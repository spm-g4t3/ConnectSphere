import { describe, expect, it } from 'vitest';

import {
  cancelEventRequest,
  getEventCancellationImpact,
} from '../../src/services/eventRequestService.js';
import { ValidationError } from '../../src/errors.js';

const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const COORDINATOR_ID = '44444444-4444-4444-8444-444444444444';

function createRpcClient(response) {
  const calls = [];
  return {
    calls,
    rpc(fn, args) {
      calls.push({ fn, args });
      return Promise.resolve(response);
    },
  };
}

const storedEvent = {
  id: EVENT_ID,
  organiser_id: '11111111-1111-4111-8111-111111111111',
  event_name: 'Industry Night',
  status: 'cancelled',
  cancellation_reason: 'Organiser withdrew',
  cancellation_initiator: 'organiser_request',
  cancelled_by: COORDINATOR_ID,
  cancelled_at: '2026-06-01T09:00:00Z',
};

describe('SCRUM-375 cancellation service', () => {
  it('reads the cancellation impact through the read-only database function', async () => {
    const impact = { venueBookings: { count: 1, details: [] } };
    const client = createRpcClient({ data: impact, error: null });

    await expect(getEventCancellationImpact(EVENT_ID, { client })).resolves.toEqual(impact);
    expect(client.calls).toEqual([{
      fn: 'event_cancellation_impact_preview',
      args: { p_event_request_id: EVENT_ID },
    }]);
  });

  it('sends coordinator identity from the route and maps the cancelled row', async () => {
    const client = createRpcClient({ data: storedEvent, error: null });

    await expect(
      cancelEventRequest(
        EVENT_ID,
        {
          reason: '  Organiser withdrew  ',
          initiator: 'organiser_request',
          attendeeMessage: '  We hope to see you soon.  ',
        },
        COORDINATOR_ID,
        { client },
      ),
    ).resolves.toMatchObject({
      id: EVENT_ID,
      status: 'cancelled',
      cancellationReason: 'Organiser withdrew',
      cancellationInitiator: 'organiser_request',
      cancelledBy: COORDINATOR_ID,
      cancelledAt: '2026-06-01T09:00:00Z',
    });
    expect(client.calls).toEqual([{
      fn: 'cancel_event_request',
      args: {
        p_event_request_id: EVENT_ID,
        p_coordinator_id: COORDINATOR_ID,
        p_reason: 'Organiser withdrew',
        p_initiator: 'organiser_request',
        p_attendee_message: 'We hope to see you soon.',
      },
    }]);
  });

  it.each([
    [{ reason: '  ', initiator: 'organiser_request' }, COORDINATOR_ID],
    [{ reason: 'Reason', initiator: '' }, COORDINATOR_ID],
    [{ reason: 'Reason', initiator: 'unknown' }, COORDINATOR_ID],
    [{ reason: 'Reason', initiator: 'organiser_request' }, ' '],
  ])('rejects invalid cancellation data before the database call', async (input, coordinatorId) => {
    const client = createRpcClient({ data: storedEvent, error: null });

    await expect(
      cancelEventRequest(EVENT_ID, input, coordinatorId, { client }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.calls).toHaveLength(0);
  });
});
