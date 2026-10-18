/**
 * Route tests for the equipment request queue.
 *
 * SCRUM-284. Named N22_ACn_<what_it_checks>. About transport and
 * authorisation: only Technical Support Staff reach the route (AC1), a refused
 * attempt reaches no database function, and each fault has the right status. The
 * client is injected, so the real Express routing and the real service run and
 * only the database is faked.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: {}, supabaseAdmin: {} }));

const { createEquipmentQueueRouter } = await import('../../src/routes/equipmentQueue.js');
const { ROLE } = await import('../../src/domain/userRole.js');

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '66666666-6666-4666-8666-666666666666';

const queueRow = {
  event_request_id: EVENT_ID,
  event_name: 'Annual Dinner',
  proposed_start: '2030-01-10T10:00:00+00:00',
  proposed_end: '2030-01-10T12:00:00+00:00',
  venues: [],
  coordinator_id: null,
  coordinator_name: null,
  item_count: 2,
  status: 'pending_review',
  reviewer_id: null,
  reviewer_name: null,
  flagged_count: 0,
  flag_reasons: [],
};

const fakeClient = (answer = { data: { needs_action: [queueRow], requests: [queueRow] }, error: null }) => ({
  rpc: vi.fn(async () => answer),
  from: vi.fn(),
});

const signedInAs = (role) => (req, _res, next) => {
  req.user = { id: USER_ID, email: 'someone@example.com', role };
  next();
};
const signedOut = (_req, res) => res.status(401).json({ error: 'Authentication required' });

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

describe('AC1: only Technical Support Staff open the dashboard', () => {
  it.each(OTHER_ROLES)('N22_AC1_refuses_%s_with_403_and_reaches_nothing', async (role) => {
    const client = fakeClient();
    const res = await request(appWith(client, signedInAs(role))).get('/api/equipment-requests');
    expect(res.status).toBe(403);
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
  });

  it('N22_AC1_refuses_a_signed_out_caller_with_401', async () => {
    const client = fakeClient();
    const res = await request(appWith(client, signedOut)).get('/api/equipment-requests');
    expect(res.status).toBe(401);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('N22_AC1_refuses_a_user_with_no_role_with_403', async () => {
    const client = fakeClient();
    const res = await request(appWith(client, (req, _res, next) => { req.user = { id: USER_ID }; next(); })).get('/api/equipment-requests');
    expect(res.status).toBe(403);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('N22_AC1_lets_technical_support_staff_in', async () => {
    const res = await request(appWith(fakeClient())).get('/api/equipment-requests');
    expect(res.status).toBe(200);
  });
});

describe('AC2 to AC4: what comes back', () => {
  it('N22_AC2_answers_with_the_two_lists', async () => {
    const res = await request(appWith(fakeClient())).get('/api/equipment-requests');
    expect(Object.keys(res.body).sort()).toEqual([
      'needsAction',
      'needsActionTotal',
      'needsActionTruncated',
      'requests',
      'requestsTotal',
      'requestsTruncated',
      'statuses',
    ]);
    expect(res.body.requests[0]).toMatchObject({ eventRequestId: EVENT_ID, eventName: 'Annual Dinner', statusLabel: 'Pending review' });
  });

  it('N22_AC2_passes_the_filter_and_the_past_flag_to_the_database', async () => {
    const client = fakeClient();
    await request(appWith(client)).get('/api/equipment-requests?status=cancelled&includePast=true');
    expect(client.rpc).toHaveBeenCalledWith('equipment_request_queue', {
      p_caller: USER_ID,
      p_status: 'cancelled',
      p_include_past: true,
    });
  });

  it('N22_AC2_a_bad_status_is_a_400_naming_the_field_and_reaches_no_function', async () => {
    const client = fakeClient();
    const res = await request(appWith(client)).get('/api/equipment-requests?status=arrange');
    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe('status');
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('N22_AC2_a_bad_includePast_is_a_400', async () => {
    const res = await request(appWith(fakeClient())).get('/api/equipment-requests?includePast=maybe');
    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe('includePast');
  });

  it('N22_AC2_a_status_given_twice_is_a_400', async () => {
    const res = await request(appWith(fakeClient())).get('/api/equipment-requests?status=arranged&status=cancelled');
    expect(res.status).toBe(400);
  });

  it('N22_AC6_the_response_carries_nothing_beyond_the_listed_fields', async () => {
    const client = fakeClient({ data: { needs_action: [], requests: [{ ...queueRow, organiser_id: 'secret-organiser', notes: 'private' }] }, error: null });
    const res = await request(appWith(client)).get('/api/equipment-requests');
    expect(JSON.stringify(res.body)).not.toMatch(/secret-organiser|private/);
  });
});

describe('failures', () => {
  it('N22_AC1_the_database_refusing_the_role_is_a_403', async () => {
    const client = fakeClient({ data: null, error: { code: '42501', message: 'Only technical support staff can see the equipment request queue' } });
    const res = await request(appWith(client)).get('/api/equipment-requests');
    expect(res.status).toBe(403);
  });

  it('N22_an_unexpected_database_failure_is_a_500_without_its_message', async () => {
    const client = fakeClient({ data: null, error: { code: 'XX000', message: 'relation "x" exploded' } });
    const res = await request(appWith(client)).get('/api/equipment-requests');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('exploded');
  });

  it('N22_only_GET_exists', async () => {
    const app = appWith(fakeClient());
    for (const method of ['post', 'put', 'patch', 'delete']) {
      const res = await request(app)[method]('/api/equipment-requests');
      expect(res.status, method).toBe(404);
    }
  });
});
