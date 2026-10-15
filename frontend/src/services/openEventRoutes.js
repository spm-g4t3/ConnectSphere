// Where the Attendee's browse pages live, so the nav, dashboard, routes and
// links cannot drift apart.

export const BROWSE_OPEN_EVENTS_PATH = "/open-events";

/** The route pattern for one event's details, as App.jsx registers it. */
export const OPEN_EVENT_DETAILS_ROUTE = `${BROWSE_OPEN_EVENTS_PATH}/:eventId`;

/** The details page for one open event. */
export function openEventDetailsPath(eventId) {
  return `${BROWSE_OPEN_EVENTS_PATH}/${encodeURIComponent(eventId)}`;
}

/**
 * Browse Open Events ships dark: it needs SCRUM-494's settings and SCRUM-22's
 * registrations in the database, so without them every click would be a 500.
 * Set VITE_OPEN_EVENTS_ENABLED=true (with OPEN_EVENTS_ENABLED=true on the
 * backend) to show the nav link, the dashboard link and the routes. Read on
 * each call, so tests can switch it.
 */
export function isOpenEventsEnabled() {
  return import.meta.env.VITE_OPEN_EVENTS_ENABLED === "true";
}
