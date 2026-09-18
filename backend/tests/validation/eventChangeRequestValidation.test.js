/**
 * Tests for event change request input validation.
 *
 * SCRUM-11: request a change to a submitted event and specify what needs
 * updating (AC1, AC2).
 *
 * Describe blocks are named after the acceptance criteria they cover, so a
 * requirement traces to the test proving it.
 */

import { describe, it, expect } from 'vitest';

import { validateCreateChangeRequest } from '../../src/validation/eventChangeRequestValidation.js';
import { CHANGE_FIELDS } from '../../src/domain/eventChangeField.js';
import { ValidationError } from '../../src/errors.js';

/** A minimal input that should always be accepted. */
const VALID = Object.freeze({
  eventRequestId: '11111111-1111-1111-1111-111111111111',
  changeField: 'expected_attendance',
  requestedChange: '120',
});

/** Run validation and return the thrown error, or null if it passed. */
function errorFrom(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

/** Which fields a failed validation complained about. */
function fieldsIn(err) {
  return err.details.map((d) => d.field);
}


describe('AC2: the Organiser specifies which event field is changing', () => {
  it('accepts a valid change request', () => {
    expect(validateCreateChangeRequest({ ...VALID })).toEqual(VALID);
  });

  it.each(CHANGE_FIELDS)('accepts changeField %s', (changeField) => {
    expect(validateCreateChangeRequest({ ...VALID, changeField }).changeField).toBe(changeField);
  });

  it('rejects a changeField outside the fixed vocabulary', () => {
    const err = errorFrom(() => validateCreateChangeRequest({ ...VALID, changeField: 'venue' }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err)).toContain('changeField');
  });

  it('rejects a missing changeField', () => {
    const input = { ...VALID };
    delete input.changeField;

    const err = errorFrom(() => validateCreateChangeRequest(input));
    expect(fieldsIn(err)).toContain('changeField');
  });
});


describe('AC2: the Organiser specifies what the change should be', () => {
  it.each(['eventRequestId', 'requestedChange'])('rejects a missing %s', (field) => {
    const input = { ...VALID };
    delete input[field];

    const err = errorFrom(() => validateCreateChangeRequest(input));
    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err)).toContain(field);
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['null', null],
    ['a number', 42],
  ])('rejects a requestedChange that is %s', (_label, value) => {
    const err = errorFrom(() => validateCreateChangeRequest({ ...VALID, requestedChange: value }));
    expect(fieldsIn(err)).toContain('requestedChange');
  });

  it('trims surrounding whitespace from requestedChange', () => {
    const result = validateCreateChangeRequest({ ...VALID, requestedChange: '  120  ' });
    expect(result.requestedChange).toBe('120');
  });

  it('reports every problem at once, not just the first', () => {
    const err = errorFrom(() => validateCreateChangeRequest({}));
    expect(fieldsIn(err).sort()).toEqual(
      ['changeField', 'eventRequestId', 'requestedChange'].sort(),
    );
  });

  it('reports a 400 status for Express to use', () => {
    const err = errorFrom(() => validateCreateChangeRequest({}));
    expect(err.status).toBe(400);
  });
});


describe('input shape', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'not an object'],
  ])('rejects input that is %s', (_label, value) => {
    expect(() => validateCreateChangeRequest(value)).toThrow(ValidationError);
  });
});
