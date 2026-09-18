/**
 * Tests for the event change field vocabulary.
 *
 * SCRUM-11: what an Organiser may say a change request is about (AC2).
 *
 * Mirrors the structure of eventRequestStatus.test.js: the JS list and the
 * database enum must not drift apart.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  CHANGE_FIELD,
  CHANGE_FIELDS,
  isValidChangeField,
} from '../../src/domain/eventChangeField.js';


describe('CHANGE_FIELD mirrors the database enum', () => {
  /** Pull the enum values straight out of the migration, comments stripped. */
  function changeFieldsDeclaredInSql() {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(
      resolve(here, '../../db/migrations/005_event_change_requests.sql'),
      'utf8',
    );

    const block = sql.match(
      /create type event_change_field as enum \(([\s\S]*?)\);/i,
    );
    if (!block) throw new Error('could not find the enum in the migration');

    return [...block[1].replace(/--[^\n]*/g, '').matchAll(/'([a-z_]+)'/g)]
      .map((m) => m[1]);
  }

  it('declares exactly the same values as the SQL migration', () => {
    // The database is the source of truth. If this fails, one of the two
    // files was edited without the other and writes will be rejected at
    // runtime.
    expect([...CHANGE_FIELDS].sort()).toEqual(changeFieldsDeclaredInSql().sort());
  });
});


describe('AC2: an Organiser can specify what needs to be changed', () => {
  it('exposes a fixed, non-empty vocabulary', () => {
    expect(CHANGE_FIELDS.length).toBeGreaterThan(0);
    expect(new Set(CHANGE_FIELDS).size).toBe(CHANGE_FIELDS.length);
  });

  it('includes an escape hatch for arrangements with no column of their own', () => {
    expect(CHANGE_FIELDS).toContain(CHANGE_FIELD.OTHER);
  });

  it.each(Object.values(CHANGE_FIELD))('accepts %s as a valid change field', (value) => {
    expect(isValidChangeField(value)).toBe(true);
  });

  it.each([
    ['an unknown string', 'venue'],
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
  ])('rejects %s', (_label, value) => {
    expect(isValidChangeField(value)).toBe(false);
  });
});
