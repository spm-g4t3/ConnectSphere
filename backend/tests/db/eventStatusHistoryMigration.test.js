/**
 * SCRUM-321: migration 021 records every status change, read from the
 * migration's SQL text.
 *
 * CI has no database, so -- like the other tests in this folder -- this reads
 * the file with every `--` comment stripped (a rule that exists only in a
 * comment does not count), whitespace collapsed and lower-cased. What it cannot
 * see, that a refused or failed change writes no history row and that the
 * status and the row land together, is proved by running the functions against
 * a real Postgres, and by `npm run request:check`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(here, '../../db/migrations');

const sql = (name) =>
  readFileSync(resolve(MIGRATIONS, name), 'utf8')
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();

const migration = sql('021_event_status_history.sql');

/** One function's text: from its `create or replace function` to the `$$;` that ends it. */
function functionBody(name) {
  const start = migration.indexOf(`create or replace function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  return migration.slice(start, migration.indexOf('$$;', migration.indexOf('$$', start) + 2));
}

describe('SCRUM-321 AC5: what each history row records', () => {
  const table = migration.slice(
    migration.indexOf('create table if not exists event_request_status_history'),
    migration.indexOf('); ', migration.indexOf('create table if not exists event_request_status_history')),
  );

  it.each([
    ['the event', /event_request_id uuid not null references event_requests \(id\) on delete restrict/],
    ['the previous status', /previous_status event_request_status not null/],
    ['the new status', /new_status event_request_status not null/],
    ['the user who caused it', /changed_by uuid not null references auth\.users \(id\) on delete restrict/],
    ['the reason, optional', /reason text(?!\s+not null)/],
    ['the date and time, set by the database', /created_at timestamptz not null default now\(\)/],
  ])('records %s', (_label, pattern) => {
    expect(table).toMatch(pattern);
  });

  it('refuses a row that records no change', () => {
    expect(migration).toMatch(/add constraint event_request_status_history_status_changes check \( previous_status <> new_status \)/);
  });

  it('refuses a blank reason', () => {
    expect(migration).toMatch(/event_request_status_history_reason_not_blank check \( reason is null or length\(trim\(reason\)\) > 0 \)/);
  });

  it('is deny-all and indexed for reading one event oldest first', () => {
    expect(migration).toMatch(/alter table event_request_status_history enable row level security/);
    expect(migration).toMatch(/on event_request_status_history \(event_request_id, created_at\)/);
  });

  it('is a separate table from the assignment history', () => {
    expect(migration).not.toMatch(/alter table event_request_assignment_history/);
    expect(migration).not.toMatch(/create table[^;]*event_request_assignment_history/);
  });
});


describe('SCRUM-321 AC3: change_event_request_status writes the status and its history together', () => {
  const body = functionBody('change_event_request_status');

  it('is one function: the status update and the history insert are in the same body', () => {
    expect(body.match(/update event_requests set/g)).toHaveLength(1);
    expect(body.match(/insert into event_request_status_history/g)).toHaveLength(1);
  });

  it('writes the history after the status update, so a failure of either rolls back both', () => {
    expect(body.indexOf('insert into event_request_status_history'))
      .toBeGreaterThan(body.indexOf('update event_requests set'));
  });

  it('records the previous status the caller expected, the new status, the user and the reason', () => {
    expect(body).toMatch(
      /insert into event_request_status_history \(event_request_id, previous_status, new_status, changed_by, reason\) values \(p_event_request_id, p_expected_status, p_new_status, p_changed_by, p_reason\)/,
    );
  });

  it('locks the row, then refuses unless it is still in the status the caller saw', () => {
    const lock = body.indexOf('for update');
    const guard = body.indexOf('v_request.status <> p_expected_status');

    expect(lock).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(lock);
    expect(guard).toBeLessThan(body.indexOf('update event_requests set'));
    expect(body).toMatch(/using errcode = 'object_not_in_prerequisite_state'/);
  });

  it('writes only a row still in that status', () => {
    expect(body).toMatch(/where id = p_event_request_id and status = p_expected_status returning/);
  });

  it('refuses a missing status or user before it writes', () => {
    const refusal = body.indexOf('p_changed_by is null');

    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(body.indexOf('update event_requests set'));
    expect(body).toMatch(/using errcode = 'null_value_not_allowed'/);
  });

  it('leaves submitting to submit_event_request', () => {
    expect(body).toMatch(/if p_new_status = 'submitted' then raise exception[^;]*using errcode = 'invalid_parameter_value'/);
  });

  it("021's own definition holds no transition table; 022 replaces it with one that does", () => {
    expect(body).not.toMatch(/allowed_transitions|can_transition/);
    expect(body).not.toMatch(/when p_expected_status = '(draft|submitted|approved|confirmed|rejected)'/);
  });

  it('does not touch assignment, the coordinator or the submission time', () => {
    expect(body).not.toMatch(/insert into event_request_assignment_history/);
    expect(body).not.toMatch(/assigned_coordinator_id = /);
    expect(body).not.toMatch(/submitted_at = /);
    expect(body).not.toMatch(/pick_event_coordinator/);
  });

  it('never raises with P0001, which the service reads as "no coordinator available"', () => {
    expect(body).not.toMatch(/errcode = 'raise_exception'|errcode = 'p0001'/);
    // A raise with no errcode defaults to P0001.
    const raises = [...body.matchAll(/raise exception [^;]*;/g)].map((m) => m[0]);
    expect(raises.length).toBeGreaterThan(0);
    for (const raise of raises) expect(raise).toMatch(/using errcode/);
  });

  it('sets the clarification note with the status, so the two cannot disagree', () => {
    expect(body).toMatch(/clarification_note = case when p_new_status = 'pending_clarification' then p_reason when p_expected_status = 'pending_clarification' then null else clarification_note end/);
  });
});


describe('SCRUM-321 with SCRUM-327: submitting records the status change once, beside the assignment', () => {
  const body = functionBody('submit_event_request');

  it('inserts the draft -> submitted status history row exactly once, after the update', () => {
    const rows = [...body.matchAll(/insert into event_request_status_history/g)];

    expect(rows).toHaveLength(1);
    expect(rows[0].index).toBeGreaterThan(body.indexOf('update event_requests set'));
    expect(body).toMatch(/values \(p_event_request_id, 'draft', 'submitted', p_changed_by, null\)/);
  });

  it('still writes the assignment history exactly once', () => {
    expect(body.match(/insert into event_request_assignment_history/g)).toHaveLength(1);
  });

  it('requires the user making the submission', () => {
    expect(body).toMatch(/if p_changed_by is null then raise exception/);
  });

  it('replaces the two-argument function so there is no way to submit without history', () => {
    expect(migration).toMatch(/drop function if exists submit_event_request\(uuid, timestamptz\)/);
    expect(migration.indexOf('drop function if exists submit_event_request'))
      .toBeLessThan(migration.indexOf('create or replace function submit_event_request('));
  });
});


describe('SCRUM-321: only the lifecycle and decision functions write the status history', () => {
  it('has no other writer in any migration', () => {
    const writers = readdirSync(MIGRATIONS)
      .filter((name) => name.endsWith('.sql'))
      .flatMap((name) => {
        const count = (sql(name).match(/insert into event_request_status_history/g) ?? []).length;
        return count > 0 ? [`${name}: ${count}`] : [];
      });

    expect(writers).toEqual([
      '021_event_status_history.sql: 2',
      // 022 replaces change_event_request_status; 021's copy is superseded, not
      // a second live writer.
      '022_event_status_transitions.sql: 1',
      // SCRUM-19. start_event_review and decide_event_request each write more
      // than a status: the reviewer, and the four decision fields, which 025's
      // constraints require in the same statement as the status. So each
      // writes its own history row, in the shape change_event_request_status
      // uses, rather than delegating to a function that cannot write those
      // columns. The same argument 021 makes for submit_event_request. One
      // row per function, so two.
      '029_event_request_decisions_functions.sql: 2',
      // SCRUM-490 records each immutable Safety Officer response in the same
      // transaction as the status transition it causes.
      '058_safety_review.sql: 2',
    ]);
  });
});
