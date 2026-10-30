/**
 * SCRUM-384 (SCRUM-379 AC2): the coordinator's own reads of an event return its closing notes, and
 * nothing an Organiser reads does. The database half is in
 * tests/db/scrum379CoordinatorReadsClosingNotesDatabase.test.js; these cover the transport: which
 * columns each read selects, who is let in, and what the JSON carries.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createEventRequestRouter } from '../../src/routes/eventRequests.js';
import { getEventRequestForCoordinator } from '../../src/services/eventRequestService.js';
import { ROLE } from '../../src/domain/userRole.js';
import { STATUS } from '../../src/domain/eventRequestStatus.js';
import { ok, createEventRequestClient } from '../fixtures/supabaseStubs.js';
import { signedInFor } from '../fixtures/auth.js';

const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const ORGANISER_ID = '11111111-1111-4111-8111-111111111111';
const COORDINATOR_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_COORDINATOR_ID = '66666666-6666-4666-8666-666666666666';
const LEAD_ID = '77777777-7777-4777-8777-777777777777';

const SECRET = 'Two attendees complained about the venue; do not tell the organiser.';

const signedInAs = signedInFor(COORDINATOR_ID);

const row = (overrides = {}) => ({
  id: EVENT_ID,
  organiser_id: ORGANISER_ID,
  event_name: 'IS212 Industry Night',
  status: STATUS.COMPLETED,
  assigned_coordinator_id: COORDINATOR_ID,
  // Present on the row only when the read asked for the column; harmless to leave on every row,
  // because what is checked is what the service selects and what the JSON carries.
  closing_notes: SECRET,
  bookings: [],
  equipment_reservations: [],
  created_at: '2026-10-20T03:00:00+00:00',
  updated_at: '2026-10-21T03:00:00+00:00',
  submitted_at: '2026-10-20T04:00:00+00:00',
  ...overrides,
});

const names = ok([{ id: ORGANISER_ID, full_name: 'Olivia Organiser' }]);

const appWith = (client, requireAuth) =>
  express()
    .use(express.json())
    .use('/api/event-requests', createEventRequestRouter({ client, requireAuth }));

const as = (role, id = COORDINATOR_ID) => signedInFor(id)(role);

const selectedColumns = (client) => client.calls.find((call) => call.operation === 'select').select;
const mentionsClosingNotes = (text) => /closing_notes|closingNotes/.test(text);

describe('SCRUM-384: GET /mine returns the closing notes to the assigned coordinator', () => {
  it('SCRUM379_AC2_a_completed_event_carries_its_closing_notes', async () => {
    const client = createEventRequestClient([ok([row()]), names]);

    const res = await request(appWith(client, as(ROLE.EVENT_COORDINATOR))).get('/api/event-requests/mine');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: EVENT_ID, status: STATUS.COMPLETED, closingNotes: SECRET, organiserName: 'Olivia Organiser' });
  });

  it('SCRUM379_AC2_the_read_asks_the_database_for_the_column', async () => {
    const client = createEventRequestClient([ok([row()]), names]);

    await request(appWith(client, as(ROLE.EVENT_COORDINATOR))).get('/api/event-requests/mine');

    expect(selectedColumns(client)).toContain('closing_notes');
  });

  it('SCRUM379_AC2_an_event_without_notes_has_closingNotes_null_not_missing', async () => {
    const client = createEventRequestClient([ok([row({ closing_notes: null })]), names]);

    const res = await request(appWith(client, as(ROLE.EVENT_COORDINATOR))).get('/api/event-requests/mine');

    expect(res.body[0]).toHaveProperty('closingNotes', null);
  });

  it('SCRUM379_AC2_an_event_that_is_not_completed_has_closingNotes_null', async () => {
    const confirmed = row({ status: STATUS.CONFIRMED, closing_notes: null });
    const client = createEventRequestClient([ok([confirmed]), names]);

    const res = await request(appWith(client, as(ROLE.EVENT_COORDINATOR))).get('/api/event-requests/mine');

    expect(res.body[0]).toMatchObject({ status: STATUS.CONFIRMED, closingNotes: null });
  });

  it('SCRUM379_AC2_the_notes_are_the_ones_on_each_row', async () => {
    const other = row({ id: '33333333-3333-4333-8333-333333333333', closing_notes: 'Second event notes' });
    const client = createEventRequestClient([ok([row(), other]), names]);

    const res = await request(appWith(client, as(ROLE.EVENT_COORDINATOR))).get('/api/event-requests/mine');

    expect(res.body.map((event) => event.closingNotes)).toEqual([SECRET, 'Second event notes']);
  });

  it('SCRUM379_AC2_the_list_is_still_narrowed_to_the_token', async () => {
    const client = createEventRequestClient([ok([])]);

    await request(appWith(client, as(ROLE.EVENT_COORDINATOR, OTHER_COORDINATOR_ID)))
      .get('/api/event-requests/mine')
      .query({ coordinatorId: COORDINATOR_ID });

    expect(client.calls[0].filters).toEqual([['assigned_coordinator_id', OTHER_COORDINATOR_ID]]);
  });
});

describe('SCRUM-384: GET /:id/review returns the closing notes to a coordinator', () => {
  const review = (client, requireAuth) => request(appWith(client, requireAuth)).get(`/api/event-requests/${EVENT_ID}/review`);

  it.each([
    ['an event coordinator', ROLE.EVENT_COORDINATOR, COORDINATOR_ID],
    ['another event coordinator', ROLE.EVENT_COORDINATOR, OTHER_COORDINATOR_ID],
    ['the event coordinator lead', ROLE.EVENT_COORDINATOR_LEAD, LEAD_ID],
  ])('SCRUM379_AC2_%s_gets_closingNotes', async (_label, role, id) => {
    const client = createEventRequestClient([ok(row())]);

    const res = await review(client, as(role, id));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: EVENT_ID, status: STATUS.COMPLETED, closingNotes: SECRET });
    expect(selectedColumns(client)).toContain('closing_notes');
  });

  it('SCRUM379_AC2_an_event_without_notes_has_closingNotes_null', async () => {
    const client = createEventRequestClient([ok(row({ closing_notes: null }))]);

    const res = await review(client, as(ROLE.EVENT_COORDINATOR));

    expect(res.body).toHaveProperty('closingNotes', null);
  });

  it.each([
    ROLE.EVENT_ORGANISER, ROLE.ATTENDEE, ROLE.VENUE_STAFF, ROLE.TECHNICAL_SUPPORT_STAFF, ROLE.SAFETY_OFFICER,
  ])('SCRUM379_AC2_%s_is_refused_with_403_and_nothing_is_read', async (role) => {
    const client = createEventRequestClient([ok(row())]);

    const res = await review(client, as(role));

    expect(res.status).toBe(403);
    expect(client.calls).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });
});

describe('SCRUM-384: nothing an Organiser reads carries the closing notes', () => {
  const organiser = as(ROLE.EVENT_ORGANISER, ORGANISER_ID);

  it('SCRUM379_AC2_the_organisers_own_list_never_selects_or_returns_them', async () => {
    // The list also reads the coordinators' names for the events it shows.
    const client = createEventRequestClient([ok([row()]), ok([])]);

    const res = await request(appWith(client, organiser)).get('/api/event-requests');

    expect(res.status).toBe(200);
    expect(mentionsClosingNotes(selectedColumns(client))).toBe(false);
    expect(mentionsClosingNotes(JSON.stringify(res.body))).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('SCRUM379_AC2_the_organisers_single_read_never_selects_or_returns_them', async () => {
    const client = createEventRequestClient([ok(row())]);

    const res = await request(appWith(client, organiser)).get(`/api/event-requests/${EVENT_ID}`);

    expect(res.status).toBe(200);
    expect(mentionsClosingNotes(selectedColumns(client))).toBe(false);
    expect(mentionsClosingNotes(JSON.stringify(res.body))).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('SCRUM379_AC2_an_organiser_cannot_use_the_coordinators_review_read_to_get_them', async () => {
    const client = createEventRequestClient([ok(row())]);

    const res = await request(appWith(client, organiser)).get(`/api/event-requests/${EVENT_ID}/review`);

    expect(res.status).toBe(403);
    expect(client.calls).toEqual([]);
  });

  it('SCRUM379_AC2_an_organiser_cannot_use_the_coordinators_mine_read_to_get_them', async () => {
    const client = createEventRequestClient([ok([row()])]);

    const res = await request(appWith(client, organiser)).get('/api/event-requests/mine');

    expect(res.status).toBe(403);
    expect(client.calls).toEqual([]);
  });

  it('SCRUM379_AC2_the_review_queue_does_not_select_them', async () => {
    const client = createEventRequestClient([ok([row({ status: STATUS.SUBMITTED })])]);

    await request(appWith(client, as(ROLE.EVENT_COORDINATOR))).get('/api/event-requests/queue');

    expect(mentionsClosingNotes(selectedColumns(client))).toBe(false);
  });
});

describe('SCRUM-384: getEventRequestForCoordinator reads the notes only when asked', () => {
  it('SCRUM379_AC2_by_default_the_column_is_not_selected_and_the_key_is_absent', async () => {
    const client = createEventRequestClient([ok(row())]);

    const result = await getEventRequestForCoordinator(EVENT_ID, { client });

    expect(mentionsClosingNotes(selectedColumns(client))).toBe(false);
    expect(result).not.toHaveProperty('closingNotes');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('SCRUM379_AC2_with_the_option_the_column_is_selected_and_returned', async () => {
    const client = createEventRequestClient([ok(row())]);

    const result = await getEventRequestForCoordinator(EVENT_ID, { client, withClosingNotes: true });

    expect(selectedColumns(client)).toContain('closing_notes');
    expect(result.closingNotes).toBe(SECRET);
  });

  it('SCRUM379_AC2_a_draft_is_still_a_not_found_with_the_option_on', async () => {
    const client = createEventRequestClient([ok(row({ status: STATUS.DRAFT, closing_notes: null }))]);

    await expect(getEventRequestForCoordinator(EVENT_ID, { client, withClosingNotes: true }))
      .rejects.toMatchObject({ name: 'NotFoundError' });
  });
});
