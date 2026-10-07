/**
 * The three results of an equipment availability check, and how one is chosen.
 *
 * SCRUM-23 (AC8). The labels are exact strings because the review of an
 * equipment request (SCRUM-290) and the equipment notifications (SCRUM-176)
 * reuse them: change one here and every reader changes with it.
 */

export const AVAILABILITY_RESULT = Object.freeze({
  FULLY_AVAILABLE: 'Fully available',
  PARTIALLY_AVAILABLE: 'Partially available',
  UNAVAILABLE: 'Unavailable',
});

/** AC11: said in place of a breakdown when the type cannot be used. */
export const NOT_FOUND_MESSAGE = 'The equipment type was not found.';
export const RETIRED_MESSAGE = 'The equipment type is retired.';

/**
 * Which result a figure gives.
 *
 * Fully available when the quantity available is at least the quantity
 * requested, Partially available when it is above zero but short, Unavailable
 * when it is zero. The figure may be negative (an over-committed type); that
 * is Unavailable too.
 *
 * @param {number} available  the quantity available, floored or not
 * @param {number} requested  a whole number above zero
 * @returns {string} one of AVAILABILITY_RESULT
 */
export function deriveAvailabilityResult(available, requested) {
  if (available >= requested) return AVAILABILITY_RESULT.FULLY_AVAILABLE;
  if (available > 0) return AVAILABILITY_RESULT.PARTIALLY_AVAILABLE;
  return AVAILABILITY_RESULT.UNAVAILABLE;
}
