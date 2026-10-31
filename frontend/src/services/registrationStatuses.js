// Mirrors backend/src/domain/registrationStatuses.js; a backend test keeps them equal.
export const REGISTRATION_CONFIGURABLE_STATUSES = Object.freeze([
  "approved",
  "safety_review",
  "safety_approved",
  "confirmed",
]);

export function isRegistrationConfigurable(status) {
  return REGISTRATION_CONFIGURABLE_STATUSES.includes(status);
}

// Where a registration list may exist, for showing the link only. The server
// decides: an Approved event has one only after a significant change.
export const REGISTRATION_LIST_STATUSES = Object.freeze([
  "approved",
  "confirmed",
  "completed",
  "cancelled",
]);

export function mayHaveRegistrationList(status) {
  return REGISTRATION_LIST_STATUSES.includes(status);
}
