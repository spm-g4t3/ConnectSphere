/**
 * Tests for 033_venue_occupancy_callers.sql, read from the migration text.
 *
 * SCRUM-484 "Configure Venue Setup and Turnaround Times" (sub-tasks 3, 4 and
 * 5: every availability check uses the shared occupied period). 033 replaces
 * the period check of create_venue_block, update_venue_block,
 * flag_bookings_for_block and create_booking_request with a call to
 * venue_occupancy_conflicts() (032), adds available_venue_ids() for venue
 * search, and drops 013's raw helper venue_block_booking_conflicts().
 *
 * These pin the shape of the migration with every `--` comment stripped: its
 * header explains the rule in prose, so a rule that exists only in a comment
 * must not count. The behaviour itself is exercised against a real Postgres in
 * venueBlockOccupancyDatabase.test.js, bookingRequestOccupancyDatabase.test.js
 * and venueSearchOccupancyDatabase.test.js.
 *
 * Same helpers as venueOccupancyFunctionMigration.test.js.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '../../db/migrations');
const FILE = '033_venue_occupancy_callers.sql';

/**
 * A migration with every `--` comment stripped, whitespace collapsed,
 * lower-cased, and the space just inside parentheses removed (layout, not
 * behaviour).
 */
function normalised(name) {
  return readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8')
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .toLowerCase()
    .trim();
}

const SQL = normalised(FILE);

/** Every migration file, in the order they sort (and are applied). */
const ALL_FILES = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

/** One function's text in `sql`: from its `create or replace` to the `$$;` that ends it. */
function functionText(sql, name) {
  const from = sql.indexOf(`create or replace function ${name}(`);
  if (from === -1) return null;
  const end = sql.indexOf('$$;', sql.indexOf('$$', from) + 2);
  return end === -1 ? null : sql.slice(from, end + 3);
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

/** The file holding the last `create or replace function name(` across every migration. */
function latestDefinitionFile(name) {
  let latest = null;
  for (const file of ALL_FILES) {
    if (normalised(file).includes(`create or replace function ${name}(`)) latest = file;
  }
  return latest;
}

const REPLACED = [
  'flag_bookings_for_block',
  'create_venue_block',
  'update_venue_block',
  'create_booking_request',
];

/** The file each replaced function was last defined in before 033. */
const PREVIOUS = {
  flag_bookings_for_block: '014_booking_review_notifications.sql',
  create_venue_block: '014_booking_review_notifications.sql',
  update_venue_block: '015_venue_block_amend_remove.sql',
  create_booking_request: '030_create_booking_request.sql',
};

const BLOCK_FUNCTIONS = ['create_venue_block', 'update_venue_block', 'flag_bookings_for_block'];

const TEXT = Object.fromEntries(
  [...REPLACED, 'available_venue_ids'].map((name) => [name, functionText(SQL, name)]),
);
const BODY = Object.fromEntries(
  Object.entries(TEXT).map(([name, text]) => [name, text ? bodyOf(text) : '']),
);

/** The four occupied keys every booking conflict gains (AC7). */
const OCCUPIED_KEYS = [
  "'occupied_starts_at', c.occupied_starts_at",
  "'occupied_ends_at', c.occupied_ends_at",
  "'setup_minutes', c.setup_minutes",
  "'turnaround_minutes', c.turnaround_minutes",
];

/** 033's locked CTE: approved bookings named by the shared function, unpadded block. */
function lockedCte(startArg, endArg) {
  return (
    'with locked as (select b.id from bookings b ' +
    "where b.status = 'approved' and b.id in (select c.id " +
    `from venue_occupancy_conflicts(p_venue_id, ${startArg}, ${endArg}, false) c ` +
    "where c.kind = 'booking') order by b.id for no key update of b)"
  );
}


describe('the migration text', () => {
  it('SCRUM484_AC4_callers_migration_defines_every_replaced_function_once', () => {
    for (const name of [...REPLACED, 'available_venue_ids']) {
      expect(TEXT[name], name).not.toBeNull();
      expect(count(SQL, `create or replace function ${name}(`), name).toBe(1);
    }
    // Re-runnable: nothing is created bare, and the only drop is the helper's.
    expect(SQL).not.toMatch(/\bcreate (function|table|type|index|trigger)\b/);
    expect(count(SQL, 'drop ')).toBe(1);
  });

  it('SCRUM484_AC4_replaced_functions_keep_their_exact_signatures', () => {
    // `create or replace` only replaces a function whose argument list and
    // return type are unchanged; anything else would add a second overload
    // (the PGRST203 trap 012 and 013 describe) or fail.
    for (const name of REPLACED) {
      const previous = functionText(normalised(PREVIOUS[name]), name);
      expect(previous, `${PREVIOUS[name]} ${name}`).not.toBeNull();
      expect(headerOf(TEXT[name]), name).toBe(headerOf(previous));
    }
  });

  it('SCRUM484_AC4_revokes_are_reissued_for_the_writers', () => {
    expect(SQL).toContain(
      'revoke execute on function flag_bookings_for_block(uuid, uuid[], uuid) from public, anon, authenticated;',
    );
    expect(SQL).toContain(
      'revoke execute on function update_venue_block(uuid, uuid, timestamptz, timestamptz, venue_block_reason, text, boolean, uuid, boolean, uuid[]) from public, anon, authenticated;',
    );
    expect(SQL).toContain(
      'revoke execute on function create_booking_request(uuid, uuid, uuid, text, text, jsonb, boolean) from public, anon, authenticated;',
    );
    // Each revoke follows the definition it protects.
    expect(SQL.indexOf('revoke execute on function flag_bookings_for_block('))
      .toBeGreaterThan(SQL.indexOf('create or replace function flag_bookings_for_block('));
    expect(SQL.indexOf('revoke execute on function update_venue_block('))
      .toBeGreaterThan(SQL.indexOf('create or replace function update_venue_block('));
    expect(SQL.indexOf('revoke execute on function create_booking_request('))
      .toBeGreaterThan(SQL.indexOf('create or replace function create_booking_request('));
  });

  it('SCRUM484_AC4_reloads_the_postgrest_schema_cache', () => {
    expect(SQL).toContain("notify pgrst, 'reload schema';");
  });
});


describe('AC4: the block functions ask the shared function', () => {
  it('SCRUM484_AC4_block_conflict_helper_uses_the_shared_function', () => {
    // B-AC4-09, as the plan settled it: the raw helper is not rewritten but
    // dropped, and no later migration brings it back.
    expect(SQL).toContain(
      'drop function if exists venue_block_booking_conflicts(uuid, timestamptz, timestamptz);',
    );
    expect(SQL).not.toContain('create or replace function venue_block_booking_conflicts(');
    expect(SQL).not.toMatch(/\bvenue_block_booking_conflicts\s*\(p_|\bfrom venue_block_booking_conflicts\(/);

    const later = ALL_FILES.filter((f) => f > FILE);
    for (const file of later) {
      expect(normalised(file), file).not.toContain('function venue_block_booking_conflicts(');
    }
    expect(latestDefinitionFile('venue_block_booking_conflicts')).toBe(
      '013_venue_block_booking_conflicts.sql',
    );
  });

  it('SCRUM484_AC4_the_helper_is_dropped_after_every_replaced_function', () => {
    const drop = SQL.indexOf('drop function if exists venue_block_booking_conflicts(');
    expect(drop).toBeGreaterThan(-1);
    for (const name of [...REPLACED, 'available_venue_ids']) {
      const end = SQL.indexOf(TEXT[name]) + TEXT[name].length;
      expect(drop, name).toBeGreaterThan(end);
    }
  });

  it('SCRUM484_AC4_block_create_locks_bookings_by_occupied_period', () => {
    const body = BODY.create_venue_block;
    expect(body).toContain(lockedCte('p_starts_at', 'p_ends_at'));
    expect(body).not.toContain('venue_block_booking_conflicts');
    // The conflict list is built from the same function's rows, restricted to
    // the bookings actually locked.
    expect(body).toContain(
      "from venue_occupancy_conflicts(p_venue_id, p_starts_at, p_ends_at, false) c where c.kind = 'booking' and c.id = any (v_live_ids)",
    );
  });

  it('SCRUM484_AC4_block_amend_locks_bookings_by_occupied_period', () => {
    const body = BODY.update_venue_block;
    // Against the merged bounds, never the raw parameters.
    expect(body).toContain(lockedCte('v_starts_at', 'v_ends_at'));
    expect(body).not.toContain('venue_occupancy_conflicts(p_venue_id, p_starts_at');
    expect(body).not.toContain('venue_block_booking_conflicts');
    expect(body).toContain(
      "from venue_occupancy_conflicts(p_venue_id, v_starts_at, v_ends_at, false) c where c.kind = 'booking' and c.id = any (v_live_ids)",
    );
  });

  it('SCRUM484_AC4_flag_for_block_uses_the_occupied_period', () => {
    const body = BODY.flag_bookings_for_block;
    const update = body.slice(body.indexOf('update bookings b'), body.indexOf('returning b.id'));
    expect(update).toContain("b.status = 'approved'");
    expect(update).toContain('b.venue_id = v_block.venue_id');
    expect(update).toContain(
      "b.id in (select c.id from venue_occupancy_conflicts(v_block.venue_id, v_block.starts_at, v_block.ends_at, false) c where c.kind = 'booking')",
    );
    // 014's raw pair is gone.
    expect(body).not.toMatch(/\bb\.starts_at\s*</);
    expect(body).not.toMatch(/\bb\.ends_at\s*>/);
  });

  it('SCRUM484_AC4_create_block_still_flags_after_the_insert', () => {
    // 014's step 8b survives the copy: the flag call follows the insert.
    const body = BODY.create_venue_block;
    const insert = body.indexOf('insert into venue_blocks');
    const flag = body.indexOf('from flag_bookings_for_block(v_block.id, v_live_ids, p_user_id) f');
    expect(insert).toBeGreaterThan(-1);
    expect(flag).toBeGreaterThan(insert);
    expect(body).toContain("'flagged_bookings', v_flagged");
    // update_venue_block flags after its update, as 015 does.
    const amend = BODY.update_venue_block;
    expect(amend.indexOf('from flag_bookings_for_block(v_block.id, v_live_ids, p_user_id) f'))
      .toBeGreaterThan(amend.indexOf('update venue_blocks vb'));
  });
});


describe('AC4: the booking request asks the shared function', () => {
  it('SCRUM484_AC4_booking_request_checks_through_the_shared_function', () => {
    const body = BODY.create_booking_request;
    const call = 'from venue_occupancy_conflicts(p_venue_id, v_event.proposed_start, v_event.proposed_end, true) c';
    expect(count(body, 'venue_occupancy_conflicts(')).toBe(1);
    expect(body).toContain(call);

    // No raw period comparison of its own, on a block or a booking.
    expect(body).not.toMatch(/\bvb\.(starts_at|ends_at)\s*(<|>|<=|>=)/);
    expect(body).not.toMatch(/\bb\.(starts_at|ends_at)\s*(<|>|<=|>=)/);
    expect(body).not.toContain('tstzrange(');
    expect(body).not.toContain('from venue_blocks');
    expect(body).not.toContain('venue_block_booking_conflicts');

    // The `for share` venue lock comes first.
    const lock = body.indexOf('from venues where id = p_venue_id for share');
    expect(lock).toBeGreaterThan(-1);
    expect(body.indexOf(call)).toBeGreaterThan(lock);
  });

  it('SCRUM484_AC7_booking_request_conflicts_carry_the_occupied_keys', () => {
    const body = BODY.create_booking_request;
    // Both kinds keep 030's keys and gain the four occupied ones.
    for (const key of ["'kind', 'block'", "'block_id', c.id", "'reason', c.reason",
      "'kind', 'booking'", "'booking_id', c.id", "'event_name', c.event_name"]) {
      expect(body, key).toContain(key);
    }
    for (const key of OCCUPIED_KEYS) {
      expect(count(body, key), key).toBe(2);
    }
  });
});


describe('AC6: a block keeps its own period', () => {
  it('SCRUM484_AC6_block_range_is_never_padded', () => {
    for (const name of BLOCK_FUNCTIONS) {
      const body = BODY[name];
      const calls = [...body.matchAll(/venue_occupancy_conflicts\(([^)]*)\)/g)].map((m) => m[1]);
      expect(calls.length, name).toBeGreaterThan(0);
      for (const args of calls) {
        // The fourth argument, p_pad_requested, is always false for a block.
        expect(args.split(',').map((a) => a.trim())[3], `${name}: ${args}`).toBe('false');
      }
      // The block's range never goes through the formula directly either.
      expect(body, name).not.toContain('venue_occupied_period(');
    }
    // Block-vs-block (011's guarantee) stays raw against raw.
    expect(BODY.create_venue_block).toContain(
      "tstzrange(starts_at, ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')",
    );
    expect(BODY.update_venue_block).toContain(
      "tstzrange(vb.starts_at, vb.ends_at, '[)') && tstzrange(v_starts_at, v_ends_at, '[)')",
    );
  });

  it('SCRUM484_AC6_latest_block_definitions_supersede_013_to_015', () => {
    for (const name of BLOCK_FUNCTIONS) {
      expect(latestDefinitionFile(name), name).toBe(FILE);
    }
    // Changed for SCRUM-491: 040 redefines create_booking_request with 033's
    // body word for word except step 7, which also counts other events'
    // active holds, so 040 is now its latest definition.
    expect(latestDefinitionFile('create_booking_request')).toBe('040_venue_holds.sql');
  });

  it('SCRUM484_AC7_block_conflicts_carry_the_occupied_keys', () => {
    for (const name of ['create_venue_block', 'update_venue_block']) {
      const body = BODY[name];
      for (const key of ["'booking_id', c.id", "'event_request_id', c.event_request_id",
        "'event_name', c.event_name", "'starts_at', c.starts_at", "'ends_at', c.ends_at",
        ...OCCUPIED_KEYS]) {
        expect(body, `${name}: ${key}`).toContain(key);
      }
    }
    // flag_bookings_for_block keeps 014's return columns (changing OUT
    // columns would need a drop); the flagged list keeps its five keys.
    expect(headerOf(TEXT.flag_bookings_for_block)).toContain(
      'returns table (booking_id uuid, event_request_id uuid, event_name text, starts_at timestamptz, ends_at timestamptz)',
    );
  });
});


describe('AC4: venue search asks one function', () => {
  it('SCRUM484_AC4_available_venue_ids_returns_a_venue_id_table', () => {
    const header = headerOf(TEXT.available_venue_ids);
    expect(header).toContain(
      'available_venue_ids(p_venue_ids uuid[], p_starts_at timestamptz, p_ends_at timestamptz)',
    );
    expect(header).toContain('returns table (venue_id uuid)');
    expect(header).not.toContain('setof');
    expect(header).toMatch(/\bstable\b/);
  });

  it('SCRUM484_AC4_available_venue_ids_pads_the_request_through_the_shared_function', () => {
    const body = BODY.available_venue_ids;
    expect(body).toContain(
      'not exists (select 1 from venue_occupancy_conflicts(candidate.id, p_starts_at, p_ends_at, true))',
    );
    expect(count(body, 'venue_occupancy_conflicts(')).toBe(1);
    // A null bound fails closed rather than offering every venue.
    expect(body).toContain('p_starts_at is not null');
    expect(body).toContain('p_ends_at is not null');
    // No overlap of its own.
    expect(body).not.toContain('tstzrange(');
    expect(body).not.toContain('venue_occupied_period(');
    expect(body).not.toMatch(/\b(starts_at|ends_at)\s*(<|>|<=|>=)/);
  });
});
