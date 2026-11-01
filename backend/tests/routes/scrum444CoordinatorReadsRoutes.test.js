/**
 * SCRUM-444 (SCRUM-445, SCRUM-448): the coordinator reads answer only the holder
 * and the Lead, everyone else as a missing id (AC1, AC4, AC5); reassign is the
 * Lead's alone and GET /coordinators is gone (AC3). Transport only: the real
 * routers and services over a fake client. The database half is
 * tests/db/scrum444AccessMatrixDatabase.test.js. Cases: docs/test-cases/SCRUM-444.md.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createEventRequestRouter } from '../../src/routes/eventRequests.js';
import { createEventEquipmentRouter } from '../../src/routes/eventEquipment.js';
import { ROLE } from '../../src/domain/userRole.js';
import { STATUS } from '../../src/domain/eventRequestStatus.js';
import { ok, createEventRequestClient } from '../fixtures/supabaseStubs.js';
import { signedInFor } from '../fixtures/auth.js';

const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const MISSING_ID = '99999999-9999-4999-8999-999999999999';
const ORGANISER_ID = '11111111-1111-4111-8111-111111111111';
const HOLDER_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_COORDINATOR_ID = '66666666-6666-4666-8666-666666666666';
const LEAD_ID = '77777777-7777-4777-8777-777777777777';
const STAFF_ID = '88888888-8888-4888-8888-888888888888';

const SECRET = 'Two attendees complained about the venue.';

const row = (overrides = {}) => ({
  id: EVENT_ID,
  organiser_id: ORGANISER_ID,
  event_name: 'IS212 Industry Night',
  status: STATUS.APPROVED,
  assigned_coordinator_id: HOLDER_ID,
  closing_notes: null,
  bookings: [],
  equipment_reservations: [],
  created_at: '2026-10-20T03:00:00+00:00',
  updated_at: '2026-10-21T03:00:00+00:00',
  submitted_at: '2026-10-20T04:00:00+00:00',
  ...overrides,
});

const appWith = (client, requireAuth) =>
  express()
    .use(express.json())
    .use('/api/event-requests/:id/equipment', createEventEquipmentRouter({ client, requireAuth }))
    .use('/api/event-requests', createEventRequestRouter({ client, requireAuth }));

const as = (role, id) => signedInFor(id)(role);

// The six reads (AC1). `after` is what each queries once the event read lets the
// caller through; a refusal must query nothing past the event read.
const READS = [
  ['review', (id) => `/api/event-requests/${id}/review`, []],
  ['assignments_review', (id) => `/api/event-requests/${id}/assignments/review`, [ok([])]],
  ['readiness', (id) => `/api/event-requests/${id}/readiness`, [ok({ ready: false, lines: [] })]],
  ['change_requests_review', (id) => `/api/event-requests/${id}/change-requests/review`, [ok([])]],
  ['equipment', (id) => `/api/event-requests/${id}/equipment`, [ok({ id: EVENT_ID }), ok({ request: null })]],
  ['clarification_history', (id) => `/api/event-requests/${id}/clarification-history`, [ok([])]],
];
const GATED = READS.filter(([name]) => name !== 'clarification_history');

async function read(path, { event = row(), after = [], role, userId }) {
  const client = createEventRequestClient([ok(event), ...after]);
  const res = await request(appWith(client, as(role, userId))).get(path);
  return { res, client };
}

/** A missing id's answer on this read: the reference body for every refusal. */
async function missingIdAnswer(path) {
  const { res } = await read(path(MISSING_ID), { event: null, role: ROLE.EVENT_COORDINATOR, userId: HOLDER_ID });
  return res;
}

/** The refusal's body with the event's id written as the missing one, to compare. */
const asMissing = (body) => JSON.parse(JSON.stringify(body).replaceAll(EVENT_ID, MISSING_ID));

describe('SCRUM-444 AC1: a coordinator reads only the events they hold; the Lead reads all', () => {
  it.each(READS)('SCRUM444_AC1_the_holder_reads_%s', async (_name, path, after) => {
    const { res } = await read(path(EVENT_ID), { after, role: ROLE.EVENT_COORDINATOR, userId: HOLDER_ID });

    expect(res.status).toBe(200);
  });

  it.each(READS)('SCRUM444_AC1_the_lead_reads_%s', async (_name, path, after) => {
    const { res } = await read(path(EVENT_ID), { after, role: ROLE.EVENT_COORDINATOR_LEAD, userId: LEAD_ID });

    expect(res.status).toBe(200);
  });

  it.each(READS)('SCRUM444_AC1_a_missing_id_is_404_on_%s', async (_name, path) => {
    const res = await missingIdAnswer(path);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: `Event request ${MISSING_ID} not found` });
  });

  it.each(READS)('SCRUM444_AC1_another_coordinator_gets_the_missing_ids_404_on_%s', async (_name, path) => {
    const { res, client } = await read(path(EVENT_ID), { role: ROLE.EVENT_COORDINATOR, userId: OTHER_COORDINATOR_ID });

    expect(res.status).toBe(404);
    expect(asMissing(res.body)).toEqual((await missingIdAnswer(path)).body);
    // The event read only: nothing else is queried, and nothing written.
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({ table: 'event_requests', operation: 'select' });
  });

  it.each(READS)('SCRUM444_AC1_other_roles_are_answered_on_%s_as_before', async (name, path) => {
    for (const [role, userId] of [
      [ROLE.EVENT_ORGANISER, ORGANISER_ID],
      [ROLE.VENUE_STAFF, STAFF_ID],
      [ROLE.TECHNICAL_SUPPORT_STAFF, STAFF_ID],
      [ROLE.SAFETY_OFFICER, STAFF_ID],
      [ROLE.ATTENDEE, STAFF_ID],
    ]) {
      const { res, client } = await read(path(EVENT_ID), { after: [ok([])], role, userId });

      if (name !== 'clarification_history') {
        // The role gate answers before any query.
        expect(res.status).toBe(403);
        expect(client.calls).toHaveLength(0);
      } else if (userId === ORGANISER_ID) {
        expect(res.status).toBe(200);
      } else {
        expect(res.status).toBe(404);
        expect(asMissing(res.body)).toEqual((await missingIdAnswer(path)).body);
      }
    }
  });

  it.each(READS)('SCRUM444_AC1_a_draft_is_404_on_%s', async (_name, path) => {
    // A coordinator left on a draft reopened before 015, and the Lead.
    const draft = row({ status: STATUS.DRAFT });
    for (const [role, userId] of [[ROLE.EVENT_COORDINATOR, HOLDER_ID], [ROLE.EVENT_COORDINATOR_LEAD, LEAD_ID]]) {
      const { res } = await read(path(EVENT_ID), { event: draft, role, userId });

      expect(res.status).toBe(404);
      expect(asMissing(res.body)).toEqual((await missingIdAnswer(path)).body);
    }
  });

  it('SCRUM444_AC1_the_organiser_still_reads_their_drafts_clarification_history', async () => {
    const { res } = await read(`/api/event-requests/${EVENT_ID}/clarification-history`, {
      event: row({ status: STATUS.DRAFT, assigned_coordinator_id: null }), after: [ok([])],
      role: ROLE.EVENT_ORGANISER, userId: ORGANISER_ID,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('SCRUM444_AC1_a_non_holder_gets_the_id_back_as_typed_like_a_missing_event', async () => {
    // Postgres matches a uuid in any case, so an existing event typed in
    // capitals is found; its refusal must echo the capitals, as a missing id's does.
    const STORED = 'abcdef12-3456-4abc-8def-abcdef123456';
    const TYPED = STORED.toUpperCase();
    const MISSING_TYPED = 'fedcba98-7654-4cba-8fed-fedcba987654'.toUpperCase();

    for (const [, path] of READS) {
      const { res: refused } = await read(path(TYPED), {
        event: row({ id: STORED }), role: ROLE.EVENT_COORDINATOR, userId: OTHER_COORDINATOR_ID,
      });
      const { res: missing } = await read(path(MISSING_TYPED), { event: null, role: ROLE.EVENT_COORDINATOR, userId: HOLDER_ID });

      expect(refused.status).toBe(404);
      expect(refused.body).toEqual({ error: `Event request ${TYPED} not found` });
      expect(JSON.parse(JSON.stringify(refused.body).replaceAll(TYPED, MISSING_TYPED))).toEqual(missing.body);
    }
  });

  it('SCRUM444_AC1_get_by_id_refuses_a_malformed_id_with_400_before_the_read', async () => {
    // GET /:id, the Organiser's read: a 400, not Postgres's 22P02 as a 500.
    const client = createEventRequestClient([]);

    const res = await request(appWith(client, as(ROLE.EVENT_ORGANISER, ORGANISER_ID))).get('/api/event-requests/not-a-uuid');

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'id', message: 'must be a valid id' }]);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM444_AC1_the_queue_route_passes_the_caller', async () => {
    const client = createEventRequestClient([ok([row({ status: STATUS.UNDER_REVIEW })])]);

    const res = await request(appWith(client, as(ROLE.EVENT_COORDINATOR, HOLDER_ID))).get('/api/event-requests/queue');

    expect(res.status).toBe(200);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].filters).toContainEqual(['assigned_coordinator_id', HOLDER_ID]);
  });
});

describe('SCRUM-444 AC4: after a handover the previous holder is a non-holder', () => {
  // Handed by the Lead from HOLDER_ID to OTHER_COORDINATOR_ID.
  const handedOver = row({ assigned_coordinator_id: OTHER_COORDINATOR_ID });

  it.each(READS)('SCRUM444_AC4_the_previous_holder_gets_the_missing_ids_404_on_%s', async (_name, path) => {
    const { res, client } = await read(path(EVENT_ID), { event: handedOver, role: ROLE.EVENT_COORDINATOR, userId: HOLDER_ID });

    expect(res.status).toBe(404);
    expect(asMissing(res.body)).toEqual((await missingIdAnswer(path)).body);
    expect(client.calls).toHaveLength(1);
  });

  it.each(READS)('SCRUM444_AC4_the_new_holder_reads_%s', async (_name, path, after) => {
    const { res } = await read(path(EVENT_ID), { event: handedOver, after, role: ROLE.EVENT_COORDINATOR, userId: OTHER_COORDINATOR_ID });

    expect(res.status).toBe(200);
  });
});

describe('SCRUM-444 AC5: closing notes reach no non-holder', () => {
  it('SCRUM444_AC5_a_non_holder_cannot_read_the_closing_notes', async () => {
    const completed = row({ status: STATUS.COMPLETED, closing_notes: SECRET });

    const { res } = await read(`/api/event-requests/${EVENT_ID}/review`, {
      event: completed, role: ROLE.EVENT_COORDINATOR, userId: OTHER_COORDINATOR_ID,
    });

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    // The holder still reads them (SCRUM-379).
    const holder = await read(`/api/event-requests/${EVENT_ID}/review`, { event: completed, role: ROLE.EVENT_COORDINATOR, userId: HOLDER_ID });
    expect(holder.res.body.closingNotes).toBe(SECRET);
  });
});

describe('SCRUM-444 AC3: only the Lead hands an event over', () => {
  const reassign = (client, role, userId) => request(appWith(client, as(role, userId)))
    .post(`/api/event-requests/${EVENT_ID}/reassign`)
    .send({ newCoordinatorId: OTHER_COORDINATOR_ID });

  it('SCRUM444_AC3_a_coordinator_is_refused_reassign_with_403_and_queries_nothing', async () => {
    // The holder too: leadOnly answers before the function is reached.
    const client = createEventRequestClient([]);

    const res = await reassign(client, ROLE.EVENT_COORDINATOR, HOLDER_ID);

    expect(res.status).toBe(403);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM444_AC3_the_lead_reaches_reassign', async () => {
    const client = createEventRequestClient([ok(row({ assigned_coordinator_id: OTHER_COORDINATOR_ID }))]);

    const res = await reassign(client, ROLE.EVENT_COORDINATOR_LEAD, LEAD_ID);

    expect(res.status).toBe(200);
    expect(client.calls).toEqual([expect.objectContaining({
      operation: 'rpc',
      fn: 'reassign_event_request',
      args: expect.objectContaining({ p_assigned_by: LEAD_ID, p_new_coordinator_id: OTHER_COORDINATOR_ID }),
    })]);
  });

  it('SCRUM444_AC3_get_coordinators_is_gone_and_answers_400_with_no_read', async () => {
    const router = createEventRequestRouter({ client: createEventRequestClient([]), requireAuth: as(ROLE.EVENT_COORDINATOR, HOLDER_ID) });
    expect(router.stack.some((layer) => layer.route?.path === '/coordinators')).toBe(false);

    // The path falls through to GET /:id, which refuses the word as an id
    // before reading anything: no event, no profile.
    const client = createEventRequestClient([]);
    const res = await request(appWith(client, as(ROLE.EVENT_COORDINATOR, HOLDER_ID))).get('/api/event-requests/coordinators');

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'id', message: 'must be a valid id' }]);
    expect(client.calls).toHaveLength(0);
  });
});
