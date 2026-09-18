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

/**
 * Which event_requests column a structured change field maps onto, for
 * applying an approved change back onto the event record (SCRUM-37, AC5).
 *
 * A field with no entry here -- venue, equipment, other -- has no column of
 * its own to write into; see the comment on 'other' in
 * 005_event_change_requests.sql for why. Approving a change to one of those
 * is still a valid decision, it is only not reflected anywhere on the event
 * record, because nowhere yet exists to put it.
 *
 * Mirrors the field-by-field branches process_change_request applies in
 * 009_event_change_request_functions.sql -- the actual write happens there,
 * inside the same transaction as the decision, not from this module or from
 * JavaScript at all. This map exists so that mapping is documented and
 * testable in one place rather than only readable out of a SQL function
 * body; a test checks the two stay in step.
 */
export const EVENT_REQUEST_COLUMN_BY_CHANGE_FIELD = Object.freeze({
  [CHANGE_FIELD.EVENT_NAME]: 'event_name',
  [CHANGE_FIELD.DESCRIPTION]: 'description',
  [CHANGE_FIELD.PURPOSE]: 'purpose',
  [CHANGE_FIELD.PROPOSED_START]: 'proposed_start',
  [CHANGE_FIELD.PROPOSED_END]: 'proposed_end',
  [CHANGE_FIELD.EXPECTED_ATTENDANCE]: 'expected_attendance',
});

/**
 * Does this change field have a column on event_requests to apply an
 * approved change onto?
 *
 * @param {string} changeField
 * @returns {boolean}
 */
export function hasEventRequestColumn(changeField) {
  return Object.hasOwn(EVENT_REQUEST_COLUMN_BY_CHANGE_FIELD, changeField);
}
