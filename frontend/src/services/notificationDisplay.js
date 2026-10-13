// notificationDisplay.js
//
// SCRUM-128 (SCRUM-17 AC3). Turns a stored notification into the two lines
// the recipient reads. Kept out of CoordinatorNotifications.jsx so the
// wording is testable without rendering, the same split as
// eventRequestStatusDisplay.js.
//
// Each type's payload is a snapshot its migration writes:
//   booking_flagged (014): { venueName, eventName, startsAt, endsAt, reason,
//     blockStartsAt, blockEndsAt }
//   booking_request_withdrawn (031): { eventRequestId, eventName, venueId,
//     venueName, startsAt, endsAt }
//   booking_flagged_setup_change (034, SCRUM-484): { venueName, eventName,
//     startsAt, endsAt, occupiedStartsAt, occupiedEndsAt, setupMinutes,
//     turnaroundMinutes, reason }
//   venue_hold_expired (040, SCRUM-491): { eventRequestId, eventName,
//     venueId, venueName, expiresAt }
//   event_cancelled (047, SCRUM-374): { audience, eventName, reason,
//     cancelledAt }
// Every field is read defensively -- a notification outlives the build that
// wrote it, and a missing name should read as "Unknown venue", not as
// "undefined".

import { formatRange, formatTimestamp } from "./displayFormat";
import { reasonLabel } from "./venueBlockReasons";
import { formatOccupiedPeriod } from "./occupiedPeriodDisplay";

/** True when `value` is a time that will parse. */
function isInstant(value) {
  if (value === null || value === undefined || value === "") return false;
  return !Number.isNaN(new Date(value).getTime());
}

/**
 * The sentence after "Setup or turnaround time changed." in a
 * booking_flagged_setup_change notification, with its leading space, or "".
 *
 * formatOccupiedPeriod falls back to the event times, so with those missing
 * it would read "unknown – unknown" even when the occupied times are there.
 * Each case says only what the payload actually has:
 *   - event times present: the labelled period, "It now occupies Setup … ·
 *     Event … · Turnaround …." (or the bare event range at a venue with none);
 *   - only the occupied times: "It now occupies <that range>.";
 *   - neither: nothing, rather than a sentence about an unknown time.
 */
function setupChangePeriod(payload) {
  if (isInstant(payload.startsAt) && isInstant(payload.endsAt)) {
    const period = formatOccupiedPeriod({
      startsAt: payload.startsAt,
      endsAt: payload.endsAt,
      occupiedStartsAt: payload.occupiedStartsAt,
      occupiedEndsAt: payload.occupiedEndsAt,
    });
    return ` It now occupies ${period}.`;
  }
  if (isInstant(payload.occupiedStartsAt) && isInstant(payload.occupiedEndsAt)) {
    return ` It now occupies ${formatRange(payload.occupiedStartsAt, payload.occupiedEndsAt)}.`;
  }
  return "";
}

/**
 * A notification as a headline and a detail line.
 *
 * @param {Object} notification  as returned by GET /api/notifications
 * @returns {{headline: string, detail: string}}
 */
export function describeNotification(notification) {
  const payload = notification?.payload ?? {};

  if (notification?.type === "booking_flagged") {
    const eventName = payload.eventName || "Unnamed event";
    const venueName = payload.venueName || "Unknown venue";
    const reason = payload.reason ? reasonLabel(payload.reason) : "unspecified reason";

    return {
      headline: `${eventName} at ${venueName} needs review`,
      detail:
        `Booked ${formatRange(payload.startsAt, payload.endsAt)}. ` +
        `The venue is blocked for ${reason}, ${formatRange(payload.blockStartsAt, payload.blockEndsAt)}.`,
    };
  }

  // SCRUM-484 (AC8). The same headline as booking_flagged: to the reader it
  // is the same thing, a booking that needs review. The detail gives the
  // period the booking now holds the venue for, with its setup and
  // turnaround parts, since that is what changed. payload.reason is the
  // backend's own sentence for the cause and is not repeated here.
  if (notification?.type === "booking_flagged_setup_change") {
    const eventName = payload.eventName || "Unnamed event";
    const venueName = payload.venueName || "Unknown venue";

    return {
      headline: `${eventName} at ${venueName} needs review`,
      detail: `Setup or turnaround time changed.${setupChangePeriod(payload)}`,
    };
  }

  // SCRUM-491 (AC8). Sent to the holding event's assigned coordinator once a
  // tentative hold's expiry has passed. Said plainly that it was never a
  // booking (AC7), so nobody reads the venue as theirs.
  if (notification?.type === "venue_hold_expired") {
    const eventName = payload.eventName || "Unnamed event";
    const venueName = payload.venueName || "Unknown venue";

    return {
      headline: `The hold on ${venueName} for ${eventName} has expired`,
      detail:
        `It expired ${formatTimestamp(payload.expiresAt)}. ` +
        "The venue is no longer held for this event; a hold is not a booking.",
    };
  }

  // 031. Sent to Venue Staff when a coordinator withdraws a pending request.
  if (notification?.type === "booking_request_withdrawn") {
    const eventName = payload.eventName || "Unnamed event";
    const venueName = payload.venueName || "Unknown venue";

    return {
      headline: `The request for ${eventName} at ${venueName} was withdrawn`,
      detail:
        `It was for ${formatRange(payload.startsAt, payload.endsAt)}. ` +
        "It no longer needs a decision.",
    };
  }

  if (notification?.type === "event_cancelled") {
    const eventName = payload.eventName || "Unnamed event";
    if (payload.audience === "organiser") {
      const reason = payload.reason || "No reason recorded";
      const cancelledAt = payload.cancelledAt
        ? ` Cancelled ${formatTimestamp(payload.cancelledAt)}.`
        : "";
      return {
        headline: `${eventName} was cancelled`,
        detail: `Reason: ${reason}.${cancelledAt}`,
      };
    }
    if (payload.audience === "venue_staff") {
      return {
        headline: `Bookings for ${eventName} were released`,
        detail: "Pending booking requests were withdrawn and confirmed bookings were cancelled.",
      };
    }
    if (payload.audience === "technical_support_staff") {
      return {
        headline: `Equipment arrangements for ${eventName} were cancelled`,
        detail: "The equipment request was cancelled and its active reservations were released.",
      };
    }
  }

  if (
    notification?.type === "clarification_requested" ||
    notification?.type === "clarification_replied" ||
    notification?.type === "clarification_closed"
  ) {
    const eventName = payload.eventName || "the event request";
    const headlineByType = {
      clarification_requested: `A Coordinator has a question about ${eventName}`,
      clarification_replied: `The Organiser replied about ${eventName}`,
      clarification_closed: `A Coordinator closed the clarification for ${eventName}`,
    };
    const detail = payload.message || "Open the event request to review the conversation.";
    return {
      headline: headlineByType[notification.type],
      detail: payload.replyByDate
        ? `${detail} Reply by ${payload.replyByDate}.`
        : detail,
    };
  }

  // A type this build does not know (the backend added one). Shown, not
  // hidden: an unread notification that renders as nothing would sit in the
  // unread count with no way to find or clear it.
  return {
    headline: "New notification",
    detail: "This notification type cannot be displayed yet.",
  };
}
