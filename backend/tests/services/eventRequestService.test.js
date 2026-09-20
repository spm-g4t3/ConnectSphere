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
      single: () => settle(call),
      maybeSingle: () => settle(call),
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
