import { describe, expect, it, vi } from 'vitest';

import {
  getSafetyReview,
  listSafetyReviewHistory,
  listSafetyReviews,
  respondToSafetyReview,
} from '../../src/services/safetyReviewService.js';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const OFFICER_ID = '22222222-2222-4222-8222-222222222222';
const BOOKING_ID = '33333333-3333-4333-8333-333333333333';

function client(answer = { data: [], error: null }) {
  return { rpc: vi.fn(async () => answer) };
}

describe('Safety review service', () => {
  it('reads the oldest-first queue through the dedicated database function', async () => {
    const rows = [{ id: EVENT_ID, eventName: 'Annual Dinner' }];
    const db = client({ data: rows, error: null });

    await expect(listSafetyReviews({ client: db })).resolves.toEqual(rows);
    expect(db.rpc).toHaveBeenCalledWith('safety_review_queue', undefined);
  });

  it('reads past responses through the history function', async () => {
    const rows = [{ id: EVENT_ID, outcome: 'approved' }];
    const db = client({ data: rows, error: null });

    await expect(listSafetyReviewHistory({ client: db })).resolves.toEqual(rows);
    expect(db.rpc).toHaveBeenCalledWith('safety_review_history', undefined);
  });

  it('validates event ids before reading review details', async () => {
    const db = client();

    await expect(getSafetyReview('not-an-id', { client: db })).rejects.toThrow(/valid event request id/);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('passes only the signed-in officer and the selected response to the transaction', async () => {
    const response = { outcome: 'changes_requested' };
    const db = client({ data: response, error: null });

    await expect(
      respondToSafetyReview(
        EVENT_ID,
        {
          outcome: 'changes_requested',
          note: 'Move the stage and widen the exit route.',
          affectedBookingIds: [BOOKING_ID],
          equipmentAffected: false,
        },
        OFFICER_ID,
        { client: db },
      ),
    ).resolves.toEqual(response);

    expect(db.rpc).toHaveBeenCalledWith('respond_to_safety_review', {
      p_event_request_id: EVENT_ID,
      p_safety_officer_id: OFFICER_ID,
      p_outcome: 'changes_requested',
      p_note: 'Move the stage and widen the exit route.',
      p_affected_booking_ids: [BOOKING_ID],
      p_equipment_affected: false,
    });
  });

  it.each(['changes_requested', 'rejected'])('requires a note for %s', async (outcome) => {
    const db = client();

    await expect(
      respondToSafetyReview(EVENT_ID, { outcome }, OFFICER_ID, { client: db }),
    ).rejects.toThrow(/note is required/i);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('allows approval without a note', async () => {
    const db = client({ data: { outcome: 'approved' }, error: null });

    await expect(
      respondToSafetyReview(EVENT_ID, { outcome: 'approved' }, OFFICER_ID, { client: db }),
    ).resolves.toEqual({ outcome: 'approved' });
    expect(db.rpc.mock.calls[0][1].p_note).toBeNull();
  });

  it('does not allow approval to return arrangements for review', async () => {
    const db = client();

    await expect(
      respondToSafetyReview(
        EVENT_ID,
        { outcome: 'approved', affectedBookingIds: [BOOKING_ID] },
        OFFICER_ID,
        { client: db },
      ),
    ).rejects.toThrow(/only when requesting changes or rejecting/);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('translates a concurrent response refusal into a conflict with its current-status message', async () => {
    const db = client({
      data: null,
      error: {
        code: '55000',
        message: 'Event has status safety_approved, so it cannot receive a safety review response',
      },
    });

    await expect(
      respondToSafetyReview(EVENT_ID, { outcome: 'approved' }, OFFICER_ID, { client: db }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'SAFETY_REVIEW_NOT_ALLOWED',
      message: expect.stringContaining('safety_approved'),
    });
  });
});
