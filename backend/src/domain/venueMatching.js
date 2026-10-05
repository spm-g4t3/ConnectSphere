/**
 * Does a venue meet an event's requirements?
 *
 * SCRUM-138, a subtask of SCRUM-20 (Search Venues Against Event Requirements).
 *
 * AC3: a venue is returned only if it meets every supplied criterion --
 * capacity at least the expected attendance, operating hours covering the
 * whole requested period, the requested layout supported, and every requested
 * accessibility feature and facility provided.
 *
 * AC4: a venue that meets only some of them is not returned. That is why
 * matchesAllCriteria joins its checks with && and nothing else: there is no
 * score, no "close enough" and no partial credit to get wrong.
 *
 * The rule lives here, in one pure module, rather than in the PostgREST query
 * or the service. One home means the search can never hold two copies of it
 * that disagree, and pure functions mean every boundary -- capacity equal to
 * attendance, an event ending on the closing minute -- can be unit-tested with
 * no database, which matters because CI has none.
 *
 * Deliberately NOT here: bookings, blocks, setup and turnaround. Whether a
 * venue is free is SCRUM-139's rule (AC5/AC6). Operating hours are checked
 * against the event's own, unpadded period, because AC3 speaks of "the
 * requested period" -- setup and turnaround are the venue's business.
 *
 * Deliberately free of imports, database calls and framework code -- pure data
 * and pure functions, the same shape as domain/turnaroundOptions.js.
 *
 * Shapes:
 *  - venue: what venueService's toVenueWithAttributes returns -- maxCapacity,
 *    and layouts, accessibility and facilities as arrays of codes, and hours as
 *    [{ day_of_week, opens_at, closes_at }] straight from venue_operating_hours.
 *  - criteria: what validateEventSearchCriteria returns -- startsAt, endsAt,
 *    expectedAttendance, and optionally layout, accessibility and facilities.
 *    An optional criterion that is absent is not filtered on.
 */

/**
 * The zone a venue's opening hours are written in.
 *
 * venue_operating_hours holds bare `time` values with no zone (002): "09:00"
 * means nine in the morning on a Singapore clock. The request arrives as an
 * instant with any offset, and the server may well run in UTC, so the server's
 * own zone cannot be trusted to turn one into the other. Every venue is in
 * Singapore today; a venue in another zone would need a time_zone column, and
 * this constant is the one place that would change.
 */
export const VENUE_TIME_ZONE = 'Asia/Singapore';

/**
 * One formatter, built once: constructing an Intl.DateTimeFormat is far more
 * expensive than calling it, and a search calls it twice per venue.
 *
 * hourCycle 'h23', not hour12: false. With hour12: false some engines report
 * midnight as hour "24" rather than "00", which would put a 00:30 start at
 * 1470 minutes and past every closing time. 'h23' always counts 0 to 23.
 *
 * Singapore has no daylight saving, but the zone is still resolved by Intl
 * rather than by adding eight hours, so the history of the zone (it was +07:30
 * before 1982) and any future change are the platform's problem, not ours.
 */
const VENUE_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: VENUE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/**
 * An instant as a venue's wall clock reads it.
 *
 * '2026-11-11T02:00:00Z' and '2026-11-11T10:00:00+08:00' are the same instant
 * and both come back as Wednesday 2026-11-11, 600 minutes -- the weekday and
 * time are taken from the Singapore date, never the UTC one (B-AC3-08/10).
 *
 * formatToParts rather than parsing format()'s output: the parts are labelled,
 * so nothing here depends on the locale's punctuation or field order.
 *
 * @param {string|Date} instant  an ISO 8601 timestamp with an offset, or a Date
 * @returns {{date: string, dayOfWeek: number, minutes: number}}
 *   date 'YYYY-MM-DD'; dayOfWeek 0-6 with 0 = Sunday, the convention
 *   venue_operating_hours.day_of_week uses (002); minutes since local
 *   midnight, with any seconds as a fraction
 */
export function toVenueLocal(instant) {
  const parts = Object.fromEntries(
    VENUE_CLOCK.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    // The weekday of a calendar date does not depend on any zone, so it is
    // computed from the local date itself in UTC -- where no zone can shift
    // it -- rather than mapped from a locale's 'Wed'.
    dayOfWeek: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    minutes: Number(parts.hour) * 60 + Number(parts.minute) + Number(parts.second) / 60,
  };
}

/**
 * 'HH:MM:SS' (or 'HH:MM') to minutes since midnight.
 *
 * PostgREST returns `time` columns as 'HH:MM:SS'. The seconds are honoured
 * rather than dropped, so a venue opening at 09:00:30 does not cover an event
 * starting at 09:00. Each part is weighted by its position, which reads
 * 'HH:MM' and 'HH:MM:SS' alike without a branch for the missing seconds.
 */
const TIME_PART_MINUTES = [60, 1, 1 / 60];

function timeToMinutes(time) {
  return time
    .split(':')
    .reduce((total, part, index) => total + Number(part) * TIME_PART_MINUTES[index], 0);
}

/**
 * AC3: "capacity >= attendance".
 *
 * >= and not >: a 100-seat room holds an event of 100 (B-AC3-01). Off by one
 * here would refuse every venue sized exactly for its event.
 *
 * @param {{maxCapacity: number}} venue
 * @param {number} attendance  the event's expected attendance
 * @returns {boolean}
 */
export function meetsCapacity(venue, attendance) {
  return venue.maxCapacity >= attendance;
}

/**
 * AC3: the venue's operating hours cover the whole requested period.
 *
 * Three conditions, each a reason a venue cannot host the event:
 *
 *  1. Start and end on the same Singapore date. Hours cannot run past midnight
 *     (closes_at > opens_at, 002/017), so no venue can be open across one and
 *     an overnight event can never fit. This returns false rather than
 *     throwing; whether validation should refuse such a request outright is
 *     SCRUM-20 open point 7, still undecided.
 *  2. A row for that weekday. A weekday with no row is closed (017's known
 *     limit), not open all day.
 *  3. opens_at <= start and closes_at >= end. Both edges inclusive: an event
 *     09:00-18:00 fits hours 09:00-18:00 exactly (B-AC3-04), while 08:59 or
 *     18:01 does not (B-AC3-05/06).
 *
 * @param {Array<{day_of_week: number, opens_at: string, closes_at: string}>} hours
 * @param {string|Date} startsAt
 * @param {string|Date} endsAt
 * @returns {boolean}
 */
export function coversPeriod(hours, startsAt, endsAt) {
  const start = toVenueLocal(startsAt);
  const end = toVenueLocal(endsAt);

  if (start.date !== end.date) return false;

  const row = hours.find((entry) => entry.day_of_week === start.dayOfWeek);
  if (row === undefined) return false;

  return (
    timeToMinutes(row.opens_at) <= start.minutes &&
    timeToMinutes(row.closes_at) >= end.minutes
  );
}

/**
 * AC3: the requested layout is one the venue supports.
 *
 * AC1 makes layout optional, so no layout asked for means every venue passes.
 * A single code, not a list: an event is set out in one layout.
 *
 * @param {{layouts: string[]}} venue
 * @param {string} [layout]
 * @returns {boolean}
 */
export function supportsLayout(venue, layout) {
  return layout === undefined || venue.layouts.includes(layout);
}

/**
 * AC3: the venue provides every requested item -- used for both accessibility
 * features and facilities.
 *
 * "Every", so a venue with more than was asked for passes (B-AC3-14/17) and a
 * venue missing even one does not (B-AC3-15/18). Nothing asked for -- the
 * criterion absent, or an empty list -- passes, since [].every() is true.
 *
 * @param {string[]} venueCodes  what the venue has
 * @param {string[]} [requested] what the event needs
 * @returns {boolean}
 */
export function providesAll(venueCodes, requested) {
  return requested === undefined || requested.every((code) => venueCodes.includes(code));
}

/**
 * AC3 and AC4: does this venue meet every supplied criterion?
 *
 * Returns a boolean and nothing else, on purpose. It never says which check
 * failed, so no caller can pass a reason on: SCRUM-143's no-match message is
 * general, and SCRUM-145 checks that nothing diagnoses why a venue was left
 * out. Keeping the reason out of this function makes that true by
 * construction rather than by every caller remembering not to.
 *
 * @param {object} venue     as described in the header
 * @param {object} criteria  as described in the header
 * @returns {boolean}
 */
export function matchesAllCriteria(venue, criteria) {
  return (
    meetsCapacity(venue, criteria.expectedAttendance) &&
    coversPeriod(venue.hours, criteria.startsAt, criteria.endsAt) &&
    supportsLayout(venue, criteria.layout) &&
    providesAll(venue.accessibility, criteria.accessibility) &&
    providesAll(venue.facilities, criteria.facilities)
  );
}
