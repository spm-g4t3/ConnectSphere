/**
 * Validation for placing a tentative venue hold.
 *
 * SCRUM-491 (Place a Tentative Venue Hold with Expiry - Venue Staff).
 *
 * What the caller sends is only what Venue Staff choose: which event, and when
 * the hold expires (AC2). The venue comes from the path, the placer from the
 * token, the period from the stored event, and the status is always active. A
 * body that names any of those is not an error; the fields are never read.
 *
 * The expiry obeys the same wire contract as every other instant in the API
 * (timestampValidation.js): a real date, a time of day and an explicit offset.
 * It must also be in the future. place_venue_hold (040) checks that again
 * against the database clock, which is the answer that counts; this check
 * saves the round trip and names the field.
 *
 * A pure module, with no database access.
 */

import { ValidationError } from '../errors.js';
import { isPlausibleId } from './ids.js';
import { createErrorCollector, throwIfInvalid } from './collector.js';
import { checkTimestamp } from './timestampValidation.js';

/** A required id, shaped like one; trimmed and lower-cased. */
function checkId(errors, field, label, value) {
  if (value === undefined || value === null || value === '') {
    errors.add(field, 'is required');
    return null;
  }
  if (!isPlausibleId(value)) {
    errors.add(field, `must be a valid ${label} id`);
    return null;
  }
  return value.trim().toLowerCase();
}

/**
 * Which venue, or which event, must at least be shaped like an id, so a value
 * that can never match one costs no round trip.
 *
 * @param {*} id
 * @param {string} [field]  the name the fault is reported under
 * @param {string} [label]  what kind of id, for the message
 * @returns {string} the id, trimmed and lower-cased
 * @throws {ValidationError}
 */
export function validateHoldTargetId(id, field = 'id', label = 'venue') {
  const errors = createErrorCollector();
  const value = checkId(errors, field, label, id);
  throwIfInvalid(errors, `Invalid ${label} id`);
  return value;
}

/**
 * Validate input for placing a hold.
 *
 * @param {object} input
 * @param {string} input.eventRequestId  the Approved event the hold is for
 * @param {string} input.expiresAt       ISO 8601 with an offset, in the future
 * @param {Date} [now]                   the clock, for tests
 * @returns {{eventRequestId: string, expiresAt: string}} the expiry trimmed,
 *          as written; Postgres resolves the offset
 * @throws {ValidationError} listing every problem found, not just the first
 */
export function validatePlaceVenueHold(input, now = new Date()) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('Invalid venue hold -- expected an object');
  }

  const errors = createErrorCollector();

  const eventRequestId = checkId(errors, 'eventRequestId', 'event', input.eventRequestId);

  let expiresAt = null;
  if (input.expiresAt === undefined || input.expiresAt === null || input.expiresAt === '') {
    errors.add('expiresAt', 'is required');
  } else {
    const instant = checkTimestamp(errors, 'expiresAt', input.expiresAt);
    if (instant !== null) {
      if (instant.getTime() <= now.getTime()) {
        errors.add('expiresAt', 'must be in the future');
      } else {
        expiresAt = input.expiresAt.trim();
      }
    }
  }

  throwIfInvalid(errors, 'Invalid venue hold');
  return { eventRequestId, expiresAt };
}
