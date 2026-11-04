import { describe, expect, it, vi } from 'vitest';

import {
  getRegistrationSettings,
  updateRegistrationSettings,
} from '../../src/services/eventRegistrationService.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../src/errors.js';

const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const ORGANISER_ID = '11111111-1111-4111-8111-111111111111';

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

function settingsClient({ event, count = 0, eventError = null, countError = null }) {
  const eventQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: event, error: eventError }),
  };
  const countQuery = {
    eq: vi.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve({ count, error: countError }).then(resolve, reject),
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
      p_waitlist_enabled: null,
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
    expect(client.countFilters).toHaveBeenCalledWith('status', 'registered');
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

  it('SCRUM494_AC2_rejects_times_without_an_offset_on_each_field', async () => {
    const client = saveClient({ outcome: 'saved' });
    const error = await updateRegistrationSettings(
      EVENT_ID,
      {
        ...validSettings,
        opensAt: '2029-12-01T09:00:00',
        closesAt: '2030-01-01T12:00',
        withdrawalDeadline: '2030-01-01 11:00:00',
      },
      ORGANISER_ID,
      { client },
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.status).toBe(400);
    expect(error.details).toEqual([
      { field: 'registrationOpensAt', message: 'Enter a valid date and time.' },
      { field: 'registrationClosesAt', message: 'Enter a valid date and time.' },
      { field: 'registrationWithdrawalDeadline', message: 'Enter a valid date and time.' },
    ]);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['+08:00', '2026-11-01T10:00:00+08:00', '2026-11-01T02:00:00.000Z'],
    ['Z', '2026-11-01T10:00:00Z', '2026-11-01T10:00:00.000Z'],
  ])('SCRUM494_AC2_accepts_an_explicit_%s_offset_and_sends_the_UTC_instant', async (_label, sent, stored) => {
    const client = saveClient({ outcome: 'saved', settings: {}, registeredCount: 0 });

    await updateRegistrationSettings(
      EVENT_ID,
      { ...validSettings, opensAt: sent, closesAt: sent, withdrawalDeadline: sent },
      ORGANISER_ID,
      { client },
    );

    expect(client.rpc).toHaveBeenCalledWith('setup_event_registration', expect.objectContaining({
      p_opens_at: stored,
      p_closes_at: stored,
      p_withdrawal_deadline: stored,
    }));
  });

  it.each([true, [5], '1e2', '  ', 3000000000])(
    'SCRUM494_AC3_rejects_capacity_that_is_not_a_whole_number_in_range (%j)',
    async (capacity) => {
      const client = saveClient({ outcome: 'saved' });
      const error = await updateRegistrationSettings(
        EVENT_ID,
        { ...validSettings, capacity },
        ORGANISER_ID,
        { client },
      ).catch((caught) => caught);

      expect(error).toBeInstanceOf(ValidationError);
      expect(error.details).toEqual([{
        field: 'registrationCapacity',
        message: capacity === 3000000000 ? 'Must be 2147483647 or fewer.' : 'Must be a whole number.',
      }]);
      expect(client.rpc).not.toHaveBeenCalled();
    },
  );

  it('SCRUM494_AC2_rejects_an_event_id_that_is_not_a_uuid_before_the_database_call', async () => {
    const client = saveClient({ outcome: 'saved' });
    const error = await updateRegistrationSettings('not-a-uuid', validSettings, ORGANISER_ID, { client })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('eventRequestId must be a valid UUID');
    expect(error.details).toEqual([{ field: 'eventRequestId', message: 'Must be a valid UUID.' }]);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it.each([null, 'enabled', [validSettings]])(
    'SCRUM494_AC2_rejects_settings_that_are_not_an_object (%j)',
    async (input) => {
      const client = saveClient({ outcome: 'saved' });
      await expect(updateRegistrationSettings(EVENT_ID, input, ORGANISER_ID, { client }))
        .rejects.toMatchObject({ name: 'ValidationError', message: 'Registration settings must be an object.' });
      expect(client.rpc).not.toHaveBeenCalled();
    },
  );

  it('SCRUM494_AC2_rejects_an_on_off_switch_that_is_not_true_or_false', async () => {
    const client = saveClient({ outcome: 'saved' });
    const error = await updateRegistrationSettings(
      EVENT_ID,
      { ...validSettings, enabled: 'yes' },
      ORGANISER_ID,
      { client },
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.details).toEqual([{ field: 'registrationEnabled', message: 'Must be true or false.' }]);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM494_AC3_accepts_capacity_sent_as_a_string_of_digits', async () => {
    const client = saveClient({ outcome: 'saved', settings: {}, registeredCount: 0 });

    await updateRegistrationSettings(EVENT_ID, { ...validSettings, capacity: '25' }, ORGANISER_ID, { client });

    expect(client.rpc).toHaveBeenCalledWith('setup_event_registration', expect.objectContaining({
      p_capacity: 25,
    }));
  });

  it.each([0, '-3'])('SCRUM494_AC3_rejects_capacity_below_one (%j)', async (capacity) => {
    const client = saveClient({ outcome: 'saved' });
    const error = await updateRegistrationSettings(
      EVENT_ID,
      { ...validSettings, capacity },
      ORGANISER_ID,
      { client },
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.details).toEqual([
      { field: 'registrationCapacity', message: 'Must be a whole number above zero.' },
    ]);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM494_AC2_reports_a_missing_event_from_the_database_as_not_found', async () => {
    const client = saveClient({ outcome: 'not_found' });
    await expect(updateRegistrationSettings(EVENT_ID, validSettings, ORGANISER_ID, { client }))
      .rejects.toMatchObject({ name: 'NotFoundError', message: 'Event not found.' });
  });

  it('SCRUM494_AC2_fails_loudly_on_an_outcome_the_service_does_not_know', async () => {
    const client = saveClient({ outcome: 'surprise' });
    await expect(updateRegistrationSettings(EVENT_ID, validSettings, ORGANISER_ID, { client }))
      .rejects.toThrow('Unexpected setup_event_registration outcome: surprise');
  });

  describe('getRegistrationSettings', () => {
    const ownedEvent = { id: EVENT_ID, organiser_id: ORGANISER_ID, status: 'approved' };

    it('SCRUM494_AC3_rejects_an_event_id_that_is_not_a_uuid', async () => {
      const client = settingsClient({ event: ownedEvent });
      await expect(getRegistrationSettings('not-a-uuid', ORGANISER_ID, { client }))
        .rejects.toMatchObject({ name: 'ValidationError', message: 'eventRequestId must be a valid UUID' });
      expect(client.from).not.toHaveBeenCalled();
    });

    it('SCRUM494_AC3_passes_on_a_failed_event_read', async () => {
      const eventError = { code: 'XX000', message: 'read failed' };
      const client = settingsClient({ event: null, eventError });
      await expect(getRegistrationSettings(EVENT_ID, ORGANISER_ID, { client })).rejects.toBe(eventError);
      expect(client.from).toHaveBeenCalledWith('event_requests');
      expect(client.countSelect).not.toHaveBeenCalled();
    });

    it('SCRUM494_AC3_reports_a_missing_event_as_not_found', async () => {
      const client = settingsClient({ event: null });
      const error = await getRegistrationSettings(EVENT_ID, ORGANISER_ID, { client }).catch((caught) => caught);
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error.message).toBe('Event not found.');
    });

    it('SCRUM494_AC3_shows_settings_only_to_the_organiser_who_created_the_event', async () => {
      const client = settingsClient({ event: { ...ownedEvent, organiser_id: '33333333-3333-4333-8333-333333333333' } });
      const error = await getRegistrationSettings(EVENT_ID, ORGANISER_ID, { client }).catch((caught) => caught);
      expect(error).toBeInstanceOf(ForbiddenError);
      expect(error.message).toBe('Only the Event Organiser who created this event can view its registration settings.');
      expect(client.countSelect).not.toHaveBeenCalled();
    });

    it('SCRUM494_AC3_passes_on_a_failed_registration_count', async () => {
      const countError = { code: 'XX000', message: 'count failed' };
      const client = settingsClient({ event: ownedEvent, countError });
      await expect(getRegistrationSettings(EVENT_ID, ORGANISER_ID, { client })).rejects.toBe(countError);
    });

    it('SCRUM494_AC3_reads_a_missing_count_as_zero', async () => {
      // A head count query always returns a number; null is a defensive fallback.
      const client = settingsClient({ event: ownedEvent, count: null });
      await expect(getRegistrationSettings(EVENT_ID, ORGANISER_ID, { client })).resolves.toMatchObject({
        settings: { registeredCount: 0, waitlistCount: 0, waitlistEnabled: false },
      });
    });
  });
});
