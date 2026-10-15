// notificationDisplay.js
//
// SCRUM-128 (SCRUM-17 AC3). Turns a stored notification into the two lines
// the recipient reads. Kept out of NotificationInbox.jsx so the
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
//   event_submitted_for_safety_review (064, SCRUM-489): { eventRequestId,
//     eventName, coordinatorId, coordinatorName, startsAt, submittedAt }
//   booking_request_approved and booking_request_rejected (066, SCRUM-258):
//     { eventRequestId, eventName, venueId, venueName, startsAt, endsAt,
//     decidedAt, reason, suggestedAlternative }
//   booking_request_conflicting (066): { eventRequestId, eventName, venueId,
//     venueName, startsAt, endsAt, approvedBookingId, approvedEventRequestId,
//     approvedEventName, approvedStartsAt, approvedEndsAt }
//   event_request_awaiting_assignment (052): { eventRequestId, eventName,
//     submittedAt }
//   event_request_assigned (052): { eventRequestId, eventName, assignedById,
//     assignedByName, previousCoordinatorId, previousCoordinatorName, note }
//   event_request_coordinator_assigned (052): { eventRequestId, eventName,
//     coordinatorId, coordinatorName, previousCoordinatorId,
//     previousCoordinatorName }
//   safety_review_response (058 on SCRUM-490's branch, SCRUM-490):
//     { eventName, outcome, note, responseId, respondedAt }
//   safety_booking_flagged (058): { eventName, venueName, startsAt, endsAt,
//     reason, responseId }
//   safety_equipment_review (058): { eventName, equipmentRequestId,
//     responseId }
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

  // 066 (SCRUM-258 AC6). Sent to the event's coordinator when Venue Staff
  // decide on one of its requests.
  if (notification?.type === "booking_request_approved") {
    const eventName = payload.eventName || "Unnamed event";
    const venueName = payload.venueName || "Unknown venue";

    return {
      headline: `${venueName} was approved for ${eventName}`,
      detail: `It is booked for ${formatRange(payload.startsAt, payload.endsAt)}.`,
    };
  }

  if (notification?.type === "booking_request_rejected") {
    const eventName = payload.eventName || "Unnamed event";
    const venueName = payload.venueName || "Unknown venue";
    const reason = payload.reason || "No reason recorded";
    // Both are free text; the reason gets a full stop of its own (unless it
    // already ends a sentence) so the two do not run together.
    const detail = payload.suggestedAlternative
      ? `Reason: ${/[.!?]$/.test(reason) ? reason : `${reason}.`} Suggested alternative: ${payload.suggestedAlternative}`
      : `Reason: ${reason}`;

    return {
      headline: `The request for ${venueName} for ${eventName} was rejected`,
      detail,
    };
  }

  // 066. Another event's request for the same venue and an overlapping time
  // was approved. Said plainly that this one is still open (a flag, not a
  // refusal), so the coordinator knows the choice is theirs.
  if (notification?.type === "booking_request_conflicting") {
    const eventName = payload.eventName || "Unnamed event";
    const venueName = payload.venueName || "Unknown venue";
    const approvedEventName = payload.approvedEventName || "another event";

    return {
      headline: `Your request for ${venueName} for ${eventName} now clashes with ${approvedEventName}`,
      detail:
        `${approvedEventName} was approved for ${formatRange(payload.approvedStartsAt, payload.approvedEndsAt)}. ` +
        "Your request is still open; you can withdraw it or wait for Venue Staff.",
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

  // SCRUM-489 (AC8). Sent to every Safety Officer when a coordinator submits
  // an Approved event; the start date says how soon the check is needed.
  if (notification?.type === "event_submitted_for_safety_review") {
    const eventName = payload.eventName || "Unnamed event";
    const coordinatorName = payload.coordinatorName || "its coordinator";
    const startsAt = isInstant(payload.startsAt)
      ? ` It starts ${formatTimestamp(payload.startsAt)}.`
      : "";

    return {
      headline: "Event submitted for safety check",
      detail: `${eventName} was submitted by ${coordinatorName}.${startsAt}`,
    };
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

  // SCRUM-172 (AC6). Sent to every Lead; submissions wait in the unassigned
  // queue until a Lead picks a coordinator.
  if (notification?.type === "event_request_awaiting_assignment") {
    const eventName = payload.eventName || "Unnamed event";
    const submittedAt = isInstant(payload.submittedAt)
      ? `Submitted ${formatTimestamp(payload.submittedAt)}. `
      : "";

    return {
      headline: `${eventName} is waiting for a coordinator`,
      detail: `${submittedAt}Assign it from the unassigned queue.`,
    };
  }

  // SCRUM-172 (AC6). Sent to the new coordinator. 052 sets the previous*
  // fields to null on a first assignment, so a set previousCoordinatorId
  // means a handover.
  if (notification?.type === "event_request_assigned") {
    const eventName = payload.eventName || "Unnamed event";
    const assignedByName = payload.assignedByName || "the Lead";
    const reassigned = Boolean(payload.previousCoordinatorId);
    const previous = reassigned
      ? ` It was with ${payload.previousCoordinatorName || "the previous coordinator"}.`
      : "";
    const note = payload.note ? ` Handover note: ${payload.note}` : "";

    return {
      headline: reassigned
        ? `${eventName} was handed over to you`
        : `${eventName} was assigned to you`,
      detail: `Assigned by ${assignedByName}.${previous}${note}`,
    };
  }

  // SCRUM-172 (AC6). Sent to the Organiser. payload.note is never shown: the
  // handover note is for the coordinator only (052, SCRUM-327 D4).
  if (notification?.type === "event_request_coordinator_assigned") {
    const eventName = payload.eventName || "Unnamed event";
    const coordinatorName = payload.coordinatorName || "A coordinator";

    if (payload.previousCoordinatorId) {
      const previousName = payload.previousCoordinatorName || "the previous coordinator";
      return {
        headline: `${eventName} has a new coordinator`,
        detail: `${coordinatorName} has taken over from ${previousName}.`,
      };
    }
    return {
      headline: `${coordinatorName} is now coordinating ${eventName}`,
      detail: "They will review your request and contact you if anything is needed.",
    };
  }

  // SCRUM-172 (AC6). Sent to the Organiser and coordinator after the Safety
  // Officer responds. An unknown outcome still says who responded.
  if (notification?.type === "safety_review_response") {
    const eventName = payload.eventName || "Unnamed event";
    const headlineByOutcome = {
      approved: `${eventName} passed the safety check`,
      changes_requested: `The safety check asked for changes to ${eventName}`,
      rejected: `${eventName} did not pass the safety check`,
    };
    let detail = "Open the event for details.";
    if (payload.note) detail = `Safety Officer's note: ${payload.note}`;
    else if (payload.outcome === "approved") detail = "No changes were needed.";

    return {
      headline:
        headlineByOutcome[payload.outcome] ||
        `The Safety Officer responded about ${eventName}`,
      detail,
    };
  }

  // SCRUM-172 (AC6). Sent to Venue Staff when a safety check asks for changes
  // or rejects; a flag only, the booking itself is untouched.
  if (notification?.type === "safety_booking_flagged") {
    const eventName = payload.eventName || "Unnamed event";
    const venueName = payload.venueName || "Unknown venue";

    return {
      headline: `${eventName} at ${venueName} needs review after the safety check`,
      detail:
        `Booked ${formatRange(payload.startsAt, payload.endsAt)}. ` +
        "The Safety Officer flagged this booking.",
    };
  }

  // SCRUM-172 (AC6). Sent to Tech Support for the same safety outcomes.
  if (notification?.type === "safety_equipment_review") {
    const eventName = payload.eventName || "Unnamed event";

    return {
      headline: `Equipment for ${eventName} needs review after the safety check`,
      detail: "The Safety Officer flagged the equipment arrangements.",
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
