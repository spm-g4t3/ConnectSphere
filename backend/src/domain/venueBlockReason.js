/**
 * Venue block reason vocabulary.
 *
 * SCRUM-17 (AC1): a block records why the venue is unavailable -- one of
 * maintenance, renovation, safety, internal activity, or other.
 *
 * Mirrors the Postgres enum `venue_block_reason` in 011_venue_blocks.sql
 * exactly, in the same order. These two lists must stay identical -- a test
 * asserts the match.
 *
 * Deliberately free of imports, database calls and framework code -- pure data
 * and pure functions, the same shape as domain/userRole.js.
 */

export const BLOCK_REASON = Object.freeze({
  MAINTENANCE: 'maintenance',
  RENOVATION: 'renovation',
  SAFETY: 'safety',
  INTERNAL_ACTIVITY: 'internal_activity',
  OTHER: 'other',
});

// Keyed by value, so the membership check below is a single own-property test.
const BY_VALUE = Object.freeze(
  Object.fromEntries(Object.values(BLOCK_REASON).map((value) => [value, true])),
);

/**
 * Is this a reason the database will accept for a venue block?
 *
 * Object.hasOwn rather than a plain lookup, for the reason userRole.js gives:
 * 'toString' or 'constructor' would otherwise find an inherited property and
 * report true.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isBlockReason(value) {
  return typeof value === 'string' && Object.hasOwn(BY_VALUE, value);
}
