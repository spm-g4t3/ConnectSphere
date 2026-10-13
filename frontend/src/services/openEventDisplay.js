// openEventDisplay.js
//
// SCRUM-495. How an open event's date, times and availability read on the
// browse list. Pure, so the component interprets nothing itself.
//
// Dates and times are Singapore time on every device, because the venue's
// hours are kept in it (datetimeFormat.js).

import { VENUE_TIME_ZONE, toVenueWallClock } from "./datetimeFormat";

const DATE_FORMAT = {
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: VENUE_TIME_ZONE,
};
const TIME_FORMAT = { hour: "2-digit", minute: "2-digit", timeZone: VENUE_TIME_ZONE };

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sameVenueDay(a, b) {
  return toVenueWallClock(a.toISOString()).slice(0, 10) === toVenueWallClock(b.toISOString()).slice(0, 10);
}

/** The event's date, e.g. "Sun, 25 Oct 2026", or a plain fallback. */
export function formatEventDate(startsAt) {
  const date = toDate(startsAt);
  return date ? date.toLocaleDateString(undefined, DATE_FORMAT) : "Date to be confirmed";
}

/** The start time, e.g. "09:00". */
export function formatEventStartTime(startsAt) {
  const date = toDate(startsAt);
  return date ? date.toLocaleTimeString(undefined, TIME_FORMAT) : "Not set";
}

/**
 * The end time. When the event ends on a later day than it starts, the date
 * goes with it, so "ends 02:00" is never read as the same evening.
 */
export function formatEventEndTime(startsAt, endsAt) {
  const end = toDate(endsAt);
  if (!end) return "Not set";

  const start = toDate(startsAt);
  const time = end.toLocaleTimeString(undefined, TIME_FORMAT);
  return start && !sameVenueDay(start, end)
    ? `${end.toLocaleDateString(undefined, DATE_FORMAT)}, ${time}`
    : time;
}

/**
 * What the availability reads as: "Full", "No limit", or "N places left".
 *
 * Full wins: an event with no places left is Full whatever else is true of it.
 * A null placesLeft is the API's "no capacity set".
 */
export function availabilityLabel(event) {
  if (event.isFull) return "Full";
  if (event.placesLeft === null || event.placesLeft === undefined) return "No limit";
  return event.placesLeft === 1 ? "1 place left" : `${event.placesLeft} places left`;
}
