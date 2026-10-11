/**
 * Tests for the venue hold status vocabulary.
 *
 * SCRUM-491 (Place a Tentative Venue Hold with Expiry - Venue Staff): a hold
 * is active until its expiry passes, then expired (AC7).
 *
 * Mirrors venueBlockReason.test.js: the JS list and the database enum in
 * 040_venue_holds.sql and the cancellation extension must not drift apart.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { VENUE_HOLD_STATUS, isVenueHoldStatus } from '../../src/domain/venueHoldStatus.js';


/** The hold migrations with every `--` comment stripped. */
function migrationSql() {
  const here = dirname(fileURLToPath(import.meta.url));
  return ['040_venue_holds.sql', '047_add_released_venue_hold_status.sql']
    .map((name) => readFileSync(resolve(here, '../../db/migrations', name), 'utf8'))
    .join('\n')
    .replace(/--[^\n]*/g, '');
}

/** Pull the enum values straight out of the migration, in declared order. */
function statusesDeclaredInSql() {
  const sql = migrationSql();
  const block = sql.match(/create type venue_hold_status as enum \(([\s\S]*?)\);/i);
  if (!block) throw new Error('could not find the enum in the migration');

  const statuses = [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const extension = sql.match(/alter type venue_hold_status add value if not exists '([a-z_]+)'/i);
  if (!extension) throw new Error('could not find the cancellation hold status');
  return [...statuses, extension[1]];
}


describe('VENUE_HOLD_STATUS mirrors the database enum', () => {
  it('SCRUM491_AC7_hold_statuses_match_the_sql_enum', () => {
    expect(Object.values(VENUE_HOLD_STATUS)).toEqual(statusesDeclaredInSql());
  });

  it('exposes active, expired, and released in order', () => {
    expect(Object.values(VENUE_HOLD_STATUS)).toEqual(['active', 'expired', 'released']);
  });

  it('is frozen, so no caller can add or rewrite a status at runtime', () => {
    expect(Object.isFrozen(VENUE_HOLD_STATUS)).toBe(true);
  });
});


describe('isVenueHoldStatus', () => {
  it.each(['active', 'expired', 'released'])('accepts %s', (value) => {
    expect(isVenueHoldStatus(value)).toBe(true);
  });

  it.each([
    ['an unknown status', 'withdrawn'],
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
