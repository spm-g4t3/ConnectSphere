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
  DETAIL_FIELD_BY_CHANGE_FIELD,
  hasEventRequestColumn,
} from '../../src/domain/eventChangeField.js';
import { DETAIL_FIELDS, DETAIL_FIELD_COLUMN } from '../../src/domain/eventDetailField.js';
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


describe('SCRUM-402: the change fields map onto 387\'s detail fields as 036 applies them', () => {
  /**
   * Since SCRUM-402, process_change_request (036) has no per-field branches to
   * parse: it reads change_request_targets(), whose values list this pulls out.
   * Renamed from SCRUM-37's test of those branches, which 036 replaced.
   */
  async function targetsInSql() {
    const sql = await functionSource(schemaDb(), 'change_request_targets');
    const rows = [...sql.matchAll(/\('([a-z_]+)', '([A-Za-z]+)', '([a-z_]+)'\)/g)];
    if (rows.length === 0) throw new Error('could not read change_request_targets()');
    return rows.map(([, changeField, detailField, column]) => ({ changeField, detailField, column }));
  }

  it('SCRUM402_AC5_every_change_field_targets_the_detail_field_and_column_036_applies', async () => {
    const targets = await targetsInSql();

    expect(Object.fromEntries(targets.map((t) => [t.changeField, t.detailField]))).toEqual(DETAIL_FIELD_BY_CHANGE_FIELD);
    for (const { detailField, column } of targets) {
      expect(DETAIL_FIELDS).toContain(detailField);
      expect(DETAIL_FIELD_COLUMN[detailField]).toBe(column);
    }
    // The six SCRUM-37 named keep their columns; venue and equipment now have one.
    for (const [changeField, column] of Object.entries(EVENT_REQUEST_COLUMN_BY_CHANGE_FIELD)) {
      expect(DETAIL_FIELD_COLUMN[DETAIL_FIELD_BY_CHANGE_FIELD[changeField]]).toBe(column);
    }
  });

  it('SCRUM402_AC5_a_venue_request_is_a_change_to_the_venue_requirements_and_other_and_cancellation_write_nothing', () => {
    expect(DETAIL_FIELD_BY_CHANGE_FIELD[CHANGE_FIELD.VENUE]).toBe('venueRequirements');
    expect(DETAIL_FIELD_BY_CHANGE_FIELD[CHANGE_FIELD.EQUIPMENT]).toBe('equipmentRequirements');
    expect(DETAIL_FIELD_BY_CHANGE_FIELD).not.toHaveProperty(CHANGE_FIELD.OTHER);
    expect(DETAIL_FIELD_BY_CHANGE_FIELD).not.toHaveProperty(CHANGE_FIELD.CANCELLATION);
    expect(CHANGE_FIELD_LABEL[CHANGE_FIELD.CANCELLATION]).toBe('Cancel the event');
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
