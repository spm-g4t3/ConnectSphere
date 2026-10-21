import { postData } from "./apiData";

/** The backend derives the attendee from the token and checks registration atomically. */
export async function registerForEvent(eventId) {
  return postData(`/open-events/${encodeURIComponent(eventId)}/registrations`);
}
