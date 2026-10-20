/**
 * Venue Staff approve or reject a pending booking request, against the final
 * schema in a real Postgres.
 *
 * SCRUM-258 AC2-AC6 at the SQL level: the approval re-check of the padded
 * period under lock, the event-status gate (safety statuses allowed), the
 * stale-period check after a handover or reschedule, the recorded decision and
 * its check constraints, and the coordinator's notice. Week 7: each request is
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
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';

/** D: the Singapore date 10 days from now, as YYYY-MM-DD. */
const D = new Date(Date.now() + 8 * 3600_000 + 10 * 86_400_000).toISOString().slice(0, 10);
/** An instant on D, written at +08:00 (Singapore). */
const at = (hhmm) => `${D}T${hhmm}:00+08:00`;

const SUITABLE = { suitable: true, criteria: [{ criterion: 'Capacity', met: true }] };

/** The error a promise rejected with; null if it resolved. */
const refusal = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
};

describe('SCRUM-258 AC2-AC6: deciding a booking request', () => {
  let db;
  let organiser;
  let coordinator;
  let staff;
  let counter = 0;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const rows = async (sql, params) => (await db.query(sql, params)).rows;

  async function makeUser(email, role) {
    const id = (await one('insert into auth.users (email) values ($1) returning id', [email])).id;
    if (role) await db.query('insert into profiles (id, role) values ($1, $2)', [id, role]);
    return id;
  }

  /** A venue with 30 minutes' setup and 45 minutes' turnaround. */
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
      proposed_start: start,
      proposed_end: end,
      expected_attendance: 150,
    });
  }

  /** A booking written directly, for the event's own period unless one is given. */
  async function insertBooking(eventId, venueId, { status = 'pending', start, end } = {}) {
    const event = await one('select proposed_start, proposed_end from event_requests where id = $1', [eventId]);
    return (
      await one(
        `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
         values ($1, $2, $3, $4, $5) returning id`,
        [venueId, eventId, start ?? event.proposed_start, end ?? event.proposed_end, status],
      )
    ).id;
  }

  /** A pending request at venueId for a new event on start-end. */
  async function pending(venueId, start = at('14:00'), end = at('16:00'), eventOptions = {}) {
    const eventId = await makeEvent({ start, end, ...eventOptions });
    return { id: await insertBooking(eventId, venueId), eventId };
  }

  const decide = async (bookingId, decision, { caller = staff, reason = null, alternative = null } = {}) =>
    (
      await one('select decide_booking_request($1, $2, $3, $4, $5) as result', [
        bookingId,
        caller,
        decision,
        reason,
        alternative,
      ])
    ).result;

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

    it('SCRUM258_AC5_a_request_for_a_period_the_event_has_moved_from_is_stale', async () => {
      const { id, eventId } = await pending(await makeVenue());
      await db.query(
        'update event_requests set proposed_start = $2, proposed_end = $3 where id = $1',
        [eventId, at('18:00'), at('20:00')],
      );

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

  describe('create_booking_request: the widened event-status gate (066)', () => {
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
});
