/**
 * SCRUM-325 and SCRUM-19 (SCRUM-134): the event status lifecycle and the
 * decision, run against a real Postgres.
 *
 * Every other lifecycle test fakes the Supabase client or reads the migrations
 * as text, so none of them can see a transaction roll back, a constraint fire
 * or a row lock decide between two callers. This one applies the real
 * migrations to an in-process Postgres (PGlite) and calls the real functions.
 * It needs no database server and no credentials, so it runs in CI.
 *
 * Migrations applied, in order: 001, 005 (event_request_details), 007, 010
 * (event_request_clarifications), 025 (event_request_decisions), 014 to 017,
 * 020, 021, 022 and 029. 018 and 019 are not needed.
 *
 * 025 comes before 014, as it did on the live database (it was applied there
 * as 010_event_request_decisions.sql, before SCRUM-327): 014's prerequisite
 * guard refuses to run unless reviewing_coordinator_id exists, and 025 creates
 * it. Until SCRUM-19's migration reached this branch, that column was added by
 * hand as a stand-in, which meant none of 025's five constraints were under
 * test here. The stand-in is gone: 025 is applied for real, its constraints
 * are live in every test below, and 020 rewrites two of them as it does in
 * production.
 *
 * That has a consequence for the fixtures. A row at approved, rejected,
 * confirmed or completed must carry a decision, because 025 refuses one
 * without (decided_status_has_decision). So request() gives every such row
 * the decision a real one would have. And the status function cannot move a
 * request to approved or rejected at all, because it writes no decision: that
 * is the bug 029's decide_event_request exists to fix, and it is tested as a
 * refusal below rather than recorded as an allowed move.
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
// SCRUM-19's decisions: five columns and five constraints. Before 014, whose
// prerequisite guard needs reviewing_coordinator_id; see the header.
const DECISIONS = '025_event_request_decisions.sql';
const ASSIGNMENT = [
  '014_coordinator_assignment.sql',
  '015_assignment_function.sql',
  '016_submit_event_request.sql',
  '017_require_assigned_coordinator.sql',
];

/** A database with the migrations up to, but not including, `020`. */
async function databaseBefore020() {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  `);
  for (const name of BASE) await db.exec(migration(name));
  await db.exec(migration(DECISIONS));
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
  // under_review -> approved and under_review -> rejected are not here. They
  // are two of the sixteen, but on a database with 025 the status function
  // cannot make them: it writes no decision, and decided_status_has_decision
  // refuses an approved or rejected row without one. decide_event_request
  // (029) makes them, and is tested below; the status function's refusal is
  // SCRUM19_AC7_the_status_function_cannot_decide_a_request.
  //
  // approved -> rejected stays. It passes because the row already carries its
  // approval, which the move leaves in place: a rejected row that says it was
  // approved. That is the AC9 question docs/test-cases/SCRUM-19.md records.
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

  /**
   * A draft, or a row placed at `status` as a fixture.
   *
   * A row at a decided status carries the decision a real one would have, made
   * by its coordinator as reviewer, because 025 refuses such a row without one.
   * approved, confirmed and completed were approved; rejected was rejected,
   * with the reason 025 requires. cancelled carries none: it is reachable both
   * with and without a decision. `extra` overrides any of it.
   */
  const DECISION_FOR = {
    [STATUS.APPROVED]: 'approved',
    [STATUS.CONFIRMED]: 'approved',
    [STATUS.COMPLETED]: 'approved',
    [STATUS.REJECTED]: 'rejected',
  };

  async function request(status = STATUS.DRAFT, extra = {}) {
    const cols = { organiser_id: organiser, event_name: `event ${status}`, status };
    if (status !== STATUS.DRAFT) {
      cols.submitted_at = new Date().toISOString();
      cols.assigned_coordinator_id = coordinator;
    }
    if (DECISION_FOR[status]) {
      Object.assign(cols, {
        reviewing_coordinator_id: coordinator,
        decision: DECISION_FOR[status],
        decision_note: DECISION_FOR[status] === 'rejected' ? 'Not viable as submitted.' : null,
        decided_by: coordinator,
        decided_at: new Date().toISOString(),
      });
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
    // SCRUM-19's two functions, after 022: start_event_review calls 022's
    // event_request_status_allows.
    await db.exec(migration('029_event_request_decisions_functions.sql'));
    // SCRUM-486's migration, last, as production will have it: the relaxed
    // assignment constraint and submission without assignment (SCRUM-515).
    await db.exec(migration('041_lead_assignment.sql'));
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('Draft -> Submitted: no coordinator since SCRUM-486, and one history row', () => {
    it('SCRUM486_AC11_submits_when_no_event_coordinator_and_no_lead_exists', async () => {
      // AC11-01 and AC11-02. Was SCRUM325_refuses_the_submission_when_no_
      // coordinator_exists_and_leaves_the_draft_alone, which pinned SCRUM-327
      // AC5's refusal (P0001) and was right then. Submission no longer looks
      // for a coordinator, so with nobody holding either role it succeeds,
      // and the request waits for a Lead. This runs before any coordinator or
      // Lead profile exists in this database.
      const id = await request();

      const { rows: [submitted] } = await submit(id);

      expect(submitted).toMatchObject({ status: 'submitted', assigned_coordinator_id: null });
      expect(await statusHistory(id)).toHaveLength(1);
      expect(await assignmentHistory(id)).toHaveLength(0);
    });

    describe('once coordinators exist', () => {
      beforeAll(async () => {
        await db.query(
          "insert into profiles (id, role) values ($1, 'event_coordinator'), ($2, 'event_coordinator')",
          [coordinator, otherCoordinator],
        );
      });

      it('SCRUM486_AC1_submits_with_no_coordinator_even_when_coordinators_exist', async () => {
        // AC1-01. Was SCRUM325_assigns_exactly_one_coordinator_and_records_one_
        // row_in_each_history, which pinned SCRUM-327 AC1 (a coordinator chosen
        // on submission, and its assignment row) and was right then. Two
        // coordinators exist here, so a coordinator could have been chosen;
        // none is. No assignment row, because nothing was assigned. The
        // status-history row is unchanged.
        const id = await request();

        const { rows: [submitted] } = await submit(id);

        expect(submitted.status).toBe('submitted');
        expect(submitted.assigned_coordinator_id).toBeNull();
        expect(submitted.reviewing_coordinator_id).toBeNull();
        expect(submitted.submitted_at).not.toBeNull();
        expect(await assignmentHistory(id)).toHaveLength(0);

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
        // None since SCRUM-486: the first submission assigns nobody, so there
        // is no assignment row for the second to add to. It used to be one.
        expect(await assignmentHistory(id)).toHaveLength(0);
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
        // status update (and, before SCRUM-486, the coordinator and the
        // assignment row). An unknown user fails it with a foreign key
        // violation, and everything before it must roll back.
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
        // Until SCRUM-486 this also asserted that a direct update to submitted
        // with no coordinator was refused by 017's constraint. That was right
        // then. 041 relaxes the constraint to allow exactly that row, so the
        // database no longer refuses it (SCRUM486_TR01_… below pins the new
        // rule); the single path is now held by the status function's refusal
        // here and by the application, which draftToSubmittedSinglePath.test.js
        // checks. The name is kept: the application still has no other way.
        const id = await request();

        const viaStatusFunction = await refusal(change(id, STATUS.DRAFT, STATUS.SUBMITTED, organiser));
        const oldSignature = await one(
          "select count(*)::int as n from pg_proc where proname = 'submit_event_request' and pronargs = 2",
        );

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
        // Since SCRUM-486 submission assigns nobody, so the request is given a
        // coordinator here, as the Lead's assignment will. Until SCRUM-516 adds
        // that function, a direct update stands in for it; it writes no status
        // history, so the journey below is unchanged. Before SCRUM-486 the
        // holder came from submission itself.
        await db.query('update event_requests set assigned_coordinator_id = $1 where id = $2', [coordinator, id]);
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
        // Until SCRUM-486 the resubmission was given a coordinator again, and
        // this asserted it (SCRUM-327 AC3), rightly then. Now it goes to the
        // Lead's queue with none, and no assignment row. SCRUM486_TR02_… below
        // is the trap this guards against, with the stale coordinator shown.
        expect(again.assigned_coordinator_id).toBeNull();
        const history = await statusHistory(id);
        expect(history.map((h) => [h.previous_status, h.new_status])).toEqual([
          [STATUS.REJECTED, STATUS.DRAFT],
          [STATUS.DRAFT, STATUS.SUBMITTED],
        ]);
        expect(await assignmentHistory(id)).toHaveLength(0);
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
        // under_review -> cancelled, not -> approved as before SCRUM-134. With
        // 025 applied, the status function cannot approve at all (it writes no
        // decision), so five identical approvals would all fail and prove
        // nothing about the guard. Cancelling is a move it can make.
        const id = await request(STATUS.UNDER_REVIEW);

        const outcomes = await Promise.allSettled(
          Array.from({ length: 5 }, () => change(id, STATUS.UNDER_REVIEW, STATUS.CANCELLED, coordinator)),
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
      // From submitted, not approved as before SCRUM-134. An approved row now
      // carries 025's approval, and since 020 a decision may not sit on
      // planning, so that update breaks decision_has_decided_status as well
      // and Postgres names whichever constraint sorts first. A row with no
      // decision can break only status_in_lifecycle.
      const id = await request(STATUS.SUBMITTED, placed);

      const err = await refusal(db.query("update event_requests set status = 'planning' where id = $1", [id]));

      expect(err.message).toContain('event_requests_status_in_lifecycle');
      expect((await row(id)).status).toBe(STATUS.SUBMITTED);
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

  // -------------------------------------------------------------------------
  // SCRUM-486 (SCRUM-515): migration 041, the relaxed constraint and the guards
  // -------------------------------------------------------------------------
  // docs/test-cases/SCRUM-486.md, TR-01, TR-02, TR-04 and AC1-02. Real
  // Postgres, because each is about what the database accepts or what a
  // function does with a null, which a fake client cannot show.

  describe('SCRUM-486: 041 relaxes the assignment constraint for submitted only', () => {
    // Each row is written straight to the table, bypassing every function, so
    // only the constraint can refuse it. `extra` overrides the fixture's
    // coordinator with null.
    const noCoordinator = { assigned_coordinator_id: null };

    it('SCRUM486_TR01_accepts_a_submitted_request_with_no_coordinator', async () => {
      // TR-01, the half 041 adds: a submitted request may wait for the Lead.
      const id = await request(STATUS.SUBMITTED, noCoordinator);

      expect((await row(id)).assigned_coordinator_id).toBeNull();
    });

    it.each([
      STATUS.UNDER_REVIEW,
      STATUS.PENDING_CLARIFICATION,
      STATUS.APPROVED,
      STATUS.CONFIRMED,
      STATUS.COMPLETED,
      STATUS.REJECTED,
    ])('SCRUM486_TR01_still_refuses_a_request_that_is_%s_with_no_coordinator', async (status) => {
      // TR-01, the half 041 keeps: past submitted, only the assigned
      // coordinator can have moved the request, so it must have one.
      const err = await refusal(request(status, noCoordinator));

      expect(err.code).toBe('23514');
      expect(err.message).toContain('event_requests_assigned_when_submitted');
    });

    it.each([STATUS.DRAFT, STATUS.CANCELLED])(
      'SCRUM486_TR01_still_accepts_a_request_that_is_%s_with_no_coordinator',
      async (status) => {
        // As 017 already allowed: a draft has not reached anyone, and a draft
        // may be cancelled before it ever does.
        const id = await request(status, noCoordinator);

        expect((await row(id)).assigned_coordinator_id).toBeNull();
      },
    );
  });

  describe('SCRUM-486: a reopened request goes back to the queue', () => {
    it('SCRUM486_TR02_a_resubmitted_request_reaches_the_queue_with_no_coordinator_and_no_reviewer', async () => {
      // TR-02. 022's rejected -> draft clears the decision but keeps the
      // coordinator and the reviewer on the draft, as the first two
      // expectations show. If submission merely stopped choosing a
      // coordinator, it would leave them there and the request would go
      // straight back to its old coordinator, past the Lead. 041 sets both to
      // null.
      const id = await request(STATUS.REJECTED);
      await change(id, STATUS.REJECTED, STATUS.DRAFT, organiser);
      const reopened = await row(id);
      expect(reopened.assigned_coordinator_id).toBe(coordinator);
      expect(reopened.reviewing_coordinator_id).toBe(coordinator);

      const { rows: [again] } = await submit(id);

      expect(again).toMatchObject({
        status: STATUS.SUBMITTED,
        assigned_coordinator_id: null,
        reviewing_coordinator_id: null,
      });
      expect(await assignmentHistory(id)).toHaveLength(0);
    });
  });

  describe('SCRUM-486: submission no longer chooses a coordinator', () => {
    it('SCRUM486_AC1_the_submission_function_in_force_does_not_call_pick_event_coordinator', async () => {
      // AC1-02, read from the function Postgres actually holds after 041, not
      // from the file: one definition in force, and no selection in it.
      const { rows } = await db.query(
        "select prosrc from pg_proc where proname = 'submit_event_request'",
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].prosrc).not.toMatch(/pick_event_coordinator/);
      expect(rows[0].prosrc).not.toMatch(/No coordinator is available/);
    });
  });

  describe('SCRUM-486: the equipment guard refuses a null caller (TR-04)', () => {
    // assert_equipment_editable reads only event_requests, and refuses the
    // caller before it reads any equipment table, so it can be called here.

    it('SCRUM486_TR04_refuses_a_null_caller_on_a_request_with_no_coordinator', async () => {
      // The hole 041 closes: before it, null is not distinct from null, so a
      // null caller on a request with no coordinator passed this check.
      const id = await request(STATUS.SUBMITTED, { assigned_coordinator_id: null });

      const err = await refusal(db.query('select assert_equipment_editable($1, null)', [id]));

      expect(err.code).toBe('42501');
    });

    it('SCRUM486_TR04_still_refuses_a_real_caller_who_is_not_the_coordinator', async () => {
      const id = await request(STATUS.APPROVED);

      const err = await refusal(db.query('select assert_equipment_editable($1, $2)', [id, otherCoordinator]));

      expect(err.code).toBe('42501');
    });

    it('SCRUM486_TR04_still_lets_the_assigned_coordinator_through_on_an_approved_event', async () => {
      // So the guard did not close the door on the person it is for.
      const id = await request(STATUS.APPROVED);

      await db.query('select assert_equipment_editable($1, $2)', [id, coordinator]);
    });
  });

  // -------------------------------------------------------------------------
  // SCRUM-19 (SCRUM-134): 025's constraints and 029's two functions
  // -------------------------------------------------------------------------
  // The cases docs/test-cases/SCRUM-19.md marked "not implemented" because a
  // fake client cannot reach them: what the functions write, in one statement,
  // and that a refusal writes nothing.

  /** A fixed decision time, injected as the service injects it (029). */
  const DECIDED_AT = '2026-06-01T09:00:00.000Z';
  const AFTER_DECISION = '2026-07-01T09:00:00.000Z';
  const BEFORE_DECISION = '2026-05-01T09:00:00.000Z';

  const startReview = (id, by) =>
    db.query('select * from start_event_review($1, $2)', [id, by]);
  const decide = (id, decision, note, by, at = DECIDED_AT) =>
    db.query('select * from decide_event_request($1, $2, $3, $4, $5)', [id, decision, note, by, at]);

  /** A request under review by `coordinator`, starting after the decision time. */
  const underReview = (extra = {}) => request(STATUS.UNDER_REVIEW, {
    reviewing_coordinator_id: coordinator,
    proposed_start: AFTER_DECISION,
    ...extra,
  });

  /** Insert a row with exactly these columns, bypassing every function. */
  async function insertDirectly(cols) {
    const all = { organiser_id: organiser, event_name: 'direct write', submitted_at: new Date().toISOString(), assigned_coordinator_id: coordinator, ...cols };
    const keys = Object.keys(all);
    return db.query(
      `insert into event_requests (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning id`,
      Object.values(all),
    );
  }

  describe("SCRUM-19: 025's five constraints, written to directly", () => {
    // Each write below breaks exactly one constraint and satisfies the other
    // four, so the constraint named in the error is the only one that could
    // have fired. Written straight to the table, as check-event-request-
    // service.js proves 005's constraint: the functions check these rules
    // first, so only a direct write reaches the constraint itself.
    const decided = (overrides) => ({
      reviewing_coordinator_id: coordinator,
      decision: 'approved',
      decision_note: null,
      decided_by: coordinator,
      decided_at: DECIDED_AT,
      ...overrides,
    });

    it.each([
      [
        'decided_status_has_decision',
        'a_decided_status_with_no_decision',
        () => ({ status: STATUS.APPROVED }),
      ],
      [
        'decision_has_decided_status',
        'a_decision_on_a_request_still_under_review',
        () => ({ status: STATUS.UNDER_REVIEW, ...decided({}) }),
      ],
      [
        'rejection_has_reason',
        'a_rejection_with_no_note',
        () => ({ status: STATUS.REJECTED, ...decided({ decision: 'rejected', decision_note: null }) }),
      ],
      [
        'rejection_has_reason',
        'a_rejection_with_a_blank_note',
        () => ({ status: STATUS.REJECTED, ...decided({ decision: 'rejected', decision_note: '   ' }) }),
      ],
      [
        'decided_by_is_reviewer',
        'a_decider_who_is_not_the_reviewer',
        () => ({ status: STATUS.APPROVED, ...decided({ decided_by: otherCoordinator }) }),
      ],
      [
        'decided_by_is_reviewer',
        'a_decider_while_the_reviewer_is_null',
        () => ({ status: STATUS.APPROVED, ...decided({ reviewing_coordinator_id: null }) }),
      ],
      [
        'decision_fields_together',
        'a_decision_without_decided_by_or_decided_at',
        () => ({ status: STATUS.APPROVED, ...decided({ decided_by: null, decided_at: null }) }),
      ],
    ])('SCRUM19_AC9_event_requests_%s_refuses_%s', async (constraint, _label, cols) => {
      // cols is a function so the users exist when it runs: it.each builds
      // its table before beforeAll has created them.
      const err = await refusal(insertDirectly(cols()));

      expect(err.code).toBe('23514');
      expect(err.message).toContain(`event_requests_${constraint}`);
    });

    it('SCRUM19_AC9_a_cancelled_request_may_carry_no_decision', async () => {
      // Cancelled straight from submitted, before anyone decided anything.
      const { rows: [r] } = await insertDirectly({ status: STATUS.CANCELLED });

      expect((await row(r.id)).decision).toBeNull();
    });

    it('SCRUM19_AC9_a_cancelled_request_may_keep_an_earlier_approval', async () => {
      // Approved, then cancelled: the approval stays on record.
      const { rows: [r] } = await insertDirectly({ status: STATUS.CANCELLED, ...decided({}) });

      expect((await row(r.id)).decision).toBe('approved');
    });
  });

  describe('SCRUM-19 AC7: the status function cannot record a decision', () => {
    it.each([STATUS.APPROVED, STATUS.REJECTED])(
      'SCRUM19_AC7_the_status_function_cannot_move_a_request_to_%s',
      async (to) => {
        // Why 029 exists. change_event_request_status writes the status and
        // nothing else, so on a database with 025 the row it would leave, a
        // decided status with no decision, is refused. Nothing is written.
        const id = await underReview();
        const before = await row(id);

        const err = await refusal(change(id, STATUS.UNDER_REVIEW, to, coordinator));

        expect(err.code).toBe('23514');
        expect(err.message).toContain('event_requests_decided_status_has_decision');
        expect(await row(id)).toEqual(before);
        expect(await statusHistory(id)).toHaveLength(0);
      },
    );
  });

  describe('SCRUM-19 AC1: start_event_review', () => {
    it('SCRUM19_AC1_starts_the_review_writing_the_status_the_reviewer_and_one_history_row', async () => {
      const id = await request(STATUS.SUBMITTED);

      const { rows: [started] } = await startReview(id, coordinator);

      expect(started).toMatchObject({ status: STATUS.UNDER_REVIEW, reviewing_coordinator_id: coordinator });
      expect(await row(id)).toMatchObject({ status: STATUS.UNDER_REVIEW, reviewing_coordinator_id: coordinator });
      const history = await statusHistory(id);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        previous_status: STATUS.SUBMITTED,
        new_status: STATUS.UNDER_REVIEW,
        changed_by: coordinator,
        reason: null,
      });
    });

    it.each([
      ['a_null_caller', STATUS.SUBMITTED, () => null, '42501'],
      ['a_coordinator_who_is_not_assigned', STATUS.SUBMITTED, () => otherCoordinator, '42501'],
      // A draft has no coordinator, so the caller check, which comes first,
      // refuses it: nobody is its assigned coordinator.
      ['a_draft_which_has_no_coordinator', STATUS.DRAFT, () => coordinator, '42501'],
      ...[
        STATUS.UNDER_REVIEW,
        STATUS.PENDING_CLARIFICATION,
        STATUS.APPROVED,
        STATUS.REJECTED,
        STATUS.CONFIRMED,
        STATUS.COMPLETED,
        STATUS.CANCELLED,
      ].map((status) => [`a_request_that_is_${status}`, status, () => coordinator, '55000']),
    ])('SCRUM19_AC1_start_review_refuses_%s_and_writes_nothing', async (_label, status, caller, code) => {
      const id = await request(status);
      const before = await row(id);

      const err = await refusal(startReview(id, caller()));

      expect(err.code).toBe(code);
      if (code === '55000') expect(err.message).toContain(`status ${status}`);
      expect(await row(id)).toEqual(before);
      expect(await statusHistory(id)).toHaveLength(0);
    });

    it('SCRUM19_AC1_start_review_reports_a_missing_request_as_not_found', async () => {
      const err = await refusal(startReview('00000000-0000-0000-0000-000000000000', coordinator));

      expect(err.code).toBe('P0002');
    });
  });

  describe('SCRUM-19: decide_event_request', () => {
    it.each([
      ['approved', 'Approved as submitted.'],
      ['rejected', 'The venue cannot hold the expected attendance.'],
    ])('SCRUM19_AC7_records_%s_with_the_status_all_four_decision_fields_and_one_history_row', async (decision, note) => {
      // AC7 and AC9 in one statement: the status, the decision, the note, who
      // and when, and the history row with the note as its reason.
      const id = await underReview();

      const { rows: [decided] } = await decide(id, decision, note, coordinator);

      const stored = await row(id);
      expect(decided.status).toBe(decision);
      expect(stored).toMatchObject({
        status: decision,
        decision,
        decision_note: note,
        decided_by: coordinator,
        reviewing_coordinator_id: coordinator,
      });
      expect(stored.decided_at.toISOString()).toBe(DECIDED_AT);
      const history = await statusHistory(id);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        previous_status: STATUS.UNDER_REVIEW,
        new_status: decision,
        changed_by: coordinator,
        reason: note,
      });
    });

    it('SCRUM19_AC5_stores_a_blank_approval_note_as_null_and_still_records_the_approval', async () => {
      // A note of spaces would fail 021's reason_not_blank on the history row;
      // 029 trims it to null first, so the approval goes through.
      const id = await underReview();

      await decide(id, 'approved', '   ', coordinator);

      expect((await row(id)).decision_note).toBeNull();
      expect((await statusHistory(id))[0].reason).toBeNull();
    });

    it('SCRUM19_AC6_allows_a_rejection_whatever_the_start_date', async () => {
      // The date rule is about approving; an event whose date has passed can
      // still be turned down.
      const id = await underReview({ proposed_start: BEFORE_DECISION });

      await decide(id, 'rejected', 'The date has passed.', coordinator);

      expect((await row(id)).status).toBe(STATUS.REJECTED);
    });

    it.each([
      ['the_caller_is_a_coordinator_who_is_not_assigned', () => underReview(), (id) => decide(id, 'approved', null, otherCoordinator), '42501'],
      ['the_caller_is_null', () => underReview(), (id) => decide(id, 'approved', null, null), '42501'],
      ['someone_else_is_recorded_as_the_reviewer', () => underReview({ reviewing_coordinator_id: otherCoordinator }), (id) => decide(id, 'approved', null, coordinator), '42501'],
      ['the_request_is_submitted_not_under_review', () => request(STATUS.SUBMITTED, { proposed_start: AFTER_DECISION }), (id) => decide(id, 'approved', null, coordinator), '55000'],
      ['the_request_is_pending_clarification', () => request(STATUS.PENDING_CLARIFICATION, { proposed_start: AFTER_DECISION }), (id) => decide(id, 'approved', null, coordinator), '55000'],
      ['the_request_is_already_approved', () => request(STATUS.APPROVED, { proposed_start: AFTER_DECISION }), (id) => decide(id, 'rejected', 'Changed my mind.', coordinator), '55000'],
      ['the_request_is_already_rejected', () => request(STATUS.REJECTED, { proposed_start: AFTER_DECISION }), (id) => decide(id, 'approved', null, coordinator), '55000'],
      ['a_rejection_has_no_reason', () => underReview(), (id) => decide(id, 'rejected', null, coordinator), '22023'],
      ['a_rejection_has_a_blank_reason', () => underReview(), (id) => decide(id, 'rejected', '   ', coordinator), '22023'],
      ['the_decision_is_null', () => underReview(), (id) => decide(id, null, null, coordinator), '22004'],
      ['the_decision_time_is_null', () => underReview(), (id) => decide(id, 'approved', null, coordinator, null), '22004'],
    ])('SCRUM19_AC3_refuses_a_decision_when_%s_and_writes_nothing', async (_label, setUp, attempt, code) => {
      // Status, all four decision fields, the reviewer, and the history, as
      // they were. A fake client returns whatever it is given and cannot show
      // this; only a real database can.
      const id = await setUp();
      const before = await row(id);

      const err = await refusal(attempt(id));

      expect(err.code).toBe(code);
      expect(await row(id)).toEqual(before);
      expect(await statusHistory(id)).toHaveLength(0);
    });

    it.each([
      ['has_passed', BEFORE_DECISION],
      ['is_missing', null],
      ['is_exactly_the_decision_time', DECIDED_AT],
    ])('SCRUM19_AC6_refuses_an_approval_whose_start_%s_and_writes_nothing', async (_label, start) => {
      // Measured against the injected decision time, never the database clock,
      // so each case is the same whenever it runs. A start at the decision time
      // counts as passed: the event would already be under way.
      const id = await underReview({ proposed_start: start });
      const before = await row(id);

      const err = await refusal(decide(id, 'approved', null, coordinator));

      expect(err.code).toBe('55000');
      expect(err.message).toContain('start date has passed or is missing');
      expect(err.message).toContain('Agree a new date with the organiser, or reject the request');
      expect(await row(id)).toEqual(before);
      expect(await statusHistory(id)).toHaveLength(0);
    });

    it('SCRUM19_AC3_names_the_current_status_when_the_request_is_not_under_review', async () => {
      const id = await request(STATUS.PENDING_CLARIFICATION, { proposed_start: AFTER_DECISION });

      const err = await refusal(decide(id, 'approved', null, coordinator));

      expect(err.message).toContain('status pending_clarification');
    });
  });

  describe('SCRUM-19 AC1: the reviewer is filled in, never overwritten', () => {
    // 029 fills in an empty reviewer because a request can reach under_review
    // without one: through change_event_request_status, which is how
    // requestEventClarification moved a submitted request before SCRUM-19, and
    // how the Organiser's reply returns one from clarification.

    it('SCRUM19_AC1_fills_in_an_empty_reviewer_with_the_decider', async () => {
      // The path that leaves it empty, end to end: submitted, then under review
      // through the status function, which sets no reviewer.
      const id = await request(STATUS.SUBMITTED, { proposed_start: AFTER_DECISION });
      await change(id, STATUS.SUBMITTED, STATUS.UNDER_REVIEW, coordinator);
      expect((await row(id)).reviewing_coordinator_id).toBeNull();

      await decide(id, 'approved', null, coordinator);

      expect(await row(id)).toMatchObject({
        status: STATUS.APPROVED,
        reviewing_coordinator_id: coordinator,
        decided_by: coordinator,
      });
    });

    it('SCRUM19_AC1_never_overwrites_a_reviewer_who_is_someone_else', async () => {
      const id = await underReview({ reviewing_coordinator_id: otherCoordinator });

      const err = await refusal(decide(id, 'approved', null, coordinator));

      expect(err.code).toBe('42501');
      expect(err.message).toContain('under review by another coordinator');
      expect((await row(id)).reviewing_coordinator_id).toBe(otherCoordinator);
    });

    it('SCRUM19_AC1_leaves_a_reviewer_who_is_the_decider_as_they_are', async () => {
      const id = await underReview();

      await decide(id, 'rejected', 'Not this term.', coordinator);

      expect((await row(id)).reviewing_coordinator_id).toBe(coordinator);
    });
  });
});


describe('SCRUM-318: a rejected request reopens on a database that has SCRUM-19\'s decision columns', () => {
  it('SCRUM318_clears_the_decision_with_the_status_and_runs_022_again_without_error', async () => {
    const db = await databaseBefore020();
    try {
      // databaseBefore020 now applies the real 025 (SCRUM-134), so the
      // decision columns and their constraints are 025's own rather than a
      // hand-written copy. A rejected request has a decision and a draft may
      // not, so the reopen has to clear it in the same statement.
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
        // 025 as first written counts planning as decided, so before 020 a
        // planning row carries the approval that put it there.
        `insert into event_requests
           (organiser_id, event_name, status, submitted_at, assigned_coordinator_id, reviewing_coordinator_id,
            decision, decided_by, decided_at)
         values ($1, 'was planning', 'planning', now(), $2, $2, 'approved', $2, now()) returning id`,
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
