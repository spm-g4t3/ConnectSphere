/**
 * Service tests for the reservation actions.
 *
 * SCRUM-300. Named SCRUM300_ACn_<what_it_checks>. The client is a test double, so
 * these are about what the service sends, what it refuses before the database
 * is called, and how each database refusal becomes a typed error. What the
 * database does is tested against Postgres in
 * tests/db/equipmentReservationsDatabase.test.js.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: {}, supabaseAdmin: {} }));

import {
  reserveEquipment,
  reduceEquipmentReservation,
  releaseEquipmentReservation,
  moveEquipmentReservation,
  keepEquipmentReservation,
  toReviewState,
} from '../../src/services/equipmentReviewService.js';
import { ValidationError, NotFoundError, ConflictError, ForbiddenError } from '../../src/errors.js';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const LINE_ID = '22222222-2222-4222-8222-222222222222';
const TYPE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const REQUEST_ID = '55555555-5555-4555-8555-555555555555';
const RESERVATION_ID = '44444444-4444-4444-8444-444444444444';
const COORDINATOR_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const REVIEWER_ID = '66666666-6666-4666-8666-666666666666';

const reservationRow = (overrides = {}) => ({
  id: RESERVATION_ID,
  quantity: 2,
  start_at: '2026-12-01T10:00:00+00:00',
  end_at: '2026-12-01T12:00:00+00:00',
  flagged: false,
  flag_reason: null,
  flagged_at: null,
  can_keep: false,
  ...overrides,
});

const reviewRow = (reservations = [reservationRow()]) => ({
  event: {
    id: EVENT_ID,
    name: 'Annual Dinner',
    proposed_start: '2026-12-01T10:00:00+00:00',
    proposed_end: '2026-12-01T12:00:00+00:00',
    assigned_coordinator_id: COORDINATOR_ID,
  },
  request: {
    id: REQUEST_ID,
    status: 'under_review',
    reviewer_id: REVIEWER_ID,
    review_started_at: '2026-10-09T08:00:00+00:00',
    created_at: '2026-10-08T09:00:00+00:00',
    updated_at: '2026-10-09T08:00:00+00:00',
    lines: [
      {
        id: LINE_ID,
        equipment_type_id: TYPE_ID,
        name: 'Projector',
        quantity: 5,
        technical_notes: null,
        type_retired: false,
        reserved: 2,
        reservations,
        outcome: null,
        outcome_note: null,
        outcome_by: null,
        outcome_at: null,
        availability: null,
      },
    ],
  },
});

const ok = (data) => ({ data, error: null });
const dbError = (code, message) => ({ data: null, error: { code, message } });

function query(result) {
  const chain = {};
  for (const method of ['select', 'in', 'eq', 'order', 'limit']) chain[method] = vi.fn(() => chain);
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function fakeClient(rpc = {}) {
  const rpcCalls = [];
  return {
    rpcCalls,
    rpc: vi.fn(async (name, args) => {
      rpcCalls.push({ name, args });
      return rpc[name] ?? ok(reviewRow());
    }),
    from: vi.fn(() => query(ok([]))),
  };
}

const failure = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
};

const ACTIONS = [
  ['reserve', 'reserve_equipment', (c, user = REVIEWER_ID) => reserveEquipment(EVENT_ID, LINE_ID, { quantity: 2 }, user, { client: c })],
  ['reduce', 'reduce_equipment_reservation', (c, user = REVIEWER_ID) => reduceEquipmentReservation(EVENT_ID, RESERVATION_ID, { quantity: 1, reason: 'Less' }, user, { client: c })],
  ['release', 'release_equipment_reservation', (c, user = REVIEWER_ID) => releaseEquipmentReservation(EVENT_ID, RESERVATION_ID, { reason: 'Done' }, user, { client: c })],
  ['move', 'move_equipment_reservation', (c, user = REVIEWER_ID) => moveEquipmentReservation(EVENT_ID, RESERVATION_ID, {}, user, { client: c })],
  ['keep', 'keep_equipment_reservation', (c, user = REVIEWER_ID) => keepEquipmentReservation(EVENT_ID, RESERVATION_ID, {}, user, { client: c })],
];

describe('what is sent to the database', () => {
  it('SCRUM300_AC2_reserve_sends_the_line_the_quantity_and_the_signed_in_user', async () => {
    const client = fakeClient();
    await reserveEquipment(EVENT_ID, LINE_ID, { quantity: 3, userId: 'forged' }, REVIEWER_ID, { client });
    expect(client.rpcCalls[0]).toEqual({
      name: 'reserve_equipment',
      args: { p_event_request_id: EVENT_ID, p_user_id: REVIEWER_ID, p_line_id: LINE_ID, p_quantity: 3 },
    });
  });

  it('SCRUM300_AC4_reduce_sends_the_quantity_and_the_trimmed_reason', async () => {
    const client = fakeClient();
    await reduceEquipmentReservation(EVENT_ID, RESERVATION_ID, { quantity: 1, reason: ' Less needed ' }, REVIEWER_ID, { client });
    expect(client.rpcCalls[0].args).toEqual({
      p_event_request_id: EVENT_ID,
      p_user_id: REVIEWER_ID,
      p_reservation_id: RESERVATION_ID,
      p_quantity: 1,
      p_reason: 'Less needed',
    });
  });

  it('SCRUM300_AC4_release_sends_the_reason', async () => {
    const client = fakeClient();
    await releaseEquipmentReservation(EVENT_ID, RESERVATION_ID, { reason: 'Wrong item' }, REVIEWER_ID, { client });
    expect(client.rpcCalls[0]).toMatchObject({
      name: 'release_equipment_reservation',
      args: { p_reason: 'Wrong item', p_user_id: REVIEWER_ID },
    });
  });

  it.each([['move', moveEquipmentReservation, 'move_equipment_reservation'], ['keep', keepEquipmentReservation, 'keep_equipment_reservation']])(
    'SCRUM300_AC7_%s_sends_a_null_reason_when_none_is_given',
    async (_what, fn, rpcName) => {
      const client = fakeClient();
      await fn(EVENT_ID, RESERVATION_ID, undefined, REVIEWER_ID, { client });
      expect(client.rpcCalls[0]).toMatchObject({ name: rpcName, args: { p_reason: null } });
    },
  );

  it.each(ACTIONS)('SCRUM300_AC1_%s_never_takes_the_caller_from_the_input', async (_what, _rpc, call) => {
    const client = fakeClient();
    await call(client, REVIEWER_ID);
    expect(client.rpcCalls[0].args.p_user_id).toBe(REVIEWER_ID);
  });
});

describe('refused before the database is called', () => {
  it.each([0, -2, 1.5, '3', null, undefined])('SCRUM300_AC2_reserve_refuses_quantity_%j_with_400', async (quantity) => {
    const client = fakeClient();
    const err = await failure(reserveEquipment(EVENT_ID, LINE_ID, { quantity }, REVIEWER_ID, { client }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM300_AC4_reduce_without_a_reason_is_refused', async () => {
    const client = fakeClient();
    const err = await failure(reduceEquipmentReservation(EVENT_ID, RESERVATION_ID, { quantity: 1 }, REVIEWER_ID, { client }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([expect.objectContaining({ field: 'reason' })]);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM300_AC4_release_without_a_reason_is_refused', async () => {
    const client = fakeClient();
    const err = await failure(releaseEquipmentReservation(EVENT_ID, RESERVATION_ID, {}, REVIEWER_ID, { client }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['event id', () => reserveEquipment('nope', LINE_ID, { quantity: 1 }, REVIEWER_ID, { client: fakeClient() })],
    ['line id', () => reserveEquipment(EVENT_ID, 'nope', { quantity: 1 }, REVIEWER_ID, { client: fakeClient() })],
    ['reservation id (reduce)', () => reduceEquipmentReservation(EVENT_ID, 'nope', { quantity: 1, reason: 'x' }, REVIEWER_ID, { client: fakeClient() })],
    ['reservation id (release)', () => releaseEquipmentReservation(EVENT_ID, 'nope', { reason: 'x' }, REVIEWER_ID, { client: fakeClient() })],
    ['reservation id (move)', () => moveEquipmentReservation(EVENT_ID, 'nope', {}, REVIEWER_ID, { client: fakeClient() })],
    ['reservation id (keep)', () => keepEquipmentReservation(EVENT_ID, 'nope', {}, REVIEWER_ID, { client: fakeClient() })],
  ])('SCRUM300_a_bad_%s_is_a_400', async (_what, call) => {
    expect(await failure(call())).toBeInstanceOf(ValidationError);
  });

  it.each(ACTIONS)('SCRUM300_AC1_%s_without_a_signed_in_user_is_refused', async (_what, _rpc, call) => {
    const client = fakeClient();
    expect(await failure(call(client, ''))).toBeInstanceOf(ValidationError);
    expect(client.rpc).not.toHaveBeenCalled();
  });
});

describe('database refusals become typed errors', () => {
  it.each(ACTIONS)('SCRUM300_AC1_%s_not_the_reviewer_is_403', async (_what, rpcName, call) => {
    const client = fakeClient({ [rpcName]: dbError('42501', 'Only the current reviewer can do this') });
    expect(await failure(call(client))).toBeInstanceOf(ForbiddenError);
  });

  it.each(ACTIONS)('SCRUM300_AC1_%s_wrong_status_is_409', async (_what, rpcName, call) => {
    const client = fakeClient({ [rpcName]: dbError('55000', 'This can only be done while the request is Under review.') });
    const err = await failure(call(client));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toMatch(/Under review/);
  });

  it.each(ACTIONS)('SCRUM300_%s_a_lost_race_40001_is_409', async (_what, rpcName, call) => {
    const client = fakeClient({ [rpcName]: dbError('40001', 'changed') });
    expect(await failure(call(client))).toBeInstanceOf(ConflictError);
  });

  it.each(ACTIONS)('SCRUM300_%s_not_found_is_404', async (_what, rpcName, call) => {
    const client = fakeClient({ [rpcName]: dbError('P0002', 'Reservation not found') });
    expect(await failure(call(client))).toBeInstanceOf(NotFoundError);
  });

  it('SCRUM300_AC2_more_than_available_is_a_400_on_quantity_and_keeps_the_figure', async () => {
    const client = fakeClient({ reserve_equipment: dbError('22023', 'Only 1 available for this period, so 2 cannot be reserved') });
    const err = await failure(reserveEquipment(EVENT_ID, LINE_ID, { quantity: 2 }, REVIEWER_ID, { client }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/Only 1 available/);
    expect(err.details).toEqual([expect.objectContaining({ field: 'quantity' })]);
  });

  it('SCRUM300_AC2_more_than_the_line_needs_is_a_400_on_quantity', async () => {
    const client = fakeClient({ reserve_equipment: dbError('22023', 'Only 1 more can be reserved on this line (it needs 3 and 2 is already reserved)') });
    const err = await failure(reserveEquipment(EVENT_ID, LINE_ID, { quantity: 2 }, REVIEWER_ID, { client }));
    expect(err.details).toEqual([expect.objectContaining({ field: 'quantity' })]);
  });

  it('SCRUM300_AC4_a_reason_the_database_refuses_is_a_400_on_reason', async () => {
    const client = fakeClient({ release_equipment_reservation: dbError('22023', 'A reason is required') });
    const err = await failure(releaseEquipmentReservation(EVENT_ID, RESERVATION_ID, { reason: 'x' }, REVIEWER_ID, { client }));
    expect(err.details).toEqual([expect.objectContaining({ field: 'reason' })]);
  });

  it('SCRUM300_AC7_a_move_the_database_refuses_for_availability_is_a_400', async () => {
    const client = fakeClient({ move_equipment_reservation: dbError('22023', 'Only 0 available for the event\'s current period, so 2 cannot be moved there') });
    expect(await failure(moveEquipmentReservation(EVENT_ID, RESERVATION_ID, {}, REVIEWER_ID, { client }))).toBeInstanceOf(ValidationError);
  });

  it('SCRUM300_AC7_a_keep_the_database_refuses_is_a_409_with_the_reason_in_words', async () => {
    const client = fakeClient({ keep_equipment_reservation: dbError('55000', 'This reservation cannot be kept. Its period no longer matches the event.') });
    const err = await failure(keepEquipmentReservation(EVENT_ID, RESERVATION_ID, {}, REVIEWER_ID, { client }));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toMatch(/period no longer matches/);
  });

  it('SCRUM300_an_unexpected_database_error_is_left_untyped_so_it_becomes_a_500', async () => {
    const client = fakeClient({ reserve_equipment: dbError('XX000', 'boom') });
    const err = await failure(reserveEquipment(EVENT_ID, LINE_ID, { quantity: 1 }, REVIEWER_ID, { client }));
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err.status).toBeUndefined();
  });
});

describe('the review state carries the reservations', () => {
  it('SCRUM300_AC7_each_line_lists_its_reservations_in_camelCase_with_the_flag', () => {
    const state = toReviewState(
      reviewRow([
        reservationRow(),
        reservationRow({ id: '99999999-9999-4999-8999-999999999999', quantity: 1, flagged: true, flag_reason: 'The event date or time changed', flagged_at: '2026-10-12T09:00:00+00:00', can_keep: true }),
      ]),
    );
    const line = state.request.lines[0];
    expect(line.reservations).toHaveLength(2);
    expect(line.reservations[1]).toEqual({
      id: '99999999-9999-4999-8999-999999999999',
      quantity: 1,
      startAt: '2026-12-01T10:00:00+00:00',
      endAt: '2026-12-01T12:00:00+00:00',
      flagged: true,
      flagReason: 'The event date or time changed',
      flaggedAt: '2026-10-12T09:00:00+00:00',
      canKeep: true,
    });
    expect(line.reservations[0].canKeep).toBe(false);
    expect(line.flaggedCount).toBe(1);
  });

  it('SCRUM300_AC7_a_reservation_with_no_can_keep_in_the_read_is_not_keepable', () => {
    const row = reviewRow();
    delete row.request.lines[0].reservations[0].can_keep;
    expect(toReviewState(row).request.lines[0].reservations[0].canKeep).toBe(false);
  });

  it('SCRUM300_a_line_with_no_reservations_has_an_empty_list_and_no_flags', () => {
    const state = toReviewState(reviewRow([]));
    expect(state.request.lines[0]).toMatchObject({ reservations: [], flaggedCount: 0 });
  });

  it('SCRUM300_a_review_row_with_no_reservations_key_maps_to_an_empty_list', () => {
    const row = reviewRow();
    delete row.request.lines[0].reservations;
    expect(toReviewState(row).request.lines[0]).toMatchObject({ reservations: [], flaggedCount: 0 });
  });
});
