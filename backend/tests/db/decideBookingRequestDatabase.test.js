/**
 * Venue Staff approve or reject a pending booking request, against the final
 * schema in a real Postgres.
 *
 * SCRUM-258 AC2-AC6 at the SQL level: the approval re-check of the padded
 * period under lock, the event-status gate (safety statuses allowed), the
 * recorded decision and its check constraints, and the coordinator's notice.
 * SCRUM-593: a request whose event has moved is approved, and checked, at the
 * event's current period; a rejection never moves it. Week 7: each request is
 * decided on its own, and the event's own hold never blocks its approval.
 *
 * PGlite is one connection, so two approvals can never meet on a lock here.
 * The race is covered by a sequential test plus a check of the lock the
 * function takes;
 * a true simultaneous run needs a live database (SCRUM-264).
 *
 * Dates: D is the Singapore date 10 days from now, never hard-coded, because
 * a hold counts only while unexpired.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor, refusal } from './helpers/queries.js';
import { decideBooking } from './helpers/bookingFlow.js';
import { at } from '../fixtures/time.js';

const SUITABLE = { suitable: true, criteria: [{ criterion: 'Capacity', met: true }] };

describe('SCRUM-258 AC2-AC6: deciding a booking request', () => {
  let db;
  let organiser;
  let coordinator;
  let staff;
  let counter = 0;

  const { one, rows } = queriesFor(() => db);

  const makeUser = (email, role) => seedUser(db, { email, role });

  /** A venue with 30 minutes' setup and 45 minutes' turnaround. */
  const makeVenue = () => seedVenue(db, { name: `Harbour Room ${++counter}` });

  function makeEvent({
    status = 'approved',
    start = at('14:00'),
    end = at('16:00'),
    assignedTo = coordinator,
  } = {}) {
    counter += 1;
    return seedEvent(db, {
      status,
      organiser_id: organiser,
      assigned_coordinator_id: assignedTo,
      event_name: `Event ${counter}`,
      purpose: 'Workshop',
      proposed_start: start,
      proposed_end: end,
      expected_attendance: 150,
    });
  }

  /** A booking written directly, for the event's own period unless one is given. */
  const insertBooking = (eventId, venueId, { status = 'pending', start, end } = {}) =>
    seedBooking(db, { venueId, eventId, status, start, end });

  /** A pending request at venueId for a new event on start-end. */
  async function pending(venueId, start = at('14:00'), end = at('16:00'), eventOptions = {}) {
    const eventId = await makeEvent({ start, end, ...eventOptions });
    return { id: await insertBooking(eventId, venueId), eventId };
  }

  const decide = (bookingId, decision, { caller = staff, reason = null, alternative = null, expected, suitability } = {}) =>
    decideBooking(db, bookingId, { caller, decision, reason, alternative, expected, suitability });

  const bookingRow = (id) => one('select * from bookings where id = $1', [id]);
  const noticesFor = (bookingId) => rows('select * from notifications where booking_id = $1', [bookingId]);

  async function placeHold(eventId, venueId) {
    return (
      await one(
        `insert into venue_holds (event_request_id, venue_id, placed_by, expires_at)
         values ($1, $2, $3, now() + interval '1 hour') returning id`,
        [eventId, venueId, staff],
      )
    ).id;
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

  describe('only Venue Staff can decide', () => {
    it.each([
      ['a coordinator', () => coordinator],
      ['an organiser', () => organiser],
      ['a null caller', () => null],
      ['a user with no profile', () => '00000000-0000-4000-8000-000000000000'],
    ])('SCRUM258_AC6_only_venue_staff_can_decide_%s_is_refused', async (_label, caller) => {
      const { id } = await pending(await makeVenue());

      expect((await refusal(decide(id, 'approve', { caller: caller() })))?.code).toBe('42501');
      expect((await refusal(decide(id, 'reject', { caller: caller(), reason: 'No' })))?.code).toBe('42501');
      expect((await bookingRow(id)).status).toBe('pending');
    });

    it('SCRUM258_AC6_an_unknown_booking_is_not_found', async () => {
      const err = await refusal(decide('00000000-0000-4000-8000-000000000001', 'approve'));
      expect(err?.code).toBe('P0002');
    });
  });

  describe('AC2: approval re-checks the occupied period', () => {
    it('SCRUM258_AC2_an_approved_booking_over_the_padded_period_refuses_approval', async () => {
      const venue = await makeVenue();
      // Raw 10:00-12:00 and 13:00-14:00 do not meet; occupied 09:30-12:45 and 12:30-14:45 do.
      const other = await makeEvent({ start: at('10:00'), end: at('12:00') });
      const approvedId = await insertBooking(other, venue, { status: 'approved' });
      const { id } = await pending(venue, at('13:00'), at('14:00'));

      const result = await decide(id, 'approve');

      expect(result.outcome).toBe('conflict');
      expect(result.conflicts.map((c) => [c.kind, c.booking_id])).toEqual([['booking', approvedId]]);
      const row = await bookingRow(id);
      expect(row.status).toBe('pending');
      expect(row.decided_at).toBeNull();
      expect(await noticesFor(id)).toEqual([]);
    });

    it('SCRUM258_AC2_occupied_periods_that_only_touch_allow_approval', async () => {
      const venue = await makeVenue();
      const other = await makeEvent({ start: at('10:00'), end: at('12:00') });
      await insertBooking(other, venue, { status: 'approved' });
      // Occupied from 12:45, exactly where the approved booking's turnaround ends.
      const { id } = await pending(venue, at('13:15'), at('14:00'));

      expect((await decide(id, 'approve')).outcome).toBe('approved');
    });

    it('SCRUM258_AC2_an_active_block_refuses_approval_and_a_removed_one_does_not', async () => {
      const [blocked, cleared] = [await makeVenue(), await makeVenue()];
      for (const [venue, removed] of [[blocked, false], [cleared, true]]) {
        await db.query(
          `insert into venue_blocks (venue_id, starts_at, ends_at, reason, removed_at)
           values ($1, $2, $3, 'maintenance', ${removed ? 'now()' : 'null'})`,
          [venue, at('15:00'), at('17:00')],
        );
      }
      const a = await pending(blocked);
      const b = await pending(cleared);

      const result = await decide(a.id, 'approve');
      expect(result.outcome).toBe('conflict');
      expect(result.conflicts.map((c) => c.kind)).toEqual(['block']);
      expect((await decide(b.id, 'approve')).outcome).toBe('approved');
    });

    it('SCRUM258_AC2_another_events_active_hold_refuses_approval', async () => {
      const venue = await makeVenue();
      const holder = await makeEvent({ start: at('14:00'), end: at('16:00') });
      const holdId = await placeHold(holder, venue);
      const { id } = await pending(venue);

      const result = await decide(id, 'approve');

      expect(result.outcome).toBe('conflict');
      expect(result.conflicts.map((c) => [c.kind, c.hold_id])).toEqual([['hold', holdId]]);
    });

    it('SCRUM258_Week7_the_events_own_hold_does_not_block_its_approval', async () => {
      const venue = await makeVenue();
      const { id, eventId } = await pending(venue);
      await placeHold(eventId, venue);

      expect((await decide(id, 'approve')).outcome).toBe('approved');
    });

    it('SCRUM258_AC2_a_clashing_pending_request_does_not_block_approval', async () => {
      const venue = await makeVenue();
      const first = await pending(venue);
      await pending(venue);

      expect((await decide(first.id, 'approve')).outcome).toBe('approved');
    });

    it('SCRUM258_AC2_once_one_overlapping_request_is_approved_the_other_is_refused', async () => {
      const venue = await makeVenue();
      const first = await pending(venue, at('14:00'), at('16:00'));
      const second = await pending(venue, at('15:00'), at('17:00'));

      expect((await decide(first.id, 'approve')).outcome).toBe('approved');
      const result = await decide(second.id, 'approve');

      expect(result.outcome).toBe('conflict');
      expect(result.conflicts.map((c) => [c.kind, c.booking_id])).toEqual([['booking', first.id]]);
      // Refused, not decided: still open, as the first approval marked it.
      expect(await bookingRow(second.id)).toMatchObject({ status: 'conflicting', decided_at: null });
    });

    // PGlite cannot run two transactions at once, so the race is pinned by the
    // lock: `for no key update` on the venue conflicts with itself, so a second
    // approval waits and then sees the first one's approval; `for share` would not.
    it('SCRUM258_AC2_approval_locks_the_venue_for_no_key_update_before_the_recheck', async () => {
      const { prosrc: body } = await one("select prosrc from pg_proc where proname = 'decide_booking_request'");

      const venueLock = body.search(/from\s+venues\s+where\s+id\s*=\s*v_venue_id\s+for no key update/);
      const bookingLock = body.search(/from\s+bookings\s+where\s+id\s*=\s*p_booking_id\s+for update/);
      const recheck = body.indexOf('venue_occupancy_conflicts(');

      expect(venueLock).toBeGreaterThan(-1);
      expect(bookingLock).toBeGreaterThan(venueLock);
      expect(recheck).toBeGreaterThan(venueLock);
      expect(body).not.toMatch(/for share/);
    });
  });

  describe('AC3: an approved request occupies the venue', () => {
    it('SCRUM258_AC3_an_approved_request_blocks_a_later_overlapping_request', async () => {
      const venue = await makeVenue();
      const { id } = await pending(venue);
      await decide(id, 'approve');

      const later = await makeEvent({ start: at('15:00'), end: at('17:00') });
      const { result } = await one(
        'select create_booking_request($1, $2, $3, null, null, $4::jsonb, false, 150) as result',
        [later, venue, coordinator, JSON.stringify(SUITABLE)],
      );

      expect((await bookingRow(id)).status).toBe('approved');
      expect(result.outcome).toBe('conflict');
      expect(result.conflicts.map((c) => c.booking_id)).toEqual([id]);
    });
  });

  describe('AC4: a rejection carries its reason', () => {
    it.each([
      ['reject with no reason', 'reject', null, null],
      ['reject with a blank reason', 'reject', '   ', null],
      ['approve with a reason', 'approve', 'Looks fine', null],
      ['approve with an alternative', 'approve', null, 'Room B'],
      ['an unknown decision', 'defer', 'Later', null],
    ])('SCRUM258_AC4_%s_is_refused', async (_label, decision, reason, alternative) => {
      const { id } = await pending(await makeVenue());

      expect((await refusal(decide(id, decision, { reason, alternative })))?.code).toBe('22023');
      expect((await bookingRow(id)).status).toBe('pending');
    });

    it('SCRUM258_AC4_a_reason_over_1000_characters_is_refused', async () => {
      const { id } = await pending(await makeVenue());

      expect((await refusal(decide(id, 'reject', { reason: 'x'.repeat(1001) })))?.code).toBe('23514');
    });

    it('SCRUM258_AC4_the_reason_and_alternative_are_stored_trimmed_and_a_blank_alternative_is_none', async () => {
      const venue = await makeVenue();
      const a = await pending(venue);
      const b = await pending(venue);

      await decide(a.id, 'reject', { reason: '  Double-booked  ', alternative: '  Room B  ' });
      await decide(b.id, 'reject', { reason: 'Closed', alternative: '   ' });

      expect(await bookingRow(a.id)).toMatchObject({
        status: 'rejected',
        decision_reason: 'Double-booked',
        suggested_alternative: 'Room B',
      });
      expect(await bookingRow(b.id)).toMatchObject({ decision_reason: 'Closed', suggested_alternative: null });
    });
  });

  describe('AC5: approval needs a live event', () => {
    it.each(['cancelled', 'rejected', 'completed', 'under_review'])(
      'SCRUM258_AC5_a_request_for_a_%s_event_cannot_be_approved',
      async (status) => {
        const { id } = await pending(await makeVenue(), undefined, undefined, { status });

        const err = await refusal(decide(id, 'approve'));

        expect(err?.code).toBe('PT409');
        expect(err?.hint).toBe('EVENT_NOT_BOOKABLE');
        expect((await bookingRow(id)).status).toBe('pending');
      },
    );

    it.each(['safety_review', 'safety_approved', 'confirmed'])(
      'SCRUM258_AC5_a_request_for_a_%s_event_can_be_approved',
      async (status) => {
        const { id } = await pending(await makeVenue(), undefined, undefined, { status });

        expect((await decide(id, 'approve')).outcome).toBe('approved');
      },
    );

    it('SCRUM258_AC5_a_request_for_a_cancelled_event_can_still_be_rejected', async () => {
      const { id } = await pending(await makeVenue(), undefined, undefined, { status: 'cancelled' });

      expect((await decide(id, 'reject', { reason: 'Event cancelled' })).outcome).toBe('rejected');
    });

    it('SCRUM258_AC2_a_request_at_a_retired_venue_cannot_be_approved', async () => {
      const venue = await makeVenue();
      const { id } = await pending(venue);
      await db.query('update venues set retired_at = now() where id = $1', [venue]);

      expect((await refusal(decide(id, 'approve')))?.hint).toBe('VENUE_RETIRED');
    });

    it('SCRUM258_AC5_a_request_for_an_event_with_no_period_is_stale', async () => {
      const { id, eventId } = await pending(await makeVenue());
      await db.query('update event_requests set proposed_start = null, proposed_end = null where id = $1', [eventId]);

      const err = await refusal(decide(id, 'approve'));

      expect(err?.code).toBe('PT409');
      expect(err?.hint).toBe('BOOKING_PERIOD_STALE');
      expect((await bookingRow(id)).status).toBe('pending');
    });
  });

  describe('AC6: the decision is recorded once and the coordinator told', () => {
    it('SCRUM258_AC6_who_and_when_are_recorded_with_the_decision', async () => {
      const { id } = await pending(await makeVenue());
      const before = Date.now();

      const result = await decide(id, 'approve');

      const row = await bookingRow(id);
      expect(row).toMatchObject({ status: 'approved', decided_by: staff, decision_reason: null });
      expect(row.decided_at.getTime()).toBeGreaterThanOrEqual(before - 5_000);
      expect(result.booking.decided_by).toBe(staff);
    });

    it.each([
      ['an approval', 'approve', null, 'reject', 'Too late'],
      ['a rejection', 'reject', 'No', 'approve', null],
    ])('SCRUM258_AC6_%s_cannot_be_decided_again', async (_label, first, firstReason, second, secondReason) => {
      const { id } = await pending(await makeVenue());
      await decide(id, first, { reason: firstReason });
      const recorded = await bookingRow(id);

      const err = await refusal(decide(id, second, { reason: secondReason }));

      expect(err?.code).toBe('PT409');
      expect(err?.hint).toBe('BOOKING_NOT_PENDING');
      expect(await bookingRow(id)).toEqual(recorded);
    });

    it.each([
      ['decided_by without decided_at', "status = 'approved', decided_by = $2"],
      ['a decision on a pending request', 'decided_by = $2, decided_at = now()'],
      ['a reason on an approval', "status = 'approved', decided_by = $2, decided_at = now(), decision_reason = 'x'"],
      ['a decided rejection without a reason', "status = 'rejected', decided_by = $2, decided_at = now()"],
      ['a blank reason', "status = 'rejected', decided_by = $2, decided_at = now(), decision_reason = '  '"],
      ['an alternative without a reason', "status = 'approved', decided_by = $2, decided_at = now(), suggested_alternative = 'Room B'"],
    ])('SCRUM258_AC6_the_constraints_refuse_%s', async (_label, set) => {
      const { id } = await pending(await makeVenue());

      const err = await refusal(db.query(`update bookings set ${set} where id = $1`, [id, staff]));

      expect(err?.code).toBe('23514');
    });

    it('SCRUM258_AC6_the_coordinator_is_notified_of_a_rejection_with_its_reason', async () => {
      const { id, eventId } = await pending(await makeVenue());

      await decide(id, 'reject', { reason: 'Double-booked', alternative: 'Room B' });

      const notices = await noticesFor(id);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ recipient_id: coordinator, type: 'booking_request_rejected' });
      expect(notices[0].payload).toMatchObject({
        eventRequestId: eventId,
        reason: 'Double-booked',
        suggestedAlternative: 'Room B',
      });
      expect(notices[0].payload.venueName).toEqual(expect.any(String));
    });

    it('SCRUM258_AC6_the_coordinator_is_notified_of_an_approval', async () => {
      const { id } = await pending(await makeVenue());

      await decide(id, 'approve');

      const notices = await noticesFor(id);
      expect(notices.map((n) => [n.recipient_id, n.type])).toEqual([[coordinator, 'booking_request_approved']]);
      expect(notices[0].payload.reason).toBeNull();
    });

    it('SCRUM258_AC6_the_current_coordinator_is_notified_after_a_handover', async () => {
      const successor = await makeUser('c2@x', 'event_coordinator');
      const { id, eventId } = await pending(await makeVenue());
      await db.query('update event_requests set assigned_coordinator_id = $2 where id = $1', [eventId, successor]);

      await decide(id, 'approve');

      expect((await noticesFor(id)).map((n) => n.recipient_id)).toEqual([successor]);
    });

    it('SCRUM258_AC6_an_event_with_no_coordinator_is_still_decided_with_no_notice', async () => {
      // Rejected, reopened and resubmitted, the event keeps its request while
      // it waits in the Lead's queue with no coordinator.
      const { id } = await pending(await makeVenue(), undefined, undefined, { status: 'submitted', assignedTo: null });

      expect((await decide(id, 'reject', { reason: 'No' })).outcome).toBe('rejected');
      expect(await noticesFor(id)).toEqual([]);
    });

    it('SCRUM258_AC6_a_decision_notice_must_name_its_booking', async () => {
      const err = await refusal(
        db.query("insert into notifications (recipient_id, type) values ($1, 'booking_request_approved')", [coordinator]),
      );

      expect(err?.code).toBe('23514');
    });

    it.each([
      ['changing_the_reason', 'reject', 'No', "decision_reason = 'Another reason'"],
      ['changing_who_decided', 'approve', null, 'decided_by = $2'],
      ['rejected_to_approved', 'reject', 'No', "status = 'approved'"],
      ['approved_to_pending', 'approve', null, "status = 'pending'"],
    ])('SCRUM258_AC6_a_decided_request_cannot_be_changed_directly_%s', async (_label, decision, reason, set) => {
      const { id } = await pending(await makeVenue());
      await decide(id, decision, { reason });
      const recorded = await bookingRow(id);

      const params = set.includes('$2') ? [id, coordinator] : [id];
      const err = await refusal(db.query(`update bookings set ${set} where id = $1`, params));

      // 42501 is the trigger; the CHECKs alone would answer 23514 or let it through.
      expect(err?.code).toBe('42501');
      expect(await bookingRow(id)).toEqual(recorded);
    });

    it('SCRUM258_AC6_an_approval_can_still_be_flagged_then_cancelled', async () => {
      const venueId = await makeVenue();
      const { id } = await pending(venueId);
      await decide(id, 'approve');
      const decided = await bookingRow(id);
      const blockId = (
        await one(
          `insert into venue_blocks (venue_id, starts_at, ends_at, reason)
           values ($1, $2, $3, 'maintenance') returning id`,
          [venueId, at('20:00'), at('21:00')],
        )
      ).id;

      await db.query(
        `update bookings
            set status = 'flagged_for_review', review_block_id = $2, flagged_at = now(), flagged_by = $3
          where id = $1`,
        [id, blockId, staff],
      );
      expect((await bookingRow(id)).status).toBe('flagged_for_review');
      await db.query("update bookings set status = 'cancelled' where id = $1", [id]);

      const row = await bookingRow(id);
      expect(row.status).toBe('cancelled');
      expect(row).toMatchObject({
        decided_by: decided.decided_by,
        decided_at: decided.decided_at,
        decision_reason: null,
        suggested_alternative: null,
      });
    });
  });

  describe('Week 7: each request is decided on its own', () => {
    it('SCRUM258_Week7_deciding_one_request_leaves_the_events_other_requests_unchanged', async () => {
      const eventId = await makeEvent();
      const [venueA, venueB, venueC] = [await makeVenue(), await makeVenue(), await makeVenue()];
      const a = await insertBooking(eventId, venueA);
      const b = await insertBooking(eventId, venueB);
      const c = await insertBooking(eventId, venueC);

      await decide(a, 'approve');
      await decide(b, 'reject', { reason: 'Closed' });

      expect((await bookingRow(a)).status).toBe('approved');
      expect((await bookingRow(b)).status).toBe('rejected');
      expect(await bookingRow(c)).toMatchObject({ status: 'pending', decided_at: null });
    });
  });

  describe('create_booking_request: the widened event-status gate', () => {
    const request = async (eventId) =>
      (
        await one(
          'select create_booking_request($1, $2, $3, null, null, $4::jsonb, false, 150) as result',
          [eventId, await makeVenue(), coordinator, JSON.stringify(SUITABLE)],
        )
      ).result;

    it('SCRUM258_AC5_a_venue_can_be_requested_for_an_event_in_safety_review', async () => {
      expect((await request(await makeEvent({ status: 'safety_review' }))).outcome).toBe('created');
    });

    it('SCRUM258_AC5_a_venue_still_cannot_be_requested_for_a_cancelled_event', async () => {
      const err = await refusal(request(await makeEvent({ status: 'cancelled' })));

      expect(err?.code).toBe('PT409');
      expect(err?.hint).toBe('EVENT_NOT_BOOKABLE');
    });
  });

  describe('SCRUM-593: approving a request whose event has moved', () => {
    /** Moves the event as its coordinator does, to 18:00-20:00 on D. */
    const moveEvent = (eventId) =>
      db.query('select apply_significant_event_change($1, $2::jsonb, $3, $4)', [
        eventId,
        JSON.stringify({ proposedStart: at('18:00'), proposedEnd: at('20:00') }),
        'Rescheduled',
        coordinator,
      ]);

    /** A 14:00-16:00 pending request whose event then moved to 18:00-20:00. */
    async function movedRequest(venueId) {
      const { id, eventId } = await pending(venueId);
      await moveEvent(eventId);
      expect(await bookingRow(id)).toMatchObject({ status: 'pending', starts_at: new Date(at('14:00')) });
      return { id, eventId };
    }

    // The move itself tells Venue Staff about the request; only the decision's notice is wanted here.
    const decisionNotices = (bookingId) =>
      rows(
        `select * from notifications
          where booking_id = $1 and type in ('booking_request_approved', 'booking_request_rejected')`,
        [bookingId],
      );

    it('SCRUM593_AC6_a_request_whose_event_moved_is_approved_at_the_new_period', async () => {
      const venue = await makeVenue();
      const { id } = await movedRequest(venue);
      // Another event holds the old period, which no longer matters.
      await insertBooking(await makeEvent(), venue, { status: 'approved' });

      const result = await decide(id, 'approve');

      expect(result.outcome).toBe('approved');
      expect(await bookingRow(id)).toMatchObject({
        status: 'approved',
        starts_at: new Date(at('18:00')),
        ends_at: new Date(at('20:00')),
        decided_by: staff,
      });
      expect(new Date(result.booking.starts_at)).toEqual(new Date(at('18:00')));
    });

    it('SCRUM593_AC6_a_clash_at_the_new_period_is_a_conflict_and_the_request_is_unchanged', async () => {
      const venue = await makeVenue();
      const { id } = await movedRequest(venue);
      // Raw 20:30-21:30 misses 18:00-20:00; occupied 20:00-22:15 meets 17:30-20:45.
      const otherId = await insertBooking(await makeEvent({ start: at('20:30'), end: at('21:30') }), venue, {
        status: 'approved',
      });
      const before = await bookingRow(id);

      const result = await decide(id, 'approve');

      expect(result.outcome).toBe('conflict');
      expect(result.conflicts.map((c) => [c.kind, c.booking_id])).toEqual([['booking', otherId]]);
      expect(await bookingRow(id)).toEqual(before);
      expect(await decisionNotices(id)).toEqual([]);
    });

    it('SCRUM593_AC6_other_requests_are_marked_conflicting_against_the_new_period', async () => {
      const venue = await makeVenue();
      const { id } = await movedRequest(venue);
      const atNew = await pending(venue, at('18:00'), at('20:00'));
      const atOld = await pending(venue, at('14:00'), at('16:00'));

      const result = await decide(id, 'approve');

      expect(result.marked_conflicting).toEqual([atNew.id]);
      expect((await bookingRow(atNew.id)).status).toBe('conflicting');
      expect((await bookingRow(atOld.id)).status).toBe('pending');
    });

    it('SCRUM593_AC6_other_requests_are_judged_at_their_own_events_new_period', async () => {
      const venue = await makeVenue();
      const { id } = await pending(venue, at('18:00'), at('20:00'));
      // Stored 14:00-16:00 with the event moved onto 18:00-20:00, and stored
      // 18:00-20:00 with the event moved off to 10:00-12:00.
      const movedOn = await movedRequest(venue);
      const movedOff = await insertBooking(await makeEvent({ start: at('10:00'), end: at('12:00') }), venue, {
        start: at('18:00'),
        end: at('20:00'),
      });

      const result = await decide(id, 'approve');

      expect(result.marked_conflicting).toEqual([movedOn.id]);
      expect((await bookingRow(movedOn.id)).status).toBe('conflicting');
      expect((await bookingRow(movedOff)).status).toBe('pending');
      const [notice] = await rows(
        `select payload from notifications where booking_id = $1 and type = 'booking_request_conflicting'`,
        [movedOn.id],
      );
      expect(notice.payload.approvedBookingId).toBe(id);
    });

    it('SCRUM593_AC7_rejecting_a_request_whose_event_moved_keeps_its_period', async () => {
      const { id } = await movedRequest(await makeVenue());

      expect((await decide(id, 'reject', { reason: 'No longer suitable' })).outcome).toBe('rejected');

      expect(await bookingRow(id)).toMatchObject({
        status: 'rejected',
        starts_at: new Date(at('14:00')),
        ends_at: new Date(at('16:00')),
      });
      const [notice] = await decisionNotices(id);
      expect(notice.payload).toMatchObject({ previousStartsAt: null, previousEndsAt: null });
    });

    it('SCRUM593_AC8_the_approval_notice_carries_the_new_period_and_the_one_it_moved_from', async () => {
      const { id } = await movedRequest(await makeVenue());

      await decide(id, 'approve');

      const notices = await decisionNotices(id);
      expect(notices).toHaveLength(1);
      const { payload } = notices[0];
      expect(new Date(payload.startsAt)).toEqual(new Date(at('18:00')));
      expect(new Date(payload.endsAt)).toEqual(new Date(at('20:00')));
      expect(new Date(payload.previousStartsAt)).toEqual(new Date(at('14:00')));
      expect(new Date(payload.previousEndsAt)).toEqual(new Date(at('16:00')));
    });

    it('SCRUM593_AC8_an_approval_that_did_not_move_names_no_previous_period', async () => {
      const { id } = await pending(await makeVenue());

      await decide(id, 'approve');

      const [notice] = await noticesFor(id);
      expect(notice.payload).toMatchObject({ previousStartsAt: null, previousEndsAt: null });
    });

    it('SCRUM593_AC6_approving_a_period_that_is_no_longer_the_events_is_refused_and_nothing_is_written', async () => {
      const { id } = await movedRequest(await makeVenue());
      const before = await bookingRow(id);

      // Venue Staff were shown the request's own period, before the event moved.
      const err = await refusal(decide(id, 'approve', { expected: [at('14:00'), at('16:00')] }));

      expect(err?.code).toBe('PT409');
      expect(err?.hint).toBe('BOOKING_PERIOD_CHANGED');
      expect(await bookingRow(id)).toEqual(before);
      expect(await decisionNotices(id)).toEqual([]);
    });

    it('SCRUM593_AC6_approving_without_the_period_shown_is_refused', async () => {
      const { id } = await movedRequest(await makeVenue());
      const before = await bookingRow(id);

      const err = await refusal(decide(id, 'approve', { expected: null }));

      expect(err?.code).toBe('22023');
      expect(await bookingRow(id)).toEqual(before);
    });

    const CLOSED = {
      suitable: false,
      criteria: [{ criterion: 'Operating hours', met: false, detail: 'Closes 18:00' }],
      checked: { startsAt: at('18:00'), endsAt: at('20:00') },
    };

    it('SCRUM593_AC6_a_move_records_the_suitability_at_the_new_period_as_not_overridden', async () => {
      const { id } = await movedRequest(await makeVenue());
      // The coordinator confirmed an unsuitable venue at the old period.
      await db.query(
        `update bookings set suitability_result = $2::jsonb, suitability_overridden = true where id = $1`,
        [id, JSON.stringify({ suitable: false, criteria: [{ criterion: 'Capacity', met: false }] })],
      );

      const result = await decide(id, 'approve', { suitability: CLOSED });

      expect(result.outcome).toBe('approved');
      expect(await bookingRow(id)).toMatchObject({ suitability_result: CLOSED, suitability_overridden: false });
      expect(result.booking).toMatchObject({ suitability_result: CLOSED, suitability_overridden: false });
    });

    it('SCRUM593_AC6_an_approval_that_does_not_move_keeps_the_stored_suitability', async () => {
      const { id } = await pending(await makeVenue());
      const stored = { suitable: false, criteria: [{ criterion: 'Capacity', met: false }] };
      await db.query(
        `update bookings set suitability_result = $2::jsonb, suitability_overridden = true where id = $1`,
        [id, JSON.stringify(stored)],
      );

      await decide(id, 'approve', { suitability: CLOSED });

      expect(await bookingRow(id)).toMatchObject({ status: 'approved', suitability_result: stored, suitability_overridden: true });
    });
  });
});
