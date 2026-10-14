/**
 * Venue hold status vocabulary.
 *
 * SCRUM-491 (Place a Tentative Venue Hold with Expiry - Venue Staff): a hold
 * is active until its expiry passes, then expired. Event cancellation can
 * release an active hold early, and approving the event's booking request for
 * the venue converts it (SCRUM-262). Expired, released and converted holds
 * occupy nothing; a converted hold's booking does instead.
 *
 * Mirrors the Postgres enum `venue_hold_status` in 040 and its 047 and 070
 * extensions, in the same order. These lists must stay identical -- a test asserts match.
 *
 * Deliberately free of imports, database calls and framework code -- pure data
 * and pure functions, the same shape as domain/venueBlockReason.js.
 */

export const VENUE_HOLD_STATUS = Object.freeze({
  ACTIVE: 'active',
  EXPIRED: 'expired',
  RELEASED: 'released',
  CONVERTED: 'converted',
});

// Keyed by value, so the membership check below is a single own-property test.
const BY_VALUE = Object.freeze(
  Object.fromEntries(Object.values(VENUE_HOLD_STATUS).map((value) => [value, true])),
);

/**
 * Is this a status the database will accept for a venue hold?
 *
 * Object.hasOwn rather than a plain lookup, for the reason userRole.js gives:
 * 'toString' or 'constructor' would otherwise find an inherited property and
 * report true.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isVenueHoldStatus(value) {
  return typeof value === 'string' && Object.hasOwn(BY_VALUE, value);
}
