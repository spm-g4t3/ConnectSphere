/**
 * SCRUM-486 (SCRUM-521), AC6 and AC7, walked through over HTTP: a Lead hands
 * coordinator A's event to coordinator B, then A is refused and B acts.
 *
 * Why this test, when eventStatusLifecycleDatabase.test.js already proves
 * AC7 against 052's functions (SCRUM486_AC7_the_new_coordinator_reviews_and_
 * decides_and_the_previous_one_cannot). That test calls the SQL functions
 * directly. SCRUM-331 proved handovers over HTTP, but only the holder's own,
 * with a fake client that answers whatever it is told. Neither exercises the
 * path a Lead actually takes: the widened route gates (coordinatorOrLead on
 * POST /:id/reassign and GET /:id/review), the services, and 052's functions,
 * together. Here the real router runs over a real database, so every refusal
 * below comes from where it would in production, not from a queued answer.
 *
 * The adapter. The services talk to supabase-js; this hands them an object
 * with the two shapes they use on this path, rpc(fn, args) and
 * from(table).select(cols).eq(col, value).maybeSingle(), each turned into one
 * SQL statement. It answers { data, error } with the Postgres code, as
 * supabase-js does, and throws on anything else so a new call on this path
 * fails by name rather than being answered wrongly. It is not a PostgREST: it
 * does what these five calls need and nothing more.
 *
 * The migrations are eventStatusLifecycleDatabase's, in its order.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { createEventRequestRouter } from '../../src/routes/eventRequests.js';
import { ROLE } from '../../src/domain/userRole.js';

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

/** The two supabase-js shapes this path uses, over PGlite. */
function pgliteClient(db) {
  const answer = async (run) => {
    try {
      return { data: await run(), error: null };
    } catch (err) {
      return { data: null, error: { code: err.code, message: err.message } };
    }
  };

  return {
    rpc(fn, args) {
      const names = Object.keys(args);
      const sql = `select * from ${fn}(${names.map((name, i) => `${name} => $${i + 1}`).join(', ')})`;
      return answer(async () => (await db.query(sql, names.map((name) => args[name]))).rows[0] ?? null);
    },
    from(table) {
      let columns = '*';
      const where = [];
      const chain = {
        // A PostgREST embed such as SCRUM-266's bookings(status) is not SQL.
        // This path's migrations have no bookings, so the embed is dropped.
        select(cols = '*') { columns = cols.replace(/,\s*\w+\([^)]*\)/g, ''); return chain; },
        eq(column, value) { where.push([column, value]); return chain; },
        maybeSingle() {
          const clause = where.map(([column], i) => `${column} = $${i + 1}`).join(' and ');
          const sql = `select ${columns} from ${table}${clause ? ` where ${clause}` : ''}`;
          return answer(async () => (await db.query(sql, where.map(([, value]) => value))).rows[0] ?? null);
        },
        then() { throw new Error(`pgliteClient: a list read on ${table} is not on this path`); },
      };
      return chain;
    },
  };
}

describe('SCRUM-486 AC6, AC7: a Lead hands A\'s event to B, over HTTP, on a real database', () => {
  let db;
  let client;
  let organiser;
  let coordinatorA;
  let coordinatorB;
  let lead;
  let eventId;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const as = (role, id) => (req, _res, next) => {
    req.user = { id, email: 'someone@example.com', role };
    next();
  };
  const app = (role, id) => express()
    .use(express.json())
    .use('/api/event-requests', createEventRequestRouter({ client, requireAuth: as(role, id) }));
  const asA = () => app(ROLE.EVENT_COORDINATOR, coordinatorA);
  const asB = () => app(ROLE.EVENT_COORDINATOR, coordinatorB);
  const asLead = () => app(ROLE.EVENT_COORDINATOR_LEAD, lead);
  const future = (days) => new Date(Date.now() + days * 86_400_000).toISOString();

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create schema auth;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text);
    `);
    for (const name of MIGRATIONS) await db.exec(migration(name));
    // The notifications table 052 writes to, in the shape
    // eventStatusLifecycleDatabase.test.js builds it, for the same reason.
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
    // The one column the services' COLUMNS reads that these migrations do not
    // add. 030 adds it, alongside a clarification workflow this walkthrough
    // never uses and whose functions need stand-ins
    // (eventClarificationDatabase.test.js builds them); the column alone is
    // what this path needs, so it is added as 030 declares it.
    await db.exec('alter table event_requests add column clarification_reply_by_date date');
    await db.exec(migration('052_lead_assignment.sql'));
    // SCRUM-370's cancellation columns. Since the merge of dev the services'
    // COLUMNS reads them (cancellation_reason, cancellation_initiator,
    // cancelled_by, cancelled_at), so every read on this path needs them.
    // 042 only adds a type and columns; nothing on this path uses them.
    await db.exec(migration('042_event_cancellation_fields.sql'));

    const user = async (email, role, name) => {
      const id = (await one('insert into auth.users (email) values ($1) returning id', [email])).id;
      await db.query('insert into profiles (id, role, full_name) values ($1, $2, $3)', [id, role, name]);
      return id;
    };
    organiser = await user('o@x', 'event_organiser', 'Aisha Rahman');
    coordinatorA = await user('a@x', 'event_coordinator', 'Priya Nair');
    coordinatorB = await user('b@x', 'event_coordinator', 'Omar Okafor');
    lead = await user('lead@x', 'event_coordinator_lead', 'Lena Lead');

    // A submitted request A holds, as the Lead's first assignment leaves it.
    eventId = (await one(
      `insert into event_requests
         (organiser_id, event_name, status, submitted_at, assigned_coordinator_id,
          proposed_start, proposed_end, expected_attendance)
       values ($1, 'IS212 Industry Night', 'submitted', now(), $2, $3, $4, 120) returning id`,
      [organiser, coordinatorA, future(30), future(30.25)],
    )).id;

    client = pgliteClient(db);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM486_AC7_after_a_lead_hands_a_to_b_a_is_refused_and_b_reviews_and_decides', async () => {
    // AC6-02, then AC7-01 to AC7-03, in the order a person would do them.

    // The Lead, who does not hold the event, opens it and hands it to B.
    const opened = await request(asLead()).get(`/api/event-requests/${eventId}/review`);
    expect(opened.status).toBe(200);
    expect(opened.body.assignedCoordinatorId).toBe(coordinatorA);

    const handedOver = await request(asLead())
      .post(`/api/event-requests/${eventId}/reassign`)
      .send({ newCoordinatorId: coordinatorB, handoverNote: 'Priya is on leave.' });
    expect(handedOver.status).toBe(200);
    expect(handedOver.body.assignedCoordinatorId).toBe(coordinatorB);

    // The history records the Lead as the one who moved it, from A to B.
    const history = await one(
      `select previous_coordinator_id, new_coordinator_id, assigned_by, handover_note
         from event_request_assignment_history where event_request_id = $1`,
      [eventId],
    );
    expect(history).toEqual({
      previous_coordinator_id: coordinatorA,
      new_coordinator_id: coordinatorB,
      assigned_by: lead,
      handover_note: 'Priya is on leave.',
    });

    // A can still read it (AC7-03), and can no longer act on it (AC7-02).
    expect((await request(asA()).get(`/api/event-requests/${eventId}/review`)).status).toBe(200);
    const aStarts = await request(asA()).post(`/api/event-requests/${eventId}/start-review`).send({});
    expect(aStarts.status).toBe(403);
    const aHandsOver = await request(asA())
      .post(`/api/event-requests/${eventId}/reassign`)
      .send({ newCoordinatorId: coordinatorA });
    expect(aHandsOver.status).toBe(403);

    // B starts the review and decides it (AC7-01).
    const bStarts = await request(asB()).post(`/api/event-requests/${eventId}/start-review`).send({});
    expect(bStarts.status).toBe(200);
    expect(bStarts.body).toMatchObject({ status: 'under_review', reviewingCoordinatorId: coordinatorB });

    const aDecides = await request(asA())
      .post(`/api/event-requests/${eventId}/decision`)
      .send({ decision: 'approved', decisionNote: 'Approved.' });
    expect(aDecides.status).toBe(403);

    const bDecides = await request(asB())
      .post(`/api/event-requests/${eventId}/decision`)
      .send({ decision: 'approved', decisionNote: 'Approved as submitted.' });
    expect(bDecides.status).toBe(200);
    expect(bDecides.body).toMatchObject({ status: 'approved', decision: 'approved', decidedBy: coordinatorB });

    // Nothing A tried was written: the decision is B's alone.
    const row = await one('select assigned_coordinator_id, decided_by from event_requests where id = $1', [eventId]);
    expect(row).toEqual({ assigned_coordinator_id: coordinatorB, decided_by: coordinatorB });
  });
});
