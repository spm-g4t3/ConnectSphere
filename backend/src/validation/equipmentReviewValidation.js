/**
 * Input validation for reviewing an equipment request.
 *
 * SCRUM-290. The only body a review route reads is the note that explains why a
 * line cannot be provided (AC7). Everything else is an id in the URL, checked by
 * the helpers equipmentLineValidation.js already has.
 *
 * Pure and synchronous. The note is checked here for a clear 400; the database
 * refuses a blank one again (038, equipment_lines_outcome_consistent), as the
 * backstop.
 */

import {
  MAX_NOTES_LENGTH,
  validateEventRequestId,
  validateEquipmentLineId,
  throwIfInvalid,
} from './equipmentLineValidation.js';

export { validateEventRequestId, validateEquipmentLineId, throwIfInvalid };

/** The same limit as a line's technical notes. */
export const MAX_OUTCOME_NOTE_LENGTH = MAX_NOTES_LENGTH;

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * AC7: check the note for a "Cannot be provided" mark. It is required and must
 * say something; it comes back trimmed.
 *
 * @param {unknown} input  the request body
 * @returns {{value: {note: string}|null, details: Array<{field: string, message: string}>}}
 *   value is only safe to use when details is empty
 */
export function checkOutcomeNote(input) {
  if (!isObject(input)) {
    return { value: null, details: [{ field: 'outcome', message: 'must be an object' }] };
  }

  const { note } = input;

  if (note === undefined || note === null) {
    return { value: null, details: [{ field: 'note', message: 'is required: say what is missing' }] };
  }
  if (typeof note !== 'string') {
    return { value: null, details: [{ field: 'note', message: 'must be text' }] };
  }

  const trimmed = note.trim();
  if (trimmed === '') {
    return { value: null, details: [{ field: 'note', message: 'is required: say what is missing' }] };
  }
  if (trimmed.length > MAX_OUTCOME_NOTE_LENGTH) {
    return {
      value: null,
      details: [{ field: 'note', message: `must be ${MAX_OUTCOME_NOTE_LENGTH} characters or fewer` }],
    };
  }

  return { value: { note: trimmed }, details: [] };
}
