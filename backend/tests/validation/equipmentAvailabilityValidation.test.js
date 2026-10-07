/**
 * Tests for availability check input validation. SCRUM-23 (AC2).
 */

import { describe, it, expect } from 'vitest';
import { validateAvailabilityRequest, MAX_QUANTITY } from '../../src/validation/equipmentAvailabilityValidation.js';
import { ValidationError } from '../../src/errors.js';

const TYPE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const EVENT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const valid = (overrides = {}) => ({
  equipmentTypeId: TYPE_ID,
  quantity: 4,
  startAt: '2026-12-01T10:00:00Z',
  endAt: '2026-12-01T12:00:00Z',
  ...overrides,
});

function faultsOf(input) {
  try {
    validateAvailabilityRequest(input);
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    return err;
  }
}
const fields = (err) => err.details.map((detail) => detail.field);

describe('a valid request', () => {
  it('SCRUM23_AC2_is_accepted_and_returned_trimmed', () => {
    const request = validateAvailabilityRequest(valid({ equipmentTypeId: ` ${TYPE_ID} `, startAt: ' 2026-12-01T10:00:00Z ' }));

    expect(request).toEqual({
      equipmentTypeId: TYPE_ID,
      quantity: 4,
      startAt: '2026-12-01T10:00:00Z',
      endAt: '2026-12-01T12:00:00Z',
      eventRequestId: null,
    });
  });

  it('SCRUM23_AC7_carries_an_optional_event_request_id', () => {
    expect(validateAvailabilityRequest(valid({ eventRequestId: EVENT_ID })).eventRequestId).toBe(EVENT_ID);
  });

  it.each([[undefined], [null], ['']])('SCRUM23_AC7_treats_an_event_request_id_of_%j_as_none', (eventRequestId) => {
    expect(validateAvailabilityRequest(valid({ eventRequestId })).eventRequestId).toBeNull();
  });

  it('SCRUM23_AC2_accepts_offsets_other_than_Z', () => {
    expect(() => validateAvailabilityRequest(valid({ startAt: '2026-12-01T18:00:00+08:00', endAt: '2026-12-01T20:00:00+08:00' }))).not.toThrow();
  });
});

describe('the quantity', () => {
  it.each([[1], [4], [MAX_QUANTITY]])('SCRUM23_AC2_accepts_%s', (quantity) => {
    expect(() => validateAvailabilityRequest(valid({ quantity }))).not.toThrow();
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['a fraction', 2.5],
    ['text', '4'],
    ['NaN', Number.NaN],
    ['a boolean', true],
    ['larger than the column holds', MAX_QUANTITY + 1],
  ])('SCRUM23_AC2_refuses_a_quantity_that_is_%s', (_label, quantity) => {
    expect(fields(faultsOf(valid({ quantity })))).toEqual(['quantity']);
  });

  it.each([[undefined], [null]])('SCRUM23_AC2_requires_a_quantity_(%j)', (quantity) => {
    expect(faultsOf(valid({ quantity })).details).toEqual([{ field: 'quantity', message: 'is required' }]);
  });
});

describe('the equipment type', () => {
  it.each([[undefined], [null], [''], ['   ']])('SCRUM23_AC2_requires_a_type_(%j)', (equipmentTypeId) => {
    expect(faultsOf(valid({ equipmentTypeId })).details).toEqual([{ field: 'equipmentTypeId', message: 'is required' }]);
  });

  it.each([['abc'], [42], [['x']]])('SCRUM23_AC2_refuses_%j_as_a_type_id', (equipmentTypeId) => {
    expect(fields(faultsOf(valid({ equipmentTypeId })))).toEqual(['equipmentTypeId']);
  });

  it('SCRUM23_AC7_refuses_an_event_request_id_that_is_not_a_uuid', () => {
    expect(fields(faultsOf(valid({ eventRequestId: 'nope' })))).toEqual(['eventRequestId']);
  });
});

describe('the period', () => {
  it('SCRUM23_AC2_refuses_an_end_that_is_not_after_the_start', () => {
    const err = faultsOf(valid({ startAt: '2026-12-01T12:00:00Z', endAt: '2026-12-01T10:00:00Z' }));

    expect(err.details).toEqual([{ field: 'endAt', message: 'must be later than the start' }]);
  });

  it('SCRUM23_AC2_refuses_an_end_equal_to_the_start', () => {
    expect(fields(faultsOf(valid({ startAt: '2026-12-01T10:00:00Z', endAt: '2026-12-01T10:00:00Z' })))).toEqual(['endAt']);
  });

  it('SCRUM23_AC2_compares_instants_so_mixed_offsets_order_correctly', () => {
    // 10:00Z is 18:00 at +08:00, so an end of 19:00+08:00 is later, and 17:00+08:00 is earlier
    expect(() => validateAvailabilityRequest(valid({ startAt: '2026-12-01T10:00:00Z', endAt: '2026-12-01T19:00:00+08:00' }))).not.toThrow();
    expect(fields(faultsOf(valid({ startAt: '2026-12-01T10:00:00Z', endAt: '2026-12-01T17:00:00+08:00' })))).toEqual(['endAt']);
  });

  it('SCRUM23_AC2_requires_both_ends_when_neither_is_given', () => {
    const err = faultsOf(valid({ startAt: undefined, endAt: undefined }));

    expect(err.details).toEqual([
      { field: 'startAt', message: 'is required' },
      { field: 'endAt', message: 'is required' },
    ]);
  });

  it('SCRUM23_AC2_names_the_missing_end_when_only_one_is_given', () => {
    expect(fields(faultsOf(valid({ endAt: undefined })))).toEqual(['endAt']);
    expect(fields(faultsOf(valid({ startAt: '' })))).toEqual(['startAt']);
  });

  it.each([
    ['a date with no time', '2026-12-01'],
    ['a time with no offset', '2026-12-01T10:00:00'],
    ['a day that does not exist', '2026-02-30T10:00:00Z'],
    ['not a date', 'tomorrow'],
    ['epoch milliseconds', 1764583200000],
  ])('SCRUM23_AC2_refuses_a_start_that_is_%s', (_label, startAt) => {
    expect(fields(faultsOf(valid({ startAt })))).toContain('startAt');
  });
});

describe('every invalid input is listed together', () => {
  it('SCRUM23_AC2_lists_all_the_faults_at_once_and_in_the_message', () => {
    const err = faultsOf({ equipmentTypeId: 'x', quantity: 0, startAt: 'nope', endAt: undefined, eventRequestId: 'y' });

    expect(fields(err).sort()).toEqual(['endAt', 'equipmentTypeId', 'eventRequestId', 'quantity', 'startAt']);
    expect(err.message).toMatch(/^Invalid availability check -- /);
    expect(err.status).toBe(400);
  });

  it.each([[null], [undefined], ['text'], [42], [[]]])('SCRUM23_AC2_refuses_a_request_that_is_not_an_object_(%j)', (input) => {
    expect(faultsOf(input).details).toEqual([{ field: 'request', message: 'must be an object' }]);
  });
});
