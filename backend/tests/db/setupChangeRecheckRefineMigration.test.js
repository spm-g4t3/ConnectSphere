/**
 * Tests for 035_setup_change_recheck_refine.sql, read from the migration text.
 *
 * SCRUM-484 AC8, refined by the user's 2026-10-08 AC review decisions:
 *  1. In the re-check a flagged_for_review booking counts as the "other"
 *     booking: a candidate is flagged when it now overlaps a block or any
 *     booking venue_occupancy_conflicts() returns (approved or flagged), so
 *     034's `c.status = 'approved'` is dropped.
 *  2. Only clashes the change created are flagged: the candidates already
 *     clashing under the OLD minutes are collected under the venue lock,
 *     before the venues row is updated, and left out of the flagged set.
 *
 * 035 replaces 034's update_venue with `create or replace` and nothing else.
 * These pin that: same signature and return type, no drop, the old set in the
 * right place and built from the same query as the new set, and -- comparing
 * normalised bodies -- everything outside the re-check exactly 034's.
 *
 * The behaviour is exercised against a real Postgres in
 * setupChangeRecheckDatabase.test.js. Same helpers as
 * setupChangeRecheckMigration.test.js: every `--` comment stripped (the
 * header explains the rules in prose, so a rule only in a comment must not
 * count), whitespace collapsed, lower-cased, space inside parentheses removed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '../../db/migrations');

function normalised(name) {
  return readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8')
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .toLowerCase()
    .trim();
}

const SQL = normalised('035_setup_change_recheck_refine.sql');
const SQL034 = normalised('034_setup_change_recheck.sql');

/** One function's text in `sql`: from its `create or replace` to the `$$;` that ends it. */
function functionText(sql, name) {
  const from = sql.indexOf(`create or replace function ${name}(`);
  if (from === -1) return null;
  const end = sql.indexOf('$$;', sql.indexOf('$$', from) + 2);
  return end === -1 ? null : sql.slice(from, end + 3);
}

/** The header between `name(` and the `as $$` that opens the body. */
const headerOf = (text) => text.slice(0, text.indexOf('$$'));

/** The parameter types of a function header, defaults dropped. */
function parameterTypes(text) {
  const open = text.indexOf('(');
  const close = text.indexOf(') returns');
  return text
    .slice(open + 1, close)
    .split(',')
    .map((p) => p.trim().split(' ')[1])
    .join(', ');
}

/** The one statement in `text` that starts at `start`, up to and including its `;`. */
const statementAt = (text, start) => text.slice(start, text.indexOf(';', start) + 1);

const UPDATE_VENUE = functionText(SQL, 'update_venue');
const UPDATE_VENUE_034 = functionText(SQL034, 'update_venue');
const BODY = UPDATE_VENUE.slice(UPDATE_VENUE.indexOf('$$'));

/** 034's "other side" and 035's. */
const OTHER_034 = "where c.kind = 'block' or (c.kind = 'booking' and c.status = 'approved' and c.id <> b.id)";
const OTHER_035 = "where c.kind = 'block' or (c.kind = 'booking' and c.id <> b.id)";

/** 035's additions, as they read normalised. */
const NEW_DECLARATIONS = " v_old_clashing uuid[] := '{}'; v_changing boolean := false;";
const CHANGING =
  'v_changing := coalesce(p_setup_minutes, v_old_setup) is distinct from v_old_setup ' +
  'or coalesce(p_turnaround_minutes, v_old_turnaround) is distinct from v_old_turnaround;';
const EXCLUDE_OLD =
  "select coalesce(array_agg(x.id order by x.id), '{}'::uuid[]) into v_clashing " +
  'from unnest(v_clashing) as x(id) where x.id <> all (v_old_clashing);';

/** The candidate query that fills a set: `select ... into <target> from bookings b ... );`. */
function candidateQuery(target) {
  const start = BODY.indexOf(`select coalesce(array_agg(b.id order by b.id), '{}'::uuid[]) into ${target} from bookings b`);
  if (start === -1) return null;
  return { start, text: statementAt(BODY, start) };
}

const NEW_SET = candidateQuery('v_clashing');
const OLD_SET = candidateQuery('v_old_clashing');

const LOCK =
  'select v.setup_minutes, v.turnaround_minutes into v_old_setup, v_old_turnaround from venues v where v.id = p_id for no key update;';


describe('SCRUM-484 AC8 (035): update_venue is replaced in place', () => {
  it('SCRUM484_AC8_refine_keeps_034_signature_without_a_drop', () => {
    expect(UPDATE_VENUE).not.toBeNull();
    expect(UPDATE_VENUE_034).not.toBeNull();
    // Same parameters, defaults and return type as 034: the whole header is
    // identical, so `create or replace` is enough.
    expect(parameterTypes(headerOf(UPDATE_VENUE))).toBe(
      'uuid, text, text, integer, text[], text[], text[], jsonb, integer, integer, uuid',
    );
    expect(headerOf(UPDATE_VENUE)).toBe(headerOf(UPDATE_VENUE_034));
    expect(headerOf(UPDATE_VENUE)).toMatch(/\) returns jsonb language plpgsql as $/);
    // Nothing is dropped, and no grant or other object changes.
    expect(SQL).not.toMatch(/\bdrop\b/);
    expect(SQL).not.toMatch(/\bgrant\b|\brevoke\b|\balter table\b/);
    // The file is exactly the function and the reload.
    expect(SQL.replace(UPDATE_VENUE, '').trim()).toBe("notify pgrst, 'reload schema';");
  });

  it('SCRUM484_AC8_refine_reloads_postgrest_after_the_create', () => {
    expect(SQL.lastIndexOf("notify pgrst, 'reload schema';")).toBeGreaterThan(
      SQL.indexOf('create or replace function update_venue(') + UPDATE_VENUE.length - 1,
    );
  });
});


describe('SCRUM-484 AC8 (035): only clashes the change created are flagged', () => {
  it('SCRUM484_AC8_old_clash_set_is_collected_under_the_lock_before_the_update', () => {
    const lock = BODY.indexOf(LOCK);
    const update = BODY.indexOf('update venues set');
    expect(lock).toBeGreaterThan(-1);
    expect(OLD_SET).not.toBeNull();
    expect(update).toBeGreaterThan(-1);
    // Lock -> old set -> update.
    expect(OLD_SET.start).toBeGreaterThan(lock);
    expect(OLD_SET.start).toBeLessThan(update);
    // ...and after the missing-venue refusal, so a missing venue reads nothing.
    expect(OLD_SET.start).toBeGreaterThan(BODY.indexOf("using errcode = 'no_data_found'"));
    // Only one venues lock, and the old set is collected exactly once.
    expect(BODY.split('for no key update;')).toHaveLength(2);
    expect(BODY.split('into v_old_clashing')).toHaveLength(2);
  });

  it('SCRUM484_AC8_old_clash_set_only_when_the_minutes_really_change', () => {
    // v_changing compares what the update will write -- coalesce(param, old)
    // -- with the old minutes, before the update, and guards the old set.
    const changing = BODY.indexOf(CHANGING);
    const guard = BODY.indexOf('if v_changing then ');
    expect(changing).toBeGreaterThan(BODY.indexOf(LOCK));
    expect(guard).toBeGreaterThan(changing);
    expect(OLD_SET.start).toBe(guard + 'if v_changing then '.length);
    expect(BODY.slice(OLD_SET.start + OLD_SET.text.length).startsWith(' end if;')).toBe(true);
    // The update writes exactly those coalesces.
    expect(BODY).toContain('turnaround_minutes = coalesce(p_turnaround_minutes, turnaround_minutes)');
    expect(BODY).toContain('setup_minutes = coalesce(p_setup_minutes, setup_minutes)');
  });

  it('SCRUM484_AC8_old_and_new_sets_use_the_same_condition_and_function', () => {
    expect(NEW_SET).not.toBeNull();
    // Word for word the same query, only the target differs.
    expect(OLD_SET.text).toBe(NEW_SET.text.replace('into v_clashing', 'into v_old_clashing'));
    expect(NEW_SET.text).toContain(
      "where b.venue_id = p_id and b.status = 'approved' and b.starts_at > now() and exists (",
    );
    expect(NEW_SET.text).toMatch(/venue_occupancy_conflicts\(p_id, b\.starts_at, b\.ends_at, true\)/);
  });

  it('SCRUM484_AC8_new_condition_counts_flagged_bookings_as_the_other_side', () => {
    // Decision 1: any booking the shared function returns (approved or
    // flagged_for_review) is the other side; 034's status filter is gone.
    expect(NEW_SET.text).toContain(OTHER_035);
    expect(OLD_SET.text).toContain(OTHER_035);
    expect(BODY).not.toContain("c.status = 'approved'");
    expect(BODY).not.toMatch(/\bc\.status\b/);
    // The candidates themselves are still approved only.
    expect(BODY.split("b.status = 'approved' and b.starts_at > now()")).toHaveLength(3);
  });

  it('SCRUM484_AC8_flagged_set_excludes_the_old_set', () => {
    // Decision 2: after the new set, before the lock and flag, v_clashing
    // keeps only the ids not in v_old_clashing.
    const exclude = BODY.indexOf(EXCLUDE_OLD);
    expect(exclude).toBeGreaterThan(NEW_SET.start);
    expect(exclude).toBeLessThan(BODY.indexOf('with locked as ('));
    expect(BODY.split(EXCLUDE_OLD)).toHaveLength(2);
    // The lock and the flag work from the narrowed v_clashing.
    expect(BODY.indexOf('b.id = any (v_clashing)')).toBeGreaterThan(exclude);
  });

  it('SCRUM484_AC8_refine_changes_nothing_outside_the_recheck', () => {
    // Undo exactly 035's four edits and 034's update_venue must come back,
    // word for word: the declarations, the old-set block before the update,
    // the other-side condition, and the exclusion.
    expect(UPDATE_VENUE).toContain(`v_clashing uuid[] := '{}';${NEW_DECLARATIONS} v_locked uuid[] := '{}';`);
    const oldBlock = `${CHANGING} if v_changing then ${OLD_SET.text} end if; `;
    expect(UPDATE_VENUE.split(oldBlock)).toHaveLength(2);
    // The old block sits right after the missing-venue check, right before
    // 023's snapshot.
    expect(UPDATE_VENUE).toContain(`end if; ${oldBlock}v_before := venue_attribute_snapshot(p_id);`);

    const reverted = UPDATE_VENUE.replace(NEW_DECLARATIONS, '')
      .replace(oldBlock, '')
      .replace(` ${EXCLUDE_OLD}`, '')
      .replace(OTHER_035, OTHER_034);
    expect(reverted).toBe(UPDATE_VENUE_034);
  });
});
