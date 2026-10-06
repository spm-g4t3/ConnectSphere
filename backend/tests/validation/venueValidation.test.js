/**
 * Tests for venue input validation.
 *
 * SCRUM-94: validate venue creation and update input.
 * SCRUM-110: the venue id retirement is given.
 * SCRUM-111: the filters a venue search may be narrowed by.
 *
 * Describe blocks are named after the acceptance criteria they cover, so a
 * requirement traces to the test proving it.
 */

import { describe, it, expect } from 'vitest';

import {
  validateCreateVenue,
  validateUpdateVenue,
  validateVenueId,
  validateSearchFilters,
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


// ---------------------------------------------------------------------------
// SCRUM-110: the id retirement is given
// ---------------------------------------------------------------------------
describe('venue ids', () => {
  const VALID_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  it('accepts a uuid and hands it back unchanged', () => {
    expect(validateVenueId(VALID_ID)).toBe(VALID_ID);
  });

  it('accepts a uuid in upper case', () => {
    expect(validateVenueId(VALID_ID.toUpperCase())).toBe(VALID_ID.toUpperCase());
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['prose', 'not-a-uuid'],
    ['a bare number as text', '42'],
    ['a uuid missing a block', '3f2504e0-4f89-41d3-0305e82c3301'],
    ['a uuid with a non-hex character', '3f2504e0-4f89-41d3-9a0c-0305e82c330g'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object', {}],
  ])('rejects %s', (_label, value) => {
    const err = errorFrom(() => validateVenueId(value));
    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err)).toContain('id');
  });

  it('reports a 400 status for Express to use', () => {
    const err = errorFrom(() => validateVenueId('nonsense'));
    expect(err.status).toBe(400);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-111: the filters a search may be narrowed by
// ---------------------------------------------------------------------------
describe('venue search filters', () => {
  it('accepts no filters at all -- "show me everything" is a real search', () => {
    // Deliberately unlike validateUpdateVenue, which rejects an empty object.
    expect(validateSearchFilters()).toEqual({});
    expect(validateSearchFilters({})).toEqual({});
  });

  it('trims a location', () => {
    expect(validateSearchFilters({ location: '  SCIS  ' })).toEqual({ location: 'SCIS' });
  });

  it('keeps a valid minimum capacity', () => {
    expect(validateSearchFilters({ minCapacity: 40 })).toEqual({ minCapacity: 40 });
  });

  it('keeps both filters when both are given', () => {
    expect(validateSearchFilters({ location: 'SCIS', minCapacity: 40 }))
      .toEqual({ location: 'SCIS', minCapacity: 40 });
  });

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['null', null],
    ['undefined', undefined],
  ])('drops a location that is %s rather than failing the search', (_label, value) => {
    // An unfilled search box is not a filter. On create the same blankness is
    // an error, because there it means a mandatory field was left out.
    expect(validateSearchFilters({ location: value })).toEqual({});
  });

  it.each([
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
  ])('drops a minimum capacity that is %s', (_label, value) => {
    expect(validateSearchFilters({ minCapacity: value })).toEqual({});
  });

  it.each([
    ['zero', 0],
    ['negative', -10],
    ['fractional', 12.5],
    ['text that looks like a number', '40'],
  ])('rejects a minimum capacity that is %s', (_label, value) => {
    const err = errorFrom(() => validateSearchFilters({ minCapacity: value }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err)).toContain('minCapacity');
  });

  it('names minCapacity, not maxCapacity, when the capacity filter is wrong', () => {
    // The two fields share one rule; they must not share one error message.
    const err = errorFrom(() => validateSearchFilters({ minCapacity: 0 }));
    expect(fieldsIn(err)).toEqual(['minCapacity']);
  });

  it('rejects a location that is not text', () => {
    const err = errorFrom(() => validateSearchFilters({ location: 42 }));
    expect(fieldsIn(err)).toContain('location');
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'SCIS'],
  ])('rejects filters that are %s rather than an object', (_label, value) => {
    const err = errorFrom(() => validateSearchFilters(value));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/expected an object/i);
  });

  it('collects both faults rather than stopping at the first', () => {
    const err = errorFrom(() => validateSearchFilters({ location: 42, minCapacity: -1 }));
    expect(fieldsIn(err)).toEqual(['location', 'minCapacity']);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-130 (SCRUM-17 AC2): the optional date window on a venue search.
// ---------------------------------------------------------------------------
describe('SCRUM17_AC2 a venue search may carry a date window', () => {
  const START = '2026-10-01T09:00:00+08:00';
  const END = '2026-10-01T17:00:00+08:00';

  it('SCRUM17_AC2_keeps_the_window_trimmed', () => {
    expect(validateSearchFilters({ startsAt: `  ${START}`, endsAt: `${END} ` })).toEqual({
      startsAt: START,
      endsAt: END,
    });
  });

  it('SCRUM17_AC2_keeps_the_window_beside_the_other_filters', () => {
    expect(
      validateSearchFilters({ location: ' SCIS ', minCapacity: 40, startsAt: START, endsAt: END }),
    ).toEqual({ location: 'SCIS', minCapacity: 40, startsAt: START, endsAt: END });
  });

  it.each([
    ['blank', { startsAt: '', endsAt: '' }],
    ['whitespace', { startsAt: '  ', endsAt: ' ' }],
    ['null', { startsAt: null, endsAt: null }],
    ['undefined', { startsAt: undefined, endsAt: undefined }],
  ])('SCRUM17_AC2_%s_dates_give_no_keys_at_all', (_label, filters) => {
    const result = validateSearchFilters(filters);
    expect(result).toEqual({});
    expect(Object.keys(result)).toEqual([]);
  });

  it('SCRUM17_AC2_a_missing_end_is_refused_on_endsAt', () => {
    const err = errorFrom(() => validateSearchFilters({ startsAt: START }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'endsAt', message: 'is required when a start is given' }]);
  });

  it('SCRUM17_AC2_a_missing_start_is_refused_on_startsAt', () => {
    const err = errorFrom(() => validateSearchFilters({ startsAt: '', endsAt: END }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'startsAt', message: 'is required when an end is given' }]);
  });

  it.each([
    ['equal', START, START],
    ['reversed', END, START],
  ])('SCRUM17_AC2_an_%s_window_is_refused_on_endsAt', (_label, startsAt, endsAt) => {
    const err = errorFrom(() => validateSearchFilters({ startsAt, endsAt }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'endsAt', message: 'must be later than the start' }]);
  });

  it('SCRUM17_AC2_a_space_where_the_plus_was_is_refused', () => {
    const err = errorFrom(() =>
      validateSearchFilters({ startsAt: '2026-10-01T09:00:00 08:00', endsAt: END }),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err)).toEqual(['startsAt']);
  });

  it('SCRUM17_AC2_window_faults_are_collected_with_minCapacity_faults', () => {
    const err = errorFrom(() =>
      validateSearchFilters({ minCapacity: 0, startsAt: START }),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([
      { field: 'minCapacity', message: 'must be greater than zero' },
      { field: 'endsAt', message: 'is required when a start is given' },
    ]);
    expect(err.message).toMatch(/minCapacity: must be greater than zero; endsAt: is required/);
  });

  it('SCRUM17_AC2_a_search_window_has_no_cap_(a_two_year_window_passes)', () => {
    expect(
      validateSearchFilters({ startsAt: '2026-01-01T00:00:00Z', endsAt: '2028-01-01T00:00:00Z' }),
    ).toEqual({ startsAt: '2026-01-01T00:00:00Z', endsAt: '2028-01-01T00:00:00Z' });
  });

  it('SCRUM17_AC2_a_past_window_passes', () => {
    expect(
      validateSearchFilters({ startsAt: '2001-01-01T00:00:00Z', endsAt: '2001-01-02T00:00:00Z' }),
    ).toEqual({ startsAt: '2001-01-01T00:00:00Z', endsAt: '2001-01-02T00:00:00Z' });
  });
});


// ---------------------------------------------------------------------------
// SCRUM-185 (SCRUM-178 AC1): includeRetired, so a retired venue's calendar
// can be reached from search. Shape only here; the role rule is the route's.
// ---------------------------------------------------------------------------
describe('SCRUM178_AC1 a venue search may include retired venues', () => {
  const START = '2026-10-01T09:00:00+08:00';
  const END = '2026-10-01T17:00:00+08:00';

  it.each([
    ['boolean_true', true],
    ['string_true', 'true'],
  ])('SCRUM178_AC1_%s_sets_includeRetired', (_label, value) => {
    expect(validateSearchFilters({ includeRetired: value })).toEqual({ includeRetired: true });
  });

  it('SCRUM178_AC1_includeRetired_sits_beside_location_and_minCapacity', () => {
    expect(
      validateSearchFilters({ location: ' SCIS ', minCapacity: 40, includeRetired: 'true' }),
    ).toEqual({ location: 'SCIS', minCapacity: 40, includeRetired: true });
  });

  it.each([
    ['boolean_false', false],
    ['string_false', 'false'],
    ['undefined', undefined],
    ['null', null],
    ['blank', ''],
    ['whitespace', '   '],
  ])('SCRUM178_AC1_%s_leaves_no_includeRetired_key', (_label, value) => {
    const result = validateSearchFilters({ includeRetired: value });
    expect(result).toEqual({});
    expect(Object.keys(result)).toEqual([]);
  });

  it('SCRUM178_AC1_the_default_search_has_no_includeRetired_key', () => {
    expect('includeRetired' in validateSearchFilters()).toBe(false);
    expect('includeRetired' in validateSearchFilters({ location: 'SCIS' })).toBe(false);
  });

  it.each([
    ['upper_case_TRUE', 'TRUE'],
    ['one', '1'],
    ['yes', 'yes'],
    ['number_1', 1],
    ['array_from_a_repeated_param', ['true']],
    ['two_element_array', ['true', 'true']],
    ['object', {}],
  ])('SCRUM178_AC1_%s_is_refused_on_includeRetired', (_label, value) => {
    const err = errorFrom(() => validateSearchFilters({ includeRetired: value }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'includeRetired', message: 'must be true or false' }]);
  });

  it.each([
    ['boolean_true', true],
    ['string_true', 'true'],
  ])('SCRUM178_AC1_%s_with_a_date_window_is_refused_on_includeRetired', (_label, value) => {
    const err = errorFrom(() =>
      validateSearchFilters({ includeRetired: value, startsAt: START, endsAt: END }),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([
      {
        field: 'includeRetired',
        message: 'cannot be combined with a date window: a retired venue cannot be booked',
      },
    ]);
  });

  it('SCRUM178_AC1_includeRetired_false_with_a_window_is_the_ordinary_window_search', () => {
    expect(
      validateSearchFilters({ includeRetired: 'false', startsAt: START, endsAt: END }),
    ).toEqual({ startsAt: START, endsAt: END });
  });

  it('SCRUM178_AC1_includeRetired_faults_are_collected_with_other_faults', () => {
    const err = errorFrom(() => validateSearchFilters({ minCapacity: 0, includeRetired: 'yes' }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([
      { field: 'minCapacity', message: 'must be greater than zero' },
      { field: 'includeRetired', message: 'must be true or false' },
    ]);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-186: the turnaround between events, one of a fixed list of minutes
// (src/domain/turnaroundOptions.js, mirroring 017's CHECK).
// ---------------------------------------------------------------------------
describe('SCRUM186 turnaround time', () => {
  const OPTIONS = [0, 15, 30, 45, 60, 90, 120];
  const MESSAGE = 'must be one of 0, 15, 30, 45, 60, 90, 120 minutes';

  it.each(OPTIONS)('SCRUM186_create_accepts_turnaround_%s', (minutes) => {
    expect(validateCreateVenue({ ...VALID, turnaroundMinutes: minutes }).turnaroundMinutes)
      .toBe(minutes);
  });

  it.each(OPTIONS)('SCRUM186_update_accepts_turnaround_%s', (minutes) => {
    expect(validateUpdateVenue({ turnaroundMinutes: minutes })).toEqual({
      turnaroundMinutes: minutes,
    });
  });

  it('SCRUM186_create_leaves_an_omitted_turnaround_out_of_the_result', () => {
    const result = validateCreateVenue({ ...VALID });
    expect(result).not.toHaveProperty('turnaroundMinutes');
  });

  it('SCRUM186_create_treats_an_explicit_undefined_as_omitted', () => {
    const result = validateCreateVenue({ ...VALID, turnaroundMinutes: undefined });
    expect(result).not.toHaveProperty('turnaroundMinutes');
  });

  it('SCRUM186_update_leaves_an_omitted_turnaround_out_of_the_result', () => {
    expect(validateUpdateVenue({ name: 'x' })).toEqual({ name: 'x' });
  });

  it('SCRUM186_update_turnaround_0_alone_is_a_valid_change', () => {
    // 0 is falsy, but it is a real choice ("none"), not "no change supplied".
    expect(validateUpdateVenue({ turnaroundMinutes: 0 })).toEqual({ turnaroundMinutes: 0 });
  });

  it('SCRUM186_accepts_negative_zero_as_zero', () => {
    // Documented, not desired-or-undesired: Number.isInteger(-0) is true and
    // includes() uses SameValueZero, so -0 passes. JSON cannot send -0
    // distinctly (JSON.stringify(-0) === '0'), so it never arrives over HTTP.
    expect(validateCreateVenue({ ...VALID, turnaroundMinutes: -0 }).turnaroundMinutes).toBe(-0);
    expect(validateUpdateVenue({ turnaroundMinutes: -0 }).turnaroundMinutes).toBe(-0);
  });

  const BAD = [
    ['null', null],
    ['a numeric string', '30'],
    ['a value between options', 25],
    ['a negative option', -15],
    ['a gap longer than two hours', 180],
    ['a fractional number', 15.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['an object', {}],
    ['an array holding an option', [30]],
  ];

  it.each(BAD)('SCRUM186_create_rejects_%s_on_field_turnaroundMinutes', (_label, value) => {
    const err = errorFrom(() => validateCreateVenue({ ...VALID, turnaroundMinutes: value }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'turnaroundMinutes', message: MESSAGE }]);
  });

  it.each(BAD)('SCRUM186_update_rejects_%s_on_field_turnaroundMinutes', (_label, value) => {
    const err = errorFrom(() => validateUpdateVenue({ turnaroundMinutes: value }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'turnaroundMinutes', message: MESSAGE }]);
  });

  it('SCRUM186_update_null_turnaround_is_refused_rather_than_read_as_keep', () => {
    // update_venue reads NULL as "keep", so a deliberate null must not pass
    // validation and silently do nothing.
    const err = errorFrom(() => validateUpdateVenue({ turnaroundMinutes: null }));
    expect(fieldsIn(err)).toEqual(['turnaroundMinutes']);
  });

  it('SCRUM186_create_reports_a_bad_turnaround_together_with_a_bad_name', () => {
    const err = errorFrom(() =>
      validateCreateVenue({ ...VALID, name: '  ', turnaroundMinutes: 25 }),
    );
    expect(err.details).toHaveLength(2);
    expect(fieldsIn(err).sort()).toEqual(['name', 'turnaroundMinutes']);
  });

  it('SCRUM186_update_reports_a_bad_turnaround_together_with_a_bad_name', () => {
    const err = errorFrom(() => validateUpdateVenue({ name: '', turnaroundMinutes: 25 }));
    expect(err.details).toHaveLength(2);
    expect(fieldsIn(err).sort()).toEqual(['name', 'turnaroundMinutes']);
  });

  it('SCRUM186_the_summary_message_names_the_field', () => {
    const err = errorFrom(() => validateCreateVenue({ ...VALID, turnaroundMinutes: 25 }));
    expect(err.message).toContain(`turnaroundMinutes: ${MESSAGE}`);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-186: the per-weekday hours model is verified, not changed. Its limits
// (see the 017 header) are pinned here so nobody mistakes them for bugs.
// ---------------------------------------------------------------------------
describe('SCRUM186 operating hours model limits', () => {
  it('SCRUM186_a_day_left_out_is_closed_and_is_accepted', () => {
    // Monday to Friday only: Saturday (6) and Sunday (0) have no row.
    const weekdays = [1, 2, 3, 4, 5].map((day) => ({
      day_of_week: day, opens_at: '09:00', closes_at: '18:00',
    }));
    const result = validateCreateVenue({ ...VALID, hours: weekdays });
    expect(result.hours.map((h) => h.day_of_week)).toEqual([1, 2, 3, 4, 5]);
  });

  it('SCRUM186_no_hours_at_all_is_accepted_every_day_closed', () => {
    expect(validateCreateVenue({ ...VALID, hours: [] }).hours).toEqual([]);
  });

  it('SCRUM186_an_overnight_window_22_00_to_02_00_is_rejected', () => {
    const err = errorFrom(() =>
      validateCreateVenue({
        ...VALID,
        hours: [{ day_of_week: 5, opens_at: '22:00', closes_at: '02:00' }],
      }),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details[0]).toMatchObject({ field: 'hours' });
    expect(err.details[0].message).toMatch(/after opens_at/);
  });

  it('SCRUM186_an_overnight_window_is_rejected_on_update_too', () => {
    const err = errorFrom(() =>
      validateUpdateVenue({ hours: [{ day_of_week: 5, opens_at: '22:00', closes_at: '02:00' }] }),
    );
    expect(fieldsIn(err)).toEqual(['hours']);
  });

  it('SCRUM186_the_latest_closing_time_is_23_59', () => {
    expect(
      validateCreateVenue({
        ...VALID,
        hours: [{ day_of_week: 1, opens_at: '09:00', closes_at: '23:59' }],
      }).hours,
    ).toHaveLength(1);

    const err = errorFrom(() =>
      validateCreateVenue({
        ...VALID,
        hours: [{ day_of_week: 1, opens_at: '09:00', closes_at: '24:00' }],
      }),
    );
    expect(fieldsIn(err)).toContain('hours');
  });

  it('SCRUM186_only_one_window_per_day_no_split_shifts', () => {
    const err = errorFrom(() =>
      validateCreateVenue({
        ...VALID,
        hours: [
          { day_of_week: 2, opens_at: '08:00', closes_at: '12:00' },
          { day_of_week: 2, opens_at: '13:00', closes_at: '17:00' },
        ],
      }),
    );
    expect(err.details[0].message).toMatch(/repeats day 2/);
  });
});
