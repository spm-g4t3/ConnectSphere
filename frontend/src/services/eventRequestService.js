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
// ROUTES: every function in this file now resolves to a real route mounted at
// /api/event-requests in backend/src/app.js, and every request-shaped response
// carries `statusDisplay` — the label, group and description, produced by the
// backend so this app keeps no copy of the status vocabulary.
//
// This note used to say that POST /event-requests, PATCH /event-requests/:id
// and POST /:id/submit were unmounted and would 404. That stopped being true
// when SCRUM-29 and SCRUM-11's routes landed, and a stale warning about a 404
// is worse than none: it sends the next reader looking for a backend gap that
// is already closed.
//
// getEventRequestQueue is the one call here that is not the Organiser's own
// data (SCRUM-45). It is gated on the Event Coordinator role server-side, so
// a 403 from it is an ordinary outcome for any other role rather than a fault.

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

/**
 * Fetches just the status of one request (SCRUM-42).
 *
 * Deliberately narrower than getEventRequestById: it returns the status
 * display and the timestamps and nothing else, so a view that only wants to
 * know whether anything moved does not re-download the whole request. Used by
 * the single-request view in SCRUM-40; the list refetches through
 * getMyEventRequests instead, which already carries every row's status.
 *
 * @param {string} id
 * @returns {Promise<{id, status, label, group, description, updatedAt, submittedAt}>}
 */
export async function getEventRequestStatus(id) {
  const response = await apiClient.get(`/event-requests/${id}/status`);
  return response.data;
}

/**
 * Every event request awaiting a decision, oldest waiting first (SCRUM-45).
 *
 * The Event Coordinator's review queue, and the only read in this file that
 * crosses Organisers: the backend gates it on the event_coordinator role
 * rather than scoping it to the caller, because a queue nobody owns is
 * exactly the thing an ownership check cannot narrow. A 403 therefore means
 * "not a Coordinator", not "something went wrong" — handle it as a message,
 * not as a failure.
 *
 * Rows are the same shape getMyEventRequests returns, `statusDisplay`
 * included, so readStatusDisplay and statusClassName work on them unchanged
 * and the queue needs no status vocabulary of its own. They are also complete:
 * the backend selects the same columns GET /:id does, which is why the detail
 * panel renders from the row already in hand and there is no second fetch.
 *
 * organiserId arrives as a bare uuid. No endpoint resolves it to a name —
 * that is deliberate, not missing — so render it as an identifier.
 *
 * @returns {Promise<Array>} possibly empty; an empty queue is the good state
 */
export async function getEventRequestQueue() {
  const response = await apiClient.get("/event-requests/queue");
  return response.data;
}
