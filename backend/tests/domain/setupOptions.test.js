/**
 * Tests for the venue setup-time vocabulary.
 *
 * SCRUM-137 (part of SCRUM-20, Week 7 Customer Change): a venue's setup time
 * before an event is one of a fixed list of minutes. The JS list in
 * src/domain/setupOptions.js and the CHECK venues_setup_minutes_allowed in
 * 023_venue_setup_time.sql must never drift apart, so this reads the list
 * straight out of the migration (with every `--` comment stripped -- a value
 * named only in a comment does not count). Same shape as
 * turnaroundOptions.test.js.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  SETUP_MINUTES_OPTIONS,
  DEFAULT_SETUP_MINUTES,
  isSetupOption,
} from '../../src/domain/setupOptions.js';
import { TURNAROUND_MINUTES_OPTIONS } from '../../src/domain/turnaroundOptions.js';


/** The 023 migration with every `--` comment stripped. */
function migrationSql() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(
    resolve(here, '../../db/migrations/023_venue_setup_time.sql'),
    'utf8',
  );
  return sql.replace(/--[^\n]*/g, '');
}

/** The minutes listed in the named CHECK, in declared order. */
function optionsDeclaredInSql() {
  const match = migrationSql().match(
    /add\s+constraint\s+venues_setup_minutes_allowed\s+check\s*\(\s*setup_minutes\s+in\s*\(([^)]*)\)\s*\)/i,
  );
  if (!match) throw new Error('could not find venues_setup_minutes_allowed in 023');
  return match[1].split(',').map((v) => Number(v.trim()));
}

/** The column default from 023's add column. */
function columnDefaultInSql() {
  const match = migrationSql().match(
    /add\s+column\s+if\s+not\s+exists\s+setup_minutes\s+smallint\s+not\s+null\s+default\s+(-?\d+)/i,
  );
  if (!match) throw new Error('could not find the setup_minutes column in 023');
  return Number(match[1]);
}

/** The number create_venue falls back to when p_setup_minutes is null. */
function createVenueCoalesceInSql() {
  const sql = migrationSql();
  const start = sql.search(/create\s+or\s+replace\s+function\s+create_venue\s*\(/i);
  if (start === -1) throw new Error('could not find create_venue in 023');
  const end = sql.search(/create\s+or\s+replace\s+function\s+update_venue\s*\(/i);
  const body = sql.slice(start, end === -1 ? undefined : end);
  const match = body.match(/coalesce\(\s*p_setup_minutes\s*,\s*(-?\d+)\s*\)/i);
  if (!match) throw new Error('could not find the coalesce in create_venue');
  return Number(match[1]);
}


describe('SCRUM20_SCRUM137 SETUP_MINUTES_OPTIONS mirrors the database CHECK', () => {
  it('SCRUM20_SCRUM137_setup_options_match_the_sql_check_list', () => {
    expect([...SETUP_MINUTES_OPTIONS]).toEqual(optionsDeclaredInSql());
  });

  it('SCRUM20_SCRUM137_setup_options_are_the_agreed_seven_values', () => {
    expect([...SETUP_MINUTES_OPTIONS]).toEqual([0, 15, 30, 45, 60, 90, 120]);
  });

  it('SCRUM20_SCRUM137_setup_options_are_ascending_with_no_duplicates', () => {
    const list = [...SETUP_MINUTES_OPTIONS];
    expect(new Set(list).size).toBe(list.length);
    for (let i = 1; i < list.length; i += 1) {
      expect(list[i]).toBeGreaterThan(list[i - 1]);
    }
  });

  it('SCRUM20_SCRUM137_setup_options_are_frozen', () => {
    expect(Object.isFrozen(SETUP_MINUTES_OPTIONS)).toBe(true);
    expect(() => SETUP_MINUTES_OPTIONS.push(180)).toThrow(TypeError);
  });

  it('SCRUM20_SCRUM137_setup_options_equal_turnaround_today_but_are_a_separate_list', () => {
    // Equal by agreement; a separate array so either can be widened alone.
    expect([...SETUP_MINUTES_OPTIONS]).toEqual([...TURNAROUND_MINUTES_OPTIONS]);
    expect(SETUP_MINUTES_OPTIONS).not.toBe(TURNAROUND_MINUTES_OPTIONS);
  });
});


describe('SCRUM20_SCRUM137 DEFAULT_SETUP_MINUTES', () => {
  it('SCRUM20_SCRUM137_default_is_zero', () => {
    expect(DEFAULT_SETUP_MINUTES).toBe(0);
  });

  it('SCRUM20_SCRUM137_default_matches_the_column_default', () => {
    expect(DEFAULT_SETUP_MINUTES).toBe(columnDefaultInSql());
  });

  it('SCRUM20_SCRUM137_default_matches_the_create_venue_coalesce', () => {
    expect(DEFAULT_SETUP_MINUTES).toBe(createVenueCoalesceInSql());
  });

  it('SCRUM20_SCRUM137_default_is_itself_an_allowed_option', () => {
    expect(isSetupOption(DEFAULT_SETUP_MINUTES)).toBe(true);
  });
});


describe('SCRUM20_SCRUM137 isSetupOption', () => {
  it.each([...SETUP_MINUTES_OPTIONS])('SCRUM20_SCRUM137_isSetupOption_accepts_%s', (value) => {
    expect(isSetupOption(value)).toBe(true);
  });

  it('SCRUM20_SCRUM137_isSetupOption_accepts_negative_zero', () => {
    // Documented behaviour, as for turnaround: -0 is an integer and includes()
    // uses SameValueZero. JSON cannot carry -0 distinctly over HTTP anyway.
    expect(isSetupOption(-0)).toBe(true);
  });

  it.each([
    ['a value between options', 25],
    ['a negative option', -15],
    ['a lead time longer than two hours', 180],
    ['a fractional number', 1.5],
    ['a fractional number near an option', 15.5],
    ['a numeric string', '30'],
    ['the string "0"', '0'],
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['an object', {}],
    ['an array holding an option', [30]],
    ['a boolean', true],
    ['false', false],
    ['a BigInt option', 30n],
  ])('SCRUM20_SCRUM137_isSetupOption_rejects_%s', (_label, value) => {
    expect(isSetupOption(value)).toBe(false);
  });
});
