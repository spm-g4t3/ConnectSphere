/**
 * Tests for the suitability record a booking request carries to Venue Staff.
 *
 * SCRUM-188 AC7: "The suitability result, including any criterion the
 * coordinator chose to override, is attached to the booking request so that
 * Venue Staff can see it."
 *
 * Pure functions, so no mocks: the inputs are bookings rows as
 * create_booking_request stores them (040), and the older or malformed rows
 * the column may still hold.
 */

import { describe, it, expect } from 'vitest';

import { overriddenCriteria, toSuitabilityRecord } from '../../src/domain/suitabilityRecord.js';


const CHECKED = {
  startsAt: '2026-11-20T01:00:00+00:00',
  endsAt: '2026-11-20T09:00:00+00:00',
  expectedAttendance: 150,
  layout: 'theatre',
  accessibility: [],
  facilities: ['projector'],
};

/** A result the check gave for an unsuitable venue, as stored. */
const UNSUITABLE = {
  suitable: false,
  criteria: [
    { criterion: 'Capacity', met: false, detail: 'Capacity 80 < expected attendance 150' },
    { criterion: 'Operating hours', met: true, detail: 'Event runs 09:00–17:00 on Friday; venue open 08:00–22:00' },
    { criterion: 'Layout', met: false, detail: 'Layout theatre not offered (offers: classroom)' },
    { criterion: 'Accessibility', met: true, detail: 'None requested' },
    { criterion: 'Facilities', met: true, detail: 'All 1 requested provided' },
    { criterion: 'Availability', met: true, detail: 'Available', conflicts: [] },
  ],
  checked: CHECKED,
};

const SUITABLE = {
  ...UNSUITABLE,
  suitable: true,
  criteria: UNSUITABLE.criteria.map((c) => ({ ...c, met: true })),
};


describe('SCRUM188_AC7 overriddenCriteria names what the coordinator overrode', () => {
  it('SCRUM188_AC7_lists_the_unmet_criteria_of_an_overridden_request_in_order', () => {
    expect(overriddenCriteria(UNSUITABLE, true)).toEqual(['Capacity', 'Layout']);
  });

  it('SCRUM188_AC7_names_nothing_when_the_request_was_not_overridden', () => {
    // Unmet criteria on a row nobody overrode were not overridden by anyone.
    expect(overriddenCriteria(UNSUITABLE, false)).toEqual([]);
    expect(overriddenCriteria(UNSUITABLE, null)).toEqual([]);
    expect(overriddenCriteria(UNSUITABLE, 'true')).toEqual([]);
  });

  it('SCRUM188_AC7_names_nothing_for_an_overridden_but_suitable_result', () => {
    expect(overriddenCriteria(SUITABLE, true)).toEqual([]);
  });

  it.each([
    ['a null result', null],
    ['no criteria', { suitable: false }],
    ['criteria not an array', { suitable: false, criteria: 'Capacity' }],
    ['a string', 'unsuitable'],
  ])('SCRUM188_AC7_names_nothing_for_%s', (_label, result) => {
    expect(overriddenCriteria(result, true)).toEqual([]);
  });

  it('SCRUM188_AC7_skips_entries_with_no_verdict_or_no_object', () => {
    const result = {
      suitable: false,
      criteria: [null, 'Capacity', { criterion: 'Layout' }, { criterion: 'Capacity', met: false }],
    };
    expect(overriddenCriteria(result, true)).toEqual(['Capacity']);
  });
});


describe('SCRUM188_AC7 toSuitabilityRecord reads a bookings row for Venue Staff', () => {
  it('SCRUM188_AC7_an_overridden_request_carries_its_result_and_overridden_criteria', () => {
    expect(toSuitabilityRecord({ suitability_result: UNSUITABLE, suitability_overridden: true })).toEqual({
      suitability: { suitable: false, criteria: UNSUITABLE.criteria, checked: CHECKED },
      suitabilityOverridden: true,
      overriddenCriteria: ['Capacity', 'Layout'],
    });
  });

  it('SCRUM188_AC7_a_suitable_request_carries_its_result_and_no_override', () => {
    expect(toSuitabilityRecord({ suitability_result: SUITABLE, suitability_overridden: false })).toEqual({
      suitability: { suitable: true, criteria: SUITABLE.criteria, checked: CHECKED },
      suitabilityOverridden: false,
      overriddenCriteria: [],
    });
  });

  it('SCRUM188_AC7_a_result_stored_before_checked_was_recorded_has_checked_null', () => {
    const { checked: _omit, ...older } = UNSUITABLE;
    const record = toSuitabilityRecord({ suitability_result: older, suitability_overridden: true });

    expect(record.suitability).toEqual({ suitable: false, criteria: UNSUITABLE.criteria, checked: null });
    expect(record.overriddenCriteria).toEqual(['Capacity', 'Layout']);
  });

  it.each([
    ['a scalar', 'yes'],
    ['an array', [1, 2]],
  ])('SCRUM188_AC7_a_checked_that_is_%s_reads_as_null', (_label, checked) => {
    const record = toSuitabilityRecord({ suitability_result: { ...SUITABLE, checked } });
    expect(record.suitability.checked).toBeNull();
  });

  it.each([
    ['no result (before 030)', { suitability_result: null, suitability_overridden: false }],
    ['missing columns', {}],
    ['suitable not a boolean', { suitability_result: { suitable: 'false', criteria: [] } }],
    ['criteria not an array', { suitability_result: { suitable: true, criteria: {} } }],
    ['a non-object result', { suitability_result: 'suitable' }],
  ])('SCRUM188_AC7_an_older_or_malformed_row_has_suitability_null (%s)', (_label, row) => {
    expect(toSuitabilityRecord(row)).toEqual({
      suitability: null,
      suitabilityOverridden: false,
      overriddenCriteria: [],
    });
  });

  it('SCRUM188_AC7_an_overridden_row_with_an_unreadable_result_names_no_criteria', () => {
    // Still reported as overridden; there is just nothing readable to name.
    expect(toSuitabilityRecord({ suitability_result: null, suitability_overridden: true })).toEqual({
      suitability: null,
      suitabilityOverridden: true,
      overriddenCriteria: [],
    });
  });

  it('SCRUM188_AC7_tolerates_a_missing_row', () => {
    expect(toSuitabilityRecord(undefined)).toEqual({
      suitability: null,
      suitabilityOverridden: false,
      overriddenCriteria: [],
    });
  });

  it('SCRUM188_AC7_suitabilityOverridden_is_true_only_for_true', () => {
    expect(toSuitabilityRecord({ suitability_result: SUITABLE, suitability_overridden: 'true' })
      .suitabilityOverridden).toBe(false);
  });
});
