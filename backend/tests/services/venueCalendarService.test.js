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
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { supabase } from '../../src/config/supabaseClient.js';
import {
  getVenueCalendar,
  toBookingEntry,
  toBlockEntry,
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

const BOOKING_SELECT = 'id, event_request_id, starts_at, ends_at, status, event_requests(event_name)';

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

function bookingRow(overrides = {}) {
  return {
    id: BOOKING_A,
    event_request_id: REQUEST_A,
    starts_at: '2026-10-05T01:00:00+00:00',
    ends_at: '2026-10-05T04:00:00+00:00',
    status: 'approved',
    event_requests: { event_name: 'Freshmen Orientation' },
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

/** Route from() by table name; any other table is a test failure. */
function givenTables({ venue = ok(venueRow()), bookings = ok([]), blocks = ok([]) } = {}) {
  const stubs = {
    venues: queryStub(venue),
    bookings: queryStub(bookings),
    venue_blocks: queryStub(blocks),
  };
  from.mockImplementation((table) => {
    if (!(table in stubs)) throw new Error(`unexpected table ${table}`);
    return stubs[table];
  });
  return stubs;
}

const tablesQueried = () => from.mock.calls.map(([table]) => table);

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
    expect(rpc).not.toHaveBeenCalled();
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
    const { bookings, venue_blocks: blocks } = givenTables({
      venue: ok(venueRow({ retired_at: '2025-06-01T00:00:00+00:00' })),
      bookings: ok([bookingRow({ starts_at: '2025-01-10T01:00:00+00:00', ends_at: '2025-01-10T03:00:00+00:00' })]),
    });

    const entries = await getVenueCalendar(VENUE_ID, past);

    expect(entries).toHaveLength(1);
    expect(entries[0].startsAt).toBe('2025-01-10T01:00:00+00:00');
    expect(bookings.args('lt')).toEqual(['starts_at', past.to]);
    expect(bookings.args('gt')).toEqual(['ends_at', past.from]);
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
      },
    ]);
  });

  it('SCRUM178_AC2_flagged_booking_carries_flagged_for_review', async () => {
    givenTables({
      bookings: ok([bookingRow({ status: 'flagged_for_review', event_requests: { event_name: 'Career Fair' } })]),
    });

    const [entry] = await getVenueCalendar(VENUE_ID, WINDOW);

    expect(entry).toMatchObject({ kind: 'booking', status: 'flagged_for_review', eventName: 'Career Fair' });
  });

  it('SCRUM178_AC2_event_name_from_a_one_element_array_embed', async () => {
    givenTables({ bookings: ok([bookingRow({ event_requests: [{ event_name: 'Hackathon' }] })]) });

    const [entry] = await getVenueCalendar(VENUE_ID, WINDOW);

    expect(entry.eventName).toBe('Hackathon');
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['an empty array', []],
    ['an object without event_name', {}],
  ])('SCRUM178_AC2_event_name_is_null_when_the_embed_is_%s', async (_label, embed) => {
    givenTables({ bookings: ok([bookingRow({ event_requests: embed })]) });

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
  it('SCRUM178_AC3_bookings_query_is_an_allow_list_of_approved_and_flagged', async () => {
    const { bookings } = givenTables();

    await getVenueCalendar(VENUE_ID, WINDOW);

    expect(bookings.args('select')).toEqual([BOOKING_SELECT]);
    expect(bookings.args('eq')).toEqual(['venue_id', VENUE_ID]);
    expect(bookings.args('in')).toEqual(['status', ['approved', 'flagged_for_review']]);
    expect(bookings.allArgs('in')).toHaveLength(1);
    // Pending is not in the allow-list (cancelled is checked under AC5).
    expect(bookings.args('in')[1]).not.toContain('pending');
    // An allow-list, not a "not cancelled" filter.
    expect(bookings.called('not')).toBe(false);
  });

  it('SCRUM178_AC3_pending_request_has_no_booking_so_never_reaches_the_calendar', async () => {
    // A pending event request has no bookings row: a booking only exists once
    // a request is approved, and the status vocabulary has no 'pending'. The
    // calendar reads bookings through an allow-list, so even a status added
    // later is hidden until someone puts it on the list.
    const { bookings } = givenTables();

    await getVenueCalendar(VENUE_ID, WINDOW);

    expect(bookings.args('in')).toEqual([
      'status',
      [BOOKING_STATUS.APPROVED, BOOKING_STATUS.FLAGGED_FOR_REVIEW],
    ]);
    expect(Object.values(BOOKING_STATUS)).not.toContain('pending');
    expect(tablesQueried()).not.toContain('event_requests');
  });
});


describe('SCRUM178_AC5 cancelled bookings and removed blocks are not shown', () => {
  it('SCRUM178_AC5_bookings_query_leaves_out_cancelled_bookings', async () => {
    const { bookings } = givenTables();

    await getVenueCalendar(VENUE_ID, WINDOW);

    expect(bookings.args('in')[1]).not.toContain('cancelled');
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
    const { bookings } = givenTables();

    await getVenueCalendar(VENUE_ID, WINDOW);

    expect(bookings.args('lt')).toEqual(['starts_at', TO]);
    expect(bookings.args('gt')).toEqual(['ends_at', FROM]);
    expect(bookings.called('lte')).toBe(false);
    expect(bookings.called('gte')).toBe(false);
  });

  it('SCRUM178_AC1_window_is_trimmed_before_it_reaches_the_queries', async () => {
    const { bookings } = givenTables();

    await getVenueCalendar(VENUE_ID, { from: ` ${FROM} `, to: `${TO}  ` });

    expect(bookings.args('lt')).toEqual(['starts_at', TO]);
    expect(bookings.args('gt')).toEqual(['ends_at', FROM]);
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
    const { bookings } = givenTables();
    const to = new Date(Date.parse('2026-01-01T00:00:00Z') + 400 * DAY_MS).toISOString();

    await expect(getVenueCalendar(VENUE_ID, { from: '2026-01-01T00:00:00Z', to })).resolves.toEqual([]);
    expect(bookings.args('lt')).toEqual(['starts_at', to]);
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
    });
  });

  it('SCRUM178_AC2_toBookingEntry_maps_an_array_embed_and_a_missing_one', () => {
    expect(toBookingEntry(bookingRow({ event_requests: [{ event_name: 'Gala' }] })).eventName).toBe('Gala');
    const { event_requests: _ignored, ...bare } = bookingRow();
    expect(toBookingEntry(bare).eventName).toBeNull();
  });

  it('SCRUM178_AC2_toBookingEntry_leaves_out_raw_columns', () => {
    const entry = toBookingEntry(bookingRow());
    expect(Object.keys(entry).sort()).toEqual(
      ['endsAt', 'eventName', 'eventRequestId', 'id', 'kind', 'startsAt', 'status'],
    );
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
