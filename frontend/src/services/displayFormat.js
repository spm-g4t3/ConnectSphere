// displayFormat.js
//
// Small display helpers shared by more than one component. Moved out of
// VenueDetail.jsx unchanged by SCRUM-125, when BlockConflictList needed the
// same identifier and timestamp rendering.

import { VENUE_TIME_ZONE } from "./datetimeFormat";

/** A list response as an array; anything else reads as an empty list. */
export function asList(data) {
  return Array.isArray(data) ? data : [];
}

/** First segment of a uuid, for display. The full value goes in a title. */
export function shortId(id) {
  return typeof id === "string" ? id.slice(0, 8) : String(id);
}

/**
 * A timestamp as Singapore time in the reader's locale format, or the raw
 * string if it will not parse. Pinned so every device shows the same time.
 *
 * `fallback` is what a missing value reads as. It defaults to "unknown", which
 * is exactly what VenueDetail has always shown.
 */
export function formatTimestamp(value, fallback = "unknown") {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString(undefined, { timeZone: VENUE_TIME_ZONE });
}

/** As formatTimestamp, but the Singapore calendar date only. */
export function formatDate(value, fallback = "unknown") {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleDateString(undefined, { timeZone: VENUE_TIME_ZONE });
}

/**
 * As formatTimestamp, but an unparseable value comes back as given rather
 * than stringified, which is what the event lists have always rendered.
 */
export function formatEventDate(value, fallback = "Date not set") {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, { timeZone: VENUE_TIME_ZONE });
}

/** A parsed Date as a medium date and short time, Singapore time in the reader's locale format. */
export function formatMediumDateTime(date) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: VENUE_TIME_ZONE,
  }).format(date);
}

/** formatMediumDateTime for a raw value; missing and unparseable as formatEventDate. */
export function formatMediumTimestamp(value, fallback) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : formatMediumDateTime(date);
}

/** "<start> – <end>", each end formatted as formatTimestamp does. */
export function formatRange(startsAt, endsAt, fallback) {
  return `${formatTimestamp(startsAt, fallback)} – ${formatTimestamp(endsAt, fallback)}`;
}

// The display format: a fixed locale as well as a fixed zone, so every device
// shows identical text. The helpers above follow the device's format.
const dayFormat = new Intl.DateTimeFormat("en-SG", {
  timeZone: VENUE_TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
});
const timeFormat = new Intl.DateTimeFormat("en-SG", {
  timeZone: VENUE_TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
});
const dateTimeFormat = new Intl.DateTimeFormat("en-SG", {
  timeZone: VENUE_TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** A parsed Date, or null for a missing or unparseable value. */
function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "15 Jan 2026, 9:00 am"; missing and unparseable as formatTimestamp. */
export function formatDateTime(value, fallback = "unknown") {
  if (!value) return fallback;
  const date = toDate(value);
  return date ? dateTimeFormat.format(date) : String(value);
}

/** "15 Jan 2026"; missing and unparseable as formatDate. */
export function formatDay(value, fallback = "unknown") {
  if (!value) return fallback;
  const date = toDate(value);
  return date ? dayFormat.format(date) : String(value);
}

/**
 * "15 Jan 2026, 9:00 am – 11:00 am" within one Singapore day, both ends in
 * full across days. An end that is missing or unparseable reads as formatRange.
 */
export function formatDateTimeRange(startsAt, endsAt, fallback) {
  const from = toDate(startsAt);
  const to = toDate(endsAt);
  if (from && to && dayFormat.format(from) === dayFormat.format(to)) {
    return `${dateTimeFormat.format(from)} – ${timeFormat.format(to)}`;
  }
  return `${formatDateTime(startsAt, fallback)} – ${formatDateTime(endsAt, fallback)}`;
}

/**
 * As formatDateTimeRange, but a range with neither end is one missing fact,
 * so the fallback is said once rather than either side of the dash.
 */
export function formatDateTimeRangeOrFallback(startsAt, endsAt, fallback) {
  if (!startsAt && !endsAt) return fallback;
  return formatDateTimeRange(startsAt, endsAt, fallback);
}

// A calendar day in the venue calendar is the device's local midnight, so
// its local date is re-read as a UTC date and formatted in UTC: the label
// is that day on every device, never shifted by a zone conversion.
function calendarDayFormat(options) {
  const format = new Intl.DateTimeFormat("en-SG", { timeZone: "UTC", ...options });
  return (day) => format.format(new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate())));
}

/** A calendar day as "Mon". */
export const formatWeekdayShort = calendarDayFormat({ weekday: "short" });

/** A calendar day as "5 Oct". */
export const formatDayMonth = calendarDayFormat({ day: "numeric", month: "short" });

/** A calendar day as "Monday, 5 October 2026". */
export const formatLongDay = calendarDayFormat({
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

/** A calendar day as "Mon, 5 Oct 2026". */
export const formatShortDay = calendarDayFormat({
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** A calendar day as "5 Oct 2026". */
export const formatCalendarDate = calendarDayFormat({ day: "numeric", month: "short", year: "numeric" });

/** A calendar day as "5". */
export const formatDayOfMonth = calendarDayFormat({ day: "numeric" });

/** A calendar day's month as "October 2026". */
export const formatMonthYear = calendarDayFormat({ month: "long", year: "numeric" });

/** "1 minute" / "15 minutes", "1 active event" / "3 active events". */
export function pluralise(count, unit) {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * Nullable prose, trimmed, or "Not specified": a blank reads as the page
 * failing to load it, while saying it was left empty is information.
 */
export function orNotSpecified(value) {
  const text = typeof value === "string" ? value.trim() : value;
  return text ? text : "Not specified";
}
