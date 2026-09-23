/**
 * Tests for the venue block reason vocabulary.
 *
 * SCRUM-17 (AC1) / SCRUM-123: a block records why the venue is unavailable --
 * maintenance, renovation, safety, internal activity, or other. "Other" must
 * be explained in notes.
 *
 * Mirrors the structure of changeRequestStatus.test.js: the JS list and the
 * database enum must not drift apart.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { BLOCK_REASON, isBlockReason } from '../../src/domain/venueBlockReason.js';


/** The 010 migration with every `--` comment stripped. */
function migrationSql() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(
    resolve(here, '../../db/migrations/010_venue_blocks.sql'),
    'utf8',
  );
  return sql.replace(/--[^\n]*/g, '');
}

/** Pull the enum values straight out of the migration, in declared order. */
function reasonsDeclaredInSql() {
  const block = migrationSql().match(
    /create type venue_block_reason as enum \(([\s\S]*?)\);/i,
  );
  if (!block) throw new Error('could not find the enum in the migration');

  return [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}


describe('BLOCK_REASON mirrors the database enum', () => {
  it('SCRUM17_AC1_block_reasons_match_the_sql_enum', () => {
    expect(Object.values(BLOCK_REASON)).toEqual(reasonsDeclaredInSql());
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
  it('SCRUM17_AC1_other_reason_requires_notes_even_when_null', () => {
    // A check that evaluates to NULL passes in Postgres, so the expression
    // must coalesce NULL notes to '' before measuring them -- otherwise
    // reason = 'other' with notes NULL would be accepted.
    expect(migrationSql()).toMatch(
      /constraint\s+venue_blocks_other_needs_notes\s+check\s*\(\s*reason\s*<>\s*'other'\s+or\s+length\(\s*trim\(\s*coalesce\(\s*notes\s*,\s*''\s*\)\s*\)\s*\)\s*>\s*0\s*\)/i,
    );
  });

  it('limits venue_blocks.notes to 1000 characters', () => {
    expect(migrationSql()).toMatch(
      /constraint\s+venue_blocks_notes_length\s+check\s*\(\s*notes\s+is\s+null\s+or\s+length\(\s*notes\s*\)\s*<=\s*1000\s*\)/i,
    );
  });
});
