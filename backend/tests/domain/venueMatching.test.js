/**
 * Tests for the venue matching rule.
 *
 * SCRUM-138, a subtask of SCRUM-20 (Search Venues Against Event Requirements).
 *
 * AC3: a venue is returned only if it meets every supplied criterion --
 *      capacity >= attendance, operating hours cover the whole period, the
 *      layout is supported, every requested accessibility feature and facility
 *      is provided.
 * AC4: a venue that meets only some criteria is not returned.
 *
 * Fixtures follow SCRUM-20-test-cases.md: "Harbour Room" and the base request
 * on Wednesday 2026-11-11 (Singapore). Cases B-AC3-01..19 and B-AC4-01..05 are
 * proved here against the pure rule; venueService.test.js proves the search
 * applies it.
 *
 * Timezone independence: every instant carries an explicit offset and every
 * expectation is a Singapore wall-clock value, so these pass whatever TZ the
 * process runs under (checked under UTC, Asia/Singapore and America/New_York).
 *
 * SCRUM-189, a subtask of SCRUM-188 (Check Venue Suitability for an Event):
 * the SCRUM188_AC2 blocks prove evaluateCriteria gives one verdict per
 * criterion, with the values compared, and never disagrees with
 * matchesAllCriteria on the fixtures above.
 */

import { describe, it, expect } from 'vitest';

import {
  VENUE_TIME_ZONE,
  toVenueLocal,
  meetsCapacity,
  coversPeriod,
  supportsLayout,
  providesAll,
  matchesLocation,
  matchesAllCriteria,
  hoursVerdict,
  SUITABILITY_CRITERIA,
  evaluateCriteria,
} from '../../src/domain/venueMatching.js';

/** Wednesday (day 3) hours 09:00-18:00, as PostgREST returns `time` columns. */
const WEDNESDAY_9_TO_6 = Object.freeze([
  Object.freeze({ day_of_week: 3, opens_at: '09:00:00', closes_at: '18:00:00' }),
]);

/** A Singapore-local instant on Wednesday 2026-11-11. */
const sgt = (hhmm, date = '2026-11-11') => `${date}T${hhmm}:00+08:00`;

/** The common "Harbour Room" fixture, as toVenueWithAttributes shapes it. */
function harbourRoom(overrides = {}) {
  return {
    id: 'harbour',
    name: 'Harbour Room',
    location: 'Level 1',
    maxCapacity: 100,
    layouts: ['classroom', 'theatre'],
    accessibility: ['lift_access', 'step_free_entrance'],
    facilities: ['pa_system', 'projector', 'wifi'],
    hours: [...WEDNESDAY_9_TO_6],
    setupMinutes: 0,
    turnaroundMinutes: 0,
    ...overrides,
  };
}

/** The base request, as validateEventSearchCriteria returns it. */
function baseRequest(overrides = {}) {
  return {
    startsAt: sgt('10:00'),
    endsAt: sgt('12:00'),
    expectedAttendance: 80,
    layout: 'theatre',
    accessibility: ['step_free_entrance'],
    facilities: ['projector', 'wifi'],
    ...overrides,
  };
}


describe('SCRUM20 venue clock', () => {
  it('SCRUM20_AC3_venue_time_zone_is_singapore', () => {
    expect(VENUE_TIME_ZONE).toBe('Asia/Singapore');
  });

  it('SCRUM20_AC3_offset_and_utc_forms_of_one_instant_read_the_same', () => {
    // B-AC3-08: 10:00+08:00 and 02:00Z are the same instant.
    const fromOffset = toVenueLocal('2026-11-11T10:00:00+08:00');
    const fromUtc = toVenueLocal('2026-11-11T02:00:00Z');

    expect(fromOffset).toEqual({ date: '2026-11-11', dayOfWeek: 3, minutes: 600 });
    expect(fromUtc).toEqual(fromOffset);
  });

  it('SCRUM20_AC3_utc_late_evening_is_the_next_singapore_day', () => {
    // 16:30Z Wednesday is 00:30 Thursday in Singapore.
    expect(toVenueLocal('2026-11-11T16:30:00Z')).toEqual({
      date: '2026-11-12',
      dayOfWeek: 4,
      minutes: 30,
    });
  });

  it('SCRUM20_AC3_local_midnight_is_minute_zero_not_1440', () => {
    // hourCycle h23: midnight must not come back as hour "24".
    expect(toVenueLocal('2026-11-11T00:00:00+08:00')).toEqual({
      date: '2026-11-11',
      dayOfWeek: 3,
      minutes: 0,
    });
  });

  it('SCRUM20_AC3_sunday_is_day_zero', () => {
    expect(toVenueLocal(sgt('10:00', '2026-11-15')).dayOfWeek).toBe(0);
  });

  it('SCRUM20_AC3_other_offsets_are_converted_to_singapore', () => {
    // 21:00 Tuesday in New York (-05:00) is 10:00 Wednesday in Singapore.
    expect(toVenueLocal('2026-11-10T21:00:00-05:00')).toEqual({
      date: '2026-11-11',
      dayOfWeek: 3,
      minutes: 600,
    });
  });

  it('SCRUM20_AC3_seconds_are_kept_as_a_fraction_of_a_minute', () => {
    expect(toVenueLocal('2026-11-11T10:00:30+08:00').minutes).toBe(600.5);
  });

  it('SCRUM20_AC3_a_date_object_is_accepted', () => {
    expect(toVenueLocal(new Date('2026-11-11T02:00:00Z'))).toEqual({
      date: '2026-11-11',
      dayOfWeek: 3,
      minutes: 600,
    });
  });
});


describe('SCRUM20_AC3 capacity', () => {
  it('SCRUM20_AC3_capacity_equal_to_attendance_is_returned', () => {
    expect(meetsCapacity(harbourRoom(), 100)).toBe(true);
  });

  it('SCRUM20_AC3_capacity_above_attendance_is_returned', () => {
    expect(meetsCapacity(harbourRoom(), 80)).toBe(true);
  });

  it('SCRUM20_AC3_capacity_one_below_attendance_is_excluded', () => {
    expect(meetsCapacity(harbourRoom(), 101)).toBe(false);
    expect(meetsCapacity(harbourRoom({ maxCapacity: 79 }), 80)).toBe(false);
  });
});


describe('SCRUM20_AC3 operating hours cover the whole period', () => {
  it('SCRUM20_AC3_period_equal_to_opening_hours_is_returned', () => {
    expect(coversPeriod(WEDNESDAY_9_TO_6, sgt('09:00'), sgt('18:00'))).toBe(true);
  });

  it('SCRUM20_AC3_period_inside_opening_hours_is_returned', () => {
    expect(coversPeriod(WEDNESDAY_9_TO_6, sgt('10:00'), sgt('12:00'))).toBe(true);
  });

  it('SCRUM20_AC3_start_one_minute_before_opening_is_excluded', () => {
    expect(coversPeriod(WEDNESDAY_9_TO_6, sgt('08:59'), sgt('12:00'))).toBe(false);
  });

  it('SCRUM20_AC3_end_one_minute_after_closing_is_excluded', () => {
    expect(coversPeriod(WEDNESDAY_9_TO_6, sgt('10:00'), sgt('18:01'))).toBe(false);
  });

  it('SCRUM20_AC3_weekday_with_no_hours_row_is_closed', () => {
    // Sunday 2026-11-15: there is no day-0 row.
    expect(coversPeriod(WEDNESDAY_9_TO_6, sgt('10:00', '2026-11-15'), sgt('12:00', '2026-11-15')))
      .toBe(false);
  });

  it('SCRUM20_AC3_no_hours_at_all_is_closed_every_day', () => {
    expect(coversPeriod([], sgt('10:00'), sgt('12:00'))).toBe(false);
  });

  it('SCRUM20_AC3_utc_timestamp_is_read_as_singapore_time', () => {
    // B-AC3-08: 02:00Z-04:00Z is 10:00-12:00 in Singapore.
    expect(coversPeriod(WEDNESDAY_9_TO_6, '2026-11-11T02:00:00Z', '2026-11-11T04:00:00Z'))
      .toBe(true);
  });

  it('SCRUM20_AC3_utc_timestamp_before_singapore_opening_is_excluded', () => {
    // B-AC3-09: 00:30Z is 08:30 in Singapore, before 09:00.
    expect(coversPeriod(WEDNESDAY_9_TO_6, '2026-11-11T00:30:00Z', '2026-11-11T02:00:00Z'))
      .toBe(false);
  });

  it('SCRUM20_AC3_weekday_is_taken_from_the_singapore_date', () => {
    // B-AC3-10: Tuesday 23:30Z is Wednesday 07:30 in Singapore.
    const wednesdayEarly = [{ day_of_week: 3, opens_at: '07:00:00', closes_at: '18:00:00' }];
    expect(coversPeriod(wednesdayEarly, '2026-11-10T23:30:00Z', '2026-11-11T01:00:00Z'))
      .toBe(true);
    // And a Tuesday row alone would not open it.
    const tuesdayOnly = [{ day_of_week: 2, opens_at: '00:00:00', closes_at: '23:59:00' }];
    expect(coversPeriod(tuesdayOnly, '2026-11-10T23:30:00Z', '2026-11-11T01:00:00Z'))
      .toBe(false);
  });

  it('SCRUM20_AC3_period_crossing_singapore_midnight_is_excluded', () => {
    const allWeek = [3, 4].map((day) => ({ day_of_week: day, opens_at: '00:00:00', closes_at: '23:59:00' }));
    expect(coversPeriod(allWeek, sgt('23:00'), sgt('01:00', '2026-11-12'))).toBe(false);
  });

  it('SCRUM20_AC3_period_crossing_midnight_in_utc_but_not_singapore_is_kept', () => {
    // 15:00Z-15:59Z is 23:00-23:59 Wednesday in Singapore: one Singapore date,
    // even though under some server zones it would straddle a local midnight.
    const lateWednesday = [{ day_of_week: 3, opens_at: '22:00:00', closes_at: '23:59:00' }];
    expect(coversPeriod(lateWednesday, '2026-11-11T15:00:00Z', '2026-11-11T15:59:00Z')).toBe(true);
  });

  it('SCRUM20_AC3_hours_given_as_hh_mm_work_too', () => {
    const shortForm = [{ day_of_week: 3, opens_at: '09:00', closes_at: '18:00' }];
    expect(coversPeriod(shortForm, sgt('09:00'), sgt('18:00'))).toBe(true);
    expect(coversPeriod(shortForm, sgt('08:59'), sgt('12:00'))).toBe(false);
    expect(coversPeriod(shortForm, sgt('10:00'), sgt('18:01'))).toBe(false);
  });

  it('SCRUM20_AC3_seconds_in_opening_hours_are_honoured', () => {
    const halfMinuteLate = [{ day_of_week: 3, opens_at: '09:00:30', closes_at: '18:00:00' }];
    expect(coversPeriod(halfMinuteLate, sgt('09:00'), sgt('12:00'))).toBe(false);
    expect(coversPeriod(halfMinuteLate, '2026-11-11T09:00:30+08:00', sgt('12:00'))).toBe(true);
  });

  it('SCRUM20_AC3_seconds_in_the_request_are_honoured', () => {
    expect(coversPeriod(WEDNESDAY_9_TO_6, '2026-11-11T08:59:59+08:00', sgt('12:00'))).toBe(false);
    expect(coversPeriod(WEDNESDAY_9_TO_6, sgt('10:00'), '2026-11-11T18:00:01+08:00')).toBe(false);
  });

  it('SCRUM20_AC3_the_matching_weekday_row_is_used_among_several', () => {
    const week = [
      { day_of_week: 1, opens_at: '06:00:00', closes_at: '23:00:00' },
      { day_of_week: 3, opens_at: '11:00:00', closes_at: '18:00:00' },
    ];
    expect(coversPeriod(week, sgt('10:00'), sgt('12:00'))).toBe(false);
    expect(coversPeriod(week, sgt('11:00'), sgt('12:00'))).toBe(true);
  });
});


describe('SCRUM20_AC3 layout', () => {
  it('SCRUM20_AC3_supported_layout_is_returned', () => {
    expect(supportsLayout(harbourRoom(), 'theatre')).toBe(true);
  });

  it('SCRUM20_AC3_unsupported_layout_is_excluded', () => {
    expect(supportsLayout(harbourRoom(), 'banquet')).toBe(false);
  });

  it('SCRUM20_AC1_no_layout_requested_passes_every_venue', () => {
    expect(supportsLayout(harbourRoom(), undefined)).toBe(true);
    expect(supportsLayout(harbourRoom({ layouts: [] }), undefined)).toBe(true);
  });

  it('SCRUM20_AC3_venue_with_no_layouts_fails_a_layout_request', () => {
    expect(supportsLayout(harbourRoom({ layouts: [] }), 'theatre')).toBe(false);
  });
});


describe('SCRUM20_AC3 accessibility features and facilities', () => {
  const ACCESS = ['lift_access', 'step_free_entrance'];
  const FACILITIES = ['pa_system', 'projector', 'wifi'];

  it('SCRUM20_AC3_venue_with_exactly_the_requested_accessibility_is_returned', () => {
    expect(providesAll(ACCESS, ['step_free_entrance', 'lift_access'])).toBe(true);
  });

  it('SCRUM20_AC3_venue_with_more_accessibility_than_requested_is_returned', () => {
    expect(providesAll(ACCESS, ['step_free_entrance'])).toBe(true);
  });

  it('SCRUM20_AC3_one_missing_accessibility_feature_is_excluded', () => {
    expect(providesAll(ACCESS, ['step_free_entrance', 'hearing_loop'])).toBe(false);
  });

  it('SCRUM20_AC3_venue_with_exactly_the_requested_facilities_is_returned', () => {
    expect(providesAll(FACILITIES, ['projector', 'wifi', 'pa_system'])).toBe(true);
  });

  it('SCRUM20_AC3_venue_with_more_facilities_than_requested_is_returned', () => {
    expect(providesAll(FACILITIES, ['projector', 'wifi'])).toBe(true);
  });

  it('SCRUM20_AC3_one_missing_facility_is_excluded', () => {
    expect(providesAll(FACILITIES, ['projector', 'catering'])).toBe(false);
  });

  it('SCRUM20_AC1_nothing_requested_passes_every_venue', () => {
    expect(providesAll(FACILITIES, undefined)).toBe(true);
    expect(providesAll([], undefined)).toBe(true);
    expect(providesAll([], [])).toBe(true);
  });

  it('SCRUM20_AC3_venue_with_nothing_fails_any_request', () => {
    expect(providesAll([], ['wifi'])).toBe(false);
  });
});


describe('SCRUM20_AC3 matchesAllCriteria', () => {
  it('SCRUM20_AC3_venue_meeting_every_criterion_is_returned', () => {
    expect(matchesAllCriteria(harbourRoom(), baseRequest())).toBe(true);
  });

  it('SCRUM20_AC3_result_is_a_strict_boolean', () => {
    // Never a truthy array or object that could carry a reason.
    expect(matchesAllCriteria(harbourRoom(), baseRequest())).toStrictEqual(true);
    expect(matchesAllCriteria(harbourRoom({ maxCapacity: 1 }), baseRequest())).toStrictEqual(false);
    expect(
      matchesAllCriteria(harbourRoom(), baseRequest({ layout: 'banquet' })),
    ).toStrictEqual(false);
  });

  it('SCRUM20_AC1_only_capacity_and_hours_apply_when_no_optionals_are_given', () => {
    const bare = harbourRoom({ layouts: [], accessibility: [], facilities: [] });
    const required = {
      startsAt: sgt('10:00'),
      endsAt: sgt('12:00'),
      expectedAttendance: 80,
    };

    expect(matchesAllCriteria(bare, required)).toBe(true);
    // ...and those two still apply.
    expect(matchesAllCriteria(bare, { ...required, expectedAttendance: 101 })).toBe(false);
    expect(matchesAllCriteria(bare, { ...required, startsAt: sgt('08:00') })).toBe(false);
  });

  it('SCRUM20_AC3_utc_request_matches_the_same_as_its_offset_form', () => {
    const utc = baseRequest({ startsAt: '2026-11-11T02:00:00Z', endsAt: '2026-11-11T04:00:00Z' });
    expect(matchesAllCriteria(harbourRoom(), utc)).toBe(true);
  });
});


// SCRUM-141: location, the optional criterion the Week 4 instructions list.
describe('SCRUM20_AC1 SCRUM141 location', () => {
  it('SCRUM20_AC1_no_location_requested_passes_every_venue', () => {
    expect(matchesLocation(harbourRoom(), undefined)).toBe(true);
    expect(matchesLocation(harbourRoom({ location: '' }), undefined)).toBe(true);
  });

  it.each([
    ['exact text', 'Level 1'],
    ['a lower-case fragment', 'level'],
    ['an upper-case fragment', 'LEVEL 1'],
    ['mixed case in the middle', 'eL 1'],
    ['a single character', '1'],
  ])('SCRUM20_AC3_location_containing_%s_matches_case_insensitively', (_label, text) => {
    expect(matchesLocation(harbourRoom(), text)).toBe(true);
  });

  it('SCRUM20_AC3_venue_text_in_upper_case_matches_a_lower_case_request', () => {
    expect(matchesLocation(harbourRoom({ location: 'ORCHARD ROAD' }), 'orchard')).toBe(true);
  });

  it.each([
    ['other text', 'Level 2'],
    ['text longer than the location', 'Level 1, SCIS'],
    ['words out of order', '1 Level'],
  ])('SCRUM20_AC3_location_not_containing_%s_is_excluded', (_label, text) => {
    expect(matchesLocation(harbourRoom(), text)).toBe(false);
  });

  it('SCRUM20_AC3_percent_is_a_literal_character_not_a_wildcard', () => {
    // ilike would read 'Lev%1' as "Lev, anything, 1"; this must not.
    expect(matchesLocation(harbourRoom(), 'Lev%1')).toBe(false);
    expect(matchesLocation(harbourRoom(), '%')).toBe(false);
    expect(matchesLocation(harbourRoom({ location: '100% Hall' }), '100%')).toBe(true);
  });

  it('SCRUM20_AC3_underscore_is_a_literal_character_not_a_wildcard', () => {
    // ilike would read 'Level_1' as "Level, any one character, 1"; this must not.
    expect(matchesLocation(harbourRoom(), 'Level_1')).toBe(false);
    expect(matchesLocation(harbourRoom(), '_')).toBe(false);
    expect(matchesLocation(harbourRoom({ location: 'Room_A, Level 1' }), 'room_a')).toBe(true);
  });

  it('SCRUM20_AC3_result_is_a_strict_boolean', () => {
    expect(matchesLocation(harbourRoom(), 'level')).toStrictEqual(true);
    expect(matchesLocation(harbourRoom(), 'basement')).toStrictEqual(false);
  });

  it('SCRUM20_AC3_matchesAllCriteria_applies_the_location', () => {
    expect(matchesAllCriteria(harbourRoom(), baseRequest({ location: 'level 1' }))).toBe(true);
    expect(matchesAllCriteria(harbourRoom(), baseRequest({ location: 'Level 2' }))).toBe(false);
  });

  it('SCRUM20_AC1_matchesAllCriteria_without_a_location_is_unchanged', () => {
    const request = baseRequest();
    expect(request).not.toHaveProperty('location');
    expect(matchesAllCriteria(harbourRoom({ location: 'Anywhere' }), request)).toBe(true);
  });

  it('SCRUM20_AC3_location_alone_with_the_required_fields_filters', () => {
    const bare = harbourRoom({ layouts: [], accessibility: [], facilities: [] });
    const required = { startsAt: sgt('10:00'), endsAt: sgt('12:00'), expectedAttendance: 80 };

    expect(matchesAllCriteria(bare, { ...required, location: 'LEVEL' })).toBe(true);
    expect(matchesAllCriteria(bare, { ...required, location: 'Tower' })).toBe(false);
  });
});


// B-AC4-01..05: Candidate is Control with exactly one thing changed.
// SCRUM-141: the request carries a location too, so the table can hold a
// venue that fails only that.
describe('SCRUM20_AC4 meeting only some criteria is not enough', () => {
  const AC4_REQUEST = () => baseRequest({ location: 'level 1' });

  it('SCRUM20_AC4_control_meets_the_base_request', () => {
    expect(matchesAllCriteria(harbourRoom(), baseRequest())).toBe(true);
    expect(matchesAllCriteria(harbourRoom(), AC4_REQUEST())).toBe(true);
  });

  it.each([
    ['SCRUM20_AC4_venue_failing_only_capacity_is_excluded', { maxCapacity: 79 }],
    [
      'SCRUM20_AC4_venue_failing_only_operating_hours_is_excluded',
      { hours: [{ day_of_week: 3, opens_at: '11:00:00', closes_at: '18:00:00' }] },
    ],
    ['SCRUM20_AC4_venue_failing_only_layout_is_excluded', { layouts: ['classroom'] }],
    ['SCRUM20_AC4_venue_failing_only_accessibility_is_excluded', { accessibility: ['lift_access'] }],
    ['SCRUM20_AC4_venue_failing_only_facilities_is_excluded', { facilities: ['pa_system', 'projector'] }],
    ['SCRUM20_AC4_venue_failing_only_location_is_excluded', { location: 'Level 2' }],
  ])('%s', (_name, change) => {
    expect(matchesAllCriteria(harbourRoom(change), AC4_REQUEST())).toBe(false);
  });
});


// SCRUM-189: the per-criterion verdicts the SCRUM-188 suitability check shows.
describe('SCRUM188_AC2 hoursVerdict', () => {
  it('SCRUM188_AC2_within_hours_carries_the_row_and_the_local_readings', () => {
    expect(hoursVerdict(WEDNESDAY_9_TO_6, sgt('10:00'), sgt('12:00'))).toEqual({
      met: true,
      reason: 'within_hours',
      dayOfWeek: 3,
      opensAt: '09:00:00',
      closesAt: '18:00:00',
      start: { date: '2026-11-11', dayOfWeek: 3, minutes: 600 },
      end: { date: '2026-11-11', dayOfWeek: 3, minutes: 720 },
    });
  });

  it('SCRUM188_AC2_each_reason_is_named', () => {
    expect(hoursVerdict(WEDNESDAY_9_TO_6, sgt('08:00'), sgt('12:00')).reason).toBe('outside_hours');
    expect(hoursVerdict(WEDNESDAY_9_TO_6, sgt('10:00', '2026-11-15'), sgt('12:00', '2026-11-15')))
      .toMatchObject({ met: false, reason: 'closed_that_day', dayOfWeek: 0 });
    expect(hoursVerdict(WEDNESDAY_9_TO_6, sgt('23:00'), sgt('01:00', '2026-11-12')))
      .toMatchObject({ met: false, reason: 'spans_midnight' });
  });

  it('SCRUM188_AC2_no_row_means_no_opening_times_are_reported', () => {
    const verdict = hoursVerdict([], sgt('10:00'), sgt('12:00'));
    expect(verdict).not.toHaveProperty('opensAt');
    expect(verdict).not.toHaveProperty('closesAt');
  });
});


describe('SCRUM188_AC2 evaluateCriteria shape', () => {
  it('SCRUM188_AC2_labels_are_the_five_display_labels_in_order', () => {
    expect(SUITABILITY_CRITERIA).toEqual([
      'Capacity',
      'Operating hours',
      'Layout',
      'Accessibility',
      'Facilities',
    ]);
    expect(Object.isFrozen(SUITABILITY_CRITERIA)).toBe(true);
  });

  it('SCRUM188_AC2_one_entry_per_criterion_in_suitability_order', () => {
    const verdicts = evaluateCriteria(harbourRoom(), baseRequest());
    expect(verdicts.map((v) => v.criterion)).toEqual([...SUITABILITY_CRITERIA]);
    verdicts.forEach((v) => {
      expect(Object.keys(v).slice(0, 3)).toEqual(['criterion', 'met', 'detail']);
      expect(typeof v.met).toBe('boolean');
      expect(typeof v.detail).toBe('string');
    });
    // SCRUM-193/194 (F4): the structured codes beside the words.
    expect(verdicts.map((v) => Object.keys(v).sort())).toEqual([
      ['criterion', 'detail', 'met'],
      ['criterion', 'detail', 'met'],
      ['criterion', 'detail', 'layout', 'met', 'offers'],
      ['criterion', 'detail', 'met', 'missing', 'requested'],
      ['criterion', 'detail', 'met', 'missing', 'requested'],
    ]);
  });

  it('SCRUM188_AC2_location_is_not_a_suitability_criterion', () => {
    const verdicts = evaluateCriteria(harbourRoom(), baseRequest({ location: 'Level 2' }));
    expect(verdicts).toHaveLength(5);
    expect(verdicts.every((v) => v.met)).toBe(true);
  });

  it('SCRUM188_AC2_base_request_reads_all_met', () => {
    expect(evaluateCriteria(harbourRoom(), baseRequest())).toEqual([
      { criterion: 'Capacity', met: true, detail: 'Capacity 100 ≥ expected attendance 80' },
      {
        criterion: 'Operating hours',
        met: true,
        detail: 'Event runs 10:00–12:00 on Wednesday; venue open 09:00–18:00',
      },
      {
        criterion: 'Layout',
        met: true,
        detail: 'Layout theatre offered',
        layout: 'theatre',
        offers: ['classroom', 'theatre'],
      },
      {
        criterion: 'Accessibility',
        met: true,
        detail: 'All 1 requested provided',
        missing: [],
        requested: ['step_free_entrance'],
      },
      {
        criterion: 'Facilities',
        met: true,
        detail: 'All 2 requested provided',
        missing: [],
        requested: ['projector', 'wifi'],
      },
    ]);
  });
});


/** The one verdict for a label, from a full evaluateCriteria run. */
const verdictFor = (label, venue, criteria) =>
  evaluateCriteria(venue, criteria).find((v) => v.criterion === label);


describe('SCRUM188_AC2 capacity verdict', () => {
  it('SCRUM188_AC2_capacity_below_attendance_is_not_met', () => {
    expect(
      verdictFor('Capacity', harbourRoom({ maxCapacity: 80 }), baseRequest({ expectedAttendance: 150 })),
    ).toEqual({ criterion: 'Capacity', met: false, detail: 'Capacity 80 < expected attendance 150' });
  });

  it('SCRUM188_AC2_capacity_equal_to_attendance_is_met', () => {
    expect(
      verdictFor('Capacity', harbourRoom({ maxCapacity: 150 }), baseRequest({ expectedAttendance: 150 })),
    ).toEqual({ criterion: 'Capacity', met: true, detail: 'Capacity 150 ≥ expected attendance 150' });
  });
});


describe('SCRUM188_AC2 operating hours verdict', () => {
  const hoursOf = (venue, criteria) => verdictFor('Operating hours', venue, criteria);

  it('SCRUM188_AC2_start_before_opening_is_not_met', () => {
    expect(hoursOf(harbourRoom(), baseRequest({ startsAt: sgt('08:00') }))).toEqual({
      criterion: 'Operating hours',
      met: false,
      detail: 'Event runs 08:00–12:00 on Wednesday; venue open 09:00–18:00',
    });
  });

  it('SCRUM188_AC2_ending_exactly_at_closing_is_met', () => {
    expect(hoursOf(harbourRoom(), baseRequest({ endsAt: sgt('18:00') }))).toEqual({
      criterion: 'Operating hours',
      met: true,
      detail: 'Event runs 10:00–18:00 on Wednesday; venue open 09:00–18:00',
    });
  });

  it('SCRUM188_AC2_one_minute_past_closing_is_not_met', () => {
    expect(hoursOf(harbourRoom(), baseRequest({ endsAt: sgt('18:01') }))).toEqual({
      criterion: 'Operating hours',
      met: false,
      detail: 'Event runs 10:00–18:01 on Wednesday; venue open 09:00–18:00',
    });
  });

  it('SCRUM188_AC2_weekday_with_no_hours_row_reads_closed', () => {
    const sunday = baseRequest({ startsAt: sgt('10:00', '2026-11-15'), endsAt: sgt('12:00', '2026-11-15') });
    expect(hoursOf(harbourRoom(), sunday)).toEqual({
      criterion: 'Operating hours',
      met: false,
      detail: 'Venue closed on Sunday',
    });
  });

  it('SCRUM188_AC2_midnight_span_names_both_days', () => {
    // Friday 2026-11-13 22:00 to Saturday 01:00, Singapore.
    const overnight = baseRequest({
      startsAt: sgt('22:00', '2026-11-13'),
      endsAt: sgt('01:00', '2026-11-14'),
    });
    expect(hoursOf(harbourRoom(), overnight)).toEqual({
      criterion: 'Operating hours',
      met: false,
      detail: 'Event spans midnight (Fri 22:00 – Sat 01:00)',
    });
  });

  it('SCRUM188_AC2_utc_and_offset_forms_of_one_period_read_the_same', () => {
    const offset = evaluateCriteria(harbourRoom(), baseRequest());
    const utc = evaluateCriteria(
      harbourRoom(),
      baseRequest({ startsAt: '2026-11-11T02:00:00Z', endsAt: '2026-11-11T04:00:00Z' }),
    );
    expect(utc).toEqual(offset);
  });

  it('SCRUM188_AC2_utc_instant_is_described_on_the_singapore_clock', () => {
    // B-AC3-09: 00:30Z is 08:30 Wednesday in Singapore.
    expect(
      hoursOf(harbourRoom(), baseRequest({ startsAt: '2026-11-11T00:30:00Z', endsAt: '2026-11-11T02:00:00Z' })),
    ).toEqual({
      criterion: 'Operating hours',
      met: false,
      detail: 'Event runs 08:30–10:00 on Wednesday; venue open 09:00–18:00',
    });
  });
});


describe('SCRUM188_AC2 layout verdict', () => {
  it('SCRUM188_AC2_offered_layout_is_met', () => {
    expect(verdictFor('Layout', harbourRoom(), baseRequest())).toEqual({
      criterion: 'Layout',
      met: true,
      detail: 'Layout theatre offered',
      layout: 'theatre',
      offers: ['classroom', 'theatre'],
    });
  });

  it('SCRUM188_AC2_layout_not_offered_lists_what_is', () => {
    expect(
      verdictFor('Layout', harbourRoom({ layouts: ['banquet', 'classroom'] }), baseRequest()),
    ).toEqual({
      criterion: 'Layout',
      met: false,
      detail: 'Layout theatre not offered (offers: banquet, classroom)',
      layout: 'theatre',
      offers: ['banquet', 'classroom'],
    });
  });

  it('SCRUM188_AC2_venue_with_no_layouts_says_none', () => {
    expect(verdictFor('Layout', harbourRoom({ layouts: [] }), baseRequest()).detail)
      .toBe('Layout theatre not offered (offers: none)');
  });
});


describe('SCRUM188_AC2 accessibility and facilities verdicts', () => {
  it('SCRUM188_AC2_missing_accessibility_is_listed_in_requested_order', () => {
    const criteria = baseRequest({
      accessibility: ['wheelchair_ramp', 'step_free_entrance', 'hearing_loop'],
    });
    expect(verdictFor('Accessibility', harbourRoom(), criteria)).toEqual({
      criterion: 'Accessibility',
      met: false,
      detail: 'Missing: wheelchair_ramp, hearing_loop',
      missing: ['wheelchair_ramp', 'hearing_loop'],
      requested: ['wheelchair_ramp', 'step_free_entrance', 'hearing_loop'],
    });
  });

  it('SCRUM188_AC2_all_accessibility_provided_is_met', () => {
    const criteria = baseRequest({ accessibility: ['lift_access', 'step_free_entrance'] });
    expect(verdictFor('Accessibility', harbourRoom(), criteria)).toEqual({
      criterion: 'Accessibility',
      met: true,
      detail: 'All 2 requested provided',
      missing: [],
      requested: ['lift_access', 'step_free_entrance'],
    });
  });

  it('SCRUM188_AC2_missing_facility_is_not_met', () => {
    const criteria = baseRequest({ facilities: ['projector', 'catering'] });
    expect(verdictFor('Facilities', harbourRoom(), criteria)).toEqual({
      criterion: 'Facilities',
      met: false,
      detail: 'Missing: catering',
      missing: ['catering'],
      requested: ['projector', 'catering'],
    });
  });

  it('SCRUM188_AC2_all_facilities_provided_is_met', () => {
    expect(verdictFor('Facilities', harbourRoom(), baseRequest())).toEqual({
      criterion: 'Facilities',
      met: true,
      detail: 'All 2 requested provided',
      missing: [],
      requested: ['projector', 'wifi'],
    });
  });
});


describe('SCRUM188_AC2 optional criteria not requested', () => {
  const required = { startsAt: sgt('10:00'), endsAt: sgt('12:00'), expectedAttendance: 80 };
  const bare = harbourRoom({ layouts: [], accessibility: [], facilities: [] });

  it('SCRUM188_AC2_absent_optionals_read_none_requested', () => {
    const verdicts = evaluateCriteria(bare, required);
    expect(verdicts.slice(2)).toEqual([
      { criterion: 'Layout', met: true, detail: 'None requested', layout: null, offers: [] },
      { criterion: 'Accessibility', met: true, detail: 'None requested', missing: [], requested: [] },
      { criterion: 'Facilities', met: true, detail: 'None requested', missing: [], requested: [] },
    ]);
  });

  it('SCRUM188_AC2_empty_lists_read_none_requested', () => {
    const verdicts = evaluateCriteria(bare, { ...required, accessibility: [], facilities: [] });
    expect(verdicts.slice(3)).toEqual([
      { criterion: 'Accessibility', met: true, detail: 'None requested', missing: [], requested: [] },
      { criterion: 'Facilities', met: true, detail: 'None requested', missing: [], requested: [] },
    ]);
  });
});


// SCRUM-193/194 (F4): structured codes beside the words, so the frontend can
// show its own labels. They never change `met`.
describe('SCRUM188_AC2 structured codes on the criterion entries', () => {
  it('SCRUM188_AC2_layout_entry_carries_the_code_asked_for_and_what_the_venue_offers', () => {
    const verdict = verdictFor('Layout', harbourRoom({ layouts: ['banquet'] }), baseRequest({ layout: 'u_shape' }));
    expect(verdict).toMatchObject({ met: false, layout: 'u_shape', offers: ['banquet'] });
  });

  it('SCRUM188_AC2_missing_and_requested_name_the_codes_for_accessibility_and_facilities', () => {
    const verdicts = evaluateCriteria(
      harbourRoom(),
      baseRequest({ accessibility: ['hearing_loop', 'lift_access'], facilities: ['stage'] }),
    );
    expect(verdicts[3]).toMatchObject({ missing: ['hearing_loop'], requested: ['hearing_loop', 'lift_access'] });
    expect(verdicts[4]).toMatchObject({ missing: ['stage'], requested: ['stage'] });
  });
});


// SCRUM-189: evaluateCriteria and matchesAllCriteria share one set of
// predicates, so over every fixture above they must agree (location aside,
// since only search filters on it).
describe('SCRUM188_AC2 parity with the SCRUM-20 search rule', () => {
  const required = { startsAt: sgt('10:00'), endsAt: sgt('12:00'), expectedAttendance: 80 };
  const bare = harbourRoom({ layouts: [], accessibility: [], facilities: [] });

  it.each([
    ['control', harbourRoom(), baseRequest()],
    ['capacity equal', harbourRoom(), baseRequest({ expectedAttendance: 100 })],
    ['capacity short', harbourRoom({ maxCapacity: 79 }), baseRequest()],
    ['capacity 1', harbourRoom({ maxCapacity: 1 }), baseRequest()],
    ['hours late open', harbourRoom({ hours: [{ day_of_week: 3, opens_at: '11:00:00', closes_at: '18:00:00' }] }), baseRequest()],
    ['start before opening', harbourRoom(), baseRequest({ startsAt: sgt('08:59') })],
    ['end after closing', harbourRoom(), baseRequest({ endsAt: sgt('18:01') })],
    ['exact hours', harbourRoom(), baseRequest({ startsAt: sgt('09:00'), endsAt: sgt('18:00') })],
    ['sunday', harbourRoom(), baseRequest({ startsAt: sgt('10:00', '2026-11-15'), endsAt: sgt('12:00', '2026-11-15') })],
    ['no hours', harbourRoom({ hours: [] }), baseRequest()],
    ['midnight span', harbourRoom(), baseRequest({ startsAt: sgt('23:00'), endsAt: sgt('01:00', '2026-11-12') })],
    ['utc request', harbourRoom(), baseRequest({ startsAt: '2026-11-11T02:00:00Z', endsAt: '2026-11-11T04:00:00Z' })],
    ['utc before opening', harbourRoom(), baseRequest({ startsAt: '2026-11-11T00:30:00Z', endsAt: '2026-11-11T02:00:00Z' })],
    ['layout missing', harbourRoom({ layouts: ['classroom'] }), baseRequest()],
    ['layout banquet', harbourRoom(), baseRequest({ layout: 'banquet' })],
    ['accessibility missing', harbourRoom({ accessibility: ['lift_access'] }), baseRequest()],
    ['facilities missing', harbourRoom({ facilities: ['pa_system', 'projector'] }), baseRequest()],
    ['bare required only', bare, required],
    ['bare too many', bare, { ...required, expectedAttendance: 101 }],
    ['bare too early', bare, { ...required, startsAt: sgt('08:00') }],
  ])('SCRUM188_AC2_parity_%s', (_label, venue, criteria) => {
    expect(criteria).not.toHaveProperty('location');
    expect(evaluateCriteria(venue, criteria).every((v) => v.met)).toBe(
      matchesAllCriteria(venue, criteria),
    );
  });

  // SCRUM-193/194, B-AC3-03: the rows above mostly test failures; these pin
  // parity when what was asked for is provided.
  it.each([
    ['layout requested and offered', harbourRoom(), baseRequest({ layout: 'classroom' })],
    [
      'accessibility and facilities all provided',
      harbourRoom(),
      baseRequest({ accessibility: ['lift_access', 'step_free_entrance'], facilities: ['pa_system', 'projector', 'wifi'] }),
    ],
    ['capacity 0 attendance 0', harbourRoom({ maxCapacity: 0 }), baseRequest({ expectedAttendance: 0 })],
  ])('SCRUM188_AC3_parity_also_holds_when_requested_items_are_provided (%s)', (_label, venue, criteria) => {
    const verdicts = evaluateCriteria(venue, criteria);
    expect(verdicts.every((v) => v.met)).toBe(true);
    expect(matchesAllCriteria(venue, criteria)).toBe(true);
  });
});
