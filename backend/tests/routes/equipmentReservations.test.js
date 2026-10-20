/**
 * Route tests for the reservation actions.
 *
 * SCRUM-300. Named SCRUM300_ACn_<what_it_checks>. About transport and authorisation:
 * only Technical Support Staff reach any route, a refused attempt reaches no
 * database function, the caller is the signed-in user and never the body, and
 * each refusal has the right status. The client is injected, so the real
 * Express routing and the real service run and only the database is faked.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ok, dbError, rpcByNameClient } from '../fixtures/supabaseStubs.js';
import { signedOut, signedInFor } from '../fixtures/auth.js';

vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: {}, supabaseAdmin: {} }));

const { createEquipmentReviewRouter } = await import('../../src/routes/equipmentReview.js');
const { ROLE } = await import('../../src/domain/userRole.js');

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const LINE_ID = '22222222-2222-4222-8222-222222222222';
const TYPE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const REQUEST_ID = '55555555-5555-4555-8555-555555555555';
const RESERVATION_ID = '44444444-4444-4444-8444-444444444444';
const COORDINATOR_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const REVIEWER_ID = '66666666-6666-4666-8666-666666666666';

const reservationRow = (overrides = {}) => ({
  id: RESERVATION_ID,
  quantity: 2,
  start_at: '2026-12-01T10:00:00+00:00',
  end_at: '2026-12-01T12:00:00+00:00',
  flagged: false,
  flag_reason: null,
  flagged_at: null,
  ...overrides,
});

const reviewRow = (reservations = [reservationRow()]) => ({
  event: {
    id: EVENT_ID,
    name: 'Annual Dinner',
    proposed_start: '2026-12-01T10:00:00+00:00',
    proposed_end: '2026-12-01T12:00:00+00:00',
    assigned_coordinator_id: COORDINATOR_ID,
  },
  request: {
    id: REQUEST_ID,
    status: 'under_review',
    reviewer_id: REVIEWER_ID,
    review_started_at: '2026-10-09T08:00:00+00:00',
    created_at: '2026-10-08T09:00:00+00:00',
    updated_at: '2026-10-09T08:00:00+00:00',
    lines: [
      {
        id: LINE_ID,
        equipment_type_id: TYPE_ID,
        name: 'Projector',
        quantity: 5,
        technical_notes: null,
        type_retired: false,
        reserved: 2,
        reservations,
        outcome: null,
        outcome_note: null,
        outcome_by: null,
        outcome_at: null,
        availability: null,
      },
    ],
  },
});

const fakeClient = (rpc = {}) => rpcByNameClient({ rpc, fallback: () => ok(reviewRow()) });

const SOMEONE_ELSE = '77777777-7777-4777-8777-777777777777';
const BASE = `/api/event-requests/${EVENT_ID}/equipment-review`;

const signedInAs = signedInFor(REVIEWER_ID);

function appWith(client, requireAuth = signedInAs(ROLE.TECHNICAL_SUPPORT_STAFF)) {
  return express()
    .use(express.json())
    .use('/api/event-requests/:id/equipment-review', createEquipmentReviewRouter({ requireAuth, client }));
}

const OTHER_ROLES = [
  ROLE.EVENT_ORGANISER,
  ROLE.EVENT_COORDINATOR,
  ROLE.VENUE_STAFF,
  ROLE.ATTENDEE,
  ROLE.EVENT_COORDINATOR_LEAD,
  ROLE.SAFETY_OFFICER,
];

const ROUTES = [
  ['reserves', (app) => request(app).post(`${BASE}/lines/${LINE_ID}/reservations`).send({ quantity: 1 }), 'reserve_equipment'],
  ['reduces', (app) => request(app).patch(`${BASE}/reservations/${RESERVATION_ID}`).send({ quantity: 1, reason: 'Less' }), 'reduce_equipment_reservation'],
  ['releases', (app) => request(app).post(`${BASE}/reservations/${RESERVATION_ID}/release`).send({ reason: 'Done' }), 'release_equipment_reservation'],
  ['moves', (app) => request(app).post(`${BASE}/reservations/${RESERVATION_ID}/move`).send({}), 'move_equipment_reservation'],
  ['keeps', (app) => request(app).post(`${BASE}/reservations/${RESERVATION_ID}/keep`).send({}), 'keep_equipment_reservation'],
];

describe('AC1: only Technical Support Staff reach any reservation route', () => {
  it.each(OTHER_ROLES.flatMap((role) => ROUTES.map(([what, call]) => [role, what, call])))(
    'SCRUM300_AC1_refuses_%s_who_%s_with_403_and_reaches_nothing',
    async (role, _what, call) => {
      const client = fakeClient();
      const res = await call(appWith(client, signedInAs(role)));
      expect(res.status).toBe(403);
      expect(client.rpc).not.toHaveBeenCalled();
      expect(client.from).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES)('SCRUM300_AC1_refuses_a_signed_out_caller_who_%s_with_401', async (_what, call) => {
    const client = fakeClient();
    const res = await call(appWith(client, signedOut));
    expect(res.status).toBe(401);
    expect(client.rpc).not.toHaveBeenCalled();
  });
});

describe('the routes for Technical Support Staff', () => {
  it.each(ROUTES)('SCRUM300_%s_answers_200_with_the_review_state_and_calls_the_right_function', async (_what, call, rpcName) => {
    const client = fakeClient();
    const res = await call(appWith(client));
    expect(res.status).toBe(200);
    expect(res.body.request.lines[0].reservations[0]).toMatchObject({ id: RESERVATION_ID, quantity: 2, flagged: false });
    expect(client.rpcCalls[0].name).toBe(rpcName);
  });

  it.each(ROUTES)('SCRUM300_AC1_%s_uses_the_signed_in_user_not_one_in_the_body', async (_what, call, _rpc) => {
    const client = fakeClient();
    const app = appWith(client, signedInAs(ROLE.TECHNICAL_SUPPORT_STAFF, SOMEONE_ELSE));
    await call(app);
    expect(client.rpcCalls[0].args.p_user_id).toBe(SOMEONE_ELSE);
  });

  it('SCRUM300_AC1_a_user_id_in_the_body_is_ignored', async () => {
    const client = fakeClient();
    await request(appWith(client))
      .post(`${BASE}/lines/${LINE_ID}/reservations`)
      .send({ quantity: 1, userId: SOMEONE_ELSE, p_user_id: SOMEONE_ELSE });
    expect(client.rpcCalls[0].args.p_user_id).toBe(REVIEWER_ID);
  });

  it('SCRUM300_AC2_reserve_with_a_bad_quantity_is_400_and_reaches_no_function', async () => {
    const client = fakeClient();
    const res = await request(appWith(client)).post(`${BASE}/lines/${LINE_ID}/reservations`).send({ quantity: 0 });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([expect.objectContaining({ field: 'quantity' })]);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM300_AC2_reserve_with_no_body_is_400', async () => {
    const client = fakeClient();
    const res = await request(appWith(client)).post(`${BASE}/lines/${LINE_ID}/reservations`);
    expect(res.status).toBe(400);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM300_AC4_release_without_a_reason_is_400', async () => {
    const client = fakeClient();
    const res = await request(appWith(client)).post(`${BASE}/reservations/${RESERVATION_ID}/release`).send({});
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([expect.objectContaining({ field: 'reason' })]);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM300_AC4_reduce_lists_both_faults_at_once', async () => {
    const client = fakeClient();
    const res = await request(appWith(client)).patch(`${BASE}/reservations/${RESERVATION_ID}`).send({ quantity: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.details.map((d) => d.field).sort()).toEqual(['quantity', 'reason']);
  });

  it('SCRUM300_a_malformed_id_in_the_url_is_400_and_reaches_no_function', async () => {
    const client = fakeClient();
    const res = await request(appWith(client)).post(`${BASE}/reservations/not-a-uuid/release`).send({ reason: 'x' });
    expect(res.status).toBe(400);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM300_AC2_more_than_available_is_400_and_the_message_shows_how_many_are', async () => {
    const client = fakeClient({ reserve_equipment: dbError('22023', 'Only 1 available for this period, so 2 cannot be reserved') });
    const res = await request(appWith(client)).post(`${BASE}/lines/${LINE_ID}/reservations`).send({ quantity: 2 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Only 1 available/);
  });

  it('SCRUM300_AC3_the_second_reviewer_for_the_last_unit_gets_the_updated_figure', async () => {
    const client = fakeClient({ reserve_equipment: dbError('22023', 'Only 0 available for this period, so 1 cannot be reserved') });
    const res = await request(appWith(client)).post(`${BASE}/lines/${LINE_ID}/reservations`).send({ quantity: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Only 0 available/);
  });

  it.each(ROUTES)('SCRUM300_AC1_%s_not_the_current_reviewer_is_403', async (_what, call, rpcName) => {
    const client = fakeClient({ [rpcName]: dbError('42501', 'Only the current reviewer can do this') });
    expect((await call(appWith(client))).status).toBe(403);
  });

  it.each(ROUTES)('SCRUM300_AC1_%s_when_the_request_is_not_under_review_is_409_with_the_code', async (_what, call, rpcName) => {
    const client = fakeClient({ [rpcName]: dbError('55000', 'This can only be done while the request is Under review. This request is Arranged.') });
    const res = await call(appWith(client));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EQUIPMENT_REVIEW_NOT_ALLOWED');
    expect(res.body.error).toMatch(/Arranged/);
  });

  it.each(ROUTES)('SCRUM300_%s_an_unknown_event_line_or_reservation_is_404', async (_what, call, rpcName) => {
    const client = fakeClient({ [rpcName]: dbError('P0002', 'Not found') });
    expect((await call(appWith(client))).status).toBe(404);
  });

  it.each(ROUTES)('SCRUM300_%s_an_unexpected_failure_is_500_without_leaking_the_driver_message', async (_what, call, rpcName) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = fakeClient({ [rpcName]: dbError('XX000', 'secret internal detail') });
    const res = await call(appWith(client));
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/secret internal detail/);
    spy.mockRestore();
  });

  it('SCRUM300_the_old_review_routes_still_exist', async () => {
    const client = fakeClient({ equipment_review_for_event: ok(reviewRow()) });
    const res = await request(appWith(client)).get(BASE);
    expect(res.status).toBe(200);
  });

  it('SCRUM300_an_unsupported_method_on_a_reservation_is_404', async () => {
    const client = fakeClient();
    const res = await request(appWith(client)).delete(`${BASE}/reservations/${RESERVATION_ID}`);
    expect(res.status).toBe(404);
    expect(client.rpc).not.toHaveBeenCalled();
  });
});
