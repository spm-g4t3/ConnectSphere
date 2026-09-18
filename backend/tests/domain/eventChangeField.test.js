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
  CHANGE_FIELD_LABEL,
  isValidChangeField,
} from '../../src/domain/eventChangeField.js';


describe('CHANGE_FIELD mirrors the database enum', () => {
  /**
   * Pull every enum value straight out of the migrations, comments stripped:
   * the values 005 created it with, plus any 007 (or a later migration)
   * added afterwards via `alter type ... add value`.
   */
  function changeFieldsDeclaredInSql() {
    const here = dirname(fileURLToPath(import.meta.url));
    const migrationsDir = resolve(here, '../../db/migrations');
    const strip = (sql) => sql.replace(/--[^\n]*/g, '');

    const created = strip(
      readFileSync(resolve(migrationsDir, '005_event_change_requests.sql'), 'utf8'),
    );
    const createdBlock = created.match(
      /create type event_change_field as enum \(([\s\S]*?)\);/i,
    );
    if (!createdBlock) throw new Error('could not find the enum in 005_event_change_requests.sql');
    const initial = [...createdBlock[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

    const extended = strip(
      readFileSync(
        resolve(migrationsDir, '007_event_change_field_venue_equipment.sql'),
        'utf8',
      ),
    );
    const added = [
      ...extended.matchAll(/alter type event_change_field add value(?: if not exists)? '([a-z_]+)'/gi),
    ].map((m) => m[1]);

    return [...initial, ...added];
  }

  it('declares exactly the same values as the SQL migrations', () => {
    // The database is the source of truth. If this fails, one of the files
    // was edited without the other and writes will be rejected at runtime.
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

  it('includes venue and equipment, matching the change request form', () => {
    // The form (frontend/ChangeRequestForm.jsx) offers these as their own
    // options, distinct from 'other'. If this ever fails, the form and this
    // vocabulary have drifted apart again.
    expect(CHANGE_FIELDS).toContain(CHANGE_FIELD.VENUE);
    expect(CHANGE_FIELDS).toContain(CHANGE_FIELD.EQUIPMENT);
  });

  it.each(Object.values(CHANGE_FIELD))('accepts %s as a valid change field', (value) => {
    expect(isValidChangeField(value)).toBe(true);
  });

  it.each([
    ['an unknown string', 'accessibility'],
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
  ])('rejects %s', (_label, value) => {
    expect(isValidChangeField(value)).toBe(false);
  });
});


describe('SCRUM-34: every change field has a label an Organiser can read', () => {
  it('labels every value in the vocabulary', () => {
    for (const field of CHANGE_FIELDS) {
      expect(CHANGE_FIELD_LABEL[field]).toBeTypeOf('string');
      expect(CHANGE_FIELD_LABEL[field].length).toBeGreaterThan(0);
    }
  });

  it('has no labels for values outside the vocabulary', () => {
    expect(Object.keys(CHANGE_FIELD_LABEL).sort()).toEqual([...CHANGE_FIELDS].sort());
  });
});
