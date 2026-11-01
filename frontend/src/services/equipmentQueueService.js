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
//
// getReviewedByMe (SCRUM-582, GET /equipment-requests/reviewed-by-me) is the
// caller's own review history:
//   { requests: Row[], total, truncated }
//   Row = { eventRequestId, eventName, proposedStart, proposedEnd, status,
//           statusLabel, lastWorkedAt, returnedToPending,
//           interruptedReason: string | null, interruptedAt: string | null }

import { getData } from "./apiData";

/**
 * @param {object} [filters]
 * @param {string} [filters.status]        one of the answer's statuses; empty means all
 * @param {boolean} [filters.includePast]  also list events that have ended
 */
export async function getEquipmentQueue({ status = "", includePast = false } = {}) {
  const params = {};
  if (status) params.status = status;
  if (includePast) params.includePast = "true";

  return getData("/equipment-requests", { params });
}

/** The requests the signed-in user has started or taken over, newest work first. */
export async function getReviewedByMe() {
  return getData("/equipment-requests/reviewed-by-me");
}
