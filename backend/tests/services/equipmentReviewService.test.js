/**
 * Tests for the equipment review service.
 *
 * SCRUM-290, subtasks SCRUM-292, 293 and 294. Named SCRUM290_AC<n>_<what_it_checks>.
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
import { ok, dbError, errorFrom, rpcByNameClient } from '../fixtures/supabaseStubs.js';

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
const VENUE_ID = '88888888-8888-4888-8888-888888888888';

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


/** A chainable query whose awaited result is `result`, as supabase-js builds them. */
function query(result) {
  const chain = {};
  for (const method of ['select', 'in', 'eq', 'order', 'limit']) chain[method] = vi.fn(() => chain);
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

const NAMES = ok([
  { id: COORDINATOR_ID, full_name: 'Casey Coordinator' },
  { id: REVIEWER_ID, full_name: 'Riley Reviewer' },
]);
const BOOKING = ok([{ venue_id: VENUE_ID, starts_at: '2026-12-01T09:00:00+00:00' }]);
const VENUES = ok([{ id: VENUE_ID, name: 'Hall A' }]);

/**
 * A client whose rpc answers by function name and whose from answers by table
 * (profiles, bookings, venues), as the names the screen shows are read.
 */
function fakeClient(rpc = {}, tables = {}) {
  const answers = { profiles: NAMES, bookings: BOOKING, venues: VENUES, ...tables };
  return rpcByNameClient({ rpc, fallback: () => ok(reviewRow()), table: (name) => answers[name] ?? ok([]) });
}


describe('AC4: the review data', () => {
  it('SCRUM290_AC4_calls_equipment_review_for_event_and_names_the_event_fields', async () => {
    const client = fakeClient();

    const state = await getEquipmentReview(EVENT_ID, { client });

    expect(client.rpcCalls).toEqual([
      { name: 'equipment_review_for_event', args: { p_event_request_id: EVENT_ID } },
    ]);
    expect(state.event).toMatchObject({
      id: EVENT_ID,
      name: 'Annual Dinner',
      proposedStart: '2026-12-01T10:00:00+00:00',
      proposedEnd: '2026-12-01T12:00:00+00:00',
      assignedCoordinatorId: COORDINATOR_ID,
    });
  });

  it('SCRUM290_AC3_names_the_status_and_who_is_reviewing', async () => {
    const state = await getEquipmentReview(EVENT_ID, { client: fakeClient() });

    expect(state.request).toMatchObject({
      id: REQUEST_ID,
      status: 'under_review',
      statusLabel: 'Under review',
      reviewerId: REVIEWER_ID,
      reviewStartedAt: '2026-10-09T08:00:00+00:00',
    });
  });

  it('SCRUM290_AC4_each_line_shows_type_quantity_notes_reserved_and_how_much_is_short', async () => {
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

  it('SCRUM290_AC4_the_availability_result_uses_scrum_23s_labels_and_breakdown', async () => {
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

  it('SCRUM290_AC4_a_line_with_no_period_has_no_availability_result_rather_than_unavailable', async () => {
    const client = fakeClient({
      equipment_review_for_event: ok(reviewRow({ lines: [lineRow({ availability: null })] })),
    });

    const { request } = await getEquipmentReview(EVENT_ID, { client });

    expect(request.lines[0].availability).toBeNull();
  });

  it('SCRUM290_AC4_an_event_with_no_equipment_request_gives_empty_state', async () => {
    const client = fakeClient({ equipment_review_for_event: ok({ request: null }) });

    expect(await getEquipmentReview(EVENT_ID, { client })).toEqual({ event: null, request: null });
  });

  it('SCRUM290_AC4_shows_a_marked_line_with_its_note_and_marker', async () => {
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

  it('SCRUM290_AC4_answers_not_found_for_an_event_that_does_not_exist', async () => {
    const client = fakeClient({ equipment_review_for_event: dbError('P0002', 'Event request not found') });

    const err = await errorFrom(getEquipmentReview(EVENT_ID, { client }));

    expect(err).toBeInstanceOf(NotFoundError);
  });

  it('SCRUM290_AC4_refuses_an_id_that_is_not_a_uuid_before_any_call', async () => {
    const client = fakeClient();

    const err = await errorFrom(getEquipmentReview('not-a-uuid', { client }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM290_AC4_never_returns_a_snake_case_key', async () => {
    const state = await getEquipmentReview(EVENT_ID, { client: fakeClient() });

    expect(JSON.stringify(state)).not.toMatch(/"[a-z]+_[a-z_]+":/);
  });
});


describe('AC2 and AC3: starting and taking over', () => {
  it('SCRUM290_AC2_start_calls_the_function_with_the_signed_in_user', async () => {
    const client = fakeClient();

    const state = await startEquipmentReview(EVENT_ID, REVIEWER_ID, { client });

    expect(client.rpcCalls).toEqual([
      { name: 'start_equipment_review', args: { p_event_request_id: EVENT_ID, p_user_id: REVIEWER_ID } },
    ]);
    expect(state.request.reviewerId).toBe(REVIEWER_ID);
  });

  it('SCRUM290_AC3_take_over_calls_the_function_with_the_signed_in_user', async () => {
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
  ])('SCRUM290_AC1_%s_refuses_a_missing_caller_before_any_call', async (_what, call) => {
    for (const userId of [undefined, null, '', '   ']) {
      const client = fakeClient();

      const err = await errorFrom(call(client, userId));

      expect(err).toBeInstanceOf(ValidationError);
      expect(client.rpc).not.toHaveBeenCalled();
    }
  });

  it('SCRUM290_AC2_a_status_that_does_not_allow_it_becomes_a_409_with_a_code_and_the_message', async () => {
    const message = 'This equipment request is already Under review. Take over the review instead.';
    const client = fakeClient({ start_equipment_review: dbError('55000', message) });

    const err = await errorFrom(startEquipmentReview(EVENT_ID, REVIEWER_ID, { client }));

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(err.code).toBe(REVIEW_NOT_ALLOWED);
    expect(err.message).toBe(message);
  });

  it('SCRUM290_AC2_a_request_that_changed_during_the_call_is_also_a_409', async () => {
    const client = fakeClient({
      start_equipment_review: dbError('40001', 'The equipment request changed while the review was being started'),
    });

    const err = await errorFrom(startEquipmentReview(EVENT_ID, REVIEWER_ID, { client }));

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe(REVIEW_NOT_ALLOWED);
  });

  it('SCRUM300_AC3_a_deadlock_between_two_changes_is_a_409_that_says_to_try_again', async () => {
    const client = fakeClient({
      start_equipment_review: dbError('40P01', 'deadlock detected'),
    });

    const err = await errorFrom(startEquipmentReview(EVENT_ID, REVIEWER_ID, { client }));

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(err.code).toBe(REVIEW_NOT_ALLOWED);
    expect(err.message).toBe('Someone changed this equipment at the same moment. Please try again.');
  });

  it('SCRUM290_AC2_an_event_with_no_equipment_request_is_a_404', async () => {
    const client = fakeClient({
      start_equipment_review: dbError('P0002', 'This event has no equipment request to review'),
    });

    const err = await errorFrom(startEquipmentReview(EVENT_ID, REVIEWER_ID, { client }));

    expect(err).toBeInstanceOf(NotFoundError);
  });

  it('SCRUM290_AC1_a_missing_privilege_becomes_a_403', async () => {
    const client = fakeClient({
      start_equipment_review: dbError('42501', 'Only Technical Support Staff can review equipment requests'),
    });

    const err = await errorFrom(startEquipmentReview(EVENT_ID, REVIEWER_ID, { client }));

    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.status).toBe(403);
  });

  it('SCRUM290_AC1_an_unrecognised_database_error_is_left_untyped_and_does_not_reach_the_caller_as_a_4xx', async () => {
    const client = fakeClient({ start_equipment_review: dbError('XX000', 'relation "x" is broken') });

    const err = await errorFrom(startEquipmentReview(EVENT_ID, REVIEWER_ID, { client }));

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AppError);
  });
});


describe('AC7: marking a line and completing', () => {
  it('SCRUM290_AC7_mark_sends_the_trimmed_note_the_line_and_the_signed_in_user', async () => {
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

  it('SCRUM290_AC7_mark_refuses_a_missing_note_before_any_call_and_names_the_field', async () => {
    const client = fakeClient();

    const err = await errorFrom(markEquipmentLineUnavailable(EVENT_ID, LINE_ID, { note: '  ' }, REVIEWER_ID, { client }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'note', message: 'is required: say what is missing' }]);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM290_AC7_mark_refuses_ids_that_are_not_uuids_before_any_call', async () => {
    const client = fakeClient();

    expect(await errorFrom(markEquipmentLineUnavailable('x', LINE_ID, { note: 'a' }, REVIEWER_ID, { client })))
      .toBeInstanceOf(ValidationError);
    expect(await errorFrom(markEquipmentLineUnavailable(EVENT_ID, 'y', { note: 'a' }, REVIEWER_ID, { client })))
      .toBeInstanceOf(ValidationError);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('SCRUM290_AC3_a_caller_who_is_not_the_reviewer_gets_a_403', async () => {
    const client = fakeClient({
      mark_equipment_line_unavailable: dbError('42501', 'Only the current reviewer can do this'),
    });

    const err = await errorFrom(markEquipmentLineUnavailable(EVENT_ID, LINE_ID, { note: 'a' }, COORDINATOR_ID, { client }));

    expect(err).toBeInstanceOf(ForbiddenError);
  });

  it('SCRUM290_AC7_a_fully_reserved_line_cannot_be_marked_and_that_is_a_409', async () => {
    const client = fakeClient({
      mark_equipment_line_unavailable: dbError('55000', 'This line is already fully reserved, so it can be provided'),
    });

    const err = await errorFrom(markEquipmentLineUnavailable(EVENT_ID, LINE_ID, { note: 'a' }, REVIEWER_ID, { client }));

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toMatch(/fully reserved/);
  });

  it('SCRUM290_AC7_clear_calls_the_function_for_that_line', async () => {
    const client = fakeClient();

    await clearEquipmentLineOutcome(EVENT_ID, LINE_ID, REVIEWER_ID, { client });

    expect(client.rpcCalls).toEqual([
      {
        name: 'clear_equipment_line_outcome',
        args: { p_event_request_id: EVENT_ID, p_user_id: REVIEWER_ID, p_line_id: LINE_ID },
      },
    ]);
  });

  it('SCRUM290_AC7_complete_calls_the_function_and_returns_the_new_state', async () => {
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

  it('SCRUM290_AC7_complete_with_lines_missing_notes_is_a_400_listing_each_line', async () => {
    const client = fakeClient({
      complete_equipment_review: dbError(
        '22023',
        'Add a note to each line that cannot be provided. Missing a note: Microphone, Projector',
      ),
    });

    const err = await errorFrom(completeEquipmentReview(EVENT_ID, REVIEWER_ID, { client }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([
      { field: 'lines', message: 'Microphone needs a note' },
      { field: 'lines', message: 'Projector needs a note' },
    ]);
    expect(err.message).toMatch(/Microphone, Projector/);
  });

  it('SCRUM290_AC7_complete_when_every_line_is_reserved_is_a_409', async () => {
    const client = fakeClient({
      complete_equipment_review: dbError('55000', 'Every line is fully reserved, so there is nothing to complete.'),
    });

    const err = await errorFrom(completeEquipmentReview(EVENT_ID, REVIEWER_ID, { client }));

    expect(err).toBeInstanceOf(ConflictError);
  });

  it('SCRUM290_AC7_a_check_constraint_is_wrapped_so_the_drivers_words_are_marked_as_such', async () => {
    const client = fakeClient({
      mark_equipment_line_unavailable: dbError('23514', 'new row violates check constraint'),
    });

    const err = await errorFrom(markEquipmentLineUnavailable(EVENT_ID, LINE_ID, { note: 'a' }, REVIEWER_ID, { client }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/^A value was rejected by the database:/);
  });
});


describe('AC3 and AC4: the names on the screen', () => {
  it('SCRUM290_AC3_names_the_reviewer_and_the_assigned_coordinator', async () => {
    const state = await getEquipmentReview(EVENT_ID, { client: fakeClient() });

    expect(state.request.reviewerName).toBe('Riley Reviewer');
    expect(state.event.assignedCoordinatorName).toBe('Casey Coordinator');
  });

  it('SCRUM290_AC4_names_the_booked_venue', async () => {
    const state = await getEquipmentReview(EVENT_ID, { client: fakeClient() });

    expect(state.event.venue).toEqual({ id: VENUE_ID, name: 'Hall A' });
  });

  it('SCRUM290_AC4_only_approved_or_flagged_bookings_count_as_the_booked_venue', async () => {
    const client = fakeClient();
    const queries = [];
    client.from.mockImplementation((table) => {
      const q = query(table === 'bookings' ? BOOKING : table === 'venues' ? VENUES : NAMES);
      queries.push({ table, q });
      return q;
    });

    await getEquipmentReview(EVENT_ID, { client });

    const bookings = queries.find((entry) => entry.table === 'bookings').q;
    expect(bookings.eq).toHaveBeenCalledWith('event_request_id', EVENT_ID);
    expect(bookings.in).toHaveBeenCalledWith('status', ['approved', 'flagged_for_review']);
  });

  it('SCRUM290_AC4_an_event_with_no_booking_has_no_venue', async () => {
    const client = fakeClient({}, { bookings: ok([]) });

    const state = await getEquipmentReview(EVENT_ID, { client });

    expect(state.event.venue).toBeNull();
    expect(client.fromCalls).not.toContain('venues');
  });

  it('SCRUM290_AC3_nobody_reviewing_means_no_reviewer_name', async () => {
    const client = fakeClient({
      equipment_review_for_event: ok(reviewRow({ status: 'pending_review', reviewer_id: null, review_started_at: null })),
    });

    const state = await getEquipmentReview(EVENT_ID, { client });

    expect(state.request.reviewerName).toBeNull();
  });

  it('SCRUM290_AC3_a_person_without_a_name_comes_back_as_null_not_undefined', async () => {
    const client = fakeClient({}, { profiles: ok([{ id: REVIEWER_ID, full_name: null }]) });

    const state = await getEquipmentReview(EVENT_ID, { client });

    expect(state.request.reviewerName).toBeNull();
    expect(state.event.assignedCoordinatorName).toBeNull();
  });

  it('SCRUM290_AC3_the_names_are_added_to_every_write_too', async () => {
    const state = await takeOverEquipmentReview(EVENT_ID, REVIEWER_ID, { client: fakeClient() });

    expect(state.request.reviewerName).toBe('Riley Reviewer');
    expect(state.event.venue.name).toBe('Hall A');
  });

  it('SCRUM290_AC3_an_event_with_no_equipment_request_reads_no_names_at_all', async () => {
    const client = fakeClient({ equipment_review_for_event: ok({ request: null }) });

    await getEquipmentReview(EVENT_ID, { client });

    expect(client.from).not.toHaveBeenCalled();
  });

  it('SCRUM290_AC3_a_failed_name_lookup_is_a_500_not_a_blank_screen', async () => {
    const client = fakeClient({}, { profiles: dbError('XX000', 'profiles is broken') });

    const err = await errorFrom(getEquipmentReview(EVENT_ID, { client }));

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AppError);
  });
});
