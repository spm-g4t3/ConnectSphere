// occupiedPeriodDisplay.js
//
// SCRUM-484 (AC7). A booking holds its venue for longer than the event: the
// venue's setup before it and its turnaround after it. AC7 asks that wherever
// a venue shows as unavailable -- the calendar, a booking request's conflicts,
// a block's conflicting bookings -- the screen says which part of that period
// is setup, which is the event and which is turnaround, so nobody reads a
// refusal at 13:14 against an event that "ended at 12:00" as a bug.
//
// The backend sends the event's startsAt/endsAt plus occupiedStartsAt/
// occupiedEndsAt (and the minutes behind them). Setup is [occupiedStartsAt,
// startsAt) and turnaround [endsAt, occupiedEndsAt); a part of zero length is
// left out, so a venue with no setup or turnaround reads as the event alone --
// its plain range, unlabelled, exactly as before AC7.
//
// An older payload, or a bad value, has no usable occupied fields. It falls
// back to the event alone rather than ever showing "Invalid Date": the event
// times are still true, only less complete.
//
// A services module, not part of a component, because the react-refresh lint
// rule lets component files export components only.

import { formatRange } from "./displayFormat";
import { formatTurnaround } from "./turnaroundOptions";

/** A Date for `value`, or null when there is none or it will not parse. */
function toInstant(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The parts of an entry's occupied period, in time order.
 *
 * Instants are compared with getTime(), never as strings: the same moment can
 * arrive as "…Z" from one field and "…+08:00" from another. The occupied
 * fields are used only when both parse and actually contain the event;
 * otherwise only the Event part is returned.
 *
 * @param {{startsAt: string, endsAt: string, occupiedStartsAt?: string,
 *          occupiedEndsAt?: string}} entry
 * @returns {Array<{label: "Setup"|"Event"|"Turnaround", startsAt: string, endsAt: string}>}
 */
export function occupiedPeriodParts(entry) {
  const event = { label: "Event", startsAt: entry?.startsAt, endsAt: entry?.endsAt };

  const start = toInstant(entry?.startsAt);
  const end = toInstant(entry?.endsAt);
  const occupiedStart = toInstant(entry?.occupiedStartsAt);
  const occupiedEnd = toInstant(entry?.occupiedEndsAt);
  if (!start || !end || !occupiedStart || !occupiedEnd) return [event];
  if (occupiedStart.getTime() > start.getTime() || occupiedEnd.getTime() < end.getTime()) {
    return [event];
  }

  const parts = [];
  if (occupiedStart.getTime() < start.getTime()) {
    parts.push({ label: "Setup", startsAt: entry.occupiedStartsAt, endsAt: entry.startsAt });
  }
  parts.push(event);
  if (occupiedEnd.getTime() > end.getTime()) {
    parts.push({ label: "Turnaround", startsAt: entry.endsAt, endsAt: entry.occupiedEndsAt });
  }
  return parts;
}

/**
 * The parts as one line: "Setup <range> · Event <range> · Turnaround <range>",
 * each range written by formatRange.
 *
 * When the Event is the only part -- no setup or turnaround, or no usable
 * occupied fields -- it is the bare formatRange, with no "Event" label. The
 * labels exist to tell parts apart; with one part there is nothing to tell
 * apart, so a booking at such a venue reads exactly as it did before AC7.
 *
 * @param {Object} entry  as occupiedPeriodParts takes it
 * @returns {string}
 */
export function formatOccupiedPeriod(entry) {
  const parts = occupiedPeriodParts(entry);
  if (parts.length === 1) return formatRange(parts[0].startsAt, parts[0].endsAt);
  return parts
    .map((part) => `${part.label} ${formatRange(part.startsAt, part.endsAt)}`)
    .join(" · ");
}

/** True for a whole number of minutes above 0, the only ones worth naming. */
function isPadding(minutes) {
  return Number.isInteger(minutes) && minutes > 0;
}

/**
 * The note under a block that a booking request ran into, or null.
 *
 * A block has no setup or turnaround of its own; the minutes on a block
 * conflict are the venue's, applied to the coordinator's event. The block is
 * checked against the event plus those minutes, so the note says they were
 * counted -- otherwise a block ending at 09:45 looks like no reason to refuse
 * a 10:00 start. Only the non-zero parts are named:
 *
 *   "Includes the 30 minutes of setup and 45 minutes of turnaround this
 *    venue needs around your event."
 *
 * @param {{setupMinutes?: number, turnaroundMinutes?: number}} conflict
 * @returns {string|null}  null when the venue needs neither
 */
export function requestPaddingNote(conflict) {
  const setup = isPadding(conflict?.setupMinutes)
    ? `${formatTurnaround(conflict.setupMinutes)} of setup`
    : null;
  const turnaround = isPadding(conflict?.turnaroundMinutes)
    ? `${formatTurnaround(conflict.turnaroundMinutes)} of turnaround`
    : null;

  if (setup && turnaround) {
    return `Includes the ${setup} and ${turnaround} this venue needs around your event.`;
  }
  if (setup) return `Includes the ${setup} this venue needs before your event.`;
  if (turnaround) return `Includes the ${turnaround} this venue needs after your event.`;
  return null;
}
