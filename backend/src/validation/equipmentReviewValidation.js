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
  validateReservationId,
  throwIfInvalid,
} from './equipmentLineValidation.js';
import { MAX_QUANTITY } from './equipmentValidation.js';

export { validateEventRequestId, validateEquipmentLineId, validateReservationId, throwIfInvalid };

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
  // Code points, as Postgres char_length counts them: an emoji is one character, not two.
  if (Array.from(trimmed).length > MAX_OUTCOME_NOTE_LENGTH) {
    return {
      value: null,
      details: [{ field: 'note', message: `must be ${MAX_OUTCOME_NOTE_LENGTH} characters or fewer` }],
    };
  }

  return { value: { note: trimmed }, details: [] };
}


/** The longest reason accepted for a reservation action. Same limit as a note. */
export const MAX_REASON_LENGTH = MAX_NOTES_LENGTH;

const QUANTITY_MESSAGE =
  `must be a whole number greater than zero, and no larger than ${MAX_QUANTITY}`;

/** A whole number above zero. Strings are refused: "2" is not a quantity. */
function readQuantity(details, value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_QUANTITY) {
    details.push({ field: 'quantity', message: QUANTITY_MESSAGE });
    return undefined;
  }
  return value;
}

/**
 * A reason. When required, missing or blank is a fault; when optional, missing
 * or blank comes back as null so the database supplies its default wording.
 */
function readReason(details, value, { required }) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    if (required) details.push({ field: 'reason', message: 'is required: say why' });
    return null;
  }
  if (typeof value !== 'string') {
    details.push({ field: 'reason', message: 'must be text' });
    return null;
  }
  const trimmed = value.trim();
  if (Array.from(trimmed).length > MAX_REASON_LENGTH) {
    details.push({ field: 'reason', message: `must be ${MAX_REASON_LENGTH} characters or fewer` });
    return null;
  }
  return trimmed;
}

const notAnObject = (field) => ({
  value: null,
  details: [{ field, message: 'must be an object' }],
});

/** AC2: reserving needs a quantity. Nothing else in the body is read. */
export function checkReserveInput(input) {
  if (!isObject(input)) return notAnObject('reservation');

  const details = [];
  const quantity = readQuantity(details, input.quantity);
  return details.length > 0 ? { value: null, details } : { value: { quantity }, details };
}

/** AC4: reducing needs the new quantity and a reason. */
export function checkReduceInput(input) {
  if (!isObject(input)) return notAnObject('reservation');

  const details = [];
  const quantity = readQuantity(details, input.quantity);
  const reason = readReason(details, input.reason, { required: true });
  return details.length > 0 ? { value: null, details } : { value: { quantity, reason }, details };
}

/** AC4: releasing needs a reason. */
export function checkReleaseInput(input) {
  if (!isObject(input)) return notAnObject('reservation');

  const details = [];
  const reason = readReason(details, input.reason, { required: true });
  return details.length > 0 ? { value: null, details } : { value: { reason }, details };
}

/** AC7: move and keep take an optional reason. A missing body is fine. */
export function checkResolveInput(input) {
  if (input === undefined || input === null) return { value: { reason: null }, details: [] };
  if (!isObject(input)) return notAnObject('reservation');

  const details = [];
  const reason = readReason(details, input.reason, { required: false });
  return details.length > 0 ? { value: null, details } : { value: { reason }, details };
}
