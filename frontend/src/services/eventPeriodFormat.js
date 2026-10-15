// eventPeriodFormat.js
//
// How the equipment screens write an event's date and times. Always Singapore
// time, like every other venue and event time, so it reads the same on any device.
// Its own file so the component files export only components (react-refresh).

import { VENUE_TIME_ZONE } from "./datetimeFormat";

const isValid = (date) => !Number.isNaN(date.getTime());

const dayFormat = new Intl.DateTimeFormat("en-SG", {
  timeZone: VENUE_TIME_ZONE,
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});
const timeFormat = new Intl.DateTimeFormat("en-SG", {
  timeZone: VENUE_TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
});

/**
 * "Tue, 1 Dec 2030, 10:00 am to 12:00 pm" for an event within one day, both full
 * timestamps for one that spans days, and a plain sentence when it has no date.
 */
export function formatEventPeriod(start, end) {
  const from = start ? new Date(start) : null;
  const to = end ? new Date(end) : null;
  if (!from || !to || !isValid(from) || !isValid(to)) return "Date not set";

  const fromDay = dayFormat.format(from);
  if (fromDay === dayFormat.format(to)) {
    return `${fromDay}, ${timeFormat.format(from)} to ${timeFormat.format(to)}`;
  }
  return `${fromDay}, ${timeFormat.format(from)} to ${dayFormat.format(to)}, ${timeFormat.format(to)}`;
}
