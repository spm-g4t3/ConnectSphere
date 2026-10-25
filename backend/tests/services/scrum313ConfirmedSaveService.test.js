/**
 * Tests for the confirmed save in the equipment service.
 *
 * SCRUM-313, a subtask of SCRUM-310 "Handle Equipment Lost After Reservation".
 * Named SCRUM310_ACn_<what_it_checks>.
 *
 * Changing a total, recording damage or maintenance and retiring a type all
 * save through one database function, apply_equipment_change. This file covers
 * what the service sends to it, what it does with each answer, and that no
 * path saves anything another way:
 *
 *   - the arguments for each of the three operations
 *   - which edits use it and which stay a plain table update
 *   - a refusal ("the list moved") becomes a 409 carrying the new list
 *   - an answer that is not one of the two documented ones is never read as success
 *   - every database error becomes the right typed error
 *   - nothing is sent to the database when the input is bad
 *
 * The database function itself is tested against a real schema in
 * tests/db/scrum313EquipmentConfirmedSaveDatabase.test.js.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { ok, dbError, queryStub, errorFrom } from '../fixtures/supabaseStubs.js';

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock('../../src/config/supabaseClient.js', () => {
  const client = { from, rpc };
  return { supabase: client, default: client };
});

const { updateEquipmentType, recordEquipmentCondition, retireEquipmentType } =
  await import('../../src/services/equipmentService.js');
const { supabase } = await import('../../src/config/supabaseClient.js');
const { ValidationError, NotFoundError, ConflictError, ForbiddenError } =
  await import('../../src/errors.js');

const TYPE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const USER_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const R3 = '33333333-3333-4333-8333-333333333333';
const RETIRED = '2026-10-20T09:00:00+00:00';

/** total 10, damaged 2, under maintenance 1: usable 7. */
function typeRow(overrides = {}) {
  return {
    id: TYPE_ID,
    name: 'Projector',
    description: 'HD',
    category: 'Display',
    location: 'Store room 1',
    total_quantity: 10,
    damaged_quantity: 2,
    under_maintenance_quantity: 1,
    retired_at: null,
    created_at: '2026-10-01T09:00:00+00:00',
    updated_at: '2026-10-01T09:00:00+00:00',
    ...overrides,
  };
}

function affectedRow(id, overrides = {}) {
  return {
    reservation_id: id,
    event_request_id: `e-${id.slice(0, 2)}`,
    event_name: 'Open Day',
    equipment_line_id: `l-${id.slice(0, 2)}`,
    quantity: 3,
    start_at: '2026-11-05T01:00:00+00:00',
    end_at: '2026-11-05T05:00:00+00:00',
    coordinator_id: 'c1',
    coordinator_name: 'Cara Coordinator',
    flagged: false,
    reserved_at: '2026-10-01T00:00:00+00:00',
    ...overrides,
  };
}

const savedAnswer = (row, { flagged = 0, affected = [] } = {}) =>
  ok({ saved: true, flagged_count: flagged, affected, equipment_type: row });

const refusedAnswer = (affected) => ok({ saved: false, affected });

/** Script the read of the current row. */
function readsRow(row = typeRow()) {
  from.mockReturnValueOnce(queryStub(ok(row)));
}

/** The arguments of the one apply_equipment_change call. */
function applied() {
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc.mock.calls[0][0]).toBe('apply_equipment_change');
  return rpc.mock.calls[0][1];
}

/** The three public operations, each with a valid call that saves. */
const OPERATIONS = [
  ['an edit of the total', (confirmed) =>
    updateEquipmentType(TYPE_ID, { totalQuantity: 5, confirmedReservationIds: confirmed }, USER_ID)],
  ['a damage change', (confirmed) =>
    recordEquipmentCondition(TYPE_ID, { damagedQuantity: 5, note: 'dropped', confirmedReservationIds: confirmed }, USER_ID)],
  ['a maintenance change', (confirmed) =>
    recordEquipmentCondition(TYPE_ID, { underMaintenanceQuantity: 5, note: 'servicing', confirmedReservationIds: confirmed }, USER_ID)],
  ['a retirement', (confirmed) =>
    retireEquipmentType(TYPE_ID, { confirmedReservationIds: confirmed }, USER_ID)],
];

beforeEach(() => {
  from.mockReset();
  rpc.mockReset();
});

describe('the test double', () => {
  it('SCRUM310_AC4_the_supabase_client_is_mocked_and_never_the_real_one', () => {
    expect(vi.isMockFunction(supabase.rpc)).toBe(true);
    expect(vi.isMockFunction(supabase.from)).toBe(true);
  });
});

describe('SCRUM310 what is sent to the database function', () => {
  it('SCRUM310_AC2_a_total_edit_sends_the_total_the_fields_the_note_and_the_confirmed_list', async () => {
    readsRow();
    from.mockReturnValueOnce(queryStub(ok([]))); // the name check, because the name is changing
    rpc.mockResolvedValueOnce(savedAnswer(typeRow({ total_quantity: 5 })));

    await updateEquipmentType(
      TYPE_ID,
      {
        totalQuantity: 5,
        name: 'Big projector',
        description: 'HD 4000',
        category: 'AV',
        location: 'Store 2',
        note: ' fewer than we thought ',
        confirmedReservationIds: [R1, R2],
      },
      USER_ID,
    );

    expect(applied()).toEqual({
      p_equipment_type_id: TYPE_ID,
      p_caller: USER_ID,
      p_total: 5,
      p_damaged: null,
      p_under_maintenance: null,
      p_retire: false,
      p_fields: {
        name: 'Big projector',
        description: 'HD 4000',
        category: 'AV',
        location: 'Store 2',
      },
      p_note: 'fewer than we thought',
      p_confirmed_reservation_ids: [R1, R2],
    });
  });

  it('SCRUM310_AC4_a_total_edit_sends_only_the_fields_that_were_given', async () => {
    readsRow();
    rpc.mockResolvedValueOnce(savedAnswer(typeRow({ total_quantity: 5 })));

    await updateEquipmentType(TYPE_ID, { totalQuantity: 5, location: 'Store 2' }, USER_ID);

    expect(applied().p_fields).toEqual({ location: 'Store 2' });
  });

  it('SCRUM310_AC4_a_total_edit_can_clear_a_text_field', async () => {
    readsRow();
    rpc.mockResolvedValueOnce(savedAnswer(typeRow({ total_quantity: 5, location: null })));

    await updateEquipmentType(TYPE_ID, { totalQuantity: 5, location: null }, USER_ID);

    const { p_fields: fields } = applied();
    expect(Object.hasOwn(fields, 'location')).toBe(true);
    expect(fields.location).toBeNull();
  });

  it('SCRUM310_AC4_a_total_edit_never_puts_the_total_note_or_list_inside_the_fields', async () => {
    readsRow();
    rpc.mockResolvedValueOnce(savedAnswer(typeRow()));

    await updateEquipmentType(
      TYPE_ID,
      { totalQuantity: 5, note: 'n', confirmedReservationIds: [R1] },
      USER_ID,
    );

    expect(applied().p_fields).toEqual({});
  });

  it('SCRUM310_AC4_a_total_of_zero_is_sent_as_zero', async () => {
    readsRow(typeRow({ damaged_quantity: 0, under_maintenance_quantity: 0 }));
    rpc.mockResolvedValueOnce(savedAnswer(typeRow({ total_quantity: 0 })));

    await updateEquipmentType(TYPE_ID, { totalQuantity: 0 }, USER_ID);

    expect(applied().p_total).toBe(0);
  });

  it('SCRUM310_AC8_a_damage_change_sends_the_damage_the_note_and_the_list_and_nothing_else', async () => {
    readsRow();
    rpc.mockResolvedValueOnce(savedAnswer(typeRow({ damaged_quantity: 5 })));

    await recordEquipmentCondition(
      TYPE_ID,
      { damagedQuantity: 5, note: ' dropped ', confirmedReservationIds: [R3] },
      USER_ID,
    );

    expect(applied()).toEqual({
      p_equipment_type_id: TYPE_ID,
      p_caller: USER_ID,
      p_total: null,
      p_damaged: 5,
      p_under_maintenance: null,
      p_retire: false,
      p_fields: {},
      p_note: 'dropped',
      p_confirmed_reservation_ids: [R3],
    });
  });

  it('SCRUM310_AC4_a_maintenance_change_sends_the_maintenance_figure', async () => {
    readsRow();
    rpc.mockResolvedValueOnce(savedAnswer(typeRow({ under_maintenance_quantity: 4 })));

    await recordEquipmentCondition(TYPE_ID, { underMaintenanceQuantity: 4, note: 'servicing' }, USER_ID);

    expect(applied()).toMatchObject({ p_damaged: null, p_under_maintenance: 4, p_total: null });
  });

  it('SCRUM310_AC4_a_retirement_sends_retire_true_and_no_quantities', async () => {
    readsRow();
    rpc.mockResolvedValueOnce(savedAnswer(typeRow({ retired_at: RETIRED })));

    await retireEquipmentType(TYPE_ID, { confirmedReservationIds: [R1], note: ' end of life ' }, USER_ID);

    expect(applied()).toEqual({
      p_equipment_type_id: TYPE_ID,
      p_caller: USER_ID,
      p_total: null,
      p_damaged: null,
      p_under_maintenance: null,
      p_retire: true,
      p_fields: {},
      p_note: 'end of life',
      p_confirmed_reservation_ids: [R1],
    });
  });

  it.each(OPERATIONS)('SCRUM310_AC2_%s_with_no_list_confirms_an_empty_one', async (_label, run) => {
    readsRow();
    rpc.mockResolvedValueOnce(savedAnswer(typeRow()));

    await run(undefined);

    expect(applied().p_confirmed_reservation_ids).toEqual([]);
  });

  it.each(OPERATIONS)('SCRUM310_AC2_%s_sends_the_list_without_repeats', async (_label, run) => {
    readsRow();
    rpc.mockResolvedValueOnce(savedAnswer(typeRow()));

    await run([R1, R2, R1]);

    expect(applied().p_confirmed_reservation_ids).toEqual([R1, R2]);
  });

  it.each(OPERATIONS)('SCRUM310_AC8_%s_is_made_as_the_acting_user', async (_label, run) => {
    readsRow();
    rpc.mockResolvedValueOnce(savedAnswer(typeRow()));

    await run([]);

    expect(applied().p_caller).toBe(USER_ID);
  });

  it('SCRUM310_AC8_without_an_acting_user_the_caller_is_null_and_the_database_refuses', async () => {
    readsRow();
    rpc.mockResolvedValueOnce(dbError('42501', 'Only Technical Support Staff can change equipment'));

    const error = await errorFrom(retireEquipmentType(TYPE_ID));

    expect(applied().p_caller).toBeNull();
    expect(error).toBeInstanceOf(ForbiddenError);
  });

  it.each(OPERATIONS)('SCRUM310_AC4_%s_makes_one_read_and_one_call_and_no_table_write', async (_label, run) => {
    const read = queryStub(ok(typeRow()));
    from.mockReturnValueOnce(read);
    rpc.mockResolvedValueOnce(savedAnswer(typeRow()));

    await run([]);

    expect(from).toHaveBeenCalledTimes(1);
    expect(read.called('select')).toBe(true);
    for (const write of ['insert', 'update', 'delete']) expect(read.called(write)).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe('SCRUM310 edits that do not use the confirmed save', () => {
  it.each([
    ['a name', { name: 'Speaker' }],
    ['a description', { description: 'Loud' }],
    ['a category', { category: 'AV' }],
    ['a location', { location: 'Store 3' }],
    ['several text fields', { category: 'AV', location: 'Store 3' }],
  ])('SCRUM310_AC4_an_edit_of_%s_is_a_plain_update_and_calls_nothing_else', async (_label, changes) => {
    const write = queryStub(ok(typeRow()));
    const calls = [queryStub(ok(typeRow()))];
    if (changes.name) calls.push(queryStub(ok([])));
    calls.push(write);
    for (const call of calls) from.mockReturnValueOnce(call);

    const updated = await updateEquipmentType(TYPE_ID, changes, USER_ID);

    expect(rpc).not.toHaveBeenCalled();
    expect(write.args('update')[0]).toMatchObject({ last_modified_by: USER_ID, last_change_note: null });
    expect(updated.flaggedCount).toBe(0);
    expect(updated.flaggedReservations).toEqual([]);
  });

  it('SCRUM310_AC4_a_list_and_a_note_with_no_total_are_not_written_to_any_column', async () => {
    const write = queryStub(ok(typeRow()));
    from.mockReturnValueOnce(queryStub(ok(typeRow()))).mockReturnValueOnce(write);

    await updateEquipmentType(
      TYPE_ID,
      { location: 'Store 3', note: 'ignored', confirmedReservationIds: [R1] },
      USER_ID,
    );

    expect(write.args('update')).toEqual([
      { location: 'Store 3', last_modified_by: USER_ID, last_change_note: null },
    ]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM310_AC4_a_plain_edit_still_translates_a_deadlock_into_try_again', async () => {
    from
      .mockReturnValueOnce(queryStub(ok(typeRow())))
      .mockReturnValueOnce(queryStub(dbError('40P01', 'deadlock detected')));

    await expect(updateEquipmentType(TYPE_ID, { location: 'X' })).rejects.toMatchObject({
      status: 409,
      code: 'EQUIPMENT_CHANGED_AT_THE_SAME_TIME',
    });
  });

  it('SCRUM310_AC4_reinstating_is_not_a_change_that_needs_confirming', async () => {
    // Imported here so a rename of the function shows up as this test failing.
    const { reinstateEquipmentType } = await import('../../src/services/equipmentService.js');
    from
      .mockReturnValueOnce(queryStub(ok(typeRow({ retired_at: RETIRED }))))
      .mockReturnValueOnce(queryStub(ok(typeRow())));

    await reinstateEquipmentType(TYPE_ID, USER_ID);

    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('SCRUM310 what comes back when it saved', () => {
  it.each(OPERATIONS)('SCRUM310_AC4_%s_returns_the_saved_type_as_the_api_shapes_it', async (_label, run) => {
    readsRow();
    rpc.mockResolvedValueOnce(savedAnswer(typeRow({ total_quantity: 5, damaged_quantity: 1, under_maintenance_quantity: 1 })));

    const result = await run([]);

    expect(result).toMatchObject({
      id: TYPE_ID,
      name: 'Projector',
      totalQuantity: 5,
      damagedQuantity: 1,
      underMaintenanceQuantity: 1,
      usableQuantity: 3,
      retiredAt: null,
    });
  });

  it('SCRUM310_AC4_returns_how_many_were_flagged_and_which', async () => {
    readsRow();
    rpc.mockResolvedValueOnce(
      savedAnswer(typeRow({ damaged_quantity: 5 }), {
        flagged: 2,
        affected: [affectedRow(R1), affectedRow(R2, { quantity: 1, flagged: true })],
      }),
    );

    const result = await recordEquipmentCondition(TYPE_ID, { damagedQuantity: 5, note: 'x', confirmedReservationIds: [R1, R2] }, USER_ID);

    expect(result.flaggedCount).toBe(2);
    expect(result.flaggedReservations).toEqual([
      {
        reservationId: R1,
        eventRequestId: 'e-11',
        eventName: 'Open Day',
        equipmentLineId: 'l-11',
        quantity: 3,
        startAt: '2026-11-05T01:00:00+00:00',
        endAt: '2026-11-05T05:00:00+00:00',
        coordinatorId: 'c1',
        coordinatorName: 'Cara Coordinator',
        flagged: false,
        reservedAt: '2026-10-01T00:00:00+00:00',
      },
      expect.objectContaining({ reservationId: R2, quantity: 1, flagged: true }),
    ]);
  });

  it('SCRUM310_AC7_a_save_that_affected_nothing_returns_zero_and_an_empty_list', async () => {
    readsRow();
    rpc.mockResolvedValueOnce(savedAnswer(typeRow({ damaged_quantity: 3 })));

    const result = await recordEquipmentCondition(TYPE_ID, { damagedQuantity: 3, note: 'x' }, USER_ID);

    expect(result.flaggedCount).toBe(0);
    expect(result.flaggedReservations).toEqual([]);
  });

  it('SCRUM310_AC7_reads_a_missing_count_as_zero_and_missing_affected_as_empty', async () => {
    readsRow();
    rpc.mockResolvedValueOnce(ok({ saved: true, equipment_type: typeRow() }));

    const result = await retireEquipmentType(TYPE_ID, {}, USER_ID);

    expect(result.flaggedCount).toBe(0);
    expect(result.flaggedReservations).toEqual([]);
  });
});

describe('SCRUM310 when the list moved since the preview', () => {
  const MOVED = [affectedRow(R1), affectedRow(R3, { quantity: 2 })];

  it.each(OPERATIONS)('SCRUM310_AC2_%s_is_refused_with_409_and_the_new_list', async (_label, run) => {
    readsRow();
    rpc.mockResolvedValueOnce(refusedAnswer(MOVED));

    const error = await errorFrom(run([R1, R2]));

    expect(error).toBeInstanceOf(ConflictError);
    expect(error.status).toBe(409);
    expect(error.code).toBe('EQUIPMENT_AFFECTED_CHANGED');
    expect(error.conflicts.map((c) => c.reservationId)).toEqual([R1, R3]);
    expect(error.conflicts[1]).toMatchObject({ quantity: 2, eventName: 'Open Day', coordinatorName: 'Cara Coordinator' });
  });

  it('SCRUM310_AC2_a_refusal_with_an_empty_new_list_is_still_a_refusal', async () => {
    readsRow();
    rpc.mockResolvedValueOnce(refusedAnswer([]));

    const error = await errorFrom(retireEquipmentType(TYPE_ID, { confirmedReservationIds: [R1] }, USER_ID));

    expect(error).toBeInstanceOf(ConflictError);
    expect(error.conflicts).toEqual([]);
  });

  it.each(OPERATIONS)('SCRUM310_AC2_%s_does_not_return_a_type_when_refused', async (_label, run) => {
    readsRow();
    rpc.mockResolvedValueOnce(refusedAnswer(MOVED));

    await expect(run([R1])).rejects.toBeInstanceOf(ConflictError);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledTimes(1);
  });

  it('SCRUM310_AC2_the_message_tells_the_staff_member_to_review_again', async () => {
    readsRow();
    rpc.mockResolvedValueOnce(refusedAnswer(MOVED));

    const error = await errorFrom(retireEquipmentType(TYPE_ID, {}, USER_ID));

    expect(error.message).toMatch(/review them again/i);
  });
});

describe('SCRUM310 an answer that is not saved and not refused is never read as success', () => {
  it.each([
    ['nothing', null],
    ['undefined', undefined],
    ['text', 'saved'],
    ['a number', 1],
    ['true', true],
    ['an empty object', {}],
    ['a text saved flag', { saved: 'true', equipment_type: typeRow() }],
    ['a numeric saved flag', { saved: 1, equipment_type: typeRow() }],
    ['a list', [{ saved: true, equipment_type: typeRow() }]],
  ])('SCRUM310_AC4_%s_as_the_answer_is_an_error', async (_label, data) => {
    readsRow();
    rpc.mockResolvedValueOnce(ok(data));

    const error = await errorFrom(retireEquipmentType(TYPE_ID, {}, USER_ID));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ConflictError);
    expect(error.message).toMatch(/did not return/);
  });

  it.each([
    ['no affected list', { saved: false }],
    ['a null affected list', { saved: false, affected: null }],
    ['an object as the affected list', { saved: false, affected: {} }],
    ['text as the affected list', { saved: false, affected: 'none' }],
  ])('SCRUM310_AC2_a_refusal_with_%s_is_an_error_not_an_empty_conflict', async (_label, data) => {
    readsRow();
    rpc.mockResolvedValueOnce(ok(data));

    const error = await errorFrom(retireEquipmentType(TYPE_ID, {}, USER_ID));

    expect(error).not.toBeInstanceOf(ConflictError);
    expect(error.message).toMatch(/did not return/);
  });

  it.each([
    ['no type', { saved: true, flagged_count: 0, affected: [] }],
    ['a null type', { saved: true, flagged_count: 0, affected: [], equipment_type: null }],
    ['text as the type', { saved: true, flagged_count: 0, affected: [], equipment_type: 'row' }],
  ])('SCRUM310_AC4_a_save_with_%s_is_an_error', async (_label, data) => {
    readsRow();
    rpc.mockResolvedValueOnce(ok(data));

    const error = await errorFrom(retireEquipmentType(TYPE_ID, {}, USER_ID));

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/did not return/);
  });
});

describe('SCRUM310 database errors', () => {
  it.each([
    ['42501', 'Only Technical Support Staff can change equipment', ForbiddenError, 403],
    ['P0002', 'Equipment type not found', NotFoundError, 404],
    ['22023', 'A note is required when damaged or under-maintenance units change', ValidationError, 400],
    ['23514', 'unusable_within_total', ValidationError, 400],
    ['23503', 'last_modified_by_fkey', ValidationError, 400],
  ])('SCRUM310_AC4_%s_becomes_the_right_typed_error', async (code, message, Type, status) => {
    readsRow();
    rpc.mockResolvedValueOnce(dbError(code, message));

    const error = await errorFrom(retireEquipmentType(TYPE_ID, {}, USER_ID));

    expect(error).toBeInstanceOf(Type);
    expect(error.status).toBe(status);
  });

  it('SCRUM310_AC2_a_conflict_hint_becomes_the_conflicts_code', async () => {
    readsRow();
    rpc.mockResolvedValueOnce(
      dbError('PT409', 'Equipment type is already retired', { hint: 'EQUIPMENT_ALREADY_RETIRED' }),
    );

    const error = await errorFrom(retireEquipmentType(TYPE_ID, {}, USER_ID));

    expect(error).toBeInstanceOf(ConflictError);
    expect(error.status).toBe(409);
    expect(error.code).toBe('EQUIPMENT_ALREADY_RETIRED');
  });

  it('SCRUM310_AC4_a_deadlock_asks_the_staff_member_to_try_again', async () => {
    readsRow();
    rpc.mockResolvedValueOnce(dbError('40P01', 'deadlock detected'));

    const error = await errorFrom(recordEquipmentCondition(TYPE_ID, { damagedQuantity: 5, note: 'x' }, USER_ID));

    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe('EQUIPMENT_CHANGED_AT_THE_SAME_TIME');
  });

  it('SCRUM310_AC4_an_error_the_service_does_not_know_stays_untyped', async () => {
    readsRow();
    rpc.mockResolvedValueOnce(dbError('57014', 'canceling statement due to statement timeout'));

    const error = await errorFrom(retireEquipmentType(TYPE_ID, {}, USER_ID));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ValidationError);
    expect(error).not.toBeInstanceOf(ConflictError);
    expect(error.message).toMatch(/timeout/);
  });

  it('SCRUM310_AC4_a_failed_call_is_not_retried_by_the_service', async () => {
    readsRow();
    rpc.mockResolvedValueOnce(dbError('57014', 'timeout'));

    await errorFrom(retireEquipmentType(TYPE_ID, {}, USER_ID));

    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe('SCRUM310 nothing reaches the database function when the input is bad', () => {
  it.each([
    ['a malformed id', () => updateEquipmentType('nope', { totalQuantity: 5 })],
    ['a malformed id on a condition change', () => recordEquipmentCondition('nope', { damagedQuantity: 1, note: 'x' })],
    ['a body naming no field on an edit', () => updateEquipmentType(TYPE_ID, { note: 'x', confirmedReservationIds: [] })],
    ['a body naming no quantity on a condition change', () => recordEquipmentCondition(TYPE_ID, { note: 'x', confirmedReservationIds: [] })],
    ['a bad list on a retirement', () => retireEquipmentType(TYPE_ID, { confirmedReservationIds: [1] })],
    ['a bad note on a retirement', () => retireEquipmentType(TYPE_ID, { note: {} })],
    ['a bad body on a retirement', () => retireEquipmentType(TYPE_ID, 'retire')],
    ['a malformed id on a retirement', () => retireEquipmentType('nope', {})],
  ])('SCRUM310_AC4_%s_is_refused_before_any_query', async (_label, run) => {
    await expect(run()).rejects.toBeInstanceOf(ValidationError);
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  // An edit and a condition change read the row first so that every problem,
  // including the ones that need the stored figures, is listed together.
  it.each([
    ['a bad list on an edit', () => updateEquipmentType(TYPE_ID, { totalQuantity: 5, confirmedReservationIds: 'x' }), 'confirmedReservationIds'],
    ['a bad note on an edit', () => updateEquipmentType(TYPE_ID, { totalQuantity: 5, note: 7 }), 'note'],
    ['a bad list on a condition change', () => recordEquipmentCondition(TYPE_ID, { damagedQuantity: 1, note: 'x', confirmedReservationIds: ['x'] }), 'confirmedReservationIds'],
    ['a missing note on a condition change', () => recordEquipmentCondition(TYPE_ID, { damagedQuantity: 1 }), 'note'],
  ])('SCRUM310_AC4_%s_is_refused_and_names_the_field', async (_label, run, field) => {
    readsRow();

    const error = await errorFrom(run());

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.details.map((d) => d.field)).toContain(field);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM310_AC4_a_total_below_damaged_plus_maintenance_is_refused_before_the_call', async () => {
    readsRow();

    await expect(updateEquipmentType(TYPE_ID, { totalQuantity: 2 })).rejects.toBeInstanceOf(ValidationError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM310_AC4_a_name_already_used_is_refused_before_the_call', async () => {
    readsRow();
    from.mockReturnValueOnce(queryStub(ok([{ id: 'other' }])));

    await expect(updateEquipmentType(TYPE_ID, { totalQuantity: 5, name: 'Speaker' })).rejects.toBeInstanceOf(ValidationError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM310_AC4_an_unknown_type_is_not_found_before_the_call', async () => {
    from.mockReturnValueOnce(queryStub(ok(null)));

    await expect(retireEquipmentType(TYPE_ID, {})).rejects.toBeInstanceOf(NotFoundError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM310_AC4_a_type_that_is_already_retired_is_a_409_before_the_call', async () => {
    readsRow(typeRow({ retired_at: RETIRED }));

    await expect(retireEquipmentType(TYPE_ID, {})).rejects.toMatchObject({
      status: 409,
      code: 'EQUIPMENT_ALREADY_RETIRED',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM310_AC4_a_failed_read_of_the_row_stops_before_the_call', async () => {
    from.mockReturnValueOnce(queryStub(dbError('57014', 'timeout')));

    await expect(retireEquipmentType(TYPE_ID, {})).rejects.toThrow('timeout');
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('SCRUM310 the arguments match the real function', () => {
  const sql = readFileSync(
    new URL('../../db/migrations/021_equipment_confirmed_save.sql', import.meta.url),
    'utf8',
  );
  const signature = sql.slice(
    sql.indexOf('create or replace function apply_equipment_change('),
    sql.indexOf('returns jsonb'),
  );
  const declared = [...signature.matchAll(/^\s+(p_[a-z_]+)\s/gm)].map((m) => m[1]);

  it('SCRUM310_AC4_the_migration_declares_nine_parameters', () => {
    expect(declared).toHaveLength(9);
  });

  it.each(OPERATIONS)('SCRUM310_AC4_%s_sends_exactly_the_declared_parameter_names', async (_label, run) => {
    readsRow();
    rpc.mockResolvedValueOnce(savedAnswer(typeRow()));

    await run([]);

    expect(Object.keys(applied()).sort()).toEqual([...declared].sort());
  });

  it('SCRUM310_AC4_the_rpc_name_is_the_function_the_migration_creates', () => {
    expect(sql).toContain('create or replace function apply_equipment_change(');
  });
});
