/**
 * SCRUM-355: the service's own guards, which the routes cannot reach because
 * the caller always comes from the token.
 */

import { describe, it, expect } from 'vitest';

import { reopenEventRequest, getEventDecisionHistory } from '../../src/services/eventRequestService.js';
import { ValidationError } from '../../src/errors.js';
import { createEventRequestClient, errorFrom } from '../fixtures/supabaseStubs.js';

const REQUEST_ID = '22222222-2222-4222-8222-222222222222';

describe('SCRUM-355: reopenEventRequest and getEventDecisionHistory', () => {
  it.each([undefined, '', '   '])('SCRUM355_AC1_a_reopen_with_no_caller_%j_queries_nothing', async (caller) => {
    const client = createEventRequestClient([]);

    expect(await errorFrom(reopenEventRequest(REQUEST_ID, caller, { client }))).toBeInstanceOf(ValidationError);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM355_AC3_a_history_read_with_no_caller_queries_nothing', async () => {
    const client = createEventRequestClient([]);

    expect(await errorFrom(getEventDecisionHistory(REQUEST_ID, undefined, null, { client })))
      .toBeInstanceOf(ValidationError);
    expect(client.calls).toHaveLength(0);
  });
});
