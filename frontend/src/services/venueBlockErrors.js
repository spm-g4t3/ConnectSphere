// venueBlockErrors.js
//
// SCRUM-127 (part of SCRUM-17). What a failed block request says to the Venue
// Staff member, for each of the four block calls in venueService.
//
// Keyed by the 409 `code` first, then by status, then a default per action --
// the same idea as VenueCatalogue's RETIRE_ERROR_MESSAGES, one level deeper,
// because a 409 here can mean five different things.
//
// data.error is never read. On these routes it is database prose carrying raw
// uuids ("block <uuid> overlaps block <uuid>"), which is not something to put
// in front of a user. The only server text the UI shows is details[].message
// from a 400, and that goes to the form, not through here.

import { codeOf, makeErrorMapper, SESSION_EXPIRED } from "./apiErrors";

const CODE_MESSAGES = {
  VENUE_RETIRED: "This venue has been retired, so it can no longer be blocked.",
  BLOCK_OVERLAPS_BLOCK:
    "This period overlaps another block on this venue. Choose a different period, or change that block instead.",
  BLOCK_REMOVED: "This block has already been removed. The list has been refreshed.",
  BLOCK_ENDED:
    "This block has already ended, so it can no longer be changed. The list has been refreshed.",
  // Only reaches here after an override: the first 409 is shown as the
  // conflict list, not as a message.
  BLOCK_BOOKING_CONFLICT: "The overlapping bookings changed since you confirmed. Review the updated list.",
};

const STATUS_MESSAGES = {
  400: "Some details were not accepted. Please check the form.",
  401: SESSION_EXPIRED,
  403: "Only Venue Staff can manage venue blocks.",
};

// A 404 on list or create can only be the venue; on update or remove it is
// almost always the block, which someone else removed or never belonged here.
const NOT_FOUND_MESSAGES = {
  list: "That venue no longer exists.",
  create: "That venue no longer exists.",
  update: "That block no longer exists. The list has been refreshed.",
  remove: "That block no longer exists. The list has been refreshed.",
};

const DEFAULT_MESSAGES = {
  list: "Could not load this venue's blocks. Please try again.",
  create: "Could not save the block. Please try again.",
  update: "Could not save the block. Please try again.",
  remove: "Could not remove this block. Please try again.",
};

const UNKNOWN_CONFLICT_MESSAGE =
  "This block changed while you were working on it. The list has been refreshed.";

// The codes that mean our copy of the block is out of date.
const STALE_CODES = new Set(["BLOCK_REMOVED", "BLOCK_ENDED"]);

/**
 * The message for a failed block request.
 *
 * @param {unknown} err  what the venueService call threw
 * @param {"list"|"create"|"update"|"remove"} action
 * @returns {string}
 */
export const blockErrorMessage = makeErrorMapper({
  codeMessages: CODE_MESSAGES,
  statusMessages: STATUS_MESSAGES,
  notFoundMessages: NOT_FOUND_MESSAGES,
  defaultMessages: DEFAULT_MESSAGES,
  unknownConflictMessage: UNKNOWN_CONFLICT_MESSAGE,
});

/**
 * Whether the failure means the block list on screen is out of date, so the
 * caller should refetch it: a 404, BLOCK_REMOVED, BLOCK_ENDED, or a 409 with a
 * code this build does not know.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isStaleBlockError(err) {
  const status = err?.response?.status;
  if (status === 404) return true;
  if (status !== 409) return false;

  const code = codeOf(err);
  if (STALE_CODES.has(code)) return true;
  return !code || !Object.hasOwn(CODE_MESSAGES, code);
}
