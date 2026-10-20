/**
 * What Venue Staff send to resolve a booking flagged for review, and which
 * event a coordinator lists the flagged bookings of.
 *
 * A flagged booking is a booking row, so its id is checked as a booking
 * request's is. The reason is required and capped as the database caps it.
 */

import { ValidationError } from '../errors.js';
import { isPlausibleId } from './ids.js';
import { createErrorCollector, throwIfInvalid, checkOptionalText } from './collector.js';

export { validateBookingRequestId as validateFlaggedBookingId } from './bookingRequestValidation.js';

/**
 * The event whose flagged bookings a coordinator lists, shaped like an id so a
 * value that can never match one costs no round trip.
 *
 * @param {*} id
 * @returns {string} the id, trimmed and lower-cased
 * @throws {ValidationError}
 */
export function validateFlaggedBookingEventId(id) {
  if (!isPlausibleId(id)) {
    throw new ValidationError('Invalid event request id', [
      { field: 'eventRequestId', message: 'must be a valid event request id' },
    ]);
  }
  return id.trim().toLowerCase();
}

/** Mirrors the 1000-character cap 076 puts on booking_resolutions.reason. */
export const RESOLUTION_REASON_MAX_LENGTH = 1000;

/**
 * @param {object} input
 * @param {string} input.reason  why the flag is resolved this way
 * @returns {{reason: string}} trimmed
 * @throws {ValidationError} listing every problem found
 */
export function validateResolution(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('Invalid resolution -- expected an object');
  }

  const errors = createErrorCollector();

  const reason = checkOptionalText(errors, 'reason', input.reason, RESOLUTION_REASON_MAX_LENGTH);
  // checkOptionalText reads blank as absent; for the reason, absent is the error.
  if (reason === null && !errors.hasErrors) {
    errors.add('reason', 'is required');
  }

  throwIfInvalid(errors, 'Invalid resolution');

  return { reason };
}
