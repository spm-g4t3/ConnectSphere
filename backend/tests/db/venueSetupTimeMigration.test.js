/**
 * Tests for 023_venue_setup_time.sql, read from the migration text.
 *
 * SCRUM-137 (part of SCRUM-20 "Search Venues Against Event Requirements"):
 * "Design/update the data model for venue search". Everything search filters
 * on already has a column except the setup time from the Week 7 Customer
 * Change, so 023 adds venues.setup_minutes the same way 017 added
 * turnaround_minutes. CI has no database, so these pin the shape of 023 with
 * every `--` comment stripped -- the header talks about triggers and
 * venue_attribute_snapshot, so a rule that exists only in a comment must not
 * count.
 *
 * Same helpers and structure as venueTurnaroundMigration.test.js (SCRUM-186),
 * with 017 as the "before" that 023 must preserve, as 008 was for 017.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { SETUP_MINUTES_OPTIONS } from '../../src/domain/setupOptions.js';

const here = dirname(fileURLToPath(import.meta.url));

/** A migration's raw text, comments included. */
function rawSql(name) {
  return readFileSync(resolve(here, `../../db/migrations/${name}`), 'utf8');
}

/**
 * A migration with every `--` comment stripped, whitespace collapsed,
 * lower-cased, and the space just inside parentheses removed -- 023 lays its
 * insert out over several lines where 017 used one, which is layout, not
 * behaviour.
 */
function normalised(name) {
  return rawSql(name)
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .toLowerCase()
    .trim();
}

const SQL = normalised('023_venue_setup_time.sql');
const SQL_017 = normalised('017_venue_turnaround.sql');

/** One function's text: from its `create or replace` to the `$$;` that ends it. */
function functionText(sql, name) {
  const start = `create or replace function ${name}(`;
  const from = sql.indexOf(start);
  if (from === -1) return null;
  const end = sql.indexOf('$$;', sql.indexOf('$$', from) + 2);
  return end === -1 ? null : sql.slice(from, end + 3);
}

/** The parameter list between `name(` and `) returns`. */
function paramsOf(text) {
  const open = text.indexOf('(');
  const close = text.indexOf(') returns');
  return text.slice(open + 1, close);
}

/** The body between a function's $$ quotes. */
function bodyOf(text) {
  const open = text.indexOf('$$');
  const close = text.lastIndexOf('$$');
  return text.slice(open + 2, close);
}

/** The identity signature Postgres uses for `drop function`: just the types. */
function signatureOf(text) {
  return paramsOf(text)
    .split(',')
    .map((param) => param.trim().split(' ')[1])
    .join(', ');
}

/** The parameter names, in declared order. */
function paramNamesOf(text) {
  return paramsOf(text)
    .split(',')
    .map((param) => param.trim().split(' ')[0]);
}

/** Assert every needle is present and in the order given. */
function expectInOrder(body, steps) {
  const positions = steps.map(([label, needle]) => [label, body.indexOf(needle)]);
  for (const [label, at] of positions) {
    expect(at, label).toBeGreaterThan(-1);
  }
  for (let i = 1; i < positions.length; i += 1) {
    expect(positions[i][1], `${positions[i - 1][0]} before ${positions[i][0]}`).toBeGreaterThan(
      positions[i - 1][1],
    );
  }
}

/** Every index at which needle occurs. */
function allIndexes(haystack, needle) {
  const found = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    found.push(at);
    at = haystack.indexOf(needle, at + 1);
  }
  return found;
}

/** The minutes in a `check (<column> in (...))`, as numbers. */
function checkList(sql, column) {
  const match = sql.match(new RegExp(`check \\(${column} in \\(([^)]*)\\)\\)`));
  if (!match) return null;
  return match[1].split(',').map((v) => Number(v.trim()));
}

const CREATE_023 = functionText(SQL, 'create_venue');
const UPDATE_023 = functionText(SQL, 'update_venue');
const CREATE_017 = functionText(SQL_017, 'create_venue');
const UPDATE_017 = functionText(SQL_017, 'update_venue');

const ATTRIBUTE_TABLES = [
  'venue_room_layouts',
  'venue_accessibility_features',
  'venue_facilities',
  'venue_operating_hours',
];


describe('SCRUM20_SCRUM137 023 adds the setup column re-runnably', () => {
  it('SCRUM20_SCRUM137_setup_minutes_defaults_to_zero', () => {
    expect(SQL).toContain(
      'alter table venues add column if not exists setup_minutes smallint not null default 0;',
    );
  });

  it('SCRUM20_SCRUM137_the_column_is_added_exactly_once', () => {
    expect(allIndexes(SQL, 'add column if not exists setup_minutes')).toHaveLength(1);
    // Never added without the guard, which would fail a re-run.
    expect(SQL).not.toMatch(/add column setup_minutes/);
  });

  it('SCRUM20_SCRUM137_the_constraint_is_dropped_if_exists_before_it_is_added', () => {
    expectInOrder(SQL, [
      ['add column', 'add column if not exists setup_minutes'],
      ['drop constraint', 'alter table venues drop constraint if exists venues_setup_minutes_allowed;'],
      ['add constraint', 'alter table venues add constraint venues_setup_minutes_allowed'],
    ]);
    expect(allIndexes(SQL, 'add constraint venues_setup_minutes_allowed')).toHaveLength(1);
  });

  it('SCRUM20_SCRUM137_the_constraint_lists_exactly_the_agreed_values', () => {
    expect(SQL).toContain(
      'add constraint venues_setup_minutes_allowed check (setup_minutes in (0, 15, 30, 45, 60, 90, 120));',
    );
  });

  it('SCRUM20_SCRUM137_the_check_list_equals_SETUP_MINUTES_OPTIONS', () => {
    expect(checkList(SQL, 'setup_minutes')).toEqual([...SETUP_MINUTES_OPTIONS]);
  });

  it('SCRUM20_SCRUM137_the_check_list_equals_the_turnaround_check_in_017', () => {
    // Equal today by agreement, not by construction: two columns, two CHECKs.
    const turnaround = checkList(SQL_017, 'turnaround_minutes');
    expect(turnaround).not.toBeNull();
    expect(checkList(SQL, 'setup_minutes')).toEqual(turnaround);
  });

  it('SCRUM20_SCRUM137_023_does_not_touch_the_turnaround_column_or_its_check', () => {
    const outside = SQL.replace(CREATE_023, '').replace(UPDATE_023, '');
    expect(outside).not.toContain('turnaround_minutes');
    expect(SQL).not.toContain('venues_turnaround_minutes_allowed');
  });
});


describe('SCRUM20_SCRUM137 023 drops 017s functions by their exact signature first', () => {
  it('SCRUM20_SCRUM137_both_functions_exist_in_017_and_023', () => {
    // Guards the helpers below: a null here would make every other test vacuous.
    expect(CREATE_017).not.toBeNull();
    expect(UPDATE_017).not.toBeNull();
    expect(CREATE_023).not.toBeNull();
    expect(UPDATE_023).not.toBeNull();
  });

  it.each([
    ['create_venue', 'text, text, integer, text[], text[], text[], jsonb, integer, uuid'],
    ['update_venue', 'uuid, text, text, integer, text[], text[], text[], jsonb, integer, uuid'],
  ])('SCRUM20_SCRUM137_drop_%s_uses_the_017_signature', (name, literal) => {
    const signature017 = signatureOf(functionText(SQL_017, name));
    // The literal and the parsed 017 list must agree, or the parser is wrong.
    expect(signature017).toBe(literal);
    expect(SQL).toContain(`drop function if exists ${name}(${signature017});`);
  });

  it.each(['create_venue', 'update_venue'])(
    'SCRUM20_SCRUM137_drop_%s_precedes_its_create_or_replace',
    (name) => {
      const drops = allIndexes(SQL, `drop function if exists ${name}(`);
      const creates = allIndexes(SQL, `create or replace function ${name}(`);
      expect(drops).toHaveLength(1);
      expect(creates).toHaveLength(1);
      expect(drops[0]).toBeLessThan(creates[0]);
    },
  );

  it.each(['create_venue', 'update_venue'])(
    'SCRUM20_SCRUM137_the_new_%s_signature_is_not_the_one_dropped',
    (name) => {
      // Otherwise the drop would remove the new function on a re-run and the
      // old one would never be cleared.
      expect(signatureOf(functionText(SQL, name))).not.toBe(
        signatureOf(functionText(SQL_017, name)),
      );
    },
  );

  it('SCRUM20_SCRUM137_no_migration_after_017_and_before_023_redefines_either_function', () => {
    // 023's header says 017's signatures are the ones to drop because nothing
    // in 018-022 redefines them. Pin that, so a later edit cannot leave an
    // overload behind (PGRST203).
    const between = [
      '018_reassign_event_request.sql',
      '019_change_request_decision_coordinator.sql',
      '020_event_status_lifecycle.sql',
      '021_event_status_history.sql',
      '022_equipment_schema.sql',
      '022_event_status_transitions.sql',
    ];
    for (const name of between) {
      expect(normalised(name), name).not.toMatch(/function (create_venue|update_venue)\(/);
    }
  });
});


describe('SCRUM20_SCRUM137 023 adds p_setup_minutes to both functions', () => {
  it.each([
    ['create_venue', () => CREATE_023],
    ['update_venue', () => UPDATE_023],
  ])('SCRUM20_SCRUM137_%s_takes_p_setup_minutes_integer_default_null_after_p_turnaround_minutes', (_name, fn) => {
    const params = paramsOf(fn());
    expect(params).toContain('p_setup_minutes integer default null');
    expectInOrder(params, [
      ['p_hours', 'p_hours jsonb'],
      ['p_turnaround_minutes', 'p_turnaround_minutes integer default null'],
      ['p_setup_minutes', 'p_setup_minutes integer default null'],
      ['p_user_id', 'p_user_id uuid default null'],
    ]);
  });

  it.each([
    ['create_venue', () => CREATE_023, () => CREATE_017],
    ['update_venue', () => UPDATE_023, () => UPDATE_017],
  ])('SCRUM20_SCRUM137_%s_params_are_017s_plus_only_p_setup_minutes', (_name, fn023, fn017) => {
    const names = paramNamesOf(fn023());
    const at = names.indexOf('p_setup_minutes');
    expect(names[at - 1]).toBe('p_turnaround_minutes');
    expect(names.filter((n) => n !== 'p_setup_minutes')).toEqual(paramNamesOf(fn017()));
    // Every other parameter keeps 017's declaration word for word.
    expect(paramsOf(fn023()).replace(' p_setup_minutes integer default null,', '')).toBe(
      paramsOf(fn017()),
    );
  });

  it.each([
    ['create_venue', () => CREATE_023],
    ['update_venue', () => UPDATE_023],
  ])('SCRUM20_SCRUM137_%s_keeps_its_return_type', (name, fn) => {
    const expected = name === 'create_venue' ? ') returns uuid ' : ') returns void ';
    expect(fn()).toContain(expected);
  });

  it('SCRUM20_SCRUM137_create_venue_inserts_coalesce_p_setup_minutes_0', () => {
    expect(bodyOf(CREATE_023)).toContain(
      'insert into venues (name, location, max_capacity, turnaround_minutes, setup_minutes, last_modified_by) ' +
      'values (p_name, p_location, p_max_capacity, coalesce(p_turnaround_minutes, 0), coalesce(p_setup_minutes, 0), p_user_id)',
    );
  });

  it('SCRUM20_SCRUM137_update_venue_sets_coalesce_p_setup_minutes_setup_minutes', () => {
    expect(bodyOf(UPDATE_023)).toContain('setup_minutes = coalesce(p_setup_minutes, setup_minutes)');
  });

  it('SCRUM20_SCRUM137_update_venue_never_treats_0_as_missing', () => {
    // nullif(p_setup_minutes, 0) or a `> 0` test would make "back to none" a no-op.
    const body = bodyOf(UPDATE_023);
    expect(body).not.toMatch(/nullif\(p_setup_minutes/);
    expect(body).not.toMatch(/p_setup_minutes\s*(>|<>|!=)\s*0/);
  });
});


describe('SCRUM20_SCRUM137 023 keeps 017s behaviour', () => {
  it('SCRUM20_SCRUM137_create_venue_body_is_017s_plus_only_the_setup', () => {
    const stripped = bodyOf(CREATE_023)
      .replace('turnaround_minutes, setup_minutes, ', 'turnaround_minutes, ')
      .replace('coalesce(p_setup_minutes, 0), ', '');
    expect(stripped).toBe(bodyOf(CREATE_017));
  });

  it('SCRUM20_SCRUM137_update_venue_body_is_017s_plus_only_the_setup', () => {
    const stripped = bodyOf(UPDATE_023)
      .replace('setup_minutes = coalesce(p_setup_minutes, setup_minutes), ', '');
    expect(stripped).toBe(bodyOf(UPDATE_017));
  });

  it('SCRUM20_SCRUM137_turnaround_is_still_written_by_both_functions', () => {
    expect(bodyOf(CREATE_023)).toContain('coalesce(p_turnaround_minutes, 0)');
    expect(bodyOf(UPDATE_023)).toContain(
      'turnaround_minutes = coalesce(p_turnaround_minutes, turnaround_minutes)',
    );
  });

  it('SCRUM20_SCRUM137_create_venue_records_the_attribute_change_against_an_empty_snapshot', () => {
    expectInOrder(bodyOf(CREATE_023), [
      ['insert venues', 'insert into venues'],
      ['record change', 'perform record_venue_attribute_change(v_id, venue_attribute_snapshot(null), venue_attribute_snapshot(v_id), p_user_id)'],
      ['return', 'return v_id;'],
    ]);
  });

  it('SCRUM20_SCRUM137_update_venue_snapshots_first_raises_no_data_found_and_records_the_change', () => {
    expectInOrder(bodyOf(UPDATE_023), [
      ['before snapshot', 'v_before := venue_attribute_snapshot(p_id);'],
      ['update venues', 'update venues set'],
      ['not found raise', "if not found then raise exception 'venue % not found', p_id using errcode = 'no_data_found';"],
      ['record change', 'perform record_venue_attribute_change(p_id, v_before, venue_attribute_snapshot(p_id), p_user_id);'],
    ]);
  });

  it.each(ATTRIBUTE_TABLES)('SCRUM20_SCRUM137_create_venue_still_writes_%s', (table) => {
    expect(bodyOf(CREATE_023)).toContain(`insert into ${table} (venue_id,`);
  });

  it.each(ATTRIBUTE_TABLES)('SCRUM20_SCRUM137_update_venue_still_replaces_%s_only_when_given', (table) => {
    expectInOrder(bodyOf(UPDATE_023), [
      [`delete ${table}`, `delete from ${table} where venue_id = p_id;`],
      [`insert ${table}`, `insert into ${table} (venue_id,`],
    ]);
  });

  it.each(['p_layouts', 'p_accessibility', 'p_facilities', 'p_hours'])(
    'SCRUM20_SCRUM137_update_venue_still_guards_%s_with_is_not_null',
    (param) => {
      expect(bodyOf(UPDATE_023)).toContain(`if ${param} is not null then`);
    },
  );
});


describe('SCRUM20_SCRUM137 023 redefines nothing else', () => {
  it('SCRUM20_SCRUM137_only_create_venue_and_update_venue_are_created', () => {
    const created = [...SQL.matchAll(/create (?:or replace )?function (\w+)\s*\(/g)].map((m) => m[1]);
    expect(created.sort()).toEqual(['create_venue', 'update_venue']);
  });

  it.each([
    'record_venue_creation',
    'venue_attribute_snapshot',
    'record_venue_attribute_change',
    'record_venue_change',
  ])('SCRUM20_SCRUM137_%s_is_not_redefined', (name) => {
    expect(SQL).not.toMatch(new RegExp(`create (or replace )?function ${name}\\b`));
  });

  it('SCRUM20_SCRUM137_no_trigger_is_created_or_dropped', () => {
    expect(SQL).not.toMatch(/create (or replace )?(constraint )?trigger\b/);
    expect(SQL).not.toMatch(/drop trigger\b/);
  });

  it('SCRUM20_SCRUM137_no_table_is_created_or_dropped', () => {
    expect(SQL).not.toMatch(/\b(create|drop) table\b/);
  });

  it('SCRUM20_SCRUM137_there_is_no_grant_or_revoke', () => {
    expect(SQL).not.toMatch(/\bgrant\b/);
    expect(SQL).not.toMatch(/\brevoke\b/);
  });

  it('SCRUM20_SCRUM137_setup_minutes_is_not_added_to_venue_attribute_snapshot', () => {
    // 003's diff trigger records a setup change once; adding it to the
    // snapshot would record it twice.
    expect(SQL).not.toMatch(/venue_attribute_snapshot[^;]*setup/);
  });

  it('SCRUM20_SCRUM137_notify_pgrst_reload_schema_is_the_last_statement', () => {
    expect(SQL.endsWith("notify pgrst, 'reload schema';")).toBe(true);
    expect(allIndexes(SQL, 'notify pgrst')).toHaveLength(1);
  });

  it('SCRUM20_SCRUM137_the_raw_file_really_has_comments_that_were_stripped', () => {
    // Proves the stripping matters: the header names record_venue_change and
    // venue_attribute_snapshot (to explain why neither changes), and none of
    // the "nothing else" tests may rely on those mentions.
    expect(rawSql('023_venue_setup_time.sql')).toMatch(/record_venue_change/);
    expect(rawSql('023_venue_setup_time.sql')).toMatch(/NOT added to venue_attribute_snapshot/);
    expect(SQL).not.toContain('record_venue_change');
  });
});
