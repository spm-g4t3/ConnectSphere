/**
 * The shape of a row id, shared by every validator and service that checks one.
 *
 * Pure: imports only the error type, so a service can use it without reaching
 * a validator.
 */

import { ValidationError } from '../errors.js';

/**
 * Loose enough to accept any real UUID (v1-v5) without pinning to Postgres's v4 default.
 * A malformed id would otherwise reach Postgres as a 22P02 cast error and surface as a 500.
 */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this value at least shaped like an id, once trimmed? Checked before any
 * network round trip: a value that is not id-shaped can never name a row.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isPlausibleId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value.trim());
}

/**
 * A caller's own id, from the token, must be present. A missing one is the
 * caller's bug, not the user's, so the message names the parameter.
 *
 * @param {*} value
 * @param {string} field  the parameter's name, e.g. 'coordinatorId'
 * @returns {string} the value, unchanged
 * @throws {ValidationError} `${field} is required`
 */
export function requireCallerId(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} is required`);
  }
  return value;
}
