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
// SCRUM-130: a separate import so the existing one is left as it was.
import { checkTimeWindow, singaporeToday } from '../../src/validation/timestampValidation.js';

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


// ---------------------------------------------------------------------------
// SCRUM-130 (SCRUM-17 AC2): checkTimeWindow, a start and end checked as a pair
// for the venue search window and the venue calendar's block window.
// ---------------------------------------------------------------------------
describe('SCRUM17_AC2 checkTimeWindow', () => {
  const FIELDS = ['from', 'to'];
  const START = '2026-10-01T09:00:00+08:00';
  const END = '2026-10-01T17:00:00+08:00';
  const DAY_MS = 86_400_000;

  function windowOf(start, end, options) {
    const errors = collector();
    const result = checkTimeWindow(errors, FIELDS, start, end, options);
    return { result, details: errors.details };
  }

  describe('neither end given', () => {
    it.each([
      ['undefined', undefined, undefined],
      ['null', null, null],
      ['blank', '', ''],
      ['whitespace', '   ', '\t '],
      ['mixed undefined and blank', undefined, '  '],
      ['mixed null and undefined', null, undefined],
    ])('SCRUM17_AC2_no_window_when_both_are_%s', (_label, start, end) => {
      const { result, details } = windowOf(start, end);
      expect(result).toBeNull();
      expect(details).toEqual([]);
    });

    it('SCRUM17_AC2_no_window_even_when_a_cap_is_set', () => {
      const { result, details } = windowOf(undefined, undefined, { maxDays: 400 });
      expect(result).toBeNull();
      expect(details).toEqual([]);
    });
  });

  describe('one end given', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['blank', '  '],
    ])('SCRUM17_AC2_a_missing_start_(%s)_is_reported_on_the_start_field', (_label, start) => {
      const { result, details } = windowOf(start, END);
      expect(result).toBeNull();
      expect(details).toEqual([{ field: 'from', message: 'is required when an end is given' }]);
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['blank', ''],
    ])('SCRUM17_AC2_a_missing_end_(%s)_is_reported_on_the_end_field', (_label, end) => {
      const { result, details } = windowOf(START, end);
      expect(result).toBeNull();
      expect(details).toEqual([{ field: 'to', message: 'is required when a start is given' }]);
    });

    it('SCRUM17_AC2_a_malformed_lone_start_also_gets_its_own_error', () => {
      const { result, details } = windowOf('2026-10-01', undefined);
      expect(result).toBeNull();
      expect(details).toEqual([
        { field: 'to', message: 'is required when a start is given' },
        { field: 'from', message: 'must include a time of day, not a date on its own' },
      ]);
    });

    it('SCRUM17_AC2_a_malformed_lone_end_also_gets_its_own_error', () => {
      const { result, details } = windowOf(null, 'garbage');
      expect(result).toBeNull();
      expect(details).toEqual([
        { field: 'from', message: 'is required when an end is given' },
        {
          field: 'to',
          message: 'must be an ISO 8601 date and time such as 2026-06-01T09:00:00+08:00',
        },
      ]);
    });
  });

  describe('malformed values', () => {
    const ISO_MESSAGE = 'must be an ISO 8601 date and time such as 2026-06-01T09:00:00+08:00';

    it.each([
      ['a date on its own', '2026-10-01', 'must include a time of day, not a date on its own'],
      ['no offset', '2026-10-01T09:00:00', 'must include a UTC offset, such as Z or +08:00'],
      ['30 February', '2026-02-30T09:00:00Z', 'is not a real date -- that month does not have that many days'],
      ['a raw + decoded to a space', '2026-10-01T09:00:00 08:00', ISO_MESSAGE],
      ['garbage', 'tomorrow', ISO_MESSAGE],
      ['a number', 1780000000000, 'must be an ISO 8601 date and time, given as text'],
      ['an array (a repeated query param)', [START, START], 'must be an ISO 8601 date and time, given as text'],
    ])('SCRUM17_AC2_refuses_a_start_that_is_%s', (_label, start, message) => {
      const { result, details } = windowOf(start, END);
      expect(result).toBeNull();
      expect(details).toEqual([{ field: 'from', message }]);
    });

    it('SCRUM17_AC2_a_space_for_plus_end_is_refused_on_the_end_field', () => {
      const { result, details } = windowOf(START, '2026-10-01T17:00:00 08:00');
      expect(result).toBeNull();
      expect(details).toEqual([{ field: 'to', message: ISO_MESSAGE }]);
    });

    it('SCRUM17_AC2_both_malformed_reports_both', () => {
      const { details } = windowOf('2026-10-01', '2026-10-02');
      expect(details.map((d) => d.field)).toEqual(['from', 'to']);
    });
  });

  describe('order', () => {
    it('SCRUM17_AC2_an_empty_window_(end_equals_start)_is_refused_on_the_end_field', () => {
      const { result, details } = windowOf(START, START);
      expect(result).toBeNull();
      expect(details).toEqual([{ field: 'to', message: 'must be later than the start' }]);
    });

    it('SCRUM17_AC2_a_reversed_window_is_refused_on_the_end_field', () => {
      const { result, details } = windowOf(END, START);
      expect(result).toBeNull();
      expect(details).toEqual([{ field: 'to', message: 'must be later than the start' }]);
    });

    it('SCRUM17_AC2_a_reversed_window_gets_one_error_not_also_the_cap', () => {
      // A year backwards is both "reversed" and "longer than 1 day" by magnitude.
      const { details } = windowOf('2027-10-01T00:00:00Z', '2026-10-01T00:00:00Z', { maxDays: 1 });
      expect(details).toEqual([{ field: 'to', message: 'must be later than the start' }]);
    });

    it('SCRUM17_AC2_mixed_offsets_are_compared_as_instants', () => {
      // 09:00+08:00 is 01:00Z. 02:00Z is later as an instant though the
      // string compares smaller.
      const ok = windowOf('2026-10-01T09:00:00+08:00', '2026-10-01T02:00:00Z');
      expect(ok.details).toEqual([]);
      expect(ok.result).toEqual({ start: '2026-10-01T09:00:00+08:00', end: '2026-10-01T02:00:00Z' });

      // The same instant in two offsets is an empty window.
      const same = windowOf('2026-10-01T09:00:00+08:00', '2026-10-01T01:00:00Z');
      expect(same.details).toEqual([{ field: 'to', message: 'must be later than the start' }]);

      // String-later, instant-earlier: reversed.
      const reversed = windowOf('2026-10-01T01:00:00Z', '2026-10-01T08:00:00+08:00');
      expect(reversed.details).toEqual([{ field: 'to', message: 'must be later than the start' }]);
    });

    it('SCRUM17_AC2_a_one_ms_window_is_accepted', () => {
      const { result, details } = windowOf('2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.001Z');
      expect(details).toEqual([]);
      expect(result).not.toBeNull();
    });

    it('SCRUM17_AC2_a_past_window_is_accepted', () => {
      const { result, details } = windowOf('2001-01-01T00:00:00Z', '2001-02-01T00:00:00Z');
      expect(details).toEqual([]);
      expect(result).toEqual({ start: '2001-01-01T00:00:00Z', end: '2001-02-01T00:00:00Z' });
    });
  });

  describe('maxDays', () => {
    const FROM = '2026-01-01T00:00:00.000Z';
    const at = (ms) => new Date(Date.parse(FROM) + ms).toISOString();

    it('SCRUM17_AC2_exactly_maxDays_passes', () => {
      const { result, details } = windowOf(FROM, at(400 * DAY_MS), { maxDays: 400 });
      expect(details).toEqual([]);
      expect(result).toEqual({ start: FROM, end: at(400 * DAY_MS) });
    });

    it('SCRUM17_AC2_one_ms_over_maxDays_fails_on_the_end_field', () => {
      const { result, details } = windowOf(FROM, at(400 * DAY_MS + 1), { maxDays: 400 });
      expect(result).toBeNull();
      expect(details).toEqual([{ field: 'to', message: 'must be within 400 days of the start' }]);
    });

    it('SCRUM17_AC2_the_cap_message_names_the_cap_given', () => {
      const { details } = windowOf(FROM, at(7 * DAY_MS + 1), { maxDays: 7 });
      expect(details).toEqual([{ field: 'to', message: 'must be within 7 days of the start' }]);
    });

    it('SCRUM17_AC2_the_cap_is_measured_between_instants_across_offsets', () => {
      // 2026-01-01T08:00+08:00 is FROM; exactly 1 day later in another offset.
      const ok = windowOf('2026-01-01T08:00:00+08:00', '2026-01-01T19:00:00-05:00', { maxDays: 1 });
      expect(ok.details).toEqual([]);
      const over = windowOf('2026-01-01T08:00:00+08:00', '2026-01-01T19:00:01-05:00', { maxDays: 1 });
      expect(over.details).toEqual([{ field: 'to', message: 'must be within 1 days of the start' }]);
    });

    it('SCRUM17_AC2_without_maxDays_a_three_year_window_passes', () => {
      const { result, details } = windowOf('2026-01-01T00:00:00Z', '2029-01-01T00:00:00Z');
      expect(details).toEqual([]);
      expect(result).toEqual({ start: '2026-01-01T00:00:00Z', end: '2029-01-01T00:00:00Z' });
    });
  });

  it('SCRUM17_AC2_returns_both_values_trimmed_as_written', () => {
    const { result, details } = windowOf(`  ${START} `, `\t${END}  `);
    expect(details).toEqual([]);
    expect(result).toEqual({ start: START, end: END });
  });

  it('SCRUM17_AC2_reports_under_the_field_names_given', () => {
    const errors = collector();
    checkTimeWindow(errors, ['startsAt', 'endsAt'], START, undefined);
    expect(errors.details).toEqual([
      { field: 'endsAt', message: 'is required when a start is given' },
    ]);
  });

  it('SCRUM17_AC2_records_nothing_for_a_valid_window', () => {
    const { details } = windowOf(START, END, { maxDays: 400 });
    expect(details).toEqual([]);
  });
});


// SCRUM-132: a separate import so the existing one is left as it was.
import { vi, afterEach } from 'vitest';

describe('checkTimestamp coverage gaps (SCRUM-132)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records "is not a real date" when the engine cannot parse a well-formed value', () => {
    // Unreachable on V8 for anything matching TIMESTAMP_PATTERN, which is why
    // the backstop exists: a future engine that parses differently. A Date
    // that answers NaN for this one string stands in for that engine; every
    // other construction (daysInMonth's Date.UTC included) is the real one.
    const RealDate = Date;
    const value = '2026-06-01T09:00:00+08:00';
    class EngineThatCannotParse extends RealDate {
      constructor(...args) {
        if (args.length === 1 && args[0] === value) super(NaN);
        else super(...args);
      }
    }
    vi.stubGlobal('Date', EngineThatCannotParse);

    const errors = collector();
    const instant = checkTimestamp(errors, 'startsAt', value);

    expect(instant).toBeNull();
    expect(errors.details).toEqual([{ field: 'startsAt', message: 'is not a real date' }]);
  });

  it('the stub is gone afterwards, so the same value parses again', () => {
    const errors = collector();
    const instant = checkTimestamp(errors, 'startsAt', '2026-06-01T09:00:00+08:00');

    expect(errors.details).toEqual([]);
    expect(instant.toISOString()).toBe('2026-06-01T01:00:00.000Z');
  });
});


describe('singaporeToday', () => {
  it.each([
    ['SCRUM162_AC1_23_30_utc_is_already_the_next_singapore_day', '2026-10-20T23:30:00Z', '2026-10-21'],
    ['SCRUM162_AC1_15_59_utc_is_still_the_same_singapore_day', '2026-10-20T15:59:59Z', '2026-10-20'],
    ['SCRUM162_AC1_16_00_utc_is_singapore_midnight_of_the_next_day', '2026-10-20T16:00:00Z', '2026-10-21'],
  ])('%s', (_name, instant, expected) => {
    expect(singaporeToday(new Date(instant))).toBe(expected);
  });
});
