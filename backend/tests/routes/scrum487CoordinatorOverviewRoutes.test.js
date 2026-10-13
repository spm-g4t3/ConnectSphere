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
    // AC1-01. 200 and a bare array, each row with its byStatus.
    const client = createFakeClient([
      ok([{ id: COORDINATOR_A, full_name: 'Omar Okafor' }]),
      ok([{ assigned_coordinator_id: COORDINATOR_A, status: STATUS.APPROVED }]),
    ]);

    const res = await overview(client);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{
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
    }]);
  });

  it('SCRUM487_AC2_does_not_read_the_coordinator_overview_path_as_a_request_id', async () => {
    // AC2-10. '/coordinator-overview' is one segment, so declared after GET
    // /:id Express would match it with id === 'coordinator-overview' and answer
    // from the Organiser's read (an eq on id, then a 404). Asserted from the
    // outside: the first read is of profiles by role, and the answer is the
    // overview's empty array.
    const client = createFakeClient([ok([])]);

    const res = await overview(client);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
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
