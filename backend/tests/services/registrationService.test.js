import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerForEvent } from '../../src/services/registrationService.js';
import { createErrorHandler } from '../../src/http/handleError.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: { rpc } }));
const ME = '44444444-4444-4444-8444-444444444444';
const EVENT = '00000000-0000-4000-8000-00000000000a';
const options = { attendeeId: ME, eventId: EVENT };
const row = {
  id: '11111111-1111-4111-8111-111111111111', event_request_id: EVENT,
  attendee_id: ME, status: 'registered', created_at: '2026-10-16T10:00:00Z',
  updated_at: '2026-10-16T10:00:00Z', private_field: 'not returned',
};
afterEach(() => { vi.resetAllMocks(); });

describe('SCRUM39 registration service', () => {
  it('SCRUM39_AC4_uses_one_atomic_RPC_and_ignores_client_capacity_role_and_status', async () => {
    rpc.mockResolvedValue({ data: { outcome: 'registered', registration: row }, error: null });
    const result = await registerForEvent({
      ...options, client: { rpc }, capacity: 999, activeCount: 0,
      role: 'attendee', status: 'confirmed', now: '2000-01-01',
    });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('register_for_event', {
      p_event_request_id: EVENT, p_attendee_id: ME,
    });
    expect(result).toEqual({
      id: row.id, eventRequestId: EVENT, attendeeId: ME, status: 'registered',
      createdAt: row.created_at, updatedAt: row.updated_at,
    });
  });

  it('SCRUM39_AC4_uses_the_shared_client_without_a_separate_preflight', async () => {
    rpc.mockResolvedValue({ data: { outcome: 'registered', registration: row }, error: null });
    await expect(registerForEvent(options)).resolves.toMatchObject({ id: row.id });
    expect(rpc).toHaveBeenCalledOnce();
  });

  it('SCRUM39_AC5_requires_a_verified_identity_before_database_access', async () => {
    await expect(registerForEvent()).rejects.toMatchObject({ status: 401, message: 'Authentication required' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(['attendeeId', 'eventId'])('SCRUM39_AC5_refuses_an_invalid_%s_before_database_access', async (field) => {
    await expect(registerForEvent({ ...options, [field]: 'invalid', client: { rpc } })).rejects.toMatchObject({ status: 400 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['EVENT_FULL', 'Event is full'], ['ALREADY_REGISTERED', 'Already registered'],
  ])('SCRUM39_AC1_AC2_returns_the_existing_conflict_response_for_%s', async (code, message) => {
    rpc.mockResolvedValue({ data: null, error: { code: '55000', hint: code, message } });
    const error = await registerForEvent({ ...options, client: { rpc } }).catch((err) => err);
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    createErrorHandler('registration test')(error, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: message, code, conflicts: [] });
  });

  it('SCRUM39_AC5_reuses_the_eligibility_error_format', async () => {
    rpc.mockResolvedValue({ error: { code: '42501', message: 'This action is restricted to Attendees' } });
    await expect(registerForEvent({ ...options, client: { rpc } })).rejects.toMatchObject({ status: 403 });
  });

  it.each([null, { outcome: 'unknown' }, { outcome: 'registered', registration: {} }])
    ('SCRUM39_AC5_refuses_an_invalid_RPC_success_result_%j', async (data) => {
      rpc.mockResolvedValue({ data, error: null });
      await expect(registerForEvent({ ...options, client: { rpc } })).rejects.toThrow('Unexpected outcome from register_for_event');
    });

  it('SCRUM39_AC5_preserves_unexpected_database_failures_for_the_standard_handler', async () => {
    const error = { code: '23503', message: 'foreign key failure' };
    rpc.mockResolvedValue({ error });
    await expect(registerForEvent({ ...options, client: { rpc } })).rejects.toBe(error);
  });
});
