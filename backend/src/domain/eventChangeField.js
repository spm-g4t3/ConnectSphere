/**
 * Event change field vocabulary.
 *
 * SCRUM-11: what an Organiser may say a change request is about (AC2).
 *
 * Mirrors the Postgres enum `event_change_field` exactly -- defined in
 * 006_event_change_requests.sql -- the same relationship
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
  // SCRUM-402 AC7 (035): the Organiser asks for the event to be cancelled.
  CANCELLATION: 'cancellation',
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
  [CHANGE_FIELD.CANCELLATION]: 'Cancel the event',
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
 * Which event_requests column each of the six structured change fields is
 * stored in (SCRUM-37). Since SCRUM-402 a venue request writes a column too,
 * the venue requirements, and equipment in review writes the equipment
 * requirements: DETAIL_FIELD_BY_CHANGE_FIELD below is the full mapping, and
 * this one stays for the six it has always named.
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

/**
 * SCRUM-402: the detail field (backend/src/domain/eventDetailField.js) each
 * change field is applied as, when a change request is accepted. A venue
 * request is a change to the venue requirements (D6). Other and cancellation
 * write no field. Mirrors change_request_targets() in 036; a test reads both.
 */
export const DETAIL_FIELD_BY_CHANGE_FIELD = Object.freeze({
  [CHANGE_FIELD.EVENT_NAME]: 'eventName',
  [CHANGE_FIELD.DESCRIPTION]: 'description',
  [CHANGE_FIELD.PURPOSE]: 'purpose',
  [CHANGE_FIELD.PROPOSED_START]: 'proposedStart',
  [CHANGE_FIELD.PROPOSED_END]: 'proposedEnd',
  [CHANGE_FIELD.EXPECTED_ATTENDANCE]: 'expectedAttendance',
  [CHANGE_FIELD.VENUE]: 'venueRequirements',
  [CHANGE_FIELD.EQUIPMENT]: 'equipmentRequirements',
});
