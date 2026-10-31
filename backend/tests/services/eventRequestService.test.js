/**
 * Tests for the event request service.
 *
 * SCRUM-31, a subtask of SCRUM-10 (Create Event Request).
 *
 * Written before src/services/eventRequestService.js exists, so the first run
 * fails to resolve the import. That is deliberate: the evidence asked for is a
 * history of failing tests followed by the implementation that turns them
 * green, not tests reconstructed afterwards.
 *
 * Acceptance criteria this file maps onto, carried in every test name:
 *   AC2 -- what comes back, and how stored columns are mapped
 *   AC3 -- a draft is created and stored
 *   AC4 -- refusals, whether from validation, the transition rule or Postgres
 *   AC5 -- submitting a draft for review
 *   AC6 -- a draft is submitted once and only once
 *
 * SCRUM-331 (a subtask of SCRUM-327) adds reassignEventRequest, which calls
 * reassign_event_request (migration 018). Its SCRUM331_* tests are named after
 * SCRUM-327's criteria:
 *   AC6 -- only the assigned coordinator may hand an event over, and only in
 *          the statuses the AC names
 *   AC7 -- the new coordinator can act on the event once it is handed over
 *   AC9 -- every handover records who made it, and the note
 *
 * SCRUM-332 (a subtask of SCRUM-327) makes every coordinator action that
 * changes an event check the caller is its assigned coordinator, and gives
 * coordinators a single read. Its SCRUM332_AC7_* tests are at the bottom of
 * this file, with the change request service's, which has no test file of its
 * own:
 *   AC7 -- after a handover the new coordinator can act on the event, and the
 *          previous one can view it but no longer change it
 *
 * SCRUM-333 (a subtask of SCRUM-327) adds listEventRequestsForCoordinator, the
 * "My events" list. Its SCRUM333_AC11_* tests are the last block in this file:
 *   AC11 -- each coordinator has a list of the events assigned to them,
 *           grouped by status, earliest event first
 *
 * SCRUM-334 (a subtask of SCRUM-327) adds listCoordinators, for the reassign
 * picker, and listAssignmentHistory, an event's history of coordinators. Their
 * SCRUM334_* tests follow SCRUM-333's:
 *   AC9  -- every handover records who made it, and the note
 *   AC10 -- the Organiser's screen shows the event's assignment history
 *

 * SCRUM-330 (a subtask of SCRUM-327) moved the write half of submission into
 * the Postgres function submit_event_request (migration 016), which also
 * assigns the Event Coordinator. The SCRUM10_AC5 and SCRUM10_AC6 tests that
 * pinned the old client-side write are replaced by SCRUM330_* tests, named
 * after SCRUM-327's criteria:
 *   AC1 -- a coordinator is assigned automatically, as part of submission
 *   AC5 -- with no coordinator available, submission is refused with that
 *          message and the request stays a draft
 *
 * Why this file runs without a .env, and why that is not an accident:
 *
 * src/config/supabaseClient.js throws at import time when SUPABASE_URL or
 * SUPABASE_SECRET_KEY is missing -- on purpose, so a misconfigured server fails
 * at startup rather than on its first query. A service that imported it at the
 * top level would drag that throw into every test run and force credentials on
 * anyone running the suite, including CI. So the service resolves its default
 * client lazily, inside each function, and only when the caller supplied none.
 * Every test below supplies a fake, so that branch is never reached. The static
 * import a few lines down is itself the assertion: if the service reached for
 * supabaseClient.js eagerly, this suite would not even collect.
 *
 * Why organiserId is a parameter and not something the service works out:
 *
 * event_requests.organiser_id is not null and references auth.users, and in
 * production the value comes from the JWT via middleware that does not exist
 * yet. Passing it in keeps the service free of auth concerns, which stays
 * correct whatever arrives later. Nothing here asserts that the caller *is*
 * that organiser -- that is authorisation, and it belongs in middleware.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  createEventRequest,
  submitEventRequest,
  getEventRequestById,
  listEventRequestsForOrganiser,
  getEventRequestForOrganiser,
  getSignificantEventChangeImpact,
  applySignificantEventChange,
  requestEventClarification,
  respondToEventClarification,
  closeEventClarification,
  getEventClarificationHistory,
  reassignEventRequest,
} from '../../src/services/eventRequestService.js';
import {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  ServiceUnavailableError,
  ForbiddenError,
} from '../../src/errors.js';
import { ROLE } from '../../src/domain/userRole.js';
import { STATUS, canTransition } from '../../src/domain/eventRequestStatus.js';
import { ok, dbError, errorFrom, createEventRequestClient } from '../fixtures/supabaseStubs.js';
import { sgDate } from '../fixtures/time.js';


// ---------------------------------------------------------------------------
// The fake client
// ---------------------------------------------------------------------------

/** The rpc calls a fake client received, in order. */
const rpcCallsOf = (client) => client.calls.filter((call) => call.operation === 'rpc');


// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
/**
 * Fixed instants, injected rather than read from the clock.
 *
 * `now` exists on the service for the same reason it exists on
 * validateSubmitEventRequest: a submission time compared against the real clock
 * makes a test that passes today and fails tomorrow, or passes locally and
 * fails in CI.
 */
const NOW = new Date('2026-01-15T09:00:00.000Z');

const ORGANISER_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';

/** SCRUM-330. The coordinator submit_event_request reports having assigned. */
const COORDINATOR_ID = '44444444-4444-4444-8444-444444444444';

/** What an API layer would hand the service, in camelCase. */
const DRAFT_INPUT = Object.freeze({
  eventName: 'IS212 Industry Night',
  purpose: 'Connect final-year students with industry partners.',
  proposedStart: '2026-06-01T09:00:00+08:00',
  proposedEnd: '2026-06-01T17:00:00+08:00',
  expectedAttendance: 120,
  venueRequirements: 'A large room, ideally tiered seating.',
});

/**
 * A row as Postgres returns it: snake_case columns, and timestamptz rendered
 * with an explicit +00:00 offset, which is what PostgREST actually sends.
 */
function storedRow(overrides = {}) {
  return {
    id: REQUEST_ID,
    organiser_id: ORGANISER_ID,
    event_name: 'IS212 Industry Night',
    purpose: 'Connect final-year students with industry partners.',
    description: null,
    proposed_start: '2026-06-01T09:00:00+00:00',
    proposed_end: '2026-06-01T17:00:00+00:00',
    expected_attendance: 120,
    venue_requirements: 'A large room, ideally tiered seating.',
    accessibility_requirements: null,
    equipment_requirements: null,
    status: STATUS.DRAFT,
    clarification_note: null,
    created_at: '2026-01-10T03:00:00+00:00',
    updated_at: '2026-01-10T03:00:00+00:00',
    submitted_at: null,
    ...overrides,
  };
}


/** Which fields a failed validation complained about. */
function fieldsIn(err) {
  return err.details.map((d) => d.field);
}

/** The instant a timestamp stands for, however it is encoded. */
function instantOf(value) {
  return new Date(value).getTime();
}


// ---------------------------------------------------------------------------
// Creating a draft
// ---------------------------------------------------------------------------
describe('AC3: a draft is created and stored', () => {
  it('SCRUM10_AC3_creates_a_draft_with_the_organiser_recorded', async () => {
    // organiser_id is not null in 001 and references auth.users, so a request
    // that does not name its Organiser cannot be stored at all -- and could not
    // be found again by the person who wrote it.
    const client = createEventRequestClient([ok(storedRow())]);

    const record = await createEventRequest(DRAFT_INPUT, ORGANISER_ID, { client });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].table).toBe('event_requests');
    expect(client.calls[0].operation).toBe('insert');
    expect(client.calls[0].payload).toMatchObject({
      organiser_id: ORGANISER_ID,
      event_name: 'IS212 Industry Night',
    });
    expect(record.id).toBe(REQUEST_ID);
  });

  it('SCRUM10_AC3_stores_the_draft_status_explicitly', async () => {
    // The column already defaults to 'draft', so this is a choice: the service
    // sends the status rather than relying on the default. Two reasons. The
    // service then says what it means, instead of a reader having to open a
    // migration to learn what a created request is; and the value cannot drift
    // if a later migration changes the default, which would otherwise alter
    // this story's behaviour silently from another branch.
    const client = createEventRequestClient([ok(storedRow())]);

    await createEventRequest(DRAFT_INPUT, ORGANISER_ID, { client });

    expect(client.calls[0].payload.status).toBe(STATUS.DRAFT);
  });

  it('SCRUM10_AC3_leaves_the_timestamp_columns_to_the_database', async () => {
    // created_at and updated_at are database defaults, and updated_at is
    // maintained by the event_requests_set_updated_at trigger -- a value sent
    // from here would be overwritten on the next write anyway, so sending one
    // only invites disagreement about which clock is authoritative.
    //
    // submitted_at must stay null while the row is a draft: the
    // event_requests_submitted_at_matches_status constraint from 005 rejects
    // the insert outright otherwise.
    const client = createEventRequestClient([ok(storedRow())]);

    await createEventRequest(DRAFT_INPUT, ORGANISER_ID, { client });

    const { payload } = client.calls[0];
    expect(payload).not.toHaveProperty('created_at');
    expect(payload).not.toHaveProperty('updated_at');
    expect(payload).not.toHaveProperty('submitted_at');
  });

  it('SCRUM10_AC3_sends_the_columns_under_their_snake_case_names', async () => {
    // The service is the one place that knows both vocabularies: camelCase
    // above it, the column names from 001 and 005 below. Getting this wrong is
    // silent -- PostgREST would simply ignore a key no column matches, and the
    // requirement would vanish without an error.
    const client = createEventRequestClient([ok(storedRow())]);

    await createEventRequest(DRAFT_INPUT, ORGANISER_ID, { client });

    const { payload } = client.calls[0];
    expect(payload).toMatchObject({
      event_name: DRAFT_INPUT.eventName,
      purpose: DRAFT_INPUT.purpose,
      expected_attendance: DRAFT_INPUT.expectedAttendance,
      venue_requirements: DRAFT_INPUT.venueRequirements,
    });
    expect(payload).not.toHaveProperty('eventName');
    expect(payload).not.toHaveProperty('venueRequirements');
  });

  it('SCRUM10_AC2_returns_the_stored_record_in_camelCase', async () => {
    // Mapped on the way out exactly as venueService.getVenueById does, so no
    // caller above this layer ever has to know a column name.
    const client = createEventRequestClient([ok(storedRow())]);

    const record = await createEventRequest(DRAFT_INPUT, ORGANISER_ID, { client });

    expect(record).toMatchObject({
      id: REQUEST_ID,
      organiserId: ORGANISER_ID,
      eventName: 'IS212 Industry Night',
      expectedAttendance: 120,
      venueRequirements: 'A large room, ideally tiered seating.',
      status: STATUS.DRAFT,
      submittedAt: null,
    });
    expect(record).not.toHaveProperty('event_name');
    expect(record).not.toHaveProperty('organiser_id');
    expect(record).not.toHaveProperty('expected_attendance');
  });
});


// ---------------------------------------------------------------------------
// Refusals before the database is involved
// ---------------------------------------------------------------------------
describe('AC4: invalid input never reaches the database', () => {
  it('SCRUM10_AC4_refuses_input_the_validator_rejects_without_touching_the_client', async () => {
    // Validation runs first so a bad form costs no round trip, and so the
    // Organiser gets a message about their form rather than a driver message
    // about a check constraint.
    const client = createEventRequestClient();

    const err = await errorFrom(
      createEventRequest({ ...DRAFT_INPUT, eventName: '   ' }, ORGANISER_ID, { client }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err)).toContain('eventName');
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM10_AC4_reports_every_fault_in_one_error', async () => {
    // Inherited from validateCreateEventRequest and asserted here too, because
    // it is the service's contract that matters to the API layer: the Organiser
    // fixes a whole form in one round trip.
    const client = createEventRequestClient();

    const err = await errorFrom(
      createEventRequest(
        { ...DRAFT_INPUT, eventName: '', expectedAttendance: 0 },
        ORGANISER_ID,
        { client },
      ),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err).sort()).toEqual(['eventName', 'expectedAttendance']);
    expect(client.calls).toHaveLength(0);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
  ])('SCRUM10_AC4_refuses_an_organiser_id_that_is_%s', async (_label, organiserId) => {
    // Caught here rather than left to the not-null constraint. The database
    // would refuse it too, but a round trip later and with a message naming a
    // column, which tells the caller nothing they can act on.
    const client = createEventRequestClient();

    const err = await errorFrom(createEventRequest(DRAFT_INPUT, organiserId, { client }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(client.calls).toHaveLength(0);
  });
});


// ---------------------------------------------------------------------------
// Database faults
// ---------------------------------------------------------------------------
describe('AC4: database faults are translated into typed errors', () => {
  it('SCRUM10_AC4_translates_a_foreign_key_violation_on_the_organiser', async () => {
    // The likeliest real failure of the three, and the reason this test is
    // specific: an organiserId that is well formed but absent from auth.users
    // -- a stale JWT, a deleted account, a hand-made request -- produces 23503.
    // Untranslated, the caller receives 'insert or update on table
    // "event_requests" violates foreign key constraint', which reads as a bug
    // rather than as an unknown user.
    const client = createEventRequestClient([
      dbError(
        '23503',
        'insert or update on table "event_requests" violates foreign key ' +
          'constraint "event_requests_organiser_id_fkey"',
      ),
    ]);

    const err = await errorFrom(createEventRequest(DRAFT_INPUT, ORGANISER_ID, { client }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/organiser/i);
  });

  it('SCRUM10_AC4_translates_a_check_constraint_violation', async () => {
    // 001 and 005 carry the real guarantees -- ordered dates, positive
    // attendance, submitted_at matching status. Validation mirrors them for
    // readable messages, but anything reaching the database by another path
    // still has to come back as a ValidationError rather than a driver string.
    const client = createEventRequestClient([
      dbError('23514', 'new row violates check constraint "event_requests_dates_ordered"'),
    ]);

    const err = await errorFrom(createEventRequest(DRAFT_INPUT, ORGANISER_ID, { client }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
  });

  it('SCRUM10_AC4_translates_a_unique_violation_into_a_conflict', async () => {
    const client = createEventRequestClient([
      dbError('23505', 'duplicate key value violates unique constraint'),
    ]);

    const err = await errorFrom(createEventRequest(DRAFT_INPUT, ORGANISER_ID, { client }));

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
  });

  it('SCRUM10_AC4_passes_an_unrecognised_database_error_through_untyped', async () => {
    // Deliberately not dressed up as a ValidationError. An unrecognised code is
    // not the Organiser's fault and there is nothing for them to fix, so it
    // must not arrive at the API as a 400 telling them to correct their form.
    const client = createEventRequestClient([dbError('08006', 'connection failure')]);

    const err = await errorFrom(createEventRequest(DRAFT_INPUT, ORGANISER_ID, { client }));

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err).not.toBeInstanceOf(ConflictError);
    expect(err).not.toBeInstanceOf(NotFoundError);
    expect(err.status).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// Reading one record
// ---------------------------------------------------------------------------
describe('AC2: one record is read back and mapped', () => {
  it('SCRUM10_AC2_reads_one_record_by_id_and_maps_it', async () => {
    const client = createEventRequestClient([ok(storedRow())]);

    const record = await getEventRequestById(REQUEST_ID, { client });

    expect(client.calls[0].table).toBe('event_requests');
    expect(client.calls[0].filters).toContainEqual(['id', REQUEST_ID]);
    expect(record).toMatchObject({
      id: REQUEST_ID,
      eventName: 'IS212 Industry Night',
      status: STATUS.DRAFT,
    });
  });

  it('SCRUM10_AC4_raises_not_found_when_the_record_is_absent', async () => {
    // maybeSingle returns data: null for no match rather than erroring, so an
    // absent row is indistinguishable from a successful read unless the service
    // says so. Left unchecked, the caller would get null and fail later.
    const client = createEventRequestClient([ok(null)]);

    const err = await errorFrom(getEventRequestById(REQUEST_ID, { client }));

    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
  });
});


// ---------------------------------------------------------------------------
// Submitting for review -- refusals the service still makes itself
// ---------------------------------------------------------------------------
// Two refusals still happen in the service, before any write is attempted:
// a request that does not exist, and a draft that is not complete. Both tests
// below predate SCRUM-330 and still hold unchanged, because the new path keeps
// the read and the validation in front of the function call.
describe('AC4: an incomplete or missing request is not submitted', () => {
  it('SCRUM10_AC4_refuses_an_incomplete_draft_and_names_every_gap', async () => {
    // The whole reason submission re-validates instead of trusting the client.
    // A draft is saved permissively by design -- the enum starts at 'draft' and
    // SCRUM-11 depends on partial saves working -- so the row may legitimately
    // be incomplete, and the Coordinator must not be handed a request they
    // cannot act on. All four gaps are reported at once so the Organiser fixes
    // the form in one pass.
    const client = createEventRequestClient([
      ok(
        storedRow({
          purpose: null,
          proposed_start: null,
          proposed_end: null,
          expected_attendance: null,
        }),
      ),
    ]);

    const err = await errorFrom(submitEventRequest(REQUEST_ID, { client, now: NOW }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err).sort()).toEqual([
      'expectedAttendance',
      'proposedEnd',
      'proposedStart',
      'purpose',
    ]);
    // Read only. Nothing was written, so the draft is exactly as it was.
    expect(client.calls).toHaveLength(1);
  });

  it('SCRUM10_AC4_raises_not_found_when_submitting_a_missing_record', async () => {
    const client = createEventRequestClient([ok(null)]);

    const err = await errorFrom(submitEventRequest(REQUEST_ID, { client, now: NOW }));

    expect(err).toBeInstanceOf(NotFoundError);
    expect(client.calls).toHaveLength(1);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-330 -- submitting assigns a coordinator, in one transaction
// ---------------------------------------------------------------------------
// The new shape of submitEventRequest: resolve the client, read the row, run
// validateSubmitEventRequest against it, then call submit_event_request
// (migration 016) through rpc. The function locks the row, checks it is still
// a draft, writes status and submitted_at, and inserts the history row, all in
// one transaction. Since 052 it assigns no coordinator; the Lead does.
//
// What these tests deliberately do not cover, and where it is covered instead:
//   - which coordinator is chosen: the Lead chooses, through
//     assign_event_request, which the database suites test. A fake can only
//     return whatever id it is given, so a test here would prove nothing about
//     the choice.
//   - the history row's contents: it is written inside the function and never
//     reaches the client, so there is nothing for the fake to observe.
//   - reassignment: a separate subtask.
//
// SCRUM-486 (SCRUM-522). Everything above about choosing a coordinator was
// SCRUM-327's requirement, and right until the customer changed it on
// 11 October: 052's submit_event_request chooses nobody, writes no assignment
// row, and leaves the request for the Event Coordinator Lead. The service call
// itself did not change -- one read, one rpc, the same three arguments -- so
// the tests below keep their assertions about it; what moved is the row the
// function returns, and the names and fixtures that said "assigned".

/**
 * The row submit_event_request returns: submitted and timed, with no
 * coordinator. Until SCRUM-486 it was "submitted, timed and assigned", with
 * assigned_coordinator_id set, because 016 assigned one. 052 does not.
 */
function submittedRow() {
  return storedRow({
    status: STATUS.SUBMITTED,
    submitted_at: NOW.toISOString(),
    assigned_coordinator_id: null,
  });
}

/** Read a complete draft, then answer the rpc with `rpcResult`. */
const submittingWith = (rpcResult, row = storedRow()) =>
  createEventRequestClient([ok(row), rpcResult]);

describe('SCRUM-327 AC1, as amended by SCRUM-486: submission is one call, and assigns nobody', () => {
  it('SCRUM330_AC1_never_submits_an_incomplete_draft', async () => {
    // Was SCRUM330_AC1_never_assigns_a_coordinator_to_an_incomplete_draft.
    // Right when written, and trivially still true, since nothing assigns a
    // coordinator on submission any more; renamed to what it proves, that an
    // incomplete draft is never submitted at all (the function is not called).
    //
    // Validation stays in the service, before the function, for two reasons.
    // First, validateSubmitEventRequest reports every gap at once, which a
    // Postgres exception cannot. Second, and more importantly here: 016's
    // function has no completeness check of its own (its header says so), so
    // this validation is the only thing that stops an incomplete draft being
    // submitted (and, before SCRUM-486, given a coordinator). The assertion that matters is
    // therefore that the function is never called, not merely that an error
    // came back.
    const client = createEventRequestClient([
      ok(storedRow({ purpose: null, expected_attendance: null })),
    ]);

    const err = await errorFrom(submitEventRequest(REQUEST_ID, { client, now: NOW }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err).sort()).toEqual(['expectedAttendance', 'purpose']);
    expect(rpcCallsOf(client)).toHaveLength(0);
  });

  it('SCRUM330_AC1_submits_through_one_call_that_names_no_coordinator', async () => {
    // Was SCRUM330_AC1_assigns_a_coordinator_on_submission. Its assertions
    // all still hold and are unchanged; its name and the reason it gave --
    // "the service does not choose one, the function does (015)" -- became
    // false when 052 stopped the function choosing. The reason it still holds
    // now: nobody is chosen at submission; the Lead chooses later
    // (assign_event_request). SCRUM-486 AC1-03.
    //
    // One read, then exactly one call to the function, and nothing else. The
    // arguments are compared with toEqual, so an extra argument fails the test
    // as surely as a missing one. In particular, nothing names a coordinator.
    //
    // p_submitted_at is the injected `now` as an ISO string. The clock stays
    // in the service, as 005 and 016 both record, so this test can state the
    // exact instant rather than "roughly now".
    const client = submittingWith(ok(submittedRow()));

    await submitEventRequest(REQUEST_ID, { client, now: NOW });

    expect(client.calls.map((call) => call.operation)).toEqual(['select', 'rpc']);
    expect(client.calls[0].filters).toContainEqual(['id', REQUEST_ID]);

    const [rpc] = rpcCallsOf(client);
    expect(rpc.fn).toBe('submit_event_request');
    expect(rpc.args).toEqual({
      p_event_request_id: REQUEST_ID,
      p_submitted_at: NOW.toISOString(),
      p_changed_by: ORGANISER_ID,
    });
  });

  it('SCRUM330_AC1_returns_the_submitted_request_in_camelCase_with_no_coordinator', async () => {
    // Was SCRUM330_AC1_returns_the_assigned_coordinator_in_camelCase, with a
    // fixture whose coordinator it expected back. Right when written: 016
    // returned every submitted row with one. Since 052 the row comes back with
    // none (SCRUM-486 AC1-03), so the fixture says so and the expectation is
    // null -- the key present, not missing, which is what lets the Organiser's
    // screen say "waiting for the Lead" (SCRUM-520) rather than nothing.
    //
    // The row the function returns goes through toEventRequest like every
    // other row this module returns, so the caller sees camelCase and never
    // assigned_coordinator_id.
    //
    // This needs two changes in the implementation, not just the rpc call:
    // toEventRequest has to map the new column, and COLUMNS has to select it,
    // or every *read* (GET /:id, the lists, the queue) would quietly omit it.
    // That is how the decision columns from 010 were left out of every API
    // response. The second assertion block pins COLUMNS through the read this
    // same call makes, so the omission cannot happen again unnoticed.
    const client = submittingWith(ok(submittedRow()));

    const record = await submitEventRequest(REQUEST_ID, { client, now: NOW });

    expect(record).toHaveProperty('assignedCoordinatorId', null);
    expect(record).toHaveProperty('reviewingCoordinatorId', null);
    expect(record.status).toBe(STATUS.SUBMITTED);
    expect(instantOf(record.submittedAt)).toBe(NOW.getTime());
    expect(Object.keys(record).some((key) => key.includes('_'))).toBe(false);

    expect(client.calls[0].select).toContain('assigned_coordinator_id');
  });

  it('SCRUM330_AC1_submits_only_through_the_function', async () => {
    // The brief offered two ways to show the transition check left the
    // service: assert canTransition is not called, or assert that no update
    // reaches the client. This asserts the second, for three reasons.
    //   - It is observable through the fake this file already uses. Spying on
    //     canTransition would need vi.mock over the domain module, the mocking
    //     DSL this file avoids so that every test can be explained without it.
    //   - "canTransition was not called" would still pass if someone replaced
    //     it with a local `status === 'draft'` check, which is exactly the
    //     second copy of the rule this change exists to remove.
    //   - It is the failure that matters. A .from('event_requests').update()
    //     alongside the rpc would be a write outside the function's
    //     transaction, which is the thing 016 was written to prevent.
    // The next test covers the other half: that no local check survives.
    const client = submittingWith(ok(submittedRow()));

    await submitEventRequest(REQUEST_ID, { client, now: NOW });

    expect(client.calls.some((call) => call.operation === 'update')).toBe(false);
    expect(client.calls.some((call) => call.operation === 'insert')).toBe(false);
  });

  it('SCRUM330_AC1_leaves_the_draft_check_to_the_function', async () => {
    // A row the service reads as 'approved' is still sent to the function, and
    // the refusal comes back from it. That is the proof that the service
    // makes no status check of its own -- not canTransition, not anything
    // else. The function's check is the one that counts, because it runs
    // under the row lock. The service's read is already stale by the time it
    // could act on it, so a local check could only ever duplicate the rule or
    // disagree with it.
    const client = submittingWith(
      dbError('55000', `event request ${REQUEST_ID} has status approved, and only a draft can be submitted`),
      storedRow({ status: STATUS.APPROVED }),
    );

    const err = await errorFrom(submitEventRequest(REQUEST_ID, { client, now: NOW }));

    expect(rpcCallsOf(client)).toHaveLength(1);
    expect(err).toBeInstanceOf(ConflictError);
  });
});


describe("SCRUM-330: the function's refusals become typed errors", () => {
  // 016 raises each refusal under its own SQLSTATE so translateError can map
  // them by error.code, the way it already maps 23514 and 23503, rather than
  // by matching message text. Every test here also asserts the function was
  // actually called, so it cannot pass by the refusal coming from somewhere
  // else, such as the old .update() path answering the same queued error.

  it('SCRUM330_AC1_translates_a_request_that_vanished_into_not_found', async () => {
    // P0002, no_data_found. The read found the row, so this means it was
    // deleted between the read and the function taking its lock. Raised the
    // way process_change_request (006) raises it, and already mapped by
    // translateError.
    const client = submittingWith(dbError('P0002', `event request ${REQUEST_ID} not found`));

    const err = await errorFrom(submitEventRequest(REQUEST_ID, { client, now: NOW }));

    expect(rpcCallsOf(client)).toHaveLength(1);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
  });

  it('SCRUM330_AC1_reports_a_request_that_is_no_longer_a_draft_as_a_conflict', async () => {
    // 55000, object_not_in_prerequisite_state. This is now how a draft is
    // submitted once and only once (SCRUM-10 AC6). A second submit waits on
    // the first one's row lock, then finds the row no longer a draft. It
    // replaces the PGRST116 guard the service used to carry, whose test this
    // file no longer has.
    //
    // The message must name the status, and it must be the function's
    // message. Here the service read the row as a draft, and the function
    // reports 'cancelled' (draft -> cancelled is a legal move in
    // ALLOWED_TRANSITIONS). The service's own read cannot know that, so the
    // test passes only if translateError carries the database's message
    // through. That message is the true one, because it was read under the
    // lock.
    const client = submittingWith(
      dbError('55000', `event request ${REQUEST_ID} has status cancelled, and only a draft can be submitted`),
    );

    const err = await errorFrom(submitEventRequest(REQUEST_ID, { client, now: NOW }));

    expect(rpcCallsOf(client)).toHaveLength(1);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/cancelled/);
  });

  it('SCRUM486_AC11_submission_no_longer_reports_a_missing_coordinator_as_a_503', async () => {
    // AC11-03. Was SCRUM330_AC5_refuses_when_no_coordinator_is_available,
    // which pinned SCRUM-327 AC5: P0001 from pick_event_coordinator finding
    // nobody became a ServiceUnavailableError, a 503 with the AC's message.
    // Right then. Since 052 submission chooses no coordinator, so it cannot
    // raise that, and translateError has no P0001 branch. A P0001 arriving here
    // now would be unexpected, and is reported as the untyped server fault it
    // is, not as "try again later".
    const client = submittingWith(dbError('P0001', 'No coordinator is available; please try again later'));

    const err = await errorFrom(submitEventRequest(REQUEST_ID, { client, now: NOW }));

    expect(rpcCallsOf(client)).toHaveLength(1);
    expect(err).not.toBeInstanceOf(ServiceUnavailableError);
    expect(err.status).toBeUndefined();
    expect(client.calls.some((call) => call.operation === 'update')).toBe(false);
  });

  it('SCRUM330_AC1_treats_a_missing_submission_time_as_a_server_fault', async () => {
    // 22004, null_value_not_allowed: the function was handed no submission
    // time. Only a bug in the service can cause that, because the service
    // always supplies `now`. So it must not come back as an AppError: a 400
    // would tell the Organiser to fix a form that has nothing wrong with it.
    // Left untyped, the route logs it and answers a 500, the same treatment
    // SCRUM10_AC4_passes_an_unrecognised_database_error_through_untyped
    // already pins for any code nobody anticipated.
    const client = submittingWith(
      dbError('22004', 'submit_event_request needs a submission time'),
    );

    const err = await errorFrom(submitEventRequest(REQUEST_ID, { client, now: NOW }));

    expect(rpcCallsOf(client)).toHaveLength(1);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AppError);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-331 -- the assigned coordinator hands the event to a colleague
// ---------------------------------------------------------------------------
// reassignEventRequest(id, { newCoordinatorId, handoverNote }, assignedBy,
// { client }) calls reassign_event_request (migration 018) through rpc. The
// function locks the row, checks the caller is the assigned coordinator, the
// status allows a handover and the new coordinator holds the role, then moves
// assigned_coordinator_id (and reviewing_coordinator_id, before a decision)
// and writes the history row, all in one transaction.
//
// The signature has the shape of updateEventRequest(id, changes, organiserId)
// and respondToEventClarification, not four positional arguments. Two of the
// values are uuids, and in a positional list they can be swapped without any
// error. Grouping what the caller asked for in one object, and taking the
// person acting from the token separately, makes that mistake impossible and
// lets the route hand req.body over untouched.
//
// Deliberately not tested here, and where it is covered instead:
//   - whether reviewing_coordinator_id moves with the handover: that rule
//     belongs to the function (018). A fake returns whatever row it is given,
//     so a test here could only check the fixture against itself.
//   - the history row's contents: written inside the function, never returned.
//   - how a coordinator is chosen: by the Lead, through assign_event_request.

/** The coordinator the event is handed to. COORDINATOR_ID is the one handing over. */
const NEW_COORDINATOR_ID = '66666666-6666-4666-8666-666666666666';

const HANDOVER_NOTE = 'On leave from Monday. The venue shortlist is in the notes.';

/** The row reassign_event_request returns: undecided, so the reviewer moved too. */
function reassignedRow() {
  return storedRow({
    status: STATUS.UNDER_REVIEW,
    submitted_at: NOW.toISOString(),
    assigned_coordinator_id: NEW_COORDINATOR_ID,
    reviewing_coordinator_id: NEW_COORDINATOR_ID,
  });
}

/** One queued answer: the function's. reassignEventRequest makes no read. */
const reassigningWith = (rpcResult) => createEventRequestClient([rpcResult]);

const reassign = (client, changes = { newCoordinatorId: NEW_COORDINATOR_ID, handoverNote: HANDOVER_NOTE }) =>
  reassignEventRequest(REQUEST_ID, changes, COORDINATOR_ID, { client });

describe('SCRUM-327 AC6, AC7, AC9: an event is handed to another coordinator', () => {
  it('SCRUM331_AC9_records_who_handed_it_over', async () => {
    // One call to the function, and nothing else, not even a read. Every
    // question a read could answer (does the event exist, is the caller its
    // coordinator, does the status allow it) is answered by the function
    // while it holds the row lock. A read here would only give an answer that
    // could be out of date by the time the function ran.
    //
    // The arguments are compared with toEqual, so an extra argument fails as
    // surely as a missing one. p_assigned_by is the caller passed in from the
    // token, never anything from the request body. A non-null assigned_by is
    // also what marks this history row as a person's handover rather than a
    // system assignment (014's convention).
    const client = reassigningWith(ok(reassignedRow()));

    await reassign(client);

    expect(client.calls.map((call) => call.operation)).toEqual(['rpc']);

    const [rpc] = rpcCallsOf(client);
    expect(rpc.fn).toBe('reassign_event_request');
    expect(rpc.args).toEqual({
      p_event_request_id: REQUEST_ID,
      p_new_coordinator_id: NEW_COORDINATOR_ID,
      p_assigned_by: COORDINATOR_ID,
      p_handover_note: HANDOVER_NOTE,
    });
  });

  it('SCRUM331_AC9_sends_an_omitted_or_blank_note_as_null', async () => {
    // The note is optional. 014 makes normalising a blank note to null the
    // service's job, and 018 stores whatever it is given, so this is the only
    // place it can happen. A note of spaces says nothing, and stored as text it
    // would show up in the history as a note that is empty.
    const omitted = reassigningWith(ok(reassignedRow()));
    await reassign(omitted, { newCoordinatorId: NEW_COORDINATOR_ID });

    const blank = reassigningWith(ok(reassignedRow()));
    await reassign(blank, { newCoordinatorId: NEW_COORDINATOR_ID, handoverNote: '   ' });

    expect(rpcCallsOf(omitted)[0].args.p_handover_note).toBeNull();
    expect(rpcCallsOf(blank)[0].args.p_handover_note).toBeNull();
  });

  it('SCRUM331_AC7_the_new_coordinator_can_act_on_the_event', async () => {
    // The row comes back through toEventRequest like every other row, so the
    // caller sees the new coordinator as assignedCoordinatorId. It also sees
    // reviewingCoordinatorId, because "can act on the event" means "can decide
    // it", and 010's decided_by_is_reviewer makes the reviewer the only person
    // who can. This is the column the function moves on an undecided handover.
    //
    // reviewingCoordinatorId needs COLUMNS and toEventRequest to carry
    // reviewing_coordinator_id, which is part of the implementation.
    // assigned_coordinator_id went in with SCRUM-330. reviewing_coordinator_id
    // is one of the five decision columns from 010 that have never reached an
    // API response, and this is the first of them to need to.
    const client = reassigningWith(ok(reassignedRow()));

    const record = await reassign(client);

    expect(record.assignedCoordinatorId).toBe(NEW_COORDINATOR_ID);
    expect(record.reviewingCoordinatorId).toBe(NEW_COORDINATOR_ID);
    expect(Object.keys(record).some((key) => key.includes('_'))).toBe(false);
  });

  it('SCRUM331_AC7_every_read_carries_the_reviewer', async () => {
    // The other half of the line above. Any read, not just the handover's
    // own response, has to carry the reviewer, or a coordinator who opened
    // the event a moment later would not see who can decide it. COLUMNS is
    // what every read selects, so it is pinned through an ordinary read.
    const client = createEventRequestClient([
      ok(storedRow({ reviewing_coordinator_id: NEW_COORDINATOR_ID })),
    ]);

    const record = await getEventRequestById(REQUEST_ID, { client });

    expect(client.calls[0].select).toContain('reviewing_coordinator_id');
    expect(record.reviewingCoordinatorId).toBe(NEW_COORDINATOR_ID);
  });

  it('SCRUM331_AC9_writes_nothing_outside_the_function', async () => {
    // Both writes, the event's new coordinator and the history row, happen
    // inside the function's transaction. A .update() or .insert() from the
    // service alongside the rpc would be a write outside it, which is exactly
    // what 018 was written to prevent: a coordinator changed with no record of
    // the handover, or a record of a handover that never happened.
    const client = reassigningWith(ok(reassignedRow()));

    await reassign(client);

    expect(client.calls.some((call) => call.operation === 'update')).toBe(false);
    expect(client.calls.some((call) => call.operation === 'insert')).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['malformed', 'not-a-real-id'],
  ])('SCRUM331_AC7_refuses_a_new_coordinator_id_that_is_%s_before_calling_the_function', async (_label, value) => {
    // The service checks this itself, before the rpc, rather than leaving it
    // to the function. The function would refuse a null with 22023, but it
    // never sees the other three. p_new_coordinator_id is a uuid parameter, so
    // PostgREST fails to read '', '   ' or 'not-a-real-id' as one (22P02)
    // before the function body runs. translateError does not recognise that
    // code, so the Organiser's colleague would get a 500 for a form fault. A
    // check here answers all four as a 400 that names the field, without
    // taking a row lock to do it. The function's own check stays as the
    // backstop for any caller that does not go through the service.
    const client = createEventRequestClient([]);

    const err = await errorFrom(reassign(client, { newCoordinatorId: value, handoverNote: HANDOVER_NOTE }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(fieldsIn(err)).toContain('newCoordinatorId');
    expect(client.calls).toHaveLength(0);
  });
});


describe("SCRUM-331: the function's refusals become typed errors", () => {
  // One row per SQLSTATE 018 raises. Each asserts the function was actually
  // called, so a refusal cannot pass by coming from somewhere else.
  //
  // `exact` marks the codes whose message is passed through untouched,
  // matching 55000 and P0001 under SCRUM-330: the text comes from `raise
  // exception` in our own function and was written for the person who made
  // the request. 23514 is the exception. translateError wraps every check
  // violation ("A value was rejected by the database: ..."), because most of
  // them come from Postgres's own constraint messages. It cannot tell 018's
  // check_violation from one of those by code alone, so the message is only
  // required to contain the function's text.
  it.each([
    {
      name: 'SCRUM331_AC6_reports_an_event_that_does_not_exist_as_not_found',
      code: 'P0002',
      message: `event request ${REQUEST_ID} not found`,
      Err: NotFoundError,
      status: 404,
      exact: false,
    },
    {
      // AC6 itself. Raised under the row lock, so it is also how the second of
      // two simultaneous handovers is refused: by the time it runs, the caller
      // no longer holds the event (see 018's header).
      //
      // Was SCRUM331_AC6_only_the_assigned_coordinator_can_hand_over, with
      // 018's message. Right when written: only the holder could hand over.
      // Since 052 (SCRUM-486 AC6) the Lead may too, so "only the assigned
      // coordinator" is no longer the rule, and the message the function
      // raises names both. Renamed to the refusal that is still true, with
      // 052's text; what is asserted (a 42501 becomes a 403 with the message
      // passed through untouched) is unchanged.
      name: 'SCRUM331_AC6_a_caller_who_neither_holds_the_event_nor_leads_is_refused',
      code: '42501',
      message: `only the coordinator assigned to event request ${REQUEST_ID}, or the Event Coordinator Lead, can hand it over`,
      Err: ForbiddenError,
      status: 403,
      exact: true,
    },
    {
      name: 'SCRUM331_AC6_refuses_a_status_that_does_not_allow_a_handover',
      code: '55000',
      message: `event request ${REQUEST_ID} has status planning, and cannot be handed over in that status`,
      Err: ConflictError,
      status: 409,
      exact: true,
    },
    {
      name: 'SCRUM331_AC7_refuses_a_new_coordinator_who_is_not_an_event_coordinator',
      code: '22023',
      message: `user ${NEW_COORDINATOR_ID} is not an Event Coordinator, so cannot be handed event request ${REQUEST_ID}`,
      Err: ValidationError,
      status: 400,
      exact: true,
    },
    {
      name: 'SCRUM331_AC7_refuses_a_handover_to_the_current_coordinator',
      code: '23514',
      message: `event request ${REQUEST_ID} is already assigned to that coordinator`,
      Err: ValidationError,
      status: 400,
      exact: false,
    },
    {
      // The guarded update matched no row. 018 says this cannot happen while
      // the row lock is held, and that if it ever does, the locking has
      // broken. The caller should still get a conflict, not a 500.
      name: 'SCRUM331_AC6_reports_a_handover_that_lost_a_race_as_a_conflict',
      code: '40001',
      message: `event request ${REQUEST_ID} changed hands while this handover was being made`,
      Err: ConflictError,
      status: 409,
      exact: true,
    },
  ])('$name', async ({ code, message, Err, status, exact }) => {
    const client = reassigningWith(dbError(code, message));

    const err = await errorFrom(reassign(client));

    expect(rpcCallsOf(client)).toHaveLength(1);
    expect(err).toBeInstanceOf(Err);
    expect(err.status).toBe(status);
    if (exact) {
      expect(err.message).toBe(message);
    } else {
      expect(err.message).toContain(message);
    }
  });
});


// ---------------------------------------------------------------------------
// The client seam
// ---------------------------------------------------------------------------
describe('AC3: the service is usable without credentials', () => {
  it('SCRUM10_AC3_loads_and_runs_with_no_credentials_configured', async () => {
    // The static import at the top of this file is the real assertion here: if
    // the service imported src/config/supabaseClient.js eagerly, that module
    // would throw for a missing SUPABASE_URL and this suite would fail to
    // collect on any machine without a .env, CI included. What is left to check
    // is that the exports arrived and that a supplied client is genuinely used
    // in place of the default one -- no real client is ever constructed.
    expect(typeof createEventRequest).toBe('function');
    expect(typeof submitEventRequest).toBe('function');
    expect(typeof getEventRequestById).toBe('function');

    const client = createEventRequestClient([ok(storedRow())]);
    await getEventRequestById(REQUEST_ID, { client });

    expect(client.calls).toHaveLength(1);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-42 -- retrieving an Organiser's requests and their statuses
// ---------------------------------------------------------------------------
const OTHER_ORGANISER_ID = '33333333-3333-4333-8333-333333333333';

describe("AC1: an Organiser sees their own requests and no one else's", () => {
  it('SCRUM14_AC1_filters_the_query_on_the_organiser', async () => {
    const client = createEventRequestClient([ok([storedRow()])]);

    await listEventRequestsForOrganiser(ORGANISER_ID, { client });

    const [call] = client.calls;
    expect(call.table).toBe('event_requests');
    expect(call.operation).toBe('select');

    // The filter is the entire access control on this endpoint: there is no id
    // in the path, so nothing else narrows the table.
    expect(call.filters).toEqual([['organiser_id', ORGANISER_ID]]);
  });

  it('SCRUM14_AC1_returns_an_empty_list_rather_than_an_error_when_there_are_none', async () => {
    const client = createEventRequestClient([ok([])]);

    // A new client who has not raised a request yet is an ordinary state, not
    // a 404. The distinction matters at the route: MyEventRequests renders an
    // empty list as "no requests yet" and a 404 as a failure.
    await expect(listEventRequestsForOrganiser(ORGANISER_ID, { client })).resolves.toEqual([]);
  });

  it('SCRUM14_AC1_survives_a_null_data_payload', async () => {
    // PostgREST can answer an empty result set with null rather than [].
    const client = createEventRequestClient([ok(null)]);

    await expect(listEventRequestsForOrganiser(ORGANISER_ID, { client })).resolves.toEqual([]);
  });

  it('SCRUM14_AC1_maps_every_row_into_camelCase', async () => {
    const client = createEventRequestClient([
      ok([
        storedRow({ id: 'a', status: STATUS.SUBMITTED }),
        storedRow({ id: 'b', status: STATUS.UNDER_REVIEW }),
      ]),
    ]);

    const requests = await listEventRequestsForOrganiser(ORGANISER_ID, { client });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      id: 'a',
      organiserId: ORGANISER_ID,
      eventName: 'IS212 Industry Night',
      status: STATUS.SUBMITTED,
    });

    // No snake_case key leaks upward on any element, not just the first.
    for (const request of requests) {
      expect(Object.keys(request).some((key) => key.includes('_'))).toBe(false);
    }
  });

  it('SCRUM14_AC1_refuses_to_query_at_all_without_an_organiser', async () => {
    const client = createEventRequestClient([ok([storedRow()])]);

    const err = await errorFrom(listEventRequestsForOrganiser(undefined, { client }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err)).toEqual(['organiserId']);

    // The point of the assertion: a missing organiser must not reach the
    // database as an unfiltered read of the whole table.
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM14_AC1_translates_a_database_failure_rather_than_leaking_it', async () => {
    const client = createEventRequestClient([dbError('42P01', 'relation does not exist')]);

    const err = await errorFrom(listEventRequestsForOrganiser(ORGANISER_ID, { client }));

    // An unrecognised code stays untyped, so it cannot reach the API dressed as
    // a 400 telling an Organiser to correct a form they filled in correctly.
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err.status).toBeUndefined();
  });

  it('SCRUM14_AC1_returns_the_request_when_the_organiser_matches', async () => {
    const client = createEventRequestClient([ok(storedRow({ status: STATUS.UNDER_REVIEW }))]);

    const request = await getEventRequestForOrganiser(REQUEST_ID, ORGANISER_ID, { client });

    expect(request).toMatchObject({ id: REQUEST_ID, status: STATUS.UNDER_REVIEW });
  });

  it("SCRUM14_AC1_hides_another_organisers_request_behind_a_not_found", async () => {
    const client = createEventRequestClient([ok(storedRow({ organiser_id: OTHER_ORGANISER_ID }))]);

    const err = await errorFrom(getEventRequestForOrganiser(REQUEST_ID, ORGANISER_ID, { client }));

    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
  });

  it('SCRUM14_AC1_answers_a_foreign_request_exactly_as_it_answers_a_missing_one', async () => {
    const foreign = createEventRequestClient([ok(storedRow({ organiser_id: OTHER_ORGANISER_ID }))]);
    const missing = createEventRequestClient([ok(null)]);

    const foreignErr = await errorFrom(
      getEventRequestForOrganiser(REQUEST_ID, ORGANISER_ID, { client: foreign }),
    );
    const missingErr = await errorFrom(
      getEventRequestForOrganiser(REQUEST_ID, ORGANISER_ID, { client: missing }),
    );

    // Identical down to the message. A different wording for "exists but is not
    // yours" would be the same enumeration oracle the 404 status code avoids.
    expect(foreignErr.message).toBe(missingErr.message);
  });

  it('SCRUM14_AC1_refuses_a_single_read_without_an_organiser', async () => {
    const client = createEventRequestClient([ok(storedRow())]);

    const err = await errorFrom(getEventRequestForOrganiser(REQUEST_ID, '', { client }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(client.calls).toHaveLength(0);
  });
});


describe('AC4: the most recently changed request is listed first', () => {
  it('SCRUM14_AC4_orders_by_updated_at_descending', async () => {
    const client = createEventRequestClient([ok([storedRow()])]);

    await listEventRequestsForOrganiser(ORGANISER_ID, { client });

    // updated_at is maintained by the event_requests_set_updated_at trigger
    // (001), so a status change moves the request to the top of the list. That
    // is AC4 expressed as an ordering rather than as a push.
    expect(client.calls[0].order[0]).toEqual(['updated_at', { ascending: false }]);
  });

  it('SCRUM14_AC4_breaks_ties_deterministically', async () => {
    const client = createEventRequestClient([ok([storedRow()])]);

    await listEventRequestsForOrganiser(ORGANISER_ID, { client });

    // A bulk update writes the same now() to several rows. Without this the
    // list can reshuffle between two refetches that read identical data, which
    // reads as movement where nothing happened.
    expect(client.calls[0].order[1]).toEqual(['id', { ascending: false }]);
  });
});


describe('AC1: the list is usable without credentials', () => {
  it('SCRUM14_AC1_lists_with_no_credentials_configured', async () => {
    // Mirrors the SCRUM-10 test above: a supplied client is genuinely used in
    // place of the default one, so no real Supabase client is ever constructed
    // and the suite keeps running in CI with no .env.
    expect(typeof listEventRequestsForOrganiser).toBe('function');
    expect(typeof getEventRequestForOrganiser).toBe('function');

    const client = createEventRequestClient([ok([storedRow()])]);
    await listEventRequestsForOrganiser(ORGANISER_ID, { client });

    expect(client.calls).toHaveLength(1);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-11 -- saving an Organiser's edits to their own draft
// ---------------------------------------------------------------------------
/**
 * Both bindings are imported here rather than added to the import block at the
 * top of the file, and that is deliberate rather than untidy. The rest of this
 * suite is the regression gate for SCRUM-10, SCRUM-31 and SCRUM-42, and the
 * one thing that must be provable at a glance is that nothing above this line
 * moved -- including an import line, which is the only part of a file an
 * append can otherwise disturb. An ESM import declaration is hoisted wherever
 * it is written, so these bind exactly as they would at the top.
 *
 * The second import is not for any test to call. It IS the test: see the seam
 * guard at the bottom of this file.
 */
import { updateEventRequest } from '../../src/services/eventRequestService.js';
import * as eventChangeRequestService from '../../src/services/eventChangeRequestService.js';


describe('SCRUM-11: a draft is updated in place', () => {
  it('SCRUM11_AC1_writes_only_the_columns_the_organiser_changed', async () => {
    const client = createEventRequestClient([
      ok(storedRow()),
      ok(storedRow({ event_name: 'IS212 Industry Evening' })),
    ]);

    const saved = await updateEventRequest(
      REQUEST_ID,
      { eventName: 'IS212 Industry Evening' },
      ORGANISER_ID,
      { client },
    );

    // Exactly one column, not nine. A PATCH that resent every field would let
    // a stale tab silently revert an answer somebody else had just corrected,
    // and would make the empty-change-set rule pointless.
    expect(client.calls[1].operation).toBe('update');
    expect(client.calls[1].payload).toEqual({ event_name: 'IS212 Industry Evening' });
    expect(saved.eventName).toBe('IS212 Industry Evening');
  });

  it('SCRUM11_AC1_reads_for_ownership_before_it_writes', async () => {
    const client = createEventRequestClient([ok(storedRow()), ok(storedRow())]);

    await updateEventRequest(REQUEST_ID, { purpose: 'Careers.' }, ORGANISER_ID, { client });

    // Two round trips, in this order. The read is what answers existence and
    // ownership together with the non-oracle 404; without it the write would
    // be the first thing that touched the row, and a miss would be reported
    // as a conflict rather than a not-found.
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0].operation).toBe('select');
    expect(client.calls[0].filters).toEqual([['id', REQUEST_ID]]);
    expect(client.calls[1].operation).toBe('update');
  });

  it('SCRUM11_AC1_guards_the_write_on_id_owner_and_draft_status', async () => {
    const client = createEventRequestClient([ok(storedRow()), ok(storedRow())]);

    await updateEventRequest(REQUEST_ID, { purpose: 'Careers.' }, ORGANISER_ID, { client });

    // Asserted as a whole rather than with toContainEqual, because each filter
    // is doing separate work and dropping any one of them is a different bug.
    //
    //  - id narrows to the row.
    //  - organiser_id can never fire, because organiser_id never changes and
    //    ownership was proved a moment ago. It is there so the statement sent
    //    to a deny-all table is structurally incapable of touching a foreign
    //    row, rather than safe only because of a check made in an earlier
    //    round trip.
    //  - status is the one that matters. The read above and this write are two
    //    round trips with no transaction spanning them, so a submit landing in
    //    the gap would otherwise let this write mutate a request a Coordinator
    //    is already reading.
    expect(client.calls[1].filters).toEqual([
      ['id', REQUEST_ID],
      ['organiser_id', ORGANISER_ID],
      ['status', STATUS.DRAFT],
    ]);
  });

  it('SCRUM11_AC1_returns_the_same_shape_create_and_submit_return', async () => {
    const client = createEventRequestClient([ok(storedRow()), ok(storedRow())]);

    const saved = await updateEventRequest(
      REQUEST_ID,
      { eventName: 'IS212 Industry Night' },
      ORGANISER_ID,
      { client },
    );

    // No new shape enters the system. A route can hand this to the same
    // withStatusDisplay projection it uses for every other event-shaped
    // response, and the form reads saved.id and saved.status off it.
    expect(saved).toMatchObject({
      id: REQUEST_ID,
      organiserId: ORGANISER_ID,
      status: STATUS.DRAFT,
    });
    expect(Object.keys(saved).some((key) => key.includes('_'))).toBe(false);
  });

  it('SCRUM11_AC1_cannot_be_made_to_write_status_or_the_timestamp_columns', async () => {
    const client = createEventRequestClient([ok(storedRow()), ok(storedRow())]);

    await updateEventRequest(
      REQUEST_ID,
      {
        eventName: 'IS212 Industry Night',
        status: STATUS.APPROVED,
        organiserId: OTHER_ORGANISER_ID,
        id: 'a-chosen-id',
        submittedAt: '2026-01-01T00:00:00+00:00',
        updatedAt: '2026-01-01T00:00:00+00:00',
      },
      ORGANISER_ID,
      { client },
    );

    // Safe by construction rather than by discipline, and worth pinning so
    // nobody has to re-derive it nervously: toColumns iterates COLUMN_BY_FIELD,
    // a frozen allow-list of exactly nine columns, and none of these is in it.
    // So the trigger stays sole authority on updated_at, and
    // event_requests_submitted_at_matches_status cannot be violated from here.
    // If someone ever "simplifies" toColumns into a spread, this is the test
    // that fails.
    expect(client.calls[1].payload).toEqual({ event_name: 'IS212 Industry Night' });
  });

  it('SCRUM11_AC1_hides_another_organisers_draft_behind_a_not_found', async () => {
    const client = createEventRequestClient([ok(storedRow({ organiser_id: OTHER_ORGANISER_ID }))]);

    const err = await errorFrom(
      updateEventRequest(REQUEST_ID, { eventName: 'Not mine' }, ORGANISER_ID, { client }),
    );

    // 404 and not 403. A 403 would confirm the id exists, which turns this
    // into an enumeration oracle over a table whose row level security is
    // deny-all specifically so that the API can be the only gate.
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);

    // The read happened and the write did not. This is the assertion that
    // matters: a foreign row must not be written to and then rolled back in
    // the caller's imagination.
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].operation).toBe('select');
  });

  it('SCRUM11_AC1_answers_a_foreign_draft_exactly_as_it_answers_a_missing_one', async () => {
    const foreign = createEventRequestClient([ok(storedRow({ organiser_id: OTHER_ORGANISER_ID }))]);
    const missing = createEventRequestClient([ok(null)]);

    const foreignErr = await errorFrom(
      updateEventRequest(REQUEST_ID, { eventName: 'x' }, ORGANISER_ID, { client: foreign }),
    );
    const missingErr = await errorFrom(
      updateEventRequest(REQUEST_ID, { eventName: 'x' }, ORGANISER_ID, { client: missing }),
    );

    // Identical down to the message. A different wording for "exists but is
    // not yours" would be the same oracle the status code avoids.
    expect(foreignErr.message).toBe(missingErr.message);
    expect(foreignErr.status).toBe(missingErr.status);
  });

  it('SCRUM11_AC1_refuses_to_edit_a_request_that_is_no_longer_a_draft', async () => {
    const client = createEventRequestClient([ok(storedRow({ status: STATUS.UNDER_REVIEW }))]);

    const err = await errorFrom(
      updateEventRequest(REQUEST_ID, { eventName: 'Renamed' }, ORGANISER_ID, { client }),
    );

    // ConflictError, not ValidationError: the body was fine, the row's state
    // was not, and ownership is already proved so there is no id to protect.
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);

    // The message has to carry the way out, which no status code can: editing
    // is closed, but requesting a change is not.
    expect(err.message).toMatch(/request a change/i);

    // And it is a gate, not a filter that happens to match nothing.
    expect(client.calls).toHaveLength(1);
  });

  it('SCRUM11_AC1_does_not_ask_the_transition_table_whether_an_edit_is_legal', async () => {
    // The status check is written as `status !== 'draft'` and deliberately NOT
    // routed through canTransition. Editing is not a transition -- the row
    // does not move -- so ALLOWED_TRANSITIONS has nothing to say about it, and
    // asking anyway would be a category error dressed as reuse.
    //
    // This is what that costs if it were done: draft -> draft is not an
    // allowed transition, so a canTransition-based guard would refuse every
    // single edit to every single draft. The assertion below is the proof that
    // the rule was not reused, rather than a comment claiming it was not.
    expect(canTransition(STATUS.DRAFT, STATUS.DRAFT)).toBe(false);

    const client = createEventRequestClient([ok(storedRow()), ok(storedRow())]);

    await expect(
      updateEventRequest(REQUEST_ID, { eventName: 'Renamed' }, ORGANISER_ID, { client }),
    ).resolves.toMatchObject({ id: REQUEST_ID });
  });

  it('SCRUM11_AC1_turns_a_guard_that_matched_no_row_into_a_conflict', async () => {
    const client = createEventRequestClient([
      ok(storedRow()),
      dbError('PGRST116', 'JSON object requested, multiple (or no) rows returned'),
    ]);

    const err = await errorFrom(
      updateEventRequest(REQUEST_ID, { eventName: 'Renamed' }, ORGANISER_ID, { client }),
    );

    // The race, and the case that makes the status filter meaningful rather
    // than decorative. The row was read successfully a moment ago and its
    // ownership proved, so the only filter that can have stopped matching is
    // the status one -- a submit landed in the gap. 409, and the message tells
    // the Organiser to reload, because their copy of the request is now stale
    // in a way no retry of the same PATCH would fix.
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/no longer/i);
    expect(err.message).toMatch(/reload/i);

    // Handled at the call site and not in translateError, which cannot tell a
    // fired guard from an ordinary empty read -- its own comment says so. If
    // it were translated centrally this would arrive as a 404 telling the
    // Organiser their own request had vanished.
    expect(err).not.toBeInstanceOf(NotFoundError);
  });

  it('SCRUM11_AC1_refuses_to_query_at_all_without_an_organiser', async () => {
    const client = createEventRequestClient([ok(storedRow()), ok(storedRow())]);

    const err = await errorFrom(
      updateEventRequest(REQUEST_ID, { eventName: 'Renamed' }, undefined, { client }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err)).toEqual(['organiserId']);

    // The point of the assertion: a missing organiser must not reach the
    // database as an update whose only remaining filters are id and status.
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM11_AC1_refuses_to_query_at_all_for_an_empty_change_set', async () => {
    const client = createEventRequestClient([ok(storedRow()), ok(storedRow())]);

    const err = await errorFrom(
      updateEventRequest(REQUEST_ID, {}, ORGANISER_ID, { client }),
    );

    // toColumns({}) is {}, so without this the service would issue
    // .update({}), whose PostgREST behaviour is unspecified and untranslated
    // -- an ambiguous 500 where a precise 400 was available.
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM11_AC1_refuses_to_query_at_all_for_a_field_fault', async () => {
    const client = createEventRequestClient([ok(storedRow()), ok(storedRow())]);

    const err = await errorFrom(
      updateEventRequest(
        REQUEST_ID,
        { proposedStart: '2026-06-01T09:00' },
        ORGANISER_ID,
        { client },
      ),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err)).toContain('proposedStart');

    // Both validations run before the client is even resolved, so a bad body
    // costs no round trip and the Organiser gets a message about their form
    // rather than a driver message about a constraint.
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM11_AC1_translates_a_check_constraint_failure_into_a_validation_error', async () => {
    const client = createEventRequestClient([
      ok(storedRow()),
      dbError('23514', 'new row violates check constraint "event_requests_dates_ordered"'),
    ]);

    const err = await errorFrom(
      updateEventRequest(
        REQUEST_ID,
        { proposedEnd: '2026-06-02T17:00:00+08:00' },
        ORGANISER_ID,
        { client },
      ),
    );

    // The constraints in 001 and 005 stay the backstop for anything validation
    // deliberately does not check -- here, an end time compared against a
    // start the caller never sent. Untranslated it would reach the API as a
    // 500 carrying a driver message naming a constraint.
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
  });

  it('SCRUM11_AC1_leaves_an_unrecognised_database_failure_untyped', async () => {
    const client = createEventRequestClient([
      ok(storedRow()),
      dbError('42P01', 'relation "event_requests" does not exist'),
    ]);

    const err = await errorFrom(
      updateEventRequest(REQUEST_ID, { eventName: 'Renamed' }, ORGANISER_ID, { client }),
    );

    // An unrecognised code is not the caller's fault and there is nothing for
    // them to correct, so it must not reach the API dressed as a 400 telling
    // an Organiser to fix a form they filled in correctly.
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err).not.toBeInstanceOf(ConflictError);
    expect(err.status).toBeUndefined();
  });
});

describe('SCRUM-162: assigned Coordinator requests clarification', () => {
  it('moves an under-review request to pending clarification with a note and reply-by date', async () => {
    const note = 'Please clarify the accessibility arrangements.';
    const replyByDate = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const client = createEventRequestClient([
      ok(storedRow({ status: STATUS.UNDER_REVIEW, assigned_coordinator_id: COORDINATOR_ID })),
      ok(storedRow({
        status: STATUS.PENDING_CLARIFICATION,
        clarification_note: note,
        clarification_reply_by_date: replyByDate,
        assigned_coordinator_id: COORDINATOR_ID,
      })),
    ]);

    const result = await requestEventClarification(REQUEST_ID, note, COORDINATOR_ID, {
      replyByDate,
      requestedFields: ['purpose', 'proposedStart'],
      client,
    });

    expect(result.status).toBe(STATUS.PENDING_CLARIFICATION);
    expect(result.clarificationNote).toBe(note);
    expect(result.clarificationReplyByDate).toBe(replyByDate);
    expect(client.calls.map((call) => call.operation)).toEqual(['select', 'rpc']);
    expect(client.calls[1].fn).toBe('request_event_clarification_with_fields');
    expect(client.calls[1].args).toEqual({
      p_event_request_id: REQUEST_ID,
      p_changed_by: COORDINATOR_ID,
      p_expected_coordinator: COORDINATOR_ID,
      p_reason: note,
      p_reply_by_date: replyByDate,
      p_requested_fields: ['purpose', 'proposedStart'],
    });
  });

  it('does not send a clarification for a request that is not under review', async () => {
    const client = createEventRequestClient([
      ok(storedRow({ status: STATUS.SUBMITTED, assigned_coordinator_id: COORDINATOR_ID })),
    ]);

    const err = await errorFrom(
      requestEventClarification(REQUEST_ID, 'Please clarify.', COORDINATOR_ID, { client }),
    );

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toMatch(/submitted.*pending_clarification/i);
    expect(client.calls.map((call) => call.operation)).toEqual(['select']);
  });

  it('reports a change the status function refuses as a conflict, and asks for nothing more', async () => {
    // The read said under review; by the time of the write it was not. One
    // write attempted, refused, so one call and nothing after it.
    const client = createEventRequestClient([
      ok(storedRow({ status: STATUS.UNDER_REVIEW, assigned_coordinator_id: COORDINATOR_ID })),
      dbError('55000', `event request ${REQUEST_ID} has status approved, not under_review`),
    ]);

    const err = await errorFrom(
      requestEventClarification(REQUEST_ID, 'Please clarify.', COORDINATOR_ID, { client }),
    );

    expect(err).toBeInstanceOf(ConflictError);
    expect(client.calls.map((call) => call.operation)).toEqual(['select', 'rpc']);
  });

  it('rejects a blank clarification note before querying', async () => {
    const client = createEventRequestClient([]);
    const err = await errorFrom(
      requestEventClarification(REQUEST_ID, '  ', ORGANISER_ID, { client }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });

  it('rejects clarification amendment fields outside the editable field list', async () => {
    const client = createEventRequestClient([]);
    const err = await errorFrom(
      requestEventClarification(REQUEST_ID, 'Please clarify.', COORDINATOR_ID, {
        requestedFields: ['status'],
        client,
      }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(client.calls).toHaveLength(0);
  });

  it.each([
    ['malformed', 'not-a-date'],
    ['impossible', '2026-02-30'],
    ['today', sgDate(0)],
  ])('rejects a %s reply-by date before querying', async (_label, replyByDate) => {
    const client = createEventRequestClient([]);
    const err = await errorFrom(
      requestEventClarification(REQUEST_ID, 'Please clarify.', COORDINATOR_ID, {
        replyByDate,
        client,
      }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/replyByDate.*future/i);
    expect(client.calls).toHaveLength(0);
  });

  describe('the reply-by date is checked against the Singapore calendar', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    // 07:30 on 21 October in Singapore, still 20 October in UTC.
    const SINGAPORE_MORNING = new Date('2026-10-20T23:30:00Z');

    it('SCRUM162_AC1_refuses_the_singapore_today_while_utc_is_still_yesterday', async () => {
      vi.useFakeTimers({ now: SINGAPORE_MORNING, toFake: ['Date'] });
      const client = createEventRequestClient([]);

      const err = await errorFrom(
        requestEventClarification(REQUEST_ID, 'Please clarify.', COORDINATOR_ID, { replyByDate: '2026-10-21', client }),
      );

      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).toMatch(/replyByDate.*future/i);
      expect(client.calls).toHaveLength(0);
    });

    it('SCRUM162_AC1_accepts_the_next_singapore_day', async () => {
      vi.useFakeTimers({ now: SINGAPORE_MORNING, toFake: ['Date'] });
      const client = createEventRequestClient([
        ok(storedRow({ status: STATUS.UNDER_REVIEW, assigned_coordinator_id: COORDINATOR_ID })),
        ok(storedRow({ status: STATUS.PENDING_CLARIFICATION, assigned_coordinator_id: COORDINATOR_ID })),
      ]);

      await requestEventClarification(REQUEST_ID, 'Please clarify.', COORDINATOR_ID, { replyByDate: '2026-10-22', client });

      expect(client.calls[1].args.p_reply_by_date).toBe('2026-10-22');
    });
  });

  it('records an organiser reply and scoped amendments, returning the request to review', async () => {
    const client = createEventRequestClient([
      ok(storedRow({ status: STATUS.PENDING_CLARIFICATION, clarification_note: 'Clarify purpose.' })),
      ok(storedRow({
        status: STATUS.UNDER_REVIEW,
        clarification_note: null,
      })),
    ]);

    const result = await respondToEventClarification(
      REQUEST_ID,
      '  The event will be invitation-only.  ',
      ORGANISER_ID,
      { purpose: 'Celebration' },
      { client },
    );

    expect(result.status).toBe(STATUS.UNDER_REVIEW);
    expect(result.clarificationNote).toBeNull();
    expect(client.calls.map((call) => call.operation)).toEqual(['select', 'rpc']);
    expect(client.calls[1].fn).toBe('reply_to_event_clarification_with_amendments');
    expect(client.calls[1].args).toEqual({
      p_event_request_id: REQUEST_ID,
      p_organiser_id: ORGANISER_ID,
      p_reply: 'The event will be invitation-only.',
      p_updates: { purpose: 'Celebration' },
    });
  });

  it('rejects blank or non-text replies without database writes', async () => {
    for (const reply of ['', '  ', { description: 'Changed field' }]) {
      const client = createEventRequestClient([]);
      const err = await errorFrom(
        respondToEventClarification(REQUEST_ID, reply, ORGANISER_ID, {}, { client }),
      );
      expect(err).toBeInstanceOf(ValidationError);
      expect(client.calls).toHaveLength(0);
    }
  });

  it('closes only an open clarification with a required coordinator note', async () => {
    const client = createEventRequestClient([
      ok(assignedRow({ status: STATUS.PENDING_CLARIFICATION })),
      ok(assignedRow({ status: STATUS.UNDER_REVIEW, clarification_note: null })),
    ]);
    const result = await closeEventClarification(
      REQUEST_ID,
      'We resolved this by phone.',
      COORDINATOR_ID,
      { client },
    );

    expect(result.status).toBe(STATUS.UNDER_REVIEW);
    expect(client.calls.map((call) => call.operation)).toEqual(['select', 'rpc']);
    expect(client.calls[1].fn).toBe('close_event_clarification');
    expect(client.calls[1].args).toEqual({
      p_event_request_id: REQUEST_ID,
      p_coordinator_id: COORDINATOR_ID,
      p_expected_coordinator: COORDINATOR_ID,
      p_message: 'We resolved this by phone.',
    });
  });

  it('rejects blank closure notes before querying', async () => {
    const client = createEventRequestClient([]);
    const err = await errorFrom(
      closeEventClarification(REQUEST_ID, '  ', COORDINATOR_ID, { client }),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(client.calls).toHaveLength(0);
  });

  it('returns clarification entries oldest first with the author name for any Coordinator', async () => {
    const firstEntry = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      entry_type: 'question',
      message: CLARIFICATION_NOTE,
      created_by: COORDINATOR_ID,
      reply_by_date: '2026-10-10',
      created_at: '2026-10-01T00:00:00Z',
    };
    const secondEntry = {
      ...firstEntry,
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      entry_type: 'reply',
      message: 'Confirmed.',
      created_by: ORGANISER_ID,
      reply_by_date: null,
      created_at: '2026-10-02T00:00:00Z',
    };
    const client = createEventRequestClient([
      ok(assignedRow()),
      ok([firstEntry, secondEntry]),
      ok([
        { id: COORDINATOR_ID, full_name: 'Review Coordinator' },
        { id: ORGANISER_ID, full_name: 'Event Organiser' },
      ]),
    ]);

    const history = await getEventClarificationHistory(
      REQUEST_ID,
      NEW_COORDINATOR_ID,
      ROLE.EVENT_COORDINATOR,
      { client },
    );

    expect(history).toEqual([
      {
        id: firstEntry.id,
        type: 'question',
        message: CLARIFICATION_NOTE,
        authorName: 'Review Coordinator',
        createdAt: firstEntry.created_at,
        replyByDate: '2026-10-10',
        requestedFields: [],
      },
      {
        id: secondEntry.id,
        type: 'reply',
        message: 'Confirmed.',
        authorName: 'Event Organiser',
        createdAt: secondEntry.created_at,
        replyByDate: null,
        requestedFields: [],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The change request service's client seam
// ---------------------------------------------------------------------------
/**
 * A sibling to "AC3: the service is usable without credentials" above, and the
 * cheapest insurance in this suite.
 *
 * eventChangeRequestService.js used to import { supabase } statically, and
 * src/config/supabaseClient.js throws at import time without a .env. Because
 * src/routes/eventRequests.js now imports that service, a return to the static
 * import would take down every route test in this repository -- not by failing
 * an assertion, but by failing to collect the file at all, which is the
 * confusing kind of red.
 *
 * The static import at the top of this block IS the assertion. It runs when
 * this file is loaded, before any test body, so if the seam is ever undone
 * this suite stops collecting and says so in one line. The expectations below
 * are only there to give the failure somewhere to be reported from, and to
 * catch the narrower regression of an export being dropped or renamed.
 */
describe('SCRUM-11: the change request service is usable without credentials', () => {
  it('SCRUM11_AC1_loads_the_change_request_service_with_no_credentials_configured', () => {
    // All five, not just the two the routes call. One surviving `supabase`
    // reference anywhere in that module keeps the static import alive and the
    // seam buys nothing, so the guard has to name the whole surface.
    expect(typeof eventChangeRequestService.createChangeRequest).toBe('function');
    expect(typeof eventChangeRequestService.createChangeRequestFromClient).toBe('function');
    expect(typeof eventChangeRequestService.getChangeRequestsForEvent).toBe('function');
    expect(typeof eventChangeRequestService.getChangeRequestById).toBe('function');
    expect(typeof eventChangeRequestService.processChangeRequest).toBe('function');
  });

  it('SCRUM11_AC1_exports_nothing_from_the_change_request_service_but_functions', () => {
    // A module-level `const supabase = createClient(...)` re-exported by
    // accident would be an object, not a function, and would drag the same
    // import-time throw back in by a different route. Checking the whole
    // namespace rather than a list keeps this true for exports added later.
    const exported = Object.entries(eventChangeRequestService)
      .filter(([, value]) => typeof value !== 'function');

    expect(exported).toEqual([]);
  });

  it('SCRUM11_AC1_uses_a_supplied_client_rather_than_resolving_the_default_one', async () => {
    // The other half of the seam: resolveClient must return the caller's
    // client without reaching for supabaseClient.js at all. If it fell through
    // to the dynamic import this call would throw for a missing SUPABASE_URL
    // rather than recording a round trip against the fake.
    const client = createEventRequestClient([ok(null)]);

    const err = await errorFrom(
      eventChangeRequestService.getChangeRequestsForEvent(REQUEST_ID, ORGANISER_ID, { client }),
    );

    // A missing event, which is this fake's answer -- the point is that the
    // query reached the fake at all.
    expect(err).toBeInstanceOf(NotFoundError);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].table).toBe('event_requests');
  });
});


// ---------------------------------------------------------------------------
// SCRUM-45 -- the Event Coordinator's review queue
// ---------------------------------------------------------------------------
/**
 * A third fake, and a deliberate one.
 *
 * createEventRequestClient records .in() into `filters` with every eq(), so
 * it cannot show that no organiser_id filter was made.
 *
 * It records .in() into its own field rather than into `filters`, which is
 * what lets the first test below assert two things at once: that the status
 * IN list is present, and that `filters` -- the list every other read in this
 * module fills with an organiser_id -- is empty. The absence is the bug being
 * fixed, so it has to be observable, not merely unmentioned.
 *
 * .eq() is kept so that one fake can serve both listEventRequestsForReview and
 * listEventRequestsForOrganiser, which is how the column comparison below runs
 * them against the same builder instead of copying COLUMNS into a test.
 *
 * The imports are appended for the reason the SCRUM-11 block above gives for
 * its own: an ESM import is hoisted wherever it is written, and nothing above
 * this line may move.
 */
import { listEventRequestsForReview } from '../../src/services/eventRequestService.js';
import { COORDINATOR_QUEUE_STATUSES } from '../../src/domain/eventRequestStatus.js';


function createQueueFakeClient(results = []) {
  const queue = [...results];
  const calls = [];

  function settle(call) {
    if (queue.length === 0) {
      throw new Error(
        `fake client: no result queued for ${call.operation} on ${call.table}`,
      );
    }
    return Promise.resolve(queue.shift());
  }

  function builder(call) {
    const chain = {
      select(columns = '*') {
        call.select = columns;
        return chain;
      },
      eq(column, value) {
        call.filters.push([column, value]);
        return chain;
      },
      in(column, values) {
        // Recorded as its own list, not appended to filters: a test has to be
        // able to say "there is an IN on status AND there is no eq at all".
        call.inFilters.push([column, values]);
        return chain;
      },
      // SCRUM-486 (SCRUM-520): the review queue's "has a coordinator",
      // .not('assigned_coordinator_id', 'is', null). Its own list too, so
      // "no eq at all" above still means what it says.
      not(column, operator, value) {
        call.notFilters.push([column, operator, value]);
        return chain;
      },
      order(column, options) {
        call.order.push([column, options]);
        return chain;
      },
      single: () => settle(call),
      maybeSingle: () => settle(call),
      then: (resolve, reject) => settle(call).then(resolve, reject),
    };
    return chain;
  }

  return {
    calls,
    from(table) {
      const call = {
        table,
        operation: 'select',
        payload: null,
        select: null,
        filters: [],
        inFilters: [],
        notFilters: [],
        order: [],
      };
      calls.push(call);
      return builder(call);
    },
  };
}


/**
 * A row the review queue can return. SCRUM-486 (SCRUM-520): since 052 the
 * queue reads only requests someone holds, so every row it returns has a
 * coordinator. The SCRUM-45 fixtures below used storedRow, which has none:
 * right when written, because the coordinator was not part of what the queue
 * selected on, and wrong to keep, because a fixture the read can no longer
 * return would let these tests pass on data production cannot produce.
 */
const heldRow = (overrides = {}) => storedRow({ assigned_coordinator_id: COORDINATOR_ID, ...overrides });

describe('SCRUM-45 AC1: every request awaiting a decision, across all Organisers', () => {
  it('SCRUM45_AC1_filters_on_the_three_review_statuses_and_on_a_coordinator_holding_the_request', async () => {
    // Was SCRUM45_AC1_filters_on_the_three_review_statuses_and_nothing_else.
    // Right when written: from SCRUM-330 until SCRUM-486 every submitted
    // request was given a coordinator in the same transaction, so a status
    // filter alone already meant "held by someone". Migration 052 removed
    // that: a submitted request now waits with no coordinator until the Lead
    // assigns one, and it is the Lead's alone (AC2-06). So the read gained one
    // filter, and "nothing else" is no longer true. Renamed for that; the
    // two halves below are unchanged and still asserted in full.
    const client = createQueueFakeClient([ok([heldRow({ status: STATUS.SUBMITTED })])]);

    await listEventRequestsForReview({ client });

    const [call] = client.calls;
    expect(call.table).toBe('event_requests');
    expect(call.operation).toBe('select');

    // Half one: the status filter is present, and it is the domain's list
    // rather than three literals copied into the service.
    expect(call.inFilters).toEqual([['status', COORDINATOR_QUEUE_STATUSES]]);

    // SCRUM-486 AC2-06: and the request has a coordinator. Exactly this one
    // negative filter, so an unassigned request cannot reach the shared queue.
    expect(call.notFilters).toEqual([['assigned_coordinator_id', 'is', null]]);

    // Half two, and the more important half: there is no organiser filter at
    // all. Every other read in this module narrows to one organiser_id, and
    // that is precisely the reported bug -- a submitted request never reached
    // the Coordinator side because no read existed that was not owner-scoped.
    // An empty `filters` is what "this query crosses every Organiser" looks
    // like at the seam.
    expect(call.filters).toEqual([]);
  });

  it('SCRUM45_AC1_selects_the_same_columns_as_the_organisers_own_list', async () => {
    const client = createQueueFakeClient([
      ok([heldRow({ status: STATUS.SUBMITTED })]),
      ok([storedRow()]),
    ]);

    await listEventRequestsForReview({ client });
    await listEventRequestsForOrganiser(ORGANISER_ID, { client });

    const [queueCall, organiserCall] = client.calls;

    // Both run against one fake and their column lists are compared, rather
    // than COLUMNS being copied into this file where it could drift. A queue
    // row being byte-identical in shape to an organiser row is what lets the
    // Coordinator UI render a full detail panel from a row it already holds,
    // instead of paying for a second route -- so it is a decision worth
    // pinning, not an implementation detail.
    expect(queueCall.select).toBe(organiserCall.select);
    expect(queueCall.select).toMatch(/organiser_id/);
    expect(queueCall.select).not.toBe('*');
  });

  it('SCRUM45_AC1_returns_requests_belonging_to_more_than_one_organiser', async () => {
    const client = createQueueFakeClient([
      ok([
        heldRow({ id: 'a', organiser_id: ORGANISER_ID, status: STATUS.SUBMITTED }),
        heldRow({ id: 'b', organiser_id: OTHER_ORGANISER_ID, status: STATUS.UNDER_REVIEW }),
      ]),
    ]);

    const requests = await listEventRequestsForReview({ client });

    // The whole point of the queue, and the inverse of the assertion
    // SCRUM14_AC1_filters_the_query_on_the_organiser makes about the list
    // beside it. Nothing here drops a row for belonging to someone else.
    expect(requests.map((r) => r.organiserId))
      .toEqual([ORGANISER_ID, OTHER_ORGANISER_ID]);
  });

  it('SCRUM45_AC1_maps_every_row_into_camelCase', async () => {
    const client = createQueueFakeClient([
      ok([
        heldRow({ id: 'a', status: STATUS.SUBMITTED }),
        heldRow({ id: 'b', status: STATUS.PENDING_CLARIFICATION }),
      ]),
    ]);

    const requests = await listEventRequestsForReview({ client });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      id: 'a',
      organiserId: ORGANISER_ID,
      eventName: 'IS212 Industry Night',
      status: STATUS.SUBMITTED,
    });

    // On every element, not just the first: the Coordinator dashboard reads
    // these keys directly and a snake_case leak would render as blank fields.
    for (const request of requests) {
      expect(Object.keys(request).some((key) => key.includes('_'))).toBe(false);
    }
  });

  it('SCRUM45_AC1_orders_by_oldest_waiting_first_with_nulls_last', async () => {
    const client = createQueueFakeClient([ok([heldRow({ status: STATUS.SUBMITTED })])]);

    await listEventRequestsForReview({ client });

    // submitted_at ASC, not updated_at DESC. updated_at is maintained by the
    // event_requests_set_updated_at trigger, so on this screen it would be
    // actively wrong: a Coordinator merely touching a request would bounce it
    // to the top of their own queue and bury whatever has waited longest.
    //
    // nullsFirst: false is asserted as part of the options object rather than
    // left implicit. 005 constrains submitted_at on drafts only, so a
    // non-draft row may legitimately carry a null one, and Postgres sorts
    // nulls first on ASC -- which would put "no recorded submission time" at
    // the head of a queue ordered by how long people have waited.
    expect(client.calls[0].order).toEqual([
      ['submitted_at', { ascending: true, nullsFirst: false }],
      ['id', { ascending: true }],
    ]);
  });

  it('SCRUM45_AC1_answers_an_empty_queue_and_a_null_payload_with_an_empty_list', async () => {
    // Nothing waiting is the good state of this screen, not a missing
    // resource, so it is [] and never a NotFoundError. The null case is the
    // shape PostgREST can return for an empty result set.
    await expect(listEventRequestsForReview({ client: createQueueFakeClient([ok([])]) }))
      .resolves.toEqual([]);
    await expect(listEventRequestsForReview({ client: createQueueFakeClient([ok(null)]) }))
      .resolves.toEqual([]);
  });

  it('SCRUM45_AC1_takes_no_organiser_and_asserts_none', async () => {
    const client = createQueueFakeClient([ok([heldRow({ status: STATUS.SUBMITTED })])]);

    // Called with no organiser at all, and both the call and the signature
    // are checked. The missing parameter is not an oversight: the module
    // header's rule is that a function taking no organiser checks none, and
    // the caller proves the right to read. Here the proof is the role gate on
    // the route -- the only proof available, since a queue that crosses every
    // Organiser is exactly the read no ownership check could scope. If
    // assertOrganiser were ever added here the queue would throw a
    // ValidationError on every call and the Coordinator's screen would show
    // a 400 for a request that named nothing wrong.
    await expect(listEventRequestsForReview({ client })).resolves.toHaveLength(1);
    expect(client.calls).toHaveLength(1);

    // No required positional parameter: the single argument is a destructured
    // options object with a default, so .length is 0.
    expect(listEventRequestsForReview.length).toBe(0);
  });

  it('SCRUM45_AC1_leaves_an_unrecognised_database_failure_untyped', async () => {
    const client = createQueueFakeClient([dbError('42P01', 'relation does not exist')]);

    const err = await errorFrom(listEventRequestsForReview({ client }));

    // Untyped means the route's handleError falls through to a 500 with a
    // generic message. Anything typed here would reach a Coordinator dressed
    // as a 400 or a 404 and tell them to fix something that is not theirs to
    // fix -- and a 404 in particular would read as "the queue is empty".
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err).not.toBeInstanceOf(NotFoundError);
    expect(err).not.toBeInstanceOf(ConflictError);
    expect(err.status).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// SCRUM-332 -- only the assigned coordinator changes an event, and every
// coordinator can read one
// ---------------------------------------------------------------------------
/**
 * SCRUM-327 AC7: after a handover, the new coordinator can carry out every
 * coordinator action on the event, and the previous one can view it but no
 * longer change it.
 *
 * An audit of every coordinator write found three that change an event.
 * Reassignment already checks the caller, inside 018. Clarification checks
 * nothing: it takes a coordinatorId, makes sure it is not blank, and throws it
 * away. Deciding a change request is now checked by 019, but the change
 * request service does not translate 019's refusal, so it reaches the caller
 * as a 500. On the read side, no coordinator can read one event once it leaves
 * the queue, which is exactly when AC6 still lets them hand it over.
 *
 * The import is appended for the reason the SCRUM-11 block gives for its own.
 */
import { getEventRequestForCoordinator } from '../../src/services/eventRequestService.js';

const CHANGE_REQUEST_ID = '77777777-7777-4777-8777-777777777777';

const CLARIFICATION_NOTE = 'Please confirm whether the event is open to the public.';

/** An event past draft, held by COORDINATOR_ID unless told otherwise. */
function assignedRow(overrides = {}) {
  return storedRow({
    status: STATUS.SUBMITTED,
    submitted_at: NOW.toISOString(),
    assigned_coordinator_id: COORDINATOR_ID,
    ...overrides,
  });
}

const askForClarification = (client, coordinatorId = COORDINATOR_ID) =>
  requestEventClarification(REQUEST_ID, CLARIFICATION_NOTE, coordinatorId, { client });


/**
 * Why a coordinator who does not hold the event gets a 403, and a guard that
 * matches no row gets a 409.
 *
 * requestEventClarification already reads the row before it writes, to check
 * the status. That read also says who holds the event. So the service can
 * answer the common case, a coordinator acting on someone else's event, from
 * the read: 403, with nothing written. The caller can see the event (every
 * coordinator can, see below), so a 403 reveals nothing and tells them the
 * true reason. errors.js gives the full argument for ForbiddenError.
 *
 * The status function then refuses unless the event is still assigned to the
 * caller (p_expected_coordinator) and still in the status just read. That
 * does the job organiser_id does in updateEventRequest: the write cannot
 * change an event the caller does not hold, rather than being safe only
 * because of a read made in an earlier request.
 *
 * If it refuses, the read a moment ago showed the caller held the event in a
 * status that allowed this, so something changed in between: a handover, or a
 * status change. That is a race, and a race is a 409, as it is in
 * updateEventRequest and SCRUM-11's tests. A 403 would be wrong for the
 * status case, where the caller still holds the event and is not forbidden
 * anything. The 409 tells them to refresh, and the refreshed event shows them
 * which it was.
 *
 * Treating a no-match as a 403 would make sense only without the read, when a
 * coordinator who does not hold the event would be the likely cause. With the
 * read, that case never reaches the update.
 */
describe('SCRUM-327 AC7: only the assigned coordinator can request clarification', () => {
  it('SCRUM332_AC7_only_the_assigned_coordinator_can_request_clarification', async () => {
    const client = createEventRequestClient([
      ok(assignedRow({ status: STATUS.UNDER_REVIEW })),
      ok(assignedRow({ status: STATUS.PENDING_CLARIFICATION, clarification_note: CLARIFICATION_NOTE })),
    ]);

    await askForClarification(client);

    expect(client.calls.map((call) => call.operation)).toEqual(['select', 'rpc']);
    const [call] = rpcCallsOf(client);
    expect(call.fn).toBe('request_event_clarification_with_fields');
    expect(call.args).toMatchObject({
      p_changed_by: COORDINATOR_ID,
      p_expected_coordinator: COORDINATOR_ID,
      p_reason: CLARIFICATION_NOTE,
    });
  });

  it('SCRUM332_AC7_the_previous_coordinator_can_no_longer_request_clarification', async () => {
    // The event was handed to NEW_COORDINATOR_ID. COORDINATOR_ID held it and
    // no longer does. Refused from the read, with nothing written: the fake
    // has only the read queued, so an attempted update would fail with "no
    // result queued" rather than pass by accident.
    const client = createEventRequestClient([ok(assignedRow({ assigned_coordinator_id: NEW_COORDINATOR_ID }))]);

    const err = await errorFrom(askForClarification(client, COORDINATOR_ID));

    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/assigned/i);
    expect(client.calls.map((call) => call.operation)).toEqual(['select']);
  });

  it('SCRUM332_AC7_the_new_coordinator_can_request_clarification', async () => {
    // The other half of AC7: the person the event was handed to can act on it.
    const client = createEventRequestClient([
      ok(assignedRow({ status: STATUS.UNDER_REVIEW, assigned_coordinator_id: NEW_COORDINATOR_ID })),
      ok(assignedRow({
        status: STATUS.PENDING_CLARIFICATION,
        clarification_note: CLARIFICATION_NOTE,
        assigned_coordinator_id: NEW_COORDINATOR_ID,
      })),
    ]);

    const result = await askForClarification(client, NEW_COORDINATOR_ID);

    expect(result.status).toBe(STATUS.PENDING_CLARIFICATION);
    expect(rpcCallsOf(client)).toHaveLength(1);
    for (const call of rpcCallsOf(client)) {
      expect(call.args.p_expected_coordinator).toBe(NEW_COORDINATOR_ID);
      expect(call.args.p_changed_by).toBe(NEW_COORDINATOR_ID);
    }
  });

  it('SCRUM332_AC7_checks_the_caller_before_the_status', async () => {
    // An approved event cannot go to clarification, and this caller does not
    // hold it either. They are told it is not theirs, not that the status is
    // wrong: whether it could be sent for clarification is a question only
    // its coordinator has any reason to ask. 018 orders its checks the same
    // way, caller before status.
    const client = createEventRequestClient([
      ok(assignedRow({ status: STATUS.APPROVED, assigned_coordinator_id: NEW_COORDINATOR_ID })),
    ]);

    const err = await errorFrom(askForClarification(client, COORDINATOR_ID));

    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err).not.toBeInstanceOf(ConflictError);
  });

  it('SCRUM332_AC7_reports_a_handover_after_the_read_as_a_conflict', async () => {
    // The read said the caller held the event and it was under review. The
    // function then refused with 40001: it was handed on, or changed status,
    // in between. A race, so a 409 telling them to refresh -- see the block
    // comment above for why not a 403.
    //
    // Under review, where dev had submitted: a submitted read is now refused
    // by the service's own status check before the function is called, so on
    // a submitted row this test would pass without reaching the 40001 at all.
    const client = createEventRequestClient([
      ok(assignedRow({ status: STATUS.UNDER_REVIEW })),
      dbError('40001', `event request ${REQUEST_ID} is no longer assigned to this coordinator`),
    ]);

    const err = await errorFrom(askForClarification(client));

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(err).not.toBeInstanceOf(ForbiddenError);
  });

  it('SCRUM332_AC7_a_draft_is_not_found_rather_than_forbidden', async () => {
    // A draft has no coordinator, so the caller check alone would answer 403,
    // and a 403 confirms the id exists. Coordinators are not supposed to know
    // a draft exists at all: COORDINATOR_QUEUE_STATUSES leaves drafts out of
    // the queue for exactly that reason. errors.js says to use ForbiddenError
    // only where the caller can already see the record, and nobody but the
    // Organiser can see a draft. So it is answered exactly as a missing event
    // is, down to the message.
    const draft = createEventRequestClient([ok(storedRow({ status: STATUS.DRAFT }))]);
    const missing = createEventRequestClient([ok(null)]);

    const draftErr = await errorFrom(askForClarification(draft));
    const missingErr = await errorFrom(askForClarification(missing));

    expect(draftErr).toBeInstanceOf(NotFoundError);
    expect(draftErr.status).toBe(404);
    expect(draftErr.message).toBe(missingErr.message);
    expect(draft.calls).toHaveLength(1);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('SCRUM332_AC7_refuses_a_coordinator_id_that_is_%s_before_any_query', async (_label, value) => {
    // Still refused before the client is touched, as it was before SCRUM-332.
    // It matters more now: the id is compared and filtered on, and a blank
    // one reaching the update would be a filter that matches nobody, which
    // would look like a race and answer 409.
    const client = createEventRequestClient([]);

    // Called directly rather than through askForClarification, whose default
    // would turn the undefined case into COORDINATOR_ID.
    const err = await errorFrom(
      requestEventClarification(REQUEST_ID, CLARIFICATION_NOTE, value, { client }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });
});


/**
 * The coordinator's single read.
 *
 * getEventRequestForOrganiser answers 404 unless the caller is the Organiser,
 * and the queue covers only submitted, under_review and pending_clarification.
 * So once an event is approved or confirmed, no coordinator can read it, while
 * AC6 still lets its coordinator hand it over and AC7 says the previous one
 * can still view it. SCRUM-332's Done criteria say reading stays open to every
 * coordinator.
 *
 * It takes no coordinator id and no organiser id, and compares neither. That
 * follows listEventRequestsForReview: a function that takes no owner checks
 * none, and the caller proves the right to read. Here the proof is the role
 * gate on the route. Which coordinator holds the event decides who can change
 * it, never who can read it.
 *
 * The one thing it refuses is a draft. A draft is the Organiser's private
 * working copy, and COORDINATOR_QUEUE_STATUSES leaves it out of the queue so
 * that no coordinator learns it exists. A single read that returned drafts
 * would undo that for anyone who guessed an id.
 */
describe('SCRUM-327 AC7: every coordinator can read an event', () => {
  it('SCRUM332_AC7_any_coordinator_can_read_an_event', async () => {
    // Held by a different coordinator and owned by a different Organiser, and
    // still returned. One read, on id only: no organiser filter, no
    // coordinator filter.
    const client = createEventRequestClient([
      ok(assignedRow({
        organiser_id: OTHER_ORGANISER_ID,
        assigned_coordinator_id: NEW_COORDINATOR_ID,
      })),
    ]);

    const request = await getEventRequestForCoordinator(REQUEST_ID, { client });

    expect(request).toMatchObject({
      id: REQUEST_ID,
      organiserId: OTHER_ORGANISER_ID,
      assignedCoordinatorId: NEW_COORDINATOR_ID,
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].filters).toEqual([['id', REQUEST_ID]]);
  });

  it.each([STATUS.APPROVED, STATUS.CONFIRMED])(
    'SCRUM332_AC7_reads_an_event_in_%s_which_the_queue_does_not_cover',
    async (status) => {
      // The gap this function exists to close, checked against the domain's
      // own list rather than assumed, so the test says why it matters.
      expect(COORDINATOR_QUEUE_STATUSES).not.toContain(status);

      const client = createEventRequestClient([ok(assignedRow({ status }))]);

      const request = await getEventRequestForCoordinator(REQUEST_ID, { client });

      expect(request.status).toBe(status);
    },
  );

  it('SCRUM332_AC7_reports_a_missing_event_as_not_found', async () => {
    const client = createEventRequestClient([ok(null)]);

    const err = await errorFrom(getEventRequestForCoordinator(REQUEST_ID, { client }));

    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
  });

  it('SCRUM332_AC7_hides_a_draft_exactly_as_it_hides_a_missing_event', async () => {
    // Same status and same message as a missing event. A different message
    // for "exists but is a draft" would be the enumeration oracle the 404 is
    // there to avoid, the same rule SCRUM14_AC1_answers_a_foreign_request_
    // exactly_as_it_answers_a_missing_one pins for the Organiser's read.
    const draft = createEventRequestClient([ok(storedRow({ status: STATUS.DRAFT }))]);
    const missing = createEventRequestClient([ok(null)]);

    const draftErr = await errorFrom(getEventRequestForCoordinator(REQUEST_ID, { client: draft }));
    const missingErr = await errorFrom(getEventRequestForCoordinator(REQUEST_ID, { client: missing }));

    expect(draftErr).toBeInstanceOf(NotFoundError);
    expect(draftErr.message).toBe(missingErr.message);
  });

  it('SCRUM332_AC7_takes_no_organiser_and_asserts_none', async () => {
    // Mirrors SCRUM45_AC1_takes_no_organiser_and_asserts_none. Called with
    // nothing but the id, and both the call and the signature are checked.
    // If an organiser check were added here, every coordinator would get a
    // 404 for every event they did not organise, which is the bug this
    // function fixes. If a coordinator check were added, the previous
    // coordinator could no longer view the event, which AC7 says they can.
    const client = createEventRequestClient([ok(assignedRow({ organiser_id: OTHER_ORGANISER_ID }))]);

    await expect(getEventRequestForCoordinator(REQUEST_ID, { client })).resolves.toMatchObject({ id: REQUEST_ID });
    expect(client.calls).toHaveLength(1);

    // One required parameter, the id. The options object has a default, so it
    // does not count towards .length.
    expect(getEventRequestForCoordinator.length).toBe(1);
  });
});


/**
 * Deciding a change request, in eventChangeRequestService.js.
 *
 * There is no tests/services/eventChangeRequestService.test.js. That service is
 * covered here, through the namespace import the SCRUM-11 seam guard already
 * makes, and through the route tests. So its SCRUM-332 tests go here too,
 * rather than in a new file nobody asked for.
 *
 * 019 does the check: process_change_request now refuses anyone but the
 * event's assigned coordinator, under a lock on the event, with 42501. What is
 * left for the service is to say so properly. Its translateError is separate
 * from this module's and has no case for 42501, so today the refusal arrives
 * as an untyped Error, which the route answers with a 500.
 */
describe("SCRUM-327 AC7: deciding a change request is refused to anyone but the event's coordinator", () => {
  const decide = (client, input = { decision: 'approved' }) =>
    eventChangeRequestService.processChangeRequest(CHANGE_REQUEST_ID, input, COORDINATOR_ID, { client });

  /** The row process_change_request returns after an approval. */
  const decidedChangeRequestRow = () => ({
    id: CHANGE_REQUEST_ID,
    event_request_id: REQUEST_ID,
    requested_by: ORGANISER_ID,
    change_field: 'expected_attendance',
    requested_change: '250',
    status: 'processed',
    decision: 'approved',
    decision_notes: null,
    processed_by: COORDINATOR_ID,
    processed_at: NOW.toISOString(),
    created_at: '2026-01-12T03:00:00+00:00',
    updated_at: NOW.toISOString(),
  });

  it('SCRUM332_AC7_only_the_assigned_coordinator_can_decide_a_change_request', async () => {
    // 403, not 404: the caller is a coordinator, who can already read the
    // event and its change requests, so the refusal tells them only the true
    // reason. The message is 019's own, written for the person who asked, and
    // passed through unchanged, as eventRequestService does for 018's 42501.
    const message = `only the coordinator assigned to event request ${REQUEST_ID} can decide its change requests`;
    const client = createEventRequestClient([dbError('42501', message)]);

    const err = await errorFrom(decide(client));

    expect(rpcCallsOf(client)).toHaveLength(1);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.status).toBe(403);
    expect(err.message).toBe(message);
  });

  it('SCRUM332_AC7_the_deciding_coordinator_is_the_one_checked', async () => {
    // 019 added no parameter. It checks p_processed_by, the person the
    // decision is recorded against, so the person recorded as deciding is by
    // construction the person who was allowed to. toEqual, so an extra
    // argument such as p_assigned_coordinator_id fails here as surely as a
    // missing one: 019 has no such parameter, and PostgREST would answer that
    // call with "function not found".
    const client = createEventRequestClient([ok(decidedChangeRequestRow())]);

    await decide(client);

    const [rpc] = rpcCallsOf(client);
    expect(rpc.fn).toBe('process_change_request');
    expect(rpc.args).toEqual({
      p_change_request_id: CHANGE_REQUEST_ID,
      p_decision: 'approved',
      p_decision_notes: null,
      p_processed_by: COORDINATOR_ID,
    });
  });

  it.each([
    {
      // 019 raises this from its new read, with the same text and code 006
      // used, and the check script asserts the 404.
      name: 'SCRUM332_AC7_still_reports_a_missing_change_request_as_not_found',
      code: 'P0002',
      message: `change request ${CHANGE_REQUEST_ID} not found`,
      Err: NotFoundError,
      status: 404,
    },
    {
      // 006 raised this with no SQLSTATE, so it is P0001, and 019 left it that
      // way. This service matches it by its text, not its code. The row pins
      // that mapping 42501 has not disturbed it, and that P0001 here did not
      // become eventRequestService's 503.
      name: 'SCRUM332_AC7_still_reports_an_already_processed_request_as_a_validation_error',
      code: 'P0001',
      message: `change request ${CHANGE_REQUEST_ID} has already been processed`,
      Err: ValidationError,
      status: 400,
    },
    {
      name: 'SCRUM22_AC8_change_request_check_constraints_remain_validation_errors',
      code: '23514',
      message: 'new row violates check constraint "event_requests_dates_ordered"',
      Err: ValidationError,
      status: 400,
    },
    {
      name: 'SCRUM363_AC8_confirmed_field_lock_refusals_remain_conflicts',
      code: '55000',
      message: 'Confirmed event details are locked. Apply a significant change and complete safety review before confirming again.',
      Err: ConflictError,
      status: 409,
    },
  ])('$name', async ({ code, message, Err, status }) => {
    const client = createEventRequestClient([dbError(code, message)]);

    const err = await errorFrom(decide(client));

    expect(err).toBeInstanceOf(Err);
    expect(err.status).toBe(status);
    expect(err).not.toBeInstanceOf(ForbiddenError);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-333 -- "My events": the events assigned to one coordinator
// ---------------------------------------------------------------------------
/**
 * SCRUM-327 AC11: each coordinator has a "My events" list showing the events
 * assigned to them, grouped by status, earliest event first.
 *
 * listEventRequestsForCoordinator(coordinatorId, { client }). It sits beside
 * the shared queue, which stays exactly as it is: the queue is the view of
 * work nobody holds yet, and this is the view of work one person does hold.
 *
 * Decisions these tests pin, each argued where it is tested:
 *
 *  - Every status, not just live ones. See
 *    SCRUM333_AC11_covers_every_status_including_decided_ones.
 *  - Ordered by proposed_start, soonest first, nulls last, then id. The queue
 *    orders by submitted_at because it asks who has waited longest. This
 *    list asks what is coming up soonest, which is what "earliest event
 *    first" means.
 *  - A flat array, like every list in this API. Grouping by status is
 *    presentation, and the frontend already maps over bare arrays.
 *  - Each row carries the organiser's name, as organiserName.
 *
 * Why the name is here, when the queue deliberately leaves it out.
 * listEventRequestsForReview's docstring calls the absence of a name "the
 * privacy floor of the shared queue": a coordinator learns what was asked
 * for, not who to contact about it. That is right for a queue of events
 * nobody has taken on, which every coordinator sees. It is wrong for events
 * you are responsible for, where contacting the organiser is the job, and AC7
 * makes you the one person who can act on them. So the two lists answer the
 * same question differently on purpose, and the reason is whose work it is.
 *
 * Why the name comes from a second read, not a join in the select. PostgREST
 * embeds one table in another only along a foreign key between them.
 * event_requests.organiser_id references auth.users (001), and so does
 * profiles.id (007); nothing links event_requests to profiles directly, so
 * select('..., profiles(full_name)') would fail with "could not find a
 * relationship". Adding that foreign key would need a migration, and would
 * refuse every organiser without a profiles row. So the service reads the
 * events, then reads full_name from profiles for exactly the organisers in
 * that list, with one .in(), and merges. Two round trips, both reads, so there
 * is nothing to keep atomic: a name changed between the two is simply read a
 * moment later.
 *
 * The second read is narrowed to the organisers of the caller's own events,
 * so it cannot be used to read anyone else's name. profiles has full_name but
 * no email, so a name is all there is to show, and full_name is nullable.
 *
 * Uses createQueueFakeClient from the SCRUM-45 block, because the second read
 * needs .in(), which createFakeClient does not have.
 */
import { listEventRequestsForCoordinator } from '../../src/services/eventRequestService.js';

/** An event assigned to COORDINATOR_ID unless told otherwise. */
function myEventRow(overrides = {}) {
  return storedRow({
    status: STATUS.SUBMITTED,
    submitted_at: NOW.toISOString(),
    assigned_coordinator_id: COORDINATOR_ID,
    ...overrides,
  });
}

/** A profiles row, as the second read returns it. */
const profileRow = (id, fullName) => ({ id, full_name: fullName });

/** The ids an .in() asked for, sorted, so a test compares sets. */
const idsAskedFor = (call) => [...call.inFilters[0][1]].sort();

describe('SCRUM-327 AC11: a coordinator lists the events assigned to them', () => {
  it('SCRUM333_AC11_lists_only_the_coordinators_own_events', async () => {
    const client = createQueueFakeClient([
      ok([myEventRow()]),
      ok([profileRow(ORGANISER_ID, 'Aisha Rahman')]),
    ]);

    await listEventRequestsForCoordinator(COORDINATOR_ID, { client });

    const [events] = client.calls;
    expect(events.table).toBe('event_requests');

    // Exactly one filter: the caller as the assigned coordinator. Not an
    // organiser, which would turn this into one Organiser's list, and no
    // status IN list (see the next test).
    //
    // No draft filter is needed either. A draft never has an assigned
    // coordinator: assignment happens at submission (016), and nothing writes
    // the column on a draft. So filtering on the caller already leaves every
    // draft out, the same privacy boundary the queue keeps.
    expect(events.filters).toEqual([['assigned_coordinator_id', COORDINATOR_ID]]);
    expect(events.inFilters).toEqual([]);
  });

  it('SCRUM333_AC11_covers_every_status_including_decided_ones', async () => {
    // Every status the event can be in once assigned, decided and terminal
    // ones included. The queue leaves decided statuses out because it is a
    // worklist, and a worklist that kept them would never empty. This list is
    // something else: the events this coordinator is responsible for. AC11
    // groups them by status, which assumes more than the live ones, and a
    // coordinator still needs the event they rejected when its Organiser asks
    // why, or the completed one when a report is due. Leaving terminal
    // statuses out here would leave no way to find them at all, since the
    // coordinator read needs an id. The frontend can collapse the groups that
    // are done.
    const statuses = [
      STATUS.SUBMITTED,
      STATUS.UNDER_REVIEW,
      STATUS.APPROVED,
      STATUS.CONFIRMED,
      STATUS.COMPLETED,
      STATUS.REJECTED,
      STATUS.CANCELLED,
    ];
    const client = createQueueFakeClient([
      ok(statuses.map((status, i) => myEventRow({ id: `event-${i}`, status }))),
      ok([profileRow(ORGANISER_ID, 'Aisha Rahman')]),
    ]);

    const events = await listEventRequestsForCoordinator(COORDINATOR_ID, { client });

    expect(events.map((event) => event.status)).toEqual(statuses);
    expect(client.calls[0].inFilters).toEqual([]);
  });

  it('SCRUM333_AC11_orders_by_the_event_date', async () => {
    const client = createQueueFakeClient([
      ok([myEventRow()]),
      ok([profileRow(ORGANISER_ID, 'Aisha Rahman')]),
    ]);

    await listEventRequestsForCoordinator(COORDINATOR_ID, { client });

    // proposed_start ascending: the event happening soonest comes first.
    // nullsFirst: false is stated, not assumed. proposed_start is nullable
    // (001), and Postgres sorts nulls first on ASC, which would put an event
    // with no date at the head of a list ordered by date. id breaks ties, as
    // it does in the queue, so two refetches of identical data cannot come
    // back in different orders.
    expect(client.calls[0].order).toEqual([
      ['proposed_start', { ascending: true, nullsFirst: false }],
      ['id', { ascending: true }],
    ]);
  });

  it('SCRUM333_AC11_selects_the_same_columns_as_every_other_read', async () => {
    const client = createQueueFakeClient([
      ok([myEventRow()]),
      ok([profileRow(ORGANISER_ID, 'Aisha Rahman')]),
      ok([storedRow()]),
    ]);

    await listEventRequestsForCoordinator(COORDINATOR_ID, { client });
    await listEventRequestsForOrganiser(ORGANISER_ID, { client });

    // The same COLUMNS, compared rather than copied, as the queue's own test
    // does. A row here is the same shape GET /:id/review returns, so the
    // frontend can open a detail panel from a row it already holds. SCRUM-384:
    // plus the closing notes, which only the coordinator's reads select.
    const [mine, , organisers] = client.calls;
    expect(mine.select).toBe(`${organisers.select}, closing_notes`);
  });

  it('SCRUM333_AC11_returns_events_from_more_than_one_organiser', async () => {
    // These are one coordinator's events, not one Organiser's, so they
    // naturally belong to several Organisers. Nothing drops a row for that.
    const client = createQueueFakeClient([
      ok([
        myEventRow({ id: 'a', organiser_id: ORGANISER_ID }),
        myEventRow({ id: 'b', organiser_id: OTHER_ORGANISER_ID }),
      ]),
      ok([
        profileRow(ORGANISER_ID, 'Aisha Rahman'),
        profileRow(OTHER_ORGANISER_ID, 'Daniel Lim'),
      ]),
    ]);

    const events = await listEventRequestsForCoordinator(COORDINATOR_ID, { client });

    expect(events.map((event) => event.organiserId)).toEqual([ORGANISER_ID, OTHER_ORGANISER_ID]);
  });

  it('SCRUM333_AC11_carries_the_organisers_name', async () => {
    // Three events, two Organisers. One read of profiles, for exactly those
    // two ids, each asked for once, and each event gets its Organiser's name.
    // organiserName sits flat beside organiserId rather than in a nested
    // { id, fullName } object: every other field on a request is flat, and
    // organiserId is already where the frontend reads it, so a nested object
    // would carry the id twice.
    const client = createQueueFakeClient([
      ok([
        myEventRow({ id: 'a', organiser_id: ORGANISER_ID }),
        myEventRow({ id: 'b', organiser_id: OTHER_ORGANISER_ID }),
        myEventRow({ id: 'c', organiser_id: ORGANISER_ID }),
      ]),
      ok([
        profileRow(ORGANISER_ID, 'Aisha Rahman'),
        profileRow(OTHER_ORGANISER_ID, 'Daniel Lim'),
      ]),
    ]);

    const events = await listEventRequestsForCoordinator(COORDINATOR_ID, { client });

    expect(client.calls).toHaveLength(2);
    const names = client.calls[1];
    expect(names.table).toBe('profiles');
    expect(names.select).toMatch(/\bid\b/);
    expect(names.select).toMatch(/full_name/);
    expect(names.inFilters).toHaveLength(1);
    expect(names.inFilters[0][0]).toBe('id');
    expect(idsAskedFor(names)).toEqual([ORGANISER_ID, OTHER_ORGANISER_ID].sort());

    expect(events.map((event) => event.organiserName))
      .toEqual(['Aisha Rahman', 'Daniel Lim', 'Aisha Rahman']);
  });

  it('SCRUM333_AC11_a_missing_or_null_name_is_null', async () => {
    // Two ways to have no name. full_name is nullable (007), and an organiser
    // can have no profiles row at all: the hand-run check scripts create such
    // users. Both are null, not undefined, so the key is always present and
    // the frontend can test for it in one way.
    const client = createQueueFakeClient([
      ok([
        myEventRow({ id: 'a', organiser_id: ORGANISER_ID }),
        myEventRow({ id: 'b', organiser_id: OTHER_ORGANISER_ID }),
      ]),
      ok([profileRow(ORGANISER_ID, null)]),
    ]);

    const events = await listEventRequestsForCoordinator(COORDINATOR_ID, { client });

    expect(events[0].organiserName).toBeNull();
    expect(events[1].organiserName).toBeNull();
  });

  it('SCRUM333_AC11_answers_an_empty_list_with_an_empty_array', async () => {
    // A coordinator with nothing assigned is the good state, not a missing
    // resource, so it is [] and never a NotFoundError. With no events there
    // are no organisers to name, so there is no second read: the fake queues
    // one answer and would throw on a second call.
    await expect(listEventRequestsForCoordinator(COORDINATOR_ID, {
      client: createQueueFakeClient([ok([])]),
    })).resolves.toEqual([]);

    // null is the shape PostgREST can return for an empty result set.
    await expect(listEventRequestsForCoordinator(COORDINATOR_ID, {
      client: createQueueFakeClient([ok(null)]),
    })).resolves.toEqual([]);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('SCRUM333_AC11_refuses_to_query_at_all_without_a_coordinator_%s', async (_label, value) => {
    // Mirrors SCRUM14_AC1_refuses_to_query_at_all_without_an_organiser. A
    // missing coordinator must not reach the database as a query whose only
    // filter is gone, which would be every assigned event in the system. It
    // comes from the token, so a missing one is a caller bug, refused before
    // the client is touched.
    const client = createQueueFakeClient([ok([myEventRow()]), ok([])]);

    const err = await errorFrom(listEventRequestsForCoordinator(value, { client }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM333_AC11_leaves_an_unrecognised_database_failure_untyped', async () => {
    // Through translateError, so an unrecognised code stays an untyped Error
    // and the route answers 500 with a generic message, logging the driver's
    // text rather than returning it. Typed, it would reach the coordinator as
    // a 400 or 404 telling them to fix something that is not theirs, and a
    // 404 would read as "nothing assigned".
    const client = createQueueFakeClient([dbError('42P01', 'relation does not exist')]);

    const err = await errorFrom(listEventRequestsForCoordinator(COORDINATOR_ID, { client }));

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err).not.toBeInstanceOf(NotFoundError);
    expect(err.status).toBeUndefined();
  });

  it('SCRUM333_AC11_fails_rather_than_dropping_names_when_the_name_read_fails', async () => {
    // If the second read fails, the call fails. Returning the events with
    // every name null would look like a list of organisers with no names,
    // and nobody would know a read had failed. An honest error the screen can
    // retry is better than a quietly wrong list.
    const client = createQueueFakeClient([
      ok([myEventRow()]),
      dbError('42P01', 'relation "profiles" does not exist'),
    ]);

    const err = await errorFrom(listEventRequestsForCoordinator(COORDINATOR_ID, { client }));

    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBeUndefined();
  });

  it('SCRUM333_AC11_maps_every_row_into_camelCase', async () => {
    const client = createQueueFakeClient([
      ok([
        myEventRow({ id: 'a', status: STATUS.APPROVED }),
        myEventRow({ id: 'b', status: STATUS.CONFIRMED }),
      ]),
      ok([profileRow(ORGANISER_ID, 'Aisha Rahman')]),
    ]);

    const events = await listEventRequestsForCoordinator(COORDINATOR_ID, { client });

    expect(events[0]).toMatchObject({
      id: 'a',
      organiserId: ORGANISER_ID,
      organiserName: 'Aisha Rahman',
      assignedCoordinatorId: COORDINATOR_ID,
      status: STATUS.APPROVED,
    });

    // On every row, and including the new key: a snake_case leak would
    // render as a blank field on the coordinator's screen.
    for (const event of events) {
      expect(Object.keys(event).some((key) => key.includes('_'))).toBe(false);
    }
  });

  it('SCRUM333_AC11_takes_the_coordinator_as_its_only_required_parameter', () => {
    // The coordinator, then the usual options object, whose default keeps it
    // out of .length. The queue takes no owner at all; this one takes exactly
    // one, because it is one person's list.
    expect(listEventRequestsForCoordinator.length).toBe(1);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-334 -- the coordinator list, and an event's assignment history
// ---------------------------------------------------------------------------
/**
 * Two reads, for the reassign screen and the history view.
 *
 *   listCoordinators({ client })
 *     every Event Coordinator's id and name, for the reassign picker.
 *   listAssignmentHistory(id, { includeNotes }, { client })
 *     one event's assignment history, oldest first.
 *
 * Named after SCRUM-327's criteria:
 *   AC9  -- every handover records who made it, and the note
 *   AC10 -- the Organiser's screen shows the event's assignment history
 *
 * The history is its own read and its own endpoint, not folded into the event
 * reads. Folded in, it would put a growing array inside every event read,
 * including /mine and /queue, where nothing displays it. Change requests are
 * already a separate endpoint (GET /:id/change-requests) for the same reason.
 *
 * Neither function checks who is asking, which is this module's rule: a
 * function that takes no owner checks none, and the route proves the right to
 * read. For the coordinator list that proof is the role gate. For the history
 * it is the same proof the event itself needs: ownership for an Organiser,
 * the role for a coordinator.
 *
 * Names come from profiles in a second read, as listEventRequestsForCoordinator
 * reads them and for the same reason: nothing has a foreign key to profiles,
 * so PostgREST cannot embed it.
 *
 * Imports appended, for the reason the SCRUM-11 block gives.
 */
import { listCoordinators, listAssignmentHistory } from '../../src/services/eventRequestService.js';

/** The column names a select string asks for, sorted, so a test compares sets. */
const columnsOf = (call) => call.select.split(',').map((column) => column.trim()).sort();

describe('SCRUM-327 AC9: every coordinator, for the reassign picker', () => {
  /**
   * Why the shape is { id, fullName }: the object is the person, so its keys
   * are that person's columns in camelCase, by the same rule toEventRequest
   * follows. organiserName on "My events" is prefixed because it names
   * someone else on an event's row; here nothing needs prefixing.
   *
   * Why ordered by name, nulls last, then id: a picker is read by a person
   * looking for a colleague, so alphabetical is what they scan. full_name is
   * nullable, so nameless coordinators go to the end rather than the top, and
   * id orders those, and any two people with the same name, the same way every
   * time. Ordering by id alone would be stable but would look random to the
   * person using it.
   */
  it('SCRUM334_AC9_lists_every_event_coordinator', async () => {
    const client = createQueueFakeClient([ok([profileRow(COORDINATOR_ID, 'Priya Nair')])]);

    await listCoordinators({ client });

    const [call] = client.calls;
    expect(call.table).toBe('profiles');

    // One filter, the role, and nothing narrowing it further.
    expect(call.filters).toEqual([['role', 'event_coordinator']]);
    expect(call.inFilters).toEqual([]);

    // The id and the name, never the whole row. This is the first read in the
    // API that lists users, so it reads only what the picker shows.
    expect(columnsOf(call)).toEqual(['full_name', 'id']);
  });

  it('SCRUM334_AC9_returns_each_coordinator_as_an_id_and_a_name', async () => {
    const client = createQueueFakeClient([
      ok([profileRow(COORDINATOR_ID, 'Priya Nair'), profileRow(NEW_COORDINATOR_ID, 'Marcus Tan')]),
    ]);

    const coordinators = await listCoordinators({ client });

    // toEqual, so an extra key fails: no role, no created_at.
    expect(coordinators).toEqual([
      { id: COORDINATOR_ID, fullName: 'Priya Nair' },
      { id: NEW_COORDINATOR_ID, fullName: 'Marcus Tan' },
    ]);
  });

  it('SCRUM334_AC9_keeps_a_coordinator_with_no_name', async () => {
    // full_name is nullable (007). A coordinator with no name is still a
    // coordinator who can take an event, so they are listed, with null, and
    // the picker shows them some other way.
    const client = createQueueFakeClient([ok([profileRow(NEW_COORDINATOR_ID, null)])]);

    const coordinators = await listCoordinators({ client });

    expect(coordinators).toEqual([{ id: NEW_COORDINATOR_ID, fullName: null }]);
  });

  it('SCRUM334_AC9_orders_coordinators_by_name_then_id', async () => {
    const client = createQueueFakeClient([ok([])]);

    await listCoordinators({ client });

    expect(client.calls[0].order).toEqual([
      ['full_name', { ascending: true, nullsFirst: false }],
      ['id', { ascending: true }],
    ]);
  });

  it('SCRUM334_AC9_answers_no_coordinators_with_an_empty_array', async () => {
    // Not an error. With no coordinators nobody can be handed an event, and
    // the picker should say so; that is the picker's message to show, not a
    // failure of this read. null is how PostgREST can send an empty result.
    await expect(listCoordinators({ client: createQueueFakeClient([ok([])]) })).resolves.toEqual([]);
    await expect(listCoordinators({ client: createQueueFakeClient([ok(null)]) })).resolves.toEqual([]);
  });

  it('SCRUM334_AC9_leaves_an_unrecognised_database_failure_untyped', async () => {
    const client = createQueueFakeClient([dbError('42P01', 'relation "profiles" does not exist')]);

    const err = await errorFrom(listCoordinators({ client }));

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err).not.toBeInstanceOf(NotFoundError);
    expect(err.status).toBeUndefined();
  });

  it('SCRUM334_AC9_takes_no_required_parameter', () => {
    // Nothing to scope it to: every coordinator, for any coordinator.
    expect(listCoordinators.length).toBe(0);
  });
});


/**
 * An event's assignment history.
 *
 * Shape of one entry:
 *
 *   { id,
 *     previousCoordinatorId, previousCoordinatorName,
 *     newCoordinatorId,      newCoordinatorName,
 *     assignedById,          assignedByName,
 *     automatic,
 *     createdAt,
 *     handoverNote }         <- only when includeNotes is true
 *
 * Flat, ids beside names, as organiserId sits beside organiserName on "My
 * events". createdAt keeps the column's name, as every other mapping here
 * does; 014 records that it is the moment the assignment took effect.
 *
 * Why `automatic` exists, when 014 already says a null assigned_by means the
 * system assigned the event. That convention is the database's vocabulary,
 * and every client would otherwise have to know it. It is also ambiguous once
 * names are added: assignedByName is null both for the system and for a
 * person with no full_name. So the API states the one fact the screen needs,
 * "assigned automatically" or "handed over by", as a boolean derived from
 * assigned_by alone, and assignedById stays as the source it came from.
 *
 * Why the handover note is withheld from the Organiser. AC10 says the
 * Organiser's screen shows the history, and the customer confirmed they see
 * the coordinator's name, so who and when are theirs. The note is not. It is
 * written by one coordinator for another, "I'm on leave, the shortlist is in
 * my notes", and if the Organiser could read it, coordinators would write
 * differently or stop writing it, and the handover it exists for would get
 * worse. So the coordinator's view carries it and the Organiser's does not.
 *
 * The key is absent, not null. null already means "no note was written",
 * which is true of every automatic assignment. An absent key means "not sent
 * to you". If both were null, the Organiser's screen could not tell a
 * withheld note from a missing one, and nor could a test. Without
 * includeNotes the note is not even selected, so it cannot reach a response
 * through a later mapping mistake.
 *
 * includeNotes defaults to false. A caller that forgets to say gets the
 * Organiser's view, never the other way round.
 */
describe('SCRUM-327 AC9, AC10: an event\'s assignment history', () => {
  /** The first row for an event: submitted, assigned by the system. */
  const firstAssignment = () => ({
    id: 'history-1',
    event_request_id: REQUEST_ID,
    previous_coordinator_id: null,
    new_coordinator_id: COORDINATOR_ID,
    assigned_by: null,
    handover_note: null,
    created_at: '2026-01-15T09:00:00+00:00',
  });

  /** A handover from COORDINATOR_ID to NEW_COORDINATOR_ID, made by COORDINATOR_ID. */
  const handover = () => ({
    id: 'history-2',
    event_request_id: REQUEST_ID,
    previous_coordinator_id: COORDINATOR_ID,
    new_coordinator_id: NEW_COORDINATOR_ID,
    assigned_by: COORDINATOR_ID,
    handover_note: HANDOVER_NOTE,
    created_at: '2026-01-20T09:00:00+00:00',
  });

  const coordinatorNames = () => [
    profileRow(COORDINATOR_ID, 'Priya Nair'),
    profileRow(NEW_COORDINATOR_ID, 'Marcus Tan'),
  ];

  const historyWith = (rows = [firstAssignment(), handover()], names = coordinatorNames()) =>
    createQueueFakeClient([ok(rows), ok(names)]);

  it('SCRUM334_AC10_reads_one_events_history_oldest_first', async () => {
    const client = historyWith();

    await listAssignmentHistory(REQUEST_ID, { includeNotes: true }, { client });

    const [history] = client.calls;
    expect(history.table).toBe('event_request_assignment_history');
    expect(history.filters).toEqual([['event_request_id', REQUEST_ID]]);
    expect(history.select).not.toBe('*');

    // Oldest first, because a history reads as a chain, null -> A, A -> B,
    // and a chain is read from its start. That is the opposite of 014's
    // index, (event_request_id, created_at desc), and the index still serves
    // it: Postgres walks a btree index backwards as easily as forwards, so
    // one event's rows are still found and returned in order without a sort.
    // id breaks ties the same way every time.
    expect(history.order).toEqual([
      ['created_at', { ascending: true }],
      ['id', { ascending: true }],
    ]);
  });

  it('SCRUM334_AC9_shows_who_handed_the_event_over', async () => {
    const client = historyWith();

    const [, entry] = await listAssignmentHistory(REQUEST_ID, { includeNotes: true }, { client });

    expect(entry).toMatchObject({
      id: 'history-2',
      previousCoordinatorId: COORDINATOR_ID,
      previousCoordinatorName: 'Priya Nair',
      newCoordinatorId: NEW_COORDINATOR_ID,
      newCoordinatorName: 'Marcus Tan',
      assignedById: COORDINATOR_ID,
      assignedByName: 'Priya Nair',
      automatic: false,
      createdAt: '2026-01-20T09:00:00+00:00',
    });
  });

  it('SCRUM334_AC9_marks_a_system_assignment_as_automatic', async () => {
    // The first assignment: nobody held the event before, and nobody handed
    // it over, so the previous coordinator and the person are all null, and
    // automatic says why.
    const client = historyWith();

    const [entry] = await listAssignmentHistory(REQUEST_ID, { includeNotes: true }, { client });

    expect(entry).toMatchObject({
      previousCoordinatorId: null,
      previousCoordinatorName: null,
      newCoordinatorId: COORDINATOR_ID,
      newCoordinatorName: 'Priya Nair',
      assignedById: null,
      assignedByName: null,
      automatic: true,
    });
  });

  it('SCRUM334_AC9_reads_every_name_in_one_read', async () => {
    // One read of profiles for everyone the history names, previous, new and
    // assigned_by alike, each asked for once, and never a null.
    const client = historyWith();

    await listAssignmentHistory(REQUEST_ID, { includeNotes: true }, { client });

    expect(client.calls).toHaveLength(2);
    const names = client.calls[1];
    expect(names.table).toBe('profiles');
    expect(columnsOf(names)).toEqual(['full_name', 'id']);
    expect(names.inFilters).toHaveLength(1);
    expect(names.inFilters[0][0]).toBe('id');
    expect(idsAskedFor(names)).toEqual([COORDINATOR_ID, NEW_COORDINATOR_ID].sort());
  });

  it('SCRUM334_AC9_a_person_with_no_name_is_still_a_person', async () => {
    // NEW_COORDINATOR_ID has no profiles row, and COORDINATOR_ID, who made
    // the handover, has a null full_name. Both names are null, and the
    // handover is still not automatic, because a person made it. This is the
    // case `automatic` exists for: assignedByName alone cannot tell a
    // nameless person from the system.
    const client = historyWith(
      [handover()],
      [profileRow(COORDINATOR_ID, null)],
    );

    const [entry] = await listAssignmentHistory(REQUEST_ID, { includeNotes: true }, { client });

    expect(entry.newCoordinatorName).toBeNull();
    expect(entry.assignedByName).toBeNull();
    expect(entry.assignedById).toBe(COORDINATOR_ID);
    expect(entry.automatic).toBe(false);
  });

  it('SCRUM334_AC9_carries_the_handover_note_for_a_coordinator', async () => {
    const client = historyWith();

    const [first, second] = await listAssignmentHistory(REQUEST_ID, { includeNotes: true }, { client });

    // The note on the handover, and null on the automatic assignment, which
    // has nobody handing over and so never has one. Present on both.
    expect(second.handoverNote).toBe(HANDOVER_NOTE);
    expect('handoverNote' in first).toBe(true);
    expect(first.handoverNote).toBeNull();
    expect(columnsOf(client.calls[0])).toContain('handover_note');
  });

  it('SCRUM334_AC10_withholds_the_handover_note_from_the_organiser', async () => {
    const client = historyWith();

    const entries = await listAssignmentHistory(REQUEST_ID, { includeNotes: false }, { client });

    // Absent, not null: see the block comment above. And not selected at
    // all, so a later change to the mapping cannot leak it.
    for (const entry of entries) {
      expect('handoverNote' in entry).toBe(false);
    }
    expect(columnsOf(client.calls[0])).not.toContain('handover_note');

    // Who and when are still there. They are the Organiser's to see.
    expect(entries[1]).toMatchObject({
      previousCoordinatorName: 'Priya Nair',
      newCoordinatorName: 'Marcus Tan',
      assignedByName: 'Priya Nair',
      createdAt: '2026-01-20T09:00:00+00:00',
    });
  });

  it('SCRUM334_AC10_withholds_the_handover_note_unless_asked_for', async () => {
    // includeNotes left out entirely. The safe answer is the Organiser's
    // view, so a caller that forgets to choose leaks nothing.
    const client = historyWith();

    const entries = await listAssignmentHistory(REQUEST_ID, undefined, { client });

    for (const entry of entries) {
      expect('handoverNote' in entry).toBe(false);
    }
  });

  it('SCRUM334_AC10_answers_an_event_with_no_history_with_an_empty_array', async () => {
    // A draft has none, and that is an ordinary state, not a missing
    // resource. With no rows there is nobody to name, so there is no second
    // read: one answer queued, and a second call would throw.
    await expect(listAssignmentHistory(REQUEST_ID, { includeNotes: true }, {
      client: createQueueFakeClient([ok([])]),
    })).resolves.toEqual([]);

    await expect(listAssignmentHistory(REQUEST_ID, { includeNotes: true }, {
      client: createQueueFakeClient([ok(null)]),
    })).resolves.toEqual([]);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('SCRUM334_AC10_refuses_an_event_id_that_is_%s_before_any_query', async (_label, value) => {
    // Without an event id the history read would have no filter, and return
    // every assignment ever made.
    const client = historyWith();

    const err = await errorFrom(listAssignmentHistory(value, { includeNotes: true }, { client }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM334_AC10_leaves_an_unrecognised_database_failure_untyped', async () => {
    const client = createQueueFakeClient([dbError('42P01', 'relation does not exist')]);

    const err = await errorFrom(listAssignmentHistory(REQUEST_ID, { includeNotes: true }, { client }));

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err).not.toBeInstanceOf(NotFoundError);
    expect(err.status).toBeUndefined();
  });

  it('SCRUM334_AC9_fails_rather_than_dropping_names_when_the_name_read_fails', async () => {
    // As in listEventRequestsForCoordinator: a history with every name null
    // would look like a history of nameless people, and nobody would know a
    // read had failed.
    const client = createQueueFakeClient([
      ok([firstAssignment(), handover()]),
      dbError('42P01', 'relation "profiles" does not exist'),
    ]);

    const err = await errorFrom(listAssignmentHistory(REQUEST_ID, { includeNotes: true }, { client }));

    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBeUndefined();
  });

  it('SCRUM334_AC10_maps_every_entry_into_camelCase', async () => {
    const client = historyWith();

    const entries = await listAssignmentHistory(REQUEST_ID, { includeNotes: true }, { client });

    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(Object.keys(entry).some((key) => key.includes('_'))).toBe(false);
    }
  });
});


// ---------------------------------------------------------------------------
// SCRUM-321 -- every status change goes through one function, which records it
// ---------------------------------------------------------------------------
/**
 * changeEventRequestStatus asks canTransition, then calls
 * change_event_request_status (migration 021) through rpc. The function writes
 * the new status and the history row in one transaction, and a fake cannot
 * observe a transaction, so what these tests pin is what the service sends and
 * what it refuses to send: nothing reaches the database for a move that is not
 * allowed, a failed call is reported and followed by no write of the service's
 * own, and the service never writes the status column or the history table
 * itself. That a refused or failed change leaves no history row, and that the
 * two writes land together, is proved against Postgres: see 021's test run and
 * `npm run request:check`.
 *
 * The import is appended for the reason the SCRUM-11 block gives for its own.
 */
import { changeEventRequestStatus } from '../../src/services/eventRequestService.js';

const approvedRow = (overrides = {}) =>
  storedRow({
    status: STATUS.APPROVED,
    submitted_at: NOW.toISOString(),
    assigned_coordinator_id: COORDINATOR_ID,
    ...overrides,
  });

const change = (client, overrides = {}) =>
  changeEventRequestStatus(
    REQUEST_ID,
    {
      expectedStatus: STATUS.UNDER_REVIEW,
      newStatus: STATUS.APPROVED,
      changedBy: COORDINATOR_ID,
      ...overrides,
    },
    { client },
  );

describe('SCRUM-321 AC5: a status change is one call that records who, what and why', () => {
  it('SCRUM321_AC5_makes_one_call_carrying_the_previous_and_new_status_and_the_actor', async () => {
    const client = createEventRequestClient([ok(approvedRow())]);

    const result = await change(client, { reason: 'Meets every requirement.' });

    expect(client.calls.map((call) => call.operation)).toEqual(['rpc']);
    expect(rpcCallsOf(client)[0]).toMatchObject({
      fn: 'change_event_request_status',
      args: {
        p_event_request_id: REQUEST_ID,
        p_expected_status: STATUS.UNDER_REVIEW,
        p_new_status: STATUS.APPROVED,
        p_changed_by: COORDINATOR_ID,
        p_reason: 'Meets every requirement.',
        p_expected_coordinator: null,
      },
    });
    expect(result.status).toBe(STATUS.APPROVED);
    expect(Object.keys(result).some((key) => key.includes('_'))).toBe(false);
  });

  it.each([
    ['is absent', undefined],
    ['is null', null],
    ['is blank', '   '],
  ])('SCRUM321_AC5_sends_no_reason_when_it_%s', async (_label, reason) => {
    const client = createEventRequestClient([ok(approvedRow())]);

    await change(client, { reason });

    expect(rpcCallsOf(client)[0].args.p_reason).toBeNull();
  });

  it('SCRUM321_AC5_trims_the_reason', async () => {
    const client = createEventRequestClient([ok(approvedRow())]);

    await change(client, { reason: '  Meets every requirement.  ' });

    expect(rpcCallsOf(client)[0].args.p_reason).toBe('Meets every requirement.');
  });

  it('SCRUM321_AC5_refuses_an_overlong_reason_before_any_call', async () => {
    const client = createEventRequestClient([]);

    const err = await errorFrom(change(client, { reason: 'x'.repeat(2001) }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(client.calls).toHaveLength(0);
  });

  it.each([undefined, null, '', '   ', 42])(
    'SCRUM321_AC5_refuses_%j_as_the_user_before_any_call',
    async (changedBy) => {
      const client = createEventRequestClient([]);

      const err = await errorFrom(change(client, { changedBy }));

      expect(err).toBeInstanceOf(ValidationError);
      expect(client.calls).toHaveLength(0);
    },
  );

  it('SCRUM321_AC5_never_writes_the_status_or_the_history_itself', async () => {
    // The two writes happen inside the function, in one transaction. A
    // .from().update() or .insert() beside the rpc would be a write outside it.
    const client = createEventRequestClient([ok(approvedRow())]);

    await change(client);

    expect(client.calls.some((call) => call.operation === 'update')).toBe(false);
    expect(client.calls.some((call) => call.operation === 'insert')).toBe(false);
    expect(client.calls.some((call) => call.table === 'event_request_status_history')).toBe(false);
  });
});


describe('SCRUM-321 AC3: a refused or failed change writes nothing', () => {
  it.each([
    [STATUS.DRAFT, STATUS.APPROVED],
    [STATUS.SUBMITTED, STATUS.CONFIRMED],
    [STATUS.COMPLETED, STATUS.CANCELLED],
    [STATUS.CANCELLED, STATUS.DRAFT],
    [STATUS.PENDING_CLARIFICATION, STATUS.APPROVED],
  ])('SCRUM321_AC3_refuses_%s_to_%s_without_calling_the_database', async (from, to) => {
    const client = createEventRequestClient([]);

    const err = await errorFrom(change(client, { expectedStatus: from, newStatus: to }));

    // The message states the status the request is in, as SCRUM-318's AC3
    // asks, and nothing was sent: no status change, so no history.
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(err.message).toContain(`'${from}'`);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM321_AC3_refuses_an_unknown_status_without_calling_the_database', async () => {
    const client = createEventRequestClient([]);

    const err = await errorFrom(change(client, { newStatus: 'planning' }));

    expect(err).toBeInstanceOf(ConflictError);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM321_AC3_leaves_submitting_to_submitEventRequest', async () => {
    // Draft -> submitted also assigns a coordinator, and has its own path.
    const client = createEventRequestClient([]);

    const err = await errorFrom(
      change(client, { expectedStatus: STATUS.DRAFT, newStatus: STATUS.SUBMITTED }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(client.calls).toHaveLength(0);
  });

  it.each([
    ['a request that is no longer in the expected status', '55000', ConflictError, 409],
    ['an event handed to another coordinator', '40001', ConflictError, 409],
    ['a request that does not exist', 'P0002', NotFoundError, 404],
  ])('SCRUM321_AC3_reports_%s', async (_label, code, Err, status) => {
    const client = createEventRequestClient([dbError(code, 'refused by the function')]);

    const err = await errorFrom(change(client));

    expect(err).toBeInstanceOf(Err);
    expect(err.status).toBe(status);
  });

  it('SCRUM321_AC3_makes_no_write_of_its_own_after_the_function_fails', async () => {
    // A failure inside the function rolls back the status and the history row
    // together. All the service can add is nothing: one call, an error out.
    const client = createEventRequestClient([dbError('23503', 'violates foreign key constraint')]);

    const err = await errorFrom(change(client));

    expect(err).toBeInstanceOf(ValidationError);
    expect(client.calls.map((call) => call.operation)).toEqual(['rpc']);
  });

  it('SCRUM321_AC3_does_not_retry_after_a_conflict', async () => {
    const client = createEventRequestClient([dbError('55000', 'event request has status approved, not under_review')]);

    await errorFrom(change(client));

    expect(rpcCallsOf(client)).toHaveLength(1);
  });
});


describe('SCRUM-488 AC2 to AC4: the safety transitions go through the same function', () => {
  const SAFETY_MOVES = [
    [STATUS.APPROVED, STATUS.SAFETY_REVIEW],
    [STATUS.SAFETY_REVIEW, STATUS.SAFETY_APPROVED],
    [STATUS.SAFETY_REVIEW, STATUS.APPROVED],
    [STATUS.SAFETY_APPROVED, STATUS.APPROVED],
    [STATUS.SAFETY_APPROVED, STATUS.CONFIRMED],
    [STATUS.SAFETY_REVIEW, STATUS.CANCELLED],
    [STATUS.SAFETY_APPROVED, STATUS.CANCELLED],
  ];

  it.each(SAFETY_MOVES)(
    'SCRUM488_AC4_%s_to_%s_is_one_call_carrying_the_statuses_the_actor_and_the_reason',
    async (from, to) => {
      const client = createEventRequestClient([ok(approvedRow({ status: to }))]);

      const result = await change(client, {
        expectedStatus: from, newStatus: to, reason: '  Sent back with reasons.  ',
      });

      expect(client.calls.map((call) => call.operation)).toEqual(['rpc']);
      expect(rpcCallsOf(client)[0]).toMatchObject({
        fn: 'change_event_request_status',
        args: {
          p_event_request_id: REQUEST_ID,
          p_expected_status: from,
          p_new_status: to,
          p_changed_by: COORDINATOR_ID,
          p_reason: 'Sent back with reasons.',
        },
      });
      expect(result.status).toBe(to);
    },
  );

  it.each([
    [STATUS.APPROVED, STATUS.CONFIRMED],
    [STATUS.APPROVED, STATUS.SAFETY_APPROVED],
    [STATUS.SAFETY_REVIEW, STATUS.CONFIRMED],
    // SCRUM-347 has not decided whether a safety status may be rejected.
    [STATUS.SAFETY_REVIEW, STATUS.REJECTED],
    [STATUS.SAFETY_APPROVED, STATUS.REJECTED],
    [STATUS.CONFIRMED, STATUS.SAFETY_REVIEW],
    [STATUS.COMPLETED, STATUS.SAFETY_REVIEW],
    [STATUS.CANCELLED, STATUS.SAFETY_APPROVED],
  ])('SCRUM488_AC3_refuses_%s_to_%s_naming_the_status_and_calling_nothing', async (from, to) => {
    const client = createEventRequestClient([]);

    const err = await errorFrom(change(client, { expectedStatus: from, newStatus: to }));

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(err.message).toContain(`'${from}'`);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM488_AC3_a_conflict_from_the_function_on_a_safety_move_is_a_409_with_no_retry', async () => {
    // The stale-status refusal and the table's own refusal both raise 55000.
    const client = createEventRequestClient([dbError('55000', 'event request has status safety_review, not approved')]);

    const err = await errorFrom(change(client, {
      expectedStatus: STATUS.APPROVED, newStatus: STATUS.SAFETY_REVIEW,
    }));

    expect(err).toBeInstanceOf(ConflictError);
    expect(rpcCallsOf(client)).toHaveLength(1);
  });
});


describe('SCRUM-321: the other status changes go through the same function', () => {
  it('SCRUM321_a_clarification_request_that_is_not_allowed_calls_nothing_after_the_read', async () => {
    // Approved cannot go back to clarification. The refusal names the status
    // and nothing is written, so no history row either.
    const client = createEventRequestClient([ok(approvedRow())]);

    const err = await errorFrom(askForClarification(client));

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toContain("'approved'");
    expect(client.calls.map((call) => call.operation)).toEqual(['select']);
  });

  it('SCRUM321_an_organiser_reply_that_is_no_longer_open_changes_no_status', async () => {
    const client = createEventRequestClient([
      ok(storedRow({ status: STATUS.UNDER_REVIEW })),
    ]);

    const err = await errorFrom(
      respondToEventClarification(REQUEST_ID, 'Answered.', ORGANISER_ID, {}, { client }),
    );

    expect(err).toBeInstanceOf(ConflictError);
    expect(rpcCallsOf(client)).toHaveLength(0);
  });

  it('SCRUM321_an_organiser_reply_race_reports_the_status_conflict', async () => {
    const client = createEventRequestClient([
      ok(storedRow({ status: STATUS.PENDING_CLARIFICATION })),
      dbError('55000', `event request ${REQUEST_ID} has status approved, not pending_clarification`),
    ]);

    const err = await errorFrom(
      respondToEventClarification(REQUEST_ID, 'Answered.', ORGANISER_ID, {}, { client }),
    );

    expect(err).toBeInstanceOf(ConflictError);
    expect(rpcCallsOf(client)).toHaveLength(1);
  });
});


describe('SCRUM-321 with SCRUM-327: Draft -> Submitted keeps its own path and gains the history row', () => {
  it('SCRUM321_submits_through_submit_event_request_only', async () => {
    // One function call writes the status, the coordinator, the assignment
    // history and the status history. Calling the status function as well
    // would record the change twice.
    const client = createEventRequestClient([ok(storedRow()), ok(submittedRow())]);

    await submitEventRequest(REQUEST_ID, { client, now: NOW });

    expect(rpcCallsOf(client).map((call) => call.fn)).toEqual(['submit_event_request']);
  });

  it('SCRUM321_records_the_organiser_as_the_submitter_by_default', async () => {
    const client = createEventRequestClient([ok(storedRow()), ok(submittedRow())]);

    await submitEventRequest(REQUEST_ID, { client, now: NOW });

    expect(rpcCallsOf(client)[0].args.p_changed_by).toBe(ORGANISER_ID);
  });

  it('SCRUM321_records_the_user_the_caller_names_as_the_submitter', async () => {
    const client = createEventRequestClient([ok(storedRow()), ok(submittedRow())]);

    await submitEventRequest(REQUEST_ID, { client, now: NOW, changedBy: COORDINATOR_ID });

    expect(rpcCallsOf(client)[0].args.p_changed_by).toBe(COORDINATOR_ID);
  });

  it('SCRUM321_a_refused_submission_still_calls_the_function_once_and_writes_nothing_else', async () => {
    // The refusal used to be P0001, "No coordinator is available", which
    // submission raised until SCRUM-486. It can no longer, so the refusal here
    // is one it still can: the request is no longer a draft (55000). What the
    // test proves is unchanged: one call, and no write after a refusal.
    const client = createEventRequestClient([
      ok(storedRow()),
      dbError('55000', `event request ${REQUEST_ID} has status submitted, and only a draft can be submitted`),
    ]);

    const err = await errorFrom(submitEventRequest(REQUEST_ID, { client, now: NOW }));

    expect(err).toBeInstanceOf(ConflictError);
    expect(client.calls.map((call) => call.operation)).toEqual(['select', 'rpc']);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-322 -- an event's status history, for its Organiser and its coordinator
// ---------------------------------------------------------------------------
/**
 * SCRUM-318 AC6: the Event Organiser and the assigned coordinator can view the
 * event's full status history, oldest first.
 *
 * Reads through createQueueFakeClient above, the one fake here with .in(),
 * because the names come from a second read of profiles filtered by id. The
 * history rows are what 021's functions wrote; these tests queue them as
 * PostgREST would return them, so what is under test is who may read them, the
 * order asked for, and the shape handed back.
 *
 * The import is appended for the reason the SCRUM-11 block gives for its own.
 */
import { getEventRequestStatusHistory } from '../../src/services/eventRequestService.js';

const STRANGER_ID = '99999999-9999-4999-8999-999999999999';

/** An event past draft, held by COORDINATOR_ID, as getEventRequestById reads it. */
const heldEvent = (overrides = {}) =>
  storedRow({
    status: STATUS.APPROVED,
    submitted_at: NOW.toISOString(),
    assigned_coordinator_id: COORDINATOR_ID,
    ...overrides,
  });

/** History rows as the table returns them. */
const historyRows = () => [
  {
    previous_status: STATUS.DRAFT,
    new_status: STATUS.SUBMITTED,
    changed_by: ORGANISER_ID,
    reason: null,
    created_at: '2026-01-15T09:00:00+00:00',
  },
  {
    previous_status: STATUS.SUBMITTED,
    new_status: STATUS.UNDER_REVIEW,
    changed_by: COORDINATOR_ID,
    reason: 'Picked up for review.',
    created_at: '2026-01-16T09:00:00+00:00',
  },
  {
    previous_status: STATUS.UNDER_REVIEW,
    new_status: STATUS.PENDING_CLARIFICATION,
    changed_by: COORDINATOR_ID,
    reason: 'Is it open to the public?',
    created_at: '2026-01-17T09:00:00+00:00',
  },
];

const profiles = () => [
  { id: ORGANISER_ID, full_name: 'Olivia Organiser' },
  { id: COORDINATOR_ID, full_name: 'Carlos Coordinator' },
];

/** The event, then its history, then the names. */
const readingHistory = (event = heldEvent(), rows = historyRows(), people = profiles()) =>
  createQueueFakeClient([ok(event), ok(rows), ok(people)]);

describe('SCRUM-322 AC6: the Organiser and the assigned coordinator see the full history', () => {
  it('SCRUM322_AC6_shows_the_organiser_every_change', async () => {
    const client = readingHistory();

    const history = await getEventRequestStatusHistory(REQUEST_ID, ORGANISER_ID, { client });

    expect(history).toHaveLength(3);
  });

  it('SCRUM322_AC6_shows_the_assigned_coordinator_every_change', async () => {
    const client = readingHistory();

    const history = await getEventRequestStatusHistory(REQUEST_ID, COORDINATOR_ID, { client });

    expect(history).toHaveLength(3);
  });

  it('SCRUM322_AC6_returns_previous_status_new_status_name_time_and_reason', async () => {
    const client = readingHistory();

    const history = await getEventRequestStatusHistory(REQUEST_ID, ORGANISER_ID, { client });

    expect(history[1]).toEqual({
      previousStatus: STATUS.SUBMITTED,
      previousStatusLabel: 'Requested',
      newStatus: STATUS.UNDER_REVIEW,
      newStatusLabel: 'Under review',
      changedByName: 'Carlos Coordinator',
      changedAt: '2026-01-16T09:00:00+00:00',
      reason: 'Picked up for review.',
    });
    expect(history[0].changedByName).toBe('Olivia Organiser');
    expect(history[0].reason).toBeNull();
  });

  it('SCRUM323_AC7_shows_the_organiser_label_for_every_status_in_the_history', async () => {
    // The raw statuses are kept for code that branches on them. What an
    // Organiser reads is the label, never the internal name.
    const client = readingHistory();

    const history = await getEventRequestStatusHistory(REQUEST_ID, ORGANISER_ID, { client });

    expect(history.map((entry) => [entry.previousStatusLabel, entry.newStatusLabel])).toEqual([
      ['Draft', 'Requested'],
      ['Requested', 'Under review'],
      ['Under review', 'Awaiting your response'],
    ]);
  });

  it('SCRUM488_AC6_shows_the_safety_statuses_by_label_with_reasons_actors_and_times_oldest_first', async () => {
    // An event seeded through the safety check: submitted for it, sent back by
    // the Safety Officer, submitted again, approved, confirmed. The raw
    // statuses stay for code; what is read is the Organiser's label.
    const SAFETY_OFFICER_ID = '55555555-5555-4555-8555-555555555555';
    const rows = [
      { previous_status: STATUS.APPROVED, new_status: STATUS.SAFETY_REVIEW, changed_by: COORDINATOR_ID, reason: 'Venue and equipment are arranged.', created_at: '2026-02-01T09:00:00+00:00' },
      { previous_status: STATUS.SAFETY_REVIEW, new_status: STATUS.APPROVED, changed_by: SAFETY_OFFICER_ID, reason: 'The second exit is blocked.', created_at: '2026-02-02T09:00:00+00:00' },
      { previous_status: STATUS.APPROVED, new_status: STATUS.SAFETY_REVIEW, changed_by: COORDINATOR_ID, reason: null, created_at: '2026-02-03T09:00:00+00:00' },
      { previous_status: STATUS.SAFETY_REVIEW, new_status: STATUS.SAFETY_APPROVED, changed_by: SAFETY_OFFICER_ID, reason: 'Meets the safety review.', created_at: '2026-02-04T09:00:00+00:00' },
      { previous_status: STATUS.SAFETY_APPROVED, new_status: STATUS.CONFIRMED, changed_by: COORDINATOR_ID, reason: null, created_at: '2026-02-05T09:00:00+00:00' },
    ];
    const people = [...profiles(), { id: SAFETY_OFFICER_ID, full_name: 'Sam Safety' }];
    const client = readingHistory(heldEvent({ status: STATUS.CONFIRMED }), rows, people);

    const history = await getEventRequestStatusHistory(REQUEST_ID, ORGANISER_ID, { client });

    expect(history.map((entry) => [entry.previousStatusLabel, entry.newStatusLabel])).toEqual([
      ['Planning', 'Safety check'],
      ['Safety check', 'Planning'],
      ['Planning', 'Safety check'],
      ['Safety check', 'Safety approved'],
      ['Safety approved', 'Confirmed'],
    ]);
    expect(history.map((entry) => [entry.previousStatus, entry.newStatus])).toEqual(
      rows.map((row) => [row.previous_status, row.new_status]),
    );
    expect(history.map((entry) => entry.reason)).toEqual(rows.map((row) => row.reason));
    expect(history.map((entry) => entry.changedByName))
      .toEqual(['Carlos Coordinator', 'Sam Safety', 'Carlos Coordinator', 'Sam Safety', 'Carlos Coordinator']);
    expect(history.map((entry) => entry.changedAt)).toEqual(rows.map((row) => row.created_at));
    for (const entry of history) {
      expect(`${entry.previousStatusLabel} ${entry.newStatusLabel}`).not.toMatch(/_|Unknown|Unavailable/);
    }
    expect(client.calls[1].order).toEqual([['created_at', { ascending: true }]]);
  });

  it.each([STATUS.SAFETY_REVIEW, STATUS.SAFETY_APPROVED])(
    'SCRUM488_AC6_an_event_in_%s_can_be_read_by_its_organiser_and_its_assigned_coordinator_only',
    async (status) => {
      for (const [userId, readable] of [[ORGANISER_ID, true], [COORDINATOR_ID, true], [STRANGER_ID, false]]) {
        const client = readingHistory(heldEvent({ status }));

        const read = getEventRequestStatusHistory(REQUEST_ID, userId, { client });

        if (readable) await expect(read).resolves.toHaveLength(3);
        else expect(await errorFrom(read)).toBeInstanceOf(NotFoundError);
      }
    },
  );

  it('SCRUM322_AC6_exposes_only_those_seven_fields', async () => {
    // Not the user id, the row id or the event id: what the screen shows is the
    // name, and the ids are nobody's business.
    const client = readingHistory();

    const [first] = await getEventRequestStatusHistory(REQUEST_ID, ORGANISER_ID, { client });

    expect(Object.keys(first).sort()).toEqual([
      'changedAt', 'changedByName', 'newStatus', 'newStatusLabel',
      'previousStatus', 'previousStatusLabel', 'reason',
    ]);
  });

  it('SCRUM322_AC6_asks_for_the_oldest_change_first', async () => {
    const client = readingHistory();

    await getEventRequestStatusHistory(REQUEST_ID, ORGANISER_ID, { client });

    const history = client.calls[1];
    expect(history.table).toBe('event_request_status_history');
    expect(history.filters).toEqual([['event_request_id', REQUEST_ID]]);
    expect(history.order).toEqual([['created_at', { ascending: true }]]);
  });

  it('SCRUM322_AC6_returns_the_rows_in_the_order_the_database_gave_them', async () => {
    const client = readingHistory();

    const history = await getEventRequestStatusHistory(REQUEST_ID, ORGANISER_ID, { client });

    expect(history.map((entry) => entry.newStatus)).toEqual([
      STATUS.SUBMITTED,
      STATUS.UNDER_REVIEW,
      STATUS.PENDING_CLARIFICATION,
    ]);
  });

  it('SCRUM322_AC6_looks_up_each_name_once_in_a_single_read', async () => {
    const client = readingHistory();

    await getEventRequestStatusHistory(REQUEST_ID, ORGANISER_ID, { client });

    expect(client.calls).toHaveLength(3);
    expect(client.calls[2].table).toBe('profiles');
    expect(client.calls[2].inFilters).toEqual([['id', [ORGANISER_ID, COORDINATOR_ID]]]);
  });

  it.each([
    ['has no profile', []],
    ['has a profile with no name', [{ id: COORDINATOR_ID, full_name: null }]],
    ['has a blank name', [{ id: COORDINATOR_ID, full_name: '   ' }]],
  ])('SCRUM322_AC6_reports_a_null_name_for_a_user_who_%s', async (_label, people) => {
    const client = readingHistory(heldEvent(), historyRows(), people);

    const history = await getEventRequestStatusHistory(REQUEST_ID, COORDINATOR_ID, { client });

    expect(history[1].changedByName).toBeNull();
  });

  it('SCRUM322_AC6_returns_an_empty_list_when_nothing_has_changed_yet', async () => {
    // A draft, or an event submitted before 021: it exists and the caller may
    // read it, so "nothing yet" is the true answer, and no names are looked up.
    const client = createQueueFakeClient([ok(storedRow()), ok([])]);

    const history = await getEventRequestStatusHistory(REQUEST_ID, ORGANISER_ID, { client });

    expect(history).toEqual([]);
    expect(client.calls).toHaveLength(2);
  });
});


describe('SCRUM-322: anyone else gets not found', () => {
  const missingMessage = `Event request ${REQUEST_ID} not found`;

  it.each([
    ['an unrelated user', STRANGER_ID, heldEvent()],
    ['a coordinator the event is not assigned to', NEW_COORDINATOR_ID, heldEvent()],
    ['the previous coordinator after a handover', COORDINATOR_ID, heldEvent({ assigned_coordinator_id: NEW_COORDINATOR_ID })],
    ['another organiser', OTHER_ORGANISER_ID, heldEvent()],
    ['a coordinator, for a draft with no coordinator', COORDINATOR_ID, storedRow()],
  ])('SCRUM322_refuses_%s with not found, and reads no history', async (_label, userId, event) => {
    const client = createQueueFakeClient([ok(event)]);

    const err = await errorFrom(getEventRequestStatusHistory(REQUEST_ID, userId, { client }));

    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
    expect(err.message).toBe(missingMessage);
    expect(client.calls).toHaveLength(1);
  });

  it('SCRUM322_answers_a_missing_event_with_the_same_not_found', async () => {
    // Identical to the refusals above, so the two cannot be told apart.
    const client = createQueueFakeClient([ok(null)]);

    const err = await errorFrom(getEventRequestStatusHistory(REQUEST_ID, ORGANISER_ID, { client }));

    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toBe(missingMessage);
  });

  it.each([undefined, null, '', '   ', 42])(
    'SCRUM322_refuses_%j_as_the_user_before_any_read',
    async (userId) => {
      const client = createQueueFakeClient([]);

      const err = await errorFrom(getEventRequestStatusHistory(REQUEST_ID, userId, { client }));

      expect(err).toBeInstanceOf(ValidationError);
      expect(client.calls).toHaveLength(0);
    },
  );

  it('SCRUM322_does_not_hide_a_failed_history_read_behind_an_empty_list', async () => {
    const client = createQueueFakeClient([ok(heldEvent()), dbError('XX000', 'boom')]);

    const err = await errorFrom(getEventRequestStatusHistory(REQUEST_ID, ORGANISER_ID, { client }));

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('boom');
  });

  it('SCRUM322_does_not_hide_a_failed_name_lookup_behind_missing_names', async () => {
    const client = createQueueFakeClient([ok(heldEvent()), ok(historyRows()), dbError('XX000', 'boom')]);

    const err = await errorFrom(getEventRequestStatusHistory(REQUEST_ID, ORGANISER_ID, { client }));

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('boom');
  });

  it('SCRUM322_writes_nothing', async () => {
    const client = readingHistory();

    await getEventRequestStatusHistory(REQUEST_ID, ORGANISER_ID, { client });

    expect(client.calls.every((call) => call.operation === 'select')).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-325 -- every pair of statuses, generated from the status list
// ---------------------------------------------------------------------------
/**
 * SCRUM-318 AC2, AC3 and AC4 through the one function every status change goes
 * through. The domain tests pin the transition table against the Jira table by
 * hand. These do not repeat the table: they take every ordered pair of
 * statuses, ask canTransition which are allowed, and check what the service
 * does with each. So a status added later is covered the moment it exists.
 *
 *  - A pair that is not allowed is refused with a ConflictError that names the
 *    status the request is in, and nothing at all is sent to the database, so
 *    the event is left unchanged and no history can be written.
 *  - A pair that is allowed is sent, once, with the previous and new status and
 *    the user. Draft -> submitted is the one allowed pair that is not sent
 *    through here: submitting has its own path, which also assigns a
 *    coordinator.
 *  - Completed and cancelled lead nowhere, whatever the target.
 */
const EVERY_STATUS = Object.values(STATUS);
const EVERY_PAIR = EVERY_STATUS.flatMap((from) => EVERY_STATUS.map((to) => [from, to]));
const DISALLOWED_PAIRS = EVERY_PAIR.filter(([from, to]) => !canTransition(from, to));
const SENT_PAIRS = EVERY_PAIR.filter(
  ([from, to]) => canTransition(from, to) && !(from === STATUS.DRAFT && to === STATUS.SUBMITTED),
);

describe('SCRUM-325 AC2/AC3: every disallowed pair of statuses is refused with the current status', () => {
  it('SCRUM325_generates_the_pairs_from_the_status_list', () => {
    // A guard against the generation going quiet: every status is a source and
    // a target, and both groups are non-empty.
    expect(EVERY_PAIR).toHaveLength(EVERY_STATUS.length ** 2);
    expect(DISALLOWED_PAIRS.length).toBeGreaterThan(0);
    expect(SENT_PAIRS.length).toBeGreaterThan(0);
    expect(DISALLOWED_PAIRS.length + SENT_PAIRS.length + 1).toBe(EVERY_PAIR.length);
  });

  it.each(DISALLOWED_PAIRS)(
    'SCRUM325_AC3_refuses_%s_to_%s_naming_the_current_status_and_sending_nothing',
    async (from, to) => {
      const client = createEventRequestClient([]);

      const err = await errorFrom(change(client, { expectedStatus: from, newStatus: to }));

      expect(err).toBeInstanceOf(ConflictError);
      expect(err.status).toBe(409);
      expect(err.message).toContain(`'${from}'`);
      expect(client.calls).toHaveLength(0);
    },
  );

  it.each(SENT_PAIRS)('SCRUM325_AC2_sends_%s_to_%s_once_with_the_previous_and_new_status', async (from, to) => {
    const client = createEventRequestClient([ok(approvedRow({ status: to }))]);

    await change(client, { expectedStatus: from, newStatus: to });

    expect(rpcCallsOf(client)).toHaveLength(1);
    expect(client.calls).toHaveLength(1);
    expect(rpcCallsOf(client)[0].args).toMatchObject({
      p_event_request_id: REQUEST_ID,
      p_expected_status: from,
      p_new_status: to,
      p_changed_by: COORDINATOR_ID,
    });
  });
});


describe('SCRUM-325 AC4: nothing leaves a final status', () => {
  it.each([STATUS.COMPLETED, STATUS.CANCELLED])('SCRUM325_AC4_refuses_every_move_out_of_%s', async (final) => {
    for (const to of EVERY_STATUS) {
      const client = createEventRequestClient([]);

      const err = await errorFrom(change(client, { expectedStatus: final, newStatus: to }));

      expect(err, `${final} -> ${to}`).toBeInstanceOf(ConflictError);
      expect(err.message).toContain(`'${final}'`);
      expect(client.calls).toHaveLength(0);
    }
  });

  describe('SCRUM-395 significant event change service calls', () => {
    const current = storedRow({
      status: STATUS.CONFIRMED,
      assigned_coordinator_id: COORDINATOR_ID,
      proposed_start: '2027-04-01T09:00:00+08:00',
      proposed_end: '2027-04-01T11:00:00+08:00',
    });
    const changes = { proposedStart: '2027-04-01T10:00:00+08:00' };

    it('SCRUM395_AC3_previews_the_validated_change_through_the_shared_database_calculation', async () => {
      const impact = { venueBookings: [], equipmentReservations: [], registeredAttendeesToNotify: 0 };
      const client = createEventRequestClient([ok(current), ok(impact)]);

      await expect(getSignificantEventChangeImpact(
        REQUEST_ID,
        changes,
        COORDINATOR_ID,
        { client },
      )).resolves.toEqual(impact);

      expect(client.calls[0].table).toBe('event_requests');
      expect(rpcCallsOf(client)).toEqual([expect.objectContaining({
        fn: 'preview_significant_event_change',
        args: {
          p_event_request_id: REQUEST_ID,
          p_changes: changes,
          p_user_id: COORDINATOR_ID,
        },
      })]);
    });

    it('SCRUM395_AC4_applies_the_change_through_the_atomic_database_function', async () => {
      const impact = { venueBookings: [], equipmentReservations: [], registeredAttendeesToNotify: 0 };
      const updated = storedRow({
        ...current,
        status: STATUS.APPROVED,
        proposed_start: '2027-04-01T10:00:00+08:00',
      });
      const client = createEventRequestClient([
        ok(current),
        ok({
          event: updated,
          impact,
          flaggedBookingIds: [],
          flaggedReservationCount: 0,
        }),
      ]);

      await expect(applySignificantEventChange(
        REQUEST_ID,
        { changes, reason: 'Updated schedule', expectedImpact: impact },
        COORDINATOR_ID,
        { client },
      )).resolves.toMatchObject({
        event: { id: REQUEST_ID, status: STATUS.APPROVED },
        impact,
        flaggedBookingIds: [],
        flaggedReservationCount: 0,
      });
      expect(rpcCallsOf(client)).toEqual([expect.objectContaining({
        fn: 'apply_significant_event_change',
        args: {
          p_event_request_id: REQUEST_ID,
          p_changes: changes,
          p_reason: 'Updated schedule',
          p_user_id: COORDINATOR_ID,
          p_expected_impact: impact,
        },
      })]);
    });

    it('SCRUM395_AC1_refuses_a_blank_reason_or_another_coordinator_before_the_write_rpc', async () => {
      const wrongAssignment = storedRow({
        ...current,
        assigned_coordinator_id: '66666666-6666-4666-8666-666666666666',
      });
      const client = createEventRequestClient([ok(wrongAssignment)]);

      await expect(applySignificantEventChange(
        REQUEST_ID,
        { changes, reason: ' ' },
        COORDINATOR_ID,
        { client },
      )).rejects.toBeInstanceOf(ValidationError);
      await expect(applySignificantEventChange(
        REQUEST_ID,
        {
          changes,
          reason: 'Updated schedule',
          expectedImpact: { venueBookings: [], equipmentReservations: [] },
        },
        COORDINATOR_ID,
        { client },
      )).rejects.toBeInstanceOf(ForbiddenError);
      expect(rpcCallsOf(client)).toHaveLength(0);
    });

    it('SCRUM395_AC3_requires_a_preview_impact_before_the_apply_rpc', async () => {
      const client = createEventRequestClient([]);
      await expect(applySignificantEventChange(
        REQUEST_ID,
        { changes, reason: 'Updated schedule' },
        COORDINATOR_ID,
        { client },
      )).rejects.toBeInstanceOf(ValidationError);
      expect(client.calls).toHaveLength(0);
    });

    const applyRefusedWith = (hint) => {
      const client = createEventRequestClient([
        ok(current),
        { data: null, error: { code: 'PT409', message: 'Refused by the database', hint } },
      ]);
      return errorFrom(applySignificantEventChange(
        REQUEST_ID,
        { changes, reason: 'Updated schedule', expectedImpact: { venueBookings: [], equipmentReservations: [] } },
        COORDINATOR_ID,
        { client },
      ));
    };

    it.each([
      ['SCRUM395_AC1', 'EVENT_STATUS_NOT_ALLOWED'],
      ['SCRUM395_AC5', 'SIGNIFICANT_CHANGE_IMPACT_CHANGED'],
    ])('%s_passes_the_%s_refusal_on_as_a_typed_conflict', async (_ac, hint) => {
      // The panel reads the code to offer a fresh preview instead of an error.
      const err = await applyRefusedWith(hint);

      expect(err).toBeInstanceOf(ConflictError);
      expect(err.code).toBe(hint);
    });

    it('SCRUM395_AC1_leaves_a_pt409_this_story_does_not_raise_untyped', async () => {
      const err = await applyRefusedWith('BOOKING_NOT_PENDING');

      expect(err).not.toBeInstanceOf(ConflictError);
      expect(err.status).toBeUndefined();
    });
  });

  it('SCRUM325_AC4_lets_a_rejected_request_go_back_to_a_draft_and_nowhere_else', () => {
    // Rejected is not final: the Organiser can reopen it.
    expect(EVERY_STATUS.filter((to) => canTransition(STATUS.REJECTED, to))).toEqual([STATUS.DRAFT]);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-19 -- starting a review, and deciding a request
// ---------------------------------------------------------------------------
/**
 * SCRUM-346 (start review), SCRUM-119 and SCRUM-121 (decide), subtasks of
 * SCRUM-19 (Approve or Reject a Submitted Event Request).
 *
 *   startEventReview(id, coordinatorId, { client })
 *     -> rpc('start_event_review', { p_event_request_id, p_coordinator_id })
 *   decideEventRequest(id, { decision, decisionNote }, decidedBy, { client, now })
 *     -> rpc('decide_event_request', { p_event_request_id, p_decision,
 *          p_decision_note, p_decided_by, p_decided_at })
 *
 * Both writes happen inside migration 029's functions. No decision could be
 * recorded before them: change_event_request_status writes only the status,
 * and 025's decided_status_has_decision refuses an approved or rejected row
 * with no decision, so the status and the decision must go in one statement.
 * And nothing set reviewing_coordinator_id, which 025's decided_by_is_reviewer
 * requires the decider to equal. 029's header argues both in full.
 *
 * These tests prove what the service does around the call: what it validates
 * before calling, exactly what it sends, and how each SQLSTATE comes back. The
 * functions' own logic (the lock, the checks, the single statement) is 029's,
 * and was proved against the live database, where a fake cannot reach.
 *
 * AC numbers follow the current ticket: AC1 starting the review and only the
 * assigned coordinator acting; AC2 and AC3 deciding only under review, AC3
 * including a request awaiting clarification; AC5 a rejection needs a reason;
 * AC6 no approval once the start date has passed; AC7 the status becomes
 * Approved or Rejected; AC9 the outcome, note, decider and time are recorded.
 *
 * Imports appended, for the reason the SCRUM-11 block gives.
 */
import { startEventReview, decideEventRequest } from '../../src/services/eventRequestService.js';

const DECISION_NOTE = 'Venue capacity cannot meet the expected attendance.';

/** The row start_event_review returns: under review, with the caller as reviewer. */
const underReviewRow = () => storedRow({
  status: STATUS.UNDER_REVIEW,
  submitted_at: NOW.toISOString(),
  assigned_coordinator_id: COORDINATOR_ID,
  reviewing_coordinator_id: COORDINATOR_ID,
});

/** The row decide_event_request returns, decided as asked. */
const decidedRow = (decision = 'rejected', note = DECISION_NOTE) => storedRow({
  status: decision,
  submitted_at: NOW.toISOString(),
  assigned_coordinator_id: COORDINATOR_ID,
  reviewing_coordinator_id: COORDINATOR_ID,
  decision,
  decision_note: note,
  decided_by: COORDINATOR_ID,
  decided_at: NOW.toISOString(),
});

const startReview = (client, coordinatorId = COORDINATOR_ID) =>
  startEventReview(REQUEST_ID, coordinatorId, { client });

const decide = (client, input = { decision: 'rejected', decisionNote: DECISION_NOTE }, decidedBy = COORDINATOR_ID) =>
  decideEventRequest(REQUEST_ID, input, decidedBy, { client, now: NOW });


describe('SCRUM-19 AC1: the assigned coordinator starts the review', () => {
  it('SCRUM19_AC1_starts_the_review_through_the_function_alone', async () => {
    // One call to the function, and nothing else, not even a read. Every
    // question a read could answer (does the event exist, is the caller its
    // coordinator, is it submitted) start_event_review answers under its row
    // lock, where the answer cannot change before the write. A read here
    // could only give an answer already out of date, as reassignEventRequest's
    // tests argue for the same shape. toEqual, so an extra argument fails as
    // surely as a missing one.
    const client = createEventRequestClient([ok(underReviewRow())]);

    await startReview(client);

    expect(client.calls.map((call) => call.operation)).toEqual(['rpc']);
    const [rpc] = rpcCallsOf(client);
    expect(rpc.fn).toBe('start_event_review');
    expect(rpc.args).toEqual({
      p_event_request_id: REQUEST_ID,
      p_coordinator_id: COORDINATOR_ID,
    });
  });

  it('SCRUM19_AC1_returns_the_request_with_its_reviewer', async () => {
    // The point of starting a review in its own function: the caller becomes
    // the reviewing coordinator, which 025's decided_by_is_reviewer requires
    // before any decision can be recorded. The row comes back through
    // toEventRequest like every other, so the reviewer is visible at once.
    const client = createEventRequestClient([ok(underReviewRow())]);

    const record = await startReview(client);

    expect(record.status).toBe(STATUS.UNDER_REVIEW);
    expect(record.reviewingCoordinatorId).toBe(COORDINATOR_ID);
    expect(Object.keys(record).some((key) => key.includes('_'))).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('SCRUM19_AC1_refuses_a_coordinator_id_that_is_%s_before_any_call', async (_label, value) => {
    // The caller comes from the token, so a missing one is a caller bug. The
    // function would refuse a null with 42501, but a blank string never
    // reaches it as a uuid at all: PostgREST fails to read it (22P02) and the
    // caller would get a 500 for what is a bad request.
    const client = createEventRequestClient([]);

    const err = await errorFrom(startEventReview(REQUEST_ID, value, { client }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM19_AC1_writes_nothing_outside_the_function', async () => {
    // The status, the reviewer and the history row are all written inside the
    // function's transaction. An update or insert from the service beside the
    // rpc would be a write outside it.
    const client = createEventRequestClient([ok(underReviewRow())]);

    await startReview(client);

    expect(client.calls.some((call) => call.operation === 'update')).toBe(false);
    expect(client.calls.some((call) => call.operation === 'insert')).toBe(false);
  });
});


describe("SCRUM-19: start_event_review's refusals become typed errors", () => {
  // One row per SQLSTATE 029 raises from start_event_review, each asserting
  // the function was called, so a refusal cannot pass by coming from
  // somewhere else. The messages are 029's own, passed through unchanged.
  it.each([
    {
      name: 'SCRUM19_AC1_reports_an_event_that_does_not_exist_as_not_found',
      code: 'P0002',
      message: `event request ${REQUEST_ID} not found`,
      Err: NotFoundError,
      status: 404,
    },
    {
      // AC1 itself. 403, not 404: the caller is a coordinator who can already
      // see the event, so the refusal reveals nothing (errors.js).
      name: 'SCRUM19_AC1_only_the_assigned_coordinator_starts_the_review',
      code: '42501',
      message: `only the coordinator assigned to event request ${REQUEST_ID} can start reviewing it`,
      Err: ForbiddenError,
      status: 403,
    },
    {
      name: 'SCRUM19_AC1_only_a_submitted_request_can_be_put_under_review',
      code: '55000',
      message: `event request ${REQUEST_ID} has status approved, and only a submitted request can be put under review`,
      Err: ConflictError,
      status: 409,
    },
    {
      name: 'SCRUM19_AC1_reports_a_review_started_in_a_race_as_a_conflict',
      code: '40001',
      message: `event request ${REQUEST_ID} changed status while the review was being started`,
      Err: ConflictError,
      status: 409,
    },
  ])('$name', async ({ code, message, Err, status }) => {
    const client = createEventRequestClient([dbError(code, message)]);

    const err = await errorFrom(startReview(client));

    expect(rpcCallsOf(client)).toHaveLength(1);
    expect(err).toBeInstanceOf(Err);
    expect(err.status).toBe(status);
    expect(err.message).toBe(message);
  });
});


/**
 * Two judgement calls the tests below pin.
 *
 * The decision must be exactly 'approved' or 'rejected', lowercase. No
 * case-folding. Those are the values of 025's event_request_decision enum and
 * of the status each leads to, and the frontend sends one of them from a
 * button, never from typed text, so there is nobody for leniency to help.
 * Accepting 'Approved' would invent a second spelling the API then has to
 * honour forever, and validateProcessChangeRequest takes the same strict line
 * for change-request decisions. Anything else, including a non-string, is a
 * ValidationError naming the field, before any call: PostgREST would otherwise
 * fail to read it as the enum (22P02), which translateError does not map, and
 * the coordinator would get a 500.
 *
 * A rejection with no reason is refused by the service too, although 029
 * refuses it with 22023. The function's refusal is one sentence in a Postgres
 * exception; the service's is a ValidationError whose details name
 * decisionNote, which is what lets the form put the message beside the field
 * that needs filling in, the way every other form fault in this API is
 * reported. It also saves a round trip and a row lock for a fault visible in
 * the request alone. The function's check stays as the backstop for any
 * caller that does not come through here, and its 22023 still maps to a 400.
 */
describe('SCRUM-19: the assigned coordinator decides a request under review', () => {
  it('SCRUM19_AC7_decides_through_the_function_alone', async () => {
    // One call, all five arguments, compared with toEqual. p_decided_at is the
    // injected clock as an ISO string, for 016's reason for p_submitted_at:
    // the service owns the clock so a test can state the exact instant. Here
    // it decides an outcome, because AC6 measures "has the start date
    // passed" at that instant. p_decided_by is the caller passed in, never
    // anything from the body.
    const client = createEventRequestClient([ok(decidedRow())]);

    await decide(client);

    expect(client.calls.map((call) => call.operation)).toEqual(['rpc']);
    const [rpc] = rpcCallsOf(client);
    expect(rpc.fn).toBe('decide_event_request');
    expect(rpc.args).toEqual({
      p_event_request_id: REQUEST_ID,
      p_decision: 'rejected',
      p_decision_note: DECISION_NOTE,
      p_decided_by: COORDINATOR_ID,
      p_decided_at: NOW.toISOString(),
    });
  });

  it('SCRUM19_AC9_returns_the_recorded_decision_in_camelCase', async () => {
    // SCRUM-121: the first time any of 025's four decision columns reaches an
    // API response. The decision, the note, who decided and when, as AC9
    // asks, under their camelCase names.
    const client = createEventRequestClient([ok(decidedRow('rejected'))]);

    const record = await decide(client);

    expect(record).toMatchObject({
      status: 'rejected',
      decision: 'rejected',
      decisionNote: DECISION_NOTE,
      decidedBy: COORDINATOR_ID,
      decidedAt: NOW.toISOString(),
      reviewingCoordinatorId: COORDINATOR_ID,
    });
    expect(Object.keys(record).some((key) => key.includes('_'))).toBe(false);
  });

  it('SCRUM19_AC9_every_read_carries_the_decision', async () => {
    // Not only the decision's own response: any read has to carry it, or the
    // Organiser reading their request a moment later would not see the
    // outcome. COLUMNS is what every read selects, so it is pinned through an
    // ordinary read, as SCRUM331_AC7_every_read_carries_the_reviewer does.
    // An undecided row reads them as null, not undefined.
    const decided = createEventRequestClient([ok(decidedRow('approved', 'Approved as submitted.'))]);
    const undecided = createEventRequestClient([ok(storedRow())]);

    const record = await getEventRequestById(REQUEST_ID, { client: decided });
    const fresh = await getEventRequestById(REQUEST_ID, { client: undecided });

    for (const column of ['reviewing_coordinator_id', 'decision', 'decision_note', 'decided_by', 'decided_at']) {
      expect(decided.calls[0].select).toContain(column);
    }
    expect(record).toMatchObject({
      decision: 'approved',
      decisionNote: 'Approved as submitted.',
      decidedBy: COORDINATOR_ID,
      decidedAt: NOW.toISOString(),
    });
    expect(fresh).toMatchObject({ decision: null, decisionNote: null, decidedBy: null, decidedAt: null });
  });

  it.each([
    ['capitalised', 'Approved'],
    ['upper case', 'REJECTED'],
    ['an unknown word', 'maybe'],
    ['empty', ''],
    ['missing', undefined],
    ['null', null],
    ['a number', 1],
  ])('SCRUM19_AC7_refuses_a_decision_that_is_%s_before_any_call', async (_label, value) => {
    const client = createEventRequestClient([]);

    const err = await errorFrom(decide(client, { decision: value, decisionNote: DECISION_NOTE }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(fieldsIn(err)).toContain('decision');
    expect(client.calls).toHaveLength(0);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('SCRUM19_AC5_refuses_a_rejection_whose_reason_is_%s_before_any_call', async (_label, value) => {
    // See the block comment above for why the service checks this as well as
    // the function.
    const client = createEventRequestClient([]);

    const err = await errorFrom(decide(client, { decision: 'rejected', decisionNote: value }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(fieldsIn(err)).toEqual(['decisionNote']);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM19_AC5_sends_an_omitted_or_blank_note_on_an_approval_as_null', async () => {
    // An approval's note is optional. A blank one says nothing, and sent as
    // spaces it would fail 021's reason_not_blank on the history row, so it
    // goes as null, as reassignEventRequest does for a blank handover note.
    const omitted = createEventRequestClient([ok(decidedRow('approved', null))]);
    const blank = createEventRequestClient([ok(decidedRow('approved', null))]);

    await decide(omitted, { decision: 'approved' });
    await decide(blank, { decision: 'approved', decisionNote: '   ' });

    expect(rpcCallsOf(omitted)[0].args.p_decision_note).toBeNull();
    expect(rpcCallsOf(blank)[0].args.p_decision_note).toBeNull();
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('SCRUM19_AC1_refuses_a_decider_id_that_is_%s_before_any_call', async (_label, value) => {
    const client = createEventRequestClient([]);

    const err = await errorFrom(
      decideEventRequest(REQUEST_ID, { decision: 'approved' }, value, { client, now: NOW }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM19_AC9_writes_nothing_outside_the_function', async () => {
    // The status, the four decision fields and the history row are written
    // in one statement and one transaction inside 029. A write from the
    // service beside it would break the single statement 025's constraints
    // require.
    const client = createEventRequestClient([ok(decidedRow())]);

    await decide(client);

    expect(client.calls.some((call) => call.operation === 'update')).toBe(false);
    expect(client.calls.some((call) => call.operation === 'insert')).toBe(false);
  });
});


describe("SCRUM-19: decide_event_request's refusals become typed errors", () => {
  // One row per SQLSTATE 029 raises from decide_event_request. Every input
  // here passes the service's own checks, so each refusal can only have come
  // from the function, and each asserts the function was called.
  it.each([
    {
      name: 'SCRUM19_AC2_reports_an_event_that_does_not_exist_as_not_found',
      code: 'P0002',
      message: `event request ${REQUEST_ID} not found`,
      Err: NotFoundError,
      status: 404,
      exact: true,
    },
    {
      name: 'SCRUM19_AC1_only_the_assigned_coordinator_decides',
      code: '42501',
      message: `only the coordinator assigned to event request ${REQUEST_ID} can decide it`,
      Err: ForbiddenError,
      status: 403,
      exact: true,
    },
    {
      // 029 refuses a decided-by who is not the recorded reviewer with the
      // same code, and the same 403.
      name: 'SCRUM19_AC1_only_the_reviewing_coordinator_decides',
      code: '42501',
      message: `event request ${REQUEST_ID} is under review by another coordinator, who must decide it`,
      Err: ForbiddenError,
      status: 403,
      exact: true,
    },
    {
      // AC3's "including Pending clarification", refused by the function's
      // under_review check with the status named.
      name: 'SCRUM19_AC3_refuses_a_decision_on_a_request_awaiting_clarification',
      code: '55000',
      message: `event request ${REQUEST_ID} has status pending_clarification, and only a request under review can be decided`,
      Err: ConflictError,
      status: 409,
      exact: true,
    },
    {
      name: 'SCRUM19_AC2_refuses_a_decision_on_a_request_not_yet_under_review',
      code: '55000',
      message: `event request ${REQUEST_ID} has status submitted, and only a request under review can be decided`,
      Err: ConflictError,
      status: 409,
      exact: true,
    },
    {
      // AC6. The same 409 as a wrong status, with 029's message telling the
      // coordinator what to do next. 029's header argues the shared code.
      name: 'SCRUM19_AC6_refuses_an_approval_when_the_start_date_has_passed',
      code: '55000',
      message: `event request ${REQUEST_ID} cannot be approved because its proposed start date has passed or is missing. Agree a new date with the organiser, or reject the request`,
      Err: ConflictError,
      status: 409,
      exact: true,
    },
    {
      // The function's own check for a missing reason, the backstop behind
      // the service's. Still a 400, with the function's sentence.
      name: 'SCRUM19_AC5_the_functions_refusal_of_a_missing_reason_is_still_a_400',
      code: '22023',
      message: `a reason is required to reject event request ${REQUEST_ID}`,
      Err: ValidationError,
      status: 400,
      exact: true,
    },
    {
      name: 'SCRUM19_AC7_reports_a_decision_made_in_a_race_as_a_conflict',
      code: '40001',
      message: `event request ${REQUEST_ID} changed status while it was being decided`,
      Err: ConflictError,
      status: 409,
      exact: true,
    },
  ])('$name', async ({ code, message, Err, status }) => {
    const client = createEventRequestClient([dbError(code, message)]);

    const err = await errorFrom(decide(client, { decision: 'approved' }));

    expect(rpcCallsOf(client)).toHaveLength(1);
    expect(err).toBeInstanceOf(Err);
    expect(err.status).toBe(status);
    expect(err.message).toBe(message);
  });

  it('SCRUM19_AC7_a_null_decision_time_is_a_server_fault', async () => {
    // 22004: the decision or the time was null. Only a caller bug can do
    // that, since the service always sends its clock, so it stays untyped,
    // as 021's 22004 does: a 500 that is logged, not a 400 telling a
    // coordinator to fix a form they filled in correctly.
    const client = createEventRequestClient([
      dbError('22004', 'decide_event_request needs the decision and the time it was made'),
    ]);

    const err = await errorFrom(decide(client, { decision: 'approved' }));

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err.status).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// SCRUM-266: a confirmed event with a flagged booking needs attention
// ---------------------------------------------------------------------------
describe('SCRUM-266: event reads say whether the event needs attention', () => {
  const booking = (status) => ({ status });

  it.each([
    ['confirmed with a flagged booking', STATUS.CONFIRMED, [booking('approved'), booking('flagged_for_review')], true],
    ['confirmed with no flagged booking', STATUS.CONFIRMED, [booking('approved'), booking('cancelled')], false],
    ['confirmed with no bookings', STATUS.CONFIRMED, [], false],
    ['approved with a flagged booking', STATUS.APPROVED, [booking('flagged_for_review')], false],
    ['in safety review with a flagged booking', STATUS.SAFETY_REVIEW, [booking('flagged_for_review')], false],
  ])('SCRUM266_AC4_an_event_%s_needs_attention_%s', async (_label, status, bookings, expected) => {
    const client = createQueueFakeClient([
      ok([myEventRow({ status, bookings })]),
      ok([profileRow(ORGANISER_ID, 'Aisha Rahman')]),
    ]);

    const [event] = await listEventRequestsForCoordinator(COORDINATOR_ID, { client });

    expect(event.needsAttention).toBe(expected);
    expect(event).not.toHaveProperty('bookings');
  });

  it('SCRUM266_AC4_an_embed_read_as_one_object_is_still_read', async () => {
    const client = createQueueFakeClient([
      ok([myEventRow({ status: STATUS.CONFIRMED, bookings: booking('flagged_for_review') })]),
      ok([profileRow(ORGANISER_ID, 'Aisha Rahman')]),
    ]);

    const [event] = await listEventRequestsForCoordinator(COORDINATOR_ID, { client });

    expect(event.needsAttention).toBe(true);
  });

  it('SCRUM266_AC4_the_queue_my_events_and_the_organisers_list_embed_booking_statuses', async () => {
    const flaggedConfirmed = heldRow({ status: STATUS.CONFIRMED, bookings: [booking('flagged_for_review')] });
    const client = createQueueFakeClient([
      ok([flaggedConfirmed]),
      ok([flaggedConfirmed]),
      ok([profileRow(ORGANISER_ID, 'Aisha Rahman')]),
      ok([flaggedConfirmed]),
      ok([profileRow(COORDINATOR_ID, 'Wei Ling')]),
    ]);

    const results = [
      await listEventRequestsForReview({ client }),
      await listEventRequestsForCoordinator(COORDINATOR_ID, { client }),
      await listEventRequestsForOrganiser(ORGANISER_ID, { client }),
    ];

    expect(results.map(([event]) => event.needsAttention)).toEqual([true, true, true]);
    const eventReads = client.calls.filter((call) => call.table === 'event_requests');
    expect(eventReads).toHaveLength(3);
    for (const call of eventReads) expect(call.select).toMatch(/bookings\(status\)/);
  });

  it('SCRUM266_AC4_the_coordinator_and_organiser_single_reads_carry_needs_attention', async () => {
    const flaggedConfirmed = heldRow({ status: STATUS.CONFIRMED, bookings: [booking('flagged_for_review')] });
    const client = createQueueFakeClient([ok(flaggedConfirmed), ok(flaggedConfirmed)]);

    const forCoordinator = await getEventRequestForCoordinator(REQUEST_ID, { client });
    const forOrganiser = await getEventRequestForOrganiser(REQUEST_ID, ORGANISER_ID, { client });

    expect(forCoordinator.needsAttention).toBe(true);
    expect(forOrganiser.needsAttention).toBe(true);
    for (const call of client.calls) expect(call.select).toMatch(/bookings\(status\)/);
  });
});

// ---------------------------------------------------------------------------
// SCRUM-315 (SCRUM-310 AC6): a confirmed event with a flagged equipment
// reservation needs attention, and says why
// ---------------------------------------------------------------------------
describe('SCRUM-310 (SCRUM-315): a flagged equipment reservation puts a Confirmed event on the Needs attention list', () => {
  const reservation = (overrides = {}) => ({
    flagged: true,
    released_at: null,
    flag_reason: 'Fewer units of this equipment are usable (Dropped)',
    flag_code: 'equipment_lost',
    ...overrides,
  });
  const booking = (status) => ({ status });
  const LOST = 'Equipment unavailable: Fewer units of this equipment are usable (Dropped)';

  async function readOne(overrides) {
    const client = createQueueFakeClient([
      ok([myEventRow(overrides)]),
      ok([profileRow(ORGANISER_ID, 'Aisha Rahman')]),
    ]);
    const [event] = await listEventRequestsForCoordinator(COORDINATOR_ID, { client });
    return event;
  }

  it.each([
    ['one flagged reservation', [reservation()], true],
    ['a flagged reservation among others', [reservation({ flagged: false }), reservation()], true],
    ['only a released reservation that was flagged', [reservation({ released_at: '2026-10-20T01:00:00Z' })], false],
    ['reservations that are not flagged', [reservation({ flagged: false, flag_reason: null })], false],
    ['no reservations', [], false],
    ['a flag that is not the boolean true', [reservation({ flagged: 'true' }), reservation({ flagged: 1 })], false],
  ])('SCRUM310_AC6_a_confirmed_event_with_%s_needs_attention_%s', async (_label, reservations, expected) => {
    const event = await readOne({ status: STATUS.CONFIRMED, equipment_reservations: reservations });

    expect(event.needsAttention).toBe(expected);
    expect(event.attentionReasons.length > 0).toBe(expected);
    expect(event).not.toHaveProperty('equipment_reservations');
    expect(event).not.toHaveProperty('equipmentReservations');
  });

  it.each([
    STATUS.DRAFT,
    STATUS.SUBMITTED,
    STATUS.UNDER_REVIEW,
    STATUS.PENDING_CLARIFICATION,
    STATUS.APPROVED,
    STATUS.SAFETY_REVIEW,
    STATUS.REJECTED,
  ])('SCRUM310_AC6_an_event_that_is_%s_does_not_need_attention_for_a_flagged_reservation', async (status) => {
    const event = await readOne({ status, equipment_reservations: [reservation()] });

    expect(event.needsAttention).toBe(false);
    expect(event.attentionReasons).toEqual([]);
  });

  it.each([
    ['the embed is missing', undefined],
    ['the embed is null', null],
    ['the embed is an empty list', []],
  ])('SCRUM310_AC6_when_%s_a_confirmed_event_does_not_need_attention', async (_label, value) => {
    const event = await readOne({ status: STATUS.CONFIRMED, equipment_reservations: value });

    expect(event.needsAttention).toBe(false);
    expect(event.attentionReasons).toEqual([]);
  });

  it('SCRUM310_AC6_an_embed_read_as_one_object_is_still_read', async () => {
    const event = await readOne({ status: STATUS.CONFIRMED, equipment_reservations: reservation() });

    expect(event.needsAttention).toBe(true);
    expect(event.attentionReasons).toEqual([LOST]);
  });

  it('SCRUM310_AC6_a_null_entry_in_the_embed_is_skipped', async () => {
    const event = await readOne({ status: STATUS.CONFIRMED, equipment_reservations: [null, reservation()] });

    expect(event.attentionReasons).toEqual([LOST]);
  });

  it('SCRUM310_AC6_the_reason_the_flag_was_given_is_the_reason_shown', async () => {
    const event = await readOne({
      status: STATUS.CONFIRMED,
      equipment_reservations: [reservation({ flag_reason: 'The equipment type was retired' })],
    });

    expect(event.attentionReasons).toEqual(['Equipment unavailable: The equipment type was retired']);
  });

  it.each([
    ['null', null],
    ['empty', ''],
    ['blank', '   '],
    ['not text', 42],
  ])('SCRUM310_AC6_a_lost_equipment_flag_whose_reason_is_%s_still_says_equipment_lost', async (_label, flag_reason) => {
    const event = await readOne({ status: STATUS.CONFIRMED, equipment_reservations: [reservation({ flag_reason })] });

    expect(event.attentionReasons).toEqual(['Equipment unavailable']);
  });

  it.each([
    ['null', null],
    ['missing', undefined],
    ['an unknown kind', 'something_else'],
    ['empty', ''],
  ])('SCRUM310_AC6_a_flag_whose_kind_is_%s_is_not_called_equipment_lost', async (_label, flag_code) => {
    const event = await readOne({
      status: STATUS.CONFIRMED,
      equipment_reservations: [reservation({ flag_code, flag_reason: 'The event date or time changed' })],
    });

    expect(event.needsAttention).toBe(true);
    expect(event.attentionReasons).toEqual(['Equipment flagged for review: The event date or time changed']);
  });

  it.each([
    ['null', null],
    ['blank', '   '],
  ])('SCRUM310_AC6_an_other_flag_with_a_%s_reason_says_only_that_it_is_flagged', async (_label, flag_reason) => {
    const event = await readOne({
      status: STATUS.CONFIRMED,
      equipment_reservations: [reservation({ flag_code: null, flag_reason })],
    });

    expect(event.attentionReasons).toEqual(['Equipment flagged for review']);
  });

  it('SCRUM310_AC6_a_lost_flag_and_another_flag_with_the_same_reason_are_two_entries', async () => {
    const event = await readOne({
      status: STATUS.CONFIRMED,
      equipment_reservations: [
        reservation({ flag_reason: 'Same words' }),
        reservation({ flag_code: null, flag_reason: 'Same words' }),
      ],
    });

    expect(event.attentionReasons).toEqual(['Equipment unavailable: Same words', 'Equipment flagged for review: Same words']);
  });

  it('SCRUM310_AC6_the_reason_is_trimmed', async () => {
    const event = await readOne({
      status: STATUS.CONFIRMED,
      equipment_reservations: [reservation({ flag_reason: '  Lost in transit  ' })],
    });

    expect(event.attentionReasons).toEqual(['Equipment unavailable: Lost in transit']);
  });

  it('SCRUM310_AC6_two_flags_with_the_same_reason_are_one_entry', async () => {
    const event = await readOne({ status: STATUS.CONFIRMED, equipment_reservations: [reservation(), reservation()] });

    expect(event.attentionReasons).toEqual([LOST]);
  });

  it('SCRUM310_AC6_flags_with_different_reasons_are_each_listed_in_the_order_met', async () => {
    const event = await readOne({
      status: STATUS.CONFIRMED,
      equipment_reservations: [
        reservation({ flag_reason: 'Second' }),
        reservation({ flag_reason: 'First' }),
        reservation({ flag_reason: 'Second' }),
      ],
    });

    expect(event.attentionReasons).toEqual(['Equipment unavailable: Second', 'Equipment unavailable: First']);
  });

  it('SCRUM310_AC6_a_released_flag_adds_no_reason', async () => {
    const event = await readOne({
      status: STATUS.CONFIRMED,
      equipment_reservations: [reservation({ released_at: '2026-10-20T01:00:00Z', flag_reason: 'Gone' }), reservation()],
    });

    expect(event.attentionReasons).toEqual([LOST]);
  });

  it('SCRUM310_AC6_a_venue_flag_and_an_equipment_flag_are_both_given_as_reasons', async () => {
    const event = await readOne({
      status: STATUS.CONFIRMED,
      bookings: [booking('flagged_for_review')],
      equipment_reservations: [reservation()],
    });

    expect(event.needsAttention).toBe(true);
    expect(event.attentionReasons).toEqual(['Venue: a booking is flagged for review', LOST]);
  });

  it('SCRUM310_AC6_a_venue_flag_alone_still_gives_its_reason_and_an_equipment_flag_alone_gives_only_its_own', async () => {
    const venueOnly = await readOne({ status: STATUS.CONFIRMED, bookings: [booking('flagged_for_review')] });
    const equipmentOnly = await readOne({ status: STATUS.CONFIRMED, bookings: [booking('approved')], equipment_reservations: [reservation()] });

    expect(venueOnly.attentionReasons).toEqual(['Venue: a booking is flagged for review']);
    expect(equipmentOnly.attentionReasons).toEqual([LOST]);
  });

  it('SCRUM310_AC6_an_event_that_does_not_need_attention_has_an_empty_reasons_list_not_a_missing_one', async () => {
    const event = await readOne({ status: STATUS.CONFIRMED });

    expect(event.attentionReasons).toEqual([]);
  });

  describe('what an organiser is shown of a flag', () => {
    const NOTE = 'Fewer units of this equipment are usable (Cracked in transit, bin 4)';
    const noted = () => reservation({ flag_reason: NOTE });

    async function listedForOrganiser(overrides) {
      const client = createQueueFakeClient([
        ok([storedRow({ status: STATUS.CONFIRMED, ...overrides })]),
      ]);
      const [event] = await listEventRequestsForOrganiser(ORGANISER_ID, { client });
      return event;
    }

    async function readForOrganiser(overrides) {
      const client = createQueueFakeClient([ok(storedRow({ status: STATUS.CONFIRMED, ...overrides }))]);
      return getEventRequestForOrganiser(REQUEST_ID, ORGANISER_ID, { client });
    }

    it('SCRUM310_AC6_the_organiser_list_names_the_kind_of_flag_and_not_the_staff_note', async () => {
      const event = await listedForOrganiser({ equipment_reservations: [noted()] });

      expect(event.needsAttention).toBe(true);
      expect(event.attentionReasons).toEqual(['Equipment unavailable']);
      expect(JSON.stringify(event)).not.toContain('Cracked in transit');
    });

    it('SCRUM310_AC6_the_organiser_single_read_names_the_kind_of_flag_and_not_the_staff_note', async () => {
      const event = await readForOrganiser({ equipment_reservations: [noted()] });

      expect(event.attentionReasons).toEqual(['Equipment unavailable']);
      expect(JSON.stringify(event)).not.toContain('Cracked in transit');
    });

    it('SCRUM310_AC6_an_organiser_sees_other_flags_by_kind_too_and_the_venue_reason_unchanged', async () => {
      const event = await listedForOrganiser({
        bookings: [booking('flagged_for_review')],
        equipment_reservations: [
          reservation({ flag_code: null, flag_reason: 'The event date or time changed' }),
          noted(),
        ],
      });

      expect(event.attentionReasons).toEqual([
        'Venue: a booking is flagged for review',
        'Equipment flagged for review',
        'Equipment unavailable',
      ]);
    });

    it('SCRUM310_AC6_two_flags_of_one_kind_show_the_organiser_one_line', async () => {
      const event = await listedForOrganiser({
        equipment_reservations: [noted(), reservation({ flag_reason: 'The equipment type was retired (End of life)' })],
      });

      expect(event.attentionReasons).toEqual(['Equipment unavailable']);
    });

    it('SCRUM310_AC6_the_coordinator_still_gets_the_reason_with_the_note', async () => {
      const event = await readOne({ status: STATUS.CONFIRMED, equipment_reservations: [noted()] });

      expect(event.attentionReasons).toEqual([`Equipment unavailable: ${NOTE}`]);
    });
  });

  it('SCRUM310_AC6_every_event_read_that_carries_needs_attention_embeds_the_reservation_flags', async () => {
    const flagged = heldRow({ status: STATUS.CONFIRMED, equipment_reservations: [reservation()] });
    const client = createQueueFakeClient([
      ok([flagged]),
      ok([flagged]),
      ok([profileRow(ORGANISER_ID, 'Aisha Rahman')]),
      ok([flagged]),
      ok([profileRow(COORDINATOR_ID, 'Wei Ling')]),
      ok(flagged),
      ok(flagged),
    ]);

    const results = [
      await listEventRequestsForReview({ client }),
      await listEventRequestsForCoordinator(COORDINATOR_ID, { client }),
      await listEventRequestsForOrganiser(ORGANISER_ID, { client }),
    ];
    const single = [
      await getEventRequestForCoordinator(REQUEST_ID, { client }),
      await getEventRequestForOrganiser(REQUEST_ID, ORGANISER_ID, { client }),
    ];

    expect(results.map(([event]) => event.needsAttention)).toEqual([true, true, true]);
    // The coordinator's read carries the reason; the organiser's carries the kind only.
    expect(single.map((event) => event.attentionReasons)).toEqual([[LOST], ['Equipment unavailable']]);
    const reads = client.calls.filter((call) => call.table === 'event_requests');
    expect(reads).toHaveLength(5);
    for (const call of reads) {
      expect(call.select).toContain('bookings(status)');
      expect(call.select).toContain('equipment_reservations(flagged, released_at, flag_reason, flag_code)');
    }
  });
});

describe('SCRUM-363: change-request approval through the significant-change path', () => {
  it.each([
    ['PT409', ConflictError],
    ['40001', ConflictError],
    ['22023', ValidationError],
  ])('SCRUM363_AC8_process_change_request_%s_reaches_the_caller_as_a_typed_error', async (code, Err) => {
    const client = { rpc: async () => dbError(code, 'expectedAttendance must be a positive whole number') };
    const err = await eventChangeRequestService
      .processChangeRequest(REQUEST_ID, { decision: 'approved' }, COORDINATOR_ID, { client })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Err);
    expect(err.message).toBe('expectedAttendance must be a positive whole number');
  });
});
