/**
 * SCRUM-325: the event status lifecycle, run against a real Postgres.
 *
 * Every other lifecycle test fakes the Supabase client or reads the migrations
 * as text, so none of them can see a transaction roll back, a constraint fire
 * or a row lock decide between two callers. This one applies the real
 * migrations to an in-process Postgres (PGlite) and calls the real functions.
 * It needs no database server and no credentials, so it runs in CI.
 *
 * Migrations applied, in order: 001, 005 (event_request_details), 007, 010
 * (event_request_clarifications), 014 to 017, 020 and 021. 018 and 019 are not
 * needed. 014 refuses to run unless SCRUM-19's decision columns exist, and that
 * migration is not on this branch, so reviewing_coordinator_id is added by hand
 * as a stand-in, which is all 014 reads. That means 010's decision constraints
 * are not under test here. 020 skips them when they are absent.
 *
 * What PGlite is not: a second connection. It runs one query at a time, so the
 * concurrency test below fires two calls at once and the database lets one go
 * first. It proves the second is refused because the status is no longer what
 * it saw, which is the guard. It does not prove two real connections block
 * each other on the row lock. `npm run request:check` runs that against Supabase.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { STATUS, canTransition } from '../../src/domain/eventRequestStatus.js';

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name) => readFileSync(resolve(here, '../../db/migrations', name), 'utf8');

const BASE = [
  '001_event_requests.sql',
  '005_event_request_details.sql',
  '007_user_roles.sql',
  '010_event_request_clarifications.sql',
];
const ASSIGNMENT = [
  '014_coordinator_assignment.sql',
  '015_assignment_function.sql',
  '016_submit_event_request.sql',
  '017_require_assigned_coordinator.sql',
];

/** What 014 reads from SCRUM-19's migration, which is not on this branch. */
const DECISION_STAND_IN = `
  alter table event_requests
    add column if not exists reviewing_coordinator_id uuid references auth.users (id);
`;

/** A database with the migrations up to, but not including, `020`. */
async function databaseBefore020() {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  `);
  for (const name of BASE) await db.exec(migration(name));
  await db.exec(DECISION_STAND_IN);
  for (const name of ASSIGNMENT) await db.exec(migration(name));
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

// Hand-written from SCRUM-318 AC2, not read from the domain module, so a
// transition added or dropped there cannot quietly change what is tested here.
// The database function holds no transition table (the service asks
// canTransition), so these are the moves it must carry out and record.
const RECORDED_TRANSITIONS = [
  [STATUS.SUBMITTED, STATUS.UNDER_REVIEW],
  [STATUS.UNDER_REVIEW, STATUS.PENDING_CLARIFICATION],
  [STATUS.PENDING_CLARIFICATION, STATUS.UNDER_REVIEW],
  [STATUS.UNDER_REVIEW, STATUS.APPROVED],
  [STATUS.UNDER_REVIEW, STATUS.REJECTED],
  [STATUS.APPROVED, STATUS.REJECTED],
  [STATUS.REJECTED, STATUS.DRAFT],
  [STATUS.APPROVED, STATUS.CONFIRMED],
  [STATUS.CONFIRMED, STATUS.APPROVED],
  [STATUS.CONFIRMED, STATUS.COMPLETED],
  ...[
    STATUS.SUBMITTED,
    STATUS.UNDER_REVIEW,
    STATUS.PENDING_CLARIFICATION,
    STATUS.APPROVED,
    STATUS.CONFIRMED,
  ].map((from) => [from, STATUS.CANCELLED]),
];

describe('SCRUM-325: the status lifecycle in Postgres', () => {
  let db;
  let organiser;
  let coordinator;
  let otherCoordinator;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  /** A draft, or a row placed at `status` as a fixture. */
  async function request(status = STATUS.DRAFT, extra = {}) {
    const cols = { organiser_id: organiser, event_name: `event ${status}`, status };
    if (status !== STATUS.DRAFT) {
      cols.submitted_at = new Date().toISOString();
      cols.assigned_coordinator_id = coordinator;
    }
    Object.assign(cols, extra);
    const keys = Object.keys(cols);
    return (await one(
      `insert into event_requests (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning id`,
      Object.values(cols),
    )).id;
  }

  const row = (id) => one('select * from event_requests where id = $1', [id]);
  const statusHistory = async (id) =>
    (await db.query(
      'select * from event_request_status_history where event_request_id = $1 order by created_at, id',
      [id],
    )).rows;
  const assignmentHistory = async (id) =>
    (await db.query('select * from event_request_assignment_history where event_request_id = $1', [id])).rows;

  const change = (id, from, to, by = coordinator, reason = null, expectedCoordinator = null) =>
    db.query('select * from change_event_request_status($1, $2, $3, $4, $5, $6)', [
      id, from, to, by, reason, expectedCoordinator,
    ]);
  const pause = () => db.query('select pg_sleep(0.01)');
  const submit = (id, by = organiser) =>
    db.query('select * from submit_event_request($1, now(), $2)', [id, by]);

  beforeAll(async () => {
    db = await databaseBefore020();
    organiser = (await one("insert into auth.users (email) values ('o@x') returning id")).id;
    coordinator = (await one("insert into auth.users (email) values ('c1@x') returning id")).id;
    otherCoordinator = (await one("insert into auth.users (email) values ('c2@x') returning id")).id;
    await db.query("insert into profiles (id, role) values ($1, 'event_organiser')", [organiser]);
    await db.exec(migration('020_event_status_lifecycle.sql'));
    await db.exec(migration('021_event_status_history.sql'));
    await db.exec(migration('022_event_status_transitions.sql'));
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('Draft -> Submitted keeps its SCRUM-327 behaviour and gains a history row', () => {
    it('SCRUM325_refuses_the_submission_when_no_coordinator_exists_and_leaves_the_draft_alone', async () => {
      const id = await request();

      const err = await refusal(submit(id));

      expect(err.code).toBe('P0001');
      expect(await row(id)).toMatchObject({ status: 'draft', submitted_at: null, assigned_coordinator_id: null });
      expect(await statusHistory(id)).toHaveLength(0);
      expect(await assignmentHistory(id)).toHaveLength(0);
    });

    describe('once coordinators exist', () => {
      beforeAll(async () => {
        await db.query(
          "insert into profiles (id, role) values ($1, 'event_coordinator'), ($2, 'event_coordinator')",
          [coordinator, otherCoordinator],
        );
      });

      it('SCRUM325_assigns_exactly_one_coordinator_and_records_one_row_in_each_history', async () => {
        const id = await request();

        const { rows: [submitted] } = await submit(id);

        expect(submitted.status).toBe('submitted');
        expect([coordinator, otherCoordinator]).toContain(submitted.assigned_coordinator_id);
        expect(submitted.submitted_at).not.toBeNull();

        const assignments = await assignmentHistory(id);
        expect(assignments).toHaveLength(1);
        expect(assignments[0]).toMatchObject({
          previous_coordinator_id: null,
          new_coordinator_id: submitted.assigned_coordinator_id,
          assigned_by: null,
        });

        const statuses = await statusHistory(id);
        expect(statuses).toHaveLength(1);
        expect(statuses[0]).toMatchObject({
          previous_status: 'draft',
          new_status: 'submitted',
          changed_by: organiser,
          reason: null,
        });
        expect(statuses[0].created_at).toBeInstanceOf(Date);
      });

      it('SCRUM325_refuses_a_second_submission_and_adds_no_assignment_and_no_history', async () => {
        const id = await request();
        const { rows: [first] } = await submit(id);

        const err = await refusal(submit(id));

        expect(err.code).toBe('55000');
        expect(err.message).toContain('submitted');
        expect((await row(id)).assigned_coordinator_id).toBe(first.assigned_coordinator_id);
        expect(await assignmentHistory(id)).toHaveLength(1);
        expect(await statusHistory(id)).toHaveLength(1);
      });

      it.each(Object.values(STATUS).filter((status) => status !== STATUS.DRAFT))(
        'SCRUM325_refuses_to_submit_a_request_that_is_%s_and_changes_nothing',
        async (status) => {
          const id = await request(status);
          const before = await row(id);

          const err = await refusal(submit(id));

          expect(err.code).toBe('55000');
          expect(await row(id)).toEqual(before);
          expect(await assignmentHistory(id)).toHaveLength(0);
          expect(await statusHistory(id)).toHaveLength(0);
        },
      );

      it('SCRUM325_is_atomic_when_the_last_write_fails', async () => {
        // The status history insert is the function's last write, after the
        // status, the coordinator and the assignment row. An unknown user fails
        // it with a foreign key violation, and everything before it must roll back.
        const id = await request();

        const err = await refusal(submit(id, '99999999-9999-4999-8999-999999999999'));

        expect(err.code).toBe('23503');
        expect(await row(id)).toMatchObject({ status: 'draft', submitted_at: null, assigned_coordinator_id: null });
        expect(await assignmentHistory(id)).toHaveLength(0);
        expect(await statusHistory(id)).toHaveLength(0);
      });

      it('SCRUM325_refuses_a_submission_with_no_user_and_leaves_a_draft', async () => {
        const id = await request();

        const err = await refusal(db.query('select * from submit_event_request($1, now(), null)', [id]));

        expect(err.code).toBe('22004');
        expect((await row(id)).status).toBe('draft');
      });

      it('SCRUM325_gives_no_other_way_to_submit_without_a_coordinator', async () => {
        const id = await request();

        const direct = await refusal(
          db.query("update event_requests set status = 'submitted', submitted_at = now() where id = $1", [id]),
        );
        const viaStatusFunction = await refusal(change(id, STATUS.DRAFT, STATUS.SUBMITTED, organiser));
        const oldSignature = await one(
          "select count(*)::int as n from pg_proc where proname = 'submit_event_request' and pronargs = 2",
        );

        expect(direct.message).toContain('event_requests_assigned_when_submitted');
        expect(viaStatusFunction.code).toBe('22023');
        expect(oldSignature.n).toBe(0);
        expect((await row(id)).status).toBe('draft');
        expect(await statusHistory(id)).toHaveLength(0);
      });
    });

    describe('every allowed transition records exactly one history row', () => {
      it.each(RECORDED_TRANSITIONS)('SCRUM325_records_%s_to_%s_once', async (from, to) => {
        const id = await request(from);

        const { rows: [moved] } = await change(id, from, to, coordinator);

        expect(moved.status).toBe(to);
        const history = await statusHistory(id);
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({
          event_request_id: id,
          previous_status: from,
          new_status: to,
          changed_by: coordinator,
          reason: null,
        });
        expect(history[0].created_at).toBeInstanceOf(Date);
      });

      it('SCRUM325_stores_the_reason_when_one_is_given', async () => {
        const id = await request(STATUS.APPROVED);

        await change(id, STATUS.APPROVED, STATUS.CANCELLED, coordinator, 'The organiser asked to withdraw.');

        expect((await statusHistory(id))[0].reason).toBe('The organiser asked to withdraw.');
      });

      it('SCRUM325_stores_no_reason_when_none_is_given', async () => {
        const id = await request(STATUS.APPROVED);

        await change(id, STATUS.APPROVED, STATUS.CANCELLED, coordinator);

        expect((await statusHistory(id))[0].reason).toBeNull();
      });

      it('SCRUM325_records_each_step_of_a_journey_once_and_in_order', async () => {
        const id = await request();
        await submit(id);
        const holder = (await row(id)).assigned_coordinator_id;

        // A pause between steps, because the history is read back by time and
        // PGlite's clock is only as fine as a millisecond. Real Postgres is finer.
        await pause();
        await change(id, STATUS.SUBMITTED, STATUS.UNDER_REVIEW, holder);
        await pause();
        await change(id, STATUS.UNDER_REVIEW, STATUS.PENDING_CLARIFICATION, holder, 'Is it open to the public?');
        await pause();
        await change(id, STATUS.PENDING_CLARIFICATION, STATUS.UNDER_REVIEW, organiser);

        const history = await statusHistory(id);
        expect(history.map((h) => [h.previous_status, h.new_status])).toEqual([
          ['draft', 'submitted'],
          ['submitted', 'under_review'],
          ['under_review', 'pending_clarification'],
          ['pending_clarification', 'under_review'],
        ]);
        expect(history.map((h) => h.changed_by)).toEqual([organiser, holder, holder, organiser]);
        expect(history[2].reason).toBe('Is it open to the public?');
      });

      it('SCRUM325_keeps_the_clarification_note_with_the_status', async () => {
        const id = await request(STATUS.UNDER_REVIEW);

        const { rows: [asked] } = await change(
          id, STATUS.UNDER_REVIEW, STATUS.PENDING_CLARIFICATION, coordinator, 'Please confirm the attendance.',
        );
        expect(asked.clarification_note).toBe('Please confirm the attendance.');

        const { rows: [answered] } = await change(id, STATUS.PENDING_CLARIFICATION, STATUS.UNDER_REVIEW, organiser);
        expect(answered.clarification_note).toBeNull();
      });
    });

    describe('a refused or failed change writes no history and leaves the event unchanged', () => {
      it.each([
        ['the status is no longer the one the caller saw', (id) => change(id, STATUS.APPROVED, STATUS.CANCELLED), '55000'],
        ['the user is missing', (id) => change(id, STATUS.SUBMITTED, STATUS.UNDER_REVIEW, null), '22004'],
        ['the target is the current status', (id) => change(id, STATUS.SUBMITTED, STATUS.SUBMITTED), '22023'],
        ['the target is submitted', (id) => change(id, STATUS.DRAFT, STATUS.SUBMITTED), '22023'],
        ['the event was handed to another coordinator', (id) => change(id, STATUS.SUBMITTED, STATUS.UNDER_REVIEW, coordinator, null, otherCoordinator), '40001'],
        ['the reason is blank', (id) => change(id, STATUS.SUBMITTED, STATUS.UNDER_REVIEW, coordinator, '   '), '23514'],
        ['the user does not exist', (id) => change(id, STATUS.SUBMITTED, STATUS.UNDER_REVIEW, '99999999-9999-4999-8999-999999999999'), '23503'],
        ['the move is not one of the sixteen (a submitted request cannot go back to draft)', (id) => change(id, STATUS.SUBMITTED, STATUS.DRAFT), '55000'],
      ])('SCRUM325_refuses_when_%s', async (_label, attempt, code) => {
        const id = await request(STATUS.SUBMITTED);
        const before = await row(id);

        const err = await refusal(attempt(id));

        expect(err.code).toBe(code);
        expect(await row(id)).toEqual(before);
        expect(await statusHistory(id)).toHaveLength(0);
      });

      it('SCRUM325_names_the_current_status_when_the_status_has_moved_on', async () => {
        const id = await request(STATUS.APPROVED);

        const err = await refusal(change(id, STATUS.UNDER_REVIEW, STATUS.APPROVED));

        expect(err.code).toBe('55000');
        expect(err.message).toContain('approved');
      });

      it('SCRUM325_reports_a_missing_request_as_not_found', async () => {
        const err = await refusal(
          change('00000000-0000-0000-0000-000000000000', STATUS.SUBMITTED, STATUS.UNDER_REVIEW),
        );

        expect(err.code).toBe('P0002');
      });
    });

    describe('a rejected request is reopened as a draft', () => {
      it('SCRUM318_reopens_a_rejected_request_without_a_submission_time_and_records_it_once', async () => {
        const id = await request(STATUS.REJECTED);

        const { rows: [reopened] } = await change(id, STATUS.REJECTED, STATUS.DRAFT, organiser, 'Revising after feedback.');

        expect(reopened).toMatchObject({ status: STATUS.DRAFT, submitted_at: null });
        const history = await statusHistory(id);
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({
          previous_status: STATUS.REJECTED,
          new_status: STATUS.DRAFT,
          changed_by: organiser,
          reason: 'Revising after feedback.',
        });
      });

      it('SCRUM318_lets_the_reopened_draft_be_submitted_again_through_the_one_submission_path', async () => {
        const id = await request(STATUS.REJECTED);
        await change(id, STATUS.REJECTED, STATUS.DRAFT, organiser);
        await pause();

        const { rows: [again] } = await submit(id);

        expect(again.status).toBe(STATUS.SUBMITTED);
        expect(again.submitted_at).not.toBeNull();
        expect([coordinator, otherCoordinator]).toContain(again.assigned_coordinator_id);
        const history = await statusHistory(id);
        expect(history.map((h) => [h.previous_status, h.new_status])).toEqual([
          [STATUS.REJECTED, STATUS.DRAFT],
          [STATUS.DRAFT, STATUS.SUBMITTED],
        ]);
        expect(await assignmentHistory(id)).toHaveLength(1);
      });
    });

    describe('concurrency', () => {
      it('SCRUM325_lets_exactly_one_of_two_simultaneous_transitions_from_the_same_status_succeed', async () => {
        const id = await request(STATUS.SUBMITTED);

        const outcomes = await Promise.allSettled([
          change(id, STATUS.SUBMITTED, STATUS.UNDER_REVIEW, coordinator),
          change(id, STATUS.SUBMITTED, STATUS.CANCELLED, coordinator),
        ]);

        const won = outcomes.filter((o) => o.status === 'fulfilled');
        const lost = outcomes.filter((o) => o.status === 'rejected');
        expect(won).toHaveLength(1);
        expect(lost).toHaveLength(1);
        expect(lost[0].reason.code).toBe('55000');

        const history = await statusHistory(id);
        expect(history).toHaveLength(1);
        expect((await row(id)).status).toBe(history[0].new_status);
      });

      it('SCRUM325_lets_exactly_one_of_several_identical_transitions_succeed', async () => {
        const id = await request(STATUS.UNDER_REVIEW);

        const outcomes = await Promise.allSettled(
          Array.from({ length: 5 }, () => change(id, STATUS.UNDER_REVIEW, STATUS.APPROVED, coordinator)),
        );

        expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
        expect(await statusHistory(id)).toHaveLength(1);
      });
    });

    describe('final statuses', () => {
      it.each([STATUS.COMPLETED, STATUS.CANCELLED])(
        'SCRUM325_records_nothing_for_a_request_that_is_%s_and_no_longer_what_the_caller_saw',
        async (final) => {
          // The service refuses every move out of a final status before it
          // calls the database. This is the function's own backstop: a caller
          // that still believes the request is live is refused.
          const id = await request(final);

          const err = await refusal(change(id, STATUS.CONFIRMED, STATUS.APPROVED));

          expect(err.code).toBe('55000');
          expect((await row(id)).status).toBe(final);
          expect(await statusHistory(id)).toHaveLength(0);
        },
      );
    });
  });

  describe('the database holds the same transition table as the domain', () => {
    // Hand-written from SCRUM-318, not read from either module, so neither copy
    // can drift without this test saying so.
    const SIXTEEN = [
      ['draft', 'submitted'],
      ['submitted', 'under_review'],
      ['under_review', 'pending_clarification'],
      ['pending_clarification', 'under_review'],
      ['under_review', 'approved'],
      ['under_review', 'rejected'],
      ['approved', 'rejected'],
      ['rejected', 'draft'],
      ['approved', 'confirmed'],
      ['confirmed', 'approved'],
      ['confirmed', 'completed'],
      ['submitted', 'cancelled'],
      ['under_review', 'cancelled'],
      ['pending_clarification', 'cancelled'],
      ['approved', 'cancelled'],
      ['confirmed', 'cancelled'],
    ];
    const NINE = Object.values(STATUS);
    const WITH_PLANNING = [...NINE, 'planning'];
    const isSixteen = (from, to) => SIXTEEN.some(([f, t]) => f === from && t === to);

    it('SCRUM318_allows_exactly_the_sixteen_listed_transitions_and_nothing_else', async () => {
      const allowed = [];
      for (const from of WITH_PLANNING) {
        for (const to of WITH_PLANNING) {
          const { rows: [r] } = await db.query('select event_request_status_allows($1, $2) as allowed', [from, to]);
          if (r.allowed) allowed.push([from, to]);
        }
      }

      expect(allowed.map((pair) => pair.join('>')).sort()).toEqual(SIXTEEN.map((pair) => pair.join('>')).sort());
    });

    it('SCRUM318_agrees_with_canTransition_for_every_pair_of_statuses', async () => {
      for (const from of WITH_PLANNING) {
        for (const to of WITH_PLANNING) {
          const { rows: [r] } = await db.query('select event_request_status_allows($1, $2) as allowed', [from, to]);
          expect(r.allowed, `${from} -> ${to}`).toBe(canTransition(from, to));
        }
      }
    });

    describe('every other move between the nine statuses', () => {
      // A move to the status the request is already in, and a move to
      // submitted, are refused earlier and for their own reasons, tested above.
      const REFUSED = NINE.flatMap((from) =>
        NINE.filter((to) => to !== from && to !== STATUS.SUBMITTED && !isSixteen(from, to))
          .map((to) => [from, to]),
      );

      it.each(REFUSED)('SCRUM318_refuses_%s_to_%s_names_the_status_and_changes_nothing', async (from, to) => {
        const id = await request(from);
        const before = await row(id);

        const err = await refusal(change(id, from, to, coordinator));

        expect(err.code).toBe('55000');
        expect(err.message).toContain(`status ${from}`);
        expect(await row(id)).toEqual(before);
        expect(await statusHistory(id)).toHaveLength(0);
      });

      it.each([STATUS.COMPLETED, STATUS.CANCELLED])(
        'SCRUM318_refuses_every_move_out_of_%s_when_the_caller_has_its_status_right',
        async (final) => {
          for (const to of NINE.filter((s) => s !== final && s !== STATUS.SUBMITTED)) {
            const id = await request(final);

            const err = await refusal(change(id, final, to, coordinator));

            expect(err.code, `${final} -> ${to}`).toBe('55000');
            expect((await row(id)).status).toBe(final);
            expect(await statusHistory(id)).toHaveLength(0);
          }
        },
      );
    });
  });

  describe('planning is rejected by the database', () => {
    const placed = { submitted_at: new Date().toISOString() };

    it('SCRUM325_refuses_an_insert_with_status_planning', async () => {
      const err = await refusal(request('planning'));

      expect(err.message).toContain('event_requests_status_in_lifecycle');
    });

    it('SCRUM325_refuses_an_update_to_planning', async () => {
      const id = await request(STATUS.APPROVED, placed);

      const err = await refusal(db.query("update event_requests set status = 'planning' where id = $1", [id]));

      expect(err.message).toContain('event_requests_status_in_lifecycle');
      expect((await row(id)).status).toBe(STATUS.APPROVED);
    });

    it('SCRUM325_refuses_the_status_function_moving_a_request_to_planning_and_records_nothing', async () => {
      const id = await request(STATUS.APPROVED);

      const err = await refusal(change(id, STATUS.APPROVED, 'planning'));

      // Refused as a move outside the sixteen, before the table constraint is
      // reached, and naming the status the request is in.
      expect(err.code).toBe('55000');
      expect(err.message).toContain('approved');
      expect(err.message).toContain('planning');
      expect((await row(id)).status).toBe(STATUS.APPROVED);
      expect(await statusHistory(id)).toHaveLength(0);
    });

    it.each([
      ['previous', "'planning', 'approved'"],
      ['new', "'approved', 'planning'"],
    ])('SCRUM318_refuses_a_history_row_whose_%s_status_is_planning', async (_which, pair) => {
      const id = await request(STATUS.APPROVED);

      const err = await refusal(db.query(
        `insert into event_request_status_history (event_request_id, previous_status, new_status, changed_by) values ($1, ${pair}, $2)`,
        [id, organiser],
      ));

      expect(err.message).toContain('event_request_status_history_statuses_in_lifecycle');
      expect(await statusHistory(id)).toHaveLength(0);
    });

    it.each(['postponed', 'archived', 'DRAFT', ''])('SCRUM325_refuses_the_unknown_status_%j', async (value) => {
      const err = await refusal(
        db.query('insert into event_requests (organiser_id, event_name, status) values ($1, $2, $3)', [organiser, 'x', value]),
      );

      expect(err.message).toMatch(/invalid input value for enum/);
    });
  });

  describe('the status history table refuses rows that record nothing', () => {
    it('SCRUM325_refuses_a_row_where_the_status_did_not_change', async () => {
      const id = await request(STATUS.SUBMITTED);

      const err = await refusal(db.query(
        "insert into event_request_status_history (event_request_id, previous_status, new_status, changed_by) values ($1, 'submitted', 'submitted', $2)",
        [id, organiser],
      ));

      expect(err.message).toContain('event_request_status_history_status_changes');
    });

    it('SCRUM325_refuses_a_row_with_no_user', async () => {
      const id = await request(STATUS.SUBMITTED);

      const err = await refusal(db.query(
        "insert into event_request_status_history (event_request_id, previous_status, new_status, changed_by) values ($1, 'submitted', 'under_review', null)",
        [id],
      ));

      expect(err.code).toBe('23502');
    });

    it('SCRUM325_keeps_the_history_when_someone_tries_to_delete_the_event', async () => {
      const id = await request(STATUS.SUBMITTED);
      await change(id, STATUS.SUBMITTED, STATUS.UNDER_REVIEW);

      const err = await refusal(db.query('delete from event_requests where id = $1', [id]));

      expect(err.code).toBe('23001');
      expect(await statusHistory(id)).toHaveLength(1);
    });
  });
});


describe('SCRUM-318: a rejected request reopens on a database that has SCRUM-19\'s decision columns', () => {
  it('SCRUM318_clears_the_decision_with_the_status_and_runs_022_again_without_error', async () => {
    const db = await databaseBefore020();
    try {
      // 010's decision columns and the two constraints 020 keeps, which this
      // branch does not carry. A rejected request has a decision and a draft
      // may not, so the reopen has to clear it in the same statement.
      await db.exec(`
        alter table event_requests
          add column decision text,
          add column decision_note text,
          add column decided_by uuid references auth.users (id),
          add column decided_at timestamptz,
          add constraint event_requests_decided_status_has_decision check (
            status not in ('approved', 'rejected', 'confirmed', 'completed') or decision is not null
          ),
          add constraint event_requests_decision_has_decided_status check (
            decision is null or status in ('approved', 'rejected', 'confirmed', 'completed', 'cancelled')
          );
      `);
      await db.exec(migration('020_event_status_lifecycle.sql'));
      await db.exec(migration('021_event_status_history.sql'));
      await db.exec(migration('022_event_status_transitions.sql'));
      await db.exec(migration('022_event_status_transitions.sql'));

      const one = async (sql, params) => (await db.query(sql, params)).rows[0];
      const organiser = (await one("insert into auth.users (email) values ('o@x') returning id")).id;
      const coordinator = (await one("insert into auth.users (email) values ('c@x') returning id")).id;
      await db.query("insert into profiles (id, role) values ($1, 'event_organiser'), ($2, 'event_coordinator')", [organiser, coordinator]);
      const { id } = await one(
        `insert into event_requests
           (organiser_id, event_name, status, submitted_at, assigned_coordinator_id, reviewing_coordinator_id,
            decision, decision_note, decided_by, decided_at)
         values ($1, 'rejected event', 'rejected', now(), $2, $2, 'rejected', 'No venue.', $2, now())
         returning id`,
        [organiser, coordinator],
      );

      const { rows: [reopened] } = await db.query(
        'select * from change_event_request_status($1, $2, $3, $4, $5)',
        [id, STATUS.REJECTED, STATUS.DRAFT, organiser, null],
      );

      expect(reopened).toMatchObject({
        status: STATUS.DRAFT,
        submitted_at: null,
        decision: null,
        decision_note: null,
        decided_by: null,
        decided_at: null,
      });
      const { rows: history } = await db.query('select * from event_request_status_history where event_request_id = $1', [id]);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ previous_status: 'rejected', new_status: 'draft', changed_by: organiser });

      const { rows: [again] } = await db.query('select * from submit_event_request($1, now(), $2)', [id, organiser]);
      expect(again).toMatchObject({ status: STATUS.SUBMITTED, assigned_coordinator_id: coordinator });
    } finally {
      await db.close();
    }
  }, 60_000);
});


describe('SCRUM-325: migration 020 moves planning to approved', () => {
  it('SCRUM325_moves_a_planning_row_to_approved_and_runs_again_without_error', async () => {
    const db = await databaseBefore020();
    try {
      const organiser = (await db.query("insert into auth.users (email) values ('o@x') returning id")).rows[0].id;
      const coordinator = (await db.query("insert into auth.users (email) values ('c@x') returning id")).rows[0].id;
      const { rows: [planning] } = await db.query(
        `insert into event_requests (organiser_id, event_name, status, submitted_at, assigned_coordinator_id)
         values ($1, 'was planning', 'planning', now(), $2) returning id`,
        [organiser, coordinator],
      );

      await db.exec(migration('020_event_status_lifecycle.sql'));
      await db.exec(migration('020_event_status_lifecycle.sql'));

      const { rows: [moved] } = await db.query('select status from event_requests where id = $1', [planning.id]);
      expect(moved.status).toBe('approved');
      const { rows: [left] } = await db.query("select count(*)::int as n from event_requests where status::text = 'planning'");
      expect(left.n).toBe(0);
    } finally {
      await db.close();
    }
  }, 60_000);
});
