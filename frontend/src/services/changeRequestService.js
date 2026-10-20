// changeRequestService.js
//
// An Organiser's change requests on an event, under
// /event-requests/:id/change-requests.

import { apiClient } from "./apiClient";

/**
 * Submits a request to change something about an already-submitted event.
 *
 * @param {string} eventRequestId
 * @param {Object} payload
 * @param {string} payload.field    which piece of info/arrangement changes
 * @param {string} payload.details  free-text description of the change
 */
export async function submitChangeRequest(eventRequestId, payload) {
  const response = await apiClient.post(
    `/event-requests/${eventRequestId}/change-requests`,
    payload,
  );
  return response.data;
}

/**
 * Fetches every change request submitted for a given event, so the
 * Organiser can see which are outstanding, in progress, or processed
 * (SCRUM-34).
 *
 * Expected shape per item: { id, fieldLabel, details, status, createdAt }
 */
export async function getChangeRequests(eventRequestId) {
  const response = await apiClient.get(
    `/event-requests/${eventRequestId}/change-requests`,
  );
  return response.data;
}
