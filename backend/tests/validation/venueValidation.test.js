/**
 * Tests for venue input validation.
 *
 * SCRUM-94: validate venue creation and update input.
 * SCRUM-110: the venue id retirement is given.
 * SCRUM-111: the filters a venue search may be narrowed by.
 * SCRUM-138 (SCRUM-20 AC1): a search against an event's requirements.
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
  validateEventSearchCriteria,
  SAFETY_TEXT_MAX_LENGTH,
  SAFETY_TEXT_BLANK_PATTERN,
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

  it('SCRUM575_AC1_a_closing_time_before_opening_is_the_next_day', () => {
    const result = validateCreateVenue(hours([{ day_of_week: 1, opens_at: '18:00', closes_at: '09:00' }]));
    expect(result.hours).toEqual([{ day_of_week: 1, opens_at: '18:00', closes_at: '09:00' }]);
  });

  it('SCRUM575_AC3_rejects_opening_and_closing_at_the_same_time', () => {
    const err = errorFrom(() =>
      validateCreateVenue(hours([{ day_of_week: 1, opens_at: '09:00', closes_at: '09:00' }])),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details[0]).toEqual({
      field: 'hours',
      message: 'hours[0].closes_at must differ from opens_at (an earlier closing time means the next day)',
    });
  });

  it('SCRUM575_AC3_rejects_opening_and_closing_at_the_same_time_on_update', () => {
    const err = errorFrom(() =>
      validateUpdateVenue({ hours: [{ day_of_week: 1, opens_at: '00:00', closes_at: '00:00' }] }),
    );
    expect(fieldsIn(err)).toEqual(['hours']);
    expect(err.details[0].message).toMatch(/must differ from opens_at/);
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

  it('reports a 400 status for a malformed venue id', () => {
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
// The per-weekday hours model's limits are pinned here so nobody mistakes them
// for bugs. A closing time before opening is overnight, not a limit.
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

  it('SCRUM575_AC1_an_overnight_window_22_00_to_02_00_is_accepted', () => {
    const result = validateCreateVenue({
      ...VALID,
      hours: [{ day_of_week: 5, opens_at: '22:00', closes_at: '02:00' }],
    });
    expect(result.hours).toEqual([{ day_of_week: 5, opens_at: '22:00', closes_at: '02:00' }]);
  });

  it('SCRUM575_AC1_an_overnight_window_is_accepted_on_update_too', () => {
    const result = validateUpdateVenue({
      hours: [{ day_of_week: 5, opens_at: '22:00', closes_at: '02:00' }],
    });
    expect(result.hours).toEqual([{ day_of_week: 5, opens_at: '22:00', closes_at: '02:00' }]);
  });

  it('SCRUM575_AC2_a_00_00_closing_time_is_midnight_and_is_accepted', () => {
    const result = validateCreateVenue({
      ...VALID,
      hours: [{ day_of_week: 6, opens_at: '18:00', closes_at: '00:00' }],
    });
    expect(result.hours).toEqual([{ day_of_week: 6, opens_at: '18:00', closes_at: '00:00' }]);
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


// ---------------------------------------------------------------------------
// SCRUM-137 (SCRUM-20): the setup time before an event, one of a fixed list
// of minutes (src/domain/setupOptions.js, mirroring 023's CHECK). Checked
// exactly like turnaround, but reported on its own field.
// ---------------------------------------------------------------------------
describe('SCRUM20_SCRUM137 setup time', () => {
  const OPTIONS = [0, 15, 30, 45, 60, 90, 120];
  const MESSAGE = 'must be one of 0, 15, 30, 45, 60, 90, 120 minutes';

  it.each(OPTIONS)('SCRUM20_SCRUM137_create_accepts_setup_%s', (minutes) => {
    expect(validateCreateVenue({ ...VALID, setupMinutes: minutes }).setupMinutes)
      .toBe(minutes);
  });

  it.each(OPTIONS)('SCRUM20_SCRUM137_update_accepts_setup_%s', (minutes) => {
    expect(validateUpdateVenue({ setupMinutes: minutes })).toEqual({
      setupMinutes: minutes,
    });
  });

  it('SCRUM20_SCRUM137_create_leaves_an_omitted_setup_out_of_the_result', () => {
    const result = validateCreateVenue({ ...VALID });
    expect(result).not.toHaveProperty('setupMinutes');
  });

  it('SCRUM20_SCRUM137_create_treats_an_explicit_undefined_as_omitted', () => {
    const result = validateCreateVenue({ ...VALID, setupMinutes: undefined });
    expect(result).not.toHaveProperty('setupMinutes');
  });

  it('SCRUM20_SCRUM137_update_leaves_an_omitted_setup_out_of_the_result', () => {
    expect(validateUpdateVenue({ name: 'x' })).toEqual({ name: 'x' });
    expect(validateUpdateVenue({ turnaroundMinutes: 30 })).toEqual({ turnaroundMinutes: 30 });
  });

  it('SCRUM20_SCRUM137_update_setup_0_alone_is_a_valid_change', () => {
    // 0 is falsy, but it is a real choice ("none"), not "no change supplied".
    expect(validateUpdateVenue({ setupMinutes: 0 })).toEqual({ setupMinutes: 0 });
  });

  it('SCRUM20_SCRUM137_setup_and_turnaround_are_kept_separate', () => {
    expect(
      validateCreateVenue({ ...VALID, setupMinutes: 15, turnaroundMinutes: 60 }),
    ).toMatchObject({ setupMinutes: 15, turnaroundMinutes: 60 });
    expect(validateUpdateVenue({ setupMinutes: 120, turnaroundMinutes: 0 })).toEqual({
      setupMinutes: 120,
      turnaroundMinutes: 0,
    });
  });

  const BAD = [
    ['null', null],
    ['a numeric string', '30'],
    ['a value between options', 25],
    ['a negative option', -15],
    ['a lead time longer than two hours', 180],
    ['a fractional number', 1.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['an object', {}],
    ['an array holding an option', [30]],
    ['a boolean', true],
  ];

  it.each(BAD)('SCRUM20_SCRUM137_create_rejects_%s_on_field_setupMinutes', (_label, value) => {
    const err = errorFrom(() => validateCreateVenue({ ...VALID, setupMinutes: value }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'setupMinutes', message: MESSAGE }]);
  });

  it.each(BAD)('SCRUM20_SCRUM137_update_rejects_%s_on_field_setupMinutes', (_label, value) => {
    const err = errorFrom(() => validateUpdateVenue({ setupMinutes: value }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'setupMinutes', message: MESSAGE }]);
  });

  it('SCRUM20_SCRUM137_update_null_setup_is_refused_rather_than_read_as_keep', () => {
    // update_venue reads NULL as "keep", so a deliberate null must not pass
    // validation and silently do nothing.
    const err = errorFrom(() => validateUpdateVenue({ setupMinutes: null }));
    expect(fieldsIn(err)).toEqual(['setupMinutes']);
  });

  it('SCRUM20_SCRUM137_create_null_setup_is_refused', () => {
    const err = errorFrom(() => validateCreateVenue({ ...VALID, setupMinutes: null }));
    expect(fieldsIn(err)).toEqual(['setupMinutes']);
  });

  it('SCRUM20_SCRUM137_a_bad_setup_is_not_reported_as_turnaround', () => {
    const err = errorFrom(() =>
      validateCreateVenue({ ...VALID, setupMinutes: 25, turnaroundMinutes: 30 }),
    );
    expect(fieldsIn(err)).toEqual(['setupMinutes']);
  });

  it('SCRUM20_SCRUM137_create_reports_a_bad_setup_together_with_a_bad_name', () => {
    const err = errorFrom(() =>
      validateCreateVenue({ ...VALID, name: '  ', setupMinutes: 25 }),
    );
    expect(err.details).toHaveLength(2);
    expect(fieldsIn(err).sort()).toEqual(['name', 'setupMinutes']);
  });

  it('SCRUM20_SCRUM137_update_reports_a_bad_setup_together_with_a_bad_turnaround', () => {
    const err = errorFrom(() =>
      validateUpdateVenue({ name: '', setupMinutes: 25, turnaroundMinutes: 25 }),
    );
    expect(err.details).toHaveLength(3);
    expect(fieldsIn(err).sort()).toEqual(['name', 'setupMinutes', 'turnaroundMinutes']);
  });

  it('SCRUM20_SCRUM137_the_summary_message_names_the_field', () => {
    const err = errorFrom(() => validateCreateVenue({ ...VALID, setupMinutes: 25 }));
    expect(err.message).toContain(`setupMinutes: ${MESSAGE}`);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-138, for SCRUM-20 AC1: "Search by event date, start time, end time and
// expected attendance. Room layout, accessibility features and facilities are
// optional." Cases B-AC1-01..10, 14 (shape half) and 15 of
// SCRUM-20-test-cases.md. Whether a code EXISTS (B-AC1-11..13) is the
// service's check and is tested in venueService.test.js.
// ---------------------------------------------------------------------------
describe('SCRUM20_AC1 event search criteria', () => {
  /** The required fields only: Wednesday 2026-11-11, 10:00-12:00 Singapore, 80 people. */
  const REQUIRED = Object.freeze({
    startsAt: '2026-11-11T10:00:00+08:00',
    endsAt: '2026-11-11T12:00:00+08:00',
    expectedAttendance: 80,
  });

  const detailsFor = (input) => errorFrom(() => validateEventSearchCriteria(input))?.details;

  it('SCRUM20_AC1_required_fields_only_is_valid', () => {
    // B-AC1-01: accepted, and no optional key appears.
    expect(validateEventSearchCriteria({ ...REQUIRED })).toEqual({ ...REQUIRED });
  });

  it('SCRUM20_AC1_every_criterion_supplied_is_valid', () => {
    const input = {
      ...REQUIRED,
      layout: 'theatre',
      accessibility: ['step_free_entrance'],
      facilities: ['projector', 'wifi'],
    };
    expect(validateEventSearchCriteria(input)).toEqual(input);
  });

  it('SCRUM20_AC1_timestamps_and_codes_are_trimmed', () => {
    const result = validateEventSearchCriteria({
      startsAt: '  2026-11-11T10:00:00+08:00 ',
      endsAt: ' 2026-11-11T12:00:00+08:00',
      expectedAttendance: 80,
      layout: '  theatre ',
      accessibility: [' lift_access '],
      facilities: ['wifi  '],
    });
    expect(result).toEqual({
      ...REQUIRED,
      layout: 'theatre',
      accessibility: ['lift_access'],
      facilities: ['wifi'],
    });
  });

  it('SCRUM20_AC1_utc_timestamps_are_accepted', () => {
    const input = { ...REQUIRED, startsAt: '2026-11-11T02:00:00Z', endsAt: '2026-11-11T04:00:00Z' };
    expect(validateEventSearchCriteria(input)).toEqual(input);
  });

  it.each([
    ['SCRUM20_AC1_missing_start_is_an_error', 'startsAt'],
    ['SCRUM20_AC1_missing_end_is_an_error', 'endsAt'],
    ['SCRUM20_AC1_missing_attendance_is_an_error', 'expectedAttendance'],
  ])('%s', (_name, field) => {
    const input = { ...REQUIRED };
    delete input[field];

    const err = errorFrom(() => validateEventSearchCriteria(input));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field, message: 'is required' }]);
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['a blank string', '   '],
  ])('SCRUM20_AC1_start_given_as_%s_is_required', (_label, value) => {
    expect(detailsFor({ ...REQUIRED, startsAt: value }))
      .toEqual([{ field: 'startsAt', message: 'is required' }]);
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
  ])('SCRUM20_AC1_end_given_as_%s_is_required', (_label, value) => {
    expect(detailsFor({ ...REQUIRED, endsAt: value }))
      .toEqual([{ field: 'endsAt', message: 'is required' }]);
  });

  it('SCRUM20_AC1_missing_period_reports_both_ends', () => {
    expect(detailsFor({ expectedAttendance: 80 })).toEqual([
      { field: 'startsAt', message: 'is required' },
      { field: 'endsAt', message: 'is required' },
    ]);
  });

  it('SCRUM20_AC1_missing_end_and_malformed_start_are_reported_together', () => {
    const details = detailsFor({ startsAt: 'tomorrow', expectedAttendance: 80 });
    expect(details.map((d) => d.field).sort()).toEqual(['endsAt', 'startsAt']);
    expect(details).toContainEqual({ field: 'endsAt', message: 'is required' });
  });

  it('SCRUM20_AC1_missing_start_and_malformed_end_are_reported_together', () => {
    const details = detailsFor({ endsAt: '2026-11-11T12:00:00', expectedAttendance: 80 });
    expect(details).toEqual([
      { field: 'startsAt', message: 'is required' },
      { field: 'endsAt', message: 'must include a UTC offset, such as Z or +08:00' },
    ]);
  });

  it('SCRUM20_AC1_missing_start_with_a_valid_end_reports_only_the_start', () => {
    expect(detailsFor({ endsAt: REQUIRED.endsAt, expectedAttendance: 80 }))
      .toEqual([{ field: 'startsAt', message: 'is required' }]);
  });

  it('SCRUM20_AC1_invalid_date_is_an_error', () => {
    // B-AC1-05: there is no 31 November.
    const details = detailsFor({ ...REQUIRED, startsAt: '2026-11-31T10:00:00+08:00' });
    expect(details.map((d) => d.field)).toEqual(['startsAt']);
  });

  it('SCRUM20_AC1_timestamp_without_offset_is_an_error', () => {
    // B-AC1-06
    expect(detailsFor({ ...REQUIRED, startsAt: '2026-11-11T10:00:00' })).toEqual([
      { field: 'startsAt', message: 'must include a UTC offset, such as Z or +08:00' },
    ]);
  });

  it('SCRUM20_AC1_timestamp_as_a_number_is_an_error', () => {
    const details = detailsFor({ ...REQUIRED, endsAt: Date.parse(REQUIRED.endsAt) });
    expect(details.map((d) => d.field)).toEqual(['endsAt']);
  });

  it('SCRUM20_AC1_end_equal_to_start_is_an_error', () => {
    // B-AC1-07
    expect(detailsFor({ ...REQUIRED, endsAt: REQUIRED.startsAt })).toEqual([
      { field: 'endsAt', message: 'must be later than the start' },
    ]);
  });

  it('SCRUM20_AC1_end_before_start_is_an_error', () => {
    // B-AC1-08
    expect(detailsFor({ ...REQUIRED, endsAt: '2026-11-11T09:00:00+08:00' })).toEqual([
      { field: 'endsAt', message: 'must be later than the start' },
    ]);
  });

  it('SCRUM20_AC1_end_before_start_is_judged_as_instants_across_offsets', () => {
    // The start 10:00+08:00 is 02:00Z; an end of 03:00Z is an hour later, so
    // the window is valid even though "03:00" reads earlier than "10:00".
    expect(() => validateEventSearchCriteria({
      ...REQUIRED,
      endsAt: '2026-11-11T03:00:00Z',
    })).not.toThrow();
    // 01:00Z is 09:00 Singapore: before the 10:00 start.
    expect(detailsFor({ ...REQUIRED, endsAt: '2026-11-11T01:00:00Z' })).toEqual([
      { field: 'endsAt', message: 'must be later than the start' },
    ]);
  });

  it.each([
    ['SCRUM20_AC1_attendance_below_one_is_an_error (0)', 0, 'must be greater than zero'],
    ['SCRUM20_AC1_attendance_below_one_is_an_error (-1)', -1, 'must be greater than zero'],
    ['SCRUM20_AC1_attendance_below_one_is_an_error (-5)', -5, 'must be greater than zero'],
    ['SCRUM20_AC1_fractional_attendance_is_an_error (1.5)', 1.5, 'must be a whole number'],
    ['SCRUM20_AC1_fractional_attendance_is_an_error (80.5)', 80.5, 'must be a whole number'],
    ['SCRUM20_AC1_attendance_as_text_is_an_error', '40', 'must be a number'],
    ['SCRUM20_AC1_attendance_nan_is_an_error', NaN, 'must be a number'],
    ['SCRUM20_AC1_attendance_null_is_required', null, 'is required'],
  ])('%s', (_name, value, message) => {
    expect(detailsFor({ ...REQUIRED, expectedAttendance: value }))
      .toEqual([{ field: 'expectedAttendance', message }]);
  });

  it('SCRUM20_AC1_attendance_of_one_is_valid', () => {
    expect(validateEventSearchCriteria({ ...REQUIRED, expectedAttendance: 1 }).expectedAttendance)
      .toBe(1);
  });

  it.each([
    ['a number', 3],
    ['an array', ['theatre']],
    ['an object', { code: 'theatre' }],
    ['a boolean', true],
  ])('SCRUM20_AC1_layout_as_%s_is_an_error', (_label, value) => {
    expect(detailsFor({ ...REQUIRED, layout: value }))
      .toEqual([{ field: 'layout', message: 'must be a single layout code' }]);
  });

  it.each(['accessibility', 'facilities'])('SCRUM20_AC1_%s_not_an_array_is_an_error', (field) => {
    expect(detailsFor({ ...REQUIRED, [field]: 'wifi' }))
      .toEqual([{ field, message: 'must be an array of codes' }]);
  });

  it.each(['accessibility', 'facilities'])('SCRUM20_AC1_%s_with_blank_entries_is_an_error', (field) => {
    expect(detailsFor({ ...REQUIRED, [field]: ['ok', '', '  ', 7] })).toEqual([
      { field, message: 'entry 1 must be a non-empty code' },
      { field, message: 'entry 2 must be a non-empty code' },
      { field, message: 'entry 3 must be a non-empty code' },
    ]);
  });

  it('SCRUM20_AC1_every_fault_is_reported_at_once', () => {
    // B-AC1-14, shape half: no endsAt, attendance 0, and a malformed facility
    // list come back in one ValidationError. (The unknown-code half cannot
    // join them: validation throws before the service looks codes up -- see
    // venueService.test.js.)
    const err = errorFrom(() => validateEventSearchCriteria({
      startsAt: REQUIRED.startsAt,
      expectedAttendance: 0,
      layout: 7,
      facilities: [''],
    }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([
      { field: 'endsAt', message: 'is required' },
      { field: 'expectedAttendance', message: 'must be greater than zero' },
      { field: 'layout', message: 'must be a single layout code' },
      { field: 'facilities', message: 'entry 0 must be a non-empty code' },
    ]);
  });

  it('SCRUM20_AC1_the_summary_message_names_each_field', () => {
    const err = errorFrom(() => validateEventSearchCriteria({ startsAt: REQUIRED.startsAt }));
    expect(err.message).toContain('endsAt: is required');
    expect(err.message).toContain('expectedAttendance: is required');
  });

  it('SCRUM20_AC1_unknown_keys_are_ignored', () => {
    expect(validateEventSearchCriteria({
      ...REQUIRED,
      attendance: 999,
      includeRetired: true,
      eventName: 'Gala',
    })).toEqual({ ...REQUIRED });
  });

  it('SCRUM20_AC1_empty_optional_criteria_mean_not_filtered', () => {
    // B-AC1-15: an unfilled form field is not a criterion.
    const result = validateEventSearchCriteria({
      ...REQUIRED,
      layout: '',
      accessibility: [],
      facilities: [],
    });
    expect(result).toEqual({ ...REQUIRED });
    expect(result).not.toHaveProperty('layout');
    expect(result).not.toHaveProperty('accessibility');
    expect(result).not.toHaveProperty('facilities');
  });

  it('SCRUM20_AC1_null_or_blank_optional_criteria_mean_not_filtered', () => {
    expect(validateEventSearchCriteria({
      ...REQUIRED,
      layout: '   ',
      accessibility: null,
      facilities: undefined,
    })).toEqual({ ...REQUIRED });
    expect(validateEventSearchCriteria({ ...REQUIRED, layout: null })).toEqual({ ...REQUIRED });
  });

  it('SCRUM20_AC1_does_not_mutate_its_input', () => {
    const input = { ...REQUIRED, layout: ' theatre ', facilities: [' wifi '] };
    const snapshot = structuredClone(input);
    validateEventSearchCriteria(input);
    expect(input).toEqual(snapshot);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an array', [REQUIRED]],
    ['a string', 'startsAt=...'],
    ['a number', 80],
  ])('SCRUM20_AC1_criteria_given_as_%s_are_refused', (_label, value) => {
    const err = errorFrom(() => validateEventSearchCriteria(value));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/expected an object/);
  });
});


describe('SCRUM20_AC1 SCRUM141 event search location', () => {
  const REQUIRED = Object.freeze({
    startsAt: '2026-11-11T10:00:00+08:00',
    endsAt: '2026-11-11T12:00:00+08:00',
    expectedAttendance: 80,
  });

  const detailsFor = (input) => errorFrom(() => validateEventSearchCriteria(input))?.details;

  it('SCRUM20_AC1_location_is_optional', () => {
    const result = validateEventSearchCriteria({ ...REQUIRED });
    expect(result).toEqual({ ...REQUIRED });
    expect(result).not.toHaveProperty('location');
  });

  it('SCRUM20_AC1_location_is_kept_when_supplied', () => {
    expect(validateEventSearchCriteria({ ...REQUIRED, location: 'Level 2' }))
      .toEqual({ ...REQUIRED, location: 'Level 2' });
  });

  it('SCRUM20_AC1_location_is_trimmed', () => {
    expect(validateEventSearchCriteria({ ...REQUIRED, location: '  Orchard Road \t' }).location)
      .toBe('Orchard Road');
  });

  it('SCRUM20_AC1_location_keeps_its_case_and_inner_spaces', () => {
    expect(validateEventSearchCriteria({ ...REQUIRED, location: ' LEVEL  1 ' }).location)
      .toBe('LEVEL  1');
  });

  it('SCRUM20_AC1_location_keeps_percent_and_underscore_as_typed', () => {
    expect(validateEventSearchCriteria({ ...REQUIRED, location: '100%_Hall' }).location)
      .toBe('100%_Hall');
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a blank string', '   '],
  ])('SCRUM20_AC1_location_given_as_%s_means_not_filtered', (_label, value) => {
    const result = validateEventSearchCriteria({ ...REQUIRED, location: value });
    expect(result).toEqual({ ...REQUIRED });
    expect(result).not.toHaveProperty('location');
  });

  it.each([
    ['a number', 42],
    ['a boolean', true],
    ['an array', ['Level 1']],
    ['an object', { contains: 'Level' }],
  ])('SCRUM20_AC1_location_given_as_%s_must_be_text', (_label, value) => {
    const err = errorFrom(() => validateEventSearchCriteria({ ...REQUIRED, location: value }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'location', message: 'must be text' }]);
    expect(err.message).toMatch(/^Invalid venue search -- /);
  });

  it('SCRUM20_AC1_a_bad_location_is_reported_with_every_other_fault', () => {
    const details = detailsFor({ startsAt: REQUIRED.startsAt, location: 7 });
    expect(details).toEqual(expect.arrayContaining([
      { field: 'endsAt', message: 'is required' },
      { field: 'expectedAttendance', message: 'is required' },
      { field: 'location', message: 'must be text' },
    ]));
  });

  it('SCRUM20_AC1_every_criterion_with_location_is_valid', () => {
    const input = {
      ...REQUIRED,
      layout: 'theatre',
      accessibility: ['step_free_entrance'],
      facilities: ['projector'],
      location: 'Level 1',
    };
    expect(validateEventSearchCriteria(input)).toEqual(input);
  });

  it('SCRUM20_AC1_location_does_not_mutate_its_input', () => {
    const input = { ...REQUIRED, location: '  Level 1  ' };
    validateEventSearchCriteria(input);
    expect(input.location).toBe('  Level 1  ');
  });
});


describe('SCRUM20 SCRUM140 a refused search is not reported as bad venue details', () => {
  const REQUIRED = Object.freeze({
    startsAt: '2026-11-11T10:00:00+08:00',
    endsAt: '2026-11-11T12:00:00+08:00',
    expectedAttendance: 80,
  });

  it('SCRUM20_AC1_event_search_errors_start_with_Invalid_venue_search', () => {
    const err = errorFrom(() => validateEventSearchCriteria({ ...REQUIRED, expectedAttendance: 0 }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message.startsWith('Invalid venue search -- ')).toBe(true);
    expect(err.message).not.toMatch(/venue details/);
    expect(fieldsIn(err)).toEqual(['expectedAttendance']);
  });

  it('SCRUM20_AC1_every_search_fault_is_listed_after_the_search_label', () => {
    const err = errorFrom(() => validateEventSearchCriteria({}));

    expect(err.message).toMatch(/^Invalid venue search -- /);
    expect(err.message).toContain('startsAt: is required');
    expect(err.message).toContain('expectedAttendance: is required');
  });

  it('SCRUM20_SCRUM140_venue_create_errors_still_start_with_Invalid_venue_details', () => {
    const err = errorFrom(() => validateCreateVenue({ ...VALID, maxCapacity: -5 }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message.startsWith('Invalid venue details -- ')).toBe(true);
  });

  it('SCRUM20_SCRUM140_venue_update_errors_still_start_with_Invalid_venue_details', () => {
    const err = errorFrom(() => validateUpdateVenue({ maxCapacity: -5 }));

    expect(err.message.startsWith('Invalid venue details -- ')).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-493 (AC1, AC2, AC4): emergencyAccess and knownRestrictions, optional
// free text of up to 2,000 characters each (checkSafetyText). Every branch is
// run on both create and update: left out (omitted), null or blank (null,
// "not recorded" -- on an update, "clear it"), not a string ("must be text"),
// text (trimmed), and the length bound, counted in code points as Postgres
// char_length() counts them.
// ---------------------------------------------------------------------------
describe('SCRUM493 emergency access and known restrictions', () => {
  const SAFETY_FIELDS = ['emergencyAccess', 'knownRestrictions'];
  const TOO_LONG = 'must be 2000 characters or fewer';

  /** Run one validator over a single safety field. */
  const MODES = [
    ['create', (field, value) => validateCreateVenue({ ...VALID, [field]: value })],
    ['update', (field, value) => validateUpdateVenue({ [field]: value })],
  ];

  const CASES = MODES.flatMap(([mode, run]) => SAFETY_FIELDS.map((field) => [mode, field, run]));

  it('SCRUM493_AC1_the_limit_is_2000_characters', () => {
    // Mirrors the venues CHECKs in db/baseline/03_venues.sql.
    expect(SAFETY_TEXT_MAX_LENGTH).toBe(2000);
  });

  it.each(CASES)('SCRUM493_AC1_%s_omitted_%s_is_left_out', (mode, field, run) => {
    // Left out means "not given" on create and "keep" on update: the key must
    // not appear at all, or the service would send it as a clear.
    if (mode === 'create') {
      expect(validateCreateVenue({ ...VALID })).not.toHaveProperty(field);
      expect(run(field, undefined)).not.toHaveProperty(field);
    } else {
      expect(validateUpdateVenue({ name: 'Harbour Room', [field]: undefined })).not.toHaveProperty(field);
    }
  });

  it.each(CASES)('SCRUM493_AC2_%s_%s_null_is_kept_as_null', (_mode, field, run) => {
    const result = run(field, null);
    expect(result).toHaveProperty(field, null);
  });

  it.each(CASES)('SCRUM493_AC2_%s_%s_blank_becomes_null', (_mode, field, run) => {
    for (const blank of ['', '   ', '\t', '\n', ' \r\n\t ']) {
      expect(run(field, blank), JSON.stringify(blank)).toHaveProperty(field, null);
    }
  });

  it.each(CASES)('SCRUM493_AC1_%s_%s_non_string_must_be_text', (_mode, field, run) => {
    for (const value of [42, 0, true, false, ['exit'], { text: 'exit' }]) {
      const err = errorFrom(() => run(field, value));
      expect(err, JSON.stringify(value)).toBeInstanceOf(ValidationError);
      expect(err.details).toEqual([{ field, message: 'must be text' }]);
    }
  });

  it.each(CASES)('SCRUM493_AC1_%s_%s_text_is_trimmed', (_mode, field, run) => {
    expect(run(field, '  Exits on the east side.\n\t')).toHaveProperty(field, 'Exits on the east side.');
    // Inner whitespace and line breaks are the user's and are kept.
    expect(run(field, 'Exit A\n\nExit B')).toHaveProperty(field, 'Exit A\n\nExit B');
  });

  it.each(CASES)('SCRUM493_AC1_%s_%s_trims_a_non_breaking_space', (_mode, field, run) => {
    // String.prototype.trim() strips U+00A0, so the API never stores a value
    // that is only non-breaking spaces. Known, accepted limit: a DIRECT SQL
    // write of only U+00A0 is stored, because [[:space:]] does not match it
    // in PGlite; the API path, tested here, is what users go through.
    expect(run(field, '\u00a0\u00a0')).toHaveProperty(field, null);
    expect(run(field, '\u00a0Exit A\u00a0')).toHaveProperty(field, 'Exit A');
  });

  it.each(CASES)('SCRUM493_AC1_%s_%s_2000_characters_is_accepted', (_mode, field, run) => {
    const text = 'x'.repeat(2000);
    expect(run(field, text)).toHaveProperty(field, text);
    // Measured after the trim: surrounding whitespace does not count.
    expect(run(field, `  ${text}\n`)).toHaveProperty(field, text);
  });

  it.each(CASES)('SCRUM493_AC1_%s_%s_2001_characters_is_refused', (_mode, field, run) => {
    const err = errorFrom(() => run(field, 'x'.repeat(2001)));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field, message: TOO_LONG }]);
  });

  it.each(CASES)('SCRUM493_AC1_%s_%s_an_emoji_counts_as_one_character', (_mode, field, run) => {
    // 2,000 emoji are 4,000 UTF-16 units but 2,000 code points, which is what
    // char_length() counts: accepted. 2,001 are refused.
    const accepted = '\u{1F6AA}'.repeat(2000);
    expect(accepted.length).toBe(4000);
    expect(run(field, accepted)).toHaveProperty(field, accepted);

    const err = errorFrom(() => run(field, '\u{1F6AA}'.repeat(2001)));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field, message: TOO_LONG }]);
  });

  it('SCRUM493_AC4_knownRestrictions_null_alone_is_a_valid_change', () => {
    // A clear on its own is a change, not "no changes supplied".
    expect(validateUpdateVenue({ knownRestrictions: null })).toEqual({ knownRestrictions: null });
    expect(validateUpdateVenue({ emergencyAccess: null })).toEqual({ emergencyAccess: null });
    expect(validateUpdateVenue({ knownRestrictions: '   ' })).toEqual({ knownRestrictions: null });
  });

  it('SCRUM493_AC4_an_update_with_one_field_returns_only_that_field', () => {
    expect(validateUpdateVenue({ emergencyAccess: ' Exit A ' })).toEqual({ emergencyAccess: 'Exit A' });
  });

  it.each([
    ['create', (changes) => validateCreateVenue({ ...VALID, ...changes })],
    ['update', (changes) => validateUpdateVenue(changes)],
  ])('SCRUM493_AC1_%s_reports_both_errors_at_once', (_mode, run) => {
    const err = errorFrom(() => run({ emergencyAccess: 'x'.repeat(2001), knownRestrictions: 7 }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([
      { field: 'emergencyAccess', message: TOO_LONG },
      { field: 'knownRestrictions', message: 'must be text' },
    ]);
  });

  it('SCRUM493_AC1_create_reports_safety_errors_alongside_other_fields', () => {
    const err = errorFrom(() =>
      validateCreateVenue({ ...VALID, name: '', knownRestrictions: 'x'.repeat(2001) }),
    );
    expect(fieldsIn(err)).toEqual(expect.arrayContaining(['name', 'knownRestrictions']));
  });

  it('SCRUM493_AC1_create_keeps_both_fields_beside_the_others', () => {
    expect(
      validateCreateVenue({ ...VALID, emergencyAccess: 'Exit A', knownRestrictions: null }),
    ).toMatchObject({ ...VALID, emergencyAccess: 'Exit A', knownRestrictions: null });
  });
});

// ---------------------------------------------------------------------------
// SCRUM-493 review fixes: invisible-only text is blank (AC2), and characters
// Postgres cannot store (U+0000, unpaired UTF-16 surrogates) are refused as a
// field error rather than reaching the database as a 500 (AC1).
// ---------------------------------------------------------------------------
describe('SCRUM493 invisible-only text and unsupported characters', () => {
  const SAFETY_FIELDS = ['emergencyAccess', 'knownRestrictions'];
  const UNSUPPORTED = 'must not contain unsupported characters';
  const MODES = [
    ['create', (field, value) => validateCreateVenue({ ...VALID, [field]: value })],
    ['update', (field, value) => validateUpdateVenue({ [field]: value })],
  ];
  const CASES = MODES.flatMap(([mode, run]) => SAFETY_FIELDS.map((field) => [mode, field, run]));

  /** The characters that draw nothing, each named for a readable failure. */
  const INVISIBLES = [
    ['U+200B zero width space', '​'],
    ['U+2060 word joiner', '⁠'],
    ['U+FEFF byte order mark', '﻿'],
    ['U+00AD soft hyphen', '­'],
    ['U+180E mongolian vowel separator', '᠎'],
    ['U+2800 braille blank', '⠀'],
    ['U+3164 hangul filler', 'ㅤ'],
    ['U+115F hangul choseong filler', 'ᅟ'],
    ['U+1160 hangul jungseong filler', 'ᅠ'],
    ['U+FFA0 halfwidth hangul filler', 'ﾠ'],
  ];

  it('SCRUM493_AC2_SAFETY_TEXT_BLANK_PATTERN_is_exported_and_matches_every_invisible', () => {
    expect(SAFETY_TEXT_BLANK_PATTERN).toBeInstanceOf(RegExp);
    expect(SAFETY_TEXT_BLANK_PATTERN.flags).toContain('u');
    for (const [label, ch] of INVISIBLES) {
      expect(SAFETY_TEXT_BLANK_PATTERN.test(ch), label).toBe(true);
      expect(SAFETY_TEXT_BLANK_PATTERN.test(` ${ch}\n${ch}\t`), label).toBe(true);
    }
    expect(SAFETY_TEXT_BLANK_PATTERN.test(INVISIBLES.map(([, ch]) => ch).join(''))).toBe(true);
    expect(SAFETY_TEXT_BLANK_PATTERN.test('')).toBe(true);
    expect(SAFETY_TEXT_BLANK_PATTERN.test(' \r\n\t')).toBe(true);
  });

  it('SCRUM493_AC2_SAFETY_TEXT_BLANK_PATTERN_does_not_match_a_visible_character', () => {
    for (const text of ['a', '​a', 'a​', '.', '\u{1F6AA}', 'ㅤx', '\u0000', '\uD800']) {
      expect(SAFETY_TEXT_BLANK_PATTERN.test(text), JSON.stringify(text)).toBe(false);
    }
  });

  it.each(CASES)('SCRUM493_AC2_%s_%s_each_invisible_alone_becomes_null', (_mode, field, run) => {
    for (const [label, ch] of INVISIBLES) {
      expect(run(field, ch), label).toHaveProperty(field, null);
      expect(run(field, ch.repeat(3)), label).toHaveProperty(field, null);
    }
  });

  it.each(CASES)('SCRUM493_AC2_%s_%s_each_invisible_mixed_with_spaces_becomes_null', (_mode, field, run) => {
    for (const [label, ch] of INVISIBLES) {
      expect(run(field, ` ${ch} ${ch} `), label).toHaveProperty(field, null);
      expect(run(field, `\t${ch} `), label).toHaveProperty(field, null);
    }
  });

  it.each(CASES)('SCRUM493_AC2_%s_%s_each_invisible_mixed_with_newlines_becomes_null', (_mode, field, run) => {
    for (const [label, ch] of INVISIBLES) {
      expect(run(field, `\n${ch}\r\n${ch}\n`), label).toHaveProperty(field, null);
    }
  });

  it.each(CASES)('SCRUM493_AC2_%s_%s_all_invisibles_together_become_null', (_mode, field, run) => {
    const all = INVISIBLES.map(([, ch]) => ch).join(' \n');
    expect(run(field, all)).toHaveProperty(field, null);
  });

  it.each(CASES)('SCRUM493_AC1_%s_%s_visible_text_keeps_its_invisibles_trimmed_only_by_js_trim', (_mode, field, run) => {
    for (const [label, ch] of INVISIBLES) {
      const value = `  ${ch}Exit${ch} A${ch}  `;
      expect(run(field, value), label).toHaveProperty(field, value.trim());
    }
    // trim() strips U+FEFF (it is whitespace to ECMAScript) but not U+200B.
    expect(run(field, '﻿Exit A﻿')).toHaveProperty(field, 'Exit A');
    expect(run(field, '​Exit A​')).toHaveProperty(field, '​Exit A​');
    expect(run(field, ' ⠀\n.\n')).toHaveProperty(field, '⠀\n.');
  });

  it.each(CASES)('SCRUM493_AC1_%s_%s_U+0000_anywhere_is_refused', (_mode, field, run) => {
    for (const value of ['\u0000', 'a\u0000b', '\u0000Exit A', 'Exit A\u0000', '  \u0000  ', '​\u0000', '\u0000\u0000']) {
      const err = errorFrom(() => run(field, value));
      expect(err, JSON.stringify(value)).toBeInstanceOf(ValidationError);
      expect(err.details).toEqual([{ field, message: UNSUPPORTED }]);
    }
  });

  it.each(CASES)('SCRUM493_AC1_%s_%s_an_unpaired_surrogate_is_refused', (_mode, field, run) => {
    const values = [
      ['lone high', '\uD800'],
      ['lone low', '\uDC00'],
      ['high inside', 'Exit\uD83DA'],
      ['low inside', 'Exit\uDEAAA'],
      ['high at start', '\uDBFFExit A'],
      ['high at end', 'Exit A\uD83D'],
      ['low at start', '\uDFFFExit A'],
      ['low at end', 'Exit A\uDC00'],
      ['reversed pair', 'Exit \uDEAA\uD83D'],
      ['high beside an invisible', '​\uD800'],
    ];
    for (const [label, value] of values) {
      const err = errorFrom(() => run(field, value));
      expect(err, label).toBeInstanceOf(ValidationError);
      expect(err.details, label).toEqual([{ field, message: UNSUPPORTED }]);
    }
  });

  it.each(CASES)('SCRUM493_AC1_%s_%s_a_valid_emoji_surrogate_pair_is_accepted', (_mode, field, run) => {
    const door = '🚪'; // U+1F6AA DOOR
    expect(door).toBe('\u{1F6AA}');
    expect(run(field, `${door} Exit A ${door}`)).toHaveProperty(field, `${door} Exit A ${door}`);
    expect(run(field, door)).toHaveProperty(field, door);
    expect(run(field, '\u{10FFFF}\u{10000}')).toHaveProperty(field, '\u{10FFFF}\u{10000}');
  });

  it.each(CASES)('SCRUM493_AC1_%s_%s_unsupported_beats_the_length_check', (_mode, field, run) => {
    // One problem per field: the character, not the length.
    const err = errorFrom(() => run(field, `${'x'.repeat(2001)}\u0000`));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field, message: UNSUPPORTED }]);
  });

  it('SCRUM493_AC1_create_reports_unsupported_characters_alongside_other_errors', () => {
    const err = errorFrom(() =>
      validateCreateVenue({
        ...VALID,
        name: '',
        emergencyAccess: 'a\u0000b',
        knownRestrictions: 'Exit\uD800',
      }),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err)).toEqual(expect.arrayContaining(['name', 'emergencyAccess', 'knownRestrictions']));
    expect(err.details).toEqual(
      expect.arrayContaining([
        { field: 'emergencyAccess', message: UNSUPPORTED },
        { field: 'knownRestrictions', message: UNSUPPORTED },
      ]),
    );
  });

  it('SCRUM493_AC1_update_reports_unsupported_characters_alongside_other_errors', () => {
    const err = errorFrom(() =>
      validateUpdateVenue({
        maxCapacity: -1,
        emergencyAccess: 'x'.repeat(2001),
        knownRestrictions: '\uDC00',
      }),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err)).toEqual(expect.arrayContaining(['maxCapacity', 'emergencyAccess', 'knownRestrictions']));
    expect(err.details).toEqual(
      expect.arrayContaining([
        { field: 'emergencyAccess', message: 'must be 2000 characters or fewer' },
        { field: 'knownRestrictions', message: UNSUPPORTED },
      ]),
    );
  });
});
