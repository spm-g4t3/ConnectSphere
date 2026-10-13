/**
 * SCRUM-487 (SCRUM-546, follow-up): every value of the event_request_status
 * enum is classified, so a new status cannot be left out of the Lead's
 * coordinator overview without anyone noticing.
 *
 * The risk. The overview's counts, its list and its status filter are built
 * from ACTIVE_EVENT_STATUSES and FINISHED_EVENT_STATUSES
 * (backend/src/services/eventRequestService.js), which are written by hand.
 * When SCRUM-488 adds safety_review and safety_approved to the enum, events in
 * those statuses are left out of every count and every list unless someone
 * also adds them there, and nothing fails: the reads just return less. This
 * test turns that silent omission into a red test whose message says what to
 * do. SCRUM-488 has a subtask pointing here (SCRUM-487 D13).
 *
 * Why it reads the migrations' text, not a PGlite database. A PGlite test
 * applies a list of migrations kept by hand (scrum487OverviewDatabase.test.js
 * has one). SCRUM-488's migration would reach that test only if its author
 * remembered to add it to the list, which is the same kind of hand-kept list
 * this test exists to guard. Reading every file in db/migrations/ picks up a
 * new `alter type ... add value` the moment the file exists. Rejected: a
 * PGlite test, for that reason. The reading follows
 * eventStatusLifecycleMigration.test.js (SCRUM-320): comments stripped (a
 * value that exists only in a comment does not count; 001's own comment shows
 * the syntax with a value 'x'), whitespace collapsed, lower-cased.
 *
 * A statement this test does not understand is a failure, not a skip: an
 * `alter type event_request_status` that is not `add value` (a rename, say)
 * fails with a message saying the test must be taught it. A guard that quietly
 * under-reads is worse than none.
 *
 * The lists are imported, not parsed from the service's source: the test
 * checks the arrays the reads actually use. The service resolves its Supabase
 * client lazily, so importing it needs no credentials.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { STATUS, isKnownStatus } from '../../src/domain/eventRequestStatus.js';
import {
  ACTIVE_EVENT_STATUSES,
  FINISHED_EVENT_STATUSES,
} from '../../src/services/eventRequestService.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(here, '../../db/migrations');

/** A migration's SQL as these tests read it: no comments, one space, lower case. */
function readMigration(name) {
  return readFileSync(resolve(MIGRATIONS, name), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const TYPE = String.raw`type (?:public\.)?event_request_status`;
const CREATE = new RegExp(String.raw`create ${TYPE} as enum \(([^)]*)\)`, 'g');
const ADD_VALUE = new RegExp(
  String.raw`alter ${TYPE} add value (?:if not exists )?'([a-z_]+)'(?: (?:before|after) '[a-z_]+')?`, 'g',
);
const ANY_ALTER = new RegExp(String.raw`alter ${TYPE}\b[^;]*`, 'g');

/**
 * The enum's values, in the order the migrations give them, read from every
 * numbered migration in filename order.
 */
function readEnum() {
  const files = readdirSync(MIGRATIONS).filter((name) => /^\d{3}_.*\.sql$/.test(name)).sort();
  const values = [];
  let creates = 0;
  const unreadable = [];

  for (const file of files) {
    const sql = readMigration(file);

    for (const [, list] of sql.matchAll(CREATE)) {
      creates += 1;
      values.push(...[...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    }

    const added = [...sql.matchAll(ADD_VALUE)];
    values.push(...added.map((m) => m[1]));
    // Every `alter type event_request_status` must be one this test read.
    const alters = [...sql.matchAll(ANY_ALTER)].map((m) => m[0].trim());
    const understood = new Set(added.map((m) => m[0].trim()));
    for (const statement of alters) {
      if (!understood.has(statement)) unreadable.push(`${file}: ${statement}`);
    }
  }

  return { values, creates, unreadable };
}

const { values: ENUM, creates: CREATES, unreadable: UNREADABLE } = readEnum();

// The four buckets. Every enum value is in exactly one.
const BUCKETS = {
  // Never on the overview: an unsubmitted request has no coordinator.
  draft: [STATUS.DRAFT],
  active: [...ACTIVE_EVENT_STATUSES],
  finished: [...FINISHED_EVENT_STATUSES],
  // Still in the enum, because Postgres cannot drop an enum value, but refused
  // for any row by 020's event_requests_status_in_lifecycle constraint
  // (SCRUM-320). The last test proves it is not a place to hide a live status.
  retired: ['planning'],
};
const CLASSIFIED = Object.values(BUCKETS).flat();

describe('SCRUM-487: every event status is classified for the overview', () => {
  it('SCRUM487_AC2_every_event_status_in_the_database_is_draft_active_finished_or_retired', () => {
    // First, the guard on the guard: one create type, and no alter type it
    // could not read. A rename, a second create, or a form not taught here
    // fails here, before any classification is trusted.
    expect(CREATES, 'expected exactly one create type event_request_status as enum (...) across the migrations').toBe(1);
    expect(
      UNREADABLE,
      'scrum487StatusClassification.test.js cannot read these statements about event_request_status. '
        + 'It understands only "create type ... as enum (...)" and "alter type ... add value \'x\'". '
        + 'Teach it the new form before relying on it.',
    ).toEqual([]);
    expect(ENUM.length).toBeGreaterThan(0);

    const missing = ENUM.filter((value) => !CLASSIFIED.includes(value));
    const message = missing.map((value) => (
      `"${value}" is in the event_request_status enum but in no bucket. If it is an active status, `
        + 'add it to ACTIVE_EVENT_STATUSES (backend/src/services/eventRequestService.js), or the Lead\'s '
        + 'coordinator overview (SCRUM-487) silently leaves its events out; if it is a finished one, to '
        + 'FINISHED_EVENT_STATUSES. Give it a STATUS_DISPLAY entry too (backend/src/domain/eventRequestStatus.js).'
    )).join('\n');

    expect(missing, message).toEqual([]);
  });

  it('SCRUM487_AC2_no_status_is_in_two_buckets', () => {
    const twice = [...new Set(CLASSIFIED.filter((value, i) => CLASSIFIED.indexOf(value) !== i))];

    expect(twice, `in more than one bucket: ${twice.join(', ')}`).toEqual([]);
  });

  it('SCRUM487_AC3_every_listed_status_exists_in_the_database', () => {
    // A typo, or a status added to a list before its migration: the read
    // would fail on it (22P02, SCRUM-487 D4).
    const unknown = [...ACTIVE_EVENT_STATUSES, ...FINISHED_EVENT_STATUSES].filter((value) => !ENUM.includes(value));

    expect(unknown, `listed but not in the event_request_status enum: ${unknown.join(', ')}`).toEqual([]);
  });

  it('SCRUM487_AC2_every_live_status_has_a_display_label', () => {
    // Every value but the retired one can be on a row, so every one needs
    // words; otherwise the overview's column heading reads "Unknown" (D9).
    const unlabelled = ENUM.filter((value) => !BUCKETS.retired.includes(value) && !isKnownStatus(value));

    expect(unlabelled, `no STATUS_DISPLAY entry in backend/src/domain/eventRequestStatus.js for: ${unlabelled.join(', ')}`).toEqual([]);
  });

  it('SCRUM487_AC2_the_retired_status_is_refused_by_the_lifecycle_constraint', () => {
    // Read 020 as eventStatusLifecycleMigration.test.js does: the quoted
    // values of the first in ( ... ) after the constraint.
    const sql = readMigration('020_event_status_lifecycle.sql');
    const at = sql.indexOf('add constraint event_requests_status_in_lifecycle');
    expect(at, 'event_requests_status_in_lifecycle not found in 020').toBeGreaterThan(-1);
    const open = sql.indexOf('(', sql.indexOf(' in ', at));
    const allowed = [...sql.slice(open, sql.indexOf(')', open)).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

    expect(allowed.length).toBeGreaterThan(0);
    for (const retired of BUCKETS.retired) expect(allowed).not.toContain(retired);
  });
});
