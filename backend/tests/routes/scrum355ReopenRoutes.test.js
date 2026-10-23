/**
 * SCRUM-355: POST /api/event-requests/:id/reopen and GET /:id/decision-history
 * over HTTP. The gate, the caller from the token, and how each refusal arrives.
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createEventRequestRouter } from '../../src/routes/eventRequests.js';
import { ROLE } from '../../src/domain/userRole.js';
import { ok, dbError, createEventRequestClient } from '../fixtures/supabaseStubs.js';
import { signedOut, signedInFor } from '../fixtures/auth.js';

const ORGANISER_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const COORDINATOR_ID = '55555555-5555-4555-8555-555555555555';
const HISTORY_ID = '66666666-6666-4666-8666-666666666666';

const storedRow = (overrides = {}) => ({
  id: REQUEST_ID,
  organiser_id: ORGANISER_ID,
  event_name: 'IS212 Industry Night',
  status: 'draft',
  created_at: '2026-10-01T03:00:00+00:00',
  updated_at: '2026-10-20T03:00:00+00:00',
  submitted_at: null,
  ...overrides,
});

const historyRow = {
  id: HISTORY_ID,
  decision: 'rejected',
  decision_note: 'The venue is too small.',
  decided_by: COORDINATOR_ID,
  decided_at: '2026-10-15T03:00:00+00:00',
  superseded_reason: 'reopened_for_revision',
  superseded_at: '2026-10-20T03:00:00+00:00',
};

const signedInAs = signedInFor(ORGANISER_ID);

const app = (client, requireAuth = signedInAs(ROLE.EVENT_ORGANISER)) =>
  express()
    .use(express.json())
    .use('/api/event-requests', createEventRequestRouter({ client, requireAuth }));

const reopenCall = (client, requireAuth) =>
  request(app(client, requireAuth)).post(`/api/event-requests/${REQUEST_ID}/reopen`).send({ organiserId: OTHER_ID });

const historyCall = (client, requireAuth) =>
  request(app(client, requireAuth)).get(`/api/event-requests/${REQUEST_ID}/decision-history`);


describe('SCRUM-355: POST /api/event-requests/:id/reopen', () => {
  it('SCRUM355_AC2_the_organiser_gets_the_request_back_as_a_draft', async () => {
    const client = createEventRequestClient([ok(storedRow())]);

    const res = await reopenCall(client);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: REQUEST_ID,
      status: 'draft',
      decision: null,
      statusDisplay: { label: 'Draft' },
    });
  });

  it('SCRUM355_AC1_the_caller_is_the_tokens_user_and_the_body_is_ignored', async () => {
    const client = createEventRequestClient([ok(storedRow())]);

    await reopenCall(client);

    expect(client.calls).toEqual([expect.objectContaining({
      operation: 'rpc',
      fn: 'reopen_event_request',
      args: { p_event_request_id: REQUEST_ID, p_caller: ORGANISER_ID },
    })]);
  });

  it.each([
    ROLE.EVENT_COORDINATOR, ROLE.EVENT_COORDINATOR_LEAD, ROLE.VENUE_STAFF,
    ROLE.TECHNICAL_SUPPORT_STAFF, ROLE.ATTENDEE, ROLE.SAFETY_OFFICER, null,
  ].map((role) => [String(role), role]))(
    'SCRUM355_AC1_%s_is_refused_with_403_by_the_gate_and_queries_nothing',
    async (_label, role) => {
      const client = createEventRequestClient([]);

      const res = await reopenCall(client, signedInAs(role, OTHER_ID));

      expect(res.status).toBe(403);
      expect(client.calls).toHaveLength(0);
    },
  );

  it('SCRUM355_AC1_the_reopen_answers_401_without_a_token', async () => {
    const client = createEventRequestClient([]);

    expect((await reopenCall(client, signedOut)).status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM355_AC1_a_request_in_another_status_is_a_409_naming_it', async () => {
    const message = 'This request is Under review, and only a Rejected request can be reopened for revision';
    const client = createEventRequestClient([dbError('55000', message)]);

    const res = await reopenCall(client);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(message);
  });

  it.each([
    ['P0002', 404],
    ['42501', 403],
  ])('SCRUM355_AC1_the_functions_%s_is_a_%s', async (code, status) => {
    const client = createEventRequestClient([dbError(code, `event request ${REQUEST_ID} not found`)]);

    expect((await reopenCall(client)).status).toBe(status);
  });
});


describe('SCRUM-355: GET /api/event-requests/:id/decision-history', () => {
  it('SCRUM355_AC3_the_organiser_reads_their_reopened_drafts_past_decisions', async () => {
    const client = createEventRequestClient([
      ok(storedRow()),
      ok([historyRow]),
      ok([{ id: COORDINATOR_ID, full_name: 'Casey Coordinator' }]),
    ]);

    const res = await historyCall(client);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{
      id: HISTORY_ID,
      decision: 'rejected',
      decisionNote: 'The venue is too small.',
      decidedByName: 'Casey Coordinator',
      decidedAt: '2026-10-15T03:00:00+00:00',
      supersededReason: 'reopened_for_revision',
      supersededAt: '2026-10-20T03:00:00+00:00',
    }]);
    expect(client.calls[1]).toMatchObject({
      table: 'event_request_decision_history',
      filters: [['event_request_id', REQUEST_ID]],
      order: [['decided_at', { ascending: true }], ['id', { ascending: true }]],
    });
  });

  it.each([ROLE.EVENT_COORDINATOR, ROLE.EVENT_COORDINATOR_LEAD])(
    'SCRUM355_AC5_a_%s_reads_a_resubmitted_requests_past_decisions',
    async (role) => {
      const client = createEventRequestClient([
        ok(storedRow({ status: 'submitted' })),
        ok([historyRow]),
        ok([]),
      ]);

      const res = await historyCall(client, signedInAs(role, COORDINATOR_ID));

      expect(res.status).toBe(200);
      expect(res.body).toEqual([expect.objectContaining({ decision: 'rejected', decidedByName: null })]);
    },
  );

  it('SCRUM355_AC5_a_request_never_decided_before_has_an_empty_history', async () => {
    const client = createEventRequestClient([ok(storedRow({ status: 'submitted' })), ok([])]);

    const res = await historyCall(client, signedInAs(ROLE.EVENT_COORDINATOR, COORDINATOR_ID));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it.each([
    ['another_organiser', ROLE.EVENT_ORGANISER, 'rejected'],
    ['a_coordinator_on_a_draft', ROLE.EVENT_COORDINATOR, 'draft'],
    ['venue_staff', ROLE.VENUE_STAFF, 'submitted'],
  ])('SCRUM355_AC3_%s_gets_a_404', async (_label, role, status) => {
    const client = createEventRequestClient([ok(storedRow({ status }))]);

    const res = await historyCall(client, signedInAs(role, OTHER_ID));

    expect(res.status).toBe(404);
    expect(client.calls).toHaveLength(1);
  });

  it('SCRUM355_AC3_a_failed_read_is_not_reported_as_an_empty_history', async () => {
    const client = createEventRequestClient([ok(storedRow()), dbError('XX000', 'boom')]);

    expect((await historyCall(client)).status).toBe(500);
  });
});
