/**
 * Tests for the equipment review routes.
 *
 * SCRUM-290, subtasks SCRUM-292, 293 and 294. Named SCRUM290_AC<n>_<what_it_checks>.
 * These are about transport and authorisation: the right routes exist, only
 * Technical Support Staff reach them, a refused attempt reaches no database
 * function so it changes nothing, and the caller is the signed-in user and never
 * the body.
 *
 *   AC1  -- only Technical Support Staff reach any route
 *   AC2  -- starting answers 200, 409 when the status does not allow it
 *   AC3  -- taking over; only the reviewer's outcomes (403 from the database)
 *   AC4  -- the read answers 200 with the review's data, or 404
 *   AC7  -- marking needs a note (400); completing lists lines without one
 *
 * The client is injected into the router, so the real Express routing and the
 * real service run and only the database is faked.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// The service reuses SCRUM-23's result mapper, whose file imports the real client.
vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: {}, supabaseAdmin: {} }));

const { createEquipmentReviewRouter } = await import('../../src/routes/equipmentReview.js');
const { ROLE } = await import('../../src/domain/userRole.js');

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const LINE_ID = '22222222-2222-4222-8222-222222222222';
const TYPE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const REVIEWER_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const SOMEONE_ELSE = '77777777-7777-4777-8777-777777777777';
const VENUE_ID = '88888888-8888-4888-8888-888888888888';

const BASE = `/api/event-requests/${EVENT_ID}/equipment-review`;

const reviewRow = (status = 'under_review') => ({
  event: {
    id: EVENT_ID,
    name: 'Annual Dinner',
    proposed_start: '2026-12-01T10:00:00+00:00',
    proposed_end: '2026-12-01T12:00:00+00:00',
    assigned_coordinator_id: SOMEONE_ELSE,
  },
  request: {
    id: '55555555-5555-4555-8555-555555555555',
    status,
    reviewer_id: status === 'under_review' ? REVIEWER_ID : null,
    review_started_at: status === 'under_review' ? '2026-10-09T08:00:00+00:00' : null,
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
        outcome: null,
        outcome_note: null,
        outcome_by: null,
        outcome_at: null,
        availability: null,
      },
    ],
  },
});

const ok = (data) => ({ data, error: null });
const dbError = (code, message) => ({ data: null, error: { code, message } });


/** A chainable query whose awaited result is `result`, as supabase-js builds them. */
function query(result) {
  const chain = {};
  for (const method of ['select', 'in', 'eq', 'order', 'limit']) chain[method] = vi.fn(() => chain);
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

const NAMES = ok([
  { id: SOMEONE_ELSE, full_name: 'Casey Coordinator' },
  { id: REVIEWER_ID, full_name: 'Riley Reviewer' },
]);
const BOOKING = ok([{ venue_id: VENUE_ID, starts_at: '2026-12-01T09:00:00+00:00' }]);
const VENUES = ok([{ id: VENUE_ID, name: 'Hall A' }]);

/** A client whose rpc answers by function name and whose from answers the name lookups. */
function fakeClient(rpc = {}) {
  const rpcCalls = [];
  const answers = { profiles: NAMES, bookings: BOOKING, venues: VENUES };
  return {
    rpcCalls,
    rpc: vi.fn(async (name, args) => {
      rpcCalls.push({ name, args });
      return rpc[name] ?? ok(reviewRow());
    }),
    from: vi.fn((table) => query(answers[table] ?? ok([]))),
  };
}

const signedInAs = (role, id = REVIEWER_ID) => (req, _res, next) => {
  req.user = { id, email: 'someone@example.com', role };
  next();
};
const signedOut = (_req, res) => res.status(401).json({ error: 'Authentication required' });

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
  ['reads', (app) => request(app).get(BASE)],
  ['starts', (app) => request(app).post(`${BASE}/start`)],
  ['takes over', (app) => request(app).post(`${BASE}/take-over`)],
  ['marks a line', (app) => request(app).put(`${BASE}/lines/${LINE_ID}/outcome`).send({ note: 'None left' })],
  ['clears a mark', (app) => request(app).delete(`${BASE}/lines/${LINE_ID}/outcome`)],
  ['completes', (app) => request(app).post(`${BASE}/complete`)],
];


describe('AC1: only Technical Support Staff reach any route', () => {
  it.each(OTHER_ROLES.flatMap((role) => ROUTES.map(([what, call]) => [role, what, call])))(
    'SCRUM290_AC1_refuses_%s_who_%s_with_403_and_reaches_nothing',
    async (role, _what, call) => {
      const client = fakeClient();

      const res = await call(appWith(client, signedInAs(role)));

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Technical Support Staff/);
      expect(client.rpc).not.toHaveBeenCalled();
      expect(client.from).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES)('SCRUM290_AC1_refuses_a_signed_out_caller_who_%s_with_401', async (_what, call) => {
    const client = fakeClient();

    const res = await call(appWith(client, signedOut));

    expect(res.status).toBe(401);
    expect(client.rpc).not.toHaveBeenCalled();
  });
});


describe('the routes for Technical Support Staff', () => {
  it('SCRUM290_AC4_get_answers_200_with_the_review_data_and_calls_only_the_read', async () => {
    const client = fakeClient();

    const res = await request(appWith(client)).get(BASE);

    expect(res.status).toBe(200);
    expect(res.body.event.name).toBe('Annual Dinner');
    expect(res.body.request).toMatchObject({ status: 'under_review', reviewerId: REVIEWER_ID });
    expect(res.body.request.lines[0]).toMatchObject({ reserved: 2, shortBy: 3 });
    expect(res.body.request.reviewerName).toBe('Riley Reviewer');
    expect(res.body.event).toMatchObject({
      assignedCoordinatorName: 'Casey Coordinator',
      venue: { id: VENUE_ID, name: 'Hall A' },
    });
    expect(client.rpcCalls.map((c) => c.name)).toEqual(['equipment_review_for_event']);
  });

  it('SCRUM290_AC2_viewing_does_not_call_any_write_function', async () => {
    const client = fakeClient();

    await request(appWith(client)).get(BASE);

    expect(client.rpcCalls.map((c) => c.name).filter((n) => /^(start|take_over|mark|clear|complete)/.test(n)))
      .toEqual([]);
  });

  it('SCRUM290_AC4_get_answers_404_for_an_event_that_does_not_exist', async () => {
    const client = fakeClient({ equipment_review_for_event: dbError('P0002', 'Event request not found') });

    const res = await request(appWith(client)).get(BASE);

    expect(res.status).toBe(404);
  });

  it('SCRUM290_AC2_start_answers_200_and_records_the_signed_in_user', async () => {
    const client = fakeClient();

    const res = await request(appWith(client)).post(`${BASE}/start`);

    expect(res.status).toBe(200);
    expect(client.rpcCalls).toEqual([
      { name: 'start_equipment_review', args: { p_event_request_id: EVENT_ID, p_user_id: REVIEWER_ID } },
    ]);
  });

  it('SCRUM290_AC1_the_acting_user_is_the_token_and_never_the_body', async () => {
    const client = fakeClient();

    await request(appWith(client))
      .post(`${BASE}/start`)
      .send({ userId: SOMEONE_ELSE, p_user_id: SOMEONE_ELSE, reviewerId: SOMEONE_ELSE });

    expect(client.rpcCalls[0].args.p_user_id).toBe(REVIEWER_ID);
  });

  it('SCRUM290_AC2_start_when_the_status_does_not_allow_it_answers_409_with_a_code', async () => {
    const message = 'This equipment request is already Under review. Take over the review instead.';
    const client = fakeClient({ start_equipment_review: dbError('55000', message) });

    const res = await request(appWith(client)).post(`${BASE}/start`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: message, code: 'EQUIPMENT_REVIEW_NOT_ALLOWED', conflicts: [] });
  });

  it('SCRUM290_AC3_take_over_answers_200_and_names_the_new_reviewer', async () => {
    const client = fakeClient();

    const res = await request(appWith(client, signedInAs(ROLE.TECHNICAL_SUPPORT_STAFF, SOMEONE_ELSE)))
      .post(`${BASE}/take-over`);

    expect(res.status).toBe(200);
    expect(client.rpcCalls).toEqual([
      { name: 'take_over_equipment_review', args: { p_event_request_id: EVENT_ID, p_user_id: SOMEONE_ELSE } },
    ]);
  });

  it('SCRUM290_AC3_take_over_when_not_under_review_answers_409', async () => {
    const client = fakeClient({
      take_over_equipment_review: dbError('55000', 'A review can only be taken over while the request is Under review.'),
    });

    const res = await request(appWith(client)).post(`${BASE}/take-over`);

    expect(res.status).toBe(409);
  });

  it('SCRUM290_AC3_a_staff_member_who_is_not_the_reviewer_cannot_mark_a_line_403', async () => {
    const client = fakeClient({
      mark_equipment_line_unavailable: dbError('42501', 'Only the current reviewer can do this'),
    });

    const res = await request(appWith(client, signedInAs(ROLE.TECHNICAL_SUPPORT_STAFF, SOMEONE_ELSE)))
      .put(`${BASE}/lines/${LINE_ID}/outcome`)
      .send({ note: 'None left' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Only the current reviewer can do this');
  });

  it('SCRUM290_AC7_mark_sends_the_trimmed_note_for_the_line', async () => {
    const client = fakeClient();

    const res = await request(appWith(client))
      .put(`${BASE}/lines/${LINE_ID}/outcome`)
      .send({ note: '  Only two in stock ' });

    expect(res.status).toBe(200);
    expect(client.rpcCalls).toEqual([
      {
        name: 'mark_equipment_line_unavailable',
        args: { p_event_request_id: EVENT_ID, p_user_id: REVIEWER_ID, p_line_id: LINE_ID, p_note: 'Only two in stock' },
      },
    ]);
  });

  it.each([
    ['no body', undefined],
    ['an empty note', { note: '' }],
    ['a blank note', { note: '   ' }],
    ['a note that is not text', { note: 5 }],
  ])('SCRUM290_AC7_mark_with_%s_answers_400_and_reaches_nothing', async (_label, body) => {
    const client = fakeClient();

    const res = await request(appWith(client)).put(`${BASE}/lines/${LINE_ID}/outcome`).send(body);

    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toMatch(/^(note|outcome)$/);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM290_AC7_clear_answers_200_for_that_line', async () => {
    const client = fakeClient();

    const res = await request(appWith(client)).delete(`${BASE}/lines/${LINE_ID}/outcome`);

    expect(res.status).toBe(200);
    expect(client.rpcCalls[0]).toEqual({
      name: 'clear_equipment_line_outcome',
      args: { p_event_request_id: EVENT_ID, p_user_id: REVIEWER_ID, p_line_id: LINE_ID },
    });
  });

  it('SCRUM290_AC7_complete_answers_200_with_the_new_status', async () => {
    const client = fakeClient({ complete_equipment_review: ok(reviewRow('cannot_be_fully_arranged')) });

    const res = await request(appWith(client)).post(`${BASE}/complete`);

    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({
      status: 'cannot_be_fully_arranged',
      statusLabel: 'Cannot be fully arranged',
      reviewerId: null,
    });
  });

  it('SCRUM290_AC7_complete_with_lines_missing_notes_answers_400_naming_each', async () => {
    const client = fakeClient({
      complete_equipment_review: dbError(
        '22023',
        'Add a note to each line that cannot be provided. Missing a note: Microphone',
      ),
    });

    const res = await request(appWith(client)).post(`${BASE}/complete`);

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'lines', message: 'Microphone needs a note' }]);
  });

  it.each([
    ['the event id', `/api/event-requests/not-a-uuid/equipment-review/start`, 'post'],
    ['the line id', `${BASE}/lines/not-a-uuid/outcome`, 'delete'],
  ])('SCRUM290_AC1_a_bad_%s_answers_400_and_reaches_nothing', async (_what, url, method) => {
    const client = fakeClient();

    const res = await request(appWith(client))[method](url);

    expect(res.status).toBe(400);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM290_AC1_an_unexpected_database_error_answers_500_without_the_drivers_words', async () => {
    const client = fakeClient({ start_equipment_review: dbError('XX000', 'secret internal detail') });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(appWith(client)).post(`${BASE}/start`);

    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret internal detail');
  });
});
