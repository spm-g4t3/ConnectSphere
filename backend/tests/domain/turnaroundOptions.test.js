/**
 * Tests for the venue turnaround vocabulary.
 *
 * SCRUM-186 (part of SCRUM-15): a venue's turnaround between events is one of
 * a fixed list of minutes. The JS list in src/domain/turnaroundOptions.js and
 * the CHECK venues_turnaround_minutes_allowed in 017_venue_turnaround.sql must
 * never drift apart, so this reads the list straight out of the migration
 * (with every `--` comment stripped -- a value named only in a comment does
 * not count). Same shape as venueBlockReason.test.js.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  TURNAROUND_MINUTES_OPTIONS,
  DEFAULT_TURNAROUND_MINUTES,
  isTurnaroundOption,
} from '../../src/domain/turnaroundOptions.js';


/** The 017 migration with every `--` comment stripped. */
function migrationSql() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(
    resolve(here, '../../db/migrations/017_venue_turnaround.sql'),
    'utf8',
  );
  return sql.replace(/--[^\n]*/g, '');
}

/** The minutes listed in the named CHECK, in declared order. */
function optionsDeclaredInSql() {
  const match = migrationSql().match(
    /add\s+constraint\s+venues_turnaround_minutes_allowed\s+check\s*\(\s*turnaround_minutes\s+in\s*\(([^)]*)\)\s*\)/i,
  );
  if (!match) throw new Error('could not find venues_turnaround_minutes_allowed in 017');
  return match[1].split(',').map((v) => Number(v.trim()));
}

/** The column default from 017's add column. */
function columnDefaultInSql() {
  const match = migrationSql().match(
    /add\s+column\s+if\s+not\s+exists\s+turnaround_minutes\s+smallint\s+not\s+null\s+default\s+(-?\d+)/i,
  );
  if (!match) throw new Error('could not find the turnaround_minutes column in 017');
  return Number(match[1]);
}

/** The number create_venue falls back to when p_turnaround_minutes is null. */
function createVenueCoalesceInSql() {
  const sql = migrationSql();
  const start = sql.search(/create\s+or\s+replace\s+function\s+create_venue\s*\(/i);
  if (start === -1) throw new Error('could not find create_venue in 017');
  const end = sql.search(/create\s+or\s+replace\s+function\s+update_venue\s*\(/i);
  const body = sql.slice(start, end === -1 ? undefined : end);
  const match = body.match(/coalesce\(\s*p_turnaround_minutes\s*,\s*(-?\d+)\s*\)/i);
  if (!match) throw new Error('could not find the coalesce in create_venue');
  return Number(match[1]);
}


describe('SCRUM186 TURNAROUND_MINUTES_OPTIONS mirrors the database CHECK', () => {
  it('SCRUM186_turnaround_options_match_the_sql_check_list', () => {
    expect([...TURNAROUND_MINUTES_OPTIONS]).toEqual(optionsDeclaredInSql());
  });

  it('SCRUM186_turnaround_options_are_the_agreed_seven_values', () => {
    expect([...TURNAROUND_MINUTES_OPTIONS]).toEqual([0, 15, 30, 45, 60, 90, 120]);
  });

  it('SCRUM186_turnaround_options_are_ascending_with_no_duplicates', () => {
    const list = [...TURNAROUND_MINUTES_OPTIONS];
    expect(new Set(list).size).toBe(list.length);
    for (let i = 1; i < list.length; i += 1) {
      expect(list[i]).toBeGreaterThan(list[i - 1]);
    }
  });

  it('SCRUM186_turnaround_options_are_frozen', () => {
    expect(Object.isFrozen(TURNAROUND_MINUTES_OPTIONS)).toBe(true);
    expect(() => TURNAROUND_MINUTES_OPTIONS.push(180)).toThrow(TypeError);
  });
});


describe('SCRUM186 DEFAULT_TURNAROUND_MINUTES', () => {
  it('SCRUM186_default_is_zero', () => {
    expect(DEFAULT_TURNAROUND_MINUTES).toBe(0);
  });

  it('SCRUM186_default_matches_the_column_default', () => {
    expect(DEFAULT_TURNAROUND_MINUTES).toBe(columnDefaultInSql());
  });

  it('SCRUM186_default_matches_the_create_venue_coalesce', () => {
    expect(DEFAULT_TURNAROUND_MINUTES).toBe(createVenueCoalesceInSql());
  });

  it('SCRUM186_default_is_itself_an_allowed_option', () => {
    expect(isTurnaroundOption(DEFAULT_TURNAROUND_MINUTES)).toBe(true);
  });
});


describe('SCRUM186 isTurnaroundOption', () => {
  it.each([...TURNAROUND_MINUTES_OPTIONS])('SCRUM186_isTurnaroundOption_accepts_%s', (value) => {
    expect(isTurnaroundOption(value)).toBe(true);
  });

  it('SCRUM186_isTurnaroundOption_accepts_negative_zero', () => {
    // Documented behaviour: -0 is an integer and Array.prototype.includes uses
    // SameValueZero, so -0 is treated as 0. JSON cannot carry -0 distinctly
    // over HTTP anyway (JSON.stringify(-0) === '0').
    expect(isTurnaroundOption(-0)).toBe(true);
  });

  it.each([
    ['a value between options', 25],
    ['a negative option', -15],
    ['a gap longer than two hours', 180],
    ['a fractional number', 15.5],
    ['a numeric string', '30'],
    ['null', null],
    ['undefined', undefined],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['an object', {}],
    ['an array holding an option', [30]],
    ['a boolean', true],
  ])('SCRUM186_isTurnaroundOption_rejects_%s', (_label, value) => {
    expect(isTurnaroundOption(value)).toBe(false);
  });
});
