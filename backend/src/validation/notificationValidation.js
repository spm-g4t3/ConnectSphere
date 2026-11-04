/**
 * Notification input validation.
 *
 * SCRUM-128, a subtask of SCRUM-17 (Block a Venue for Unavailability).
 *
 * The only input a notification route reads is the id in PATCH /:id/read, so
 * this module checks that one value. Pure and synchronous, like the other
 * validators, so it is unit-testable without credentials.
 *
 * Checked here rather than left to the database: a malformed id would reach
 * Postgres as a uuid cast and come back as 22P02, which the service would have
 * to translate. Refusing it before the round trip gives a readable 400 and
 * costs no network call.
 */

import { ValidationError } from '../errors.js';
import { UUID_PATTERN } from './ids.js';

/**
 * Validate a notification id before it reaches the database.
 *
 * Mirrors validateBlockId in venueBlockValidation.js: the same message shape
 * and a details entry naming the field, so a client handles every id error
 * the same way.
 *
 * @param {string} id
 * @returns {string} the id, unchanged
 * @throws {ValidationError}
 */
export function validateNotificationId(id) {
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    const details = [{ field: 'notificationId', message: 'must be a notification id' }];
    throw new ValidationError(
      'Invalid notification details -- notificationId: must be a notification id',
      details,
    );
  }

  return id;
}
