/**
 * How many places an event has left, and whether it is full. Pure, so SCRUM-22
 * can share one definition of a current registration.
 *
 * Assumes a registration has a status and only 'registered' holds a place;
 * anything else frees it. The list is advisory (SCRUM-22 re-checks under a
 * lock), so ACTIVE_REGISTRATION_STATUS is the one place to change.
 */
export const ACTIVE_REGISTRATION_STATUS = 'registered';

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
