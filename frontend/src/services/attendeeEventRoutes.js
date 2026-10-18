export const REGISTERED_EVENTS_PATH = "/registered-events";
export const ATTENDEE_EVENT_ROUTE = "/registered-events/:eventId";

export function attendeeEventPath(eventId) {
  return `${REGISTERED_EVENTS_PATH}/${encodeURIComponent(eventId)}`;
}
