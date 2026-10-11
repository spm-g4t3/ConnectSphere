/**
 * Tests for the venue hold status vocabulary.
 *
 * SCRUM-491 (Place a Tentative Venue Hold with Expiry - Venue Staff): a hold
 * is active until its expiry passes, then expired (AC7).
 *
 * Mirrors venueBlockReason.test.js: the JS list and the database enum in
 * 040_venue_holds.sql must not drift apart.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { VENUE_HOLD_STATUS, isVenueHoldStatus } from '../../src/domain/venueHoldStatus.js';


/** The 040 migration with every `--` comment stripped. */
function migrationSql() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(resolve(here, '../../db/migrations/040_venue_holds.sql'), 'utf8');
  return sql.replace(/--[^\n]*/g, '');
}

/** Pull the enum values straight out of the migration, in declared order. */
function statusesDeclaredInSql() {
  const block = migrationSql().match(/create type venue_hold_status as enum \(([\s\S]*?)\);/i);
  if (!block) throw new Error('could not find the enum in the migration');

  return [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}


describe('VENUE_HOLD_STATUS mirrors the database enum', () => {
  it('SCRUM491_AC7_hold_statuses_match_the_sql_enum', () => {
    expect(Object.values(VENUE_HOLD_STATUS)).toEqual(statusesDeclaredInSql());
  });

  it('exposes exactly active and expired, in order', () => {
    expect(Object.values(VENUE_HOLD_STATUS)).toEqual(['active', 'expired']);
  });

  it('is frozen, so no caller can add or rewrite a status at runtime', () => {
    expect(Object.isFrozen(VENUE_HOLD_STATUS)).toBe(true);
  });
});


describe('isVenueHoldStatus', () => {
  it.each(['active', 'expired'])('accepts %s', (value) => {
    expect(isVenueHoldStatus(value)).toBe(true);
  });

  it.each([
    ['an unknown status', 'released'],
    ['the wrong case', 'Active'],
    ['an inherited property name', 'toString'],
    ['an empty string', ''],
    ['a number', 1],
    ['null', null],
    ['undefined', undefined],
  ])('refuses %s', (_label, value) => {
    expect(isVenueHoldStatus(value)).toBe(false);
  });
});
