/**
 * SCRUM-347: the assigned coordinator rejects an Approved event, against the real
 * schema. reject_approved_event (024), 012's decision history and N08's release.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { ROLE } from '../../src/domain/userRole.js';
import { useSchemaDb, seedEvent, seedUser, seedVenue, seedBooking, seedBlock } from './helpers/schemaDb.js';
import { queriesFor, refusal, expectSqlError } from './helpers/queries.js';
import { clientsCanExecute } from './helpers/grants.js';

const getDb = useSchemaDb();
const { one, rows } = queriesFor(getDb);

const DAY = 86_400_000;
let counter = 0;
const next = () => (counter += 1);
const user = (role) => seedUser(getDb(), { email: `u${next()}@example.com`, role, fullName: `User ${counter}` });

let organiser;
let venueStaff;
let technicalSupport;
let equipmentType;

beforeAll(async () => {
  organiser = await user(ROLE.EVENT_ORGANISER);
  venueStaff = await user(ROLE.VENUE_STAFF);
  technicalSupport = await user(ROLE.TECHNICAL_SUPPORT_STAFF);
  equipmentType = (await one("insert into equipment_types (name, total_quantity) values ('Projector', 50) returning id")).id;
});

const reject = (id, caller, reason = 'The only suitable hall is closed for repairs.') =>
  getDb().query('select * from reject_approved_event($1, $2, $3)', [id, caller, reason]);
const eventRow = (id) => one('select * from event_requests where id = $1', [id]);
const decisionHistory = (id) =>
  rows('select * from event_request_decision_history where event_request_id = $1 order by decided_at, id', [id]);
const notifications = (id) =>
  rows(
    `select recipient_id, booking_id, payload ->> 'audience' as audience, payload
       from notifications where event_request_id = $1 and type = 'event_rejected'
      order by audience, booking_id nulls first`,
    [id],
  );

// An event in `status` with one of each arrangement: a pending request, an
// approved booking, a request Venue Staff already rejected, an active hold and
// an equipment request with a live reservation.
async function eventWithArrangements(coordinator, status = 'approved') {
  const start = new Date(Date.now() + 30 * DAY);
  const end = new Date(start.getTime() + 2 * 3_600_000);
  const id = await seedEvent(getDb(), {
    status,
    event_name: `Event ${next()}`,
    organiser_id: organiser,
    assigned_coordinator_id: coordinator,
    proposed_start: start,
    proposed_end: end,
  });
  const venue = () => seedVenue(getDb(), { name: `Venue ${next()}`, setup: 0, turnaround: 0 });
  const venues = { pending: await venue(), approved: await venue(), rejected: await venue(), held: await venue() };
  const bookings = {
    pending: await seedBooking(getDb(), { venueId: venues.pending, eventId: id, status: 'pending' }),
    approved: await seedBooking(getDb(), { venueId: venues.approved, eventId: id, status: 'approved' }),
    rejected: await seedBooking(getDb(), { venueId: venues.rejected, eventId: id, status: 'rejected' }),
  };
  const hold = (await one(
    `insert into venue_holds (event_request_id, venue_id, placed_by, expires_at)
     values ($1, $2, $3, now() + interval '2 days') returning id`,
    [id, venues.held, coordinator],
  )).id;
  const equipmentRequest = (await one(
    "insert into equipment_requests (event_request_id, status) values ($1, 'arranged') returning id",
    [id],
  )).id;
  const line = (await one(
    'insert into equipment_lines (equipment_request_id, equipment_type_id, quantity) values ($1, $2, 2) returning id',
    [equipmentRequest, equipmentType],
  )).id;
  const reservation = (await one(
    `insert into equipment_reservations (equipment_type_id, event_request_id, equipment_line_id, quantity, start_at, end_at)
     values ($1, $2, $3, 2, $4, $5) returning id`,
    [equipmentType, id, line, start, end],
  )).id;
  const changeRequest = async (status, decision = null) => (await one(
    `insert into event_change_requests (event_request_id, requested_by, change_field, requested_change, status, decision)
     values ($1, $2, 'venue', 'A larger room', $3, $4) returning id`,
    [id, organiser, status, decision],
  )).id;
  const changeRequests = {
    outstanding: await changeRequest('outstanding'),
    inProgress: await changeRequest('in_progress'),
    processed: await changeRequest('processed', 'approved'),
  };
  return { id, start, end, venues, bookings, hold, equipmentRequest, reservation, changeRequests };
}

// Everything a rejection writes, so a refusal can be shown to have written none of it.
async function snapshot(event) {
  return {
    event: await eventRow(event.id),
    bookings: await rows('select id, status::text from bookings where event_request_id = $1 order by id', [event.id]),
    hold: await one('select status::text, released_at from venue_holds where id = $1', [event.hold]),
    equipment: await one('select status::text from equipment_requests where id = $1', [event.equipmentRequest]),
    reservation: await one('select released_at from equipment_reservations where id = $1', [event.reservation]),
    decisionHistory: await decisionHistory(event.id),
    statusHistory: await rows('select * from event_request_status_history where event_request_id = $1', [event.id]),
    notifications: await rows('select * from notifications where event_request_id = $1', [event.id]),
    changeRequests: await rows('select * from event_change_requests where event_request_id = $1 order by id', [event.id]),
  };
}

describe('SCRUM-347: reject_approved_event', () => {
  it('SCRUM347_AC1_clients_cannot_call_it_directly', async () => {
    expect(await clientsCanExecute(getDb(), 'reject_approved_event(uuid, uuid, text)')).toEqual([]);
  });

  describe('a rejection', () => {
    let coordinator;
    let event;
    let approval;
    let returned;

    beforeAll(async () => {
      coordinator = await user(ROLE.EVENT_COORDINATOR);
      event = await eventWithArrangements(coordinator);
      approval = await eventRow(event.id);
      ({ rows: [returned] } = await reject(event.id, coordinator, '  The only suitable hall is closed.  '));
    });

    it('SCRUM347_AC3_the_status_becomes_rejected', async () => {
      expect(returned.status).toBe('rejected');
      expect((await eventRow(event.id)).status).toBe('rejected');
      expect(await rows(
        'select previous_status::text, new_status::text, changed_by, reason from event_request_status_history where event_request_id = $1',
        [event.id],
      )).toEqual([{
        previous_status: 'approved', new_status: 'rejected', changed_by: coordinator, reason: 'The only suitable hall is closed.',
      }]);
    });

    it('SCRUM347_AC3_the_rejection_is_the_current_decision_with_its_trimmed_reason', async () => {
      const row = await eventRow(event.id);
      expect(row).toMatchObject({
        decision: 'rejected',
        decision_note: 'The only suitable hall is closed.',
        decided_by: coordinator,
        reviewing_coordinator_id: coordinator,
      });
      expect(row.decided_at.getTime()).toBeGreaterThan(approval.decided_at.getTime());
    });

    it('SCRUM347_AC3_the_approval_moves_into_the_decision_history', async () => {
      expect(await decisionHistory(event.id)).toEqual([expect.objectContaining({
        decision: 'approved',
        decision_note: approval.decision_note,
        decided_by: approval.decided_by,
        decided_at: approval.decided_at,
        superseded_reason: 'rejected_after_approval',
        superseded_by: coordinator,
      })]);
    });

    it('SCRUM347_AC3_a_history_entry_cannot_be_updated_or_deleted', async () => {
      const [entry] = await decisionHistory(event.id);

      await expectSqlError(
        getDb().query("update event_request_decision_history set decision_note = 'edited' where id = $1", [entry.id]),
        '42501',
      );
      await expectSqlError(getDb().query('delete from event_request_decision_history where id = $1', [entry.id]), '42501');
      expect(await decisionHistory(event.id)).toEqual([entry]);
    });

    it('SCRUM347_AC4_pending_requests_are_withdrawn_and_approved_bookings_cancelled', async () => {
      const status = async (id) => (await one('select status::text from bookings where id = $1', [id])).status;
      expect(await status(event.bookings.pending)).toBe('withdrawn');
      expect(await status(event.bookings.approved)).toBe('cancelled');
      expect(await status(event.bookings.rejected)).toBe('rejected');
    });

    it('SCRUM347_AC4_the_tentative_hold_is_released', async () => {
      expect(await one('select status::text, released_by from venue_holds where id = $1', [event.hold]))
        .toEqual({ status: 'released', released_by: coordinator });
    });

    it('SCRUM347_AC4_the_equipment_request_is_cancelled_and_its_reservation_released', async () => {
      expect((await one('select status::text from equipment_requests where id = $1', [event.equipmentRequest])).status)
        .toBe('cancelled');
      const reservation = await one('select released_at, release_reason from equipment_reservations where id = $1', [event.reservation]);
      expect(reservation.released_at).not.toBeNull();
      expect(reservation.release_reason).toBe('event rejected');
    });

    it('SCRUM347_AC4_the_released_booking_and_hold_no_longer_occupy_their_venues', async () => {
      const occupants = (venueId) => rows(
        'select kind, event_request_id from venue_occupancy_conflicts($1, $2, $3, true, null)',
        [venueId, event.start, event.end],
      );
      expect(await occupants(event.venues.approved)).toEqual([]);
      expect(await occupants(event.venues.held)).toEqual([]);
    });

    it('SCRUM347_AC6_open_change_requests_are_closed_and_processed_ones_left_alone', async () => {
      const changeRequest = (id) => one(
        'select status::text, decision::text, decision_notes, processed_by from event_change_requests where id = $1',
        [id],
      );
      const closed = { status: 'processed', decision: 'event_rejected', decision_notes: null, processed_by: coordinator };

      expect(await changeRequest(event.changeRequests.outstanding)).toEqual(closed);
      expect(await changeRequest(event.changeRequests.inProgress)).toEqual(closed);
      expect(await changeRequest(event.changeRequests.processed)).toMatchObject({ status: 'processed', decision: 'approved' });
    });

    it('SCRUM347_AC7_the_organiser_venue_staff_and_technical_support_are_notified', async () => {
      const sent = await notifications(event.id);

      expect(sent.filter((n) => n.audience === 'organiser')).toEqual([expect.objectContaining({
        recipient_id: organiser,
        booking_id: null,
        payload: expect.objectContaining({ reason: 'The only suitable hall is closed.' }),
      })]);
      // One per released booking: the pending request and the approved booking.
      // The request never held the venue, so it says withdrawn, not released.
      expect(sent.filter((n) => n.audience === 'venue_staff').map((n) => [n.recipient_id, n.booking_id, n.payload.outcome]).sort())
        .toEqual([
          [venueStaff, event.bookings.pending, 'withdrawn'],
          [venueStaff, event.bookings.approved, 'cancelled'],
        ].sort());
      expect(sent.filter((n) => n.audience === 'technical_support_staff')).toEqual([expect.objectContaining({
        recipient_id: technicalSupport,
        payload: expect.objectContaining({ equipmentRequestId: event.equipmentRequest }),
      })]);
    });

    it('SCRUM347_AC6_the_organiser_can_still_reopen_it_and_the_history_reads_approval_then_rejection', async () => {
      await getDb().query('select reopen_event_request($1, $2)', [event.id, organiser]);

      expect((await decisionHistory(event.id)).map((h) => [h.decision, h.superseded_reason])).toEqual([
        ['approved', 'rejected_after_approval'],
        ['rejected', 'reopened_for_revision'],
      ]);
    });
  });

  it('SCRUM347_AC3_after_a_reassignment_the_new_coordinator_rejects_and_becomes_the_reviewer', async () => {
    const approver = await user(ROLE.EVENT_COORDINATOR);
    const successor = await user(ROLE.EVENT_COORDINATOR);
    const lead = await user(ROLE.EVENT_COORDINATOR_LEAD);
    const event = await eventWithArrangements(approver);
    await getDb().query('select reassign_event_request($1, $2, $3, null)', [event.id, successor, lead]);
    expect((await eventRow(event.id)).reviewing_coordinator_id).toBe(approver);

    await expectSqlError(reject(event.id, approver), '42501');
    await reject(event.id, successor);

    expect(await eventRow(event.id)).toMatchObject({
      status: 'rejected', decided_by: successor, reviewing_coordinator_id: successor,
    });
    expect((await decisionHistory(event.id))[0].decided_by).toBe(approver);
  });

  describe('a refused rejection changes nothing', () => {
    it.each([
      ['another coordinator', () => user(ROLE.EVENT_COORDINATOR)],
      ['the Lead', () => user(ROLE.EVENT_COORDINATOR_LEAD)],
      ['Venue Staff', () => venueStaff],
      ['the organiser', () => organiser],
      ['a null caller', () => null],
    ])('SCRUM347_AC1_%s_is_refused_with_42501', async (_who, caller) => {
      const event = await eventWithArrangements(await user(ROLE.EVENT_COORDINATOR));
      const before = await snapshot(event);

      await expectSqlError(reject(event.id, await caller()), '42501');

      expect(await snapshot(event)).toEqual(before);
    });

    it.each([
      ['submitted', 'Submitted'],
      ['under_review', 'Under review'],
      ['pending_clarification', 'Pending clarification'],
      ['safety_review', 'in Safety review'],
      ['safety_approved', 'Safety approved'],
      ['rejected', 'Rejected'],
      ['cancelled', 'Cancelled'],
    ])('SCRUM347_AC1_a_%s_event_is_refused_with_its_status_named', async (status, words) => {
      const coordinator = await user(ROLE.EVENT_COORDINATOR);
      const event = await eventWithArrangements(coordinator, status);
      const before = await snapshot(event);

      const error = await refusal(reject(event.id, coordinator));

      expect(error.code).toBe('55000');
      expect(error.message).toBe(`This event is ${words}, and only an Approved event can be rejected.`);
      expect(error.hint).toBeUndefined();
      expect(await snapshot(event)).toEqual(before);
    });

    it('SCRUM347_AC1_a_confirmed_event_is_refused_with_a_suggestion_to_cancel_it', async () => {
      const coordinator = await user(ROLE.EVENT_COORDINATOR);
      const event = await eventWithArrangements(coordinator, 'confirmed');
      const before = await snapshot(event);

      const error = await refusal(reject(event.id, coordinator));

      expect(error.code).toBe('55000');
      expect(error.message).toBe('This event is Confirmed, and only an Approved event can be rejected. Cancel it instead.');
      expect(error.hint).toBe('CANCEL_INSTEAD');
      expect(await snapshot(event)).toEqual(before);
    });

    it.each([
      ['empty', ''],
      ['spaces', '   '],
      ['tabs and line breaks', '\t\n '],
      ['missing', null],
    ])('SCRUM347_AC1_a_%s_reason_is_refused_with_22023', async (_kind, reason) => {
      const coordinator = await user(ROLE.EVENT_COORDINATOR);
      const event = await eventWithArrangements(coordinator);
      const before = await snapshot(event);

      await expectSqlError(reject(event.id, coordinator, reason), '22023');

      expect(await snapshot(event)).toEqual(before);
    });

    it('SCRUM347_AC1_a_missing_event_is_refused_with_P0002', async () => {
      await expectSqlError(reject('00000000-0000-0000-0000-000000000000', await user(ROLE.EVENT_COORDINATOR)), 'P0002');
    });
  });

  it('SCRUM347_AC7_technical_support_hears_of_reservations_freed_from_an_already_cancelled_request', async () => {
    const coordinator = await user(ROLE.EVENT_COORDINATOR);
    const event = await eventWithArrangements(coordinator);
    // Written directly: a request cancelled with its reservation still held (029).
    const cancelledRequest = (await one(
      "insert into equipment_requests (event_request_id, status) values ($1, 'cancelled') returning id",
      [event.id],
    )).id;
    const line = (await one(
      'insert into equipment_lines (equipment_request_id, equipment_type_id, quantity) values ($1, $2, 1) returning id',
      [cancelledRequest, equipmentType],
    )).id;
    const heldReservation = (await one(
      `insert into equipment_reservations (equipment_type_id, event_request_id, equipment_line_id, quantity, start_at, end_at)
       values ($1, $2, $3, 1, $4, $5) returning id`,
      [equipmentType, event.id, line, event.start, event.end],
    )).id;

    await reject(event.id, coordinator);

    expect((await one('select released_at from equipment_reservations where id = $1', [heldReservation])).released_at)
      .not.toBeNull();
    const told = (await notifications(event.id))
      .filter((n) => n.audience === 'technical_support_staff')
      .map((n) => n.payload.equipmentRequestId)
      .sort();
    expect(told).toEqual([event.equipmentRequest, cancelledRequest].sort());
  });

  it('SCRUM347_AC7_an_already_cancelled_request_with_nothing_held_is_not_mentioned', async () => {
    const coordinator = await user(ROLE.EVENT_COORDINATOR);
    const event = await eventWithArrangements(coordinator);
    await one("insert into equipment_requests (event_request_id, status) values ($1, 'cancelled') returning id", [event.id]);

    await reject(event.id, coordinator);

    expect((await notifications(event.id)).filter((n) => n.audience === 'technical_support_staff').map((n) => n.payload.equipmentRequestId))
      .toEqual([event.equipmentRequest]);
  });

  describe('other events waiting behind a released booking (027)', () => {
    // Another event's request for the slot our approved booking held, marked
    // Conflicting because of it.
    async function waitingBehind(event) {
      const coordinator = await user(ROLE.EVENT_COORDINATOR);
      const otherEvent = await seedEvent(getDb(), {
        status: 'approved',
        event_name: `Waiting ${next()}`,
        organiser_id: organiser,
        assigned_coordinator_id: coordinator,
        proposed_start: event.start,
        proposed_end: event.end,
      });
      const request = await seedBooking(getDb(), { venueId: event.venues.approved, eventId: otherEvent, status: 'conflicting' });
      return { coordinator, request };
    }
    const bookingStatus = async (id) => (await one('select status::text from bookings where id = $1', [id])).status;
    const clearedNotices = (bookingId) => rows(
      "select recipient_id, payload from notifications where type = 'booking_request_conflict_cleared' and booking_id = $1",
      [bookingId],
    );

    it('SCRUM347_AC4_a_rejection_returns_their_request_to_pending_and_tells_their_coordinator', async () => {
      const coordinator = await user(ROLE.EVENT_COORDINATOR);
      const event = await eventWithArrangements(coordinator);
      const waiting = await waitingBehind(event);

      await reject(event.id, coordinator);

      expect(await bookingStatus(waiting.request)).toBe('pending');
      expect(await clearedNotices(waiting.request)).toEqual([{
        recipient_id: waiting.coordinator,
        payload: expect.objectContaining({ releasedBookingId: event.bookings.approved }),
      }]);
    });

    it('SCRUM347_AC4_a_request_something_else_still_blocks_stays_conflicting', async () => {
      const coordinator = await user(ROLE.EVENT_COORDINATOR);
      const event = await eventWithArrangements(coordinator);
      const waiting = await waitingBehind(event);
      await seedBlock(getDb(), { venueId: event.venues.approved, start: event.start, end: event.end });

      await reject(event.id, coordinator);

      expect(await bookingStatus(waiting.request)).toBe('conflicting');
      expect(await clearedNotices(waiting.request)).toEqual([]);
    });

    it('SCRUM347_AC4_cancelling_an_event_frees_them_too', async () => {
      const coordinator = await user(ROLE.EVENT_COORDINATOR);
      const event = await eventWithArrangements(coordinator);
      const waiting = await waitingBehind(event);

      await getDb().query(
        "select cancel_event_request($1, $2, 'No longer needed', 'connectsphere_decision')",
        [event.id, coordinator],
      );

      expect(await bookingStatus(waiting.request)).toBe('pending');
      expect(await clearedNotices(waiting.request)).toHaveLength(1);
    });
  });

  it('SCRUM347_AC4_a_failure_while_releasing_rolls_back_everything_and_notifies_nobody', async () => {
    const coordinator = await user(ROLE.EVENT_COORDINATOR);
    const event = await eventWithArrangements(coordinator);
    const before = await snapshot(event);
    // Holds are released last, so bookings and equipment have already changed when this fires.
    await getDb().exec(`
      create function fail_hold_release() returns trigger language plpgsql as $$
      begin
        raise exception 'simulated release failure' using errcode = 'P0001';
      end;
      $$;
      create trigger fail_hold_release before update on venue_holds
        for each row execute function fail_hold_release();
    `);

    try {
      await expectSqlError(reject(event.id, coordinator), 'P0001');
    } finally {
      await getDb().exec('drop trigger fail_hold_release on venue_holds; drop function fail_hold_release();');
    }

    expect(await snapshot(event)).toEqual(before);
    expect(await notifications(event.id)).toEqual([]);
  });
});
