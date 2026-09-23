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

import { describe, it, expect } from 'vitest';

import {
  createEventRequest,
  submitEventRequest,
  getEventRequestById,
  listEventRequestsForOrganiser,
  getEventRequestForOrganiser,
} from '../../src/services/eventRequestService.js';
import { ValidationError, NotFoundError, ConflictError } from '../../src/errors.js';
import { STATUS, canTransition } from '../../src/domain/eventRequestStatus.js';


// ---------------------------------------------------------------------------
// The fake client
// ---------------------------------------------------------------------------
/**
 * A hand-rolled stand-in for the supabase-js query builder.
 *
 * Hand-rolled rather than vi.mock for a reason worth saying out loud: the chain
 * this service uses is three calls deep and entirely predictable, and a reader
 * can see exactly what is recorded and exactly what is returned in the twenty
 * lines below. A mocking DSL would move that behaviour into framework
 * incantations that have to be explained before the test can be discussed, and
 * these tests have to be defensible in a closed-door examination.
 *
 * It records one entry per .from() so a test can assert what was sent, and
 * hands back queued { data, error } pairs in call order. Running out of queued
 * results throws loudly rather than returning undefined, so a service that
 * makes an unexpected extra round trip fails with a legible message instead of
 * a confusing null dereference somewhere downstream.
 */
function createFakeClient(results = []) {
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
      insert(payload) {
        call.operation = 'insert';
        call.payload = payload;
        return chain;
      },
      update(payload) {
        call.operation = 'update';
        call.payload = payload;
        return chain;
      },
      // On a read this names the columns; after insert/update it only asks for
      // the row back. Recorded either way, never treated as the operation.
      select(columns = '*') {
        call.select = columns;
        return chain;
      },
      eq(column, value) {
        call.filters.push([column, value]);
        return chain;
      },
      // SCRUM-42. Recorded in call order, because which column is sorted on
      // first is the whole of AC4's "most recently changed first".
      order(column, options) {
        call.order.push([column, options]);
        return chain;
      },
      single: () => settle(call),
      maybeSingle: () => settle(call),

      // SCRUM-42. A list query ends at .order() with no .single(), so the
      // builder itself is what gets awaited. Making the chain thenable is how
      // supabase-js behaves too, and it keeps the list path using the same
      // queue and the same recorded call as every other test here.
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
        order: [],
      };
      calls.push(call);
      return builder(call);
    },
  };
}

/** A successful Postgres response. */
const ok = (data) => ({ data, error: null });

/** A Postgres failure, shaped as supabase-js surfaces it. */
const dbError = (code, message) => ({ data: null, error: { code, message } });


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
    created_at: '2026-01-10T03:00:00+00:00',
    updated_at: '2026-01-10T03:00:00+00:00',
    submitted_at: null,
    ...overrides,
  };
}


/** Await a rejection and hand back the error, or null if it resolved. */
async function errorFrom(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
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
    const client = createFakeClient([ok(storedRow())]);

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
    const client = createFakeClient([ok(storedRow())]);

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
    const client = createFakeClient([ok(storedRow())]);

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
    const client = createFakeClient([ok(storedRow())]);

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
    const client = createFakeClient([ok(storedRow())]);

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
    const client = createFakeClient();

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
    const client = createFakeClient();

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
    const client = createFakeClient();

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
    const client = createFakeClient([
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
    const client = createFakeClient([
      dbError('23514', 'new row violates check constraint "event_requests_dates_ordered"'),
    ]);

    const err = await errorFrom(createEventRequest(DRAFT_INPUT, ORGANISER_ID, { client }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
  });

  it('SCRUM10_AC4_translates_a_unique_violation_into_a_conflict', async () => {
    const client = createFakeClient([
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
    const client = createFakeClient([dbError('08006', 'connection failure')]);

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
    const client = createFakeClient([ok(storedRow())]);

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
    const client = createFakeClient([ok(null)]);

    const err = await errorFrom(getEventRequestById(REQUEST_ID, { client }));

    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
  });
});


// ---------------------------------------------------------------------------
// Submitting for review
// ---------------------------------------------------------------------------
describe('AC5: a complete draft is submitted for review', () => {
  /** Read the draft, then write the submitted row. */
  const submitting = (row = storedRow()) =>
    createFakeClient([
      ok(row),
      ok({ ...row, status: STATUS.SUBMITTED, submitted_at: NOW.toISOString() }),
    ]);

  it('SCRUM10_AC5_reads_the_stored_record_before_writing', async () => {
    // The stored row is the subject, not whatever the client sent. A draft was
    // saved permissively and may have been edited since, so the only honest
    // answer to "is this ready?" comes from reading it back.
    const client = submitting();

    await submitEventRequest(REQUEST_ID, { client, now: NOW });

    expect(client.calls).toHaveLength(2);
    expect(client.calls[0].operation).toBe('select');
    expect(client.calls[0].filters).toContainEqual(['id', REQUEST_ID]);
    expect(client.calls[1].operation).toBe('update');
  });

  it('SCRUM10_AC5_writes_the_submitted_status', async () => {
    const client = submitting();

    await submitEventRequest(REQUEST_ID, { client, now: NOW });

    expect(client.calls[1].payload.status).toBe(STATUS.SUBMITTED);
  });

  it('SCRUM10_AC5_records_the_submission_time', async () => {
    // Separate from created_at, which is when the draft was first saved. A
    // draft may sit for days before it is sent, so review turnaround can only
    // be measured from this column. The instant is asserted rather than the
    // encoding, since 005 does not say whether the service sends an ISO string
    // or a Date.
    const client = submitting();

    await submitEventRequest(REQUEST_ID, { client, now: NOW });

    expect(instantOf(client.calls[1].payload.submitted_at)).toBe(NOW.getTime());
  });

  it('SCRUM10_AC5_guards_the_write_on_the_row_still_being_a_draft', async () => {
    // The read and the write are two round trips with no transaction between
    // them, so a second submit arriving in the gap would otherwise write
    // 'submitted' twice and move submitted_at. Filtering the update on the old
    // status makes the write itself the check: the second one matches no row.
    const client = submitting();

    await submitEventRequest(REQUEST_ID, { client, now: NOW });

    expect(client.calls[1].filters).toContainEqual(['id', REQUEST_ID]);
    expect(client.calls[1].filters).toContainEqual(['status', STATUS.DRAFT]);
  });

  it('SCRUM10_AC2_returns_the_updated_record_in_camelCase', async () => {
    const client = submitting();

    const record = await submitEventRequest(REQUEST_ID, { client, now: NOW });

    expect(record.status).toBe(STATUS.SUBMITTED);
    expect(instantOf(record.submittedAt)).toBe(NOW.getTime());
    expect(record).not.toHaveProperty('submitted_at');
  });
});


describe('AC4: an incomplete or ineligible request is not submitted', () => {
  it('SCRUM10_AC4_refuses_an_incomplete_draft_and_names_every_gap', async () => {
    // The whole reason submission re-validates instead of trusting the client.
    // A draft is saved permissively by design -- the enum starts at 'draft' and
    // SCRUM-11 depends on partial saves working -- so the row may legitimately
    // be incomplete, and the Coordinator must not be handed a request they
    // cannot act on. All four gaps are reported at once so the Organiser fixes
    // the form in one pass.
    const client = createFakeClient([
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

  it.each(
    Object.values(STATUS).filter((status) => !canTransition(status, STATUS.SUBMITTED)),
  )('SCRUM10_AC4_refuses_submission_from_%s', async (status) => {
    // Driven from canTransition rather than a list written out here, so the
    // rule lives in one place: eventRequestStatus.js already answers which
    // moves are legal, the Coordinator stories will reuse the same table, and a
    // local `status === 'draft'` check here would be a second copy to keep in
    // step. Deriving the cases means this test follows the rule if it changes.
    const client = createFakeClient([ok(storedRow({ status }))]);

    const err = await errorFrom(submitEventRequest(REQUEST_ID, { client, now: NOW }));

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(client.calls).toHaveLength(1);
  });

  it('SCRUM10_AC4_names_the_current_status_in_the_refusal', async () => {
    // "Cannot be submitted" leaves the Organiser guessing. Naming the status
    // they are actually in tells them whether to wait or to do something --
    // which is the distinction the status groups exist to make.
    const client = createFakeClient([ok(storedRow({ status: STATUS.APPROVED }))]);

    const err = await errorFrom(submitEventRequest(REQUEST_ID, { client, now: NOW }));

    expect(err.message).toMatch(/approved/i);
  });

  it('SCRUM10_AC4_raises_not_found_when_submitting_a_missing_record', async () => {
    const client = createFakeClient([ok(null)]);

    const err = await errorFrom(submitEventRequest(REQUEST_ID, { client, now: NOW }));

    expect(err).toBeInstanceOf(NotFoundError);
    expect(client.calls).toHaveLength(1);
  });
});


// ---------------------------------------------------------------------------
// Submitting once, and only once
// ---------------------------------------------------------------------------
describe('AC6: a draft is submitted once and only once', () => {
  it('SCRUM10_AC6_refuses_a_submit_whose_draft_guard_matched_no_row', async () => {
    // The concurrent-submit path, and the case that makes the guard meaningful
    // rather than decorative. Two callers submit the same draft -- a
    // double-clicked button, a retried request, two tabs. Both reads succeed and
    // both see a complete draft, because the read and the write are separate
    // round trips with no transaction spanning them. The first update moves the
    // row to 'submitted'; the second one's status = 'draft' filter then matches
    // nothing, and PostgREST answers .single() with PGRST116 because it was
    // asked for exactly one row and found none.
    //
    // Without the guard both writes would land: the second would overwrite
    // submitted_at with a later instant, so review turnaround would be measured
    // from the wrong moment, and any future status history would record the
    // transition twice. The guard turns the write itself into the check, which
    // is the only place it can be checked reliably -- a re-read before writing
    // would just move the same race one step earlier.
    //
    // ConflictError rather than a validation failure: the input was never the
    // problem. The request simply is not a draft any more, which is the same
    // reason an already-submitted request is refused by canTransition.
    const client = createFakeClient([
      ok(storedRow()),
      dbError('PGRST116', 'JSON object requested, multiple (or no) rows returned'),
    ]);

    const err = await errorFrom(submitEventRequest(REQUEST_ID, { client, now: NOW }));

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/no longer/i);
    expect(err.message).toMatch(/draft/i);

    // Both round trips happened, and the write did carry the guard -- otherwise
    // this test would be proving nothing about why the update matched no row.
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1].operation).toBe('update');
    expect(client.calls[1].filters).toContainEqual(['status', STATUS.DRAFT]);
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

    const client = createFakeClient([ok(storedRow())]);
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
    const client = createFakeClient([ok([storedRow()])]);

    await listEventRequestsForOrganiser(ORGANISER_ID, { client });

    const [call] = client.calls;
    expect(call.table).toBe('event_requests');
    expect(call.operation).toBe('select');

    // The filter is the entire access control on this endpoint: there is no id
    // in the path, so nothing else narrows the table.
    expect(call.filters).toEqual([['organiser_id', ORGANISER_ID]]);
  });

  it('SCRUM14_AC1_returns_an_empty_list_rather_than_an_error_when_there_are_none', async () => {
    const client = createFakeClient([ok([])]);

    // A new client who has not raised a request yet is an ordinary state, not
    // a 404. The distinction matters at the route: MyEventRequests renders an
    // empty list as "no requests yet" and a 404 as a failure.
    await expect(listEventRequestsForOrganiser(ORGANISER_ID, { client })).resolves.toEqual([]);
  });

  it('SCRUM14_AC1_survives_a_null_data_payload', async () => {
    // PostgREST can answer an empty result set with null rather than [].
    const client = createFakeClient([ok(null)]);

    await expect(listEventRequestsForOrganiser(ORGANISER_ID, { client })).resolves.toEqual([]);
  });

  it('SCRUM14_AC1_maps_every_row_into_camelCase', async () => {
    const client = createFakeClient([
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
    const client = createFakeClient([ok([storedRow()])]);

    const err = await errorFrom(listEventRequestsForOrganiser(undefined, { client }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err)).toEqual(['organiserId']);

    // The point of the assertion: a missing organiser must not reach the
    // database as an unfiltered read of the whole table.
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM14_AC1_translates_a_database_failure_rather_than_leaking_it', async () => {
    const client = createFakeClient([dbError('42P01', 'relation does not exist')]);

    const err = await errorFrom(listEventRequestsForOrganiser(ORGANISER_ID, { client }));

    // An unrecognised code stays untyped, so it cannot reach the API dressed as
    // a 400 telling an Organiser to correct a form they filled in correctly.
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err.status).toBeUndefined();
  });

  it('SCRUM14_AC1_returns_the_request_when_the_organiser_matches', async () => {
    const client = createFakeClient([ok(storedRow({ status: STATUS.UNDER_REVIEW }))]);

    const request = await getEventRequestForOrganiser(REQUEST_ID, ORGANISER_ID, { client });

    expect(request).toMatchObject({ id: REQUEST_ID, status: STATUS.UNDER_REVIEW });
  });

  it("SCRUM14_AC1_hides_another_organisers_request_behind_a_not_found", async () => {
    const client = createFakeClient([ok(storedRow({ organiser_id: OTHER_ORGANISER_ID }))]);

    const err = await errorFrom(getEventRequestForOrganiser(REQUEST_ID, ORGANISER_ID, { client }));

    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
  });

  it('SCRUM14_AC1_answers_a_foreign_request_exactly_as_it_answers_a_missing_one', async () => {
    const foreign = createFakeClient([ok(storedRow({ organiser_id: OTHER_ORGANISER_ID }))]);
    const missing = createFakeClient([ok(null)]);

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
    const client = createFakeClient([ok(storedRow())]);

    const err = await errorFrom(getEventRequestForOrganiser(REQUEST_ID, '', { client }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(client.calls).toHaveLength(0);
  });
});


describe('AC4: the most recently changed request is listed first', () => {
  it('SCRUM14_AC4_orders_by_updated_at_descending', async () => {
    const client = createFakeClient([ok([storedRow()])]);

    await listEventRequestsForOrganiser(ORGANISER_ID, { client });

    // updated_at is maintained by the event_requests_set_updated_at trigger
    // (001), so a status change moves the request to the top of the list. That
    // is AC4 expressed as an ordering rather than as a push.
    expect(client.calls[0].order[0]).toEqual(['updated_at', { ascending: false }]);
  });

  it('SCRUM14_AC4_breaks_ties_deterministically', async () => {
    const client = createFakeClient([ok([storedRow()])]);

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

    const client = createFakeClient([ok([storedRow()])]);
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
    const client = createFakeClient([
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
    const client = createFakeClient([ok(storedRow()), ok(storedRow())]);

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
    const client = createFakeClient([ok(storedRow()), ok(storedRow())]);

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
    const client = createFakeClient([ok(storedRow()), ok(storedRow())]);

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
    const client = createFakeClient([ok(storedRow()), ok(storedRow())]);

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
    const client = createFakeClient([ok(storedRow({ organiser_id: OTHER_ORGANISER_ID }))]);

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
    const foreign = createFakeClient([ok(storedRow({ organiser_id: OTHER_ORGANISER_ID }))]);
    const missing = createFakeClient([ok(null)]);

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
    const client = createFakeClient([ok(storedRow({ status: STATUS.UNDER_REVIEW }))]);

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

    const client = createFakeClient([ok(storedRow()), ok(storedRow())]);

    await expect(
      updateEventRequest(REQUEST_ID, { eventName: 'Renamed' }, ORGANISER_ID, { client }),
    ).resolves.toMatchObject({ id: REQUEST_ID });
  });

  it('SCRUM11_AC1_turns_a_guard_that_matched_no_row_into_a_conflict', async () => {
    const client = createFakeClient([
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
    const client = createFakeClient([ok(storedRow()), ok(storedRow())]);

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
    const client = createFakeClient([ok(storedRow()), ok(storedRow())]);

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
    const client = createFakeClient([ok(storedRow()), ok(storedRow())]);

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
    const client = createFakeClient([
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
    const client = createFakeClient([
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
    const client = createFakeClient([ok(null)]);

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
