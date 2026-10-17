import { describe, expect, it, vi } from 'vitest';

import {
  getRegistrationSettings,
  listOpenRegistrationEvents,
  updateRegistrationSettings,
} from '../../src/services/eventRegistrationService.js';
import { listOpenEventsForRegistration } from '../../src/services/openEventService.js';
import { ConflictError, ForbiddenError, ValidationError } from '../../src/errors.js';

vi.mock('../../src/services/openEventService.js', () => ({
  listOpenEventsForRegistration: vi.fn(),
}));

const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const ORGANISER_ID = '11111111-1111-4111-8111-111111111111';
const ATTENDEE_ID = '33333333-3333-4333-8333-333333333333';

const validSettings = {
  enabled: true,
  opensAt: '2029-12-01T09:00:00.000Z',
  closesAt: '2030-01-01T12:00:00.000Z',
  capacity: 10,
  withdrawalDeadline: '2030-01-01T11:00:00.000Z',
};

function saveClient(rpcResult, rpcError = null) {
  return {
    from: vi.fn(),
    rpc: vi.fn().mockResolvedValue({ data: rpcResult, error: rpcError }),
  };
}

function settingsClient({ event, count = 0 }) {
  const eventQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: event, error: null }),
  };
  const countQuery = {
    eq: vi.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve({ count, error: null }).then(resolve, reject),
  };
  const countSelect = vi.fn(() => countQuery);
  return {
    from: vi.fn((table) => table === 'event_requests' ? eventQuery : {
      select: countSelect,
    }),
    countSelect,
    countFilters: countQuery.eq,
  };
}

describe('SCRUM-494 registration settings and attendee listings', () => {
  it('SCRUM494_AC1_leaves_cross_field_validation_and_capacity_checks_to_the_locked_database_function', async () => {
    const details = [
      { field: 'registrationOpensAt', message: 'Must be before the closing date and time.' },
      { field: 'registrationCapacity', message: 'Cannot be below the 2 attendees already registered.' },
    ];
    const client = saveClient({ outcome: 'invalid', details });

    await expect(updateRegistrationSettings(
      EVENT_ID,
      { ...validSettings, capacity: 1 },
      ORGANISER_ID,
      { client },
    )).rejects.toMatchObject({ name: 'ValidationError', details });
    expect(client.from).not.toHaveBeenCalled();
    expect(client.rpc).toHaveBeenCalledTimes(1);
  });

  it('SCRUM494_AC2_sends_normalized_settings_in_one_transactional_call', async () => {
    const client = saveClient({
      outcome: 'saved',
      settings: {
        enabled: true,
        opensAt: validSettings.opensAt,
        closesAt: validSettings.closesAt,
        capacity: 10,
        withdrawalDeadline: validSettings.withdrawalDeadline,
      },
      registeredCount: 0,
    });

    await expect(updateRegistrationSettings(EVENT_ID, validSettings, ORGANISER_ID, { client }))
      .resolves.toMatchObject({ enabled: true, capacity: 10, registeredCount: 0 });
    expect(client.from).not.toHaveBeenCalled();
    expect(client.rpc).toHaveBeenCalledWith('setup_event_registration', {
      p_event_request_id: EVENT_ID,
      p_user_id: ORGANISER_ID,
      p_enabled: true,
      p_opens_at: validSettings.opensAt,
      p_closes_at: validSettings.closesAt,
      p_capacity: 10,
      p_withdrawal_deadline: validSettings.withdrawalDeadline,
    });
  });

  it('SCRUM494_AC2_reports_ownership_and_lifecycle_conflicts_from_the_database', async () => {
    const forbiddenClient = saveClient({ outcome: 'forbidden' });
    await expect(updateRegistrationSettings(EVENT_ID, validSettings, ORGANISER_ID, { client: forbiddenClient }))
      .rejects.toBeInstanceOf(ForbiddenError);

    const statusClient = saveClient({ outcome: 'status_not_allowed', status: 'under_review' });
    await expect(updateRegistrationSettings(EVENT_ID, validSettings, ORGANISER_ID, { client: statusClient }))
      .rejects.toMatchObject({ name: 'ConflictError', message: expect.stringContaining('Under review') });
  });

  it('SCRUM494_AC3_counts_only_active_registrations_in_organiser_settings', async () => {
    const client = settingsClient({
      count: 4,
      event: {
        id: EVENT_ID,
        organiser_id: ORGANISER_ID,
        status: 'approved',
        proposed_start: '2030-01-01T12:00:00.000Z',
        registration_enabled: true,
        registration_opens_at: validSettings.opensAt,
        registration_closes_at: validSettings.closesAt,
        registration_capacity: 10,
        registration_withdrawal_deadline: validSettings.withdrawalDeadline,
      },
    });

    await expect(getRegistrationSettings(EVENT_ID, ORGANISER_ID, { client })).resolves.toMatchObject({
      status: 'approved',
      settings: { enabled: true, capacity: 10, registeredCount: 4 },
    });
    expect(client.countSelect).toHaveBeenCalledWith('id', {
      count: 'exact',
      head: true,
    });
    expect(client.countFilters).toHaveBeenLastCalledWith('status', 'registered');
  });

  it('SCRUM494_AC4_uses_the_shared_open_event_eligibility_and_registration_state', async () => {
    const now = new Date('2030-01-01T10:00:00.000Z');
    const events = [{
      id: EVENT_ID,
      eventName: 'Industry Night',
      startsAt: '2030-01-01T12:00:00.000Z',
      registrationOpensAt: '2030-01-01T09:00:00.000Z',
      registrationClosesAt: '2030-01-01T11:00:00.000Z',
      capacity: 10,
      registeredCount: 10,
      isRegistered: true,
      isFull: true,
    }];
    listOpenEventsForRegistration.mockResolvedValue(events);

    await expect(listOpenRegistrationEvents(ATTENDEE_ID, { now })).resolves.toEqual([{
      id: EVENT_ID,
      eventName: 'Industry Night',
      description: undefined,
      startsAt: '2030-01-01T12:00:00.000Z',
      registrationOpensAt: '2030-01-01T09:00:00.000Z',
      registrationClosesAt: '2030-01-01T11:00:00.000Z',
      capacity: 10,
      registeredCount: 10,
      isRegistered: true,
      isFull: true,
    }]);
    expect(listOpenEventsForRegistration).toHaveBeenCalledWith({
      attendeeId: ATTENDEE_ID,
      client: undefined,
      now,
    });
  });

  it('SCRUM494_AC2_rejects_malformed_settings_before_the_database_call', async () => {
    const client = saveClient({ outcome: 'saved' });
    const error = await updateRegistrationSettings(
      EVENT_ID,
      { ...validSettings, opensAt: 'not-a-date' },
      ORGANISER_ID,
      { client },
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.details).toContainEqual(expect.objectContaining({ field: 'registrationOpensAt' }));
    expect(client.rpc).not.toHaveBeenCalled();
  });
});
