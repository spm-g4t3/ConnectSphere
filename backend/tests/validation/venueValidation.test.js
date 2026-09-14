/**
 * Tests for venue input validation.
 *
 * SCRUM-94: validate venue creation and update input.
 *
 * Describe blocks are named after the acceptance criteria they cover, so a
 * requirement traces to the test proving it.
 */

import { describe, it, expect } from 'vitest';

import {
  validateCreateVenue,
  validateUpdateVenue,
} from '../../src/validation/venueValidation.js';
import { ValidationError } from '../../src/errors.js';

/** A minimal input that should always be accepted. */
const VALID = Object.freeze({
  name: 'Seminar Room 2-1',
  location: 'Level 2, SCIS',
  maxCapacity: 40,
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


describe('AC1: name, location and capacity are mandatory', () => {
  it('accepts a venue with all three', () => {
    expect(validateCreateVenue({ ...VALID })).toMatchObject(VALID);
  });

  it.each(['name', 'location', 'maxCapacity'])('rejects a missing %s', (field) => {
    const input = { ...VALID };
    delete input[field];

    const err = errorFrom(() => validateCreateVenue(input));
    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err)).toContain(field);
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['null', null],
    ['a number', 42],
  ])('rejects a name that is %s', (_label, value) => {
    const err = errorFrom(() => validateCreateVenue({ ...VALID, name: value }));
    expect(fieldsIn(err)).toContain('name');
  });

  it('reports a 400 status for Express to use', () => {
    const err = errorFrom(() => validateCreateVenue({}));
    expect(err.status).toBe(400);
  });
});


describe('AC1: capacity must be a positive whole number', () => {
  it.each([1, 40, 5000])('accepts %i', (value) => {
    expect(validateCreateVenue({ ...VALID, maxCapacity: value }).maxCapacity).toBe(value);
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['fractional', 40.5],
    ['a numeric string', '40'],
    ['not a number at all', 'forty'],
    ['NaN', Number.NaN],
    ['null', null],
    ['a boolean', true],
  ])('rejects %s', (_label, value) => {
    const err = errorFrom(() => validateCreateVenue({ ...VALID, maxCapacity: value }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err)).toContain('maxCapacity');
  });

  it('says why, not just that it failed', () => {
    const err = errorFrom(() => validateCreateVenue({ ...VALID, maxCapacity: 40.5 }));
    expect(err.details[0].message).toMatch(/whole number/i);
  });
});


describe('every problem is reported at once', () => {
  it('collects all three faults rather than stopping at the first', () => {
    const err = errorFrom(() =>
      validateCreateVenue({ name: '   ', maxCapacity: -5 }),
    );

    // blank name, missing location, non-positive capacity
    expect(err.details).toHaveLength(3);
    expect(fieldsIn(err).sort()).toEqual(['location', 'maxCapacity', 'name']);
  });

  it('summarises them all in the message', () => {
    const err = errorFrom(() => validateCreateVenue({}));
    expect(err.message).toMatch(/name/);
    expect(err.message).toMatch(/location/);
    expect(err.message).toMatch(/maxCapacity/);
  });
});


describe('normalisation', () => {
  it('trims surrounding whitespace', () => {
    const result = validateCreateVenue({
      ...VALID,
      name: '  Seminar Room 2-1  ',
      location: '  Level 2, SCIS  ',
    });

    expect(result.name).toBe('Seminar Room 2-1');
    expect(result.location).toBe('Level 2, SCIS');
  });

  it('omits attribute fields that were never supplied', () => {
    const result = validateCreateVenue({ ...VALID });
    expect(result).not.toHaveProperty('layouts');
    expect(result).not.toHaveProperty('hours');
  });
});


describe('attribute sets', () => {
  it.each(['layouts', 'accessibility', 'facilities'])('accepts codes for %s', (field) => {
    const result = validateCreateVenue({ ...VALID, [field]: ['projector', 'wifi'] });
    expect(result[field]).toEqual(['projector', 'wifi']);
  });

  it('accepts an empty array, which clears the set on update', () => {
    expect(validateCreateVenue({ ...VALID, facilities: [] }).facilities).toEqual([]);
  });

  it.each([
    ['a string instead of an array', 'projector'],
    ['an object', { code: 'projector' }],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    const err = errorFrom(() => validateCreateVenue({ ...VALID, facilities: value }));
    expect(fieldsIn(err)).toContain('facilities');
  });

  it('rejects an array containing a blank or non-string entry', () => {
    const err = errorFrom(() =>
      validateCreateVenue({ ...VALID, facilities: ['projector', '', 7] }),
    );
    expect(err.details).toHaveLength(2);
  });

  it('does not check whether a code exists -- that is the foreign key', () => {
    // Referential integrity is the database's job; this layer only checks shape.
    expect(() =>
      validateCreateVenue({ ...VALID, facilities: ['not_a_real_facility'] }),
    ).not.toThrow();
  });
});


describe('opening hours', () => {
  const hours = (entries) => ({ ...VALID, hours: entries });

  it('accepts a valid set', () => {
    const result = validateCreateVenue(
      hours([
        { day_of_week: 1, opens_at: '09:00', closes_at: '18:00' },
        { day_of_week: 2, opens_at: '09:00:00', closes_at: '17:30:00' },
      ]),
    );
    expect(result.hours).toHaveLength(2);
  });

  it.each([-1, 7, 1.5, '1', null])('rejects day_of_week of %s', (day) => {
    const err = errorFrom(() =>
      validateCreateVenue(hours([{ day_of_week: day, opens_at: '09:00', closes_at: '18:00' }])),
    );
    expect(fieldsIn(err)).toContain('hours');
  });

  it.each(['9:00', '25:00', '09:60', 'morning', '', 900])('rejects a time of %s', (time) => {
    const err = errorFrom(() =>
      validateCreateVenue(hours([{ day_of_week: 1, opens_at: time, closes_at: '18:00' }])),
    );
    expect(fieldsIn(err)).toContain('hours');
  });

  it('rejects a closing time before opening', () => {
    const err = errorFrom(() =>
      validateCreateVenue(hours([{ day_of_week: 1, opens_at: '18:00', closes_at: '09:00' }])),
    );
    expect(err.details[0].message).toMatch(/after opens_at/);
  });

  it('rejects opening and closing at the same time', () => {
    const err = errorFrom(() =>
      validateCreateVenue(hours([{ day_of_week: 1, opens_at: '09:00', closes_at: '09:00' }])),
    );
    expect(err).toBeInstanceOf(ValidationError);
  });

  it('treats 09:00 and 09:00:00 as the same instant', () => {
    // Mixed formats must not slip through on a plain string comparison.
    const err = errorFrom(() =>
      validateCreateVenue(hours([{ day_of_week: 1, opens_at: '09:00', closes_at: '09:00:00' }])),
    );
    expect(err).toBeInstanceOf(ValidationError);
  });

  it('rejects the same day appearing twice', () => {
    const err = errorFrom(() =>
      validateCreateVenue(
        hours([
          { day_of_week: 1, opens_at: '09:00', closes_at: '12:00' },
          { day_of_week: 1, opens_at: '13:00', closes_at: '18:00' },
        ]),
      ),
    );
    expect(err.details[0].message).toMatch(/repeats day 1/);
  });

  it('rejects an entry that is not an object', () => {
    const err = errorFrom(() => validateCreateVenue(hours(['09:00-18:00'])));
    expect(fieldsIn(err)).toContain('hours');
  });
});


describe('update rules', () => {
  it('accepts a single field', () => {
    expect(validateUpdateVenue({ maxCapacity: 80 })).toEqual({ maxCapacity: 80 });
  });

  it('accepts clearing an attribute set with an empty array', () => {
    expect(validateUpdateVenue({ facilities: [] })).toEqual({ facilities: [] });
  });

  it('does not require the mandatory create fields', () => {
    expect(() => validateUpdateVenue({ location: 'Level 4, SCIS' })).not.toThrow();
  });

  it.each([
    ['an empty object', {}],
    ['only undefined values', { name: undefined }],
  ])('rejects %s as a no-op', (_label, changes) => {
    const err = errorFrom(() => validateUpdateVenue(changes));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/no changes/i);
  });

  it('still rejects a blank name when one is supplied', () => {
    // Omitting name means "leave unchanged"; sending blank is a mistake.
    const err = errorFrom(() => validateUpdateVenue({ name: '   ' }));
    expect(fieldsIn(err)).toContain('name');
  });

  it('applies the same capacity rule', () => {
    const err = errorFrom(() => validateUpdateVenue({ maxCapacity: 0 }));
    expect(fieldsIn(err)).toContain('maxCapacity');
  });
});


describe('bad input shapes', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'venue'],
    ['a number', 7],
  ])('rejects %s instead of an object', (_label, value) => {
    expect(() => validateCreateVenue(value)).toThrow(ValidationError);
    expect(() => validateUpdateVenue(value)).toThrow(ValidationError);
  });

  it('always provides a details array, even when not field-specific', () => {
    const err = errorFrom(() => validateCreateVenue(null));
    expect(Array.isArray(err.details)).toBe(true);
  });
});
