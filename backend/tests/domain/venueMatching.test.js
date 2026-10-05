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
 */

import { describe, it, expect } from 'vitest';

import {
  VENUE_TIME_ZONE,
  toVenueLocal,
  meetsCapacity,
  coversPeriod,
  supportsLayout,
  providesAll,
  matchesAllCriteria,
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


// B-AC4-01..05: Candidate is Control with exactly one thing changed.
describe('SCRUM20_AC4 meeting only some criteria is not enough', () => {
  it('SCRUM20_AC4_control_meets_the_base_request', () => {
    expect(matchesAllCriteria(harbourRoom(), baseRequest())).toBe(true);
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
  ])('%s', (_name, change) => {
    expect(matchesAllCriteria(harbourRoom(change), baseRequest())).toBe(false);
  });
});
