/**
 * SCRUM-355: the service's own guards, which the routes cannot reach because
 * the caller always comes from the token.
 */

import { describe, it, expect } from 'vitest';

import { reopenEventRequest, getEventDecisionHistory } from '../../src/services/eventRequestService.js';
import { ValidationError } from '../../src/errors.js';
import { ROLE } from '../../src/domain/userRole.js';
import { createEventRequestClient, errorFrom, ok } from '../fixtures/supabaseStubs.js';

const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const ORGANISER_ID = '11111111-1111-4111-8111-111111111111';
const COORDINATOR_ID = '44444444-4444-4444-8444-444444444444';

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

  it('SCRUM355_AC3_a_decision_recorded_without_a_note_reads_back_as_a_null_note', async () => {
    const entry = {
      id: '33333333-3333-4333-8333-333333333333',
      decision: 'approved',
      decided_by: COORDINATOR_ID,
      decided_at: '2026-10-01T00:00:00Z',
      superseded_reason: 'reopened',
      superseded_at: '2026-10-02T00:00:00Z',
    };
    const client = createEventRequestClient([
      ok({ id: REQUEST_ID, organiser_id: ORGANISER_ID, status: 'submitted', assigned_coordinator_id: COORDINATOR_ID }),
      ok([entry]),
      ok([{ id: COORDINATOR_ID, full_name: 'Carlos Coordinator' }]),
    ]);

    const history = await getEventDecisionHistory(REQUEST_ID, ORGANISER_ID, ROLE.EVENT_ORGANISER, { client });

    expect(history).toEqual([{
      id: entry.id,
      decision: 'approved',
      decisionNote: null,
      decidedByName: 'Carlos Coordinator',
      decidedAt: entry.decided_at,
      supersededReason: 'reopened',
      supersededAt: entry.superseded_at,
    }]);
    expect(client.calls.map((call) => call.table)).toEqual(['event_requests', 'event_request_decision_history', 'profiles']);
  });
});
