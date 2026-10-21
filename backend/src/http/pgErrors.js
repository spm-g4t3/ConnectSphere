/**
 * Turning a Postgres or PostgREST error into one of the typed errors in
 * errors.js.
 *
 * Every service maps SQLSTATEs a little differently (40001 is BOOKING_CHANGED
 * in one, a plain conflict in another), so there is no one map. Each service
 * builds its own translator from the handlers here, listing only the codes it
 * expects; anything it does not list stays an untyped Error, a 500.
 *
 * Pure: imports only the error classes and the id shape, so it never reaches
 * the Supabase client.
 */

import { ValidationError, NotFoundError, ConflictError, ForbiddenError } from '../errors.js';
// The shape gen_random_uuid() produces; the only id trusted out of DETAIL.
import { UUID_PATTERN } from '../validation/ids.js';

/** A table, column or function the API expects is missing: the schema, not the caller. */
export const SCHEMA_MISSING_CODES = ['42P01', '42703', 'PGRST202', 'PGRST204', 'PGRST205'];

/**
 * Handlers take (detail, error): detail is the error's message, and error is
 * the raw one, for the hint and details.
 */

/** A driver message, wrapped because it was written for a developer. */
export const rejected = (detail) => new ValidationError(`A value was rejected by the database: ${detail}`);

/** Our own function's message, passed through because it was written to be read. */
export const invalid = (detail) => new ValidationError(detail);

export const forbidden = (detail) => new ForbiddenError(detail);

export const missingReference = (detail) =>
  new ValidationError(`A referenced record does not exist: ${detail}`);

export const untyped = (detail) => new Error(detail || 'Unexpected database error');

export function notFound(fallbackMessage) {
  return (detail) => new NotFoundError(detail || fallbackMessage);
}

export function conflict(code = null) {
  return (detail) => new ConflictError(detail, { code });
}

/**
 * PT409: the hint is the conflict's code. For the hints in conflictFor, DETAIL
 * names the clashing record, and conflictFor[hint](id) builds its entry; only
 * a uuid is trusted there, so anything else leaves the list empty.
 */
export function hintConflict(conflictFor = {}) {
  return (detail, error) => {
    const hint = error.hint ?? null;
    const id = typeof error.details === 'string' ? error.details.trim() : '';
    const conflicts =
      Object.hasOwn(conflictFor, hint) && UUID_PATTERN.test(id) ? [conflictFor[hint](id)] : [];
    return new ConflictError(detail, { code: hint, conflicts });
  };
}

/** One handler for several codes, to spread into a codes map. */
export function forCodes(codes, handler) {
  return Object.fromEntries([...codes].map((code) => [code, handler]));
}

/**
 * Build a translator. The code decides first; only when no code matches are
 * the message patterns tried, in order, and then the fallback.
 *
 * @param {object} config
 * @param {object} [config.codes]          SQLSTATE -> handler
 * @param {Array}  [config.messages]       [pattern, handler] pairs
 * @param {Function} [config.fallback]     defaults to untyped
 * @param {string} [config.missingMessage] detail when the error has no message
 * @returns {(error: object) => Error|null}
 */
export function createPgTranslator({
  codes = {},
  messages = [],
  fallback = untyped,
  missingMessage = '',
} = {}) {
  return function translateError(error) {
    if (!error) return null;

    const detail = error.message ?? missingMessage;
    if (Object.hasOwn(codes, error.code)) return codes[error.code](detail, error);

    for (const [pattern, handler] of messages) {
      if (pattern.test(detail)) return handler(detail, error);
    }
    return fallback(detail, error);
  };
}
