/**
 * Venue setup-time vocabulary.
 *
 * SCRUM-137 (SCRUM-20, Week 7 Customer Change): the time Venue Staff need to
 * prepare a venue before an event starts, chosen from a fixed list of
 * minutes. 0 means none -- the event can start the moment the venue is free.
 *
 * Mirrors the CHECK `venues_setup_minutes_allowed` in
 * 023_venue_setup_time.sql exactly, in the same order, and the default
 * matches the column default there. These must stay identical -- a test
 * asserts the match.
 *
 * A file of its own rather than a re-export of turnaroundOptions.js: the
 * customer names setup and turnaround as two settings, and the lists are free
 * to diverge. Today they happen to be equal.
 *
 * Deliberately free of imports, database calls and framework code -- pure data
 * and pure functions, the same shape as domain/turnaroundOptions.js.
 */

export const SETUP_MINUTES_OPTIONS = Object.freeze([0, 15, 30, 45, 60, 90, 120]);

// 0 rather than a "sensible" lead time: nothing enforces setup until
// SCRUM-139, so any other default would invent a rule for every venue that
// never chose one.
export const DEFAULT_SETUP_MINUTES = 0;

/**
 * Is this a setup time the database will accept?
 *
 * Number.isInteger first, so "30" is refused rather than coerced -- the same
 * strictness isTurnaroundOption applies.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isSetupOption(value) {
  return Number.isInteger(value) && SETUP_MINUTES_OPTIONS.includes(value);
}
