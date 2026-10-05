/**
 * Tests for equipment type validation.
 *
 * SCRUM-276, a subtask of SCRUM-275 "Maintain Equipment Catalogue and
 * Status". Test names carry the acceptance criterion they cover, as
 * SCRUM275_ACn_<what_it_checks>.
 *
 *   AC2 -- a type is created with a name, description, category, location and
 *          total quantity; name and total are required; the total is a whole
 *          number of zero or more; every invalid field is listed together
 *   AC3 -- any of those fields can be edited, under the same rules
 */

import { describe, it, expect } from 'vitest';

import {
  checkCreateEquipmentType,
  checkUpdateEquipmentType,
  hasField,
  throwIfInvalid,
  validateEquipmentTypeId,
  MAX_QUANTITY,
} from '../../src/validation/equipmentValidation.js';
import { ValidationError } from '../../src/errors.js';

const fields = (details) => details.map((detail) => detail.field);


describe('AC2: creating a type', () => {
  it('SCRUM275_AC2_accepts_all_five_fields', () => {
    const { value, details } = checkCreateEquipmentType({
      name: 'Projector',
      description: 'HD, 4000 lumens',
      category: 'Display',
      location: 'Store room 1',
      totalQuantity: 10,
    });

    expect(details).toEqual([]);
    expect(value).toEqual({
      name: 'Projector',
      description: 'HD, 4000 lumens',
      category: 'Display',
      location: 'Store room 1',
      totalQuantity: 10,
    });
  });

  it('SCRUM275_AC2_needs_only_a_name_and_a_total', () => {
    const { value, details } = checkCreateEquipmentType({ name: 'Cable', totalQuantity: 0 });

    expect(details).toEqual([]);
    expect(value).toEqual({
      name: 'Cable',
      description: null,
      category: null,
      location: null,
      totalQuantity: 0,
    });
  });

  it('SCRUM275_AC2_trims_text_and_turns_blank_optional_text_into_null', () => {
    const { value } = checkCreateEquipmentType({
      name: '  Projector  ',
      description: '   ',
      category: '',
      location: null,
      totalQuantity: 3,
    });

    expect(value.name).toBe('Projector');
    expect(value.description).toBeNull();
    expect(value.category).toBeNull();
    expect(value.location).toBeNull();
  });

  it.each([
    ['missing', undefined, 'is required'],
    ['null', null, 'is required'],
    ['blank', '   ', 'must not be blank'],
    ['not text', 42, 'must be text'],
  ])('SCRUM275_AC2_refuses_a_name_that_is_%s', (_label, name, message) => {
    const { details } = checkCreateEquipmentType({ name, totalQuantity: 1 });

    expect(details).toEqual([{ field: 'name', message }]);
  });

  it('SCRUM275_AC2_refuses_a_missing_total', () => {
    const { details } = checkCreateEquipmentType({ name: 'Cable' });

    expect(details).toEqual([{ field: 'totalQuantity', message: 'is required' }]);
  });

  it.each([
    ['negative', -1],
    ['a fraction', 1.5],
    ['text', '5'],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['a boolean', true],
    ['larger than the column holds', MAX_QUANTITY + 1],
  ])('SCRUM275_AC2_refuses_a_total_that_is_%s', (_label, totalQuantity) => {
    const { details } = checkCreateEquipmentType({ name: 'Cable', totalQuantity });

    expect(fields(details)).toEqual(['totalQuantity']);
  });

  it.each([[0], [1], [MAX_QUANTITY]])('SCRUM275_AC2_accepts_a_total_of_%s', (totalQuantity) => {
    const { details } = checkCreateEquipmentType({ name: 'Cable', totalQuantity });

    expect(details).toEqual([]);
  });

  it('SCRUM275_AC2_lists_every_invalid_field_together', () => {
    const { details } = checkCreateEquipmentType({
      name: '',
      description: 7,
      category: false,
      location: [],
      totalQuantity: -3,
    });

    expect(fields(details)).toEqual(['name', 'totalQuantity', 'description', 'category', 'location']);
  });

  it('SCRUM275_AC2_lists_both_required_fields_for_an_empty_body', () => {
    const { details } = checkCreateEquipmentType({});

    expect(fields(details)).toEqual(['name', 'totalQuantity']);
  });

  it.each([[null], [undefined], ['text'], [42], [[]]])(
    'SCRUM275_AC2_refuses_a_body_that_is_not_an_object_(%j)',
    (input) => {
      const { value, details } = checkCreateEquipmentType(input);

      expect(value).toBeNull();
      expect(details).toEqual([{ field: 'equipment', message: 'must be an object' }]);
    },
  );
});


describe('AC3: editing a type', () => {
  it('SCRUM275_AC3_accepts_any_single_field', () => {
    expect(checkUpdateEquipmentType({ name: 'Mic' }).value).toEqual({ name: 'Mic' });
    expect(checkUpdateEquipmentType({ totalQuantity: 9 }).value).toEqual({ totalQuantity: 9 });
    expect(checkUpdateEquipmentType({ location: 'Store 2' }).value).toEqual({ location: 'Store 2' });
  });

  it('SCRUM275_AC3_returns_only_the_fields_sent', () => {
    const { value } = checkUpdateEquipmentType({ name: 'Mic', totalQuantity: 4 });

    expect(Object.keys(value).sort()).toEqual(['name', 'totalQuantity']);
  });

  it('SCRUM275_AC3_clears_optional_text_with_null_or_blank', () => {
    const { value, details } = checkUpdateEquipmentType({ description: null, category: '  ' });

    expect(details).toEqual([]);
    expect(value).toEqual({ description: null, category: null });
  });

  it('SCRUM275_AC3_ignores_fields_that_have_their_own_endpoints', () => {
    const { value } = checkUpdateEquipmentType({
      name: 'Mic',
      damagedQuantity: 2,
      underMaintenanceQuantity: 1,
      retiredAt: '2026-10-01T00:00:00Z',
      id: 'x',
    });

    expect(value).toEqual({ name: 'Mic' });
  });

  it('SCRUM275_AC3_refuses_a_change_that_names_no_field', () => {
    for (const changes of [{}, { damagedQuantity: 1 }]) {
      const { details } = checkUpdateEquipmentType(changes);

      expect(hasField(details, 'equipment')).toBe(true);
    }
  });

  it('SCRUM275_AC3_applies_the_same_rules_as_creation', () => {
    const { details } = checkUpdateEquipmentType({ name: ' ', totalQuantity: -1, location: 5 });

    expect(fields(details)).toEqual(['name', 'totalQuantity', 'location']);
  });

  it('SCRUM275_AC3_refuses_clearing_the_name_or_the_total', () => {
    expect(fields(checkUpdateEquipmentType({ name: null }).details)).toEqual(['name']);
    expect(fields(checkUpdateEquipmentType({ totalQuantity: null }).details)).toEqual(['totalQuantity']);
  });

  it.each([[null], ['text'], [[]]])('SCRUM275_AC3_refuses_a_body_that_is_not_an_object_(%j)', (changes) => {
    const { value, details } = checkUpdateEquipmentType(changes);

    expect(value).toBeNull();
    expect(hasField(details, 'equipment')).toBe(true);
  });
});


describe('raising the collected problems', () => {
  it('SCRUM275_AC2_throws_one_ValidationError_carrying_every_detail', () => {
    const details = [
      { field: 'name', message: 'is required' },
      { field: 'totalQuantity', message: 'is required' },
    ];

    try {
      throwIfInvalid(details);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.status).toBe(400);
      expect(err.details).toEqual(details);
      expect(err.message).toBe('Invalid equipment details -- name: is required; totalQuantity: is required');
    }
  });

  it('SCRUM275_AC2_does_not_throw_when_there_is_nothing_wrong', () => {
    expect(() => throwIfInvalid([])).not.toThrow();
  });
});


describe('the equipment type id', () => {
  it('SCRUM275_AC3_accepts_a_uuid', () => {
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

    expect(validateEquipmentTypeId(id)).toBe(id);
  });

  it.each([['abc'], [''], [undefined], [null], [42]])('SCRUM275_AC3_refuses_%j_as_an_id', (id) => {
    expect(() => validateEquipmentTypeId(id)).toThrow(ValidationError);
  });
});
