import { apiClient } from "./apiClient";

export async function getRegisteredEvents() {
  const response = await apiClient.get("/attendee-events");
  return response.data;
}

export async function getAttendeeEvent(eventId) {
  const response = await apiClient.get(`/attendee-events/${encodeURIComponent(eventId)}`);
  return response.data;
}
