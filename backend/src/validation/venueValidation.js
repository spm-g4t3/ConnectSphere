/**
 * Venue input validation.
 *
 * SCRUM-94: validate venue creation and update input.
 *
 * AC1: name, location and maximum capacity are mandatory, and capacity must be
 * a positive whole number.
 *
 * Pure and synchronous -- no database, no imports beyond the error types. That
 * keeps it unit-testable without credentials, which is the point: the database
 * constraints in 002_venues.sql already guarantee correctness, and this layer
 * exists to say what went wrong in words a Venue Staff member can act on.
 *
 * Deliberately NOT checked here: whether a layout or facility code exists.
 * That is referential integrity, the foreign keys enforce it, and
 * venueService.translateError turns the violation into a ValidationError
 * naming the bad code. Checking it here would make this module async and
 * database-dependent for no real gain.
 */

import { ValidationError } from '../errors.js';

/** HH:MM or HH:MM:SS, with real hour and minute ranges. */
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;

const ATTRIBUTE_FIELDS = ['layouts', 'accessibility', 'facilities'];

/** 'HH:MM' -> 'HH:MM:SS', so two times are always compared in the same shape. */
function withSeconds(time) {
  return time.length === 5 ? `${time}:00` : time;
}


/** Collects problems so every fault in a form is reported at once. */
function createErrorCollector() {
  const details = [];
  return {
    add: (field, message) => details.push({ field, message }),
    details,
    get hasErrors() {
      return details.length > 0;
    },
  };
}

function throwIfInvalid(errors) {
  if (!errors.hasErrors) return;

  const summary = errors.details
    .map(({ field, message }) => `${field}: ${message}`)
    .join('; ');

  throw new ValidationError(`Invalid venue details -- ${summary}`, errors.details);
}

/** Required text: must be a string with something in it once trimmed. */
function checkRequiredText(errors, field, value) {
  if (value === undefined || value === null) {
    errors.add(field, 'is required');
    return null;
  }
  if (typeof value !== 'string') {
    errors.add(field, 'must be text');
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    errors.add(field, 'cannot be blank');
    return null;
  }
  return trimmed;
}

/**
 * AC1: "capacity must be a positive whole number".
 *
 * Strict about type on purpose. "40" is rejected rather than coerced, so a
 * caller sending strings finds out here instead of the bug surfacing later.
 */
function checkCapacity(errors, value) {
  if (value === undefined || value === null) {
    errors.add('maxCapacity', 'is required');
    return null;
  }
  if (typeof value !== 'number' || Number.isNaN(value)) {
    errors.add('maxCapacity', 'must be a number');
    return null;
  }
  if (!Number.isInteger(value)) {
    errors.add('maxCapacity', 'must be a whole number');
    return null;
  }
  if (value <= 0) {
    errors.add('maxCapacity', 'must be greater than zero');
    return null;
  }
  return value;
}

/** Attribute sets are arrays of lookup codes; existence is the FK's job. */
function checkCodeArray(errors, field, value) {
  if (!Array.isArray(value)) {
    errors.add(field, 'must be an array of codes');
    return null;
  }
  const cleaned = [];
  value.forEach((code, index) => {
    if (typeof code !== 'string' || code.trim() === '') {
      errors.add(field, `entry ${index} must be a non-empty code`);
      return;
    }
    cleaned.push(code.trim());
  });
  return cleaned;
}

/**
 * Opening hours, one entry per day.
 *
 * The ordering and duplicate-day rules mirror constraints the database already
 * has. That duplication is intentional -- the database is the guarantee, this
 * is the readable message.
 */
function checkHours(errors, value) {
  if (!Array.isArray(value)) {
    errors.add('hours', 'must be an array');
    return null;
  }

  const cleaned = [];
  const daysSeen = new Set();

  value.forEach((entry, index) => {
    const label = `hours[${index}]`;

    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.add('hours', `${label} must be an object`);
      return;
    }

    const { day_of_week: day, opens_at: opens, closes_at: closes } = entry;

    let valid = true;

    if (!Number.isInteger(day) || day < 0 || day > 6) {
      errors.add('hours', `${label}.day_of_week must be a whole number from 0 (Sunday) to 6`);
      valid = false;
    } else if (daysSeen.has(day)) {
      errors.add('hours', `${label} repeats day ${day}; each day may appear once`);
      valid = false;
    }

    if (typeof opens !== 'string' || !TIME_PATTERN.test(opens)) {
      errors.add('hours', `${label}.opens_at must be a time such as 09:00`);
      valid = false;
    }

    if (typeof closes !== 'string' || !TIME_PATTERN.test(closes)) {
      errors.add('hours', `${label}.closes_at must be a time such as 18:00`);
      valid = false;
    }

    // Compare in a single format. Zero-padded 24-hour times sort
    // chronologically as strings, but only if both have the same shape --
    // '09:00:00' sorts after '09:00' despite being the same instant.
    if (valid && withSeconds(closes) <= withSeconds(opens)) {
      errors.add('hours', `${label}.closes_at must be after opens_at`);
      valid = false;
    }

    if (valid) {
      daysSeen.add(day);
      cleaned.push({ day_of_week: day, opens_at: opens, closes_at: closes });
    }
  });

  return cleaned;
}


/**
 * Validate input for creating a venue.
 *
 * @param {object} input
 * @returns {object} a normalised copy -- name and location trimmed
 * @throws {ValidationError} listing every problem found, not just the first
 */
export function validateCreateVenue(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('Invalid venue details -- expected an object');
  }

  const errors = createErrorCollector();
  const normalised = {};

  normalised.name = checkRequiredText(errors, 'name', input.name);
  normalised.location = checkRequiredText(errors, 'location', input.location);
  normalised.maxCapacity = checkCapacity(errors, input.maxCapacity);

  for (const field of ATTRIBUTE_FIELDS) {
    if (input[field] !== undefined) {
      normalised[field] = checkCodeArray(errors, field, input[field]);
    }
  }

  if (input.hours !== undefined) {
    normalised.hours = checkHours(errors, input.hours);
  }

  throwIfInvalid(errors);
  return normalised;
}

/**
 * Validate input for updating a venue. Every field is optional.
 *
 * An empty object is rejected: an update that changes nothing is a caller bug,
 * not a request worth a database round trip.
 *
 * A supplied name or location must still be non-empty. Omitting a field means
 * "leave unchanged" (see update_venue in 004_venue_functions.sql), so there is
 * no way to clear a mandatory field -- a blank string is a mistake.
 *
 * @param {object} changes
 * @returns {object} a normalised copy containing only the supplied fields
 * @throws {ValidationError}
 */
export function validateUpdateVenue(changes) {
  if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) {
    throw new ValidationError('Invalid venue details -- expected an object');
  }

  const supplied = Object.keys(changes).filter((key) => changes[key] !== undefined);
  if (supplied.length === 0) {
    throw new ValidationError('Invalid venue details -- no changes supplied');
  }

  const errors = createErrorCollector();
  const normalised = {};

  if (changes.name !== undefined) {
    normalised.name = checkRequiredText(errors, 'name', changes.name);
  }

  if (changes.location !== undefined) {
    normalised.location = checkRequiredText(errors, 'location', changes.location);
  }

  if (changes.maxCapacity !== undefined) {
    normalised.maxCapacity = checkCapacity(errors, changes.maxCapacity);
  }

  for (const field of ATTRIBUTE_FIELDS) {
    if (changes[field] !== undefined) {
      normalised[field] = checkCodeArray(errors, field, changes[field]);
    }
  }

  if (changes.hours !== undefined) {
    normalised.hours = checkHours(errors, changes.hours);
  }

  throwIfInvalid(errors);
  return normalised;
}
