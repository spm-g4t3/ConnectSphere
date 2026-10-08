/**
 * Tests for 032_venue_occupancy.sql, read from the migration text.
 *
 * SCRUM-484 "Configure Venue Setup and Turnaround Times" (sub-task 2: the
 * shared occupied-period function). 032 adds venue_occupied_period(), the one
 * place the formula [start - setup, end + turnaround) is written, and
 * venue_occupancy_conflicts(), which answers "what occupies this venue during
 * this period?" through it.
 *
 * These pin the shape of the migration with every `--` comment stripped: the
 * header explains the formula, the statuses and the edges in prose, so a rule
 * that exists only in a comment must not count. The behaviour itself (the
 * worked example, the edges, the statuses) is exercised against a real
 * Postgres in venueOccupancyDatabase.test.js.
 *
 * Same helpers and structure as venueBlockBookingConflictsMigration.test.js
 * and venueSetupTimeMigration.test.js.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** The raw 032 migration, comments included. */
function rawSql() {
  return readFileSync(resolve(here, '../../db/migrations/032_venue_occupancy.sql'), 'utf8');
}

/**
 * The 032 migration with every `--` comment stripped, whitespace collapsed,
 * lower-cased, and the space just inside parentheses removed (layout, not
 * behaviour).
 */
function migrationSql() {
  return rawSql()
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .toLowerCase()
    .trim();
}

const SQL = migrationSql();

const PERIOD_START = 'create or replace function venue_occupied_period(';
const CONFLICTS_START = 'create or replace function venue_occupancy_conflicts(';

/** One function's text: from its `create or replace` to the `$$;` that ends it. */
function functionText(start) {
  const from = SQL.indexOf(start);
  if (from === -1) return null;
  const end = SQL.indexOf('$$;', SQL.indexOf('$$', from) + 2);
  return end === -1 ? null : SQL.slice(from, end + 3);
}

/** The header between `name(` and the `as $$` that opens the body. */
function headerOf(text) {
  return text.slice(0, text.indexOf('$$'));
}

/** The body between a function's $$ quotes. */
function bodyOf(text) {
  const open = text.indexOf('$$');
  const close = text.lastIndexOf('$$');
  return text.slice(open + 2, close);
}

/** How many times `needle` occurs in `haystack`. */
function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

const PERIOD = functionText(PERIOD_START);
const PERIOD_HEADER = PERIOD ? headerOf(PERIOD) : '';
const PERIOD_BODY = PERIOD ? bodyOf(PERIOD) : '';
const CONFLICTS = functionText(CONFLICTS_START);
const CONFLICTS_HEADER = CONFLICTS ? headerOf(CONFLICTS) : '';
const CONFLICTS_BODY = CONFLICTS ? bodyOf(CONFLICTS) : '';

/** The formula, as venue_occupied_period writes it. */
const FORMULA =
  "tstzrange(p_starts_at - make_interval(mins => p_setup_minutes), " +
  "p_ends_at + make_interval(mins => p_turnaround_minutes), '[)')";


describe('the migration text', () => {
  it('defines both functions', () => {
    expect(PERIOD).not.toBeNull();
    expect(CONFLICTS).not.toBeNull();
  });

  it('SCRUM484_AC3_migration_only_uses_create_or_replace', () => {
    // Both functions are new, so `create or replace` is enough to re-run it;
    // a bare `create` of anything would fail the second time.
    expect(SQL).not.toMatch(/\bcreate (function|table|type|index|trigger)\b/);
    expect(SQL).not.toMatch(/\bdrop\b/);
    expect(count(SQL, 'create or replace function ')).toBe(2);
  });
});


describe('AC3: the occupied period', () => {
  it('SCRUM484_AC3_occupied_period_function_is_defined_once_with_the_formula', () => {
    expect(count(SQL, PERIOD_START)).toBe(1);
    expect(PERIOD_HEADER).toMatch(
      /venue_occupied_period\(p_starts_at timestamptz, p_ends_at timestamptz, p_setup_minutes integer, p_turnaround_minutes integer\)/,
    );
    expect(PERIOD_HEADER).toMatch(/returns tstzrange/);
    expect(PERIOD_HEADER).toMatch(/\bimmutable\b/);
    expect(PERIOD_HEADER).toMatch(/\bstrict\b/);
    expect(PERIOD_BODY).toContain(FORMULA);

    // The formula is written once, in this function, and nowhere else: every
    // range in the file is built by this one tstzrange call.
    expect(count(SQL, FORMULA)).toBe(1);
    expect(count(SQL, 'tstzrange(')).toBe(1);
    expect(CONFLICTS_BODY).not.toContain('tstzrange(');
  });

  it('SCRUM484_AC3_minutes_come_from_the_venue_not_the_caller', () => {
    expect(CONFLICTS_HEADER).toMatch(
      /venue_occupancy_conflicts\(p_venue_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_pad_requested boolean\)/,
    );
    // No minutes parameter: the caller cannot supply its own.
    const params = CONFLICTS_HEADER.slice(
      CONFLICTS_HEADER.indexOf('(') + 1,
      CONFLICTS_HEADER.indexOf(') returns'),
    );
    expect(params).not.toMatch(/minutes/);

    // The minutes are read from the venues row for p_venue_id.
    expect(CONFLICTS_BODY).toMatch(/from venues v where v\.id = p_venue_id/);
    expect(CONFLICTS_BODY).toMatch(/v\.setup_minutes/);
    expect(CONFLICTS_BODY).toMatch(/v\.turnaround_minutes/);
  });
});


describe('AC4: one function, every consumer', () => {
  it('SCRUM484_AC4_conflicts_function_uses_the_period_function_and_occupying_statuses', () => {
    expect(CONFLICTS_HEADER).toMatch(/\bstable\b/);
    expect(CONFLICTS_HEADER).not.toMatch(/\bimmutable\b|\bvolatile\b/);
    expect(CONFLICTS_BODY).not.toMatch(/\bfor (update|share|no key update|key share)\b/);

    // Bookings: the occupying allow-list, compared through the one formula.
    expect(CONFLICTS_BODY).toContain("b.status in ('approved', 'flagged_for_review')");
    expect(CONFLICTS_BODY).toMatch(
      /venue_occupied_period\(b\.starts_at, b\.ends_at, req\.setup_minutes, req\.turnaround_minutes\) && req\.period/,
    );

    // Blocks: active only, raw (0, 0), compared through the one formula.
    expect(CONFLICTS_BODY).toContain('vb.removed_at is null');
    expect(CONFLICTS_BODY).toMatch(
      /venue_occupied_period\(vb\.starts_at, vb\.ends_at, 0, 0\) && req\.period/,
    );

    // The requested range is padded only when p_pad_requested.
    expect(CONFLICTS_BODY).toMatch(
      /case when p_pad_requested then venue_occupied_period\(p_starts_at, p_ends_at, ven\.setup_minutes, ven\.turnaround_minutes\) else venue_occupied_period\(p_starts_at, p_ends_at, 0, 0\) end as period/,
    );
  });
});


describe('AC5: touching periods do not conflict', () => {
  it('SCRUM484_AC5_ranges_are_half_open_everywhere', () => {
    // Nothing inclusive anywhere in the file.
    expect(SQL).not.toContain('<=');
    expect(SQL).not.toContain('>=');
    expect(SQL).not.toContain("'[]'");
    expect(SQL).not.toContain("'(]'");
    expect(SQL).not.toContain("'()'");

    // Every range built is '[)'.
    const built = SQL.match(/tstzrange\([^;]*?'(\[|\()(\]|\))'\)/g) ?? [];
    expect(built.length).toBe(count(SQL, 'tstzrange('));
    for (const call of built) expect(call.endsWith("'[)')")).toBe(true);

    // Ranges are compared with && (bookings and blocks).
    expect(count(CONFLICTS_BODY, '&& req.period')).toBe(2);
  });
});
