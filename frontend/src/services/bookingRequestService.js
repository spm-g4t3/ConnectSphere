// bookingRequestService.js
//
// SCRUM-254 (part of SCRUM-243). The one frontend call to the booking request
// API from SCRUM-252, kept beside the other service files so components never
// build a URL themselves.

import { apiClient } from "./apiClient";

/**
 * Requests a venue for an event (POST /booking-requests).
 *
 * Only the coordinator's choices go in the body. The period and the event's
 * requirements come from the stored event, the requester from the token, the
 * suitability result from the server, and the status is always pending, so
 * none of them is sent.
 *
 * Failures, as the backend answers them: 400 with details[], 401, 403 (not the
 * event's assigned coordinator), 404 (no such event or venue), 503 (suitability
 * checking unavailable) and 409 with a `code` and `conflicts`:
 * EVENT_NOT_BOOKABLE, EVENT_DATES_MISSING, VENUE_RETIRED,
 * BOOKING_REQUEST_EXISTS and BOOKING_FLAGGED_FOR_REVIEW (conflicts name the
 * existing booking), BOOKING_PERIOD_CONFLICT (conflicts are blocks and approved
 * bookings), and SUITABILITY_CONFIRMATION_REQUIRED (conflicts are the criteria
 * not met; resend with confirmUnsuitable: true).
 *
 * @param {Object} input
 * @param {string} input.eventRequestId
 * @param {string} input.venueId
 * @param {string} [input.setupNotes]
 * @param {boolean} [input.confirmUnsuitable]
 * @returns {Promise<Object>} the new request, always status "pending"
 */
export async function createBookingRequest(input) {
  const response = await apiClient.post("/booking-requests", input);
  return response.data;
}
