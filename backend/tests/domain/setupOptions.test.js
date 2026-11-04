/**
 * Tests for the venue setup-time vocabulary.
 *
 * SCRUM-137 (part of SCRUM-20, Week 7 Customer Change): a venue's setup time
 * before an event is one of a fixed list of minutes. The JS list in
 * src/domain/setupOptions.js and the CHECK venues_setup_minutes_allowed must
 * never drift apart, so this reads the list from the built schema. Same shape
 * as turnaroundOptions.test.js.
 */

import { describe, it, expect } from 'vitest';

import {
  SETUP_MINUTES_OPTIONS,
  DEFAULT_SETUP_MINUTES,
  isSetupOption,
} from '../../src/domain/setupOptions.js';
import { TURNAROUND_MINUTES_OPTIONS } from '../../src/domain/turnaroundOptions.js';
import {
  useSchemaDb,
  checkListValues,
  columnDefault,
  functionSource,
} from './helpers/schemaVocabulary.js';


const schemaDb = useSchemaDb();

/** The minutes listed in the named CHECK, in declared order. */
const optionsDeclaredInSql = () => checkListValues(schemaDb(), 'venues_setup_minutes_allowed');

/** The column default of venues.setup_minutes. */
async function columnDefaultInSql() {
  return Number(await columnDefault(schemaDb(), 'venues', 'setup_minutes'));
}

/** The number create_venue falls back to when p_setup_minutes is null. */
async function createVenueCoalesceInSql() {
  const body = await functionSource(schemaDb(), 'create_venue');
  const match = body.match(/coalesce\(\s*p_setup_minutes\s*,\s*(-?\d+)\s*\)/i);
  if (!match) throw new Error('could not find the coalesce in create_venue');
  return Number(match[1]);
}


describe('SCRUM20_SCRUM137 SETUP_MINUTES_OPTIONS mirrors the database CHECK', () => {
  it('SCRUM20_SCRUM137_setup_options_match_the_sql_check_list', async () => {
    expect([...SETUP_MINUTES_OPTIONS]).toEqual(await optionsDeclaredInSql());
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

  it('SCRUM20_SCRUM137_default_matches_the_column_default', async () => {
    expect(DEFAULT_SETUP_MINUTES).toBe(await columnDefaultInSql());
  });

  it('SCRUM20_SCRUM137_default_matches_the_create_venue_coalesce', async () => {
    expect(DEFAULT_SETUP_MINUTES).toBe(await createVenueCoalesceInSql());
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
