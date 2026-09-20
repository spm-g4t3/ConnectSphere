// eventRequestService.js
//
// Matches the REAL backend contract, inferred from
// backend/scripts/check-event-request-service.js (which exercises the actual
// eventRequestService.js/eventRequestValidation.js you have but didn't
// upload directly). Field names below are taken verbatim from that script's
// assertions, e.g. `complete.venueRequirements`, `complete.organiserId`,
// `submitted.submittedAt`.
//
// Key backend behaviours this service reflects:
//   - createEventRequest never submits — every new request starts as 'draft'
//     (SCRUM-10 AC3), so creation and submission are two separate calls.
//   - submitEventRequest validates completeness server-side and returns
//     every failing field at once (SCRUM-10 AC4) — a ValidationError with
//     a `details` array of { field, message }.
//   - Submitting a non-draft request is refused (409/ConflictError) —
//     SCRUM-10 AC6.
//   - The backend scopes "my requests" by the authenticated organiser
//     (SCRUM-10 AC8) — this service doesn't pass an organiserId; the
//     Express layer derives it from the authenticated session.
//
// NOTE: I don't have the actual Express routes for any of this — only the
// service layer's behaviour, inferred from the check script. Route paths
// below (/event-requests, /event-requests/:id/submit) are my best guess at
// convention; confirm the real paths with your backend teammate once routes
// exist.

import { apiClient } from "./apiClient";

/**
 * Creates a new event request as a draft (SCRUM-29).
 *
 * @param {Object} input
 * @param {string} input.eventName
 * @param {string} [input.purpose]
 * @param {string} [input.description]
 * @param {string} [input.proposedStart]   ISO datetime
 * @param {string} [input.proposedEnd]     ISO datetime
 * @param {number} [input.expectedAttendance]
 * @param {string} [input.venueRequirements]
 * @param {string} [input.accessibilityRequirements]
 * @param {string} [input.equipmentRequirements]
 * @returns {Promise<Object>} the created request, status 'draft'
 */
export async function createEventRequest(input) {
  const response = await apiClient.post("/event-requests", input);
  return response.data;
}

/**
 * Saves changes to an existing draft (SCRUM-11). Only valid while status
 * is still 'draft' — once submitted, further changes go through the
 * change-request flow (SCRUM-32/34) instead.
 *
 * @param {string} id
 * @param {Object} input  same shape as createEventRequest's input
 */
export async function updateEventRequest(id, input) {
  const response = await apiClient.patch(`/event-requests/${id}`, input);
  return response.data;
}

/**
 * Submits a draft request (SCRUM-10 AC4-7). The backend validates
 * completeness and moves status draft -> submitted, recording submittedAt.
 *
 * On failure, throws with err.response.data.details as an array of
 * { field, message } — every gap at once, not just the first (AC4).
 *
 * @param {string} id
 * @returns {Promise<Object>} the request, now status 'submitted'
 */
export async function submitEventRequest(id) {
  const response = await apiClient.post(`/event-requests/${id}/submit`);
  return response.data;
}

/**
 * Fetches one event request by id.
 */
export async function getEventRequestById(id) {
  const response = await apiClient.get(`/event-requests/${id}`);
  return response.data;
}

/**
 * Fetches every event request belonging to the signed-in Organiser
 * (SCRUM-10 AC8 — an Organiser sees only their own requests). The backend
 * derives "mine" from the authenticated session, not a passed-in id.
 *
 * @returns {Promise<Array>}
 */
export async function getMyEventRequests() {
  const response = await apiClient.get("/event-requests");
  return response.data;
}
