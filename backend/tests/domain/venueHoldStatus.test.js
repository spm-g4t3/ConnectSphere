/**
 * Tests for the venue hold status vocabulary.
 *
 * SCRUM-491 (Place a Tentative Venue Hold with Expiry - Venue Staff): a hold
 * is active until its expiry passes, then expired (AC7).
 *
 * Mirrors venueBlockReason.test.js: the JS list and the database enum, read
 * from the built schema, must not drift apart.
 */

import { describe, it, expect } from 'vitest';

import { VENUE_HOLD_STATUS, isVenueHoldStatus } from '../../src/domain/venueHoldStatus.js';
import { useSchemaDb, enumLabels } from './helpers/schemaVocabulary.js';

const schemaDb = useSchemaDb();


describe('VENUE_HOLD_STATUS mirrors the database enum', () => {
  it('SCRUM491_AC7_hold_statuses_match_the_sql_enum', async () => {
    expect(Object.values(VENUE_HOLD_STATUS)).toEqual(await enumLabels(schemaDb(), 'venue_hold_status'));
  });

  it('exposes active, expired, released, and converted in order', () => {
    expect(Object.values(VENUE_HOLD_STATUS)).toEqual(['active', 'expired', 'released', 'converted']);
  });

  it('is frozen, so no caller can add or rewrite a status at runtime', () => {
    expect(Object.isFrozen(VENUE_HOLD_STATUS)).toBe(true);
  });
});


describe('isVenueHoldStatus', () => {
  it.each(['active', 'expired', 'released', 'converted'])('accepts %s', (value) => {
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
