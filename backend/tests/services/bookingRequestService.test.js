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
  approveBookingRequest,
  createBookingRequest,
  rejectBookingRequest,
  withdrawBookingRequest,
  listBookingRequestsForCoordinator,
  listPendingBookingRequests,
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
  // SCRUM-525: an attendance to default to, as every requestable event has
  // in practice; the cases without one set it to null explicitly.
  expected_attendance: 150,
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
      expectedAttendance: null,
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
      expectedAttendance: 150,
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

describe('SCRUM525_AC2 each request carries its own expected attendance', () => {
  /**
   * A client that answers the event read, then answers the rpc as 051 does:
   * the created booking holds the p_expected_attendance it was sent. So a
   * response's expectedAttendance can only be right if the service sent the
   * right number and mapped the row back, not because a fixture said so.
   */
  function storingClient(event) {
    const calls = [];
    return {
      calls,
      from(table) {
        calls.push({ table });
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: event, error: null }),
        };
        return chain;
      },
      rpc(fn, args) {
        calls.push({ fn, args });
        const booking = {
          id: BOOKING,
          event_request_id: args.p_event_request_id,
          venue_id: args.p_venue_id,
          status: 'pending',
          expected_attendance: args.p_expected_attendance,
        };
        return Promise.resolve({ data: { outcome: 'created', booking }, error: null });
      },
    };
  }

  const rpcArgs = (client) => client.calls.find((c) => c.fn === 'create_booking_request').args;

  it('SCRUM525_AC2_without_attendance_the_events_reaches_the_check_and_the_rpc', async () => {
    // B-AC2-05 (R4): absent, the default is the event's 150, and it is the one
    // number both judged and stored.
    const checkSuitability = checker();
    const client = storingClient(eventRow());

    const booking = await createBookingRequest({ eventRequestId: EVENT, venueId: VENUE }, USER, {
      client,
      checkSuitability,
    });

    expect(checkSuitability.mock.calls[0][0].expectedAttendance).toBe(150);
    expect(rpcArgs(client).p_expected_attendance).toBe(150);
    expect(booking.expectedAttendance).toBe(150);
  });

  it('SCRUM525_AC2_a_given_attendance_is_the_one_checked_and_stored', async () => {
    // B-AC2-06 (R4): 40 for this venue against an event of 150. If the check
    // saw one number and the rpc another, the stored verdict would be about a
    // different crowd from the one Venue Staff are asked to host.
    const checkSuitability = checker();
    const client = storingClient(eventRow());

    const booking = await createBookingRequest(
      { eventRequestId: EVENT, venueId: VENUE, expectedAttendance: 40 },
      USER,
      { client, checkSuitability },
    );

    expect(checkSuitability.mock.calls[0][0].expectedAttendance).toBe(40);
    expect(rpcArgs(client).p_expected_attendance).toBe(40);
    expect(booking.expectedAttendance).toBe(40);
  });

  it('SCRUM525_AC2_no_attendance_anywhere_is_409_and_nothing_is_written', async () => {
    // B-AC2-07 (R12): neither the request nor the event gives a number, so
    // there is nothing to judge Capacity on or to store. Refused after the
    // event read and before the check: only event_requests was read.
    const checkSuitability = checker();
    const client = storingClient({ ...eventRow(), expected_attendance: null });

    const err = await createBookingRequest({ eventRequestId: EVENT, venueId: VENUE }, USER, {
      client,
      checkSuitability,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('EVENT_ATTENDANCE_MISSING');
    expect(checkSuitability).not.toHaveBeenCalled();
    expect(client.calls).toEqual([{ table: 'event_requests' }]);
  });

  it('SCRUM525_AC2_an_event_without_attendance_can_still_be_requested_with_one', async () => {
    // B-AC2-07's pair (R12): the refusal is for no number anywhere, not for
    // an event without one. Given 40, the request goes through on 40.
    const checkSuitability = checker();
    const client = storingClient({ ...eventRow(), expected_attendance: null });

    const booking = await createBookingRequest(
      { eventRequestId: EVENT, venueId: VENUE, expectedAttendance: 40 },
      USER,
      { client, checkSuitability },
    );

    expect(checkSuitability.mock.calls[0][0].expectedAttendance).toBe(40);
    expect(rpcArgs(client).p_expected_attendance).toBe(40);
    expect(booking.status).toBe('pending');
  });

  it('SCRUM525_AC2_attendance_above_the_events_is_a_field_error_and_nothing_runs', async () => {
    // 151 for one venue of an event expecting 150: refused on the field,
    // before the check or the rpc, so nothing is judged or written.
    const checkSuitability = checker();
    const client = storingClient(eventRow());

    const err = await createBookingRequest(
      { eventRequestId: EVENT, venueId: VENUE, expectedAttendance: 151 },
      USER,
      { client, checkSuitability },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([
      { field: 'expectedAttendance', message: expect.stringContaining('(150)') },
    ]);
    expect(checkSuitability).not.toHaveBeenCalled();
    expect(client.calls).toEqual([{ table: 'event_requests' }]);
  });

  it('SCRUM525_AC2_attendance_equal_to_the_events_is_accepted', async () => {
    // The boundary: the whole event at one venue is allowed.
    const client = storingClient(eventRow());

    const booking = await createBookingRequest(
      { eventRequestId: EVENT, venueId: VENUE, expectedAttendance: 150 },
      USER,
      { client, checkSuitability: checker() },
    );

    expect(rpcArgs(client).p_expected_attendance).toBe(150);
    expect(booking.expectedAttendance).toBe(150);
  });

  it('SCRUM525_AC2_a_stranger_is_refused_before_the_attendance_is_considered', async () => {
    // The order the brief fixes: the coordinator check comes first, so an
    // event with no attendance answers a stranger 403, not a 409 that would
    // tell them something about the event.
    const client = storingClient({
      ...eventRow(),
      assigned_coordinator_id: '99999999-9999-4999-8999-999999999999',
      expected_attendance: null,
    });

    const err = await createBookingRequest({ eventRequestId: EVENT, venueId: VENUE }, USER, {
      client,
      checkSuitability: checker(),
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ForbiddenError);
  });

  it('SCRUM525_AC2_an_attendance_beyond_the_integer_range_is_a_400', async () => {
    // 3000000000 cannot be stored as a Postgres integer. checkAttendance
    // refuses it (MAX_ATTENDANCE) before any call; should that ever be
    // skipped, the 22003 from the cast still maps to a 400, not a 500.
    const client = clientAnswering(
      { data: eventRow(), error: null },
      failure('22003', 'value "3000000000" is out of range for type integer'),
    );

    const err = await createBookingRequest(
      { eventRequestId: EVENT, venueId: VENUE, expectedAttendance: 3000000000 },
      USER,
      { client, checkSuitability: checker() },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
  });
});

describe('SCRUM258_AC1 the Venue Staff queue of pending requests', () => {
  const OTHER_EVENT = '66666666-6666-4666-8666-666666666666';
  const OTHER_BOOKING = '77777777-7777-4777-8777-777777777777';
  const OVERRIDDEN = {
    suitable: false,
    criteria: [
      { criterion: 'Capacity', met: false },
      { criterion: 'Facilities', met: true },
      { criterion: 'Accessibility', met: false },
    ],
  };

  /** One element of list_pending_booking_requests (065), as jsonb returns it. */
  const pendingRow = (overrides = {}) => ({
    id: BOOKING,
    event_request_id: EVENT,
    event_name: 'Gala',
    event_status: 'approved',
    venue_id: VENUE,
    venue_name: 'Hall A',
    venue_location: 'Level 1',
    starts_at: '2026-12-01T10:00:00+00:00',
    ends_at: '2026-12-01T12:00:00+00:00',
    occupied_starts_at: '2026-12-01T09:30:00+00:00',
    occupied_ends_at: '2026-12-01T12:45:00+00:00',
    expected_attendance: 120,
    room_layout_code: 'theatre',
    venue_requirements: 'Tiered seating',
    accessibility_requirements: null,
    setup_notes: null,
    suitability_result: OVERRIDDEN,
    suitability_overridden: true,
    requested_by: USER,
    created_at: '2026-10-01T00:00:00+00:00',
    overlapping: [
      {
        id: OTHER_BOOKING,
        event_request_id: OTHER_EVENT,
        event_name: 'Fair',
        starts_at: '2026-12-01T12:30:00+00:00',
        ends_at: '2026-12-01T14:00:00+00:00',
        occupied_starts_at: '2026-12-01T12:00:00+00:00',
        occupied_ends_at: '2026-12-01T14:45:00+00:00',
        created_at: '2026-10-02T00:00:00+00:00',
      },
    ],
    ...overrides,
  });

  it.each([undefined, null, '', '   ', 42])('SCRUM258_AC1_listing_for_the_caller_%j_is_refused_before_any_call', async (caller) => {
    const client = clientAnswering();
    const err = await listPendingBookingRequests(caller, { client }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM258_AC1_a_caller_who_is_not_venue_staff_is_forbidden', async () => {
    const err = await listPendingBookingRequests(USER, { client: clientAnswering(failure('42501')) }).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
  });

  it('SCRUM258_AC1_shows_the_suitability_with_overrides_and_the_overlaps_in_camelCase', async () => {
    const [request] = await listPendingBookingRequests(USER, { client: clientAnswering({ data: [pendingRow()], error: null }) });

    expect(request).toMatchObject({
      id: BOOKING,
      status: 'pending',
      expectedAttendance: 120,
      occupiedStartsAt: '2026-12-01T09:30:00+00:00',
      occupiedEndsAt: '2026-12-01T12:45:00+00:00',
      suitability: { suitable: false, criteria: OVERRIDDEN.criteria },
      suitabilityOverridden: true,
      overriddenCriteria: ['Capacity', 'Accessibility'],
    });
    expect(request.overlapping).toEqual([
      {
        id: OTHER_BOOKING,
        eventRequestId: OTHER_EVENT,
        eventName: 'Fair',
        startsAt: '2026-12-01T12:30:00+00:00',
        endsAt: '2026-12-01T14:00:00+00:00',
        occupiedStartsAt: '2026-12-01T12:00:00+00:00',
        occupiedEndsAt: '2026-12-01T14:45:00+00:00',
        createdAt: '2026-10-02T00:00:00+00:00',
      },
    ]);
  });

  it('SCRUM258_AC3_a_conflicting_request_in_the_queue_keeps_its_status_and_display', async () => {
    const [request] = await listPendingBookingRequests(USER, {
      client: clientAnswering({ data: [pendingRow({ status: 'conflicting' })], error: null }),
    });

    expect(request.status).toBe('conflicting');
    expect(request.statusDisplay).toMatchObject({ label: 'Conflicting', group: 'CONFLICTING' });
  });

  it.each([null, undefined])('SCRUM258_AC1_a_%s_result_or_overlap_list_is_empty_not_an_error', async (value) => {
    expect(await listPendingBookingRequests(USER, { client: clientAnswering({ data: value, error: null }) })).toEqual([]);
    const [request] = await listPendingBookingRequests(USER, {
      client: clientAnswering({ data: [pendingRow({ overlapping: value })], error: null }),
    });
    expect(request.overlapping).toEqual([]);
  });
});

describe('SCRUM258 approving and rejecting a booking request (066)', () => {
  const STAFF = '88888888-8888-4888-8888-888888888888';
  const HOLD = '99999999-9999-4999-8999-999999999999';
  const OTHER_EVENT = '66666666-6666-4666-8666-666666666666';

  /** The booking decide_booking_request returns, as to_jsonb writes it. */
  const decidedRow = (overrides = {}) => ({
    id: BOOKING,
    event_request_id: EVENT,
    venue_id: VENUE,
    status: 'approved',
    starts_at: '2026-12-01T10:00:00+00:00',
    ends_at: '2026-12-01T12:00:00+00:00',
    created_at: '2026-10-01T00:00:00+00:00',
    decided_by: STAFF,
    decided_at: '2026-10-14T00:00:00+00:00',
    decision_reason: null,
    suggested_alternative: null,
    ...overrides,
  });
  const answer = (outcome, row) => ({ data: { outcome, booking: row }, error: null });

  it.each([undefined, null, '', '   ', 42])('SCRUM258_AC6_deciding_for_the_caller_%j_is_refused_before_any_call', async (caller) => {
    const client = clientAnswering();
    await expect(approveBookingRequest(BOOKING, caller, { client })).rejects.toBeInstanceOf(ValidationError);
    await expect(rejectBookingRequest(BOOKING, caller, { reason: 'No' }, { client })).rejects.toBeInstanceOf(ValidationError);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM258_AC6_a_malformed_id_is_refused_before_any_call', async () => {
    const client = clientAnswering();
    await expect(approveBookingRequest('nope', STAFF, { client })).rejects.toBeInstanceOf(ValidationError);
    await expect(rejectBookingRequest('nope', STAFF, { reason: 'No' }, { client })).rejects.toBeInstanceOf(ValidationError);
    expect(client.calls).toHaveLength(0);
  });

  it.each([
    ['no reason', {}],
    ['a blank reason', { reason: '' }],
    ['a whitespace reason', { reason: '   ' }],
    ['a reason over 1000 characters', { reason: 'x'.repeat(1001) }],
    ['an alternative over 1000 characters', { reason: 'No', suggestedAlternative: 'x'.repeat(1001) }],
  ])('SCRUM258_AC4_rejecting_with_%s_is_refused_before_any_call', async (_label, input) => {
    const client = clientAnswering();
    const err = await rejectBookingRequest(BOOKING, STAFF, input, { client }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM258_AC4_rejection_sends_the_trimmed_reason_and_alternative_and_returns_the_decision', async () => {
    const row = decidedRow({ status: 'rejected', decision_reason: 'Double-booked', suggested_alternative: 'Room B' });
    const client = clientAnswering(answer('rejected', row));

    const booking = await rejectBookingRequest(
      BOOKING.toUpperCase(),
      STAFF,
      { reason: '  Double-booked ', suggestedAlternative: ' Room B ' },
      { client },
    );

    expect(client.calls).toEqual([
      {
        fn: 'decide_booking_request',
        args: {
          p_booking_id: BOOKING,
          p_caller: STAFF,
          p_decision: 'reject',
          p_reason: 'Double-booked',
          p_suggested_alternative: 'Room B',
        },
      },
    ]);
    expect(booking).toMatchObject({
      id: BOOKING,
      status: 'rejected',
      decidedBy: STAFF,
      decidedAt: '2026-10-14T00:00:00+00:00',
      decisionReason: 'Double-booked',
      suggestedAlternative: 'Room B',
    });
  });

  it('SCRUM258_AC6_approval_sends_no_reason_and_returns_who_decided_and_when', async () => {
    const client = clientAnswering(answer('approved', decidedRow()));

    const booking = await approveBookingRequest(BOOKING, STAFF, { client });

    expect(client.calls[0].args).toEqual({
      p_booking_id: BOOKING,
      p_caller: STAFF,
      p_decision: 'approve',
      p_reason: null,
      p_suggested_alternative: null,
    });
    expect(booking).toMatchObject({ status: 'approved', decidedBy: STAFF, decidedAt: '2026-10-14T00:00:00+00:00', decisionReason: null });
  });

  it.each(['BOOKING_NOT_PENDING', 'EVENT_NOT_BOOKABLE', 'BOOKING_PERIOD_STALE', 'VENUE_RETIRED'])(
    'SCRUM258_AC5_PT409_%s_is_a_conflict_with_that_code',
    async (hint) => {
      const client = clientAnswering(failure('PT409', 'refused', { hint }));
      const err = await approveBookingRequest(BOOKING, STAFF, { client }).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.code).toBe(hint);
    },
  );

  it('SCRUM258_AC2_a_conflict_outcome_is_BOOKING_PERIOD_CONFLICT_with_the_occupants', async () => {
    const holdEntry = {
      kind: 'hold',
      hold_id: HOLD,
      event_request_id: OTHER_EVENT,
      event_name: 'Fair',
      starts_at: '2026-12-01T12:30:00+00:00',
      ends_at: '2026-12-01T14:00:00+00:00',
      occupied_starts_at: '2026-12-01T12:00:00+00:00',
      occupied_ends_at: '2026-12-01T14:45:00+00:00',
      setup_minutes: 30,
      turnaround_minutes: 45,
    };
    const client = clientAnswering({ data: { outcome: 'conflict', conflicts: [holdEntry] }, error: null });

    const err = await approveBookingRequest(BOOKING, STAFF, { client }).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('BOOKING_PERIOD_CONFLICT');
    expect(err.conflicts).toEqual([
      {
        kind: 'hold',
        holdId: HOLD,
        eventRequestId: OTHER_EVENT,
        eventName: 'Fair',
        startsAt: '2026-12-01T12:30:00+00:00',
        endsAt: '2026-12-01T14:00:00+00:00',
        occupiedStartsAt: '2026-12-01T12:00:00+00:00',
        occupiedEndsAt: '2026-12-01T14:45:00+00:00',
        setupMinutes: 30,
        turnaroundMinutes: 45,
      },
    ]);
  });

  it('SCRUM258_AC6_a_caller_who_is_not_venue_staff_is_forbidden', async () => {
    const err = await rejectBookingRequest(BOOKING, USER, { reason: 'No' }, { client: clientAnswering(failure('42501')) }).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
  });

  it('SCRUM258_AC3_approval_returns_the_ids_of_the_requests_it_marked_conflicting', async () => {
    const marked = [OTHER_EVENT, HOLD];
    const client = clientAnswering({
      data: { outcome: 'approved', booking: decidedRow(), marked_conflicting: marked },
      error: null,
    });

    expect((await approveBookingRequest(BOOKING, STAFF, { client })).markedConflicting).toEqual(marked);
  });

  it.each([
    [HOLD, HOLD],
    [null, null],
    [undefined, null],
  ])('SCRUM258_Week7_approval_returns_the_converted_hold_id_%s_as_%s', async (converted, expected) => {
    const client = clientAnswering({
      data: { outcome: 'approved', booking: decidedRow(), marked_conflicting: [], converted_hold_id: converted },
      error: null,
    });

    expect((await approveBookingRequest(BOOKING, STAFF, { client })).convertedHoldId).toBe(expected);
  });

  it('SCRUM258_AC3_an_approval_reported_with_a_booking_still_pending_is_an_error_not_a_success', async () => {
    const client = clientAnswering(answer('approved', decidedRow({ status: 'pending' })));
    await expect(approveBookingRequest(BOOKING, STAFF, { client })).rejects.toThrow(/not approved/);
  });
});
