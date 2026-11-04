/**
 * Input validation for an equipment availability check.
 *
 * SCRUM-23 (AC2): the check takes an equipment type, a quantity and a period.
 * The quantity must be a whole number above zero and the end must be after the
 * start; otherwise the check is refused and every invalid input is listed.
 * An event request id is optional (AC7): given, that event's own reservations
 * are left out of the count.
 *
 * Pure and synchronous. The period's timestamps are judged by
 * timestampValidation.js, the same rules the venue block window uses, so an
 * offset-less or date-only value is refused rather than guessed at.
 */

import { ValidationError } from '../errors.js';
import { UUID_PATTERN } from './ids.js';
import { MAX_INTEGER } from './limits.js';
import { createErrorCollector, throwIfInvalid } from './collector.js';
import { checkTimeWindow } from './timestampValidation.js';

/** The largest value an integer column holds. */
export const MAX_QUANTITY = MAX_INTEGER;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isBlank = (value) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/**
 * @param {unknown} input  { equipmentTypeId, quantity, startAt, endAt, eventRequestId? }
 * @returns {{equipmentTypeId: string, quantity: number, startAt: string, endAt: string, eventRequestId: string|null}}
 * @throws {ValidationError} listing every invalid input, before any query
 */
export function validateAvailabilityRequest(input) {
  if (!isObject(input)) {
    throw new ValidationError('Invalid availability check -- request: must be an object', [
      { field: 'request', message: 'must be an object' },
    ]);
  }

  const errors = createErrorCollector();

  let equipmentTypeId = null;
  if (isBlank(input.equipmentTypeId)) {
    errors.add('equipmentTypeId', 'is required');
  } else if (typeof input.equipmentTypeId !== 'string' || !UUID_PATTERN.test(input.equipmentTypeId.trim())) {
    errors.add('equipmentTypeId', 'must be a UUID');
  } else {
    equipmentTypeId = input.equipmentTypeId.trim();
  }

  const { quantity } = input;
  if (quantity === undefined || quantity === null) {
    errors.add('quantity', 'is required');
  } else if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    errors.add('quantity', `must be a whole number greater than zero, and no larger than ${MAX_QUANTITY}`);
  }

  // The period is required, which checkTimeWindow's "both or neither" is not:
  // naming neither is a fault here, not an absent window.
  let window = null;
  if (isBlank(input.startAt) && isBlank(input.endAt)) {
    errors.add('startAt', 'is required');
    errors.add('endAt', 'is required');
  } else {
    window = checkTimeWindow(errors, ['startAt', 'endAt'], input.startAt, input.endAt);
  }

  let eventRequestId = null;
  if (!isBlank(input.eventRequestId)) {
    if (typeof input.eventRequestId !== 'string' || !UUID_PATTERN.test(input.eventRequestId.trim())) {
      errors.add('eventRequestId', 'must be a UUID');
    } else {
      eventRequestId = input.eventRequestId.trim();
    }
  }

  throwIfInvalid(errors, 'Invalid availability check');

  return { equipmentTypeId, quantity, startAt: window.start, endAt: window.end, eventRequestId };
}
