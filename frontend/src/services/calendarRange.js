// calendarRange.js
//
// SCRUM-180 (part of SCRUM-178). The date arithmetic behind VenueCalendar:
// which days a day, week or month view covers, how Previous and Next move
// it, which entries land on which day, and the window sent to
// GET /venues/:id/calendar. Pure and React-free, so every edge can be pinned
// by a unit test rather than found by clicking.
//
// Everything is worked out in the device's local time zone, because a
// calendar's "Monday" is the reader's Monday. Two rules keep that correct
// across daylight-saving changes, and both have a wrong-looking alternative:
//
// 1. A day is never 86 400 000 ms. On a DST change it is 23 or 25 hours, so
//    adding a fixed 24 hours lands on 23:00 or 01:00 and every later day in
//    the grid is off by one hour -- or, near midnight, by one date. Days are
//    built with the local Date constructor instead, which lets the engine
//    roll the calendar date and pick that day's own midnight.
//
// 2. A month move sets the date to the 1st BEFORE changing the month.
//    setMonth on 31 January asks for 31 February, which JavaScript rolls into
//    3 March, so Next from 31 Jan would skip February entirely.
//
// Weeks start on Monday. Ranges are half-open [start, end), the same rule
// the backend uses for blocks and for the calendar window itself.
//
// Titles are formatted in en-GB on purpose: the app's examples read
// "5 – 11 Oct 2026", and a pinned locale means a test machine's own locale
// cannot change what the heading says.

import { toDatetimeLocalValue, toOffsetIsoString } from "./datetimeFormat";

export const CALENDAR_VIEWS = Object.freeze(["day", "week", "month"]);

/** The locale every calendar heading and day label is written in. */
export const CALENDAR_LOCALE = "en-GB";

const FULL_DATE = { day: "numeric", month: "short", year: "numeric" };

/**
 * Local midnight at the start of `date`'s day.
 *
 * @param {Date} date
 * @returns {Date} a new Date; `date` is not changed
 */
export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Local midnight `n` days after (or, negative, before) `date`'s day.
 *
 * Built from the calendar date rather than by adding milliseconds, so the
 * answer is a midnight even when a daylight-saving change sits in between.
 * The time of day of `date` is dropped: calendar maths here is day-based.
 *
 * One constructor call, with the day overflowing into the next month or
 * year, rather than startOfDay() then setDate(). In a zone whose DST change
 * happens AT midnight (Chile, for one) that day starts at 01:00, and setDate
 * on a 01:00 Date carries the 01:00 onto the following day too.
 *
 * @param {Date} date
 * @param {number} n  whole days
 * @returns {Date}
 */
export function addDays(date, n) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

/**
 * The Monday on or before `date`, at local midnight.
 *
 * getDay() counts from Sunday = 0; (getDay() + 6) % 7 renumbers it so that
 * Monday is 0 and Sunday 6, which is how many days back Monday is.
 *
 * @param {Date} date
 * @returns {Date}
 */
export function startOfWeek(date) {
  return addDays(date, -((date.getDay() + 6) % 7));
}

/**
 * The days a view shows around `anchor`, as local Dates with `end` exclusive.
 *
 *   - day:   that one day
 *   - week:  Monday to the following Monday
 *   - month: the Monday on or before the 1st through the Sunday after the
 *            last day, so the month grid is always whole weeks
 *
 * Any other view reads as week, the component's default.
 *
 * @param {"day"|"week"|"month"} view
 * @param {Date} anchor  any moment inside the period
 * @returns {{start: Date, end: Date}}
 */
export function rangeFor(view, anchor) {
  if (view === "day") {
    const start = startOfDay(anchor);
    return { start, end: addDays(start, 1) };
  }

  if (view === "month") {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    // Day 0 of next month is the last day of this one.
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    return { start: startOfWeek(first), end: addDays(startOfWeek(last), 7) };
  }

  const start = startOfWeek(anchor);
  return { start, end: addDays(start, 7) };
}

/**
 * The anchor one period earlier (step -1) or later (step 1).
 *
 * A month move lands on the 1st of the target month -- see rule 2 in the
 * header for why the date is set to 1 before the month changes.
 *
 * @param {"day"|"week"|"month"} view
 * @param {Date} anchor
 * @param {number} step  -1 or 1
 * @returns {Date}
 */
export function shiftAnchor(view, anchor, step) {
  if (view === "month") {
    const moved = startOfDay(anchor);
    moved.setDate(1);
    moved.setMonth(moved.getMonth() + step);
    return moved;
  }

  return addDays(anchor, view === "day" ? step : step * 7);
}

/**
 * Every day in a range, each at local midnight, in order.
 *
 * @param {{start: Date, end: Date}} range  end exclusive
 * @returns {Date[]}
 */
export function daysIn({ start, end }) {
  const days = [];
  for (let day = startOfDay(start); day < end; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
}

/**
 * The entries overlapping one day, in their original order.
 *
 * Half-open overlap with [day, next day): an entry counts when it starts
 * before the next midnight and ends after this one. So a multi-day block
 * shows on every day it covers, and an entry ending exactly at midnight does
 * not leak onto the following day.
 *
 * @param {Array<{startsAt: string, endsAt: string}>} entries
 * @param {Date} day
 * @returns {Array<Object>}
 */
export function entriesOnDay(entries, day) {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  return entries.filter(
    (entry) => new Date(entry.startsAt) < dayEnd && new Date(entry.endsAt) > dayStart,
  );
}

/**
 * A Date as the API wants it: local wall-clock with seconds and an explicit
 * offset, e.g. "2026-10-05T00:00:00+08:00".
 *
 * Goes through datetimeFormat.js rather than building the string again, so
 * the calendar speaks exactly the dialect every form does. Its invariant --
 * toOffsetIsoString(toDatetimeLocalValue(x)) names the same instant as x, to
 * the minute -- is all that is needed here, because range ends are midnights.
 */
function toWire(date) {
  return toOffsetIsoString(toDatetimeLocalValue(date.toISOString()));
}

/**
 * The query window for GET /venues/:id/calendar.
 *
 * @param {{start: Date, end: Date}} range
 * @returns {{from: string, to: string}} ISO strings with offsets
 */
export function toWireWindow({ start, end }) {
  return { from: toWire(start), to: toWire(end) };
}

/**
 * The heading over a view, in CALENDAR_LOCALE:
 *
 *   - day:   "Mon, 5 Oct 2026"
 *   - week:  "5 – 11 Oct 2026", "28 Sept – 4 Oct 2026" across a month, and
 *            "29 Dec 2025 – 4 Jan 2026" across a year
 *   - month: "October 2026"
 *
 * Exact punctuation is whatever the runtime's en-GB data says.
 *
 * @param {"day"|"week"|"month"} view
 * @param {{start: Date, end: Date}} range  as rangeFor returns it
 * @returns {string}
 */
export function rangeTitle(view, { start, end }) {
  if (view === "day") {
    return start.toLocaleDateString(CALENDAR_LOCALE, { weekday: "short", ...FULL_DATE });
  }

  if (view === "month") {
    // A month range starts up to six days before the 1st, so its first day
    // can belong to the previous month. A week in, it never does.
    return addDays(start, 7).toLocaleDateString(CALENDAR_LOCALE, {
      month: "long",
      year: "numeric",
    });
  }

  const last = addDays(end, -1);
  const sameYear = start.getFullYear() === last.getFullYear();
  const sameMonth = sameYear && start.getMonth() === last.getMonth();
  const startOptions = sameMonth
    ? { day: "numeric" }
    : sameYear
      ? { day: "numeric", month: "short" }
      : FULL_DATE;
  return `${start.toLocaleDateString(CALENDAR_LOCALE, startOptions)} – ${last.toLocaleDateString(CALENDAR_LOCALE, FULL_DATE)}`;
}

/**
 * A `?date=` value as a local-midnight Date, or null when there is no usable
 * date in it.
 *
 * Strictly YYYY-MM-DD, built with the local Date constructor so the day is
 * the reader's day (rule 1 in the header). The constructor rolls an
 * impossible date forward -- 2026-02-30 becomes 2 March -- so the year, month
 * and day must come back unchanged, or the link named a day that does not
 * exist and the caller falls back to today.
 *
 * @param {*} value  normally a string from the URL, or null when absent
 * @returns {Date|null}
 */
export function parseCalendarDate(value) {
  const match = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day);
  const unchanged =
    date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  return unchanged ? date : null;
}

/**
 * The inverse of parseCalendarDate: `date`'s local day as YYYY-MM-DD, for a
 * `?date=` link. Local getters, not toISOString, which would give the UTC
 * day: local midnight east of Greenwich is still the previous day in UTC.
 *
 * @param {Date} date
 * @returns {string} e.g. "2026-10-05"
 */
export function toCalendarDateParam(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
