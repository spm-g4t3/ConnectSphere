/**
 * SCRUM-488 AC1 and AC7 (SCRUM-550): migration 053 adds safety_review and
 * safety_approved to the event status, and to the three constraints that decide
 * which statuses a row and its history may hold, on a real Postgres (PGlite).
 *
 * Two databases, both built with the migrations in the order the other PGlite
 * suites use, up to 052:
 *   - upgraded: seeded with one event per existing status, and its status
 *     history, before 053 runs. AC7: afterwards every row is as it was.
 *   - clean: 053 applied straight after 052, with no rows.
 *
 * The constraints are read from pg_constraint as well as exercised, because a
 * constraint that accepts the right rows can still list a wrong status, and
 * because the guard in scrum487StatusClassification.test.js reads migration
 * text, not a database.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name) => readFileSync(resolve(here, '../../db/migrations', name), 'utf8');
const MIGRATION = '053_safety_statuses.sql';

const SEQUENCE = [
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

// Written out, not read from the domain module: the test states what the
// database must hold.
const NINE = [
  'approved', 'cancelled', 'completed', 'confirmed', 'draft',
  'pending_clarification', 'rejected', 'submitted', 'under_review',
];
const SAFETY = ['safety_review', 'safety_approved'];
const ELEVEN = [...NINE, ...SAFETY].sort();

/** Migrations 001 to 052 as the other PGlite suites apply them. */
async function databaseAt052() {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  `);
  for (const name of SEQUENCE) await db.exec(migration(name));
  // The notifications table 052 writes to, in the shape the other suites build.
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
  return db;
}

const refusal = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
};

/** Event rows and their history, as the database holds them, in a stable order. */
async function snapshot(db) {
  return {
    events: (await db.query('select * from event_requests order by id')).rows,
    history: (await db.query('select * from event_request_status_history order by id')).rows,
  };
}

/** The distinct quoted words in a constraint's definition, sorted. */
const quotedWords = (definition) => [...new Set([...definition.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]))].sort();

describe('SCRUM-488 AC1, AC7: migration 053, the safety statuses and their constraints', () => {
  let upgraded;
  let clean;
  let before;
  let organiser;
  let coordinator;
  let seeded;

  const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
  const definitionOf = async (db, table, name) => (await one(
    db,
    'select pg_get_constraintdef(oid) as definition from pg_constraint where conname = $1 and conrelid = $2::regclass',
    [name, table],
  )).definition;

  /**
   * An event row at `status`, with what a real one has: submitted and held by
   * its coordinator beyond draft, and the approval a decided status requires.
   */
  async function insertEvent(db, status, extra = {}) {
    const decided = ['approved', 'confirmed', 'completed', ...SAFETY].includes(status);
    const cols = { organiser_id: organiser, event_name: `event ${status}`, status };
    if (status !== 'draft') {
      Object.assign(cols, { submitted_at: new Date().toISOString(), assigned_coordinator_id: coordinator });
    }
    if (['under_review', 'rejected', 'pending_clarification'].includes(status) || decided) {
      cols.reviewing_coordinator_id = coordinator;
    }
    if (decided || status === 'rejected') {
      Object.assign(cols, {
        decision: status === 'rejected' ? 'rejected' : 'approved',
        decision_note: status === 'rejected' ? 'Not viable as submitted.' : 'Looks fine.',
        decided_by: coordinator,
        decided_at: new Date().toISOString(),
      });
    }
    Object.assign(cols, extra);
    const keys = Object.keys(cols);
    return (await one(
      db,
      `insert into event_requests (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning id`,
      Object.values(cols),
    )).id;
  }

  const history = (db, id, previous, next, reason = null) => db.query(
    `insert into event_request_status_history (event_request_id, previous_status, new_status, changed_by, reason)
     values ($1, $2, $3, $4, $5)`,
    [id, previous, next, coordinator, reason],
  );

  beforeAll(async () => {
    [upgraded, clean] = await Promise.all([databaseAt052(), databaseAt052()]);

    organiser = (await one(upgraded, "insert into auth.users (email) values ('o@x') returning id")).id;
    coordinator = (await one(upgraded, "insert into auth.users (email) values ('c@x') returning id")).id;
    await clean.query('insert into auth.users (id, email) values ($1, $2), ($3, $4)', [organiser, 'o@x', coordinator, 'c@x']);

    // The existing events: one per status, and a cancelled one that keeps its
    // approval. Then the history a few of them would have.
    seeded = {};
    for (const status of NINE) seeded[status] = await insertEvent(upgraded, status);
    seeded.cancelledAfterApproval = await insertEvent(upgraded, 'cancelled', {
      reviewing_coordinator_id: coordinator,
      decision: 'approved',
      decided_by: coordinator,
      decided_at: new Date().toISOString(),
    });
    await history(upgraded, seeded.approved, 'under_review', 'approved', 'Approved after review.');
    await history(upgraded, seeded.confirmed, 'approved', 'confirmed');
    await history(upgraded, seeded.cancelled, 'submitted', 'cancelled', 'Organiser withdrew.');

    before = await snapshot(upgraded);

    await upgraded.exec(migration(MIGRATION));
    await clean.exec(migration(MIGRATION));
  }, 120_000);

  afterAll(async () => {
    await Promise.all([upgraded?.close(), clean?.close()]);
  });

  describe('the upgrade: existing events', () => {
    it('SCRUM488_AC7_every_existing_event_and_history_row_is_unchanged_by_the_migration', async () => {
      expect(before.events).toHaveLength(10);
      expect(before.history).toHaveLength(3);

      expect(await snapshot(upgraded)).toEqual(before);
    });

    it('SCRUM488_AC7_no_existing_event_is_in_a_safety_status', async () => {
      const { rows } = await upgraded.query(
        "select id from event_requests where status::text in ('safety_review', 'safety_approved')",
      );

      expect(rows).toEqual([]);
    });

    it('SCRUM488_AC7_the_decision_fields_of_every_decided_event_are_exactly_as_they_were', async () => {
      const decisionOf = (rows) => rows
        .filter((row) => row.decision !== null)
        .map(({ id, status, decision, decision_note, decided_by, decided_at }) => (
          { id, status, decision, decision_note, decided_by, decided_at }
        ));

      const { rows } = await upgraded.query('select * from event_requests order by id');

      expect(decisionOf(rows)).toHaveLength(5);
      expect(decisionOf(rows)).toEqual(decisionOf(before.events));
    });

    it('SCRUM488_AC1_running_the_migration_again_changes_nothing', async () => {
      await upgraded.exec(migration(MIGRATION));

      expect(await snapshot(upgraded)).toEqual(before);
      const { rows } = await upgraded.query(
        `select conname from pg_constraint
          where conrelid = 'event_requests'::regclass
            and conname in ('event_requests_status_in_lifecycle',
                            'event_requests_decided_status_has_decision',
                            'event_requests_decision_has_decided_status')`,
      );
      expect(rows).toHaveLength(3);
    });
  });

  describe.each([['an upgraded database', () => upgraded], ['a clean database', () => clean]])('on %s', (_name, getDb) => {
    let db;
    beforeAll(() => { db = getDb(); });

    it('SCRUM488_AC1_the_enum_has_both_safety_statuses_between_approved_and_confirmed', async () => {
      const { rows: [{ labels }] } = await db.query('select enum_range(null::event_request_status)::text as labels');
      const values = labels.replace(/[{}]/g, '').split(',');

      expect(values).toEqual(expect.arrayContaining(ELEVEN));
      expect(values.indexOf('approved')).toBeLessThan(values.indexOf('safety_review'));
      expect(values.indexOf('safety_review')).toBeLessThan(values.indexOf('safety_approved'));
      expect(values.indexOf('safety_approved')).toBeLessThan(values.indexOf('confirmed'));
      // 001 is append-only: planning stays in the enum and is refused below.
      expect(values).toContain('planning');
    });

    it('SCRUM488_AC1_the_lifecycle_constraint_lists_exactly_the_eleven_statuses_and_not_planning', async () => {
      const definition = await definitionOf(db, 'event_requests', 'event_requests_status_in_lifecycle');

      expect(quotedWords(definition)).toEqual(ELEVEN);
    });

    it('SCRUM488_AC1_both_decided_status_lists_carry_the_safety_statuses_and_not_planning', async () => {
      const requiring = await definitionOf(db, 'event_requests', 'event_requests_decided_status_has_decision');
      const allowing = await definitionOf(db, 'event_requests', 'event_requests_decision_has_decided_status');

      expect(quotedWords(requiring)).toEqual(
        ['approved', 'completed', 'confirmed', 'rejected', ...SAFETY].sort(),
      );
      // The second list is the first and cancelled, as in 025.
      expect(quotedWords(allowing)).toEqual(
        ['approved', 'cancelled', 'completed', 'confirmed', 'rejected', ...SAFETY].sort(),
      );
    });

    it('SCRUM488_AC1_the_history_constraint_holds_the_same_eleven_for_both_columns', async () => {
      const definition = await definitionOf(
        db, 'event_request_status_history', 'event_request_status_history_statuses_in_lifecycle',
      );

      expect(quotedWords(definition)).toEqual(ELEVEN);
      expect(definition).toMatch(/previous_status/);
      expect(definition).toMatch(/new_status/);
    });

    it('SCRUM488_AC1_no_status_constraint_still_names_planning_and_each_is_defined_once', async () => {
      const { rows: names } = await db.query(
        `select conname from pg_constraint
          where conrelid in ('event_requests'::regclass, 'event_request_status_history'::regclass)
            and pg_get_constraintdef(oid) ilike '%planning%'`,
      );
      const { rows: counts } = await db.query(
        `select conname, count(*)::int as n from pg_constraint
          where conname in ('event_requests_status_in_lifecycle',
                            'event_requests_decided_status_has_decision',
                            'event_requests_decision_has_decided_status',
                            'event_request_status_history_statuses_in_lifecycle')
          group by conname`,
      );

      expect(names).toEqual([]);
      expect(counts.map((row) => row.n)).toEqual([1, 1, 1, 1]);
    });

    it.each(SAFETY)('SCRUM488_AC1_stores_a_new_event_in_%s_with_its_decision', async (status) => {
      const id = await insertEvent(db, status);

      const stored = await one(db, 'select status::text as status, decision, decided_by from event_requests where id = $1', [id]);
      expect(stored).toEqual({ status, decision: 'approved', decided_by: coordinator });
    });

    it.each(SAFETY)('SCRUM488_AC1_moves_an_approved_event_into_%s_and_keeps_its_decision', async (status) => {
      const id = await insertEvent(db, 'approved');
      const { decision, decision_note, decided_by, decided_at } = await one(db, 'select * from event_requests where id = $1', [id]);

      await db.query('update event_requests set status = $1::event_request_status where id = $2', [status, id]);

      const moved = await one(db, 'select * from event_requests where id = $1', [id]);
      expect(moved.status).toBe(status);
      expect({ decision: moved.decision, decision_note: moved.decision_note, decided_by: moved.decided_by, decided_at: moved.decided_at })
        .toEqual({ decision, decision_note, decided_by, decided_at });
    });

    it('SCRUM488_AC1_a_cancelled_event_may_come_from_a_safety_status_and_keep_its_approval', async () => {
      const id = await insertEvent(db, 'safety_review');

      await db.query("update event_requests set status = 'cancelled' where id = $1", [id]);

      expect((await one(db, 'select status::text as status, decision from event_requests where id = $1', [id])))
        .toEqual({ status: 'cancelled', decision: 'approved' });
    });

    it.each(SAFETY)('SCRUM488_AC1_refuses_%s_with_no_decision', async (status) => {
      const err = await refusal(insertEvent(db, status, {
        decision: null, decision_note: null, decided_by: null, decided_at: null,
      }));

      expect(err.message).toContain('event_requests_decided_status_has_decision');
    });

    it.each(SAFETY)('SCRUM488_AC1_refuses_a_rejection_in_%s_with_no_reason', async (status) => {
      const err = await refusal(insertEvent(db, status, { decision: 'rejected', decision_note: null }));

      expect(err.message).toContain('event_requests_rejection_has_reason');
    });

    it('SCRUM488_AC1_still_refuses_a_decision_on_a_status_that_is_not_decided', async () => {
      for (const status of ['draft', 'submitted', 'under_review', 'pending_clarification']) {
        const err = await refusal(insertEvent(db, status, {
          reviewing_coordinator_id: coordinator,
          decision: 'approved', decided_by: coordinator, decided_at: new Date().toISOString(),
        }));

        expect(err?.message, status).toContain('event_requests_decision_has_decided_status');
      }
    });

    it('SCRUM488_AC1_still_refuses_the_retired_planning_status', async () => {
      const err = await refusal(insertEvent(db, 'planning'));

      expect(err.message).toContain('event_requests_status_in_lifecycle');
    });

    it('SCRUM488_AC1_still_refuses_an_approval_on_a_row_with_the_decision_fields_split', async () => {
      const err = await refusal(insertEvent(db, 'safety_review', { decided_at: null }));

      expect(err.message).toContain('event_requests_decision_fields_together');
    });

    it.each([
      ['approved', 'safety_review'],
      ['safety_review', 'safety_approved'],
      ['safety_review', 'approved'],
      ['safety_approved', 'confirmed'],
      ['safety_approved', 'approved'],
      ['safety_review', 'cancelled'],
    ])('SCRUM488_AC4_stores_a_history_row_for_%s_to_%s', async (previous, next) => {
      const id = await insertEvent(db, 'approved');

      await history(db, id, previous, next, 'Sent back with reasons.');

      const row = await one(
        db,
        'select previous_status::text as previous, new_status::text as next, changed_by, reason from event_request_status_history where event_request_id = $1',
        [id],
      );
      expect(row).toEqual({ previous, next, changed_by: coordinator, reason: 'Sent back with reasons.' });
    });

    it.each([
      ['planning', 'approved'],
      ['approved', 'planning'],
    ])('SCRUM488_AC4_still_refuses_a_history_row_for_%s_to_%s', async (previous, next) => {
      const id = await insertEvent(db, 'approved');

      const err = await refusal(history(db, id, previous, next));

      expect(err.message).toContain('event_request_status_history_statuses_in_lifecycle');
    });

    it('SCRUM488_AC4_still_refuses_a_history_row_that_changes_nothing', async () => {
      const id = await insertEvent(db, 'safety_review');

      const err = await refusal(history(db, id, 'safety_review', 'safety_review'));

      expect(err.message).toContain('event_request_status_history_status_changes');
    });
  });

  describe('the migration file and the enum transaction rule', () => {
    const sql = migration(MIGRATION).replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').toLowerCase();

    it('SCRUM488_AC1_adds_each_enum_value_once_and_guarded', () => {
      expect(sql.match(/alter type event_request_status add value/g)).toHaveLength(2);
      expect(sql).toContain("add value if not exists 'safety_review'");
      expect(sql).toContain("add value if not exists 'safety_approved'");
    });

    it('SCRUM488_AC1_never_names_the_new_values_as_enum_literals', () => {
      // The reason the migration can be one file: see the next test.
      expect(sql).not.toMatch(/::event_request_status/);
      expect(sql).not.toMatch(/\bstatus (not )?in \(/);
      expect(sql).not.toMatch(/(previous|new)_status in \(/);
    });

    it('SCRUM488_AC1_changes_no_function_and_creates_no_table', () => {
      expect(sql).not.toMatch(/create (or replace )?function/);
      expect(sql).not.toMatch(/create table/);
    });

    it('SCRUM488_AC1_postgres_refuses_the_new_value_as_an_enum_literal_in_the_same_transaction_but_not_as_text', async () => {
      // The rule the migration is written around, on this suite's Postgres.
      const scratch = new PGlite();
      try {
        await scratch.exec("create type e as enum ('a'); create table t (s e);");

        const literal = await refusal(scratch.exec(
          "alter type e add value 'b'; alter table t add constraint c1 check (s in ('a', 'b'));",
        ));
        const text = await refusal(scratch.exec(
          "alter type e add value 'c'; alter table t add constraint c2 check (s::text in ('a', 'c'));",
        ));

        expect(literal?.code).toBe('55P04');
        expect(text).toBeNull();
      } finally {
        await scratch.close();
      }
    }, 30_000);
  });
});
