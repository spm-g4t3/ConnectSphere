/**
 * Tests for validateCreateBookingRequest.
 *
 * SCRUM-252. The route tests cover the refusals end to end; these pin what the
 * validator hands on: ids lower-cased, text trimmed, blanks as null, and no
 * field the caller must not choose.
 */

import { describe, it, expect } from 'vitest';

import {
  validateCreateBookingRequest,
  validateBookingRequestId,
  SETUP_NOTES_MAX_LENGTH,
} from '../../src/validation/bookingRequestValidation.js';
import { ValidationError } from '../../src/errors.js';

const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const VENUE_ID = '33333333-3333-4333-8333-333333333333';
const BASE = { eventRequestId: EVENT_ID, venueId: VENUE_ID };

describe('validateCreateBookingRequest', () => {
  it('SCRUM252_returns_only_the_coordinators_choices_with_defaults', () => {
    expect(validateCreateBookingRequest({ ...BASE, status: 'approved', startsAt: 'x' })).toEqual({
      eventRequestId: EVENT_ID,
      venueId: VENUE_ID,
      roomLayoutCode: null,
      setupNotes: null,
      confirmUnsuitable: false,
      accessibility: [],
      facilities: [],
      acknowledgedCriteria: [],
      expectedAttendance: null,
    });
  });

  it('SCRUM252_normalises_ids_text_and_layout', () => {
    const result = validateCreateBookingRequest({
      eventRequestId: ` ${EVENT_ID.toUpperCase()} `,
      venueId: VENUE_ID.toUpperCase(),
      roomLayoutCode: ' u_shape ',
      setupNotes: '  Extra tables  ',
      confirmUnsuitable: true,
    });
    expect(result).toEqual({
      eventRequestId: EVENT_ID,
      venueId: VENUE_ID,
      roomLayoutCode: 'u_shape',
      setupNotes: 'Extra tables',
      confirmUnsuitable: true,
      accessibility: [],
      facilities: [],
      acknowledgedCriteria: [],
      expectedAttendance: null,
    });
  });

  it('SCRUM252_blank_optional_text_becomes_null', () => {
    const result = validateCreateBookingRequest({ ...BASE, roomLayoutCode: '  ', setupNotes: '\n', confirmUnsuitable: null });
    expect(result).toMatchObject({ roomLayoutCode: null, setupNotes: null, confirmUnsuitable: false });
  });

  it('SCRUM252_counts_setup_notes_in_code_points_like_postgres', () => {
    const atLimit = '\u{1F600}'.repeat(SETUP_NOTES_MAX_LENGTH);
    expect(validateCreateBookingRequest({ ...BASE, setupNotes: atLimit }).setupNotes).toBe(atLimit);
    expect(() => validateCreateBookingRequest({ ...BASE, setupNotes: `${atLimit}x` })).toThrow(ValidationError);
  });

  it.each([null, undefined, 'text', 7, []])('SCRUM252_refuses_%j_as_a_body', (input) => {
    expect(() => validateCreateBookingRequest(input)).toThrow(ValidationError);
  });

  it('SCRUM252_refuses_a_layout_that_is_not_text', () => {
    expect(() => validateCreateBookingRequest({ ...BASE, roomLayoutCode: 5 })).toThrow(ValidationError);
  });
});


describe('SCRUM188_AC1 validateCreateBookingRequest carries the requirement codes (SCRUM-190)', () => {
  it('SCRUM188_AC1_trims_each_code_and_keeps_the_order_given', () => {
    const result = validateCreateBookingRequest({
      ...BASE,
      accessibility: [' wheelchair_access ', 'hearing_loop'],
      facilities: ['projector'],
    });
    expect(result.accessibility).toEqual(['wheelchair_access', 'hearing_loop']);
    expect(result.facilities).toEqual(['projector']);
  });

  it.each([undefined, null])('SCRUM188_AC1_%j_lists_are_empty_not_missing', (value) => {
    const result = validateCreateBookingRequest({ ...BASE, accessibility: value, facilities: value });
    expect(result).toMatchObject({ accessibility: [], facilities: [] });
  });

  it('SCRUM188_AC1_a_list_that_is_not_an_array_is_refused_by_the_search_rule', () => {
    const err = (() => {
      try {
        validateCreateBookingRequest({ ...BASE, accessibility: 'wheelchair_access' });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'accessibility', message: 'must be an array of codes' }]);
  });

  it('SCRUM188_AC1_every_bad_entry_is_reported_with_the_other_faults', () => {
    let err;
    try {
      validateCreateBookingRequest({ ...BASE, venueId: 'nope', facilities: ['projector', '  ', 7] });
    } catch (e) {
      err = e;
    }
    expect(err.details).toEqual([
      { field: 'venueId', message: 'must be a valid venue id' },
      { field: 'facilities', message: 'entry 1 must be a non-empty code' },
      { field: 'facilities', message: 'entry 2 must be a non-empty code' },
    ]);
  });
});


describe('SCRUM188_AC7 validateCreateBookingRequest reads acknowledgedCriteria (SCRUM-193/194)', () => {
  const faultsOf = (input) => {
    try {
      validateCreateBookingRequest(input);
    } catch (e) {
      return e;
    }
    return null;
  };

  it.each([undefined, null])('SCRUM188_AC7_acknowledged_criteria_%j_is_none', (value) => {
    expect(validateCreateBookingRequest({ ...BASE, acknowledgedCriteria: value }).acknowledgedCriteria).toEqual([]);
  });

  it('SCRUM188_AC7_acknowledged_criteria_are_kept_by_label_trimmed_and_once_each', () => {
    const result = validateCreateBookingRequest({
      ...BASE,
      confirmUnsuitable: true,
      acknowledgedCriteria: ['Capacity', ' Operating hours ', 'Capacity', 'Availability'],
    });
    expect(result.acknowledgedCriteria).toEqual(['Capacity', 'Operating hours', 'Availability']);
  });

  it('SCRUM188_AC7_all_six_criteria_can_be_acknowledged', () => {
    const all = ['Capacity', 'Operating hours', 'Layout', 'Accessibility', 'Facilities', 'Availability'];
    expect(validateCreateBookingRequest({ ...BASE, acknowledgedCriteria: all }).acknowledgedCriteria).toEqual(all);
  });

  it('SCRUM188_AC7_an_unknown_criterion_is_400_naming_it', () => {
    const err = faultsOf({ ...BASE, acknowledgedCriteria: ['Capacity', 'capacity', 'Parking'] });
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toHaveLength(2);
    expect(err.details.map((d) => d.field)).toEqual(['acknowledgedCriteria', 'acknowledgedCriteria']);
    expect(err.details[0].message).toMatch(/^entry 1 is not a criterion: "capacity"/);
    expect(err.details[1].message).toMatch(/^entry 2 is not a criterion: "Parking"/);
  });

  it.each([
    ['a string', 'Capacity', 'must be a list of criterion names'],
    ['an object', { Capacity: true }, 'must be a list of criterion names'],
    ['seven entries', ['Capacity', 'Capacity', 'Capacity', 'Capacity', 'Capacity', 'Capacity', 'Capacity'],
      'must name at most 6 criteria'],
  ])('SCRUM188_AC7_acknowledged_criteria_as_%s_is_refused', (_label, value, message) => {
    const err = faultsOf({ ...BASE, acknowledgedCriteria: value });
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'acknowledgedCriteria', message }]);
  });

  it('SCRUM188_AC7_blank_or_non_text_entries_are_refused_with_the_other_faults', () => {
    const err = faultsOf({ ...BASE, venueId: 'nope', acknowledgedCriteria: ['  ', 7] });
    expect(err.details).toEqual([
      { field: 'venueId', message: 'must be a valid venue id' },
      { field: 'acknowledgedCriteria', message: 'entry 0 must be a non-empty criterion name' },
      { field: 'acknowledgedCriteria', message: 'entry 1 must be a non-empty criterion name' },
    ]);
  });
});


describe('SCRUM525_AC2 validateCreateBookingRequest reads expectedAttendance', () => {
  // B-AC2-04 (R4): optional, a whole number above zero, never coerced. Each
  // value is one way the rule could be loosened: no bound (0, -1), a fraction
  // let through (1.5), a numeric string or a boolean coerced ("12", true).
  it.each([0, -1, 1.5, '12', true])('SCRUM525_AC2_expected_attendance_%j_is_refused', (value) => {
    const err = (() => {
      try {
        validateCreateBookingRequest({ ...BASE, expectedAttendance: value });
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details.map((d) => d.field)).toEqual(['expectedAttendance']);
  });

  it('SCRUM525_AC2_expected_attendance_is_optional_and_1_is_accepted', () => {
    // Absent or null is "the event's", left as null for the service to fill;
    // 1, the boundary beside the refused 0, is kept as given.
    expect(validateCreateBookingRequest(BASE).expectedAttendance).toBeNull();
    expect(validateCreateBookingRequest({ ...BASE, expectedAttendance: null }).expectedAttendance).toBeNull();
    expect(validateCreateBookingRequest({ ...BASE, expectedAttendance: 1 }).expectedAttendance).toBe(1);
  });
});


describe('validateBookingRequestId (SCRUM-253)', () => {
  it('SCRUM253_trims_and_lower_cases_an_id', () => {
    expect(validateBookingRequestId(` ${EVENT_ID.toUpperCase()} `)).toBe(EVENT_ID);
  });

  it.each([undefined, null, '', 'nope', 7, {}])('SCRUM253_refuses_%j', (id) => {
    expect(() => validateBookingRequestId(id)).toThrow(ValidationError);
  });
});
