// notificationLink.js
//
// SCRUM-172 (AC7): where selecting a notification takes its reader. Each role
// lands on a page it already has and is authorised for; no new pages.

import { normaliseRole } from "../auth/normaliseRole";
import { attendeeEventPath, REGISTERED_EVENTS_PATH } from "./attendeeEventRoutes";

const eventRequestPage = (id) => ({ to: `/event-requests/${id}` });

const ORGANISER_REGISTRATION_TYPES = new Set([
  "registration_schedule_conflict",
  "registration_opened",
  "registration_closed",
  "registration_capacity_reached",
  "registration_place_released",
]);

// SCRUM-177: the notices a waiting attendee is sent about their queue.
const ATTENDEE_QUEUE_TYPES = new Set(["registration_opened", "registration_closed"]);

const VENUE_STAFF_PAGES = {
  booking_request_submitted: { to: "/booking-requests" },
  safety_booking_flagged: { to: "/flagged-bookings" },
  booking_flagged_event_change: { to: "/flagged-bookings" },
  booking_request_event_change: { to: "/booking-requests" },
};

// What opens the equipment review: the safety flag (SCRUM-172) and the
// equipment notifications (SCRUM-176) Technical Support is sent about a live
// request. A cancelled one is left out.
const TECH_SUPPORT_REVIEW_TYPES = new Set([
  "safety_equipment_review",
  "equipment_requested",
  "equipment_request_changed",
]);

const ATTENDEE_EVENT_PAGE_TYPES = new Set([
  "registration_promoted",
  "event_confirmed",
  "event_venue_changed",
]);

// One entry per role, so a later story adds a line rather than a branch.
const LINKS_BY_ROLE = {
  // The review page lets any coordinator or Lead read any submitted event;
  // an unassigned one opens read-only.
  EVENT_COORDINATOR: (_type, id) => eventRequestPage(id),
  EVENT_COORDINATOR_LEAD: (_type, id) => eventRequestPage(id),

  // The organiser's only event page is their own list; router state picks
  // the row, as the dashboard's clarification shortcut already does.
  EVENT_ORGANISER: (type, id) => {
    if (type === "clarification_requested") {
      return { to: "/events", state: { openClarificationRequestId: id } };
    }
    // The clashing dates are fixed, and the window and counts shown, on the
    // event's registration settings page.
    if (ORGANISER_REGISTRATION_TYPES.has(type)) return { to: `/events/${id}/registration` };
    return { to: "/events", state: { focusEventRequestId: id } };
  },

  // A cancelled event's review has nothing left to act on, and neither has a
  // cancelled equipment request.
  TECHNICAL_SUPPORT_STAFF: (type, id) =>
    TECH_SUPPORT_REVIEW_TYPES.has(type) ? { to: `/equipment-review/${id}` } : null,

  // A new request is decided in their queue and a safety flag on their flagged
  // bookings list. A withdrawn request has nothing left to decide, so no link.
  VENUE_STAFF: (type) => VENUE_STAFF_PAGES[type] ?? null,
  // No safety review page yet (SCRUM-490).
  SAFETY_OFFICER: () => null,
  // These open the event's registered-attendee page. A cancellation opens
  // nothing: that page only shows a confirmed event. That page is for
  // registered attendees only, so a queue notice opens the list of their places.
  ATTENDEE: (type, id) => {
    if (ATTENDEE_EVENT_PAGE_TYPES.has(type)) return { to: attendeeEventPath(id) };
    return ATTENDEE_QUEUE_TYPES.has(type) ? { to: REGISTERED_EVENTS_PATH } : null;
  },
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
