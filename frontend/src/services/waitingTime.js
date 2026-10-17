// waitingTime.js
//
// SCRUM-486 (SCRUM-519), AC2: how long a request has waited in the Lead's
// unassigned queue, as "waiting 3 days" or "waiting 1 hour".
//
// Computed here, against the reader's clock, from the submittedAt the API
// sends, rather than by the server: a duration worked out when the list was
// read would be stale by the time anyone looked at it, and the queue is
// refetched only when the tab regains focus.
//
// Whole units, rounded down, largest unit only. The Lead is comparing rows,
// "which has waited longest", and the list is already oldest first; "2 days"
// answers that, "2 days, 3 hours and 14 minutes" only slows it down. Under an
// hour is said as such rather than in minutes for the same reason.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const plural = (count, unit) => `${count} ${unit}${count === 1 ? "" : "s"}`;

/**
 * @param {string} submittedAt  an ISO timestamp from the API
 * @param {Date} [now]          injected by tests; the reader's clock otherwise
 * @returns {string}
 */
export function describeWaiting(submittedAt, now = new Date()) {
  const submitted = submittedAt ? new Date(submittedAt).getTime() : NaN;

  // A request in this queue always has a submission time (019 sets it with
  // the status). Said plainly if one ever does not parse, never "NaN days".
  if (Number.isNaN(submitted)) return "waiting time unknown";

  // Negative only when the reader's clock is behind the server's. The request
  // has just arrived, which is what "less than an hour" says.
  const waited = now.getTime() - submitted;

  if (waited < HOUR) return "waiting less than an hour";
  if (waited < DAY) return `waiting ${plural(Math.floor(waited / HOUR), "hour")}`;
  return `waiting ${plural(Math.floor(waited / DAY), "day")}`;
}
