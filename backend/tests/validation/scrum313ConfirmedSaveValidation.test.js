/**
 * Tests for the extra input the confirmed save reads.
 *
 * A change that lowers a type's usable quantity is saved only with the list of
 * reservations the staff member was shown (confirmedReservationIds). Leaving it
 * out means "this change affects nothing", so anything that is present but is
 * not a list of reservation ids is refused rather than read as empty.
 *
 *   - update (a new total), condition (damage, maintenance) and retire all read it
 *   - the optional note on an update and on a retirement
 *   - the retire body, which used to be empty
 */

import { describe, it, expect } from 'vitest';

import {
  checkUpdateEquipmentType,
  checkConditionChange,
  checkRetire,
} from '../../src/validation/equipmentValidation.js';

const ID_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const ID_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ID_UPPER = ID_A.toUpperCase();

const fields = (details) => details.map((detail) => detail.field);

/** The three checks, each given a body that is otherwise valid. */
const CHECKS = [
  ['update', (extra) => checkUpdateEquipmentType({ totalQuantity: 5, ...extra })],
  ['condition', (extra) => checkConditionChange({ damagedQuantity: 3, note: 'dropped', ...extra })],
  ['retire', (extra) => checkRetire({ ...extra })],
];

describe.each(CHECKS)('SCRUM310 the confirmed list on %s', (_name, check) => {
  it('SCRUM310_AC2_leaves_the_list_out_of_the_result_when_it_is_not_sent', () => {
    const { value, details } = check({});
    expect(details).toEqual([]);
    expect(value).not.toHaveProperty('confirmedReservationIds');
  });

  it('SCRUM310_AC2_accepts_a_list_of_reservation_ids_and_returns_it', () => {
    const { value, details } = check({ confirmedReservationIds: [ID_A, ID_B] });
    expect(details).toEqual([]);
    expect(value.confirmedReservationIds).toEqual([ID_A, ID_B]);
  });

  it('SCRUM310_AC2_accepts_an_empty_list_as_the_claim_that_nothing_is_affected', () => {
    const { value, details } = check({ confirmedReservationIds: [] });
    expect(details).toEqual([]);
    expect(value.confirmedReservationIds).toEqual([]);
  });

  it('SCRUM310_AC2_accepts_a_single_id', () => {
    expect(check({ confirmedReservationIds: [ID_A] }).value.confirmedReservationIds).toEqual([ID_A]);
  });

  it('SCRUM310_AC2_accepts_upper_case_ids', () => {
    const { value, details } = check({ confirmedReservationIds: [ID_UPPER] });
    expect(details).toEqual([]);
    expect(value.confirmedReservationIds).toHaveLength(1);
  });

  it('SCRUM310_AC2_drops_repeats_so_a_list_that_names_one_reservation_twice_is_the_same_list', () => {
    const { value } = check({ confirmedReservationIds: [ID_A, ID_B, ID_A, ID_A] });
    expect(value.confirmedReservationIds).toEqual([ID_A, ID_B]);
  });

  it('SCRUM310_AC2_does_not_change_the_order_it_was_given', () => {
    expect(check({ confirmedReservationIds: [ID_B, ID_A] }).value.confirmedReservationIds).toEqual([ID_B, ID_A]);
  });

  it('SCRUM310_AC2_accepts_as_many_as_one_thousand', () => {
    const ids = Array.from({ length: 1000 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const { value, details } = check({ confirmedReservationIds: ids });
    expect(details).toEqual([]);
    expect(value.confirmedReservationIds).toHaveLength(1000);
  });

  it('SCRUM310_AC2_refuses_more_than_one_thousand', () => {
    const ids = Array.from({ length: 1001 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const { value, details } = check({ confirmedReservationIds: ids });
    expect(details).toEqual([
      { field: 'confirmedReservationIds', message: 'must not list more than 1000 reservations' },
    ]);
    expect(value).not.toHaveProperty('confirmedReservationIds');
  });

  it.each([
    ['null', null],
    ['a string', ID_A],
    ['a number', 3],
    ['true', true],
    ['an object', { 0: ID_A }],
    ['an object with a length', { length: 0 }],
  ])('SCRUM310_AC2_refuses_%s_in_place_of_a_list', (_label, bad) => {
    const { value, details } = check({ confirmedReservationIds: bad });
    expect(details).toEqual([
      { field: 'confirmedReservationIds', message: 'must be a list of reservation ids' },
    ]);
    expect(value).not.toHaveProperty('confirmedReservationIds');
  });

  it.each([
    ['text that is not an id', ['not-an-id']],
    ['a number', [1]],
    ['null', [null]],
    ['undefined', [undefined]],
    ['an object', [{ id: ID_A }]],
    ['a nested list', [[ID_A]]],
    ['an empty string', ['']],
    ['an id with a space', [` ${ID_A}`]],
    ['an id with a suffix', [`${ID_A}x`]],
    ['one bad id among good ones', [ID_A, 'oops', ID_B]],
  ])('SCRUM310_AC2_refuses_a_list_holding_%s', (_label, bad) => {
    const { value, details } = check({ confirmedReservationIds: bad });
    expect(details).toEqual([
      { field: 'confirmedReservationIds', message: 'must be a list of reservation ids' },
    ]);
    expect(value).not.toHaveProperty('confirmedReservationIds');
  });

  it('SCRUM310_AC2_reports_a_bad_list_once_whatever_else_is_wrong', () => {
    const { details } = check({ confirmedReservationIds: 'nope' });
    expect(fields(details).filter((field) => field === 'confirmedReservationIds')).toHaveLength(1);
  });
});

describe('SCRUM310 the list listed together with other problems', () => {
  it('SCRUM310_AC2_update_lists_a_bad_list_with_a_bad_total', () => {
    const { details } = checkUpdateEquipmentType({ totalQuantity: -1, confirmedReservationIds: 'x' });
    expect(fields(details)).toEqual(expect.arrayContaining(['totalQuantity', 'confirmedReservationIds']));
  });

  it('SCRUM310_AC2_condition_lists_a_bad_list_with_a_missing_note_and_a_bad_quantity', () => {
    const { details } = checkConditionChange({ damagedQuantity: -1, confirmedReservationIds: 'x' });
    expect(fields(details)).toEqual(
      expect.arrayContaining(['damagedQuantity', 'note', 'confirmedReservationIds']),
    );
  });
});

describe('SCRUM310 the optional note on an update', () => {
  const update = (extra) => checkUpdateEquipmentType({ totalQuantity: 5, ...extra });

  it('SCRUM310_AC8_leaves_the_note_out_when_none_is_sent', () => {
    expect(update({}).value).not.toHaveProperty('note');
  });

  it('SCRUM310_AC8_trims_the_note', () => {
    expect(update({ note: '  one fewer  ' }).value.note).toBe('one fewer');
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['only a line break', '\n'],
    ['null', null],
  ])('SCRUM310_AC8_reads_a_%s_note_as_none', (_label, note) => {
    const { value, details } = update({ note });
    expect(details).toEqual([]);
    expect(value).not.toHaveProperty('note');
  });

  it.each([
    ['a number', 5],
    ['true', true],
    ['an object', { text: 'x' }],
    ['a list', ['x']],
  ])('SCRUM310_AC8_refuses_%s_as_a_note', (_label, note) => {
    const { details } = update({ note });
    expect(details).toEqual([{ field: 'note', message: 'must be text' }]);
  });

  it('SCRUM310_AC8_does_not_count_a_note_alone_as_a_change', () => {
    const { details } = checkUpdateEquipmentType({ note: 'x', confirmedReservationIds: [] });
    expect(details).toEqual([
      {
        field: 'equipment',
        message: 'provide at least one of name, description, category, location or totalQuantity',
      },
    ]);
  });
});

describe('SCRUM310 the body of a retirement', () => {
  it.each([
    ['no body', undefined],
    ['a null body', null],
    ['an empty body', {}],
  ])('SCRUM310_AC4_accepts_%s_and_confirms_nothing', (_label, input) => {
    const { value, details } = checkRetire(input);
    expect(details).toEqual([]);
    expect(value).toEqual({});
  });

  it('SCRUM310_AC2_reads_the_confirmed_list_and_the_trimmed_note', () => {
    const { value, details } = checkRetire({ confirmedReservationIds: [ID_A], note: ' end of life ' });
    expect(details).toEqual([]);
    expect(value).toEqual({ confirmedReservationIds: [ID_A], note: 'end of life' });
  });

  it('SCRUM310_AC4_ignores_fields_it_does_not_know_and_does_not_return_them', () => {
    const { value, details } = checkRetire({
      confirmedReservationIds: [],
      totalQuantity: 99,
      retiredAt: '2020-01-01',
      lastModifiedBy: 'someone-else',
      p_caller: 'someone-else',
    });
    expect(details).toEqual([]);
    expect(value).toEqual({ confirmedReservationIds: [] });
  });

  it.each([
    ['text', 'retire'],
    ['a number', 5],
    ['true', true],
    ['a list', [ID_A]],
  ])('SCRUM310_AC4_refuses_%s_as_a_body', (_label, input) => {
    const { value, details } = checkRetire(input);
    expect(value).toBeNull();
    expect(details).toEqual([{ field: 'equipment', message: 'must be an object' }]);
  });

  it('SCRUM310_AC2_lists_a_bad_note_and_a_bad_list_together', () => {
    const { details } = checkRetire({ confirmedReservationIds: 'x', note: 4 });
    expect(fields(details).sort()).toEqual(['confirmedReservationIds', 'note']);
  });

  it('SCRUM310_AC4_does_not_change_the_input_it_was_given', () => {
    const input = { confirmedReservationIds: [ID_A, ID_A], note: ' x ' };
    const copy = structuredClone(input);
    checkRetire(input);
    expect(input).toEqual(copy);
  });
});

describe('SCRUM310 the condition check keeps what it had', () => {
  it('SCRUM310_AC8_still_requires_a_note_on_a_damage_change', () => {
    const { details } = checkConditionChange({ damagedQuantity: 1, confirmedReservationIds: [] });
    expect(details).toEqual([{ field: 'note', message: 'is required' }]);
  });

  it('SCRUM310_AC2_does_not_count_the_list_alone_as_a_change', () => {
    const { details } = checkConditionChange({ note: 'x', confirmedReservationIds: [ID_A] });
    expect(details).toEqual([
      { field: 'equipment', message: 'provide damagedQuantity, underMaintenanceQuantity or both' },
    ]);
  });
});
