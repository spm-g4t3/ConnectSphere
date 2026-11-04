/**
 * SCRUM-571: when an event is cancelled, a flagged booking is cancelled, or a
 * replacement for a flagged booking is approved, other events' Conflicting
 * requests that clashed only with the freed booking return to Pending and
 * their coordinators are told, against the final schema in a real Postgres
 * (PGlite). Requests something else still occupies stay Conflicting.
 *
 * Dates: D is the Singapore date 10 days from now, because a block or hold
 * counts only while it has not ended.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor, refusal } from './helpers/queries.js';
import { approveBooking, decideBooking } from './helpers/bookingFlow.js';
import { flagForReason } from './helpers/flaggedBookings.js';
import { at } from '../fixtures/time.js';

const CLEARED = 'booking_request_conflict_cleared';

describe('SCRUM-571: freed venues return other events\' Conflicting requests to Pending', () => {
  let db;
  let organiser;
  let coordinator;
  let otherCoordinator;
  let staff;
  let counter = 0;

  const { one, rows } = queriesFor(() => db);

  const makeUser = (email, role, fullName) => seedUser(db, { email, role, fullName });

  /** A venue with 30 minutes' setup and 45 minutes' turnaround. */
  const makeVenue = () => seedVenue(db, { name: `Harbour Room ${++counter}` });

  function makeEvent({ status = 'approved', start = at('13:00'), end = at('14:00'), assigned } = {}) {
    counter += 1;
    return seedEvent(db, {
      status,
      organiser_id: organiser,
      assigned_coordinator_id: assigned === undefined ? coordinator : assigned,
      event_name: `Event ${counter}`,
      proposed_start: start,
      proposed_end: end,
      expected_attendance: 150,
    });
  }

  /** A request for the event's own period, written directly as pending unless told otherwise. */
  const insertBooking = (eventId, venueId, { status = 'pending' } = {}) => seedBooking(db, { venueId, eventId, status });

  /** A request approved by Venue Staff, so its decision is recorded. */
  const approved = (venueId, eventId) => approveBooking(db, { venueId, eventId, caller: staff });

  async function flaggedAt(venueId, eventId) {
    const id = await approved(venueId, eventId);
    await flagForReason(db, id, { reason: 'safety_review', flaggedBy: staff });
    return id;
  }

  const cancelEvent = (eventId, caller = coordinator) =>
    db.query(
      `select cancel_event_request($1, $2, 'Venue issue', 'connectsphere_decision'::event_cancellation_initiator, null)`,
      [eventId, caller],
    );

  const cancelFlagged = async (bookingId, caller = coordinator) =>
    (await one('select cancel_flagged_booking($1, $2, $3) as result', [bookingId, caller, 'Venue no longer fits'])).result;

  /** create_booking_request naming the flagged booking it replaces, then Venue Staff approve it. */
  async function approveReplacement(eventId, venueId, replacesId) {
    const { result } = await one(
      `select create_booking_request($1, $2, $3, null, null, '{"suitable": true}'::jsonb, false, 100, $4) as result`,
      [eventId, venueId, coordinator, replacesId],
    );
    return decideBooking(db, result.booking.id, { caller: staff, decision: 'approve' });
  }

  const bookingRow = (id) => one('select * from bookings where id = $1', [id]);
  const eventRow = (id) => one('select * from event_requests where id = $1', [id]);
  const statusOf = async (id) => (await bookingRow(id)).status;
  const clearedNotices = (bookingId) =>
    rows('select recipient_id, payload from notifications where booking_id = $1 and type = $2', [bookingId, CLEARED]);

  /**
   * Venue V; another event's request R for 13:00-17:00 at V; then the
   * releasing event's booking B for 13:00-14:00 at V, approved, which marks R
   * conflicting, and flagged if asked. With 30/45 minutes, B occupies 12:30-14:45.
   */
  async function conflictingBehind({ flagged = false, assigned, status } = {}) {
    const venue = await makeVenue();
    const other = await makeEvent({
      start: at('13:00'), end: at('17:00'), assigned: assigned === undefined ? otherCoordinator : assigned, status,
    });
    const request = await insertBooking(other, venue);
    const releasing = await makeEvent();
    const booking = flagged ? await flaggedAt(venue, releasing) : await approved(venue, releasing);
    expect(await statusOf(request)).toBe('conflicting');
    return { venue, other, request, releasing, booking };
  }

  /** R is Pending and its coordinator has exactly one notice naming what freed it. */
  async function expectFreed({ venue, other, request, releasing, booking }) {
    expect(await statusOf(request)).toBe('pending');
    expect(await clearedNotices(request)).toEqual([{
      recipient_id: otherCoordinator,
      payload: {
        eventRequestId: other,
        eventName: (await eventRow(other)).event_name,
        venueId: venue,
        venueName: expect.stringMatching(/^Harbour Room/),
        startsAt: expect.any(String),
        endsAt: expect.any(String),
        releasedBookingId: booking,
        releasedEventName: (await eventRow(releasing)).event_name,
      },
    }]);
  }

  async function expectStillConflicting(request) {
    expect(await statusOf(request)).toBe('conflicting');
    expect(await clearedNotices(request)).toEqual([]);
  }

  beforeAll(async () => {
    db = await createSchemaDb();

    organiser = await makeUser('o@x', 'event_organiser', 'Olive Organiser');
    coordinator = await makeUser('c@x', 'event_coordinator', 'Priya Nair');
    otherCoordinator = await makeUser('c2@x', 'event_coordinator', 'Omar Okafor');
    staff = await makeUser('s@x', 'venue_staff', 'Sam Staff');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  // -------------------------------------------------------------------------
  // AC1: cancelling an event
  // -------------------------------------------------------------------------
  describe('AC1: cancelling an event frees what only its bookings blocked', () => {
    it.each([
      ['an_approved', false],
      ['a_flagged', true],
    ])('SCRUM571_AC1_cancelling_an_event_with_%s_booking_frees_the_conflicting_request', async (_label, flagged) => {
      const setup = await conflictingBehind({ flagged });

      await cancelEvent(setup.releasing);

      expect(await statusOf(setup.booking)).toBe('cancelled');
      await expectFreed(setup);
    });

    it('SCRUM571_AC1_an_event_with_bookings_at_two_venues_frees_the_conflicting_requests_at_each', async () => {
      const [v1, v2] = [await makeVenue(), await makeVenue()];
      const otherAt = () => makeEvent({ start: at('13:00'), end: at('17:00'), assigned: otherCoordinator });
      const [o1, o2] = [await otherAt(), await otherAt()];
      const [r1, r2] = [await insertBooking(o1, v1), await insertBooking(o2, v2)];
      const releasing = await makeEvent();
      const [b1, b2] = [await approved(v1, releasing), await approved(v2, releasing)];
      expect([await statusOf(r1), await statusOf(r2)]).toEqual(['conflicting', 'conflicting']);

      await cancelEvent(releasing);

      await expectFreed({ venue: v1, other: o1, request: r1, releasing, booking: b1 });
      await expectFreed({ venue: v2, other: o2, request: r2, releasing, booking: b2 });
    });

    it('SCRUM571_AC1_a_request_two_of_the_events_bookings_block_at_one_venue_is_told_once', async () => {
      // create_booking_request allows one occupying booking per event and
      // venue, so the second is written directly. Both are cancelled before
      // the loop, so the first frees R and the second finds it Pending.
      const setup = await conflictingBehind();
      const second = await seedBooking(db, { venueId: setup.venue, eventId: setup.releasing, status: 'approved' });

      await cancelEvent(setup.releasing);

      expect([await statusOf(setup.booking), await statusOf(second)]).toEqual(['cancelled', 'cancelled']);
      await expectFreed({ ...setup, booking: [setup.booking, second].sort()[0] });
    });

    it('SCRUM571_AC1_the_cancelled_events_own_pending_and_conflicting_requests_are_withdrawn', async () => {
      // Its own conflicting request at V2 is behind a third event's booking.
      const releasing = await makeEvent();
      const own = await approved(await makeVenue(), releasing);
      const v2 = await makeVenue();
      const ownConflicting = await insertBooking(releasing, v2);
      await approved(v2, await makeEvent());
      const ownPending = await insertBooking(releasing, await makeVenue());
      expect(await statusOf(ownConflicting)).toBe('conflicting');

      await cancelEvent(releasing);

      expect([await statusOf(own), await statusOf(ownConflicting), await statusOf(ownPending)])
        .toEqual(['cancelled', 'withdrawn', 'withdrawn']);
      expect(await clearedNotices(ownConflicting)).toEqual([]);
      expect(await clearedNotices(ownPending)).toEqual([]);
    });

    it('SCRUM571_AC1_a_freed_request_with_no_coordinator_returns_to_pending_and_nobody_is_told', async () => {
      // Waiting in the Lead's queue, the other event has no coordinator.
      const { request, releasing } = await conflictingBehind({ assigned: null, status: 'submitted' });

      await cancelEvent(releasing);

      expect(await statusOf(request)).toBe('pending');
      expect(await clearedNotices(request)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // AC2: cancelling or replacing a flagged booking
  // -------------------------------------------------------------------------
  describe('AC2: cancelling or replacing a flagged booking frees what only it blocked', () => {
    it.each([
      ['the_events_coordinator', () => coordinator],
      ['Venue_Staff', () => staff],
    ])('SCRUM571_AC2_cancel_flagged_booking_by_%s_frees_the_conflicting_request', async (_label, caller) => {
      const setup = await conflictingBehind({ flagged: true });

      expect((await cancelFlagged(setup.booking, caller())).outcome).toBe('cancelled');

      await expectFreed(setup);
    });

    it('SCRUM571_AC2_approving_a_replacement_at_another_venue_frees_the_conflicting_request_on_the_old_slot', async () => {
      const setup = await conflictingBehind({ flagged: true });

      const result = await approveReplacement(setup.releasing, await makeVenue(), setup.booking);

      expect(result.replaced_booking_id).toBe(setup.booking);
      expect(await statusOf(setup.booking)).toBe('cancelled');
      await expectFreed(setup);
    });

    it('SCRUM571_AC2_a_replacement_at_the_same_venue_is_refused_and_moves_nothing', async () => {
      // Step 6 refuses any request at a venue the event has a flagged booking
      // at, whatever the period, so a replacement is always at another venue.
      const setup = await conflictingBehind({ flagged: true });

      const refused = await refusal(one(
        `select create_booking_request($1, $2, $3, null, null, '{"suitable": true}'::jsonb, false, 100, $4)`,
        [setup.releasing, setup.venue, coordinator, setup.booking],
      ));

      expect(refused).toMatchObject({ code: 'PT409', hint: 'BOOKING_FLAGGED_FOR_REVIEW', detail: setup.booking });
      expect(await statusOf(setup.booking)).toBe('flagged_for_review');
      await expectStillConflicting(setup.request);
    });

    it.each([
      ['by_another_coordinator', () => otherCoordinator, false, '42501'],
      ['for_a_booking_that_is_not_flagged', () => coordinator, true, 'PT409'],
    ])('SCRUM571_AC2_a_refused_cancel_flagged_booking_%s_moves_nothing', async (_label, caller, approvedOnly, code) => {
      const { request, booking } = await conflictingBehind({ flagged: !approvedOnly });
      const before = await statusOf(booking);

      expect((await refusal(cancelFlagged(booking, caller())))?.code).toBe(code);

      expect(await statusOf(booking)).toBe(before);
      await expectStillConflicting(request);
    });
  });

  // -------------------------------------------------------------------------
  // AC3, AC4: only a request nothing else occupies is freed
  // -------------------------------------------------------------------------
  describe('AC3 and AC4: a request something else still occupies stays Conflicting', () => {
    // Each case runs through both releases, so neither path skips the check.
    const releases = [
      ['cancelling_the_event', (s) => cancelEvent(s.releasing)],
      ['cancelling_the_flagged_booking', (s) => cancelFlagged(s.booking)],
    ];

    it.each(releases)('SCRUM571_AC4_%s_leaves_a_request_another_approved_booking_blocks', async (_label, release) => {
      // A third event's booking 15:30-17:00 occupies 15:00-17:45, inside R's period.
      const setup = await conflictingBehind({ flagged: true });
      await approved(setup.venue, await makeEvent({ start: at('15:30'), end: at('17:00') }));

      await release(setup);

      await expectStillConflicting(setup.request);
    });

    it.each(releases)('SCRUM571_AC4_%s_leaves_a_request_a_venue_block_covers', async (_label, release) => {
      const setup = await conflictingBehind({ flagged: true });
      const { result } = await one(
        "select create_venue_block($1, $2, $3, 'maintenance', null, $4, false, '{}'::uuid[]) as result",
        [setup.venue, at('16:00'), at('17:00'), staff],
      );
      expect(result.outcome).toBe('created');

      await release(setup);

      await expectStillConflicting(setup.request);
    });

    it.each(releases)('SCRUM571_AC4_%s_leaves_a_request_another_events_active_hold_covers', async (_label, release) => {
      const setup = await conflictingBehind({ flagged: true });
      const holder = await makeEvent({ start: at('16:00'), end: at('17:00') });
      await db.query(
        "insert into venue_holds (event_request_id, venue_id, placed_by, expires_at) values ($1, $2, $3, now() + interval '2 days')",
        [holder, setup.venue, coordinator],
      );

      await release(setup);

      await expectStillConflicting(setup.request);
    });

    it.each(releases)('SCRUM571_AC3_%s_frees_a_request_behind_only_an_expired_hold', async (_label, release) => {
      // Lapsed but still active: the expiry job has not reached it yet.
      const setup = await conflictingBehind({ flagged: true });
      const holder = await makeEvent({ start: at('16:00'), end: at('17:00') });
      await db.query(
        `insert into venue_holds (event_request_id, venue_id, placed_by, placed_at, expires_at)
         values ($1, $2, $3, now() - interval '2 hours', now() - interval '1 hour')`,
        [holder, setup.venue, coordinator],
      );

      await release(setup);

      await expectFreed(setup);
    });

    it.each(releases)('SCRUM571_AC3_%s_leaves_a_conflicting_request_outside_setup_and_turnaround', async (_label, release) => {
      // B occupies 12:30-14:45; R2 at 15:30-16:30 occupies 15:00-17:15. R2 is
      // conflicting with nothing left (its blocker was cancelled directly), so
      // only an overlap check that ignores the period would free it.
      const setup = await conflictingBehind({ flagged: true });
      const period = { start: at('15:30'), end: at('16:30') };
      const request = await insertBooking(await makeEvent({ ...period, assigned: otherCoordinator }), setup.venue);
      const blocker = await approved(setup.venue, await makeEvent(period));
      await db.query("update bookings set status = 'cancelled' where id = $1", [blocker]);
      expect(await statusOf(request)).toBe('conflicting');

      await release(setup);

      await expectStillConflicting(request);
    });
  });
});
