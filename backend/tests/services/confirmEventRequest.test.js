import { describe, it, expect, vi } from 'vitest';
import { confirmEventRequest } from '../../src/services/eventRequestService.js';

const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const COORDINATOR_ID = '44444444-4444-4444-8444-444444444444';
const confirm = (client, options = {}) => confirmEventRequest({
  client, eventRequestId: EVENT_ID, coordinatorId: COORDINATOR_ID, ...options,
});

describe('SCRUM-363: confirmation service', () => {
  it.each([false, true])('SCRUM363_AC6_confirmation_is_one_rpc_with_explicit_acknowledgement_%s', async (acknowledged) => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: {
      id: EVENT_ID, status: 'confirmed', assigned_coordinator_id: COORDINATOR_ID,
    }, error: null }) };

    await expect(confirm(client, { noEquipmentConfirmed: acknowledged })).resolves.toMatchObject({
      id: EVENT_ID, status: 'confirmed', assignedCoordinatorId: COORDINATOR_ID,
    });
    expect(client.rpc.mock.calls).toEqual([['confirm_event_request', {
      p_event_request_id: EVENT_ID, p_coordinator_id: COORDINATOR_ID, p_no_equipment_confirmed: acknowledged, p_expected_updated_at: null,
    }]]);
  });

  it.each([
    [{ eventRequestId: 'bad' }, 'id'],
    [{ coordinatorId: null }, 'coordinatorId'],
    [{ coordinatorId: 'bad' }, 'coordinatorId'],
    [{ noEquipmentConfirmed: 'true' }, 'noEquipmentConfirmed'],
    [{ noEquipmentConfirmed: null }, 'noEquipmentConfirmed'],
    [{ expectedUpdatedAt: '2026-06-01' }, 'expectedUpdatedAt'],
    [{ expectedUpdatedAt: '2026-06-01T09:00:00' }, 'expectedUpdatedAt'],
    [{ expectedUpdatedAt: 12 }, 'expectedUpdatedAt'],
  ])('SCRUM363_AC1_invalid_input_%j_is_refused_before_rpc', async (options, field) => {
    const client = { rpc: vi.fn() };
    await expect(confirm(client, options)).rejects.toMatchObject({ status: 400, details: [{ field, message: expect.any(String) }] });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['42501', 403], ['55000', 409], ['P0002', 404], ['40001', 409], ['22023', 400],
  ])('SCRUM363_AC1_database_%s_uses_the_established_error_response_%s', async (code, status) => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code, message: 'Confirmation refused' } }) };
    await expect(confirm(client)).rejects.toMatchObject({ status, message: 'Confirmation refused' });
  });

  it('SCRUM363_AC5_preserves_the_observed_database_revision_including_microseconds', async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: { id: EVENT_ID, status: 'confirmed' }, error: null }) };
    const expectedUpdatedAt = '2026-06-01T09:00:00.123456+00:00';
    await confirm(client, { expectedUpdatedAt, noEquipmentConfirmed: true });
    expect(client.rpc.mock.calls[0][1].p_expected_updated_at).toBe(expectedUpdatedAt);
  });

  it('SCRUM363_AC3_keeps_every_outstanding_readiness_condition', async () => {
    const conflicts = [
      { key: 'venue', met: false, detail: 'No venue booking' },
      { key: 'date', met: false, detail: "The event's start has passed" },
    ];
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error: {
      code: 'PT409', hint: 'EVENT_NOT_READY', message: 'This event is not ready for confirmation.', details: JSON.stringify(conflicts),
    } }) };
    await expect(confirm(client)).rejects.toMatchObject({ status: 409, code: 'EVENT_NOT_READY', conflicts });
  });

  it('SCRUM363_AC6_unexpected_database_failure_is_not_returned_as_success', async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: 'XX000', message: 'Database failure' } }) };
    await expect(confirm(client)).rejects.toThrow('Database failure');
  });
});
