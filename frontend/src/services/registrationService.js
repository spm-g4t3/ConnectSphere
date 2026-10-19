import { apiClient } from "./apiClient";

/** The backend derives the attendee from the token and checks registration atomically. */
export async function registerForEvent(eventId) {
  const response = await apiClient.post(`/open-events/${encodeURIComponent(eventId)}/registrations`);
  return response.data;
}
