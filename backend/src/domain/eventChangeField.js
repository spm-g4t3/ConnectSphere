/**
 * Event change field vocabulary.
 *
 * SCRUM-11: what an Organiser may say a change request is about (AC2).
 *
 * Mirrors the Postgres enum `event_change_field` exactly -- created in
 * 005_event_change_requests.sql and extended in
 * 007_event_change_field_venue_equipment.sql -- the same relationship
 * STATUS in eventRequestStatus.js has to `event_request_status`. These two
 * lists must stay identical -- a test asserts the match rather than leaving
 * it to whoever edits one file to remember the other.
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
  VENUE: 'venue',
  EQUIPMENT: 'equipment',
  OTHER: 'other',
});

/** Every value CHANGE_FIELD holds, for checking a value against the vocabulary. */
export const CHANGE_FIELDS = Object.freeze(Object.values(CHANGE_FIELD));

/**
 * What an Organiser sees for each change field, in the change request status
 * list this exists to label. Wording matches what the request form already
 * shows when the Organiser first picks what to change, so the same field
 * reads the same way whether it is being chosen or being reviewed.
 */
export const CHANGE_FIELD_LABEL = Object.freeze({
  [CHANGE_FIELD.EVENT_NAME]: 'Event name',
  [CHANGE_FIELD.DESCRIPTION]: 'Description',
  [CHANGE_FIELD.PURPOSE]: 'Purpose',
  [CHANGE_FIELD.PROPOSED_START]: 'Date / start time',
  [CHANGE_FIELD.PROPOSED_END]: 'End time',
  [CHANGE_FIELD.EXPECTED_ATTENDANCE]: 'Expected attendance',
  [CHANGE_FIELD.VENUE]: 'Venue',
  [CHANGE_FIELD.EQUIPMENT]: 'Equipment',
  [CHANGE_FIELD.OTHER]: 'Something else',
});

/**
 * Is this a value the database will accept for change_field?
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isValidChangeField(value) {
  return typeof value === 'string' && CHANGE_FIELDS.includes(value);
}
