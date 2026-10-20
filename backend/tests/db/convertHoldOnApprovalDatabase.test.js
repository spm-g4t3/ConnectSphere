/**
 * Approving a booking request converts the approving event's own hold at that
 * venue instead of releasing it, against the final schema in a real Postgres.
 *
 * SCRUM-258 Week 7: holds are not released on approval; the event's own hold
 * for the same venue becomes converted (SCRUM-491). An expired hold never
 * counts as a booking, and each request is decided on its own.
 *
 * Dates: D is the Singapore date 10 days from now, never hard-coded.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor, refusal } from './helpers/queries.js';
import { decideBooking } from './helpers/bookingFlow.js';
import { at } from '../fixtures/time.js';

describe('SCRUM-258 Week 7: approval converts the event\'s own hold', () => {
  let db;
  let organiser;
  let coordinator;
  let staff;
  let counter = 0;

  const { one, rows } = queriesFor(() => db);

  const makeUser = (email, role) => seedUser(db, { email, role });

  /** A venue with 30 minutes' setup and 45 minutes' turnaround. */
  const makeVenue = () => seedVenue(db, { name: `Harbour Room ${++counter}` });

  function makeEvent({ start = at('14:00'), end = at('16:00'), status = 'approved' } = {}) {
    counter += 1;
    return seedEvent(db, {
      status: status,
      organiser_id: organiser,
      assigned_coordinator_id: coordinator,
      event_name: `Event ${counter}`,
      proposed_start: start,
      proposed_end: end,
      expected_attendance: 150,
    });
  }

  /** A pending booking request written directly, for the event's own period. */
  const insertBooking = (eventId, venueId) => seedBooking(db, { venueId, eventId });

  /** An active hold, unexpired by default; a lapsed one is placed two hours ago. */
  async function insertHold(eventId, venueId, { lapsed = false } = {}) {
    const [placed, expires] = lapsed ? ["now() - interval '2 hours'", "now() - interval '1 hour'"] : ['now()', "now() + interval '2 days'"];
    return (
      await one(
        `insert into venue_holds (event_request_id, venue_id, placed_by, placed_at, expires_at)
         values ($1, $2, $3, ${placed}, ${expires}) returning id`,
        [eventId, venueId, staff],
      )
    ).id;
  }

  const decide = (bookingId, decision, reason = null) => decideBooking(db, bookingId, { caller: staff, decision, reason });

  const holdOf = (id) =>
    one(
      `select status::text as status, converted_at, converted_booking_id, expired_at
         from venue_holds where id = $1`,
      [id],
    );

  /** An event with a pending request and an active hold at a new venue. */
  async function heldRequest() {
    const venueId = await makeVenue();
    const eventId = await makeEvent();
    const bookingId = await insertBooking(eventId, venueId);
    const holdId = await insertHold(eventId, venueId);
    return { venueId, eventId, bookingId, holdId };
  }

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await makeUser('o@x', 'event_organiser');
    coordinator = await makeUser('c@x', 'event_coordinator');
    staff = await makeUser('s@x', 'venue_staff');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('what an approval converts', () => {
    it('SCRUM258_Week7_approval_converts_the_events_own_active_hold_into_the_approved_booking', async () => {
      const { bookingId, holdId } = await heldRequest();

      const result = await decide(bookingId, 'approve');

      expect(result.outcome).toBe('approved');
      expect(result.converted_hold_id).toBe(holdId);
      // Converted, not released or expired: the hold became the booking.
      const hold = await holdOf(holdId);
      expect(hold.status).toBe('converted');
      expect(hold.expired_at).toBeNull();
      expect(hold.converted_at).not.toBeNull();
      expect(hold.converted_booking_id).toBe(bookingId);
    });

    it('SCRUM258_Week7_only_the_hold_at_the_booked_venue_is_converted_not_the_events_other_venue_or_other_events', async () => {
      const { venueId, eventId, bookingId, holdId } = await heldRequest();
      const elsewhere = await makeVenue();
      const ownElsewhere = await insertHold(eventId, elsewhere);
      // Later the same day, so it does not refuse the approval: occupies 17:30-19:45.
      const otherEvent = await makeEvent({ start: at('18:00'), end: at('19:00') });
      const otherEventsHold = await insertHold(otherEvent, venueId);

      const result = await decide(bookingId, 'approve');

      expect(result.converted_hold_id).toBe(holdId);
      expect((await holdOf(ownElsewhere)).status).toBe('active');
      expect((await holdOf(otherEventsHold)).status).toBe('active');
    });

    it('SCRUM258_Week7_a_hold_past_its_expiry_is_not_converted_and_the_expiry_job_still_expires_it', async () => {
      const venueId = await makeVenue();
      const eventId = await makeEvent();
      const bookingId = await insertBooking(eventId, venueId);
      const lapsed = await insertHold(eventId, venueId, { lapsed: true });

      const result = await decide(bookingId, 'approve');

      expect(result.outcome).toBe('approved');
      expect(result.converted_hold_id).toBeNull();
      expect((await holdOf(lapsed)).status).toBe('active');

      await db.query('select process_venue_hold_expiry()');
      const hold = await holdOf(lapsed);
      expect(hold.status).toBe('expired');
      expect(hold.converted_at).toBeNull();
      expect(hold.converted_booking_id).toBeNull();
    });

    it('SCRUM258_Week7_an_approval_with_no_hold_succeeds_and_converts_nothing', async () => {
      const venueId = await makeVenue();
      const bookingId = await insertBooking(await makeEvent(), venueId);

      const result = await decide(bookingId, 'approve');

      expect(result.outcome).toBe('approved');
      expect(result).toHaveProperty('converted_hold_id', null);
    });
  });

  describe('what leaves the hold alone', () => {
    it('SCRUM258_Week7_a_rejection_leaves_the_hold_active', async () => {
      const { bookingId, holdId } = await heldRequest();

      const result = await decide(bookingId, 'reject', 'Under maintenance');

      expect(result.outcome).toBe('rejected');
      expect(result).not.toHaveProperty('converted_hold_id');
      expect(await holdOf(holdId)).toMatchObject({ status: 'active', converted_at: null, converted_booking_id: null });
    });

    it('SCRUM258_Week7_an_approval_refused_for_a_conflict_leaves_the_hold_active', async () => {
      const { venueId, bookingId, holdId } = await heldRequest();
      // Another event's active hold over the same period occupies the venue.
      await insertHold(await makeEvent(), venueId);

      const result = await decide(bookingId, 'approve');

      expect(result.outcome).toBe('conflict');
      expect((await holdOf(holdId)).status).toBe('active');
    });

    it('SCRUM258_Week7_an_approval_refused_for_an_unbookable_event_leaves_the_hold_active', async () => {
      const { eventId, bookingId, holdId } = await heldRequest();
      // Rejected after approval: a move the lifecycle allows, which keeps the hold and request.
      await db.query("update event_requests set status = 'rejected' where id = $1", [eventId]);

      const err = await refusal(decide(bookingId, 'approve'));

      expect(err?.hint).toBe('EVENT_NOT_BOOKABLE');
      expect((await holdOf(holdId)).status).toBe('active');
    });
  });

  describe('occupancy after conversion', () => {
    const occupants = (venueId) =>
      rows(
        `select kind, id from venue_occupancy_conflicts($1, $2, $3, true, null) order by kind`,
        [venueId, at('14:00'), at('16:00')],
      );

    it('SCRUM258_Week7_after_conversion_the_booking_occupies_the_venue_and_the_hold_no_longer_does', async () => {
      const { venueId, bookingId, holdId } = await heldRequest();
      expect(await occupants(venueId)).toEqual([{ kind: 'hold', id: holdId }]);

      await decide(bookingId, 'approve');

      expect(await occupants(venueId)).toEqual([{ kind: 'booking', id: bookingId }]);
    });

    it('SCRUM258_Week7_the_expiry_job_never_expires_a_converted_hold_even_past_its_expiry', async () => {
      const { bookingId, holdId } = await heldRequest();
      await decide(bookingId, 'approve');
      await db.query(
        `update venue_holds set placed_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
          where id = $1`,
        [holdId],
      );

      await db.query('select process_venue_hold_expiry()');

      expect(await holdOf(holdId)).toMatchObject({ status: 'converted', expired_at: null, converted_booking_id: bookingId });
      expect(
        await rows("select 1 from notifications where venue_hold_id = $1 and type = 'venue_hold_expired'", [holdId]),
      ).toHaveLength(0);
    });
  });

  describe('the converted columns match the status', () => {
    it('SCRUM258_Week7_a_converted_hold_needs_converted_at_and_its_booking', async () => {
      const { bookingId, holdId } = await heldRequest();
      await decide(bookingId, 'approve');

      const noTime = await refusal(db.query('update venue_holds set converted_at = null where id = $1', [holdId]));
      const noBooking = await refusal(db.query('update venue_holds set converted_booking_id = null where id = $1', [holdId]));

      expect(noTime?.constraint).toBe('venue_holds_converted_at_matches_status');
      expect(noBooking?.constraint).toBe('venue_holds_converted_booking_matches_status');
    });

    it('SCRUM258_Week7_a_hold_that_is_not_converted_cannot_carry_converted_at_or_a_booking', async () => {
      const { bookingId, holdId } = await heldRequest();

      const withTime = await refusal(db.query('update venue_holds set converted_at = now() where id = $1', [holdId]));
      const withBooking = await refusal(
        db.query('update venue_holds set converted_booking_id = $2 where id = $1', [holdId, bookingId]),
      );

      expect(withTime?.constraint).toBe('venue_holds_converted_at_matches_status');
      expect(withBooking?.constraint).toBe('venue_holds_converted_booking_matches_status');
    });
  });
});
