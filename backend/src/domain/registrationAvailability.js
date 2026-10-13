/**
 * How many places an event has left, and whether it can still be registered for.
 *
 * SCRUM-495 (AC3). Pure data and pure functions, no imports, so SCRUM-22 can
 * share one definition of "current registration" and "full".
 *
 * Assumption, because no registrations table exists yet (SCRUM-22, SCRUM-27;
 * the cancellation migrations 042-048 on dev say so in as many words): a
 * registration row carries a status, and only 'registered' holds a place.
 * 'withdrawn' (SCRUM-27) and 'cancelled' free it, and so does any status this
 * file does not know, which is the reading a browse list can afford: the list
 * is advisory, and SCRUM-22 re-checks capacity and duplicates under a lock.
 * When SCRUM-22 fixes the real vocabulary, ACTIVE_REGISTRATION_STATUS is the
 * one place to change.
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
