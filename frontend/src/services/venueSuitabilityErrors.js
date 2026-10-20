// venueSuitabilityErrors.js
//
// SCRUM-191 (part of SCRUM-188). What a failed suitability check says to the
// coordinator. Keyed by the 409 `code` first, then by status, then a default,
// the way bookingRequestErrors.js does it.
//
// data.error is never read: it can carry database prose and raw uuids, which
// are not for a user. A venue that is not suitable is not an error at all; it
// comes back as a 200 and VenueSuitabilityResult shows it.

import { SESSION_EXPIRED } from "./apiErrors";

const CODE_MESSAGES = {
  EVENT_DATES_MISSING:
    "This event has no proposed start and end, so no venue can be checked against it yet.",
  VENUE_RETIRED: "This venue has been retired, so it cannot be checked or requested. Choose another venue.",
  // SCRUM-188: the event has no expected attendance, so Capacity has nothing
  // to be judged against. SCRUM-525: only this check is stuck, not the venue:
  // a request carries its own attendance, entered on the request form, so the
  // message says the venue can still be requested.
  EVENT_ATTENDANCE_MISSING:
    "This event has no expected attendance yet, so capacity can't be checked here. You can still request the venue and enter an attendance for it.",
};

const STATUS_MESSAGES = {
  400: "This venue could not be checked with these requirements. Check the layout, accessibility features and facilities, then try again.",
  401: SESSION_EXPIRED,
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

// SCRUM-188 (AC6). The event's recheck sends no requirement codes, so a 400
// there is not the coordinator's layout or features to fix: it gets its own
// message. Everything else reads as for a single check.
const RECHECK_STATUS_MESSAGES = {
  400: "This event's venues could not be rechecked. Please try again.",
};

/**
 * The message for a failed recheck of the event's venues
 * (getEventVenueSuitability).
 *
 * @param {unknown} err
 * @returns {string}
 */
export function recheckErrorMessage(err) {
  // EVENT_ATTENDANCE_MISSING is unreachable here since SCRUM-525 (R12): the
  // recheck no longer refuses the whole list for an event without attendance,
  // it marks each booking that has none (EventVenueSuitability's item
  // errors). The shared mapping is kept as a defensive fallback.
  const code = err?.response?.data?.code ?? null;
  if (code && Object.hasOwn(CODE_MESSAGES, code)) return CODE_MESSAGES[code];

  const status = err?.response?.status;
  if (Object.hasOwn(RECHECK_STATUS_MESSAGES, status)) return RECHECK_STATUS_MESSAGES[status];

  return suitabilityErrorMessage(err);
}
