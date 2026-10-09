/**
 * Tests for the equipment review service.
 *
 * SCRUM-290, subtasks SCRUM-292, 293 and 294. Named N14_ACn_<what_it_checks>.
 *
 *   AC1  -- the caller is always the signed-in user, never read from input
 *   AC2  -- starting; each refusal from the database becomes the right typed error
 *   AC3  -- who is reviewing, and taking over
 *   AC4  -- the review's data, with SCRUM-23's availability result per line
 *   AC7  -- marking a line and completing, with the missing notes listed
 *
 * The client is a test double passed in through the options, so no credentials
 * are read and nothing leaves the process. What the database does is tested
 * against a real Postgres in tests/db/equipmentReviewDatabase.test.js.
 */

import { describe, it, expect, vi } from 'vitest';

// equipmentReviewService reuses SCRUM-23's result mapper, which sits in a file
// that imports the real client. Nothing here calls it.
vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: {}, supabaseAdmin: {} }));

import {
  getEquipmentReview,
  startEquipmentReview,
  takeOverEquipmentReview,
  markEquipmentLineUnavailable,
  clearEquipmentLineOutcome,
  completeEquipmentReview,
  toReviewState,
  REVIEW_NOT_ALLOWED,
} from '../../src/services/equipmentReviewService.js';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
  AppError,
} from '../../src/errors.js';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const LINE_ID = '22222222-2222-4222-8222-222222222222';
const TYPE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const REQUEST_ID = '55555555-5555-4555-8555-555555555555';
const COORDINATOR_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const REVIEWER_ID = '66666666-6666-4666-8666-666666666666';

const availability = (overrides = {}) => ({
  found: true,
  retired: false,
  total: 10,
  damaged: 1,
  under_maintenance: 1,
  reserved: 3,
  available: 5,
  reservations: [],
  ...overrides,
});

const lineRow = (overrides = {}) => ({
  id: LINE_ID,
  equipment_type_id: TYPE_ID,
  name: 'Projector',
  quantity: 5,
  technical_notes: 'HDMI please',
  type_retired: false,
  reserved: 2,
  outcome: null,
  outcome_note: null,
  outcome_by: null,
  outcome_at: null,
  availability: availability(),
  ...overrides,
});

const reviewRow = ({ status = 'under_review', lines = [lineRow()], ...request } = {}) => ({
  event: {
    id: EVENT_ID,
    name: 'Annual Dinner',
    proposed_start: '2026-12-01T10:00:00+00:00',
    proposed_end: '2026-12-01T12:00:00+00:00',
    assigned_coordinator_id: COORDINATOR_ID,
  },
  request: {
    id: REQUEST_ID,
    status,
    reviewer_id: REVIEWER_ID,
    review_started_at: '2026-10-09T08:00:00+00:00',
    created_at: '2026-10-08T09:00:00+00:00',
    updated_at: '2026-10-09T08:00:00+00:00',
    lines,
    ...request,
  },
});

const ok = (data) => ({ data, error: null });
const dbError = (code, message) => ({ data: null, error: { code, message } });

/** A client whose rpc answers by function name. */
function fakeClient(rpc = {}) {
  const rpcCalls = [];
  return {
    rpcCalls,
    rpc: vi.fn(async (name, args) => {
      rpcCalls.push({ name, args });
      return rpc[name] ?? ok(reviewRow());
    }),
    from: vi.fn(),
  };
}

const failure = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
};


describe('AC4: the review data', () => {
  it('N14_AC4_calls_equipment_review_for_event_and_names_the_event_fields', async () => {
    const client = fakeClient();

    const state = await getEquipmentReview(EVENT_ID, { client });

    expect(client.rpcCalls).toEqual([
      { name: 'equipment_review_for_event', args: { p_event_request_id: EVENT_ID } },
    ]);
    expect(state.event).toEqual({
      id: EVENT_ID,
      name: 'Annual Dinner',
      proposedStart: '2026-12-01T10:00:00+00:00',
      proposedEnd: '2026-12-01T12:00:00+00:00',
      assignedCoordinatorId: COORDINATOR_ID,
    });
  });

  it('N14_AC3_names_the_status_and_who_is_reviewing', async () => {
    const state = await getEquipmentReview(EVENT_ID, { client: fakeClient() });

    expect(state.request).toMatchObject({
      id: REQUEST_ID,
      status: 'under_review',
      statusLabel: 'Under review',
      reviewerId: REVIEWER_ID,
      reviewStartedAt: '2026-10-09T08:00:00+00:00',
    });
  });

  it('N14_AC4_each_line_shows_type_quantity_notes_reserved_and_how_much_is_short', async () => {
    const state = await getEquipmentReview(EVENT_ID, { client: fakeClient() });

    expect(state.request.lines[0]).toMatchObject({
      id: LINE_ID,
      equipmentTypeId: TYPE_ID,
      name: 'Projector',
      quantity: 5,
      technicalNotes: 'HDMI please',
      reserved: 2,
      shortBy: 3,
      outcome: null,
      outcomeNote: null,
    });
  });

  it('N14_AC4_the_availability_result_uses_scrum_23s_labels_and_breakdown', async () => {
    const client = fakeClient({
      equipment_review_for_event: ok(
        reviewRow({
          lines: [
            lineRow({ id: 'a', name: 'Fully', availability: availability({ available: 5 }) }),
            lineRow({ id: 'b', name: 'Partly', availability: availability({ available: 2 }) }),
            lineRow({ id: 'c', name: 'None', availability: availability({ available: -1 }) }),
          ],
        }),
      ),
    });

    const { request } = await getEquipmentReview(EVENT_ID, { client });
    const [fully, partly, none] = request.lines.map((l) => l.availability);

    expect(fully.result).toBe('Fully available');
    expect(partly.result).toBe('Partially available');
    expect(none.result).toBe('Unavailable');
    expect(none.quantityAvailable).toBe(0);
    expect(fully.breakdown).toMatchObject({ total: 10, damagedOrUnderMaintenance: 2, reserved: 3 });
  });

  it('N14_AC4_a_line_with_no_period_has_no_availability_result_rather_than_unavailable', async () => {
    const client = fakeClient({
      equipment_review_for_event: ok(reviewRow({ lines: [lineRow({ availability: null })] })),
    });

    const { request } = await getEquipmentReview(EVENT_ID, { client });

    expect(request.lines[0].availability).toBeNull();
  });

  it('N14_AC4_an_event_with_no_equipment_request_gives_empty_state', async () => {
    const client = fakeClient({ equipment_review_for_event: ok({ request: null }) });

    expect(await getEquipmentReview(EVENT_ID, { client })).toEqual({ event: null, request: null });
  });

  it('N14_AC4_shows_a_marked_line_with_its_note_and_marker', async () => {
    const state = toReviewState(
      reviewRow({
        lines: [
          lineRow({
            outcome: 'cannot_be_provided',
            outcome_note: 'Only two in stock',
            outcome_by: REVIEWER_ID,
            outcome_at: '2026-10-09T08:30:00+00:00',
          }),
        ],
      }),
    );

    expect(state.request.lines[0]).toMatchObject({
      outcome: 'cannot_be_provided',
      outcomeNote: 'Only two in stock',
      outcomeBy: REVIEWER_ID,
      outcomeAt: '2026-10-09T08:30:00+00:00',
    });
  });

  it('N14_AC4_answers_not_found_for_an_event_that_does_not_exist', async () => {
    const client = fakeClient({ equipment_review_for_event: dbError('P0002', 'Event request not found') });

    const err = await failure(getEquipmentReview(EVENT_ID, { client }));

    expect(err).toBeInstanceOf(NotFoundError);
  });

  it('N14_AC4_refuses_an_id_that_is_not_a_uuid_before_any_call', async () => {
    const client = fakeClient();

    const err = await failure(getEquipmentReview('not-a-uuid', { client }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('N14_AC4_never_returns_a_snake_case_key', async () => {
    const state = await getEquipmentReview(EVENT_ID, { client: fakeClient() });

    expect(JSON.stringify(state)).not.toMatch(/"[a-z]+_[a-z_]+":/);
  });
});


describe('AC2 and AC3: starting and taking over', () => {
  it('N14_AC2_start_calls_the_function_with_the_signed_in_user', async () => {
    const client = fakeClient();

    const state = await startEquipmentReview(EVENT_ID, REVIEWER_ID, { client });

    expect(client.rpcCalls).toEqual([
      { name: 'start_equipment_review', args: { p_event_request_id: EVENT_ID, p_user_id: REVIEWER_ID } },
    ]);
    expect(state.request.reviewerId).toBe(REVIEWER_ID);
  });

  it('N14_AC3_take_over_calls_the_function_with_the_signed_in_user', async () => {
    const client = fakeClient();

    await takeOverEquipmentReview(EVENT_ID, REVIEWER_ID, { client });

    expect(client.rpcCalls).toEqual([
      { name: 'take_over_equipment_review', args: { p_event_request_id: EVENT_ID, p_user_id: REVIEWER_ID } },
    ]);
  });

  it.each([
    ['start', (client, userId) => startEquipmentReview(EVENT_ID, userId, { client })],
    ['take over', (client, userId) => takeOverEquipmentReview(EVENT_ID, userId, { client })],
    ['complete', (client, userId) => completeEquipmentReview(EVENT_ID, userId, { client })],
    ['clear', (client, userId) => clearEquipmentLineOutcome(EVENT_ID, LINE_ID, userId, { client })],
    ['mark', (client, userId) => markEquipmentLineUnavailable(EVENT_ID, LINE_ID, { note: 'x' }, userId, { client })],
  ])('N14_AC1_%s_refuses_a_missing_caller_before_any_call', async (_what, call) => {
    for (const userId of [undefined, null, '', '   ']) {
      const client = fakeClient();

      const err = await failure(call(client, userId));

      expect(err).toBeInstanceOf(ValidationError);
      expect(client.rpc).not.toHaveBeenCalled();
    }
  });

  it('N14_AC2_a_status_that_does_not_allow_it_becomes_a_409_with_a_code_and_the_message', async () => {
    const message = 'This equipment request is already Under review. Take over the review instead.';
    const client = fakeClient({ start_equipment_review: dbError('55000', message) });

    const err = await failure(startEquipmentReview(EVENT_ID, REVIEWER_ID, { client }));

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(err.code).toBe(REVIEW_NOT_ALLOWED);
    expect(err.message).toBe(message);
  });

  it('N14_AC2_a_request_that_changed_during_the_call_is_also_a_409', async () => {
    const client = fakeClient({
      start_equipment_review: dbError('40001', 'The equipment request changed while the review was being started'),
    });

    const err = await failure(startEquipmentReview(EVENT_ID, REVIEWER_ID, { client }));

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe(REVIEW_NOT_ALLOWED);
  });

  it('N14_AC2_an_event_with_no_equipment_request_is_a_404', async () => {
    const client = fakeClient({
      start_equipment_review: dbError('P0002', 'This event has no equipment request to review'),
    });

    const err = await failure(startEquipmentReview(EVENT_ID, REVIEWER_ID, { client }));

    expect(err).toBeInstanceOf(NotFoundError);
  });

  it('N14_AC1_a_missing_privilege_becomes_a_403', async () => {
    const client = fakeClient({
      start_equipment_review: dbError('42501', 'Only Technical Support Staff can review equipment requests'),
    });

    const err = await failure(startEquipmentReview(EVENT_ID, REVIEWER_ID, { client }));

    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.status).toBe(403);
  });

  it('N14_an_unrecognised_database_error_is_left_untyped_and_does_not_reach_the_caller_as_a_4xx', async () => {
    const client = fakeClient({ start_equipment_review: dbError('XX000', 'relation "x" is broken') });

    const err = await failure(startEquipmentReview(EVENT_ID, REVIEWER_ID, { client }));

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AppError);
  });
});


describe('AC7: marking a line and completing', () => {
  it('N14_AC7_mark_sends_the_trimmed_note_the_line_and_the_signed_in_user', async () => {
    const client = fakeClient();

    await markEquipmentLineUnavailable(EVENT_ID, LINE_ID, { note: '  Only two in stock ' }, REVIEWER_ID, { client });

    expect(client.rpcCalls).toEqual([
      {
        name: 'mark_equipment_line_unavailable',
        args: {
          p_event_request_id: EVENT_ID,
          p_user_id: REVIEWER_ID,
          p_line_id: LINE_ID,
          p_note: 'Only two in stock',
        },
      },
    ]);
  });

  it('N14_AC7_mark_refuses_a_missing_note_before_any_call_and_names_the_field', async () => {
    const client = fakeClient();

    const err = await failure(markEquipmentLineUnavailable(EVENT_ID, LINE_ID, { note: '  ' }, REVIEWER_ID, { client }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'note', message: 'is required: say what is missing' }]);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('N14_AC7_mark_refuses_ids_that_are_not_uuids_before_any_call', async () => {
    const client = fakeClient();

    expect(await failure(markEquipmentLineUnavailable('x', LINE_ID, { note: 'a' }, REVIEWER_ID, { client })))
      .toBeInstanceOf(ValidationError);
    expect(await failure(markEquipmentLineUnavailable(EVENT_ID, 'y', { note: 'a' }, REVIEWER_ID, { client })))
      .toBeInstanceOf(ValidationError);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('N14_AC3_a_caller_who_is_not_the_reviewer_gets_a_403', async () => {
    const client = fakeClient({
      mark_equipment_line_unavailable: dbError('42501', 'Only the current reviewer can do this'),
    });

    const err = await failure(markEquipmentLineUnavailable(EVENT_ID, LINE_ID, { note: 'a' }, COORDINATOR_ID, { client }));

    expect(err).toBeInstanceOf(ForbiddenError);
  });

  it('N14_AC7_a_fully_reserved_line_cannot_be_marked_and_that_is_a_409', async () => {
    const client = fakeClient({
      mark_equipment_line_unavailable: dbError('55000', 'This line is already fully reserved, so it can be provided'),
    });

    const err = await failure(markEquipmentLineUnavailable(EVENT_ID, LINE_ID, { note: 'a' }, REVIEWER_ID, { client }));

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toMatch(/fully reserved/);
  });

  it('N14_AC7_clear_calls_the_function_for_that_line', async () => {
    const client = fakeClient();

    await clearEquipmentLineOutcome(EVENT_ID, LINE_ID, REVIEWER_ID, { client });

    expect(client.rpcCalls).toEqual([
      {
        name: 'clear_equipment_line_outcome',
        args: { p_event_request_id: EVENT_ID, p_user_id: REVIEWER_ID, p_line_id: LINE_ID },
      },
    ]);
  });

  it('N14_AC7_complete_calls_the_function_and_returns_the_new_state', async () => {
    const client = fakeClient({
      complete_equipment_review: ok(
        reviewRow({ status: 'cannot_be_fully_arranged', reviewer_id: null, review_started_at: null }),
      ),
    });

    const state = await completeEquipmentReview(EVENT_ID, REVIEWER_ID, { client });

    expect(client.rpcCalls[0]).toEqual({
      name: 'complete_equipment_review',
      args: { p_event_request_id: EVENT_ID, p_user_id: REVIEWER_ID },
    });
    expect(state.request).toMatchObject({
      status: 'cannot_be_fully_arranged',
      statusLabel: 'Cannot be fully arranged',
      reviewerId: null,
    });
  });

  it('N14_AC7_complete_with_lines_missing_notes_is_a_400_listing_each_line', async () => {
    const client = fakeClient({
      complete_equipment_review: dbError(
        '22023',
        'Add a note to each line that cannot be provided. Missing a note: Microphone, Projector',
      ),
    });

    const err = await failure(completeEquipmentReview(EVENT_ID, REVIEWER_ID, { client }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([
      { field: 'lines', message: 'Microphone needs a note' },
      { field: 'lines', message: 'Projector needs a note' },
    ]);
    expect(err.message).toMatch(/Microphone, Projector/);
  });

  it('N14_AC7_complete_when_every_line_is_reserved_is_a_409', async () => {
    const client = fakeClient({
      complete_equipment_review: dbError('55000', 'Every line is fully reserved, so there is nothing to complete.'),
    });

    const err = await failure(completeEquipmentReview(EVENT_ID, REVIEWER_ID, { client }));

    expect(err).toBeInstanceOf(ConflictError);
  });

  it('N14_AC7_a_check_constraint_is_wrapped_so_the_drivers_words_are_marked_as_such', async () => {
    const client = fakeClient({
      mark_equipment_line_unavailable: dbError('23514', 'new row violates check constraint'),
    });

    const err = await failure(markEquipmentLineUnavailable(EVENT_ID, LINE_ID, { note: 'a' }, REVIEWER_ID, { client }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/^A value was rejected by the database:/);
  });
});
