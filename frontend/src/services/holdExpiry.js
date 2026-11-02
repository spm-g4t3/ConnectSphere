// How soon a tentative hold expires, in words, for the holds list.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function count(n, unit) {
  return `in ${n} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * "in 3 days", "in 36 hours", "in 5 hours", "in less than an hour", or "expired".
 *
 * Rounded down past a day, because understating a deadline is the safe
 * direction: Venue Staff act early rather than find the hold already gone.
 * Hours are kept below 48 so a short hold just placed does not read "in 1 day".
 * `soon` is true within 24 hours, when Venue Staff may want to act before the
 * venue is released.
 *
 * @param {string|Date} expiresAt
 * @param {Date} [now]
 * @returns {{relative: string|null, soon: boolean}}  relative is null for an unreadable date
 */
export function describeHoldExpiry(expiresAt, now = new Date()) {
  const remaining = new Date(expiresAt).getTime() - now.getTime();
  if (Number.isNaN(remaining)) return { relative: null, soon: false };
  if (remaining <= 0) return { relative: "expired", soon: false };

  const soon = remaining <= DAY;
  if (remaining < HOUR) return { relative: "in less than an hour", soon };
  if (soon) return { relative: count(Math.round(remaining / HOUR), "hour"), soon };
  if (remaining < 2 * DAY) return { relative: count(Math.floor(remaining / HOUR), "hour"), soon };
  return { relative: count(Math.floor(remaining / DAY), "day"), soon };
}
