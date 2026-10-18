/**
 * SCRUM-492 (SCRUM-565): POST /api/booking-requests/:id/release over HTTP.
 * The gate, the caller from the token, the body, and the status each refusal
 * arrives as. The fake client is bookingRequests.test.js's, copied.
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createBookingRequestRouter } from '../../src/routes/bookingRequests.js';
import { ROLE } from '../../src/domain/userRole.js';

const COORDINATOR_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_ID = '66666666-6666-4666-8666-666666666666';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const VENUE_ID = '33333333-3333-4333-8333-333333333333';
const BOOKING_ID = '44444444-4444-4444-8444-444444444444';
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

const released = ok({
  outcome: 'released',
  booking: {
    id: BOOKING_ID,
    event_request_id: EVENT_ID,
    venue_id: VENUE_ID,
    status: 'released',
    starts_at: '2026-12-01T05:00:00+00:00',
    ends_at: '2026-12-01T06:00:00+00:00',
    created_at: '2026-10-01T03:00:00+00:00',
    released_by: COORDINATOR_ID,
    released_at: '2026-10-18T03:00:00+00:00',
    release_reason: 'Moving to Hall B',
  },
  returned_to_pending: [FREED_ID],
});

const signedInWithRole = (role, id = COORDINATOR_ID) => (req, _res, next) => {
  req.user = { id, email: 'user@example.com', role };
  next();
};
const signedOut = (_req, res) => res.status(401).json({ error: 'Authentication required' });

const releaseCall = (client, { id = BOOKING_ID, body = { reason: 'Moving to Hall B' }, requireAuth } = {}) =>
  request(
    express()
      .use(express.json())
      .use('/api/booking-requests', createBookingRequestRouter({
        client,
        requireAuth: requireAuth ?? signedInWithRole(ROLE.EVENT_COORDINATOR),
      })),
  ).post(`/api/booking-requests/${id}/release`).send(body);


describe('SCRUM-492: POST /api/booking-requests/:id/release', () => {
  it('SCRUM492_AC2_the_holder_releases_and_gets_the_booking_and_the_requests_returned_to_pending', async () => {
    // AC2-06.
    const client = createFakeClient([released]);

    const res = await releaseCall(client);

    expect(res.status).toBe(200);
    expect(res.body.returnedToPending).toEqual([FREED_ID]);
    expect(res.body.booking).toMatchObject({
      id: BOOKING_ID,
      status: 'released',
      statusDisplay: { label: 'Released', group: 'RELEASED' },
      releasedBy: COORDINATOR_ID,
      releaseReason: 'Moving to Hall B',
    });
  });

  it('SCRUM492_AC1_the_caller_is_the_tokens_user_and_the_bodys_ids_are_ignored', async () => {
    // AC1-12.
    const client = createFakeClient([released]);

    await releaseCall(client, { body: { reason: 'Moving', coordinatorId: OTHER_ID, releasedBy: OTHER_ID } });

    expect(client.calls).toEqual([{
      fn: 'release_venue_booking',
      args: { p_booking_id: BOOKING_ID, p_caller: COORDINATOR_ID, p_reason: 'Moving' },
    }]);
  });

  it.each([
    ROLE.EVENT_COORDINATOR_LEAD, ROLE.VENUE_STAFF, ROLE.EVENT_ORGANISER,
    ROLE.TECHNICAL_SUPPORT_STAFF, ROLE.ATTENDEE, ROLE.SAFETY_OFFICER, null,
  ].map((role) => [String(role), role]))(
    'SCRUM492_AC1_%s_is_refused_with_403_by_the_gate_and_queries_nothing',
    async (_label, role) => {
      // AC1-11: coordinatorOnly. A Lead and Venue Staff too (D1).
      const client = createFakeClient([]);

      const res = await releaseCall(client, { requireAuth: signedInWithRole(role, OTHER_ID) });

      expect(res.status).toBe(403);
      expect(client.calls).toHaveLength(0);
    },
  );

  it('SCRUM492_AC1_the_release_answers_401_without_a_token', async () => {
    const client = createFakeClient([]);

    expect((await releaseCall(client, { requireAuth: signedOut })).status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });

  it.each([
    ['an_empty_body', {}, BOOKING_ID],
    ['a_blank_reason', { reason: '   ' }, BOOKING_ID],
    ['a_reason_of_1001_characters', { reason: 'x'.repeat(1001) }, BOOKING_ID],
    ['a_malformed_id', { reason: 'Moving' }, 'not-a-uuid'],
  ])('SCRUM492_AC1_%s_is_400_and_queries_nothing', async (_label, body, id) => {
    // AC1-13.
    const client = createFakeClient([]);

    const res = await releaseCall(client, { id, body });

    expect(res.status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });

  it.each([
    ['EVENT_NOT_APPROVED', dbFailure('PT409', 'words', { hint: 'EVENT_NOT_APPROVED' }), 409],
    ['BOOKING_NOT_APPROVED', dbFailure('PT409', 'words', { hint: 'BOOKING_NOT_APPROVED' }), 409],
    ['BOOKING_CHANGED', dbFailure('40001', 'words'), 409],
  ])('SCRUM492_AC1_a_%s_refusal_is_a_409_with_its_code', async (code, answer, status) => {
    // AC1-14.
    const client = createFakeClient([answer]);

    const res = await releaseCall(client);

    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
  });

  it.each([
    ['42501', 403],
    ['P0002', 404],
  ])('SCRUM492_AC1_the_functions_%s_is_a_%s', async (code, status) => {
    const client = createFakeClient([dbFailure(code, 'words')]);

    expect((await releaseCall(client)).status).toBe(status);
  });
});


describe('SCRUM-492: GET /api/booking-requests/mine', () => {
  it('SCRUM492_AC2_a_released_booking_in_the_list_carries_when_and_why', async () => {
    // AC2-07: the list reads the two columns and maps them.
    const row = {
      id: BOOKING_ID,
      event_request_id: EVENT_ID,
      venue_id: VENUE_ID,
      starts_at: '2026-12-01T05:00:00+00:00',
      ends_at: '2026-12-01T06:00:00+00:00',
      status: 'released',
      created_at: '2026-10-01T03:00:00+00:00',
      released_at: '2026-10-18T03:00:00+00:00',
      release_reason: 'Moving to Hall B',
      venues: { name: 'Hall A', location: 'Level 2' },
      event_requests: { event_name: 'IS212 Industry Night', status: 'approved', assigned_coordinator_id: COORDINATOR_ID },
    };
    const selects = [];
    const client = {
      from: () => {
        const chain = {
          select: (columns) => { selects.push(columns); return chain; },
          eq: () => chain,
          order: () => chain,
          then: (resolve, reject) => Promise.resolve(ok([row])).then(resolve, reject),
        };
        return chain;
      },
    };

    const res = await request(
      express().use(express.json()).use('/api/booking-requests', createBookingRequestRouter({
        client, requireAuth: signedInWithRole(ROLE.EVENT_COORDINATOR),
      })),
    ).get('/api/booking-requests/mine');

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      status: 'released',
      statusDisplay: { label: 'Released' },
      releasedAt: '2026-10-18T03:00:00+00:00',
      releaseReason: 'Moving to Hall B',
    });
    expect(selects[0]).toMatch(/\breleased_at\b/);
    expect(selects[0]).toMatch(/\brelease_reason\b/);
  });
});
