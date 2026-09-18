/**
 * Event change field vocabulary.
 *
 * SCRUM-11: what an Organiser may say a change request is about (AC2).
 *
 * Mirrors the Postgres enum `event_change_field` in
 * 005_event_change_requests.sql exactly, the same relationship STATUS in
 * eventRequestStatus.js has to `event_request_status`. These two lists must
 * stay identical -- a test asserts the match rather than leaving it to
 * whoever edits one file to remember the other.
 *
 * Deliberately free of imports, database calls and framework code, so it can
 * be tested in isolation and reused by both validation and the service layer
 * without either depending on the other.
 */

export const CHANGE_FIELD = Object.freeze({
  EVENT_NAME: 'event_name',
  DESCRIPTION: 'description',
  PURPOSE: 'purpose',
  PROPOSED_START: 'proposed_start',
  PROPOSED_END: 'proposed_end',
  EXPECTED_ATTENDANCE: 'expected_attendance',
  OTHER: 'other',
});

/** Every value CHANGE_FIELD holds, for checking a value against the vocabulary. */
export const CHANGE_FIELDS = Object.freeze(Object.values(CHANGE_FIELD));

/**
 * Is this a value the database will accept for change_field?
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isValidChangeField(value) {
  return typeof value === 'string' && CHANGE_FIELDS.includes(value);
}
