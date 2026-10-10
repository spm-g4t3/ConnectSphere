// calendarEntryDisplay.js
//
// SCRUM-180 (part of SCRUM-178). What one calendar entry says and how it is
// coloured, in the acceptance criteria's own words:
//   - an approved booking is "Booked", with the event name
//   - a booking flagged for review is "Booked – under review"
//   - a block is "Blocked", with its reason
//   - (SCRUM-491, AC6) an active tentative hold is "Tentatively held", naming
//     the holding event. The endpoint only returns holds still in force, so
//     an expired one never reaches here (AC7).
//
// Blocks reuse blockCalendarLabel from venueBlockDisplay.js, which SCRUM-130
// added for exactly this calendar, so the wording lives in one place. A
// block's notes are deliberately not shown: they are staff free text, and the
// calendar is read by Coordinators too.
//
// Anything this module does not recognise -- another kind, or a booking
// status other than the two the endpoint promises -- maps to null and the
// calendar leaves it out. The failure that matters is a pending or cancelled
// booking ever reading "Booked"; rendering nothing is the safe way to be
// wrong.

import { blockCalendarLabel } from "./venueBlockDisplay";

const BOOKING_DISPLAY = Object.freeze({
  approved: Object.freeze({ label: "Booked", tone: "booked" }),
  flagged_for_review: Object.freeze({ label: "Booked – under review", tone: "review" }),
});

/**
 * How one entry from GET /venues/:id/calendar is shown.
 *
 * `tone` is "booked", "review", "blocked" or "held" and becomes a BEM
 * modifier on the entry; the label carries the same meaning in words, so
 * colour is never the only signal. `detail` is the booking's or hold's event
 * name, or null when there is none to show (always null for a block).
 *
 * @param {Object} entry  a calendar entry
 * @returns {{label: string, detail: string|null, tone: "booked"|"review"|"blocked"|"held"}|null}
 */
export function calendarEntryDisplay(entry) {
  if (entry?.kind === "block") {
    return { label: blockCalendarLabel(entry), detail: null, tone: "blocked" };
  }

  // SCRUM-491 (AC6). Its own label and tone, never "Booked": a hold is not a
  // booking (AC7).
  if (entry?.kind === "hold") {
    return { label: "Tentatively held", detail: entry.eventName || null, tone: "held" };
  }

  // Object.hasOwn, not a plain lookup: a status of "toString" must not find
  // Object.prototype's method and come back looking like a match.
  if (entry?.kind !== "booking" || !Object.hasOwn(BOOKING_DISPLAY, entry.status)) {
    return null;
  }

  const { label, tone } = BOOKING_DISPLAY[entry.status];
  return { label, detail: entry.eventName || null, tone };
}
