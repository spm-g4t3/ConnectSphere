/**
 * Tests for the event change field vocabulary.
 *
 * SCRUM-11: what an Organiser may say a change request is about (AC2).
 *
 * Mirrors the structure of eventRequestStatus.test.js: the JS list and the
 * database enum, read from the built schema, must not drift apart.
 */

import { describe, it, expect } from 'vitest';

import {
  CHANGE_FIELD,
  CHANGE_FIELDS,
  CHANGE_FIELD_LABEL,
  isValidChangeField,
  EVENT_REQUEST_COLUMN_BY_CHANGE_FIELD,
  hasEventRequestColumn,
} from '../../src/domain/eventChangeField.js';
import { useSchemaDb, enumLabels, functionSource } from './helpers/schemaVocabulary.js';

const schemaDb = useSchemaDb();


describe('CHANGE_FIELD mirrors the database enum', () => {
  it('declares exactly the values of the event_change_field enum in the schema', async () => {
    // The database is the source of truth. If this fails, one of the two was
    // edited without the other and writes will be rejected at runtime.
    expect([...CHANGE_FIELDS].sort()).toEqual((await enumLabels(schemaDb(), 'event_change_field')).sort());
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
   * Pull the changeField -> column pairs straight out of the built
   * process_change_request: each branch is one line of the form
   * `... change_field = 'x' then update event_requests set y = ...`
   * specifically so this test can parse it without a SQL parser.
   */
  async function columnsAppliedInSql() {
    const sql = await functionSource(schemaDb(), 'process_change_request');
    const pairs = [...sql.matchAll(
      /change_field = '([a-z_]+)'\s+then\s+update\s+event_requests\s+set\s+([a-z_]+)\s*=/g,
    )];
    if (pairs.length === 0) throw new Error('could not find any change_field branches in process_change_request');

    return Object.fromEntries(pairs.map((m) => [m[1], m[2]]));
  }

  it('applies every structured field to exactly the column the SQL function applies it to', async () => {
    // If this fails, EVENT_REQUEST_COLUMN_BY_CHANGE_FIELD and
    // process_change_request's branches have drifted apart -- one names a
    // field or column the other does not.
    expect(EVENT_REQUEST_COLUMN_BY_CHANGE_FIELD).toEqual(await columnsAppliedInSql());
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
