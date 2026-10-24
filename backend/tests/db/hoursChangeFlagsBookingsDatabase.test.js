/**
 * update_venue flags the bookings Venue Staff confirmed the new operating hours
 * leave out, against the final schema in a real Postgres. The API decides which
 * bookings those are (domain/venueMatching.js); the function re-checks only
 * that each is still approved, on this venue and not started.
 *
 * Dates: D is the Singapore date 10 days from now, so "not started" holds.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { expectSqlError, queriesFor } from './helpers/queries.js';
import { at, sgDate } from '../fixtures/time.js';

const TYPE = 'booking_flagged_hours_change';

describe('SCRUM-575 AC7: shortened hours flag the confirmed bookings', () => {
  let db;
  let organiser;
  let staff;
  let counter = 0;

  const { one, rows } = queriesFor(() => db);

  const makeUser = (role) => seedUser(db, { email: `u${++counter}@x`, role });

  const makeVenue = (setup = 0, turnaround = 0) =>
    seedVenue(db, { name: `Harbour Room ${++counter}`, setup, turnaround });

  /**
   * An event with one booking on the venue. coordinator null is a submitted
   * event in the Lead's queue: the only kind of event with bookings and no
   * coordinator.
   */
  async function makeBooking(venueId, { status = 'approved', start = at('20:00'), end = at('22:00'), coordinator } = {}) {
    counter += 1;
    const eventId = await seedEvent(db, {
      status: coordinator === null ? 'submitted' : 'approved',
      organiser_id: organiser,
      assigned_coordinator_id: coordinator === undefined ? await makeUser('event_coordinator') : coordinator,
      event_name: `Event ${counter}`,
      proposed_start: start,
      proposed_end: end,
      expected_attendance: 50,
    });
    return seedBooking(db, { venueId, eventId, status, start, end });
  }

  /** update_venue with the hours that leave the bookings out, as the service sends it. */
  const shortenHours = (venueId, bookingIds, extra = '') =>
    one(
      `select update_venue(p_id => $1, p_hours => $2::jsonb, p_user_id => $3,
                           p_hours_flag_booking_ids => $4::uuid[]${extra}) as result`,
      [venueId, JSON.stringify([{ day_of_week: 1, opens_at: '09:00', closes_at: '18:00' }]), staff, bookingIds],
    ).then((r) => r.result);

  const booking = (id) => one('select * from bookings where id = $1', [id]);
  const notices = (id) =>
    rows('select recipient_id, type, payload from notifications where booking_id = $1 order by type', [id]);

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await makeUser('event_organiser');
    staff = await makeUser('venue_staff');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM575_AC7_flags_the_confirmed_booking_for_review_and_tells_its_coordinator', async () => {
    const venue = await makeVenue();
    const coordinator = await makeUser('event_coordinator');
    const id = await makeBooking(venue, { coordinator });

    const result = await shortenHours(venue, [id]);

    const flagged = await booking(id);
    expect(flagged).toMatchObject({
      status: 'flagged_for_review',
      review_reason: 'venue_details_changed',
      review_block_id: null,
      flag_reason: 'venue_edit',
      flagged_by: staff,
    });
    expect(flagged.flagged_at).not.toBeNull();

    const sent = await notices(id);
    expect(sent).toHaveLength(1);
    expect(sent[0].recipient_id).toBe(coordinator);
    expect(sent[0].type).toBe(TYPE);
    expect(sent[0].payload).toMatchObject({
      venueName: expect.stringMatching(/^Harbour Room/),
      eventName: expect.stringMatching(/^Event /),
      reason: 'Operating hours changed',
    });
    expect(new Date(sent[0].payload.startsAt).toISOString()).toBe(new Date(at('20:00')).toISOString());
    expect(new Date(sent[0].payload.endsAt).toISOString()).toBe(new Date(at('22:00')).toISOString());

    expect(result.flagged_bookings.map((b) => b.booking_id)).toEqual([id]);
    expect(result.flagged_bookings[0]).toMatchObject({ event_name: expect.any(String), setup_minutes: 0, turnaround_minutes: 0 });
  });

  it('SCRUM575_AC7_leaves_alone_ids_that_are_not_approved_not_started_bookings_of_this_venue', async () => {
    const venue = await makeVenue();
    const otherVenue = await makeVenue();
    const elsewhere = await makeBooking(otherVenue);
    const pending = await makeBooking(venue, { status: 'pending' });
    const started = await makeBooking(venue, { start: at('20:00', sgDate(-1)), end: at('22:00', sgDate(1)) });

    const result = await shortenHours(venue, [elsewhere, pending, started]);

    expect(result.flagged_bookings).toEqual([]);
    expect((await booking(elsewhere)).status).toBe('approved');
    expect((await booking(pending)).status).toBe('pending');
    expect((await booking(started)).status).toBe('approved');
    for (const id of [elsewhere, pending, started]) expect(await notices(id)).toEqual([]);
  });

  it('SCRUM575_AC7_flags_without_a_notice_when_the_event_has_no_coordinator', async () => {
    const venue = await makeVenue();
    const id = await makeBooking(venue, { coordinator: null });

    await shortenHours(venue, [id]);

    expect((await booking(id)).status).toBe('flagged_for_review');
    expect(await notices(id)).toEqual([]);
  });

  it('SCRUM575_AC7_no_ids_flags_nothing', async () => {
    const venue = await makeVenue();
    const id = await makeBooking(venue);

    const result = await shortenHours(venue, null);

    expect(result.flagged_bookings).toEqual([]);
    expect((await booking(id)).status).toBe('approved');
  });

  it('SCRUM575_AC7_a_booking_the_setup_change_already_flagged_is_listed_once', async () => {
    // A and B clash once setup and turnaround grow, so step 7 flags both first.
    const venue = await makeVenue(0, 0);
    const a = await makeBooking(venue, { start: at('10:00'), end: at('12:00') });
    const b = await makeBooking(venue, { start: at('12:30'), end: at('14:00') });

    const result = await shortenHours(venue, [a], ', p_setup_minutes => 30, p_turnaround_minutes => 45');

    expect(result.flagged_bookings.map((r) => r.booking_id).sort()).toEqual([a, b].sort());
    expect((await booking(a)).review_reason).toBe('setup_or_turnaround_changed');
    expect((await notices(a)).map((n) => n.type)).toEqual(['booking_flagged_setup_change']);
  });

  it('SCRUM575_AC7_the_old_overload_without_the_ids_is_gone', async () => {
    const { count } = await one("select count(*)::int as count from pg_proc where proname = 'update_venue'");
    const old = await one(
      "select to_regprocedure('update_venue(uuid, text, text, integer, text[], text[], text[], jsonb, integer, integer, text, text, uuid)') as oid",
    );

    expect(count).toBe(1);
    expect(old.oid).toBeNull();
  });

  it('SCRUM575_AC7_the_notice_needs_a_booking', async () => {
    await expectSqlError(
      db.query(`insert into notifications (recipient_id, type) values ($1, '${TYPE}')`, [staff]),
      '23514',
      'notifications_hours_change_needs_booking',
    );
  });
});
