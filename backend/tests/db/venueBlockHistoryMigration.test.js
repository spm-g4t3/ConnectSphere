/**
 * Tests for venue_block_history and its trigger, read from the migration text.
 *
 * SCRUM-131 (part of SCRUM-17, AC4: "with the creating or amending user and
 * timestamp recorded"). CI has no database, so these pin the shape of
 * 016_venue_block_history.sql with every `--` comment stripped -- a rule that
 * exists only in a comment does not count. Helpers copied from
 * venueBlockAmendRemoveMigration.test.js.
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
  return rawSql(name).replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').toLowerCase();
}

const FILE = '016_venue_block_history.sql';
const RAW = rawSql(FILE);
const SQL = normalised(FILE);

const FUNCTION_START = 'create or replace function record_venue_block_change(';

/** One function's text: from its `create or replace` to the `$$;` that ends it. */
function functionText(sql, start) {
  const from = sql.indexOf(start);
  if (from === -1) return null;
  const end = sql.indexOf('$$;', sql.indexOf('$$', from) + 2);
  return end === -1 ? null : sql.slice(from, end + 3);
}

/** The body between a function's $$ quotes. */
function bodyOf(text) {
  const open = text.indexOf('$$');
  const close = text.lastIndexOf('$$');
  return text.slice(open + 2, close);
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

const FN = functionText(SQL, FUNCTION_START);
const BODY = FN ? bodyOf(FN) : '';

/** The create table statement, up to its closing `);`. */
const TABLE = (() => {
  const from = SQL.indexOf('create table if not exists venue_block_history (');
  if (from === -1) return '';
  return SQL.slice(from, SQL.indexOf(');', SQL.indexOf('new_values', from)) + 2);
})();

const TRIGGER_DROP = 'drop trigger if exists venue_blocks_record_change on venue_blocks;';
const TRIGGER_CREATE = 'create trigger venue_blocks_record_change';
const BACKFILL_START =
  'insert into venue_block_history (block_id, action, changed_by, changed_at, old_values, new_values)';

/** The backfill: from its insert to the `;` that ends it. */
const BACKFILL = (() => {
  const from = SQL.indexOf(BACKFILL_START);
  if (from === -1) return '';
  return SQL.slice(from, SQL.indexOf(';', from) + 1);
})();

/** The INSERT branch: from `if tg_op = 'insert'` to its `end if;`. */
const INSERT_BRANCH = (() => {
  const from = BODY.indexOf("if tg_op = 'insert' then");
  if (from === -1) return '';
  return BODY.slice(from, BODY.indexOf('end if;', from) + 'end if;'.length);
})();

/** Everything in the body after the INSERT branch: the UPDATE path. */
const UPDATE_PATH = INSERT_BRANCH ? BODY.slice(BODY.indexOf(INSERT_BRANCH) + INSERT_BRANCH.length) : '';


describe('SCRUM17_AC4 the venue_block_history table', () => {
  it('SCRUM17_AC4_creates_the_table_if_not_exists', () => {
    expect(TABLE).not.toBe('');
  });

  it('SCRUM17_AC4_has_a_uuid_primary_key_with_a_default', () => {
    expect(TABLE).toContain('id uuid primary key default gen_random_uuid()');
  });

  it('SCRUM17_AC4_block_id_references_venue_blocks_on_delete_restrict', () => {
    expect(TABLE).toContain('block_id uuid not null references venue_blocks (id) on delete restrict');
  });

  it('SCRUM17_AC4_nothing_cascades', () => {
    expect(SQL).not.toContain('cascade');
  });

  it('SCRUM17_AC4_action_is_text_with_a_named_check_of_exactly_three_values', () => {
    expect(TABLE).toContain(
      "action text not null constraint venue_block_history_action_known check (action in ('created', 'amended', 'removed'))",
    );
    const list = TABLE.match(/check \(action in \(([^)]*)\)\)/);
    expect(list).not.toBeNull();
    expect(list[1].split(',').map((v) => v.trim())).toEqual(["'created'", "'amended'", "'removed'"]);
  });

  it('SCRUM17_AC4_action_is_not_an_enum', () => {
    expect(SQL).not.toMatch(/create type/);
  });

  it('SCRUM17_AC4_changed_by_references_auth_users_and_is_nullable', () => {
    expect(TABLE).toMatch(/changed_by uuid references auth\.users \(id\),/);
    expect(TABLE).not.toMatch(/changed_by uuid[^,]*not null/);
  });

  it('SCRUM17_AC4_changed_at_is_not_null_and_defaults_to_now', () => {
    expect(TABLE).toContain('changed_at timestamptz not null default now()');
  });

  it('SCRUM17_AC4_old_and_new_values_are_jsonb_not_null', () => {
    expect(TABLE).toContain('old_values jsonb not null');
    expect(TABLE).toContain('new_values jsonb not null');
  });

  it('SCRUM17_AC4_has_no_venue_id_column', () => {
    expect(TABLE).not.toContain('venue_id');
  });

  it('SCRUM17_AC4_indexes_block_id_then_changed_at_desc', () => {
    expect(SQL).toContain(
      'create index if not exists idx_venue_block_history_block on venue_block_history (block_id, changed_at desc);',
    );
  });
});


describe('SCRUM17_AC4 record_venue_block_change()', () => {
  it('SCRUM17_AC4_defines_the_function_once_as_a_plpgsql_trigger', () => {
    expect(FN).not.toBeNull();
    expect(SQL.split(FUNCTION_START)).toHaveLength(2);
    expect(FN).toContain('returns trigger');
    expect(FN).toContain('language plpgsql');
  });

  it('SCRUM17_AC4_is_not_security_definer', () => {
    // the raw file mentions it in a comment only
    expect(SQL).not.toContain('security definer');
  });

  it('SCRUM17_AC4_does_not_read_auth_uid', () => {
    expect(SQL).not.toContain('auth.uid');
  });

  it('SCRUM17_AC4_branches_on_tg_op_insert', () => {
    expect(INSERT_BRANCH).not.toBe('');
  });

  it('SCRUM17_AC4_insert_writes_a_created_row_by_last_modified_by_with_empty_old_values', () => {
    expect(INSERT_BRANCH).toContain(
      "values (new.id, 'created', new.last_modified_by, '{}'::jsonb, new_row - 'updated_at' - 'last_modified_by');",
    );
    expect(INSERT_BRANCH).toContain('return null;');
  });

  it('SCRUM17_AC4_the_new_row_is_the_whole_record', () => {
    expect(BODY).toContain('new_row jsonb := to_jsonb(new);');
    expect(UPDATE_PATH).toContain('old_row := to_jsonb(old);');
  });

  it('SCRUM17_AC4_update_diff_skips_updated_at_and_last_modified_by', () => {
    expect(UPDATE_PATH).toContain("if col in ('updated_at', 'last_modified_by') then continue; end if;");
  });

  it('SCRUM17_AC4_update_diff_uses_is_distinct_from', () => {
    expect(UPDATE_PATH).toContain('if old_row -> col is distinct from new_row -> col then');
    expect(UPDATE_PATH).toContain('for col in select jsonb_object_keys(new_row) loop');
  });

  it('SCRUM17_AC4_an_empty_diff_returns_before_the_update_insert', () => {
    const inserts = allIndexes(BODY, 'insert into venue_block_history');
    expect(inserts).toHaveLength(2);
    const emptyCheck = BODY.indexOf("if old_changed = '{}'::jsonb then return null; end if;");
    expect(emptyCheck).toBeGreaterThan(inserts[0]);
    expect(emptyCheck).toBeLessThan(inserts[1]);
  });

  it('SCRUM17_AC4_names_removal_only_on_the_null_to_set_transition', () => {
    expect(UPDATE_PATH).toContain(
      "case when old.removed_at is null and new.removed_at is not null then 'removed' else 'amended' end",
    );
  });

  it('SCRUM17_AC4_the_update_row_records_last_modified_by_and_only_the_changed_keys', () => {
    expectInOrder(UPDATE_PATH, [
      ['insert', 'insert into venue_block_history (block_id, action, changed_by, old_values, new_values)'],
      ['block id', 'new.id,'],
      ['action', 'case when'],
      ['changed_by', 'new.last_modified_by,'],
      ['old', 'old_changed,'],
      ['new', 'new_changed );'],
    ]);
  });

  it('SCRUM17_AC4_never_writes_the_block_table_itself', () => {
    expect(BODY).not.toMatch(/update venue_blocks|insert into venue_blocks|delete from/);
  });
});


describe('SCRUM17_AC4 the trigger', () => {
  it('SCRUM17_AC4_drops_if_exists_before_creating', () => {
    expectInOrder(SQL, [
      ['function', FUNCTION_START],
      ['drop', TRIGGER_DROP],
      ['create', TRIGGER_CREATE],
    ]);
  });

  it('SCRUM17_AC4_fires_after_insert_or_update_for_each_row', () => {
    expect(SQL).toContain(
      'create trigger venue_blocks_record_change after insert or update on venue_blocks for each row execute function record_venue_block_change();',
    );
    expect(SQL).not.toMatch(/before insert or update on venue_blocks/);
  });
});


describe('SCRUM17_AC4 the backfill', () => {
  it('SCRUM17_AC4_exists', () => {
    expect(BACKFILL).not.toBe('');
  });

  it('SCRUM17_AC4_runs_after_the_trigger_exists', () => {
    expect(SQL.indexOf(BACKFILL_START)).toBeGreaterThan(SQL.indexOf(TRIGGER_CREATE));
    expect(SQL.indexOf(TRIGGER_CREATE)).toBeGreaterThan(-1);
  });

  it('SCRUM17_AC4_writes_created_rows_stamped_with_created_by_and_created_at', () => {
    expect(BACKFILL).toContain(
      "select b.id, 'created', b.created_by, b.created_at, '{}'::jsonb, to_jsonb(b) - 'updated_at' - 'last_modified_by'",
    );
    expect(BACKFILL).toContain('from venue_blocks b');
  });

  it('SCRUM17_AC4_skips_blocks_that_already_have_history', () => {
    expect(BACKFILL).toContain(
      'where not exists ( select 1 from venue_block_history h where h.block_id = b.id )',
    );
  });

  it('SCRUM17_AC4_excludes_updated_at_and_last_modified_by_everywhere_a_row_is_snapshotted', () => {
    // INSERT branch, UPDATE diff, backfill
    expect(INSERT_BRANCH).toContain("- 'updated_at' - 'last_modified_by'");
    expect(UPDATE_PATH).toContain("('updated_at', 'last_modified_by')");
    expect(BACKFILL).toContain("- 'updated_at' - 'last_modified_by'");
  });
});


describe('SCRUM17_AC4 row level security and scope', () => {
  it('SCRUM17_AC4_enables_rls_with_no_policy', () => {
    expect(SQL).toContain('alter table venue_block_history enable row level security;');
    expect(SQL).not.toContain('create policy');
  });

  it('SCRUM17_AC4_grants_nothing', () => {
    expect(SQL).not.toMatch(/\bgrant\b/);
  });

  it('SCRUM17_AC4_notify_pgrst_is_the_last_statement', () => {
    expect(SQL.trim().endsWith("notify pgrst, 'reload schema';")).toBe(true);
    expect(allIndexes(SQL, 'notify pgrst')).toHaveLength(1);
  });

  it('SCRUM17_AC4_the_raw_file_ends_with_notify_too', () => {
    // a comment precedes it, but nothing follows it
    expect(RAW.trim().endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });

  it.each(['create_venue_block', 'update_venue_block', 'remove_venue_block', 'flag_bookings_for_block'])(
    'SCRUM17_AC4_redefines_no_rpc_(%s)',
    (name) => {
      expect(SQL).not.toMatch(new RegExp(`function ${name}\\b`));
    },
  );

  it('SCRUM17_AC4_defines_only_the_one_function', () => {
    expect(allIndexes(SQL, 'create or replace function')).toHaveLength(1);
    expect(allIndexes(SQL, 'create function')).toHaveLength(0);
  });

  it('SCRUM17_AC4_touches_no_booking', () => {
    expect(SQL).not.toContain('update bookings');
    expect(SQL).not.toMatch(/\bbookings\b/);
  });
});
