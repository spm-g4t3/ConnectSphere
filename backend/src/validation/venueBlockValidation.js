/**
 * Venue block input validation.
 *
 * SCRUM-126, a subtask of SCRUM-17 (Block a Venue for Unavailability).
 *
 * AC1: a block is created with a venue, a start and end date and time, and a
 * reason category. This module says, in words a Venue Staff member can act
 * on, what is wrong with a block before it reaches the database. The database
 * is still the guarantee: 010_venue_blocks.sql carries the same ordering,
 * "other needs notes" and notes-length constraints, and create_venue_block
 * (011) re-checks the period and the overlap inside its own transaction. The
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
 *  - Overlap with another block, or with approved bookings. The first is the
 *    RPC's job for the same reason; the second is SCRUM-125.
 *  - Whether the start is in the past. A block may start in the past -- staff
 *    record a closure that has already begun -- so only the end has to be
 *    ahead of now.
 *  - Unknown keys. They are ignored silently, as both existing validators do.
 */

import { ValidationError } from '../errors.js';
import { BLOCK_REASON, isBlockReason } from '../domain/venueBlockReason.js';
import { checkTimestamp } from './timestampValidation.js';

/** The shape gen_random_uuid() produces, which is what venue_blocks.id holds. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TIMESTAMP_FIELDS = ['startsAt', 'endsAt'];

/** Mirrors venue_blocks_notes_length in 010. */
const NOTES_MAX_LENGTH = 1000;

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
 * @param {object} [options]
 * @param {Date} [options.now]     the instant to judge "future" against
 * @returns {{startsAt: string, endsAt: string, reason: string, notes: string|null}}
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

  // Mirrors venue_blocks_other_needs_notes in 010. Skipped when notes were not
  // text at all, which has already been reported.
  if (normalised.reason === BLOCK_REASON.OTHER && notes === null && wasText) {
    errors.add('notes', 'is required when the reason is other');
  }

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
