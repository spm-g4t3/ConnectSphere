/**
 * Tests for venue_block_booking_conflicts and the redefined create_venue_block,
 * read from the migration text.
 *
 * SCRUM-125 (part of SCRUM-17, AC3). CI has no database, so these pin the
 * shape of 013_venue_block_booking_conflicts.sql with every `--` comment
 * stripped -- a rule that exists only in a comment does not count.
 *
 * 013 re-states 012's create_venue_block body, so the 012 rules are pinned
 * here again: the copied body must not drift from what 012's tests promise.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** The raw 013 migration, comments included. */
function rawSql() {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(
    resolve(here, '../../db/migrations/013_venue_block_booking_conflicts.sql'),
    'utf8',
  );
}

/** The 013 migration with every `--` comment stripped, whitespace collapsed. */
function migrationSql() {
  return rawSql().replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').toLowerCase();
}

const SQL = migrationSql();

const HELPER_START = 'create or replace function venue_block_booking_conflicts(';
const CREATE_START = 'create or replace function create_venue_block(';

/** One function's text: from its `create or replace` to the `$$;` that ends it. */
function functionText(start) {
  const from = SQL.indexOf(start);
  if (from === -1) return null;
  const end = SQL.indexOf('$$;', SQL.indexOf('$$', from) + 2);
  return end === -1 ? null : SQL.slice(from, end + 3);
}

/** The body between a function's $$ quotes. */
function bodyOf(text) {
  const open = text.indexOf('$$');
  const close = text.lastIndexOf('$$');
  return text.slice(open + 2, close);
}

const HELPER = functionText(HELPER_START);
const HELPER_BODY = HELPER ? bodyOf(HELPER) : '';
const CREATE = functionText(CREATE_START);
const CREATE_BODY = CREATE ? bodyOf(CREATE) : '';


describe('the migration text', () => {
  it('defines both functions', () => {
    expect(HELPER).not.toBeNull();
    expect(CREATE).not.toBeNull();
  });
});


describe('dropping the 012 signature', () => {
  const DROP =
    'drop function if exists create_venue_block(uuid, timestamptz, timestamptz, venue_block_reason, text, uuid);';

  it('SCRUM17_AC3_drops_the_012_signature_before_redefining', () => {
    const drop = SQL.indexOf(DROP);
    expect(drop).toBeGreaterThan(-1);
    expect(drop).toBeLessThan(SQL.indexOf(CREATE_START));
  });
});


describe('create_venue_block signature', () => {
  it('SCRUM17_AC3_signature_adds_the_override_parameters_with_defaults', () => {
    expect(SQL).toMatch(
      new RegExp(
        'create or replace function create_venue_block\\( ?' +
          'p_venue_id uuid, ' +
          'p_starts_at timestamptz, ' +
          'p_ends_at timestamptz, ' +
          'p_reason venue_block_reason, ' +
          'p_notes text default null, ' +
          'p_user_id uuid default null, ' +
          'p_confirm_override boolean default false, ' +
          'p_acknowledged_booking_ids uuid\\[\\] default null ?\\)',
      ),
    );
  });

  it('still returns jsonb in plpgsql, with invoker rights', () => {
    expect(CREATE).toMatch(/\) returns jsonb language plpgsql/);
    expect(SQL).not.toMatch(/security definer/);
    expect(SQL).not.toMatch(/set search_path/);
  });
});


describe('venue_block_booking_conflicts', () => {
  it('SCRUM17_AC3_helper_takes_venue_and_period', () => {
    expect(HELPER).toMatch(
      /venue_block_booking_conflicts\( ?p_venue_id uuid, p_starts_at timestamptz, p_ends_at timestamptz ?\)/,
    );
  });

  it('SCRUM17_AC3_helper_returns_the_conflict_columns', () => {
    expect(HELPER).toMatch(
      /returns table \( ?booking_id uuid, event_request_id uuid, event_name text, starts_at timestamptz, ends_at timestamptz ?\)/,
    );
  });

  it('SCRUM17_AC3_helper_is_a_stable_sql_function_without_security_definer', () => {
    expect(HELPER).toMatch(/\) language sql stable as \$\$/);
    expect(HELPER).not.toMatch(/security definer/);
    expect(HELPER).not.toMatch(/volatile/);
  });

  it('SCRUM17_AC3_helper_takes_no_locks', () => {
    expect(HELPER_BODY).not.toMatch(/\bfor (no key )?update\b/);
    expect(HELPER_BODY).not.toMatch(/\bfor (key )?share\b/);
    expect(HELPER_BODY).not.toMatch(/\block\b/);
  });

  it('SCRUM17_AC3_helper_counts_only_approved_bookings_with_half_open_comparisons', () => {
    expect(HELPER_BODY).toMatch(/from bookings b/);
    expect(HELPER_BODY).toMatch(/where b\.venue_id = p_venue_id/);
    expect(HELPER_BODY).toMatch(/b\.status = 'approved'/);
    expect(HELPER_BODY).toMatch(/b\.starts_at < p_ends_at/);
    expect(HELPER_BODY).toMatch(/b\.ends_at > p_starts_at/);
    // Strict comparisons: bookings that only touch the period do not conflict.
    expect(HELPER_BODY).not.toMatch(/<=|>=/);
  });

  it('SCRUM17_AC3_helper_joins_event_requests_for_the_name', () => {
    expect(HELPER_BODY).toMatch(/join event_requests er on er\.id = b\.event_request_id/);
    expect(HELPER_BODY).toMatch(
      /select b\.id, b\.event_request_id, er\.event_name, b\.starts_at, b\.ends_at/,
    );
  });

  it('SCRUM17_AC3_helper_uses_no_tstzrange', () => {
    expect(HELPER_BODY).not.toMatch(/tstzrange/);
  });

  it('orders by start time, then id', () => {
    expect(HELPER_BODY).toMatch(/order by b\.starts_at, b\.id;?\s*$/);
  });
});


describe('create_venue_block: locking the conflicting bookings', () => {
  it('SCRUM17_AC3_locks_bookings_for_no_key_update_of_b_ordered_by_id', () => {
    expect(CREATE_BODY).toMatch(
      /with locked as \( select b\.id from bookings b where ([^)]*) order by b\.id for no key update of b \)/,
    );
  });

  it('locks the same approved, overlapping bookings the helper reports', () => {
    const where = CREATE_BODY.match(/with locked as \( select b\.id from bookings b where ([^)]*) order by/);
    expect(where).not.toBeNull();
    expect(where[1]).toMatch(/b\.venue_id = p_venue_id/);
    expect(where[1]).toMatch(/b\.status = 'approved'/);
    expect(where[1]).toMatch(/b\.starts_at < p_ends_at/);
    expect(where[1]).toMatch(/b\.ends_at > p_starts_at/);
  });

  it('collects the locked ids into v_live_ids', () => {
    expect(CREATE_BODY).toMatch(/into v_live_ids from locked;/);
  });

  it('builds the conflict list from the helper, restricted to the locked ids', () => {
    expect(CREATE_BODY).toMatch(
      /into v_conflicts from venue_block_booking_conflicts\(p_venue_id, p_starts_at, p_ends_at\) c where c\.booking_id = any \(v_live_ids\);/,
    );
  });
});


describe('create_venue_block: the gate', () => {
  it('SCRUM17_AC3_gate_requires_confirm_and_every_live_booking_acknowledged', () => {
    expect(CREATE_BODY).toMatch(
      /if cardinality\(v_live_ids\) > 0 and not \( ?coalesce\(p_confirm_override, false\) and v_live_ids <@ coalesce\(p_acknowledged_booking_ids, '\{\}'\) ?\) then/,
    );
  });

  it('SCRUM17_AC3_conflict_branch_returns_before_any_write', () => {
    const gate = CREATE_BODY.indexOf('if cardinality(v_live_ids) > 0');
    const conflictReturn = CREATE_BODY.indexOf(
      "return jsonb_build_object('outcome', 'conflict', 'conflicts', v_conflicts);",
    );
    const insert = CREATE_BODY.indexOf('insert into venue_blocks');

    expect(gate).toBeGreaterThan(-1);
    expect(conflictReturn).toBeGreaterThan(gate);
    expect(insert).toBeGreaterThan(conflictReturn);

    // Nothing between the start of the body and the conflict return writes.
    const beforeReturn = CREATE_BODY.slice(0, conflictReturn);
    expect(beforeReturn).not.toMatch(/\b(insert into|update \w+ set|delete from)\b/);
  });

  it('SCRUM17_AC3_created_outcome_includes_affected_bookings', () => {
    expect(CREATE_BODY).toMatch(
      /return jsonb_build_object\( ?'outcome', 'created', 'block', to_jsonb\(v_block\), 'affected_bookings', v_conflicts ?\);/,
    );
  });
});


describe('create_venue_block: order of the steps', () => {
  it('SCRUM17_AC3_steps_run_in_order', () => {
    const steps = [
      ['venue lock', 'from venues where id = p_venue_id for no key update;'],
      ['retired', "hint = 'venue_retired'"],
      ['period', 'if p_ends_at <= p_starts_at then'],
      ['block overlap', "hint = 'block_overlaps_block'"],
      ['booking lock', 'for no key update of b'],
      ['conflict return', "'outcome', 'conflict'"],
      ['insert', 'insert into venue_blocks'],
    ];

    const positions = steps.map(([label, needle]) => [label, CREATE_BODY.indexOf(needle)]);
    for (const [label, at] of positions) {
      expect(at, label).toBeGreaterThan(-1);
    }
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i][1], `${positions[i - 1][0]} before ${positions[i][0]}`).toBeGreaterThan(
        positions[i - 1][1],
      );
    }
  });
});


describe('create_venue_block: the 012 rules, re-pinned', () => {
  it('SCRUM17_AC1_locks_the_venue_row_for_no_key_update', () => {
    expect(CREATE_BODY).toMatch(/from venues where id = p_venue_id for no key update;/);
  });

  it('raises no_data_found for an unknown venue', () => {
    expect(CREATE_BODY).toMatch(
      /if not found then raise exception [^;]* errcode = 'no_data_found'/,
    );
  });

  it('raises PT409 with hint VENUE_RETIRED for a retired venue', () => {
    expect(CREATE_BODY).toMatch(
      /if v_retired_at is not null then raise exception [^;]*errcode = 'pt409', hint = 'venue_retired'/,
    );
  });

  it('refuses null bounds and bad periods with invalid_parameter_value (22023)', () => {
    expect(CREATE_BODY).toMatch(
      /if p_starts_at is null or p_ends_at is null then raise exception [^;]*errcode = 'invalid_parameter_value'/,
    );
    expect(CREATE_BODY).toMatch(
      /if p_ends_at <= p_starts_at then raise exception [^;]*errcode = 'invalid_parameter_value'/,
    );
    expect(CREATE_BODY).toMatch(
      /if p_ends_at <= now\(\) then raise exception [^;]*errcode = 'invalid_parameter_value'/,
    );
  });

  it('SCRUM17_AC1_period_checks_come_before_the_first_tstzrange', () => {
    const nulls = CREATE_BODY.indexOf('if p_starts_at is null or p_ends_at is null then');
    const ordering = CREATE_BODY.indexOf('if p_ends_at <= p_starts_at then');
    const future = CREATE_BODY.indexOf('if p_ends_at <= now() then');
    const firstRange = CREATE_BODY.indexOf('tstzrange');

    expect(firstRange).toBeGreaterThan(-1);
    for (const at of [nulls, ordering, future]) {
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(firstRange);
    }
  });

  it('raises PT409 with hint BLOCK_OVERLAPS_BLOCK and the clashing id in detail', () => {
    expect(CREATE_BODY).toMatch(
      /errcode = 'pt409', hint = 'block_overlaps_block', detail = v_overlap_id::text/,
    );
  });

  it('the block overlap query only sees active blocks with half-open ranges', () => {
    const overlapQuery = CREATE_BODY.match(
      /select id into v_overlap_id from venue_blocks where ([^;]*);/,
    );
    expect(overlapQuery).not.toBeNull();
    expect(overlapQuery[1]).toMatch(/venue_id = p_venue_id/);
    expect(overlapQuery[1]).toMatch(/removed_at is null/);
    expect(overlapQuery[1]).toMatch(
      /tstzrange\(starts_at, ends_at, '\[\)'\) && tstzrange\(p_starts_at, p_ends_at, '\[\)'\)/,
    );
  });

  it('SCRUM17_AC1_created_by_and_last_modified_by_both_take_p_user_id', () => {
    expect(CREATE_BODY).toMatch(
      /insert into venue_blocks \( ?venue_id, starts_at, ends_at, reason, notes, created_by, last_modified_by ?\) values \( ?p_venue_id, p_starts_at, p_ends_at, p_reason, p_notes, p_user_id, p_user_id ?\)/,
    );
  });
});
