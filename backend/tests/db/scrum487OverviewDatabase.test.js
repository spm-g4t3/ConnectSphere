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
 * The migrations are leadReassignmentWalkthrough's, in its order.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  listAssignedEventsForLead,
  listCoordinatorOverview,
} from '../../src/services/eventRequestService.js';

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name) => readFileSync(resolve(here, '../../db/migrations', name), 'utf8');

const MIGRATIONS = [
  '001_event_requests.sql',
  '005_event_request_details.sql',
  '007_user_roles.sql',
  '010_event_request_clarifications.sql',
  '025_event_request_decisions.sql',
  '014_coordinator_assignment.sql',
  '015_assignment_function.sql',
  '016_submit_event_request.sql',
  '017_require_assigned_coordinator.sql',
  '020_event_status_lifecycle.sql',
  '021_event_status_history.sql',
  '022_event_status_transitions.sql',
  '029_event_request_decisions_functions.sql',
  '006_event_change_requests.sql',
  '019_change_request_decision_coordinator.sql',
  '039_coordinator_lead_and_safety_officer_roles.sql',
];

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

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const future = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
  const countsOf = (overview, id) => overview.coordinators.find((row) => row.id === id);

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create schema auth;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text);
    `);
    for (const name of MIGRATIONS) await db.exec(migration(name));
    // The notifications table 052 writes to, in the shape
    // leadReassignmentWalkthrough.test.js builds it, for the same reason.
    await db.exec(`
      create table notifications (
        id uuid primary key default gen_random_uuid(),
        recipient_id uuid not null references auth.users (id) on delete cascade,
        type text not null,
        booking_id uuid,
        block_id uuid,
        venue_hold_id uuid,
        payload jsonb not null default '{}',
        read_at timestamptz,
        created_at timestamptz not null default now(),
        constraint notifications_type_known check (type in ('booking_flagged'))
      );
    `);
    await db.exec('alter table event_requests add column clarification_reply_by_date date');
    await db.exec(migration('052_lead_assignment.sql'));
    await db.exec(migration('042_event_cancellation_fields.sql'));
    // SCRUM-488: the safety statuses, which the overview now lists.
    await db.exec(migration('053_safety_statuses.sql'));

    const user = async (email, role, name) => {
      const id = (await one('insert into auth.users (email) values ($1) returning id', [email])).id;
      await db.query('insert into profiles (id, role, full_name) values ($1, $2, $3)', [id, role, name]);
      return id;
    };
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
    const safetyEvent = async (name, status, startDays) => (await one(
      `insert into event_requests
         (organiser_id, event_name, status, submitted_at, assigned_coordinator_id, reviewing_coordinator_id,
          decision, decided_by, decided_at, proposed_start, proposed_end)
       values ($1, $2, $3::event_request_status, now(), $4, $4, 'approved', $4, now(), $5, $6) returning id`,
      [organiser, name, status, coordinatorA, future(startDays), future(startDays + 0.25)],
    )).id;
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
