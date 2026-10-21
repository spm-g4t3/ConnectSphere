/**
 * SCRUM-487 (SCRUM-546), AC2, AC3 and AC6 on a real database: the Lead's
 * overview reads, run against Postgres, before and after a Lead hands an
 * event from one coordinator to another.
 *
 * Why this test, when the service tests already pin every filter. Those use a
 * fake client that answers whatever it is told, so they prove which filters
 * the service asks for, not what Postgres answers to them. Here the real
 * listCoordinatorOverview and listAssignedEventsForLead run over a real
 * database, with 052's real reassign_event_request between two reads, so
 * AC6-03 (the counts move) and AC6-04 (the event moves to the new
 * coordinator's list) are what the database does, not what a fake was told.
 * There is no route in this story that writes, so nothing else could show it.
 *
 * The adapter. The services talk to supabase-js; this hands them the list
 * reads these two functions make, from(table).select(cols) with eq, in,
 * not(column, 'is', null) and order, each turned into one SQL statement, and
 * answers { data, error } as supabase-js does. Anything else throws, so a new
 * call on this path fails by name rather than being answered wrongly. It is
 * not a PostgREST. SCRUM-486's leadReassignmentWalkthrough.test.js has its own
 * adapter, for single-row reads and rpc; it is left as it is (SCRUM-486 kept
 * it to exactly what its path needed, and its PR is under review).
 *
 * The database is the final schema.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
  listAssignedEventsForLead,
  listCoordinatorOverview,
} from '../../src/services/eventRequestService.js';
import { createSchemaDb, seedEvent, seedUser } from './helpers/schemaDb.js';
import { queriesFor } from './helpers/queries.js';

/** The list reads these two services make, over PGlite. */
function pgliteListClient(db) {
  return {
    from(table) {
      let columns = '*';
      const where = [];
      const params = [];
      const orderBy = [];
      const chain = {
        select(cols = '*') { columns = cols; return chain; },
        eq(column, value) { params.push(value); where.push(`${column} = $${params.length}`); return chain; },
        in(column, values) { params.push([...values]); where.push(`${column}::text = any($${params.length})`); return chain; },
        not(column, operator, value) {
          if (operator !== 'is' || value !== null) throw new Error(`pgliteListClient: unsupported not(${operator}, ${value})`);
          where.push(`${column} is not null`);
          return chain;
        },
        order(column, { ascending = true, nullsFirst } = {}) {
          const nulls = nullsFirst === undefined ? '' : nullsFirst ? ' nulls first' : ' nulls last';
          orderBy.push(`${column} ${ascending ? 'asc' : 'desc'}${nulls}`);
          return chain;
        },
        then(resolveRead, rejectRead) {
          const sql = `select ${columns} from ${table}`
            + (where.length ? ` where ${where.join(' and ')}` : '')
            + (orderBy.length ? ` order by ${orderBy.join(', ')}` : '');
          return db.query(sql, params)
            .then((result) => ({ data: result.rows, error: null }), (err) => ({ data: null, error: { code: err.code, message: err.message } }))
            .then(resolveRead, rejectRead);
        },
      };
      return chain;
    },
  };
}

describe('SCRUM-487 AC2, AC3, AC6: the overview over a real database, before and after a handover', () => {
  let db;
  let client;
  let organiser;
  let coordinatorA;
  let coordinatorB;
  let lead;
  let eventId;

  const { one } = queriesFor(() => db);
  const future = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
  const countsOf = (overview, id) => overview.coordinators.find((row) => row.id === id);

  beforeAll(async () => {
    db = await createSchemaDb();

    const user = (email, role, name) => seedUser(db, { email, role, fullName: name });
    organiser = await user('o@x', 'event_organiser', 'Aisha Rahman');
    coordinatorA = await user('a@x', 'event_coordinator', 'Priya Nair');
    coordinatorB = await user('b@x', 'event_coordinator', 'Omar Okafor');
    lead = await user('lead@x', 'event_coordinator_lead', 'Lena Lead');

    // A submitted request A holds, as the Lead's first assignment leaves it;
    // and one that is nobody's yet, which neither read may count or list.
    eventId = (await one(
      `insert into event_requests
         (organiser_id, event_name, status, submitted_at, assigned_coordinator_id,
          proposed_start, proposed_end, expected_attendance)
       values ($1, 'IS212 Industry Night', 'submitted', now(), $2, $3, $4, 120) returning id`,
      [organiser, coordinatorA, future(30), future(30.25)],
    )).id;
    await db.query(
      `insert into event_requests (organiser_id, event_name, status, submitted_at, proposed_start, proposed_end)
       values ($1, 'Waiting for the Lead', 'submitted', now(), $2, $3)`,
      [organiser, future(10), future(10.25)],
    );

    client = pgliteListClient(db);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM487_AC6_after_a_lead_hands_a_to_b_the_counts_and_the_filtered_list_move_with_the_event', async () => {
    // AC6-03, AC6-04, in the order a Lead would see them.

    // Before: A holds it, counted once under submitted; B holds nothing.
    // The unassigned request is in neither (held events only).
    const before = await listCoordinatorOverview({ client });
    expect(before.coordinators.map((row) => row.fullName)).toEqual(['Omar Okafor', 'Priya Nair']);
    expect(countsOf(before, coordinatorA)).toMatchObject({ activeEvents: 1, byStatus: expect.objectContaining({ submitted: 1 }) });
    expect(countsOf(before, coordinatorB)).toMatchObject({ activeEvents: 0, byStatus: expect.objectContaining({ submitted: 0 }) });
    expect((await listAssignedEventsForLead({ client, coordinatorId: coordinatorA })).map((event) => event.id)).toEqual([eventId]);
    expect(await listAssignedEventsForLead({ client, coordinatorId: coordinatorB })).toEqual([]);

    // The Lead hands it to B. A does nothing (AC6).
    await db.query('select * from reassign_event_request($1, $2, $3, $4)', [eventId, coordinatorB, lead, 'Priya is on leave.']);

    // After: one down for A, one up for B, in the event's status.
    const after = await listCoordinatorOverview({ client });
    expect(countsOf(after, coordinatorA)).toMatchObject({ activeEvents: 0, byStatus: expect.objectContaining({ submitted: 0 }) });
    expect(countsOf(after, coordinatorB)).toMatchObject({ activeEvents: 1, byStatus: expect.objectContaining({ submitted: 1 }) });

    // And the list, filtered by B, now holds it; filtered by A, not.
    const underB = await listAssignedEventsForLead({ client, coordinatorId: coordinatorB });
    expect(underB).toEqual([expect.objectContaining({ id: eventId, assignedCoordinatorId: coordinatorB, assignedCoordinatorName: 'Omar Okafor' })]);
    expect(await listAssignedEventsForLead({ client, coordinatorId: coordinatorA })).toEqual([]);
  });

  it('SCRUM487_AC3_on_a_real_database_the_filters_and_include_finished_select_what_they_say', async () => {
    // The filters' SQL, not their recorded calls: a status filter, a
    // finished status hidden then shown, and the held filter keeping the
    // unassigned request out of every answer.
    const finishedId = (await one(
      `insert into event_requests
         (organiser_id, event_name, status, submitted_at, assigned_coordinator_id, proposed_start, proposed_end)
       values ($1, 'Last Term''s Fair', 'cancelled', now(), $2, $3, $4) returning id`,
      [organiser, coordinatorA, future(5), future(5.25)],
    )).id;

    const ids = async (options) => (await listAssignedEventsForLead({ client, ...options })).map((event) => event.id);

    expect(await ids({})).toEqual([eventId]);
    expect(await ids({ status: 'submitted' })).toEqual([eventId]);
    expect(await ids({ status: 'cancelled' })).toEqual([]);
    expect(await ids({ status: 'cancelled', includeFinished: true })).toEqual([finishedId]);
    // Earliest first: the cancelled event starts sooner.
    expect(await ids({ includeFinished: true })).toEqual([finishedId, eventId]);
    expect(await ids({ includeFinished: true, coordinatorId: coordinatorA })).toEqual([finishedId]);
  });

  it('SCRUM487_AC2_AC3_on_a_real_database_events_in_the_safety_statuses_are_counted_listed_and_filtered', async () => {
    // AC2-12 and AC3-18, which waited for SCRUM-488's enum values. A's two
    // events, one in each safety status, each carrying the approval a decided
    // status requires.
    const safetyEvent = (name, status, startDays) => seedEvent(db, {
      status, organiser_id: organiser, event_name: name, assigned_coordinator_id: coordinatorA,
      proposed_start: future(startDays), proposed_end: future(startDays + 0.25),
    });
    const inReview = await safetyEvent('Safety Walkthrough', 'safety_review', 20);
    const approved = await safetyEvent('Safety Gala', 'safety_approved', 21);

    const overview = await listCoordinatorOverview({ client });
    const row = countsOf(overview, coordinatorA);

    expect(overview.statuses.map(({ status, label, finished }) => [status, label, finished])).toEqual([
      ['submitted', 'Requested', false],
      ['under_review', 'Under review', false],
      ['pending_clarification', 'Awaiting your response', false],
      ['approved', 'Planning', false],
      ['safety_review', 'Safety check', false],
      ['safety_approved', 'Safety approved', false],
      ['confirmed', 'Confirmed', false],
      ['completed', 'Completed', true],
      ['rejected', 'Rejected', true],
      ['cancelled', 'Cancelled', true],
    ]);
    expect(row.byStatus).toMatchObject({ safety_review: 1, safety_approved: 1 });
    expect(row.activeEvents).toBe(2);

    const ids = async (options) => (await listAssignedEventsForLead({ client, ...options })).map((event) => event.id);
    expect(await ids({ coordinatorId: coordinatorA })).toEqual([inReview, approved]);
    expect(await ids({ status: 'safety_review' })).toEqual([inReview]);
    expect(await ids({ status: 'safety_approved' })).toEqual([approved]);
  });
});
