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
  const endpoints = [`/api/open-events/${EVENT}/registrations`, `/api/registration/events/${EVENT}/register`];

  it.each(endpoints)('SCRUM22_AC4_both_endpoints_share_PR68_success_duplicate_and_capacity_outcomes_at_%s', async (path) => {
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
