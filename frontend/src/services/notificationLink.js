// notificationLink.js
//
// SCRUM-172 (AC7): where selecting a notification takes its reader. Each role
// lands on a page it already has and is authorised for; no new pages.

import { normaliseRole } from "../auth/normaliseRole";

const eventRequestPage = (id) => ({ to: `/event-requests/${id}` });

// One entry per role, so a later story adds a line rather than a branch.
const LINKS_BY_ROLE = {
  // The review page lets any coordinator or Lead read any submitted event;
  // an unassigned one opens read-only.
  EVENT_COORDINATOR: (_type, id) => eventRequestPage(id),
  EVENT_COORDINATOR_LEAD: (_type, id) => eventRequestPage(id),

  // The organiser's only event page is their own list; router state picks
  // the row, as the dashboard's clarification shortcut already does.
  EVENT_ORGANISER: (type, id) =>
    type === "clarification_requested"
      ? { to: "/events", state: { openClarificationRequestId: id } }
      : { to: "/events", state: { focusEventRequestId: id } },

  // A cancelled event's review has nothing left to act on.
  TECHNICAL_SUPPORT_STAFF: (type, id) =>
    type === "safety_equipment_review" ? { to: `/equipment-review/${id}` } : null,

  // Their only page is the pending queue, and none of their current types is
  // about a pending request; SCRUM-174's "new request" notice will link there.
  VENUE_STAFF: () => null,
  // No safety review page yet (SCRUM-490).
  SAFETY_OFFICER: () => null,
  // No attendee event page yet (SCRUM-495).
  ATTENDEE: () => null,
};

/**
 * The page a notification opens for this role, or null when it opens none.
 *
 * @param {{ type: string, eventRequestId?: string|null }} notification
 * @param {*} role  the signed-in user's role, however it is spelled
 * @returns {{ to: string, state?: object } | null}
 */
export function notificationLink(notification, role) {
  const id = notification.eventRequestId;
  if (!id) return null;
  const linkFor = LINKS_BY_ROLE[normaliseRole(role)];
  return linkFor ? linkFor(notification.type, id) : null;
}
