// StatusBadge tones for the Venue Staff screens, one colour per meaning:
// green approved or active, amber awaiting a decision, blue held, red flagged,
// blocked or rejected, grey no longer in force.

/** Keyed on statusDisplay.group, so a new booking status in an existing group needs no edit. */
export const BOOKING_GROUP_TONES = Object.freeze({
  PENDING: "warning",
  CONFLICTING: "warning",
  APPROVED: "success",
  FLAGGED: "danger",
  REJECTED: "danger",
  WITHDRAWN: "neutral",
  CANCELLED: "neutral",
  RELEASED: "neutral",
});

/** An upcoming block already blocks bookings in its period, so it reads as blocked. */
export const BLOCK_PHASE_TONES = Object.freeze({
  upcoming: "danger",
  in_effect: "danger",
  ended: "neutral",
});

export const VENUE_TONES = Object.freeze({
  active: "success",
  retired: "neutral",
});

export const HOLD_TONE = "info";

/** Unknown or missing values fall back to neutral rather than a colour that claims a meaning. */
export function toneFor(tones, key) {
  return tones[key] ?? "neutral";
}
