/**
 * SCRUM-300: input checks for the reservation actions. Named SCRUM300_ACn_<what>.
 * Pure functions, so nothing is faked.
 */

import { describe, it, expect } from 'vitest';
import {
  checkReserveInput,
  checkReduceInput,
  checkReleaseInput,
  checkResolveInput,
  validateReservationId,
  MAX_REASON_LENGTH,
} from '../../src/validation/equipmentReviewValidation.js';
import { ValidationError } from '../../src/errors.js';

describe('AC2: the quantity to reserve', () => {
  it('SCRUM300_AC2_accepts_a_whole_number_above_zero', () => {
    expect(checkReserveInput({ quantity: 3 })).toEqual({ value: { quantity: 3 }, details: [] });
  });

  it.each([0, -1, 1.5, '2', null, undefined, NaN, Infinity, 2147483648, true, [], {}])(
    'SCRUM300_AC2_refuses_%j',
    (quantity) => {
      const { value, details } = checkReserveInput({ quantity });
      expect(value).toBeNull();
      expect(details).toEqual([expect.objectContaining({ field: 'quantity' })]);
    },
  );

  it.each([null, undefined, 'x', 5, []])('SCRUM300_AC2_refuses_a_body_that_is_%j', (body) => {
    const { value, details } = checkReserveInput(body);
    expect(value).toBeNull();
    expect(details).toHaveLength(1);
  });

  it('SCRUM300_AC2_ignores_everything_else_in_the_body', () => {
    const { value } = checkReserveInput({ quantity: 2, userId: 'someone', startAt: 'x', reviewerId: 'y' });
    expect(value).toEqual({ quantity: 2 });
  });
});

describe('AC4: reduce and release need a reason', () => {
  it('SCRUM300_AC4_reduce_accepts_a_quantity_and_a_trimmed_reason', () => {
    expect(checkReduceInput({ quantity: 1, reason: '  Not needed  ' }).value)
      .toEqual({ quantity: 1, reason: 'Not needed' });
  });

  it('SCRUM300_AC4_reduce_lists_every_fault_at_once', () => {
    const { details } = checkReduceInput({ quantity: 0, reason: '  ' });
    expect(details.map((d) => d.field).sort()).toEqual(['quantity', 'reason']);
  });

  it.each([undefined, null, '', '   ', 5, {}])('SCRUM300_AC4_release_refuses_the_reason_%j', (reason) => {
    const { value, details } = checkReleaseInput({ reason });
    expect(value).toBeNull();
    expect(details).toEqual([expect.objectContaining({ field: 'reason' })]);
  });

  it('SCRUM300_AC4_release_refuses_a_reason_that_is_too_long', () => {
    const { details } = checkReleaseInput({ reason: 'x'.repeat(MAX_REASON_LENGTH + 1) });
    expect(details).toEqual([expect.objectContaining({ field: 'reason' })]);
  });

  it('SCRUM300_AC4_release_accepts_a_reason_at_the_limit', () => {
    expect(checkReleaseInput({ reason: 'x'.repeat(MAX_REASON_LENGTH) }).details).toEqual([]);
  });

  it('SCRUM300_AC4_release_counts_the_reason_in_characters_so_an_emoji_counts_once', () => {
    const atLimit = `${'x'.repeat(MAX_REASON_LENGTH - 1)}😀`;

    expect(checkReleaseInput({ reason: atLimit }).details).toEqual([]);
    expect(checkReleaseInput({ reason: `${atLimit}😀` }).details).toEqual([expect.objectContaining({ field: 'reason' })]);
  });

  it('SCRUM300_AC4_release_refuses_no_body', () => {
    expect(checkReleaseInput(undefined).details).toHaveLength(1);
  });
});

describe('AC7: move and keep take an optional reason', () => {
  it.each([undefined, null, {}, { reason: '' }, { reason: '   ' }])('SCRUM300_AC7_accepts_%j_as_no_reason', (body) => {
    expect(checkResolveInput(body)).toEqual({ value: { reason: null }, details: [] });
  });

  it('SCRUM300_AC7_trims_a_reason_that_is_given', () => {
    expect(checkResolveInput({ reason: ' Date reverted ' }).value).toEqual({ reason: 'Date reverted' });
  });

  it.each([5, true, 'text', []])('SCRUM300_AC7_refuses_a_body_that_is_%j', (body) => {
    expect(checkResolveInput(body).details).toHaveLength(1);
  });

  it('SCRUM300_AC7_refuses_a_reason_that_is_not_text', () => {
    expect(checkResolveInput({ reason: 5 }).details).toEqual([expect.objectContaining({ field: 'reason' })]);
  });
});

describe('the reservation id', () => {
  it('SCRUM300_accepts_a_uuid', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(validateReservationId(id)).toBe(id);
  });

  it.each([undefined, null, '', 'abc', 5, '1111'])('SCRUM300_refuses_%j_with_a_ValidationError', (id) => {
    expect(() => validateReservationId(id)).toThrow(ValidationError);
  });
});
