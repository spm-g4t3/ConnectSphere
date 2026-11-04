/**
 * Timestamp validation shared by every validator that accepts an instant.
 *
 * SCRUM-126, a subtask of SCRUM-17 (Block a Venue for Unavailability).
 *
 * Extracted unchanged from eventRequestValidation.js (SCRUM-30), because a
 * venue block's start and end obey exactly the same wire contract as an event
 * request's proposed period: a real calendar date, a time of day and an
 * explicit offset. Two copies of these rules would be two places that decide
 * what a timestamp means, and the first time one was fixed and the other was
 * not, a block and a booking could disagree about the same instant.
 * eventRequestValidation.test.js passing unchanged is the proof the move
 * altered no behaviour.
 *
 * Only the timestamp rules moved. The error-collector copies stay in each
 * validator, as their own header notes explain; extracting those is a
 * separate refactor.
 *
 * Pure and synchronous -- no imports at all. checkTimestamp takes any object
 * with an add(field, message) method, so each caller keeps its own collector.
 *
 * SCRUM-130 adds checkTimeWindow, a start and end checked as a pair, for the
 * venue search's date window and the venue calendar's block window. It lives
 * here rather than in either validator so the two windows cannot drift apart
 * on what "later than the start" means.
 */


/** Every user is in Singapore, so "today" is the Singapore calendar day. */
const SINGAPORE_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Singapore',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Today's date in Singapore as YYYY-MM-DD ('en-CA' formats it that way). The
 * UTC date is a day behind from 00:00 to 08:00 Singapore time.
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function singaporeToday(now = new Date()) {
  return SINGAPORE_DATE.format(now);
}

/** A date with no time of day at all. Checked first so it can be named. */
export const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date and time with no offset. Exists only to produce a better message than
 * "malformed" for a value that is nearly right, so its date part stays loose --
 * anything reaching it already has a time of day and no offset.
 */
export const LOCAL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/;

/**
 * An instant this system will accept: a real calendar date, a time of day, and
 * an explicit offset. Seconds and fractional seconds are optional, following
 * the TIME_PATTERN precedent in venueValidation.js -- no Organiser types
 * milliseconds, and demanding them would refuse a well-formed value.
 *
 * The offset is required, not optional. ECMAScript parses a date-time without
 * one as LOCAL time while parsing a date-only value as UTC, so an offset-less
 * string means a different instant on a developer's machine, on Supabase and in
 * CI -- the same stored request would describe three different periods.
 *
 * Ranges are spelled out rather than left as \d{2} for the same reason
 * TIME_PATTERN spells out hours and minutes: '2026-13-45' should be refused for
 * what it is, not survive to be caught by a parse failure further down.
 */
export const TIMESTAMP_PATTERN =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d)(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):([0-5]\d))$/;

/**
 * How many days that month actually had, leap years included.
 *
 * Date.UTC(year, month, 0) is day zero of the following month, which is the
 * last day of this one -- month being 1-based here and 0-based there.
 */
export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}


/**
 * A timestamp, checked on the string's shape before it is parsed.
 *
 * The order matters and is the whole point of the two-step approach. A
 * deliberate midnight event, '2026-06-01T00:00:00Z', and a date-only
 * '2026-06-01' resolve to exactly the same instant, so no examination of the
 * parsed value can tell them apart -- a rule inferred from the instant would
 * have to refuse real midnight events. Only the string distinguishes them.
 *
 * The calendar day is then checked arithmetically rather than by trusting the
 * parse. '2026-02-30T09:00:00Z' matches every pattern here and is not a day,
 * and new Date() does not refuse it: V8 rolls it forward to 2026-03-02 and
 * reports success. An Organiser who typed 30 February would have been handed an
 * event two days later without being told -- the same silently invented value
 * the offset and time-of-day rules exist to stop.
 *
 * @param {{add: function(string, string): void}} errors  collector to record faults against
 * @param {string} field  the field name faults are reported under
 * @param {*} value       the caller's raw value
 * @returns {Date|null} the instant, or null when a fault was recorded
 */
export function checkTimestamp(errors, field, value) {
  if (typeof value !== 'string') {
    // Strict about type, as checkCapacity in venueValidation.js is: epoch
    // milliseconds are a number the platform would happily accept, and a caller
    // sending them should find out here rather than three stories downstream.
    errors.add(field, 'must be an ISO 8601 date and time, given as text');
    return null;
  }

  const text = value.trim();

  if (DATE_ONLY_PATTERN.test(text)) {
    // Naming the real fault. "Invalid timestamp" would send the Organiser
    // hunting for a typo in a date that is perfectly well formed.
    errors.add(field, 'must include a time of day, not a date on its own');
    return null;
  }

  if (LOCAL_DATETIME_PATTERN.test(text)) {
    errors.add(field, 'must include a UTC offset, such as Z or +08:00');
    return null;
  }

  const match = TIMESTAMP_PATTERN.exec(text);
  if (match === null) {
    errors.add(
      field,
      'must be an ISO 8601 date and time such as 2026-06-01T09:00:00+08:00',
    );
    return null;
  }

  const [, year, month, day] = match;
  if (Number(day) > daysInMonth(Number(year), Number(month))) {
    errors.add(field, 'is not a real date -- that month does not have that many days');
    return null;
  }

  const instant = new Date(text);
  if (Number.isNaN(instant.getTime())) {
    // Unreachable for anything matching the pattern above on this engine, and
    // kept as a backstop rather than removed: it costs one comparison, and the
    // alternative is trusting that no future engine parses differently.
    errors.add(field, 'is not a real date');
    return null;
  }

  return instant;
}


/** One day in milliseconds, for checkTimeWindow's maxDays cap. */
const DAY_MS = 86_400_000;

/**
 * Blank, undefined or null: not given. A query string sends an unfilled date
 * box as '', and that is "no window", not a malformed one.
 */
function isGiven(value) {
  return !(
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '')
  );
}

/**
 * An optional time window: both ends or neither (SCRUM-130).
 *
 * Half-open [start, end): the end must be strictly later than the start, the
 * rule venue_blocks_no_overlap uses, so an empty window is refused rather than
 * matching nothing. A window in the past is allowed -- the calendar shows the
 * past too.
 *
 * When only one end is given, that end is still checked, so every fault in the
 * request is reported at once rather than one per round trip.
 *
 * @param {{add: function(string, string): void}} errors  collector to record faults against
 * @param {[string, string]} fields  the start and end field names faults are reported under
 * @param {*} startValue  the caller's raw start
 * @param {*} endValue    the caller's raw end
 * @param {object} [options]
 * @param {number} [options.maxDays]  the longest window allowed; exactly
 *                                    maxDays passes. Omitted means no cap.
 * @returns {{start: string, end: string}|null} both trimmed, or null when
 *          neither was given or a fault was recorded
 */
export function checkTimeWindow(errors, [startField, endField], startValue, endValue, { maxDays } = {}) {
  const hasStart = isGiven(startValue);
  const hasEnd = isGiven(endValue);

  if (!hasStart && !hasEnd) return null;

  // The fault goes on the MISSING field: that is the box the user has to fill.
  if (!hasStart) errors.add(startField, 'is required when an end is given');
  if (!hasEnd) errors.add(endField, 'is required when a start is given');

  const start = hasStart ? checkTimestamp(errors, startField, startValue) : null;
  const end = hasEnd ? checkTimestamp(errors, endField, endValue) : null;

  if (start === null || end === null) return null;

  // Compared as instants, not strings, so mixed offsets order correctly.
  if (end <= start) {
    errors.add(endField, 'must be later than the start');
    return null;
  }

  // Only once the order is right: a reversed window is not also "too long".
  if (maxDays !== undefined && end - start > maxDays * DAY_MS) {
    errors.add(endField, `must be within ${maxDays} days of the start`);
    return null;
  }

  // Passed on as written, trimmed, for the reason validateCreateBlock gives:
  // the columns are timestamptz, so Postgres resolves the offset.
  return { start: startValue.trim(), end: endValue.trim() };
}
