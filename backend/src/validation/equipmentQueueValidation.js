/**
 * Validation for the equipment request queue's query: an optional status, and
 * includePast ("true" or "false").
 *
 * Pure and synchronous. A value that is present and wrong is refused with a 400
 * that names it, never ignored, and every fault is reported at once.
 */

import { EQUIPMENT_REQUEST_STATUS } from '../domain/equipmentRequestStatus.js';

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
