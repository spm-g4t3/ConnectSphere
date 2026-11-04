/**
 * Places left and fullness, pure so SCRUM-22 can share one definition of a
 * current registration. Only 'registered' holds a place; the list is advisory.
 */
import { REGISTRATION_STATUS } from './registrationStatus.js';

export const ACTIVE_REGISTRATION_STATUS = REGISTRATION_STATUS.REGISTERED;

/** @param {{status?: string}} registration */
export function holdsAPlace(registration) {
  return registration?.status === ACTIVE_REGISTRATION_STATUS;
}

/**
 * @param {number|null|undefined} capacity  null or undefined means no limit
 * @param {number} activeCount              registrations that hold a place
 * @returns {{placesLeft: number|null, isFull: boolean}}
 *   placesLeft is null for no limit, otherwise never below zero: an event
 *   over capacity (the organiser lowered it after people registered) reads as
 *   0 left, not as a negative number.
 */
export function availability(capacity, activeCount) {
  if (capacity === null || capacity === undefined) {
    return { placesLeft: null, isFull: false };
  }

  const placesLeft = Math.max(0, Number(capacity) - activeCount);
  return { placesLeft, isFull: placesLeft === 0 };
}
