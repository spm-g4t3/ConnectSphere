import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createOpenEventRouter } from '../../src/routes/openEvents.js';
import { createEventRegistrationRouter } from '../../src/routes/eventRegistration.js';
import { createRequireAuth } from '../../src/middleware/requireAuth.js';
import { ROLE } from '../../src/domain/userRole.js';

const ME = '44444444-4444-4444-8444-444444444444';
const EVENT = '00000000-0000-4000-8000-00000000000a';
const saved = {
  id: '11111111-1111-4111-8111-111111111111', attendee_id: ME,
  event_request_id: EVENT, status: 'registered', created_at: '2026-10-16T10:00:00Z',
  updated_at: '2026-10-16T10:00:00Z',
};
const client = () => ({ rpc: vi.fn().mockResolvedValue({
  data: { outcome: 'registered', registration: saved }, error: null,
}) });

function app(db, role = ROLE.ATTENDEE) {
  const requireAuth = createRequireAuth({
    verifyToken: async (token) => token === 'valid-token' ? { id: ME, email: 'a@example.com' } : null,
    loadRole: async () => role,
  });
  return express().use(express.json())
    .use('/api/open-events', createOpenEventRouter({ client: db, requireAuth }))
    .use('/api/registration', createEventRegistrationRouter({ client: db, requireAuth }));
}

describe('SCRUM36 registration submission endpoint', () => {
  const endpoints = [`/api/open-events/${EVENT}/registrations`];

  it('SCRUM22_AC4_does_not_restore_the_retired_registration_submission_route', async () => {
    const db = client();
    const response = await request(app(db)).post(`/api/registration/events/${EVENT}/register`)
      .set('Authorization', 'Bearer valid-token');
    expect(response.status).toBe(404);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it.each(endpoints)('SCRUM22_AC4_registration_returns_success_duplicate_and_capacity_outcomes_at_%s', async (path) => {
    const db = client();
    const registration = { id: saved.id, eventRequestId: EVENT, attendeeId: ME, registeredAt: saved.created_at };
    db.rpc.mockResolvedValueOnce({ data: { outcome: 'registered', registration, registeredCount: 1 }, error: null })
      .mockResolvedValueOnce({ data: { outcome: 'already_registered' }, error: null })
      .mockResolvedValueOnce({ data: { outcome: 'capacity_reached' }, error: null });
    const server = app(db);
    const success = await request(server).post(path).set('Authorization', 'Bearer valid-token');
    expect(success.status).toBe(201);
    expect(success.body).toMatchObject(registration);
    const duplicate = await request(server).post(path).set('Authorization', 'Bearer valid-token');
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('ALREADY_REGISTERED');
    const full = await request(server).post(path).set('Authorization', 'Bearer valid-token');
    expect(full.status).toBe(409);
    expect(full.body.code).toBe('EVENT_FULL');
  });

  it.each(endpoints)('SCRUM22_AC1_missing_deployment_dependencies_return_503_at_%s', async (path) => {
    for (const code of ['42703', '42P01', 'PGRST202']) {
      const db = client();
      db.rpc.mockResolvedValue({ error: { code, message: 'Private schema details' } });
      const response = await request(app(db)).post(path).set('Authorization', 'Bearer valid-token');
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'Event registration is temporarily unavailable. Please try again later.' });
    }
  });

  it.each(endpoints)('SCRUM22_AC1_private_event_states_and_unknown_ids_have_the_same_404_at_%s', async (path) => {
    for (const hint of ['EVENT_NOT_CONFIRMED', 'REGISTRATION_DISABLED', 'REGISTRATION_NOT_OPEN', 'REGISTRATION_CLOSED', 'EVENT_STARTED', 'REGISTRATION_DATES_MISSING', null]) {
      const db = client();
      db.rpc.mockResolvedValue({ error: { code: hint ? '55000' : 'P0002', hint, message: 'Private event details' } });
      const res = await request(app(db)).post(path).set('Authorization', 'Bearer valid-token');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'This event is not open for registration' });
    }
    for (const outcome of ['not_found', 'event_not_confirmed', 'registration_closed']) {
      const db = client();
      db.rpc.mockResolvedValue({ data: { outcome, status: 'rejected' }, error: null });
      const res = await request(app(db)).post(path).set('Authorization', 'Bearer valid-token');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'This event is not open for registration' });
    }
  });

  it.each(endpoints)('SCRUM22_AC4_retryable_database_races_are_safe_409_responses_at_%s', async (path) => {
    for (const code of ['40001', '40P01']) {
      const db = client();
      db.rpc.mockResolvedValue({ error: { code, message: 'Private deadlock detail' } });
      const res = await request(app(db)).post(path).set('Authorization', 'Bearer valid-token');
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'Registration changed while you were registering. Please try again.', code: 'REGISTRATION_CHANGED', conflicts: [] });
    }
  });
  it('SCRUM36_AC3_AC4_uses_the_verified_attendee_and_atomic_RPC_ignoring_body_claims', async () => {
    const db = client();
    const res = await request(app(db)).post(`/api/open-events/${EVENT}/registrations`)
      .set('Authorization', 'Bearer valid-token')
      .send({ attendeeId: EVENT, eventId: ME, role: 'attendee', capacity: 999, status: 'confirmed' });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      id: saved.id, attendeeId: ME, eventRequestId: EVENT, status: 'registered',
      createdAt: saved.created_at, updatedAt: saved.updated_at,
    });
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith('register_for_event', {
      p_attendee_id: ME, p_event_request_id: EVENT,
    });
  });

  it.each([null, 'Bearer expired-token'])('SCRUM36_AC4_rejects_missing_or_invalid_authentication_%s', async (header) => {
    const db = client();
    const req = request(app(db)).post(`/api/open-events/${EVENT}/registrations`);
    if (header) req.set('Authorization', header);
    const res = await req.send({ role: 'attendee', attendeeId: ME });
    expect(res.status).toBe(401);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it.each(Object.values(ROLE).filter((role) => role !== ROLE.ATTENDEE))
    ('SCRUM36_AC4_rejects_the_stored_role_%s_despite_body_claims', async (role) => {
      const db = client();
      const res = await request(app(db, role)).post(`/api/open-events/${EVENT}/registrations`)
        .set('Authorization', 'Bearer valid-token').send({ role: 'attendee' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('This action is restricted to Attendees');
      expect(db.rpc).not.toHaveBeenCalled();
    });

  it('SCRUM36_AC6_rejects_invalid_event_ids_before_the_RPC', async () => {
    const db = client();
    const res = await request(app(db)).post('/api/open-events/invalid/registrations')
      .set('Authorization', 'Bearer valid-token');
    expect(res.status).toBe(400);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['EVENT_FULL', 'Event is full'], ['ALREADY_REGISTERED', 'Already registered'],
  ])('SCRUM36_AC7_returns_the_authoritative_%s_response', async (code, message) => {
    const db = client();
    db.rpc.mockResolvedValue({ error: { code: '55000', hint: code, message } });
    const res = await request(app(db)).post(`/api/open-events/${EVENT}/registrations`)
      .set('Authorization', 'Bearer valid-token');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: message, code, conflicts: [] });
  });

  it('SCRUM36_AC6_hides_unexpected_database_failures', async () => {
    const db = client();
    db.rpc.mockResolvedValue({ error: new Error('private database failure') });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await request(app(db)).post(`/api/open-events/${EVENT}/registrations`)
        .set('Authorization', 'Bearer valid-token');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Unexpected server error' });
    } finally { log.mockRestore(); }
  });
});

describe('SCRUM494 registration settings endpoint', () => {
  it('SCRUM494_AC2_answers_400_for_a_time_without_an_offset', async () => {
    const db = client();
    const res = await request(app(db, ROLE.EVENT_ORGANISER)).put(`/api/registration/events/${EVENT}/settings`)
      .set('Authorization', 'Bearer valid-token')
      .send({ enabled: true, opensAt: '2026-11-01T10:00:00', closesAt: '2026-11-02T10:00:00Z' });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'registrationOpensAt', message: 'Enter a valid date and time.' }]);
    expect(db.rpc).not.toHaveBeenCalled();
  });
});

describe('SCRUM478 registration list endpoint', () => {
  const ATTENDEE = '99999999-9999-4999-8999-999999999999';
  const path = `/api/registration/events/${EVENT}/registrations`;
  const listed = {
    outcome: 'listed',
    event: { id: EVENT, eventName: 'Gala', status: 'confirmed', capacity: 50 },
    registeredCount: 1,
    entries: [{
      id: saved.id, attendeeId: ATTENDEE, attendeeName: 'Ada',
      registeredAt: '2026-10-16T10:00:00Z', status: 'registered',
    }],
  };
  // The list's view of an entry: the email from the admin API, no attendee id.
  const shown = { id: saved.id, attendeeName: 'Ada', attendeeEmail: 'ada@example.com',
    registeredAt: '2026-10-16T10:00:00Z', status: 'registered', statusLabel: 'Registered' };
  const listing = (data = listed, error = null, users = [{ id: ATTENDEE, email: 'ada@example.com' }]) => ({
    rpc: vi.fn().mockResolvedValue({ data, error }),
    auth: { admin: { listUsers: vi.fn().mockResolvedValue({ data: { users }, error: null }) } },
  });
  const get = (db, role, query = '') => request(app(db, role)).get(`${path}${query}`)
    .set('Authorization', 'Bearer valid-token');

  it.each([ROLE.EVENT_ORGANISER, ROLE.EVENT_COORDINATOR])(
    'SCRUM478_AC1_passes_the_%s_role_and_the_caller_to_the_database_check',
    async (role) => {
      const db = listing();
      const res = await get(db, role, '?hideWithdrawn=true');
      expect(res.status).toBe(200);
      expect(db.rpc).toHaveBeenCalledWith('list_event_registrations', {
        p_event_request_id: EVENT, p_user_id: ME, p_hide_withdrawn: true,
      });
      expect(res.body).toEqual({
        event: listed.event,
        counts: { registered: 1, capacity: 50 },
        hideWithdrawn: true,
        entries: [shown],
      });
    },
  );

  it.each([
    ROLE.ATTENDEE, ROLE.EVENT_COORDINATOR_LEAD, ROLE.VENUE_STAFF,
    ROLE.TECHNICAL_SUPPORT_STAFF, ROLE.SAFETY_OFFICER,
  ])('SCRUM478_AC1_refuses_the_%s_role_before_reading', async (role) => {
    const db = listing();
    const res = await get(db, role);
    expect(res.status).toBe(403);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM478_AC1_refuses_an_unauthenticated_caller', async () => {
    const db = listing();
    const res = await request(app(db, ROLE.EVENT_ORGANISER)).get(path);
    expect(res.status).toBe(401);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM478_AC1_maps_the_database_refusals_to_403_and_404', async () => {
    const forbidden = await get(listing({ outcome: 'forbidden' }), ROLE.EVENT_COORDINATOR);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toMatch(/assigned coordinator/);
    const hidden = await get(listing({ outcome: 'not_found' }), ROLE.EVENT_ORGANISER);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual({ error: 'Event not found.' });
  });

  it('SCRUM478_AC6_answers_409_naming_the_status_when_the_list_is_not_available', async () => {
    const res = await get(listing({ outcome: 'status_not_available', status: 'under_review' }), ROLE.EVENT_ORGANISER);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REGISTRATION_LIST_NOT_AVAILABLE');
    expect(res.body.error).toMatch(/Current status: Under review\.$/);
  });

  it('SCRUM478_AC2_labels_each_stored_status', async () => {
    const entries = ['registered', 'withdrawn', 'cancelled', 'waitlisted', 'mystery'].map((status, index) => ({
      ...listed.entries[0], id: `${index}`, status,
    }));
    const res = await get(listing({ ...listed, entries }), ROLE.EVENT_ORGANISER);
    expect(res.body.entries.map((entry) => entry.statusLabel))
      .toEqual(['Registered', 'Withdrawn', 'Event cancelled', 'Waitlisted', 'Unknown']);
  });

  it('SCRUM478_AC3_reports_a_count_without_capacity_when_none_is_set', async () => {
    const res = await get(listing({ ...listed, event: { ...listed.event, capacity: null } }), ROLE.EVENT_ORGANISER);
    expect(res.body.counts).toEqual({ registered: 1, capacity: null });
  });

  it('SCRUM478_AC4_defaults_to_showing_withdrawn_and_refuses_other_filter_values', async () => {
    const db = listing();
    await get(db, ROLE.EVENT_ORGANISER);
    expect(db.rpc.mock.calls[0][1].p_hide_withdrawn).toBe(false);
    await get(db, ROLE.EVENT_ORGANISER, '?hideWithdrawn=false');
    expect(db.rpc.mock.calls[1][1].p_hide_withdrawn).toBe(false);

    const bad = listing();
    const res = await get(bad, ROLE.EVENT_ORGANISER, '?hideWithdrawn=yes');
    expect(res.status).toBe(400);
    expect(bad.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM478_AC5_accepts_no_write_methods', async () => {
    const db = listing();
    for (const method of ['post', 'put', 'patch', 'delete']) {
      const res = await request(app(db, ROLE.EVENT_ORGANISER))[method](path)
        .set('Authorization', 'Bearer valid-token');
      expect(res.status).toBe(404);
    }
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM478_AC1_refuses_a_malformed_event_id_without_reading', async () => {
    const db = listing();
    const res = await request(app(db, ROLE.EVENT_ORGANISER)).get('/api/registration/events/nope/registrations')
      .set('Authorization', 'Bearer valid-token');
    expect(res.status).toBe(400);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM478_AC2_pages_through_users_only_until_every_attendee_is_found', async () => {
    const page = (start) => Array.from({ length: 1000 }, (_, index) => ({ id: `u${start + index}`, email: null }));
    const db = listing();
    db.auth.admin.listUsers
      .mockResolvedValueOnce({ data: { users: page(0) }, error: null })
      .mockResolvedValueOnce({ data: { users: [...page(1000).slice(1), { id: ATTENDEE, email: 'ada@example.com' }] }, error: null });
    const res = await get(db, ROLE.EVENT_ORGANISER);
    expect(res.body.entries[0].attendeeEmail).toBe('ada@example.com');
    expect(db.auth.admin.listUsers.mock.calls).toEqual([[{ page: 1, perPage: 1000 }], [{ page: 2, perPage: 1000 }]]);
  });

  it('SCRUM478_AC2_leaves_the_email_empty_for_a_user_the_admin_api_does_not_return', async () => {
    const res = await get(listing(listed, null, []), ROLE.EVENT_ORGANISER);
    expect(res.status).toBe(200);
    expect(res.body.entries[0].attendeeEmail).toBeNull();
  });

  it('SCRUM478_AC2_leaves_the_email_empty_for_a_user_without_one', async () => {
    const res = await get(listing(listed, null, [{ id: ATTENDEE }]), ROLE.EVENT_ORGANISER);
    expect(res.status).toBe(200);
    expect(res.body.entries[0].attendeeEmail).toBeNull();
  });

  it('SCRUM478_AC2_skips_the_user_lookup_for_an_empty_list', async () => {
    const db = listing({ ...listed, entries: [] });
    expect((await get(db, ROLE.EVENT_ORGANISER)).status).toBe(200);
    expect(db.auth.admin.listUsers).not.toHaveBeenCalled();
  });

  it('SCRUM478_AC2_answers_503_when_the_admin_api_fails', async () => {
    const db = listing();
    db.auth.admin.listUsers.mockResolvedValue({ data: null, error: new Error('auth down') });
    const res = await get(db, ROLE.EVENT_ORGANISER);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/emails are temporarily unavailable/);
  });

  it('SCRUM478_AC1_answers_503_while_the_function_is_missing_and_500_for_anything_unexpected', async () => {
    const missing = await get(listing(null, { code: 'PGRST202', message: 'no function' }), ROLE.EVENT_ORGANISER);
    expect(missing.status).toBe(503);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const odd = await get(listing({ outcome: 'surprise' }), ROLE.EVENT_ORGANISER);
      expect(odd.status).toBe(500);
    } finally { log.mockRestore(); }
  });
});
