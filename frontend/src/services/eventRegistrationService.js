import { getData, putData } from "./apiData";

export async function getRegistrationSettings(eventId) {
  return getData(`/registration/events/${eventId}/settings`);
}

export async function saveRegistrationSettings(eventId, settings) {
  return putData(`/registration/events/${eventId}/settings`, settings);
}
