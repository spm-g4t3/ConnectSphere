// bookingRequestEligibility.js
//
// SCRUM-254 (part of SCRUM-243). Whether the signed-in coordinator can request
// a venue for the event on screen, from what the screen already holds.
//
// A convenience, not the gate: it saves a coordinator a button that can only be
// refused, the way CoordinatorRequestDetail's canReassign does. The backend
// checks all of it again under a lock (create_booking_request, migration 030)
// and a refusal there is shown by bookingRequestErrors.js.
//
// What it does not judge: whether a venue already has a pending, approved or
// review-flagged booking for this event. Since SCRUM-525 that is a per-venue
// question, not an eligibility one: EventVenueFinder and VenueSearch lock
// those venues themselves, and the server's BOOKING_REQUEST_EXISTS and
// BOOKING_FLAGGED_FOR_REVIEW answers remain the gate.

/** The event statuses a venue can be requested for (SCRUM-243 AC1). */
export const BOOKABLE_EVENT_STATUSES = Object.freeze(["approved", "confirmed"]);

function statusLabel(status) {
  return typeof status === "string" && status ? status.replaceAll("_", " ") : "unknown";
}

/**
 * @param {Object|null|undefined} event  the event's id, status,
 *        assignedCoordinatorId, proposedStart and proposedEnd
 * @param {string|undefined} userId      the signed-in user
 * @returns {{eligible: boolean, reason: string|null}} reason is the sentence to
 *          show a coordinator who cannot request, or null
 */
export function bookingRequestEligibility(event, userId) {
  if (!event?.id) {
    return { eligible: false, reason: "Open venue search from an event to request a venue for it." };
  }

  if (!userId || event.assignedCoordinatorId !== userId) {
    return {
      eligible: false,
      reason: "Only the coordinator assigned to this event can request a venue for it.",
    };
  }

  if (!BOOKABLE_EVENT_STATUSES.includes(event.status)) {
    return {
      eligible: false,
      reason: `A venue can only be requested for an approved or confirmed event. This event is ${statusLabel(event.status)}.`,
    };
  }

  if (!event.proposedStart || !event.proposedEnd) {
    return {
      eligible: false,
      reason: "This event has no proposed start and end yet, so a venue cannot be requested.",
    };
  }

  return { eligible: true, reason: null };
}
