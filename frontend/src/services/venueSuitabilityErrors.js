// venueSuitabilityErrors.js
//
// SCRUM-191 (part of SCRUM-188). What a failed suitability check says to the
// coordinator. Keyed by the 409 `code` first, then by status, then a default,
// the way bookingRequestErrors.js does it.
//
// data.error is never read: it can carry database prose and raw uuids, which
// are not for a user. A venue that is not suitable is not an error at all; it
// comes back as a 200 and VenueSuitabilityResult shows it.

const CODE_MESSAGES = {
  EVENT_DATES_MISSING:
    "This event has no proposed start and end, so no venue can be checked against it yet.",
  VENUE_RETIRED: "This venue has been retired, so it cannot be checked or requested. Choose another venue.",
};

const STATUS_MESSAGES = {
  400: "This venue could not be checked with these requirements. Check the layout, accessibility features and facilities, then try again.",
  401: "Your session has expired. Please sign in again.",
  403: "Only the coordinator assigned to this event can check a venue for it.",
  404: "That event or venue no longer exists.",
};

const DEFAULT_MESSAGE = "Could not check this venue. Please try again.";

/**
 * The message for a failed check, for a code this build knows or a status.
 *
 * @param {unknown} err  what checkVenueSuitability threw
 * @returns {string}
 */
export function suitabilityErrorMessage(err) {
  const code = err?.response?.data?.code ?? null;
  if (code && Object.hasOwn(CODE_MESSAGES, code)) return CODE_MESSAGES[code];

  const status = err?.response?.status;
  if (Object.hasOwn(STATUS_MESSAGES, status)) return STATUS_MESSAGES[status];

  return DEFAULT_MESSAGE;
}
