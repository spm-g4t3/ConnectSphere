// flaggedBookingDisplay.js
//
// Shared wording for the review reasons stored on flagged bookings, for the
// replacement requests linked to them, and for a booking or request that an
// approval moves to its event's new period.
//
// A services module, not part of a component, because the react-refresh lint
// rule lets component files export components only.

import { statusLabel } from "./bookingRequestEligibility";
import { formatVenuePeriod } from "./datetimeFormat";
import { reasonLabel } from "./venueBlockReasons";

// Keyed by the review_reason code the backend stores on a flagged booking.
// A booking flagged for any other cause (a venue block, 014) has no code.
// event_changed is allowed by 078 before anything sets it; retiring a venue
// (085) sets venue_details_changed.
export const REVIEW_REASON_LABELS = Object.freeze({
  setup_or_turnaround_changed: "Setup or turnaround time changed",
  safety_review: "Safety review",
  event_changed: "Event details changed",
  venue_details_changed: "Venue details changed",
});

/**
 * The label for a review reason code, or null when there is no code or this
 * build does not know it. Null rather than the raw code, so a new code reads
 * as nothing extra instead of as "some_snake_case".
 *
 * @param {string|null|undefined} code
 * @returns {string|null}
 */
export function reviewReasonLabel(code) {
  if (!code) return null;
  return Object.prototype.hasOwnProperty.call(REVIEW_REASON_LABELS, code)
    ? REVIEW_REASON_LABELS[code]
    : null;
}

/** Why a venue save flagged a booking it listed as an hours conflict. */
export const HOURS_CHANGED_REASON = "Operating hours changed";

/**
 * The causes behind a venue save's flaggedBookings, for the notice heading.
 * A flagged booking the user confirmed as an hours conflict was flagged for
 * the hours; any other was flagged by a new setup or turnaround time.
 *
 * @param {Array<{bookingId: string}>} flaggedBookings  from the save
 * @param {string[]} [confirmedHoursChange=[]]  the ids sent as confirmHoursChange
 * @returns {string[]}  labels, hours first; empty when nothing was flagged
 */
export function venueSaveFlagReasons(flaggedBookings, confirmedHoursChange = []) {
  const confirmed = new Set(confirmedHoursChange.map(String));
  const reasons = [];
  if (flaggedBookings.some((b) => confirmed.has(String(b.bookingId)))) reasons.push(HOURS_CHANGED_REASON);
  if (flaggedBookings.some((b) => !confirmed.has(String(b.bookingId)))) {
    reasons.push(REVIEW_REASON_LABELS.setup_or_turnaround_changed);
  }
  return reasons;
}

/**
 * The heading of the notice after a venue save flagged bookings:
 * "2 bookings at Harbour Room flagged for review: Setup or turnaround time
 * changed". The venue is named because the notice outlives the form: once it
 * closes, the catalogue lists every venue and nothing else says which one
 * was edited. Without a name (a blank or missing one) it reads
 * "1 booking flagged for review: …", as before. `reasons` comes from
 * venueSaveFlagReasons; without any it is the setup or turnaround change.
 *
 * @param {number} count
 * @param {string} [venueName]
 * @param {string[]} [reasons]
 * @returns {string}
 */
export function flaggedBookingsHeading(count, venueName, reasons) {
  const bookings = count === 1 ? "1 booking" : `${count} bookings`;
  const name = typeof venueName === "string" ? venueName.trim() : "";
  const where = name ? ` at ${name}` : "";
  const why = reasons?.length ? reasons : [REVIEW_REASON_LABELS.setup_or_turnaround_changed];
  return `${bookings}${where} flagged for review: ${why.join("; ")}`;
}

/**
 * Every cause recorded on a flagged booking, as { kind, text, details }. A
 * safety flag keeps the block that flagged the booking before it (071), so a
 * booking can have both a block and a review reason.
 *
 * @param {object} item  a row from getFlaggedBookings
 * @returns {Array<{kind: "block"|"review"|"unknown", text: string, details: string[]}>}
 */
export function flagReasons(item) {
  const reasons = [];
  const block = item?.block;
  if (block) {
    const label = block.reason ? reasonLabel(block.reason) : null;
    const removed = block.removedAt ? " (block since removed)" : "";
    const details = [`Blocked ${formatVenuePeriod(block.startsAt, block.endsAt)}`];
    if (block.notes) details.push(`Notes: ${block.notes}`);
    reasons.push({
      kind: "block",
      text: `${label ? `Venue unavailable: ${label}` : "Venue unavailable"}${removed}`,
      details,
    });
  }
  const review = reviewReasonLabel(item?.reviewReason);
  if (review) reasons.push({ kind: "review", text: review, details: [] });
  if (reasons.length === 0) reasons.push({ kind: "unknown", text: "Reason not recorded", details: [] });
  return reasons;
}

/** Text with its first letter upper-cased, for labels that start a line. */
export function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * An event or booking status as a label that starts a line: "pending" reads
 * "Pending", and a missing status "Unknown".
 *
 * @param {string|null|undefined} status
 * @returns {string}
 */
export function bookingStatusText(status) {
  return capitalise(statusLabel(status));
}

/**
 * A flagged booking's venue, with its location when known: "Room A, Level 2".
 *
 * @param {{venueName?: string|null, venueLocation?: string|null}} item
 * @returns {string}
 */
export function venueText(item) {
  const name = item.venueName || "Unknown venue";
  return item.venueLocation ? `${name}, ${item.venueLocation}` : name;
}

/**
 * One open replacement request on a flagged booking, as both the coordinator
 * and Venue Staff see it: "Replacement requested: Room B, <period> (Pending)".
 *
 * @param {{venueName?: string|null, status?: string, startsAt?: string, endsAt?: string}} request
 * @returns {string}
 */
export function replacementRequestText(request) {
  const venue = request.venueName || "Unknown venue";
  const period = formatVenuePeriod(request.startsAt, request.endsAt);
  return `Replacement requested: ${venue}, ${period} (${bookingStatusText(request.status)})`;
}

/**
 * A row's open replacement requests; a missing or malformed field reads as
 * none, so an older server shows nothing rather than failing.
 *
 * @param {object} item  a flagged booking row
 * @returns {object[]}
 */
export function replacementRequests(item) {
  return Array.isArray(item.replacementRequests) ? item.replacementRequests : [];
}

/**
 * The note on a pending request raised to replace a flagged booking. While
 * that booking is flagged, approving cancels it; once it was reinstated
 * (approved), approving leaves it alone and books a second venue.
 *
 * @param {{venueName?: string|null, startsAt?: string, endsAt?: string, status?: string}} replaces
 * @returns {string}
 */
export function replacesFlaggedBookingText(replaces) {
  const venue = replaces.venueName || "Unknown venue";
  const period = formatVenuePeriod(replaces.startsAt, replaces.endsAt);
  if (replaces.status === "approved") {
    return (
      `The booking this request was meant to replace, at ${venue}, ${period}, was reinstated. ` +
      "Approving this request books a second venue for the event and does not cancel that booking."
    );
  }
  return `Replaces the flagged booking at ${venue}, ${period}. Approving this request cancels that booking.`;
}

/** The event's current period as instants, or null unless both times parse. */
function eventPeriod(item) {
  const start = Date.parse(item.eventStartsAt);
  const end = Date.parse(item.eventEndsAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return { start, end };
}

/**
 * Whether reinstating a flagged booking moves it to its event's current
 * period: the event has both times and the booking no longer covers them, the
 * test reinstate_flagged_booking (057) applies. Instants are compared, not
 * strings, since one instant can be written with different offsets.
 *
 * @param {{startsAt?: string, endsAt?: string, eventStartsAt?: string|null, eventEndsAt?: string|null}} item
 * @returns {boolean}
 */
export function movesToEventPeriod(item) {
  const event = eventPeriod(item);
  if (!event) return false;
  return !(Date.parse(item.startsAt) <= event.start && Date.parse(item.endsAt) >= event.end);
}

/**
 * Whether an open request's event has moved since it was raised, so approving
 * it books the event's new period instead of the request's own (057).
 *
 * @param {{startsAt?: string, endsAt?: string, eventStartsAt?: string|null, eventEndsAt?: string|null}} item
 * @returns {boolean}
 */
export function eventMovedFromRequest(item) {
  const event = eventPeriod(item);
  if (!event) return false;
  return Date.parse(item.startsAt) !== event.start || Date.parse(item.endsAt) !== event.end;
}
