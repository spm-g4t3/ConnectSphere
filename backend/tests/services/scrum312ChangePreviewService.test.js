/**
 * Tests for the equipment change preview service.
 *
 * SCRUM-312, a subtask of SCRUM-310 "Handle Equipment Lost After Reservation".
 * Named SCRUM310_ACn_<what_it_checks>.
 *
 *   - what usable figure each kind of change is sent to the database with
 *   - the preview only reads: one select, at most one rpc, never a write
 *   - a change that does not lower the usable figure asks the database nothing
 *     and previews as affecting nothing (the confirmed save, SCRUM-313, skips
 *     the check for the same changes)
 *   - bad input, a missing type and a retired type are refused before the rpc
 *   - every database refusal becomes the right typed error
 *   - the rows come back in the API's shape, with counts that add up
 *   - the rpc arguments match the real function's parameter names
 *
 * The Supabase client is mocked with a factory, as in equipmentService.test.js.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { ok, dbError, queryStub, errorFrom } from '../fixtures/supabaseStubs.js';

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock('../../src/config/supabaseClient.js', () => {
  const client = { from, rpc };
  return { supabase: client, default: client };
});

const { previewEquipmentChange } = await import('../../src/services/equipmentChangePreviewService.js');
const { supabase } = await import('../../src/config/supabaseClient.js');
const { ValidationError, NotFoundError, ConflictError, ForbiddenError } = await import('../../src/errors.js');

const TYPE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const USER_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

/** total 10, damaged 2, under maintenance 1: usable 7. */
function typeRow(overrides = {}) {
  return {
    id: TYPE_ID,
    name: 'Projector',
    total_quantity: 10,
    damaged_quantity: 2,
    under_maintenance_quantity: 1,
    retired_at: null,
    ...overrides,
  };
}

function affectedRow(overrides = {}) {
  return {
    reservation_id: 'r1',
    event_request_id: 'e1',
    event_name: 'Open Day',
    equipment_line_id: 'l1',
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

/** Script the type read and the rpc answer; returns the select stub. */
function script({ row = typeRow(), data = [] } = {}) {
  const select = queryStub(ok(row));
  from.mockReturnValueOnce(select);
  rpc.mockResolvedValueOnce(ok(data));
  return select;
}

beforeEach(() => {
  from.mockReset();
  rpc.mockReset();
});

describe('the test double', () => {
  it('SCRUM310_AC1_the_supabase_client_is_mocked_and_never_the_real_one', () => {
    expect(vi.isMockFunction(supabase.rpc)).toBe(true);
    expect(vi.isMockFunction(supabase.from)).toBe(true);
  });
});

describe('SCRUM310 the usable figure sent to the database', () => {
  it.each([
    ['a smaller total', { totalQuantity: 6 }, 3], // 6 - 2 - 1
    ['the smallest total that holds today\'s damage', { totalQuantity: 3 }, 0],
    ['more damaged', { damagedQuantity: 5 }, 4], // 10 - 5 - 1
    ['more under maintenance', { underMaintenanceQuantity: 4 }, 4], // 10 - 2 - 4
    ['both conditions', { damagedQuantity: 4, underMaintenanceQuantity: 3 }, 3],
    ['everything unusable', { damagedQuantity: 9, underMaintenanceQuantity: 1 }, 0],
    ['a total with both conditions', { totalQuantity: 8, damagedQuantity: 1, underMaintenanceQuantity: 1 }, 6],
    ['a total with one condition', { totalQuantity: 8, damagedQuantity: 4 }, 3], // 8 - 4 - 1
    ['a total of one less with nothing else', { totalQuantity: 9 }, 6],
  ])('SCRUM310_AC1_sends_%s_as_the_right_usable_figure', async (_label, input, usableAfter) => {
    script();
    const result = await previewEquipmentChange(TYPE_ID, input, USER_ID);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('equipment_over_commitment', {
      p_equipment_type_id: TYPE_ID,
      p_usable_after: usableAfter,
      p_caller: USER_ID,
    });
    expect(result.usableAfter).toBe(usableAfter);
    expect(result.usableBefore).toBe(7);
  });

  it.each([
    ['a total equal to today', { totalQuantity: 10 }, 7],
    ['a larger total', { totalQuantity: 20 }, 17],
    ['no damaged', { damagedQuantity: 0 }, 9],
    ['no under maintenance', { underMaintenanceQuantity: 0 }, 8],
    ['damage swapped for maintenance', { damagedQuantity: 1, underMaintenanceQuantity: 2 }, 7],
    ['a total that rises with more damage', { totalQuantity: 12, damagedQuantity: 4 }, 7],
  ])('SCRUM310_AC1_%s_does_not_lower_the_usable_figure_so_nothing_is_asked_or_affected', async (_label, input, usableAfter) => {
    script({ data: [affectedRow()] }); // would show a row if the database were asked
    const result = await previewEquipmentChange(TYPE_ID, input, USER_ID);

    expect(result.usableAfter).toBe(usableAfter);
    expect(result.usableAfter).toBeGreaterThanOrEqual(result.usableBefore);
    expect(rpc).not.toHaveBeenCalled();
    expect(result.affected).toEqual([]);
    expect(result.affectedCount).toBe(0);
    expect(result.affectedUnits).toBe(0);
  });

  it('SCRUM310_AC1_a_retirement_is_previewed_as_zero_usable_whatever_the_quantities', async () => {
    script();
    const result = await previewEquipmentChange(TYPE_ID, { retire: true }, USER_ID);

    expect(rpc.mock.calls[0][1].p_usable_after).toBe(0);
    expect(result.usableAfter).toBe(0);
    expect(result.usableBefore).toBe(7);
  });

  it('SCRUM310_AC7_a_retirement_of_a_type_with_nothing_usable_affects_nothing_and_asks_nothing', async () => {
    script({ row: typeRow({ damaged_quantity: 10, under_maintenance_quantity: 0 }) });
    const result = await previewEquipmentChange(TYPE_ID, { retire: true }, USER_ID);

    expect(result.usableBefore).toBe(0);
    expect(result.usableAfter).toBe(0);
    expect(result.affected).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM310_AC1_a_retired_type_can_still_have_a_quantity_change_previewed', async () => {
    script({ row: typeRow({ retired_at: '2026-10-02T00:00:00+00:00' }) });
    const result = await previewEquipmentChange(TYPE_ID, { totalQuantity: 5 }, USER_ID);

    expect(result.usableAfter).toBe(2);
  });

  it('SCRUM310_AC1_an_unusable_current_state_does_not_break_the_arithmetic', async () => {
    script({ row: typeRow({ total_quantity: 0, damaged_quantity: 0, under_maintenance_quantity: 0 }) });
    const result = await previewEquipmentChange(TYPE_ID, { totalQuantity: 0 }, USER_ID);

    expect(result.usableBefore).toBe(0);
    expect(result.usableAfter).toBe(0);
  });
});

describe('SCRUM310 it only reads', () => {
  it('SCRUM310_AC2_makes_one_select_on_the_type_and_one_rpc_and_nothing_else', async () => {
    const select = script();
    await previewEquipmentChange(TYPE_ID, { totalQuantity: 4 }, USER_ID);

    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('equipment_types');
    expect(select.called('select')).toBe(true);
    expect(select.args('eq')).toEqual(['id', TYPE_ID]);
    for (const write of ['insert', 'update', 'delete']) expect(select.called(write)).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe('equipment_over_commitment');
  });

  it.each([
    ['a total', { totalQuantity: 5 }],
    ['a condition', { damagedQuantity: 3 }],
    ['a retirement', { retire: true }],
  ])('SCRUM310_AC2_%s_preview_calls_no_other_function', async (_label, input) => {
    script();
    await previewEquipmentChange(TYPE_ID, input, USER_ID);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['equipment_over_commitment']);
  });

  it('SCRUM310_AC1_the_caller_sent_is_the_one_passed_in_and_nothing_in_the_body_can_change_it', async () => {
    script();
    await previewEquipmentChange(
      TYPE_ID,
      { totalQuantity: 4, callerId: 'other', p_caller: 'other', userId: 'other' },
      USER_ID,
    );
    expect(rpc.mock.calls[0][1].p_caller).toBe(USER_ID);
  });

  it('SCRUM310_AC1_a_usable_figure_in_the_body_is_never_trusted', async () => {
    script();
    await previewEquipmentChange(TYPE_ID, { totalQuantity: 4, usableAfter: 100, p_usable_after: 100 }, USER_ID);
    expect(rpc.mock.calls[0][1].p_usable_after).toBe(1);
  });
});

describe('SCRUM310 refused before the database function runs', () => {
  it.each([
    ['not-a-uuid'],
    [''],
    [null],
    [undefined],
    [42],
    ['3f2504e0-4f89-41d3-9a0c-0305e82c330'],
  ])('SCRUM310_AC1_a_bad_id_%j_is_a_400_with_no_query', async (id) => {
    const err = await errorFrom(previewEquipmentChange(id, { totalQuantity: 1 }, USER_ID));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'id', message: 'must be a UUID' }]);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    [null],
    [undefined],
    ['retire'],
    [[]],
    [{}],
    [{ totalQuantity: -1 }],
    [{ retire: false }],
    [{ retire: true, totalQuantity: 1 }],
  ])('SCRUM310_AC1_a_bad_body_%j_is_a_400_with_no_query', async (body) => {
    const err = await errorFrom(previewEquipmentChange(TYPE_ID, body, USER_ID));
    expect(err).toBeInstanceOf(ValidationError);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM310_AC1_an_unknown_type_is_a_404_and_the_rpc_is_not_asked', async () => {
    from.mockReturnValueOnce(queryStub(ok(null)));
    const err = await errorFrom(previewEquipmentChange(TYPE_ID, { totalQuantity: 1 }, USER_ID));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM310_AC1_retiring_a_retired_type_is_a_409_with_its_code_and_the_rpc_is_not_asked', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow({ retired_at: '2026-10-02T00:00:00+00:00' }))));
    const err = await errorFrom(previewEquipmentChange(TYPE_ID, { retire: true }, USER_ID));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('EQUIPMENT_ALREADY_RETIRED');
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['a total of zero', { totalQuantity: 0 }, 'totalQuantity'],
    ['a total one below damaged plus maintenance', { totalQuantity: 2 }, 'totalQuantity'],
    ['damaged above the total', { damagedQuantity: 10 }, 'damagedQuantity'], // 10 + 1 > 10
    ['under maintenance above the total', { underMaintenanceQuantity: 9 }, 'underMaintenanceQuantity'], // 2 + 9 > 10
    [
      'both conditions together above the total',
      { damagedQuantity: 6, underMaintenanceQuantity: 5 },
      'damagedQuantity',
    ],
    [
      'a smaller total that the conditions no longer fit',
      { totalQuantity: 5, damagedQuantity: 4, underMaintenanceQuantity: 2 },
      'totalQuantity',
    ],
  ])('SCRUM310_AC1_%s_is_a_400_naming_%s_with_no_rpc', async (_label, input, field) => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    const err = await errorFrom(previewEquipmentChange(TYPE_ID, input, USER_ID));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details.map((d) => d.field)).toContain(field);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM310_AC1_damaged_plus_maintenance_exactly_equal_to_the_total_is_allowed', async () => {
    script();
    const result = await previewEquipmentChange(TYPE_ID, { damagedQuantity: 9 }, USER_ID); // 9 + 1 = 10
    expect(result.usableAfter).toBe(0);
  });

  it('SCRUM310_AC1_a_retirement_ignores_the_quantity_rule_even_on_an_oddly_stored_type', async () => {
    script({ row: typeRow({ total_quantity: 1, damaged_quantity: 5, under_maintenance_quantity: 5 }) });
    const result = await previewEquipmentChange(TYPE_ID, { retire: true }, USER_ID);
    expect(result.usableAfter).toBe(0);
  });
});

describe('SCRUM310 database refusals become typed errors', () => {
  it.each([
    ['42501', ForbiddenError],
    ['P0002', NotFoundError],
    ['22023', ValidationError],
    ['22P02', ValidationError],
  ])('SCRUM310_AC1_rpc_error_%s_becomes_%s', async (code, ErrorClass) => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(dbError(code, 'database says no'));

    const err = await errorFrom(previewEquipmentChange(TYPE_ID, { totalQuantity: 4 }, USER_ID));
    expect(err).toBeInstanceOf(ErrorClass);
  });

  it('SCRUM310_AC1_an_unlisted_rpc_error_stays_an_untyped_failure', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(dbError('XX000', 'boom'));

    const err = await errorFrom(previewEquipmentChange(TYPE_ID, { totalQuantity: 4 }, USER_ID));
    expect(err).toBeInstanceOf(Error);
    for (const typed of [ValidationError, NotFoundError, ConflictError, ForbiddenError]) {
      expect(err).not.toBeInstanceOf(typed);
    }
  });

  it('SCRUM310_AC1_a_failed_read_of_the_type_is_not_swallowed_and_the_rpc_is_not_asked', async () => {
    from.mockReturnValueOnce(queryStub(dbError('XX000', 'read failed')));
    const err = await errorFrom(previewEquipmentChange(TYPE_ID, { totalQuantity: 4 }, USER_ID));
    expect(err).toBeInstanceOf(Error);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([[null], [undefined], [{}], ['[]'], [5]])(
    'SCRUM310_AC1_an_rpc_answer_that_is_not_a_list_(%j)_is_an_error_not_an_empty_result',
    async (data) => {
      from.mockReturnValueOnce(queryStub(ok(typeRow())));
      rpc.mockResolvedValueOnce({ data, error: null });

      const err = await errorFrom(previewEquipmentChange(TYPE_ID, { totalQuantity: 4 }, USER_ID));
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/did not return a list/);
    },
  );
});

describe('SCRUM310 what comes back', () => {
  it('SCRUM310_AC7_names_the_type_and_reports_no_one_affected_for_an_empty_list', async () => {
    script({ data: [] });
    const result = await previewEquipmentChange(TYPE_ID, { totalQuantity: 9 }, USER_ID);

    expect(result).toEqual({
      equipmentTypeId: TYPE_ID,
      equipmentName: 'Projector',
      usableBefore: 7,
      usableAfter: 6,
      affectedCount: 0,
      affectedUnits: 0,
      affected: [],
    });
  });

  it('SCRUM310_AC2_maps_a_row_to_the_api_shape_field_by_field', async () => {
    script({ data: [affectedRow()] });
    const { affected } = await previewEquipmentChange(TYPE_ID, { totalQuantity: 4 }, USER_ID);

    expect(affected).toEqual([
      {
        reservationId: 'r1',
        eventRequestId: 'e1',
        eventName: 'Open Day',
        equipmentLineId: 'l1',
        quantity: 3,
        startAt: '2026-11-05T01:00:00+00:00',
        endAt: '2026-11-05T05:00:00+00:00',
        coordinatorId: 'c1',
        coordinatorName: 'Cara Coordinator',
        flagged: false,
        reservedAt: '2026-10-01T00:00:00+00:00',
      },
    ]);
  });

  it('SCRUM310_AC2_keeps_the_order_the_database_gave_and_totals_the_units', async () => {
    script({
      data: [
        affectedRow({ reservation_id: 'a', quantity: 2, flagged: true }),
        affectedRow({ reservation_id: 'b', quantity: 5 }),
        affectedRow({ reservation_id: 'c', quantity: 1 }),
      ],
    });
    const result = await previewEquipmentChange(TYPE_ID, { totalQuantity: 4 }, USER_ID);

    expect(result.affected.map((row) => row.reservationId)).toEqual(['a', 'b', 'c']);
    expect(result.affectedCount).toBe(3);
    expect(result.affectedUnits).toBe(8);
    expect(result.affected[0].flagged).toBe(true);
  });

  it('SCRUM310_AC2_a_coordinator_with_no_name_comes_back_as_null_not_dropped', async () => {
    script({ data: [affectedRow({ coordinator_id: null, coordinator_name: null })] });
    const { affected } = await previewEquipmentChange(TYPE_ID, { totalQuantity: 4 }, USER_ID);

    expect(affected[0].coordinatorId).toBeNull();
    expect(affected[0].coordinatorName).toBeNull();
    expect(Object.keys(affected[0])).toContain('coordinatorName');
  });

  it('SCRUM310_AC2_returns_a_fresh_result_each_time', async () => {
    script({ data: [affectedRow()] });
    script({ data: [] });
    const first = await previewEquipmentChange(TYPE_ID, { totalQuantity: 4 }, USER_ID);
    const second = await previewEquipmentChange(TYPE_ID, { totalQuantity: 4 }, USER_ID);

    expect(first.affectedCount).toBe(1);
    expect(second.affectedCount).toBe(0);
  });
});

describe('SCRUM310 the rpc contract', () => {
  const sql = readFileSync(
    new URL('../../db/migrations/020_equipment_over_commitment.sql', import.meta.url),
    'utf8',
  );

  it('SCRUM310_AC1_the_argument_names_sent_are_the_parameter_names_of_the_real_function', async () => {
    script();
    await previewEquipmentChange(TYPE_ID, { totalQuantity: 4 }, USER_ID);

    const sent = Object.keys(rpc.mock.calls[0][1]).sort();
    const declared = sql
      .match(/create or replace function equipment_over_commitment\(([^)]*)\)/s)[1]
      .split(',')
      .map((part) => part.trim().split(/\s+/)[0])
      .sort();

    expect(sent).toEqual(declared);
  });

  it('SCRUM310_AC1_every_field_read_from_a_row_is_a_key_the_function_builds', () => {
    const built = [...sql.matchAll(/'([a-z_]+)',/g)].map((m) => m[1]);
    for (const key of Object.keys(affectedRow())) expect(built).toContain(key);
  });
});
