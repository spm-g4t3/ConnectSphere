/**
 * SCRUM-434 (AC2, AC3, AC6, AC8): the event routes an Organiser uses, called by
 * someone who does not own the event. Every one is answered 404, as if the
 * event did not exist, and none writes anything.
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createEventRequestRouter } from '../../src/routes/eventRequests.js';
import { ROLE } from '../../src/domain/userRole.js';
import { ok, createEventRequestClient } from '../fixtures/supabaseStubs.js';
import { signedOut, signedInFor } from '../fixtures/auth.js';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const STRANGER_ID = '33333333-3333-4333-8333-333333333333';

const storedRow = () => ({
  id: REQUEST_ID,
  organiser_id: OWNER_ID,
  event_name: 'IS212 Industry Night',
  status: 'submitted',
  assigned_coordinator_id: null,
  created_at: '2026-10-01T03:00:00+00:00',
  updated_at: '2026-10-20T03:00:00+00:00',
  submitted_at: '2026-10-02T03:00:00+00:00',
});

const signedInAs = signedInFor(STRANGER_ID);
const app = (client, requireAuth) =>
  express()
    .use(express.json())
    .use('/api/event-requests', createEventRequestRouter({ client, requireAuth }));

const base = `/api/event-requests/${REQUEST_ID}`;

// Reads an Organiser opens for their own event. They have no role gate: the
// ownership check is what keeps a stranger out, so it is what is pinned.
const READ_ROUTES = [
  ['GET', '', null],
  ['GET', '/status', null],
  ['GET', '/status-history', null],
  ['GET', '/clarification-history', null],
  ['GET', '/decision-history', null],
  ['GET', '/change-history', null],
  ['GET', '/change-requests', null],
  ['GET', '/assignments', null],
];

// Writes an Organiser makes to their own event. Role-gated to the Organiser
// (SCRUM-434 AC6): before, any signed-in account could create an event, edit a
// draft, submit it or raise a change, and it was only the ownership check that
// stopped it touching someone else's.
const WRITE_ROUTES = [
  ['POST', '', { eventName: 'A new event' }],
  ['PATCH', '', { eventName: 'Renamed' }],
  ['POST', '/submit', {}],
  ['PATCH', '/clarification-response', { message: 'Here is the answer' }],
  ['POST', '/change-requests', { field: 'event_name', details: 'A new name' }],
];
const ALL_ROUTES = [...READ_ROUTES, ...WRITE_ROUTES];

const NON_ORGANISER_ROLES = [
  ['an event coordinator', ROLE.EVENT_COORDINATOR],
  ['the lead', ROLE.EVENT_COORDINATOR_LEAD],
  ['venue staff', ROLE.VENUE_STAFF],
  ['technical support', ROLE.TECHNICAL_SUPPORT_STAFF],
  ['a safety officer', ROLE.SAFETY_OFFICER],
  ['an attendee', ROLE.ATTENDEE],
];

// Histories a coordinator or the Lead may read on a submitted event they do not
// own. The service decides this per role, and the access-matrix test covers it
// against the real schema; here they are left out of the 404 cases.
const MAY_READ = {
  [ROLE.EVENT_COORDINATOR]: new Set(['/clarification-history']),
  [ROLE.EVENT_COORDINATOR_LEAD]: new Set(['/clarification-history', '/decision-history', '/change-history']),
};

const WRITES = new Set(['insert', 'update', 'rpc', 'delete']);

const send = (client, requireAuth, route) => {
  const [method, path, body] = route;
  // POST / creates, so it has no id in its path; every other route does.
  const url = method === 'POST' && path === '' ? '/api/event-requests' : `${base}${path}`;
  const call = request(app(client, requireAuth));
  if (method === 'GET') return call.get(url);
  if (method === 'PATCH') return call.patch(url).send(body);
  return call.post(url).send(body);
};
const label = (route) => `${route[0]} ${route[1] || '/:id'}`;

describe('SCRUM-434: an account that is not the event\'s Organiser', () => {
  describe('another Organiser is answered as if the event did not exist', () => {
    const OTHER = signedInAs(ROLE.EVENT_ORGANISER);

    it.each(ALL_ROUTES.filter((r) => !(r[0] === 'POST' && r[1] === '')).map((r) => [label(r), r]))(
      'SCRUM434_AC6_%s_is_a_404',
      async (_name, route) => {
        // Reads find the event and refuse on ownership. PATCH is guarded on
        // organiser in the write itself, so it finds no row to change.
        const client = createEventRequestClient([ok(storedRow()), ok(null), ok(null)]);

        const res = await send(client, OTHER, route);

        expect(res.status).toBe(404);
        expect(JSON.stringify(res.body)).not.toContain('IS212 Industry Night');
      },
    );

    it('SCRUM434_AC8_no_route_wrote_anything_when_refused', async () => {
      for (const route of ALL_ROUTES.filter((r) => !(r[0] === 'POST' && r[1] === ''))) {
        const client = createEventRequestClient([ok(storedRow()), ok(null), ok(null)]);

        await send(client, OTHER, route);

        // PATCH reaches the guarded update, which matches no row; it is the
        // only write attempted, and it changes nothing.
        const attempted = client.calls.filter((call) => WRITES.has(call.operation));
        for (const call of attempted) {
          expect(call.filters).toContainEqual(['organiser_id', STRANGER_ID]);
        }
      }
    });
  });

  describe.each(NON_ORGANISER_ROLES)('%s', (_who, role) => {
    it.each(WRITE_ROUTES.map((r) => [label(r), r]))(
      'SCRUM434_AC6_%s_is_refused_with_403_and_queries_nothing',
      async (_name, route) => {
        const client = createEventRequestClient([]);

        const res = await send(client, signedInAs(role), route);

        expect(res.status).toBe(403);
        expect(client.calls).toHaveLength(0);
      },
    );

    it.each(READ_ROUTES.filter((r) => !MAY_READ[role]?.has(r[1])).map((r) => [label(r), r]))(
      'SCRUM434_AC6_%s_is_a_404_for_an_event_that_is_not_theirs',
      async (_name, route) => {
        const client = createEventRequestClient([ok(storedRow())]);

        const res = await send(client, signedInAs(role), route);

        expect(res.status).toBe(404);
        expect(JSON.stringify(res.body)).not.toContain('IS212 Industry Night');
        expect(client.calls.filter((call) => WRITES.has(call.operation))).toEqual([]);
      },
    );
  });

  it.each(ALL_ROUTES.map((r) => [label(r), r]))(
    'SCRUM434_AC6_%s_answers_401_without_a_token_and_queries_nothing',
    async (_name, route) => {
      const client = createEventRequestClient([]);

      const res = await send(client, signedOut, route);

      expect(res.status).toBe(401);
      expect(client.calls).toHaveLength(0);
    },
  );

  it('SCRUM434_AC6_the_organiser_still_creates_edits_and_submits', async () => {
    // The gate must not lock out the role it is for.
    const ORGANISER = signedInAs(ROLE.EVENT_ORGANISER, OWNER_ID);
    const client = createEventRequestClient([ok({ ...storedRow(), status: 'draft' })]);

    const res = await send(client, ORGANISER, ['POST', '', { eventName: 'A new event' }]);

    expect(res.status).toBe(201);
    expect(client.calls[0]).toMatchObject({ operation: 'insert' });
    expect(client.calls[0].payload.organiser_id).toBe(OWNER_ID);
  });

  it('SCRUM434_AC6_another_organiser_gets_the_answer_a_missing_event_gets', async () => {
    const missing = createEventRequestClient([ok(null)]);
    const real = createEventRequestClient([ok(storedRow())]);
    const as = signedInAs(ROLE.EVENT_ORGANISER);

    const forMissing = await send(missing, as, ['GET', '/status-history', null]);
    const forReal = await send(real, as, ['GET', '/status-history', null]);

    expect(forReal.status).toBe(forMissing.status);
    expect(forReal.body).toEqual(forMissing.body);
  });
});
