import { apiClient } from "./apiClient";

export async function getRegistrationSettings(eventId) {
  const response = await apiClient.get(`/registration/events/${eventId}/settings`);
  return response.data;
}

export async function saveRegistrationSettings(eventId, settings) {
  const response = await apiClient.put(`/registration/events/${eventId}/settings`, settings);
  return response.data;
}
