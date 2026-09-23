/**
 * Tests for the shared timestamp rules.
 *
 * SCRUM-126 (part of SCRUM-17, AC1): the helpers were extracted from
 * eventRequestValidation.js unchanged. These prove they work on their own,
 * with nothing but a minimal collector; eventRequestValidation.test.js passing
 * unchanged proves the extraction altered no behaviour.
 */

import { describe, it, expect } from 'vitest';

import {
  DATE_ONLY_PATTERN,
  LOCAL_DATETIME_PATTERN,
  TIMESTAMP_PATTERN,
  daysInMonth,
  checkTimestamp,
} from '../../src/validation/timestampValidation.js';

/** The smallest thing checkTimestamp accepts: any object with add(). */
function collector() {
  const details = [];
  return { add: (field, message) => details.push({ field, message }), details };
}


describe('daysInMonth', () => {
  it('SCRUM17_AC1_daysInMonth_handles_leap_years', () => {
    expect(daysInMonth(2028, 2)).toBe(29); // divisible by 4
    expect(daysInMonth(2026, 2)).toBe(28); // ordinary year
    expect(daysInMonth(1900, 2)).toBe(28); // century, not divisible by 400
    expect(daysInMonth(2000, 2)).toBe(29); // divisible by 400
  });

  it('knows the 30- and 31-day months', () => {
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });
});


describe('the exported patterns', () => {
  it('tell a date on its own, a local date-time and a full instant apart', () => {
    expect(DATE_ONLY_PATTERN.test('2026-06-01')).toBe(true);
    expect(LOCAL_DATETIME_PATTERN.test('2026-06-01T09:00')).toBe(true);
    expect(TIMESTAMP_PATTERN.test('2026-06-01T09:00:00+08:00')).toBe(true);
    expect(TIMESTAMP_PATTERN.test('2026-06-01T09:00')).toBe(false);
  });
});


describe('checkTimestamp', () => {
  it.each([
    '2026-06-01T09:00:00+08:00',
    '2026-06-01T01:00:00Z',
    '2026-06-01T09:00+08:00',
    '2026-06-01T09:00:00.123-05:00',
  ])('SCRUM17_AC1_accepts_an_instant_with_an_offset (%s)', (value) => {
    const errors = collector();
    const instant = checkTimestamp(errors, 'startsAt', value);

    expect(errors.details).toEqual([]);
    expect(instant).toBeInstanceOf(Date);
    expect(instant.getTime()).toBe(new Date(value).getTime());
  });

  it('trims surrounding whitespace before judging', () => {
    const errors = collector();
    const instant = checkTimestamp(errors, 'startsAt', '  2026-06-01T01:00:00Z  ');

    expect(errors.details).toEqual([]);
    expect(instant.toISOString()).toBe('2026-06-01T01:00:00.000Z');
  });

  it.each([
    ['a date on its own', '2026-06-01', 'must include a time of day, not a date on its own'],
    ['a missing offset', '2026-06-01T09:00:00', 'must include a UTC offset, such as Z or +08:00'],
    [
      '30 February',
      '2026-02-30T09:00:00Z',
      'is not a real date -- that month does not have that many days',
    ],
    [
      'garbage',
      'next tuesday',
      'must be an ISO 8601 date and time such as 2026-06-01T09:00:00+08:00',
    ],
    [
      'an out-of-range month',
      '2026-13-01T09:00:00Z',
      'must be an ISO 8601 date and time such as 2026-06-01T09:00:00+08:00',
    ],
  ])('SCRUM17_AC1_rejects %s', (_label, value, message) => {
    const errors = collector();

    expect(checkTimestamp(errors, 'endsAt', value)).toBeNull();
    expect(errors.details).toEqual([{ field: 'endsAt', message }]);
  });

  it('accepts 29 February in a leap year', () => {
    const errors = collector();
    expect(checkTimestamp(errors, 'endsAt', '2028-02-29T09:00:00Z')).toBeInstanceOf(Date);
    expect(errors.details).toEqual([]);
  });

  it.each([
    ['a number', 1780000000000],
    ['a Date', new Date('2026-06-01T01:00:00Z')],
    ['null', null],
    ['an object', {}],
  ])('SCRUM17_AC1_rejects a non-string: %s', (_label, value) => {
    const errors = collector();

    expect(checkTimestamp(errors, 'startsAt', value)).toBeNull();
    expect(errors.details).toEqual([
      { field: 'startsAt', message: 'must be an ISO 8601 date and time, given as text' },
    ]);
  });
});
