// bookingRequestStatusDisplay.js
//
// SCRUM-255. The CSS class for a booking status group. The labels and groups
// come from the API as `statusDisplay` (backend domain/bookingStatus.js), as an
// event's do, so this file holds only what is the frontend's: the style for a
// group, and what to show if no statusDisplay arrived.
//
// Keyed on the group, not the status, so a status the backend adds later lands
// in an existing group or in UNKNOWN and this table needs no edit.

import { readStatusDisplay } from "./eventRequestStatusDisplay";

const CLASS_BY_GROUP = {
  PENDING: "status--booking-pending",
  CONFLICTING: "status--booking-conflicting",
  APPROVED: "status--booking-approved",
  FLAGGED: "status--booking-flagged",
  REJECTED: "status--booking-rejected",
  WITHDRAWN: "status--booking-withdrawn",
  CANCELLED: "status--booking-cancelled",
  UNKNOWN: "status--booking-unknown",
  UNAVAILABLE: "status--booking-unknown",
};

/**
 * @param {string} group  from statusDisplay.group
 * @returns {string}
 */
export function bookingStatusClassName(group) {
  return Object.hasOwn(CLASS_BY_GROUP, group) ? CLASS_BY_GROUP[group] : CLASS_BY_GROUP.UNKNOWN;
}

/**
 * The display for a booking request, however it arrived. Never undefined: a
 * row with no statusDisplay reads "Status Unavailable", the wording an event
 * with none already gets.
 *
 * @param {object} bookingRequest  a row from getMyBookingRequests
 * @returns {{status: string|null, label: string, group: string, description: string}}
 */
export function readBookingStatusDisplay(bookingRequest) {
  return readStatusDisplay(bookingRequest);
}
