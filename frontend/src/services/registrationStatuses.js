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
