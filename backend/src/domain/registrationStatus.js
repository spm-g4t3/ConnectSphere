/**
 * Attendee registration status vocabulary: the values of event_registrations.status.
 *
 * Mirrors the CHECK constraint event_registrations_status_known
 * (baseline/08_registration.sql), in the same order; a test asserts the match.
 * Only REGISTERED holds a place (registrationAvailability.js). WAITLISTED is
 * queued for one, WITHDRAWN gave one up (and may register or queue again), and
 * CANCELLED is final.
 *
 * Deliberately free of imports, database calls and framework code, the same
 * shape as domain/venueHoldStatus.js.
 */

export const REGISTRATION_STATUS = Object.freeze({
  REGISTERED: 'registered',
  WITHDRAWN: 'withdrawn',
  WAITLISTED: 'waitlisted',
  CANCELLED: 'cancelled',
});

const BY_VALUE = Object.freeze(
  Object.fromEntries(Object.values(REGISTRATION_STATUS).map((value) => [value, true])),
);

/**
 * Is this a status the database will accept for a registration?
 * Object.hasOwn, so an inherited name such as 'toString' is refused.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isRegistrationStatus(value) {
  return typeof value === 'string' && Object.hasOwn(BY_VALUE, value);
}
