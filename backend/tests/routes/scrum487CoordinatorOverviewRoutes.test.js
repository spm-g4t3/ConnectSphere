/**
 * SCRUM-487: the Event Coordinator Lead's coordinator overview over HTTP.
 *
 *   GET /api/event-requests/coordinator-overview  AC1, AC2  leadOnly (SCRUM-541)
 *   GET /api/event-requests/assigned?…            AC1, AC3  leadOnly, now filtered (SCRUM-542)
 *
 * Transport tests: the counting and the filtering are proved in
 * tests/services/scrum487CoordinatorOverview.test.js. What is unproved until
 * here is who the gate lets through, that the one-segment path is not read as
 * an id, and that the query string reaches the service as it should.
 *
 * A file of its own, beside SCRUM-486's leadAssignmentRoutes.test.js, which is
 * under review in its PR; its fake is copied, not imported.
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
      throw new Error(`fake client: no result queued for ${call.operation} on ${call.table}`);
    }
    return Promise.resolve(queue.shift());
  }

  return {
    calls,
    from(table) {
      const call = { table, operation: 'select', select: null, filters: [], inFilters: [], notFilters: [], order: [] };
      calls.push(call);
      const chain = {
        select(columns = '*') { call.select = columns; return chain; },
        eq(column, value) { call.filters.push([column, value]); return chain; },
        in(column, values) { call.inFilters.push([column, [...values]]); return chain; },
        not(column, operator, value) { call.notFilters.push([column, operator, value]); return chain; },
        order(column, options) { call.order.push([column, options]); return chain; },
        maybeSingle: () => settle(call),
        single: () => settle(call),
        then: (resolve, reject) => settle(call).then(resolve, reject),
      };
      return chain;
    },
  };
}

const ok = (data) => ({ data, error: null });

const LEAD_ID = '77777777-7777-4777-8777-777777777777';
const COORDINATOR_A = '44444444-4444-4444-8444-444444444444';

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


// ---------------------------------------------------------------------------
// AC1, AC2: GET /coordinator-overview
// ---------------------------------------------------------------------------
describe('SCRUM-487 AC1, AC2: GET /coordinator-overview is the Lead\'s', () => {
  const overview = (client, requireAuth) =>
    request(appWith({ client, requireAuth })).get('/api/event-requests/coordinator-overview');

  it('SCRUM487_AC2_a_lead_reads_every_coordinator_with_counts_per_status', async () => {
    // AC1-01. 200 and { statuses, coordinators }: each coordinator with its
    // byStatus, and each status with its label (SCRUM-546, D9).
    const client = createFakeClient([
      ok([{ id: COORDINATOR_A, full_name: 'Omar Okafor' }]),
      ok([{ assigned_coordinator_id: COORDINATOR_A, status: STATUS.APPROVED }]),
    ]);

    const res = await overview(client);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      statuses: [
        { status: STATUS.SUBMITTED, label: 'Requested', finished: false },
        { status: STATUS.UNDER_REVIEW, label: 'Under review', finished: false },
        { status: STATUS.PENDING_CLARIFICATION, label: 'Awaiting your response', finished: false },
        { status: STATUS.APPROVED, label: 'Planning', finished: false },
        { status: STATUS.CONFIRMED, label: 'Confirmed', finished: false },
        { status: STATUS.COMPLETED, label: 'Completed', finished: true },
        { status: STATUS.REJECTED, label: 'Rejected', finished: true },
        { status: STATUS.CANCELLED, label: 'Cancelled', finished: true },
      ],
      coordinators: [{
        id: COORDINATOR_A,
        fullName: 'Omar Okafor',
        activeEvents: 1,
        byStatus: {
          [STATUS.SUBMITTED]: 0,
          [STATUS.UNDER_REVIEW]: 0,
          [STATUS.PENDING_CLARIFICATION]: 0,
          [STATUS.APPROVED]: 1,
          [STATUS.CONFIRMED]: 0,
        },
      }],
    });
  });

  it('SCRUM487_AC2_does_not_read_the_coordinator_overview_path_as_a_request_id', async () => {
    // AC2-10. '/coordinator-overview' is one segment, so declared after GET
    // /:id Express would match it with id === 'coordinator-overview' and answer
    // from the Organiser's read (an eq on id, then a 404). Asserted from the
    // outside: the first read is of profiles by role, and the answer is the
    // overview's, with no coordinators.
    const client = createFakeClient([ok([])]);

    const res = await overview(client);

    expect(res.status).toBe(200);
    expect(res.body.coordinators).toEqual([]);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].table).toBe('profiles');
    expect(client.calls[0].filters).toEqual([['role', 'event_coordinator']]);
  });

  it.each(NOT_A_LEAD.map((role) => [String(role), role]))(
    'SCRUM487_AC1_%s_is_refused_the_coordinator_overview_with_403_and_queries_nothing',
    async (_label, role) => {
      // AC1-02. leadOnly: every coordinator's caseload is the Lead's to see.
      // Nothing queued, so a query that slipped past the gate would fail.
      const client = createFakeClient([]);

      const res = await overview(client, signedInWithRole(role, COORDINATOR_A));

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'This action is restricted to Event Coordinator Leads' });
      expect(client.calls).toHaveLength(0);
    },
  );

  it('SCRUM487_AC1_the_coordinator_overview_answers_401_without_a_token', async () => {
    // AC1-03.
    const client = createFakeClient([]);

    const res = await overview(client, signedOut);

    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });
});


// ---------------------------------------------------------------------------
// AC1, AC3: GET /assigned with the filters
// ---------------------------------------------------------------------------
describe('SCRUM-487 AC1, AC3: GET /assigned takes the Lead\'s filters', () => {
  const FINISHED = [STATUS.COMPLETED, STATUS.REJECTED, STATUS.CANCELLED];
  const ACTIVE = [STATUS.SUBMITTED, STATUS.UNDER_REVIEW, STATUS.PENDING_CLARIFICATION, STATUS.APPROVED, STATUS.CONFIRMED];
  const assigned = (client, query, requireAuth) =>
    request(appWith({ client, requireAuth })).get(`/api/event-requests/assigned${query}`);

  it('SCRUM487_AC3_the_query_string_reaches_the_read', async () => {
    // AC3-14, AC3-16: every parameter arrives, and a path with a query string
    // is still the list's read, not GET /:id's (no eq on id).
    const client = createFakeClient([ok([])]);

    const res = await assigned(client, `?coordinatorId=${COORDINATOR_A}&status=completed&includeFinished=true`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].filters).toEqual([['status', STATUS.COMPLETED], ['assigned_coordinator_id', COORDINATOR_A]]);
    expect(client.calls[0].notFilters).toEqual([['assigned_coordinator_id', 'is', null]]);
  });

  it.each([
    ['?includeFinished=true', [...ACTIVE, ...FINISHED]],
    ['?includeFinished=false', ACTIVE],
    ['', ACTIVE],
  ])('SCRUM487_AC3_include_finished_%j_reads_its_statuses', async (query, statuses) => {
    // AC3-13. 'true' is true; 'false' and absent are false.
    const client = createFakeClient([ok([])]);

    const res = await assigned(client, query);

    expect(res.status).toBe(200);
    expect(client.calls[0].inFilters).toEqual([['status', statuses]]);
  });

  it.each([
    ['?includeFinished=yes', 'includeFinished'],
    ['?includeFinished=TRUE', 'includeFinished'],
    ['?includeFinished=', 'includeFinished'],
    ['?status=draft', 'status'],
    ['?status=nonsense', 'status'],
    ['?coordinatorId=not-a-uuid', 'coordinatorId'],
    ['?status=approved&status=confirmed', 'status'],
  ])('SCRUM487_AC3_%s_is_400_and_queries_nothing', async (query, field) => {
    // AC3-09 to AC3-12 over HTTP. A stray value is refused, never read as
    // false or as no filter; a repeated parameter arrives as an array and is
    // refused too.
    const client = createFakeClient([]);

    const res = await assigned(client, query);

    expect(res.status).toBe(400);
    expect(res.body.details.map((detail) => detail.field)).toEqual([field]);
    expect(client.calls).toHaveLength(0);
  });

  it.each([
    ['event_coordinator', ROLE.EVENT_COORDINATOR],
    ['event_organiser', ROLE.EVENT_ORGANISER],
  ])('SCRUM487_AC1_%s_is_refused_the_filtered_list_with_403_and_queries_nothing', async (_label, role) => {
    // AC1-04. The filters do not widen the gate; refused before validation.
    const client = createFakeClient([]);

    const res = await assigned(client, `?coordinatorId=${COORDINATOR_A}&status=approved&includeFinished=true`, signedInWithRole(role, COORDINATOR_A));

    expect(res.status).toBe(403);
    expect(client.calls).toHaveLength(0);
  });
});


// ---------------------------------------------------------------------------
// AC5: the Lead's view is read-only; every write on the event page refuses them
// ---------------------------------------------------------------------------
describe('SCRUM-487 AC5: a Lead is refused every write the event page offers a coordinator', () => {
  // SCRUM-487 (SCRUM-545). SCRUM-485 sampled coordinatorOnly with a Lead on
  // GET /queue, GET /coordinators and POST /:id/start-review
  // (SCRUM485_AC5_%s_refuses_%s_with_403_and_queries_nothing); requireRole's
  // own test proves the gate. This covers every write the event screen can
  // make, each one by name: a route moved to coordinatorOrLead by mistake,
  // as POST /:id/reassign was on purpose (SCRUM-486 AC6), fails here by name.
  // POST /:id/reassign is the one write a Lead is allowed, and is SCRUM-486's
  // to prove (SCRUM486_AC6_a_lead_reaches_the_handover_function).
  const EVENT_ID = '22222222-2222-4222-8222-222222222222';
  const CHANGE_REQUEST_ID = '33333333-3333-4333-8333-333333333333';
  const WRITES = [
    ['POST /:id/start-review', (app) => request(app).post(`/api/event-requests/${EVENT_ID}/start-review`).send({})],
    ['POST /:id/decision', (app) => request(app).post(`/api/event-requests/${EVENT_ID}/decision`).send({ decision: 'approved', decisionNote: 'Fine.' })],
    ['POST /:id/cancel', (app) => request(app).post(`/api/event-requests/${EVENT_ID}/cancel`).send({ reason: 'Venue closed.' })],
    ['POST /:id/clarification', (app) => request(app).post(`/api/event-requests/${EVENT_ID}/clarification`).send({ note: 'Numbers?' })],
    ['POST /:id/clarification/close', (app) => request(app).post(`/api/event-requests/${EVENT_ID}/clarification/close`).send({ note: 'Closing.' })],
    [
      'POST /change-requests/:changeRequestId/decision',
      (app) => request(app).post(`/api/event-requests/change-requests/${CHANGE_REQUEST_ID}/decision`).send({ decision: 'approved' }),
    ],
  ];

  it.each(WRITES)('SCRUM487_AC5_a_lead_is_refused_%s_with_403_and_queries_nothing', async (_route, call) => {
    // AC5-04 to AC5-09. Nothing queued: a query that slipped past the gate
    // would fail with "no result queued" instead of passing by accident.
    const client = createFakeClient([]);

    const res = await call(appWith({ client }));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'This action is restricted to Event Coordinators' });
    expect(client.calls).toHaveLength(0);
  });
});
