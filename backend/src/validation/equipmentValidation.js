/**
 * Equipment type input validation.
 *
 * SCRUM-276, a subtask of SCRUM-275 "Maintain Equipment Catalogue and Status".
 *
 * AC2: an equipment type is created with a name, description, category,
 * location and total quantity. The name and total are required, the total is a
 * whole number of zero or more, and every invalid field is listed together.
 * AC3: the same rules apply when any of those fields is edited.
 *
 * Pure and synchronous, like venueValidation.js: no database and nothing
 * imported but the error type, so it can be unit-tested without credentials.
 *
 * Two rules need a read, so equipmentService adds them to the problems this
 * module returns instead of raising them itself: the name must be unique
 * ignoring capitalisation, and the total can't go below damaged plus under
 * maintenance. That is why the check functions return their problems rather
 * than throwing -- the service can add its own before anything is thrown, and
 * the caller still sees every fault at once. The constraints in
 * 022_equipment_schema.sql remain the backstop for two writers racing.
 *
 * Only the five fields below are ever read from a body. Damaged and
 * under-maintenance quantities and retirement have their own endpoints
 * (SCRUM-277, SCRUM-278), so sending them here changes nothing.
 */

import { ValidationError } from '../errors.js';

/** The largest value the integer column holds; anything bigger is a 500 from Postgres. */
export const MAX_QUANTITY = 2147483647;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OPTIONAL_TEXT_FIELDS = ['description', 'category', 'location'];
const FIELDS = ['name', ...OPTIONAL_TEXT_FIELDS, 'totalQuantity'];

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);


/** Required text. Returns the trimmed name, or undefined after recording why not. */
function readName(details, value) {
  if (value === undefined || value === null) {
    details.push({ field: 'name', message: 'is required' });
    return undefined;
  }
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'must be text' });
    return undefined;
  }
  const name = value.trim();
  if (name === '') {
    details.push({ field: 'name', message: 'must not be blank' });
    return undefined;
  }
  return name;
}

/** A whole number of zero or more. Strings are refused: "5" is not a quantity. */
function readTotal(details, value) {
  if (value === undefined || value === null) {
    details.push({ field: 'totalQuantity', message: 'is required' });
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_QUANTITY) {
    details.push({
      field: 'totalQuantity',
      message: `must be a whole number of zero or more, and no larger than ${MAX_QUANTITY}`,
    });
    return undefined;
  }
  return value;
}

/**
 * Optional text. null or blank means "no value" and comes back as null;
 * undefined comes back when the value was refused, so a caller can tell a
 * deliberate clear (null) from a rejection (undefined).
 */
function readOptionalText(details, field, value) {
  if (value === null) return null;
  if (typeof value !== 'string') {
    details.push({ field, message: 'must be text' });
    return undefined;
  }
  const text = value.trim();
  return text === '' ? null : text;
}


/**
 * AC2: check the input for a new equipment type.
 *
 * @param {unknown} input
 * @returns {{value: object|null, details: Array<{field: string, message: string}>}}
 *   value is only safe to use when details is empty
 */
export function checkCreateEquipmentType(input) {
  if (!isObject(input)) {
    return { value: null, details: [{ field: 'equipment', message: 'must be an object' }] };
  }

  const details = [];
  const name = readName(details, input.name);
  const totalQuantity = readTotal(details, input.totalQuantity);

  const optional = {};
  for (const field of OPTIONAL_TEXT_FIELDS) {
    optional[field] = input[field] === undefined ? null : readOptionalText(details, field, input[field]);
  }

  return { value: { name, ...optional, totalQuantity }, details };
}

/**
 * AC3: check a change to an existing type. Only the fields sent are checked
 * and only they come back, so omitting a field leaves it as it was.
 *
 * @param {unknown} changes
 * @returns {{value: object|null, details: Array<{field: string, message: string}>}}
 */
export function checkUpdateEquipmentType(changes) {
  if (!isObject(changes)) {
    return { value: null, details: [{ field: 'equipment', message: 'must be an object' }] };
  }

  const details = [];
  const value = {};

  if (changes.name !== undefined) {
    const name = readName(details, changes.name);
    if (name !== undefined) value.name = name;
  }

  if (changes.totalQuantity !== undefined) {
    const total = readTotal(details, changes.totalQuantity);
    if (total !== undefined) value.totalQuantity = total;
  }

  for (const field of OPTIONAL_TEXT_FIELDS) {
    if (changes[field] === undefined) continue;
    const text = readOptionalText(details, field, changes[field]);
    if (text !== undefined) value[field] = text;
  }

  // Refused outright rather than sent as an update that changes nothing.
  if (!FIELDS.some((field) => changes[field] !== undefined)) {
    details.push({
      field: 'equipment',
      message: 'provide at least one of name, description, category, location or totalQuantity',
    });
  }

  return { value, details };
}

/** Is a problem already recorded against this field? */
export function hasField(details, field) {
  return details.some((detail) => detail.field === field);
}

/** Raise every problem collected so far as one ValidationError. */
export function throwIfInvalid(details) {
  if (details.length === 0) return;

  const summary = details.map(({ field, message }) => `${field}: ${message}`).join('; ');
  throw new ValidationError(`Invalid equipment details -- ${summary}`, details);
}

/** A malformed id would reach Postgres as a 22P02 cast error and surface as a 500. */
export function validateEquipmentTypeId(id) {
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    throw new ValidationError('Invalid equipment type id -- id: must be a UUID', [
      { field: 'id', message: 'must be a UUID' },
    ]);
  }
  return id;
}