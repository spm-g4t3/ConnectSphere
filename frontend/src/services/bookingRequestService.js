// bookingRequestService.js
//
// SCRUM-254 (part of SCRUM-243). The one frontend call to the booking request
// API from SCRUM-252, kept beside the other service files so components never
// build a URL themselves.

import { apiClient } from "./apiClient";

/**
 * Requests a venue for an event (POST /booking-requests).
 *
 * Only the coordinator's choices go in the body: the venue, setup notes,
 * (SCRUM-191) the room layout and accessibility and facility codes the
 * suitability check judges, each left out when blank or empty, and
 * (SCRUM-525, AC2) the expected attendance for this venue, which the server
 * checks Capacity on and stores with the booking. The period and
 * the event's free-text requirements come from the stored event, the
 * requester from the token, the suitability result from the server, and the
 * status is always pending, so none of them is sent.
 *
 * Failures, as the backend answers them: 400 with details[], 401, 403 (not the
 * event's assigned coordinator), 404 (no such event or venue), 503 (suitability
 * checking unavailable) and 409 with a `code` and `conflicts`:
 * EVENT_NOT_BOOKABLE, EVENT_DATES_MISSING, VENUE_RETIRED,
 * EVENT_ATTENDANCE_MISSING (SCRUM-525: no attendance in the body and none on
 * the event), BOOKING_REQUEST_EXISTS and BOOKING_FLAGGED_FOR_REVIEW
 * (SCRUM-525: per venue, so they mean this event already has a live request
 * for this venue; conflicts are [{ kind: 'booking_request', bookingId }], with
 * no venue id, so the caller knows the venue from what it sent),
 * BOOKING_PERIOD_CONFLICT (conflicts are blocks and approved bookings), and
 * SUITABILITY_CONFIRMATION_REQUIRED (conflicts are the criteria not met;
 * resend with confirmUnsuitable: true). A 400's details[] may name
 * expectedAttendance.
 *
 * @param {Object} input
 * @param {string} input.eventRequestId
 * @param {string} input.venueId
 * @param {string} [input.roomLayoutCode]   SCRUM-191, one room layout code
 * @param {string[]} [input.accessibility]  SCRUM-191, accessibility feature codes
 * @param {string[]} [input.facilities]     SCRUM-191, facility codes
 * @param {string} [input.setupNotes]
 * @param {number} [input.expectedAttendance]  SCRUM-525, a whole number of 1
 *   or more; the event's when left out
 * @param {boolean} [input.confirmUnsuitable]
 * @param {string[]} [input.acknowledgedCriteria]  SCRUM-188 (AC7), the names of
 *   the unmet criteria the coordinator confirmed; sent with confirmUnsuitable.
 *   The server accepts the override only when they cover every criterion it
 *   finds unmet, otherwise it answers SUITABILITY_CONFIRMATION_REQUIRED again.
 * @returns {Promise<Object>} the new request, always status "pending", with
 *   the expectedAttendance it was stored with
 */
export async function createBookingRequest(input) {
  const response = await apiClient.post("/booking-requests", input);
  return response.data;
}

/**
 * The signed-in coordinator's booking requests, newest first (SCRUM-255).
 *
 * Every status -- pending, approved, flagged for review, rejected, withdrawn
 * and cancelled -- on every event assigned to the caller. The list is the
 * caller's from the token; there is no parameter that could ask for someone
 * else's. Each row carries the event's name and status, the venue's name and
 * location, the period, and a `statusDisplay` ({ status, label, group,
 * description }) so this file and its callers keep no copy of the vocabulary.
 * `flaggedAt` is the review indicator for a booking a venue block flagged.
 *
 * Gated on the event_coordinator role, so a 403 means "not a coordinator", not
 * a fault. An empty list is the good state.
 *
 * @returns {Promise<Array>} possibly empty
 */
export async function getMyBookingRequests() {
  const response = await apiClient.get("/booking-requests/mine");
  return response.data;
}

/**
 * Withdraws a pending request (POST /booking-requests/:id/withdraw, SCRUM-253).
 *
 * Failures: 400 (malformed id), 401, 403 (not the event's assigned coordinator),
 * 404, and 409 BOOKING_NOT_PENDING (approved, rejected, already withdrawn and so
 * on: repeating the call is refused, not answered as a success) or
 * BOOKING_CHANGED.
 *
 * @param {string} id  the request's id
 * @returns {Promise<Object>} the request, now withdrawn
 */
export async function withdrawBookingRequest(id) {
  const response = await apiClient.post(`/booking-requests/${id}/withdraw`);
  return response.data;
}