// Date, times and availability for the browse pages, in Singapore wall clock
// on every device (the venue's hours are kept in it). EVENT_TIME_NOTE names the zone.

import { VENUE_TIME_NOTE, toVenueWallClock } from "./datetimeFormat";

export const EVENT_TIME_NOTE = VENUE_TIME_NOTE;

/** The event's date, e.g. "2026-10-25", or a plain fallback. */
export function formatEventDate(startsAt) {
  const wallClock = toVenueWallClock(startsAt);
  return wallClock ? wallClock.slice(0, 10) : "Date to be confirmed";
}

/** The start time, e.g. "09:00". */
export function formatEventStartTime(startsAt) {
  const wallClock = toVenueWallClock(startsAt);
  return wallClock ? wallClock.slice(11) : "Not set";
}

/**
 * The end time. When the event ends on a later day than it starts, the date
 * goes with it, so "ends 02:00" is never read as the same evening.
 */
export function formatEventEndTime(startsAt, endsAt) {
  const end = toVenueWallClock(endsAt);
  if (!end) return "Not set";

  const start = toVenueWallClock(startsAt);
  const [date, time] = end.split("T");
  return start && start.slice(0, 10) !== date ? `${date} ${time}` : time;
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
