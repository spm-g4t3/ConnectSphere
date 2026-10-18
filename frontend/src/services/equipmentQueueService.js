// equipmentQueueService.js
//
// The call behind the dashboard's equipment request lists
// (GET /equipment-requests, backend/src/routes/equipmentQueue.js).
//
//   { needsAction: Row[], needsActionTotal, needsActionTruncated,
//     requests: Row[], requestsTotal, requestsTruncated,
//     statuses: [{ value, label }] }
//   Row = { eventRequestId, eventName, proposedStart, proposedEnd,
//           venues: [{ id, name }], coordinator: { id, name } | null,
//           itemCount, status, statusLabel, reviewer: { id, name } | null,
//           flaggedCount, flagReasons: string[] }
//
// needsAction ignores the status filter; requests is every status, or the one
// asked for. Each list is cut at a limit, and *Total is the count before the cut. statuses is the filter's choices, so labels are not kept here.
// A 400 is a filter the server does not know, a 403 is not Technical Support.

import { apiClient } from "./apiClient";

/**
 * @param {object} [filters]
 * @param {string} [filters.status]        one of the answer's statuses; empty means all
 * @param {boolean} [filters.includePast]  also list events that have ended
 */
export async function getEquipmentQueue({ status = "", includePast = false } = {}) {
  const params = {};
  if (status) params.status = status;
  if (includePast) params.includePast = "true";

  const response = await apiClient.get("/equipment-requests", { params });
  return response.data;
}
