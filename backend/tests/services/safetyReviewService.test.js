import { describe, expect, it, vi } from 'vitest';

import {
  getSafetyReview,
  listSafetyReviewHistory,
  listSafetyReviews,
  respondToSafetyReview,
} from '../../src/services/safetyReviewService.js';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../../src/errors.js';

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

    await expect(listSafetyReviews(OFFICER_ID, { client: db })).resolves.toEqual(rows);
    expect(db.rpc).toHaveBeenCalledWith('safety_review_queue', { p_caller: OFFICER_ID });
  });

  it('reads past responses through the history function', async () => {
    const rows = [{ id: EVENT_ID, outcome: 'approved' }];
    const db = client({ data: rows, error: null });

    await expect(listSafetyReviewHistory(OFFICER_ID, { client: db })).resolves.toEqual(rows);
    expect(db.rpc).toHaveBeenCalledWith('safety_review_history', { p_caller: OFFICER_ID });
  });

  it('validates event ids before reading review details', async () => {
    const db = client();

    await expect(getSafetyReview('not-an-id', OFFICER_ID, { client: db })).rejects.toThrow(/valid event request id/);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM490_AC3_reads_the_detail_as_the_signed_in_officer', async () => {
    const db = client({ data: { event: { id: EVENT_ID } }, error: null });

    await getSafetyReview(EVENT_ID, OFFICER_ID, { client: db });

    expect(db.rpc).toHaveBeenCalledWith('safety_review_detail', { p_event_request_id: EVENT_ID, p_caller: OFFICER_ID });
  });

  it.each([
    ['SCRUM490_AC1_the_queue', (db) => listSafetyReviews(undefined, { client: db })],
    ['SCRUM490_AC13_the_history', (db) => listSafetyReviewHistory(undefined, { client: db })],
    ['SCRUM490_AC3_the_detail', (db) => getSafetyReview(EVENT_ID, undefined, { client: db })],
  ])('%s_is_not_read_without_a_caller', async (_name, read) => {
    const db = client();

    await expect(read(db)).rejects.toBeInstanceOf(ValidationError);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM490_AC1_maps_the_functions_role_refusal_to_forbidden', async () => {
    const db = client({ data: null, error: { code: '42501', message: 'Only Safety Officers can view safety reviews' } });

    await expect(listSafetyReviews(OFFICER_ID, { client: db })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('SCRUM490_AC3_an_event_the_detail_function_cannot_find_is_not_found', async () => {
    const message = `event request ${EVENT_ID} not found`;
    const db = client({ data: null, error: { code: 'P0002', message } });

    const error = await getSafetyReview(EVENT_ID, OFFICER_ID, { client: db }).catch((caught) => caught);

    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.message).toBe(message);
  });

  it('SCRUM490_AC1_an_unrecognised_database_error_is_left_untyped_so_it_becomes_a_500', async () => {
    const db = client({ data: null, error: { code: 'XX000', message: 'queue is broken' } });

    const error = await listSafetyReviews(OFFICER_ID, { client: db }).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AppError);
    expect(error.message).toBe('queue is broken');
  });

  it.each([
    ['SCRUM490_AC1_the_queue', listSafetyReviews],
    ['SCRUM490_AC13_the_history', listSafetyReviewHistory],
  ])('%s_reads_as_an_empty_list_when_the_function_returns_no_rows', async (_name, read) => {
    // The functions return a json array; null is the fallback for an empty answer.
    const db = client({ data: null, error: null });

    await expect(read(OFFICER_ID, { client: db })).resolves.toEqual([]);
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

  it.each([
    ['missing', undefined],
    ['not a uuid', 'officer-1'],
  ])('SCRUM490_a_%s_safety_officer_id_is_refused_before_the_database', async (_label, officerId) => {
    const db = client();

    const err = await respondToSafetyReview(EVENT_ID, { outcome: 'approved' }, officerId, { client: db }).catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe('A signed-in Safety Officer is required');
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['no response at all', null],
    ['an outcome outside the three choices', { outcome: 'deferred' }],
  ])('SCRUM490_%s_is_refused_before_the_database', async (_label, input) => {
    const db = client();

    const err = await respondToSafetyReview(EVENT_ID, input, OFFICER_ID, { client: db }).catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe('Choose approve, request changes or reject the safety arrangement');
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM490_a_note_that_is_not_text_is_refused_before_the_database', async () => {
    const db = client();

    const err = await respondToSafetyReview(
      EVENT_ID,
      { outcome: 'rejected', note: 42 },
      OFFICER_ID,
      { client: db },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe('The safety review note must be text');
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['not a list', BOOKING_ID],
    ['a list holding a non-uuid id', [BOOKING_ID, 'booking-2']],
    ['a list naming one booking twice', [BOOKING_ID, BOOKING_ID]],
  ])('SCRUM490_affected_bookings_given_as_%s_are_refused_before_the_database', async (_label, affectedBookingIds) => {
    const db = client();

    const err = await respondToSafetyReview(
      EVENT_ID,
      { outcome: 'changes_requested', note: 'Widen the exit route.', affectedBookingIds },
      OFFICER_ID,
      { client: db },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe('Affected venue bookings must be a list of unique booking ids');
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM490_equipment_affected_that_is_not_true_or_false_is_refused_before_the_database', async () => {
    const db = client();

    const err = await respondToSafetyReview(
      EVENT_ID,
      { outcome: 'changes_requested', note: 'Swap the speakers.', equipmentAffected: 'yes' },
      OFFICER_ID,
      { client: db },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe('equipmentAffected must be true or false');
    expect(db.rpc).not.toHaveBeenCalled();
  });
});
