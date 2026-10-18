import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequireAuth } from '../../src/middleware/requireAuth.js';
import { createAttendeeEventRouter } from '../../src/routes/attendeeEvents.js';
import { getAttendeeEvent } from '../../src/services/attendeeEventService.js';
import { ROLE } from '../../src/domain/userRole.js';

const defaultClient = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: defaultClient }));

const ATTENDEE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ATTENDEE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EVENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_EVENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const user = { id: ATTENDEE, role: ROLE.ATTENDEE };
const notFound = { error: 'Event information not found' };

function registration(overrides = {}) {
  return {
    attendee_id: ATTENDEE,
    event_request_id: EVENT,
    status: 'registered',
    event_requests: { id: EVENT },
    ...overrides,
  };
}

// Execute the actual query filters over records, so unrelated and inactive
// registrations cannot pass just because a mock always returns its first row.
function database(rows = [], { error = null, ignoreFilters = false } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, columns: null, filters: [] };
      calls.push(call);
      const query = {
        select(columns) { call.columns = columns; return query; },
        eq(field, value) { call.filters.push([field, value]); return query; },
        async maybeSingle() {
          const data = ignoreFilters ? rows[0] : rows.find(row => (
            call.filters.every(([field, value]) => row[field] === value)
            && row.event_requests?.id
          ));
          return { data: data ?? null, error };
        },
      };
      return query;
    },
  };
}

function application(client, { id = ATTENDEE, role = ROLE.ATTENDEE } = {}) {
  const requireAuth = createRequireAuth({
    verifyToken: async token => token === 'valid'
      ? { id, user_metadata: { role: ROLE.ATTENDEE } } : null,
    loadRole: async () => role,
  });
  return express().use(express.json()).use('/api/attendee-events',
    createAttendeeEventRouter({ client, requireAuth }));
}

const read = (app, id = EVENT) => request(app)
  .get(`/api/attendee-events/${id}`).set('Authorization', 'Bearer valid');

afterEach(() => vi.restoreAllMocks());

describe('SCRUM-49 attendee event access', () => {
  it.each([undefined, 'Basic valid', 'Bearer ', 'Bearer expired'])(
    'SCRUM24_AC1_rejects_unauthenticated_access_%s', async authorization => {
      const client = database([registration()]);
      let req = request(application(client)).get(`/api/attendee-events/${EVENT}`);
      if (authorization !== undefined) req = req.set('Authorization', authorization);
      const response = await req;
      expect(response.status).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(client.calls).toEqual([]);
    },
  );

  it.each(Object.values(ROLE).filter(role => role !== ROLE.ATTENDEE))(
    'SCRUM24_AC1_rejects_wrong_role_even_with_attendee_token_metadata_%s', async role => {
      const client = database([registration()]);
      const response = await read(application(client, { role }));
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'This action is restricted to Attendees' });
      expect(client.calls).toEqual([]);
    },
  );

  it('SCRUM24_AC1_requires_a_current_profile_role', async () => {
    const client = database([registration()]);
    expect((await read(application(client, { role: null }))).status).toBe(403);
    expect(client.calls).toEqual([]);
  });

  it('SCRUM24_AC1_reads_only_the_verified_attendees_own_active_registration', async () => {
    const client = database([registration({ attendee_id: OTHER_ATTENDEE }), registration()]);
    const response = await read(application(client));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ eventRequestId: EVENT });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(client.calls).toEqual([{
      table: 'event_registrations',
      columns: 'event_request_id, attendee_id, status, event_requests!inner(id)',
      filters: [['attendee_id', ATTENDEE], ['event_request_id', EVENT], ['status', 'registered']],
    }]);
  });

  it.each(['withdrawn', 'cancelled', 'waitlisted', 'unknown'])(
    'SCRUM24_AC1_refuses_inactive_registration_%s', async status => {
      const response = await read(application(database([registration({ status })])));
      expect(response.status).toBe(404);
      expect(response.body).toEqual(notFound);
    },
  );

  it('SCRUM24_AC1_unknown_and_inaccessible_events_have_the_same_safe_response', async () => {
    const client = database([registration({ attendee_id: OTHER_ATTENDEE })]);
    const app = application(client);
    const inaccessible = await read(app);
    const unknown = await read(app, OTHER_EVENT);
    expect(inaccessible.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(inaccessible.body).toEqual(notFound);
    expect(unknown.body).toEqual(inaccessible.body);
  });

  it('SCRUM24_AC1_ignores_forged_attendee_identity_and_role_in_query_and_body', async () => {
    const client = database([registration()]);
    const response = await read(application(client, { id: OTHER_ATTENDEE }))
      .query({ attendeeId: ATTENDEE, userId: ATTENDEE, role: ROLE.ATTENDEE })
      .send({ user: { id: ATTENDEE, role: ROLE.ATTENDEE }, attendeeId: ATTENDEE });
    expect(response.status).toBe(404);
    expect(response.body).toEqual(notFound);
    expect(client.calls[0].filters[0]).toEqual(['attendee_id', OTHER_ATTENDEE]);
  });

  it('SCRUM24_AC1_path_event_cannot_be_overridden_by_query_or_body', async () => {
    const client = database([registration()]);
    const response = await read(application(client), OTHER_EVENT)
      .query({ eventRequestId: EVENT, eventId: EVENT }).send({ eventRequestId: EVENT });
    expect(response.status).toBe(404);
    expect(response.body).toEqual(notFound);
    expect(client.calls[0].filters[1]).toEqual(['event_request_id', OTHER_EVENT]);
  });

  it.each(['not-an-id', "' OR 1=1 --"])(
    'SCRUM24_AC1_rejects_invalid_event_identifier_before_querying_%s', async id => {
      const client = database();
      const response = await read(application(client), encodeURIComponent(id));
      expect(response.status).toBe(400);
      expect(response.body.details).toEqual([{ field: 'eventRequestId', message: 'must be a valid UUID' }]);
      expect(client.calls).toEqual([]);
    },
  );

  it('SCRUM24_AC1_access_does_not_depend_on_registration_availability', async () => {
    const client = database([registration({ event_requests: {
      id: EVENT, status: 'approved', proposed_start: '2000-01-01T00:00:00Z',
      registration_enabled: false, registration_capacity: 0,
      registration_opens_at: '2100-01-01T00:00:00Z',
      registration_closes_at: '2000-01-01T00:00:00Z',
    } })]);
    const response = await read(application(client));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ eventRequestId: EVENT });
    expect(client.calls[0].filters.map(([field]) => field))
      .toEqual(['attendee_id', 'event_request_id', 'status']);
  });

  it('SCRUM24_AC1_withdrawal_revokes_access_on_the_next_read', async () => {
    const row = registration();
    const client = database([row]);
    const app = application(client);
    expect((await read(app)).status).toBe(200);
    row.status = 'withdrawn';
    const response = await read(app);
    expect(response.status).toBe(404);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(client.calls).toHaveLength(2);
  });

  it('SCRUM24_AC8_returns_no_planning_information_or_placeholder_arrangements', async () => {
    const client = database([registration({
      staff: 'private', supplier: 'private',
      event_requests: { id: EVENT, coordinator_id: OTHER_ATTENDEE, description: 'private', venues: ['unconfirmed'] },
    })]);
    expect((await read(application(client))).body).toEqual({ eventRequestId: EVENT });
    expect(client.calls[0].columns).not.toMatch(/\*|description|coordinator|venue|equipment/);
  });

  it.each(['42P01', '42703', 'PGRST200', 'PGRST202', 'PGRST204', 'PGRST205'])(
    'SCRUM24_AC1_missing_dependency_schema_fails_closed_%s', async code => {
      const client = database([], { error: { code, message: 'private database details' } });
      const response = await read(application(client));
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'Event information is temporarily unavailable. Please try again later.' });
    },
  );

  it.each(['42501', '22023', '55000', '40001', '40P01', 'XX000'])(
    'SCRUM24_AC1_unexpected_database_failure_is_logged_and_not_disclosed_%s', async code => {
      const error = { code, message: 'private database details' };
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await read(application(database([], { error })));
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Unexpected server error' });
      expect(log).toHaveBeenCalledWith('Unexpected error in attendee events route:', error);
    },
  );

  it.each([
    { attendee_id: OTHER_ATTENDEE }, { event_request_id: OTHER_EVENT },
    { status: 'withdrawn' }, { event_requests: { id: OTHER_EVENT } },
    { event_requests: undefined },
  ])('SCRUM24_AC1_reusable_policy_refuses_mismatched_query_results_%j', async overrides => {
    const client = database([registration(overrides)], { ignoreFilters: true });
    await expect(getAttendeeEvent({ user, eventRequestId: EVENT, client }))
      .rejects.toMatchObject({ status: 404, message: notFound.error });
  });

  it('SCRUM24_AC1_reusable_policy_requires_verified_identity_and_attendee_role', async () => {
    const client = database([registration()]);
    await expect(getAttendeeEvent()).rejects.toMatchObject({ status: 401 });
    await expect(getAttendeeEvent({ user: {}, eventRequestId: EVENT, client }))
      .rejects.toMatchObject({ status: 401 });
    await expect(getAttendeeEvent({ user: { ...user, role: ROLE.EVENT_ORGANISER }, eventRequestId: EVENT, client }))
      .rejects.toMatchObject({ status: 403 });
    await expect(getAttendeeEvent({ user: { ...user, id: 'forged' }, eventRequestId: EVENT, client }))
      .rejects.toMatchObject({ status: 400, details: [{ field: 'attendeeId', message: 'must be a valid UUID' }] });
    expect(client.calls).toEqual([]);
  });

  it('SCRUM24_AC1_normalises_UUIDs_and_resolves_the_default_server_client', async () => {
    const client = database([registration()]);
    defaultClient.from.mockImplementation(client.from);
    await expect(getAttendeeEvent({
      user: { ...user, id: ` ${ATTENDEE.toUpperCase()} ` }, eventRequestId: ` ${EVENT.toUpperCase()} `,
    })).resolves.toEqual({ eventRequestId: EVENT });
    expect(client.calls[0].filters.slice(0, 2))
      .toEqual([['attendee_id', ATTENDEE], ['event_request_id', EVENT]]);
  });

  it('SCRUM24_AC1_default_router_is_protected_without_injected_middleware', async () => {
    const app = express().use('/api/attendee-events', createAttendeeEventRouter());
    const response = await request(app).get(`/api/attendee-events/${EVENT}`);
    expect(response.status).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
  });
});
