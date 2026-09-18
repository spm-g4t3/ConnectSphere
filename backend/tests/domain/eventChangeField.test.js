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
  EVENT_REQUEST_COLUMN_BY_CHANGE_FIELD,
  hasEventRequestColumn,
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


describe('SCRUM-37: EVENT_REQUEST_COLUMN_BY_CHANGE_FIELD mirrors process_change_request', () => {
  /**
   * Pull the changeField -> column pairs straight out of
   * process_change_request's branches: each is written as one line of the
   * form `... change_field = 'x' then update event_requests set y = ...`
   * specifically so this test can parse it without re-implementing a SQL
   * parser.
   */
  function columnsAppliedInSql() {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(
      resolve(here, '../../db/migrations/009_event_change_request_functions.sql'),
      'utf8',
    );

    const pairs = [...sql.matchAll(
      /change_field = '([a-z_]+)'\s+then\s+update\s+event_requests\s+set\s+([a-z_]+)\s*=/g,
    )];
    if (pairs.length === 0) throw new Error('could not find any change_field branches in the migration');

    return Object.fromEntries(pairs.map((m) => [m[1], m[2]]));
  }

  it('applies every structured field to exactly the column the SQL function applies it to', () => {
    // If this fails, EVENT_REQUEST_COLUMN_BY_CHANGE_FIELD and
    // process_change_request's branches have drifted apart -- one names a
    // field or column the other does not.
    expect(EVENT_REQUEST_COLUMN_BY_CHANGE_FIELD).toEqual(columnsAppliedInSql());
  });

  it('has no entry for fields with no column on event_requests', () => {
    expect(EVENT_REQUEST_COLUMN_BY_CHANGE_FIELD).not.toHaveProperty(CHANGE_FIELD.VENUE);
    expect(EVENT_REQUEST_COLUMN_BY_CHANGE_FIELD).not.toHaveProperty(CHANGE_FIELD.EQUIPMENT);
    expect(EVENT_REQUEST_COLUMN_BY_CHANGE_FIELD).not.toHaveProperty(CHANGE_FIELD.OTHER);
  });

  it.each([
    CHANGE_FIELD.EVENT_NAME,
    CHANGE_FIELD.DESCRIPTION,
    CHANGE_FIELD.PURPOSE,
    CHANGE_FIELD.PROPOSED_START,
    CHANGE_FIELD.PROPOSED_END,
    CHANGE_FIELD.EXPECTED_ATTENDANCE,
  ])('hasEventRequestColumn(%s) is true', (field) => {
    expect(hasEventRequestColumn(field)).toBe(true);
  });

  it.each([CHANGE_FIELD.VENUE, CHANGE_FIELD.EQUIPMENT, CHANGE_FIELD.OTHER])(
    'hasEventRequestColumn(%s) is false',
    (field) => {
      expect(hasEventRequestColumn(field)).toBe(false);
    },
  );
});
