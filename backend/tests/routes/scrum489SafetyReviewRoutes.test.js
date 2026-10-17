/**
 * SCRUM-489 (SCRUM-555, SCRUM-556) over HTTP:
 *
 *   GET  /api/event-requests/:id/readiness      AC2, AC3  coordinatorOrLead
 *   POST /api/event-requests/:id/safety-review  AC1, AC4 to AC6, AC8  coordinatorOnly
 *
 * Transport tests: who the gates let through, the caller from the token, the
 * query and body parameters, and the 409 a not-ready event arrives as. The fake
 * is SCRUM-486's leadAssignmentRoutes.test.js's, copied.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createEventRequestRouter } from '../../src/routes/eventRequests.js';
import { ROLE } from '../../src/domain/userRole.js';

function createFakeClient(results = []) {
  const queue = [...results];
  const calls = [];

  function settle(call) {
    if (queue.length === 0) {
      throw new Error(`fake client: no result queued for ${call.operation} on ${call.table ?? call.fn}`);
    }
    return Promise.resolve(queue.shift());
  }

  return {
    calls,
    from(table) {
      const call = { table, fn: null, operation: 'select', filters: [] };
      calls.push(call);
      const chain = {
        select() { return chain; },
        eq(column, value) { call.filters.push([column, value]); return chain; },
        maybeSingle: () => settle(call),
        single: () => settle(call),
        then: (resolve, reject) => settle(call).then(resolve, reject),
      };
      return chain;
    },
    rpc(fn, args) {
      const call = { table: null, fn, args, operation: 'rpc' };
      calls.push(call);
      return settle(call);
    },
  };
}

const ok = (data) => ({ data, error: null });
const dbError = (code, message, extra = {}) => ({ data: null, error: { code, message, ...extra } });

const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const COORDINATOR_A = '44444444-4444-4444-8444-444444444444';
const COORDINATOR_B = '66666666-6666-4666-8666-666666666666';
const LEAD_ID = '77777777-7777-4777-8777-777777777777';

const signedInWithRole = (role, id = COORDINATOR_A) => (req, _res, next) => {
  req.user = { id, email: 'someone@example.com', role };
  next();
};
const signedOut = (_req, res) => res.status(401).json({ error: 'Authentication required' });

function appWith({ client, requireAuth = signedInWithRole(ROLE.EVENT_COORDINATOR) } = {}) {
  return express()
    .use(express.json())
    .use('/api/event-requests', createEventRequestRouter({ client, requireAuth }));
}

const eventRow = (overrides = {}) => ({
  id: EVENT_ID,
  organiser_id: '11111111-1111-4111-8111-111111111111',
  event_name: 'IS212 Industry Night',
  status: 'approved',
  assigned_coordinator_id: COORDINATOR_A,
  created_at: '2026-10-01T03:00:00+00:00',
  updated_at: '2026-10-14T03:00:00+00:00',
  submitted_at: '2026-10-02T03:00:00+00:00',
  ...overrides,
});

const CHECKLIST = {
  eventRequestId: EVENT_ID,
  ready: false,
  items: [{ key: 'venue', met: false, detail: 'No venue booking' }, { key: 'date', met: true, detail: 'Starts in the future' }],
};

const OTHER_ROLES = [ROLE.EVENT_ORGANISER, ROLE.VENUE_STAFF, ROLE.TECHNICAL_SUPPORT_STAFF, ROLE.ATTENDEE, ROLE.SAFETY_OFFICER, null];

describe('SCRUM-363: POST /:id/confirm', () => {
  const confirm = (client, body = {}, requireAuth) =>
    request(appWith({ client, requireAuth })).post(`/api/event-requests/${EVENT_ID}/confirm`).send(body);

  it('SCRUM363_AC6_confirmation_returns_the_confirmed_event_and_uses_only_the_token_caller', async () => {
    const client = createFakeClient([ok(eventRow({ status: 'confirmed' }))]);
    const res = await confirm(client, { coordinatorId: COORDINATOR_B, noEquipmentConfirmed: true, status: 'confirmed' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: EVENT_ID, status: 'confirmed', statusDisplay: { label: 'Confirmed' } });
    expect(client.calls).toEqual([expect.objectContaining({ fn: 'confirm_event_request', args: {
      p_event_request_id: EVENT_ID, p_coordinator_id: COORDINATOR_A, p_no_equipment_confirmed: true, p_expected_updated_at: null,
    } })]);
  });

  it('SCRUM363_AC5_absent_acknowledgement_defaults_to_false', async () => {
    const client = createFakeClient([ok(eventRow({ status: 'confirmed' }))]);
    await confirm(client);
    expect(client.calls[0].args.p_no_equipment_confirmed).toBe(false);
  });

  it('SCRUM363_AC5_the_endpoint_passes_the_observed_revision_to_the_atomic_rpc', async () => {
    const client = createFakeClient([ok(eventRow({ status: 'confirmed' }))]);
    const expectedUpdatedAt = '2026-06-01T09:00:00.123456+00:00';
    expect((await confirm(client, { noEquipmentConfirmed: true, expectedUpdatedAt })).status).toBe(200);
    expect(client.calls[0].args.p_expected_updated_at).toBe(expectedUpdatedAt);
  });

  it.each([[ROLE.EVENT_COORDINATOR_LEAD], ...OTHER_ROLES.map((role) => [role])])(
    'SCRUM363_AC1_role_%s_is_forbidden_without_database_access', async (role) => {
      const client = createFakeClient([]);
      const res = await confirm(client, {}, signedInWithRole(role));
      expect(res.status).toBe(403);
      expect(client.calls).toHaveLength(0);
    },
  );

  it('SCRUM363_AC1_authentication_is_required_before_database_access', async () => {
    const client = createFakeClient([]);
    expect((await confirm(client, {}, signedOut)).status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });

  it.each([null, 'true', 1])('SCRUM363_AC5_invalid_acknowledgement_%j_is_400_before_rpc', async (noEquipmentConfirmed) => {
    const client = createFakeClient([]);
    expect((await confirm(client, { noEquipmentConfirmed })).status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM363_AC1_invalid_event_id_is_400_before_rpc', async () => {
    const client = createFakeClient([]);
    const res = await request(appWith({ client })).post('/api/event-requests/invalid/confirm').send({});
    expect(res.status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });

  it.each([['42501', 403], ['55000', 409], ['P0002', 404]])(
    'SCRUM363_AC1_database_%s_is_returned_as_%s', async (code, status) => {
      const client = createFakeClient([dbError(code, 'Its current status is approved.')]);
      const res = await confirm(client);
      expect(res.status).toBe(status);
      expect(res.body.error).toBe('Its current status is approved.');
    },
  );

  it('SCRUM363_AC3_returns_every_outstanding_item_in_the_existing_conflict_format', async () => {
    const conflicts = [
      { key: 'venue', met: false, detail: 'Flagged for review' },
      { key: 'equipment', met: false, detail: 'Pending review' },
    ];
    const client = createFakeClient([dbError('PT409', 'This event is not ready for confirmation.', {
      hint: 'EVENT_NOT_READY', details: JSON.stringify(conflicts),
    })]);
    const res = await confirm(client);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'This event is not ready for confirmation.', code: 'EVENT_NOT_READY', conflicts });
  });

  it('SCRUM363_AC6_unexpected_database_errors_are_safe_500_responses', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await confirm(createFakeClient([dbError('XX000', 'private database detail')]));
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Unexpected server error' });
    } finally {
      log.mockRestore();
    }
  });
});


// ---------------------------------------------------------------------------
// GET /:id/readiness
// ---------------------------------------------------------------------------
describe('SCRUM-489 AC3: GET /:id/readiness', () => {
  const readiness = (client, query = '', requireAuth) =>
    request(appWith({ client, requireAuth })).get(`/api/event-requests/${EVENT_ID}/readiness${query}`);

  it('SCRUM363_AC4_returns_every_database_condition_and_booking_period_without_a_second_checker', async () => {
    const checklist = {
      ...CHECKLIST,
      items: [
        {
          key: 'venue', met: false, detail: 'Flagged for review',
          bookingId: '33333333-3333-4333-8333-333333333333', venueName: 'Hall A',
          startsAt: '2026-11-01T01:00:00+00:00', endsAt: '2026-11-01T03:00:00+00:00',
        },
        { key: 'no_equipment_confirmation', met: false, detail: 'Confirm that this event needs no equipment', organiserRequirements: 'Projectors' },
        { key: 'date', met: true, detail: 'Starts in the future' },
      ],
    };
    const client = createFakeClient([ok(eventRow({ status: 'safety_approved' })), ok(checklist)]);

    const res = await readiness(client);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(checklist);
    expect(client.calls.map((call) => call.fn ?? call.table)).toEqual(['event_requests', 'event_readiness']);
    expect(client.calls[1].args).toEqual({ p_event_request_id: EVENT_ID, p_no_equipment_confirmed: false });
  });

  it.each([
    ['a coordinator', ROLE.EVENT_COORDINATOR, COORDINATOR_A],
    ['a Lead', ROLE.EVENT_COORDINATOR_LEAD, LEAD_ID],
  ])('SCRUM489_AC3_%s_reads_the_checklist', async (_label, role, id) => {
    // AC3-04, AC3-08: the event is read as a coordinator reads it (no draft),
    // then the checklist; not GET /:id's read.
    const client = createFakeClient([ok(eventRow()), ok(CHECKLIST)]);

    const res = await readiness(client, '', signedInWithRole(role, id));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(CHECKLIST);
    expect(client.calls.map((call) => call.fn ?? call.table)).toEqual(['event_requests', 'event_readiness']);
  });

  it.each([
    ['?noEquipmentConfirmed=true', true],
    ['?noEquipmentConfirmed=false', false],
    ['', false],
  ])('SCRUM489_AC3_%j_reads_with_no_equipment_confirmed_%s', async (query, confirmed) => {
    // AC3-06.
    const client = createFakeClient([ok(eventRow()), ok(CHECKLIST)]);

    await readiness(client, query);

    expect(client.calls[1].args).toEqual({ p_event_request_id: EVENT_ID, p_no_equipment_confirmed: confirmed });
  });

  it.each(['?noEquipmentConfirmed=yes', '?noEquipmentConfirmed=TRUE', '?noEquipmentConfirmed='])(
    'SCRUM489_AC3_%s_is_400_and_queries_nothing',
    async (query) => {
      const client = createFakeClient([]);

      const res = await readiness(client, query);

      expect(res.status).toBe(400);
      expect(res.body.details.map((d) => d.field)).toEqual(['noEquipmentConfirmed']);
      expect(client.calls).toHaveLength(0);
    },
  );

  it('SCRUM489_AC3_an_id_that_is_not_a_uuid_is_400_and_queries_nothing', async () => {
    const client = createFakeClient([]);

    const res = await request(appWith({ client })).get('/api/event-requests/not-a-uuid/readiness');

    expect(res.status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM489_AC3_a_draft_is_answered_as_not_found', async () => {
    const client = createFakeClient([ok(eventRow({ status: 'draft' }))]);

    const res = await readiness(client);

    expect(res.status).toBe(404);
    expect(client.calls).toHaveLength(1);
  });

  it.each(OTHER_ROLES.map((role) => [String(role), role]))(
    'SCRUM489_AC3_%s_is_refused_the_checklist_with_403_and_queries_nothing',
    async (_label, role) => {
      // AC3-07.
      const client = createFakeClient([]);

      const res = await readiness(client, '', signedInWithRole(role));

      expect(res.status).toBe(403);
      expect(client.calls).toHaveLength(0);
    },
  );

  it('SCRUM489_AC3_the_checklist_answers_401_without_a_token', async () => {
    const client = createFakeClient([]);

    expect((await readiness(client, '', signedOut)).status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });
});


// ---------------------------------------------------------------------------
// POST /:id/safety-review
// ---------------------------------------------------------------------------
describe('SCRUM-489: POST /:id/safety-review', () => {
  const submit = (client, body = {}, requireAuth) =>
    request(appWith({ client, requireAuth })).post(`/api/event-requests/${EVENT_ID}/safety-review`).send(body);

  it('SCRUM489_AC6_the_holder_submits_and_gets_the_event_in_safety_review', async () => {
    // AC6-04: 200 with the event and its statusDisplay, as the other actions.
    const client = createFakeClient([ok(eventRow({ status: 'safety_review' }))]);

    const res = await submit(client, { note: 'East doors.', noEquipmentConfirmed: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: EVENT_ID, status: 'safety_review' });
    expect(res.body.statusDisplay).toMatchObject({ label: 'Safety check' });
    expect(client.calls).toEqual([expect.objectContaining({
      fn: 'submit_event_for_safety_review',
      args: { p_event_request_id: EVENT_ID, p_coordinator_id: COORDINATOR_A, p_note: 'East doors.', p_no_equipment_confirmed: true },
    })]);
  });

  it('SCRUM489_AC1_the_caller_is_the_tokens_user_not_the_bodys', async () => {
    // AC1-08.
    const client = createFakeClient([ok(eventRow({ status: 'safety_review' }))]);

    await submit(client, { coordinatorId: COORDINATOR_B });

    expect(client.calls[0].args.p_coordinator_id).toBe(COORDINATOR_A);
  });

  it('SCRUM489_AC3_not_ready_arrives_as_a_409_with_its_code_and_every_outstanding_line', async () => {
    // AC3-02 over HTTP: the screen keys on the status and the code.
    const outstanding = [{ key: 'venue', met: false, detail: 'No venue booking' }];
    const client = createFakeClient([dbError('PT409', 'This event is not ready for the safety check.', {
      hint: 'EVENT_NOT_READY', details: JSON.stringify(outstanding),
    })]);

    const res = await submit(client);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'This event is not ready for the safety check.', code: 'EVENT_NOT_READY', conflicts: outstanding });
  });

  it.each([
    ['a note over 2,000 characters', { note: 'x'.repeat(2001) }],
    ['a noEquipmentConfirmed that is not a boolean', { noEquipmentConfirmed: 'true' }],
  ])('SCRUM489_AC5_%s_is_400_and_queries_nothing', async (_label, body) => {
    const client = createFakeClient([]);

    const res = await submit(client, body);

    expect(res.status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM489_AC1_an_id_that_is_not_a_uuid_is_400_and_queries_nothing', async () => {
    // AC1-09.
    const client = createFakeClient([]);

    const res = await request(appWith({ client })).post('/api/event-requests/not-a-uuid/safety-review').send({});

    expect(res.status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });

  it.each([[ROLE.EVENT_COORDINATOR_LEAD], ...OTHER_ROLES.map((role) => [role])])(
    'SCRUM489_AC1_%s_is_refused_the_submission_with_403_and_queries_nothing',
    async (role) => {
      // AC1-03: coordinatorOnly. A Lead too: AC1 says the assigned coordinator.
      const client = createFakeClient([]);

      const res = await submit(client, {}, signedInWithRole(role, LEAD_ID));

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'This action is restricted to Event Coordinators' });
      expect(client.calls).toHaveLength(0);
    },
  );

  it('SCRUM489_AC1_the_submission_answers_401_without_a_token', async () => {
    // AC1-07.
    const client = createFakeClient([]);

    expect((await submit(client, {}, signedOut)).status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });
});
