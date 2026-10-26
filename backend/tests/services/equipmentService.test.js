/**
 * Tests for the equipment catalogue service.
 *
 * SCRUM-276, a subtask of SCRUM-275 "Maintain Equipment Catalogue and
 * Status". Named SCRUM275_ACn_<what_it_checks>.
 *
 *   AC2 -- create: required fields, unique name ignoring capitalisation, every
 *          invalid field listed together
 *   AC3 -- edit under the same rules; the total can't drop below damaged plus
 *          under maintenance
 *   AC5 -- usable quantity is total minus damaged minus under maintenance
 *   AC6 -- the picker only ever receives active types
 *
 * The Supabase client is mocked with a factory, as in venueService.test.js:
 * supabaseClient.js throws at import time without credentials, so automocking
 * (which loads the real module first) would trip exactly that. The guard test
 * exists because on a machine with a real .env a failed mock would run against
 * live data and still pass.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, dbError, queryStub } from '../fixtures/supabaseStubs.js';

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock('../../src/config/supabaseClient.js', () => {
  const client = { from, rpc };
  return { supabase: client, default: client };
});

const {
  createEquipmentType,
  updateEquipmentType,
  listEquipmentTypes,
  listActiveEquipmentTypes,
  getEquipmentTypeHistory,
  recordEquipmentCondition,
  retireEquipmentType,
  reinstateEquipmentType,
} = await import('../../src/services/equipmentService.js');

const { supabase } = await import('../../src/config/supabaseClient.js');
const { ValidationError, NotFoundError, ConflictError } = await import('../../src/errors.js');


const TYPE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OTHER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const USER_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

/** The row shape the service selects. */
function typeRow(overrides = {}) {
  return {
    id: TYPE_ID,
    name: 'Projector',
    description: 'HD, 4000 lumens',
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

/**
 * What apply_equipment_change answers when it saved (SCRUM-313). The type goes
 * through the database function, so these tests script the rpc, not a table write.
 */
function saved(row, { flagged = 0, affected = [] } = {}) {
  return ok({ saved: true, flagged_count: flagged, affected, equipment_type: row });
}

/** The arguments of the one apply_equipment_change call. */
function appliedWith() {
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc.mock.calls[0][0]).toBe('apply_equipment_change');
  return rpc.mock.calls[0][1];
}

beforeEach(() => {
  from.mockReset();
  rpc.mockReset();
});


describe('the test double', () => {
  it('SCRUM275_the_supabase_client_is_mocked_and_never_the_real_one', () => {
    expect(vi.isMockFunction(supabase.from)).toBe(true);
  });
});


describe('AC2: creating a type', () => {
  it('SCRUM275_AC2_inserts_the_five_fields_as_columns_and_returns_the_type', async () => {
    const nameCheck = queryStub(ok([]));
    const insert = queryStub(ok(typeRow({ damaged_quantity: 0, under_maintenance_quantity: 0 })));
    from.mockReturnValueOnce(nameCheck).mockReturnValueOnce(insert);

    const created = await createEquipmentType({
      name: ' Projector ',
      description: 'HD, 4000 lumens',
      category: 'Display',
      location: 'Store room 1',
      totalQuantity: 10,
    });

    expect(insert.args('insert')).toEqual([
      {
        name: 'Projector',
        description: 'HD, 4000 lumens',
        category: 'Display',
        location: 'Store room 1',
        total_quantity: 10,
        last_modified_by: null,
      },
    ]);
    expect(created).toMatchObject({ id: TYPE_ID, name: 'Projector', totalQuantity: 10, usableQuantity: 10 });
  });

  it('SCRUM275_AC2_checks_the_name_ignoring_capitalisation', async () => {
    const nameCheck = queryStub(ok([]));
    from.mockReturnValueOnce(nameCheck).mockReturnValueOnce(queryStub(ok(typeRow())));

    await createEquipmentType({ name: 'PROJECTOR', totalQuantity: 1 });

    expect(from).toHaveBeenNthCalledWith(1, 'equipment_types');
    expect(nameCheck.called('ilike')).toBe(true);
    expect(nameCheck.args('ilike')).toEqual(['name', 'PROJECTOR']);
  });

  it('SCRUM275_AC2_matches_wildcard_characters_literally', async () => {
    const nameCheck = queryStub(ok([]));
    from.mockReturnValueOnce(nameCheck).mockReturnValueOnce(queryStub(ok(typeRow())));

    await createEquipmentType({ name: '50%_off\\', totalQuantity: 1 });

    expect(nameCheck.args('ilike')).toEqual(['name', '50\\%\\_off\\\\']);
  });

  it('SCRUM275_AC2_refuses_a_name_already_in_use_and_writes_nothing', async () => {
    from.mockReturnValueOnce(queryStub(ok([{ id: OTHER_ID }])));

    const attempt = createEquipmentType({ name: 'projector', totalQuantity: 1 });

    await expect(attempt).rejects.toMatchObject({
      status: 400,
      details: [{ field: 'name', message: 'is already used by another equipment type' }],
    });
    expect(from).toHaveBeenCalledTimes(1);
  });

  it('SCRUM275_AC2_lists_a_duplicate_name_together_with_the_other_invalid_fields', async () => {
    from.mockReturnValueOnce(queryStub(ok([{ id: OTHER_ID }])));

    const attempt = createEquipmentType({ name: 'projector', totalQuantity: -1, location: 5 });

    await expect(attempt).rejects.toMatchObject({
      details: [
        { field: 'totalQuantity' },
        { field: 'location' },
        { field: 'name', message: 'is already used by another equipment type' },
      ],
    });
  });

  it('SCRUM275_AC2_does_not_look_up_a_name_that_is_already_invalid', async () => {
    const attempt = createEquipmentType({ name: '  ', totalQuantity: 1 });

    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC2_refuses_a_body_that_is_not_an_object_before_any_query', async () => {
    await expect(createEquipmentType(null)).rejects.toBeInstanceOf(ValidationError);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC2_answers_409_when_two_writers_race_to_the_same_name', async () => {
    from
      .mockReturnValueOnce(queryStub(ok([])))
      .mockReturnValueOnce(queryStub(dbError('23505', 'duplicate key value violates unique constraint')));

    const attempt = createEquipmentType({ name: 'Projector', totalQuantity: 1 });

    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    await expect(attempt).rejects.toMatchObject({ status: 409, code: 'EQUIPMENT_NAME_TAKEN' });
  });

  it('SCRUM275_AC2_translates_a_check_constraint_into_a_ValidationError', async () => {
    from
      .mockReturnValueOnce(queryStub(ok([])))
      .mockReturnValueOnce(queryStub(dbError('23514', 'violates check constraint')));

    await expect(createEquipmentType({ name: 'Cable', totalQuantity: 1 })).rejects.toBeInstanceOf(ValidationError);
  });

  it('SCRUM275_AC2_lets_an_unexpected_database_error_through_untyped', async () => {
    from.mockReturnValueOnce(queryStub({ data: null, error: { code: '57014', message: 'timeout' } }));

    const attempt = createEquipmentType({ name: 'Cable', totalQuantity: 1 });

    await expect(attempt).rejects.toThrow('timeout');
    await expect(attempt).rejects.not.toBeInstanceOf(ValidationError);
  });
});


describe('AC3: editing a type', () => {
  it('SCRUM275_AC3_updates_only_the_fields_sent', async () => {
    const read = queryStub(ok(typeRow()));
    const write = queryStub(ok(typeRow({ location: 'Store room 2' })));
    from.mockReturnValueOnce(read).mockReturnValueOnce(write);

    const updated = await updateEquipmentType(TYPE_ID, { location: 'Store room 2' });

    expect(write.args('update')).toEqual([
      { location: 'Store room 2', last_modified_by: null, last_change_note: null },
    ]);
    expect(write.args('eq')).toEqual(['id', TYPE_ID]);
    expect(updated.location).toBe('Store room 2');
  });

  it('SCRUM275_AC3_sends_a_new_total_through_the_confirmed_save', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(saved(typeRow({ total_quantity: 12 })));

    const updated = await updateEquipmentType(TYPE_ID, { totalQuantity: 12 }, USER_ID);

    expect(appliedWith()).toEqual({
      p_equipment_type_id: TYPE_ID,
      p_caller: USER_ID,
      p_total: 12,
      p_damaged: null,
      p_under_maintenance: null,
      p_retire: false,
      p_fields: {},
      p_note: null,
      p_confirmed_reservation_ids: [],
    });
    expect(updated.totalQuantity).toBe(12);
    expect(from).toHaveBeenCalledTimes(1); // the read only: no table write
  });

  it('SCRUM275_AC3_does_not_count_the_type_itself_when_checking_the_name', async () => {
    const nameCheck = queryStub(ok([]));
    from
      .mockReturnValueOnce(queryStub(ok(typeRow())))
      .mockReturnValueOnce(nameCheck)
      .mockReturnValueOnce(queryStub(ok(typeRow({ name: 'PROJECTOR' }))));

    await updateEquipmentType(TYPE_ID, { name: 'PROJECTOR' });

    expect(nameCheck.args('neq')).toEqual(['id', TYPE_ID]);
  });

  it('SCRUM275_AC3_refuses_a_name_used_by_another_type', async () => {
    from
      .mockReturnValueOnce(queryStub(ok(typeRow())))
      .mockReturnValueOnce(queryStub(ok([{ id: OTHER_ID }])));

    const attempt = updateEquipmentType(TYPE_ID, { name: 'Speaker' });

    await expect(attempt).rejects.toMatchObject({
      details: [{ field: 'name', message: 'is already used by another equipment type' }],
    });
    expect(from).toHaveBeenCalledTimes(2);
  });

  it('SCRUM275_AC3_refuses_a_total_below_damaged_plus_under_maintenance', async () => {
    // damaged 2 + under maintenance 1 = 3
    from.mockReturnValueOnce(queryStub(ok(typeRow())));

    const attempt = updateEquipmentType(TYPE_ID, { totalQuantity: 2 });

    await expect(attempt).rejects.toMatchObject({
      status: 400,
      details: [{ field: 'totalQuantity', message: "can't be below damaged plus under maintenance (3)" }],
    });
    expect(from).toHaveBeenCalledTimes(1);
  });

  it('SCRUM275_AC3_allows_a_total_equal_to_damaged_plus_under_maintenance', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(saved(typeRow({ total_quantity: 3 })));

    const updated = await updateEquipmentType(TYPE_ID, { totalQuantity: 3 });

    expect(updated.usableQuantity).toBe(0);
  });

  it('SCRUM275_AC3_lists_every_problem_together', async () => {
    from
      .mockReturnValueOnce(queryStub(ok(typeRow())))
      .mockReturnValueOnce(queryStub(ok([{ id: OTHER_ID }])));

    const attempt = updateEquipmentType(TYPE_ID, { name: 'Speaker', totalQuantity: 1, location: 9 });

    await expect(attempt).rejects.toMatchObject({
      details: [
        { field: 'location', message: 'must be text' },
        { field: 'name' },
        { field: 'totalQuantity' },
      ],
    });
  });

  it('SCRUM275_AC3_answers_not_found_for_an_unknown_type', async () => {
    from.mockReturnValueOnce(queryStub(ok(null)));

    await expect(updateEquipmentType(TYPE_ID, { name: 'Mic' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('SCRUM275_AC3_answers_not_found_when_the_type_disappears_before_the_write', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow()))).mockReturnValueOnce(queryStub(ok(null)));

    await expect(updateEquipmentType(TYPE_ID, { location: 'X' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('SCRUM275_AC3_refuses_a_malformed_id_before_any_query', async () => {
    await expect(updateEquipmentType('nope', { name: 'Mic' })).rejects.toBeInstanceOf(ValidationError);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC3_refuses_a_change_naming_no_field_before_any_query', async () => {
    await expect(updateEquipmentType(TYPE_ID, {})).rejects.toBeInstanceOf(ValidationError);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC3_allows_editing_a_retired_type', async () => {
    const retired = typeRow({ retired_at: '2026-09-30T00:00:00+00:00' });
    from
      .mockReturnValueOnce(queryStub(ok(retired)))
      .mockReturnValueOnce(queryStub(ok({ ...retired, category: 'AV' })));

    const updated = await updateEquipmentType(TYPE_ID, { category: 'AV' });

    expect(updated.category).toBe('AV');
  });

  it('SCRUM300_AC3_a_deadlock_with_a_reservation_is_a_409_that_says_to_try_again', async () => {
    from
      .mockReturnValueOnce(queryStub(ok(typeRow())))
      .mockReturnValueOnce(queryStub(dbError('40P01', 'deadlock detected')));

    const attempt = updateEquipmentType(TYPE_ID, { location: 'X' });

    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    await expect(attempt).rejects.toMatchObject({
      status: 409,
      code: 'EQUIPMENT_CHANGED_AT_THE_SAME_TIME',
      message: 'Someone changed this equipment at the same moment. Please try again.',
    });
  });

  it('SCRUM275_AC3_translates_a_database_refusal_on_write', async () => {
    from
      .mockReturnValueOnce(queryStub(ok(typeRow())))
      .mockReturnValueOnce(queryStub(dbError('23505', 'duplicate')));

    await expect(updateEquipmentType(TYPE_ID, { location: 'X' })).rejects.toBeInstanceOf(ConflictError);
  });

  it('SCRUM275_AC3_surfaces_a_failed_read_of_the_current_row', async () => {
    from.mockReturnValueOnce(queryStub(dbError('57014', 'timeout')));

    await expect(updateEquipmentType(TYPE_ID, { location: 'X' })).rejects.toThrow('timeout');
  });

  it('SCRUM275_AC3_treats_a_name_lookup_that_returns_no_rows_at_all_as_not_taken', async () => {
    const write = queryStub(ok(typeRow({ name: 'Mic' })));
    from
      .mockReturnValueOnce(queryStub(ok(typeRow())))
      .mockReturnValueOnce(queryStub(ok(null)))
      .mockReturnValueOnce(write);

    const updated = await updateEquipmentType(TYPE_ID, { name: 'Mic' });

    expect(updated.name).toBe('Mic');
    expect(write.called('update')).toBe(true);
  });

  it('SCRUM275_AC3_surfaces_a_failed_name_lookup', async () => {
    from
      .mockReturnValueOnce(queryStub(ok(typeRow())))
      .mockReturnValueOnce(queryStub(dbError('57014', 'timeout')));

    await expect(updateEquipmentType(TYPE_ID, { name: 'Mic' })).rejects.toThrow('timeout');
  });
});


describe('AC5: the usable quantity', () => {
  it('SCRUM275_AC5_is_total_minus_damaged_minus_under_maintenance', async () => {
    from.mockReturnValueOnce(queryStub(ok([typeRow()])));

    const [type] = await listEquipmentTypes();

    // 10 total, 2 damaged, 1 under maintenance
    expect(type).toMatchObject({
      totalQuantity: 10,
      damagedQuantity: 2,
      underMaintenanceQuantity: 1,
      usableQuantity: 7,
    });
  });

  it('SCRUM275_AC5_lists_retired_types_too_with_retiredAt_set', async () => {
    from.mockReturnValueOnce(
      queryStub(ok([typeRow(), typeRow({ id: OTHER_ID, name: 'Old', retired_at: '2026-09-01T00:00:00+00:00' })])),
    );

    const types = await listEquipmentTypes();

    expect(types.map((type) => type.retiredAt)).toEqual([null, '2026-09-01T00:00:00+00:00']);
  });

  it('SCRUM275_AC5_answers_an_empty_list_when_there_are_none', async () => {
    from.mockReturnValueOnce(queryStub(ok(null)));

    await expect(listEquipmentTypes()).resolves.toEqual([]);
  });

  it('SCRUM275_AC5_surfaces_a_failed_list_read', async () => {
    from.mockReturnValueOnce(queryStub(dbError('57014', 'timeout')));

    await expect(listEquipmentTypes()).rejects.toThrow('timeout');
  });
});


describe('AC1 and AC6: the picker', () => {
  it('SCRUM275_AC6_asks_for_active_types_only', async () => {
    const read = queryStub(ok([typeRow()]));
    from.mockReturnValueOnce(read);

    await listActiveEquipmentTypes();

    expect(read.args('is')).toEqual(['retired_at', null]);
  });

  it('SCRUM275_AC1_returns_only_what_a_picker_needs', async () => {
    from.mockReturnValueOnce(queryStub(ok([typeRow()])));

    const [type] = await listActiveEquipmentTypes();

    expect(type).toEqual({
      id: TYPE_ID,
      name: 'Projector',
      description: 'HD, 4000 lumens',
      category: 'Display',
    });
  });

  it('SCRUM275_AC1_answers_an_empty_list_when_there_are_none', async () => {
    from.mockReturnValueOnce(queryStub(ok(null)));

    await expect(listActiveEquipmentTypes()).resolves.toEqual([]);
  });

  it('SCRUM275_AC1_surfaces_a_failed_read', async () => {
    from.mockReturnValueOnce(queryStub(dbError('57014', 'timeout')));

    await expect(listActiveEquipmentTypes()).rejects.toThrow('timeout');
  });
});


describe('AC8: recording who changed what', () => {
  it('SCRUM275_AC8_records_the_acting_user_on_create', async () => {
    const insert = queryStub(ok(typeRow()));
    from.mockReturnValueOnce(queryStub(ok([]))).mockReturnValueOnce(insert);

    await createEquipmentType({ name: 'Projector', totalQuantity: 10 }, USER_ID);

    expect(insert.args('insert')[0].last_modified_by).toBe(USER_ID);
  });

  it('SCRUM275_AC8_records_the_acting_user_on_edit_and_clears_any_stale_note', async () => {
    const write = queryStub(ok(typeRow()));
    from.mockReturnValueOnce(queryStub(ok(typeRow()))).mockReturnValueOnce(write);

    await updateEquipmentType(TYPE_ID, { location: 'Store room 2' }, USER_ID);

    expect(write.args('update')[0]).toMatchObject({ last_modified_by: USER_ID, last_change_note: null });
  });

  it('SCRUM275_AC8_refuses_an_acting_user_who_does_not_exist', async () => {
    from
      .mockReturnValueOnce(queryStub(ok([])))
      .mockReturnValueOnce(queryStub(dbError('23503', 'violates foreign key constraint "last_modified_by_fkey"')));

    const attempt = createEquipmentType({ name: 'Projector', totalQuantity: 10 }, OTHER_ID);

    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt).rejects.toThrow(/editing user does not exist/);
  });
});


describe('AC8: reading the history', () => {
  const historyRow = (overrides = {}) => ({
    id: 7,
    equipment_type_id: TYPE_ID,
    field_name: 'damaged_quantity',
    old_value: '0',
    new_value: '2',
    note: 'cracked lens',
    changed_by: USER_ID,
    changed_at: '2026-10-01T09:00:00+00:00',
    ...overrides,
  });

  it('SCRUM275_AC8_asks_for_this_types_rows_newest_first', async () => {
    const read = queryStub(ok([]));
    from.mockReturnValueOnce(read);

    await getEquipmentTypeHistory(TYPE_ID);

    expect(from).toHaveBeenCalledWith('equipment_type_history');
    expect(read.args('eq')).toEqual(['equipment_type_id', TYPE_ID]);
    expect(read.allArgs('order')).toEqual([
      ['changed_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
  });

  it('SCRUM275_AC8_returns_old_and_new_values_the_user_and_the_note', async () => {
    from.mockReturnValueOnce(queryStub(ok([historyRow()])));

    const [entry] = await getEquipmentTypeHistory(TYPE_ID);

    expect(entry).toEqual({
      id: 7,
      equipmentTypeId: TYPE_ID,
      field: 'damagedQuantity',
      oldValue: '0',
      newValue: '2',
      note: 'cracked lens',
      changedBy: USER_ID,
      changedAt: '2026-10-01T09:00:00+00:00',
    });
  });

  it('SCRUM275_AC8_names_fields_as_the_api_does_and_passes_others_through', async () => {
    from.mockReturnValueOnce(
      queryStub(ok([
        historyRow({ field_name: 'total_quantity' }),
        historyRow({ field_name: 'under_maintenance_quantity' }),
        historyRow({ field_name: 'retired_at' }),
        historyRow({ field_name: 'name' }),
        historyRow({ field_name: 'created' }),
      ])),
    );

    const entries = await getEquipmentTypeHistory(TYPE_ID);

    expect(entries.map((entry) => entry.field)).toEqual([
      'totalQuantity', 'underMaintenanceQuantity', 'retiredAt', 'name', 'created',
    ]);
  });

  it('SCRUM275_AC8_answers_an_empty_list_when_there_is_no_history', async () => {
    from.mockReturnValueOnce(queryStub(ok(null)));

    await expect(getEquipmentTypeHistory(TYPE_ID)).resolves.toEqual([]);
  });

  it('SCRUM275_AC8_refuses_a_malformed_id_before_any_query', async () => {
    await expect(getEquipmentTypeHistory('nope')).rejects.toBeInstanceOf(ValidationError);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC8_surfaces_a_failed_read', async () => {
    from.mockReturnValueOnce(queryStub(dbError('57014', 'timeout')));

    await expect(getEquipmentTypeHistory(TYPE_ID)).rejects.toThrow('timeout');
  });
});


describe('AC4: recording damaged and under-maintenance quantities', () => {
  // The default row is total 10, damaged 2, under maintenance 1, so usable 7.
  // The save itself is apply_equipment_change (SCRUM-313); scrum313ConfirmedSaveService
  // tests cover confirmation. These cover the checks made before it is called.

  it('SCRUM275_AC4_sends_only_the_quantity_given_with_the_trimmed_note_and_the_user', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(saved(typeRow({ damaged_quantity: 4 })));

    await recordEquipmentCondition(TYPE_ID, { damagedQuantity: 4, note: ' dropped ' }, USER_ID);

    expect(appliedWith()).toMatchObject({
      p_equipment_type_id: TYPE_ID,
      p_caller: USER_ID,
      p_damaged: 4,
      p_under_maintenance: null,
      p_total: null,
      p_retire: false,
      p_note: 'dropped',
    });
  });

  it('SCRUM275_AC4_sends_both_quantities_when_both_are_given', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(saved(typeRow()));

    await recordEquipmentCondition(TYPE_ID, { damagedQuantity: 3, underMaintenanceQuantity: 2, note: 'x' });

    expect(appliedWith()).toMatchObject({ p_damaged: 3, p_under_maintenance: 2 });
  });

  it('SCRUM275_AC4_sends_a_zero_as_zero_and_not_as_left_out', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(saved(typeRow({ damaged_quantity: 0 })));

    await recordEquipmentCondition(TYPE_ID, { damagedQuantity: 0, note: 'repaired' });

    expect(appliedWith()).toMatchObject({ p_damaged: 0, p_under_maintenance: null });
  });

  it('SCRUM275_AC5_returns_the_new_usable_figure', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(saved(typeRow({ damaged_quantity: 5 })));

    const updated = await recordEquipmentCondition(TYPE_ID, { damagedQuantity: 5, note: 'x' });

    // 10 total, 5 damaged, 1 under maintenance
    expect(updated).toMatchObject({ damagedQuantity: 5, underMaintenanceQuantity: 1, usableQuantity: 4 });
  });

  it('SCRUM275_AC4_lets_a_reduction_mark_units_usable_again', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(saved(typeRow({ damaged_quantity: 0 })));

    const updated = await recordEquipmentCondition(TYPE_ID, { damagedQuantity: 0, note: 'repaired' });

    expect(updated.usableQuantity).toBe(9);
  });

  it('SCRUM275_AC4_allows_damaged_plus_maintenance_equal_to_the_total', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(saved(typeRow({ damaged_quantity: 9 })));

    const updated = await recordEquipmentCondition(TYPE_ID, { damagedQuantity: 9, note: 'flood' });

    expect(updated.usableQuantity).toBe(0);
  });

  it('SCRUM275_AC4_refuses_damaged_plus_maintenance_above_the_total_and_saves_nothing', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));

    const attempt = recordEquipmentCondition(TYPE_ID, { damagedQuantity: 10, note: 'x' });

    // 10 damaged + 1 under maintenance = 11 against a total of 10
    await expect(attempt).rejects.toMatchObject({
      status: 400,
      details: [{ field: 'damagedQuantity', message: "damaged plus under maintenance (11) can't exceed the total (10)" }],
    });
    expect(from).toHaveBeenCalledTimes(1);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC4_refuses_values_the_type_already_has_and_saves_nothing', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));

    // the default row already has 2 damaged
    const attempt = recordEquipmentCondition(TYPE_ID, { damagedQuantity: 2, note: 'same again' });

    await expect(attempt).rejects.toMatchObject({
      status: 400,
      details: [{ field: 'equipment', message: 'nothing changed: damaged and under maintenance already have these values' }],
    });
    expect(from).toHaveBeenCalledTimes(1);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC4_refuses_both_quantities_when_neither_differs', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));

    const attempt = recordEquipmentCondition(TYPE_ID, { damagedQuantity: 2, underMaintenanceQuantity: 1, note: 'x' });

    await expect(attempt).rejects.toMatchObject({ details: [{ field: 'equipment' }] });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC4_accepts_a_change_to_just_one_of_two_quantities', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(saved(typeRow({ under_maintenance_quantity: 0 })));

    const updated = await recordEquipmentCondition(TYPE_ID, { damagedQuantity: 2, underMaintenanceQuantity: 0, note: 'back' });

    expect(updated.underMaintenanceQuantity).toBe(0);
  });

  it('SCRUM275_AC4_names_the_maintenance_field_when_only_maintenance_was_sent', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));

    const attempt = recordEquipmentCondition(TYPE_ID, { underMaintenanceQuantity: 9, note: 'x' });

    await expect(attempt).rejects.toMatchObject({ details: [{ field: 'underMaintenanceQuantity' }] });
  });

  it('SCRUM275_AC4_lists_a_missing_note_together_with_a_bad_quantity', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));

    const attempt = recordEquipmentCondition(TYPE_ID, { damagedQuantity: -1 });

    await expect(attempt).rejects.toMatchObject({
      details: [{ field: 'damagedQuantity' }, { field: 'note', message: 'is required' }],
    });
  });

  it('SCRUM275_AC4_refuses_a_change_naming_neither_quantity_before_any_query', async () => {
    await expect(recordEquipmentCondition(TYPE_ID, { note: 'x' })).rejects.toBeInstanceOf(ValidationError);
    await expect(recordEquipmentCondition(TYPE_ID, null)).rejects.toBeInstanceOf(ValidationError);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC4_refuses_a_malformed_id_before_any_query', async () => {
    await expect(recordEquipmentCondition('nope', { damagedQuantity: 1, note: 'x' })).rejects.toBeInstanceOf(ValidationError);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC4_answers_not_found_for_an_unknown_type', async () => {
    from.mockReturnValueOnce(queryStub(ok(null)));

    await expect(recordEquipmentCondition(TYPE_ID, { damagedQuantity: 1, note: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC4_answers_not_found_when_the_type_disappears_before_the_save', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(dbError('P0002', 'Equipment type not found'));

    await expect(recordEquipmentCondition(TYPE_ID, { damagedQuantity: 1, note: 'x' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('SCRUM275_AC4_translates_a_constraint_refusal_from_a_race_on_save', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(dbError('23514', 'unusable_within_total'));

    await expect(recordEquipmentCondition(TYPE_ID, { damagedQuantity: 4, note: 'x' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('SCRUM275_AC4_surfaces_a_failed_read_of_the_current_row', async () => {
    from.mockReturnValueOnce(queryStub(dbError('57014', 'timeout')));

    await expect(recordEquipmentCondition(TYPE_ID, { damagedQuantity: 1, note: 'x' })).rejects.toThrow('timeout');
  });
});


describe('AC6: retiring and reinstating a type', () => {
  const RETIRED = '2026-10-01T09:00:00+00:00';

  it('SCRUM275_AC6_retire_goes_through_the_confirmed_save_as_the_acting_user', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(saved(typeRow({ retired_at: RETIRED })));

    const retired = await retireEquipmentType(TYPE_ID, undefined, USER_ID);

    expect(appliedWith()).toEqual({
      p_equipment_type_id: TYPE_ID,
      p_caller: USER_ID,
      p_total: null,
      p_damaged: null,
      p_under_maintenance: null,
      p_retire: true,
      p_fields: {},
      p_note: null,
      p_confirmed_reservation_ids: [],
    });
    expect(from).toHaveBeenCalledTimes(1); // the read only: no table write
    expect(retired.retiredAt).toBe(RETIRED);
  });

  it('SCRUM275_AC6_a_retired_type_keeps_its_quantities', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(saved(typeRow({ retired_at: RETIRED })));

    const retired = await retireEquipmentType(TYPE_ID);

    expect(retired).toMatchObject({ totalQuantity: 10, damagedQuantity: 2, underMaintenanceQuantity: 1 });
  });

  it('SCRUM275_AC6_retiring_a_retired_type_answers_409_and_saves_nothing', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow({ retired_at: RETIRED }))));

    const attempt = retireEquipmentType(TYPE_ID);

    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    await expect(attempt).rejects.toMatchObject({ status: 409, code: 'EQUIPMENT_ALREADY_RETIRED' });
    expect(from).toHaveBeenCalledTimes(1);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC6_retire_answers_409_when_another_writer_retires_it_first', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(
      dbError('PT409', 'Equipment type is already retired', { hint: 'EQUIPMENT_ALREADY_RETIRED' }),
    );

    await expect(retireEquipmentType(TYPE_ID)).rejects.toMatchObject({ status: 409, code: 'EQUIPMENT_ALREADY_RETIRED' });
  });

  it('SCRUM275_AC6_retire_answers_not_found_for_an_unknown_type', async () => {
    from.mockReturnValueOnce(queryStub(ok(null)));

    await expect(retireEquipmentType(TYPE_ID)).rejects.toBeInstanceOf(NotFoundError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC6_retire_refuses_a_malformed_id_before_any_query', async () => {
    await expect(retireEquipmentType('nope')).rejects.toBeInstanceOf(ValidationError);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC6_reinstate_clears_retired_at_and_records_the_user', async () => {
    const write = queryStub(ok(typeRow()));
    from.mockReturnValueOnce(queryStub(ok(typeRow({ retired_at: RETIRED })))).mockReturnValueOnce(write);

    const reinstated = await reinstateEquipmentType(TYPE_ID, USER_ID);

    expect(write.args('update')).toEqual([{ retired_at: null, last_modified_by: USER_ID, last_change_note: null }]);
    expect(reinstated.retiredAt).toBeNull();
  });

  it('SCRUM275_AC7_reinstate_does_not_use_the_confirmed_save', async () => {
    from
      .mockReturnValueOnce(queryStub(ok(typeRow({ retired_at: RETIRED }))))
      .mockReturnValueOnce(queryStub(ok(typeRow())));

    await reinstateEquipmentType(TYPE_ID);

    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC6_reinstating_a_type_that_is_not_retired_answers_409', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));

    const attempt = reinstateEquipmentType(TYPE_ID);

    await expect(attempt).rejects.toMatchObject({ status: 409, code: 'EQUIPMENT_NOT_RETIRED' });
    expect(from).toHaveBeenCalledTimes(1);
  });

  it('SCRUM275_AC6_reinstate_translates_a_database_refusal_on_write', async () => {
    from
      .mockReturnValueOnce(queryStub(ok(typeRow({ retired_at: RETIRED }))))
      .mockReturnValueOnce(queryStub(dbError('40P01', 'deadlock detected')));

    await expect(reinstateEquipmentType(TYPE_ID)).rejects.toMatchObject({
      status: 409,
      code: 'EQUIPMENT_CHANGED_AT_THE_SAME_TIME',
    });
  });

  it('SCRUM275_AC6_reinstate_surfaces_an_untyped_failure_on_write', async () => {
    from
      .mockReturnValueOnce(queryStub(ok(typeRow({ retired_at: RETIRED }))))
      .mockReturnValueOnce(queryStub(dbError('57014', 'timeout')));

    await expect(reinstateEquipmentType(TYPE_ID)).rejects.toThrow('timeout');
  });

  it('SCRUM275_AC6_reinstate_answers_not_found_for_an_unknown_type', async () => {
    from.mockReturnValueOnce(queryStub(ok(null)));

    await expect(reinstateEquipmentType(TYPE_ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('SCRUM275_AC6_reinstate_answers_not_found_when_the_type_disappears_before_the_write', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow({ retired_at: RETIRED })))).mockReturnValueOnce(queryStub(ok(null)));

    await expect(reinstateEquipmentType(TYPE_ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('SCRUM275_AC6_reinstate_refuses_a_malformed_id_before_any_query', async () => {
    await expect(reinstateEquipmentType('nope')).rejects.toBeInstanceOf(ValidationError);
    expect(from).not.toHaveBeenCalled();
  });
});