// flaggedBookingService.js
//
// The frontend's calls to the flagged booking API, kept beside the other
// service files so components never build a URL themselves.

import { apiClient } from "./apiClient";

/**
 * Every booking flagged for review (GET /flagged-bookings), oldest flag first,
 * across all venues. Each item carries the event, the venue, the booking's
 * period and occupied period, the event's current period, the flag (time,
 * review reason and the block that caused it, if any) and `reinstatable`.
 * Not re-sorted by callers: the server's order is the list's.
 *
 * Failures: 401, 403 (not Venue Staff), 500. None flagged is 200 [].
 *
 * @returns {Promise<Array>} possibly empty
 */
export async function getFlaggedBookings() {
  const response = await apiClient.get("/flagged-bookings");
  return response.data;
}

/**
 * Reinstates a flagged booking (POST /flagged-bookings/:id/reinstate).
 *
 * The server re-checks everything under its locks. Failures: 400 (malformed
 * id, a missing or blank reason, or one over 1000 characters), 401, 403, 404,
 * and 409 with a `code`: BOOKING_NOT_FLAGGED, SAFETY_FLAG_NOT_REINSTATABLE,
 * EVENT_NOT_BOOKABLE, BOOKING_PERIOD_STALE, VENUE_RETIRED, BOOKING_CHANGED, or
 * BOOKING_PERIOD_CONFLICT with `conflicts`.
 *
 * @param {string} id      the booking's id
 * @param {string} reason  why it is reinstated
 * @returns {Promise<Object>} the booking, now approved, with `resolution`
 */
export async function reinstateFlaggedBooking(id, reason) {
  const response = await apiClient.post(`/flagged-bookings/${id}/reinstate`, { reason });
  return response.data;
}

/**
 * Cancels a flagged booking (POST /flagged-bookings/:id/cancel), whatever
 * flagged it. Failures: 400 as reinstateFlaggedBooking's, 401, 403, 404, and
 * 409 BOOKING_NOT_FLAGGED or BOOKING_CHANGED.
 *
 * @param {string} id      the booking's id
 * @param {string} reason  why it is cancelled
 * @returns {Promise<Object>} the booking, now cancelled, with `resolution`
 */
export async function cancelFlaggedBooking(id, reason) {
  const response = await apiClient.post(`/flagged-bookings/${id}/cancel`, { reason });
  return response.data;
}
