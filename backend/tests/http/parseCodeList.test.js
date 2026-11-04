/**
 * Tests for parseCodeList, the ?accessibility= / ?facilities= splitter shared
 * by the venue search (SCRUM-20 AC1) and the suitability check.
 *
 * Splitting, blank pieces and repeated keys are proved end to end in
 * tests/routes/venues.test.js. These pin the pass-through: anything that is
 * not a string reaches the validator unchanged, so it is reported, not dropped.
 */

import { describe, it, expect } from 'vitest';

import { parseCodeList } from '../../src/http/parseCodeList.js';
import { validateEventSearchCriteria } from '../../src/validation/venueValidation.js';
import { ValidationError } from '../../src/errors.js';

describe('SCRUM20_AC1 parseCodeList leaves non-text for the validator', () => {
  it.each([
    ['an_object', { 0: 'ramp' }],
    ['a_number', 7],
    ['null', null],
  ])('SCRUM20_AC1_%s_is_returned_as_it_came', (_label, value) => {
    expect(parseCodeList(value)).toBe(value);
  });

  it('SCRUM20_AC1_a_non_text_array_entry_is_kept_in_place_among_the_split_codes', () => {
    const entry = { code: 'ramp' };
    const codes = parseCodeList(['lift,ramp', entry, 'hearing-loop']);

    expect(codes).toEqual(['lift', 'ramp', entry, 'hearing-loop']);
    expect(codes[2]).toBe(entry);
  });

  it('SCRUM20_AC1_a_kept_non_text_entry_is_then_refused_by_the_search_validator', () => {
    // The point of passing it through: the search is refused rather than run
    // with the criterion silently missing.
    const criteria = {
      startsAt: '2027-04-01T09:00:00+08:00',
      endsAt: '2027-04-01T11:00:00+08:00',
      expectedAttendance: 80,
      accessibility: parseCodeList(['lift', 5]),
    };

    expect(() => validateEventSearchCriteria(criteria)).toThrow(ValidationError);
  });
});
