// openEventService.js
//
// SCRUM-495. The one frontend call to the Attendee's open-events list, kept
// beside the other service files so components never build a URL themselves.

import { apiClient } from "./apiClient";

/**
 * The events the signed-in Attendee can currently register for
 * (GET /open-events), earliest start first.
 *
 * Nothing identifies the caller in the request: the backend takes the attendee
 * from the token, and answers only Attendees. The order is the server's and
 * must not be re-sorted. Each event carries id, eventName, description,
 * startsAt, endsAt, capacity, placesLeft (null for no limit), isFull,
 * isRegistered and canRegister.
 *
 * Failures, as the backend answers them: 401 (no or expired session), 403 (not
 * an Attendee) and 500.
 *
 * @returns {Promise<Object[]>} possibly empty
 */
export async function getOpenEvents() {
  const response = await apiClient.get("/open-events");
  return response.data;
}

/**
 * One open event, for the details page (GET /open-events/:id): the same
 * eligibility as the list, judged by the server at this moment, with the same
 * fields. Read afresh each time it is called.
 *
 * Failures: 401, 403 (not an Attendee), 404 (the event is not open for
 * registration, for whatever reason) and 500.
 *
 * @param {string} eventId
 * @returns {Promise<Object>}
 */
export async function getOpenEvent(eventId) {
  const response = await apiClient.get(`/open-events/${encodeURIComponent(eventId)}`);
  return response.data;
}
