/**
 * Tests for the event equipment routes.
 *
 * SCRUM-244, a subtask of SCRUM-21. Named SCRUM21_ACn_<what_it_checks>. These
 * are about transport and authorisation: the right routes exist, the right
 * role reaches them, a refused attempt reaches no database function so it
 * changes nothing, and the caller is the signed-in user and never the body.
 *
 *   AC1  -- only Event Coordinators reach any route; the assigned-coordinator
 *           and Approved-status rules are the database's, and arrive as 403
 *           and 409
 *   AC2-AC5 -- add answers 201, or 400 listing every invalid field
 *   AC6, AC7 -- amend and remove answer 200 with the event's equipment
 *   AC11 -- the read answers 200, or 404 for an event that does not exist
 *
 * The client is injected into the router, as the event request routes allow, so
 * the real Express routing and the real service run and only the database is
 * faked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { createEventEquipmentRouter } = await import('../../src/routes/eventEquipment.js');
const { ROLE } = await import('../../src/domain/userRole.js');

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const LINE_ID = '22222222-2222-4222-8222-222222222222';
const TYPE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const COORDINATOR_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const SOMEONE_ELSE = '77777777-7777-4777-8777-777777777777';

const BASE = `/api/event-requests/${EVENT_ID}/equipment`;

const stateRow = (overrides = {}) => ({
  request: {
    id: '55555555-5555-4555-8555-555555555555',
    status: 'pending_review',
    created_at: '2026-10-08T09:00:00+00:00',
    updated_at: '2026-10-08T09:00:00+00:00',
    lines: [
      {
        id: LINE_ID,
        equipment_type_id: TYPE_ID,
        name: 'Projector',
        quantity: 2,
        technical_notes: null,
        type_retired: false,
        created_at: '2026-10-08T09:00:00+00:00',
        updated_at: '2026-10-08T09:00:00+00:00',
      },
    ],
    ...overrides,
  },
});

const ok = (data) => ({ data, error: null });
const dbError = (code, message) => ({ data: null, error: { code, message } });

/** A client whose rpc answers by function name. */
function fakeClient({ rpc = {}, type = { id: TYPE_ID, retired_at: null }, event = { id: EVENT_ID } } = {}) {
  const rpcCalls = [];
  const client = {
    rpcCalls,
    rpc: vi.fn(async (name, args) => {
      rpcCalls.push({ name, args });
      const answer = rpc[name];
      return answer === undefined ? ok({ request: null }) : answer;
    }),
    from: vi.fn((table) => {
      const row = table === 'equipment_types' ? type : event;
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(ok(row)) }) }) };
    }),
  };
  return client;
}

/** Stands in for a signed-in user of a given role. */
const signedInAs = (role, id = COORDINATOR_ID) => (req, _res, next) => {
  req.user = { id, email: 'someone@example.com', role };
  next();
};

/** Stands in for no session, answering as the real middleware does. */
const signedOut = (_req, res) => res.status(401).json({ error: 'Authentication required' });

/** An app with the router mounted where app.js mounts it. */
function appWith(client, requireAuth = signedInAs(ROLE.EVENT_COORDINATOR)) {
  return express()
    .use(express.json())
    .use('/api/event-requests/:id/equipment', createEventEquipmentRouter({ requireAuth, client }));
}

const OTHER_ROLES = [
  ROLE.EVENT_ORGANISER,
  ROLE.VENUE_STAFF,
  ROLE.TECHNICAL_SUPPORT_STAFF,
  ROLE.ATTENDEE,
  ROLE.EVENT_COORDINATOR_LEAD,
  ROLE.SAFETY_OFFICER,
];

const ROUTES = [
  ['reads', (app) => request(app).get(BASE)],
  ['adds', (app) => request(app).post(`${BASE}/lines`).send({ equipmentTypeId: TYPE_ID, quantity: 1 })],
  ['amends', (app) => request(app).patch(`${BASE}/lines/${LINE_ID}`).send({ quantity: 3 })],
  ['removes', (app) => request(app).delete(`${BASE}/lines/${LINE_ID}`)],
];


/**
 * SCRUM-486 (SCRUM-521): the Lead may read an event's equipment, and only
 * read it. The event screen the Lead hands an event over from reads this list
 * on mount. The table below refused the Lead every route, reads included, and
 * that was right when written (SCRUM-485 granted the Lead nothing). The read
 * row for the Lead is taken out of the refusal table and pinned as allowed in
 * the case after it; the Lead's three write rows stay refused.
 */
const isLeadRead = (role, what) => role === ROLE.EVENT_COORDINATOR_LEAD && what === 'reads';

describe('AC1: only Event Coordinators reach any route', () => {
  it.each(
    OTHER_ROLES.flatMap((role) => ROUTES.map(([what, call]) => [role, what, call]))
      .filter(([role, what]) => !isLeadRead(role, what)),
  )(
    'SCRUM21_AC1_refuses_%s_who_%s_with_403_and_reaches_nothing',
    async (role, _what, call) => {
      const client = fakeClient();

      const res = await call(appWith(client, signedInAs(role)));

      expect(res.status).toBe(403);
      expect(client.rpc).not.toHaveBeenCalled();
      expect(client.from).not.toHaveBeenCalled();
    },
  );

  it('SCRUM486_AC6_the_lead_reads_an_events_equipment_and_nothing_else', async () => {
    // The read reaches the read function and only that; the writes above
    // still refuse the Lead before the client is touched.
    const client = fakeClient({ rpc: { equipment_for_event: ok(stateRow({ status: 'arranged' })) } });

    const res = await request(appWith(client, signedInAs(ROLE.EVENT_COORDINATOR_LEAD))).get(BASE);

    expect(res.status).toBe(200);
    expect(res.body.request.statusLabel).toBe('Arranged');
    expect(client.rpcCalls.map(({ name }) => name)).toEqual(['equipment_for_event']);
  });

  it.each(ROUTES)('SCRUM21_AC1_refuses_a_signed_out_caller_who_%s_with_401', async (_what, call) => {
    const client = fakeClient();

    const res = await call(appWith(client, signedOut));

    expect(res.status).toBe(401);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM21_AC1_a_coordinator_who_is_not_assigned_gets_403_from_the_database', async () => {
    const client = fakeClient({
      rpc: { add_equipment_line: dbError('42501', "Only the event's assigned coordinator can change its equipment") },
    });

    const res = await request(appWith(client))
      .post(`${BASE}/lines`)
      .send({ equipmentTypeId: TYPE_ID, quantity: 1 });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/assigned coordinator/);
  });

  it('SCRUM21_AC1_an_event_that_is_not_approved_gets_409_with_the_status_in_words', async () => {
    const message = 'Equipment can only be changed while the event is Approved. This event is Under review.';
    const client = fakeClient({ rpc: { add_equipment_line: dbError('55000', message) } });

    const res = await request(appWith(client))
      .post(`${BASE}/lines`)
      .send({ equipmentTypeId: TYPE_ID, quantity: 1 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(message);
    expect(res.body.code).toBe('EVENT_NOT_APPROVED');
  });

  it('SCRUM21_AC10_a_confirmed_event_gets_409_with_the_significant_change_message', async () => {
    const client = fakeClient({
      rpc: { remove_equipment_line: dbError('55000', 'Equipment on this event can only be changed as a significant change') },
    });

    const res = await request(appWith(client)).delete(`${BASE}/lines/${LINE_ID}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/significant change/);
  });
});


describe('the caller is the signed-in user, never the body', () => {
  it('SCRUM21_AC1_add_ignores_a_coordinator_id_in_the_body', async () => {
    const client = fakeClient({ rpc: { add_equipment_line: ok(stateRow()) } });

    await request(appWith(client))
      .post(`${BASE}/lines`)
      .send({ equipmentTypeId: TYPE_ID, quantity: 1, coordinatorId: SOMEONE_ELSE, p_coordinator_id: SOMEONE_ELSE });

    const call = client.rpcCalls.find(({ name }) => name === 'add_equipment_line');
    expect(call.args.p_coordinator_id).toBe(COORDINATOR_ID);
  });

  it('SCRUM21_AC1_amend_ignores_a_coordinator_id_and_a_status_in_the_body', async () => {
    const client = fakeClient({ rpc: { amend_equipment_line: ok(stateRow()) } });

    await request(appWith(client))
      .patch(`${BASE}/lines/${LINE_ID}`)
      .send({ quantity: 3, coordinatorId: SOMEONE_ELSE, status: 'arranged' });

    const call = client.rpcCalls.find(({ name }) => name === 'amend_equipment_line');
    expect(call.args).toMatchObject({ p_coordinator_id: COORDINATOR_ID, p_quantity: 3 });
    expect(Object.keys(call.args).sort()).toEqual([
      'p_change_notes',
      'p_coordinator_id',
      'p_event_request_id',
      'p_line_id',
      'p_quantity',
      'p_technical_notes',
    ]);
  });

  it('SCRUM21_AC1_remove_uses_the_token_and_the_ids_in_the_url', async () => {
    const client = fakeClient({ rpc: { remove_equipment_line: ok(stateRow({ lines: [] })) } });

    await request(appWith(client)).delete(`${BASE}/lines/${LINE_ID}`).send({ coordinatorId: SOMEONE_ELSE });

    const call = client.rpcCalls.find(({ name }) => name === 'remove_equipment_line');
    expect(call.args).toEqual({
      p_event_request_id: EVENT_ID,
      p_coordinator_id: COORDINATOR_ID,
      p_line_id: LINE_ID,
    });
  });
});


describe('AC2 to AC5: adding a line', () => {
  it('SCRUM21_AC5_answers_201_with_the_events_equipment', async () => {
    const client = fakeClient({ rpc: { add_equipment_line: ok(stateRow()) } });

    const res = await request(appWith(client))
      .post(`${BASE}/lines`)
      .send({ equipmentTypeId: TYPE_ID, quantity: 2, technicalNotes: 'needs HDMI' });

    expect(res.status).toBe(201);
    expect(res.body.request.status).toBe('pending_review');
    expect(res.body.request.statusLabel).toBe('Pending review');
    expect(res.body.request.lines[0]).toMatchObject({ name: 'Projector', quantity: 2, equipmentTypeId: TYPE_ID });
  });

  it('SCRUM21_AC3_answers_400_listing_every_invalid_field', async () => {
    const client = fakeClient();

    const res = await request(appWith(client)).post(`${BASE}/lines`).send({ quantity: 0 });

    expect(res.status).toBe(400);
    expect(res.body.details.map((d) => d.field).sort()).toEqual(['equipmentTypeId', 'quantity']);
    expect(client.rpcCalls.filter(({ name }) => name === 'add_equipment_line')).toEqual([]);
  });

  it('SCRUM21_AC2_a_retired_type_is_a_400_naming_the_type', async () => {
    const client = fakeClient({ type: { id: TYPE_ID, retired_at: '2026-09-01T00:00:00Z' } });

    const res = await request(appWith(client))
      .post(`${BASE}/lines`)
      .send({ equipmentTypeId: TYPE_ID, quantity: 1 });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'equipmentTypeId', message: 'is retired and cannot be chosen' }]);
  });

  it('SCRUM21_AC1_an_event_id_that_is_not_a_uuid_is_a_400_and_reaches_nothing', async () => {
    const client = fakeClient();

    const res = await request(appWith(client))
      .post('/api/event-requests/abc/equipment/lines')
      .send({ equipmentTypeId: TYPE_ID, quantity: 1 });

    expect(res.status).toBe(400);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM21_AC1_an_event_that_does_not_exist_is_a_404', async () => {
    const client = fakeClient({ rpc: { add_equipment_line: dbError('P0002', 'Event request not found') } });

    const res = await request(appWith(client))
      .post(`${BASE}/lines`)
      .send({ equipmentTypeId: TYPE_ID, quantity: 1 });

    expect(res.status).toBe(404);
  });
});


describe('AC6 and AC7: amending and removing', () => {
  it('SCRUM21_AC6_amend_answers_200_with_the_events_equipment', async () => {
    const client = fakeClient({ rpc: { amend_equipment_line: ok(stateRow()) } });

    const res = await request(appWith(client)).patch(`${BASE}/lines/${LINE_ID}`).send({ quantity: 5 });

    expect(res.status).toBe(200);
    expect(res.body.request.lines).toHaveLength(1);
  });

  it('SCRUM21_AC6_amend_refuses_a_change_of_type_with_400', async () => {
    const client = fakeClient();

    const res = await request(appWith(client))
      .patch(`${BASE}/lines/${LINE_ID}`)
      .send({ equipmentTypeId: TYPE_ID });

    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe('equipmentTypeId');
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM21_AC6_amend_refuses_an_empty_body_with_400', async () => {
    const client = fakeClient();

    const res = await request(appWith(client)).patch(`${BASE}/lines/${LINE_ID}`).send({});

    expect(res.status).toBe(400);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM21_AC6_amend_with_a_line_id_that_is_not_a_uuid_is_a_400', async () => {
    const client = fakeClient();

    const res = await request(appWith(client)).patch(`${BASE}/lines/abc`).send({ quantity: 2 });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'lineId', message: 'must be a UUID' }]);
  });

  it('SCRUM21_AC6_amend_of_a_line_that_is_not_on_the_event_is_a_404', async () => {
    const client = fakeClient({ rpc: { amend_equipment_line: dbError('P0002', 'Equipment line not found') } });

    const res = await request(appWith(client)).patch(`${BASE}/lines/${LINE_ID}`).send({ quantity: 2 });

    expect(res.status).toBe(404);
  });

  it('SCRUM21_AC8_remove_answers_200_and_a_cancelled_request_when_it_was_the_last_line', async () => {
    const client = fakeClient({
      rpc: { remove_equipment_line: ok(stateRow({ status: 'cancelled', lines: [] })) },
    });

    const res = await request(appWith(client)).delete(`${BASE}/lines/${LINE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('cancelled');
    expect(res.body.request.lines).toEqual([]);
  });
});


describe('AC11: reading', () => {
  it('SCRUM21_AC11_answers_200_with_the_request_and_lines', async () => {
    const client = fakeClient({ rpc: { equipment_for_event: ok(stateRow({ status: 'arranged' })) } });

    const res = await request(appWith(client)).get(BASE);

    expect(res.status).toBe(200);
    expect(res.body.request.statusLabel).toBe('Arranged');
  });

  it('SCRUM21_AC11_an_event_that_never_asked_for_equipment_answers_200_with_request_null', async () => {
    const client = fakeClient({ rpc: { equipment_for_event: ok({ request: null }) } });

    const res = await request(appWith(client)).get(BASE);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ request: null });
  });

  it('SCRUM21_AC11_an_event_that_does_not_exist_answers_404', async () => {
    const client = fakeClient({ event: null });

    const res = await request(appWith(client)).get(BASE);

    expect(res.status).toBe(404);
  });

  it('SCRUM21_AC11_the_read_never_calls_a_write_function', async () => {
    const client = fakeClient({ rpc: { equipment_for_event: ok({ request: null }) } });

    await request(appWith(client)).get(BASE);

    expect(client.rpcCalls.map(({ name }) => name)).toEqual(['equipment_for_event']);
  });
});


describe('a database failure', () => {
  it('SCRUM21_answers_500_without_leaking_a_driver_message', async () => {
    const client = fakeClient({ rpc: { add_equipment_line: dbError('XX000', 'secret driver text') } });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(appWith(client))
      .post(`${BASE}/lines`)
      .send({ equipmentTypeId: TYPE_ID, quantity: 1 });

    log.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret driver text');
  });
});
