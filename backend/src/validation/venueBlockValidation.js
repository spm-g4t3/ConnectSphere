/**
 * Venue block input validation.
 *
 * SCRUM-126, a subtask of SCRUM-17 (Block a Venue for Unavailability).
 *
 * AC1: a block is created with a venue, a start and end date and time, and a
 * reason category. This module says, in words a Venue Staff member can act
 * on, what is wrong with a block before it reaches the database. The database
 * is still the guarantee: 011_venue_blocks.sql carries the same ordering,
 * "other needs notes" and notes-length constraints, and create_venue_block
 * (012) re-checks the period and the overlap inside its own transaction. The
 * duplication is intentional -- the database is the guarantee, this is the
 * readable message.
 *
 * Pure and synchronous -- no database, no network, and no clock read except
 * the default for the injected `now`. That keeps it unit-testable without
 * credentials and deterministic in CI.
 *
 * Deliberately NOT checked here:
 *
 *  - Whether the venue exists, or is retired. That needs the database, and
 *    create_venue_block answers it under a row lock so it cannot go stale
 *    between the check and the insert.
 *  - Overlap with another block, or with approved bookings. Both need the
 *    database, and create_venue_block (013) answers them under locks. What
 *    this module does check, for SCRUM-125, is the SHAPE of the override the
 *    caller sends: confirmOverride and acknowledgedBookingIds.
 *  - Whether the start is in the past. A block may start in the past -- staff
 *    record a closure that has already begun -- so only the end has to be
 *    ahead of now.
 *  - Unknown keys. They are ignored silently, as both existing validators do.
 *
 * SCRUM-125 (AC3) adds the override fields. A block over approved bookings is
 * created only when the caller sets confirmOverride AND lists the bookings it
 * is overriding, so the two travel together: an override with no bookings
 * named, or bookings named with no override, is refused as malformed rather
 * than quietly treated as one or the other.
 *
 * SCRUM-127 (AC4) adds validateUpdateBlock, for shortening or extending a
 * block or changing its reason or notes. It is a patch: an omitted field
 * keeps its stored value, so the rules that compare fields -- start before
 * end, "other needs notes" -- can only be judged here when both sides were
 * sent. update_venue_block (015) judges them again on the merged row, which
 * is the only place the stored half is visible.
 *
 * SCRUM-130 (AC2) adds two read-side checks. validateBlockWindow is the
 * optional from/to window the venue calendar reads blocks through, capped at
 * BLOCK_WINDOW_MAX_DAYS. validatePeriod is a period where both ends are
 * required (written for findBlockedVenueIds, which SCRUM-484 removed).
 * Neither has a future-end rule:
 * these read blocks, they do not create them.
 */

import { ValidationError } from '../errors.js';
import { BLOCK_REASON, isBlockReason } from '../domain/venueBlockReason.js';
import { checkTimestamp, checkTimeWindow } from './timestampValidation.js';

/** The shape gen_random_uuid() produces, which is what venue_blocks.id holds. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TIMESTAMP_FIELDS = ['startsAt', 'endsAt'];

/**
 * SCRUM-130: the longest block window one read may ask for. A year view plus
 * the spill-over weeks a month grid shows either side of it; it keeps one
 * request from reading a venue's whole history.
 */
export const BLOCK_WINDOW_MAX_DAYS = 400;

/** SCRUM-127: the fields that make an update a change, rather than an empty request. */
const PATCH_FIELDS = ['startsAt', 'endsAt', 'reason', 'notes'];

/** Mirrors venue_blocks_notes_length in 011. */
const NOTES_MAX_LENGTH = 1000;

/**
 * The most bookings one override may acknowledge. Far beyond any real period,
 * and it keeps an arbitrarily large array out of the RPC call.
 */
const ACKNOWLEDGED_MAX = 500;

/** Built from the vocabulary, so a new reason cannot leave the message stale. */
const REASON_MESSAGE = `must be one of: ${Object.values(BLOCK_REASON).join(', ')}`;


/**
 * Collects problems so every fault in a form is reported at once.
 *
 * A copy of the collector in venueValidation.js and eventRequestValidation.js,
 * for the reason eventRequestValidation.js gives: extracting a shared helper
 * is a separate refactor, not something to fold into a feature story.
 */
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

  throw new ValidationError(`Invalid venue block details -- ${summary}`, errors.details);
}


/**
 * Optional notes: trimmed, blank becomes null, at most 1000 characters.
 *
 * Length is counted in code points (Array.from), not UTF-16 units
 * (String.length), because that is what Postgres length() counts. With
 * .length an emoji counts twice, so 600 emoji would be refused here while the
 * column happily stores them.
 *
 * @returns {{notes: string|null, wasText: boolean}} wasText is false when a
 *          non-string was refused, so the "other needs notes" rule can stay
 *          quiet instead of naming the same fault twice
 */
function checkNotes(errors, value) {
  if (value === undefined || value === null) return { notes: null, wasText: true };

  if (typeof value !== 'string') {
    errors.add('notes', 'must be text');
    return { notes: null, wasText: false };
  }

  const trimmed = value.trim();
  if (trimmed === '') return { notes: null, wasText: true };

  if (Array.from(trimmed).length > NOTES_MAX_LENGTH) {
    errors.add('notes', `must be ${NOTES_MAX_LENGTH} characters or fewer`);
  }

  return { notes: trimmed, wasText: true };
}


/**
 * Optional confirmOverride: a real boolean, defaulting to false.
 *
 * No coercion -- "true" or 1 is refused, because an override is the one field
 * here whose meaning is "yes, flag those bookings", and a guessed yes is worse
 * than a readable fault.
 *
 * @returns {boolean|null} null when refused
 */
function checkConfirmOverride(errors, value) {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') {
    errors.add('confirmOverride', 'must be true or false');
    return null;
  }
  return value;
}

/**
 * Optional acknowledgedBookingIds: an array of booking uuids.
 *
 * Lowercased, because Postgres prints uuids in lower case and the frontend
 * compares what it sent against what came back; de-duplicated keeping
 * first-seen order, so the RPC gets each id once. A non-uuid is reported once
 * however many there are -- one fault, one message.
 *
 * @returns {string[]|null} null when refused
 */
function checkAcknowledgedIds(errors, value) {
  if (value === undefined || value === null) return [];

  if (!Array.isArray(value)) {
    errors.add('acknowledgedBookingIds', 'must be a list of booking ids');
    return null;
  }

  let ok = true;

  if (value.some((id) => typeof id !== 'string' || !UUID_PATTERN.test(id))) {
    errors.add('acknowledgedBookingIds', 'must contain only booking ids');
    ok = false;
  }

  if (value.length > ACKNOWLEDGED_MAX) {
    errors.add('acknowledgedBookingIds', `must list ${ACKNOWLEDGED_MAX} bookings or fewer`);
    ok = false;
  }

  if (!ok) return null;

  return [...new Set(value.map((id) => id.toLowerCase()))];
}

/**
 * The override fields together: each checked, then the pairing rules.
 *
 * Shared by create and update (SCRUM-127) so the gate's input has one
 * definition. The pairing rules run only when both fields were themselves
 * well formed, so a single fault is not reported twice.
 *
 * @returns {{confirmOverride: boolean, acknowledgedBookingIds: string[]}}
 *          false and [] in place of a refused field
 */
function checkOverride(errors, input) {
  const confirmOverride = checkConfirmOverride(errors, input.confirmOverride);
  const acknowledgedBookingIds = checkAcknowledgedIds(errors, input.acknowledgedBookingIds);

  if (confirmOverride !== null && acknowledgedBookingIds !== null) {
    if (confirmOverride && acknowledgedBookingIds.length === 0) {
      errors.add('acknowledgedBookingIds', 'must list the bookings being overridden');
    } else if (!confirmOverride && acknowledgedBookingIds.length > 0) {
      errors.add('acknowledgedBookingIds', 'can only be sent with confirmOverride');
    }
  }

  return {
    confirmOverride: confirmOverride ?? false,
    acknowledgedBookingIds: acknowledgedBookingIds ?? [],
  };
}

/**
 * Validate input for creating a venue block.
 *
 * `now` is injected so the future-end rule is deterministic. A check written
 * against the real clock would pass today and fail tomorrow; callers in
 * production simply omit it.
 *
 * @param {object} input
 * @param {string} input.startsAt  ISO 8601 with an offset
 * @param {string} input.endsAt    ISO 8601 with an offset
 * @param {string} input.reason    one of BLOCK_REASON
 * @param {string} [input.notes]   required when reason is 'other'
 * @param {boolean} [input.confirmOverride]  SCRUM-125: override approved
 *                                  bookings; requires acknowledgedBookingIds
 * @param {string[]} [input.acknowledgedBookingIds]  SCRUM-125: the bookings
 *                                  being overridden; requires confirmOverride
 * @param {object} [options]
 * @param {Date} [options.now]     the instant to judge "future" against
 * @returns {{startsAt: string, endsAt: string, reason: string, notes: string|null,
 *            confirmOverride: boolean, acknowledgedBookingIds: string[]}}
 * @throws {ValidationError} listing every problem found, not just the first
 */
export function validateCreateBlock(input, { now = new Date() } = {}) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('Invalid venue block details -- expected an object');
  }

  const errors = createErrorCollector();
  const normalised = {};
  const instants = {};

  for (const field of TIMESTAMP_FIELDS) {
    const value = input[field];

    if (value === undefined || value === null) {
      errors.add(field, 'is required');
      normalised[field] = null;
      continue;
    }

    const instant = checkTimestamp(errors, field, value);
    if (instant === null) {
      normalised[field] = null;
    } else {
      instants[field] = instant;
      // Passed on as written, trimmed -- the column is timestamptz, so Postgres
      // is the authority on resolving the offset.
      normalised[field] = value.trim();
    }
  }

  // Only once both ends parsed: a backwards period is not worth naming when
  // one end is missing, because that is the fault the user can act on.
  if (
    instants.startsAt !== undefined &&
    instants.endsAt !== undefined &&
    instants.endsAt <= instants.startsAt
  ) {
    errors.add('endsAt', 'must be later than the start');
  }

  // Strictly later than now. A block that has already ended blocks nothing.
  if (instants.endsAt !== undefined && instants.endsAt <= now) {
    errors.add('endsAt', 'must be in the future');
  }

  const reason = input.reason;
  if (reason === undefined || reason === null) {
    errors.add('reason', 'is required');
    normalised.reason = null;
  } else if (!isBlockReason(reason)) {
    errors.add('reason', REASON_MESSAGE);
    normalised.reason = null;
  } else {
    normalised.reason = reason;
  }

  const { notes, wasText } = checkNotes(errors, input.notes);
  normalised.notes = notes;

  // Mirrors venue_blocks_other_needs_notes in 011. Skipped when notes were not
  // text at all, which has already been reported.
  if (normalised.reason === BLOCK_REASON.OTHER && notes === null && wasText) {
    errors.add('notes', 'is required when the reason is other');
  }

  // SCRUM-125.
  Object.assign(normalised, checkOverride(errors, input));

  throwIfInvalid(errors);
  return normalised;
}

/**
 * Validate a block id before it reaches the database.
 *
 * The venue id beside it goes through validateVenueId in venueValidation.js.
 *
 * @param {string} id
 * @returns {string} the id, unchanged
 * @throws {ValidationError}
 */
export function validateBlockId(id) {
  const errors = createErrorCollector();

  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    errors.add('blockId', 'must be a block id');
  }

  throwIfInvalid(errors);
  return id;
}


/**
 * Validate input for amending a venue block (SCRUM-127, AC4).
 *
 * A patch. An omitted startsAt, endsAt or reason comes back null, meaning
 * "keep the stored value", which update_venue_block (015) reads as such.
 * Notes need notesSupplied beside them, because for notes null is also a real
 * value: a null or blank notes clears them, while omitting notes keeps them.
 *
 * `now` is injected for the reason validateCreateBlock gives.
 *
 * @param {object} input
 * @param {string} [input.startsAt]  ISO 8601 with an offset
 * @param {string} [input.endsAt]    ISO 8601 with an offset; must be ahead of now
 * @param {string} [input.reason]    one of BLOCK_REASON
 * @param {string|null} [input.notes]  null or blank clears them
 * @param {boolean} [input.confirmOverride]  as for validateCreateBlock
 * @param {string[]} [input.acknowledgedBookingIds]  as for validateCreateBlock
 * @param {object} [options]
 * @param {Date} [options.now]       the instant to judge "future" against
 * @returns {{startsAt: string|null, endsAt: string|null, reason: string|null,
 *            notes: string|null, notesSupplied: boolean,
 *            confirmOverride: boolean, acknowledgedBookingIds: string[]}}
 * @throws {ValidationError} listing every problem found, not just the first
 */
export function validateUpdateBlock(input, { now = new Date() } = {}) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('Invalid venue block details -- expected an object');
  }

  // The override fields do not count: an override-only body names nothing to
  // amend. Unknown keys do not count either, so {userId} alone is refused.
  // Same wording as validateUpdateVenue, so "nothing to do" is one message.
  if (!PATCH_FIELDS.some((field) => input[field] !== undefined)) {
    throw new ValidationError('Invalid venue block details -- no changes supplied');
  }

  const errors = createErrorCollector();
  const normalised = {};
  const instants = {};

  for (const field of TIMESTAMP_FIELDS) {
    const value = input[field];

    if (value === undefined) {
      normalised[field] = null;
      continue;
    }

    // Null is refused rather than read as "keep". The columns are not null,
    // so a client sending null is asking for something that cannot exist,
    // and telling it so beats quietly keeping a value it meant to change.
    if (value === null) {
      errors.add(field, 'cannot be cleared');
      normalised[field] = null;
      continue;
    }

    const instant = checkTimestamp(errors, field, value);
    if (instant === null) {
      normalised[field] = null;
    } else {
      instants[field] = instant;
      normalised[field] = value.trim();
    }
  }

  // Only when both were sent. With one, the other side is the stored value,
  // which update_venue_block checks on the merged row.
  if (
    instants.startsAt !== undefined &&
    instants.endsAt !== undefined &&
    instants.endsAt <= instants.startsAt
  ) {
    errors.add('endsAt', 'must be later than the start');
  }

  // As on create: a new start may be in the past, a new end may not.
  if (instants.endsAt !== undefined && instants.endsAt <= now) {
    errors.add('endsAt', 'must be in the future');
  }

  const reason = input.reason;
  if (reason === undefined) {
    normalised.reason = null;
  } else if (reason === null) {
    errors.add('reason', 'cannot be cleared');
    normalised.reason = null;
  } else if (!isBlockReason(reason)) {
    errors.add('reason', REASON_MESSAGE);
    normalised.reason = null;
  } else {
    normalised.reason = reason;
  }

  // checkNotes already turns null and blank into null, which here means
  // "clear" -- so notesSupplied is what separates clearing from keeping.
  const notesSupplied = input.notes !== undefined;
  const { notes, wasText } = checkNotes(errors, input.notes);
  normalised.notes = notes;
  normalised.notesSupplied = notesSupplied;

  // Only when both halves are in this request: reason other with notes being
  // cleared. Other with notes omitted is left to update_venue_block, because
  // only it can see whether the stored notes are blank.
  if (
    normalised.reason === BLOCK_REASON.OTHER &&
    notesSupplied &&
    notes === null &&
    wasText
  ) {
    errors.add('notes', 'is required when the reason is other');
  }

  // The same override rules as validateCreateBlock: an amendment that widens
  // the period over approved bookings faces the same gate (015).
  Object.assign(normalised, checkOverride(errors, input));

  throwIfInvalid(errors);
  return normalised;
}


/**
 * Validate the optional window a venue's blocks are read through (SCRUM-130).
 *
 * Both ends or neither. A block overlapping the window is in it; one that
 * only touches its edge is not -- the service applies that, this checks the
 * window itself.
 *
 * @param {object} [window]
 * @param {string} [window.from]  ISO 8601 with an offset
 * @param {string} [window.to]    ISO 8601 with an offset; later than from, and
 *                                within BLOCK_WINDOW_MAX_DAYS of it
 * @returns {{from: string, to: string}|null} null when neither was given
 * @throws {ValidationError} listing every problem found
 */
export function validateBlockWindow({ from, to } = {}) {
  const errors = createErrorCollector();
  const window = checkTimeWindow(errors, ['from', 'to'], from, to, {
    maxDays: BLOCK_WINDOW_MAX_DAYS,
  });

  throwIfInvalid(errors);
  return window === null ? null : { from: window.start, to: window.end };
}

/**
 * Validate a period that must be given in full (SCRUM-130).
 *
 * Written for findBlockedVenueIds, which SCRUM-484 replaced with
 * available_venue_ids(); kept as the full-period check for any read that
 * needs one. Unlike a search or calendar window
 * there is no "no period" here: asking which venues are blocked during nothing
 * is a caller bug, so neither end given reports both as required. No cap --
 * how long an event may run is SCRUM-20's rule, not this one's.
 *
 * @param {object} [period]
 * @param {string} [period.startsAt]  ISO 8601 with an offset
 * @param {string} [period.endsAt]    ISO 8601 with an offset; later than startsAt
 * @returns {{startsAt: string, endsAt: string}}
 * @throws {ValidationError} listing every problem found
 */
export function validatePeriod({ startsAt, endsAt } = {}) {
  const errors = createErrorCollector();
  const window = checkTimeWindow(errors, TIMESTAMP_FIELDS, startsAt, endsAt);

  // null with nothing recorded means neither end was given.
  if (window === null && !errors.hasErrors) {
    errors.add('startsAt', 'is required');
    errors.add('endsAt', 'is required');
  }

  throwIfInvalid(errors);
  return { startsAt: window.start, endsAt: window.end };
}
