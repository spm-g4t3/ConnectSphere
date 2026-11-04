/**
 * Tests for the venue block reason vocabulary.
 *
 * SCRUM-17 (AC1) / SCRUM-123: a block records why the venue is unavailable --
 * maintenance, renovation, safety, internal activity, or other. "Other" must
 * be explained in notes.
 *
 * Mirrors the structure of changeRequestStatus.test.js: the JS list and the
 * database enum, read from the built schema, must not drift apart.
 */

import { describe, it, expect } from 'vitest';

import { BLOCK_REASON, isBlockReason } from '../../src/domain/venueBlockReason.js';
import { useSchemaDb, enumLabels, constraintDef } from './helpers/schemaVocabulary.js';

const schemaDb = useSchemaDb();


describe('BLOCK_REASON mirrors the database enum', () => {
  it('SCRUM17_AC1_block_reasons_match_the_sql_enum', async () => {
    expect(Object.values(BLOCK_REASON)).toEqual(await enumLabels(schemaDb(), 'venue_block_reason'));
  });

  it('exposes exactly the five reasons AC1 asks for, in order', () => {
    expect(Object.values(BLOCK_REASON)).toEqual([
      'maintenance',
      'renovation',
      'safety',
      'internal_activity',
      'other',
    ]);
  });

  it('is frozen, so no caller can add or rewrite a reason at runtime', () => {
    expect(Object.isFrozen(BLOCK_REASON)).toBe(true);
  });
});


describe('isBlockReason', () => {
  it.each(Object.values(BLOCK_REASON))('SCRUM17_AC1_isBlockReason_accepts_each_reason: %s', (value) => {
    expect(isBlockReason(value)).toBe(true);
  });

  it.each([
    ['an unknown reason', 'holiday'],
    ['an inherited key', 'toString'],
    ['another inherited key', 'constructor'],
    ['an enum key rather than its value', 'MAINTENANCE'],
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['a number', 1],
    ['an object', {}],
  ])('SCRUM17_AC1_isBlockReason_rejects_unknown_and_inherited_keys: %s', (_label, value) => {
    expect(isBlockReason(value)).toBe(false);
  });
});


describe('venue_blocks notes constraints', () => {
  it('SCRUM17_AC1_other_reason_requires_notes_even_when_null', async () => {
    // A check that evaluates to NULL passes in Postgres, so the expression
    // must coalesce NULL notes to '' before measuring them -- otherwise
    // reason = 'other' with notes NULL would be accepted.
    expect(await constraintDef(schemaDb(), 'venue_blocks_other_needs_notes')).toBe(
      "CHECK (((reason <> 'other'::venue_block_reason) OR (length(TRIM(BOTH FROM COALESCE(notes, ''::text))) > 0)))",
    );
  });

  it('limits venue_blocks.notes to 1000 characters', async () => {
    expect(await constraintDef(schemaDb(), 'venue_blocks_notes_length')).toBe(
      'CHECK (((notes IS NULL) OR (length(notes) <= 1000)))',
    );
  });
});
