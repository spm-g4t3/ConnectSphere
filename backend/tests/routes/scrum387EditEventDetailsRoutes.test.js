/**
 * SCRUM-387: PATCH /api/event-requests/:id/details and GET /:id/change-history
 * over HTTP. The gate, the caller from the token, validation, and how each of
 * edit_event_request_details's refusals arrives.
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createEventRequestRouter } from '../../src/routes/eventRequests.js';
import { ROLE } from '../../src/domain/userRole.js';
import { ok, dbError, createEventRequestClient } from '../fixtures/supabaseStubs.js';
import { signedOut, signedInFor } from '../fixtures/auth.js';

const ORGANISER_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const COORDINATOR_ID = '55555555-5555-4555-8555-555555555555';

const storedRow = (overrides = {}) => ({
  id: REQUEST_ID,
  organiser_id: ORGANISER_ID,
  assigned_coordinator_id: COORDINATOR_ID,
  event_name: 'IS212 Industry Night',
  purpose: 'Networking',
  status: 'under_review',
  created_at: '2026-10-01T03:00:00+00:00',
  updated_at: '2026-10-20T03:00:00+00:00',
  submitted_at: '2026-10-02T03:00:00+00:00',
  ...overrides,
});

const historyRows = [
  {
    id: 'b0000000-0000-4000-8000-000000000002',
    field_name: 'purpose',
    old_value: 'Networking',
    new_value: 'Alumni networking',
    reason: 'Organiser asked by email',
    source: 'direct_edit',
    changed_by: COORDINATOR_ID,
    changed_at: '2026-10-21T03:00:00+00:00',
  },
  {
    id: 'b0000000-0000-4000-8000-000000000001',
    field_name: 'proposedStart',
    old_value: '2026-12-01T09:00:00+00:00',
    new_value: '2026-12-02T09:00:00+00:00',
    reason: 'The venue moved the date',
    source: 'significant_change',
    changed_by: COORDINATOR_ID,
    changed_at: '2026-10-20T03:00:00+00:00',
  },
];

const BODY = {
  changes: { purpose: '  Alumni networking  ' },
  expected: { purpose: 'Networking' },
  reason: '  Organiser asked by email  ',
};

const signedInAs = signedInFor(COORDINATOR_ID);

const app = (client, requireAuth = signedInAs(ROLE.EVENT_COORDINATOR)) =>
  express()
    .use(express.json())
    .use('/api/event-requests', createEventRequestRouter({ client, requireAuth }));

const editCall = (client, requireAuth, body = BODY) =>
  request(app(client, requireAuth)).patch(`/api/event-requests/${REQUEST_ID}/details`).send(body);

const historyCall = (client, requireAuth) =>
  request(app(client, requireAuth)).get(`/api/event-requests/${REQUEST_ID}/change-history`);


describe('SCRUM-387: PATCH /api/event-requests/:id/details', () => {
  it('SCRUM387_AC2_the_coordinator_gets_the_event_back_with_the_fields_it_changed', async () => {
    const client = createEventRequestClient([
      ok({ event: storedRow({ purpose: 'Alumni networking' }), changedFields: ['purpose'] }),
    ]);

    const res = await editCall(client);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: REQUEST_ID,
      purpose: 'Alumni networking',
      status: 'under_review',
      statusDisplay: { label: 'Under review' },
      changedFields: ['purpose'],
    });
  });

  it('SCRUM387_AC1_the_caller_is_the_tokens_user_and_the_body_is_sent_normalised', async () => {
    const client = createEventRequestClient([ok({ event: storedRow(), changedFields: ['purpose'] })]);

    await editCall(client, undefined, { ...BODY, coordinatorId: OTHER_ID });

    expect(client.calls).toEqual([expect.objectContaining({
      operation: 'rpc',
      fn: 'edit_event_request_details',
      args: {
        p_event_request_id: REQUEST_ID,
        p_user_id: COORDINATOR_ID,
        p_changes: { purpose: 'Alumni networking' },
        p_expected: { purpose: 'Networking' },
        p_reason: 'Organiser asked by email',
      },
    })]);
  });

  it.each([
    ROLE.EVENT_ORGANISER, ROLE.EVENT_COORDINATOR_LEAD, ROLE.VENUE_STAFF,
    ROLE.TECHNICAL_SUPPORT_STAFF, ROLE.ATTENDEE, ROLE.SAFETY_OFFICER, null,
  ].map((role) => [String(role), role]))(
    'SCRUM387_AC1_%s_is_refused_with_403_by_the_gate_and_queries_nothing',
    async (_label, role) => {
      const client = createEventRequestClient([]);

      const res = await editCall(client, signedInAs(role, OTHER_ID));

      expect(res.status).toBe(403);
      expect(client.calls).toHaveLength(0);
    },
  );

  it('SCRUM387_AC1_the_edit_answers_401_without_a_token', async () => {
    const client = createEventRequestClient([]);

    expect((await editCall(client, signedOut)).status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });

  it.each([
    ['42501', 403],
    ['P0002', 404],
  ])('SCRUM387_AC1_the_functions_%s_is_a_%s', async (code, status) => {
    const client = createEventRequestClient([dbError(code, "Only the assigned event coordinator can edit this event's information")]);

    expect((await editCall(client)).status).toBe(status);
  });

  it('SCRUM387_AC6_a_malformed_id_is_refused_with_400_before_the_database', async () => {
    const client = createEventRequestClient([]);

    const res = await request(app(client)).patch('/api/event-requests/not-a-uuid/details').send(BODY);

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'id', message: 'must be a valid id' }]);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM387_AC6_every_fault_is_listed_in_one_400_and_nothing_is_queried', async () => {
    const client = createEventRequestClient([]);

    const res = await editCall(client, undefined, {
      changes: { eventName: '', venue: 'Hall B' },
      expected: {},
      reason: '',
    });

    expect(res.status).toBe(400);
    expect(res.body.details.map((d) => d.field)).toEqual(expect.arrayContaining([
      'reason', 'venue', 'eventName', 'expected.eventName',
    ]));
    expect(client.calls).toHaveLength(0);
  });

  it.each([
    ['22023', 'No changes: every value sent is the one already stored'],
    ['22023', 'proposedEnd must be later than the proposed start'],
  ])('SCRUM387_AC6_the_functions_%s_is_a_400_with_its_message', async (code, message) => {
    const client = createEventRequestClient([dbError(code, message)]);

    const res = await editCall(client);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(message);
  });

  it.each([
    ['AC2', 'EVENT_HOLDS_ARRANGEMENTS', 'This request still holds 1 venue bookings from before it was rejected. Release or withdraw them before changing its date, time, attendance or requirements.'],
    ['AC3', 'SIGNIFICANT_CHANGE_REQUIRED', 'The date, time, attendance, requirements and equipment of an event in planning are changed through the significant change process, not edited here.'],
    ['AC4', 'EVENT_CONFIRMED', 'A confirmed event cannot be edited here. Change it through the significant change process, which returns it to Approved.'],
    ['AC5', 'EVENT_STATUS_NOT_ALLOWED', 'An event that is cancelled cannot be edited'],
    ['AC9', 'EVENT_CHANGED_SINCE_OPENED', 'Changed since you opened the form: purpose. Reopen the event to see the current values.'],
  ])('SCRUM387_%s_%s_is_a_409_with_its_code_and_message', async (_ac, hint, message) => {
    const client = createEventRequestClient([dbError('PT409', message, { hint })]);

    const res = await editCall(client);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(hint);
    expect(res.body.error).toContain(message);
  });
});


describe('SCRUM-387: GET /api/event-requests/:id/change-history', () => {
  it('SCRUM387_AC7_the_organiser_reads_the_history_newest_first_with_names', async () => {
    const client = createEventRequestClient([
      ok(storedRow()),
      ok(historyRows),
      ok([{ id: COORDINATOR_ID, full_name: 'Priya Nair' }]),
    ]);

    const res = await historyCall(client, signedInAs(ROLE.EVENT_ORGANISER, ORGANISER_ID));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: historyRows[0].id,
        field: 'purpose',
        oldValue: 'Networking',
        newValue: 'Alumni networking',
        reason: 'Organiser asked by email',
        source: 'direct_edit',
        changedByName: 'Priya Nair',
        changedAt: '2026-10-21T03:00:00+00:00',
      },
      expect.objectContaining({ field: 'proposedStart', source: 'significant_change' }),
    ]);
    expect(client.calls[1]).toMatchObject({
      table: 'event_change_history',
      filters: [['event_request_id', REQUEST_ID]],
      order: [['changed_at', { ascending: false }], ['field_name', { ascending: true }], ['id', { ascending: true }]],
    });
  });

  it.each([
    ['the_assigned_coordinator', ROLE.EVENT_COORDINATOR, COORDINATOR_ID],
    ['the_Lead', ROLE.EVENT_COORDINATOR_LEAD, OTHER_ID],
  ])('SCRUM387_AC7_%s_reads_the_history', async (_label, role, userId) => {
    const client = createEventRequestClient([ok(storedRow()), ok(historyRows), ok([])]);

    const res = await historyCall(client, signedInAs(role, userId));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('SCRUM387_AC7_a_field_filled_in_or_cleared_reads_null_on_the_empty_side', async () => {
    const filledIn = { ...historyRows[0], field_name: 'description', old_value: null, new_value: 'Talks' };
    const cleared = { ...historyRows[1], field_name: 'description', old_value: 'Talks', new_value: null };
    const client = createEventRequestClient([ok(storedRow()), ok([filledIn, cleared]), ok([])]);

    const res = await historyCall(client);

    expect(res.body.map(({ oldValue, newValue }) => [oldValue, newValue])).toEqual([[null, 'Talks'], ['Talks', null]]);
  });

  it('SCRUM387_AC7_an_event_never_edited_has_an_empty_history', async () => {
    const client = createEventRequestClient([ok(storedRow()), ok([])]);

    const res = await historyCall(client);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it.each([
    ['another_organiser', ROLE.EVENT_ORGANISER],
    ['a_coordinator_it_is_not_assigned_to', ROLE.EVENT_COORDINATOR],
    ['a_safety_officer', ROLE.SAFETY_OFFICER],
    ['venue_staff', ROLE.VENUE_STAFF],
  ])('SCRUM387_AC7_%s_gets_a_404', async (_label, role) => {
    const client = createEventRequestClient([ok(storedRow())]);

    const res = await historyCall(client, signedInAs(role, OTHER_ID));

    expect(res.status).toBe(404);
    expect(client.calls).toHaveLength(1);
  });

  it('SCRUM387_AC7_a_malformed_id_is_refused_with_400_before_the_database', async () => {
    const client = createEventRequestClient([]);

    const res = await request(app(client, signedInAs(ROLE.EVENT_ORGANISER, ORGANISER_ID)))
      .get('/api/event-requests/not-a-uuid/change-history');

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'id', message: 'must be a valid id' }]);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM387_AC7_a_failed_read_is_not_reported_as_an_empty_history', async () => {
    const client = createEventRequestClient([ok(storedRow()), dbError('XX000', 'boom')]);

    expect((await historyCall(client)).status).toBe(500);
  });
});
