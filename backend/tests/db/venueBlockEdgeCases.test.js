/**
 * SCRUM-17 AC3 edge cases, read from the migrations' SQL text (SCRUM-132).
 *
 * CI has no database, so -- like venueBlockBookingWritesTraceability.test.js
 * -- this reads 013, 014 and 015 with every `--` comment stripped (a rule that
 * exists only in a comment does not count), whitespace collapsed and
 * lower-cased, and looks only inside `create or replace function` bodies.
 *
 * Two rules, over every booking-period predicate on alias b
 * (`b.starts_at <op> ...`, `b.ends_at <op> ...`): the conflict helper, the
 * booking locks in create_venue_block (013, 014) and update_venue_block (015),
 * and the flag update in flag_bookings_for_block (014).
 *
 *  1. Strict < and > only, never <= or >=. Periods are half-open [start, end),
 *     so a booking that ends exactly when the block starts -- or starts
 *     exactly when it ends -- touches it and is never a conflict.
 *  2. Every WHERE holding such a predicate also requires b.status =
 *     'approved'. Once a booking is flagged_for_review it no longer conflicts,
 *     so a later amendment does not ask to override it a second time.
 *
 * The live proof of both is `npm run venue-blocks:check`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const MIGRATIONS = [
  '013_venue_block_booking_conflicts.sql',
  '014_booking_review_notifications.sql',
  '015_venue_block_amend_remove.sql',
];

/** A migration with every `--` comment stripped, whitespace collapsed, lower-cased. */
function normalised(name) {
  return readFileSync(resolve(here, `../../db/migrations/${name}`), 'utf8')
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Every function body: from `create or replace function` to the `$$;` that ends it. */
function functionBodies(sql) {
  const bodies = [];
  const head = /create or replace function (\w+)\(/g;
  for (const match of sql.matchAll(head)) {
    const open = sql.indexOf('$$', match.index);
    const close = sql.indexOf('$$;', open + 2);
    bodies.push({ fn: match[1], body: sql.slice(open + 2, close) });
  }
  return bodies;
}

/**
 * `b.starts_at` or `b.ends_at` followed by any comparison operator. The word
 * boundary keeps vb.starts_at (a block column) out; a select list or an
 * ORDER BY has no operator after the column and does not match.
 */
const BOOKING_PERIOD_PREDICATE = /\bb\.(starts_at|ends_at)\s*(<=|>=|<>|!=|=|<|>)/g;

/** Where a WHERE clause ends, after the predicate. */
const CLAUSE_ENDS = [' order by ', ' returning ', ' group by ', ' limit ', ';', ' for '];

/** The WHERE clause a predicate at `index` belongs to. */
function whereClause(body, index) {
  const start = body.lastIndexOf(' where ', index);
  const ends = CLAUSE_ENDS.map((stop) => body.indexOf(stop, index)).filter((i) => i !== -1);
  return body.slice(start, ends.length > 0 ? Math.min(...ends) : body.length);
}

const PREDICATES = MIGRATIONS.flatMap((name) =>
  functionBodies(normalised(name)).flatMap(({ fn, body }) =>
    [...body.matchAll(BOOKING_PERIOD_PREDICATE)].map((m) => ({
      name,
      fn,
      text: m[0],
      column: m[1],
      op: m[2],
      clause: whereClause(body, m.index),
    })),
  ),
);


describe('SCRUM17_AC3 booking-period predicates in the block migrations', () => {
  it('SCRUM17_AC3_found_the_helper_both_locks_and_the_flag_update', () => {
    // 013 helper + lock, 014 flag update + lock, 015 lock: 5 functions x 2.
    expect(PREDICATES.length).toBeGreaterThanOrEqual(4);
    const fns = new Set(PREDICATES.map((p) => `${p.name}:${p.fn}`));
    expect(fns).toEqual(new Set([
      '013_venue_block_booking_conflicts.sql:venue_block_booking_conflicts',
      '013_venue_block_booking_conflicts.sql:create_venue_block',
      '014_booking_review_notifications.sql:flag_bookings_for_block',
      '014_booking_review_notifications.sql:create_venue_block',
      '015_venue_block_amend_remove.sql:update_venue_block',
    ]));
  });

  it('SCRUM17_AC3_touching_booking_is_never_a_conflict', () => {
    expect(PREDICATES.length).toBeGreaterThanOrEqual(4);
    for (const p of PREDICATES) {
      // Half-open overlap: the start is compared strictly below the other
      // end, and the end strictly above the other start.
      const expected = p.column === 'starts_at' ? '<' : '>';
      expect(p.op, `${p.name} ${p.fn}: ${p.text}`).toBe(expected);
    }
  });

  it('SCRUM17_AC3_flagged_booking_no_longer_conflicts', () => {
    expect(PREDICATES.length).toBeGreaterThanOrEqual(4);
    for (const p of PREDICATES) {
      expect(p.clause.startsWith(' where '), `${p.name} ${p.fn}: no where`).toBe(true);
      expect(p.clause, `${p.name} ${p.fn}: ${p.text}`).toContain("b.status = 'approved'");
    }
  });
});
