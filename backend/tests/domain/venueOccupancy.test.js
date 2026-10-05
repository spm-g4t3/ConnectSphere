/**
 * Tests for the venue occupancy rule.
 *
 * SCRUM-139, a subtask of SCRUM-20 (Search Venues Against Event Requirements).
 *
 * AC5: a booking or block overlaps when it starts before the requested end AND
 *      ends after the requested start. Ending exactly at the start, or
 *      starting exactly at the end, is not an overlap.
 * AC6: a venue with an overlapping occupying booking or active block is not
 *      returned. (Decided: flagged_for_review bookings occupy too.)
 * Week 7: at a venue an event occupies [start - setup, end + turnaround), and
 *      so does the requested event. A block is a closure: it is compared RAW
 *      against the request's padded period -- it gets no setup or turnaround
 *      of its own.
 *
 * Fixtures follow SCRUM-20-test-cases.md: the base request is Wednesday
 * 2026-11-11, 10:00-12:00 Singapore. Cases B-AC5-01..06 (bookings),
 * B-AC5-08..13 (blocks, tested here against isVenueFree rather than
 * findBlockedVenueIds), B-AC5-15..25.
 *
 * Timezone independence: every instant carries an explicit offset and every
 * expectation is a boolean or epoch milliseconds, so these pass whatever TZ the
 * process runs under (checked under UTC, Asia/Singapore and America/New_York).
 */

import { describe, it, expect } from 'vitest';

import {
  overlaps,
  paddedPeriod,
  OCCUPYING_BOOKING_STATUSES,
  MAX_BUFFER_MINUTES,
  isVenueFree,
} from '../../src/domain/venueOccupancy.js';
import { BOOKING_STATUS } from '../../src/domain/bookingStatus.js';
import { SETUP_MINUTES_OPTIONS } from '../../src/domain/setupOptions.js';
import { TURNAROUND_MINUTES_OPTIONS } from '../../src/domain/turnaroundOptions.js';

/** A Singapore-local instant on Wednesday 2026-11-11. */
const sgt = (hhmm, date = '2026-11-11') => `${date}T${hhmm}:00+08:00`;

/** A booking or block row, as PostgREST returns it. */
const row = (from, to) => ({ starts_at: sgt(from), ends_at: sgt(to) });

/** A request from one Singapore time to another. */
const request = (from, to) => ({ startsAt: sgt(from), endsAt: sgt(to) });

const ms = (iso) => new Date(iso).getTime();

const NO_BUFFERS = Object.freeze({ setupMinutes: 0, turnaroundMinutes: 0 });
/** The customer's worked example: setup 30, turnaround 45. */
const WORKED = Object.freeze({ setupMinutes: 30, turnaroundMinutes: 45 });

/** Base request: 10:00-12:00. */
const BASE = Object.freeze(request('10:00', '12:00'));

/**
 * The plain AC5 edge cases against the base request: [name, from, to, free].
 * Shared by bookings (B-AC5-01..06) and blocks (B-AC5-08..13).
 */
const PLAIN_EDGES = [
  ['ending_at_requested_start_does_not_overlap', '08:00', '10:00', true],
  ['starting_at_requested_end_does_not_overlap', '12:00', '14:00', true],
  ['ending_one_minute_after_start_overlaps', '08:00', '10:01', false],
  ['starting_one_minute_before_end_overlaps', '11:59', '14:00', false],
  ['containing_the_period_overlaps', '09:00', '13:00', false],
  ['inside_the_period_overlaps', '10:30', '11:00', false],
];

// ---------------------------------------------------------------------------
// overlaps: the strict half-open rule
// ---------------------------------------------------------------------------
describe('SCRUM20 AC5 overlaps is strict at both edges', () => {
  it.each([
    ['touching at a.end == b.start', 0, 10, 10, 20, false],
    ['touching at a.start == b.end', 10, 20, 0, 10, false],
    ['one unit over a.end', 0, 11, 10, 20, true],
    ['one unit over a.start', 9, 20, 0, 10, true],
    ['a contains b', 0, 30, 10, 20, true],
    ['a inside b', 12, 18, 10, 20, true],
    ['identical periods', 10, 20, 10, 20, true],
    ['disjoint before', 0, 5, 10, 20, false],
    ['disjoint after', 25, 30, 10, 20, false],
  ])('SCRUM20_AC5_overlaps_%s', (_name, aStart, aEnd, bStart, bEnd, expected) => {
    expect(overlaps(aStart, aEnd, bStart, bEnd)).toBe(expected);
    // Symmetric: the rule does not care which period is which.
    expect(overlaps(bStart, bEnd, aStart, aEnd)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// paddedPeriod
// ---------------------------------------------------------------------------
describe('SCRUM20 AC5 paddedPeriod', () => {
  it('SCRUM20_AC5_padded_period_subtracts_setup_and_adds_turnaround', () => {
    // The worked example: 10:00-12:00 with 30/45 occupies 09:30-12:45.
    expect(paddedPeriod(sgt('10:00'), sgt('12:00'), 30, 45)).toEqual({
      start: ms(sgt('09:30')),
      end: ms(sgt('12:45')),
    });
  });

  it('SCRUM20_AC5_padded_period_with_zero_buffers_is_the_raw_period', () => {
    expect(paddedPeriod(sgt('10:00'), sgt('12:00'), 0, 0)).toEqual({
      start: ms(sgt('10:00')),
      end: ms(sgt('12:00')),
    });
  });

  it('SCRUM20_AC5_padded_period_ignores_the_offset_a_timestamp_was_written_with', () => {
    const singapore = paddedPeriod('2026-11-11T10:00:00+08:00', '2026-11-11T12:00:00+08:00', 30, 45);
    const utc = paddedPeriod('2026-11-11T02:00:00Z', '2026-11-11T04:00:00Z', 30, 45);
    const newYork = paddedPeriod('2026-11-10T21:00:00-05:00', '2026-11-10T23:00:00-05:00', 30, 45);

    expect(utc).toEqual(singapore);
    expect(newYork).toEqual(singapore);
    expect(singapore.start).toBe(Date.UTC(2026, 10, 11, 1, 30));
    expect(singapore.end).toBe(Date.UTC(2026, 10, 11, 4, 45));
  });

  it('SCRUM20_AC5_padded_period_accepts_dates', () => {
    const start = new Date('2026-11-11T02:00:00Z');
    const end = new Date('2026-11-11T04:00:00Z');

    expect(paddedPeriod(start, end, 30, 45)).toEqual(paddedPeriod(sgt('10:00'), sgt('12:00'), 30, 45));
  });

  it('SCRUM20_AC5_padded_period_crosses_midnight', () => {
    const { start, end } = paddedPeriod(sgt('00:15'), sgt('23:30'), 30, 45);

    expect(start).toBe(ms(sgt('23:45', '2026-11-10')));
    expect(end).toBe(ms(sgt('00:15', '2026-11-12')));
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
describe('SCRUM20 AC6 constants', () => {
  it('SCRUM20_AC5_max_buffer_is_240_minutes', () => {
    expect(MAX_BUFFER_MINUTES).toBe(240);
  });

  it('SCRUM20_AC5_max_buffer_is_the_largest_setup_plus_the_largest_turnaround', () => {
    expect(MAX_BUFFER_MINUTES).toBe(
      Math.max(...SETUP_MINUTES_OPTIONS) + Math.max(...TURNAROUND_MINUTES_OPTIONS),
    );
  });

  it('SCRUM20_AC6_occupying_statuses_are_exactly_approved_and_flagged', () => {
    expect(OCCUPYING_BOOKING_STATUSES).toEqual(['approved', 'flagged_for_review']);
    expect(OCCUPYING_BOOKING_STATUSES).toEqual([
      BOOKING_STATUS.APPROVED,
      BOOKING_STATUS.FLAGGED_FOR_REVIEW,
    ]);
  });

  it('SCRUM20_AC6_occupying_statuses_exclude_cancelled', () => {
    expect(OCCUPYING_BOOKING_STATUSES).not.toContain(BOOKING_STATUS.CANCELLED);
  });

  it('SCRUM20_AC6_occupying_statuses_are_frozen', () => {
    expect(Object.isFrozen(OCCUPYING_BOOKING_STATUSES)).toBe(true);
    expect(() => {
      OCCUPYING_BOOKING_STATUSES.push('cancelled');
    }).toThrow(TypeError);
    expect(OCCUPYING_BOOKING_STATUSES).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// isVenueFree, zero buffers: the plain AC5 edges
// ---------------------------------------------------------------------------
describe('SCRUM20 AC5 isVenueFree with zero buffers: bookings', () => {
  it.each(PLAIN_EDGES)('SCRUM20_AC5_booking_%s', (_name, from, to, free) => {
    expect(isVenueFree(NO_BUFFERS, BASE, [row(from, to)], [])).toBe(free);
  });
});

describe('SCRUM20 AC5 isVenueFree with zero buffers: blocks', () => {
  it.each(PLAIN_EDGES)('SCRUM20_AC5_block_%s', (_name, from, to, free) => {
    expect(isVenueFree(NO_BUFFERS, BASE, [], [row(from, to)])).toBe(free);
  });

  it('SCRUM20_AC5_block_containing_the_period_overlaps (whole-day block)', () => {
    // B-AC5-12 exactly as written: 2026-11-11 00:00 to 2026-11-12 00:00.
    const wholeDay = { starts_at: sgt('00:00'), ends_at: sgt('00:00', '2026-11-12') };

    expect(isVenueFree(NO_BUFFERS, BASE, [], [wholeDay])).toBe(false);
  });
});

describe('SCRUM20 AC5 zero buffers equal the plain edge cases', () => {
  const cases = PLAIN_EDGES.flatMap(([name, from, to]) => [
    [`booking_${name}`, from, to, 'booking'],
    [`block_${name}`, from, to, 'block'],
  ]);

  it.each(cases)('SCRUM20_AC5_zero_buffers_equal_the_plain_edge_cases: %s', (_name, from, to, kind) => {
    // B-AC5-25: with both buffers at 0, isVenueFree is exactly !overlaps on
    // the raw periods.
    const occupied = row(from, to);
    const plain = overlaps(ms(BASE.startsAt), ms(BASE.endsAt), ms(occupied.starts_at), ms(occupied.ends_at));
    const free =
      kind === 'booking'
        ? isVenueFree(NO_BUFFERS, BASE, [occupied], [])
        : isVenueFree(NO_BUFFERS, BASE, [], [occupied]);

    expect(free).toBe(!plain);
  });
});

// ---------------------------------------------------------------------------
// isVenueFree with setup and turnaround (Week 7): bookings
// Venue setup 30, turnaround 45; booking 10:00-12:00 occupies 09:30-12:45.
// ---------------------------------------------------------------------------
describe('SCRUM20 AC5 isVenueFree pads bookings and the request', () => {
  const BOOKING = Object.freeze([row('10:00', '12:00')]);

  it('SCRUM20_AC5_padded_request_touching_padded_booking_end_is_kept', () => {
    // B-AC5-15: request 13:15 pads back to 12:45, touching 12:45.
    expect(isVenueFree(WORKED, request('13:15', '14:00'), BOOKING, [])).toBe(true);
    expect(isVenueFree(WORKED, request('13:15', '14:15'), BOOKING, [])).toBe(true);
  });

  it('SCRUM20_AC5_padded_request_one_minute_into_turnaround_is_excluded', () => {
    // B-AC5-16: 13:14 pads back to 12:44, one minute inside 12:45.
    expect(isVenueFree(WORKED, request('13:14', '14:00'), BOOKING, [])).toBe(false);
    expect(isVenueFree(WORKED, request('13:14', '14:15'), BOOKING, [])).toBe(false);
  });

  it('SCRUM20_AC5_request_ending_well_before_padded_booking_is_kept', () => {
    // B-AC5-17: request 07:00/07:15-08:15 occupies up to 09:00; booking from 09:30.
    expect(isVenueFree(WORKED, request('07:00', '08:15'), BOOKING, [])).toBe(true);
    expect(isVenueFree(WORKED, request('07:15', '08:15'), BOOKING, [])).toBe(true);
  });

  it('SCRUM20_AC5_padded_request_touching_padded_booking_start_is_kept', () => {
    // B-AC5-18: request ending 08:45 pads forward to 09:30, touching 09:30.
    expect(isVenueFree(WORKED, request('07:45', '08:45'), BOOKING, [])).toBe(true);
  });

  it('SCRUM20_AC5_padded_request_one_minute_into_setup_is_excluded', () => {
    // B-AC5-19: request ending 08:46 pads forward to 09:31.
    expect(isVenueFree(WORKED, request('07:46', '08:46'), BOOKING, [])).toBe(false);
  });

  it('SCRUM20_AC5_request_setup_alone_causes_overlap', () => {
    // B-AC5-20: setup 30, turnaround 0. Request 12:00-13:00 occupies
    // 11:30-13:00, so its own setup runs into the booking.
    const venue = { setupMinutes: 30, turnaroundMinutes: 0 };

    expect(isVenueFree(venue, request('12:00', '13:00'), BOOKING, [])).toBe(false);
    // ...whereas with no buffers at all the same request only touches.
    expect(isVenueFree(NO_BUFFERS, request('12:00', '13:00'), BOOKING, [])).toBe(true);
  });

  it('SCRUM20_AC5_booking_turnaround_alone_sets_the_edge', () => {
    // B-AC5-21: setup 0, turnaround 45. Booking occupies until 12:45.
    const venue = { setupMinutes: 0, turnaroundMinutes: 45 };

    expect(isVenueFree(venue, request('12:30', '13:30'), BOOKING, [])).toBe(false);
    expect(isVenueFree(venue, request('12:45', '13:45'), BOOKING, [])).toBe(true);
  });

  it('SCRUM20_AC5_any_one_clashing_booking_among_many_excludes', () => {
    const bookings = [row('07:00', '08:00'), row('10:00', '12:00'), row('16:00', '17:00')];

    expect(isVenueFree(WORKED, request('13:14', '14:00'), bookings, [])).toBe(false);
    expect(isVenueFree(WORKED, request('13:15', '14:00'), bookings, [])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isVenueFree with setup and turnaround: blocks are compared RAW against the
// request's padded period. A block is a closure, not an event, so it gets no
// setup or turnaround of its own on either side.
// ---------------------------------------------------------------------------
describe('SCRUM20 AC5 isVenueFree compares blocks raw against the padded request', () => {
  it('SCRUM20_AC5_padded_start_touching_block_end_is_kept (block 08:00-09:45)', () => {
    // Request 10:15 pads back to 09:45, touching the block's end. Were the
    // block padded by turnaround (to 10:30) this would clash.
    expect(isVenueFree(WORKED, request('10:15', '11:00'), [], [row('08:00', '09:45')])).toBe(true);
  });

  it('SCRUM20_AC5_padded_start_inside_block_is_excluded (block 08:00-09:45)', () => {
    // Request 10:14 pads back to 09:44, one minute inside the block.
    expect(isVenueFree(WORKED, request('10:14', '11:00'), [], [row('08:00', '09:45')])).toBe(false);
  });

  it('SCRUM20_AC5_padded_start_inside_block_is_excluded', () => {
    // B-AC5-22: block 13:00-14:00; request 14:15 pads back to 13:45.
    expect(isVenueFree(WORKED, request('14:15', '15:00'), [], [row('13:00', '14:00')])).toBe(false);
  });

  it('SCRUM20_AC5_padded_start_touching_block_end_is_kept', () => {
    // B-AC5-23: same block; request 14:30 pads back to 14:00.
    expect(isVenueFree(WORKED, request('14:30', '15:00'), [], [row('13:00', '14:00')])).toBe(true);
  });

  it('SCRUM20_AC5_padded_end_against_block_start_edge', () => {
    // B-AC5-24: block 16:00-17:00. Request ending 15:15 pads to 16:00 (kept);
    // ending 15:16 pads to 16:01 (excluded). Were the block padded back by
    // setup (to 15:30), 15:15 would clash too.
    const block = [row('16:00', '17:00')];

    expect(isVenueFree(WORKED, request('14:30', '15:15'), [], block)).toBe(true);
    expect(isVenueFree(WORKED, request('14:30', '15:16'), [], block)).toBe(false);
  });

  it('SCRUM20_AC5_block_is_not_padded_where_a_booking_would_be', () => {
    // The same period as a booking and as a block, against the same request:
    // the booking (padded 09:30-12:45) clashes with a request padded from
    // 12:44; the block (raw 10:00-12:00) does not.
    const req = request('13:14', '14:00');

    expect(isVenueFree(WORKED, req, [row('10:00', '12:00')], [])).toBe(false);
    expect(isVenueFree(WORKED, req, [], [row('10:00', '12:00')])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isVenueFree: branches
// ---------------------------------------------------------------------------
describe('SCRUM20 AC6 isVenueFree branches', () => {
  it('SCRUM20_AC6_no_bookings_and_no_blocks_is_free', () => {
    expect(isVenueFree(WORKED, BASE, [], [])).toBe(true);
  });

  it('SCRUM20_AC6_a_booking_clash_answers_false_before_blocks_are_checked', () => {
    // A blocks array whose .some throws proves it is never consulted.
    const untouchable = {
      some: () => {
        throw new Error('blocks were checked');
      },
    };

    expect(isVenueFree(NO_BUFFERS, BASE, [row('10:30', '11:00')], untouchable)).toBe(false);
  });

  it('SCRUM20_AC6_blocks_are_checked_when_no_booking_clashes', () => {
    expect(isVenueFree(NO_BUFFERS, BASE, [row('07:00', '08:00')], [row('10:30', '11:00')])).toBe(false);
    expect(isVenueFree(NO_BUFFERS, BASE, [row('07:00', '08:00')], [row('13:00', '14:00')])).toBe(true);
  });

  it('SCRUM20_AC6_answers_a_boolean_and_nothing_else', () => {
    expect(isVenueFree(NO_BUFFERS, BASE, [row('10:30', '11:00')], [])).toBe(false);
    expect(typeof isVenueFree(NO_BUFFERS, BASE, [], [])).toBe('boolean');
  });

  it('SCRUM20_AC5_rows_with_utc_timestamps_compare_as_instants', () => {
    // PostgREST returns timestamptz in UTC; the request carries +08:00.
    const utcBooking = { starts_at: '2026-11-11T02:00:00+00:00', ends_at: '2026-11-11T04:00:00+00:00' };

    expect(isVenueFree(WORKED, request('13:14', '14:00'), [utcBooking], [])).toBe(false);
    expect(isVenueFree(WORKED, request('13:15', '14:00'), [utcBooking], [])).toBe(true);
  });

  it('SCRUM20_AC5_request_as_dates_is_accepted', () => {
    const req = { startsAt: new Date(sgt('13:15')), endsAt: new Date(sgt('14:00')) };

    expect(isVenueFree(WORKED, req, [row('10:00', '12:00')], [])).toBe(true);
  });
});
