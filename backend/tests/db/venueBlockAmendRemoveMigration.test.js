/**
 * Tests for update_venue_block and remove_venue_block, read from the
 * migration text.
 *
 * SCRUM-127 (part of SCRUM-17, AC4, and AC3 when an amendment widens a block
 * over approved bookings). CI has no database, so these pin the shape of
 * 015_venue_block_amend_remove.sql with every `--` comment stripped -- a rule
 * that exists only in a comment does not count.
 *
 * The amendment's acknowledgement gate is compared against 014's
 * create_venue_block gate, extracted from 014 itself, so the two cannot drift.
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

const SQL = normalised('015_venue_block_amend_remove.sql');
const SQL_014 = normalised('014_booking_review_notifications.sql');

const UPDATE_START = 'create or replace function update_venue_block(';
const REMOVE_START = 'create or replace function remove_venue_block(';
const CREATE_START = 'create or replace function create_venue_block(';

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

const UPDATE = functionText(SQL, UPDATE_START);
const UPDATE_BODY = UPDATE ? bodyOf(UPDATE) : '';
const REMOVE = functionText(SQL, REMOVE_START);
const REMOVE_BODY = REMOVE ? bodyOf(REMOVE) : '';
const CREATE_014 = functionText(SQL_014, CREATE_START);
const CREATE_014_BODY = CREATE_014 ? bodyOf(CREATE_014) : '';

/** The acknowledgement gate: from `if cardinality(` to the `then` that closes it. */
function gateOf(body) {
  const from = body.indexOf('if cardinality(v_live_ids)');
  if (from === -1) return null;
  const to = body.indexOf(' then', from);
  return to === -1 ? null : body.slice(from, to + ' then'.length);
}

const VENUE_LOCK = 'from venues where id = p_venue_id for no key update;';
const BLOCK_LOCK =
  'from venue_blocks vb where vb.id = p_block_id and vb.venue_id = p_venue_id for no key update;';

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


describe('the migration text', () => {
  it('SCRUM17_AC4_defines_both_functions', () => {
    expect(UPDATE).not.toBeNull();
    expect(REMOVE).not.toBeNull();
  });

  it('defines each function exactly once', () => {
    expect(SQL.split(UPDATE_START)).toHaveLength(2);
    expect(SQL.split(REMOVE_START)).toHaveLength(2);
  });

  it('finds 014s create_venue_block to compare the gate against', () => {
    expect(CREATE_014).not.toBeNull();
  });

  it('SCRUM17_AC4_does_not_touch_create_venue_block_outside_comments', () => {
    expect(SQL).not.toMatch(/create_venue_block/);
  });

  it('SCRUM17_AC4_drops_no_function', () => {
    expect(SQL).not.toMatch(/drop function/);
  });

  it('drops no table or column, grants nothing, and adds no definer rights', () => {
    expect(SQL).not.toMatch(/drop table|drop column/);
    expect(SQL).not.toMatch(/\bgrant\b/);
    expect(SQL).not.toMatch(/security definer/);
    expect(SQL).not.toMatch(/set search_path/);
  });
});


describe('execute is revoked, and PostgREST reloads', () => {
  it('SCRUM17_AC4_revokes_update_venue_block_from_public_anon_and_authenticated', () => {
    expect(SQL).toContain(
      'revoke execute on function update_venue_block(uuid, uuid, timestamptz, timestamptz, venue_block_reason, text, boolean, uuid, boolean, uuid[]) from public, anon, authenticated;',
    );
  });

  it('SCRUM17_AC4_revokes_remove_venue_block_from_public_anon_and_authenticated', () => {
    expect(SQL).toContain(
      'revoke execute on function remove_venue_block(uuid, uuid, uuid) from public, anon, authenticated;',
    );
  });

  it('revokes each function after it is defined', () => {
    expect(SQL.indexOf('revoke execute on function update_venue_block')).toBeGreaterThan(
      SQL.indexOf(UPDATE_START),
    );
    expect(SQL.indexOf('revoke execute on function remove_venue_block')).toBeGreaterThan(
      SQL.indexOf(REMOVE_START),
    );
  });

  it('SCRUM17_AC4_notifies_pgrst_to_reload_the_schema_last', () => {
    const notify = SQL.indexOf("notify pgrst, 'reload schema';");
    expect(notify).toBeGreaterThan(-1);
    expect(notify).toBeGreaterThan(SQL.indexOf('revoke execute on function update_venue_block'));
    expect(notify).toBeGreaterThan(SQL.indexOf('revoke execute on function remove_venue_block'));
  });
});


describe('update_venue_block: signature', () => {
  it('SCRUM17_AC4_takes_ten_parameters_with_p_notes_supplied_defaulting_false', () => {
    expect(SQL).toMatch(
      new RegExp(
        'create or replace function update_venue_block\\( ?' +
          'p_venue_id uuid, ' +
          'p_block_id uuid, ' +
          'p_starts_at timestamptz default null, ' +
          'p_ends_at timestamptz default null, ' +
          'p_reason venue_block_reason default null, ' +
          'p_notes text default null, ' +
          'p_notes_supplied boolean default false, ' +
          'p_user_id uuid default null, ' +
          'p_confirm_override boolean default false, ' +
          'p_acknowledged_booking_ids uuid\\[\\] default null ?\\)',
      ),
    );
  });

  it('returns jsonb in plpgsql', () => {
    expect(UPDATE).toMatch(/\) returns jsonb language plpgsql as \$\$/);
  });
});


describe('update_venue_block: locks and lookups', () => {
  it('SCRUM17_AC4_locks_the_venue_before_the_block', () => {
    expectInOrder(UPDATE_BODY, [
      ['venue lock', VENUE_LOCK],
      ['block lock', BLOCK_LOCK],
    ]);
  });

  it('SCRUM17_AC4_scopes_the_block_lookup_by_block_and_venue', () => {
    expect(UPDATE_BODY).toContain(BLOCK_LOCK);
  });

  it('SCRUM17_AC4_raises_no_data_found_for_a_missing_venue_and_a_missing_block', () => {
    expect(allIndexes(UPDATE_BODY, "errcode = 'no_data_found'").length).toBeGreaterThanOrEqual(2);
    expectInOrder(UPDATE_BODY, [
      ['venue lock', VENUE_LOCK],
      ['venue not found', "errcode = 'no_data_found'"],
      ['block lock', BLOCK_LOCK],
    ]);
    const afterBlockLock = UPDATE_BODY.slice(UPDATE_BODY.indexOf(BLOCK_LOCK));
    expect(afterBlockLock).toMatch(/if not found then raise exception [^;]*errcode = 'no_data_found';/);
  });
});


describe('update_venue_block: refused by state', () => {
  it('SCRUM17_AC4_refuses_removed_then_ended_then_retired', () => {
    expectInOrder(UPDATE_BODY, [
      ['block lock', BLOCK_LOCK],
      ['removed check', 'if v_block.removed_at is not null then'],
      ['removed hint', "hint = 'block_removed'"],
      ['ended check', 'if v_block.ends_at <= now() then'],
      ['ended hint', "hint = 'block_ended'"],
      ['retired check', 'if v_retired_at is not null then'],
      ['retired hint', "hint = 'venue_retired'"],
    ]);
  });

  it('SCRUM17_AC4_state_refusals_are_pt409', () => {
    expect(UPDATE_BODY).toMatch(/errcode = 'pt409', hint = 'block_removed'/);
    expect(UPDATE_BODY).toMatch(/errcode = 'pt409', hint = 'block_ended'/);
    expect(UPDATE_BODY).toMatch(/errcode = 'pt409', hint = 'venue_retired'/);
  });
});


describe('update_venue_block: merging the patch', () => {
  it('SCRUM17_AC4_coalesces_start_end_and_reason_onto_the_stored_row', () => {
    expect(UPDATE_BODY).toContain('v_starts_at := coalesce(p_starts_at, v_block.starts_at);');
    expect(UPDATE_BODY).toContain('v_ends_at := coalesce(p_ends_at, v_block.ends_at);');
    expect(UPDATE_BODY).toContain('v_reason := coalesce(p_reason, v_block.reason);');
  });

  it('SCRUM17_AC4_picks_notes_by_p_notes_supplied', () => {
    expect(UPDATE_BODY).toContain(
      'v_notes := case when coalesce(p_notes_supplied, false) then p_notes else v_block.notes end;',
    );
  });

  it('merges after the state checks', () => {
    expectInOrder(UPDATE_BODY, [
      ['retired hint', "hint = 'venue_retired'"],
      ['merge', 'v_starts_at := coalesce('],
    ]);
  });
});


describe('update_venue_block: the merged period', () => {
  it('SCRUM17_AC4_checks_the_merged_order_and_future_end', () => {
    expect(UPDATE_BODY).toMatch(
      /if v_ends_at <= v_starts_at then raise exception [^;]*errcode = 'invalid_parameter_value';/,
    );
    expect(UPDATE_BODY).toMatch(
      /if v_ends_at <= now\(\) then raise exception [^;]*errcode = 'invalid_parameter_value';/,
    );
  });

  it('SCRUM17_AC4_refuses_reason_other_without_notes_as_22023', () => {
    expect(UPDATE_BODY).toMatch(
      /if v_reason = 'other' and length\(trim\(coalesce\(v_notes, ''\)\)\) = 0 then raise exception [^;]*errcode = 'invalid_parameter_value';/,
    );
  });

  it('SCRUM17_AC4_every_22023_check_runs_before_the_first_tstzrange', () => {
    const firstRange = UPDATE_BODY.indexOf('tstzrange(');
    expect(firstRange).toBeGreaterThan(-1);

    const checks = allIndexes(UPDATE_BODY, "errcode = 'invalid_parameter_value'");
    expect(checks.length).toBeGreaterThanOrEqual(3);
    for (const at of checks) {
      expect(at).toBeLessThan(firstRange);
    }
  });

  it('checks the period after the merge', () => {
    expectInOrder(UPDATE_BODY, [
      ['merge', 'v_ends_at := coalesce('],
      ['order check', 'if v_ends_at <= v_starts_at then'],
    ]);
  });
});


describe('update_venue_block: overlap with another block', () => {
  const OVERLAP = (UPDATE_BODY.match(/select vb\.id into v_overlap_id from venue_blocks vb where [^;]*;/) ?? [''])[0];

  it('finds the overlap query', () => {
    expect(OVERLAP).not.toBe('');
  });

  it('SCRUM17_AC4_only_active_blocks_on_the_venue_count', () => {
    expect(OVERLAP).toContain('vb.venue_id = p_venue_id');
    expect(OVERLAP).toContain('vb.removed_at is null');
  });

  it('SCRUM17_AC4_excludes_the_block_being_amended', () => {
    expect(OVERLAP).toContain('vb.id <> p_block_id');
  });

  it('SCRUM17_AC4_compares_half_open_ranges_of_the_merged_period', () => {
    expect(OVERLAP).toContain(
      "tstzrange(vb.starts_at, vb.ends_at, '[)') && tstzrange(v_starts_at, v_ends_at, '[)')",
    );
  });

  it('SCRUM17_AC4_raises_block_overlaps_block_with_the_id_in_detail', () => {
    expect(UPDATE_BODY).toMatch(
      /if v_overlap_id is not null then raise exception [^;]*errcode = 'pt409', hint = 'block_overlaps_block', detail = v_overlap_id::text;/,
    );
  });
});


describe('update_venue_block: approved bookings and the gate', () => {
  it('SCRUM17_AC3_locks_approved_overlapping_bookings_in_id_order', () => {
    const where = UPDATE_BODY.match(
      /with locked as \( select b\.id from bookings b where ([^)]*) order by b\.id for no key update of b \)/,
    );
    expect(where).not.toBeNull();
    expect(where[1]).toMatch(/b\.venue_id = p_venue_id/);
    expect(where[1]).toMatch(/b\.status = 'approved'/);
    expect(where[1]).toMatch(/b\.starts_at < v_ends_at/);
    expect(where[1]).toMatch(/b\.ends_at > v_starts_at/);
  });

  it('SCRUM17_AC3_gate_is_identical_to_014s_create_venue_block_gate', () => {
    const createGate = gateOf(CREATE_014_BODY);
    const updateGate = gateOf(UPDATE_BODY);
    expect(createGate).not.toBeNull();
    expect(updateGate).not.toBeNull();
    expect(updateGate).toBe(createGate);
  });

  it('SCRUM17_AC3_conflict_return_precedes_any_write', () => {
    const conflictReturn = UPDATE_BODY.indexOf(
      "return jsonb_build_object('outcome', 'conflict', 'conflicts', v_conflicts);",
    );
    expect(conflictReturn).toBeGreaterThan(-1);
    expect(conflictReturn).toBeLessThan(UPDATE_BODY.indexOf('update venue_blocks'));

    const beforeReturn = UPDATE_BODY.slice(0, conflictReturn);
    expect(beforeReturn).not.toMatch(/\b(insert into|update \w+( \w+)? set|delete from)\b/);
    expect(beforeReturn).not.toMatch(/flag_bookings_for_block/);
  });
});


describe('update_venue_block: the write and the flag', () => {
  it('SCRUM17_AC4_steps_run_in_order', () => {
    expectInOrder(UPDATE_BODY, [
      ['venue lock', VENUE_LOCK],
      ['block lock', BLOCK_LOCK],
      ['removed', "hint = 'block_removed'"],
      ['ended', "hint = 'block_ended'"],
      ['retired', "hint = 'venue_retired'"],
      ['merge', 'v_starts_at := coalesce('],
      ['period', 'if v_ends_at <= v_starts_at then'],
      ['block overlap', "hint = 'block_overlaps_block'"],
      ['booking lock', 'for no key update of b'],
      ['conflict return', "'outcome', 'conflict'"],
      ['update', 'update venue_blocks'],
      ['flag', 'flag_bookings_for_block('],
      ['updated outcome', "'outcome', 'updated'"],
    ]);
  });

  it('SCRUM17_AC4_update_writes_the_merged_values_and_last_modified_by_the_user', () => {
    const update = (UPDATE_BODY.match(/update venue_blocks vb set ([^;]*?) where vb\.id = p_block_id returning \* into v_block;/) ?? [])[1];
    expect(update).toBeDefined();
    expect(update).toContain('starts_at = v_starts_at');
    expect(update).toContain('ends_at = v_ends_at');
    expect(update).toContain('reason = v_reason');
    expect(update).toContain('notes = v_notes');
    expect(update).toContain('last_modified_by = p_user_id');
  });

  it('SCRUM17_AC3_update_precedes_the_flag_call', () => {
    expect(UPDATE_BODY.indexOf('update venue_blocks')).toBeGreaterThan(-1);
    expect(UPDATE_BODY.indexOf('update venue_blocks')).toBeLessThan(
      UPDATE_BODY.indexOf('flag_bookings_for_block('),
    );
  });

  it('SCRUM17_AC3_flag_call_passes_the_amending_user', () => {
    expect(UPDATE_BODY).toContain('from flag_bookings_for_block(v_block.id, v_live_ids, p_user_id) f;');
    expect(UPDATE_BODY.split('flag_bookings_for_block(')).toHaveLength(2);
  });

  it('SCRUM17_AC3_never_updates_bookings_directly', () => {
    expect(UPDATE_BODY).not.toMatch(/update bookings/);
  });

  it('SCRUM17_AC4_returns_updated_with_block_affected_and_flagged_bookings', () => {
    expect(UPDATE_BODY).toMatch(
      /return jsonb_build_object\( ?'outcome', 'updated', 'block', to_jsonb\(v_block\), 'affected_bookings', v_conflicts, 'flagged_bookings', v_flagged ?\);/,
    );
  });
});


describe('remove_venue_block', () => {
  it('SCRUM17_AC4_takes_three_parameters', () => {
    expect(SQL).toMatch(
      /create or replace function remove_venue_block\( ?p_venue_id uuid, p_block_id uuid, p_user_id uuid default null ?\) returns jsonb language plpgsql as \$\$/,
    );
  });

  it('SCRUM17_AC4_locks_the_venue_then_the_block', () => {
    expectInOrder(REMOVE_BODY, [
      ['venue lock', VENUE_LOCK],
      ['block lock', BLOCK_LOCK],
    ]);
  });

  it('SCRUM17_AC4_raises_no_data_found_for_missing_venue_and_block', () => {
    expect(allIndexes(REMOVE_BODY, "errcode = 'no_data_found'").length).toBeGreaterThanOrEqual(2);
  });

  it('SCRUM17_AC4_refuses_removed_then_ended', () => {
    expectInOrder(REMOVE_BODY, [
      ['block lock', BLOCK_LOCK],
      ['removed', "errcode = 'pt409', hint = 'block_removed'"],
      ['ended check', 'if v_block.ends_at <= now() then'],
      ['ended', "errcode = 'pt409', hint = 'block_ended'"],
      ['update', 'update venue_blocks'],
    ]);
  });

  it('SCRUM17_AC4_has_no_retired_venue_check', () => {
    expect(REMOVE_BODY).not.toMatch(/venue_retired/);
    expect(REMOVE_BODY).not.toMatch(/retired_at/);
  });

  it('SCRUM17_AC4_soft_deletes_recording_who_and_when', () => {
    const update = (REMOVE_BODY.match(/update venue_blocks vb set ([^;]*?) where vb\.id = p_block_id/) ?? [])[1];
    expect(update).toBeDefined();
    expect(update).toContain('removed_at = now()');
    expect(update).toContain('removed_by = p_user_id');
    expect(update).toContain('last_modified_by = p_user_id');
  });

  it('SCRUM17_AC4_touches_no_booking_and_deletes_nothing', () => {
    expect(REMOVE_BODY).not.toMatch(/update bookings/);
    expect(REMOVE_BODY).not.toMatch(/flag_bookings_for_block/);
    expect(REMOVE_BODY).not.toMatch(/delete from venue_blocks/);
    expect(SQL).not.toMatch(/delete from/);
  });

  it('SCRUM17_AC4_returns_removed_with_the_block', () => {
    expect(REMOVE_BODY).toMatch(
      /return jsonb_build_object\( ?'outcome', 'removed', 'block', to_jsonb\(v_block\) ?\);/,
    );
  });
});
