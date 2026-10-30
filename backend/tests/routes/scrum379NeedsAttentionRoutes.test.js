/**
 * SCRUM-383 (SCRUM-379 AC7): GET /api/event-requests/needs-attention over HTTP.
 * The rules are covered in tests/domain/scrum379CoordinatorAttentionList.test.js and on the real schema in
 * tests/db/scrum379NeedsAttentionDatabase.test.js. These cover the transport: the gate, the
 * scoping to the caller, the shape, the path, and what a failure looks like.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createEventRequestRouter } from '../../src/routes/eventRequests.js';
import { ROLE } from '../../src/domain/userRole.js';
import { ok, dbError, createEventRequestClient } from '../fixtures/supabaseStubs.js';
import { signedInFor, signedOut } from '../fixtures/auth.js';

const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_EVENT_ID = '33333333-3333-4333-8333-333333333333';
const ORGANISER_ID = '11111111-1111-4111-8111-111111111111';
const COORDINATOR_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_COORDINATOR_ID = '66666666-6666-4666-8666-666666666666';

const signedInAs = signedInFor(COORDINATOR_ID);

// Fixed instants far in the past so every one of these events has ended whenever the test runs.
const ENDED_START = '2001-01-01T01:00:00+00:00';
const ENDED_END = '2001-01-01T03:00:00+00:00';

const row = (overrides = {}) => ({
  id: EVENT_ID,
  organiser_id: ORGANISER_ID,
  event_name: 'IS212 Industry Night',
  status: 'confirmed',
  assigned_coordinator_id: COORDINATOR_ID,
  proposed_start: ENDED_START,
  proposed_end: ENDED_END,
  clarification_reply_by_date: null,
  equipment_reservations: [],
  created_at: '2000-12-01T03:00:00+00:00',
  updated_at: '2000-12-02T03:00:00+00:00',
  submitted_at: '2000-12-01T04:00:00+00:00',
  ...overrides,
});

const readyReadiness = ok({ ready: true, items: [{ key: 'venue', met: true }, { key: 'equipment', met: true }] });
const names = ok([{ id: ORGANISER_ID, full_name: 'Olivia Organiser' }]);

const appWith = (client, requireAuth = signedInAs(ROLE.EVENT_COORDINATOR)) =>
  express()
    .use(express.json())
    .use('/api/event-requests', createEventRequestRouter({ client, requireAuth }));

const get = (client, requireAuth) => request(appWith(client, requireAuth)).get('/api/event-requests/needs-attention');

describe('SCRUM-383: GET /needs-attention', () => {
  it('SCRUM379_AC7_a_coordinator_gets_200_and_a_bare_array_of_items', async () => {
    const client = createEventRequestClient([ok([row()]), readyReadiness, names]);

    const res = await get(client);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{
      id: `${EVENT_ID}:MARK_COMPLETED:0`,
      code: 'MARK_COMPLETED',
      reason: 'Mark as completed',
      eventRequestId: EVENT_ID,
      eventName: 'IS212 Industry Night',
      status: 'confirmed',
      proposedStart: ENDED_START,
      proposedEnd: ENDED_END,
      organiserName: 'Olivia Organiser',
      link: `/event-requests/${EVENT_ID}`,
    }]);
  });

  it('SCRUM379_AC7_the_list_is_narrowed_to_the_token_not_the_query_string', async () => {
    const client = createEventRequestClient([ok([row()]), readyReadiness, names]);

    await request(appWith(client))
      .get('/api/event-requests/needs-attention')
      .query({ coordinatorId: OTHER_COORDINATOR_ID, assignedCoordinatorId: OTHER_COORDINATOR_ID });

    expect(client.calls[0]).toMatchObject({ table: 'event_requests', operation: 'select' });
    expect(client.calls[0].filters).toEqual([
      ['assigned_coordinator_id', COORDINATOR_ID],
      ['status', ['confirmed', 'approved', 'pending_clarification']],
    ]);
  });

  it('SCRUM379_AC7_another_coordinators_token_reads_with_its_own_id', async () => {
    const client = createEventRequestClient([ok([])]);

    await get(client, signedInAs(ROLE.EVENT_COORDINATOR, OTHER_COORDINATOR_ID));

    expect(client.calls[0].filters[0]).toEqual(['assigned_coordinator_id', OTHER_COORDINATOR_ID]);
  });

  it('SCRUM379_AC7_the_read_is_ordered_earliest_event_first_with_the_id_as_tiebreak', async () => {
    const client = createEventRequestClient([ok([])]);

    await get(client);

    expect(client.calls[0].order).toEqual([
      ['proposed_start', { ascending: true, nullsFirst: false }],
      ['id', { ascending: true }],
    ]);
  });

  it('SCRUM379_AC7_nothing_needing_attention_is_200_with_an_empty_array_not_404', async () => {
    const client = createEventRequestClient([ok([])]);

    const res = await get(client);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(client.calls).toHaveLength(1);
  });

  it('SCRUM379_AC7_an_event_that_is_fine_adds_no_item', async () => {
    const future = row({ proposed_start: '2999-01-01T01:00:00+00:00', proposed_end: '2999-01-01T03:00:00+00:00' });
    const client = createEventRequestClient([ok([future]), readyReadiness, names]);

    const res = await get(client);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('SCRUM379_AC7_the_readiness_of_a_confirmed_event_is_asked_with_no_equipment_confirmed', async () => {
    const client = createEventRequestClient([ok([row()]), readyReadiness, names]);

    await get(client);

    expect(client.calls[1]).toMatchObject({
      operation: 'rpc',
      fn: 'event_readiness',
      args: { p_event_request_id: EVENT_ID, p_no_equipment_confirmed: true },
    });
  });

  it('SCRUM379_AC7_an_unmet_readiness_item_becomes_its_own_reason', async () => {
    const future = row({ proposed_start: '2999-01-01T01:00:00+00:00', proposed_end: '2999-01-01T03:00:00+00:00' });
    const notReady = ok({
      ready: false,
      items: [
        { key: 'venue', met: false, detail: 'No venue booking' },
        { key: 'equipment', met: false, detail: 'Pending review' },
        { key: 'date', met: false, detail: 'The start has passed' },
      ],
    });
    const client = createEventRequestClient([ok([future]), notReady, names]);

    const res = await get(client);

    expect(res.body.map((item) => [item.code, item.reason])).toEqual([
      ['VENUE_NOT_READY', 'No valid venue booking'],
      ['EQUIPMENT_NOT_READY', 'Equipment request: Pending review'],
    ]);
  });

  it('SCRUM379_AC7_an_approved_event_is_not_asked_for_readiness', async () => {
    const approved = row({ status: 'approved' });
    const client = createEventRequestClient([ok([approved]), names]);

    const res = await get(client);

    expect(res.body.map((item) => item.code)).toEqual(['NOT_CONFIRMED']);
    expect(client.calls.map((c) => c.fn ?? c.table)).toEqual(['event_requests', 'profiles']);
  });

  it('SCRUM379_AC7_an_overdue_clarification_names_its_date', async () => {
    const waiting = row({ status: 'pending_clarification', proposed_end: '2999-01-01T03:00:00+00:00', clarification_reply_by_date: '2001-02-03' });
    const client = createEventRequestClient([ok([waiting]), names]);

    const res = await get(client);

    expect(res.body.map((item) => item.reason)).toEqual(['Clarification overdue: reply was due 2001-02-03']);
  });

  it('SCRUM379_AC7_items_come_back_earliest_event_first_whatever_order_the_read_returned_them', async () => {
    const later = row({ id: SECOND_EVENT_ID, status: 'approved', event_name: 'Later', proposed_start: '2002-01-01T01:00:00+00:00', proposed_end: '2002-01-01T03:00:00+00:00' });
    const earlier = row({ status: 'approved', event_name: 'Earlier' });
    const client = createEventRequestClient([ok([later, earlier]), names]);

    const res = await get(client);

    expect(res.body.map((item) => item.eventName)).toEqual(['Earlier', 'Later']);
  });

  it('SCRUM379_AC7_the_path_is_not_read_as_a_request_id', async () => {
    const client = createEventRequestClient([ok([row({ status: 'approved' })]), names]);

    const res = await get(client);

    expect(res.status).toBe(200);
    expect(client.calls[0].filters).not.toContainEqual(['id', 'needs-attention']);
  });

  describe('who may ask', () => {
    it.each([
      ROLE.EVENT_ORGANISER, ROLE.ATTENDEE, ROLE.VENUE_STAFF, ROLE.TECHNICAL_SUPPORT_STAFF,
      ROLE.SAFETY_OFFICER, ROLE.EVENT_COORDINATOR_LEAD,
    ])('SCRUM379_AC7_%s_is_refused_with_403_and_nothing_is_read', async (role) => {
      const client = createEventRequestClient([ok([row()]), readyReadiness, names]);

      const res = await get(client, signedInAs(role));

      expect(res.status).toBe(403);
      expect(client.calls).toEqual([]);
    });

    it('SCRUM379_AC7_a_caller_with_no_role_is_refused', async () => {
      const client = createEventRequestClient([ok([row()])]);

      const res = await get(client, signedInAs(undefined));

      expect(res.status).toBe(403);
      expect(client.calls).toEqual([]);
    });

    it('SCRUM379_AC7_signed_out_is_401_and_nothing_is_read', async () => {
      const client = createEventRequestClient([ok([row()])]);

      const res = await get(client, signedOut);

      expect(res.status).toBe(401);
      expect(client.calls).toEqual([]);
    });
  });

  describe('failures', () => {
    it('SCRUM379_AC7_a_failed_event_read_is_a_500_that_does_not_leak_the_database_message', async () => {
      const client = createEventRequestClient([dbError('08006', 'connection to db.internal:5432 lost')]);

      const res = await get(client);

      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('db.internal');
    });

    it('SCRUM379_AC7_a_failed_readiness_read_is_a_500_not_a_list_with_reasons_missing', async () => {
      const client = createEventRequestClient([ok([row()]), dbError('XX000', 'readiness exploded at table event_requests')]);

      const res = await get(client);

      expect(res.status).toBe(500);
      expect(Array.isArray(res.body)).toBe(false);
      expect(JSON.stringify(res.body)).not.toContain('exploded');
    });

    it('SCRUM379_AC7_a_failed_name_read_is_a_500', async () => {
      const client = createEventRequestClient([ok([row({ status: 'approved' })]), dbError('08006', 'connection lost')]);

      const res = await get(client);

      expect(res.status).toBe(500);
    });
  });

  it('SCRUM379_AC7_asking_changes_nothing', async () => {
    const client = createEventRequestClient([ok([row()]), readyReadiness, names]);

    await get(client);

    expect(client.calls.filter((c) => c.operation === 'insert' || c.operation === 'update')).toEqual([]);
    expect(client.calls.filter((c) => c.operation === 'rpc').map((c) => c.fn)).toEqual(['event_readiness']);
  });
});
