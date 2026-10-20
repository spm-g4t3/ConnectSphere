/**
 * Retiring a venue flags its future approved bookings and tells each event's
 * coordinator, against the final schema in a real Postgres.
 *
 * SCRUM-174 AC5 (the coordinator learns their venue is gone; nothing is
 * cancelled) and AC6 (the notice names the event and the venue).
 *
 * Dates: D is the Singapore date 10 days from now, never hard-coded, because
 * only a booking that has not ended is flagged.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';

/** D: the Singapore date 10 days from now, as YYYY-MM-DD. */
const D = new Date(Date.now() + 8 * 3600_000 + 10 * 86_400_000).toISOString().slice(0, 10);
/** An instant on D, written at +08:00 (Singapore). */
const at = (hhmm) => `${D}T${hhmm}:00+08:00`;

describe('SCRUM-174: retiring a venue flags its bookings and tells the coordinator', () => {
  let db;
  let organiser;
  let coordinator;
  let staff;
  let leads;
  let counter = 0;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  async function makeUser(email, role) {
    const id = (await one('insert into auth.users (email) values ($1) returning id', [email])).id;
    if (role) await db.query('insert into profiles (id, role) values ($1, $2)', [id, role]);
    return id;
  }

  async function makeVenue() {
    counter += 1;
    return (
      await one(
        `insert into venues (name, location, max_capacity, setup_minutes, turnaround_minutes)
         values ($1, 'Block A', 200, 30, 45) returning id`,
        [`Harbour Room ${counter}`],
      )
    ).id;
  }

  function makeEvent() {
    counter += 1;
    return seedEvent(db, {
      status: 'approved',
      organiser_id: organiser,
      assigned_coordinator_id: coordinator,
      event_name: `Event ${counter}`,
      proposed_start: at('14:00'),
      proposed_end: at('16:00'),
      expected_attendance: 150,
    });
  }

  /** A pending request, raised by the coordinator as the API raises it. */
  const request = async (eventId, venueId) =>
    (
      await one(
        `select create_booking_request($1, $2, $3, null, null, $4::jsonb, false, 100, null) as result`,
        [eventId, venueId, coordinator, JSON.stringify({ suitable: true })],
      )
    ).result.booking.id;

  const approve = (bookingId) =>
    db.query(`update bookings set status = 'approved' where id = $1`, [bookingId]);

  const retire = (venueId) => db.query('select retire_venue($1, $2)', [venueId, staff]);

  const booking = (id) => one('select * from bookings where id = $1', [id]);

  const notices = async (bookingId, type) =>
    (
      await db.query(
        `select recipient_id, booking_id, block_id, payload from notifications
          where booking_id = $1 and type = $2 order by recipient_id`,
        [bookingId, type],
      )
    ).rows;

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await makeUser('o@x', 'event_organiser');
    coordinator = await makeUser('c@x', 'event_coordinator');
    staff = await makeUser('s@x', 'venue_staff');
    leads = [
      await makeUser('l@x', 'event_coordinator_lead'),
      await makeUser('l2@x', 'event_coordinator_lead'),
    ].sort();
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM174_AC5_retiring_a_venue_flags_its_future_approved_bookings_and_tells_their_coordinator', async () => {
    const venue = await makeVenue();
    const id = await request(await makeEvent(), venue);
    await approve(id);

    await retire(venue);

    const flagged = await booking(id);
    expect(flagged.status).toBe('flagged_for_review');
    expect(flagged.review_reason).toBe('venue_details_changed');
    expect(flagged.review_block_id).toBeNull();
    expect(flagged.flagged_by).toBe(staff);
    expect(flagged.flagged_at).not.toBeNull();
    expect((await notices(id, 'booking_flagged_venue_retired')).map((n) => n.recipient_id)).toEqual([
      coordinator,
    ]);
    // A flag with no block still reaches Venue Staff's flagged list (078).
    const list = (await one('select list_flagged_bookings($1) as list', [staff])).list;
    expect(list.find((row) => row.id === id)).toMatchObject({
      review_reason: 'venue_details_changed',
      block_id: null,
    });
  });

  it('SCRUM174_AC5_a_past_booking_is_not_flagged_when_its_venue_retires', async () => {
    const venue = await makeVenue();
    const id = await request(await makeEvent(), venue);
    await db.query(
      `update bookings
          set status = 'approved',
              starts_at = now() - interval '2 days',
              ends_at = now() - interval '2 days' + interval '2 hours'
        where id = $1`,
      [id],
    );

    await retire(venue);

    expect((await booking(id)).status).toBe('approved');
    expect(await notices(id, 'booking_flagged_venue_retired')).toEqual([]);
  });

  it('SCRUM174_AC5_a_pending_request_at_a_retired_venue_is_told_but_not_changed', async () => {
    const venue = await makeVenue();
    const id = await request(await makeEvent(), venue);

    await retire(venue);

    expect((await booking(id)).status).toBe('pending');
    const told = await notices(id, 'booking_request_venue_unavailable');
    expect(told.map((n) => [n.recipient_id, n.block_id, n.payload.cause])).toEqual([
      [coordinator, null, 'retired'],
    ]);
    expect(await notices(id, 'booking_flagged_venue_retired')).toEqual([]);
  });

  it('SCRUM174_AC5_an_unassigned_events_retirement_flag_reaches_the_leads', async () => {
    const venue = await makeVenue();
    const event = await makeEvent();
    const id = await request(event, venue);
    await approve(id);
    // Rejected, reopened and resubmitted, the event keeps its booking and
    // waits in the Lead's queue with no coordinator.
    await db.query("select change_event_request_status($1, 'approved', 'rejected', $2)", [event, coordinator]);
    await db.query("select change_event_request_status($1, 'rejected', 'draft', $2)", [event, organiser]);
    await db.query('select submit_event_request($1, now(), $2)', [event, organiser]);

    await retire(venue);

    expect((await booking(id)).status).toBe('flagged_for_review');
    expect((await notices(id, 'booking_flagged_venue_retired')).map((n) => n.recipient_id)).toEqual(
      leads,
    );
  });

  it('SCRUM174_AC6_retirement_notice_names_event_and_venue', async () => {
    const venue = await makeVenue();
    const event = await makeEvent();
    const id = await request(event, venue);
    await approve(id);

    await retire(venue);

    const [notice] = await notices(id, 'booking_flagged_venue_retired');
    const names = await one(
      `select e.event_name, v.name as venue_name, v.retired_at, b.starts_at, b.ends_at
         from bookings b
         join event_requests e on e.id = b.event_request_id
         join venues v on v.id = b.venue_id
        where b.id = $1`,
      [id],
    );
    const iso = (value) => new Date(value).toISOString();
    expect(notice.booking_id).toBe(id);
    expect({
      ...notice.payload,
      startsAt: iso(notice.payload.startsAt),
      endsAt: iso(notice.payload.endsAt),
      retiredAt: iso(notice.payload.retiredAt),
    }).toEqual({
      eventRequestId: event,
      eventName: names.event_name,
      venueId: venue,
      venueName: names.venue_name,
      startsAt: iso(names.starts_at),
      endsAt: iso(names.ends_at),
      retiredAt: iso(names.retired_at),
    });
  });
});
