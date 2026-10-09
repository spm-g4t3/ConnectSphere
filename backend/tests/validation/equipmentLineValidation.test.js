/**
 * Tests for equipment line validation.
 *
 * SCRUM-244, a subtask of SCRUM-21. Named SCRUM21_ACn_<what_it_checks>.
 *
 *   AC2 -- a line has a type, a quantity and optional technical notes
 *   AC3 -- the quantity is a whole number greater than zero
 *   AC6 -- an amendment changes only quantity and notes, never the type
 *
 * Pure functions, so nothing is mocked.
 */

import { describe, it, expect } from 'vitest';

import {
  checkAddEquipmentLine,
  checkAmendEquipmentLine,
  validateEventRequestId,
  validateEquipmentLineId,
  MAX_NOTES_LENGTH,
} from '../../src/validation/equipmentLineValidation.js';
import { MAX_QUANTITY } from '../../src/validation/equipmentValidation.js';
import { ValidationError } from '../../src/errors.js';

const TYPE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const fields = (details) => details.map((detail) => detail.field);


describe('AC2: checking a new line', () => {
  it('SCRUM21_AC2_accepts_a_type_a_quantity_and_notes', () => {
    const { value, details } = checkAddEquipmentLine({
      equipmentTypeId: TYPE_ID,
      quantity: 2,
      technicalNotes: 'needs HDMI',
    });

    expect(details).toEqual([]);
    expect(value).toEqual({ equipmentTypeId: TYPE_ID, quantity: 2, technicalNotes: 'needs HDMI' });
  });

  it.each([[undefined], [null], ['   '], ['']])(
    'SCRUM21_AC2_treats_notes_of_%j_as_no_notes',
    (notes) => {
      const { value, details } = checkAddEquipmentLine({
        equipmentTypeId: TYPE_ID,
        quantity: 1,
        technicalNotes: notes,
      });

      expect(details).toEqual([]);
      expect(value.technicalNotes).toBeNull();
    },
  );

  it('SCRUM21_AC2_trims_the_notes', () => {
    const { value } = checkAddEquipmentLine({
      equipmentTypeId: TYPE_ID,
      quantity: 1,
      technicalNotes: '  needs HDMI  ',
    });
    expect(value.technicalNotes).toBe('needs HDMI');
  });

  it.each([[undefined], [null]])('SCRUM21_AC2_requires_a_type_id_when_it_is_%j', (id) => {
    const { details } = checkAddEquipmentLine({ equipmentTypeId: id, quantity: 1 });
    expect(details).toEqual([{ field: 'equipmentTypeId', message: 'is required' }]);
  });

  it.each([['projector'], [42], ['3f2504e0']])('SCRUM21_AC2_refuses_a_type_id_of_%j', (id) => {
    const { details } = checkAddEquipmentLine({ equipmentTypeId: id, quantity: 1 });
    expect(details).toEqual([{ field: 'equipmentTypeId', message: 'must be a UUID' }]);
  });

  it.each([[null], ['text'], [[]], [7]])('SCRUM21_AC2_refuses_a_body_of_%j', (body) => {
    const { value, details } = checkAddEquipmentLine(body);

    expect(value).toBeNull();
    expect(fields(details)).toEqual(['equipmentLine']);
  });

  it('SCRUM21_AC2_refuses_notes_that_are_not_text', () => {
    const { details } = checkAddEquipmentLine({ equipmentTypeId: TYPE_ID, quantity: 1, technicalNotes: 5 });
    expect(details).toEqual([{ field: 'technicalNotes', message: 'must be text' }]);
  });

  it('SCRUM21_AC2_accepts_notes_of_exactly_the_limit_and_refuses_one_more', () => {
    const atLimit = 'x'.repeat(MAX_NOTES_LENGTH);

    expect(checkAddEquipmentLine({ equipmentTypeId: TYPE_ID, quantity: 1, technicalNotes: atLimit }).details).toEqual([]);
    expect(
      fields(checkAddEquipmentLine({ equipmentTypeId: TYPE_ID, quantity: 1, technicalNotes: `${atLimit}x` }).details),
    ).toEqual(['technicalNotes']);
  });
});


describe('AC3: the quantity', () => {
  it.each([[1], [2], [MAX_QUANTITY]])('SCRUM21_AC3_accepts_%j', (quantity) => {
    const { details } = checkAddEquipmentLine({ equipmentTypeId: TYPE_ID, quantity });
    expect(details).toEqual([]);
  });

  it.each([
    [0],
    [-1],
    [1.5],
    ['5'],
    [null],
    [undefined],
    [NaN],
    [MAX_QUANTITY + 1],
  ])('SCRUM21_AC3_refuses_a_quantity_of_%j', (quantity) => {
    const { details } = checkAddEquipmentLine({ equipmentTypeId: TYPE_ID, quantity });
    expect(fields(details)).toEqual(['quantity']);
  });

  it('SCRUM21_AC3_reports_every_invalid_field_together', () => {
    const { details } = checkAddEquipmentLine({ quantity: 0, technicalNotes: 5 });
    expect(fields(details).sort()).toEqual(['equipmentTypeId', 'quantity', 'technicalNotes']);
  });
});


describe('AC6: checking an amendment', () => {
  it('SCRUM21_AC6_accepts_a_quantity_alone', () => {
    const { value, details } = checkAmendEquipmentLine({ quantity: 5 });

    expect(details).toEqual([]);
    expect(value).toEqual({ quantity: 5, technicalNotes: null, changeNotes: false });
  });

  it('SCRUM21_AC6_accepts_notes_alone', () => {
    const { value, details } = checkAmendEquipmentLine({ technicalNotes: ' new ' });

    expect(details).toEqual([]);
    expect(value).toEqual({ quantity: null, technicalNotes: 'new', changeNotes: true });
  });

  it.each([[null], ['   ']])('SCRUM21_AC6_notes_of_%j_clear_the_notes_and_say_so', (notes) => {
    const { value, details } = checkAmendEquipmentLine({ technicalNotes: notes });

    expect(details).toEqual([]);
    expect(value).toEqual({ quantity: null, technicalNotes: null, changeNotes: true });
  });

  it('SCRUM21_AC6_accepts_both_together', () => {
    const { value } = checkAmendEquipmentLine({ quantity: 3, technicalNotes: 'x' });
    expect(value).toEqual({ quantity: 3, technicalNotes: 'x', changeNotes: true });
  });

  it('SCRUM21_AC6_refuses_an_amendment_that_changes_nothing', () => {
    const { details } = checkAmendEquipmentLine({});
    expect(details).toEqual([{ field: 'changes', message: 'give a quantity, technical notes, or both' }]);
  });

  it('SCRUM21_AC6_refuses_a_change_of_type_and_says_to_remove_and_add', () => {
    const { details } = checkAmendEquipmentLine({ equipmentTypeId: TYPE_ID, quantity: 2 });

    expect(details).toHaveLength(1);
    expect(details[0].field).toBe('equipmentTypeId');
    expect(details[0].message).toMatch(/remove the line and add a new one/);
  });

  it.each([[0], [-2], [1.5], ['5'], [null]])('SCRUM21_AC6_refuses_an_amended_quantity_of_%j', (quantity) => {
    const { details } = checkAmendEquipmentLine({ quantity });
    expect(fields(details)).toEqual(['quantity']);
  });

  it('SCRUM21_AC6_ignores_every_other_key', () => {
    const { value } = checkAmendEquipmentLine({ quantity: 4, status: 'arranged', flagged: true, id: 'x' });
    expect(value).toEqual({ quantity: 4, technicalNotes: null, changeNotes: false });
  });

  it.each([[null], [[]], ['x']])('SCRUM21_AC6_refuses_a_body_of_%j', (body) => {
    const { value, details } = checkAmendEquipmentLine(body);

    expect(value).toBeNull();
    expect(fields(details)).toEqual(['changes']);
  });
});


describe('the ids in the URL', () => {
  it('SCRUM21_accepts_a_uuid_for_the_event_and_the_line', () => {
    expect(validateEventRequestId(TYPE_ID)).toBe(TYPE_ID);
    expect(validateEquipmentLineId(TYPE_ID)).toBe(TYPE_ID);
  });

  it.each([['abc'], [undefined], [null], [42]])('SCRUM21_refuses_an_event_id_of_%j_with_a_400_error', (id) => {
    try {
      validateEventRequestId(id);
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.details).toEqual([{ field: 'id', message: 'must be a UUID' }]);
    }
  });

  it.each([['abc'], [undefined]])('SCRUM21_refuses_a_line_id_of_%j_with_a_400_error', (id) => {
    try {
      validateEquipmentLineId(id);
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.details).toEqual([{ field: 'lineId', message: 'must be a UUID' }]);
    }
  });
});
