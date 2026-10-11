// venueHoldErrors.js
//
// SCRUM-491. What a failed hold request says to the Venue Staff member, for
// each of the three hold calls in venueService.
//
// Keyed by the 409 `code` first, then by status, then a default per action,
// the way venueBlockErrors.js does it.
//
// data.error is never read. On these routes it is database prose that can
// carry raw uuids, which is not something to put in front of a user. The only
// server text the UI shows is details[].message from a 400, and that goes to
// the form, not through here.

const CODE_MESSAGES = {
  EVENT_NOT_APPROVED:
    "Only an Approved event can hold a venue, and this event is no longer Approved. The event list has been refreshed.",
  EVENT_DATES_MISSING:
    "This event has no proposed start and end, so there is no period to hold.",
  VENUE_RETIRED: "This venue has been retired, so it can no longer be held.",
  HOLD_EXISTS:
    "This event already holds this venue. An event can have only one active hold at each venue.",
  HOLD_PERIOD_CONFLICT:
    "This venue is not free for the whole of the event. See what is in the way below.",
};

const STATUS_MESSAGES = {
  400: "Some details were not accepted. Please check the form.",
  401: "Your session has expired. Please sign in again.",
  // AC1: refused, with the reason.
  403: "Only Venue Staff can place a tentative hold on a venue.",
};

// A 404 on the list can only be the venue; on a place it is the venue or the
// event, which may have been removed since the picker loaded.
const NOT_FOUND_MESSAGES = {
  list: "That venue no longer exists.",
  place: "That venue or event no longer exists. The event list has been refreshed.",
};

const DEFAULT_MESSAGES = {
  list: "Could not load this venue's holds. Please try again.",
  candidates: "Could not load the Approved events. Please try again.",
  place: "Could not place the hold. Please try again.",
};

const UNKNOWN_CONFLICT_MESSAGE =
  "Something changed while you were placing this hold. Please try again.";

/** The kinds of thing that can be in the way of a hold (AC4). */
const CONFLICT_KINDS = new Set(["booking", "block", "hold"]);

function codeOf(err) {
  return err?.response?.data?.code ?? null;
}

/**
 * The message for a failed hold request.
 *
 * @param {unknown} err  what the venueService call threw
 * @param {"list"|"candidates"|"place"} action
 * @returns {string}
 */
export function holdErrorMessage(err, action) {
  const code = codeOf(err);
  if (code && Object.hasOwn(CODE_MESSAGES, code)) return CODE_MESSAGES[code];

  const status = err?.response?.status;
  if (status === 404 && Object.hasOwn(NOT_FOUND_MESSAGES, action)) return NOT_FOUND_MESSAGES[action];
  if (status === 409) return UNKNOWN_CONFLICT_MESSAGE;
  if (Object.hasOwn(STATUS_MESSAGES, status)) return STATUS_MESSAGES[status];

  return DEFAULT_MESSAGES[action] ?? "Something went wrong. Please try again.";
}

/**
 * What is in the way of the hold, from a HOLD_PERIOD_CONFLICT answer (AC4):
 * bookings, blocks and other events' holds, each with its occupied period.
 * Anything else, or any other answer, is an empty list.
 *
 * @param {unknown} err
 * @returns {Array<Object>}
 */
export function holdConflicts(err) {
  if (codeOf(err) !== "HOLD_PERIOD_CONFLICT") return [];
  const conflicts = err.response.data.conflicts;
  return Array.isArray(conflicts) ? conflicts.filter((c) => CONFLICT_KINDS.has(c?.kind)) : [];
}
