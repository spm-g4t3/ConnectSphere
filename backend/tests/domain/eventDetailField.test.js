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
  STATUSES_ALLOWING_ANY_EDIT,
  STATUSES_ALLOWING_ORDINARY_EDITS,
  isSignificantDetailField,
} from '../../src/domain/eventDetailField.js';
import { useSchemaDb, enumLabels, checkListValues } from './helpers/schemaVocabulary.js';

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

  it('SCRUM387_AC3_the_status_lists_are_real_statuses_with_review_inside_planning', async () => {
    const statuses = await enumLabels(schemaDb(), 'event_request_status');

    expect(STATUSES_ALLOWING_ANY_EDIT).toEqual(['under_review', 'pending_clarification']);
    expect(STATUSES_ALLOWING_ORDINARY_EDITS).toEqual([
      'under_review', 'pending_clarification', 'approved', 'safety_review', 'safety_approved',
    ]);
    for (const status of STATUSES_ALLOWING_ORDINARY_EDITS) expect(statuses).toContain(status);
    // D9: Confirmed refuses even an ordinary edit.
    expect(STATUSES_ALLOWING_ORDINARY_EDITS).not.toContain('confirmed');
  });
});
