/**
 * Route tests for GET /api/equipment-requests/reviewed-by-me.
 *
 * SCRUM-582. Named SCRUM582_AC<n>_<what_it_checks>. About transport and
 * authorisation; the database function is tested against Postgres in
 * tests/db/scrum582ReviewedByMeDatabase.test.js.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { signedOut, signedInFor } from '../fixtures/auth.js';

vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: {}, supabaseAdmin: {} }));

const { createEquipmentQueueRouter } = await import('../../src/routes/equipmentQueue.js');
const { ROLE } = await import('../../src/domain/userRole.js');

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '66666666-6666-4666-8666-666666666666';
const URL = '/api/equipment-requests/reviewed-by-me';

const reviewedRow = {
  event_request_id: EVENT_ID,
  event_name: 'Annual Dinner',
  proposed_start: '2030-01-10T10:00:00+00:00',
  proposed_end: '2030-01-10T12:00:00+00:00',
  status: 'pending_review',
  last_worked_at: '2030-01-05T09:00:00+00:00',
  interrupted_reason: 'The lines were changed during the review',
  interrupted_at: '2030-01-05T09:30:00+00:00',
  returned_to_pending: true,
};

const fakeClient = (answer = { data: { requests: [reviewedRow], total: 1, truncated: false }, error: null }) => ({
  rpc: vi.fn(async () => answer),
  from: vi.fn(),
});

const signedInAs = signedInFor(USER_ID);

const appWith = (client, requireAuth = signedInAs(ROLE.TECHNICAL_SUPPORT_STAFF)) =>
  express().use('/api/equipment-requests', createEquipmentQueueRouter({ requireAuth, client }));

const OTHER_ROLES = [
  ROLE.EVENT_ORGANISER,
  ROLE.EVENT_COORDINATOR,
  ROLE.VENUE_STAFF,
  ROLE.ATTENDEE,
  ROLE.EVENT_COORDINATOR_LEAD,
  ROLE.SAFETY_OFFICER,
];

describe('AC5: only Technical Support Staff, only their own history', () => {
  it.each(OTHER_ROLES)('SCRUM582_AC5_refuses_%s_with_403_and_reaches_nothing', async (role) => {
    const client = fakeClient();
    const res = await request(appWith(client, signedInAs(role))).get(URL);
    expect(res.status).toBe(403);
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
  });

  it('SCRUM582_AC5_refuses_a_signed_out_caller_with_401', async () => {
    const client = fakeClient();
    const res = await request(appWith(client, signedOut)).get(URL);
    expect(res.status).toBe(401);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM582_AC5_the_database_refusing_the_role_is_a_403', async () => {
    const client = fakeClient({ data: null, error: { code: '42501', message: 'Only technical support staff can see the requests they have reviewed' } });
    const res = await request(appWith(client)).get(URL);
    expect(res.status).toBe(403);
  });
});

describe('AC1, AC2 and AC4: what comes back', () => {
  it('SCRUM582_AC5_asks_for_the_callers_own_history_and_nobody_elses', async () => {
    const client = fakeClient();
    await request(appWith(client)).get(`${URL}?userId=someone-else`);
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith('equipment_reviewed_by_me', { p_caller: USER_ID });
  });

  it('SCRUM582_AC2_answers_in_camel_case_with_the_status_label_the_interruption_and_the_pending_flag', async () => {
    const res = await request(appWith(fakeClient())).get(URL);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      requests: [
        {
          eventRequestId: EVENT_ID,
          eventName: 'Annual Dinner',
          proposedStart: '2030-01-10T10:00:00+00:00',
          proposedEnd: '2030-01-10T12:00:00+00:00',
          status: 'pending_review',
          statusLabel: 'Pending review',
          lastWorkedAt: '2030-01-05T09:00:00+00:00',
          returnedToPending: true,
          interruptedReason: 'The lines were changed during the review',
          interruptedAt: '2030-01-05T09:30:00+00:00',
        },
      ],
      total: 1,
      truncated: false,
    });
  });

  it('SCRUM582_AC1_an_empty_history_is_an_empty_list_not_an_error', async () => {
    const client = fakeClient({ data: null, error: null });
    const res = await request(appWith(client)).get(URL);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requests: [], total: 0, truncated: false });
  });

  it('SCRUM582_AC5_the_response_is_not_cached_and_carries_nothing_beyond_the_listed_fields', async () => {
    const client = fakeClient({
      data: { requests: [{ ...reviewedRow, reviewer_id: 'secret-reviewer', notes: 'private' }], total: 1, truncated: false },
      error: null,
    });
    const res = await request(appWith(client)).get(URL);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(res.body)).not.toMatch(/secret-reviewer|private/);
  });

  it('SCRUM582_AC4_reading_calls_one_function_and_writes_nothing', async () => {
    const client = fakeClient();
    await request(appWith(client)).get(URL);
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.from).not.toHaveBeenCalled();
  });

  it('SCRUM582_AC1_the_queue_route_is_unchanged_by_the_new_path', async () => {
    const queueClient = fakeClient({ data: { needs_action: [], requests: [] }, error: null });
    const res = await request(appWith(queueClient)).get('/api/equipment-requests');
    expect(res.status).toBe(200);
    expect(queueClient.rpc).toHaveBeenCalledWith('equipment_request_queue', expect.any(Object));
  });
});

describe('failures', () => {
  it('SCRUM582_AC5_an_unexpected_database_failure_is_a_500_without_its_message', async () => {
    const client = fakeClient({ data: null, error: { code: 'XX000', message: 'relation "x" exploded' } });
    const res = await request(appWith(client)).get(URL);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('exploded');
  });
});
