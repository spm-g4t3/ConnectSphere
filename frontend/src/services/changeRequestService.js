// changeRequestService.js
//
// An Organiser's change requests on an event, under
// /event-requests/:id/change-requests.

import { getData, postData } from "./apiData";

/**
 * Submits a request to change something about an already-submitted event.
 *
 * @param {string} eventRequestId
 * @param {Object} payload
 * @param {string} payload.field    which piece of info/arrangement changes
 * @param {string} payload.details  free-text description of the change
 */
export async function submitChangeRequest(eventRequestId, payload) {
  return postData(
    `/event-requests/${eventRequestId}/change-requests`,
    payload,
  );
}

/**
 * Fetches every change request submitted for a given event, so the
 * Organiser can see which are outstanding, in progress, or processed
 * (SCRUM-34).
 *
 * Expected shape per item: { id, fieldLabel, details, status, createdAt }
 */
export async function getChangeRequests(eventRequestId) {
  return getData(
    `/event-requests/${eventRequestId}/change-requests`,
  );
}
