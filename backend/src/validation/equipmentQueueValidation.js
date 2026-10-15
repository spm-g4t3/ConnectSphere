/**
 * Input validation for the equipment request queue.
 *
 * SCRUM-285, for SCRUM-284. The queue reads two optional query parameters:
 *
 *   status        one of the five equipment request statuses (AC2)
 *   includePast   "true" or "false": also list events that have ended (AC2)
 *
 * Pure and synchronous. A value that is present and wrong is refused with a 400
 * that names it, never ignored: a mistyped "status=arrange" quietly returning
 * every request would look like a filter that found nothing wrong. Every fault
 * is reported at once.
 */

import { EQUIPMENT_REQUEST_STATUS } from '../domain/equipmentRequestStatus.js';
import { throwIfInvalid } from './equipmentLineValidation.js';

export { throwIfInvalid };

const STATUSES = Object.values(EQUIPMENT_REQUEST_STATUS);

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A value that is absent or an empty string means "not given". */
const isGiven = (value) => value !== undefined && value !== '';

/**
 * @param {unknown} query  req.query
 * @returns {{value: {status: string|null, includePast: boolean}|null,
 *            details: Array<{field: string, message: string}>}}
 *   value is only safe to use when details is empty
 */
export function checkQueueQuery(query) {
  const details = [];
  const input = isObject(query) ? query : {};

  let status = null;
  if (isGiven(input.status)) {
    if (typeof input.status !== 'string' || !STATUSES.includes(input.status)) {
      details.push({ field: 'status', message: `must be one of: ${STATUSES.join(', ')}` });
    } else {
      status = input.status;
    }
  }

  let includePast = false;
  if (isGiven(input.includePast)) {
    if (input.includePast === 'true') includePast = true;
    else if (input.includePast !== 'false') {
      details.push({ field: 'includePast', message: 'must be true or false' });
    }
  }

  return details.length > 0
    ? { value: null, details }
    : { value: { status, includePast }, details: [] };
}
