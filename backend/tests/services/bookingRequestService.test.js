/**
 * Unit tests for the booking request service.
 *
 * SCRUM-256. tests/routes/bookingRequests.test.js drives the service through
 * HTTP; these cover what a route cannot reach -- a caller with no id -- and pin
 * how each Postgres error the two functions raise becomes a typed error, which
 * the route tests only sample. The client is a queue-fed fake, so nothing here
 * needs credentials.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  createBookingRequest,
  withdrawBookingRequest,
  listBookingRequestsForCoordinator,
  toBookingRequest,
} from '../../src/services/bookingRequestService.js';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} from '../../src/errors.js';

const USER = '55555555-5555-4555-8555-555555555555';
const EVENT = '22222222-2222-4222-8222-222222222222';
const VENUE = '33333333-3333-4333-8333-333333333333';
const BOOKING = '44444444-4444-4444-8444-444444444444';
const SUITABLE = { suitable: true, criteria: [] };

const eventRow = () => ({
  id: EVENT,
  organiser_id: USER,
  event_name: 'Gala',
  status: 'approved',
  assigned_coordinator_id: USER,
  proposed_start: '2026-12-01T09:00:00+00:00',
  proposed_end: '2026-12-01T17:00:00+00:00',
});

/** A client that answers the event read, then the rpc, in that order. */
function clientAnswering(...results) {
  const queue = [...results];
  const calls = [];
  const next = () => Promise.resolve(queue.shift());
  return {
    calls,
    from(table) {
      calls.push({ table });
      const chain = { select: () => chain, eq: () => chain, maybeSingle: next, order: () => chain, then: (a, b) => next().then(a, b) };
      return chain;
    },
    rpc(fn, args) {
      calls.push({ fn, args });
      return next();
    },
  };
}

const failure = (code, message = 'db message', extra = {}) => ({ data: null, error: { code, message, ...extra } });
const checker = () => vi.fn(async () => SUITABLE);

const create = (client) =>
  createBookingRequest({ eventRequestId: EVENT, venueId: VENUE }, USER, { client, checkSuitability: checker() });

describe('the caller is required', () => {
  it.each([undefined, null, '', '   ', 42])('SCRUM256_creating_with_the_user_%j_is_refused_before_any_call', async (user) => {
    const client = clientAnswering();
    await expect(createBookingRequest({ eventRequestId: EVENT, venueId: VENUE }, user, { client })).rejects.toBeInstanceOf(ValidationError);
    expect(client.calls).toHaveLength(0);
  });

  it.each([undefined, null, '', '   '])('SCRUM256_withdrawing_with_the_user_%j_is_refused_before_any_call', async (user) => {
    const client = clientAnswering();
    await expect(withdrawBookingRequest(BOOKING, user, { client })).rejects.toBeInstanceOf(ValidationError);
    expect(client.calls).toHaveLength(0);
  });

  it.each([undefined, null, '', '  ', 7])('SCRUM256_listing_for_the_user_%j_is_refused_before_any_call', async (user) => {
    const client = clientAnswering();
    const err = await listBookingRequestsForCoordinator(user, { client }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'coordinatorId', message: 'is required' }]);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM256_withdrawing_a_malformed_id_is_refused_before_any_call', async () => {
    const client = clientAnswering();
    await expect(withdrawBookingRequest('nope', USER, { client })).rejects.toBeInstanceOf(ValidationError);
    expect(client.calls).toHaveLength(0);
  });
});

describe('how database errors from create_booking_request become typed errors', () => {
  it.each(['23514', '22023', '23502', '22P02', '23503'])('SCRUM256_%s_is_a_validation_error', async (code) => {
    const err = await create(clientAnswering({ data: eventRow(), error: null }, failure(code))).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
  });

  it('SCRUM256_P0002_is_not_found', async () => {
    const err = await create(clientAnswering({ data: eventRow(), error: null }, failure('P0002', 'venue not found'))).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it('SCRUM256_P0002_with_no_message_still_says_what_is_missing', async () => {
    const err = await create(clientAnswering({ data: eventRow(), error: null }, { data: null, error: { code: 'P0002' } })).catch((e) => e);
    expect(err.message).toBe('Event request or venue not found');
  });

  it('SCRUM256_42501_is_forbidden', async () => {
    const err = await create(clientAnswering({ data: eventRow(), error: null }, failure('42501'))).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
  });

  it.each([
    ['VENUE_RETIRED', undefined, []],
    ['EVENT_NOT_BOOKABLE', undefined, []],
    ['BOOKING_REQUEST_EXISTS', BOOKING, [{ kind: 'booking_request', bookingId: BOOKING }]],
    ['BOOKING_FLAGGED_FOR_REVIEW', BOOKING, [{ kind: 'booking_request', bookingId: BOOKING }]],
    ['BOOKING_REQUEST_EXISTS', 'not a uuid', []],
    ['BOOKING_REQUEST_EXISTS', undefined, []],
    ['VENUE_RETIRED', BOOKING, []],
  ])('SCRUM256_PT409_%s_with_detail_%s_carries_%j', async (hint, details, conflicts) => {
    const err = await create(
      clientAnswering({ data: eventRow(), error: null }, failure('PT409', 'refused', { hint, details })),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe(hint);
    expect(err.conflicts).toEqual(conflicts);
  });

  it('SCRUM256_PT409_with_no_hint_is_a_conflict_with_no_code', async () => {
    const err = await create(clientAnswering({ data: eventRow(), error: null }, failure('PT409'))).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBeNull();
  });

  it('SCRUM256_40001_is_a_changed_booking_conflict', async () => {
    const err = await create(clientAnswering({ data: eventRow(), error: null }, failure('40001'))).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('BOOKING_CHANGED');
  });

  it('SCRUM256_an_unrecognised_code_stays_untyped_so_it_is_a_500', async () => {
    const err = await create(clientAnswering({ data: eventRow(), error: null }, failure('XX000', 'boom'))).catch((e) => e);
    expect(err.constructor).toBe(Error);
    expect(err.message).toBe('boom');
  });

  it('SCRUM256_an_error_with_no_message_still_has_one', async () => {
    const err = await create(clientAnswering({ data: eventRow(), error: null }, { data: null, error: { code: 'XX000' } })).catch((e) => e);
    expect(err.message).toBe('Unexpected database error');
  });
});

describe('withdrawBookingRequest', () => {
  it('SCRUM256_returns_the_withdrawn_request', async () => {
    const row = { id: BOOKING, event_request_id: EVENT, venue_id: VENUE, status: 'withdrawn' };
    const client = clientAnswering({ data: { outcome: 'withdrawn', booking: row }, error: null });

    await expect(withdrawBookingRequest(BOOKING.toUpperCase(), USER, { client })).resolves.toMatchObject({
      id: BOOKING,
      status: 'withdrawn',
    });
    expect(client.calls[0]).toEqual({ fn: 'withdraw_booking_request', args: { p_booking_id: BOOKING, p_requested_by: USER } });
  });

  it('SCRUM256_refuses_a_booking_the_function_reports_as_still_pending', async () => {
    const client = clientAnswering({ data: { outcome: 'withdrawn', booking: { id: BOOKING, status: 'pending' } }, error: null });
    await expect(withdrawBookingRequest(BOOKING, USER, { client })).rejects.toThrow(/not a withdrawn one/);
  });

  it.each([null, undefined])('SCRUM256_refuses_an_empty_answer_%s', async (data) => {
    await expect(withdrawBookingRequest(BOOKING, USER, { client: clientAnswering({ data, error: null }) })).rejects.toThrow(
      /Unexpected outcome/,
    );
  });
});

describe('toBookingRequest', () => {
  it('SCRUM256_reads_a_row_with_only_the_columns_every_booking_has', () => {
    expect(
      toBookingRequest({ id: BOOKING, event_request_id: EVENT, venue_id: VENUE, status: 'approved', starts_at: 'a', ends_at: 'b', created_at: 'c' }),
    ).toEqual({
      id: BOOKING,
      eventRequestId: EVENT,
      venueId: VENUE,
      status: 'approved',
      startsAt: 'a',
      endsAt: 'b',
      roomLayoutCode: null,
      venueRequirements: null,
      accessibilityRequirements: null,
      setupNotes: null,
      suitability: null,
      suitabilityOverridden: false,
      requestedBy: null,
      createdAt: 'c',
    });
  });
});

describe('SCRUM484 booking request conflicts carry the occupied period', () => {
  const BLOCK = '66666666-6666-4666-8666-666666666666';
  const OTHER_EVENT = '77777777-7777-4777-8777-777777777777';

  it('SCRUM484_AC7_booking_request_conflicts_carry_occupied_periods', async () => {
    // B-AC7-03. create_booking_request (033) answers both kinds from
    // venue_occupancy_conflicts with the four occupied keys. A booking's
    // occupied period is padded by the venue's 30/45; a block's equals its
    // own period, and its minutes are the venue's (how far this event's own
    // setup and turnaround reached into it).
    //
    // NOTE: the test-case doc (B-AC7-03) says the block item carries "none of"
    // the four fields. Production (toPeriodConflict, per the plan's 033
    // comment) maps them on block items too. This pins what production does;
    // the occupied times on a block equal its own, so nothing is padded.
    const bookingEntry = {
      kind: 'booking',
      booking_id: BOOKING,
      event_request_id: OTHER_EVENT,
      event_name: 'Orientation',
      starts_at: '2026-11-11T10:00:00+08:00',
      ends_at: '2026-11-11T12:00:00+08:00',
      occupied_starts_at: '2026-11-11T09:30:00+08:00',
      occupied_ends_at: '2026-11-11T12:45:00+08:00',
      setup_minutes: 30,
      turnaround_minutes: 45,
    };
    const blockEntry = {
      kind: 'block',
      block_id: BLOCK,
      starts_at: '2026-11-11T14:00:00+08:00',
      ends_at: '2026-11-11T15:00:00+08:00',
      reason: 'maintenance',
      occupied_starts_at: '2026-11-11T14:00:00+08:00',
      occupied_ends_at: '2026-11-11T15:00:00+08:00',
      setup_minutes: 30,
      turnaround_minutes: 45,
    };
    const client = clientAnswering(
      { data: eventRow(), error: null },
      { data: { outcome: 'conflict', conflicts: [blockEntry, bookingEntry] }, error: null },
    );

    const err = await create(client).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('BOOKING_PERIOD_CONFLICT');
    const [block, booking] = err.conflicts;
    expect(booking).toMatchObject({
      kind: 'booking',
      bookingId: BOOKING,
      eventRequestId: OTHER_EVENT,
      eventName: 'Orientation',
      startsAt: '2026-11-11T10:00:00+08:00',
      endsAt: '2026-11-11T12:00:00+08:00',
      occupiedStartsAt: '2026-11-11T09:30:00+08:00',
      occupiedEndsAt: '2026-11-11T12:45:00+08:00',
      setupMinutes: 30,
      turnaroundMinutes: 45,
    });
    expect(block).toMatchObject({
      kind: 'block',
      startsAt: '2026-11-11T14:00:00+08:00',
      endsAt: '2026-11-11T15:00:00+08:00',
      reason: 'maintenance',
    });
    // A block is never padded: whatever occupied times it carries are its own.
    expect(block.occupiedStartsAt).toBe(block.startsAt);
    expect(block.occupiedEndsAt).toBe(block.endsAt);
    expect(block).not.toHaveProperty('eventName');
  });
});

describe('SCRUM484_AC8 the coordinator list carries the review reason', () => {
  /** A bookings row as LIST_COLUMNS reads it, assigned to USER. */
  const listRow = (overrides = {}) => ({
    id: BOOKING,
    event_request_id: EVENT,
    venue_id: VENUE,
    starts_at: '2026-12-01T09:00:00+00:00',
    ends_at: '2026-12-01T17:00:00+00:00',
    status: 'flagged_for_review',
    room_layout_code: null,
    setup_notes: null,
    suitability_overridden: false,
    created_at: '2026-10-06T10:00:00+00:00',
    flagged_at: '2026-10-07T10:00:00+00:00',
    venues: { name: 'Harbour Room', location: 'Block A' },
    event_requests: { event_name: 'Gala', status: 'approved', assigned_coordinator_id: USER },
    ...overrides,
  });

  /** A client whose list read answers `rows`, recording the select it was sent. */
  function listClient(rows) {
    const selects = [];
    const chain = {
      select: (columns) => {
        selects.push(columns);
        return chain;
      },
      eq: () => chain,
      order: () => chain,
      then: (a, b) => Promise.resolve({ data: rows, error: null }).then(a, b),
    };
    return { selects, from: () => chain };
  }

  it('SCRUM484_AC8_reviewReason_is_mapped_from_review_reason', async () => {
    const client = listClient([listRow({ review_reason: 'setup_or_turnaround_changed' })]);

    const [item] = await listBookingRequestsForCoordinator(USER, { client });

    expect(item.reviewReason).toBe('setup_or_turnaround_changed');
    expect(item.flaggedAt).toBe('2026-10-07T10:00:00+00:00');
    expect(item).not.toHaveProperty('review_reason');
    // The column is asked for, so the mapping has something to read.
    expect(client.selects[0]).toMatch(/\breview_reason\b/);
  });

  it.each([
    ['null', { review_reason: null }],
    ['absent', {}],
  ])('SCRUM484_AC8_reviewReason_is_null_when_review_reason_is_%s', async (_label, overrides) => {
    // A block flag (014) has no reason; neither has an unflagged booking.
    const client = listClient([
      listRow(overrides),
      listRow({ ...overrides, id: '66666666-6666-4666-8666-666666666666', status: 'pending', flagged_at: null }),
    ]);

    const items = await listBookingRequestsForCoordinator(USER, { client });

    expect(items.map((i) => i.reviewReason)).toEqual([null, null]);
  });
});

describe('SCRUM188 the booking request carries the requirement codes to the check (SCRUM-190)', () => {
  const pendingRow = { id: BOOKING, event_request_id: EVENT, venue_id: VENUE, status: 'pending' };
  const createdAnswer = { data: { outcome: 'created', booking: pendingRow }, error: null };

  it('SCRUM188_AC1_forwards_the_codes_and_the_caller_to_the_checker', async () => {
    const checkSuitability = checker();
    const client = clientAnswering({ data: eventRow(), error: null }, createdAnswer);

    await createBookingRequest(
      {
        eventRequestId: EVENT,
        venueId: VENUE,
        roomLayoutCode: 'theatre',
        accessibility: ['wheelchair_access'],
        facilities: [' projector '],
      },
      USER,
      { client, checkSuitability },
    );

    expect(checkSuitability).toHaveBeenCalledWith({
      eventRequestId: EVENT,
      venueId: VENUE,
      roomLayoutCode: 'theatre',
      accessibility: ['wheelchair_access'],
      facilities: ['projector'],
      userId: USER,
      client,
    });
  });

  it('SCRUM188_AC1_no_codes_reach_the_checker_as_empty_lists', async () => {
    const checkSuitability = checker();
    await createBookingRequest({ eventRequestId: EVENT, venueId: VENUE }, USER, {
      client: clientAnswering({ data: eventRow(), error: null }, createdAnswer),
      checkSuitability,
    });
    expect(checkSuitability.mock.calls[0][0]).toMatchObject({ accessibility: [], facilities: [] });
  });

  it('SCRUM188_AC2_keeps_what_was_checked_in_the_stored_result', async () => {
    const checked = {
      startsAt: '2026-12-01T09:00:00+00:00',
      endsAt: '2026-12-01T17:00:00+00:00',
      expectedAttendance: 120,
      layout: 'theatre',
      accessibility: [],
      facilities: ['projector'],
    };
    const result = { suitable: true, criteria: [{ criterion: 'Capacity', met: true, detail: 'x' }], checked };
    const client = clientAnswering({ data: eventRow(), error: null }, createdAnswer);

    await createBookingRequest({ eventRequestId: EVENT, venueId: VENUE }, USER, {
      client,
      checkSuitability: vi.fn(async () => result),
    });

    expect(client.calls.at(-1).args.p_suitability).toEqual(result);
  });

  it('SCRUM188_AC2_a_result_without_checked_is_stored_without_one', async () => {
    const client = clientAnswering({ data: eventRow(), error: null }, createdAnswer);
    await createBookingRequest({ eventRequestId: EVENT, venueId: VENUE }, USER, {
      client,
      checkSuitability: vi.fn(async () => ({ suitable: true, criteria: [], checked: null, extra: 'dropped' })),
    });
    expect(client.calls.at(-1).args.p_suitability).toEqual({ suitable: true, criteria: [] });
  });

  it('SCRUM188_AC1_an_error_from_the_check_stops_the_request_before_anything_is_written', async () => {
    const client = clientAnswering({ data: eventRow(), error: null });
    const refusal = new ValidationError('Invalid suitability check -- facilities: unknown code "x"');
    const err = await createBookingRequest({ eventRequestId: EVENT, venueId: VENUE, facilities: ['x'] }, USER, {
      client,
      checkSuitability: vi.fn(async () => {
        throw refusal;
      }),
    }).catch((e) => e);
    expect(err).toBe(refusal);
    expect(client.calls.filter((c) => c.fn)).toHaveLength(0);
  });
});
