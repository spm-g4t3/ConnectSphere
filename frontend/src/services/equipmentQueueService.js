// equipmentQueueService.js
//
// SCRUM-287, for SCRUM-284 (Technical Support Dashboard and Request Queue). The
// call behind the dashboard's equipment request lists, one route in
// backend/src/routes/equipmentQueue.js.
//
// The answer:
//
//   { needsAction: Row[], requests: Row[] }
//
//   Row = { eventRequestId, eventName, proposedStart, proposedEnd,
//           venue: { id, name } | null, coordinator: { id, name } | null,
//           lineCount, status, statusLabel,
//           reviewer: { id, name } | null,
//           flaggedCount, flagReasons: string[] }
//
// needsAction is Pending review requests and requests with flagged reservations,
// whatever the status filter says. requests is every status, or the one asked for.
//
// Status codes a caller will want to tell apart: 400 (a filter the server does
// not know), 403 (not technical support staff), anything else is a failure to load.

import { apiClient } from "./apiClient";

/** The five statuses of an equipment request, in the order a reviewer meets them. */
export const QUEUE_STATUSES = [
  { value: "pending_review", label: "Pending review" },
  { value: "under_review", label: "Under review" },
  { value: "arranged", label: "Arranged" },
  { value: "cannot_be_fully_arranged", label: "Cannot be fully arranged" },
  { value: "cancelled", label: "Cancelled" },
];

/**
 * @param {object} [filters]
 * @param {string} [filters.status]        one of QUEUE_STATUSES' values; empty means all
 * @param {boolean} [filters.includePast]  also list events that have ended
 */
export async function getEquipmentQueue({ status = "", includePast = false } = {}) {
  const params = {};
  if (status) params.status = status;
  if (includePast) params.includePast = "true";

  const response = await apiClient.get("/equipment-requests", { params });
  return response.data;
}
