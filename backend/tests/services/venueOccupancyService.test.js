/**
 * Tests for the venue occupancy reads.
 *
 * SCRUM-139, a subtask of SCRUM-20 (Search Venues Against Event Requirements).
 *
 * findOccupancies reads the occupying bookings and active blocks that could
 * clash with a requested period, widened on both sides by MAX_BUFFER_MINUTES
 * (240), and groups them per venue. It decides nothing; isVenueFree does.
 *
 *  AC5: both reads use the strict half-open overlap, lt on starts_at and gt
 *       on ends_at (B-AC5-07, B-AC5-14), widened by 240 minutes.
 *  AC6: bookings are limited to OCCUPYING_BOOKING_STATUSES (approved and
 *       flagged_for_review -- decided, wider than the AC's wording), blocks to
 *       active ones (.is('removed_at', null)) (B-AC6-02/03/06).
 *
 * The Supabase client is replaced wholesale, as the other service tests do:
 * vi.mock's factory is hoisted above the imports, so the real module never
 * evaluates. `from(table)` is routed by table name. Nothing touches the
 * network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { supabase } from '../../src/config/supabaseClient.js';
import { findOccupancies } from '../../src/services/venueOccupancyService.js';
import { OCCUPYING_BOOKING_STATUSES } from '../../src/domain/venueOccupancy.js';
import { ValidationError } from '../../src/errors.js';

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));

vi.mock('../../src/config/supabaseClient.js', () => {
  const client = { rpc, from };
  return { supabase: client, default: client };
});

const VENUE_A = '6c1a2d3e-0000-4000-8000-00000000000a';
const VENUE_B = '6c1a2d3e-0000-4000-8000-00000000000b';
const VENUE_C = '6c1a2d3e-0000-4000-8000-00000000000c';

/** Base request: Wednesday 2026-11-11, 10:00-12:00 Singapore (02:00-04:00Z). */
const STARTS_AT = '2026-11-11T10:00:00+08:00';
const ENDS_AT = '2026-11-11T12:00:00+08:00';
/** STARTS_AT - 240 minutes and ENDS_AT + 240 minutes, as toISOString writes them. */
const READ_FROM = '2026-11-10T22:00:00.000Z';
const READ_TO = '2026-11-11T08:00:00.000Z';

const COLUMNS = 'venue_id, starts_at, ends_at';

/**
 * A recording, thenable stand-in for a supabase-js query builder. Unlike
 * venueService.test.js's queryStub it keeps EVERY call, because the bookings
 * read calls .in twice (venue_id, then status).
 */
function queryStub(result) {
  const calls = [];
  const stub = {
    calls,
    then: (ok, ko) => Promise.resolve(result).then(ok, ko),
  };
  for (const method of ['select', 'eq', 'is', 'in', 'lt', 'gt', 'lte', 'gte', 'order', 'not']) {
    stub[method] = (...args) => {
      calls.push([method, ...args]);
      return stub;
    };
  }
  return stub;
}

/** Wire `from` per table; anything else is a loud failure. */
function givenOccupancy({ bookings = { data: [], error: null }, blocks = { data: [], error: null } } = {}) {
  const stubs = {};
  from.mockImplementation((table) => {
    if (table === 'bookings') return (stubs.bookings = queryStub(bookings));
    if (table === 'venue_blocks') return (stubs.venue_blocks = queryStub(blocks));
    throw new Error(`unexpected table ${table}`);
  });
  return stubs;
}

async function errorFromAsync(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

const occupancyRow = (venueId, from, to) => ({ venue_id: venueId, starts_at: from, ends_at: to });

beforeEach(() => {
  vi.resetAllMocks();
});

describe('the test double', () => {
  it('has replaced the real Supabase client', () => {
    expect(vi.isMockFunction(supabase.from)).toBe(true);
  });
});

describe('SCRUM20 findOccupancies: no venues, no query', () => {
  it('SCRUM20_AC6_empty_ids_answer_an_empty_map_without_a_query', async () => {
    givenOccupancy();

    const result = await findOccupancies([], STARTS_AT, ENDS_AT);

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('SCRUM20 findOccupancies: the query shape', () => {
  it('SCRUM20_AC5_both_reads_are_issued', async () => {
    givenOccupancy();

    await findOccupancies([VENUE_A], STARTS_AT, ENDS_AT);

    expect(from.mock.calls.map(([t]) => t).sort()).toEqual(['bookings', 'venue_blocks']);
  });

  it('SCRUM20_AC5_booking_query_uses_strict_lt_and_gt', async () => {
    // B-AC5-07 and B-AC6-02/03: exactly this chain, widened by 240 minutes.
    const stubs = givenOccupancy();

    await findOccupancies([VENUE_A, VENUE_B], STARTS_AT, ENDS_AT);

    expect(stubs.bookings.calls).toEqual([
      ['select', COLUMNS],
      ['in', 'venue_id', [VENUE_A, VENUE_B]],
      ['in', 'status', ['approved', 'flagged_for_review']],
      ['lt', 'starts_at', READ_TO],
      ['gt', 'ends_at', READ_FROM],
    ]);
  });

  it('SCRUM20_AC6_booking_query_filters_on_the_occupying_statuses', async () => {
    const stubs = givenOccupancy();

    await findOccupancies([VENUE_A], STARTS_AT, ENDS_AT);

    const statusFilter = stubs.bookings.calls.find(([m, col]) => m === 'in' && col === 'status');
    expect(statusFilter[2]).toBe(OCCUPYING_BOOKING_STATUSES);
    expect(statusFilter[2]).not.toContain('cancelled');
  });

  it('SCRUM20_AC5_block_query_uses_strict_lt_and_gt', async () => {
    // B-AC5-14 and B-AC6-06: only active blocks, widened by 240 minutes.
    const stubs = givenOccupancy();

    await findOccupancies([VENUE_A, VENUE_B], STARTS_AT, ENDS_AT);

    expect(stubs.venue_blocks.calls).toEqual([
      ['select', COLUMNS],
      ['in', 'venue_id', [VENUE_A, VENUE_B]],
      ['is', 'removed_at', null],
      ['lt', 'starts_at', READ_TO],
      ['gt', 'ends_at', READ_FROM],
    ]);
  });

  it('SCRUM20_AC5_read_window_is_the_same_instant_whatever_the_offset', async () => {
    const stubs = givenOccupancy();

    await findOccupancies([VENUE_A], '2026-11-11T02:00:00Z', new Date('2026-11-11T04:00:00Z'));

    expect(stubs.bookings.calls).toContainEqual(['lt', 'starts_at', READ_TO]);
    expect(stubs.bookings.calls).toContainEqual(['gt', 'ends_at', READ_FROM]);
  });
});

describe('SCRUM20 findOccupancies: grouping', () => {
  it('SCRUM20_AC6_rows_are_grouped_per_venue_and_every_id_is_present', async () => {
    const bookingA = occupancyRow(VENUE_A, '2026-11-11T02:30:00+00:00', '2026-11-11T03:30:00+00:00');
    const bookingA2 = occupancyRow(VENUE_A, '2026-11-11T05:00:00+00:00', '2026-11-11T06:00:00+00:00');
    const blockB = occupancyRow(VENUE_B, '2026-11-11T02:00:00+00:00', '2026-11-11T04:00:00+00:00');
    givenOccupancy({
      bookings: { data: [bookingA, bookingA2], error: null },
      blocks: { data: [blockB], error: null },
    });

    const result = await findOccupancies([VENUE_A, VENUE_B, VENUE_C], STARTS_AT, ENDS_AT);

    expect([...result.keys()]).toEqual([VENUE_A, VENUE_B, VENUE_C]);
    expect(result.get(VENUE_A)).toEqual({ bookings: [bookingA, bookingA2], blocks: [] });
    expect(result.get(VENUE_B)).toEqual({ bookings: [], blocks: [blockB] });
    expect(result.get(VENUE_C)).toEqual({ bookings: [], blocks: [] });
  });

  it('SCRUM20_AC6_null_data_gives_empty_arrays', async () => {
    givenOccupancy({ bookings: { data: null, error: null }, blocks: { data: null, error: null } });

    const result = await findOccupancies([VENUE_A, VENUE_B], STARTS_AT, ENDS_AT);

    expect(result.get(VENUE_A)).toEqual({ bookings: [], blocks: [] });
    expect(result.get(VENUE_B)).toEqual({ bookings: [], blocks: [] });
  });

  it('SCRUM20_AC6_each_venue_gets_its_own_arrays', async () => {
    givenOccupancy({
      bookings: { data: [occupancyRow(VENUE_A, 'x', 'y')], error: null },
    });

    const result = await findOccupancies([VENUE_A, VENUE_B], STARTS_AT, ENDS_AT);

    expect(result.get(VENUE_A).bookings).not.toBe(result.get(VENUE_B).bookings);
    expect(result.get(VENUE_B).bookings).toEqual([]);
  });
});

describe('SCRUM20 findOccupancies: errors are translated', () => {
  it.each([
    ['bookings', { bookings: { data: null, error: { code: 'XX000', message: 'bookings read failed' } } }, 'bookings read failed'],
    ['venue_blocks', { blocks: { data: null, error: { code: 'XX000', message: 'blocks read failed' } } }, 'blocks read failed'],
  ])('SCRUM20_AC6_a_%s_read_error_is_a_plain_error', async (_table, wiring, message) => {
    givenOccupancy(wiring);

    const err = await errorFromAsync(() => findOccupancies([VENUE_A], STARTS_AT, ENDS_AT));

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err.message).toBe(message);
  });

  it.each([
    ['bookings', 'bookings'],
    ['venue_blocks', 'blocks'],
  ])('SCRUM20_AC6_a_%s_22P02_is_a_validation_error', async (_table, key) => {
    givenOccupancy({ [key]: { data: null, error: { code: '22P02', message: 'invalid input syntax for type uuid' } } });

    const err = await errorFromAsync(() => findOccupancies([VENUE_A], STARTS_AT, ENDS_AT));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(err.message).toContain('invalid input syntax for type uuid');
  });

  it('SCRUM20_AC6_a_22P02_without_a_message_is_still_a_validation_error', async () => {
    givenOccupancy({ bookings: { data: null, error: { code: '22P02' } } });

    const err = await errorFromAsync(() => findOccupancies([VENUE_A], STARTS_AT, ENDS_AT));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).not.toContain('undefined');
  });

  it('SCRUM20_AC6_an_error_without_a_message_has_a_fallback', async () => {
    givenOccupancy({ blocks: { data: null, error: { code: 'XX000' } } });

    const err = await errorFromAsync(() => findOccupancies([VENUE_A], STARTS_AT, ENDS_AT));

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Unexpected database error');
  });

  it('SCRUM20_AC6_a_bookings_error_wins_when_both_reads_fail', async () => {
    givenOccupancy({
      bookings: { data: null, error: { code: 'XX000', message: 'bookings read failed' } },
      blocks: { data: null, error: { code: 'XX000', message: 'blocks read failed' } },
    });

    const err = await errorFromAsync(() => findOccupancies([VENUE_A], STARTS_AT, ENDS_AT));

    expect(err.message).toBe('bookings read failed');
  });
});
