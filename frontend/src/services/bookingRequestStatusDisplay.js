// bookingRequestStatusDisplay.js
//
// SCRUM-255. The labels and groups come from the API as `statusDisplay`
// (backend domain/bookingStatus.js), as an event's do, so this file holds only
// what to show if no statusDisplay arrived.

import { readStatusDisplay } from "./eventRequestStatusDisplay";

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
