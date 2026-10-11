// openEventRoutes.js
//
// SCRUM-495. Where the Attendee's browse pages live, in one place so the nav,
// the dashboard, the route table and the list's links cannot drift apart.

export const BROWSE_OPEN_EVENTS_PATH = "/open-events";

/**
 * The details page for one open event.
 *
 * Not registered in App.jsx yet: the details page is a later SCRUM-495
 * subtask, so until then following one of these links reaches the catch-all
 * and lands on /dashboard.
 */
export function openEventDetailsPath(eventId) {
  return `${BROWSE_OPEN_EVENTS_PATH}/${encodeURIComponent(eventId)}`;
}
