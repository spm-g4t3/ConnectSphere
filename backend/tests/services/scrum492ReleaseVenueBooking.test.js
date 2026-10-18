/**
 * SCRUM-492 (SCRUM-565, SCRUM-566): releaseVenueBooking, over a fake client.
 * What the service refuses before any round trip, the one rpc it makes, how
 * its answer is shaped, and how each SQLSTATE and hint becomes an error. What
 * the function itself does is proved on PGlite in
 * tests/db/scrum492ReleaseVenueBookingDatabase.test.js.
 */

import { describe, it, expect } from 'vitest';

import { releaseVenueBooking } from '../../src/services/bookingRequestService.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../src/errors.js';

const BOOKING_ID = '44444444-4444-4444-8444-444444444444';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const VENUE_ID = '33333333-3333-4333-8333-333333333333';
const COORDINATOR_ID = '55555555-5555-4555-8555-555555555555';
const STAFF_ID = '99999999-9999-4999-8999-999999999999';
const FREED_ID = '77777777-7777-4777-8777-777777777777';

function createFakeClient(results = []) {
  const queue = [...results];
  const calls = [];
  return {
    calls,
    rpc(fn, args) {
      calls.push({ fn, args });
      if (queue.length === 0) throw new Error(`fake client: no result queued for ${fn}`);
      return Promise.resolve(queue.shift());
    },
  };
}

const ok = (data) => ({ data, error: null });
const dbFailure = (code, message, extra = {}) => ({ data: null, error: { code, message, ...extra } });

/** A bookings row as release_venue_booking's to_jsonb returns it. */
const releasedRow = (overrides = {}) => ({
  id: BOOKING_ID,
  event_request_id: EVENT_ID,
  venue_id: VENUE_ID,
  status: 'released',
  starts_at: '2026-12-01T05:00:00+00:00',
  ends_at: '2026-12-01T06:00:00+00:00',
  created_at: '2026-10-01T03:00:00+00:00',
  decided_by: STAFF_ID,
  decided_at: '2026-10-02T03:00:00+00:00',
  decision_reason: null,
  suggested_alternative: null,
  released_by: COORDINATOR_ID,
  released_at: '2026-10-18T03:00:00+00:00',
  release_reason: 'Moving to Hall B',
  ...overrides,
});

const released = (overrides = {}, freed = []) =>
  ok({ outcome: 'released', booking: releasedRow(overrides), returned_to_pending: freed });

const call = (client, { id = BOOKING_ID, caller = COORDINATOR_ID, input = { reason: 'Moving to Hall B' } } = {}) =>
  releaseVenueBooking(id, caller, input, { client });

const rejection = (promise) => promise.then(() => null, (err) => err);


describe('SCRUM-492: releaseVenueBooking', () => {
  it.each([
    ['no_caller', { caller: null }, 'callerId'],
    ['a_blank_caller', { caller: '  ' }, 'callerId'],
    ['a_malformed_id', { id: 'not-a-uuid' }, 'id'],
    ['no_reason', { input: {} }, 'reason'],
    ['a_reason_of_only_spaces', { input: { reason: '    ' } }, 'reason'],
    ['a_reason_of_only_whitespace', { input: { reason: ' \n\t ' } }, 'reason'],
    ['a_reason_that_is_not_text', { input: { reason: 42 } }, 'reason'],
    ['a_reason_of_1001_characters', { input: { reason: 'x'.repeat(1001) } }, 'reason'],
  ])('SCRUM492_AC1_%s_is_refused_with_400_before_any_rpc', async (_label, options, field) => {
    // AC1-13.
    const client = createFakeClient([]);

    const err = await rejection(call(client, options));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details.map((d) => d.field)).toEqual([field]);
    expect(client.calls).toHaveLength(0);
  });

  it.each([null, [], 'reason'])('SCRUM492_AC1_an_input_of_%j_is_refused_with_400_before_any_rpc', async (input) => {
    const client = createFakeClient([]);

    expect(await rejection(call(client, { input }))).toBeInstanceOf(ValidationError);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM492_AC2_a_release_is_one_rpc_with_the_caller_and_the_trimmed_reason', async () => {
    // AC2-06: 1000 characters after trimming is accepted, and sent trimmed.
    const client = createFakeClient([released()]);
    const reason = `  ${'x'.repeat(1000)}  `;

    await call(client, { id: BOOKING_ID.toUpperCase(), input: { reason } });

    expect(client.calls).toEqual([{
      fn: 'release_venue_booking',
      args: { p_booking_id: BOOKING_ID, p_caller: COORDINATOR_ID, p_reason: 'x'.repeat(1000) },
    }]);
  });

  it('SCRUM492_AC2_the_answer_is_the_released_booking_and_the_requests_returned_to_pending', async () => {
    // AC2-06, AC4-01, AC6-01.
    const client = createFakeClient([released({}, [FREED_ID])]);

    const result = await call(client);

    expect(result.returnedToPending).toEqual([FREED_ID]);
    expect(result.booking).toMatchObject({
      id: BOOKING_ID,
      eventRequestId: EVENT_ID,
      venueId: VENUE_ID,
      status: 'released',
      statusDisplay: { status: 'released', label: 'Released', group: 'RELEASED' },
      decidedBy: STAFF_ID,
      releasedBy: COORDINATOR_ID,
      releasedAt: '2026-10-18T03:00:00+00:00',
      releaseReason: 'Moving to Hall B',
    });
  });

  it('SCRUM492_AC4_an_answer_with_no_list_returns_none_to_pending', async () => {
    const client = createFakeClient([ok({ outcome: 'released', booking: releasedRow() })]);

    expect((await call(client)).returnedToPending).toEqual([]);
  });

  it.each(['EVENT_NOT_APPROVED', 'BOOKING_NOT_APPROVED'])(
    'SCRUM492_AC1_the_functions_%s_arrives_as_a_409_with_that_code',
    async (hint) => {
      // AC1-14: keyed on the hint, never the message.
      const client = createFakeClient([dbFailure('PT409', 'words the screen never reads', { hint })]);

      const err = await rejection(call(client));

      expect(err).toBeInstanceOf(ConflictError);
      expect(err.status).toBe(409);
      expect(err.code).toBe(hint);
    },
  );

  it.each([
    ['42501', ForbiddenError, 403, undefined],
    ['P0002', NotFoundError, 404, undefined],
    ['22023', ValidationError, 400, undefined],
    ['23514', ValidationError, 400, undefined],
    ['40001', ConflictError, 409, 'BOOKING_CHANGED'],
  ])('SCRUM492_AC1_the_functions_%s_arrives_as_its_status', async (code, type, status, conflictCode) => {
    // AC1-14.
    const client = createFakeClient([dbFailure(code, 'words')]);

    const err = await rejection(call(client));

    expect(err).toBeInstanceOf(type);
    expect(err.status).toBe(status);
    if (conflictCode) expect(err.code).toBe(conflictCode);
  });

  it.each([
    ['an_outcome_that_is_not_released', ok({ outcome: 'cancelled', booking: releasedRow() })],
    ['a_booking_that_is_not_released', released({ status: 'approved' })],
  ])('SCRUM492_AC2_%s_is_an_error_not_a_success', async (_label, answer) => {
    const client = createFakeClient([answer]);

    const err = await rejection(call(client));

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ValidationError);
  });
});
