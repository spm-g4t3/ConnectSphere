/**
 * SCRUM-486 (SCRUM-519): the service half of the Event Coordinator Lead's
 * unassigned queue and assignment picker.
 *
 *   listUnassignedEventRequests  AC2-01, AC2-02  the queue
 *   listCoordinatorWorkload      AC3-06          the picker's list
 *   assignEventRequest           AC3-04, AC4-03  the assignment, and a lost race
 *   requestEventClarification    AC8             the wrong-reason fault 041 left
 *   listEventRequestsForReview   AC2-06          the shared queue leaves the unassigned out (SCRUM-520)
 *   getEventClarificationHistory AC6             the Lead reads it, so the event screen loads (SCRUM-521)
 *
 * A file of its own rather than more blocks in eventRequestService.test.js,
 * because neither fake there can answer these reads: createFakeClient has no
 * .in(), createQueueFakeClient has no .is() and no .rpc(). The SCRUM-45 block
 * met the same gap by writing its own fake rather than changing a shared one,
 * and this does the same, so no other story's helper moves.
 *
 * What the database itself does (who may assign, the race, the history row,
 * the notices) is proved against real Postgres in
 * tests/db/eventStatusLifecycleDatabase.test.js. These pin what this layer
 * adds: which rows it asks for, in what order, and what it turns refusals into.
 */

import { describe, it, expect } from 'vitest';

import {
  listUnassignedEventRequests,
  listCoordinatorWorkload,
  assignEventRequest,
  requestEventClarification,
  listEventRequestsForReview,
  getEventClarificationHistory,
  listAssignmentHistory,
  startEventReview,
  decideEventRequest,
} from '../../src/services/eventRequestService.js';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} from '../../src/errors.js';
import { STATUS, COORDINATOR_QUEUE_STATUSES } from '../../src/domain/eventRequestStatus.js';
import { listBookingRequestsForCoordinator } from '../../src/services/bookingRequestService.js';


// ---------------------------------------------------------------------------
// The fake client
// ---------------------------------------------------------------------------
/**
 * Records one entry per .from() or .rpc(), each filter kind in its own list so
 * a test can say "an IS NULL on the coordinator and no other eq", and hands
 * back queued { data, error } pairs in call order. Running out throws, so an
 * unexpected extra round trip fails by name.
 */
function createFakeClient(results = []) {
  const queue = [...results];
  const calls = [];

  function settle(call) {
    if (queue.length === 0) {
      throw new Error(`fake client: no result queued for ${call.operation} on ${call.table ?? call.fn}`);
    }
    return Promise.resolve(queue.shift());
  }

  function record(fields) {
    const call = { table: null, fn: null, args: null, select: null, filters: [], inFilters: [], isFilters: [], order: [], ...fields };
    calls.push(call);
    return call;
  }

  return {
    calls,
    from(table) {
      const call = record({ table, operation: 'select' });
      const chain = {
        select(columns = '*') { call.select = columns; return chain; },
        eq(column, value) { call.filters.push([column, value]); return chain; },
        in(column, values) { call.inFilters.push([column, [...values]]); return chain; },
        is(column, value) { call.isFilters.push([column, value]); return chain; },
        order(column, options) { call.order.push([column, options]); return chain; },
        single: () => settle(call),
        maybeSingle: () => settle(call),
        then: (resolve, reject) => settle(call).then(resolve, reject),
      };
      return chain;
    },
    rpc(fn, args) {
      return settle(record({ operation: 'rpc', fn, args }));
    },
  };
}

const ok = (data) => ({ data, error: null });
const dbError = (code, message) => ({ data: null, error: { code, message } });

async function errorFrom(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

/** What each call was, in order: 'event_requests', 'profiles', or 'rpc:<fn>'. */
const trail = (client) => client.calls.map((call) => (call.operation === 'rpc' ? `rpc:${call.fn}` : call.table));


// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const ORGANISER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORGANISER_ID = '33333333-3333-4333-8333-333333333333';
const LEAD_ID = '55555555-5555-4555-8555-555555555555';
const COORDINATOR_A = '44444444-4444-4444-8444-444444444444';
const COORDINATOR_B = '66666666-6666-4666-8666-666666666666';

/** A submitted request with no coordinator, as Postgres returns it. */
function unassignedRow(overrides = {}) {
  return {
    id: REQUEST_ID,
    organiser_id: ORGANISER_ID,
    event_name: 'IS212 Industry Night',
    purpose: 'Connect final-year students with industry partners.',
    description: null,
    proposed_start: '2026-11-01T09:00:00+00:00',
    proposed_end: '2026-11-01T17:00:00+00:00',
    expected_attendance: 120,
    venue_requirements: null,
    accessibility_requirements: null,
    equipment_requirements: null,
    status: STATUS.SUBMITTED,
    clarification_note: null,
    assigned_coordinator_id: null,
    reviewing_coordinator_id: null,
    created_at: '2026-10-01T03:00:00+00:00',
    updated_at: '2026-10-08T03:00:00+00:00',
    submitted_at: '2026-10-08T03:00:00+00:00',
    ...overrides,
  };
}

const profileRow = (id, fullName) => ({ id, full_name: fullName });


// ---------------------------------------------------------------------------
// AC2: the unassigned queue
// ---------------------------------------------------------------------------
describe('SCRUM-486 AC2: the Lead\'s unassigned queue', () => {
  it('SCRUM486_AC2_reads_submitted_requests_with_no_coordinator_oldest_first', async () => {
    // AC2-01. status = submitted AND assigned_coordinator_id IS NULL. The
    // status filter is what keeps drafts out: a draft is not waiting for
    // anyone, with or without a stale coordinator left on it by 022's reopen.
    // Oldest submission first, because the Lead's question is what has waited
    // longest; id breaks a tie so a refetch never reshuffles.
    const client = createFakeClient([ok([unassignedRow()]), ok([profileRow(ORGANISER_ID, 'Aisha Rahman')])]);

    await listUnassignedEventRequests({ client });

    const [queue] = client.calls;
    expect(queue.table).toBe('event_requests');
    expect(queue.filters).toEqual([['status', STATUS.SUBMITTED]]);
    expect(queue.isFilters).toEqual([['assigned_coordinator_id', null]]);
    expect(queue.inFilters).toEqual([]);
    expect(queue.order).toEqual([
      ['submitted_at', { ascending: true, nullsFirst: false }],
      ['id', { ascending: true }],
    ]);
  });

  it('SCRUM486_AC2_each_row_carries_name_organiser_period_attendance_and_when_it_was_submitted', async () => {
    // AC2-02. "How long it has waited" is submittedAt, shown by the screen
    // against its own clock: a duration computed here would be stale by the
    // time it was read.
    const client = createFakeClient([
      ok([
        unassignedRow(),
        unassignedRow({ id: 'second', organiser_id: OTHER_ORGANISER_ID, submitted_at: '2026-10-10T03:00:00+00:00' }),
        unassignedRow({ id: 'third', submitted_at: '2026-10-11T03:00:00+00:00' }),
      ]),
      ok([profileRow(ORGANISER_ID, 'Aisha Rahman'), profileRow(OTHER_ORGANISER_ID, 'Ben Lim')]),
    ]);

    const rows = await listUnassignedEventRequests({ client });

    expect(rows.map((row) => row.id)).toEqual([REQUEST_ID, 'second', 'third']);
    expect(rows[0]).toMatchObject({
      eventName: 'IS212 Industry Night',
      organiserId: ORGANISER_ID,
      organiserName: 'Aisha Rahman',
      proposedStart: '2026-11-01T09:00:00+00:00',
      proposedEnd: '2026-11-01T17:00:00+00:00',
      expectedAttendance: 120,
      submittedAt: '2026-10-08T03:00:00+00:00',
      assignedCoordinatorId: null,
    });
    expect(rows[1].organiserName).toBe('Ben Lim');

    // The second read: profiles, by id, each organiser once.
    const [, names] = client.calls;
    expect(names.table).toBe('profiles');
    expect(names.inFilters).toHaveLength(1);
    expect(names.inFilters[0][0]).toBe('id');
    expect([...names.inFilters[0][1]].sort()).toEqual([ORGANISER_ID, OTHER_ORGANISER_ID].sort());
  });

  it('SCRUM486_AC2_an_empty_queue_is_an_empty_array_and_one_read', async () => {
    // AC2-08's service half: nothing waiting is not an error, and there are no
    // organisers to name, so the second read is skipped. null is how
    // PostgREST can send an empty result.
    for (const data of [[], null]) {
      const client = createFakeClient([ok(data)]);
      await expect(listUnassignedEventRequests({ client })).resolves.toEqual([]);
      expect(trail(client)).toEqual(['event_requests']);
    }
  });

  it('SCRUM486_AC2_an_organiser_with_no_name_is_listed_with_null', async () => {
    const client = createFakeClient([ok([unassignedRow()]), ok([profileRow(ORGANISER_ID, null)])]);

    const [row] = await listUnassignedEventRequests({ client });

    expect(row.organiserName).toBeNull();
  });

  it.each([
    ['the queue read', [dbError('42P01', 'relation "event_requests" does not exist')]],
    ['the names read', [ok([unassignedRow()]), dbError('42P01', 'relation "profiles" does not exist')]],
  ])('SCRUM486_AC2_a_failure_in_%s_is_left_untyped', async (_label, results) => {
    // A 500, not a 400 or a 404 the Lead could act on.
    const err = await errorFrom(listUnassignedEventRequests({ client: createFakeClient(results) }));

    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// AC3: the picker's coordinators and their workload
// ---------------------------------------------------------------------------
describe('SCRUM-486 AC3: every Event Coordinator, with their active events', () => {
  const ACTIVE = [STATUS.SUBMITTED, STATUS.UNDER_REVIEW, STATUS.PENDING_CLARIFICATION, STATUS.APPROVED, STATUS.CONFIRMED];

  it('SCRUM486_AC3_lists_every_event_coordinator_with_their_active_count', async () => {
    // AC3-06: A holds two active events, B none. B is listed with 0, not left
    // out: a coordinator with nothing is the one most able to take more.
    const client = createFakeClient([
      ok([profileRow(COORDINATOR_A, 'Omar Okafor'), profileRow(COORDINATOR_B, 'Priya Nair')]),
      ok([{ assigned_coordinator_id: COORDINATOR_A }, { assigned_coordinator_id: COORDINATOR_A }]),
    ]);

    const coordinators = await listCoordinatorWorkload({ client });

    // toEqual, so an extra key fails: no role, no "recommended".
    expect(coordinators).toEqual([
      { id: COORDINATOR_A, fullName: 'Omar Okafor', activeEvents: 2 },
      { id: COORDINATOR_B, fullName: 'Priya Nair', activeEvents: 0 },
    ]);
  });

  it('SCRUM486_AC3_only_the_event_coordinator_role_is_read_so_no_lead_is_listed', async () => {
    // One role per account (007), so an exact match on event_coordinator
    // leaves every Lead out: the Lead cannot be assigned events.
    const client = createFakeClient([ok([profileRow(COORDINATOR_A, 'Omar Okafor')]), ok([])]);

    await listCoordinatorWorkload({ client });

    const [people] = client.calls;
    expect(people.table).toBe('profiles');
    expect(people.filters).toEqual([['role', 'event_coordinator']]);
    expect(people.inFilters).toEqual([]);
    expect(people.select.split(',').map((c) => c.trim()).sort()).toEqual(['full_name', 'id']);
  });

  it('SCRUM486_AC3_ordered_by_name_never_by_workload', async () => {
    // AC3: the system suggests nobody. The read orders by name then id, and
    // the service keeps that order. Omar has three events and Priya none, so
    // a list sorted by workload would put Priya first; she stays second.
    const client = createFakeClient([
      ok([profileRow(COORDINATOR_A, 'Omar Okafor'), profileRow(COORDINATOR_B, 'Priya Nair')]),
      ok([{ assigned_coordinator_id: COORDINATOR_A }, { assigned_coordinator_id: COORDINATOR_A }, { assigned_coordinator_id: COORDINATOR_A }]),
    ]);

    const coordinators = await listCoordinatorWorkload({ client });

    expect(client.calls[0].order).toEqual([
      ['full_name', { ascending: true, nullsFirst: false }],
      ['id', { ascending: true }],
    ]);
    expect(coordinators.map((c) => c.fullName)).toEqual(['Omar Okafor', 'Priya Nair']);
    expect(coordinators.map((c) => c.activeEvents)).toEqual([3, 0]);
  });

  it('SCRUM486_AC3_counts_only_the_active_statuses_of_the_coordinators_listed', async () => {
    // Open question 3, answered once in the service: submitted (assigned, not
    // yet reviewed) through confirmed. Not draft, completed, rejected or
    // cancelled. The count is narrowed to the coordinators just read.
    const client = createFakeClient([
      ok([profileRow(COORDINATOR_A, 'Omar Okafor'), profileRow(COORDINATOR_B, 'Priya Nair')]),
      ok([]),
    ]);

    await listCoordinatorWorkload({ client });

    const [, events] = client.calls;
    expect(events.table).toBe('event_requests');
    expect(events.select).toBe('assigned_coordinator_id');
    expect(events.inFilters).toEqual([
      ['assigned_coordinator_id', [COORDINATOR_A, COORDINATOR_B]],
      ['status', ACTIVE],
    ]);
    for (const finished of [STATUS.DRAFT, STATUS.COMPLETED, STATUS.REJECTED, STATUS.CANCELLED]) {
      expect(events.inFilters[1][1]).not.toContain(finished);
    }
  });

  it('SCRUM486_AC3_no_coordinators_is_an_empty_array_and_no_count', async () => {
    // The picker says nobody can be assigned; that is its message, not a
    // failure here. Nothing to count, so the second read is skipped.
    for (const data of [[], null]) {
      const client = createFakeClient([ok(data)]);
      await expect(listCoordinatorWorkload({ client })).resolves.toEqual([]);
      expect(trail(client)).toEqual(['profiles']);
    }
  });

  it('SCRUM486_AC3_a_coordinator_with_no_name_keeps_their_count', async () => {
    const client = createFakeClient([
      ok([profileRow(COORDINATOR_A, null)]),
      ok([{ assigned_coordinator_id: COORDINATOR_A }]),
    ]);

    await expect(listCoordinatorWorkload({ client })).resolves.toEqual([
      { id: COORDINATOR_A, fullName: null, activeEvents: 1 },
    ]);
  });

  it.each([
    ['the coordinators read', [dbError('42P01', 'relation "profiles" does not exist')]],
    ['the count read', [ok([profileRow(COORDINATOR_A, 'Omar Okafor')]), dbError('42P01', 'relation "event_requests" does not exist')]],
  ])('SCRUM486_AC3_a_failure_in_%s_is_left_untyped', async (_label, results) => {
    const err = await errorFrom(listCoordinatorWorkload({ client: createFakeClient(results) }));

    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// AC3, AC4: the assignment
// ---------------------------------------------------------------------------
describe('SCRUM-486 AC3, AC4: the Lead assigns a request', () => {
  const assign = (client, input = { coordinatorId: COORDINATOR_A, note: 'Over to you' }) =>
    assignEventRequest(REQUEST_ID, input, LEAD_ID, { client });

  it('SCRUM486_AC3_an_assignment_is_one_rpc_with_the_caller_and_the_note', async () => {
    // AC3-04. The caller is the third argument, which the route takes from
    // the token, never from the body.
    const client = createFakeClient([ok(unassignedRow({ assigned_coordinator_id: COORDINATOR_A }))]);

    const result = await assign(client);

    expect(trail(client)).toEqual(['rpc:assign_event_request']);
    expect(client.calls[0].args).toEqual({
      p_event_request_id: REQUEST_ID,
      p_coordinator_id: COORDINATOR_A,
      p_assigned_by: LEAD_ID,
      p_note: 'Over to you',
    });
    expect(result).toMatchObject({ id: REQUEST_ID, status: STATUS.SUBMITTED, assignedCoordinatorId: COORDINATOR_A });
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['not a string', 42],
  ])('SCRUM486_AC3_a_note_that_is_%s_is_sent_as_null', async (_label, note) => {
    // The note is optional (AC3). 041 also stores nullif(btrim(note), ''),
    // so this is belt to its braces; sending null says "no note" plainly.
    const client = createFakeClient([ok(unassignedRow({ assigned_coordinator_id: COORDINATOR_A }))]);

    await assign(client, { coordinatorId: COORDINATOR_A, note });

    expect(client.calls[0].args.p_note).toBeNull();
  });

  it.each([
    ['missing', undefined, 'is required'],
    ['blank', '   ', 'is required'],
    ['not an id', 'Priya', 'must be the id of an Event Coordinator'],
    ['not a string', 42, 'is required'],
  ])('SCRUM486_AC3_a_coordinator_id_that_is_%s_is_refused_before_any_call', async (_label, coordinatorId, message) => {
    // A 400 naming the field, and nothing sent: a malformed id reaching the
    // function would come back as 22P02, an untyped 500.
    const client = createFakeClient([]);

    const err = await errorFrom(assign(client, { coordinatorId }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'coordinatorId', message }]);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM486_AC4_a_lost_race_is_a_409_that_names_who_holds_it', async () => {
    // AC4-03. 041 refuses with "event request <id> is already assigned to
    // <name>". The service reads who holds it now and returns them as data,
    // so the screen can say "already assigned to Priya Nair" (AC4-04)
    // without parsing server text. The message carries the name and not the
    // request's id, which would mean nothing to the Lead.
    const client = createFakeClient([
      dbError('55000', `event request ${REQUEST_ID} is already assigned to Priya Nair`),
      ok({ assigned_coordinator_id: COORDINATOR_B }),
      ok([profileRow(COORDINATOR_B, 'Priya Nair')]),
    ]);

    const err = await errorFrom(assign(client));

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('ALREADY_ASSIGNED');
    expect(err.conflicts).toEqual([{ assignedCoordinatorId: COORDINATOR_B, assignedCoordinatorName: 'Priya Nair' }]);
    expect(err.message).toBe('This request has already been assigned to Priya Nair.');
    expect(err.message).not.toContain(REQUEST_ID);

    // The holder is read by the request's id, and named from profiles.
    expect(trail(client)).toEqual(['rpc:assign_event_request', 'event_requests', 'profiles']);
    expect(client.calls[1].filters).toEqual([['id', REQUEST_ID]]);
  });

  it('SCRUM486_AC4_a_holder_with_no_name_is_still_reported_as_already_assigned', async () => {
    const client = createFakeClient([
      dbError('55000', 'already assigned'),
      ok({ assigned_coordinator_id: COORDINATOR_B }),
      ok([profileRow(COORDINATOR_B, null)]),
    ]);

    const err = await errorFrom(assign(client));

    expect(err.code).toBe('ALREADY_ASSIGNED');
    expect(err.conflicts).toEqual([{ assignedCoordinatorId: COORDINATOR_B, assignedCoordinatorName: null }]);
    expect(err.message).toBe('This request has already been assigned to another coordinator.');
  });

  it.each([
    ['nobody holds it (it was cancelled)', ok({ assigned_coordinator_id: null })],
    ['it is gone', ok(null)],
    ['the holder cannot be read', dbError('42P01', 'relation "event_requests" does not exist')],
  ])('SCRUM486_AC4_a_409_when_%s_passes_through_as_the_function_said', async (_label, holderRead) => {
    // A request that is no longer submitted is a conflict too, but not a lost
    // race, and saying "already assigned" would be false. With no holder to
    // name, the function's own 409 is what the caller gets.
    const refusal = `event request ${REQUEST_ID} has status cancelled, not submitted`;
    const client = createFakeClient([dbError('55000', refusal), holderRead]);

    const err = await errorFrom(assign(client));

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBeNull();
    expect(err.message).toBe(refusal);
    expect(trail(client)).toEqual(['rpc:assign_event_request', 'event_requests']);
  });

  it.each([
    ['42501', 'only the Event Coordinator Lead can assign event request', ForbiddenError, 403],
    ['22023', 'is not an Event Coordinator', ValidationError, 400],
    ['P0002', 'event request not found', NotFoundError, 404],
  ])('SCRUM486_AC3_the_functions_%s_refusal_is_typed_and_nothing_more_is_read', async (code, message, Type, status) => {
    // Only a 409 can be a lost race, so only a 409 reads the holder.
    const client = createFakeClient([dbError(code, message)]);

    const err = await errorFrom(assign(client));

    expect(err).toBeInstanceOf(Type);
    expect(err.status).toBe(status);
    expect(trail(client)).toEqual(['rpc:assign_event_request']);
  });
});


// ---------------------------------------------------------------------------
// AC2-06: the coordinators' shared queue leaves unassigned requests out
// ---------------------------------------------------------------------------
/**
 * A fake that applies the filters it is given to a table of rows, instead of
 * only recording them. The recording fakes can show which filter was sent;
 * this shows what that filter does to a mix of rows: which come back, which
 * do not. It understands exactly the four filters the read uses, and throws
 * on anything else so a new one cannot be silently ignored.
 */
function createTableFakeClient(rows) {
  return {
    from() {
      const keep = [];
      const chain = {
        select() { return chain; },
        eq(column, value) { keep.push((row) => row[column] === value); return chain; },
        in(column, values) { keep.push((row) => values.includes(row[column])); return chain; },
        is(column, value) { keep.push((row) => (row[column] ?? null) === value); return chain; },
        not(column, operator, value) {
          if (operator !== 'is' || value !== null) throw new Error(`fake: unsupported not(${operator}, ${value})`);
          keep.push((row) => (row[column] ?? null) !== null);
          return chain;
        },
        order() { return chain; },
        then: (resolve, reject) =>
          Promise.resolve({ data: rows.filter((row) => keep.every((test) => test(row))), error: null }).then(resolve, reject),
      };
      return chain;
    },
  };
}

describe('SCRUM-486 AC2-06: the shared review queue lists only requests someone holds', () => {
  const held = (id, status) => unassignedRow({ id, status, assigned_coordinator_id: COORDINATOR_A });

  // Every status the queue listed before SCRUM-520, each held by a coordinator;
  // one submitted request held by nobody; and two the status filter always
  // kept out, so the new filter is seen working beside the old one.
  const TABLE = [
    unassignedRow({ id: 'unassigned-submitted' }),
    held('held-submitted', STATUS.SUBMITTED),
    held('held-under-review', STATUS.UNDER_REVIEW),
    held('held-pending-clarification', STATUS.PENDING_CLARIFICATION),
    held('held-approved', STATUS.APPROVED),
    unassignedRow({ id: 'draft', status: STATUS.DRAFT }),
    // AC2-03's other draft: one that keeps a coordinator from before it was
    // reopened (022's reopen leaves the coordinator on the row). Neither queue
    // may list it: it is the Organiser's again.
    unassignedRow({ id: 'draft-stale-coordinator', status: STATUS.DRAFT, assigned_coordinator_id: COORDINATOR_A }),
  ];

  it('SCRUM486_AC2_the_review_queue_leaves_out_a_submitted_request_nobody_holds', async () => {
    const queue = await listEventRequestsForReview({ client: createTableFakeClient(TABLE) });

    expect(queue.map((request) => request.id)).not.toContain('unassigned-submitted');
    for (const request of queue) expect(request.assignedCoordinatorId).not.toBeNull();
  });

  it('SCRUM486_AC2_the_review_queue_still_lists_a_held_request_in_every_status_it_listed_before', async () => {
    // Submitted, under review, pending clarification: COORDINATOR_QUEUE_STATUSES,
    // unchanged. Approved and draft stay out, as they always did.
    const queue = await listEventRequestsForReview({ client: createTableFakeClient(TABLE) });

    expect(queue.map((request) => request.id).sort()).toEqual(
      ['held-pending-clarification', 'held-submitted', 'held-under-review'],
    );
    expect(queue.map((request) => request.status).sort()).toEqual([...COORDINATOR_QUEUE_STATUSES].sort());
  });

  it('SCRUM486_AC2_the_unassigned_request_is_the_leads_and_appears_in_the_leads_queue', async () => {
    // The other half of the same rule: what leaves the shared queue is not
    // lost. It is in the Lead's queue, and only there.
    const client = createTableFakeClient(TABLE);
    const leadsQueue = await listUnassignedEventRequests({
      client: {
        from: (table) => (table === 'profiles'
          ? { select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) }
          : client.from(table)),
      },
    });

    expect(leadsQueue.map((request) => request.id)).toEqual(['unassigned-submitted']);
  });

  it('SCRUM486_AC2_neither_queue_lists_a_draft_even_one_with_a_stale_coordinator', async () => {
    // AC2-03. The Lead's queue reads status = submitted and the coordinators'
    // the three review statuses, so a draft is out of both, whatever its
    // coordinator column says. Run against the same table as above, through
    // the real queries.
    const shared = await listEventRequestsForReview({ client: createTableFakeClient(TABLE) });
    const client = createTableFakeClient(TABLE);
    const leads = await listUnassignedEventRequests({
      client: {
        from: (table) => (table === 'profiles'
          ? { select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) }
          : client.from(table)),
      },
    });

    for (const id of ['draft', 'draft-stale-coordinator']) {
      expect(shared.map((request) => request.id)).not.toContain(id);
      expect(leads.map((request) => request.id)).not.toContain(id);
    }
  });
});


// ---------------------------------------------------------------------------
// AC8: clarification on a request nobody holds
// ---------------------------------------------------------------------------
describe('SCRUM-486 AC8: an unassigned request is waiting for the Lead, not someone else\'s', () => {
  // One queued result, the coordinator read: both refusals come before any write.
  const ask = (row, caller = COORDINATOR_A) =>
    requestEventClarification(REQUEST_ID, 'Please confirm the audience.', caller, { client: createFakeClient([ok(row)]) });

  it('SCRUM486_AC8_asking_for_clarification_on_an_unassigned_request_names_the_lead', async () => {
    // The fault 041 fixed in start_event_review, here in the service. Before
    // SCRUM-519 the caller check came first and answered 403 "Only the
    // coordinator assigned to event request ... can request clarification on
    // it" about a request that has no coordinator, telling A it is someone
    // else's. Now a 409 saying what it is waiting for, and nothing written.
    const err = await errorFrom(ask(unassignedRow()));

    expect(err).toBeInstanceOf(ConflictError);
    expect(err).not.toBeInstanceOf(ForbiddenError);
    expect(err.message).toMatch(/waiting for the Event Coordinator Lead to assign it a coordinator/);
    expect(err.message).not.toMatch(/Only the coordinator assigned/);
  });

  it('SCRUM486_AC8_the_check_is_narrow_a_submitted_request_held_by_another_is_still_a_403', async () => {
    // The new check fires only when nobody holds the request. Someone else's
    // request is still refused as someone else's.
    const err = await errorFrom(ask(unassignedRow({ assigned_coordinator_id: COORDINATOR_B })));

    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toMatch(/Only the coordinator assigned/);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-521: the clarification history, one of the event screen's mount reads
// ---------------------------------------------------------------------------
describe("SCRUM-486 AC6: the Lead reads an event's clarification history", () => {
  // Its route has no role gate; this check is the gate. Before SCRUM-521 it
  // admitted the Organiser and event_coordinator only, so the Lead got a 404
  // and that section of the screen they hand an event over from failed.
  const ENTRY = {
    id: 'c1',
    entry_type: 'question',
    message: 'How many will attend?',
    created_by: COORDINATOR_A,
    reply_by_date: null,
    requested_fields: [],
    created_at: '2026-10-09T03:00:00+00:00',
  };
  const read = (role, status = STATUS.UNDER_REVIEW) => getEventClarificationHistory(
    REQUEST_ID,
    LEAD_ID,
    role,
    {
      client: createFakeClient([
        ok(unassignedRow({ status, assigned_coordinator_id: COORDINATOR_A })),
        ok([ENTRY]),
        ok([profileRow(COORDINATOR_A, 'Priya Nair')]),
      ]),
    },
  );

  it('SCRUM486_AC6_a_lead_who_did_not_write_it_reads_it', async () => {
    await expect(read('event_coordinator_lead')).resolves.toEqual([
      expect.objectContaining({ id: 'c1', message: 'How many will attend?', authorName: 'Priya Nair' }),
    ]);
  });

  it('SCRUM486_AC6_a_coordinator_still_reads_it', async () => {
    await expect(read('event_coordinator')).resolves.toHaveLength(1);
  });

  it.each([
    ['a safety officer', 'safety_officer', STATUS.UNDER_REVIEW],
    ['venue staff', 'venue_staff', STATUS.UNDER_REVIEW],
    ['a lead, on a draft', 'event_coordinator_lead', STATUS.DRAFT],
  ])('SCRUM486_AC6_%s_who_did_not_organise_it_gets_not_found', async (_label, role, status) => {
    // Widened by one role, and not to drafts: a draft is the Organiser's
    // private copy, as it is for a coordinator.
    const err = await errorFrom(read(role, status));

    expect(err).toBeInstanceOf(NotFoundError);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-522: AC9-03, the history label across the old rows and the new
// ---------------------------------------------------------------------------
describe('SCRUM-486 AC9: an old automatic row and a Lead\'s row, in one history', () => {
  it('SCRUM486_AC9_an_old_row_reads_automatic_and_a_leads_row_names_the_lead', async () => {
    // AC9-03. Events assigned before SCRUM-486 have a history row with
    // assigned_by null, written by 016 on submission; the Lead's rows name the
    // Lead. The live data now holds both, often on the same event: assigned
    // automatically in September, handed on by a Lead in October. `automatic`
    // is derived from assigned_by alone, so the old row must still read true
    // and the Lead's false, with the Lead's name.
    const rows = [
      {
        id: 'h1', previous_coordinator_id: null, new_coordinator_id: COORDINATOR_A,
        assigned_by: null, handover_note: null, created_at: '2026-09-20T03:00:00+00:00',
      },
      {
        id: 'h2', previous_coordinator_id: COORDINATOR_A, new_coordinator_id: COORDINATOR_B,
        assigned_by: LEAD_ID, handover_note: 'Priya is on leave.', created_at: '2026-10-11T03:00:00+00:00',
      },
    ];
    const client = createFakeClient([
      ok(rows),
      ok([profileRow(COORDINATOR_A, 'Priya Nair'), profileRow(COORDINATOR_B, 'Omar Okafor'), profileRow(LEAD_ID, 'Lena Lead')]),
    ]);

    const history = await listAssignmentHistory(REQUEST_ID, { includeNotes: true }, { client });

    expect(history[0]).toMatchObject({ automatic: true, assignedById: null, assignedByName: null, newCoordinatorName: 'Priya Nair' });
    expect(history[1]).toMatchObject({
      automatic: false,
      assignedById: LEAD_ID,
      assignedByName: 'Lena Lead',
      previousCoordinatorName: 'Priya Nair',
      newCoordinatorName: 'Omar Okafor',
      handoverNote: 'Priya is on leave.',
    });
  });

  it('SCRUM486_AC9_a_lead_with_no_name_is_still_not_automatic', async () => {
    // The reason `automatic` exists (SCRUM-334): a null name is also what a
    // person with no full_name has, and the two must not read the same.
    const client = createFakeClient([
      ok([{
        id: 'h1', previous_coordinator_id: null, new_coordinator_id: COORDINATOR_A,
        assigned_by: LEAD_ID, handover_note: null, created_at: '2026-10-11T03:00:00+00:00',
      }]),
      ok([profileRow(COORDINATOR_A, 'Priya Nair'), profileRow(LEAD_ID, null)]),
    ]);

    const [entry] = await listAssignmentHistory(REQUEST_ID, {}, { client });

    expect(entry).toMatchObject({ automatic: false, assignedById: LEAD_ID, assignedByName: null });
  });
});


// ---------------------------------------------------------------------------
// SCRUM-522: AC7-06, a flagged booking follows its event to the new coordinator
// ---------------------------------------------------------------------------
describe('SCRUM-486 AC7: a booking flagged before the Lead moved its event is the new coordinator\'s', () => {
  // Two flagged bookings, both requested by A. The Lead then moved the first
  // event to B. Nothing in a booking names who holds its event; the list reads
  // the event's current coordinator, so the booking follows the event. This
  // fake answers rows the way the embedded read would after the move, and
  // records the filter, so both the query and the service's own narrowing are
  // seen.
  const booking = (id, holder) => ({
    id,
    event_request_id: `event-${id}`,
    venue_id: 'v1',
    starts_at: '2026-11-01T01:00:00+00:00',
    ends_at: '2026-11-01T09:00:00+00:00',
    status: 'pending',
    room_layout_code: null,
    setup_notes: null,
    suitability_overridden: false,
    created_at: '2026-10-06T10:00:00+00:00',
    flagged_at: '2026-10-07T10:00:00+00:00',
    review_reason: null,
    venues: { name: 'Harbour Room', location: 'Block A' },
    event_requests: { event_name: `Event ${id}`, status: 'approved', assigned_coordinator_id: holder },
  });
  const ROWS = [booking('moved', COORDINATOR_B), booking('kept', COORDINATOR_A)];

  function bookingsClient() {
    const filters = [];
    const chain = {
      select: () => chain,
      eq: (column, value) => { filters.push([column, value]); return chain; },
      order: () => chain,
      then: (resolve, reject) => Promise.resolve({
        data: ROWS.filter((row) => filters.every(([column, value]) =>
          column === 'event_requests.assigned_coordinator_id' && row.event_requests.assigned_coordinator_id === value)),
        error: null,
      }).then(resolve, reject),
    };
    return { filters, from: () => chain };
  }

  it('SCRUM486_AC7_the_new_coordinator_lists_the_booking_and_the_previous_one_does_not', async () => {
    const asB = bookingsClient();
    const asA = bookingsClient();

    const forB = await listBookingRequestsForCoordinator(COORDINATOR_B, { client: asB });
    const forA = await listBookingRequestsForCoordinator(COORDINATOR_A, { client: asA });

    expect(forB.map((item) => item.id)).toEqual(['moved']);
    expect(forA.map((item) => item.id)).toEqual(['kept']);
    // The filter is the event's current holder, never who made the request.
    expect(asB.filters).toEqual([['event_requests.assigned_coordinator_id', COORDINATOR_B]]);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-522: AC8-03, 041's "waiting for the Lead" refusal reaches the caller
// ---------------------------------------------------------------------------
describe('SCRUM-486 AC8: the review of a request waiting for the Lead is refused in its own words', () => {
  // 041 refuses start_event_review and decide_event_request on a submitted
  // request with no coordinator, with 55000 and a message naming the Lead,
  // before the caller check. The service must pass that message through as a
  // 409, not dress it as "not yours" (403). The texts are 041's exactly.
  it.each([
    [
      'starting the review',
      (client) => startEventReview(REQUEST_ID, COORDINATOR_A, { client }),
      `event request ${REQUEST_ID} is waiting for the Event Coordinator Lead to assign it a coordinator, so its review cannot start yet`,
    ],
    [
      'deciding it',
      (client) => decideEventRequest(REQUEST_ID, { decision: 'approved' }, COORDINATOR_A, { client, now: new Date('2026-10-12T00:00:00Z') }),
      `event request ${REQUEST_ID} is waiting for the Event Coordinator Lead to assign it a coordinator, so it cannot be decided yet`,
    ],
  ])('SCRUM486_AC8_%s_is_a_409_with_the_functions_message', async (_label, call, message) => {
    const client = createFakeClient([dbError('55000', message)]);

    const err = await errorFrom(call(client));

    expect(err).toBeInstanceOf(ConflictError);
    expect(err).not.toBeInstanceOf(ForbiddenError);
    expect(err.status).toBe(409);
    expect(err.message).toBe(message);
    expect(trail(client)).toHaveLength(1);
  });
});
