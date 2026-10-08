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
 *
 * SCRUM-484 adds 032 and 033 to the list. 033 redefines all three block
 * functions, and they no longer write a booking-period predicate of their own:
 * they ask venue_occupancy_conflicts() (032) which bookings meet the block. So
 * the predicates now live in 032's shared function, and rule 1 is checked
 * there too. Rule 2 is adapted for 032 (see SHARED_READER below), and 033's
 * own rules get their own describe block at the end.
 *
 * SCRUM-484 (AC8) adds 034, whose update_venue re-checks a venue's approved
 * bookings when its setup or turnaround changes. It flags bookings, so both
 * rules apply to it, and it is in the list. Its one booking-period
 * comparison is the "not started" filter `b.starts_at > now()`, which
 * compares a start with the clock, not two periods: it is named below
 * (NOT_STARTED) and kept out of the overlap predicates. The overlap itself is
 * 032's, asked with pad = true, and 034's rules get their own describe block.
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
  '032_venue_occupancy.sql',
  '033_venue_occupancy_callers.sql',
  '034_setup_change_recheck.sql',
];

/**
 * SCRUM-484 (AC8): the one booking-period comparison that is not an overlap
 * -- update_venue's "event has not started" filter in 034. Only this exact
 * text, only in that function.
 */
const NOT_STARTED = { fn: '034_setup_change_recheck.sql:update_venue', text: 'b.starts_at > now()' };

/**
 * SCRUM-484: 032's venue_occupancy_conflicts() is the shared READER every
 * caller asks, not a block's candidate list, so its booking predicates sit
 * under `b.status in ('approved', 'flagged_for_review')` -- the occupying
 * statuses (decision 2): a flagged booking still holds the venue for search,
 * the booking request and the calendar. Rule 2 ("once flagged it no longer
 * conflicts") is a rule of the block writers, so it is checked where they
 * apply it: 033's locks keep b.status = 'approved' in their own WHERE (the
 * describe block at the end).
 */
const SHARED_READER = '032_venue_occupancy.sql:venue_occupancy_conflicts';

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

/** Every booking-period predicate, the named not-started filter included. */
const ALL_PREDICATES = MIGRATIONS.flatMap((name) =>
  functionBodies(normalised(name)).flatMap(({ fn, body }) =>
    [...body.matchAll(BOOKING_PERIOD_PREDICATE)].map((m) => ({
      name,
      fn,
      text: m[0],
      column: m[1],
      op: m[2],
      clause: whereClause(body, m.index),
      full: body.slice(m.index, m.index + NOT_STARTED.text.length),
    })),
  ),
);

const isNotStarted = (p) => `${p.name}:${p.fn}` === NOT_STARTED.fn && p.full === NOT_STARTED.text;

/** The overlap predicates the two rules are about. */
const PREDICATES = ALL_PREDICATES.filter((p) => !isNotStarted(p));


describe('SCRUM17_AC3 booking-period predicates in the block migrations', () => {
  it('SCRUM17_AC3_found_the_helper_both_locks_and_the_flag_update', () => {
    // 013 helper + lock, 014 flag update + lock, 015 lock: 5 functions x 2.
    // SCRUM-484: plus 032's shared function, which is now where the overlap
    // is written. 033 contributes none -- its block functions call 032.
    expect(PREDICATES.length).toBeGreaterThanOrEqual(4);
    const fns = new Set(PREDICATES.map((p) => `${p.name}:${p.fn}`));
    expect(fns).toEqual(new Set([
      '013_venue_block_booking_conflicts.sql:venue_block_booking_conflicts',
      '013_venue_block_booking_conflicts.sql:create_venue_block',
      '014_booking_review_notifications.sql:flag_bookings_for_block',
      '014_booking_review_notifications.sql:create_venue_block',
      '015_venue_block_amend_remove.sql:update_venue_block',
      SHARED_READER,
    ]));
    // SCRUM-484 (AC8): 034's update_venue contributes only the named
    // not-started filter, exactly once; its overlap is 032's.
    expect(ALL_PREDICATES.filter(isNotStarted)).toHaveLength(1);
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
      if (`${p.name}:${p.fn}` === SHARED_READER) {
        // Adapted (see SHARED_READER): the occupying allow-list, never "not
        // cancelled", so pending/rejected/withdrawn occupy nothing.
        expect(p.clause, `${p.name} ${p.fn}: ${p.text}`).toContain(
          "b.status in ('approved', 'flagged_for_review')",
        );
        continue;
      }
      expect(p.clause, `${p.name} ${p.fn}: ${p.text}`).toContain("b.status = 'approved'");
    }
  });
});


describe('SCRUM484 the block functions in 033 keep both rules through the shared function', () => {
  const SQL033 = normalised('033_venue_occupancy_callers.sql');
  const BODIES = Object.fromEntries(
    functionBodies(SQL033).map(({ fn, body }) => [fn, body]),
  );
  const BLOCK_FUNCTIONS = ['create_venue_block', 'update_venue_block', 'flag_bookings_for_block'];

  it('SCRUM484_AC5_block_functions_write_no_booking_period_predicate_of_their_own', () => {
    // Rule 1 now holds by construction: the only comparison is 032's, which
    // the predicates above already check is strict.
    for (const fn of BLOCK_FUNCTIONS) {
      expect(BODIES[fn], fn).toBeDefined();
      expect([...BODIES[fn].matchAll(BOOKING_PERIOD_PREDICATE)], fn).toEqual([]);
      expect(BODIES[fn], fn).toMatch(/venue_occupancy_conflicts\([^)]*, false\)/);
    }
  });

  it('SCRUM484_AC6_block_functions_still_only_take_approved_bookings', () => {
    // Rule 2: every query that picks bookings through the shared function
    // also requires b.status = 'approved' in its own WHERE, so a booking
    // already flagged_for_review (which the function still returns, as it
    // occupies) is not listed or flagged again.
    for (const fn of BLOCK_FUNCTIONS) {
      const body = BODIES[fn];
      for (const m of body.matchAll(/\bb\.id in \(\s*select c\.id from venue_occupancy_conflicts\(/g)) {
        const clause = whereClause(body, m.index);
        expect(clause, `${fn}: ${clause}`).toContain("b.status = 'approved'");
      }
      expect(body.match(/\bb\.id in \(\s*select c\.id from venue_occupancy_conflicts\(/g)?.length ?? 0, fn)
        .toBeGreaterThan(0);
    }
  });
});


describe('SCRUM484 the AC8 re-check in 034 keeps both rules through the shared function', () => {
  const BODY = functionBodies(normalised('034_setup_change_recheck.sql')).find(
    ({ fn }) => fn === 'update_venue',
  )?.body;

  it('SCRUM484_AC8_recheck_writes_no_booking_period_predicate_of_its_own', () => {
    // Rule 1 by construction: apart from the not-started filter, the only
    // comparison is 032's, asked with the booking's own period padded.
    expect(BODY).toBeDefined();
    const own = [...BODY.matchAll(BOOKING_PERIOD_PREDICATE)].map(
      (m) => BODY.slice(m.index, m.index + NOT_STARTED.text.length),
    );
    expect(own).toEqual([NOT_STARTED.text]);
    expect(BODY).toMatch(/venue_occupancy_conflicts\(p_id, b\.starts_at, b\.ends_at, true\)/);
  });

  it('SCRUM484_AC8_recheck_only_takes_approved_bookings', () => {
    // Rule 2: the candidate query, the lock and the flag UPDATE each require
    // b.status = 'approved' in their own WHERE, so a booking already
    // flagged_for_review is not flagged again.
    const candidates = BODY.indexOf(NOT_STARTED.text);
    expect(whereClause(BODY, candidates)).toContain("b.status = 'approved'");
    for (const anchor of ['b.id = any (v_clashing)', 'b.id = any (v_locked)']) {
      const at = BODY.indexOf(anchor);
      expect(at, anchor).toBeGreaterThan(-1);
      expect(whereClause(BODY, at), anchor).toContain("b.status = 'approved'");
    }
  });
});
