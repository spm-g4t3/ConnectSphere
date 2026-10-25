/**
 * Tests for the confirmed save at the route level.
 *
 * SCRUM-313, a subtask of SCRUM-310 "Handle Equipment Lost After Reservation".
 * Named SCRUM310_ACn_<what_it_checks>. About transport and authorisation: who may
 * save, what the body may carry, each status, and what the client is told when
 * the list it confirmed is no longer the list the change affects.
 *
 * The Supabase client is mocked with a factory, as in equipment.test.js. The
 * database function is tested against a real schema in tests/db.
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
const { ROLE } = await import('../../src/domain/userRole.js');

const TYPE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const STAFF_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const RETIRED = '2026-10-20T09:00:00+00:00';

const typeRow = (overrides = {}) => ({
  id: TYPE_ID,
  name: 'Projector',
  description: null,
  category: null,
  location: null,
  total_quantity: 10,
  damaged_quantity: 2,
  under_maintenance_quantity: 1,
  retired_at: null,
  created_at: '2026-10-01T09:00:00+00:00',
  updated_at: '2026-10-01T09:00:00+00:00',
  ...overrides,
});

const affectedRow = (id, overrides = {}) => ({
  reservation_id: id,
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
  ...overrides,
});

const savedAnswer = (row, { flagged = 0, affected = [] } = {}) =>
  ok({ saved: true, flagged_count: flagged, affected, equipment_type: row });

const signedInAs = signedInFor(STAFF_ID);

function appWith(requireAuth = signedInAs(ROLE.TECHNICAL_SUPPORT_STAFF)) {
  return express()
    .use(express.json())
    .use('/api/equipment', createEquipmentRouter({ requireAuth }));
}

const OTHER_ROLES = Object.values(ROLE).filter((role) => role !== ROLE.TECHNICAL_SUPPORT_STAFF);

/** The three routes that save through the database function. */
const SAVES = [
  ['an edit of the total', 'patch', '', { totalQuantity: 5 }],
  ['a damage change', 'patch', '/condition', { damagedQuantity: 5, note: 'dropped' }],
  ['a retirement', 'post', '/retire', {}],
];
const urlFor = (suffix, id = TYPE_ID) => `/api/equipment/${id}${suffix}`;
const send = (app, method, suffix, body) => request(app)[method](urlFor(suffix)).send(body);

beforeEach(() => {
  from.mockReset();
  rpc.mockReset();
});

describe('SCRUM310 who may save', () => {
  it.each(SAVES.flatMap(([label, method, suffix, body]) =>
    OTHER_ROLES.map((role) => [label, role, method, suffix, body]),
  ))('SCRUM310_AC4_refuses_%s_from_%s_with_403_and_reads_and_saves_nothing', async (_label, role, method, suffix, body) => {
    const res = await send(appWith(signedInAs(role)), method, suffix, { ...body, confirmedReservationIds: [] });

    expect(res.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(SAVES)('SCRUM310_AC4_refuses_%s_when_signed_out_with_401', async (_label, method, suffix, body) => {
    const res = await send(appWith(signedOut), method, suffix, body);

    expect(res.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(SAVES)('SCRUM310_AC4_%s_made_by_a_coordinator_cannot_be_unlocked_with_a_role_in_the_body', async (_label, method, suffix, body) => {
    const res = await send(
      appWith(signedInAs(ROLE.EVENT_COORDINATOR)),
      method,
      suffix,
      { ...body, role: ROLE.TECHNICAL_SUPPORT_STAFF },
    );

    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('SCRUM310 a change that is confirmed', () => {
  it('SCRUM310_AC4_a_total_edit_answers_200_with_the_type_and_what_was_flagged', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(
      savedAnswer(typeRow({ total_quantity: 5 }), { flagged: 1, affected: [affectedRow(R1)] }),
    );

    const res = await request(appWith())
      .patch(urlFor(''))
      .send({ totalQuantity: 5, confirmedReservationIds: [R1] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: TYPE_ID, totalQuantity: 5, usableQuantity: 2, flaggedCount: 1 });
    expect(res.body.flaggedReservations).toHaveLength(1);
    expect(res.body.flaggedReservations[0]).toMatchObject({
      reservationId: R1,
      eventName: 'Open Day',
      coordinatorName: 'Cara Coordinator',
    });
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_total: 5,
      p_confirmed_reservation_ids: [R1],
    });
  });

  it('SCRUM310_AC4_a_damage_change_answers_200_with_the_new_usable_figure', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(
      savedAnswer(typeRow({ damaged_quantity: 5 }), { flagged: 2, affected: [affectedRow(R1), affectedRow(R2)] }),
    );

    const res = await request(appWith())
      .patch(urlFor('/condition'))
      .send({ damagedQuantity: 5, note: 'flood', confirmedReservationIds: [R2, R1] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ damagedQuantity: 5, usableQuantity: 4, flaggedCount: 2 });
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_damaged: 5,
      p_note: 'flood',
      p_confirmed_reservation_ids: [R2, R1],
    });
  });

  it('SCRUM310_AC4_a_retirement_answers_200_with_retired_at_and_what_was_flagged', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(
      savedAnswer(typeRow({ retired_at: RETIRED }), { flagged: 1, affected: [affectedRow(R1)] }),
    );

    const res = await request(appWith())
      .post(urlFor('/retire'))
      .send({ confirmedReservationIds: [R1], note: 'end of life' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ retiredAt: RETIRED, flaggedCount: 1 });
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_retire: true,
      p_note: 'end of life',
      p_confirmed_reservation_ids: [R1],
    });
  });

  it('SCRUM310_AC7_a_retirement_needs_no_body_when_nothing_is_affected', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(savedAnswer(typeRow({ retired_at: RETIRED })));

    const res = await request(appWith()).post(urlFor('/retire'));

    expect(res.status).toBe(200);
    expect(res.body.flaggedCount).toBe(0);
    expect(rpc.mock.calls[0][1].p_confirmed_reservation_ids).toEqual([]);
  });

  it.each(SAVES)('SCRUM310_AC8_%s_uses_the_signed_in_user_whatever_the_body_says', async (_label, method, suffix, body) => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(savedAnswer(typeRow()));

    await send(appWith(), method, suffix, {
      ...body,
      lastModifiedBy: 'someone-else',
      userId: 'someone-else',
      p_caller: 'someone-else',
      caller: 'someone-else',
    });

    expect(rpc.mock.calls[0][1].p_caller).toBe(STAFF_ID);
    expect(JSON.stringify(rpc.mock.calls[0][1])).not.toContain('someone-else');
  });

  it.each(SAVES)('SCRUM310_AC4_%s_cannot_add_parameters_the_function_does_not_take_through_the_body', async (_label, method, suffix, body) => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(savedAnswer(typeRow()));

    await send(appWith(), method, suffix, { ...body, p_retire: true, p_fields: { name: 'x' }, retire: true });

    const args = rpc.mock.calls[0][1];
    expect(Object.keys(args).sort()).toEqual([
      'p_caller', 'p_confirmed_reservation_ids', 'p_damaged', 'p_equipment_type_id', 'p_fields',
      'p_note', 'p_retire', 'p_total', 'p_under_maintenance',
    ]);
    // Only the retire route may ask for a retirement.
    expect(args.p_retire).toBe(suffix === '/retire');
    expect(args.p_fields).toEqual({});
  });
});

describe('SCRUM310 when the list moved since the preview', () => {
  const MOVED = [affectedRow(R1), affectedRow(R2, { quantity: 1 })];

  it.each(SAVES)('SCRUM310_AC2_%s_answers_409_with_the_code_and_the_new_list', async (_label, method, suffix, body) => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(ok({ saved: false, affected: MOVED }));

    const res = await send(appWith(), method, suffix, { ...body, confirmedReservationIds: [R1] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EQUIPMENT_AFFECTED_CHANGED');
    expect(res.body.conflicts.map((c) => c.reservationId)).toEqual([R1, R2]);
    expect(res.body.conflicts[1]).toMatchObject({
      eventName: 'Open Day',
      quantity: 1,
      coordinatorName: 'Cara Coordinator',
    });
    expect(res.body.error).toMatch(/review them again/i);
  });

  it('SCRUM310_AC4_a_409_for_a_retired_type_keeps_its_own_code', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow({ retired_at: RETIRED }))));

    const res = await request(appWith()).post(urlFor('/retire')).send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EQUIPMENT_ALREADY_RETIRED');
    expect(res.body.conflicts).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM310_AC4_a_retirement_that_loses_a_race_to_another_retirement_is_a_409_with_that_code', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(
      dbError('PT409', 'Equipment type is already retired', { hint: 'EQUIPMENT_ALREADY_RETIRED' }),
    );

    const res = await request(appWith()).post(urlFor('/retire')).send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EQUIPMENT_ALREADY_RETIRED');
  });
});

describe('SCRUM310 bad requests', () => {
  it.each([
    ['a list that is not a list', { confirmedReservationIds: 'all of them' }],
    ['a list with something that is not an id', { confirmedReservationIds: [R1, 'x'] }],
    ['a list holding a number', { confirmedReservationIds: [1] }],
    ['a list that is null', { confirmedReservationIds: null }],
  ])('SCRUM310_AC4_%s_answers_400_and_never_reaches_the_function', async (_label, extra) => {
    for (const [, method, suffix, body] of SAVES) {
      from.mockReset();
      rpc.mockReset();
      from.mockReturnValue(queryStub(ok(typeRow())));

      const res = await send(appWith(), method, suffix, { ...body, ...extra });

      expect(res.status).toBe(400);
      expect(res.body.details.map((d) => d.field)).toContain('confirmedReservationIds');
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it('SCRUM310_AC8_a_retirement_with_a_bad_note_answers_400', async () => {
    const res = await request(appWith()).post(urlFor('/retire')).send({ note: 5 });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'note', message: 'must be text' }]);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM310_AC4_a_retirement_with_a_list_as_its_body_answers_400', async () => {
    const res = await request(appWith()).post(urlFor('/retire')).send([R1]);

    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(SAVES)('SCRUM310_AC4_%s_answers_400_for_a_malformed_id_without_a_query', async (_label, method, suffix, body) => {
    const res = await request(appWith())[method](urlFor(suffix, 'not-a-uuid')).send(body);

    expect(res.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(SAVES)('SCRUM310_AC4_%s_answers_404_for_an_unknown_type', async (_label, method, suffix, body) => {
    from.mockReturnValueOnce(queryStub(ok(null)));

    const res = await send(appWith(), method, suffix, body);

    expect(res.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(SAVES)('SCRUM310_AC4_%s_answers_404_when_the_type_goes_before_the_save', async (_label, method, suffix, body) => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(dbError('P0002', 'Equipment type not found'));

    const res = await send(appWith(), method, suffix, body);

    expect(res.status).toBe(404);
  });

  it.each(SAVES)('SCRUM310_AC4_%s_answers_403_when_the_database_says_the_caller_may_not', async (_label, method, suffix, body) => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(dbError('42501', 'Only Technical Support Staff can change equipment'));

    const res = await send(appWith(), method, suffix, body);

    expect(res.status).toBe(403);
  });

  it.each(SAVES)('SCRUM310_AC4_%s_answers_400_when_the_database_refuses_the_input', async (_label, method, suffix, body) => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(dbError('22023', 'There is nothing to change'));

    const res = await send(appWith(), method, suffix, body);

    expect(res.status).toBe(400);
  });

  it.each(SAVES)('SCRUM310_AC4_%s_answers_500_without_the_database_message_when_the_function_fails', async (_label, method, suffix, body) => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(dbError('XX000', 'secret internal detail'));

    const res = await send(appWith(), method, suffix, body);

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret internal detail');
  });

  it.each(SAVES)('SCRUM310_AC4_%s_answers_500_when_the_function_answers_something_unexpected', async (_label, method, suffix, body) => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(ok('saved'));

    const res = await send(appWith(), method, suffix, body);

    expect(res.status).toBe(500);
  });
});
