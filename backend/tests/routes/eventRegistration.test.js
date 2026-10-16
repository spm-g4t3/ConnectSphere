import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createOpenEventRouter } from '../../src/routes/openEvents.js';
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
  return express().use(express.json()).use('/api/open-events', createOpenEventRouter({ client: db, requireAuth }));
}

describe('SCRUM36 registration submission endpoint', () => {
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
    ['REGISTRATION_CLOSED', 'Registration has closed for this event'],
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
