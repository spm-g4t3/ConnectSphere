/**
 * Booking-progress notices for Venue Staff and Event Coordinators, against the
 * final schema in a real Postgres, through the functions the API calls:
 * create_booking_request, decide_booking_request and create_venue_block /
 * flag_bookings_for_block.
 *
 * SCRUM-174 AC1 (Venue Staff told of every new request), AC2-AC5 (the
 * coordinator told of approval, rejection, conflict and a flag) and AC6 (each
 * notice names its own event and venue).
 *
 * Dates: D is the Singapore date 10 days from now, never hard-coded, because
 * a booking counts only while it has not ended.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, returnToLeadQueue, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor } from './helpers/queries.js';
import { decideBooking } from './helpers/bookingFlow.js';
import { at } from '../fixtures/time.js';

describe('SCRUM-174: booking-progress notices name their event and venue', () => {
  let db;
  let organiser;
  let coordinator;
  let otherCoordinator;
  let staff;
  let otherStaff;
  let leads;
  let counter = 0;

  const { one } = queriesFor(() => db);

  const makeUser = (email, role) => seedUser(db, { email, role });

  const makeVenue = () => seedVenue(db, { name: `Harbour Room ${++counter}` });

  function makeEvent({ assigned = coordinator } = {}) {
    counter += 1;
    return seedEvent(db, {
      status: 'approved',
      organiser_id: organiser,
      assigned_coordinator_id: assigned,
      event_name: `Event ${counter}`,
      proposed_start: at('14:00'),
      proposed_end: at('16:00'),
      expected_attendance: 150,
    });
  }

  /** create_booking_request as the API calls it, optionally naming a booking it replaces. */
  const request = async (eventId, venueId, { caller = coordinator, replacesId = null } = {}) =>
    (
      await one(
        `select create_booking_request($1, $2, $3, null, null, '{"suitable": true}'::jsonb, false, 100, $4)
           as result`,
        [eventId, venueId, caller, replacesId],
      )
    ).result;

  /** decide_booking_request as the API calls it, by a Venue Staff user. */
  const decide = (bookingId, decision = 'approve', reason = null, alternative = null) =>
    decideBooking(db, bookingId, { caller: staff, decision, reason, alternative });

  /** The event's and venue's names as stored, so no payload is checked against a guess. */
  const namesOf = (eventId, venueId) =>
    one(
      `select e.event_name, v.name as venue_name
         from event_requests e, venues v where e.id = $1 and v.id = $2`,
      [eventId, venueId],
    );

  const noticesOf = async (type, bookingId) =>
    (
      await db.query(
        `select recipient_id, booking_id, block_id, payload from notifications
          where type = $1 and booking_id = $2 order by recipient_id`,
        [type, bookingId],
      )
    ).rows;

  const bookingRow = (id) => one('select * from bookings where id = $1', [id]);

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await makeUser('o@x', 'event_organiser');
    coordinator = await makeUser('c@x', 'event_coordinator');
    otherCoordinator = await makeUser('c2@x', 'event_coordinator');
    staff = await makeUser('s@x', 'venue_staff');
    otherStaff = await makeUser('s2@x', 'venue_staff');
    leads = [await makeUser('l@x', 'event_coordinator_lead'), await makeUser('l2@x', 'event_coordinator_lead')].sort();
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM174_AC2_AC6_approved_notice_reaches_assigned_coordinator_and_names_event_and_venue', async () => {
    const event = await makeEvent();
    const venue = await makeVenue();
    const created = await request(event, venue);

    const decided = await decide(created.booking.id);

    expect(decided.outcome).toBe('approved');
    const notices = await noticesOf('booking_request_approved', created.booking.id);
    expect(notices.map((n) => n.recipient_id)).toEqual([coordinator]);
    const names = await namesOf(event, venue);
    expect(notices[0].payload).toMatchObject({
      eventRequestId: event,
      eventName: names.event_name,
      venueId: venue,
      venueName: names.venue_name,
      startsAt: decided.booking.starts_at,
      endsAt: decided.booking.ends_at,
    });
  });

  it('SCRUM174_AC3_AC4_AC6_rejected_notice_carries_reason_alternative_and_names', async () => {
    const event = await makeEvent();
    const venue = await makeVenue();
    const created = await request(event, venue);

    const decided = await decide(created.booking.id, 'reject', '  Stage under repair  ', '  Try the Atrium  ');

    expect(decided.outcome).toBe('rejected');
    const row = await bookingRow(created.booking.id);
    expect(row.decision_reason).toBe('Stage under repair');
    expect(row.suggested_alternative).toBe('Try the Atrium');
    const notices = await noticesOf('booking_request_rejected', created.booking.id);
    expect(notices.map((n) => n.recipient_id)).toEqual([coordinator]);
    const names = await namesOf(event, venue);
    expect(notices[0].payload).toMatchObject({
      eventRequestId: event,
      eventName: names.event_name,
      venueId: venue,
      venueName: names.venue_name,
      reason: row.decision_reason,
      suggestedAlternative: row.suggested_alternative,
    });
  });

  it('SCRUM174_AC5_AC6_conflicting_notice_names_its_own_event_and_venue', async () => {
    const venue = await makeVenue();
    const approvedEvent = await makeEvent();
    const clashingEvent = await makeEvent({ assigned: otherCoordinator });
    const toApprove = (await request(approvedEvent, venue)).booking.id;
    const clashing = (await request(clashingEvent, venue, { caller: otherCoordinator })).booking.id;

    await decide(toApprove);

    expect((await bookingRow(clashing)).status).toBe('conflicting');
    const notices = await noticesOf('booking_request_conflicting', clashing);
    expect(notices.map((n) => n.recipient_id)).toEqual([otherCoordinator]);
    const own = await namesOf(clashingEvent, venue);
    const approved = await namesOf(approvedEvent, venue);
    expect(own.event_name).not.toBe(approved.event_name);
    expect(notices[0].payload).toMatchObject({
      eventRequestId: clashingEvent,
      eventName: own.event_name,
      venueId: venue,
      venueName: own.venue_name,
      approvedEventRequestId: approvedEvent,
      approvedEventName: approved.event_name,
    });
  });

  /** An approved booking for the event at the venue. */
  async function approvedBooking(event, venue) {
    const booking = (await request(event, venue)).booking.id;
    await decide(booking);
    return booking;
  }

  /** A block over the booking on the API's override path: confirmed, with the booking acknowledged. */
  const blockOver = async (venue, booking) =>
    (
      await one(
        `select create_venue_block($1, $2, $3, 'maintenance', null, $4, true, $5::uuid[]) as result`,
        [venue, at('13:00'), at('15:00'), staff, [booking]],
      )
    ).result;

  it('SCRUM174_AC5_AC6_block_flag_reaches_the_assigned_coordinator_and_names_event_and_venue', async () => {
    const event = await makeEvent();
    const venue = await makeVenue();
    const booking = await approvedBooking(event, venue);

    const block = await blockOver(venue, booking);

    expect(block.outcome).toBe('created');
    expect((await bookingRow(booking)).status).toBe('flagged_for_review');
    // Not otherCoordinator and not the Leads: the event has its own coordinator.
    const notices = await noticesOf('booking_flagged', booking);
    expect(notices.map((n) => n.recipient_id)).toEqual([coordinator]);
    const names = await namesOf(event, venue);
    expect(notices[0].block_id).toBe(block.block.id);
    expect(notices[0].payload).toMatchObject({ eventName: names.event_name, venueName: names.venue_name });
  });

  it('SCRUM174_AC5_block_flag_on_an_unassigned_event_reaches_the_leads', async () => {
    const event = await makeEvent();
    const venue = await makeVenue();
    const booking = await approvedBooking(event, venue);
    await returnToLeadQueue(db, event, { coordinator, organiser });

    await blockOver(venue, booking);

    const notices = await noticesOf('booking_flagged', booking);
    expect(notices.map((n) => n.recipient_id)).toEqual(leads);
  });

  it('SCRUM174_AC1_each_venue_of_a_multi_venue_event_notifies_separately', async () => {
    const event = await makeEvent();
    const venues = [await makeVenue(), await makeVenue()];
    const bookings = [];
    for (const venue of venues) {
      const created = await request(event, venue);
      expect(created.outcome).toBe('created');
      bookings.push(created.booking.id);
    }
    const venueNameOf = {};
    for (const [i, id] of bookings.entries()) venueNameOf[id] = (await namesOf(event, venues[i])).venue_name;

    for (const recipient of [staff, otherStaff]) {
      const notices = (
        await db.query(
          `select booking_id, payload from notifications
            where type = 'booking_request_submitted' and recipient_id = $1
              and payload->>'eventRequestId' = $2`,
          [recipient, event],
        )
      ).rows;
      expect(notices.map((n) => n.booking_id).sort()).toEqual([...bookings].sort());
      for (const notice of notices) {
        expect(notice.payload.venueName).toBe(venueNameOf[notice.booking_id]);
      }
    }
  });

  it('SCRUM174_AC1_replacement_request_notifies_venue_staff', async () => {
    const event = await makeEvent();
    const flaggedVenue = await makeVenue();
    const original = (await request(event, flaggedVenue)).booking.id;
    await decide(original);
    await db.query(
      `update bookings
          set status = 'flagged_for_review', review_reason = 'setup_or_turnaround_changed',
              flagged_at = now(), flagged_by = $2
        where id = $1`,
      [original, staff],
    );
    const newVenue = await makeVenue();

    const replacement = await request(event, newVenue, { replacesId: original });

    expect(replacement.outcome).toBe('created');
    expect(replacement.booking.replaces_booking_id).toBe(original);
    const allStaff = (await db.query(`select id from profiles where role = 'venue_staff' order by id`)).rows.map(
      (r) => r.id,
    );
    const notices = await noticesOf('booking_request_submitted', replacement.booking.id);
    expect(notices.map((n) => n.recipient_id)).toEqual(allStaff);
    const names = await namesOf(event, newVenue);
    for (const notice of notices) {
      expect(notice.payload).toMatchObject({
        eventRequestId: event,
        eventName: names.event_name,
        venueId: newVenue,
        venueName: names.venue_name,
      });
    }
  });

  /** A block with no approved booking under it, so no override is needed. */
  const blockAt = async (venue, startsAt, endsAt) =>
    (
      await one(`select create_venue_block($1, $2, $3, 'maintenance', null, $4) as result`, [
        venue,
        startsAt,
        endsAt,
        staff,
      ])
    ).result;

  const UNAVAILABLE = 'booking_request_venue_unavailable';

  it('SCRUM174_AC5_a_block_over_a_pending_request_tells_its_coordinator_without_changing_it', async () => {
    const event = await makeEvent();
    const venue = await makeVenue();
    const created = await request(event, venue);

    const block = await blockAt(venue, at('13:00'), at('15:00'));

    expect(block.outcome).toBe('created');
    // Flag and notify only: the request stays open for Venue Staff to decide.
    const row = await bookingRow(created.booking.id);
    expect(row.status).toBe('pending');
    expect(row.review_block_id).toBeNull();
    expect(await noticesOf('booking_flagged', created.booking.id)).toEqual([]);
    const notices = await noticesOf(UNAVAILABLE, created.booking.id);
    expect(notices.map((n) => n.recipient_id)).toEqual([coordinator]);
    expect(notices[0].block_id).toBe(block.block.id);
    const names = await namesOf(event, venue);
    expect(notices[0].payload).toMatchObject({
      cause: 'block',
      eventRequestId: event,
      eventName: names.event_name,
      venueId: venue,
      venueName: names.venue_name,
      startsAt: created.booking.starts_at,
      endsAt: created.booking.ends_at,
      reason: 'maintenance',
      blockStartsAt: block.block.starts_at,
      blockEndsAt: block.block.ends_at,
    });
  });

  it('SCRUM174_AC5_a_conflicting_request_under_a_block_is_told_too', async () => {
    const venue = await makeVenue();
    const approvedEvent = await makeEvent();
    const clashingEvent = await makeEvent({ assigned: otherCoordinator });
    const toApprove = (await request(approvedEvent, venue)).booking.id;
    const clashing = (await request(clashingEvent, venue, { caller: otherCoordinator })).booking.id;
    await decide(toApprove);
    expect((await bookingRow(clashing)).status).toBe('conflicting');

    await blockOver(venue, toApprove);

    expect((await bookingRow(clashing)).status).toBe('conflicting');
    const notices = await noticesOf(UNAVAILABLE, clashing);
    expect(notices.map((n) => n.recipient_id)).toEqual([otherCoordinator]);
    // The approved booking is flagged instead, not also told it is unavailable.
    expect(await noticesOf(UNAVAILABLE, toApprove)).toEqual([]);
  });

  it('SCRUM174_AC5_extending_the_same_block_does_not_repeat_the_notice', async () => {
    const event = await makeEvent();
    const venue = await makeVenue();
    const created = await request(event, venue);
    const block = await blockAt(venue, at('13:00'), at('15:00'));

    const updated = (
      await one(
        `select update_venue_block($1, $2, $3, $4, null, null, false, $5) as result`,
        [venue, block.block.id, at('12:00'), at('15:30'), staff],
      )
    ).result;

    expect(updated.outcome).toBe('updated');
    expect(await noticesOf(UNAVAILABLE, created.booking.id)).toHaveLength(1);
  });

  it('SCRUM174_AC5_a_request_outside_the_block_is_not_told', async () => {
    // The request is 14:00-16:00; with the venue's 30 min setup and 45 min
    // turnaround it occupies 13:30-16:45. Each case gets its own venue.
    const cases = [
      { from: '13:00', to: '13:30', told: false },
      { from: '16:45', to: '17:30', told: false },
      { from: '13:00', to: '13:31', told: true }, // inside setup only
      { from: '16:44', to: '17:30', told: true }, // inside turnaround only
    ];
    for (const { from, to, told } of cases) {
      const event = await makeEvent();
      const venue = await makeVenue();
      const created = await request(event, venue);

      await blockAt(venue, at(from), at(to));

      expect(await noticesOf(UNAVAILABLE, created.booking.id), `${from}-${to}`).toHaveLength(told ? 1 : 0);
    }
  });

  it('SCRUM174_AC5_unavailable_notice_requires_booking', async () => {
    await expect(
      db.query(`insert into notifications (recipient_id, type, payload) values ($1, $2, '{}'::jsonb)`, [
        coordinator,
        UNAVAILABLE,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
