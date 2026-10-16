/**
 * Tests for the flagged booking routes.
 *
 * SCRUM-266. Real Express routing and the real service, over a fake Supabase
 * client: reinstate_flagged_booking's (076) and cancel_flagged_booking's (077)
 * answers are queued, and what is proved is what the endpoint does with them
 * -- the status, the error code and the conflict list the UI reads, and that
 * the caller always comes from the token. What the function decides is proved in
 * tests/db/reinstateFlaggedBookingDatabase.test.js and
 * tests/db/cancelFlaggedBookingDatabase.test.js.
 *
 * The router is mounted here at the path app.js uses, rather than imported
 * from src/app.js, which calls app.listen() and needs a .env.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// The default router export builds with the real requireAuth, which loads the
// Supabase client; every query here goes to the injected fake.
vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: {}, supabaseAdmin: {}, default: {} }));

import defaultRouter, { createFlaggedBookingRouter } from '../../src/routes/flaggedBookings.js';
import { ROLE } from '../../src/domain/userRole.js';

const STAFF_ID = '88888888-8888-4888-8888-888888888888';
const COORDINATOR_ID = '55555555-5555-4555-8555-555555555555';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const VENUE_ID = '33333333-3333-4333-8333-333333333333';
const BOOKING_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_BOOKING_ID = '77777777-7777-4777-8777-777777777777';
const RESOLUTION_ID = '99999999-9999-4999-8999-999999999999';

const START = '2026-12-01T09:00:00+00:00';
const END = '2026-12-01T17:00:00+00:00';

const ok = (data) => ({ data, error: null });
const dbFailure = (code, message, extra = {}) => ({ data: null, error: { code, message, ...extra } });

const reinstated = () =>
  ok({
    outcome: 'reinstated',
    booking: {
      id: BOOKING_ID,
      venue_id: VENUE_ID,
      event_request_id: EVENT_ID,
      starts_at: START,
      ends_at: END,
      status: 'approved',
      created_at: '2026-10-06T10:00:00+00:00',
      flagged_at: null,
      review_block_id: null,
      review_reason: null,
    },
    resolution: {
      id: RESOLUTION_ID,
      booking_id: BOOKING_ID,
      outcome: 'reinstated',
      reason: 'Block moved',
      resolved_by: STAFF_ID,
      created_at: '2026-10-16T02:00:00+00:00',
    },
  });

/** A queue-fed stand-in for the Supabase client, recording every call. */
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

const signedInWithRole = (role, id = STAFF_ID) => (req, _res, next) => {
  req.user = { id, email: 'user@example.com', role };
  next();
};
const signedOut = (_req, res) => res.status(401).json({ error: 'Authentication required' });
const asStaff = signedInWithRole(ROLE.VENUE_STAFF);

const appWith = ({ client, requireAuth = asStaff }) =>
  express()
    .use(express.json())
    .use('/api/flagged-bookings', createFlaggedBookingRouter({ client, requireAuth }));

/** Sends { reason: 'Block moved' } unless a body is given; `body: undefined` sends none. */
const reinstate = (client, options = {}) => {
  const { requireAuth, id = BOOKING_ID } = options;
  const body = 'body' in options ? options.body : { reason: 'Block moved' };
  const req = request(appWith({ client, requireAuth })).post(`/api/flagged-bookings/${id}/reinstate`);
  return body === undefined ? req : req.send(body);
};

describe('SCRUM-266: Venue Staff reinstate a flagged booking', () => {
  it('SCRUM266_AC5_reinstate_is_200_with_the_booking_and_its_resolution_and_the_caller_from_the_token', async () => {
    const client = createFakeClient([reinstated()]);

    const res = await reinstate(client, { body: { reason: '  Block moved ', callerId: COORDINATOR_ID, status: 'pending' } });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: BOOKING_ID,
      eventRequestId: EVENT_ID,
      venueId: VENUE_ID,
      status: 'approved',
      statusDisplay: expect.objectContaining({ status: 'approved' }),
      resolution: {
        id: RESOLUTION_ID,
        outcome: 'reinstated',
        reason: 'Block moved',
        resolvedBy: STAFF_ID,
        resolvedAt: '2026-10-16T02:00:00+00:00',
      },
    });
    expect(client.calls).toEqual([
      {
        fn: 'reinstate_flagged_booking',
        args: { p_booking_id: BOOKING_ID, p_caller: STAFF_ID, p_reason: 'Block moved' },
      },
    ]);
  });

  it('SCRUM266_AC2_returns_401_without_a_token_and_never_queries', async () => {
    const client = createFakeClient([reinstated()]);
    const res = await reinstate(client, { requireAuth: signedOut });
    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });

  it.each([
    ROLE.EVENT_COORDINATOR,
    ROLE.EVENT_ORGANISER,
    ROLE.EVENT_COORDINATOR_LEAD,
    ROLE.TECHNICAL_SUPPORT_STAFF,
    ROLE.SAFETY_OFFICER,
    ROLE.ATTENDEE,
    null,
  ])('SCRUM266_AC2_refuses_%s_with_403_and_never_queries', async (role) => {
    const client = createFakeClient([reinstated()]);
    const res = await reinstate(client, { requireAuth: signedInWithRole(role, COORDINATOR_ID) });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Venue Staff/);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM266_AC2_a_refusal_from_the_function_is_403', async () => {
    const res = await reinstate(createFakeClient([dbFailure('42501', 'only Venue Staff can reinstate a flagged booking')]));
    expect(res.status).toBe(403);
  });

  it.each([
    ['no body', undefined],
    ['no reason', {}],
    ['a blank reason', { reason: '   ' }],
    ['a reason over 1000 characters', { reason: 'x'.repeat(1001) }],
  ])('SCRUM266_AC5_%s_is_400_and_never_queries', async (_label, body) => {
    const client = createFakeClient([reinstated()]);
    const res = await reinstate(client, { body });
    expect(res.status).toBe(400);
    // With no body at all there is no object to name a field in.
    if (body !== undefined) expect(res.body.details).toEqual([expect.objectContaining({ field: 'reason' })]);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM266_AC2_a_malformed_id_is_400_and_never_queries', async () => {
    const client = createFakeClient([reinstated()]);
    const res = await reinstate(client, { id: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM266_AC2_an_unknown_booking_is_404', async () => {
    const res = await reinstate(createFakeClient([dbFailure('P0002', 'booking not found')]));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('booking not found');
  });

  it.each([
    'BOOKING_NOT_FLAGGED',
    'SAFETY_FLAG_NOT_REINSTATABLE',
    'EVENT_NOT_BOOKABLE',
    'BOOKING_PERIOD_STALE',
    'VENUE_RETIRED',
  ])('SCRUM266_AC2_a_%s_refusal_is_409_with_its_code', async (hint) => {
    const res = await reinstate(createFakeClient([dbFailure('PT409', 'refused', { hint })]));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'refused', code: hint, conflicts: [] });
  });

  it('SCRUM266_AC2_a_booking_changed_under_the_call_is_409_BOOKING_CHANGED', async () => {
    const res = await reinstate(createFakeClient([dbFailure('40001', 'changed')]));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BOOKING_CHANGED');
  });

  it('SCRUM266_AC2_an_occupied_period_is_409_BOOKING_PERIOD_CONFLICT_with_what_occupies_it', async () => {
    const conflict = {
      kind: 'booking',
      booking_id: OTHER_BOOKING_ID,
      event_request_id: '12121212-1212-4212-8212-121212121212',
      event_name: 'Careers Fair',
      starts_at: START,
      ends_at: END,
      occupied_starts_at: START,
      occupied_ends_at: END,
      setup_minutes: 30,
      turnaround_minutes: 45,
    };
    const res = await reinstate(createFakeClient([ok({ outcome: 'conflict', conflicts: [conflict] })]));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BOOKING_PERIOD_CONFLICT');
    expect(res.body.conflicts).toEqual([
      expect.objectContaining({ kind: 'booking', bookingId: OTHER_BOOKING_ID, eventName: 'Careers Fair', setupMinutes: 30 }),
    ]);
  });

  it('SCRUM266_AC2_an_unexpected_outcome_is_500_without_the_detail', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await reinstate(createFakeClient([ok({ outcome: 'approved' })]));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Unexpected server error' });
    spy.mockRestore();
  });

  it('SCRUM266_AC2_a_coordinator_still_cannot_reinstate_and_never_queries', async () => {
    const client = createFakeClient([reinstated()]);
    const res = await reinstate(client, { requireAuth: signedInWithRole(ROLE.EVENT_COORDINATOR, COORDINATOR_ID) });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('This action is restricted to Venue Staff');
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM266_AC2_the_default_export_is_a_router', () => {
    expect(typeof defaultRouter).toBe('function');
    expect(typeof defaultRouter.use).toBe('function');
  });

  it('SCRUM266_AC2_app_js_mounts_the_router_at_api_flagged_bookings', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const app = readFileSync(resolve(here, '../../src/app.js'), 'utf8');
    expect(app).toMatch(/import flaggedBookingRoutes from '\.\/routes\/flaggedBookings\.js';/);
    expect(app).toMatch(/app\.use\('\/api\/flagged-bookings', flaggedBookingRoutes\);/);
  });
});

const cancelled = (resolvedBy = COORDINATOR_ID) =>
  ok({
    outcome: 'cancelled',
    booking: {
      id: BOOKING_ID,
      venue_id: VENUE_ID,
      event_request_id: EVENT_ID,
      starts_at: START,
      ends_at: END,
      status: 'cancelled',
      created_at: '2026-10-06T10:00:00+00:00',
      flagged_at: '2026-10-10T00:00:00+00:00',
      review_block_id: OTHER_BOOKING_ID,
      review_reason: null,
    },
    resolution: {
      id: RESOLUTION_ID,
      booking_id: BOOKING_ID,
      outcome: 'cancelled',
      reason: 'Venue no longer fits',
      resolved_by: resolvedBy,
      created_at: '2026-10-16T02:00:00+00:00',
    },
  });

const asCoordinator = signedInWithRole(ROLE.EVENT_COORDINATOR, COORDINATOR_ID);

/** Sends { reason: 'Venue no longer fits' } as a coordinator unless told otherwise. */
const cancel = (client, options = {}) => {
  const { requireAuth = asCoordinator, id = BOOKING_ID } = options;
  const body = 'body' in options ? options.body : { reason: 'Venue no longer fits' };
  const req = request(appWith({ client, requireAuth })).post(`/api/flagged-bookings/${id}/cancel`);
  return body === undefined ? req : req.send(body);
};

describe('SCRUM-266: the coordinator or Venue Staff cancel a flagged booking', () => {
  it('SCRUM266_AC3_cancel_is_200_for_a_coordinator_with_the_booking_and_its_resolution_and_the_caller_from_the_token', async () => {
    const client = createFakeClient([cancelled()]);

    const res = await cancel(client, { body: { reason: '  Venue no longer fits ', callerId: STAFF_ID, status: 'approved' } });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: BOOKING_ID,
      eventRequestId: EVENT_ID,
      venueId: VENUE_ID,
      status: 'cancelled',
      statusDisplay: expect.objectContaining({ status: 'cancelled' }),
      resolution: {
        id: RESOLUTION_ID,
        outcome: 'cancelled',
        reason: 'Venue no longer fits',
        resolvedBy: COORDINATOR_ID,
        resolvedAt: '2026-10-16T02:00:00+00:00',
      },
    });
    expect(client.calls).toEqual([
      {
        fn: 'cancel_flagged_booking',
        args: { p_booking_id: BOOKING_ID, p_caller: COORDINATOR_ID, p_reason: 'Venue no longer fits' },
      },
    ]);
  });

  it('SCRUM266_AC3_cancel_is_200_for_venue_staff_with_the_caller_from_the_token', async () => {
    const client = createFakeClient([cancelled(STAFF_ID)]);

    const res = await cancel(client, { requireAuth: asStaff, body: { reason: 'Venue no longer fits', callerId: COORDINATOR_ID } });

    expect(res.status).toBe(200);
    expect(res.body.resolution.resolvedBy).toBe(STAFF_ID);
    expect(client.calls).toEqual([
      {
        fn: 'cancel_flagged_booking',
        args: { p_booking_id: BOOKING_ID, p_caller: STAFF_ID, p_reason: 'Venue no longer fits' },
      },
    ]);
  });

  it('SCRUM266_AC3_cancel_returns_401_without_a_token_and_never_queries', async () => {
    const client = createFakeClient([cancelled()]);
    const res = await cancel(client, { requireAuth: signedOut });
    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });

  it.each([
    ROLE.EVENT_ORGANISER,
    ROLE.EVENT_COORDINATOR_LEAD,
    ROLE.TECHNICAL_SUPPORT_STAFF,
    ROLE.SAFETY_OFFICER,
    ROLE.ATTENDEE,
    null,
  ])('SCRUM266_AC3_cancel_refuses_%s_with_403_and_never_queries', async (role) => {
    const client = createFakeClient([cancelled()]);
    const res = await cancel(client, { requireAuth: signedInWithRole(role, COORDINATOR_ID) });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('This action is restricted to Event Coordinators or Venue Staff');
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM266_AC3_a_coordinator_not_assigned_to_the_event_is_403_from_the_function', async () => {
    const client = createFakeClient([dbFailure('42501', 'only the coordinator assigned to event request x or Venue Staff can cancel a flagged booking')]);
    const res = await cancel(client);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only the coordinator assigned/);
    expect(client.calls).toHaveLength(1);
  });

  it.each([
    ['no body', undefined],
    ['no reason', {}],
    ['a blank reason', { reason: '   ' }],
    ['a reason over 1000 characters', { reason: 'x'.repeat(1001) }],
  ])('SCRUM266_AC5_cancelling_with_%s_is_400_and_never_queries', async (_label, body) => {
    const client = createFakeClient([cancelled()]);
    const res = await cancel(client, { body });
    expect(res.status).toBe(400);
    if (body !== undefined) expect(res.body.details).toEqual([expect.objectContaining({ field: 'reason' })]);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM266_AC3_cancel_with_a_malformed_id_is_400_and_never_queries', async () => {
    const client = createFakeClient([cancelled()]);
    const res = await cancel(client, { id: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });

  it.each(['22023', '23514'])('SCRUM266_AC5_a_%s_reason_refusal_from_the_function_is_400', async (code) => {
    const res = await cancel(createFakeClient([dbFailure(code, 'bad reason')]));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad reason');
  });

  it('SCRUM266_AC3_cancel_of_an_unknown_booking_is_404', async () => {
    const res = await cancel(createFakeClient([dbFailure('P0002', 'booking not found')]));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('booking not found');
  });

  it('SCRUM266_AC3_cancel_of_a_booking_that_is_not_flagged_is_409_BOOKING_NOT_FLAGGED', async () => {
    const res = await cancel(createFakeClient([dbFailure('PT409', 'refused', { hint: 'BOOKING_NOT_FLAGGED' })]));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'refused', code: 'BOOKING_NOT_FLAGGED', conflicts: [] });
  });

  it('SCRUM266_AC3_cancel_of_a_booking_changed_under_the_call_is_409_BOOKING_CHANGED', async () => {
    const res = await cancel(createFakeClient([dbFailure('40001', 'changed')]));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BOOKING_CHANGED');
  });

  it('SCRUM266_AC3_cancel_with_an_unexpected_outcome_is_500_without_the_detail', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await cancel(createFakeClient([ok({ outcome: 'reinstated' })]));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Unexpected server error' });
    spy.mockRestore();
  });
});
