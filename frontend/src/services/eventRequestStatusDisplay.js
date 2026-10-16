// eventRequestStatusDisplay.js
//
// SCRUM-42. This file used to hold a hand-copied duplicate of the backend's
// STATUS_DISPLAY table, with a note admitting that it had to be kept in sync by
// hand. It no longer does: the API now sends the Organiser-facing view of a
// status as `statusDisplay` on every request, produced by
// backend/src/domain/eventRequestStatus.js, so the labels and descriptions have
// exactly one definition.
//
// Two things are left here, because they are genuinely the frontend's:
// the CSS class for a status group, and what to show if no statusDisplay
// arrived at all.

// Keyed on the group rather than the status, on purpose. Groups are the stable
// half of the contract -- when the backend adds a status it maps into an
// existing group, and this file needs no edit. Only a new *group* does.
const CLASS_BY_GROUP = {
  DRAFT: "status--draft",
  AWAITING_REVIEW: "status--awaiting-review",
  UNDER_REVIEW: "status--under-review",
  ACTION_REQUIRED: "status--action-required",
  APPROVED: "status--approved",
  CONFIRMED: "status--confirmed",
  COMPLETED: "status--completed",
  REJECTED: "status--rejected",
  CANCELLED: "status--cancelled",

  // SCRUM-47's two fallbacks are styled too. A fallback the UI cannot style
  // renders as an unstyled gap, which is the thing SCRUM-47 exists to avoid.
  UNAVAILABLE: "status--unavailable",
  UNKNOWN: "status--unknown",
};

/** Statuses the assigned coordinator can cancel from; mirrors the transition table in 063. */
export const CANCELLABLE_STATUSES = new Set([
  "submitted",
  "under_review",
  "pending_clarification",
  "approved",
  "safety_review",
  "safety_approved",
  "confirmed",
]);

/**
 * The CSS class for a status group.
 *
 * @param {string} group  from statusDisplay.group
 * @returns {string}
 */
export function statusClassName(group) {
  return CLASS_BY_GROUP[group] ?? CLASS_BY_GROUP.UNKNOWN;
}

/**
 * The last-resort display, for when no statusDisplay reached us at all.
 *
 * UNAVAILABLE and not UNKNOWN, and the distinction is SCRUM-47's whole point:
 * nothing usable arrived, so refreshing may genuinely fix it. UNKNOWN means a
 * value did arrive that this build does not recognise, which a refresh will not
 * help with -- and only the server can tell us that, because only the server
 * knows the vocabulary. So the client never produces UNKNOWN on its own.
 *
 * Wording matches STATUS_FALLBACK.UNAVAILABLE in the backend domain module.
 */
const UNAVAILABLE = Object.freeze({
  status: null,
  label: "Status Unavailable",
  group: "UNAVAILABLE",
  description:
    "We could not read the status of this request. Please refresh the page, " +
    "and contact your Event Coordinator if it keeps happening.",
});

/**
 * The status display for a request, however it arrived.
 *
 * Never returns undefined, for the same reason getStatusDisplay on the backend
 * never does: a screen showing nothing at all meets "the Organiser can view the
 * status" worse than a screen saying the status could not be read.
 *
 * @param {object} request  an event request from the API
 * @returns {{status: string|null, label: string, group: string, description: string}}
 */
export function readStatusDisplay(request) {
  return request?.statusDisplay ?? UNAVAILABLE;
}
