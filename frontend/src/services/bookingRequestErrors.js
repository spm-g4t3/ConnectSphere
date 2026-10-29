// bookingRequestErrors.js
//
// SCRUM-254 (part of SCRUM-243). What a failed booking request says to the
// coordinator. Keyed by the 409 `code` first, then by status, then a default,
// the way venueBlockErrors.js does it.
//
// data.error is never read. On this route it is database prose carrying raw
// uuids, which is not something to put in front of a user. The only server text
// shown is a 400's details[].message, and that goes beside its field.

import { codeOf } from "./apiErrors";

const CODE_MESSAGES = {
  EVENT_NOT_BOOKABLE:
    "A venue can only be requested for an approved or confirmed event, including one under or past safety review.",
  EVENT_DATES_MISSING:
    "This event has no proposed start and end, so a venue cannot be requested yet.",
  VENUE_RETIRED: "This venue has been retired and can no longer be requested. Choose another venue.",
  // SCRUM-525 (AC1): one live request per venue per event, not per event, so
  // both refusals are about this venue only and say other venues are still
  // open. "Venue Requests" is the menu label of the page where a request is
  // withdrawn (Navigation.jsx, /my-venue-requests), so the coordinator knows
  // where to go.
  BOOKING_REQUEST_EXISTS:
    "This event already has a pending or approved request for this venue. You can still request other venues; to ask for this one again, withdraw that request first under Venue Requests.",
  BOOKING_FLAGGED_FOR_REVIEW:
    "This event's booking for this venue is flagged for review. Resolve it before requesting this venue again, or choose another venue.",
  // SCRUM-525 (R4): only when the form sent no attendance and the event has
  // none either. The form always sends one, so this is a stale or odd client.
  EVENT_ATTENDANCE_MISSING:
    "This event has no expected attendance saved, so enter one for this venue before requesting it.",
  BOOKING_PERIOD_CONFLICT:
    "This venue is not available for the whole of the event. See what is in the way below, or choose another venue.",
  BOOKING_CHANGED: "This request changed while you were working on it. Please try again.",
  // SCRUM-266: a request sent as the replacement for a flagged booking.
  REPLACED_BOOKING_NOT_FLAGGED:
    "The booking you were replacing is no longer flagged for review; it may already have been resolved. Nothing was requested. Check Flagged bookings above.",
  REPLACED_BOOKING_NOT_ON_EVENT:
    "The booking you were replacing does not belong to this event, so nothing was requested. Stop replacing and try again.",
};

const STATUS_MESSAGES = {
  400: "Some details were not accepted. Please check the form.",
  403: "Only the coordinator assigned to this event can request a venue for it.",
  404: "That event or venue no longer exists.",
  503: "Venue suitability checking is not available yet, so a venue cannot be requested right now.",
};

const DEFAULT_MESSAGE = "Could not submit the request. Please try again.";

// SCRUM-188: a 400 naming the requirement codes means the server did not
// recognise one of the layout, accessibility or facility codes the request
// carried (or the criteria it acknowledged). They come from the search form,
// so that is where to fix them.
const REQUIREMENT_FIELDS = new Set(["accessibility", "facilities", "roomLayoutCode", "acknowledgedCriteria"]);
const REQUIREMENTS_MESSAGE =
  "The selected requirements were not recognised. Adjust the layout, accessibility features or facilities in the search form, then try again.";

// SCRUM-525 (AC2): the attendance is typed on the request form itself, not in
// the search form, so a 400 naming it gets its own message pointing there. It
// is checked first, and kept out of REQUIREMENT_FIELDS, so a refused number is
// never blamed on the search form.
const ATTENDANCE_FIELDS = new Set(["expectedAttendance"]);
const ATTENDANCE_MESSAGE =
  "The expected attendance for this venue was not accepted. Enter a whole number of 1 or more.";

/** Does a 400's details[] name any of these fields? */
function namesField(err, fields) {
  if (err?.response?.status !== 400) return false;
  const details = err.response.data?.details;
  return Array.isArray(details) && details.some((d) => fields.has(d?.field));
}

/**
 * The 409 codes meaning this event already has a live request or booking for
 * the venue just asked for. SCRUM-525: per venue, so they lock that venue
 * only, never the event.
 */
const VENUE_ALREADY_REQUESTED_CODES = new Set([
  "BOOKING_REQUEST_EXISTS",
  "BOOKING_FLAGGED_FOR_REVIEW",
]);

const SUITABILITY_CODE = "SUITABILITY_CONFIRMATION_REQUIRED";

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
  if (namesField(err, ATTENDANCE_FIELDS)) return ATTENDANCE_MESSAGE;
  if (namesField(err, REQUIREMENT_FIELDS)) return REQUIREMENTS_MESSAGE;

  const status = err?.response?.status;
  if (Object.hasOwn(STATUS_MESSAGES, status)) return STATUS_MESSAGES[status];

  return DEFAULT_MESSAGE;
}

const REPLACEMENT_CODES = new Set(["REPLACED_BOOKING_NOT_FLAGGED", "REPLACED_BOOKING_NOT_ON_EVENT"]);

/**
 * SCRUM-266: was a replacement refused because the flagged booking it named
 * is no longer one this event can replace? The caller stops replacing it.
 */
export function isReplacementRefused(err) {
  return err?.response?.status === 409 && REPLACEMENT_CODES.has(codeOf(err));
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

/** The kinds a BOOKING_PERIOD_CONFLICT can list. 'hold' is SCRUM-491's (AC5). */
const PERIOD_CONFLICT_KINDS = new Set(["block", "booking", "hold"]);

/**
 * What is in the way of the period, from a BOOKING_PERIOD_CONFLICT answer:
 * venue blocks, approved bookings and (SCRUM-491, AC5) another event's active
 * tentative hold, as { kind, ... }. The event's own hold never appears: the
 * backend leaves it out.
 */
export function periodConflicts(err) {
  if (codeOf(err) !== "BOOKING_PERIOD_CONFLICT") return [];
  return conflictsOf(err).filter((c) => PERIOD_CONFLICT_KINDS.has(c?.kind));
}

/**
 * Does the answer mean this event already has a pending, approved or flagged
 * booking for the venue just asked for (SCRUM-525: that venue, not the event)?
 */
export function isVenueAlreadyRequested(err) {
  return err?.response?.status === 409 && VENUE_ALREADY_REQUESTED_CODES.has(codeOf(err));
}

// Re-exported because BookingRequestPanel and this module's tests read it from here.
export { fieldErrorsFrom } from "./apiErrors";

// SCRUM-255: withdrawing, from the list. Same shape as above, with a note on
// each message that the list has been refreshed where the answer means the
// coordinator's copy of the request was out of date.
const WITHDRAW_CODE_MESSAGES = {
  BOOKING_NOT_PENDING:
    "This request is no longer pending, so it can't be withdrawn. The list has been refreshed.",
  BOOKING_CHANGED: "This request changed while you were working on it. The list has been refreshed.",
};

const WITHDRAW_STATUS_MESSAGES = {
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

// SCRUM-492: releasing an approved booking from the event screen. Every 409
// means the list on screen is out of date, so the caller refetches.
const RELEASE_CODE_MESSAGES = {
  EVENT_NOT_APPROVED: "Venues can be released only while the event is Approved.",
  BOOKING_NOT_APPROVED: "This booking is no longer approved. The list has been refreshed.",
  BOOKING_CHANGED: "This booking changed while you were releasing it. The list has been refreshed.",
};

const RELEASE_STATUS_MESSAGES = {
  400: "Give a reason of up to 1,000 characters.",
  403: "Only the coordinator assigned to this event can release its venues.",
  404: "This booking no longer exists.",
};

const RELEASE_DEFAULT_MESSAGE = "The venue could not be released. Please try again.";

/**
 * The message for a failed release: by the 409's code, then by status.
 *
 * @param {unknown} err  what releaseVenueBooking threw
 * @returns {string}
 */
export function releaseErrorMessage(err) {
  const status = err?.response?.status;
  const code = codeOf(err);
  if (status === 409 && code && Object.hasOwn(RELEASE_CODE_MESSAGES, code)) return RELEASE_CODE_MESSAGES[code];
  if (Object.hasOwn(RELEASE_STATUS_MESSAGES, status)) return RELEASE_STATUS_MESSAGES[status];
  return RELEASE_DEFAULT_MESSAGE;
}
// SCRUM-258: Venue Staff approving or rejecting from the pending queue. The
// server re-checks everything under its locks (AC2), so each refusal says why
// in the reader's terms; the ones meaning the queue was out of date also say
// it has been refreshed.
const DECISION_CODE_MESSAGES = {
  BOOKING_NOT_PENDING:
    "This request has already been decided or withdrawn. The list has been refreshed.",
  BOOKING_CHANGED:
    "This request changed while you were deciding. The list has been refreshed; please try again.",
  BOOKING_PERIOD_STALE:
    "The event's dates have changed since this request was made, so it can't be approved. The coordinator needs to request the venue again for the new dates.",
  EVENT_NOT_BOOKABLE:
    "This event is no longer approved, in the safety check, or confirmed (it may have been cancelled), so its venue request can't be approved.",
  VENUE_RETIRED: "This venue has been retired, so the request can't be approved.",
};

const DECISION_STATUS_MESSAGES = {
  400: "The decision was not accepted. A reason is required, and each text must be at most 1000 characters.",
  403: "Only Venue Staff can approve or reject booking requests.",
  404: "That request no longer exists. The list has been refreshed.",
};

const DECISION_DEFAULT_MESSAGE = "Could not record the decision. Please try again.";

/**
 * One thing in the way of an approval, named for Venue Staff. The flagged
 * screens reuse it with their own word for a booking and add the block reason.
 *
 * @param {Object} conflict          one entry from periodConflicts
 * @param {string} [bookingNoun]     what a 'booking' conflict is called
 * @returns {string}
 */
export function occupantText(conflict, bookingNoun = "approved booking") {
  const eventName = conflict.eventName || "another event";
  if (conflict.kind === "block") return "a venue block";
  if (conflict.kind === "hold") return `a tentative hold for ${eventName}`;
  return `the ${bookingNoun} for ${eventName}`;
}

/**
 * The " In the way: a, b." tail of a period-conflict message, each occupant
 * named once; empty when the answer listed none. describe gets only the
 * conflict, so occupantText's second argument is never a map index.
 *
 * @param {Object[]} conflicts         from periodConflicts
 * @param {(conflict: Object) => string} describe
 * @returns {string}
 */
export function inTheWayText(conflicts, describe) {
  const occupants = [...new Set(conflicts.map((c) => describe(c)))];
  return occupants.length > 0 ? ` In the way: ${occupants.join(", ")}.` : "";
}

/**
 * The message for a failed approve or reject. A BOOKING_PERIOD_CONFLICT names
 * what now occupies the venue, from periodConflicts.
 *
 * @param {unknown} err  what approveBookingRequest or rejectBookingRequest threw
 * @returns {string}
 */
export function decisionErrorMessage(err) {
  const code = codeOf(err);
  if (code === "BOOKING_PERIOD_CONFLICT") {
    const inTheWay = inTheWayText(periodConflicts(err), occupantText);
    return `The venue is no longer free for this request's period, setup and turnaround included, so it can't be approved.${inTheWay}`;
  }
  if (code && Object.hasOwn(DECISION_CODE_MESSAGES, code)) return DECISION_CODE_MESSAGES[code];

  const status = err?.response?.status;
  if (Object.hasOwn(DECISION_STATUS_MESSAGES, status)) return DECISION_STATUS_MESSAGES[status];

  return DECISION_DEFAULT_MESSAGE;
}

/**
 * Whether a failed decision means the queue on screen is out of date, so the
 * caller should refetch: the request is gone (404), already decided or
 * withdrawn, or changed under the call.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isStaleDecisionError(err) {
  const code = codeOf(err);
  return err?.response?.status === 404 || code === "BOOKING_NOT_PENDING" || code === "BOOKING_CHANGED";
}
