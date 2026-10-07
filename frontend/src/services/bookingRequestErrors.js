// bookingRequestErrors.js
//
// SCRUM-254 (part of SCRUM-243). What a failed booking request says to the
// coordinator. Keyed by the 409 `code` first, then by status, then a default,
// the way venueBlockErrors.js does it.
//
// data.error is never read. On this route it is database prose carrying raw
// uuids, which is not something to put in front of a user. The only server text
// shown is a 400's details[].message, and that goes beside its field.

const CODE_MESSAGES = {
  EVENT_NOT_BOOKABLE: "A venue can only be requested for an approved or confirmed event.",
  EVENT_DATES_MISSING:
    "This event has no proposed start and end, so a venue cannot be requested yet.",
  VENUE_RETIRED: "This venue has been retired and can no longer be requested. Choose another venue.",
  BOOKING_REQUEST_EXISTS:
    "This event already has a pending or approved venue request, and only one is allowed at a time. Withdraw the pending request first if you want a different venue.",
  BOOKING_FLAGGED_FOR_REVIEW:
    "A booking for this event is flagged for review. Resolve it before requesting another venue.",
  BOOKING_PERIOD_CONFLICT:
    "This venue is not available for the whole of the event. See what is in the way below, or choose another venue.",
  BOOKING_CHANGED: "This request changed while you were working on it. Please try again.",
};

const STATUS_MESSAGES = {
  400: "Some details were not accepted. Please check the form.",
  401: "Your session has expired. Please sign in again.",
  403: "Only the coordinator assigned to this event can request a venue for it.",
  404: "That event or venue no longer exists.",
  503: "Venue suitability checking is not available yet, so a venue cannot be requested right now.",
};

const DEFAULT_MESSAGE = "Could not submit the request. Please try again.";

/** The 409 codes meaning the event already has a live request or booking. */
const EVENT_ALREADY_REQUESTED_CODES = new Set([
  "BOOKING_REQUEST_EXISTS",
  "BOOKING_FLAGGED_FOR_REVIEW",
]);

const SUITABILITY_CODE = "SUITABILITY_CONFIRMATION_REQUIRED";

function codeOf(err) {
  return err?.response?.data?.code ?? null;
}

function conflictsOf(err) {
  const conflicts = err?.response?.data?.conflicts;
  return Array.isArray(conflicts) ? conflicts : [];
}

/**
 * The message for a failed request, for a code this build knows or a status.
 *
 * @param {unknown} err  what createBookingRequest threw
 * @returns {string}
 */
export function bookingRequestErrorMessage(err) {
  const code = codeOf(err);
  if (code && Object.hasOwn(CODE_MESSAGES, code)) return CODE_MESSAGES[code];

  const status = err?.response?.status;
  if (Object.hasOwn(STATUS_MESSAGES, status)) return STATUS_MESSAGES[status];

  return DEFAULT_MESSAGE;
}

/** Did the server ask for an explicit confirmation of an unsuitable venue? */
export function isSuitabilityConfirmationRequired(err) {
  return err?.response?.status === 409 && codeOf(err) === SUITABILITY_CODE;
}

/**
 * The criteria not met, from a SUITABILITY_CONFIRMATION_REQUIRED answer.
 *
 * @returns {Array<{criterion: string, met: boolean, detail?: string}>}
 */
export function unmetCriteria(err) {
  return conflictsOf(err).filter((criterion) => criterion && typeof criterion === "object");
}

/**
 * What is in the way of the period, from a BOOKING_PERIOD_CONFLICT answer:
 * venue blocks and approved bookings, as { kind, ... }.
 */
export function periodConflicts(err) {
  if (codeOf(err) !== "BOOKING_PERIOD_CONFLICT") return [];
  return conflictsOf(err).filter((c) => c?.kind === "block" || c?.kind === "booking");
}

/** Does the answer mean this event already has a pending, approved or flagged booking? */
export function isEventAlreadyRequested(err) {
  return err?.response?.status === 409 && EVENT_ALREADY_REQUESTED_CODES.has(codeOf(err));
}

/** A 400's details[], for the fields this form has. */
export function fieldErrorsFrom(err, fields) {
  const details = err?.response?.status === 400 ? err.response.data?.details : null;
  return Array.isArray(details) ? details.filter((d) => fields.includes(d?.field)) : [];
}

// SCRUM-255: withdrawing, from the list. Same shape as above, with a note on
// each message that the list has been refreshed where the answer means the
// coordinator's copy of the request was out of date.
const WITHDRAW_CODE_MESSAGES = {
  BOOKING_NOT_PENDING:
    "This request is no longer pending, so it can't be withdrawn. The list has been refreshed.",
  BOOKING_CHANGED: "This request changed while you were working on it. The list has been refreshed.",
};

const WITHDRAW_STATUS_MESSAGES = {
  401: "Your session has expired. Please sign in again.",
  403: "Only the coordinator assigned to this event can withdraw its venue requests. The list has been refreshed.",
  404: "That request no longer exists. The list has been refreshed.",
};

const WITHDRAW_DEFAULT_MESSAGE = "Could not withdraw the request. Please try again.";

/**
 * The message for a failed withdrawal.
 *
 * @param {unknown} err  what withdrawBookingRequest threw
 * @returns {string}
 */
export function withdrawErrorMessage(err) {
  const code = codeOf(err);
  if (code && Object.hasOwn(WITHDRAW_CODE_MESSAGES, code)) return WITHDRAW_CODE_MESSAGES[code];

  const status = err?.response?.status;
  if (status === 409) return WITHDRAW_CODE_MESSAGES.BOOKING_CHANGED;
  if (Object.hasOwn(WITHDRAW_STATUS_MESSAGES, status)) return WITHDRAW_STATUS_MESSAGES[status];

  return WITHDRAW_DEFAULT_MESSAGE;
}

/**
 * Whether a failed withdrawal means the list on screen is out of date, so the
 * caller should refetch: the request is gone (404), is no longer this
 * coordinator's (403) or has changed (any 409).
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isStaleWithdrawError(err) {
  const status = err?.response?.status;
  return status === 403 || status === 404 || status === 409;
}