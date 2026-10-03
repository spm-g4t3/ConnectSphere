/**
 * Tests for 017_venue_turnaround.sql, read from the migration text.
 *
 * SCRUM-186 (part of SCRUM-15): "Define the operating hours model (per
 * weekday) and the turnaround field". CI has no database, so these pin the
 * shape of 017 with every `--` comment stripped -- the header talks about
 * triggers and venue_attribute_snapshot, so a rule that exists only in a
 * comment must not count, and the "nothing else is redefined" checks match
 * `create ... function` / `create trigger` statements rather than bare words.
 *
 * The second half pins the per-weekday hours model from 002, which SCRUM-186
 * verifies rather than changes. Helpers copied from
 * venueBlockHistoryMigration.test.js.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** A migration's raw text, comments included. */
function rawSql(name) {
  return readFileSync(resolve(here, `../../db/migrations/${name}`), 'utf8');
}

/** A migration with every `--` comment stripped, whitespace collapsed, lower-cased. */
function normalised(name) {
  return rawSql(name).replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').toLowerCase().trim();
}

const SQL = normalised('017_venue_turnaround.sql');
const SQL_008 = normalised('008_venue_audit_completion.sql');
const SQL_002 = normalised('002_venues.sql');

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

const CREATE_017 = functionText(SQL, 'create_venue');
const UPDATE_017 = functionText(SQL, 'update_venue');
const CREATE_008 = functionText(SQL_008, 'create_venue');
const UPDATE_008 = functionText(SQL_008, 'update_venue');

const ATTRIBUTE_TABLES = [
  'venue_room_layouts',
  'venue_accessibility_features',
  'venue_facilities',
  'venue_operating_hours',
];


describe('SCRUM186 017 adds the turnaround column re-runnably', () => {
  it('SCRUM186_the_column_is_added_with_if_not_exists_smallint_not_null_default_0', () => {
    expect(SQL).toContain(
      'alter table venues add column if not exists turnaround_minutes smallint not null default 0;',
    );
  });

  it('SCRUM186_the_constraint_is_dropped_if_exists_before_it_is_added', () => {
    expectInOrder(SQL, [
      ['add column', 'add column if not exists turnaround_minutes'],
      ['drop constraint', 'alter table venues drop constraint if exists venues_turnaround_minutes_allowed;'],
      ['add constraint', 'alter table venues add constraint venues_turnaround_minutes_allowed'],
    ]);
    expect(allIndexes(SQL, 'add constraint venues_turnaround_minutes_allowed')).toHaveLength(1);
  });

  it('SCRUM186_the_constraint_lists_exactly_the_agreed_values', () => {
    expect(SQL).toContain(
      'add constraint venues_turnaround_minutes_allowed check (turnaround_minutes in (0, 15, 30, 45, 60, 90, 120));',
    );
  });
});


describe('SCRUM186 017 drops 008s functions by their exact signature first', () => {
  it('SCRUM186_both_functions_exist_in_008_and_017', () => {
    // Guards the helpers below: a null here would make every other test vacuous.
    expect(CREATE_008).not.toBeNull();
    expect(UPDATE_008).not.toBeNull();
    expect(CREATE_017).not.toBeNull();
    expect(UPDATE_017).not.toBeNull();
  });

  it.each([
    ['create_venue', 'text, text, integer, text[], text[], text[], jsonb, uuid'],
    ['update_venue', 'uuid, text, text, integer, text[], text[], text[], jsonb, uuid'],
  ])('SCRUM186_drop_%s_uses_the_008_signature', (name, literal) => {
    const signature008 = signatureOf(functionText(SQL_008, name));
    // The literal and the parsed 008 list must agree, or the parser is wrong.
    expect(signature008).toBe(literal);
    expect(SQL).toContain(`drop function if exists ${name}(${signature008});`);
  });

  it.each(['create_venue', 'update_venue'])(
    'SCRUM186_drop_%s_precedes_its_create_or_replace',
    (name) => {
      const drops = allIndexes(SQL, `drop function if exists ${name}(`);
      const creates = allIndexes(SQL, `create or replace function ${name}(`);
      expect(drops).toHaveLength(1);
      expect(creates).toHaveLength(1);
      expect(drops[0]).toBeLessThan(creates[0]);
    },
  );

  it.each(['create_venue', 'update_venue'])(
    'SCRUM186_the_new_%s_signature_is_not_the_one_dropped',
    (name) => {
      // Otherwise the drop would remove the new function on a re-run and the
      // old one would never be cleared.
      const fn = functionText(SQL, name);
      expect(signatureOf(fn)).not.toBe(signatureOf(functionText(SQL_008, name)));
    },
  );
});


describe('SCRUM186 017 adds p_turnaround_minutes to both functions', () => {
  it.each([
    ['create_venue', () => CREATE_017],
    ['update_venue', () => UPDATE_017],
  ])('SCRUM186_%s_takes_p_turnaround_minutes_integer_default_null_after_p_hours', (_name, fn) => {
    const params = paramsOf(fn());
    expect(params).toContain('p_turnaround_minutes integer default null');
    expectInOrder(params, [
      ['p_hours', 'p_hours jsonb'],
      ['p_turnaround_minutes', 'p_turnaround_minutes integer default null'],
      ['p_user_id', 'p_user_id uuid default null'],
    ]);
  });

  it('SCRUM186_create_venue_inserts_coalesce_p_turnaround_minutes_0', () => {
    const body = bodyOf(CREATE_017);
    expect(body).toContain(
      'insert into venues (name, location, max_capacity, turnaround_minutes, last_modified_by) ' +
      'values (p_name, p_location, p_max_capacity, coalesce(p_turnaround_minutes, 0), p_user_id)',
    );
  });

  it('SCRUM186_update_venue_sets_coalesce_p_turnaround_minutes_turnaround_minutes', () => {
    const body = bodyOf(UPDATE_017);
    expect(body).toContain('turnaround_minutes = coalesce(p_turnaround_minutes, turnaround_minutes)');
  });
});


describe('SCRUM186 017 keeps 008s behaviour', () => {
  it('SCRUM186_create_venue_body_is_008s_plus_only_the_turnaround', () => {
    const stripped = bodyOf(CREATE_017)
      .replace('turnaround_minutes, ', '')
      .replace('coalesce(p_turnaround_minutes, 0), ', '');
    expect(stripped).toBe(bodyOf(CREATE_008));
  });

  it('SCRUM186_update_venue_body_is_008s_plus_only_the_turnaround', () => {
    const stripped = bodyOf(UPDATE_017)
      .replace('turnaround_minutes = coalesce(p_turnaround_minutes, turnaround_minutes), ', '');
    expect(stripped).toBe(bodyOf(UPDATE_008));
  });

  it('SCRUM186_create_venue_records_the_attribute_change_against_an_empty_snapshot', () => {
    expectInOrder(bodyOf(CREATE_017), [
      ['insert venues', 'insert into venues'],
      ['record change', 'perform record_venue_attribute_change( v_id, venue_attribute_snapshot(null), venue_attribute_snapshot(v_id), p_user_id )'],
      ['return', 'return v_id;'],
    ]);
  });

  it('SCRUM186_update_venue_snapshots_first_raises_no_data_found_and_records_the_change', () => {
    expectInOrder(bodyOf(UPDATE_017), [
      ['before snapshot', 'v_before := venue_attribute_snapshot(p_id);'],
      ['update venues', 'update venues set'],
      ['not found raise', "if not found then raise exception 'venue % not found', p_id using errcode = 'no_data_found';"],
      ['record change', 'perform record_venue_attribute_change( p_id, v_before, venue_attribute_snapshot(p_id), p_user_id );'],
    ]);
  });

  it.each(ATTRIBUTE_TABLES)('SCRUM186_create_venue_still_writes_%s', (table) => {
    expect(bodyOf(CREATE_017)).toContain(`insert into ${table} (venue_id,`);
  });

  it.each(ATTRIBUTE_TABLES)('SCRUM186_update_venue_still_replaces_%s', (table) => {
    expectInOrder(bodyOf(UPDATE_017), [
      [`delete ${table}`, `delete from ${table} where venue_id = p_id;`],
      [`insert ${table}`, `insert into ${table} (venue_id,`],
    ]);
  });
});


describe('SCRUM186 017 redefines nothing else', () => {
  it('SCRUM186_only_create_venue_and_update_venue_are_created', () => {
    const created = [...SQL.matchAll(/create (?:or replace )?function (\w+)\s*\(/g)].map((m) => m[1]);
    expect(created.sort()).toEqual(['create_venue', 'update_venue']);
  });

  it.each([
    'record_venue_creation',
    'venue_attribute_snapshot',
    'record_venue_attribute_change',
    'record_venue_change',
  ])('SCRUM186_%s_is_not_redefined', (name) => {
    expect(SQL).not.toMatch(new RegExp(`create (or replace )?function ${name}\\b`));
  });

  it('SCRUM186_no_trigger_is_created_or_dropped', () => {
    expect(SQL).not.toMatch(/create (or replace )?(constraint )?trigger\b/);
    expect(SQL).not.toMatch(/drop trigger\b/);
  });

  it('SCRUM186_there_is_no_grant_or_revoke', () => {
    expect(SQL).not.toMatch(/\bgrant\b/);
    expect(SQL).not.toMatch(/\brevoke\b/);
  });

  it('SCRUM186_venue_attribute_snapshot_is_only_called_not_changed', () => {
    // The plan keeps turnaround out of the snapshot so a change is recorded
    // once, by 003's diff trigger.
    expect(SQL).not.toMatch(/venue_attribute_snapshot[^;]*turnaround/);
  });

  it('SCRUM186_notify_pgrst_reload_schema_is_the_last_statement', () => {
    expect(SQL.endsWith("notify pgrst, 'reload schema';")).toBe(true);
    expect(allIndexes(SQL, 'notify pgrst')).toHaveLength(1);
  });

  it('SCRUM186_the_raw_file_really_has_comments_that_were_stripped', () => {
    // Proves the stripping matters: the header mentions triggers and the
    // snapshot, and none of the "nothing else" tests may rely on them.
    expect(rawSql('017_venue_turnaround.sql')).toMatch(/trigger/i);
    expect(rawSql('017_venue_turnaround.sql')).toMatch(/venue_attribute_snapshot/);
  });
});


describe('SCRUM186 the per-weekday operating hours model from 002 stands', () => {
  const HOURS_TABLE = (() => {
    const from = SQL_002.indexOf('create table if not exists venue_operating_hours (');
    if (from === -1) return '';
    return SQL_002.slice(from, SQL_002.indexOf(');', SQL_002.indexOf('venue_operating_hours_ordered', from)) + 2);
  })();

  it('SCRUM186_hours_table_exists_in_002', () => {
    expect(HOURS_TABLE).not.toBe('');
  });

  it('SCRUM186_one_window_per_day_primary_key_venue_id_day_of_week', () => {
    expect(HOURS_TABLE).toContain('primary key (venue_id, day_of_week)');
  });

  it('SCRUM186_day_of_week_is_checked_between_0_and_6', () => {
    expect(HOURS_TABLE).toContain('day_of_week smallint not null check (day_of_week between 0 and 6)');
  });

  it('SCRUM186_closing_must_be_after_opening_so_no_overnight_hours', () => {
    expect(HOURS_TABLE).toContain(
      'constraint venue_operating_hours_ordered check (closes_at > opens_at)',
    );
  });

  it('SCRUM186_opens_and_closes_are_time_of_day_not_null', () => {
    expect(HOURS_TABLE).toContain('opens_at time not null');
    expect(HOURS_TABLE).toContain('closes_at time not null');
  });

  it('SCRUM186_there_is_no_closed_flag_a_missing_day_is_closed', () => {
    expect(HOURS_TABLE).not.toMatch(/\bclosed\b|is_closed|is_open/);
  });

  it('SCRUM186_017_changes_no_hours_schema', () => {
    // 017's recreated create_venue / update_venue still write hours rows (as
    // 008's did), so the table name does appear in their bodies. What 017
    // must not do is change the table itself.
    expect(SQL).not.toMatch(/(alter|create|drop) table (if (not )?exists )?venue_operating_hours\b/);
    expect(SQL).not.toMatch(/venue_operating_hours_ordered/);
  });

  it('SCRUM186_017_mentions_venue_operating_hours_only_inside_the_two_function_bodies', () => {
    const outside = SQL.replace(CREATE_017, '').replace(UPDATE_017, '');
    expect(outside).not.toContain('venue_operating_hours');
  });
});
