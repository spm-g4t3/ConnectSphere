import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  validateRegistrationEligibility, translateRegistrationEligibilityError,
} from '../../src/services/registrationEligibilityService.js';
import { createErrorHandler } from '../../src/http/handleError.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: { rpc } }));
const ME = '44444444-4444-4444-8444-444444444444';
const EVENT = '00000000-0000-4000-8000-00000000000a';
const options = { attendeeId: ME, eventId: EVENT };
afterEach(() => { vi.resetAllMocks(); });

describe('SCRUM38 registration eligibility service', () => {
  it('SCRUM38_AC1_checks_database_state_without_passing_client_role_status_or_time', async () => {
    rpc.mockResolvedValue({ error: null });
    await expect(validateRegistrationEligibility({
      ...options, client: { rpc }, role: 'attendee', status: 'confirmed', now: '2000-01-01',
      registrationEnabled: true,
    })).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledExactlyOnceWith('assert_event_registration_eligible', {
      p_attendee_id: ME, p_event_request_id: EVENT,
    });
  });

  it('SCRUM38_AC1_requires_an_authenticated_identity_before_accessing_the_database', async () => {
    await expect(validateRegistrationEligibility()).rejects.toMatchObject({ status: 401, message: 'Authentication required' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(['attendeeId', 'eventId'])('SCRUM38_AC6_validates_%s_before_database_access', async (field) => {
    await expect(validateRegistrationEligibility({ ...options, [field]: 'invalid' })).rejects.toMatchObject({
      status: 400, details: [{ field, message: 'must be a valid UUID' }],
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM38_AC1_uses_the_shared_client_when_none_is_injected', async () => {
    rpc.mockResolvedValue({ error: null });
    await expect(validateRegistrationEligibility(options)).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledOnce();
  });

  it.each([
    ['42501', null, 'This action is restricted to Attendees', 403],
    ['P0002', null, 'Event not found', 404],
    ['22023', null, 'An attendee and event are required', 400],
    ['55000', 'EVENT_NOT_CONFIRMED', 'Registration requires a Confirmed event', 404],
    ['55000', 'REGISTRATION_DISABLED', 'Registration is disabled for this event', 404],
    ['55000', 'REGISTRATION_NOT_OPEN', 'Registration has not opened yet', 404],
    ['55000', 'REGISTRATION_CLOSED', 'Registration has closed for this event', 404],
    ['55000', 'EVENT_STARTED', 'Registration is closed because the event has started', 404],
    ['55000', 'REGISTRATION_DATES_MISSING', 'Registration dates are not configured for this event', 404],
  ])('SCRUM38_AC6_maps_%s_%s_to_the_existing_API_format', async (code, hint, message, status) => {
    rpc.mockResolvedValue({ error: { code, hint, message } });
    const error = await validateRegistrationEligibility({ ...options, client: { rpc } }).catch((err) => err);
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    createErrorHandler('eligibility test')(error, res);
    expect(res.status).toHaveBeenCalledWith(status);
    const body = { error: status === 404 ? 'This event is not open for registration' : message };
    if (status === 409) Object.assign(body, { code: hint, conflicts: [] });
    if (status === 400) body.details = [];
    expect(res.json).toHaveBeenCalledWith(body);
  });

  it('SCRUM38_AC6_leaves_unexpected_database_errors_to_the_standard_handler', () => {
    const error = { code: 'XX000', message: 'internal database error' };
    expect(translateRegistrationEligibilityError(error)).toBe(error);
  });

  it.each(['42703', '42P01', 'PGRST202', 'PGRST204', 'PGRST205'])('SCRUM22_AC1_missing_schema_%s_is_a_safe_503', (code) => {
    expect(translateRegistrationEligibilityError({ code, message: 'Private schema details' }))
      .toMatchObject({ status: 503, message: 'Event registration is temporarily unavailable. Please try again later.' });
  });
});
