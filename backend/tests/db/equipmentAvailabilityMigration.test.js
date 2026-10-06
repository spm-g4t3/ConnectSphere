/**
 * Tests for 024_equipment_availability.sql, read from the migration text.
 *
 * SCRUM-23 (SCRUM-67). CI has no database, so these pin the shape of the
 * function with every `--` comment stripped: the header talks about flagged and
 * released reservations, and a rule that exists only in a comment must not
 * count. The real proof that the numbers come out right is
 * npm run equipment-availability:check, which runs the function against the
 * database with every boundary case.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const RAW = readFileSync(resolve(here, '../../db/migrations/024_equipment_availability.sql'), 'utf8');
const SQL = RAW.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').toLowerCase().trim();

/** The function from its `create or replace` to the `$$;` that ends it. */
const FUNCTION = (() => {
  const from = SQL.indexOf('create or replace function equipment_availability(');
  const end = SQL.indexOf('$$;', SQL.indexOf('$$', from) + 2);
  return from === -1 || end === -1 ? '' : SQL.slice(from, end + 3);
})();

/** The where clause of the reservation query. */
const WHERE = FUNCTION.slice(FUNCTION.indexOf('from equipment_reservations'), FUNCTION.indexOf('return jsonb_build_object(', FUNCTION.indexOf('from equipment_reservations')));

describe('the function exists once, as a read-only function', () => {
  it('SCRUM23_AC12_is_one_create_or_replace_function_returning_jsonb', () => {
    expect(FUNCTION).not.toBe('');
    expect(SQL.match(/create or replace function/g)).toHaveLength(1);
    expect(FUNCTION).toMatch(/returns jsonb/);
  });

  it('SCRUM23_AC12_takes_the_type_the_period_and_an_optional_event', () => {
    expect(FUNCTION).toMatch(/p_equipment_type_id uuid, p_start_at timestamptz, p_end_at timestamptz, p_event_request_id uuid default null/);
  });

  it('SCRUM23_AC12_is_stable_so_postgres_refuses_any_write', () => {
    expect(FUNCTION).toMatch(/language plpgsql stable as \$\$/);
  });

  it('SCRUM23_AC12_contains_no_insert_update_or_delete', () => {
    expect(FUNCTION).not.toMatch(/\binsert (into )?\w/);
    expect(FUNCTION).not.toMatch(/\bupdate \w+ set\b/);
    expect(FUNCTION).not.toMatch(/\bdelete from\b/);
  });

  it('SCRUM23_AC12_is_not_security_definer_and_takes_no_lock', () => {
    expect(FUNCTION).not.toMatch(/security definer/);
    expect(FUNCTION).not.toMatch(/for update/);
  });
});

describe('AC4: overlap is strict on both sides', () => {
  it('SCRUM23_AC4_a_reservation_starting_before_the_period_ends', () => {
    expect(WHERE).toMatch(/r\.start_at < p_end_at/);
  });

  it('SCRUM23_AC4_and_ending_after_the_period_starts', () => {
    expect(WHERE).toMatch(/r\.end_at > p_start_at/);
  });

  it('SCRUM23_AC4_never_uses_an_inclusive_comparison_on_the_period', () => {
    expect(WHERE).not.toMatch(/r\.start_at <= p_end_at/);
    expect(WHERE).not.toMatch(/r\.end_at >= p_start_at/);
  });
});

describe('AC5 to AC7: which reservations count', () => {
  it('SCRUM23_AC3_counts_only_reservations_of_this_type', () => {
    expect(WHERE).toMatch(/r\.equipment_type_id = p_equipment_type_id/);
  });

  it('SCRUM23_AC6_released_reservations_do_not_count', () => {
    expect(WHERE).toMatch(/r\.released_at is null/);
  });

  it('SCRUM23_AC6_a_flagged_reservation_still_counts_because_flagged_is_never_filtered', () => {
    expect(WHERE).not.toMatch(/flagged/);
  });

  it('SCRUM23_AC7_leaves_out_the_given_events_own_reservations_only_when_one_is_given', () => {
    expect(WHERE).toMatch(/\(p_event_request_id is null or r\.event_request_id <> p_event_request_id\)/);
  });
});

describe('AC5: damaged and under maintenance count for every period', () => {
  it('SCRUM23_AC5_damaged_and_under_maintenance_are_subtracted_from_the_total', () => {
    expect(FUNCTION).toMatch(/v_type\.total_quantity - v_type\.damaged_quantity - v_type\.under_maintenance_quantity/);
  });

  it('SCRUM23_AC5_they_come_from_the_type_row_so_no_period_filter_applies_to_them', () => {
    expect(FUNCTION).toContain('v_type.damaged_quantity');
    expect(FUNCTION).toContain('v_type.under_maintenance_quantity');
    expect(WHERE).not.toMatch(/damaged/);
    expect(WHERE).not.toMatch(/under_maintenance/);
  });
});

describe('AC3, AC5 and AC9: the figure', () => {
  it('SCRUM23_AC3_available_is_total_minus_damaged_minus_maintenance_minus_reserved', () => {
    expect(FUNCTION).toMatch(/'available', v_type\.total_quantity - v_type\.damaged_quantity - v_type\.under_maintenance_quantity - v_reserved/);
  });

  it('SCRUM23_AC8_the_figure_is_not_floored_because_reserving_needs_to_see_a_negative', () => {
    expect(FUNCTION).not.toMatch(/greatest\(/);
  });

  it('SCRUM23_AC9_returns_the_breakdown', () => {
    for (const key of ["'total'", "'damaged'", "'under_maintenance'", "'reserved'", "'available'"]) {
      expect(FUNCTION).toContain(key);
    }
  });

  it('SCRUM23_AC10_returns_each_overlapping_reservation_with_its_event_name_period_and_quantity', () => {
    for (const key of ["'event_name'", "'quantity'", "'start_at'", "'end_at'", "'flagged'"]) {
      expect(FUNCTION).toContain(key);
    }
    expect(FUNCTION).toMatch(/join event_requests e on e\.id = r\.event_request_id/);
  });
});

describe('AC11: an unknown or retired type', () => {
  it('SCRUM23_AC11_an_unknown_type_answers_found_false', () => {
    expect(FUNCTION).toMatch(/if not found then return jsonb_build_object\('found', false, 'retired', false\)/);
  });

  it('SCRUM23_AC11_a_retired_type_answers_retired_true', () => {
    expect(FUNCTION).toMatch(/if v_type\.retired_at is not null then return jsonb_build_object\('found', true, 'retired', true\)/);
  });
});

describe('AC2: the function refuses a bad period itself', () => {
  it('SCRUM23_AC2_raises_22023_for_an_end_that_is_not_after_the_start', () => {
    expect(FUNCTION).toMatch(/p_end_at <= p_start_at/);
    expect(FUNCTION).toMatch(/errcode = '22023'/);
  });
});