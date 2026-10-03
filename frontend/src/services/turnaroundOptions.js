// turnaroundOptions.js
//
// SCRUM-186. The turnaround a venue needs between one event ending and the
// next starting, as the durations the venue form offers.
//
// The minutes mirror TURNAROUND_MINUTES_OPTIONS in
// backend/src/domain/turnaroundOptions.js and the named CHECK
// `venues_turnaround_minutes_allowed` in
// backend/db/migrations/017_venue_turnaround.sql, in the same order. A test
// keeps this copy in step with the backend's. Only the labels are the
// frontend's own.
//
// 0 ("None") is a real choice -- back-to-back bookings are allowed -- and the
// default, because nothing enforces a gap yet. A gap longer than two hours
// belongs in a venue block, with a reason.

export const TURNAROUND_MINUTES = Object.freeze([0, 15, 30, 45, 60, 90, 120]);

export const DEFAULT_TURNAROUND_MINUTES = 0;

/** "1 minute" / "15 minutes", "1 hour" / "2 hours". */
function plural(count, unit) {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * A turnaround, in words: "None", "15 minutes", "1 hour 30 minutes".
 *
 * Works for any whole number of minutes, not only the listed ones, because it
 * also renders change history -- raw jsonb that may hold a value this build's
 * list has never offered. IT MUST NOT THROW, for the same reason VenueDetail's
 * fmt must not: one odd value would blank the whole history panel. Anything
 * that is not a whole number >= 0 is shown as itself rather than hidden.
 *
 * @param {*} minutes
 * @returns {string}
 */
export function formatTurnaround(minutes) {
  if (minutes === null || minutes === undefined) return "not set";

  if (!Number.isInteger(minutes) || minutes < 0) {
    try {
      return String(minutes);
    } catch {
      // Object.create(null) and friends have no way to become a string.
      return "unrecognised value";
    }
  }

  if (minutes === 0) return "None";

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return plural(rest, "minute");
  if (rest === 0) return plural(hours, "hour");
  return `${plural(hours, "hour")} ${plural(rest, "minute")}`;
}

export const TURNAROUND_OPTIONS = Object.freeze(
  TURNAROUND_MINUTES.map((minutes) =>
    Object.freeze({ minutes, label: formatTurnaround(minutes) }),
  ),
);

/**
 * The options, plus the venue's saved value when the list does not have it.
 *
 * The same job optionsWithUnknownCodes does for the checkbox lists. Without
 * it a controlled <select> whose value matches no option silently SHOWS the
 * first one ("None") while the state still holds the saved value -- so the
 * form would display one turnaround and keep another. The extra option makes
 * the saved value visible, and choosing a listed value is still one click.
 *
 * @param {*} current  the saved turnaroundMinutes, or null/undefined
 * @returns {ReadonlyArray<{minutes, label, unknown?: boolean}>}
 */
export function turnaroundOptionsWith(current) {
  if (current === null || current === undefined) return TURNAROUND_OPTIONS;
  if (TURNAROUND_MINUTES.includes(current)) return TURNAROUND_OPTIONS;
  return [
    ...TURNAROUND_OPTIONS,
    {
      minutes: current,
      label: `${formatTurnaround(current)} (not in this form's list)`,
      unknown: true,
    },
  ];
}
