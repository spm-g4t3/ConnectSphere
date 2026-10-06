/**
 * Tests for the booking status vocabulary and the 011 venue block schema.
 *
 * SCRUM-17 (AC1, AC3, AC4) / SCRUM-123: a block only conflicts with approved
 * bookings, active blocks on one venue may not overlap, and every block
 * records who created, amended and removed it.
 *
 * Mirrors the structure of changeRequestStatus.test.js: the JS list and the
 * database enum must not drift apart.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { BOOKING_STATUS, isBookingStatus } from '../../src/domain/bookingStatus.js';


/** The 011 migration with every `--` comment stripped. */
function migrationSql() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(
    resolve(here, '../../db/migrations/011_venue_blocks.sql'),
    'utf8',
  );
  return sql.replace(/--[^\n]*/g, '');
}

/** The 027 migration (SCRUM-250) with every `--` comment stripped. */
function requestStatusMigrationSql() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(
    resolve(here, '../../db/migrations/027_booking_request_statuses.sql'),
    'utf8',
  );
  return sql.replace(/--[^\n]*/g, '');
}

/**
 * The enum values as the migrations leave them, in declared order: the ones
 * 011 creates, then the ones 027 appends.
 */
function statusesDeclaredInSql() {
  const block = migrationSql().match(
    /create type booking_status as enum \(([\s\S]*?)\);/i,
  );
  if (!block) throw new Error('could not find the enum in the migration');

  const created = [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const added = [
    ...requestStatusMigrationSql().matchAll(
      /alter\s+type\s+booking_status\s+add\s+value\s+if\s+not\s+exists\s+'([a-z_]+)'/gi,
    ),
  ].map((m) => m[1]);

  return [...created, ...added];
}

/** The body of the venue_blocks create table statement. */
function venueBlocksTableBody() {
  const table = migrationSql().match(
    /create table if not exists venue_blocks \(([\s\S]*?)\r?\n\);/i,
  );
  if (!table) throw new Error('could not find the venue_blocks table in the migration');
  return table[1];
}


describe('BOOKING_STATUS mirrors the database enum', () => {
  it('SCRUM17_AC3_booking_statuses_match_the_sql_enum', () => {
    expect(Object.values(BOOKING_STATUS)).toEqual(statusesDeclaredInSql());
  });

  it('SCRUM250_exposes_the_three_original_statuses_then_the_request_statuses, in order', () => {
    expect(Object.values(BOOKING_STATUS)).toEqual([
      'approved',
      'flagged_for_review',
      'cancelled',
      'pending',
      'rejected',
      'withdrawn',
    ]);
  });

  it('is frozen, so no caller can add or rewrite a status at runtime', () => {
    expect(Object.isFrozen(BOOKING_STATUS)).toBe(true);
  });
});


describe('isBookingStatus', () => {
  it.each(Object.values(BOOKING_STATUS))('accepts %s', (value) => {
    expect(isBookingStatus(value)).toBe(true);
  });

  it.each([
    ['an unknown string', 'declined'],
    ['a status in the wrong case', 'Pending'],
    ['an inherited key', 'toString'],
    ['an enum key rather than its value', 'APPROVED'],
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['a number', 1],
  ])('rejects %s', (_label, value) => {
    expect(isBookingStatus(value)).toBe(false);
  });
});


describe('011 migration schema', () => {
  it('SCRUM17_AC3_existing_bookings_default_to_approved', () => {
    expect(migrationSql()).toMatch(
      /alter\s+table\s+bookings\s+add\s+column\s+if\s+not\s+exists\s+status\s+booking_status\s+not\s+null\s+default\s+'approved'/i,
    );
  });

  it('SCRUM17_AC1_migration_declares_the_active_block_exclusion_constraint', () => {
    // The gist index needs btree_gist to compare uuids with =.
    expect(migrationSql()).toMatch(/create\s+extension\s+if\s+not\s+exists\s+btree_gist/i);
    expect(venueBlocksTableBody()).toMatch(
      /constraint\s+venue_blocks_no_overlap\s+exclude\s+using\s+gist\s*\(\s*venue_id\s+with\s+=\s*,\s*tstzrange\(\s*starts_at\s*,\s*ends_at\s*,\s*'\[\)'\s*\)\s+with\s+&&\s*\)\s*where\s*\(\s*removed_at\s+is\s+null\s*\)/i,
    );
  });

  it.each([
    ['created_by', /^\s*created_by\s+uuid\b/im],
    ['last_modified_by', /^\s*last_modified_by\s+uuid\b/im],
    ['removed_at', /^\s*removed_at\s+timestamptz\b/im],
    ['removed_by', /^\s*removed_by\s+uuid\b/im],
  ])('SCRUM17_AC4_venue_blocks_has_audit_columns: %s', (_column, pattern) => {
    expect(venueBlocksTableBody()).toMatch(pattern);
  });
});
