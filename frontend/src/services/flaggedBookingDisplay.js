// flaggedBookingDisplay.js
//
// SCRUM-484 (AC8). Changing a venue's setup or turnaround time can make its
// approved bookings overlap, and the backend flags those for review (034).
// This module holds the wording for that, so the venue catalogue's notice and
// the coordinator's booking-request list say the same thing.
//
// A services module, not part of a component, because the react-refresh lint
// rule lets component files export components only.

// Keyed by the review_reason code the backend stores on a flagged booking.
// A booking flagged for any other cause (a venue block, 014) has no code.
export const REVIEW_REASON_LABELS = Object.freeze({
  setup_or_turnaround_changed: "Setup or turnaround time changed",
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
 * "1 booking flagged for review: Setup or turnaround time changed" /
 * "3 bookings flagged for review: Setup or turnaround time changed".
 *
 * @param {number} count
 * @returns {string}
 */
export function flaggedBookingsHeading(count) {
  const bookings = count === 1 ? "1 booking" : `${count} bookings`;
  return `${bookings} flagged for review: ${REVIEW_REASON_LABELS.setup_or_turnaround_changed}`;
}
