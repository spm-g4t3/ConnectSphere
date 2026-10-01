/**
 * Booking status vocabulary.
 *
 * SCRUM-17 (AC3): a venue block only conflicts with *approved* bookings, so a
 * booking needs a status to say whether it is one.
 *
 * Mirrors the Postgres enum `booking_status` in 011_venue_blocks.sql exactly,
 * in the same order. These two lists must stay identical -- a test asserts
 * the match.
 *
 * Deliberately free of imports, database calls and framework code -- pure data
 * and pure functions, the same shape as domain/userRole.js.
 */

export const BOOKING_STATUS = Object.freeze({
  APPROVED: 'approved',
  FLAGGED_FOR_REVIEW: 'flagged_for_review',
  CANCELLED: 'cancelled',
});

// Keyed by value, so the membership check below is a single own-property test.
const BY_VALUE = Object.freeze(
  Object.fromEntries(Object.values(BOOKING_STATUS).map((value) => [value, true])),
);

/**
 * Is this a status the database will accept for a booking?
 *
 * Object.hasOwn rather than a plain lookup, so an inherited key such as
 * 'toString' is not mistaken for a status.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isBookingStatus(value) {
  return typeof value === 'string' && Object.hasOwn(BY_VALUE, value);
}
