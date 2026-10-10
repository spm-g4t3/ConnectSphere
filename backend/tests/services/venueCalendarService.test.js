/**
 * Tests for the venue calendar service.
 *
 * SCRUM-179, the backend subtask of SCRUM-178 (View Venue Availability
 * Calendar - Venue Staff).
 *
 * Acceptance criteria carried in the test names:
 *   AC1 -- any venue, active or retired, has a calendar; an unknown one is 404
 *   AC2 -- approved and flagged bookings carry their status and event name;
 *          blocks carry their reason
 *   AC3 -- pending requests are not shown as booked (a status allow-list)
 *   AC5 -- cancelled bookings and removed blocks are not shown
 *   (A database error stops the calendar opening, so it is filed under AC1.)
 *   (AC6, the roles, is a route concern: tests/routes/venues.test.js.)
 *
 * The Supabase client is replaced wholesale, as venueBlockService.test.js
 * does it: vi.mock's factory is hoisted above the imports, so the real module
 * never evaluates. The mock sits at the client, not at getVenueById or
 * listVenueBlocks, so both real functions run and `from(table)` is routed by
 * table name. Nothing here touches the network.
 *
 * SCRUM-484: bookings are no longer a `from('bookings')` read. readBookings
 * calls rpc('venue_occupancy_conflicts', {..., p_pad_requested: false}) (032)
 * and keeps the kind = 'booking' rows, which arrive flat (event_name joined
 * in SQL) with the occupied period and the venue's minutes. givenTables
 * still takes `bookings`, but scripts it as that rpc's answer. Which rows the
 * function returns -- the status allow-list, the padded overlap, touching is
 * clear -- is now Postgres's, tested in tests/db/venueOccupancyDatabase.test.js.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { supabase } from '../../src/config/supabaseClient.js';
import {
  getVenueCalendar,
  toBookingEntry,
  toBlockEntry,
  toHoldEntry,
} from '../../src/services/venueCalendarService.js';
import { ValidationError, NotFoundError, AppError } from '../../src/errors.js';
import { BOOKING_STATUS } from '../../src/domain/bookingStatus.js';

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));

vi.mock('../../src/config/supabaseClient.js', () => {
  const client = { rpc, from };
  return { supabase: client, default: client };
});


const VENUE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const STAFF_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const BOOKING_A = 'b0000000-0000-4000-8000-00000000000a';
const BOOKING_B = 'b0000000-0000-4000-8000-00000000000b';
const BLOCK_A = 'c0000000-0000-4000-8000-00000000000a';
const BLOCK_B = 'c0000000-0000-4000-8000-00000000000b';
const REQUEST_A = 'e0000000-0000-4000-8000-00000000000a';
const REQUEST_B = 'e0000000-0000-4000-8000-00000000000b';

const FROM = '2026-10-01T00:00:00+08:00';
const TO = '2026-11-01T00:00:00+08:00';
const WINDOW = { from: FROM, to: TO };
const DAY_MS = 86_400_000;

const OCCUPANCY_RPC = 'venue_occupancy_conflicts';

async function errorFromAsync(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

/** The row shape getVenueById selects. */
function venueRow(overrides = {}) {
  return {
    id: VENUE_ID,
    name: 'Seminar Room 2-1',
    location: 'Level 2, SCIS',
    max_capacity: 40,
    turnaround_minutes: 0,
    retired_at: null,
    created_at: '2026-09-12T09:00:00+00:00',
    updated_at: '2026-09-12T09:00:00+00:00',
    last_modified_by: STAFF_ID,
    venue_room_layouts: [],
    venue_accessibility_features: [],
    venue_facilities: [],
    venue_operating_hours: [],
    ...overrides,
  };
}

/**
 * A kind = 'booking' row as venue_occupancy_conflicts() (032) returns it:
 * flat, with the occupied period and the venue's minutes. 0/0 here, so the
 * occupied period equals the event's own.
 */
function bookingRow(overrides = {}) {
  return {
    kind: 'booking',
    id: BOOKING_A,
    status: 'approved',
    event_request_id: REQUEST_A,
    event_name: 'Freshmen Orientation',
    reason: null,
    starts_at: '2026-10-05T01:00:00+00:00',
    ends_at: '2026-10-05T04:00:00+00:00',
    occupied_starts_at: '2026-10-05T01:00:00+00:00',
    occupied_ends_at: '2026-10-05T04:00:00+00:00',
    setup_minutes: 0,
    turnaround_minutes: 0,
    ...overrides,
  };
}

/** A kind = 'block' row from the same function; the calendar drops these. */
function occupancyBlockRow(overrides = {}) {
  return {
    kind: 'block',
    id: BLOCK_B,
    status: null,
    event_request_id: null,
    event_name: null,
    reason: 'maintenance',
    starts_at: '2026-10-07T01:00:00+00:00',
    ends_at: '2026-10-07T03:00:00+00:00',
    occupied_starts_at: '2026-10-07T01:00:00+00:00',
    occupied_ends_at: '2026-10-07T03:00:00+00:00',
    setup_minutes: 0,
    turnaround_minutes: 0,
    ...overrides,
  };
}

function blockRow(overrides = {}) {
  return {
    id: BLOCK_A,
    venue_id: VENUE_ID,
    starts_at: '2026-10-03T01:00:00+00:00',
    ends_at: '2026-10-03T09:00:00+00:00',
    reason: 'maintenance',
    notes: 'Aircon servicing',
    created_by: STAFF_ID,
    last_modified_by: STAFF_ID,
    created_at: '2026-09-23T00:00:00+00:00',
    updated_at: '2026-09-23T00:00:00+00:00',
    removed_at: null,
    removed_by: null,
    ...overrides,
  };
}

/**
 * A stand-in for a supabase-js query builder, copied from
 * venueBlockService.test.js, with `in` added for the bookings status filter.
 */
function queryStub(result) {
  const calls = [];

  const stub = {
    calls,
    called: (method) => calls.some(([name]) => name === method),
    args: (method) => calls.find(([name]) => name === method)?.slice(1),
    allArgs: (method) => calls.filter(([name]) => name === method).map((c) => c.slice(1)),
    then: (onFulfilled, onRejected) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  };

  for (const method of ['select', 'eq', 'is', 'in', 'ilike', 'gte', 'order', 'limit', 'delete', 'lt', 'gt', 'lte', 'not']) {
    stub[method] = (...args) => {
      calls.push([method, ...args]);
      return stub;
    };
  }

  stub.maybeSingle = (...args) => {
    calls.push(['maybeSingle', ...args]);
    return Promise.resolve(result);
  };

  return stub;
}

const ok = (data) => ({ data, error: null });
const fail = (error) => ({ data: null, error });

/**
 * Route from() by table name; any other table is a test failure. `bookings`
 * is the answer of rpc('venue_occupancy_conflicts') (SCRUM-484); any other
 * rpc is a test failure.
 */
function givenTables({ venue = ok(venueRow()), bookings = ok([]), blocks = ok([]) } = {}) {
  const stubs = {
    venues: queryStub(venue),
    venue_blocks: queryStub(blocks),
  };
  from.mockImplementation((table) => {
    if (!(table in stubs)) throw new Error(`unexpected table ${table}`);
    return stubs[table];
  });
  rpc.mockImplementation((name) => {
    if (name !== OCCUPANCY_RPC) throw new Error(`unexpected rpc ${name}`);
    return Promise.resolve(bookings);
  });
  return stubs;
}

/** Every read made, in order: tables by name, the bookings rpc as 'bookings'. */
const tablesQueried = () => {
  const reads = from.mock.calls.map(([table]) => table);
  if (rpc.mock.calls.length > 0) reads.push(...rpc.mock.calls.map(() => 'bookings'));
  return reads;
};

/** The arguments the bookings rpc was called with. */
const occupancyArgs = () => rpc.mock.calls.find(([name]) => name === OCCUPANCY_RPC)?.[1];

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
});


describe('SCRUM178 the test double', () => {
  it('SCRUM178_the_supabase_client_is_mocked_and_never_the_real_one', () => {
    expect(vi.isMockFunction(supabase.rpc)).toBe(true);
    expect(vi.isMockFunction(supabase.from)).toBe(true);
  });
});


describe('SCRUM178_AC1 which venues have a calendar', () => {
  it('SCRUM178_AC1_unknown_venue_throws_NotFoundError_and_reads_no_bookings_or_blocks', async () => {
    const { venues } = givenTables({ venue: ok(null) });

    const err = await errorFromAsync(() => getVenueCalendar(VENUE_ID, WINDOW));

    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
    expect(tablesQueried()).toEqual(['venues']);
    expect(venues.args('eq')).toEqual(['id', VENUE_ID]);
    expect(venues.called('maybeSingle')).toBe(true);
  });

  it('SCRUM178_AC1_venue_is_looked_up_before_bookings_and_blocks', async () => {
    givenTables();

    await getVenueCalendar(VENUE_ID, WINDOW);

    expect(tablesQueried()[0]).toBe('venues');
    expect([...tablesQueried()].sort()).toEqual(['bookings', 'venue_blocks', 'venues']);
    // SCRUM-484: the bookings read is the one rpc, and nothing else is called.
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe(OCCUPANCY_RPC);
  });

  it('SCRUM178_AC1_retired_venue_still_returns_its_entries', async () => {
    givenTables({
      venue: ok(venueRow({ retired_at: '2026-09-15T10:00:00+00:00' })),
      bookings: ok([bookingRow()]),
      blocks: ok([blockRow()]),
    });

    const entries = await getVenueCalendar(VENUE_ID, WINDOW);

    expect(entries.map((e) => [e.kind, e.id])).toEqual([
      ['block', BLOCK_A],
      ['booking', BOOKING_A],
    ]);
  });

  it('SCRUM178_AC1_a_past_window_is_accepted_and_forwarded', async () => {
    const past = { from: '2025-01-01T00:00:00Z', to: '2025-02-01T00:00:00Z' };
    const { venue_blocks: blocks } = givenTables({
      venue: ok(venueRow({ retired_at: '2025-06-01T00:00:00+00:00' })),
      bookings: ok([bookingRow({ starts_at: '2025-01-10T01:00:00+00:00', ends_at: '2025-01-10T03:00:00+00:00' })]),
    });

    const entries = await getVenueCalendar(VENUE_ID, past);

    expect(entries).toHaveLength(1);
    expect(entries[0].startsAt).toBe('2025-01-10T01:00:00+00:00');
    expect(occupancyArgs()).toMatchObject({ p_starts_at: past.from, p_ends_at: past.to });
    expect(blocks.args('lt')).toEqual(['starts_at', past.to]);
    expect(blocks.args('gt')).toEqual(['ends_at', past.from]);
  });
});


describe('SCRUM178_AC2 entry mapping', () => {
  it('SCRUM178_AC2_approved_booking_carries_status_and_event_name', async () => {
    givenTables({ bookings: ok([bookingRow()]) });

    await expect(getVenueCalendar(VENUE_ID, WINDOW)).resolves.toEqual([
      {
        kind: 'booking',
        id: BOOKING_A,
        startsAt: '2026-10-05T01:00:00+00:00',
        endsAt: '2026-10-05T04:00:00+00:00',
        status: 'approved',
        eventRequestId: REQUEST_A,
        eventName: 'Freshmen Orientation',
        // SCRUM-484 (AC7): the occupied period and the venue's minutes.
        occupiedStartsAt: '2026-10-05T01:00:00+00:00',
        occupiedEndsAt: '2026-10-05T04:00:00+00:00',
        setupMinutes: 0,
        turnaroundMinutes: 0,
      },
    ]);
  });

  it('SCRUM178_AC2_flagged_booking_carries_flagged_for_review', async () => {
    givenTables({
      bookings: ok([bookingRow({ status: 'flagged_for_review', event_name: 'Career Fair' })]),
    });

    const [entry] = await getVenueCalendar(VENUE_ID, WINDOW);

    expect(entry).toMatchObject({ kind: 'booking', status: 'flagged_for_review', eventName: 'Career Fair' });
  });

  // SCRUM-484: the event name now arrives flat from venue_occupancy_conflicts,
  // joined in SQL, so there is no PostgREST embed to unwrap. The one-element
  // array embed test and the 'an empty array' / 'an object without
  // event_name' rows below were embed shapes and are gone; a missing or null
  // name is still null.
  it.each([
    ['missing', undefined],
    ['null', null],
  ])('SCRUM178_AC2_event_name_is_null_when_the_embed_is_%s', async (_label, name) => {
    givenTables({ bookings: ok([bookingRow({ event_name: name })]) });

    const [entry] = await getVenueCalendar(VENUE_ID, WINDOW);

    expect(entry.eventName).toBeNull();
    expect(entry.kind).toBe('booking');
  });

  it('SCRUM178_AC2_block_carries_reason_and_notes_and_drops_audit_fields', async () => {
    givenTables({ blocks: ok([blockRow({ reason: 'safety', notes: null })]) });

    const [entry] = await getVenueCalendar(VENUE_ID, WINDOW);

    expect(entry).toEqual({
      kind: 'block',
      id: BLOCK_A,
      startsAt: '2026-10-03T01:00:00+00:00',
      endsAt: '2026-10-03T09:00:00+00:00',
      reason: 'safety',
      notes: null,
    });
    for (const key of ['createdBy', 'lastModifiedBy', 'createdAt', 'updatedAt', 'removedAt', 'removedBy', 'venueId']) {
      expect(entry).not.toHaveProperty(key);
    }
  });
});


describe('SCRUM178_AC3 pending requests are not shown as booked: the bookings status allow-list', () => {
  // SCRUM-484: the allow-list now lives in venue_occupancy_conflicts (032,
  // `b.status in ('approved', 'flagged_for_review')`), pinned by
  // SCRUM484_AC4_only_approved_and_flagged_bookings_occupy against PGlite.
  // Here: the calendar asks that function, and adds no status filter of its
  // own that could drift from it.
  it('SCRUM178_AC3_bookings_query_is_an_allow_list_of_approved_and_flagged', async () => {
    givenTables();

    await getVenueCalendar(VENUE_ID, WINDOW);

    expect(rpc).toHaveBeenCalledWith(OCCUPANCY_RPC, {
      p_venue_id: VENUE_ID,
      p_starts_at: FROM,
      p_ends_at: TO,
      p_pad_requested: false,
    });
    expect(tablesQueried()).not.toContain('event_requests');
    expect(from.mock.calls.map(([t]) => t)).not.toContain('bookings');
  });

  it('SCRUM178_AC3_pending_request_has_no_booking_so_never_reaches_the_calendar', async () => {
    // SCRUM-250 gave bookings a 'pending' status, so a pending booking request
    // is now a bookings row. The shared function's allow-list keeps pending,
    // rejected and withdrawn rows out of its answer; the calendar shows what
    // it answers, statuses as given.
    givenTables({
      bookings: ok([
        bookingRow({ id: BOOKING_A, status: BOOKING_STATUS.APPROVED }),
        bookingRow({ id: BOOKING_B, status: BOOKING_STATUS.FLAGGED_FOR_REVIEW, starts_at: '2026-10-06T01:00:00+00:00' }),
      ]),
    });

    const entries = await getVenueCalendar(VENUE_ID, WINDOW);

    expect(entries.map((e) => e.status)).toEqual([
      BOOKING_STATUS.APPROVED,
      BOOKING_STATUS.FLAGGED_FOR_REVIEW,
    ]);
    expect(tablesQueried()).not.toContain('event_requests');
  });
});


describe('SCRUM178_AC5 cancelled bookings and removed blocks are not shown', () => {
  it('SCRUM178_AC5_bookings_query_leaves_out_cancelled_bookings', async () => {
    // SCRUM-484: cancelled is outside venue_occupancy_conflicts' allow-list
    // (PGlite: SCRUM484_AC4_only_approved_and_flagged_bookings_occupy). The
    // calendar asks only that function for bookings, never the table.
    givenTables();

    await getVenueCalendar(VENUE_ID, WINDOW);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe(OCCUPANCY_RPC);
    expect(from.mock.calls.map(([t]) => t)).not.toContain('bookings');
  });

  it('SCRUM178_AC5_blocks_query_leaves_out_removed_blocks_within_the_window', async () => {
    const { venue_blocks: blocks } = givenTables();

    await getVenueCalendar(VENUE_ID, WINDOW);

    expect(blocks.args('eq')).toEqual(['venue_id', VENUE_ID]);
    expect(blocks.args('is')).toEqual(['removed_at', null]);
    expect(blocks.args('lt')).toEqual(['starts_at', TO]);
    expect(blocks.args('gt')).toEqual(['ends_at', FROM]);
  });
});


describe('SCRUM178_AC1 the window reaches the queries as given', () => {
  it('SCRUM178_AC1_bookings_overlap_is_strict_half_open', async () => {
    // SCRUM-484: the overlap is venue_occupancy_conflicts' '[)' && (032), so
    // half-open is Postgres's (SCRUM484_AC5_ranges_are_half_open_everywhere).
    // The window goes to it as given, unpadded: it is not an event.
    givenTables();

    await getVenueCalendar(VENUE_ID, WINDOW);

    expect(occupancyArgs()).toEqual({
      p_venue_id: VENUE_ID,
      p_starts_at: FROM,
      p_ends_at: TO,
      p_pad_requested: false,
    });
  });

  it('SCRUM178_AC1_window_is_trimmed_before_it_reaches_the_queries', async () => {
    givenTables();

    await getVenueCalendar(VENUE_ID, { from: ` ${FROM} `, to: `${TO}  ` });

    expect(occupancyArgs()).toMatchObject({ p_starts_at: FROM, p_ends_at: TO });
  });
});


describe('SCRUM178_AC2 merge and sort', () => {
  it('SCRUM178_AC2_bookings_and_blocks_are_merged_soonest_first', async () => {
    givenTables({
      bookings: ok([
        bookingRow({ id: BOOKING_A, starts_at: '2026-10-02T00:00:00+00:00', ends_at: '2026-10-02T02:00:00+00:00' }),
        bookingRow({ id: BOOKING_B, starts_at: '2026-10-20T00:00:00+00:00', ends_at: '2026-10-20T02:00:00+00:00', event_request_id: REQUEST_B }),
      ]),
      blocks: ok([
        blockRow({ id: BLOCK_A, starts_at: '2026-10-01T00:00:00+00:00', ends_at: '2026-10-01T05:00:00+00:00' }),
        blockRow({ id: BLOCK_B, starts_at: '2026-10-10T00:00:00+00:00', ends_at: '2026-10-10T05:00:00+00:00' }),
      ]),
    });

    const entries = await getVenueCalendar(VENUE_ID, WINDOW);

    expect(entries.map((e) => e.id)).toEqual([BLOCK_A, BOOKING_A, BLOCK_B, BOOKING_B]);
  });

  it('SCRUM178_AC2_mixed_offsets_sort_by_instant_not_by_string', async () => {
    // 10:00+08:00 is 02:00Z, which is before 03:00Z, though it sorts after as text.
    givenTables({
      bookings: ok([bookingRow({ id: BOOKING_A, starts_at: '2026-10-01T03:00:00Z', ends_at: '2026-10-01T05:00:00Z' })]),
      blocks: ok([blockRow({ id: BLOCK_A, starts_at: '2026-10-01T10:00:00+08:00', ends_at: '2026-10-01T11:00:00+08:00' })]),
    });

    const entries = await getVenueCalendar(VENUE_ID, WINDOW);

    expect(entries.map((e) => e.id)).toEqual([BLOCK_A, BOOKING_A]);
  });

  it('SCRUM178_AC2_equal_starts_break_ties_by_id', async () => {
    // Same instant written two ways; ids decide. The block id 'c...' and the
    // booking id 'b...' put the booking first despite blocks being appended last.
    givenTables({
      bookings: ok([bookingRow({ id: BOOKING_B, starts_at: '2026-10-01T02:00:00Z' })]),
      blocks: ok([
        blockRow({ id: BLOCK_A, starts_at: '2026-10-01T10:00:00+08:00' }),
      ]),
    });

    const entries = await getVenueCalendar(VENUE_ID, WINDOW);

    expect(entries.map((e) => e.id)).toEqual([BOOKING_B, BLOCK_A]);
  });

  it('SCRUM178_AC2_tie_break_is_by_id_whichever_order_the_rows_arrive_in', async () => {
    givenTables({
      bookings: ok([
        bookingRow({ id: BOOKING_B, starts_at: '2026-10-01T02:00:00Z' }),
        bookingRow({ id: BOOKING_A, starts_at: '2026-10-01T02:00:00Z' }),
      ]),
    });

    const entries = await getVenueCalendar(VENUE_ID, WINDOW);

    expect(entries.map((e) => e.id)).toEqual([BOOKING_A, BOOKING_B]);
  });

  it('SCRUM178_AC2_nothing_in_the_window_is_an_empty_array', async () => {
    givenTables();

    await expect(getVenueCalendar(VENUE_ID, WINDOW)).resolves.toEqual([]);
  });

  it('SCRUM178_AC2_null_bookings_data_is_treated_as_none', async () => {
    givenTables({ bookings: ok(null), blocks: ok(null) });

    await expect(getVenueCalendar(VENUE_ID, WINDOW)).resolves.toEqual([]);
  });

  it('SCRUM178_AC2_null_bookings_data_still_returns_the_blocks', async () => {
    givenTables({ bookings: ok(null), blocks: ok([blockRow()]) });

    const entries = await getVenueCalendar(VENUE_ID, WINDOW);

    expect(entries.map((e) => e.kind)).toEqual(['block']);
  });
});


describe('SCRUM178_AC1 window and id validation, before any network call', () => {
  async function expectValidation(venueId, window, details) {
    const err = await errorFromAsync(() => getVenueCalendar(venueId, window));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    if (details) expect(err.details).toEqual(details);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    return err;
  }

  it('SCRUM178_AC1_bad_venue_id', async () => {
    await expectValidation('not-a-uuid', WINDOW, [{ field: 'id', message: 'must be a venue id' }]);
  });

  it('SCRUM178_AC1_from_missing', async () => {
    await expectValidation(VENUE_ID, { to: TO }, [{ field: 'from', message: 'is required' }]);
  });

  it('SCRUM178_AC1_to_missing', async () => {
    await expectValidation(VENUE_ID, { from: FROM }, [{ field: 'to', message: 'is required' }]);
  });

  it('SCRUM178_AC1_both_missing_lists_both_fields', async () => {
    const err = await expectValidation(VENUE_ID, {}, [
      { field: 'from', message: 'is required' },
      { field: 'to', message: 'is required' },
    ]);
    expect(err.message).toBe('Invalid calendar window -- from: is required; to: is required');
  });

  it('SCRUM178_AC1_no_window_argument_at_all_lists_both_fields', async () => {
    await expectValidation(VENUE_ID, undefined, [
      { field: 'from', message: 'is required' },
      { field: 'to', message: 'is required' },
    ]);
  });

  it('SCRUM178_AC1_null_ends_are_missing', async () => {
    await expectValidation(VENUE_ID, { from: null, to: null }, [
      { field: 'from', message: 'is required' },
      { field: 'to', message: 'is required' },
    ]);
  });

  it('SCRUM178_AC1_blank_strings_are_missing', async () => {
    await expectValidation(VENUE_ID, { from: '', to: '   ' }, [
      { field: 'from', message: 'is required' },
      { field: 'to', message: 'is required' },
    ]);
  });

  it('SCRUM178_AC1_non_string_end_is_rejected_not_treated_as_missing', async () => {
    await expectValidation(VENUE_ID, { from: 12345, to: TO }, [
      { field: 'from', message: 'must be an ISO 8601 date and time, given as text' },
    ]);
  });

  it('SCRUM178_AC1_offset_less_timestamp', async () => {
    await expectValidation(VENUE_ID, { from: '2026-10-01T00:00:00', to: TO }, [
      { field: 'from', message: 'must include a UTC offset, such as Z or +08:00' },
    ]);
  });

  it('SCRUM178_AC1_reversed_window', async () => {
    await expectValidation(VENUE_ID, { from: TO, to: FROM }, [
      { field: 'to', message: 'must be later than the start' },
    ]);
  });

  it('SCRUM178_AC1_equal_ends_are_not_a_window', async () => {
    await expectValidation(VENUE_ID, { from: FROM, to: FROM }, [
      { field: 'to', message: 'must be later than the start' },
    ]);
  });

  it('SCRUM178_AC1_over_400_days', async () => {
    const to = new Date(Date.parse('2026-01-01T00:00:00Z') + 401 * DAY_MS).toISOString();
    await expectValidation(VENUE_ID, { from: '2026-01-01T00:00:00Z', to }, [
      { field: 'to', message: 'must be within 400 days of the start' },
    ]);
  });

  it('SCRUM178_AC1_exactly_400_days_is_accepted', async () => {
    givenTables();
    const to = new Date(Date.parse('2026-01-01T00:00:00Z') + 400 * DAY_MS).toISOString();

    await expect(getVenueCalendar(VENUE_ID, { from: '2026-01-01T00:00:00Z', to })).resolves.toEqual([]);
    expect(occupancyArgs()).toMatchObject({ p_ends_at: to });
  });
});


describe('SCRUM178_AC1 a database error stops the calendar opening', () => {
  it('SCRUM178_AC1_a_22P02_on_bookings_is_a_ValidationError', async () => {
    givenTables({ bookings: fail({ code: '22P02', message: 'invalid input syntax for type uuid' }) });

    const err = await errorFromAsync(() => getVenueCalendar(VENUE_ID, WINDOW));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('A value was rejected by the database: invalid input syntax for type uuid');
  });

  it('SCRUM178_AC1_a_22P02_with_no_message_is_still_a_ValidationError', async () => {
    givenTables({ bookings: fail({ code: '22P02' }) });

    const err = await errorFromAsync(() => getVenueCalendar(VENUE_ID, WINDOW));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe('A value was rejected by the database: ');
  });

  it('SCRUM178_AC1_another_code_is_a_plain_Error_with_the_driver_message', async () => {
    givenTables({ bookings: fail({ code: '42P01', message: 'relation "bookings" does not exist' }) });

    const err = await errorFromAsync(() => getVenueCalendar(VENUE_ID, WINDOW));

    expect(err).toBeInstanceOf(Error);
    // Untyped, so handleError answers 500 and never leaks the message.
    expect(err).not.toBeInstanceOf(AppError);
    expect(err.message).toBe('relation "bookings" does not exist');
  });

  it.each([
    ['no message', { code: '42P01' }],
    ['an empty message', { code: '08006', message: '' }],
  ])('SCRUM178_AC1_an_error_with_%s_is_Unexpected_database_error', async (_label, error) => {
    givenTables({ bookings: fail(error) });

    const err = await errorFromAsync(() => getVenueCalendar(VENUE_ID, WINDOW));

    expect(err).not.toBeInstanceOf(AppError);
    expect(err.message).toBe('Unexpected database error');
  });

  it('SCRUM178_AC1_a_venue_lookup_error_stops_before_bookings_and_blocks', async () => {
    givenTables({ venue: fail({ code: '42P01', message: 'relation "venues" does not exist' }) });

    const err = await errorFromAsync(() => getVenueCalendar(VENUE_ID, WINDOW));

    expect(err).toBeInstanceOf(Error);
    expect(tablesQueried()).toEqual(['venues']);
  });

  it('SCRUM178_AC1_a_blocks_error_rejects_the_whole_calendar', async () => {
    givenTables({
      bookings: ok([bookingRow()]),
      blocks: fail({ code: '42P01', message: 'relation "venue_blocks" does not exist' }),
    });

    const err = await errorFromAsync(() => getVenueCalendar(VENUE_ID, WINDOW));

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AppError);
  });
});


describe('SCRUM178_AC2 toBookingEntry and toBlockEntry', () => {
  it('SCRUM178_AC2_toBookingEntry_maps_an_object_embed', () => {
    expect(toBookingEntry(bookingRow())).toEqual({
      kind: 'booking',
      id: BOOKING_A,
      startsAt: '2026-10-05T01:00:00+00:00',
      endsAt: '2026-10-05T04:00:00+00:00',
      status: 'approved',
      eventRequestId: REQUEST_A,
      eventName: 'Freshmen Orientation',
      occupiedStartsAt: '2026-10-05T01:00:00+00:00',
      occupiedEndsAt: '2026-10-05T04:00:00+00:00',
      setupMinutes: 0,
      turnaroundMinutes: 0,
    });
  });

  it('SCRUM178_AC2_toBookingEntry_maps_an_array_embed_and_a_missing_one', () => {
    // SCRUM-484: no embed any more -- the name is flat. Kept for its second
    // half: a missing name is null, not an error.
    expect(toBookingEntry(bookingRow({ event_name: 'Gala' })).eventName).toBe('Gala');
    const { event_name: _ignored, ...bare } = bookingRow();
    expect(toBookingEntry(bare).eventName).toBeNull();
  });

  it('SCRUM178_AC2_toBookingEntry_leaves_out_raw_columns', () => {
    const entry = toBookingEntry(bookingRow());
    expect(Object.keys(entry).sort()).toEqual([
      'endsAt', 'eventName', 'eventRequestId', 'id', 'kind',
      'occupiedEndsAt', 'occupiedStartsAt', 'setupMinutes', 'startsAt', 'status',
      'turnaroundMinutes',
    ]);
  });

  it('SCRUM178_AC2_toBlockEntry_keeps_only_the_calendar_fields', () => {
    const block = {
      id: BLOCK_A,
      venueId: VENUE_ID,
      startsAt: '2026-10-03T01:00:00+00:00',
      endsAt: '2026-10-03T09:00:00+00:00',
      reason: 'other',
      notes: 'Exam hall setup',
      createdBy: STAFF_ID,
      lastModifiedBy: STAFF_ID,
      createdAt: '2026-09-23T00:00:00+00:00',
      updatedAt: '2026-09-23T00:00:00+00:00',
      removedAt: null,
      removedBy: null,
    };

    expect(toBlockEntry(block)).toEqual({
      kind: 'block',
      id: BLOCK_A,
      startsAt: '2026-10-03T01:00:00+00:00',
      endsAt: '2026-10-03T09:00:00+00:00',
      reason: 'other',
      notes: 'Exam hall setup',
    });
  });
});


describe('SCRUM484 the calendar reads bookings through the shared occupancy function', () => {
  // D = 2026-11-11, +08:00. Booking A 10:00-12:00 at a 30/45 venue occupies
  // 09:30-12:45 (AC3's worked example).
  const D_WINDOW = { from: '2026-11-11T08:00:00+08:00', to: '2026-11-11T09:45:00+08:00' };
  const WORKED = {
    starts_at: '2026-11-11T10:00:00+08:00',
    ends_at: '2026-11-11T12:00:00+08:00',
    occupied_starts_at: '2026-11-11T09:30:00+08:00',
    occupied_ends_at: '2026-11-11T12:45:00+08:00',
    setup_minutes: 30,
    turnaround_minutes: 45,
  };

  it('SCRUM484_AC4_calendar_reads_bookings_by_occupied_period', async () => {
    // B-AC4-13: the window 08:00-09:45 misses A's raw 10:00 start but meets
    // its 09:30 setup. Which rows meet it is the shared function's decision;
    // the service asks it, unpadded, and filters nothing on raw columns.
    const { venue_blocks: blocks } = givenTables({ bookings: ok([bookingRow(WORKED)]) });

    const entries = await getVenueCalendar(VENUE_ID, D_WINDOW);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(OCCUPANCY_RPC, {
      p_venue_id: VENUE_ID,
      p_starts_at: D_WINDOW.from,
      p_ends_at: D_WINDOW.to,
      p_pad_requested: false,
    });
    // No raw lt('starts_at')/gt('ends_at') on bookings: bookings is not a table read.
    expect(from.mock.calls.map(([t]) => t)).not.toContain('bookings');
    // Blocks still come from listVenueBlocks, with their raw window.
    expect(blocks.args('lt')).toEqual(['starts_at', D_WINDOW.to]);
    expect(blocks.args('gt')).toEqual(['ends_at', D_WINDOW.from]);
    expect(entries.map((e) => [e.kind, e.id])).toEqual([['booking', BOOKING_A]]);
  });

  it('SCRUM484_AC4_calendar_drops_block_rows_from_the_shared_function', async () => {
    // The function answers blocks too, but the calendar takes blocks from
    // listVenueBlocks (which keeps notes). A block row from the rpc must not
    // appear twice, nor as a booking.
    givenTables({
      bookings: ok([occupancyBlockRow(), bookingRow()]),
      blocks: ok([blockRow()]),
    });

    const entries = await getVenueCalendar(VENUE_ID, WINDOW);

    expect(entries.map((e) => [e.kind, e.id])).toEqual([
      ['block', BLOCK_A],
      ['booking', BOOKING_A],
    ]);
    expect(entries.map((e) => e.id)).not.toContain(BLOCK_B);
  });

  it('SCRUM484_AC4_calendar_translates_an_rpc_error', async () => {
    givenTables({ bookings: fail({ code: '22P02', message: 'invalid input syntax for type uuid' }) });

    const err = await errorFromAsync(() => getVenueCalendar(VENUE_ID, WINDOW));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe('A value was rejected by the database: invalid input syntax for type uuid');

    givenTables({ bookings: fail({ code: 'PGRST202', message: 'Could not find the function' }) });
    const other = await errorFromAsync(() => getVenueCalendar(VENUE_ID, WINDOW));
    expect(other).not.toBeInstanceOf(AppError);
    expect(other.message).toBe('Could not find the function');
  });

  it('SCRUM484_AC7_calendar_booking_entry_carries_its_occupied_period', () => {
    // B-AC7-01: passed through as the database computed them, never redone.
    expect(toBookingEntry(bookingRow(WORKED))).toEqual({
      kind: 'booking',
      id: BOOKING_A,
      startsAt: '2026-11-11T10:00:00+08:00',
      endsAt: '2026-11-11T12:00:00+08:00',
      status: 'approved',
      eventRequestId: REQUEST_A,
      eventName: 'Freshmen Orientation',
      occupiedStartsAt: '2026-11-11T09:30:00+08:00',
      occupiedEndsAt: '2026-11-11T12:45:00+08:00',
      setupMinutes: 30,
      turnaroundMinutes: 45,
    });
  });

  it('SCRUM484_AC7_calendar_block_entry_has_no_occupied_period', async () => {
    // B-AC7-02: a block is never padded, and its entry says nothing of setup.
    givenTables({ blocks: ok([blockRow()]) });

    const [entry] = await getVenueCalendar(VENUE_ID, WINDOW);

    expect(entry.kind).toBe('block');
    for (const key of ['occupiedStartsAt', 'occupiedEndsAt', 'setupMinutes', 'turnaroundMinutes']) {
      expect(entry).not.toHaveProperty(key);
    }
  });
});


// ---------------------------------------------------------------------------
// SCRUM-491 (AC6, AC7): tentative holds are the third kind of entry. They
// arrive from the same venue_occupancy_conflicts() call as bookings, which
// (040) returns only active holds whose expiry is still ahead, so the
// calendar shows exactly the holds that occupy the venue.
// ---------------------------------------------------------------------------
const HOLD_A = 'd0000000-0000-4000-8000-00000000000a';

/** A kind = 'hold' row as venue_occupancy_conflicts() (040) returns it. */
function holdRow(overrides = {}) {
  return {
    kind: 'hold',
    id: HOLD_A,
    status: null,
    event_request_id: REQUEST_B,
    event_name: 'Career Fair',
    reason: null,
    starts_at: '2026-10-06T02:00:00+00:00',
    ends_at: '2026-10-06T04:00:00+00:00',
    occupied_starts_at: '2026-10-06T01:30:00+00:00',
    occupied_ends_at: '2026-10-06T04:45:00+00:00',
    setup_minutes: 30,
    turnaround_minutes: 45,
    ...overrides,
  };
}

describe('SCRUM491_AC6 holds on the calendar', () => {
  it('SCRUM491_AC6_an_active_hold_is_a_hold_entry_naming_the_holding_event', async () => {
    givenTables({ bookings: ok([bookingRow(), holdRow(), occupancyBlockRow()]), blocks: ok([blockRow()]) });

    const entries = await getVenueCalendar(VENUE_ID, WINDOW);

    expect(entries.map((e) => e.kind)).toEqual(['block', 'booking', 'hold']);
    expect(entries[2]).toEqual({
      kind: 'hold',
      id: HOLD_A,
      startsAt: '2026-10-06T02:00:00+00:00',
      endsAt: '2026-10-06T04:00:00+00:00',
      eventRequestId: REQUEST_B,
      eventName: 'Career Fair',
      occupiedStartsAt: '2026-10-06T01:30:00+00:00',
      occupiedEndsAt: '2026-10-06T04:45:00+00:00',
      setupMinutes: 30,
      turnaroundMinutes: 45,
    });
  });

  it('SCRUM491_AC7_the_calendar_asks_with_four_arguments_so_no_hold_is_excluded', async () => {
    givenTables({ bookings: ok([holdRow()]) });

    await getVenueCalendar(VENUE_ID, WINDOW);

    expect(Object.keys(occupancyArgs()).sort()).toEqual(['p_ends_at', 'p_pad_requested', 'p_starts_at', 'p_venue_id']);
  });

  it('SCRUM491_AC6_toHoldEntry_reads_a_missing_event_name_as_null', () => {
    expect(toHoldEntry(holdRow({ event_name: undefined })).eventName).toBeNull();
  });
});
