/**
 * Tests for the equipment line service.
 *
 * SCRUM-244, a subtask of SCRUM-21. Named SCRUM21_ACn_<what_it_checks>.
 *
 *   AC1  -- only the assigned coordinator of an Approved event; each refusal
 *           from the database becomes the right typed error
 *   AC2-AC5 -- adding lines, with every invalid field reported together
 *   AC6, AC7 -- amending and removing
 *   AC11 -- reading an event's equipment
 *
 * The client is a test double passed in through the options, so no credentials
 * are read and nothing leaves the process. What the database does is tested
 * against a real Postgres in tests/db/equipmentLinesDatabase.test.js.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  listEventEquipment,
  addEquipmentLine,
  amendEquipmentLine,
  removeEquipmentLine,
} from '../../src/services/equipmentLineService.js';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
  AppError,
} from '../../src/errors.js';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const LINE_ID = '22222222-2222-4222-8222-222222222222';
const TYPE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OTHER_TYPE_ID = '4f2504e0-4f89-41d3-9a0c-0305e82c3302';
const COORDINATOR_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const REQUEST_ID = '55555555-5555-4555-8555-555555555555';

const lineRow = (overrides = {}) => ({
  id: LINE_ID,
  equipment_type_id: TYPE_ID,
  name: 'Projector',
  quantity: 2,
  technical_notes: null,
  type_retired: false,
  created_at: '2026-10-08T09:00:00+00:00',
  updated_at: '2026-10-08T09:00:00+00:00',
  ...overrides,
});

const stateRow = ({ status = 'pending_review', lines = [lineRow()] } = {}) => ({
  request: {
    id: REQUEST_ID,
    status,
    created_at: '2026-10-08T09:00:00+00:00',
    updated_at: '2026-10-08T09:00:00+00:00',
    lines,
  },
});

const dbError = (code, message) => ({ data: null, error: { code, message } });
const ok = (data) => ({ data, error: null });


/**
 * A client whose `rpc` answers by function name and whose `from` answers the
 * single-row read of equipment_types and the existence read of event_requests.
 */
function fakeClient({ rpc = {}, type = { id: TYPE_ID, retired_at: null }, event = { id: EVENT_ID } } = {}) {
  const rpcCalls = [];
  const fromCalls = [];

  return {
    rpcCalls,
    fromCalls,
    rpc: vi.fn(async (name, args) => {
      rpcCalls.push({ name, args });
      const answer = rpc[name];
      if (answer === undefined) return ok({ request: null });
      return typeof answer === 'function' ? answer(args) : answer;
    }),
    from: vi.fn((table) => {
      fromCalls.push(table);
      const row = table === 'equipment_types' ? type : event;
      return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(ok(row)) }) }),
      };
    }),
  };
}

const writes = (client) =>
  client.rpcCalls.filter(({ name }) => /^(add|amend|remove)_equipment_line$/.test(name));

const failure = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
};

let client;
beforeEach(() => {
  client = fakeClient();
});


describe('AC2 to AC5: adding a line', () => {
  it('SCRUM21_AC5_calls_add_equipment_line_with_the_caller_and_the_fields', async () => {
    client = fakeClient({ rpc: { add_equipment_line: ok(stateRow()) } });

    await addEquipmentLine(
      EVENT_ID,
      { equipmentTypeId: TYPE_ID, quantity: 2, technicalNotes: '  needs HDMI ' },
      COORDINATOR_ID,
      { client },
    );

    expect(writes(client)).toEqual([
      {
        name: 'add_equipment_line',
        args: {
          p_event_request_id: EVENT_ID,
          p_coordinator_id: COORDINATOR_ID,
          p_equipment_type_id: TYPE_ID,
          p_quantity: 2,
          p_technical_notes: 'needs HDMI',
        },
      },
    ]);
  });

  it('SCRUM21_AC11_answers_in_camel_case_with_a_readable_status', async () => {
    client = fakeClient({
      rpc: { add_equipment_line: ok(stateRow({ status: 'cannot_be_fully_arranged', lines: [lineRow({ technical_notes: 'x' })] })) },
    });

    const state = await addEquipmentLine(EVENT_ID, { equipmentTypeId: TYPE_ID, quantity: 2 }, COORDINATOR_ID, { client });

    expect(state.request.status).toBe('cannot_be_fully_arranged');
    expect(state.request.statusLabel).toBe('Cannot be fully arranged');
    expect(state.request.lines[0]).toEqual({
      id: LINE_ID,
      equipmentTypeId: TYPE_ID,
      name: 'Projector',
      quantity: 2,
      technicalNotes: 'x',
      typeRetired: false,
      reserved: 0,
      outcome: null,
      outcomeNote: null,
      createdAt: '2026-10-08T09:00:00+00:00',
      updatedAt: '2026-10-08T09:00:00+00:00',
    });
    expect(JSON.stringify(state)).not.toMatch(/equipment_type_id|technical_notes|type_retired|outcome_note/);
  });

  it('SCRUM290_AC10_carries_reserved_and_the_reviewers_outcome_to_the_coordinator', async () => {
    client = fakeClient({
      rpc: {
        equipment_for_event: ok(
          stateRow({
            status: 'cannot_be_fully_arranged',
            lines: [lineRow({ reserved: 1, outcome: 'cannot_be_provided', outcome_note: 'Only one in stock' })],
          }),
        ),
      },
    });

    const state = await listEventEquipment(EVENT_ID, { client });

    expect(state.request.lines[0]).toMatchObject({
      reserved: 1,
      outcome: 'cannot_be_provided',
      outcomeNote: 'Only one in stock',
    });
  });

  it('SCRUM21_AC3_refuses_a_bad_quantity_before_any_write', async () => {
    const err = await failure(
      addEquipmentLine(EVENT_ID, { equipmentTypeId: TYPE_ID, quantity: 0 }, COORDINATOR_ID, { client }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details.map((d) => d.field)).toEqual(['quantity']);
    expect(writes(client)).toEqual([]);
  });

  it('SCRUM21_AC2_refuses_an_unknown_type_and_says_so_without_writing', async () => {
    client = fakeClient({ type: null });

    const err = await failure(
      addEquipmentLine(EVENT_ID, { equipmentTypeId: TYPE_ID, quantity: 1 }, COORDINATOR_ID, { client }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'equipmentTypeId', message: 'is not an equipment type' }]);
    expect(writes(client)).toEqual([]);
  });

  it('SCRUM21_AC2_refuses_a_retired_type_and_says_so_without_writing', async () => {
    client = fakeClient({ type: { id: TYPE_ID, retired_at: '2026-09-01T00:00:00Z' } });

    const err = await failure(
      addEquipmentLine(EVENT_ID, { equipmentTypeId: TYPE_ID, quantity: 1 }, COORDINATOR_ID, { client }),
    );

    expect(err.details).toEqual([{ field: 'equipmentTypeId', message: 'is retired and cannot be chosen' }]);
    expect(writes(client)).toEqual([]);
  });

  it('SCRUM21_AC4_refuses_a_type_already_on_the_event_without_writing', async () => {
    client = fakeClient({ rpc: { equipment_for_event: ok(stateRow()) } });

    const err = await failure(
      addEquipmentLine(EVENT_ID, { equipmentTypeId: TYPE_ID, quantity: 1 }, COORDINATOR_ID, { client }),
    );

    expect(err.details).toEqual([{ field: 'equipmentTypeId', message: 'is already on this event' }]);
    expect(writes(client)).toEqual([]);
  });

  it('SCRUM21_AC4_a_different_type_is_not_a_duplicate', async () => {
    client = fakeClient({
      rpc: { equipment_for_event: ok(stateRow()), add_equipment_line: ok(stateRow()) },
    });

    await expect(
      addEquipmentLine(EVENT_ID, { equipmentTypeId: OTHER_TYPE_ID, quantity: 1 }, COORDINATOR_ID, { client }),
    ).resolves.toBeDefined();
    expect(writes(client)).toHaveLength(1);
  });

  it('SCRUM21_AC3_reports_a_bad_quantity_and_a_retired_type_together', async () => {
    client = fakeClient({ type: { id: TYPE_ID, retired_at: '2026-09-01T00:00:00Z' } });

    const err = await failure(
      addEquipmentLine(EVENT_ID, { equipmentTypeId: TYPE_ID, quantity: -1 }, COORDINATOR_ID, { client }),
    );

    expect(err.details.map((d) => d.field).sort()).toEqual(['equipmentTypeId', 'quantity']);
    expect(writes(client)).toEqual([]);
  });

  it('SCRUM21_AC2_asks_the_database_nothing_when_the_type_id_is_not_readable', async () => {
    const err = await failure(
      addEquipmentLine(EVENT_ID, { equipmentTypeId: 'nope', quantity: 1 }, COORDINATOR_ID, { client }),
    );

    expect(err.details).toEqual([{ field: 'equipmentTypeId', message: 'must be a UUID' }]);
    expect(client.fromCalls).toEqual([]);
    expect(client.rpcCalls).toEqual([]);
  });

  it('SCRUM21_AC1_refuses_a_blank_caller_before_any_call', async () => {
    const err = await failure(
      addEquipmentLine(EVENT_ID, { equipmentTypeId: TYPE_ID, quantity: 1 }, '  ', { client }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(client.rpcCalls).toEqual([]);
    expect(client.fromCalls).toEqual([]);
  });

  it('SCRUM21_AC1_refuses_an_event_id_that_is_not_a_uuid_before_any_call', async () => {
    const err = await failure(
      addEquipmentLine('abc', { equipmentTypeId: TYPE_ID, quantity: 1 }, COORDINATOR_ID, { client }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(client.rpcCalls).toEqual([]);
  });
});


describe('AC1: what the database refuses becomes a typed error', () => {
  const NOT_ASSIGNED = "Only the event's assigned coordinator can change its equipment";
  const NOT_APPROVED = 'Equipment can only be changed while the event is Approved. This event is Under review.';
  const CONFIRMED = 'Equipment on this event can only be changed as a significant change';

  const callAdd = (rpcError) => {
    client = fakeClient({ rpc: { add_equipment_line: rpcError } });
    return failure(addEquipmentLine(EVENT_ID, { equipmentTypeId: TYPE_ID, quantity: 1 }, COORDINATOR_ID, { client }));
  };

  it('SCRUM21_AC1_42501_is_a_ForbiddenError_with_the_functions_own_words', async () => {
    const err = await callAdd(dbError('42501', NOT_ASSIGNED));

    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.status).toBe(403);
    expect(err.message).toBe(NOT_ASSIGNED);
  });

  it.each([[NOT_APPROVED], [CONFIRMED]])('SCRUM21_AC1_55000_is_a_conflict_that_keeps_the_message_%#', async (message) => {
    const err = await callAdd(dbError('55000', message));

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('EVENT_NOT_APPROVED');
    expect(err.message).toBe(message);
  });

  it('SCRUM21_AC10_a_confirmed_event_keeps_the_significant_change_wording', async () => {
    const err = await callAdd(dbError('55000', CONFIRMED));
    expect(err.message).toMatch(/significant change/);
  });

  it('SCRUM21_AC3_22023_about_the_quantity_is_a_400_naming_the_field', async () => {
    const err = await callAdd(dbError('22023', 'The quantity must be a whole number greater than zero'));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details[0].field).toBe('quantity');
  });

  it('SCRUM21_AC2_22023_about_the_type_is_a_400_naming_the_field', async () => {
    const err = await callAdd(dbError('22023', 'That equipment type is retired and cannot be chosen'));
    expect(err.details[0].field).toBe('equipmentTypeId');
  });

  it('SCRUM21_AC4_23505_from_a_race_is_a_400_naming_the_type', async () => {
    const err = await callAdd(dbError('23505', 'That equipment type is already on this event'));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'equipmentTypeId', message: 'is already on this event' }]);
  });

  it('SCRUM21_AC1_P0002_is_a_NotFoundError', async () => {
    const err = await callAdd(dbError('P0002', 'Event request not found'));

    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
  });

  it('SCRUM21_AC1_an_unknown_code_is_left_untyped_so_it_reaches_the_api_as_a_500', async () => {
    const err = await callAdd(dbError('XX000', 'secret driver text'));

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AppError);
  });
});


describe('AC6 and AC7: amending a line', () => {
  it('SCRUM21_AC6_calls_amend_equipment_line_with_the_quantity_and_no_notes_change', async () => {
    client = fakeClient({ rpc: { amend_equipment_line: ok(stateRow()) } });

    await amendEquipmentLine(EVENT_ID, LINE_ID, { quantity: 5 }, COORDINATOR_ID, { client });

    expect(writes(client)).toEqual([
      {
        name: 'amend_equipment_line',
        args: {
          p_event_request_id: EVENT_ID,
          p_coordinator_id: COORDINATOR_ID,
          p_line_id: LINE_ID,
          p_quantity: 5,
          p_technical_notes: null,
          p_change_notes: false,
        },
      },
    ]);
  });

  it('SCRUM21_AC6_clearing_the_notes_sends_the_change_flag', async () => {
    client = fakeClient({ rpc: { amend_equipment_line: ok(stateRow()) } });

    await amendEquipmentLine(EVENT_ID, LINE_ID, { technicalNotes: null }, COORDINATOR_ID, { client });

    expect(writes(client)[0].args).toMatchObject({ p_quantity: null, p_technical_notes: null, p_change_notes: true });
  });

  it('SCRUM21_AC6_changing_the_type_is_refused_before_any_call', async () => {
    const err = await failure(
      amendEquipmentLine(EVENT_ID, LINE_ID, { equipmentTypeId: OTHER_TYPE_ID }, COORDINATOR_ID, { client }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details[0].field).toBe('equipmentTypeId');
    expect(client.rpcCalls).toEqual([]);
  });

  it('SCRUM21_AC6_an_empty_amendment_is_refused_before_any_call', async () => {
    const err = await failure(amendEquipmentLine(EVENT_ID, LINE_ID, {}, COORDINATOR_ID, { client }));

    expect(err.details[0].field).toBe('changes');
    expect(client.rpcCalls).toEqual([]);
  });

  it('SCRUM21_AC6_a_line_id_that_is_not_a_uuid_is_refused_before_any_call', async () => {
    const err = await failure(amendEquipmentLine(EVENT_ID, 'abc', { quantity: 2 }, COORDINATOR_ID, { client }));

    expect(err.details).toEqual([{ field: 'lineId', message: 'must be a UUID' }]);
    expect(client.rpcCalls).toEqual([]);
  });

  it('SCRUM21_AC6_a_line_that_is_not_on_the_event_is_a_404', async () => {
    client = fakeClient({ rpc: { amend_equipment_line: dbError('P0002', 'Equipment line not found') } });

    const err = await failure(amendEquipmentLine(EVENT_ID, LINE_ID, { quantity: 2 }, COORDINATOR_ID, { client }));
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it('SCRUM21_AC1_an_amendment_by_someone_else_is_a_403', async () => {
    client = fakeClient({ rpc: { amend_equipment_line: dbError('42501', 'Only the assigned coordinator') } });

    const err = await failure(amendEquipmentLine(EVENT_ID, LINE_ID, { quantity: 2 }, COORDINATOR_ID, { client }));
    expect(err).toBeInstanceOf(ForbiddenError);
  });
});


describe('AC6 to AC8: removing a line', () => {
  it('SCRUM21_AC6_calls_remove_equipment_line_with_the_caller', async () => {
    client = fakeClient({ rpc: { remove_equipment_line: ok(stateRow({ lines: [] })) } });

    const state = await removeEquipmentLine(EVENT_ID, LINE_ID, COORDINATOR_ID, { client });

    expect(writes(client)).toEqual([
      {
        name: 'remove_equipment_line',
        args: { p_event_request_id: EVENT_ID, p_coordinator_id: COORDINATOR_ID, p_line_id: LINE_ID },
      },
    ]);
    expect(state.request.lines).toEqual([]);
  });

  it('SCRUM21_AC8_a_cancelled_request_comes_back_labelled_cancelled', async () => {
    client = fakeClient({ rpc: { remove_equipment_line: ok(stateRow({ status: 'cancelled', lines: [] })) } });

    const state = await removeEquipmentLine(EVENT_ID, LINE_ID, COORDINATOR_ID, { client });

    expect(state.request.status).toBe('cancelled');
    expect(state.request.statusLabel).toBe('Cancelled');
  });

  it('SCRUM21_AC1_removal_in_the_wrong_status_is_a_409', async () => {
    client = fakeClient({ rpc: { remove_equipment_line: dbError('55000', 'Equipment can only be changed while the event is Approved. This event is Submitted.') } });

    const err = await failure(removeEquipmentLine(EVENT_ID, LINE_ID, COORDINATOR_ID, { client }));
    expect(err).toBeInstanceOf(ConflictError);
  });

  it('SCRUM21_AC6_a_blank_caller_is_refused_before_any_call', async () => {
    const err = await failure(removeEquipmentLine(EVENT_ID, LINE_ID, '', { client }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(client.rpcCalls).toEqual([]);
  });
});


describe('AC11: reading an event equipment', () => {
  it('SCRUM21_AC11_returns_the_request_and_its_lines', async () => {
    client = fakeClient({ rpc: { equipment_for_event: ok(stateRow({ status: 'arranged' })) } });

    const state = await listEventEquipment(EVENT_ID, { client });

    expect(state.request.status).toBe('arranged');
    expect(state.request.statusLabel).toBe('Arranged');
    expect(state.request.lines).toHaveLength(1);
  });

  it('SCRUM21_AC11_an_event_that_never_asked_for_equipment_has_request_null', async () => {
    client = fakeClient({ rpc: { equipment_for_event: ok({ request: null }) } });

    await expect(listEventEquipment(EVENT_ID, { client })).resolves.toEqual({ request: null });
  });

  it('SCRUM21_AC11_an_event_that_does_not_exist_is_a_404_not_an_empty_answer', async () => {
    client = fakeClient({ event: null });

    const err = await failure(listEventEquipment(EVENT_ID, { client }));

    expect(err).toBeInstanceOf(NotFoundError);
    expect(client.rpcCalls).toEqual([]);
  });

  it('SCRUM21_AC11_an_id_that_is_not_a_uuid_is_refused_before_any_call', async () => {
    const err = await failure(listEventEquipment('abc', { client }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(client.fromCalls).toEqual([]);
  });

  it('SCRUM21_AC11_a_read_never_calls_a_write_function', async () => {
    client = fakeClient({ rpc: { equipment_for_event: ok({ request: null }) } });

    await listEventEquipment(EVENT_ID, { client });

    expect(writes(client)).toEqual([]);
  });
});
