/**
 * SCRUM-402: the change-request routes over HTTP. The gates, the caller from
 * the token, malformed ids, the bodies the functions are sent, and how each of
 * 036's refusals arrives.
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
const CHANGE_ID = '44444444-4444-4444-8444-444444444444';
const COORDINATOR_ID = '55555555-5555-4555-8555-555555555555';

const coordinatorAuth = signedInFor(COORDINATOR_ID)(ROLE.EVENT_COORDINATOR);
const organiserAuth = signedInFor(ORGANISER_ID)(ROLE.EVENT_ORGANISER);

const app = (client, requireAuth = coordinatorAuth) =>
  express()
    .use(express.json())
    .use('/api/event-requests', createEventRequestRouter({ client, requireAuth }));

const changeRow = (overrides = {}) => ({
  id: CHANGE_ID,
  event_request_id: REQUEST_ID,
  request_group_id: CHANGE_ID,
  requested_by: ORGANISER_ID,
  change_field: 'purpose',
  requested_change: 'Alumni networking',
  status: 'outstanding',
  decision: null,
  decision_notes: null,
  processed_by: null,
  processed_at: null,
  created_at: '2026-10-20T03:00:00+00:00',
  updated_at: '2026-10-20T03:00:00+00:00',
  ...overrides,
});

const eventRow = (overrides = {}) => ({
  id: REQUEST_ID,
  organiser_id: ORGANISER_ID,
  event_name: 'Tech Talk',
  status: 'approved',
  created_at: '2026-10-01T03:00:00+00:00',
  updated_at: '2026-10-20T03:00:00+00:00',
  ...overrides,
});

const preview = (client, requireAuth, id = CHANGE_ID) =>
  request(app(client, requireAuth)).get(`/api/event-requests/change-requests/${id}/preview`);
const decide = (client, body, requireAuth, id = CHANGE_ID) =>
  request(app(client, requireAuth)).post(`/api/event-requests/change-requests/${id}/decision`).send(body);

const OTHER_ROLES = [
  ROLE.EVENT_ORGANISER, ROLE.EVENT_COORDINATOR_LEAD, ROLE.VENUE_STAFF,
  ROLE.TECHNICAL_SUPPORT_STAFF, ROLE.ATTENDEE, ROLE.SAFETY_OFFICER, null,
].map((role) => [String(role), role]);


describe('SCRUM-402: GET /change-requests/:id/preview', () => {
  it('SCRUM402_AC4_the_preview_is_asked_for_by_the_tokens_coordinator_and_returned_as_is', async () => {
    const result = { changeRequestId: CHANGE_ID, rows: [], invalid: [], revertsEvent: false, impact: null };
    const client = createEventRequestClient([ok(result)]);

    const res = await preview(client);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(client.calls).toEqual([expect.objectContaining({
      operation: 'rpc', fn: 'preview_change_request', args: { p_change_request_id: CHANGE_ID, p_user_id: COORDINATOR_ID },
    })]);
  });

  it.each(OTHER_ROLES)('SCRUM402_AC2_%s_is_refused_the_preview_with_403_and_queries_nothing', async (_label, role) => {
    const client = createEventRequestClient([]);

    expect((await preview(client, signedInFor(OTHER_ID)(role))).status).toBe(403);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM402_AC2_the_preview_answers_401_without_a_token_and_400_for_a_malformed_id', async () => {
    const client = createEventRequestClient([]);

    expect((await preview(client, signedOut)).status).toBe(401);
    const res = await preview(client, undefined, 'not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'changeRequestId', message: 'must be a valid id' }]);
    expect(client.calls).toHaveLength(0);
  });

  it.each([
    ['REVIEW_NOT_STARTED', 'Start the review of this event before processing its change requests'],
    ['EVENT_STATUS_NOT_ALLOWED', 'Change requests for an event that is cancelled cannot be processed'],
    ['CHANGE_REQUEST_ALREADY_PROCESSED', `change request ${CHANGE_ID} has already been processed`],
  ])('SCRUM402_AC2_the_previews_%s_is_a_409_with_its_code', async (hint, message) => {
    const client = createEventRequestClient([dbError('PT409', message, { hint })]);

    const res = await preview(client);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(hint);
  });
});


describe('SCRUM-402: POST /change-requests/:id/decision', () => {
  it('SCRUM402_AC4_the_previewed_impact_is_passed_to_the_function', async () => {
    const impact = { statusBefore: 'approved', statusAfter: 'approved', venueBookings: [] };
    const client = createEventRequestClient([ok(changeRow({ status: 'processed', decision: 'approved', processed_by: COORDINATOR_ID }))]);

    const res = await decide(client, { decision: 'approved', decisionNotes: '  As asked  ', expectedImpact: impact });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'processed', decision: 'approved', requestGroupId: CHANGE_ID });
    expect(client.calls[0].args).toEqual({
      p_change_request_id: CHANGE_ID,
      p_decision: 'approved',
      p_decision_notes: 'As asked',
      p_processed_by: COORDINATOR_ID,
      p_expected_impact: impact,
    });
  });

  it('SCRUM402_AC4_a_decision_without_an_impact_sends_the_four_arguments_it_always_did', async () => {
    const client = createEventRequestClient([ok(changeRow({ status: 'processed', decision: 'rejected' }))]);

    await decide(client, { decision: 'rejected', decisionNotes: 'Not this term' });

    expect(Object.keys(client.calls[0].args)).toEqual(['p_change_request_id', 'p_decision', 'p_decision_notes', 'p_processed_by']);
  });

  it.each([
    ['a_malformed_id', { decision: 'approved' }, 'not-a-uuid', 'changeRequestId'],
    ['an_impact_that_is_not_an_object', { decision: 'approved', expectedImpact: 'stale' }, CHANGE_ID, 'expectedImpact'],
    ['a_reason_over_2000_characters', { decision: 'rejected', decisionNotes: 'x'.repeat(2001) }, CHANGE_ID, 'decisionNotes'],
  ])('SCRUM402_AC3_%s_is_a_400_before_the_database', async (_label, body, id, field) => {
    const client = createEventRequestClient([]);

    const res = await decide(client, body, undefined, id);

    expect(res.status).toBe(400);
    expect(res.body.details.map((d) => d.field)).toContain(field);
    expect(client.calls).toHaveLength(0);
  });

  it.each(OTHER_ROLES)('SCRUM402_AC2_%s_is_refused_the_decision_with_403_and_queries_nothing', async (_label, role) => {
    const client = createEventRequestClient([]);

    expect((await decide(client, { decision: 'approved' }, signedInFor(OTHER_ID)(role))).status).toBe(403);
    expect(client.calls).toHaveLength(0);
  });

  it.each([
    ['AC2', 'REVIEW_NOT_STARTED'],
    ['AC2', 'EVENT_STATUS_NOT_ALLOWED'],
    ['AC10', 'CHANGE_REQUEST_ALREADY_PROCESSED'],
    ['AC4', 'SIGNIFICANT_CHANGE_IMPACT_CHANGED'],
    ['AC5', 'EVENT_HOLDS_ARRANGEMENTS'],
  ])('SCRUM402_%s_the_decisions_%s_is_a_409_with_its_code', async (_ac, hint) => {
    const client = createEventRequestClient([dbError('PT409', 'Refused for a reason', { hint })]);

    const res = await decide(client, { decision: 'approved' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(hint);
  });

  it.each([
    ['42501', 403],
    ['P0002', 404],
    ['22023', 400],
  ])('SCRUM402_AC2_the_functions_%s_is_a_%s', async (code, status) => {
    const client = createEventRequestClient([dbError(code, 'This change request cannot be applied: proposedEnd must be later than the proposed start')]);

    const res = await decide(client, { decision: 'approved' });

    expect(res.status).toBe(status);
    if (code === '22023') expect(res.body.error).toContain('proposedEnd');
  });
});


describe('SCRUM-402: the organiser submits a group', () => {
  const submit = (client, body) =>
    request(app(client, organiserAuth)).post(`/api/event-requests/${REQUEST_ID}/change-requests`).send(body);

  it('SCRUM402_AC1_several_fields_go_to_the_group_function_in_one_call', async () => {
    const second = changeRow({ id: OTHER_ID, change_field: 'proposed_start', requested_change: '2026-12-02T09:00:00Z' });
    const client = createEventRequestClient([ok(eventRow({ status: 'submitted' })), ok([changeRow(), second])]);

    const res = await submit(client, {
      changes: [
        { field: 'purpose', details: '  Alumni networking  ' },
        { field: 'proposed_start', details: '2026-12-02T09:00:00Z' },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.map((r) => [r.changeField, r.requestGroupId])).toEqual([['purpose', CHANGE_ID], ['proposed_start', CHANGE_ID]]);
    expect(client.calls[1]).toMatchObject({
      fn: 'create_change_request_group',
      args: {
        p_event_request_id: REQUEST_ID,
        p_organiser_id: ORGANISER_ID,
        p_changes: [
          { changeField: 'purpose', requestedChange: 'Alumni networking' },
          { changeField: 'proposed_start', requestedChange: '2026-12-02T09:00:00Z' },
        ],
      },
    });
  });

  it('SCRUM402_AC1_the_organisers_note_goes_with_the_group_and_comes_back_on_each_row', async () => {
    const noted = (o) => changeRow({ organiser_note: 'Our sponsor asked', ...o });
    const client = createEventRequestClient([ok(eventRow({ status: 'submitted' })), ok([noted(), noted({ id: OTHER_ID, change_field: 'description' })])]);

    const res = await submit(client, {
      changes: [{ field: 'purpose', details: 'Alumni networking' }, { field: 'description', details: 'Talks' }],
      note: '  Our sponsor asked  ',
    });

    expect(client.calls[1].args.p_note).toBe('Our sponsor asked');
    expect(res.body.map((r) => r.organiserNote)).toEqual(['Our sponsor asked', 'Our sponsor asked']);
  });

  it.each([
    ['no_note', {}],
    ['a_blank_note', { note: '   ' }],
  ])('SCRUM402_AC1_a_group_with_%s_sends_no_p_note', async (_label, extra) => {
    const client = createEventRequestClient([ok(eventRow({ status: 'submitted' })), ok([changeRow()])]);

    await submit(client, { changes: [{ field: 'purpose', details: 'New' }], ...extra });

    expect(client.calls[1].args).not.toHaveProperty('p_note');
  });

  it.each([
    ['no_changes', [], 'changes'],
    ['a_field_twice', [{ field: 'purpose', details: 'A' }, { field: 'purpose', details: 'B' }], 'changes[1].changeField'],
    ['a_cancellation_with_another_field', [{ field: 'cancellation', details: 'Called off' }, { field: 'purpose', details: 'A' }], 'changes'],
    ['ten_changes', Array.from({ length: 10 }, (_, i) => ({ field: 'other', details: `Note ${i}` })), 'changes'],
    ['an_unusable_date', [{ field: 'proposed_end', details: 'next Tuesday' }], 'changes[0].requestedChange'],
    ['changes_that_are_not_a_list', 'purpose', 'changes'],
  ])('SCRUM402_AC1_a_group_with_%s_is_a_400_before_the_function', async (_label, changes, field) => {
    const client = createEventRequestClient([ok(eventRow({ status: 'submitted' }))]);

    const res = await submit(client, { changes });

    expect(res.status).toBe(400);
    expect(res.body.details.map((d) => d.field)).toContain(field);
    expect(client.calls.map((c) => c.operation)).toEqual(['select']);
  });
});


describe('SCRUM-402: the organiser submits with nothing returned', () => {
  it('SCRUM402_AC1_a_submission_the_function_answers_with_no_rows_is_still_a_201', async () => {
    // A function returning setof answers [] rather than null; the service reads either.
    const client = createEventRequestClient([ok(eventRow({ status: 'submitted' })), ok(null)]);

    const res = await request(app(client, organiserAuth))
      .post(`/api/event-requests/${REQUEST_ID}/change-requests`)
      .send({ changes: [{ field: 'purpose', details: 'New' }] });

    expect(res.status).toBe(201);
    expect(res.body).toEqual([]);
  });
});


describe('SCRUM-402: the coordinator reads the change requests', () => {
  it('SCRUM402_AC1_oldest_first_with_each_rows_group_and_current_value_in_one_query', async () => {
    const client = createEventRequestClient([ok([
      changeRow({ event_requests: { purpose: 'Industry networking', venue_requirements: 'A large hall' } }),
      changeRow({ id: OTHER_ID, change_field: 'venue', requested_change: 'A tiered hall',
        event_requests: { purpose: 'Industry networking', venue_requirements: 'A large hall' } }),
      changeRow({ id: 'c0000000-0000-4000-8000-000000000003', request_group_id: 'c0000000-0000-4000-8000-000000000003',
        change_field: 'other', requested_change: 'A photographer', event_requests: {} }),
    ])]);

    const res = await request(app(client)).get(`/api/event-requests/${REQUEST_ID}/change-requests/review`);

    expect(res.status).toBe(200);
    expect(res.body.map((r) => [r.changeField, r.requestGroupId, r.currentValue])).toEqual([
      ['purpose', CHANGE_ID, 'Industry networking'],
      ['venue', CHANGE_ID, 'A large hall'],
      ['other', 'c0000000-0000-4000-8000-000000000003', null],
    ]);
    expect(res.body.map((r) => r.organiserNote)).toEqual([null, null, null]);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      table: 'event_change_requests',
      filters: [['event_request_id', REQUEST_ID]],
      order: [['created_at', { ascending: true }], ['change_field', { ascending: true }]],
    });
    expect(client.calls[0].select).toContain('event_requests ( event_name, description, purpose, proposed_start');
  });

  it('SCRUM402_AC1_a_failed_read_is_a_500_not_an_empty_list', async () => {
    const client = createEventRequestClient([dbError('XX000', 'boom')]);

    expect((await request(app(client)).get(`/api/event-requests/${REQUEST_ID}/change-requests/review`)).status).toBe(500);
  });

  it('SCRUM402_AC1_the_coordinators_list_carries_the_organisers_note', async () => {
    const client = createEventRequestClient([ok([changeRow({ organiser_note: 'Our sponsor asked', event_requests: { purpose: 'Industry networking' } })])]);

    const res = await request(app(client)).get(`/api/event-requests/${REQUEST_ID}/change-requests/review`);

    expect(res.body[0]).toMatchObject({ organiserNote: 'Our sponsor asked', details: 'Alumni networking' });
  });

  it('SCRUM402_AC1_a_malformed_event_id_is_a_400_before_the_database', async () => {
    const client = createEventRequestClient([]);

    const res = await request(app(client)).get('/api/event-requests/not-a-uuid/change-requests/review');

    expect(res.status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM402_AC10_the_organisers_list_carries_each_rows_group_and_note', async () => {
    const client = createEventRequestClient([
      ok(eventRow()),
      ok({ id: REQUEST_ID, organiser_id: ORGANISER_ID }),
      ok([changeRow({
        status: 'processed', decision: 'approved', decision_notes: 'Done', processed_by: COORDINATOR_ID, organiser_note: 'Sponsor asked',
      })]),
    ]);

    const res = await request(app(client, organiserAuth)).get(`/api/event-requests/${REQUEST_ID}/change-requests`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({
      requestGroupId: CHANGE_ID, organiserNote: 'Sponsor asked', decision: 'approved', decisionNotes: 'Done', processedBy: COORDINATOR_ID,
    })]);
  });
});


describe('SCRUM-402: GET /mine counts the open change requests', () => {
  it('SCRUM402_AC1_each_event_carries_how_many_submissions_wait_counted_by_group', async () => {
    const client = createEventRequestClient([
      ok([
        eventRow({ assigned_coordinator_id: COORDINATOR_ID, event_change_requests: [
          { request_group_id: 'g1', status: 'outstanding' },
          { request_group_id: 'g1', status: 'outstanding' },
          { request_group_id: 'g2', status: 'processed' },
          { request_group_id: 'g3', status: 'in_progress' },
        ] }),
        eventRow({ id: OTHER_ID, assigned_coordinator_id: COORDINATOR_ID, event_change_requests: [] }),
      ]),
      ok([{ id: ORGANISER_ID, full_name: 'Olive Organiser' }]),
    ]);

    const res = await request(app(client)).get('/api/event-requests/mine');

    expect(res.status).toBe(200);
    expect(res.body.map((e) => e.openChangeRequestCount)).toEqual([2, 0]);
    expect(res.body[0]).not.toHaveProperty('eventChangeRequests');
    expect(client.calls[0].select).toContain('event_change_requests(request_group_id, status)');
  });
});
