import { getData } from "./apiData";

export async function getRegisteredEvents() {
  return getData("/attendee-events");
}

export async function getAttendeeEvent(eventId) {
  return getData(`/attendee-events/${encodeURIComponent(eventId)}`);
}
