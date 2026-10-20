/**
 * The error collector the form validators share, so every fault in a form is
 * reported at once, as one ValidationError.
 */

import { ValidationError } from '../errors.js';

/** Collects problems so every fault in a form is reported at once. */
export function createErrorCollector() {
  const details = [];
  return {
    add: (field, message) => details.push({ field, message }),
    details,
    get hasErrors() {
      return details.length > 0;
    },
  };
}

/**
 * Throw one ValidationError carrying every collected problem, if there are any.
 * The label opens the message, so each form keeps its own prefix.
 *
 * @param {{details: Array<{field: string, message: string}>}} errors
 * @param {string} label  e.g. 'Invalid venue details'
 */
export function throwIfInvalid(errors, label) {
  if (errors.details.length === 0) return;

  const summary = errors.details
    .map(({ field, message }) => `${field}: ${message}`)
    .join('; ');

  throw new ValidationError(`${label} -- ${summary}`, errors.details);
}

/** Optional text: trimmed, blank becomes null. Length counts code points, as Postgres does. */
export function checkOptionalText(errors, field, value, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    errors.add(field, 'must be text');
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (Array.from(trimmed).length > max) {
    errors.add(field, `must be ${max} characters or fewer`);
    return null;
  }
  return trimmed;
}
