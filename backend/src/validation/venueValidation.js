/**
 * Venue input validation.
 *
 * SCRUM-94: validate venue creation and update input.
 *
 * AC1: name, location and maximum capacity are mandatory, and capacity must be
 * a positive whole number.
 *
 * Pure and synchronous -- no database, no imports beyond the error types and
 * the shared timestamp rules (SCRUM-130). That
 * keeps it unit-testable without credentials, which is the point: the database
 * constraints in 002_venues.sql already guarantee correctness, and this layer
 * exists to say what went wrong in words a Venue Staff member can act on.
 *
 * SCRUM-186 adds the turnaround between events, one of a fixed list of
 * minutes (domain/turnaroundOptions.js).
 *
 * Deliberately NOT checked here: whether a layout or facility code exists.
 * That is referential integrity, the foreign keys enforce it, and
 * venueService.translateError turns the violation into a ValidationError
 * naming the bad code. Checking it here would make this module async and
 * database-dependent for no real gain.
 */

import { ValidationError } from '../errors.js';
import { checkTimeWindow } from './timestampValidation.js';
import {
  TURNAROUND_MINUTES_OPTIONS,
  isTurnaroundOption,
} from '../domain/turnaroundOptions.js';

/** HH:MM or HH:MM:SS, with real hour and minute ranges. */
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;

/** The shape gen_random_uuid() produces, which is what venues.id holds. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 *
 * Takes the field name because the same rule guards two different fields: a
 * venue's maxCapacity, and the minCapacity a search filters by.
 */
function checkCapacity(errors, field, value) {
  if (value === undefined || value === null) {
    errors.add(field, 'is required');
    return null;
  }
  if (typeof value !== 'number' || Number.isNaN(value)) {
    errors.add(field, 'must be a number');
    return null;
  }
  if (!Number.isInteger(value)) {
    errors.add(field, 'must be a whole number');
    return null;
  }
  if (value <= 0) {
    errors.add(field, 'must be greater than zero');
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
 * SCRUM-186: turnaround between events, one of the allowed minute values.
 *
 * Only called when the field was supplied, so null here was sent on purpose
 * and is refused: update_venue reads NULL as "keep the current value", and a
 * request that says "clear it" should not quietly do nothing.
 */
function checkTurnaround(errors, value) {
  if (!isTurnaroundOption(value)) {
    errors.add(
      'turnaroundMinutes',
      `must be one of ${TURNAROUND_MINUTES_OPTIONS.join(', ')} minutes`,
    );
    return null;
  }
  return value;
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
  normalised.maxCapacity = checkCapacity(errors, 'maxCapacity', input.maxCapacity);

  for (const field of ATTRIBUTE_FIELDS) {
    if (input[field] !== undefined) {
      normalised[field] = checkCodeArray(errors, field, input[field]);
    }
  }

  if (input.hours !== undefined) {
    normalised.hours = checkHours(errors, input.hours);
  }

  if (input.turnaroundMinutes !== undefined) {
    normalised.turnaroundMinutes = checkTurnaround(errors, input.turnaroundMinutes);
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
    normalised.maxCapacity = checkCapacity(errors, 'maxCapacity', changes.maxCapacity);
  }

  for (const field of ATTRIBUTE_FIELDS) {
    if (changes[field] !== undefined) {
      normalised[field] = checkCodeArray(errors, field, changes[field]);
    }
  }

  if (changes.hours !== undefined) {
    normalised.hours = checkHours(errors, changes.hours);
  }

  // !== undefined, not truthiness: 0 is a real choice, so {turnaroundMinutes: 0}
  // on its own is a change and passes the "no changes supplied" rule above.
  if (changes.turnaroundMinutes !== undefined) {
    normalised.turnaroundMinutes = checkTurnaround(errors, changes.turnaroundMinutes);
  }

  throwIfInvalid(errors);
  return normalised;
}

/**
 * Validate a venue id before it reaches the database.
 *
 * SCRUM-110. Retirement is the only destructive operation on the catalogue, so
 * a malformed id is refused here rather than sent to Postgres and returned as
 * a driver-level cast error that names no field.
 *
 * @param {string} id
 * @returns {string} the id, unchanged
 * @throws {ValidationError}
 */
export function validateVenueId(id) {
  const errors = createErrorCollector();

  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    errors.add('id', 'must be a venue id');
  }

  throwIfInvalid(errors);
  return id;
}

/**
 * An unfilled search box is not a filter.
 *
 * This is the one place blankness is forgiven rather than reported. On create
 * and update a blank name is a mistake worth naming; on a search it is just a
 * field the user did not fill in, and rejecting it would make an empty form
 * unsubmittable.
 */
function isUnset(value) {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '')
  );
}

/**
 * Validate the filters a venue search may be narrowed by.
 *
 * SCRUM-111. Every filter is optional and, unlike validateUpdateVenue, an
 * empty object is valid -- "show me everything" is a legitimate search rather
 * than a caller bug.
 *
 * Retirement is deliberately not a filter. AC3 makes active-only the rule for
 * every search, not an option a caller can switch off, so searchVenues applies
 * it unconditionally and no filter here can reach a retired venue.
 *
 * SCRUM-130 adds an optional startsAt/endsAt window, both or neither, through
 * the same checkTimeWindow the block window uses. No length cap: how long an
 * event may run is SCRUM-20's rule, and a search should not invent one.
 *
 * @param {object} [filters]
 * @param {string} [filters.location]     matched as a substring, case-insensitively
 * @param {number} [filters.minCapacity]  venues that seat at least this many
 * @param {string} [filters.startsAt]     SCRUM-130: ISO 8601 with an offset
 * @param {string} [filters.endsAt]       SCRUM-130: ISO 8601 with an offset;
 *                                        later than startsAt
 * @returns {object} a normalised copy holding only the filters actually supplied
 * @throws {ValidationError}
 */
export function validateSearchFilters(filters = {}) {
  if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) {
    throw new ValidationError('Invalid venue search -- expected an object');
  }

  const errors = createErrorCollector();
  const normalised = {};

  if (!isUnset(filters.location)) {
    normalised.location = checkRequiredText(errors, 'location', filters.location);
  }

  if (!isUnset(filters.minCapacity)) {
    normalised.minCapacity = checkCapacity(errors, 'minCapacity', filters.minCapacity);
  }

  // Keys only when a window was given, so a dateless search normalises to
  // exactly what it did before SCRUM-130.
  const window = checkTimeWindow(errors, ['startsAt', 'endsAt'], filters.startsAt, filters.endsAt);
  if (window !== null) {
    normalised.startsAt = window.start;
    normalised.endsAt = window.end;
  }

  throwIfInvalid(errors);
  return normalised;
}
