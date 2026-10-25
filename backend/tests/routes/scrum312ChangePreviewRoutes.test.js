/**
 * Tests for the change-preview route.
 *
 * SCRUM-312, a subtask of SCRUM-310 "Handle Equipment Lost After Reservation".
 * Named SCRUM310_ACn_<what_it_checks>. About transport and authorisation: the
 * right role reaches it, everyone else is refused before anything is read,
 * each failure has its status, and the acting user comes from the session.
 *
 * The Supabase client is mocked with a factory, as in equipment.test.js.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ok, dbError, queryStub } from '../fixtures/supabaseStubs.js';
import { signedOut, signedInFor } from '../fixtures/auth.js';

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock('../../src/config/supabaseClient.js', () => {
  const client = { from, rpc };
  return { supabase: client, default: client };
});

const { createEquipmentRouter } = await import('../../src/routes/equipment.js');
const { supabase } = await import('../../src/config/supabaseClient.js');
const { ROLE } = await import('../../src/domain/userRole.js');

const TYPE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const STAFF_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

const typeRow = (overrides = {}) => ({
  id: TYPE_ID,
  name: 'Projector',
  total_quantity: 10,
  damaged_quantity: 2,
  under_maintenance_quantity: 1,
  retired_at: null,
  ...overrides,
});

const affectedRow = {
  reservation_id: 'r1',
  event_request_id: 'e1',
  event_name: 'Open Day',
  equipment_line_id: 'l1',
  quantity: 3,
  start_at: '2026-11-05T01:00:00+00:00',
  end_at: '2026-11-05T05:00:00+00:00',
  coordinator_id: 'c1',
  coordinator_name: 'Cara Coordinator',
  flagged: false,
  reserved_at: '2026-10-01T00:00:00+00:00',
};

const signedInAs = signedInFor(STAFF_ID);

function appWith(requireAuth = signedInAs(ROLE.TECHNICAL_SUPPORT_STAFF)) {
  return express()
    .use(express.json())
    .use('/api/equipment', createEquipmentRouter({ requireAuth }));
}

const OTHER_ROLES = Object.values(ROLE).filter((role) => role !== ROLE.TECHNICAL_SUPPORT_STAFF);
const url = (id = TYPE_ID) => `/api/equipment/${id}/change-preview`;

beforeEach(() => {
  from.mockReset();
  rpc.mockReset();
});

describe('the test double', () => {
  it('SCRUM310_AC1_the_supabase_client_is_mocked_and_never_the_real_one', () => {
    expect(vi.isMockFunction(supabase.rpc)).toBe(true);
  });
});

describe('SCRUM310 who may ask', () => {
  it('SCRUM310_AC1_there_are_other_roles_to_test_and_the_list_has_the_ones_that_matter', () => {
    expect(OTHER_ROLES.length).toBeGreaterThanOrEqual(6);
    expect(OTHER_ROLES).toContain(ROLE.EVENT_COORDINATOR);
    expect(OTHER_ROLES).toContain(ROLE.EVENT_COORDINATOR_LEAD);
    expect(OTHER_ROLES).not.toContain(ROLE.TECHNICAL_SUPPORT_STAFF);
  });

  it.each(OTHER_ROLES)('SCRUM310_AC1_refuses_%s_with_403_and_reads_nothing', async (role) => {
    const res = await request(appWith(signedInAs(role))).post(url()).send({ totalQuantity: 1 });

    expect(res.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM310_AC1_refuses_a_signed_out_caller_with_401_and_reads_nothing', async () => {
    const res = await request(appWith(signedOut)).post(url()).send({ totalQuantity: 1 });

    expect(res.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM310_AC1_a_role_named_in_the_body_does_not_help_a_coordinator', async () => {
    const res = await request(appWith(signedInAs(ROLE.EVENT_COORDINATOR)))
      .post(url())
      .send({ totalQuantity: 5, role: ROLE.TECHNICAL_SUPPORT_STAFF });

    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('SCRUM310 a successful preview', () => {
  it('SCRUM310_AC2_answers_200_with_the_preview', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(ok([affectedRow]));

    const res = await request(appWith()).post(url()).send({ totalQuantity: 4 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      equipmentTypeId: TYPE_ID,
      equipmentName: 'Projector',
      usableBefore: 7,
      usableAfter: 1,
      affectedCount: 1,
      affectedUnits: 3,
    });
    expect(res.body.affected[0]).toMatchObject({
      reservationId: 'r1',
      eventName: 'Open Day',
      coordinatorName: 'Cara Coordinator',
      quantity: 3,
    });
  });

  it('SCRUM310_AC7_answers_200_with_an_empty_list_when_no_one_is_affected', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(ok([]));

    const res = await request(appWith()).post(url()).send({ totalQuantity: 9 });

    expect(res.status).toBe(200);
    expect(res.body.affected).toEqual([]);
    expect(res.body.affectedCount).toBe(0);
  });

  it('SCRUM310_AC1_a_retirement_is_previewed_as_zero_usable', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(ok([]));

    const res = await request(appWith()).post(url()).send({ retire: true });

    expect(res.status).toBe(200);
    expect(res.body.usableAfter).toBe(0);
    expect(rpc.mock.calls[0][1].p_usable_after).toBe(0);
  });

  it('SCRUM310_AC1_the_acting_user_sent_to_the_database_is_the_signed_in_one', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(ok([]));

    await request(appWith(signedInAs(ROLE.TECHNICAL_SUPPORT_STAFF, 'aaaaaaaa-0000-4000-8000-000000000001')))
      .post(url())
      .send({ totalQuantity: 4, p_caller: 'someone-else', userId: 'someone-else' });

    expect(rpc.mock.calls[0][1].p_caller).toBe('aaaaaaaa-0000-4000-8000-000000000001');
  });

  it('SCRUM310_AC2_a_preview_makes_only_reads', async () => {
    const select = queryStub(ok(typeRow()));
    from.mockReturnValueOnce(select);
    rpc.mockResolvedValueOnce(ok([affectedRow]));

    await request(appWith()).post(url()).send({ totalQuantity: 4 });

    for (const write of ['insert', 'update', 'delete']) expect(select.called(write)).toBe(false);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['equipment_over_commitment']);
  });
});

describe('SCRUM310 the failures', () => {
  it('SCRUM310_AC1_a_malformed_id_is_a_400_with_no_query', async () => {
    const res = await request(appWith()).post(url('not-a-uuid')).send({ totalQuantity: 1 });

    expect(res.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty body', {}],
    ['a negative total', { totalQuantity: -1 }],
    ['a text total', { totalQuantity: '5' }],
    ['retire false', { retire: false }],
    ['retire with a quantity', { retire: true, totalQuantity: 3 }],
  ])('SCRUM310_AC1_%s_is_a_400_with_no_query', async (_label, body) => {
    const res = await request(appWith()).post(url()).send(body);

    expect(res.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM310_AC1_a_missing_body_is_a_400_not_a_crash', async () => {
    const res = await request(appWith()).post(url());

    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM310_AC1_a_body_that_is_not_json_is_refused_without_reading_anything', async () => {
    const res = await request(appWith())
      .post(url())
      .set('Content-Type', 'application/json')
      .send('{not json');

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM310_AC1_damaged_plus_under_maintenance_above_the_total_is_a_400_listing_the_field', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));

    const res = await request(appWith()).post(url()).send({ totalQuantity: 2 });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('totalQuantity');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM310_AC1_an_unknown_type_is_a_404', async () => {
    from.mockReturnValueOnce(queryStub(ok(null)));

    const res = await request(appWith()).post(url()).send({ totalQuantity: 4 });

    expect(res.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM310_AC1_retiring_a_retired_type_is_a_409_with_its_code', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow({ retired_at: '2026-10-02T00:00:00+00:00' }))));

    const res = await request(appWith()).post(url()).send({ retire: true });

    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('EQUIPMENT_ALREADY_RETIRED');
  });

  it('SCRUM310_AC1_a_database_refusal_of_the_caller_is_a_403', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(dbError('42501', 'Only Technical Support Staff can check what a change to equipment affects'));

    const res = await request(appWith()).post(url()).send({ totalQuantity: 4 });

    expect(res.status).toBe(403);
  });

  it('SCRUM310_AC1_a_type_that_vanishes_before_the_function_runs_is_a_404', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(dbError('P0002', 'Equipment type not found'));

    const res = await request(appWith()).post(url()).send({ totalQuantity: 4 });

    expect(res.status).toBe(404);
  });

  it('SCRUM310_AC1_an_unexpected_database_failure_is_a_500_that_does_not_leak_its_message', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(dbError('XX000', 'secret internal detail'));

    const res = await request(appWith()).post(url()).send({ totalQuantity: 4 });

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret internal detail');
  });
});

describe('SCRUM310 the route sits beside the others without disturbing them', () => {
  it.each(['get', 'put', 'delete', 'patch'])('SCRUM310_AC1_%s_on_the_preview_path_is_not_a_preview', async (method) => {
    const res = await request(appWith())[method](url()).send({ totalQuantity: 4 });

    expect(rpc).not.toHaveBeenCalled();
    expect(res.status).not.toBe(200);
  });

  it('SCRUM310_AC1_editing_a_type_still_works_and_does_not_call_the_preview_function', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    from.mockReturnValueOnce(queryStub(ok(typeRow({ description: 'x' }))));

    const res = await request(appWith()).patch(`/api/equipment/${TYPE_ID}`).send({ description: 'x' });

    expect(res.status).toBe(200);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM310_AC1_the_history_route_is_not_swallowed_by_the_new_one', async () => {
    from.mockReturnValueOnce(queryStub(ok([])));

    const res = await request(appWith()).get(`/api/equipment/${TYPE_ID}/history`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
