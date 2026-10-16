/**
 * Unit tests for the flagged booking service.
 *
 * SCRUM-266. tests/routes/flaggedBookings.test.js drives the service through
 * HTTP; these pin what the route cannot reach -- a caller with no id, the
 * default client -- and how each answer reinstate_flagged_booking (076) gives
 * becomes a result or a typed error. What the function decides is proved in
 * tests/db/reinstateFlaggedBookingDatabase.test.js. The client is a queue-fed
 * fake, so nothing here needs credentials.
 */

import { describe, it, expect, vi } from 'vitest';

// The default client, for the one case that passes none.
const defaultClient = vi.hoisted(() => ({ rpc: null }));
vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: defaultClient, supabaseAdmin: {}, default: defaultClient }));

import { reinstateFlaggedBooking } from '../../src/services/flaggedBookingService.js';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} from '../../src/errors.js';

const STAFF = '88888888-8888-4888-8888-888888888888';
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
