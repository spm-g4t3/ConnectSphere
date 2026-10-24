/**
 * SCRUM-539 (SCRUM-578): POST /:id/cancel and GET /:id/cancellation-impact let
 * the Event Coordinator Lead through, and cancel_event_request and its preview
 * decide which event each caller may act on (013). Cases:
 * docs/test-cases/SCRUM-539.md.
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createEventRequestRouter } from '../../src/routes/eventRequests.js';
import { ROLE } from '../../src/domain/userRole.js';
import { STATUS } from '../../src/domain/eventRequestStatus.js';
import { ok, dbError, createEventRequestClient } from '../fixtures/supabaseStubs.js';
import { signedInFor } from '../fixtures/auth.js';

const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const ORGANISER_ID = '11111111-1111-4111-8111-111111111111';
const LEAD_ID = '77777777-7777-4777-8777-777777777777';
const COORDINATOR_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_ID = '66666666-6666-4666-8666-666666666666';

const signedInWithRole = signedInFor(LEAD_ID);

function appWith({ client, requireAuth = signedInWithRole(ROLE.EVENT_COORDINATOR_LEAD) }) {
  return express()
    .use(express.json())
    .use('/api/event-requests', createEventRequestRouter({ client, requireAuth }));
}

const storedRow = (overrides = {}) => ({
  id: REQUEST_ID,
  organiser_id: ORGANISER_ID,
  event_name: 'IS212 Industry Night',
  status: STATUS.SUBMITTED,
  assigned_coordinator_id: null,
  created_at: '2026-10-20T03:00:00+00:00',
  updated_at: '2026-10-21T03:00:00+00:00',
  submitted_at: '2026-10-20T04:00:00+00:00',
  ...overrides,
});

const BODY = { reason: 'Organiser no longer needs it', initiator: 'organiser_request' };

const cancel = (client, { body = BODY, requireAuth } = {}) =>
  request(appWith({ client, requireAuth })).post(`/api/event-requests/${REQUEST_ID}/cancel`).send(body);
const previewOf = (client, requireAuth) =>
  request(appWith({ client, requireAuth })).get(`/api/event-requests/${REQUEST_ID}/cancellation-impact`);

describe('SCRUM-539: the Lead reaches cancel and its preview', () => {
  it('SCRUM539_AC1_a_lead_cancels_and_the_caller_comes_from_the_token', async () => {
    // AC1-06: a coordinatorId in the body is not a parameter anyone reads.
    const client = createEventRequestClient([
      ok(storedRow({ status: STATUS.CANCELLED, cancelled_by: LEAD_ID, cancellation_reason: BODY.reason })),
    ]);

    const res = await cancel(client, { body: { ...BODY, coordinatorId: OTHER_ID } });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: REQUEST_ID, status: STATUS.CANCELLED });
    expect(client.calls).toEqual([expect.objectContaining({
      fn: 'cancel_event_request',
      args: {
        p_event_request_id: REQUEST_ID,
        p_coordinator_id: LEAD_ID,
        p_reason: BODY.reason,
        p_initiator: 'organiser_request',
        p_attendee_message: null,
      },
    })]);
  });

  it('SCRUM539_AC1_a_lead_reaches_the_preview', async () => {
    // AC1-07: the event read first (404 for a draft), then the function decides.
    const impact = { eventRequestId: REQUEST_ID, venueBookings: { count: 0, details: [] } };
    const client = createEventRequestClient([ok(storedRow()), ok(impact)]);

    const res = await previewOf(client);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(impact);
    expect(client.calls[1]).toMatchObject({
      fn: 'event_cancellation_impact_preview',
      args: { p_event_request_id: REQUEST_ID, p_caller: LEAD_ID },
    });
  });

  it('SCRUM539_AC3_a_lead_reaches_cancel_and_the_database_refuses_a_held_event_with_403', async () => {
    // AC3-03: moved here from SCRUM487_AC5_a_lead_is_refused_%s_with_403_and_queries_nothing.
    const client = createEventRequestClient([
      dbError('42501', 'Only the coordinator assigned to event request x can cancel it; the Event Coordinator Lead cancels only requests nobody holds'),
    ]);

    const res = await cancel(client);

    expect(res.status).toBe(403);
    expect(client.calls).toEqual([expect.objectContaining({ fn: 'cancel_event_request' })]);
  });

  it('SCRUM539_AC3_a_lead_previewing_a_held_event_is_answered_403_by_the_function', async () => {
    // AC3-02 over HTTP: the route no longer compares the holder itself.
    const client = createEventRequestClient([
      ok(storedRow({ status: STATUS.APPROVED, assigned_coordinator_id: COORDINATOR_ID })),
      dbError('42501', 'Only the coordinator assigned to this event can preview its cancellation'),
    ]);

    expect((await previewOf(client)).status).toBe(403);
    expect(client.calls[1]).toMatchObject({ fn: 'event_cancellation_impact_preview' });
  });

  it('SCRUM539_AC4_a_coordinator_on_an_unassigned_request_gets_409', async () => {
    // AC4-07: the function's 55000, "waiting for the Event Coordinator Lead".
    const client = createEventRequestClient([
      dbError('55000', 'event request x is waiting for the Event Coordinator Lead to assign it a coordinator; only the Lead can cancel it'),
    ]);

    const res = await cancel(client, { requireAuth: signedInWithRole(ROLE.EVENT_COORDINATOR, COORDINATOR_ID) });

    expect(res.status).toBe(409);
    expect(client.calls[0].args.p_coordinator_id).toBe(COORDINATOR_ID);
  });

  it.each([
    ['organiser', ROLE.EVENT_ORGANISER],
    ['venue_staff', ROLE.VENUE_STAFF],
    ['technical_support', ROLE.TECHNICAL_SUPPORT_STAFF],
    ['safety_officer', ROLE.SAFETY_OFFICER],
    ['attendee', ROLE.ATTENDEE],
  ])('SCRUM539_AC4_%s_is_refused_with_403_and_queries_nothing', async (_label, role) => {
    // AC4-03: coordinatorOrLead, on both routes. Nothing queued, so a query
    // that slipped past the gate fails rather than passing by accident.
    const client = createEventRequestClient([]);
    const requireAuth = signedInWithRole(role, OTHER_ID);

    expect((await cancel(client, { requireAuth })).status).toBe(403);
    expect((await previewOf(client, requireAuth)).status).toBe(403);
    expect(client.calls).toHaveLength(0);
  });
});
