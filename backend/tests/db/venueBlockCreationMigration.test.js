/**
 * Tests for create_venue_block, read from the migration text.
 *
 * SCRUM-126 (part of SCRUM-17, AC1). CI has no database, so these pin the
 * function's shape from 011_venue_block_creation.sql with every `--` comment
 * stripped -- a rule that exists only in a comment does not count.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** The raw 011 migration, comments included. */
function rawSql() {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, '../../db/migrations/011_venue_block_creation.sql'), 'utf8');
}

/** The 011 migration with every `--` comment stripped, whitespace collapsed. */
function migrationSql() {
  return rawSql().replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').toLowerCase();
}

const SQL = migrationSql();


describe('create_venue_block signature', () => {
  it('SCRUM17_AC1_signature_has_the_parameters_and_defaults', () => {
    expect(SQL).toMatch(
      new RegExp(
        'create or replace function create_venue_block\\( ?' +
          'p_venue_id uuid, ' +
          'p_starts_at timestamptz, ' +
          'p_ends_at timestamptz, ' +
          'p_reason venue_block_reason, ' +
          'p_notes text default null, ' +
          'p_user_id uuid default null ?\\)',
      ),
    );
  });

  it('returns jsonb and is written in plpgsql', () => {
    expect(SQL).toMatch(/\) returns jsonb language plpgsql/);
  });

  it('runs with invoker rights: no security definer', () => {
    expect(SQL).not.toMatch(/security definer/);
    expect(SQL).not.toMatch(/set search_path/);
  });

  it('tells SCRUM-125 which exact signature to drop, in the header', () => {
    // The header is a comment, so drop the `--` markers rather than the text.
    const header = rawSql().split('create or replace function')[0]
      .replace(/^\s*--/gm, '')
      .replace(/\s+/g, ' ');
    expect(header).toMatch(
      /drop function if exists create_venue_block\( ?uuid, timestamptz, timestamptz, venue_block_reason, text, uuid\);/,
    );
  });
});


describe('create_venue_block body', () => {
  it('SCRUM17_AC1_locks_the_venue_row_for_no_key_update', () => {
    expect(SQL).toMatch(/from venues where id = p_venue_id for no key update;/);
  });

  it('raises no_data_found for an unknown venue', () => {
    expect(SQL).toMatch(/if not found then raise exception [^;]* errcode = 'no_data_found'/);
  });

  it('raises PT409 with hint VENUE_RETIRED for a retired venue', () => {
    expect(SQL).toMatch(
      /if v_retired_at is not null then raise exception [^;]*errcode = 'pt409', hint = 'venue_retired'/,
    );
  });

  it('raises PT409 with hint BLOCK_OVERLAPS_BLOCK and the clashing id in detail', () => {
    expect(SQL).toMatch(
      /errcode = 'pt409', hint = 'block_overlaps_block', detail = v_overlap_id::text/,
    );
  });

  it('SCRUM17_AC1_ordering_check_comes_before_the_first_tstzrange', () => {
    const ordering = SQL.indexOf('if p_ends_at <= p_starts_at then');
    const future = SQL.indexOf('if p_ends_at <= now() then');
    const firstRange = SQL.indexOf('tstzrange');

    expect(ordering).toBeGreaterThan(-1);
    expect(future).toBeGreaterThan(-1);
    expect(firstRange).toBeGreaterThan(-1);
    expect(ordering).toBeLessThan(firstRange);
    expect(future).toBeLessThan(firstRange);
  });

  it('refuses null bounds and bad periods with invalid_parameter_value (22023)', () => {
    expect(SQL).toMatch(
      /if p_starts_at is null or p_ends_at is null then raise exception [^;]*errcode = 'invalid_parameter_value'/,
    );
    expect(SQL).toMatch(
      /if p_ends_at <= p_starts_at then raise exception [^;]*errcode = 'invalid_parameter_value'/,
    );
    expect(SQL).toMatch(
      /if p_ends_at <= now\(\) then raise exception [^;]*errcode = 'invalid_parameter_value'/,
    );
  });

  it('checks the venue before the period, and the period before the overlap', () => {
    const lock = SQL.indexOf('for no key update');
    const retired = SQL.indexOf("hint = 'venue_retired'");
    const ordering = SQL.indexOf('if p_ends_at <= p_starts_at then');
    const overlap = SQL.indexOf("hint = 'block_overlaps_block'");
    const insert = SQL.indexOf('insert into venue_blocks');

    expect(lock).toBeLessThan(retired);
    expect(retired).toBeLessThan(ordering);
    expect(ordering).toBeLessThan(overlap);
    expect(overlap).toBeLessThan(insert);
  });

  it('SCRUM17_AC1_overlap_query_only_sees_active_blocks_with_half_open_ranges', () => {
    const overlapQuery = SQL.match(/select id into v_overlap_id from venue_blocks where ([^;]*);/);
    expect(overlapQuery).not.toBeNull();
    expect(overlapQuery[1]).toMatch(/venue_id = p_venue_id/);
    expect(overlapQuery[1]).toMatch(/removed_at is null/);
    expect(overlapQuery[1]).toMatch(
      /tstzrange\(starts_at, ends_at, '\[\)'\) && tstzrange\(p_starts_at, p_ends_at, '\[\)'\)/,
    );
  });

  it('SCRUM17_AC1_created_by_and_last_modified_by_both_take_p_user_id', () => {
    expect(SQL).toMatch(
      /insert into venue_blocks \( ?venue_id, starts_at, ends_at, reason, notes, created_by, last_modified_by ?\) values \( ?p_venue_id, p_starts_at, p_ends_at, p_reason, p_notes, p_user_id, p_user_id ?\)/,
    );
  });

  it("SCRUM17_AC1_returns_the_created_outcome_with_the_row", () => {
    expect(SQL).toMatch(
      /return jsonb_build_object\('outcome', 'created', 'block', to_jsonb\(v_block\)\);/,
    );
  });
});
