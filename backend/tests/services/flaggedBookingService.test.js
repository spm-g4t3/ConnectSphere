/**
 * Unit tests for the flagged booking service.
 *
 * SCRUM-266. tests/routes/flaggedBookings.test.js drives the service through
 * HTTP; these pin what the route cannot reach -- a caller with no id, the
 * default client -- and how each answer list_flagged_bookings and
 * list_event_flagged_bookings (078),
 * reinstate_flagged_booking (076) and cancel_flagged_booking (077) give becomes a result or a typed error. What the function decides is proved in
 * tests/db/reinstateFlaggedBookingDatabase.test.js and
 * tests/db/cancelFlaggedBookingDatabase.test.js. The client is a queue-fed
 * fake, so nothing here needs credentials.
 */

import { describe, it, expect, vi } from 'vitest';

// The default client, for the one case that passes none.
const defaultClient = vi.hoisted(() => ({ rpc: null }));
vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: defaultClient, supabaseAdmin: {}, default: defaultClient }));

import {
  cancelFlaggedBooking,
  listEventFlaggedBookings,
  listFlaggedBookings,
  reinstateFlaggedBooking,
} from '../../src/services/flaggedBookingService.js';
import { getBookingStatusDisplay } from '../../src/domain/bookingStatus.js';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} from '../../src/errors.js';

const STAFF = '88888888-8888-4888-8888-888888888888';
const COORDINATOR = '55555555-5555-4555-8555-555555555555';
const EVENT = '22222222-2222-4222-8222-222222222222';
const VENUE = '33333333-3333-4333-8333-333333333333';
const BOOKING = '44444444-4444-4444-8444-444444444444';
const BLOCK = '99999999-9999-4999-8999-999999999999';
const RESOLUTION = '77777777-7777-4777-8777-777777777777';
const OTHER_BOOKING = '66666666-6666-4666-8666-666666666666';

/** A client that answers each rpc from the queue, recording the calls. */
function clientAnswering(...results) {
  const queue = [...results];
  const calls = [];
  return {
    calls,
    rpc(fn, args) {
      calls.push({ fn, args });
      return Promise.resolve(queue.shift());
    },
  };
}

const failure = (code, message = 'db message', extra = {}) => ({ data: null, error: { code, message, ...extra } });

/** The booking 076 returns, as to_jsonb writes it, approved and unflagged. */
const bookingRow = (overrides = {}) => ({
  id: BOOKING,
  event_request_id: EVENT,
  venue_id: VENUE,
  status: 'approved',
  starts_at: '2026-12-01T06:00:00+00:00',
  ends_at: '2026-12-01T08:00:00+00:00',
  room_layout_code: 'theatre',
  expected_attendance: 150,
  venue_requirements: null,
  accessibility_requirements: null,
  setup_notes: null,
  suitability_result: null,
  suitability_overridden: false,
  requested_by: null,
  created_at: '2026-10-01T00:00:00+00:00',
  flagged_at: null,
  review_block_id: null,
  review_reason: null,
  decided_by: STAFF,
  decided_at: '2026-10-05T00:00:00+00:00',
  ...overrides,
});

const resolutionRow = () => ({
  id: RESOLUTION,
  booking_id: BOOKING,
  outcome: 'reinstated',
  reason: 'Block moved',
  resolved_by: STAFF,
  review_block_id: BLOCK,
  review_reason: null,
  flagged_at: '2026-10-10T00:00:00+00:00',
  flagged_by: STAFF,
  replacement_booking_id: null,
  created_at: '2026-10-16T01:02:03+00:00',
});

const reinstated = () => ({
  data: { outcome: 'reinstated', booking: bookingRow(), resolution: resolutionRow() },
  error: null,
});

const reinstate = (client, input = { reason: 'Block moved' }, id = BOOKING, caller = STAFF) =>
  reinstateFlaggedBooking(id, caller, input, { client });

describe('SCRUM266 refusals before any call', () => {
  it.each([undefined, null, '', '   ', 42])('SCRUM266_AC2_the_caller_%j_is_refused_before_any_call', async (caller) => {
    const client = clientAnswering();
    const err = await reinstateFlaggedBooking(BOOKING, caller, { reason: 'Block moved' }, { client }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'callerId', message: 'is required' }]);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM266_AC2_a_malformed_id_is_refused_before_any_call', async () => {
    const client = clientAnswering();
    await expect(reinstate(client, { reason: 'x' }, 'nope')).rejects.toBeInstanceOf(ValidationError);
    expect(client.calls).toHaveLength(0);
  });

  it.each([
    ['no body', undefined],
    ['no reason', {}],
    ['a blank reason', { reason: '   ' }],
    ['a reason over 1000 characters', { reason: 'x'.repeat(1001) }],
  ])('SCRUM266_AC5_%s_is_refused_before_any_call', async (_label, input) => {
    const client = clientAnswering();
    await expect(reinstateFlaggedBooking(BOOKING, STAFF, input, { client })).rejects.toBeInstanceOf(ValidationError);
    expect(client.calls).toHaveLength(0);
  });
});

describe('SCRUM266 the call and its result', () => {
  it('SCRUM266_AC2_sends_the_normalised_id_the_caller_and_the_trimmed_reason', async () => {
    const client = clientAnswering(reinstated());

    await reinstate(client, { reason: '  Block moved  ', callerId: 'someone-else' }, BOOKING.toUpperCase());

    expect(client.calls).toEqual([
      {
        fn: 'reinstate_flagged_booking',
        args: { p_booking_id: BOOKING, p_caller: STAFF, p_reason: 'Block moved' },
      },
    ]);
  });

  it('SCRUM266_AC5_returns_the_approved_booking_in_camel_case_with_the_resolution', async () => {
    const result = await reinstate(clientAnswering(reinstated()));

    expect(result).toEqual({
      id: BOOKING,
      eventRequestId: EVENT,
      venueId: VENUE,
      status: 'approved',
      startsAt: '2026-12-01T06:00:00+00:00',
      endsAt: '2026-12-01T08:00:00+00:00',
      roomLayoutCode: 'theatre',
      expectedAttendance: 150,
      venueRequirements: null,
      accessibilityRequirements: null,
      setupNotes: null,
      suitability: null,
      suitabilityOverridden: false,
      requestedBy: null,
      replacesBookingId: null,
      createdAt: '2026-10-01T00:00:00+00:00',
      statusDisplay: expect.objectContaining({ status: 'approved' }),
      resolution: {
        id: RESOLUTION,
        outcome: 'reinstated',
        reason: 'Block moved',
        resolvedBy: STAFF,
        resolvedAt: '2026-10-16T01:02:03+00:00',
      },
    });
    expect(result.statusDisplay.group).not.toBe('UNKNOWN');
  });

  it('SCRUM266_AC2_uses_the_default_client_when_none_is_given', async () => {
    const calls = [];
    defaultClient.rpc = (fn, args) => {
      calls.push({ fn, args });
      return Promise.resolve(reinstated());
    };

    const result = await reinstateFlaggedBooking(BOOKING, STAFF, { reason: 'Block moved' });

    expect(result.status).toBe('approved');
    expect(calls.map((c) => c.fn)).toEqual(['reinstate_flagged_booking']);
  });
});

describe('SCRUM266 the conflict outcome', () => {
  it('SCRUM266_AC2_a_conflict_is_BOOKING_PERIOD_CONFLICT_with_the_occupants_mapped', async () => {
    const block = {
      kind: 'block',
      block_id: BLOCK,
      starts_at: '2026-12-01T07:00:00+00:00',
      ends_at: '2026-12-01T09:00:00+00:00',
      reason: 'maintenance',
      occupied_starts_at: '2026-12-01T07:00:00+00:00',
      occupied_ends_at: '2026-12-01T09:00:00+00:00',
      setup_minutes: 0,
      turnaround_minutes: 0,
    };
    const booking = {
      kind: 'booking',
      booking_id: OTHER_BOOKING,
      event_request_id: EVENT,
      event_name: 'Careers Fair',
      starts_at: '2026-12-01T08:30:00+00:00',
      ends_at: '2026-12-01T09:30:00+00:00',
      occupied_starts_at: '2026-12-01T08:00:00+00:00',
      occupied_ends_at: '2026-12-01T10:15:00+00:00',
      setup_minutes: 30,
      turnaround_minutes: 45,
    };
    const client = clientAnswering({ data: { outcome: 'conflict', conflicts: [block, booking] }, error: null });

    const err = await reinstate(client).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('BOOKING_PERIOD_CONFLICT');
    expect(err.conflicts).toEqual([
      {
        kind: 'block',
        blockId: BLOCK,
        startsAt: '2026-12-01T07:00:00+00:00',
        endsAt: '2026-12-01T09:00:00+00:00',
        reason: 'maintenance',
        occupiedStartsAt: '2026-12-01T07:00:00+00:00',
        occupiedEndsAt: '2026-12-01T09:00:00+00:00',
        setupMinutes: 0,
        turnaroundMinutes: 0,
      },
      {
        kind: 'booking',
        bookingId: OTHER_BOOKING,
        eventRequestId: EVENT,
        eventName: 'Careers Fair',
        startsAt: '2026-12-01T08:30:00+00:00',
        endsAt: '2026-12-01T09:30:00+00:00',
        occupiedStartsAt: '2026-12-01T08:00:00+00:00',
        occupiedEndsAt: '2026-12-01T10:15:00+00:00',
        setupMinutes: 30,
        turnaroundMinutes: 45,
      },
    ]);
  });

  it('SCRUM266_AC2_a_conflict_with_no_list_is_still_a_conflict_with_an_empty_list', async () => {
    const err = await reinstate(clientAnswering({ data: { outcome: 'conflict' }, error: null })).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('BOOKING_PERIOD_CONFLICT');
    expect(err.conflicts).toEqual([]);
  });

  it.each([
    ['an unknown outcome', { data: { outcome: 'approved', booking: bookingRow() }, error: null }, /approved/],
    ['no outcome', { data: {}, error: null }, /undefined/],
    ['no data', { data: null, error: null }, /undefined/],
  ])('SCRUM266_AC2_%s_is_a_plain_error_not_a_success', async (_label, answer, message) => {
    const err = await reinstate(clientAnswering(answer)).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConflictError);
    expect(err.status).toBeUndefined();
    expect(err.message).toMatch(/Unexpected outcome from reinstate_flagged_booking/);
    expect(err.message).toMatch(message);
  });
});

describe('SCRUM266 how database errors become typed errors', () => {
  it('SCRUM266_AC2_42501_is_forbidden', async () => {
    const err = await reinstate(clientAnswering(failure('42501', 'only Venue Staff'))).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe('only Venue Staff');
  });

  it('SCRUM266_AC2_P0002_is_not_found', async () => {
    const err = await reinstate(clientAnswering(failure('P0002', 'booking not found'))).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
  });

  it.each([
    'BOOKING_NOT_FLAGGED',
    'SAFETY_FLAG_NOT_REINSTATABLE',
    'EVENT_NOT_BOOKABLE',
    'BOOKING_PERIOD_STALE',
    'VENUE_RETIRED',
  ])('SCRUM266_AC2_PT409_%s_is_a_conflict_with_that_code', async (hint) => {
    const err = await reinstate(clientAnswering(failure('PT409', 'refused', { hint }))).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe(hint);
    expect(err.message).toBe('refused');
    expect(err.conflicts).toEqual([]);
  });

  it('SCRUM266_AC2_PT409_with_no_hint_is_a_conflict_with_a_null_code', async () => {
    const err = await reinstate(clientAnswering(failure('PT409', 'refused'))).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBeNull();
  });

  it('SCRUM266_AC2_40001_is_a_conflict_BOOKING_CHANGED', async () => {
    const err = await reinstate(clientAnswering(failure('40001', 'changed'))).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('BOOKING_CHANGED');
  });

  it.each(['22023', '23514', '22P02'])('SCRUM266_AC5_%s_is_a_validation_error', async (code) => {
    const err = await reinstate(clientAnswering(failure(code))).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
  });

  it('SCRUM266_AC2_an_unmapped_code_is_a_plain_error_with_the_message', async () => {
    const err = await reinstate(clientAnswering(failure('XX000', 'boom'))).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBeUndefined();
    expect(err.message).toBe('boom');
  });

  it('SCRUM266_AC2_an_error_with_no_message_says_it_was_unexpected', async () => {
    const err = await reinstate(clientAnswering({ data: null, error: { code: '42501' } })).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe('Unexpected database error');
  });
});

describe('SCRUM266 cancelling a flagged booking', () => {
  const cancelledResolution = () => ({
    ...resolutionRow(),
    outcome: 'cancelled',
    reason: 'Venue no longer fits',
    resolved_by: COORDINATOR,
  });

  // The flag stays on a cancelled booking (077), so the row still carries it.
  const cancelled = () => ({
    data: {
      outcome: 'cancelled',
      booking: bookingRow({ status: 'cancelled', flagged_at: '2026-10-10T00:00:00+00:00', review_block_id: BLOCK }),
      resolution: cancelledResolution(),
    },
    error: null,
  });

  const cancel = (client, input = { reason: 'Venue no longer fits' }, id = BOOKING, caller = COORDINATOR) =>
    cancelFlaggedBooking(id, caller, input, { client });

  describe('refusals before any call', () => {
    it.each([undefined, null, '', '   ', 42])('SCRUM266_AC3_the_caller_%j_is_refused_before_any_call', async (caller) => {
      const client = clientAnswering();
      const err = await cancelFlaggedBooking(BOOKING, caller, { reason: 'Venue no longer fits' }, { client }).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.details).toEqual([{ field: 'callerId', message: 'is required' }]);
      expect(client.calls).toHaveLength(0);
    });

    it('SCRUM266_AC3_a_malformed_id_is_refused_before_any_call', async () => {
      const client = clientAnswering();
      await expect(cancel(client, { reason: 'x' }, 'nope')).rejects.toBeInstanceOf(ValidationError);
      expect(client.calls).toHaveLength(0);
    });

    it.each([
      ['no body', undefined],
      ['no reason', {}],
      ['a blank reason', { reason: '   ' }],
      ['a reason over 1000 characters', { reason: 'x'.repeat(1001) }],
    ])('SCRUM266_AC5_cancelling_with_%s_is_refused_before_any_call', async (_label, input) => {
      const client = clientAnswering();
      await expect(cancelFlaggedBooking(BOOKING, COORDINATOR, input, { client })).rejects.toBeInstanceOf(ValidationError);
      expect(client.calls).toHaveLength(0);
    });
  });

  describe('the call and its result', () => {
    it('SCRUM266_AC3_sends_the_normalised_id_the_caller_and_the_trimmed_reason_to_cancel_flagged_booking', async () => {
      const client = clientAnswering(cancelled());

      await cancel(client, { reason: '  Venue no longer fits  ', callerId: STAFF }, BOOKING.toUpperCase());

      expect(client.calls).toEqual([
        {
          fn: 'cancel_flagged_booking',
          args: { p_booking_id: BOOKING, p_caller: COORDINATOR, p_reason: 'Venue no longer fits' },
        },
      ]);
    });

    it('SCRUM266_AC5_returns_the_cancelled_booking_in_camel_case_with_the_resolution', async () => {
      const result = await cancel(clientAnswering(cancelled()));

      expect(result).toEqual({
        id: BOOKING,
        eventRequestId: EVENT,
        venueId: VENUE,
        status: 'cancelled',
        startsAt: '2026-12-01T06:00:00+00:00',
        endsAt: '2026-12-01T08:00:00+00:00',
        roomLayoutCode: 'theatre',
        expectedAttendance: 150,
        venueRequirements: null,
        accessibilityRequirements: null,
        setupNotes: null,
        suitability: null,
        suitabilityOverridden: false,
        requestedBy: null,
        replacesBookingId: null,
        createdAt: '2026-10-01T00:00:00+00:00',
        statusDisplay: expect.objectContaining({ status: 'cancelled' }),
        resolution: {
          id: RESOLUTION,
          outcome: 'cancelled',
          reason: 'Venue no longer fits',
          resolvedBy: COORDINATOR,
          resolvedAt: '2026-10-16T01:02:03+00:00',
        },
      });
      expect(result.statusDisplay.group).not.toBe('UNKNOWN');
    });

    it('SCRUM266_AC3_venue_staff_are_sent_as_the_caller_too', async () => {
      const client = clientAnswering(cancelled());

      await cancel(client, undefined, BOOKING, STAFF);

      expect(client.calls[0].args.p_caller).toBe(STAFF);
    });

    it('SCRUM266_AC3_cancel_uses_the_default_client_when_none_is_given', async () => {
      const calls = [];
      defaultClient.rpc = (fn, args) => {
        calls.push({ fn, args });
        return Promise.resolve(cancelled());
      };

      const result = await cancelFlaggedBooking(BOOKING, COORDINATOR, { reason: 'Venue no longer fits' });

      expect(result.status).toBe('cancelled');
      expect(calls.map((c) => c.fn)).toEqual(['cancel_flagged_booking']);
    });

    it.each([
      ['a reinstated outcome', { data: { outcome: 'reinstated', booking: bookingRow() }, error: null }, /reinstated/],
      ['a conflict outcome', { data: { outcome: 'conflict', conflicts: [] }, error: null }, /conflict/],
      ['no outcome', { data: {}, error: null }, /undefined/],
      ['no data', { data: null, error: null }, /undefined/],
    ])('SCRUM266_AC3_cancel_with_%s_is_a_plain_error_not_a_success', async (_label, answer, message) => {
      const err = await cancel(clientAnswering(answer)).catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ConflictError);
      expect(err.status).toBeUndefined();
      expect(err.message).toMatch(/Unexpected outcome from cancel_flagged_booking/);
      expect(err.message).toMatch(message);
    });
  });

  describe('how database errors become typed errors', () => {
    it('SCRUM266_AC3_cancel_42501_is_forbidden', async () => {
      const err = await cancel(clientAnswering(failure('42501', 'only the assigned coordinator'))).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenError);
      expect(err.status).toBe(403);
      expect(err.message).toBe('only the assigned coordinator');
    });

    it('SCRUM266_AC3_cancel_P0002_is_not_found', async () => {
      const err = await cancel(clientAnswering(failure('P0002', 'booking not found'))).catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundError);
      expect(err.status).toBe(404);
    });

    it('SCRUM266_AC3_cancel_PT409_BOOKING_NOT_FLAGGED_is_a_conflict_with_that_code', async () => {
      const err = await cancel(clientAnswering(failure('PT409', 'refused', { hint: 'BOOKING_NOT_FLAGGED' }))).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.status).toBe(409);
      expect(err.code).toBe('BOOKING_NOT_FLAGGED');
      expect(err.message).toBe('refused');
    });

    it('SCRUM266_AC3_cancel_PT409_with_no_hint_is_a_conflict_with_a_null_code', async () => {
      const err = await cancel(clientAnswering(failure('PT409', 'refused'))).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.code).toBeNull();
    });

    it('SCRUM266_AC3_cancel_40001_is_a_conflict_BOOKING_CHANGED', async () => {
      const err = await cancel(clientAnswering(failure('40001', 'changed'))).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.code).toBe('BOOKING_CHANGED');
    });

    it.each(['22023', '23514', '22P02'])('SCRUM266_AC5_cancel_%s_is_a_validation_error', async (code) => {
      const err = await cancel(clientAnswering(failure(code))).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.status).toBe(400);
    });

    it('SCRUM266_AC3_cancel_an_unmapped_code_is_a_plain_error_with_the_message', async () => {
      const err = await cancel(clientAnswering(failure('XX000', 'boom'))).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.status).toBeUndefined();
      expect(err.message).toBe('boom');
    });

    it('SCRUM266_AC3_cancel_an_error_with_no_message_says_it_was_unexpected', async () => {
      const err = await cancel(clientAnswering({ data: null, error: { code: 'P0002' } })).catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundError);
      expect(err.message).toBe('Unexpected database error');
    });
  });
});

describe('SCRUM266 listing flagged bookings', () => {
  /** One element of list_flagged_bookings (078), as jsonb_build_object writes it. */
  const flaggedRow = (overrides = {}) => ({
    id: BOOKING,
    event_request_id: EVENT,
    venue_id: VENUE,
    starts_at: '2026-12-01T06:00:00+00:00',
    ends_at: '2026-12-01T08:00:00+00:00',
    occupied_starts_at: '2026-12-01T05:30:00+00:00',
    occupied_ends_at: '2026-12-01T08:45:00+00:00',
    flagged_at: '2026-10-10T00:00:00+00:00',
    flagged_by: STAFF,
    review_reason: 'safety_review',
    event_name: 'Open Day',
    event_status: 'approved',
    event_starts_at: '2026-12-01T06:30:00+00:00',
    event_ends_at: '2026-12-01T08:30:00+00:00',
    assigned_coordinator_id: COORDINATOR,
    venue_name: 'Harbour Room',
    venue_location: 'Block A',
    block_id: BLOCK,
    block_reason: 'maintenance',
    block_notes: 'Roof repair',
    block_starts_at: '2026-12-01T07:00:00+00:00',
    block_ends_at: '2026-12-01T09:00:00+00:00',
    block_removed_at: '2026-10-12T00:00:00+00:00',
    reinstatable: false,
    ...overrides,
  });

  const listed = (...rows) => ({ data: rows, error: null });
  const list = (client) => listFlaggedBookings(STAFF, { client });

  describe('refusals before any call', () => {
    it.each([undefined, null, '', '   ', 42])('SCRUM266_AC1_the_caller_%j_is_refused_before_any_call', async (caller) => {
      const client = clientAnswering(listed());
      const err = await listFlaggedBookings(caller, { client }).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.details).toEqual([{ field: 'callerId', message: 'is required' }]);
      expect(client.calls).toHaveLength(0);
    });
  });

  describe('the call and its result', () => {
    it('SCRUM266_AC1_calls_list_flagged_bookings_with_only_the_caller', async () => {
      const client = clientAnswering(listed());

      await list(client);

      expect(client.calls).toEqual([{ fn: 'list_flagged_bookings', args: { p_caller: STAFF } }]);
    });

    it('SCRUM266_AC1_nothing_flagged_is_an_empty_array', async () => {
      expect(await list(clientAnswering(listed()))).toEqual([]);
    });

    it('SCRUM266_AC1_maps_every_field_to_camel_case_with_the_block_nested', async () => {
      const [item] = await list(clientAnswering(listed(flaggedRow())));

      expect(item).toEqual({
        id: BOOKING,
        eventRequestId: EVENT,
        venueId: VENUE,
        statusDisplay: getBookingStatusDisplay('flagged_for_review'),
        startsAt: '2026-12-01T06:00:00+00:00',
        endsAt: '2026-12-01T08:00:00+00:00',
        occupiedStartsAt: '2026-12-01T05:30:00+00:00',
        occupiedEndsAt: '2026-12-01T08:45:00+00:00',
        flaggedAt: '2026-10-10T00:00:00+00:00',
        flaggedBy: STAFF,
        reviewReason: 'safety_review',
        eventName: 'Open Day',
        eventStatus: 'approved',
        eventStartsAt: '2026-12-01T06:30:00+00:00',
        eventEndsAt: '2026-12-01T08:30:00+00:00',
        assignedCoordinatorId: COORDINATOR,
        venueName: 'Harbour Room',
        venueLocation: 'Block A',
        block: {
          id: BLOCK,
          reason: 'maintenance',
          notes: 'Roof repair',
          startsAt: '2026-12-01T07:00:00+00:00',
          endsAt: '2026-12-01T09:00:00+00:00',
          removedAt: '2026-10-12T00:00:00+00:00',
        },
        reinstatable: false,
      });
    });

    it('SCRUM266_AC1_status_display_reads_flagged_for_review', async () => {
      const [item] = await list(clientAnswering(listed(flaggedRow())));

      expect(item.statusDisplay).toMatchObject({ label: 'Flagged for review', group: 'FLAGGED' });
    });

    it('SCRUM266_AC1_keeps_the_order_the_function_gave', async () => {
      const result = await list(clientAnswering(listed(flaggedRow({ id: OTHER_BOOKING }), flaggedRow())));

      expect(result.map((item) => item.id)).toEqual([OTHER_BOOKING, BOOKING]);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
    ])('SCRUM266_AC1_the_block_is_null_when_block_id_is_%s', async (_label, blockId) => {
      const [item] = await list(
        clientAnswering(listed(flaggedRow({ block_id: blockId, review_reason: 'setup_or_turnaround_changed' }))),
      );

      expect(item.block).toBeNull();
      expect(item.reviewReason).toBe('setup_or_turnaround_changed');
    });

    it('SCRUM266_AC1_a_sparse_row_maps_every_missing_field_to_null', async () => {
      const sparse = { id: BOOKING, event_request_id: EVENT, venue_id: VENUE, starts_at: 's', ends_at: 'e', block_id: BLOCK };

      const [item] = await list(clientAnswering(listed(sparse)));

      expect(item).toEqual({
        id: BOOKING,
        eventRequestId: EVENT,
        venueId: VENUE,
        statusDisplay: getBookingStatusDisplay('flagged_for_review'),
        startsAt: 's',
        endsAt: 'e',
        occupiedStartsAt: null,
        occupiedEndsAt: null,
        flaggedAt: null,
        flaggedBy: null,
        reviewReason: null,
        eventName: null,
        eventStatus: null,
        eventStartsAt: null,
        eventEndsAt: null,
        assignedCoordinatorId: null,
        venueName: null,
        venueLocation: null,
        block: { id: BLOCK, reason: null, notes: null, startsAt: null, endsAt: null, removedAt: null },
        reinstatable: false,
      });
    });

    it.each([
      ['true', true, true],
      ['false', false, false],
      ['the string true', 'true', false],
      ['1', 1, false],
      ['missing', undefined, false],
    ])('SCRUM266_AC1_reinstatable_%s_maps_to_%s', async (_label, value, expected) => {
      const [item] = await list(clientAnswering(listed(flaggedRow({ reinstatable: value }))));

      expect(item.reinstatable).toBe(expected);
    });

    it('SCRUM266_AC1_list_uses_the_default_client_when_none_is_given', async () => {
      const calls = [];
      defaultClient.rpc = (fn, args) => {
        calls.push({ fn, args });
        return Promise.resolve(listed(flaggedRow()));
      };

      const result = await listFlaggedBookings(STAFF);

      expect(result.map((item) => item.id)).toEqual([BOOKING]);
      expect(calls).toEqual([{ fn: 'list_flagged_bookings', args: { p_caller: STAFF } }]);
    });
  });

  describe('errors and unexpected results', () => {
    it('SCRUM266_AC1_list_42501_is_forbidden', async () => {
      const err = await list(clientAnswering(failure('42501', 'only Venue Staff can view flagged bookings'))).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenError);
      expect(err.message).toBe('only Venue Staff can view flagged bookings');
    });

    it('SCRUM266_AC1_list_an_unmapped_code_is_a_plain_error_with_the_message', async () => {
      const err = await list(clientAnswering(failure('XX000', 'boom'))).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ForbiddenError);
      expect(err.status).toBeUndefined();
      expect(err.message).toBe('boom');
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['an object', { outcome: 'listed' }],
      ['a string', '[]'],
    ])('SCRUM266_AC1_list_with_%s_data_is_a_plain_error', async (_label, data) => {
      const err = await list(clientAnswering({ data, error: null })).catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ConflictError);
      expect(err.status).toBeUndefined();
      expect(err.message).toBe('Unexpected result from list_flagged_bookings');
    });
  });
});

describe('SCRUM266 the coordinator lists one event\'s flagged bookings', () => {
  const REPLACEMENT = '12121212-1212-4212-8212-121212121212';
  const listed = (...rows) => ({ data: rows, error: null });
  const listForEvent = (client, eventId = EVENT, caller = COORDINATOR) =>
    listEventFlaggedBookings(eventId, caller, { client });

  const replacementRow = (overrides = {}) => ({
    id: REPLACEMENT,
    venue_id: VENUE,
    venue_name: 'Garden Hall',
    status: 'conflicting',
    starts_at: '2026-12-01T06:00:00+00:00',
    ends_at: '2026-12-01T08:00:00+00:00',
    created_at: '2026-10-11T00:00:00+00:00',
    ...overrides,
  });

  /** A sparse element of list_event_flagged_bookings; the shared fields are pinned above. */
  const eventRow = (overrides = {}) => ({
    id: BOOKING,
    event_request_id: EVENT,
    venue_id: VENUE,
    starts_at: 's',
    ends_at: 'e',
    review_reason: 'safety_review',
    reinstatable: false,
    replacement_requests: [replacementRow()],
    ...overrides,
  });

  it.each([undefined, null, '', 42])('SCRUM266_AC1_the_caller_%j_is_refused_before_any_call', async (caller) => {
    const client = clientAnswering(listed());
    const err = await listEventFlaggedBookings(EVENT, caller, { client }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM266_AC1_a_malformed_event_id_is_refused_before_any_call', async () => {
    const client = clientAnswering(listed());
    const err = await listForEvent(client, 'nope').catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'eventRequestId', message: 'must be a valid event request id' }]);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM266_AC1_calls_list_event_flagged_bookings_with_the_caller_and_the_normalised_event', async () => {
    const client = clientAnswering(listed());

    expect(await listForEvent(client, ` ${EVENT.toUpperCase()} `)).toEqual([]);

    expect(client.calls).toEqual([
      { fn: 'list_event_flagged_bookings', args: { p_caller: COORDINATOR, p_event_request_id: EVENT } },
    ]);
  });

  it('SCRUM266_W7_each_item_is_the_list_shape_plus_its_replacement_requests_in_camel_case', async () => {
    const [venueStaffItem] = await listFlaggedBookings(STAFF, { client: clientAnswering(listed(eventRow())) });

    const [item] = await listForEvent(clientAnswering(listed(eventRow())));

    expect(item).toEqual({
      ...venueStaffItem,
      replacementRequests: [
        {
          id: REPLACEMENT,
          venueId: VENUE,
          venueName: 'Garden Hall',
          status: 'conflicting',
          startsAt: '2026-12-01T06:00:00+00:00',
          endsAt: '2026-12-01T08:00:00+00:00',
          createdAt: '2026-10-11T00:00:00+00:00',
        },
      ],
    });
  });

  it('SCRUM266_W7_no_replacement_requests_is_an_empty_list', async () => {
    const result = await listForEvent(
      clientAnswering(listed(eventRow({ replacement_requests: [] }), eventRow({ id: OTHER_BOOKING, replacement_requests: undefined }))),
    );

    expect(result.map((item) => item.replacementRequests)).toEqual([[], []]);
  });

  it('SCRUM266_W7_a_replacement_with_no_venue_name_reads_null', async () => {
    const [item] = await listForEvent(
      clientAnswering(listed(eventRow({ replacement_requests: [replacementRow({ venue_name: undefined })] }))),
    );

    expect(item.replacementRequests[0].venueName).toBeNull();
  });

  it.each([
    ['42501', ForbiddenError],
    ['P0002', NotFoundError],
  ])('SCRUM266_AC1_event_list_%s_is_a_typed_error', async (code, type) => {
    const err = await listForEvent(clientAnswering(failure(code))).catch((e) => e);
    expect(err).toBeInstanceOf(type);
  });

  it('SCRUM266_AC1_event_list_that_is_not_an_array_is_an_unexpected_result', async () => {
    await expect(listForEvent(clientAnswering({ data: null, error: null }))).rejects.toThrow(
      'Unexpected result from list_event_flagged_bookings',
    );
  });

  it('SCRUM266_AC1_event_list_uses_the_default_client_when_none_is_given', async () => {
    const calls = [];
    defaultClient.rpc = (fn, args) => {
      calls.push({ fn, args });
      return Promise.resolve(listed());
    };

    expect(await listEventFlaggedBookings(EVENT, COORDINATOR)).toEqual([]);
    expect(calls.map((c) => c.fn)).toEqual(['list_event_flagged_bookings']);
  });
});
