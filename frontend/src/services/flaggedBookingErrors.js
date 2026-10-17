// flaggedBookingErrors.js
//
// What a failed reinstate or cancel says to Venue Staff. Keyed by the 409
// `code` first, then by status, then a default, as bookingRequestErrors.js
// does it. data.error is never read: it is database prose carrying raw uuids.

import { inTheWayText, occupantText, periodConflicts } from "./bookingRequestErrors";
import { reasonLabel } from "./venueBlockReasons";

const CODE_MESSAGES = {
  BOOKING_NOT_FLAGGED:
    "This booking is no longer flagged for review; it may already have been resolved. The list has been refreshed.",
  SAFETY_FLAG_NOT_REINSTATABLE:
    "This booking was flagged by the safety review, so it can't be reinstated. It can be cancelled.",
  EVENT_NOT_BOOKABLE:
    "This event is no longer approved, in the safety check, or confirmed (it may have been cancelled), so its booking can't be reinstated. It can be cancelled.",
  BOOKING_PERIOD_STALE:
    "The event's dates have changed, so this booking no longer covers the whole event and can't be reinstated. It can be cancelled, so the coordinator can request the venue for the new dates.",
  VENUE_RETIRED: "This venue has been retired, so the booking can't be reinstated. It can be cancelled.",
  BOOKING_CHANGED:
    "This booking changed while you were resolving it. The list has been refreshed; please try again.",
};

const STATUS_MESSAGES = {
  400: "The reason was not accepted. A reason is required, and it must be at most 1000 characters.",
  401: "Your session has expired. Please sign in again.",
  403: "Only Venue Staff can resolve flagged bookings.",
  404: "That booking no longer exists. The list has been refreshed.",
};

const DEFAULT_MESSAGE = "Could not resolve the flagged booking. Please try again.";

const CONFLICT_CODE = "BOOKING_PERIOD_CONFLICT";

function codeOf(err) {
  return err?.response?.data?.code ?? null;
}

/**
 * What now occupies the venue, from a BOOKING_PERIOD_CONFLICT answer: venue
 * blocks, other bookings and tentative holds, as { kind, ... }. The same
 * filter as a pending request's approval, under this screen's name.
 */
export const resolutionConflicts = periodConflicts;

/** One thing in the way of a reinstatement, named for Venue Staff, with the block's reason. */
export function conflictText(conflict) {
  const text = occupantText(conflict, "booking");
  return conflict.kind === "block" ? `${text} (${reasonLabel(conflict.reason)})` : text;
}

/**
 * The message for a failed reinstate or cancel. A BOOKING_PERIOD_CONFLICT
 * names what now occupies the venue.
 *
 * @param {unknown} err  what reinstateFlaggedBooking or cancelFlaggedBooking threw
 * @returns {string}
 */
export function resolutionErrorMessage(err) {
  const code = codeOf(err);
  if (code === CONFLICT_CODE) {
    const inTheWay = inTheWayText(resolutionConflicts(err), conflictText);
    return `The venue is no longer free for this booking's period, setup and turnaround included, so it can't be reinstated.${inTheWay}`;
  }
  if (code && Object.hasOwn(CODE_MESSAGES, code)) return CODE_MESSAGES[code];

  const status = err?.response?.status;
  if (Object.hasOwn(STATUS_MESSAGES, status)) return STATUS_MESSAGES[status];

  return DEFAULT_MESSAGE;
}

/**
 * Whether a failed resolution means the list on screen is out of date, so the
 * caller should refetch: the booking is gone (404), no longer flagged, or
 * changed under the call.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isStaleResolutionError(err) {
  const code = codeOf(err);
  return err?.response?.status === 404 || code === "BOOKING_NOT_FLAGGED" || code === "BOOKING_CHANGED";
}

// The coordinator's 403 names the coordinator, not Venue Staff; every other
// refusal of a cancel reads the same on either screen.
const COORDINATOR_CANCEL_FORBIDDEN =
  "Only the coordinator assigned to this event can cancel its flagged bookings.";

/**
 * The message for a failed cancel from the coordinator's event screen.
 *
 * @param {unknown} err  what cancelFlaggedBooking threw
 * @returns {string}
 */
export function coordinatorCancelErrorMessage(err) {
  if (err?.response?.status === 403) return COORDINATOR_CANCEL_FORBIDDEN;
  return resolutionErrorMessage(err);
}
