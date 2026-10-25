/**
 * Tests for the event detail field vocabulary (SCRUM-387).
 *
 * The lists must agree with the schema they describe: each field has an
 * event_requests column, and event_change_history accepts each name. The PGlite
 * suite sends every field to edit_event_request_details itself (D2).
 */

import { describe, it, expect } from 'vitest';

import {
  ORDINARY_DETAIL_FIELDS,
  SIGNIFICANT_DETAIL_FIELDS,
  DETAIL_FIELDS,
  DETAIL_FIELD_COLUMN,
  isSignificantDetailField,
} from '../../src/domain/eventDetailField.js';
import { useSchemaDb, checkListValues } from './helpers/schemaVocabulary.js';

const schemaDb = useSchemaDb();


describe('SCRUM-387: the detail field lists', () => {
  it('SCRUM387_AC3_splits_the_nine_fields_into_three_ordinary_and_six_significant', () => {
    expect(ORDINARY_DETAIL_FIELDS).toEqual(['eventName', 'purpose', 'description']);
    expect(DETAIL_FIELDS).toEqual([...ORDINARY_DETAIL_FIELDS, ...SIGNIFICANT_DETAIL_FIELDS]);
    expect(new Set(DETAIL_FIELDS).size).toBe(9);
    expect(DETAIL_FIELDS.filter(isSignificantDetailField)).toEqual(SIGNIFICANT_DETAIL_FIELDS);
    expect(isSignificantDetailField('venue')).toBe(false);
  });

  it('SCRUM387_AC2_names_a_real_event_requests_column_for_every_field', async () => {
    const { rows } = await schemaDb().query(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'event_requests'",
    );
    const columns = rows.map((row) => row.column_name);

    expect(Object.keys(DETAIL_FIELD_COLUMN)).toEqual([...DETAIL_FIELDS]);
    for (const column of Object.values(DETAIL_FIELD_COLUMN)) expect(columns).toContain(column);
  });

  it('SCRUM387_AC7_every_field_is_a_name_the_change_history_accepts', async () => {
    const known = await checkListValues(schemaDb(), 'event_change_history_field_known');

    for (const field of DETAIL_FIELDS) expect(known).toContain(field);
  });

  it('SCRUM387_AC7_the_history_sources_are_the_three_022_declares', async () => {
    expect(await checkListValues(schemaDb(), 'event_change_history_source_known'))
      .toEqual(['significant_change', 'direct_edit', 'change_request']);
  });
});
