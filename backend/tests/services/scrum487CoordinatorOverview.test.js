/**
 * SCRUM-487: the service half of the Event Coordinator Lead's coordinator
 * overview.
 *
 *   listCoordinatorOverview    AC2  every coordinator, counted in total and per status (SCRUM-541),
 *                                   and each status's label (SCRUM-546, D9)
 *   listAssignedEventsForLead  AC3  the events list, filtered (SCRUM-542)
 *
 * A file of its own rather than more blocks in leadAssignmentService.test.js,
 * which is SCRUM-486's and under review in its PR: a change here cannot then
 * collide with a change there. The fake client is that file's, copied rather
 * than imported, for the reason that file gives for not sharing helpers.
 *
 * SCRUM-486's own tests of listCoordinatorWorkload and listAssignedEventsForLead
 * stay where they are, unedited. They are the proof that this story's changes
 * left the picker and the unfiltered list exactly as they were (cases AC2-09
 * and AC3-01 of docs/test-cases/SCRUM-487.md).
 */

import { describe, it, expect } from 'vitest';

import {
  listCoordinatorOverview,
  listCoordinatorWorkload,
  listAssignedEventsForLead,
} from '../../src/services/eventRequestService.js';
import { STATUS } from '../../src/domain/eventRequestStatus.js';
import { ValidationError } from '../../src/errors.js';
import { ok, dbError, errorFrom, createReadQueueClient } from '../fixtures/supabaseStubs.js';


// ---------------------------------------------------------------------------
// The fake client
// ---------------------------------------------------------------------------

const trail = (client) => client.calls.map((call) => call.table);


// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const COORDINATOR_A = '44444444-4444-4444-8444-444444444444';
const COORDINATOR_B = '66666666-6666-4666-8666-666666666666';

/** The active statuses, written out: the test states what the code must count. SCRUM-488 adds the two safety statuses, in lifecycle order. */
const ACTIVE = [
  STATUS.SUBMITTED, STATUS.UNDER_REVIEW, STATUS.PENDING_CLARIFICATION, STATUS.APPROVED,
  STATUS.SAFETY_REVIEW, STATUS.SAFETY_APPROVED, STATUS.CONFIRMED,
];

const profileRow = (id, fullName) => ({ id, full_name: fullName });
const held = (coordinator, status) => ({ assigned_coordinator_id: coordinator, status });
const zeros = () => Object.fromEntries(ACTIVE.map((status) => [status, 0]));

/**
 * The overview's statuses, written out: every active status, then every
 * finished one, each with the label every status badge uses (SCRUM-487 D9).
 */
const STATUSES = [
  { status: STATUS.SUBMITTED, label: 'Requested', finished: false },
  { status: STATUS.UNDER_REVIEW, label: 'Under review', finished: false },
  { status: STATUS.PENDING_CLARIFICATION, label: 'Awaiting your response', finished: false },
  { status: STATUS.APPROVED, label: 'Planning', finished: false },
  { status: STATUS.SAFETY_REVIEW, label: 'Safety check', finished: false },
  { status: STATUS.SAFETY_APPROVED, label: 'Safety approved', finished: false },
  { status: STATUS.CONFIRMED, label: 'Confirmed', finished: false },
  { status: STATUS.COMPLETED, label: 'Completed', finished: true },
  { status: STATUS.REJECTED, label: 'Rejected', finished: true },
  { status: STATUS.CANCELLED, label: 'Cancelled', finished: true },
];

/** Omar (A) holds one event in each active status and a second approved one; Priya (B) holds nothing. */
const COORDINATORS = [profileRow(COORDINATOR_A, 'Omar Okafor'), profileRow(COORDINATOR_B, 'Priya Nair')];
const EVENTS = [...ACTIVE.map((status) => held(COORDINATOR_A, status)), held(COORDINATOR_A, STATUS.APPROVED)];


// ---------------------------------------------------------------------------
// AC2: every coordinator, with active events and the count in each status
// ---------------------------------------------------------------------------
describe('SCRUM-487 AC2: every Event Coordinator, counted in total and per status', () => {
  it('SCRUM487_AC2_lists_every_coordinator_with_a_count_for_every_active_status', async () => {
    // AC2-01, AC2-02, AC2-03. Every key of ACTIVE_EVENT_STATUSES on every row;
    // a coordinator with nothing is listed with zeros, not left out.
    const client = createReadQueueClient([ok(COORDINATORS), ok(EVENTS)]);

    const { coordinators: overview } = await listCoordinatorOverview({ client });

    expect(overview).toEqual([
      {
        id: COORDINATOR_A,
        fullName: 'Omar Okafor',
        activeEvents: 8,
        byStatus: {
          [STATUS.SUBMITTED]: 1,
          [STATUS.UNDER_REVIEW]: 1,
          [STATUS.PENDING_CLARIFICATION]: 1,
          [STATUS.APPROVED]: 2,
          [STATUS.SAFETY_REVIEW]: 1,
          [STATUS.SAFETY_APPROVED]: 1,
          [STATUS.CONFIRMED]: 1,
        },
      },
      { id: COORDINATOR_B, fullName: 'Priya Nair', activeEvents: 0, byStatus: zeros() },
    ]);
  });

  it('SCRUM487_AC2_active_events_is_the_sum_of_by_status_and_the_pickers_count', async () => {
    // AC2-04, AC2-05 (SCRUM-487 D3). The same coordinators and events through
    // both reads: one count, so the picker and the overview cannot disagree.
    const { coordinators: overview } = await listCoordinatorOverview({ client: createReadQueueClient([ok(COORDINATORS), ok(EVENTS)]) });
    const picker = await listCoordinatorWorkload({ client: createReadQueueClient([ok(COORDINATORS), ok(EVENTS)]) });

    for (const row of overview) {
      expect(row.activeEvents).toBe(Object.values(row.byStatus).reduce((sum, n) => sum + n, 0));
    }
    expect(overview.map(({ id, activeEvents }) => ({ id, activeEvents })))
      .toEqual(picker.map(({ id, activeEvents }) => ({ id, activeEvents })));
  });

  it('SCRUM487_AC2_reads_coordinators_by_name_and_only_their_active_events_with_status', async () => {
    // AC2-01, AC2-06, AC2-11. The same two reads as the picker's: role
    // event_coordinator only (no Lead), by name then id, never by workload;
    // then their events in the active statuses, now with status to count by.
    const client = createReadQueueClient([ok(COORDINATORS), ok([])]);

    await listCoordinatorOverview({ client });

    const [people, events] = client.calls;
    expect(people.table).toBe('profiles');
    expect(people.filters).toEqual([['role', 'event_coordinator']]);
    expect(people.order).toEqual([
      ['full_name', { ascending: true, nullsFirst: false }],
      ['id', { ascending: true }],
    ]);
    expect(events.table).toBe('event_requests');
    expect(events.select.split(',').map((c) => c.trim()).sort()).toEqual(['assigned_coordinator_id', 'status']);
    expect(events.inFilters).toEqual([
      ['assigned_coordinator_id', [COORDINATOR_A, COORDINATOR_B]],
      ['status', ACTIVE],
    ]);
    for (const notActive of [STATUS.DRAFT, STATUS.COMPLETED, STATUS.REJECTED, STATUS.CANCELLED]) {
      expect(events.inFilters[1][1]).not.toContain(notActive);
    }
  });

  it('SCRUM487_AC2_the_order_is_the_reads_never_the_workload', async () => {
    // Omar holds eight and Priya none; a list sorted by workload would move
    // Priya. The service keeps the read's order.
    const client = createReadQueueClient([ok(COORDINATORS), ok(EVENTS)]);

    const { coordinators: overview } = await listCoordinatorOverview({ client });

    expect(overview.map((row) => row.fullName)).toEqual(['Omar Okafor', 'Priya Nair']);
  });

  it('SCRUM487_AC2_no_coordinators_is_an_empty_list_with_its_statuses_and_no_event_read', async () => {
    // AC2-07. Was SCRUM487_AC2_no_coordinators_is_an_empty_array_and_no_event_read,
    // right while the response was a bare array; since SCRUM-546 it is
    // { statuses, coordinators }, and the statuses are there with nobody to
    // count (the filter still needs them).
    for (const data of [[], null]) {
      const client = createReadQueueClient([ok(data)]);
      await expect(listCoordinatorOverview({ client })).resolves.toEqual({ statuses: STATUSES, coordinators: [] });
      expect(trail(client)).toEqual(['profiles']);
    }
  });

  it('SCRUM487_AC2_a_coordinator_with_no_name_keeps_their_counts', async () => {
    const client = createReadQueueClient([ok([profileRow(COORDINATOR_A, null)]), ok([held(COORDINATOR_A, STATUS.CONFIRMED)])]);

    const { coordinators: [row] } = await listCoordinatorOverview({ client });

    expect(row).toEqual({ id: COORDINATOR_A, fullName: null, activeEvents: 1, byStatus: { ...zeros(), [STATUS.CONFIRMED]: 1 } });
  });

  it('SCRUM487_AC2_a_safety_event_is_counted_under_its_own_status_and_in_the_pickers_count', async () => {
    // AC2-12, open until SCRUM-488 added the statuses. One event in Safety
    // review is one under safety_review, in the total, and in the picker.
    const events = [held(COORDINATOR_A, STATUS.SAFETY_REVIEW)];
    const { coordinators: [row] } = await listCoordinatorOverview({ client: createReadQueueClient([ok(COORDINATORS), ok(events)]) });
    const [picked] = await listCoordinatorWorkload({ client: createReadQueueClient([ok(COORDINATORS), ok(events)]) });

    expect(row).toEqual({
      id: COORDINATOR_A,
      fullName: 'Omar Okafor',
      activeEvents: 1,
      byStatus: { ...zeros(), [STATUS.SAFETY_REVIEW]: 1 },
    });
    expect(picked.activeEvents).toBe(1);
  });

  it('SCRUM487_AC2_the_response_names_every_active_then_finished_status_with_its_badge_label', async () => {
    // AC2-02, AC3-05 (SCRUM-487 D9). Every status the overview shows, in
    // order, active then finished, each in the words its status badge uses.
    // Never draft. From the response, not collected from event rows.
    const { statuses } = await listCoordinatorOverview({ client: createReadQueueClient([ok(COORDINATORS), ok(EVENTS)]) });

    expect(statuses).toEqual(STATUSES);
    expect(statuses.map((entry) => entry.status)).not.toContain(STATUS.DRAFT);
  });

  it.each([
    ['the coordinators read', [dbError('42P01', 'relation "profiles" does not exist')]],
    ['the events read', [ok(COORDINATORS), dbError('42P01', 'relation "event_requests" does not exist')]],
  ])('SCRUM487_AC2_a_failure_in_%s_is_an_error_not_a_zero_filled_list', async (_label, results) => {
    // AC2-08. Through translateError: 42P01 is no known SQLSTATE, so it stays
    // untyped and handleError answers 500. Never a list of zeros, which would
    // look like coordinators with nothing to do.
    const err = await errorFrom(listCoordinatorOverview({ client: createReadQueueClient(results) }));

    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBeUndefined();
  });

  it('SCRUM487_AC2_a_known_sqlstate_from_the_events_read_is_translated', async () => {
    // By SQLSTATE, never by message: 42501 is translateError's ForbiddenError,
    // so the events read's error goes through it rather than being rethrown.
    const err = await errorFrom(listCoordinatorOverview({
      client: createReadQueueClient([ok(COORDINATORS), dbError('42501', 'permission denied for table event_requests')]),
    }));

    expect(err.status).toBe(403);
  });
});


// ---------------------------------------------------------------------------
// AC3: the events list, filtered by coordinator and status, finished on request
// ---------------------------------------------------------------------------
describe('SCRUM-487 AC3: the Lead filters the list and can include finished events', () => {
  const FINISHED = [STATUS.COMPLETED, STATUS.REJECTED, STATUS.CANCELLED];
  const SELECT = 'id, event_name, status, proposed_start, organiser_id, assigned_coordinator_id';
  const ORDER = [
    ['proposed_start', { ascending: true, nullsFirst: false }],
    ['id', { ascending: true }],
  ];

  /** The one read the list makes, with nothing held: no name read follows. */
  const readWith = async (options) => {
    const client = createReadQueueClient([ok([])]);
    await listAssignedEventsForLead({ client, ...options });
    return client;
  };

  it('SCRUM487_AC3_with_no_options_the_read_is_scrum486s', async () => {
    // AC3-01. Exactly SCRUM-486 AC6's read: no eq at all, the active set,
    // held only, earliest first. SCRUM-486's own tests pin it too, unedited.
    const client = await readWith({});

    const [read] = client.calls;
    expect(trail(client)).toEqual(['event_requests']);
    expect(read.select).toBe(SELECT);
    expect(read.filters).toEqual([]);
    expect(read.inFilters).toEqual([['status', ACTIVE]]);
    expect(read.notFilters).toEqual([['assigned_coordinator_id', 'is', null]]);
    expect(read.order).toEqual(ORDER);
  });

  it('SCRUM487_AC3_a_coordinator_filter_adds_one_eq_on_the_coordinator', async () => {
    // AC3-02. Still the active set, still held only.
    const [read] = (await readWith({ coordinatorId: COORDINATOR_A })).calls;

    expect(read.filters).toEqual([['assigned_coordinator_id', COORDINATOR_A]]);
    expect(read.inFilters).toEqual([['status', ACTIVE]]);
    expect(read.notFilters).toEqual([['assigned_coordinator_id', 'is', null]]);
  });

  it('SCRUM487_AC3_a_status_filter_narrows_the_read_to_that_status', async () => {
    // AC3-03. One status in place of the set it belongs to.
    const [read] = (await readWith({ status: STATUS.APPROVED })).calls;

    expect(read.filters).toEqual([['status', STATUS.APPROVED]]);
    expect(read.inFilters).toEqual([]);
    expect(read.notFilters).toEqual([['assigned_coordinator_id', 'is', null]]);
  });

  it.each([STATUS.SAFETY_REVIEW, STATUS.SAFETY_APPROVED])(
    'SCRUM487_AC3_a_status_filter_accepts_the_safety_status_%s',
    async (status) => {
      // AC3-18, open until SCRUM-488 added the statuses. Both are active, so
      // the filter is not refused and the read is narrowed to the one status.
      const [read] = (await readWith({ status })).calls;

      expect(read.filters).toEqual([['status', status]]);
      expect(read.inFilters).toEqual([]);
    },
  );

  it('SCRUM487_AC3_coordinator_and_status_filters_combine', async () => {
    // AC3-04, AC3-15: both filters, and the order is untouched by either.
    const [read] = (await readWith({ coordinatorId: COORDINATOR_A, status: STATUS.APPROVED })).calls;

    expect(read.filters).toEqual([['status', STATUS.APPROVED], ['assigned_coordinator_id', COORDINATOR_A]]);
    expect(read.notFilters).toEqual([['assigned_coordinator_id', 'is', null]]);
    expect(read.order).toEqual(ORDER);
  });

  it('SCRUM487_AC3_include_finished_adds_exactly_the_three_finished_statuses', async () => {
    // AC3-05. Never draft.
    const [read] = (await readWith({ includeFinished: true })).calls;

    expect(read.inFilters).toEqual([['status', [...ACTIVE, ...FINISHED]]]);
    expect(read.inFilters[0][1]).not.toContain(STATUS.DRAFT);
    expect(read.order).toEqual(ORDER);
  });

  it('SCRUM487_AC3_finished_events_are_hidden_unless_asked_for_and_a_draft_never_shows', async () => {
    // AC3-06, over a table holding one held event in every status, through
    // the real query's own filters.
    const TABLE = Object.values(STATUS).map((status) => ({
      id: status, event_name: status, status, proposed_start: null,
      organiser_id: COORDINATOR_B, assigned_coordinator_id: COORDINATOR_A,
    }));
    const overTable = () => ({
      from(table) {
        if (table === 'profiles') return { select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) };
        const keep = [];
        const chain = {
          select() { return chain; },
          eq(column, value) { keep.push((row) => row[column] === value); return chain; },
          in(column, values) { keep.push((row) => values.includes(row[column])); return chain; },
          not(column) { keep.push((row) => row[column] != null); return chain; },
          order() { return chain; },
          then: (resolve, reject) =>
            Promise.resolve({ data: TABLE.filter((row) => keep.every((test) => test(row))), error: null }).then(resolve, reject),
        };
        return chain;
      },
    });

    const hidden = await listAssignedEventsForLead({ client: overTable() });
    const shown = await listAssignedEventsForLead({ client: overTable(), includeFinished: true });

    expect(hidden.map((event) => event.status).sort()).toEqual([...ACTIVE].sort());
    expect(shown.map((event) => event.status).sort()).toEqual([...ACTIVE, ...FINISHED].sort());
    expect(shown.map((event) => event.status)).not.toContain(STATUS.DRAFT);
  });

  it.each(FINISHED)('SCRUM487_AC3_asking_for_%s_while_finished_events_are_hidden_is_empty_and_makes_no_query', async (status) => {
    // AC3-07. A coherent question with an empty answer: nothing in the list
    // can match, so there is nothing to ask the database.
    const client = createReadQueueClient([]);

    await expect(listAssignedEventsForLead({ client, status })).resolves.toEqual([]);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM487_AC3_a_finished_status_with_include_finished_is_read', async () => {
    // AC3-08.
    const [read] = (await readWith({ status: STATUS.COMPLETED, includeFinished: true })).calls;

    expect(read.filters).toEqual([['status', STATUS.COMPLETED]]);
  });

  it.each([
    ['a coordinatorId that is not a uuid', { coordinatorId: 'not-a-uuid' }, 'coordinatorId'],
    ['an empty coordinatorId', { coordinatorId: '' }, 'coordinatorId'],
    ['status draft', { status: STATUS.DRAFT }, 'status'],
    ['status nonsense', { status: 'nonsense' }, 'status'],
    ['includeFinished as the string yes', { includeFinished: 'yes' }, 'includeFinished'],
    ['includeFinished as the string true', { includeFinished: 'true' }, 'includeFinished'],
  ])('SCRUM487_AC3_%s_is_refused_with_400_before_any_query', async (_label, options, field) => {
    // AC3-09 to AC3-12. Draft is a known status (isKnownStatus would admit
    // it), but never in this list. The service takes a boolean; turning the
    // query string into one is the route's job, so a string here is a caller bug.
    const client = createReadQueueClient([]);

    const err = await errorFrom(listAssignedEventsForLead({ client, ...options }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(err.details.map((detail) => detail.field)).toEqual([field]);
    expect(client.calls).toHaveLength(0);
  });
});
