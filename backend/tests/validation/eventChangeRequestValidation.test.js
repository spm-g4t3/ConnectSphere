/**
 * Tests for event change request input validation.
 *
 * SCRUM-11: request a change to a submitted event and specify what needs
 * updating (AC1, AC2).
 *
 * SCRUM-33: ensure the Organiser has supplied the required details, and that
 * the request is associated with the correct event.
 *
 * Describe blocks are named after the acceptance criteria they cover, so a
 * requirement traces to the test proving it.
 */

import { describe, it, expect } from 'vitest';

import { validateCreateChangeRequest } from '../../src/validation/eventChangeRequestValidation.js';
import { CHANGE_FIELD, CHANGE_FIELDS } from '../../src/domain/eventChangeField.js';
import { ValidationError } from '../../src/errors.js';

/** A minimal input that should always be accepted. */
const VALID = Object.freeze({
  eventRequestId: '11111111-1111-1111-1111-111111111111',
  changeField: 'expected_attendance',
  requestedChange: '120',
});

/** A requestedChange that is usable for every changeField, so tests that vary
 *  the field do not fail on a value shape check unrelated to what they mean
 *  to exercise. */
const VALID_REQUESTED_CHANGE = Object.freeze({
  [CHANGE_FIELD.EVENT_NAME]: 'Updated event name',
  [CHANGE_FIELD.DESCRIPTION]: 'Updated description',
  [CHANGE_FIELD.PURPOSE]: 'Updated purpose',
  [CHANGE_FIELD.PROPOSED_START]: '2026-10-15T09:00:00Z',
  [CHANGE_FIELD.PROPOSED_END]: '2026-10-15T17:00:00Z',
  [CHANGE_FIELD.EXPECTED_ATTENDANCE]: '120',
  [CHANGE_FIELD.VENUE]: 'Move to the larger hall on Level 3',
  [CHANGE_FIELD.EQUIPMENT]: 'Add two extra microphones',
  [CHANGE_FIELD.OTHER]: 'Something else that needs to change',
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
    const result = validateCreateChangeRequest({
      ...VALID,
      changeField,
      requestedChange: VALID_REQUESTED_CHANGE[changeField],
    });
    expect(result.changeField).toBe(changeField);
  });

  it('rejects a changeField outside the fixed vocabulary', () => {
    const err = errorFrom(() => validateCreateChangeRequest({ ...VALID, changeField: 'accessibility' }));
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


describe('SCRUM-33: the request is associated with the correct event', () => {
  it('accepts a well-formed event id', () => {
    expect(validateCreateChangeRequest({ ...VALID }).eventRequestId).toBe(VALID.eventRequestId);
  });

  it('rejects a missing eventRequestId', () => {
    const input = { ...VALID };
    delete input.eventRequestId;

    const err = errorFrom(() => validateCreateChangeRequest(input));
    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err)).toContain('eventRequestId');
  });

  it.each([
    ['not id-shaped at all', 'my-event'],
    ['an event name typed into the wrong box', 'Graduation Dinner 2026'],
    ['missing dashes', '11111111111111111111111111111111'],
    ['too short', '11111111-1111-1111-1111-1111'],
    ['whitespace only', '   '],
  ])('rejects an eventRequestId that is %s', (_label, value) => {
    const err = errorFrom(() => validateCreateChangeRequest({ ...VALID, eventRequestId: value }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err)).toContain('eventRequestId');
  });

  it('does not reject existence or ownership -- that needs the database', () => {
    // A syntactically valid id that names nothing is still accepted here.
    // eventChangeRequestService.js is where "does this event actually
    // exist, and does it belong to this caller?" is checked.
    const unknownButWellFormed = '99999999-9999-9999-9999-999999999999';
    expect(validateCreateChangeRequest({ ...VALID, eventRequestId: unknownButWellFormed }))
      .toMatchObject({ eventRequestId: unknownButWellFormed });
  });
});


describe('SCRUM-33: the organiser has provided usable details for the change', () => {
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

  describe('expected_attendance must be a positive whole number', () => {
    it.each(['1', '120', '5000'])('accepts %s', (value) => {
      const result = validateCreateChangeRequest({
        ...VALID,
        changeField: CHANGE_FIELD.EXPECTED_ATTENDANCE,
        requestedChange: value,
      });
      expect(result.requestedChange).toBe(value);
    });

    it.each([
      ['zero', '0'],
      ['negative', '-5'],
      ['fractional', '12.5'],
      ['not a number', 'lots'],
      ['a number with units', '120 people'],
    ])('rejects %s', (_label, value) => {
      const err = errorFrom(() => validateCreateChangeRequest({
        ...VALID,
        changeField: CHANGE_FIELD.EXPECTED_ATTENDANCE,
        requestedChange: value,
      }));
      expect(err).toBeInstanceOf(ValidationError);
      expect(fieldsIn(err)).toContain('requestedChange');
    });
  });

  describe.each([CHANGE_FIELD.PROPOSED_START, CHANGE_FIELD.PROPOSED_END])(
    '%s must be a valid date/time',
    (changeField) => {
      it.each([
        '2026-10-15T09:00:00Z',
        '2026-10-15T09:00:00+08:00',
        '2026-10-15',
      ])('accepts %s', (value) => {
        const result = validateCreateChangeRequest({ ...VALID, changeField, requestedChange: value });
        expect(result.requestedChange).toBe(value);
      });

      it.each([
        ['not a date at all', 'next tuesday afternoon'],
        // Date.parse('120') resolves to a real timestamp under JS's legacy
        // fallback rules; this is exactly the false positive checked against.
        ['a bare number', '120'],
        ['an empty string', ''],
      ])('rejects %s', (_label, value) => {
        const err = errorFrom(() => validateCreateChangeRequest({ ...VALID, changeField, requestedChange: value }));
        expect(err).toBeInstanceOf(ValidationError);
        expect(fieldsIn(err)).toContain('requestedChange');
      });
    },
  );

  it.each([CHANGE_FIELD.OTHER, CHANGE_FIELD.VENUE, CHANGE_FIELD.EQUIPMENT])(
    'does not impose a format on the free-text field %s beyond being non-blank',
    (changeField) => {
      const result = validateCreateChangeRequest({
        ...VALID,
        changeField,
        requestedChange: 'Please also add a wheelchair ramp at the side entrance',
      });
      expect(result.requestedChange).toBe('Please also add a wheelchair ramp at the side entrance');
    },
  );

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

