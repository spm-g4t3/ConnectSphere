/**
 * Venue turnaround vocabulary.
 *
 * SCRUM-186: the turnaround time required between consecutive events at a
 * venue, chosen from a fixed list of minutes. 0 means none -- back-to-back
 * bookings are allowed.
 *
 * Mirrors the CHECK `venues_turnaround_minutes_allowed` in
 * 017_venue_turnaround.sql exactly, in the same order, and the default
 * matches the column default there. These must stay identical -- a test
 * asserts the match.
 *
 * Deliberately free of imports, database calls and framework code -- pure data
 * and pure functions, the same shape as domain/venueBlockReason.js.
 */

export const TURNAROUND_MINUTES_OPTIONS = Object.freeze([0, 15, 30, 45, 60, 90, 120]);

// 0 rather than a "sensible" gap: nothing enforces turnaround yet, so any
// other default would invent a rule for every venue that never chose one.
export const DEFAULT_TURNAROUND_MINUTES = 0;

/**
 * Is this a turnaround the database will accept?
 *
 * Number.isInteger first, so "30" is refused rather than coerced -- the same
 * strictness checkCapacity applies to capacity.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isTurnaroundOption(value) {
  return Number.isInteger(value) && TURNAROUND_MINUTES_OPTIONS.includes(value);
}
