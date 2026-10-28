import { postData } from "./apiData";

/** The backend derives the attendee from the token and checks registration atomically. */
export async function registerForEvent(eventId) {
  return postData(`/open-events/${encodeURIComponent(eventId)}/registrations`);
}

/** Joins a full event's waiting list; the backend checks it is still full. */
export async function joinWaitlist(eventId) {
  return postData(`/open-events/${encodeURIComponent(eventId)}/waitlist`);
}
