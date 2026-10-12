// eventPeriodFormat.js
//
// SCRUM-287. How the equipment request queue writes an event's date and times.
// Its own file, not the component's, so the component file exports only the
// component (react-refresh).

const isValid = (date) => !Number.isNaN(date.getTime());

/**
 * "Tue, 1 Dec 2030, 10:00 AM to 12:00 PM" for an event within one day, both full
 * timestamps for one that spans days, and a plain sentence when it has no date.
 */
export function formatEventPeriod(start, end) {
  const from = start ? new Date(start) : null;
  const to = end ? new Date(end) : null;
  if (!from || !to || !isValid(from) || !isValid(to)) return "Date not set";

  const dayOptions = { weekday: "short", day: "numeric", month: "short", year: "numeric" };
  const timeOptions = { hour: "numeric", minute: "2-digit" };

  if (from.toDateString() === to.toDateString()) {
    return `${from.toLocaleDateString(undefined, dayOptions)}, ${from.toLocaleTimeString(undefined, timeOptions)} to ${to.toLocaleTimeString(undefined, timeOptions)}`;
  }
  return `${from.toLocaleString()} to ${to.toLocaleString()}`;
}
