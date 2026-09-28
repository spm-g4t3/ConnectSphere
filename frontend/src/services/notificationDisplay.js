// notificationDisplay.js
//
// SCRUM-128 (SCRUM-17 AC3). Turns a stored notification into the two lines
// the Coordinator reads. Kept out of CoordinatorNotifications.jsx so the
// wording is testable without rendering, the same split as
// eventRequestStatusDisplay.js.
//
// The payload is the snapshot 013_booking_review_notifications.sql writes:
// { venueName, eventName, startsAt, endsAt, reason, blockStartsAt,
//   blockEndsAt }. Every field is read defensively -- a notification outlives
// the build that wrote it, and a missing name should read as "Unknown venue",
// not as "undefined".

import { formatRange } from "./displayFormat";
import { reasonLabel } from "./venueBlockReasons";

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

  // A type this build does not know (the backend added one). Shown, not
  // hidden: an unread notification that renders as nothing would sit in the
  // unread count with no way to find or clear it.
  return {
    headline: "New notification",
    detail: "This notification type cannot be displayed yet.",
  };
}
