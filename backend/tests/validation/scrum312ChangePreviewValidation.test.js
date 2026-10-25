/**
 * Tests for the change-preview input check.
 *
 * SCRUM-312, a subtask of SCRUM-310 "Handle Equipment Lost After Reservation".
 * Named SCRUM310_ACn_<what_it_checks>.
 *
 * The body is one change Technical Support Staff want to look at: a total, a
 * damaged and/or under-maintenance quantity, or a retirement. Every invalid
 * field is listed together, nothing outside the known fields is read, and the
 * returned value holds only what was sent and valid.
 */

import { describe, it, expect } from 'vitest';

import { checkChangePreview, MAX_QUANTITY } from '../../src/validation/equipmentValidation.js';

const fields = (details) => details.map((detail) => detail.field);

describe('SCRUM310 accepted changes', () => {
  it.each([
    ['a total', { totalQuantity: 5 }, { totalQuantity: 5 }],
    ['damaged', { damagedQuantity: 3 }, { damagedQuantity: 3 }],
    ['under maintenance', { underMaintenanceQuantity: 2 }, { underMaintenanceQuantity: 2 }],
    [
      'damaged and under maintenance',
      { damagedQuantity: 1, underMaintenanceQuantity: 2 },
      { damagedQuantity: 1, underMaintenanceQuantity: 2 },
    ],
    [
      'a total with both conditions',
      { totalQuantity: 9, damagedQuantity: 1, underMaintenanceQuantity: 2 },
      { totalQuantity: 9, damagedQuantity: 1, underMaintenanceQuantity: 2 },
    ],
    ['a retirement', { retire: true }, { retire: true }],
  ])('SCRUM310_AC1_accepts_%s', (_label, input, expected) => {
    const { value, details } = checkChangePreview(input);
    expect(details).toEqual([]);
    expect(value).toEqual(expected);
  });

  it.each([
    ['zero total', { totalQuantity: 0 }],
    ['zero damaged', { damagedQuantity: 0 }],
    ['zero under maintenance', { underMaintenanceQuantity: 0 }],
    ['the largest total', { totalQuantity: MAX_QUANTITY }],
    ['the largest damaged', { damagedQuantity: MAX_QUANTITY }],
  ])('SCRUM310_AC1_accepts_the_boundary_%s', (_label, input) => {
    expect(checkChangePreview(input).details).toEqual([]);
  });

  it('SCRUM310_AC1_ignores_fields_it_does_not_know_and_does_not_return_them', () => {
    const { value, details } = checkChangePreview({
      totalQuantity: 4,
      name: 'Hijack',
      note: 'not needed',
      callerId: 'someone-else',
      usableAfter: 99,
    });
    expect(details).toEqual([]);
    expect(value).toEqual({ totalQuantity: 4 });
  });

  it('SCRUM310_AC1_does_not_need_a_note', () => {
    expect(checkChangePreview({ damagedQuantity: 1 }).details).toEqual([]);
  });
});

describe('SCRUM310 refused bodies', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'retire'],
    ['a number', 5],
    ['an array', [{ totalQuantity: 1 }]],
    ['true', true],
  ])('SCRUM310_AC1_refuses_%s_as_a_body', (_label, input) => {
    const { value, details } = checkChangePreview(input);
    expect(value).toBeNull();
    expect(details).toEqual([{ field: 'equipment', message: 'must be an object' }]);
  });

  it('SCRUM310_AC1_refuses_an_empty_object', () => {
    const { details } = checkChangePreview({});
    expect(fields(details)).toEqual(['equipment']);
    expect(details[0].message).toMatch(/provide/);
  });

  it('SCRUM310_AC1_refuses_a_body_with_only_unknown_fields', () => {
    expect(fields(checkChangePreview({ name: 'x', note: 'y' }).details)).toEqual(['equipment']);
  });

  it.each(['totalQuantity', 'damagedQuantity', 'underMaintenanceQuantity'])(
    'SCRUM310_AC1_refuses_a_bad_%s',
    (field) => {
      const bad = [-1, 1.5, '5', null, NaN, Infinity, MAX_QUANTITY + 1, true, [], {}];
      for (const badValue of bad) {
        const { value, details } = checkChangePreview({ [field]: badValue });
        expect(fields(details), `${field}=${String(badValue)}`).toContain(field);
        expect(value[field], `${field}=${String(badValue)}`).toBeUndefined();
      }
    },
  );

  it('SCRUM310_AC1_lists_every_invalid_field_together', () => {
    const { details } = checkChangePreview({
      totalQuantity: -1,
      damagedQuantity: 'a',
      underMaintenanceQuantity: 1.5,
    });
    expect(fields(details).sort()).toEqual(['damagedQuantity', 'totalQuantity', 'underMaintenanceQuantity']);
  });

  it('SCRUM310_AC1_keeps_a_valid_field_even_when_another_is_invalid', () => {
    const { value, details } = checkChangePreview({ totalQuantity: 5, damagedQuantity: -2 });
    expect(fields(details)).toEqual(['damagedQuantity']);
    expect(value).toEqual({ totalQuantity: 5 });
  });
});

describe('SCRUM310 retire', () => {
  it.each([false, 'true', 1, 0, null, 'yes', {}, []])(
    'SCRUM310_AC1_refuses_retire_set_to_%j',
    (retire) => {
      const { value, details } = checkChangePreview({ retire });
      expect(fields(details)).toContain('retire');
      expect(value.retire).toBeUndefined();
    },
  );

  it('SCRUM310_AC1_refuses_retire_false_instead_of_reading_it_as_nothing', () => {
    const { details } = checkChangePreview({ retire: false, totalQuantity: 3 });
    expect(fields(details)).toEqual(['retire']);
  });

  it.each(['totalQuantity', 'damagedQuantity', 'underMaintenanceQuantity'])(
    'SCRUM310_AC1_refuses_retire_together_with_%s',
    (field) => {
      const { details } = checkChangePreview({ retire: true, [field]: 1 });
      expect(fields(details)).toEqual(['retire']);
      expect(details[0].message).toMatch(/combined/);
    },
  );

  it('SCRUM310_AC1_a_retire_with_a_bad_quantity_lists_both_problems', () => {
    const { details } = checkChangePreview({ retire: true, totalQuantity: -1 });
    expect(fields(details).sort()).toEqual(['retire', 'totalQuantity']);
  });
});
