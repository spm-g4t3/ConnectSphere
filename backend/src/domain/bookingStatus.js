/**
 * Booking status vocabulary.
 *
 * SCRUM-17 (AC3): a venue block only conflicts with *approved* bookings, so a
 * booking needs a status to say whether it is one.
 *
 * SCRUM-250: a venue booking request is a booking in the pending, rejected or
 * withdrawn state, so those three are part of the same vocabulary. SCRUM-261
 * adds conflicting: still open, but another event's overlapping request was
 * approved.
 *
 * Mirrors the Postgres enum `booking_status` exactly, in the same order: 011
 * creates it, 027_booking_request_statuses.sql appends the request statuses
 * and 065_booking_decision_statuses.sql appends conflicting. These two lists
 * must stay identical -- a test asserts the match.
 *
 * Deliberately free of imports, database calls and framework code -- pure data
 * and pure functions, the same shape as domain/userRole.js.
 */

export const BOOKING_STATUS = Object.freeze({
  APPROVED: 'approved',
  FLAGGED_FOR_REVIEW: 'flagged_for_review',
  CANCELLED: 'cancelled',
  PENDING: 'pending',
  REJECTED: 'rejected',
  WITHDRAWN: 'withdrawn',
  CONFLICTING: 'conflicting',
});

// Keyed by value, so the membership check below is a single own-property test.
const BY_VALUE = Object.freeze(
  Object.fromEntries(Object.values(BOOKING_STATUS).map((value) => [value, true])),
);

/**
 * Is this a status the database will accept for a booking?
 *
 * Object.hasOwn rather than a plain lookup, so an inherited key such as
 * 'toString' is not mistaken for a status.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isBookingStatus(value) {
  return typeof value === 'string' && Object.hasOwn(BY_VALUE, value);
}

/**
 * SCRUM-255: how a booking status reads to the coordinator who raised it, and
 * the group a screen colours it by.
 *
 * The same arrangement as eventRequestStatus.js: the API sends this as
 * `statusDisplay` on every booking request, so the labels have one definition
 * and the frontend keeps no copy of the list. Groups are the stable half of
 * the contract; a screen maps a group to a style.
 *
 * The labels are the story's own words (Pending, Rejected, Withdrawn). Two
 * differ from the raw value: flagged_for_review reads "Flagged for review", the
 * indicator SCRUM-17 gave a booking a block has overridden, and the rest are
 * the value capitalised.
 */
export const BOOKING_STATUS_DISPLAY = Object.freeze({
  [BOOKING_STATUS.PENDING]: Object.freeze({
    label: 'Pending',
    group: 'PENDING',
    description: 'Waiting for Venue Staff to decide. It can still be withdrawn.',
  }),
  // A flag on an open request, not an outcome: it still waits for Venue Staff,
  // and the coordinator decides whether to withdraw it.
  [BOOKING_STATUS.CONFLICTING]: Object.freeze({
    label: 'Conflicting',
    group: 'CONFLICTING',
    description:
      'Still waiting for Venue Staff, but another event has been approved for an overlapping time. It can still be withdrawn.',
  }),
  [BOOKING_STATUS.APPROVED]: Object.freeze({
    label: 'Approved',
    group: 'APPROVED',
    description: 'Venue Staff approved this request, so the venue is held for the event.',
  }),
  [BOOKING_STATUS.FLAGGED_FOR_REVIEW]: Object.freeze({
    label: 'Flagged for review',
    group: 'FLAGGED',
    description: 'A change to the venue affects this booking and it needs to be resolved.',
  }),
  [BOOKING_STATUS.REJECTED]: Object.freeze({
    label: 'Rejected',
    group: 'REJECTED',
    description: 'Venue Staff did not approve this request.',
  }),
  [BOOKING_STATUS.WITHDRAWN]: Object.freeze({
    label: 'Withdrawn',
    group: 'WITHDRAWN',
    description: 'This request was withdrawn before Venue Staff decided it.',
  }),
  [BOOKING_STATUS.CANCELLED]: Object.freeze({
    label: 'Cancelled',
    group: 'CANCELLED',
    description: 'This booking was called off and no longer holds the venue.',
  }),
});

/**
 * The display for a booking status. Never returns undefined, so a screen always
 * has a label: a value this build does not recognise, or none at all, is
 * UNKNOWN.
 *
 * @param {*} status
 * @returns {{status: string|null, label: string, group: string, description: string}}
 */
export function getBookingStatusDisplay(status) {
  if (isBookingStatus(status)) {
    const { label, group, description } = BOOKING_STATUS_DISPLAY[status];
    return Object.freeze({ status, label, group, description });
  }

  return Object.freeze({
    status: typeof status === 'string' ? status : null,
    label: 'Unknown Status',
    group: 'UNKNOWN',
    description: 'This request is at a stage this page does not recognise.',
  });
}