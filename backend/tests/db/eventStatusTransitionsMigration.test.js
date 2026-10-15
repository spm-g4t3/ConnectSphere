/**
 * SCRUM-318: migration 022 makes the database enforce the status lifecycle,
 * read from the migration's SQL text.
 *
 * Like the other migration tests, this reads the file with every `--` comment
 * stripped, so a rule that exists only in a comment does not count. What the
 * functions do when they run is proved against a real Postgres in
 * eventStatusLifecycleDatabase.test.js.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const sql = (name) =>
  readFileSync(resolve(here, '../../db/migrations', name), 'utf8')
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();

const migration = sql('022_event_status_transitions.sql');

function functionBody(name) {
  const start = migration.indexOf(`create or replace function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  return migration.slice(start, migration.indexOf('$$;', migration.indexOf('$$', start) + 2));
}

describe('SCRUM-318: the transition table in SQL', () => {
  const body = functionBody('event_request_status_allows');

  it('lists sixteen transitions', () => {
    expect(body.match(/\('[a-z_]+', '[a-z_]+'\)/g)).toHaveLength(16);
  });

  it('is immutable, because the answer depends only on its arguments', () => {
    expect(body).toMatch(/language sql immutable/);
  });

  it('names no planning status', () => {
    expect(body).not.toMatch(/planning/);
  });
});

describe('SCRUM-318: change_event_request_status refuses an illegal move', () => {
  const body = functionBody('change_event_request_status');

  it('asks the table after the stale-status check and before it writes', () => {
    const stale = body.indexOf('v_request.status <> p_expected_status');
    const allows = body.indexOf('event_request_status_allows(');
    const write = body.indexOf('update event_requests');

    expect(stale).toBeGreaterThan(-1);
    expect(allows).toBeGreaterThan(stale);
    expect(allows).toBeLessThan(write);
  });

  it('refuses with a SQLSTATE the service reads as a 409, never P0001', () => {
    const refusal = body.slice(body.indexOf('if not event_request_status_allows('));
    const raise = refusal.slice(0, refusal.indexOf('end if'));

    expect(raise).toMatch(/using errcode = 'object_not_in_prerequisite_state'/);
    expect(body).not.toMatch(/errcode = 'raise_exception'|errcode = 'p0001'/);
    for (const statement of body.match(/raise exception [^;]*;/g)) {
      expect(statement).toMatch(/using errcode/);
    }
  });

  it('names the status the request is in when it refuses', () => {
    expect(body).toMatch(/has status %, which cannot change to %', p_event_request_id, v_request\.status, p_new_status/);
  });

  it('still leaves submitting to submit_event_request', () => {
    expect(body).toMatch(/if p_new_status = 'submitted' then raise exception[^;]*using errcode = 'invalid_parameter_value'/);
  });

  it('writes the status and its history row once each, history after the update', () => {
    expect(body.match(/insert into event_request_status_history/g)).toHaveLength(1);
    expect(body.indexOf('insert into event_request_status_history'))
      .toBeGreaterThan(body.lastIndexOf('returning * into v_request'));
  });

  it('records the status the caller expected, the new status, the user and the reason', () => {
    expect(body).toMatch(
      /insert into event_request_status_history \(event_request_id, previous_status, new_status, changed_by, reason\) values \(p_event_request_id, p_expected_status, p_new_status, p_changed_by, p_reason\)/,
    );
  });

  it('does not touch assignment, the coordinator or the selection rule', () => {
    expect(body).not.toMatch(/insert into event_request_assignment_history/);
    expect(body).not.toMatch(/assigned_coordinator_id = /);
    expect(body).not.toMatch(/pick_event_coordinator/);
  });

  it('clears the submission time when a request is reopened as a draft', () => {
    expect(body).toMatch(/submitted_at = case when p_new_status = 'draft' then null else submitted_at end/);
  });

  it('clears the decision with the status in one statement, only where those columns exist', () => {
    expect(body).toMatch(/column_name = 'decision'/);
    expect(body).toMatch(/set status = \$1, submitted_at = null, decision = null, decision_note = null, decided_by = null, decided_at = null/);
  });

  it('keeps the clarification note with the status', () => {
    expect(body).toMatch(/clarification_note = case when p_new_status = 'pending_clarification' then p_reason when p_expected_status = 'pending_clarification' then null else clarification_note end/);
  });
});

describe('SCRUM-318: the status history holds only the nine statuses', () => {
  it('constrains both columns, without planning', () => {
    const constraint = migration.slice(
      migration.indexOf('add constraint event_request_status_history_statuses_in_lifecycle'),
    );
    const lists = [...constraint.matchAll(/(previous_status|new_status) in \(([^)]*)\)/g)];

    expect(lists.map((m) => m[1])).toEqual(['previous_status', 'new_status']);
    for (const [, , list] of lists) {
      expect([...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual([
        'approved', 'cancelled', 'completed', 'confirmed', 'draft',
        'pending_clarification', 'rejected', 'submitted', 'under_review',
      ]);
    }
  });

  it('is guarded so the migration can run twice', () => {
    expect(migration).toMatch(/if not exists \( select 1 from pg_constraint where conname = 'event_request_status_history_statuses_in_lifecycle'/);
  });
});

describe('SCRUM-318: what migration 022 leaves alone', () => {
  it('creates no table and does not touch the enum', () => {
    expect(migration).not.toMatch(/create table/);
    expect(migration).not.toMatch(/alter type/);
  });

  it('does not redefine submit_event_request or the coordinator functions', () => {
    expect(migration).not.toMatch(/function submit_event_request/);
    expect(migration).not.toMatch(/function pick_event_coordinator/);
    expect(migration).not.toMatch(/function reassign_event_request/);
  });

  it('tells the API about the new function', () => {
    expect(migration).toMatch(/notify pgrst, 'reload schema'/);
  });
});


describe('SCRUM-488 AC2: migration 063 restates the transition table', () => {
  const safety = sql('063_safety_transitions.sql');
  const start = safety.indexOf('create or replace function event_request_status_allows(');
  const body = safety.slice(start, safety.indexOf('$$;', safety.indexOf('$$', start) + 2));
  const pairs = [...body.matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)].map((m) => `${m[1]}>${m[2]}`);

  it('replaces 022\'s function with the same signature, so no overload is left behind', () => {
    expect(start).toBeGreaterThan(-1);
    expect(safety.match(/create or replace function/g)).toHaveLength(1);
    expect(body).toMatch(/event_request_status_allows\( p_from event_request_status, p_to event_request_status \) returns boolean language sql immutable/);
  });

  it('lists twenty-two transitions, once each', () => {
    expect(pairs).toHaveLength(22);
    expect(new Set(pairs).size).toBe(22);
  });

  it('drops approved to confirmed and adds the seven safety moves', () => {
    expect(pairs).not.toContain('approved>confirmed');
    expect(pairs).toEqual(expect.arrayContaining([
      'approved>safety_review', 'safety_review>safety_approved', 'safety_review>approved',
      'safety_approved>approved', 'safety_approved>confirmed',
      'safety_review>cancelled', 'safety_approved>cancelled',
    ]));
  });

  it('keeps every other transition of 022', () => {
    const original = functionBody('event_request_status_allows');
    const before = [...original.matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)].map((m) => `${m[1]}>${m[2]}`);

    expect(before.filter((pair) => !pairs.includes(pair))).toEqual(['approved>confirmed']);
  });

  it('does not let either safety status be rejected, which SCRUM-347 has not decided', () => {
    expect(pairs).not.toContain('safety_review>rejected');
    expect(pairs).not.toContain('safety_approved>rejected');
  });

  it('names no planning status and compares as text', () => {
    expect(body).not.toMatch(/planning/);
    expect(body).toMatch(/t\.from_status = p_from::text and t\.to_status = p_to::text/);
  });

  it('redefines nothing else, so locking, stale-status checks, reasons and history are 022\'s', () => {
    expect(safety).not.toMatch(/function change_event_request_status/);
    expect(safety).not.toMatch(/create table|alter table|alter type/);
    expect(safety).toMatch(/notify pgrst, 'reload schema'/);
  });
});
