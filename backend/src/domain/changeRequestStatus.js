/**
 * Change request status vocabulary.
 *
 * SCRUM-34 (AC4): show whether each change request is outstanding, in
 * progress, or processed, so an Organiser can track it.
 *
 * Mirrors the Postgres enum `change_request_status` in
 * 006_event_change_request_status.sql exactly, the same relationship STATUS
 * in eventRequestStatus.js has to `event_request_status`. These two lists
 * must stay identical -- a test asserts the match.
 *
 * Kept as its own module rather than folded into eventRequestStatus.js
 * because it answers a different question. eventRequestStatus.js is "what
 * stage is the event itself at" (draft, under review, confirmed, ...); this
 * is "has this one request for a change to it been dealt with yet". Both
 * being called "status" is exactly why they should not share a module.
 */

export const CHANGE_REQUEST_STATUS = Object.freeze({
  OUTSTANDING: 'outstanding',
  IN_PROGRESS: 'in_progress',
  PROCESSED: 'processed',
});

/** Every value CHANGE_REQUEST_STATUS holds, for checking a value against the vocabulary. */
export const CHANGE_REQUEST_STATUSES = Object.freeze(Object.values(CHANGE_REQUEST_STATUS));

/**
 * What an Organiser sees for each status. Wording matches the change
 * request status list this vocabulary exists for.
 */
export const CHANGE_REQUEST_STATUS_LABEL = Object.freeze({
  [CHANGE_REQUEST_STATUS.OUTSTANDING]: 'Outstanding',
  [CHANGE_REQUEST_STATUS.IN_PROGRESS]: 'In Progress',
  [CHANGE_REQUEST_STATUS.PROCESSED]: 'Processed',
});

/**
 * Is this a value the database will accept for a change request's status?
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isValidChangeRequestStatus(value) {
  return typeof value === 'string' && CHANGE_REQUEST_STATUSES.includes(value);
}
