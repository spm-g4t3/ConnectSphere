// flaggedBookingDisplay.js
//
// Shared wording for the review reasons stored on flagged bookings.
//
// A services module, not part of a component, because the react-refresh lint
// rule lets component files export components only.

import { formatVenuePeriod } from "./datetimeFormat";
import { reasonLabel } from "./venueBlockReasons";

// Keyed by the review_reason code the backend stores on a flagged booking.
// A booking flagged for any other cause (a venue block, 014) has no code.
// The last two are allowed by 078 before anything sets them.
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

/**
 * The heading of the notice after a venue save flagged bookings:
 * "2 bookings at Harbour Room flagged for review: Setup or turnaround time
 * changed". The venue is named because the notice outlives the form: once it
 * closes, the catalogue lists every venue and nothing else says which one
 * was edited. Without a name (a blank or missing one) it reads
 * "1 booking flagged for review: …", as before.
 *
 * @param {number} count
 * @param {string} [venueName]
 * @returns {string}
 */
export function flaggedBookingsHeading(count, venueName) {
  const bookings = count === 1 ? "1 booking" : `${count} bookings`;
  const name = typeof venueName === "string" ? venueName.trim() : "";
  const where = name ? ` at ${name}` : "";
  return `${bookings}${where} flagged for review: ${REVIEW_REASON_LABELS.setup_or_turnaround_changed}`;
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
