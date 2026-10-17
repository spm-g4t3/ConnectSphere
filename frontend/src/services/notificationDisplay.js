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
//   booking_request_submitted (083, SCRUM-174): { eventRequestId, eventName,
//     venueId, venueName, startsAt, endsAt }
//   booking_flagged_setup_change (034, SCRUM-484): { venueName, eventName,
//     startsAt, endsAt, occupiedStartsAt, occupiedEndsAt, setupMinutes,
//     turnaroundMinutes, reason }
//   venue_hold_expired (040, SCRUM-491): { eventRequestId, eventName,
//     venueId, venueName, expiresAt }
//   event_cancelled (047, SCRUM-374): { audience, eventName, reason,
//     cancelledAt }; audience is organiser, venue_staff,
//     technical_support_staff or safety_officer
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
//   flagged_booking_resolved (SCRUM-266): { audience, outcome, eventRequestId,
//     eventName, venueId, venueName, startsAt, endsAt, reason, resolvedAt,
//     resolvedByRole, replacementBookingId, replacementVenueName,
//     replacementStartsAt, replacementEndsAt }; audience is coordinator or
//     organiser, outcome reinstated, cancelled or replaced, and the
//     replacement* fields are null unless replaced
// Every field is read defensively -- a notification outlives the build that
// wrote it, and a missing name should read as "Unknown venue", not as
// "undefined".

import { formatRange, formatTimestamp } from "./displayFormat";
import { reasonLabel } from "./venueBlockReasons";
import { formatOccupiedPeriod } from "./occupiedPeriodDisplay";

const UNNAMED_EVENT = "Unnamed event";
const UNKNOWN_VENUE = "Unknown venue";
const NO_REASON = "No reason recorded";
const PREVIOUS_COORDINATOR = "the previous coordinator";
// Week 7: a flagged booking tells its coordinator another plan is needed.
const ALTERNATIVE_ARRANGEMENTS = " Alternative arrangements are required.";

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

/** The headline every flagged-booking type opens with. */
function needsReview(eventName, venueName) {
  return `${eventName} at ${venueName} needs review`;
}

/** Free text ended with a full stop, unless it already ends a sentence. */
function asSentence(text) {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** "Booked <range>. ", the start of a flagged booking's detail. */
function bookedFor(payload) {
  return `Booked ${formatRange(payload.startsAt, payload.endsAt)}. `;
}

/**
 * The clarification types share a describer. Their fallback is "the event
 * request", not "Unnamed event": the sentence still reads with no name.
 */
function describeClarification(payload, _names, type) {
  const eventName = payload.eventName || "the event request";
  const headlineByType = {
    clarification_requested: `A Coordinator has a question about ${eventName}`,
    clarification_replied: `The Organiser replied about ${eventName}`,
    clarification_closed: `A Coordinator closed the clarification for ${eventName}`,
  };
  const detail = payload.message || "Open the event request to review the conversation.";
  return {
    headline: headlineByType[type],
    detail: payload.replyByDate
      ? `${detail} Reply by ${payload.replyByDate}.`
      : detail,
  };
}

// Keyed by notification type. Each takes (payload, { eventName, venueName },
// type) and returns { headline, detail }, or undefined to fall through to the
// generic result.
const DESCRIBERS = {
  booking_flagged(payload, { eventName, venueName }) {
    const reason = payload.reason ? reasonLabel(payload.reason) : "unspecified reason";

    return {
      headline: needsReview(eventName, venueName),
      detail:
        bookedFor(payload) +
        `The venue is blocked for ${reason}, ${formatRange(payload.blockStartsAt, payload.blockEndsAt)}.` +
        ALTERNATIVE_ARRANGEMENTS,
    };
  },

  // SCRUM-484 (AC8). The same headline as booking_flagged: to the reader it
  // is the same thing, a booking that needs review. The detail gives the
  // period the booking now holds the venue for, with its setup and
  // turnaround parts, since that is what changed. payload.reason is the
  // backend's own sentence for the cause and is not repeated here.
  booking_flagged_setup_change(payload, { eventName, venueName }) {
    return {
      headline: needsReview(eventName, venueName),
      detail: `Setup or turnaround time changed.${setupChangePeriod(payload)}${ALTERNATIVE_ARRANGEMENTS}`,
    };
  },

  // SCRUM-491 (AC8). Sent to the holding event's assigned coordinator once a
  // tentative hold's expiry has passed. Said plainly that it was never a
  // booking (AC7), so nobody reads the venue as theirs.
  venue_hold_expired(payload, { eventName, venueName }) {
    return {
      headline: `The hold on ${venueName} for ${eventName} has expired`,
      detail:
        `It expired ${formatTimestamp(payload.expiresAt)}. ` +
        "The venue is no longer held for this event; a hold is not a booking.",
    };
  },

  // 031. Sent to Venue Staff when a coordinator withdraws a pending request.
  booking_request_withdrawn(payload, { eventName, venueName }) {
    return {
      headline: `The request for ${eventName} at ${venueName} was withdrawn`,
      detail:
        `It was for ${formatRange(payload.startsAt, payload.endsAt)}. ` +
        "It no longer needs a decision.",
    };
  },

  // 083 (SCRUM-174 AC1). Sent to every Venue Staff user when a coordinator
  // submits a booking request, so it reaches the queue's deciders. The
  // reader is who must act next, so the inbox marks it as needing action.
  booking_request_submitted(payload, { eventName, venueName }) {
    return {
      headline: `New request: ${eventName} at ${venueName}`,
      detail: `It is for ${formatRange(payload.startsAt, payload.endsAt)}. It needs a decision.`,
      needsAction: true,
    };
  },

  // 066 (SCRUM-258 AC6). Sent to the event's coordinator when Venue Staff
  // decide on one of its requests.
  booking_request_approved(payload, { eventName, venueName }) {
    return {
      headline: `${venueName} was approved for ${eventName}`,
      detail: `It is booked for ${formatRange(payload.startsAt, payload.endsAt)}.`,
    };
  },

  booking_request_rejected(payload, { eventName, venueName }) {
    const reason = payload.reason || NO_REASON;
    // Both are free text; the reason gets a full stop of its own (unless it
    // already ends a sentence) so the two do not run together.
    const detail = payload.suggestedAlternative
      ? `Reason: ${asSentence(reason)} Suggested alternative: ${payload.suggestedAlternative}`
      : `Reason: ${reason}`;

    return {
      headline: `The request for ${venueName} for ${eventName} was rejected`,
      detail,
    };
  },

  // 066. Another event's request for the same venue and an overlapping time
  // was approved. Said plainly that this one is still open (a flag, not a
  // refusal), so the coordinator knows the choice is theirs.
  booking_request_conflicting(payload, { eventName, venueName }) {
    const approvedEventName = payload.approvedEventName || "another event";

    return {
      headline: `Your request for ${venueName} for ${eventName} now clashes with ${approvedEventName}`,
      detail:
        `${approvedEventName} was approved for ${formatRange(payload.approvedStartsAt, payload.approvedEndsAt)}. ` +
        "Your request is still open; you can withdraw it or wait for Venue Staff.",
    };
  },

  // SCRUM-266 (AC6). Sent to the coordinator when Venue Staff resolve a
  // flagged booking, and to the Organiser of a Confirmed event. Only the
  // coordinator is told what to do next; the Organiser has nothing to act on.
  // An unknown audience or outcome reads as the generic notification.
  flagged_booking_resolved(payload, { eventName, venueName }) {
    const forCoordinator = payload.audience === "coordinator";
    if (!forCoordinator && payload.audience !== "organiser") return undefined;
    const reason = `Reason: ${asSentence(payload.reason || NO_REASON)}`;

    if (payload.outcome === "reinstated") {
      return {
        headline: `${venueName} for ${eventName} was reinstated`,
        detail: `It is booked again for ${formatRange(payload.startsAt, payload.endsAt)}. ${reason}`,
      };
    }
    if (payload.outcome === "cancelled") {
      const byRole = {
        venue_staff: " by Venue Staff",
        event_coordinator: " by the event's coordinator",
      };
      // Own keys only, as in describeNotification; an unknown role names no one.
      const by = Object.hasOwn(byRole, payload.resolvedByRole) ? byRole[payload.resolvedByRole] : "";
      const nextStep = forCoordinator
        ? "You can request another venue from the event."
        : "Your event is not cancelled.";
      return {
        headline: `The booking of ${venueName} for ${eventName} was cancelled`,
        detail: `It was cancelled${by}. ${reason} ${nextStep}`,
      };
    }
    if (payload.outcome === "replaced") {
      const replacement = payload.replacementVenueName || UNKNOWN_VENUE;
      return {
        headline: `${venueName} for ${eventName} was replaced by ${replacement}`,
        detail:
          `${replacement} is booked for ${formatRange(payload.replacementStartsAt, payload.replacementEndsAt)}. ` +
          reason,
      };
    }
    return undefined;
  },

  // An audience this build does not know returns undefined, so it reads as
  // the generic notification. cancelledAt is only checked for being set.
  event_cancelled(payload, { eventName }) {
    if (payload.audience === "organiser") {
      const reason = payload.reason || NO_REASON;
      const cancelledAt = payload.cancelledAt
        ? ` Cancelled ${formatTimestamp(payload.cancelledAt)}.`
        : "";
      return {
        headline: `${eventName} was cancelled`,
        detail: `Reason: ${reason}.${cancelledAt}`,
      };
    }
    if (payload.audience === "safety_officer") {
      const reason = payload.reason || NO_REASON;
      const cancelledAt = payload.cancelledAt
        ? ` Cancelled ${formatTimestamp(payload.cancelledAt)}.`
        : "";
      return {
        headline: `${eventName} was cancelled`,
        detail: `It no longer needs a safety review. Reason: ${reason}.${cancelledAt}`,
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
    return undefined;
  },

  // SCRUM-489 (AC8). Sent to every Safety Officer when a coordinator submits
  // an Approved event; the start date says how soon the check is needed.
  event_submitted_for_safety_review(payload, { eventName }) {
    const coordinatorName = payload.coordinatorName || "its coordinator";
    const startsAt = isInstant(payload.startsAt)
      ? ` It starts ${formatTimestamp(payload.startsAt)}.`
      : "";

    return {
      headline: "Event submitted for safety check",
      detail: `${eventName} was submitted by ${coordinatorName}.${startsAt}`,
    };
  },

  clarification_requested: describeClarification,
  clarification_replied: describeClarification,
  clarification_closed: describeClarification,

  // SCRUM-172 (AC6). Sent to every Lead; submissions wait in the unassigned
  // queue until a Lead picks a coordinator.
  event_request_awaiting_assignment(payload, { eventName }) {
    const submittedAt = isInstant(payload.submittedAt)
      ? `Submitted ${formatTimestamp(payload.submittedAt)}. `
      : "";

    return {
      headline: `${eventName} is waiting for a coordinator`,
      detail: `${submittedAt}Assign it from the unassigned queue.`,
    };
  },

  // SCRUM-172 (AC6). Sent to the new coordinator. 052 sets the previous*
  // fields to null on a first assignment, so a set previousCoordinatorId
  // means a handover.
  event_request_assigned(payload, { eventName }) {
    const assignedByName = payload.assignedByName || "the Lead";
    const reassigned = Boolean(payload.previousCoordinatorId);
    const previous = reassigned
      ? ` It was with ${payload.previousCoordinatorName || PREVIOUS_COORDINATOR}.`
      : "";
    const note = payload.note ? ` Handover note: ${payload.note}` : "";

    return {
      headline: reassigned
        ? `${eventName} was handed over to you`
        : `${eventName} was assigned to you`,
      detail: `Assigned by ${assignedByName}.${previous}${note}`,
    };
  },

  // SCRUM-172 (AC6). Sent to the Organiser. payload.note is never shown: the
  // handover note is for the coordinator only (052, SCRUM-327 D4).
  event_request_coordinator_assigned(payload, { eventName }) {
    const coordinatorName = payload.coordinatorName || "A coordinator";

    if (payload.previousCoordinatorId) {
      const previousName = payload.previousCoordinatorName || PREVIOUS_COORDINATOR;
      return {
        headline: `${eventName} has a new coordinator`,
        detail: `${coordinatorName} has taken over from ${previousName}.`,
      };
    }
    return {
      headline: `${coordinatorName} is now coordinating ${eventName}`,
      detail: "They will review your request and contact you if anything is needed.",
    };
  },

  // SCRUM-172 (AC6). Sent to the Organiser and coordinator after the Safety
  // Officer responds. An unknown outcome still says who responded.
  safety_review_response(payload, { eventName }) {
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
  },

  // SCRUM-172 (AC6). Sent to Venue Staff when a safety check asks for changes
  // or rejects; a flag only, the booking itself is untouched.
  safety_booking_flagged(payload, { eventName, venueName }) {
    return {
      headline: `${needsReview(eventName, venueName)} after the safety check`,
      detail: bookedFor(payload) + "The Safety Officer flagged this booking.",
    };
  },

  // SCRUM-172 (AC6). Sent to Tech Support for the same safety outcomes.
  safety_equipment_review(payload, { eventName }) {
    return {
      headline: `Equipment for ${eventName} needs review after the safety check`,
      detail: "The Safety Officer flagged the equipment arrangements.",
    };
  },
};

/**
 * A notification as a headline and a detail line.
 *
 * @param {Object} notification  as returned by GET /api/notifications
 * @returns {{headline: string, detail: string, needsAction?: true}}
 */
export function describeNotification(notification) {
  const payload = notification?.payload ?? {};
  const type = notification?.type;
  // Own keys only, so a type such as "toString" is not read off the prototype.
  const describe =
    typeof type === "string" && Object.hasOwn(DESCRIBERS, type) ? DESCRIBERS[type] : null;
  const described = describe?.(
    payload,
    {
      eventName: payload.eventName || UNNAMED_EVENT,
      venueName: payload.venueName || UNKNOWN_VENUE,
    },
    type,
  );
  if (described) return described;

  // A type this build does not know (the backend added one). Shown, not
  // hidden: an unread notification that renders as nothing would sit in the
  // unread count with no way to find or clear it.
  return {
    headline: "New notification",
    detail: "This notification type cannot be displayed yet.",
  };
}
