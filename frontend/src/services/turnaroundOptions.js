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

import { pluralise } from "./displayFormat";

export const TURNAROUND_MINUTES = Object.freeze([0, 15, 30, 45, 60, 90, 120]);

export const DEFAULT_TURNAROUND_MINUTES = 0;

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
  if (hours === 0) return pluralise(rest, "minute");
  if (rest === 0) return pluralise(hours, "hour");
  return `${pluralise(hours, "hour")} ${pluralise(rest, "minute")}`;
}

/**
 * A list of minutes as a venue form's <select> options, labelled by
 * formatTurnaround, and `optionsWith(current)`: the options plus the venue's
 * saved value when the list does not have it.
 *
 * The same job optionsWithUnknownCodes does for the checkbox lists. Without
 * it a controlled <select> whose value matches no option silently SHOWS the
 * first one ("None") while the state still holds the saved value -- so the
 * form would display one value and keep another. The extra option makes
 * the saved value visible, and choosing a listed value is still one click.
 *
 * @param {ReadonlyArray<number>} minutesList
 * @returns {{ options: ReadonlyArray<{minutes, label}>,
 *   optionsWith: (current: *) => ReadonlyArray<{minutes, label, unknown?: boolean}> }}
 */
export function makeMinuteOptions(minutesList) {
  const options = Object.freeze(
    minutesList.map((minutes) =>
      Object.freeze({ minutes, label: formatTurnaround(minutes) }),
    ),
  );

  function optionsWith(current) {
    if (current === null || current === undefined) return options;
    if (minutesList.includes(current)) return options;
    return [
      ...options,
      {
        minutes: current,
        label: `${formatTurnaround(current)} (not in this form's list)`,
        unknown: true,
      },
    ];
  }

  return { options, optionsWith };
}

const turnaround = makeMinuteOptions(TURNAROUND_MINUTES);

export const TURNAROUND_OPTIONS = turnaround.options;

/** @param {*} current  the saved turnaroundMinutes, or null/undefined */
export const turnaroundOptionsWith = turnaround.optionsWith;
