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
