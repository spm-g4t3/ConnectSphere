/**
 * Tests for the shared id shape.
 *
 * Each validator's own tests pin its message and field; these pin the shape
 * they all check against, and the caller-id guard the services share.
 */

import { describe, it, expect } from 'vitest';

import { UUID_PATTERN, isPlausibleId, requireCallerId } from '../../src/validation/ids.js';
import { ValidationError } from '../../src/errors.js';

const UUID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('UUID_PATTERN', () => {
  it('accepts a UUID in either case', () => {
    expect(UUID_PATTERN.test(UUID)).toBe(true);
    expect(UUID_PATTERN.test(UUID.toUpperCase())).toBe(true);
  });

  it('accepts any version, not only v4', () => {
    expect(UUID_PATTERN.test('11111111-1111-1111-1111-111111111111')).toBe(true);
  });

  it.each([
    ['surrounding spaces', ` ${UUID} `],
    ['a missing group', '7c9e6679-7425-40de-944b'],
    ['a non-hex character', '7c9e6679-7425-40de-944b-e07fc1f90aeg'],
    ['no hyphens', '7c9e6679742540de944be07fc1f90ae7'],
  ])('refuses %s', (_label, value) => {
    expect(UUID_PATTERN.test(value)).toBe(false);
  });
});

describe('isPlausibleId', () => {
  it('accepts a UUID, trimming it first', () => {
    expect(isPlausibleId(UUID)).toBe(true);
    expect(isPlausibleId(`  ${UUID}  `)).toBe(true);
  });

  it.each([
    ['a non-string', 42],
    ['null', null],
    ['an empty string', ''],
    ['a name', 'Annual Gala'],
  ])('refuses %s', (_label, value) => {
    expect(isPlausibleId(value)).toBe(false);
  });
});

describe('requireCallerId', () => {
  it('returns the id unchanged', () => {
    expect(requireCallerId(' abc ', 'coordinatorId')).toBe(' abc ');
  });

  it.each([
    ['a missing id', undefined],
    ['a non-string', 42],
    ['a blank id', '   '],
  ])('refuses %s, naming the parameter', (_label, value) => {
    expect(() => requireCallerId(value, 'coordinatorId')).toThrow(ValidationError);
    expect(() => requireCallerId(value, 'coordinatorId')).toThrow(/^coordinatorId is required$/);
  });
});
