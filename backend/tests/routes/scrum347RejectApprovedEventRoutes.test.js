/**
 * SCRUM-347: POST /:id/rejection, through the router and rejectApprovedEvent to
 * a stubbed reject_approved_event (024).
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
const COORDINATOR_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_ID = '66666666-6666-4666-8666-666666666666';

const signedInAs = signedInFor(COORDINATOR_ID);

const rejectedRow = {
  id: REQUEST_ID,
  organiser_id: ORGANISER_ID,
  event_name: 'IS212 Industry Night',
  status: STATUS.REJECTED,
  assigned_coordinator_id: COORDINATOR_ID,
  reviewing_coordinator_id: COORDINATOR_ID,
  decision: 'rejected',
  decision_note: 'The hall is closed.',
  decided_by: COORDINATOR_ID,
  decided_at: '2026-10-25T03:00:00+00:00',
  created_at: '2026-10-20T03:00:00+00:00',
  updated_at: '2026-10-25T03:00:00+00:00',
  submitted_at: '2026-10-20T04:00:00+00:00',
};

const reject = (client, { body = { reason: 'The hall is closed.' }, role = ROLE.EVENT_COORDINATOR } = {}) =>
  request(
    express()
      .use(express.json())
      .use('/api/event-requests', createEventRequestRouter({ client, requireAuth: signedInAs(role) })),
  ).post(`/api/event-requests/${REQUEST_ID}/rejection`).send(body);

describe('SCRUM-347: POST /api/event-requests/:id/rejection', () => {
  it('SCRUM347_AC3_rejects_with_the_trimmed_reason_and_the_caller_from_the_token', async () => {
    const client = createEventRequestClient([ok(rejectedRow)]);

    const res = await reject(client, { body: { reason: '  The hall is closed.  ', coordinatorId: OTHER_ID } });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: REQUEST_ID, status: STATUS.REJECTED, decisionNote: 'The hall is closed.' });
    expect(client.calls).toEqual([expect.objectContaining({
      fn: 'reject_approved_event',
      args: { p_event_request_id: REQUEST_ID, p_coordinator_id: COORDINATOR_ID, p_reason: 'The hall is closed.' },
    })]);
  });

  it.each([ROLE.EVENT_ORGANISER, ROLE.EVENT_COORDINATOR_LEAD, ROLE.VENUE_STAFF])(
    'SCRUM347_AC1_a_%s_is_refused_before_any_call',
    async (role) => {
      const client = createEventRequestClient([]);

      const res = await reject(client, { role });

      expect(res.status).toBe(403);
      expect(client.calls).toEqual([]);
    },
  );

  it.each([['missing', {}], ['empty', { reason: '' }], ['blank', { reason: ' \t\n' }], ['not text', { reason: 7 }]])(
    'SCRUM347_AC1_a_%s_reason_is_a_400_naming_the_field_before_any_call',
    async (_kind, body) => {
      const client = createEventRequestClient([]);

      const res = await reject(client, { body });

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([expect.objectContaining({ field: 'reason' })]);
      expect(client.calls).toEqual([]);
    },
  );

  it('SCRUM347_AC1_another_coordinator_is_a_403', async () => {
    const client = createEventRequestClient([
      dbError('42501', "Only the event's assigned Event Coordinator can reject it"),
    ]);

    const res = await reject(client);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only the event's assigned Event Coordinator can reject it");
  });

  it('SCRUM347_AC1_an_event_in_another_status_is_a_409_naming_it', async () => {
    const message = 'This event is Under review, and only an Approved event can be rejected.';
    const client = createEventRequestClient([dbError('55000', message)]);

    const res = await reject(client);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: message, code: null });
  });

  it('SCRUM347_AC1_a_confirmed_event_is_a_409_with_the_cancel_instead_code', async () => {
    const message = 'This event is Confirmed, and only an Approved event can be rejected. Cancel it instead.';
    const client = createEventRequestClient([dbError('55000', message, { hint: 'CANCEL_INSTEAD' })]);

    const res = await reject(client);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: message, code: 'CANCEL_INSTEAD' });
  });

  it('SCRUM347_AC6_a_rejected_event_takes_no_new_change_requests', async () => {
    const client = createEventRequestClient([
      // The route's ownership pre-check, then createChangeRequest's own read.
      ok(rejectedRow),
      ok({ id: REQUEST_ID, organiser_id: ORGANISER_ID, status: STATUS.REJECTED }),
    ]);

    const res = await request(
      express()
        .use(express.json())
        .use('/api/event-requests', createEventRequestRouter({
          client, requireAuth: signedInAs(ROLE.EVENT_ORGANISER, ORGANISER_ID),
        })),
    ).post(`/api/event-requests/${REQUEST_ID}/change-requests`).send({ field: 'venue', details: 'A larger room.' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot request a change to a rejected event; revise and resubmit it instead');
    expect(client.calls.map((call) => call.operation)).not.toContain('insert');
  });

  it('SCRUM347_AC1_a_missing_event_is_a_404', async () => {
    const client = createEventRequestClient([dbError('P0002', `event request ${REQUEST_ID} not found`)]);

    expect((await reject(client)).status).toBe(404);
  });
});
