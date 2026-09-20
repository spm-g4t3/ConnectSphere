// eventRequestService.js
//
// IMPORTANT: this assumes an Express route exists that calls
// getStatusDisplay(request.status) from backend/src/eventRequestStatus.js
// and returns its result directly, e.g.:
//
//   GET /event-requests/:id/status
//   -> { status, label, group, description }
//

import { apiClient } from "./apiClient"; // <-- replace with your actual API client

/**
 * Fetches the organiser-facing status display for one event request.
 * Returns exactly what getStatusDisplay() on the backend produces:
 * { status, label, group, description }. The frontend intentionally keeps
 * no copy of the status vocabulary — see eventRequestStatus.js on the backend.
 */
export async function getEventRequestStatus(requestId) {
  const response = await apiClient.get(`/event-requests/${requestId}/status`);
  return response.data;
}

/**
 * Creates a new event request (SCRUM-29). Maps directly onto the columns
 * in event_requests (001_event_requests.sql). Status is not sent — the
 * database defaults new requests to 'draft'.
 *
 * @param {Object} input
 * @param {string} input.eventName
 * @param {string|null} [input.purpose]
 * @param {string|null} [input.proposedStart]  ISO datetime
 * @param {string|null} [input.proposedEnd]    ISO datetime
 * @param {number|null} [input.expectedAttendance]
 * @param {string|null} [input.description]    requirements go here for now —
 *                                              confirm with backend
 */
export async function createEventRequest(input) {
  const response = await apiClient.post("/event-requests", {
    event_name: input.eventName,
    purpose: input.purpose ?? null,
    proposed_start: input.proposedStart ?? null,
    proposed_end: input.proposedEnd ?? null,
    expected_attendance: input.expectedAttendance ?? null,
    description: input.description ?? null,
  });
  return response.data;
}

/**
 * Saves changes to an existing draft event request (SCRUM-11). Only valid
 * while the request is still in 'draft' status — once submitted, further
 * changes should go through the change-request flow (SCRUM-32/34) instead
 * of a direct edit, since the request is no longer solely the Organiser's
 * to alter.
 *
 * Same field mapping as createEventRequest — this is intentionally the
 * same shape so EventRequestForm.jsx can use one payload builder for both.
 *
 * @param {string} id  the event request being edited
 * @param {Object} input  same shape as createEventRequest's input
 */
export async function updateEventRequest(id, input) {
  const response = await apiClient.patch(`/event-requests/${id}`, {
    event_name: input.eventName,
    purpose: input.purpose ?? null,
    proposed_start: input.proposedStart ?? null,
    proposed_end: input.proposedEnd ?? null,
    expected_attendance: input.expectedAttendance ?? null,
    description: input.description ?? null,
  });
  return response.data;
}
