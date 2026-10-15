// equipmentReviewService.js
//
// SCRUM-296, for SCRUM-290 (Review an Equipment Request - Technical Support
// Staff). The calls behind the review screen, one per route in
// backend/src/routes/equipmentReview.js.
//
// Every call answers with the whole review state, so the screen redraws from
// one response and never splices a list by hand:
//
//   { event: null, request: null }   no such request to review
//   { event: { id, name, proposedStart, proposedEnd, assignedCoordinatorId,
//              assignedCoordinatorName, venue: { id, name } | null },
//     request: { id, status, statusLabel, reviewerId, reviewerName,
//                reviewStartedAt, createdAt, updatedAt,
//                lines: [{ id, equipmentTypeId, name, quantity, technicalNotes,
//                          typeRetired, reserved, shortBy, outcome, outcomeNote,
//                          outcomeBy, outcomeAt, availability, flaggedCount,
//                          reservations: [{ id, quantity, startAt, endAt, flagged,
//                                           flagReason, flaggedAt }] }] } }
//
// The status codes a caller will want to tell apart:
//
//   400  an invalid note, or a line still missing its note on completion.
//        err.response.data.details names each one: [{ field, message }].
//   403  the caller is not the reviewer, or is not technical support staff.
//   404  no such event, or no such line on it.
//   409  the request is not in a state that allows this (code
//        EQUIPMENT_REVIEW_NOT_ALLOWED).

import { apiClient } from "./apiClient";

const base = (eventRequestId) => `/event-requests/${eventRequestId}/equipment-review`;

/** The event's current equipment request, its lines and each line's availability. */
export async function getEquipmentReview(eventRequestId) {
  const response = await apiClient.get(base(eventRequestId));
  return response.data;
}

/** Start reviewing, or start again after a "Cannot be fully arranged" outcome. */
export async function startEquipmentReview(eventRequestId) {
  const response = await apiClient.post(`${base(eventRequestId)}/start`);
  return response.data;
}

/** Take the review over from the staff member currently holding it. */
export async function takeOverEquipmentReview(eventRequestId) {
  const response = await apiClient.post(`${base(eventRequestId)}/take-over`);
  return response.data;
}

/** Mark a line as one that cannot be provided, with the reason (a note). */
export async function markEquipmentLineUnavailable(eventRequestId, lineId, note) {
  const response = await apiClient.put(`${base(eventRequestId)}/lines/${lineId}/outcome`, { note });
  return response.data;
}

/** Remove that mark from a line. */
export async function clearEquipmentLineOutcome(eventRequestId, lineId) {
  const response = await apiClient.delete(`${base(eventRequestId)}/lines/${lineId}/outcome`);
  return response.data;
}

/** Finish the review: Cannot be fully arranged unless every line is reserved. */
export async function completeEquipmentReview(eventRequestId) {
  const response = await apiClient.post(`${base(eventRequestId)}/complete`);
  return response.data;
}

// SCRUM-300: the reservation actions. Same state back from each, same refusals
// (400 with details naming quantity or reason, 403, 404, 409).

/** Reserve `quantity` units for a line, covering the event's current start to end. */
export async function reserveEquipment(eventRequestId, lineId, quantity) {
  const response = await apiClient.post(`${base(eventRequestId)}/lines/${lineId}/reservations`, { quantity });
  return response.data;
}

/** Reduce a reservation to a smaller quantity, with a reason. */
export async function reduceEquipmentReservation(eventRequestId, reservationId, quantity, reason) {
  const response = await apiClient.patch(`${base(eventRequestId)}/reservations/${reservationId}`, { quantity, reason });
  return response.data;
}

/** Release a reservation, with a reason. It stays in the history. */
export async function releaseEquipmentReservation(eventRequestId, reservationId, reason) {
  const response = await apiClient.post(`${base(eventRequestId)}/reservations/${reservationId}/release`, { reason });
  return response.data;
}

/** Move a flagged reservation to the event's current date and time. */
export async function moveEquipmentReservation(eventRequestId, reservationId) {
  const response = await apiClient.post(`${base(eventRequestId)}/reservations/${reservationId}/move`, {});
  return response.data;
}

/** Keep a flagged reservation as it is, when it still fits. */
export async function keepEquipmentReservation(eventRequestId, reservationId) {
  const response = await apiClient.post(`${base(eventRequestId)}/reservations/${reservationId}/keep`, {});
  return response.data;
}
