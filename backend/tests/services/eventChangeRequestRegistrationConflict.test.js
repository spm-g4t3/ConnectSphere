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
  it('SCRUM494_AC1_blocks_approval_with_a_clear_message_on_a_start_time_clash', async () => {
    // The shape Supabase returns: a SQLSTATE and message only, never a constraint name.
    const client = clientFor({
      code: 'RS409',
      message: 'The new event start is earlier than the registration closing time.',
      details: null,
      hint: null,
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
