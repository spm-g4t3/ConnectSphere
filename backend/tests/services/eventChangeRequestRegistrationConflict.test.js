import { describe, expect, it, vi } from 'vitest';

import { processChangeRequest } from '../../src/services/eventChangeRequestService.js';
import { ConflictError, ValidationError } from '../../src/errors.js';

const CHANGE_REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const COORDINATOR_ID = '11111111-1111-4111-8111-111111111111';

function clientFor(error) {
  return {
    rpc: vi.fn().mockResolvedValue({ data: null, error }),
  };
}

describe('SCRUM-494 registration schedule conflicts', () => {
  it.each([
    'event_requests_registration_closes_before_start',
    'event_requests_withdrawal_before_start',
  ])('SCRUM494_AC1_blocks_approval_with_a_clear_message_for_%s', async (constraint) => {
    const client = clientFor({
      code: '23514',
      constraint,
      message: `new row violates check constraint "${constraint}"`,
    });

    await expect(processChangeRequest(
      CHANGE_REQUEST_ID,
      { decision: 'approved' },
      COORDINATOR_ID,
      { client },
    )).rejects.toMatchObject({
      name: 'ConflictError',
      code: 'REGISTRATION_SCHEDULE_CONFLICT',
      message: expect.stringContaining('Ask the organiser to adjust those settings'),
    });
  });

  it('SCRUM494_AC1_keeps_other_check_constraint_errors_as_validation_errors', async () => {
    const client = clientFor({
      code: '23514',
      constraint: 'event_requests_dates_ordered',
      message: 'new row violates check constraint "event_requests_dates_ordered"',
    });

    await expect(processChangeRequest(
      CHANGE_REQUEST_ID,
      { decision: 'approved' },
      COORDINATOR_ID,
      { client },
    )).rejects.toBeInstanceOf(ValidationError);
  });
});
