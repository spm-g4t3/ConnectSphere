import { getData, putData } from "./apiData";

export async function getRegistrationSettings(eventId) {
  return getData(`/registration/events/${eventId}/settings`);
}

export async function saveRegistrationSettings(eventId, settings) {
  return putData(`/registration/events/${eventId}/settings`, settings);
}

export async function getEventRegistrations(eventId, { hideWithdrawn = false } = {}) {
  return getData(`/registration/events/${encodeURIComponent(eventId)}/registrations`, {
    params: hideWithdrawn ? { hideWithdrawn: true } : undefined,
  });
}

/** Registered and waiting-list totals, for the Organiser or the assigned Coordinator. */
export async function getRegistrationCounts(eventId) {
  return getData(`/registration/events/${eventId}/counts`);
}
