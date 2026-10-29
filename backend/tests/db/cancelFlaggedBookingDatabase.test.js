/**
 * The event's assigned coordinator or Venue Staff cancel a booking flagged for
 * review, against the final schema in a real Postgres.
 *
 * SCRUM-266 AC3 and AC5 at the SQL level: any flag can be cancelled, the
 * cancelled booking frees the venue so the coordinator can request it again,
 * the event is untouched, and every cancellation leaves a booking_resolutions
 * row with a snapshot of the flag. Week 7: each booking of an event is
 * resolved on its own.
 *
 * Dates: D is the Singapore date 10 days from now, never hard-coded, because
 * a block or hold counts only while it has not ended.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, returnToLeadQueue, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor, refusal } from './helpers/queries.js';
import { approveBooking, decideBooking } from './helpers/bookingFlow.js';
import { flagForReason, flaggedByBlock } from './helpers/flaggedBookings.js';
import { clientsCanExecute } from './helpers/grants.js';
import { at } from '../fixtures/time.js';

const NO_ONE = '00000000-0000-4000-8000-000000000000';

describe('SCRUM-266 AC3 and AC5: cancelling a flagged booking', () => {
  let db;
  let organiser;
  let coordinator;
  let otherCoordinator;
  let staff;
  let counter = 0;

  const { one, rows } = queriesFor(() => db);

  const makeUser = (email, role) => seedUser(db, { email, role });
  /** A venue with 30 minutes' setup and 45 minutes' turnaround. */
  const makeVenue = () => seedVenue(db, { name: `Harbour Room ${++counter}` });

  function makeEvent({ status = 'approved', start = at('14:00'), end = at('16:00') } = {}) {
    counter += 1;
    return seedEvent(db, {
      status,
      organiser_id: organiser,
      assigned_coordinator_id: coordinator,
      event_name: `Event ${counter}`,
      proposed_start: start,
      proposed_end: end,
      expected_attendance: 150,
    });
  }

  /** A pending booking for the event's own period, written directly. */
  const insertBooking = (eventId, venueId) => seedBooking(db, { venueId, eventId });
  const decide = (bookingId, decision = 'approve', reason = null) =>
    decideBooking(db, bookingId, { caller: staff, decision, reason });
  /** A booking approved by Venue Staff, so its decision is recorded. */
  const approved = (venueId, eventId) => approveBooking(db, { venueId, eventId, caller: staff });

  /**
   * An approved booking flagged by a block over 15:00-17:00 on its venue: an
   * event 14:00-16:00 at a fresh venue unless one is given.
   */
  const flagged = async ({ venueId, eventId } = {}) =>
    flaggedByBlock(db, { venueId: venueId ?? (await makeVenue()), eventId: eventId ?? (await makeEvent()), caller: staff });

  /** An approved booking flagged by a reason rather than a block, as a venue setup change or a safety review flags them. */
  async function flaggedFor(reviewReason, { eventId } = {}) {
    const venueId = await makeVenue();
    const event = eventId ?? (await makeEvent());
    const id = await approved(venueId, event);
    await flagForReason(db, id, { reason: reviewReason, flaggedBy: staff });
    return { id, venueId, eventId: event };
  }

  const cancel = async (bookingId, { caller = coordinator, reason = 'Venue no longer fits' } = {}) =>
    (await one('select cancel_flagged_booking($1, $2, $3) as result', [bookingId, caller, reason])).result;

  const reinstate = async (bookingId) =>
    (
      await one('select reinstate_flagged_booking($1, $2, $3) as result', [bookingId, staff, 'Block moved'])
    ).result;

  const bookingRow = (id) => one('select * from bookings where id = $1', [id]);
  const eventRow = (id) => one('select * from event_requests where id = $1', [id]);
  const resolutionsFor = (id) => rows('select * from booking_resolutions where booking_id = $1', [id]);

  /** Refused with PT409 and the hint, leaving the booking and the record unchanged. */
  async function expectNotFlagged(id) {
    const before = await bookingRow(id);
    const resolutionsBefore = await resolutionsFor(id);
    const err = await refusal(cancel(id));
    expect(err?.code).toBe('PT409');
    expect(err?.hint).toBe('BOOKING_NOT_FLAGGED');
    expect(await bookingRow(id)).toEqual(before);
    expect(await resolutionsFor(id)).toEqual(resolutionsBefore);
  }

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await makeUser('o@x', 'event_organiser');
    coordinator = await makeUser('c@x', 'event_coordinator');
    otherCoordinator = await makeUser('c2@x', 'event_coordinator');
    staff = await makeUser('s@x', 'venue_staff');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('AC3: the assigned coordinator or Venue Staff cancel it', () => {
    it('SCRUM266_AC3_the_assigned_coordinator_cancels_a_flagged_booking', async () => {
      const { id } = await flagged();

      const result = await cancel(id, { caller: coordinator });

      expect(result.outcome).toBe('cancelled');
      expect(result.booking).toMatchObject({ id, status: 'cancelled' });
      expect(result.resolution).toMatchObject({ booking_id: id, outcome: 'cancelled', resolved_by: coordinator });
      expect((await bookingRow(id)).status).toBe('cancelled');
    });

    it('SCRUM266_AC3_venue_staff_cancel_a_flagged_booking', async () => {
      const { id } = await flagged();

      const result = await cancel(id, { caller: staff });

      expect(result.outcome).toBe('cancelled');
      expect(result.resolution.resolved_by).toBe(staff);
      expect((await bookingRow(id)).status).toBe('cancelled');
    });

    it('SCRUM266_AC3_venue_staff_cancel_a_booking_whose_event_has_no_coordinator', async () => {
      const { id, eventId } = await flagged();
      await returnToLeadQueue(db, eventId, { coordinator, organiser });

      expect((await cancel(id, { caller: staff })).outcome).toBe('cancelled');
    });

    it.each([
      ['another coordinator', () => otherCoordinator],
      ['an organiser', () => organiser],
      ['a null caller', () => null],
      ['a user with no profile', () => NO_ONE],
    ])('SCRUM266_AC3_%s_is_refused_with_42501', async (_label, caller) => {
      const { id } = await flagged();
      const before = await bookingRow(id);

      expect((await refusal(cancel(id, { caller: caller() })))?.code).toBe('42501');
      expect(await bookingRow(id)).toEqual(before);
      expect(await resolutionsFor(id)).toEqual([]);
    });

    it('SCRUM266_AC3_a_null_caller_is_refused_when_the_event_has_no_coordinator', async () => {
      const { id, eventId } = await flagged();
      await returnToLeadQueue(db, eventId, { coordinator, organiser });

      expect((await refusal(cancel(id, { caller: null })))?.code).toBe('42501');
      expect((await bookingRow(id)).status).toBe('flagged_for_review');
    });

    it('SCRUM266_AC3_a_safety_review_flag_can_be_cancelled', async () => {
      const { id } = await flaggedFor('safety_review');

      expect((await cancel(id)).outcome).toBe('cancelled');
      expect(await bookingRow(id)).toMatchObject({ status: 'cancelled', review_reason: 'safety_review' });
    });

    it('SCRUM266_AC3_a_setup_change_flag_can_be_cancelled', async () => {
      const { id } = await flaggedFor('setup_or_turnaround_changed');

      expect((await cancel(id, { caller: staff })).outcome).toBe('cancelled');
      expect(await bookingRow(id)).toMatchObject({
        status: 'cancelled',
        review_reason: 'setup_or_turnaround_changed',
        review_block_id: null,
      });
    });

    it.each([
      ['pending', async (venue, event) => insertBooking(event, venue)],
      ['approved', async (venue, event) => approved(venue, event)],
      [
        'rejected',
        async (venue, event) => {
          const id = await insertBooking(event, venue);
          await decide(id, 'reject', 'No');
          return id;
        },
      ],
      [
        'cancelled',
        async (venue, event) => {
          const { id } = await flagged({ venueId: venue, eventId: event });
          await db.query("update bookings set status = 'cancelled' where id = $1", [id]);
          return id;
        },
      ],
    ])('SCRUM266_AC3_a_%s_booking_is_not_flagged_and_is_refused', async (status, make) => {
      const id = await make(await makeVenue(), await makeEvent());
      expect((await bookingRow(id)).status).toBe(status);

      await expectNotFlagged(id);
    });
  });

  describe('AC3: the venue is free again and the event is untouched', () => {
    it('SCRUM266_AC3_after_cancelling_the_coordinator_can_request_the_same_venue_again', async () => {
      const { id, venueId, eventId, blockId } = await flagged();
      const request = () =>
        one(
          `select create_booking_request($1, $2, $3, null, null, '{"suitable": true}'::jsonb, false, 100, null) as result`,
          [eventId, venueId, coordinator],
        );

      // While flagged, create_booking_request refuses a second request at this venue.
      const blocked = await refusal(request());
      expect(blocked?.hint).toBe('BOOKING_FLAGGED_FOR_REVIEW');

      await cancel(id);
      await db.query('update venue_blocks set removed_at = now() where id = $1', [blockId]);
      const { result } = await request();

      expect(result.outcome).toBe('created');
      expect(result.booking).toMatchObject({ venue_id: venueId, event_request_id: eventId, status: 'pending' });
      expect(result.booking.id).not.toBe(id);
    });

    it('SCRUM266_AC3_after_cancelling_the_coordinator_can_request_another_venue', async () => {
      const { id, eventId } = await flagged();
      await cancel(id);

      const { result } = await one(
        `select create_booking_request($1, $2, $3, null, null, '{"suitable": true}'::jsonb, false, 100, null) as result`,
        [eventId, await makeVenue(), coordinator],
      );

      expect(result.outcome).toBe('created');
    });

    it('SCRUM266_AC3_a_cancelled_booking_no_longer_occupies_the_venue', async () => {
      const { id, venueId } = await flagged();
      const occupants = async () =>
        (
          await rows(
            `select id from venue_occupancy_conflicts($1, $2, $3, true, null) where kind = 'booking'`,
            [venueId, at('14:00'), at('16:00')],
          )
        ).map((r) => r.id);
      expect(await occupants()).toEqual([id]);

      await cancel(id);

      expect(await occupants()).toEqual([]);
    });

    it.each(['approved', 'safety_review', 'safety_approved', 'confirmed'])(
      'SCRUM266_AC3_the_%s_event_keeps_its_status_and_fields',
      async (status) => {
        const eventId = await makeEvent({ status });
        const { id } = await flagged({ eventId });
        const before = await eventRow(eventId);

        expect((await cancel(id)).outcome).toBe('cancelled');

        expect(await eventRow(eventId)).toEqual(before);
      },
    );

    // Cancelling now frees other events' Conflicting requests (SCRUM-571), so it
    // takes the venue lock an approval takes, in the same order.
    it('SCRUM266_AC3_cancelling_locks_the_event_then_the_venue_then_the_booking', async () => {
      const { body, definer } = await one(
        `select prosrc as body, prosecdef as definer from pg_proc where proname = 'cancel_flagged_booking'`,
      );

      const eventLock = body.search(/from\s+event_requests\s+where\s+id\s*=\s*v_event_id\s+for update/);
      const venueLock = body.search(/from\s+venues\s+where\s+id\s*=\s*v_venue_id\s+for no key update/);
      const bookingLock = body.search(/from\s+bookings\s+where\s+id\s*=\s*p_booking_id\s+for update/);
      const record = body.indexOf('insert into booking_resolutions');

      expect(eventLock).toBeGreaterThan(-1);
      expect(venueLock).toBeGreaterThan(eventLock);
      expect(bookingLock).toBeGreaterThan(venueLock);
      expect(record).toBeGreaterThan(bookingLock);
      expect(definer).toBe(false);
    });
  });

  describe('AC5: the resolution is recorded and the flag kept', () => {
    it('SCRUM266_AC5_cancelling_records_outcome_who_why_when_and_the_flag_and_keeps_it_on_the_booking', async () => {
      const { id, blockId } = await flagged();
      const before = await bookingRow(id);
      const startedAt = Date.now();

      const result = await cancel(id, { reason: '  Moving to a bigger room  ' });

      const recorded = await resolutionsFor(id);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        booking_id: id,
        outcome: 'cancelled',
        reason: 'Moving to a bigger room',
        resolved_by: coordinator,
        review_block_id: blockId,
        review_reason: null,
        flagged_by: staff,
        replacement_booking_id: null,
      });
      expect(recorded[0].flagged_at).toEqual(before.flagged_at);
      expect(recorded[0].created_at.getTime()).toBeGreaterThanOrEqual(startedAt - 5_000);

      // Only the status moves: the flag and the decision stay as they were.
      expect(await bookingRow(id)).toEqual({ ...before, status: 'cancelled' });

      expect(result.resolution).toMatchObject({
        id: recorded[0].id,
        booking_id: id,
        outcome: 'cancelled',
        reason: 'Moving to a bigger room',
        resolved_by: coordinator,
      });
      expect(result.resolution.created_at).toEqual(expect.any(String));
      expect(result.booking).toMatchObject({ id, status: 'cancelled', review_block_id: blockId });
    });

    it.each(['setup_or_turnaround_changed', 'safety_review'])(
      'SCRUM266_AC5_a_%s_flag_is_snapshotted_by_venue_staff_and_kept',
      async (reviewReason) => {
        const { id } = await flaggedFor(reviewReason);
        const before = await bookingRow(id);

        await cancel(id, { caller: staff });

        const recorded = await resolutionsFor(id);
        expect(recorded).toEqual([
          expect.objectContaining({
            outcome: 'cancelled',
            resolved_by: staff,
            review_reason: reviewReason,
            review_block_id: null,
            flagged_by: staff,
          }),
        ]);
        expect(recorded[0].flagged_at).toEqual(before.flagged_at);
        expect(await bookingRow(id)).toEqual({ ...before, status: 'cancelled' });
      },
    );

    it.each([
      ['no reason', null],
      ['an empty reason', ''],
      ['a blank reason', '   '],
    ])('SCRUM266_AC5_%s_is_refused_with_22023', async (_label, reason) => {
      const { id } = await flagged();

      expect((await refusal(cancel(id, { reason })))?.code).toBe('22023');
      expect((await bookingRow(id)).status).toBe('flagged_for_review');
      expect(await resolutionsFor(id)).toEqual([]);
    });

    it('SCRUM266_AC5_a_reason_over_1000_characters_is_refused_with_23514', async () => {
      const { id } = await flagged();

      expect((await refusal(cancel(id, { reason: 'x'.repeat(1001) })))?.code).toBe('23514');
      expect((await bookingRow(id)).status).toBe('flagged_for_review');
      expect(await resolutionsFor(id)).toEqual([]);
    });

    it('SCRUM266_AC5_a_reason_of_exactly_1000_characters_after_trimming_is_accepted', async () => {
      const { id } = await flagged();

      const result = await cancel(id, { reason: `  ${'x'.repeat(1000)}  ` });

      expect(result.outcome).toBe('cancelled');
      expect(result.resolution.reason).toHaveLength(1000);
    });

    it('SCRUM266_AC5_an_unknown_booking_is_not_found', async () => {
      expect((await refusal(cancel('00000000-0000-4000-8000-000000000001')))?.code).toBe('P0002');
    });

    it('SCRUM266_AC5_a_cancelled_booking_cannot_be_cancelled_again', async () => {
      const { id } = await flagged();
      await cancel(id);

      await expectNotFlagged(id);
      expect(await resolutionsFor(id)).toHaveLength(1);
    });

    it('SCRUM266_AC5_a_cancelled_booking_cannot_be_reinstated', async () => {
      const { id, blockId } = await flagged();
      await cancel(id);
      await db.query('update venue_blocks set removed_at = now() where id = $1', [blockId]);
      const before = await bookingRow(id);

      const err = await refusal(reinstate(id));

      expect(err?.code).toBe('PT409');
      expect(err?.hint).toBe('BOOKING_NOT_FLAGGED');
      expect(await bookingRow(id)).toEqual(before);
      expect(await resolutionsFor(id)).toHaveLength(1);
    });

    it('SCRUM266_AC5_the_function_is_not_granted_to_anon_or_authenticated', async () => {
      expect(await clientsCanExecute(db, 'cancel_flagged_booking(uuid, uuid, text)')).toEqual([]);
    });
  });

  describe('AC6: cancelling notifies the event\'s people', () => {
    const noticesFor = (bookingId) =>
      rows(
        `select recipient_id, payload from notifications
          where booking_id = $1 and type = 'flagged_booking_resolved'
          order by payload->>'audience'`,
        [bookingId],
      );
    const told = async (bookingId) =>
      (await noticesFor(bookingId)).map((n) => [n.payload.audience, n.recipient_id, n.payload.resolvedByRole]);

    /** A flagged booking for an event in the given status. */
    async function flaggedOn(status) {
      return flagged({ eventId: await makeEvent({ status }) });
    }

    it('SCRUM266_AC6_venue_staff_cancelling_tells_the_coordinator_what_was_recorded', async () => {
      const { id, venueId, eventId } = await flaggedOn('approved');

      await cancel(id, { caller: staff, reason: '  Venue closed for repairs  ' });

      const [resolution] = await resolutionsFor(id);
      const booking = await bookingRow(id);
      const notices = await noticesFor(id);
      expect(notices).toEqual([
        {
          recipient_id: coordinator,
          payload: {
            audience: 'coordinator',
            outcome: 'cancelled',
            eventRequestId: eventId,
            eventName: (await eventRow(eventId)).event_name,
            venueId,
            venueName: (await one('select name from venues where id = $1', [venueId])).name,
            startsAt: expect.any(String),
            endsAt: expect.any(String),
            reason: 'Venue closed for repairs',
            resolvedAt: expect.any(String),
            resolvedByRole: 'venue_staff',
            replacementBookingId: null,
            replacementVenueName: null,
            replacementStartsAt: null,
            replacementEndsAt: null,
          },
        },
      ]);
      const { payload } = notices[0];
      expect(payload.reason).toBe(resolution.reason);
      expect(new Date(payload.resolvedAt)).toEqual(resolution.created_at);
      expect(new Date(payload.startsAt)).toEqual(booking.starts_at);
      expect(new Date(payload.endsAt)).toEqual(booking.ends_at);
    });

    it('SCRUM266_AC6_venue_staff_cancelling_a_confirmed_events_booking_tells_coordinator_and_organiser', async () => {
      const { id } = await flaggedOn('confirmed');

      await cancel(id, { caller: staff });

      expect(await told(id)).toEqual([
        ['coordinator', coordinator, 'venue_staff'],
        ['organiser', organiser, 'venue_staff'],
      ]);
    });

    it('SCRUM266_AC6_the_coordinator_cancelling_is_not_told_but_a_confirmed_events_organiser_is', async () => {
      const { id } = await flaggedOn('confirmed');

      await cancel(id, { caller: coordinator });

      expect(await told(id)).toEqual([['organiser', organiser, 'event_coordinator']]);
    });

    it('SCRUM266_AC6_the_coordinator_cancelling_an_unconfirmed_events_booking_tells_nobody', async () => {
      const { id } = await flaggedOn('safety_approved');

      await cancel(id, { caller: coordinator });

      expect(await noticesFor(id)).toEqual([]);
    });

    it('SCRUM266_AC6_an_event_with_no_coordinator_has_no_coordinator_notice_when_submitted', async () => {
      const { id, eventId } = await flaggedOn('approved');
      await returnToLeadQueue(db, eventId, { coordinator, organiser });

      await cancel(id, { caller: staff });

      expect(await told(id)).toEqual([]);
    });
  });

  describe('Week 7: each booking is resolved on its own', () => {
    it('SCRUM266_W7_cancelling_one_booking_leaves_the_events_other_flagged_booking_untouched', async () => {
      const eventId = await makeEvent();
      const a = await flagged({ eventId });
      const b = await flagged({ eventId });
      const otherBefore = await bookingRow(b.id);

      expect((await cancel(a.id)).outcome).toBe('cancelled');

      expect((await bookingRow(a.id)).status).toBe('cancelled');
      expect(await bookingRow(b.id)).toEqual(otherBefore);
      expect(await resolutionsFor(b.id)).toEqual([]);
    });

    it('SCRUM266_W7_cancelling_a_flagged_booking_leaves_the_events_approved_booking_untouched', async () => {
      const eventId = await makeEvent();
      const a = await flagged({ eventId });
      const kept = await approved(await makeVenue(), eventId);
      const keptBefore = await bookingRow(kept);

      await cancel(a.id);

      expect(await bookingRow(kept)).toEqual(keptBefore);
    });
  });

});
