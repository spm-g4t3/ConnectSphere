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

const { from } = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock('../../src/config/supabaseClient.js', () => {
  const client = { from };
  return { supabase: client, default: client };
});

const {
  createEquipmentType,
  updateEquipmentType,
  listEquipmentTypes,
  listActiveEquipmentTypes,
  getEquipmentTypeHistory,
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
 * A stand-in for a supabase-js query builder: every method records its
 * arguments and returns the same object, and the builder is thenable because
 * supabase-js resolves the chain itself. `result` must stay a plain object.
 */
function queryStub(result) {
  const calls = [];
  const stub = {
    called: (method) => calls.some(([name]) => name === method),
    args: (method) => calls.find(([name]) => name === method)?.slice(1),
    /** Every call to it, in order, for a method used more than once. */
    all: (method) => calls.filter(([name]) => name === method).map(([, ...args]) => args),
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  for (const method of ['select', 'eq', 'neq', 'is', 'ilike', 'order', 'limit', 'insert', 'update']) {
    stub[method] = (...args) => { calls.push([method, ...args]); return stub; };
  }
  for (const method of ['single', 'maybeSingle']) {
    stub[method] = (...args) => { calls.push([method, ...args]); return Promise.resolve(result); };
  }
  return stub;
}

const ok = (data) => ({ data, error: null });
const failed = (code, message) => ({ data: null, error: { code, message } });

beforeEach(() => {
  from.mockReset();
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
      .mockReturnValueOnce(queryStub(failed('23505', 'duplicate key value violates unique constraint')));

    const attempt = createEquipmentType({ name: 'Projector', totalQuantity: 1 });

    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    await expect(attempt).rejects.toMatchObject({ status: 409, code: 'EQUIPMENT_NAME_TAKEN' });
  });

  it('SCRUM275_AC2_translates_a_check_constraint_into_a_ValidationError', async () => {
    from
      .mockReturnValueOnce(queryStub(ok([])))
      .mockReturnValueOnce(queryStub(failed('23514', 'violates check constraint')));

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

  it('SCRUM275_AC3_maps_the_total_to_its_column', async () => {
    const write = queryStub(ok(typeRow({ total_quantity: 12 })));
    from.mockReturnValueOnce(queryStub(ok(typeRow()))).mockReturnValueOnce(write);

    await updateEquipmentType(TYPE_ID, { totalQuantity: 12 });

    expect(write.args('update')).toEqual([
      { total_quantity: 12, last_modified_by: null, last_change_note: null },
    ]);
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
    from
      .mockReturnValueOnce(queryStub(ok(typeRow())))
      .mockReturnValueOnce(queryStub(ok(typeRow({ total_quantity: 3 }))));

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

  it('SCRUM275_AC3_translates_a_database_refusal_on_write', async () => {
    from
      .mockReturnValueOnce(queryStub(ok(typeRow())))
      .mockReturnValueOnce(queryStub(failed('23505', 'duplicate')));

    await expect(updateEquipmentType(TYPE_ID, { location: 'X' })).rejects.toBeInstanceOf(ConflictError);
  });

  it('SCRUM275_AC3_surfaces_a_failed_read_of_the_current_row', async () => {
    from.mockReturnValueOnce(queryStub(failed('57014', 'timeout')));

    await expect(updateEquipmentType(TYPE_ID, { location: 'X' })).rejects.toThrow('timeout');
  });

  it('SCRUM275_AC3_surfaces_a_failed_name_lookup', async () => {
    from
      .mockReturnValueOnce(queryStub(ok(typeRow())))
      .mockReturnValueOnce(queryStub(failed('57014', 'timeout')));

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
    from.mockReturnValueOnce(queryStub(failed('57014', 'timeout')));

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
    from.mockReturnValueOnce(queryStub(failed('57014', 'timeout')));

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
      .mockReturnValueOnce(queryStub(failed('23503', 'violates foreign key constraint "last_modified_by_fkey"')));

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
    expect(read.all('order')).toEqual([
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
    from.mockReturnValueOnce(queryStub(failed('57014', 'timeout')));

    await expect(getEquipmentTypeHistory(TYPE_ID)).rejects.toThrow('timeout');
  });
});