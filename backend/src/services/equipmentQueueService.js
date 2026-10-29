/**
 * The equipment request queue behind the Technical Support dashboard.
 *
 * One read-only Postgres function (056_equipment_request_queue.sql) answers the
 * whole page, so the two lists always agree. It checks the caller's role itself;
 * the route checks it too. The rows hold only the fields the dashboard shows.
 *
 *   { needsAction, needsActionTruncated, requests, requestsTruncated, statuses }
 *   Row = { eventRequestId, eventName, proposedStart, proposedEnd,
 *           venues: [{ id, name }], coordinator: { id, name } | null,
 *           itemCount, status, statusLabel, reviewer: { id, name } | null,
 *           flaggedCount, flagReasons }
 *   statuses = [{ value, label }], the filter's choices, in review order
 *
 * SQLSTATEs: 42501 not Technical Support (403), 22023 unknown status (400).
 * Anything else is untyped and reaches the API as a 500.
 *
 * "Reviewed by me" (SCRUM-582, 041_equipment_reviewed_by_me.sql) is a second
 * read-only function for the same dashboard:
 *   { requests, total, truncated }
 *   Row = { eventRequestId, eventName, proposedStart, proposedEnd, status,
 *           statusLabel, lastWorkedAt, returnedToPending,
 *           interruptedReason, interruptedAt }
 * Only the caller's own history is read, and nothing is assigned or locked.
 */

import { ForbiddenError, ValidationError } from '../errors.js';
import { resolveClient } from '../config/resolveClient.js';
import { createPgTranslator } from '../http/pgErrors.js';
import {
  EQUIPMENT_REQUEST_STATUS,
  equipmentRequestStatusLabel,
} from '../domain/equipmentRequestStatus.js';
import { checkQueueQuery } from '../validation/equipmentQueueValidation.js';
import { throwIfInvalid } from '../validation/equipmentLineValidation.js';

const STATUS_CHOICES = Object.values(EQUIPMENT_REQUEST_STATUS).map((value) => ({
  value,
  label: equipmentRequestStatusLabel(value),
}));

const translateError = createPgTranslator({
  codes: {
    '42501': (_, error) => new ForbiddenError(error.message),
    '22023': (_, error) =>
      new ValidationError(error.message, [{ field: 'status', message: error.message }]),
  },
});

/** A person with an id and maybe no name, or null when there is no id. */
function person(id, name) {
  return id ? { id, name: name ?? null } : null;
}

/** One queue row, in camelCase. */
export function toQueueRow(row) {
  return {
    eventRequestId: row.event_request_id,
    eventName: row.event_name,
    proposedStart: row.proposed_start ?? null,
    proposedEnd: row.proposed_end ?? null,
    venues: (row.venues ?? []).map((venue) => ({ id: venue.id, name: venue.name ?? null })),
    coordinator: person(row.coordinator_id, row.coordinator_name),
    itemCount: row.item_count ?? 0,
    status: row.status,
    statusLabel: equipmentRequestStatusLabel(row.status),
    reviewer: person(row.reviewer_id, row.reviewer_name),
    flaggedCount: row.flagged_count ?? 0,
    flagReasons: Array.isArray(row.flag_reasons) ? row.flag_reasons : [],
  };
}

/** The function's answer as the API's. */
export function toQueue(data) {
  return {
    needsAction: (data?.needs_action ?? []).map(toQueueRow),
    needsActionTotal: Number(data?.needs_action_total ?? 0),
    needsActionTruncated: data?.needs_action_truncated === true,
    requests: (data?.requests ?? []).map(toQueueRow),
    requestsTotal: Number(data?.requests_total ?? 0),
    requestsTruncated: data?.requests_truncated === true,
    statuses: STATUS_CHOICES,
  };
}

/**
 * @param {object} query            req.query: { status?, includePast? }
 * @param {object} options
 * @param {string} options.callerId the signed-in user, from the token
 * @param {object} [options.client] a Supabase client, usually a test double
 * @throws {ValidationError} a status or includePast that is not valid (400)
 * @throws {ForbiddenError}  the caller is not Technical Support (403)
 */
export async function getEquipmentRequestQueue(query, { callerId, client } = {}) {
  const { value, details } = checkQueueQuery(query);
  throwIfInvalid(details);

  const db = await resolveClient(client);
  const { data, error } = await db.rpc('equipment_request_queue', {
    p_caller: callerId ?? null,
    p_status: value.status,
    p_include_past: value.includePast,
  });

  if (error) throw translateError(error);

  return toQueue(data);
}


/** One "reviewed by me" row, in camelCase. */
export function toReviewedRow(row) {
  return {
    eventRequestId: row.event_request_id,
    eventName: row.event_name,
    proposedStart: row.proposed_start ?? null,
    proposedEnd: row.proposed_end ?? null,
    status: row.status,
    statusLabel: equipmentRequestStatusLabel(row.status),
    lastWorkedAt: row.last_worked_at ?? null,
    returnedToPending: row.returned_to_pending === true,
    interruptedReason: row.interrupted_reason ?? null,
    interruptedAt: row.interrupted_at ?? null,
  };
}

/**
 * The requests the caller has started or taken over, newest work first.
 *
 * @param {object} options
 * @param {string} options.callerId the signed-in user, from the token
 * @param {object} [options.client] a Supabase client, usually a test double
 * @throws {ForbiddenError} the caller is not Technical Support (403)
 */
export async function getRequestsReviewedByMe({ callerId, client } = {}) {
  const db = await resolveClient(client);
  const { data, error } = await db.rpc('equipment_reviewed_by_me', { p_caller: callerId ?? null });

  if (error) throw translateError(error);

  return {
    requests: (data?.requests ?? []).map(toReviewedRow),
    total: Number(data?.total ?? 0),
    truncated: data?.truncated === true,
  };
}
