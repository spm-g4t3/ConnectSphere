/**
 * SCRUM-379: POST /:id/complete over HTTP and the completeEventRequest service.
 * The database tests (tests/db/scrum379CompleteEventDatabase.test.js) cover who
 * may complete what and when; these cover the API contract around it.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createEventRequestRouter } from '../../src/routes/eventRequests.js';
import { completeEventRequest } from '../../src/services/eventRequestService.js';
import { ForbiddenError, ValidationError, ConflictError } from '../../src/errors.js';
import { ROLE } from '../../src/domain/userRole.js';
import { STATUS } from '../../src/domain/eventRequestStatus.js';
import { ok, dbError, createEventRequestClient } from '../fixtures/supabaseStubs.js';
import { signedInFor, signedOut } from '../fixtures/auth.js';

const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const ORGANISER_ID = '11111111-1111-4111-8111-111111111111';
const COORDINATOR_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_ID = '66666666-6666-4666-8666-666666666666';

const signedInAs = signedInFor(COORDINATOR_ID);

const completedRow = (overrides = {}) => ({
  id: EVENT_ID,
  organiser_id: ORGANISER_ID,
  event_name: 'IS212 Industry Night',
  status: STATUS.COMPLETED,
  assigned_coordinator_id: COORDINATOR_ID,
  closing_notes: null,
  created_at: '2026-10-20T03:00:00+00:00',
  updated_at: '2026-10-21T03:00:00+00:00',
  submitted_at: '2026-10-20T04:00:00+00:00',
  ...overrides,
});

const appWith = (client, requireAuth = signedInAs(ROLE.EVENT_COORDINATOR)) =>
  express()
    .use(express.json())
    .use('/api/event-requests', createEventRequestRouter({ client, requireAuth }));

const complete = (client, { body = {}, requireAuth } = {}) =>
  request(appWith(client, requireAuth)).post(`/api/event-requests/${EVENT_ID}/complete`).send(body);

describe('SCRUM-379: POST /:id/complete', () => {
  it('SCRUM379_AC1_a_coordinator_completes_and_the_caller_comes_from_the_token', async () => {
    const client = createEventRequestClient([ok(completedRow({ closing_notes: 'All went well.' }))]);

    const res = await complete(client, { body: { closingNotes: 'All went well.', coordinatorId: OTHER_ID } });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: EVENT_ID, status: STATUS.COMPLETED, closingNotes: 'All went well.' });
    expect(res.body.statusDisplay).toBeDefined();
    expect(client.calls).toEqual([expect.objectContaining({
      fn: 'complete_event_request',
      args: { p_event_request_id: EVENT_ID, p_coordinator_id: COORDINATOR_ID, p_closing_notes: 'All went well.' },
    })]);
  });

  it('SCRUM379_AC2_closing_notes_are_optional', async () => {
    const client = createEventRequestClient([ok(completedRow())]);

    const res = await complete(client);

    expect(res.status).toBe(200);
    expect(res.body.closingNotes).toBeNull();
    expect(client.calls[0].args.p_closing_notes).toBeNull();
  });

  it.each([[''], ['   '], ['\n\t']])('SCRUM379_AC2_blank_notes_%j_are_sent_as_null', async (notes) => {
    const client = createEventRequestClient([ok(completedRow())]);
    await complete(client, { body: { closingNotes: notes } });
    expect(client.calls[0].args.p_closing_notes).toBeNull();
  });

  it('SCRUM379_AC2_notes_are_trimmed_before_the_database', async () => {
    const client = createEventRequestClient([ok(completedRow({ closing_notes: 'Done' }))]);
    await complete(client, { body: { closingNotes: '  Done  ' } });
    expect(client.calls[0].args.p_closing_notes).toBe('Done');
  });

  it('SCRUM379_AC2_notes_of_exactly_2000_characters_reach_the_database', async () => {
    const notes = 'x'.repeat(2000);
    const client = createEventRequestClient([ok(completedRow({ closing_notes: notes }))]);
    expect((await complete(client, { body: { closingNotes: notes } })).status).toBe(200);
  });

  it('SCRUM379_AC2_the_limit_counts_characters_so_2000_emoji_are_accepted_and_2001_refused', async () => {
    const accepted = '\u{1F600}'.repeat(2000);
    const okClient = createEventRequestClient([ok(completedRow({ closing_notes: accepted }))]);
    expect((await complete(okClient, { body: { closingNotes: accepted } })).status).toBe(200);

    const refusedClient = createEventRequestClient([]);
    const res = await complete(refusedClient, { body: { closingNotes: '\u{1F600}'.repeat(2001) } });
    expect(res.status).toBe(400);
    expect(refusedClient.calls).toEqual([]);
  });

  it.each([
    ['over 2000 characters', 'x'.repeat(2001)],
    ['a number', 42],
    ['an object', { text: 'no' }],
    ['an array', ['no']],
    ['a boolean', true],
  ])('SCRUM379_AC2_notes_that_are_%s_are_refused_with_400_before_the_database', async (_name, closingNotes) => {
    const client = createEventRequestClient([]);

    const res = await complete(client, { body: { closingNotes } });

    expect(res.status).toBe(400);
    expect(client.calls).toEqual([]);
  });

  it.each([
    ['an event organiser', ROLE.EVENT_ORGANISER],
    ['an attendee', ROLE.ATTENDEE],
    ['technical support staff', ROLE.TECHNICAL_SUPPORT_STAFF],
    ['venue staff', ROLE.VENUE_STAFF],
    ['the coordinator lead', ROLE.EVENT_COORDINATOR_LEAD],
  ])('SCRUM379_AC1_%s_is_refused_with_403_and_the_database_is_not_called', async (_name, role) => {
    const client = createEventRequestClient([]);

    const res = await complete(client, { requireAuth: signedInAs(role) });

    expect(res.status).toBe(403);
    expect(client.calls).toEqual([]);
  });

  it('SCRUM379_AC1_a_request_without_a_session_is_refused_with_401', async () => {
    const client = createEventRequestClient([]);

    const res = await complete(client, { requireAuth: signedOut });

    expect(res.status).toBe(401);
    expect(client.calls).toEqual([]);
  });

  it.each([
    [403, '42501', 'Only the coordinator assigned to event request x can mark it as completed'],
    [409, '55000', 'Event request x has status approved, and only a Confirmed event can be marked as completed'],
    [409, '55000', 'Event request x has not ended yet, so it cannot be marked as completed'],
    [404, 'P0002', 'Event request x not found'],
    [400, '22023', 'Closing notes can be at most 2000 characters'],
  ])('SCRUM379_AC1_the_database_refusal_%i_%s_is_passed_on', async (status, code, message) => {
    const client = createEventRequestClient([dbError(code, message)]);

    const res = await complete(client);

    expect(res.status).toBe(status);
    expect(client.calls).toHaveLength(1);
  });

  it('SCRUM379_AC1_a_refusal_for_an_unfinished_event_keeps_the_databases_reason_in_the_message', async () => {
    const message = 'Event request x has not ended yet, so it cannot be marked as completed';
    const res = await complete(createEventRequestClient([dbError('55000', message)]));
    expect(JSON.stringify(res.body)).toContain('has not ended yet');
  });

  it('SCRUM379_AC4_a_rejected_second_completion_is_a_409_not_a_server_error', async () => {
    const client = createEventRequestClient([
      dbError('55000', 'Event request x has status completed, and only a Confirmed event can be marked as completed'),
    ]);
    expect((await complete(client)).status).toBe(409);
  });
});

describe('SCRUM-379: closing notes stay with coordinators', () => {
  it('SCRUM379_AC2_an_organiser_reading_the_event_never_gets_the_closing_notes', async () => {
    const secret = 'Two attendees complained about the venue; ask the organiser nothing.';
    const client = createEventRequestClient([ok(completedRow({ closing_notes: secret }))]);

    const res = await request(appWith(client, signedInFor(ORGANISER_ID)(ROLE.EVENT_ORGANISER)))
      .get(`/api/event-requests/${EVENT_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(STATUS.COMPLETED);
    expect(res.body).not.toHaveProperty('closingNotes');
    expect(res.body).not.toHaveProperty('closing_notes');
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });
});

describe('SCRUM-379: completeEventRequest service', () => {
  const clientReturning = (response) => {
    const calls = [];
    return { calls, rpc: (fn, args) => { calls.push({ fn, args }); return Promise.resolve(response); } };
  };

  it('SCRUM379_AC1_refuses_a_missing_caller_before_the_database', async () => {
    const client = clientReturning({ data: completedRow(), error: null });
    await expect(completeEventRequest(EVENT_ID, {}, undefined, { client })).rejects.toBeInstanceOf(ValidationError);
    expect(client.calls).toEqual([]);
  });

  it('SCRUM379_AC2_returns_the_closing_notes_to_the_calling_coordinator', async () => {
    const client = clientReturning({ data: completedRow({ closing_notes: 'Notes' }), error: null });
    await expect(completeEventRequest(EVENT_ID, { closingNotes: 'Notes' }, COORDINATOR_ID, { client }))
      .resolves.toMatchObject({ status: STATUS.COMPLETED, closingNotes: 'Notes' });
  });

  it('SCRUM379_AC2_a_row_without_notes_gives_null_not_undefined', async () => {
    const row = completedRow();
    delete row.closing_notes;
    const client = clientReturning({ data: row, error: null });
    const result = await completeEventRequest(EVENT_ID, undefined, COORDINATOR_ID, { client });
    expect(result.closingNotes).toBeNull();
  });

  it('SCRUM379_AC1_maps_the_callers_refusal_to_forbidden', async () => {
    const client = clientReturning({ data: null, error: { code: '42501', message: 'Only the coordinator assigned' } });
    await expect(completeEventRequest(EVENT_ID, {}, COORDINATOR_ID, { client })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('SCRUM379_AC1_maps_a_wrong_status_or_unfinished_event_to_conflict', async () => {
    const client = clientReturning({ data: null, error: { code: '55000', message: 'not ended yet' } });
    await expect(completeEventRequest(EVENT_ID, {}, COORDINATOR_ID, { client })).rejects.toBeInstanceOf(ConflictError);
  });
});
