/**
 * Tests for 036_venue_safety_facts.sql, read from the migration text.
 *
 * SCRUM-493 "Record Venue Emergency Access and Restrictions (Venue Staff)".
 * 036 adds two nullable text columns to venues, emergency_access and
 * known_restrictions, each with a CHECK (1 to 2,000 characters, at least one
 * non-whitespace character), and redefines create_venue (023's body) and
 * update_venue (035's body) with one parameter each and the lines that store
 * them. These pin that shape:
 *
 *  - the columns are nullable with no default (AC2: an existing venue reads
 *    as not recorded);
 *  - both CHECKs carry the length bound and the non-whitespace rule (AC1);
 *  - each old signature is dropped, exactly, before its create, so PostgREST
 *    is never left with two overloads (PGRST203);
 *  - normalised, update_venue minus its two parameters and two SET lines is
 *    exactly 035's, and create_venue minus its two parameters, columns and
 *    values is exactly 023's -- so nothing else changed;
 *  - 035's re-check guard is untouched (AC6);
 *  - `notify pgrst` comes after both creates.
 *
 * The behaviour is exercised against a real Postgres in
 * venueSafetyFactsDatabase.test.js. Same helpers as
 * setupChangeRecheckRefineMigration.test.js: every `--` comment stripped (the
 * header explains the rules in prose, so a rule only in a comment must not
 * count), whitespace collapsed, lower-cased, space inside parentheses removed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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

const SQL = normalised('036_venue_safety_facts.sql');
const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
const SQL023 = normalised('023_venue_setup_time.sql');
const SQL035 = normalised('035_setup_change_recheck_refine.sql');

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

/** How many times `needle` occurs in `text`. */
const count = (text, needle) => text.split(needle).length - 1;

/** Remove `needle` from `text`, insisting it occurs exactly once. */
function removeOnce(text, needle) {
  expect(count(text, needle), needle).toBe(1);
  return text.replace(needle, '');
}

const CREATE_VENUE = functionText(SQL, 'create_venue');
const UPDATE_VENUE = functionText(SQL, 'update_venue');
const CREATE_VENUE_023 = functionText(SQL023, 'create_venue');
const UPDATE_VENUE_035 = functionText(SQL035, 'update_venue');

/** The whitespace-class trim, as it reads normalised, for one parameter. */
const trimmed = (param) => `nullif(regexp_replace(${param}, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '')`;

/** The two parameters 036 adds to both functions, right before p_user_id. */
const NEW_PARAMS = 'p_emergency_access text default null, p_known_restrictions text default null, ';

/** update_venue's two SET lines: NULL keeps, anything else is trimmed, blank clears. */
const SET_LINES =
  `emergency_access = case when p_emergency_access is null then emergency_access else ${trimmed('p_emergency_access')} end, ` +
  `known_restrictions = case when p_known_restrictions is null then known_restrictions else ${trimmed('p_known_restrictions')} end, `;

/** 035's re-check guard, in its two places (step 0a and step 7). */
const CHANGING =
  'v_changing := coalesce(p_setup_minutes, v_old_setup) is distinct from v_old_setup ' +
  'or coalesce(p_turnaround_minutes, v_old_turnaround) is distinct from v_old_turnaround;';
const STEP_7_GUARD =
  'if v_new_setup is distinct from v_old_setup or v_new_turnaround is distinct from v_old_turnaround then';

/** The exact signatures 023 created create_venue with and 034/035 update_venue with. */
const OLD_CREATE_SIGNATURE = 'text, text, integer, text[], text[], text[], jsonb, integer, integer, uuid';
const OLD_UPDATE_SIGNATURE = 'uuid, text, text, integer, text[], text[], text[], jsonb, integer, integer, uuid';


describe('SCRUM-493 (036): the two columns', () => {
  it.each(['emergency_access', 'known_restrictions'])(
    'SCRUM493_AC2_%s_is_nullable_text_with_no_default',
    (column) => {
      // The whole statement, so a `not null` or a `default` cannot hide in it.
      expect(SQL).toContain(`alter table venues add column if not exists ${column} text;`);
      const statements = SQL.split(';').filter((s) => new RegExp(`\\b${column}\\b`).test(s) && /add column/.test(s));
      expect(statements).toHaveLength(1);
      expect(statements[0]).not.toMatch(/\bnot null\b|\bdefault\b/);
      // Nothing later makes it mandatory or gives it a default either.
      expect(SQL).not.toMatch(new RegExp(`alter column ${column}`));
    },
  );

  it.each(['emergency_access', 'known_restrictions'])(
    'SCRUM493_AC1_%s_check_has_the_length_bound_and_the_non_whitespace_rule',
    (column) => {
      const name = `venues_${column}_length`;
      const drop = `alter table venues drop constraint if exists ${name};`;
      const add =
        `alter table venues add constraint ${name} check (${column} is null ` +
        `or (char_length(${column}) between 1 and 2000 and ${column} ~ '[^[:space:]]'));`;
      expect(count(SQL, drop)).toBe(1);
      expect(count(SQL, add)).toBe(1);
      // Dropped by name first, so a re-run replaces it instead of failing.
      expect(SQL.indexOf(drop)).toBeLessThan(SQL.indexOf(add));
      // Defined after the column it checks.
      expect(SQL.indexOf(`add column if not exists ${column} text;`)).toBeLessThan(SQL.indexOf(add));
    },
  );

  it('SCRUM493_AC1_the_check_and_the_trim_use_the_same_whitespace_class', () => {
    // So the database and the trim agree on what blank is. Known, accepted
    // limit: U+00A0 is not in [[:space:]] in PGlite, so a direct SQL write of
    // only non-breaking spaces is stored; the API trims it first.
    expect(count(SQL, "~ '[^[:space:]]'")).toBe(2);
    expect(count(SQL, "'^[[:space:]]+|[[:space:]]+$'")).toBe(4);
    // btrim() strips only spaces, so it must not be the trim used.
    expect(SQL).not.toMatch(/\bbtrim\(|\btrim\(/);
  });

  it('SCRUM493_AC4_no_history_table_or_trigger_changes', () => {
    // 003's record_venue_change already diffs every column, so 036 needs no
    // trigger, no history change, and no snapshot change.
    expect(SQL).not.toMatch(/\bcreate (?:or replace )?trigger\b/);
    expect(SQL).not.toMatch(/venue_change_history/);
    expect(SQL).not.toMatch(/create or replace function (?!create_venue\(|update_venue\()/);
    expect(SQL).not.toMatch(/\bgrant\b|\brevoke\b|\bsecurity definer\b/);
  });
});


describe('SCRUM-493 (036): each old signature is dropped before its create', () => {
  it('SCRUM493_AC1_create_venue_drops_023_signature_exactly_before_creating', () => {
    expect(CREATE_VENUE_023).not.toBeNull();
    expect(parameterTypes(headerOf(CREATE_VENUE_023))).toBe(OLD_CREATE_SIGNATURE);
    const drop = `drop function if exists create_venue(${OLD_CREATE_SIGNATURE});`;
    expect(count(SQL, drop)).toBe(1);
    expect(SQL.indexOf(drop)).toBeLessThan(SQL.indexOf('create or replace function create_venue('));
    // The one drop of create_venue in the file.
    expect(count(SQL, 'drop function if exists create_venue(')).toBe(1);
    // No migration between 023 and 036 redefines create_venue, so 023's
    // signature is really the live one.
    const between = MIGRATION_FILES.filter((f) => f > '023_venue_setup_time.sql' && f < '036_venue_safety_facts.sql');
    expect(between.length).toBeGreaterThan(0);
    for (const name of between) {
      expect(normalised(name), name).not.toContain('function create_venue(');
    }
  });

  it('SCRUM493_AC1_update_venue_drops_035_signature_exactly_before_creating', () => {
    expect(UPDATE_VENUE_035).not.toBeNull();
    expect(parameterTypes(headerOf(UPDATE_VENUE_035))).toBe(OLD_UPDATE_SIGNATURE);
    const drop = `drop function if exists update_venue(${OLD_UPDATE_SIGNATURE});`;
    expect(count(SQL, drop)).toBe(1);
    expect(SQL.indexOf(drop)).toBeLessThan(SQL.indexOf('create or replace function update_venue('));
    expect(count(SQL, 'drop function if exists update_venue(')).toBe(1);
  });

  it('SCRUM493_AC1_the_new_signatures_add_two_text_parameters_before_the_user', () => {
    expect(parameterTypes(headerOf(CREATE_VENUE))).toBe(
      'text, text, integer, text[], text[], text[], jsonb, integer, integer, text, text, uuid',
    );
    expect(parameterTypes(headerOf(UPDATE_VENUE))).toBe(
      'uuid, text, text, integer, text[], text[], text[], jsonb, integer, integer, text, text, uuid',
    );
    expect(headerOf(CREATE_VENUE)).toContain(`${NEW_PARAMS}p_user_id uuid default null) returns uuid`);
    expect(headerOf(UPDATE_VENUE)).toContain(`${NEW_PARAMS}p_user_id uuid default null) returns jsonb`);
  });
});


describe('SCRUM-493 (036): nothing else in the two functions changed', () => {
  it('SCRUM493_AC4_update_venue_is_035_plus_two_params_and_two_set_lines', () => {
    expect(UPDATE_VENUE).not.toBeNull();
    let rest = removeOnce(UPDATE_VENUE, NEW_PARAMS);
    rest = removeOnce(rest, SET_LINES);
    expect(rest).toBe(UPDATE_VENUE_035);
  });

  it('SCRUM493_AC4_update_venue_names_the_new_fields_only_in_those_lines', () => {
    // Outside the parameters and the SET, neither field appears: no step of
    // the re-check, the lock or the attribute steps reads them.
    const rest = UPDATE_VENUE.replace(NEW_PARAMS, '').replace(SET_LINES, '');
    expect(rest).not.toMatch(/emergency_access|known_restrictions/);
  });

  it('SCRUM493_AC1_create_venue_is_023_plus_the_params_columns_and_values', () => {
    expect(CREATE_VENUE).not.toBeNull();
    let rest = removeOnce(CREATE_VENUE, NEW_PARAMS);
    rest = removeOnce(rest, 'emergency_access, known_restrictions, ');
    rest = removeOnce(rest, `${trimmed('p_emergency_access')}, ${trimmed('p_known_restrictions')}, `);
    // 023 wrote its values on one line; 036 put each on its own, which
    // normalises to the same text once the two new values are gone.
    expect(rest).toBe(CREATE_VENUE_023);
  });

  it('SCRUM493_AC2_create_venue_inserts_the_trimmed_values_in_column_order', () => {
    expect(CREATE_VENUE).toContain(
      'insert into venues (name, location, max_capacity, turnaround_minutes, setup_minutes, ' +
      'emergency_access, known_restrictions, last_modified_by) values (p_name, p_location, p_max_capacity, ' +
      'coalesce(p_turnaround_minutes, 0), coalesce(p_setup_minutes, 0), ' +
      `${trimmed('p_emergency_access')}, ${trimmed('p_known_restrictions')}, p_user_id) returning id into v_id;`,
    );
  });
});


describe('SCRUM-493 (036): the setup-change re-check is untouched (AC6)', () => {
  it('SCRUM493_AC6_the_035_recheck_guard_is_present_unchanged', () => {
    for (const guard of [CHANGING, STEP_7_GUARD]) {
      expect(count(UPDATE_VENUE, guard), guard).toBe(1);
      expect(count(UPDATE_VENUE_035, guard), guard).toBe(1);
    }
    // The guard compares the minutes and nothing else.
    for (const guard of [CHANGING, STEP_7_GUARD]) {
      expect(guard).not.toMatch(/emergency|restriction/);
    }
    // The re-check, from step 7 to the end, is byte-for-byte 035's.
    const tail = (text) => text.slice(text.indexOf(STEP_7_GUARD));
    expect(tail(UPDATE_VENUE)).toBe(tail(UPDATE_VENUE_035));
  });
});


describe('SCRUM-493 (036): PostgREST is told to reload', () => {
  it('SCRUM493_AC1_notify_pgrst_comes_after_both_creates', () => {
    const notify = "notify pgrst, 'reload schema';";
    expect(count(SQL, notify)).toBe(1);
    const createEnd = Math.max(
      SQL.indexOf(CREATE_VENUE) + CREATE_VENUE.length,
      SQL.indexOf(UPDATE_VENUE) + UPDATE_VENUE.length,
    );
    expect(SQL.indexOf(notify)).toBeGreaterThanOrEqual(createEnd);
    // And it is the last statement.
    expect(SQL.endsWith(notify)).toBe(true);
  });
});

