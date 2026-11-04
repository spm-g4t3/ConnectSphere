/**
 * The equipment change preview service, with the Supabase client mocked. The usable
 * quantities and the affected list come from the database function, which the database
 * tests cover; these check what is sent to it, what is refused first, and the mapping back.
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

/** Script the type read and the rpc answer; returns the select stub. `data` is the affected list. */
function script({ row = typeRow(), data = [], usable = [7, 6] } = {}) {
  const select = queryStub(ok(row));
  from.mockReturnValueOnce(select);
  rpc.mockResolvedValueOnce(ok({ usable_before: usable[0], usable_after: usable[1], affected: data }));
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

const NONE = { p_total: null, p_damaged: null, p_under_maintenance: null, p_retire: false };

describe('SCRUM310 what is sent to the database function', () => {
  it.each([
    ['a smaller total', { totalQuantity: 6 }, { p_total: 6 }],
    ['a larger total', { totalQuantity: 20 }, { p_total: 20 }],
    ['more damaged', { damagedQuantity: 5 }, { p_damaged: 5 }],
    ['no damaged', { damagedQuantity: 0 }, { p_damaged: 0 }],
    ['more under maintenance', { underMaintenanceQuantity: 4 }, { p_under_maintenance: 4 }],
    ['both conditions', { damagedQuantity: 4, underMaintenanceQuantity: 3 }, { p_damaged: 4, p_under_maintenance: 3 }],
    ['a total with a condition', { totalQuantity: 8, damagedQuantity: 4 }, { p_total: 8, p_damaged: 4 }],
    ['a retirement', { retire: true }, { p_retire: true }],
  ])('SCRUM310_AC1_sends_%s_as_it_was_given_and_leaves_the_rest_null', async (_label, input, sent) => {
    script();
    await previewEquipmentChange(TYPE_ID, input, USER_ID);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('equipment_change_affected', {
      p_equipment_type_id: TYPE_ID,
      p_caller: USER_ID,
      ...NONE,
      ...sent,
    });
  });

  it('SCRUM310_AC1_the_database_decides_whether_a_change_can_affect_anything_so_it_is_always_asked', async () => {
    script({ data: [affectedRow()], usable: [7, 17] });
    const result = await previewEquipmentChange(TYPE_ID, { totalQuantity: 20 }, USER_ID);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(result.affectedCount).toBe(1);
  });

  it('SCRUM310_AC1_the_usable_quantities_are_the_ones_the_database_answered', async () => {
    script({ usable: [7, 0] });
    const result = await previewEquipmentChange(TYPE_ID, { retire: true }, USER_ID);

    expect(result.usableBefore).toBe(7);
    expect(result.usableAfter).toBe(0);
  });

  it('SCRUM310_AC1_a_retired_type_can_still_have_a_quantity_change_previewed', async () => {
    script({ row: typeRow({ retired_at: '2026-10-02T00:00:00+00:00' }) });
    await previewEquipmentChange(TYPE_ID, { totalQuantity: 5 }, USER_ID);

    expect(rpc).toHaveBeenCalledTimes(1);
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
    expect(rpc.mock.calls[0][0]).toBe('equipment_change_affected');
  });

  it.each([
    ['a total', { totalQuantity: 5 }],
    ['a condition', { damagedQuantity: 3 }],
    ['a retirement', { retire: true }],
  ])('SCRUM310_AC2_%s_preview_calls_no_other_function', async (_label, input) => {
    script();
    await previewEquipmentChange(TYPE_ID, input, USER_ID);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['equipment_change_affected']);
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

  it('SCRUM310_AC1_a_usable_figure_in_the_body_is_never_sent', async () => {
    script();
    await previewEquipmentChange(TYPE_ID, { totalQuantity: 4, usableAfter: 100, p_usable_after: 100 }, USER_ID);
    expect(Object.keys(rpc.mock.calls[0][1]).sort()).toEqual(Object.keys({ p_equipment_type_id: 1, p_caller: 1, ...NONE }).sort());
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
    script({ usable: [7, 0] });
    await previewEquipmentChange(TYPE_ID, { damagedQuantity: 9 }, USER_ID); // 9 + 1 = 10
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('SCRUM310_AC1_a_retirement_ignores_the_quantity_rule_even_on_an_oddly_stored_type', async () => {
    script({ row: typeRow({ total_quantity: 1, damaged_quantity: 5, under_maintenance_quantity: 5 }), usable: [0, 0] });
    await previewEquipmentChange(TYPE_ID, { retire: true }, USER_ID);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('SCRUM310_AC1_a_name_that_is_already_taken_is_a_400_naming_name_and_the_rpc_is_not_asked', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    from.mockReturnValueOnce(queryStub(ok([{ id: 'other' }])));

    const err = await errorFrom(previewEquipmentChange(TYPE_ID, { totalQuantity: 4, name: 'Speaker' }, USER_ID));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details.map((d) => d.field)).toEqual(['name']);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([[''], ['   '], [42]])('SCRUM310_AC1_a_bad_name_%j_is_a_400_with_no_query', async (name) => {
    const err = await errorFrom(previewEquipmentChange(TYPE_ID, { totalQuantity: 4, name }, USER_ID));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details.map((d) => d.field)).toContain('name');
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM310_AC1_a_free_name_goes_through_and_is_never_sent_to_the_database_function', async () => {
    script();
    from.mockReturnValueOnce(queryStub(ok([])));

    await previewEquipmentChange(TYPE_ID, { totalQuantity: 4, name: 'Speaker', description: 'Loud' }, USER_ID);

    expect(Object.keys(rpc.mock.calls[0][1]).sort()).toEqual(Object.keys({ p_equipment_type_id: 1, p_caller: 1, ...NONE }).sort());
  });

  it('SCRUM310_AC1_a_retirement_with_an_edited_field_is_refused', async () => {
    const err = await errorFrom(previewEquipmentChange(TYPE_ID, { retire: true, name: 'Speaker' }, USER_ID));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details.map((d) => d.field)).toContain('retire');
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
  const read = (file) => readFileSync(new URL(`../../db/migrations/${file}`, import.meta.url), 'utf8');
  const sql = read('020_equipment_over_commitment.sql');
  const fixesSql = read('026_equipment_loss_fixes.sql');

  it('SCRUM310_AC1_the_argument_names_sent_are_the_parameter_names_of_the_real_function', async () => {
    script();
    await previewEquipmentChange(TYPE_ID, { totalQuantity: 4 }, USER_ID);

    const sent = Object.keys(rpc.mock.calls[0][1]).sort();
    const declared = fixesSql
      .match(/create or replace function equipment_change_affected\(([^)]*)\)/s)[1]
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
