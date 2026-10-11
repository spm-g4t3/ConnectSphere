/**
 * SCRUM-486 (SCRUM-519): the Event Coordinator Lead's routes over HTTP, and
 * the handover route's widened gate.
 *
 *   GET  /api/event-requests/unassigned            AC2-04, AC2-05  leadOnly
 *   GET  /api/event-requests/coordinator-workload  AC3-06          leadOnly
 *   POST /api/event-requests/:id/assign            AC3-05, AC4     leadOnly
 *   POST /api/event-requests/:id/reassign          AC6-04          coordinatorOrLead
 *
 * Transport tests: the service's reads and refusals are proved in
 * tests/services/leadAssignmentService.test.js, and the database's in
 * tests/db/eventStatusLifecycleDatabase.test.js. What is unproved until here
 * is who the gates let through, that the caller comes from the token, that
 * the one-segment paths are not read as ids, and that a lost race arrives with
 * the holder as data.
 *
 * A file of its own, with its own fake, because none of the fakes in
 * eventRequests.test.js has .is(), which the queue read uses. Adding it there
 * would change helpers other stories' tests share.
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createEventRequestRouter } from '../../src/routes/eventRequests.js';
import { ROLE } from '../../src/domain/userRole.js';
import { STATUS } from '../../src/domain/eventRequestStatus.js';


function createFakeClient(results = []) {
  const queue = [...results];
  const calls = [];

  function settle(call) {
    if (queue.length === 0) {
      throw new Error(`fake client: no result queued for ${call.operation} on ${call.table ?? call.fn}`);
    }
    return Promise.resolve(queue.shift());
  }

  function record(fields) {
    const call = { table: null, fn: null, args: null, filters: [], inFilters: [], isFilters: [], order: [], ...fields };
    calls.push(call);
    return call;
  }

  return {
    calls,
    from(table) {
      const call = record({ table, operation: 'select' });
      const chain = {
        select() { return chain; },
        eq(column, value) { call.filters.push([column, value]); return chain; },
        in(column, values) { call.inFilters.push([column, [...values]]); return chain; },
        is(column, value) { call.isFilters.push([column, value]); return chain; },
        order(column, options) { call.order.push([column, options]); return chain; },
        single: () => settle(call),
        maybeSingle: () => settle(call),
        then: (resolve, reject) => settle(call).then(resolve, reject),
      };
      return chain;
    },
    rpc(fn, args) {
      return settle(record({ operation: 'rpc', fn, args }));
    },
  };
}

const ok = (data) => ({ data, error: null });
const dbFailure = (code, message) => ({ data: null, error: { code, message } });

const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const ORGANISER_ID = '11111111-1111-4111-8111-111111111111';
const LEAD_ID = '77777777-7777-4777-8777-777777777777';
const COORDINATOR_A = '44444444-4444-4444-8444-444444444444';
const COORDINATOR_B = '66666666-6666-4666-8666-666666666666';

const signedInWithRole = (role, id = LEAD_ID) => (req, _res, next) => {
  req.user = { id, email: 'someone@example.com', role };
  next();
};
const signedOut = (_req, res) => res.status(401).json({ error: 'Authentication required' });

function appWith({ client, requireAuth = signedInWithRole(ROLE.EVENT_COORDINATOR_LEAD) } = {}) {
  return express()
    .use(express.json())
    .use('/api/event-requests', createEventRequestRouter({ client, requireAuth }));
}

function row(overrides = {}) {
  return {
    id: REQUEST_ID,
    organiser_id: ORGANISER_ID,
    event_name: 'IS212 Industry Night',
    purpose: 'Connect final-year students with industry partners.',
    description: null,
    proposed_start: '2026-11-01T09:00:00+00:00',
    proposed_end: '2026-11-01T17:00:00+00:00',
    expected_attendance: 120,
    venue_requirements: null,
    accessibility_requirements: null,
    equipment_requirements: null,
    status: STATUS.SUBMITTED,
    clarification_note: null,
    assigned_coordinator_id: null,
    reviewing_coordinator_id: null,
    created_at: '2026-10-01T03:00:00+00:00',
    updated_at: '2026-10-08T03:00:00+00:00',
    submitted_at: '2026-10-08T03:00:00+00:00',
    ...overrides,
  };
}

/** Every role but the Lead, plus an account with no profiles row (role null). */
const NOT_A_LEAD = [
  ROLE.EVENT_COORDINATOR,
  ROLE.EVENT_ORGANISER,
  ROLE.VENUE_STAFF,
  ROLE.TECHNICAL_SUPPORT_STAFF,
  ROLE.ATTENDEE,
  ROLE.SAFETY_OFFICER,
  null,
];

const LEAD_ROUTES = [
  ['GET /unassigned', (app) => request(app).get('/api/event-requests/unassigned')],
  ['GET /coordinator-workload', (app) => request(app).get('/api/event-requests/coordinator-workload')],
  ['POST /:id/assign', (app) => request(app).post(`/api/event-requests/${REQUEST_ID}/assign`).send({ coordinatorId: COORDINATOR_A })],
];


describe('SCRUM-486 AC2, AC3: the Lead\'s routes are the Lead\'s alone', () => {
  const CASES = LEAD_ROUTES.flatMap(([route, call]) => NOT_A_LEAD.map((role) => [route, String(role), role, call]));

  it.each(CASES)('SCRUM486_AC2_%s_refuses_%s_with_403_and_queries_nothing', async (_route, _label, role, call) => {
    // AC2-05, AC3-05. A coordinator too: the queue is the Lead's worklist,
    // and only a Lead can assign (041). Nothing is queued, so a query that
    // slipped past the gate would fail loudly rather than pass by accident.
    const client = createFakeClient([]);

    const res = await call(appWith({ client, requireAuth: signedInWithRole(role) }));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'This action is restricted to Event Coordinator Leads' });
    expect(client.calls).toHaveLength(0);
  });

  it.each(LEAD_ROUTES)('SCRUM486_AC2_%s_answers_401_without_a_token', async (_route, call) => {
    const client = createFakeClient([]);

    const res = await call(appWith({ client, requireAuth: signedOut }));

    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });
});


describe('SCRUM-486 AC2: GET /unassigned', () => {
  it('SCRUM486_AC2_a_lead_reads_the_unassigned_queue', async () => {
    // AC2-04. 200 and a bare array, each row with its organiser's name and
    // the same statusDisplay every other list in this router carries.
    const client = createFakeClient([
      ok([row()]),
      ok([{ id: ORGANISER_ID, full_name: 'Aisha Rahman' }]),
    ]);

    const res = await request(appWith({ client })).get('/api/event-requests/unassigned');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: REQUEST_ID,
      eventName: 'IS212 Industry Night',
      organiserName: 'Aisha Rahman',
      expectedAttendance: 120,
      submittedAt: '2026-10-08T03:00:00+00:00',
      assignedCoordinatorId: null,
    });
    expect(res.body[0].statusDisplay.label).toBeTruthy();
  });

  it('SCRUM486_AC2_does_not_read_the_unassigned_path_as_a_request_id', async () => {
    // '/unassigned' is one segment, so declared after GET /:id Express would
    // read it as id === 'unassigned' and answer from the Organiser's read.
    // Asserted from the outside: the first read is the queue's, by status
    // and a null coordinator, not one event by id.
    const client = createFakeClient([ok([])]);

    const res = await request(appWith({ client })).get('/api/event-requests/unassigned');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].filters).toEqual([['status', STATUS.SUBMITTED]]);
    expect(client.calls[0].isFilters).toEqual([['assigned_coordinator_id', null]]);
  });
});


describe('SCRUM-486 AC3: GET /coordinator-workload', () => {
  it('SCRUM486_AC3_a_lead_reads_every_coordinator_with_their_active_events', async () => {
    const client = createFakeClient([
      ok([{ id: COORDINATOR_A, full_name: 'Omar Okafor' }, { id: COORDINATOR_B, full_name: 'Priya Nair' }]),
      ok([{ assigned_coordinator_id: COORDINATOR_B }]),
    ]);

    const res = await request(appWith({ client })).get('/api/event-requests/coordinator-workload');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: COORDINATOR_A, fullName: 'Omar Okafor', activeEvents: 0 },
      { id: COORDINATOR_B, fullName: 'Priya Nair', activeEvents: 1 },
    ]);
    // Not read as an id: the first read is of profiles by role.
    expect(client.calls[0].table).toBe('profiles');
    expect(client.calls[0].filters).toEqual([['role', 'event_coordinator']]);
  });
});


describe('SCRUM-486 AC3, AC4: POST /:id/assign', () => {
  const assign = (client, body, requireAuth) =>
    request(appWith({ client, requireAuth })).post(`/api/event-requests/${REQUEST_ID}/assign`).send(body);

  it('SCRUM486_AC3_a_lead_assigns_and_is_recorded_from_the_token_not_the_body', async () => {
    // AC3-05. The body names someone else as the one assigning; it is
    // ignored. Without this a Lead's assignment could be made to look like
    // another person's, and 041's Lead check would test the wrong person.
    const client = createFakeClient([ok(row({ assigned_coordinator_id: COORDINATOR_A }))]);

    const res = await assign(client, { coordinatorId: COORDINATOR_A, note: 'Over to you', assignedBy: COORDINATOR_B });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: REQUEST_ID, assignedCoordinatorId: COORDINATOR_A });
    expect(res.body.statusDisplay.label).toBeTruthy();
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].fn).toBe('assign_event_request');
    expect(client.calls[0].args).toEqual({
      p_event_request_id: REQUEST_ID,
      p_coordinator_id: COORDINATOR_A,
      p_assigned_by: LEAD_ID,
      p_note: 'Over to you',
    });
  });

  it('SCRUM486_AC3_refuses_a_missing_coordinator_before_the_database', async () => {
    const client = createFakeClient([]);

    const res = await assign(client, { note: 'Over to you' });

    expect(res.status).toBe(400);
    expect(res.body.details.map((d) => d.field)).toEqual(['coordinatorId']);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM486_AC4_a_lost_race_arrives_as_a_409_with_the_holder_as_data', async () => {
    // AC4-03/04. code and conflicts are what the screen reads to say "already
    // assigned to Priya Nair"; it never parses the message.
    const client = createFakeClient([
      dbFailure('55000', `event request ${REQUEST_ID} is already assigned to Priya Nair`),
      ok({ assigned_coordinator_id: COORDINATOR_B }),
      ok([{ id: COORDINATOR_B, full_name: 'Priya Nair' }]),
    ]);

    const res = await assign(client, { coordinatorId: COORDINATOR_A });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'This request has already been assigned to Priya Nair.',
      code: 'ALREADY_ASSIGNED',
      conflicts: [{ assignedCoordinatorId: COORDINATOR_B, assignedCoordinatorName: 'Priya Nair' }],
    });
  });

  it.each([
    ['42501', 'only the Event Coordinator Lead can assign event request', 403],
    ['22023', 'is not an Event Coordinator', 400],
    ['P0002', 'event request not found', 404],
  ])('SCRUM486_AC3_the_functions_%s_arrives_as_its_status', async (code, message, status) => {
    const client = createFakeClient([dbFailure(code, message)]);

    const res = await assign(client, { coordinatorId: COORDINATOR_A });

    expect(res.status).toBe(status);
    expect(res.body.error).toBe(message);
  });
});


describe('SCRUM-486 AC6: POST /:id/reassign admits the Lead as well as a coordinator', () => {
  const handOver = (client, requireAuth) =>
    request(appWith({ client, requireAuth }))
      .post(`/api/event-requests/${REQUEST_ID}/reassign`)
      .send({ newCoordinatorId: COORDINATOR_B, handoverNote: 'Handing over' });

  const handedOver = () => ok(row({ status: STATUS.UNDER_REVIEW, assigned_coordinator_id: COORDINATOR_B }));

  it('SCRUM486_AC6_a_lead_reaches_the_handover_function', async () => {
    // AC6-04. Before SCRUM-519 this route was coordinatorOnly, so a Lead was
    // refused here with "restricted to Event Coordinators" and 041's widened
    // reassign_event_request was unreachable from the browser. The Lead is
    // the one handing over, from the token.
    const client = createFakeClient([handedOver()]);

    const res = await handOver(client, signedInWithRole(ROLE.EVENT_COORDINATOR_LEAD));

    expect(res.status).toBe(200);
    expect(res.body.assignedCoordinatorId).toBe(COORDINATOR_B);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].fn).toBe('reassign_event_request');
    expect(client.calls[0].args.p_assigned_by).toBe(LEAD_ID);
  });

  it('SCRUM486_AC6_a_coordinator_still_reaches_it', async () => {
    // SCRUM-327 AC6, unchanged: the holder hands over. Whether this
    // coordinator holds the event is still the function's question.
    const client = createFakeClient([handedOver()]);

    const res = await handOver(client, signedInWithRole(ROLE.EVENT_COORDINATOR, COORDINATOR_A));

    expect(res.status).toBe(200);
    expect(client.calls[0].args.p_assigned_by).toBe(COORDINATOR_A);
  });

  it.each(
    [ROLE.EVENT_ORGANISER, ROLE.VENUE_STAFF, ROLE.TECHNICAL_SUPPORT_STAFF, ROLE.ATTENDEE, ROLE.SAFETY_OFFICER, null]
      .map((role) => [String(role), role]),
  )('SCRUM486_AC6_%s_is_refused_the_handover_with_403_and_queries_nothing', async (_label, role) => {
    // Widened by exactly one role. The refusal now names both who may.
    const client = createFakeClient([]);

    const res = await handOver(client, signedInWithRole(role, ORGANISER_ID));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'This action is restricted to Event Coordinators or Event Coordinator Leads' });
    expect(client.calls).toHaveLength(0);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-521: the reads the event screen makes on mount admit the Lead
// ---------------------------------------------------------------------------
describe('SCRUM-486 AC6: the event screen\'s reads admit the Lead, so the hand-over is reachable', () => {
  // The reassign route admitted the Lead in SCRUM-519, but the screen a
  // handover is made from loads with these three reads, and each was
  // coordinatorOnly: the Lead could not open the screen at all. The fourth
  // mount read, the clarification history, has no route gate; its service
  // check is pinned in leadAssignmentService.test.js.
  const held = () => row({ status: STATUS.UNDER_REVIEW, assigned_coordinator_id: COORDINATOR_A });
  const historyRow = {
    id: 'h1',
    previous_coordinator_id: null,
    new_coordinator_id: COORDINATOR_A,
    assigned_by: LEAD_ID,
    handover_note: 'Yours from today',
    created_at: '2026-10-09T03:00:00+00:00',
  };

  const READS = [
    ['GET /:id/review', `/api/event-requests/${REQUEST_ID}/review`, () => [ok(held())]],
    [
      'GET /:id/assignments/review',
      `/api/event-requests/${REQUEST_ID}/assignments/review`,
      () => [ok(held()), ok([historyRow]), ok([{ id: COORDINATOR_A, full_name: 'Priya Nair' }, { id: LEAD_ID, full_name: 'Lena Lead' }])],
    ],
    ['GET /:id/change-requests/review', `/api/event-requests/${REQUEST_ID}/change-requests/review`, () => [ok([])]],
  ];

  it.each(READS)('SCRUM486_AC6_a_lead_who_holds_nothing_reads_%s', async (_route, path, results) => {
    const client = createFakeClient(results());

    const res = await request(appWith({ client })).get(path);

    expect(res.status).toBe(200);
  });

  it('SCRUM486_AC6_the_lead_opens_the_event_as_a_coordinator_does', async () => {
    const client = createFakeClient([ok(held())]);

    const res = await request(appWith({ client })).get(`/api/event-requests/${REQUEST_ID}/review`);

    expect(res.body).toMatchObject({ id: REQUEST_ID, assignedCoordinatorId: COORDINATOR_A });
    expect(res.body.statusDisplay.label).toBeTruthy();
  });

  it('SCRUM486_AC6_the_lead_reads_the_history_with_its_notes', async () => {
    // The Lead writes handover notes (041 records theirs), so reads them; the
    // Organiser's route still never carries them.
    const [, path, results] = READS[1];
    const client = createFakeClient(results());

    const res = await request(appWith({ client })).get(path);

    expect(res.body).toEqual([expect.objectContaining({ assignedByName: 'Lena Lead', handoverNote: 'Yours from today' })]);
  });

  it.each(
    READS.flatMap(([route, path]) =>
      [ROLE.EVENT_ORGANISER, ROLE.VENUE_STAFF, ROLE.TECHNICAL_SUPPORT_STAFF, ROLE.ATTENDEE, ROLE.SAFETY_OFFICER, null]
        .map((role) => [route, String(role), role, path])),
  )('SCRUM486_AC6_%s_still_refuses_%s_and_reads_nothing', async (_route, _label, role, path) => {
    // Widened by exactly one role.
    const client = createFakeClient([]);

    const res = await request(appWith({ client, requireAuth: signedInWithRole(role, ORGANISER_ID) })).get(path);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'This action is restricted to Event Coordinators or Event Coordinator Leads' });
    expect(client.calls).toHaveLength(0);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-522: AC9-04, AC9-05 -- the two history routes over an old automatic
// row and a Lead's row
// ---------------------------------------------------------------------------
describe('SCRUM-486 AC9: both history routes carry the old row and the Lead\'s', () => {
  const rows = () => [
    {
      id: 'h1', previous_coordinator_id: null, new_coordinator_id: COORDINATOR_A,
      assigned_by: null, handover_note: null, created_at: '2026-09-20T03:00:00+00:00',
    },
    {
      id: 'h2', previous_coordinator_id: COORDINATOR_A, new_coordinator_id: COORDINATOR_B,
      assigned_by: LEAD_ID, handover_note: 'Priya is on leave.', created_at: '2026-10-11T03:00:00+00:00',
    },
  ];
  const names = () => [
    { id: COORDINATOR_A, full_name: 'Priya Nair' },
    { id: COORDINATOR_B, full_name: 'Omar Okafor' },
    { id: LEAD_ID, full_name: 'Lena Lead' },
  ];
  const event = () => row({ status: STATUS.UNDER_REVIEW, assigned_coordinator_id: COORDINATOR_B });

  it('SCRUM486_AC9_the_organisers_route_has_both_rows_and_no_note_on_either', async () => {
    // AC9-04. The Lead is named to the Organiser (who moved their event is
    // theirs to know); the note is not (AC9: written for coordinators).
    const client = createFakeClient([ok(event()), ok(rows()), ok(names())]);

    const res = await request(appWith({ client, requireAuth: signedInWithRole(ROLE.EVENT_ORGANISER, ORGANISER_ID) }))
      .get(`/api/event-requests/${REQUEST_ID}/assignments`);

    expect(res.status).toBe(200);
    expect(res.body.map((entry) => [entry.automatic, entry.assignedByName])).toEqual([[true, null], [false, 'Lena Lead']]);
    for (const entry of res.body) expect(entry).not.toHaveProperty('handoverNote');
  });

  it('SCRUM486_AC9_the_coordinators_route_has_both_rows_with_the_note', async () => {
    // AC9-05, as the coordinator who now holds it.
    const client = createFakeClient([ok(event()), ok(rows()), ok(names())]);

    const res = await request(appWith({ client, requireAuth: signedInWithRole(ROLE.EVENT_COORDINATOR, COORDINATOR_B) }))
      .get(`/api/event-requests/${REQUEST_ID}/assignments/review`);

    expect(res.status).toBe(200);
    expect(res.body.map((entry) => [entry.automatic, entry.assignedByName, entry.handoverNote]))
      .toEqual([[true, null, null], [false, 'Lena Lead', 'Priya is on leave.']]);
  });
});
