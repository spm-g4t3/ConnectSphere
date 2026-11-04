/**
 * Tests for the shared error collector.
 *
 * Each validator's own tests pin its messages end to end; these pin the parts
 * they all lean on: collection order, the message shape, and optional text.
 */

import { describe, it, expect } from 'vitest';

import {
  createErrorCollector,
  throwIfInvalid,
  checkOptionalText,
} from '../../src/validation/collector.js';
import { ValidationError } from '../../src/errors.js';

describe('createErrorCollector', () => {
  it('starts empty', () => {
    const errors = createErrorCollector();
    expect(errors.hasErrors).toBe(false);
    expect(errors.details).toEqual([]);
  });

  it('keeps every problem in the order it was added', () => {
    const errors = createErrorCollector();
    errors.add('name', 'is required');
    errors.add('capacity', 'must be a number');
    expect(errors.hasErrors).toBe(true);
    expect(errors.details).toEqual([
      { field: 'name', message: 'is required' },
      { field: 'capacity', message: 'must be a number' },
    ]);
  });
});

describe('throwIfInvalid', () => {
  it('does nothing when nothing was collected', () => {
    expect(() => throwIfInvalid(createErrorCollector(), 'Invalid thing')).not.toThrow();
  });

  it('throws one ValidationError opening with the label and listing every problem', () => {
    const errors = createErrorCollector();
    errors.add('name', 'is required');
    errors.add('capacity', 'must be a number');

    let thrown;
    try {
      throwIfInvalid(errors, 'Invalid thing');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    expect(thrown.message).toBe('Invalid thing -- name: is required; capacity: must be a number');
    expect(thrown.details).toBe(errors.details);
  });
});

describe('checkOptionalText', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['blank', '   '],
  ])('reads %s as absent, without an error', (_label, value) => {
    const errors = createErrorCollector();
    expect(checkOptionalText(errors, 'notes', value, 10)).toBeNull();
    expect(errors.hasErrors).toBe(false);
  });

  it('returns the text trimmed', () => {
    const errors = createErrorCollector();
    expect(checkOptionalText(errors, 'notes', '  hello  ', 10)).toBe('hello');
    expect(errors.hasErrors).toBe(false);
  });

  it('refuses a non-string', () => {
    const errors = createErrorCollector();
    expect(checkOptionalText(errors, 'notes', 42, 10)).toBeNull();
    expect(errors.details).toEqual([{ field: 'notes', message: 'must be text' }]);
  });

  it('counts code points, so an emoji is one character', () => {
    const errors = createErrorCollector();
    expect(checkOptionalText(errors, 'notes', '😀😀', 2)).toBe('😀😀');
    expect(checkOptionalText(errors, 'notes', '😀😀😀', 2)).toBeNull();
    expect(errors.details).toEqual([{ field: 'notes', message: 'must be 2 characters or fewer' }]);
  });
});
