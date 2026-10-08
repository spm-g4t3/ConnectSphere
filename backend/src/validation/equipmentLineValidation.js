/**
 * Equipment line input validation.
 *
 * SCRUM-244, a subtask of SCRUM-21 "Record Equipment Requirements for an Event".
 *
 * AC2: a line has an equipment type, a quantity and optional technical notes.
 * AC3: the quantity is a whole number greater than zero.
 * AC6: an amendment changes only the quantity and the technical notes. Changing
 *      the type is a remove followed by an add.
 *
 * Pure and synchronous, like equipmentValidation.js: no database, nothing
 * imported but the error type and that file's helpers. The check functions
 * return their problems instead of throwing, so the service can add the two
 * that need a read (the type exists and is not retired, and the type is not
 * already on the event) before anything is thrown. The caller still sees every
 * fault at once, as SCRUM-10 does. 037_equipment_request_lines.sql refuses the
 * same things under a lock, as the backstop for two writers racing.
 */

import { ValidationError } from '../errors.js';
import { MAX_QUANTITY, throwIfInvalid } from './equipmentValidation.js';

export { throwIfInvalid };

/** Technical notes are free text. The customer set no limit, so this is a team decision. */
export const MAX_NOTES_LENGTH = 1000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const QUANTITY_MESSAGE =
  `must be a whole number greater than zero, and no larger than ${MAX_QUANTITY}`;


/** A required UUID. */
function readTypeId(details, value) {
  if (value === undefined || value === null) {
    details.push({ field: 'equipmentTypeId', message: 'is required' });
    return undefined;
  }
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    details.push({ field: 'equipmentTypeId', message: 'must be a UUID' });
    return undefined;
  }
  return value;
}

/** A whole number above zero. Strings are refused: "5" is not a quantity. */
function readQuantity(details, value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_QUANTITY) {
    details.push({ field: 'quantity', message: QUANTITY_MESSAGE });
    return undefined;
  }
  return value;
}

/**
 * Optional text. null or blank means "no notes" and comes back as null;
 * undefined comes back only when the value was refused.
 */
function readNotes(details, value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    details.push({ field: 'technicalNotes', message: 'must be text' });
    return undefined;
  }
  const notes = value.trim();
  if (notes.length > MAX_NOTES_LENGTH) {
    details.push({
      field: 'technicalNotes',
      message: `must be ${MAX_NOTES_LENGTH} characters or fewer`,
    });
    return undefined;
  }
  return notes === '' ? null : notes;
}


/**
 * AC2, AC3: check the input for a new line.
 *
 * @param {unknown} input
 * @returns {{value: {equipmentTypeId: string, quantity: number, technicalNotes: string|null}|null,
 *            details: Array<{field: string, message: string}>}}
 *   value is only safe to use when details is empty
 */
export function checkAddEquipmentLine(input) {
  if (!isObject(input)) {
    return { value: null, details: [{ field: 'equipmentLine', message: 'must be an object' }] };
  }

  const details = [];
  const equipmentTypeId = readTypeId(details, input.equipmentTypeId);
  const quantity = readQuantity(details, input.quantity);
  const technicalNotes = readNotes(details, input.technicalNotes);

  return { value: { equipmentTypeId, quantity, technicalNotes }, details };
}

/**
 * AC6: check an amendment. Only quantity and technicalNotes are read.
 *
 * technicalNotes sent as null or blank clears the notes, so whether the key was
 * sent matters: changeNotes says so, because a null technicalNotes alone cannot
 * tell "clear them" from "leave them".
 *
 * @param {unknown} input
 * @returns {{value: {quantity: number|null, technicalNotes: string|null, changeNotes: boolean}|null,
 *            details: Array<{field: string, message: string}>}}
 */
export function checkAmendEquipmentLine(input) {
  if (!isObject(input)) {
    return { value: null, details: [{ field: 'changes', message: 'must be an object' }] };
  }

  const details = [];

  if (has(input, 'equipmentTypeId')) {
    details.push({
      field: 'equipmentTypeId',
      message: 'cannot be changed; remove the line and add a new one',
    });
  }

  const sendsQuantity = has(input, 'quantity');
  const sendsNotes = has(input, 'technicalNotes');

  if (!sendsQuantity && !sendsNotes && details.length === 0) {
    details.push({ field: 'changes', message: 'give a quantity, technical notes, or both' });
  }

  const quantity = sendsQuantity ? readQuantity(details, input.quantity) : null;
  const technicalNotes = sendsNotes ? readNotes(details, input.technicalNotes) : null;

  return {
    value: {
      quantity: quantity ?? null,
      technicalNotes: technicalNotes ?? null,
      changeNotes: sendsNotes,
    },
    details,
  };
}


/** An id in the URL. Anything else would reach Postgres and come back as a 500. */
function validateUuid(id, field, label) {
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    throw new ValidationError(`Invalid ${label} -- ${field}: must be a UUID`, [
      { field, message: 'must be a UUID' },
    ]);
  }
  return id;
}

export const validateEventRequestId = (id) => validateUuid(id, 'id', 'event request id');
export const validateEquipmentLineId = (id) => validateUuid(id, 'lineId', 'equipment line id');
