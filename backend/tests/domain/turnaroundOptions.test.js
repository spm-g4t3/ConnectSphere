/**
 * Tests for the venue turnaround vocabulary.
 *
 * SCRUM-186 (part of SCRUM-15): a venue's turnaround between events is one of
 * a fixed list of minutes. The JS list in src/domain/turnaroundOptions.js and
 * the CHECK venues_turnaround_minutes_allowed must never drift apart, so this
 * reads the list from the built schema. Same shape as venueBlockReason.test.js.
 */

import { describe, it, expect } from 'vitest';

import {
  TURNAROUND_MINUTES_OPTIONS,
  DEFAULT_TURNAROUND_MINUTES,
  isTurnaroundOption,
} from '../../src/domain/turnaroundOptions.js';
import {
  useSchemaDb,
  checkListValues,
  columnDefault,
  functionSource,
} from './helpers/schemaVocabulary.js';


const schemaDb = useSchemaDb();

/** The minutes listed in the named CHECK, in declared order. */
const optionsDeclaredInSql = () => checkListValues(schemaDb(), 'venues_turnaround_minutes_allowed');

/** The column default of venues.turnaround_minutes. */
async function columnDefaultInSql() {
  return Number(await columnDefault(schemaDb(), 'venues', 'turnaround_minutes'));
}

/** The number create_venue falls back to when p_turnaround_minutes is null. */
async function createVenueCoalesceInSql() {
  const body = await functionSource(schemaDb(), 'create_venue');
  const match = body.match(/coalesce\(\s*p_turnaround_minutes\s*,\s*(-?\d+)\s*\)/i);
  if (!match) throw new Error('could not find the coalesce in create_venue');
  return Number(match[1]);
}


describe('SCRUM186 TURNAROUND_MINUTES_OPTIONS mirrors the database CHECK', () => {
  it('SCRUM186_turnaround_options_match_the_sql_check_list', async () => {
    expect([...TURNAROUND_MINUTES_OPTIONS]).toEqual(await optionsDeclaredInSql());
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

  it('SCRUM186_default_matches_the_column_default', async () => {
    expect(DEFAULT_TURNAROUND_MINUTES).toBe(await columnDefaultInSql());
  });

  it('SCRUM186_default_matches_the_create_venue_coalesce', async () => {
    expect(DEFAULT_TURNAROUND_MINUTES).toBe(await createVenueCoalesceInSql());
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
