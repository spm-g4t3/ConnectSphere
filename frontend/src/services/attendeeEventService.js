import { getData, postData } from "./apiData";

export async function getRegisteredEvents() {
  return getData("/attendee-events");
}

export async function getAttendeeEvent(eventId) {
  return getData(`/attendee-events/${encodeURIComponent(eventId)}`);
}

/** The backend takes the attendee from the token and decides eligibility itself. */
export async function withdrawRegistration(registrationId) {
  return postData(`/attendee-events/registrations/${encodeURIComponent(registrationId)}/withdrawal`);
}
