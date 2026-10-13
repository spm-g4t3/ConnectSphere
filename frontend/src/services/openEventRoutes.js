// openEventRoutes.js
//
// SCRUM-495. Where the Attendee's browse pages live, in one place so the nav,
// the dashboard, the route table and the list's links cannot drift apart.

export const BROWSE_OPEN_EVENTS_PATH = "/open-events";

/** The route pattern for one event's details, as App.jsx registers it. */
export const OPEN_EVENT_DETAILS_ROUTE = `${BROWSE_OPEN_EVENTS_PATH}/:eventId`;

/** The details page for one open event. */
export function openEventDetailsPath(eventId) {
  return `${BROWSE_OPEN_EVENTS_PATH}/${encodeURIComponent(eventId)}`;
}