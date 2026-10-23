import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  translateWithdrawalError, validateWithdrawalIdentity, withdrawRegistration,
} from '../../src/services/registrationWithdrawalService.js';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: { rpc } }));
const ME = '44444444-4444-4444-8444-444444444444';
const REGISTRATION = '00000000-0000-4000-8000-00000000000b';
const EVENT = '00000000-0000-4000-8000-00000000000a';
const options = { attendeeId: ME, registrationId: REGISTRATION };
const registration = {
  id: REGISTRATION, eventRequestId: EVENT, attendeeId: ME, status: 'withdrawn',
  registeredAt: '2026-10-12T10:00:00Z', createdAt: '2026-10-12T10:00:00Z', updatedAt: '2026-10-16T10:00:00Z',
};
afterEach(() => { vi.resetAllMocks(); });

describe('SCRUM27 withdrawal service', () => {
  it('SCRUM27_AC3_sends_only_the_verified_ids_to_one_RPC_and_returns_the_withdrawn_registration', async () => {
    rpc.mockResolvedValue({ data: { outcome: 'withdrawn', registration: { ...registration, extra: 'dropped' } }, error: null });
    await expect(withdrawRegistration({ ...options, client: { rpc }, status: 'registered', now: '2000-01-01' }))
      .resolves.toEqual(registration);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('withdraw_registration', {
      p_registration_id: REGISTRATION, p_attendee_id: ME,
    });
  });

  it('SCRUM27_AC3_uses_the_shared_client_when_none_is_injected', async () => {
    rpc.mockResolvedValue({ data: { outcome: 'withdrawn', registration }, error: null });
    await expect(withdrawRegistration(options)).resolves.toMatchObject({ id: REGISTRATION });
  });

  it('SCRUM27_AC1_checks_identity_before_database_access', async () => {
    await expect(withdrawRegistration({ registrationId: REGISTRATION })).rejects.toMatchObject({ status: 401 });
    await expect(withdrawRegistration({ ...options, registrationId: 'invalid' })).rejects.toMatchObject({ status: 400 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM27_AC7_translates_a_refusal', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '55000', hint: 'ALREADY_WITHDRAWN', message: 'This registration has already been withdrawn' } });
    await expect(withdrawRegistration(options)).rejects.toMatchObject({ status: 409, code: 'ALREADY_WITHDRAWN' });
  });

  it.each([null, { outcome: 'registered', registration }, { outcome: 'withdrawn' }])
    ('SCRUM27_AC3_an_unexpected_result_%#_is_an_error_not_a_success', async (data) => {
      rpc.mockResolvedValue({ data, error: null });
      await expect(withdrawRegistration(options)).rejects.toThrow('Unexpected outcome from withdraw_registration');
    });
});

describe('SCRUM27 withdrawal eligibility refusals', () => {
  it.each(['REGISTRATION_NOT_FOUND', 'REGISTRATION_NOT_OWNED'])
    ('SCRUM27_AC1_%s_is_the_same_404_so_ownership_is_not_disclosed', (hint) => {
      const error = translateWithdrawalError({ code: 'P0002', hint, message: 'Registration not found' });
      expect(error).toMatchObject({ status: 404, message: 'Registration not found' });
      expect(error).not.toHaveProperty('code');
    });

  it.each([
    ['ALREADY_WITHDRAWN', 'This registration has already been withdrawn'],
    ['REGISTRATION_NOT_CONFIRMED', 'Only a confirmed registration can be withdrawn'],
    ['WITHDRAWAL_DEADLINE_NOT_SET', 'This event has no withdrawal deadline, so registrations cannot be withdrawn'],
    ['WITHDRAWAL_DEADLINE_PASSED', 'The withdrawal deadline for this event has passed'],
  ])('SCRUM27_AC7_%s_is_a_409_carrying_its_reason', (hint, message) => {
    expect(translateWithdrawalError({ code: '55000', hint, message }))
      .toMatchObject({ status: 409, code: hint, message });
  });

  it('SCRUM27_AC1_a_caller_who_is_not_an_attendee_is_forbidden', () => {
    expect(translateWithdrawalError({ code: '42501', message: 'This action is restricted to Attendees' }))
      .toMatchObject({ status: 403, message: 'This action is restricted to Attendees' });
  });

  it('SCRUM27_AC1_a_missing_argument_is_a_400', () => {
    expect(translateWithdrawalError({ code: '22023', message: 'An attendee and registration are required' }))
      .toMatchObject({ status: 400 });
  });

  it.each(['40001', '40P01'])('SCRUM27_AC7_a_%s_race_asks_the_attendee_to_retry', (code) => {
    expect(translateWithdrawalError({ code, message: 'could not serialize access' }))
      .toMatchObject({ status: 409, code: 'REGISTRATION_CHANGED' });
  });

  it.each(['42703', '42P01', 'PGRST202', 'PGRST204', 'PGRST205'])('SCRUM27_AC7_missing_schema_%s_is_a_safe_503', (code) => {
    expect(translateWithdrawalError({ code, message: 'Private schema details' }))
      .toMatchObject({ status: 503, message: 'Registration withdrawal is temporarily unavailable. Please try again later.' });
  });

  it('SCRUM27_AC7_an_unexpected_error_stays_untyped', () => {
    expect(translateWithdrawalError({ code: 'XX000', message: 'boom' })).not.toHaveProperty('status');
  });
});

describe('SCRUM27 withdrawal identity', () => {
  it('SCRUM27_AC1_requires_an_authenticated_attendee', () => {
    expect(() => validateWithdrawalIdentity({ registrationId: REGISTRATION }))
      .toThrow(expect.objectContaining({ status: 401 }));
  });

  it.each(['attendeeId', 'registrationId'])('SCRUM27_AC1_validates_%s_as_a_uuid', (field) => {
    expect(() => validateWithdrawalIdentity({ attendeeId: ME, registrationId: REGISTRATION, [field]: 'invalid' }))
      .toThrow(expect.objectContaining({ status: 400, details: [{ field, message: 'must be a valid UUID' }] }));
  });

  it('SCRUM27_AC1_accepts_two_uuids', () => {
    expect(() => validateWithdrawalIdentity({ attendeeId: ME, registrationId: REGISTRATION })).not.toThrow();
  });
});
