// eventCompletion.js
//
// SCRUM-384 (SCRUM-379): what the coordinator screens need to know about completing an event,
// kept out of the components so it can be tested without rendering one.
//
// Nothing here decides whether an event may be completed. The database does, under a row lock, in
// complete_event_request (034). These are the conveniences in front of it: which events to offer
// the action on, the notes limit the box enforces, and the words for a refusal.

import { SESSION_EXPIRED, codeOf } from "./apiErrors";

/** The only status an event is completed from. */
export const COMPLETABLE_STATUS = "confirmed";

/** Mirrors event_requests_closing_notes_nonblank (033) and the service's limit. */
export const CLOSING_NOTES_MAX_LENGTH = 2000;

/**
 * Has the event's end time passed? A missing or unreadable end time has not: the server refuses
 * to complete an event with no end time, so the action is not offered on one.
 *
 * @param {string|null|undefined} proposedEnd  an instant from the API
 * @param {Date} [now]
 * @returns {boolean}
 */
export function eventHasEnded(proposedEnd, now = new Date()) {
  if (!proposedEnd) return false;
  const end = new Date(proposedEnd).getTime();
  return !Number.isNaN(end) && end <= now.getTime();
}

/**
 * Is "Mark as completed" offered for this event to this person? A convenience, not the gate:
 * the server checks the caller, the status and the end time again.
 *
 * @param {object} event  an event request as the coordinator reads it
 * @param {{isAssignedCoordinator: boolean, now?: Date}} viewer
 * @returns {boolean}
 */
export function canMarkCompleted(event, { isAssignedCoordinator, now = new Date() }) {
  return Boolean(isAssignedCoordinator)
    && event?.status === COMPLETABLE_STATUS
    && eventHasEnded(event.proposedEnd, now);
}

/**
 * The closing notes to show, or null when the response carries none to show. `undefined` means the
 * response was not a coordinator read that includes the field (a response from some other
 * action), which is different from `null`, an event that has no notes.
 *
 * @param {object} event
 * @returns {{recorded: boolean, text: string|null}|null}  null when the field is not on the event
 */
export function closingNotesOf(event) {
  if (!event || event.closingNotes === undefined) return null;
  const text = typeof event.closingNotes === "string" && event.closingNotes.trim() !== ""
    ? event.closingNotes
    : null;
  return { recorded: text !== null, text };
}

/**
 * The words for a refused or failed completion. An EVENT_FINAL refusal is shown as the server
 * worded it; the other refusals are put in terms of what the coordinator can do next.
 *
 * @param {unknown} error  an axios error
 * @returns {string}
 */
export function completionErrorMessage(error) {
  const status = error?.response?.status;
  const serverMessage = error?.response?.data?.error;

  if (!error?.response) {
    return "The request did not reach the server, so the event may not have been completed. Reopen the event to check where it stands before trying again.";
  }
  if (status === 401) return SESSION_EXPIRED;
  if (status === 403) return "Only the coordinator assigned to this event can mark it as completed.";
  if (status === 404) return "This event request no longer exists.";
  if (status === 400) {
    return serverMessage || "The closing notes could not be saved. Check them and try again.";
  }
  if (status === 409) {
    if (codeOf(error) === "EVENT_FINAL" && serverMessage) return serverMessage;
    if (/has not ended yet/i.test(serverMessage ?? "")) {
      return "This event has not ended yet, so it cannot be marked as completed. Try again once it has ended.";
    }
    if (/only a confirmed event/i.test(serverMessage ?? "")) {
      return "This event is no longer Confirmed, so it cannot be marked as completed. Reopen it to see where it stands.";
    }
    return "This event has changed and can no longer be marked as completed. Reopen it to see where it stands.";
  }
  return "The event could not be marked as completed. No changes have been made; try again.";
}
