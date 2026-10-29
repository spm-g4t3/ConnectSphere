/**
 * Service tests for the "reviewed by me" list.
 *
 * SCRUM-582. Named SCRUM582_AC<n>_<what_it_checks>. The client is a test
 * double, so these are about what the service sends and how the answer is
 * reshaped. What the database does is tested in
 * tests/db/scrum582ReviewedByMeDatabase.test.js.
 */

import { describe, it, expect, vi } from 'vitest';
import { ok, dbError } from '../fixtures/supabaseStubs.js';

const defaultClient = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: defaultClient, supabaseAdmin: {} }));

import { getRequestsReviewedByMe, toReviewedRow } from '../../src/services/equipmentQueueService.js';
import { ForbiddenError } from '../../src/errors.js';

const CALLER_ID = '77777777-7777-4777-8777-777777777777';

const fakeClient = (answer = ok({ requests: [], total: 0, truncated: false })) => ({
  rpc: vi.fn(async () => answer),
  from: vi.fn(),
});

describe('toReviewedRow', () => {
  it('SCRUM582_AC2_a_row_with_no_interruption_has_null_reason_and_time', () => {
    expect(
      toReviewedRow({
        event_request_id: 'e1',
        event_name: 'Dinner',
        status: 'under_review',
        last_worked_at: '2030-01-05T09:00:00+00:00',
        returned_to_pending: false,
        interrupted_reason: null,
        interrupted_at: null,
      }),
    ).toMatchObject({
      statusLabel: 'Under review',
      returnedToPending: false,
      interruptedReason: null,
      interruptedAt: null,
      proposedStart: null,
      proposedEnd: null,
    });
  });

  it('SCRUM582_AC3_returnedToPending_is_true_only_for_an_actual_true', () => {
    expect(toReviewedRow({ returned_to_pending: 'yes' }).returnedToPending).toBe(false);
    expect(toReviewedRow({ returned_to_pending: true }).returnedToPending).toBe(true);
  });
});

describe('getRequestsReviewedByMe', () => {
  it('SCRUM582_AC5_calls_the_one_function_for_the_caller_alone', async () => {
    const client = fakeClient();
    await getRequestsReviewedByMe({ callerId: CALLER_ID, client });
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith('equipment_reviewed_by_me', { p_caller: CALLER_ID });
    expect(client.from).not.toHaveBeenCalled();
  });

  it('SCRUM582_AC5_passes_a_null_caller_so_the_database_refuses_it', async () => {
    const client = fakeClient();
    await getRequestsReviewedByMe({ client });
    expect(client.rpc).toHaveBeenCalledWith('equipment_reviewed_by_me', { p_caller: null });
  });

  it('SCRUM582_AC1_reshapes_the_answer_and_keeps_the_total_and_the_cut_flag', async () => {
    const client = fakeClient(
      ok({ requests: [{ event_request_id: 'e1', event_name: 'Dinner', status: 'arranged' }], total: '3', truncated: true }),
    );
    const result = await getRequestsReviewedByMe({ callerId: CALLER_ID, client });
    expect(result.total).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({ eventRequestId: 'e1', statusLabel: 'Arranged' });
  });

  it('SCRUM582_AC5_a_42501_from_the_database_is_a_ForbiddenError', async () => {
    const client = fakeClient(dbError('42501', 'Only technical support staff can see the requests they have reviewed'));
    await expect(getRequestsReviewedByMe({ callerId: CALLER_ID, client })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('SCRUM582_AC5_any_other_database_error_is_not_turned_into_a_typed_error', async () => {
    const client = fakeClient(dbError('XX000', 'boom'));
    await expect(getRequestsReviewedByMe({ callerId: CALLER_ID, client })).rejects.not.toBeInstanceOf(ForbiddenError);
  });
});
