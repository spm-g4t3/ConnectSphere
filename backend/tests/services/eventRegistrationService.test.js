import { describe, expect, it, vi } from 'vitest';

import {
  getRegistrationSettings,
  updateRegistrationSettings,
} from '../../src/services/eventRegistrationService.js';
import { ConflictError, ForbiddenError, ValidationError } from '../../src/errors.js';

const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const ORGANISER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '33333333-3333-4333-8333-333333333333';

function clientFor({ event = {}, count = 0, rpcResult = {} } = {}) {
  const row = {
    id: EVENT_ID,
    organiser_id: ORGANISER_ID,
    status: 'approved',
    proposed_start: '2030-01-01T12:00:00.000Z',
    ...event,
  };
  const eventQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
  };
  const registrationsQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockResolvedValue({ count, error: null }),
  };
  return {
    from: vi.fn((table) => table === 'event_requests' ? eventQuery : registrationsQuery),
    rpc: vi.fn().mockResolvedValue({ data: rpcResult, error: null }),
  };
}

const validSettings = {
  enabled: true,
  opensAt: '2029-12-01T09:00:00.000Z',
  closesAt: '2030-01-01T12:00:00.000Z',
  capacity: 10,
  withdrawalDeadline: '2030-01-01T11:00:00.000Z',
};

describe('SCRUM-363 registration settings service', () => {
  it('collects opening, closing, withdrawal and registered-capacity faults in one response', async () => {
    const client = clientFor({ count: 2 });
    const error = await updateRegistrationSettings(
      EVENT_ID,
      {
        ...validSettings,
        opensAt: '2030-01-01T14:00:00.000Z',
        closesAt: '2030-01-01T13:00:00.000Z',
        withdrawalDeadline: '2030-01-01T13:00:00.000Z',
        capacity: 1,
      },
      ORGANISER_ID,
      { client },
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.details.map(({ field }) => field)).toEqual([
      'registrationOpensAt',
      'registrationClosesAt',
      'registrationWithdrawalDeadline',
      'registrationCapacity',
    ]);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('explains ownership and lifecycle refusals before validating submitted settings', async () => {
    const foreignEvent = clientFor({ event: { organiser_id: OTHER_USER_ID } });
    await expect(updateRegistrationSettings(EVENT_ID, {}, ORGANISER_ID, { client: foreignEvent }))
      .rejects.toThrow(ForbiddenError);

    const inReview = clientFor({ event: { status: 'under_review' } });
    const statusError = await updateRegistrationSettings(
      EVENT_ID,
      {},
      ORGANISER_ID,
      { client: inReview },
    ).catch((error) => error);
    expect(statusError).toBeInstanceOf(ConflictError);
    expect(statusError.message).toContain('Current status: under_review');
  });

  it('returns the current settings and count for the owning organiser', async () => {
    const client = clientFor({
      count: 4,
      event: {
        registration_enabled: true,
        registration_opens_at: validSettings.opensAt,
        registration_closes_at: validSettings.closesAt,
        registration_capacity: 10,
        registration_withdrawal_deadline: validSettings.withdrawalDeadline,
      },
    });

    await expect(getRegistrationSettings(EVENT_ID, ORGANISER_ID, { client })).resolves.toMatchObject({
      status: 'approved',
      settings: {
        enabled: true,
        capacity: 10,
        registeredCount: 4,
      },
    });
  });

  it('writes valid settings through the transactional database function', async () => {
    const client = clientFor({
      rpcResult: {
        outcome: 'saved',
        settings: {
          enabled: true,
          opensAt: validSettings.opensAt,
          closesAt: validSettings.closesAt,
          capacity: 10,
          withdrawalDeadline: validSettings.withdrawalDeadline,
        },
        registeredCount: 0,
      },
    });

    await expect(updateRegistrationSettings(EVENT_ID, validSettings, ORGANISER_ID, { client }))
      .resolves.toMatchObject({ enabled: true, capacity: 10, registeredCount: 0 });
    expect(client.rpc).toHaveBeenCalledWith('setup_event_registration', expect.objectContaining({
      p_event_request_id: EVENT_ID,
      p_user_id: ORGANISER_ID,
      p_capacity: 10,
    }));
  });
});
