/**
 * Event detail field vocabulary.
 *
 * SCRUM-387: which of an event's fields its assigned coordinator may edit
 * directly, and in which statuses. Not eventChangeField.js, which is SCRUM-11's
 * change-request vocabulary (snake_case, with venue and other).
 *
 * Mirrors the field list in edit_event_request_details (migration 022), the
 * camelCase names event_change_history records. A PGlite test sends every field
 * here to the function and an unknown one too, so the two lists cannot drift (D2).
 *
 * Significant fields change what has been or will be arranged; ordinary fields
 * only describe the event. In planning only the ordinary ones are edited here;
 * the rest go through the significant change process (SCRUM-395).
 */

import { STATUS } from './eventRequestStatus.js';

/** Describe the event; editable in review and in planning. */
export const ORDINARY_DETAIL_FIELDS = Object.freeze(['eventName', 'purpose', 'description']);

/** Change what is arranged; editable here only in review. */
export const SIGNIFICANT_DETAIL_FIELDS = Object.freeze([
  'proposedStart',
  'proposedEnd',
  'expectedAttendance',
  'venueRequirements',
  'accessibilityRequirements',
  'equipmentRequirements',
]);

/** Every field the edit accepts, ordinary first. */
export const DETAIL_FIELDS = Object.freeze([...ORDINARY_DETAIL_FIELDS, ...SIGNIFICANT_DETAIL_FIELDS]);

/** The event_requests column each field is stored in. */
export const DETAIL_FIELD_COLUMN = Object.freeze({
  eventName: 'event_name',
  purpose: 'purpose',
  description: 'description',
  proposedStart: 'proposed_start',
  proposedEnd: 'proposed_end',
  expectedAttendance: 'expected_attendance',
  venueRequirements: 'venue_requirements',
  accessibilityRequirements: 'accessibility_requirements',
  equipmentRequirements: 'equipment_requirements',
});

/** Nothing is arranged yet, so any field may change (AC2). */
export const STATUSES_ALLOWING_ANY_EDIT = Object.freeze([STATUS.UNDER_REVIEW, STATUS.PENDING_CLARIFICATION]);

/** Any edit in review; ordinary fields only in planning and the safety check (AC3, D3). */
export const STATUSES_ALLOWING_ORDINARY_EDITS = Object.freeze([
  ...STATUSES_ALLOWING_ANY_EDIT,
  STATUS.APPROVED,
  STATUS.SAFETY_REVIEW,
  STATUS.SAFETY_APPROVED,
]);

/**
 * @param {string} field  a camelCase field name
 * @returns {boolean} true only for one of SIGNIFICANT_DETAIL_FIELDS
 */
export function isSignificantDetailField(field) {
  return SIGNIFICANT_DETAIL_FIELDS.includes(field);
}
