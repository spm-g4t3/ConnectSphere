/**
 * The equipment request queue: what the Technical Support dashboard lists.
 *
 * SCRUM-285, for SCRUM-284 "Technical Support Dashboard and Request Queue".
 * One read-only Postgres function (056_equipment_request_queue.sql) answers the
 * whole page, so the two lists on it always agree with each other and a request
 * cannot appear in one and be missing from the other.
 *
 * Who may call is the route's job (Technical Support Staff only, AC1). The rows
 * hold exactly the fields AC3 lists and the function selects nothing else, so
 * nothing about the event beyond them can leak (AC6); this file only renames
 * the keys.
 *
 * The result:
 *
 *   {
 *     needsAction: Row[],   // AC4: Pending review, and reservations flagged
 *     requests:    Row[],   // AC2: every status, or the one asked for
 *   }
 *
 *   Row = { eventRequestId, eventName, proposedStart, proposedEnd,
 *           venue: { id, name } | null, coordinator: { id, name } | null,
 *           lineCount, status, statusLabel,
 *           reviewer: { id, name } | null,
 *           flaggedCount, flagReasons }
 *
 * SQLSTATEs the function raises, and what they become:
 *   22023  an unknown status                  ValidationError  400
 * Anything else is left untyped, so it reaches the API as a 500.
 */

import { ValidationError } from '../errors.js';
import { equipmentRequestStatusLabel } from '../domain/equipmentRequestStatus.js';
import { checkQueueQuery, throwIfInvalid } from '../validation/equipmentQueueValidation.js';


/** The client to use. Imported only when none was supplied, as the other services do. */
async function resolveClient(client) {
  if (client) return client;

  const { supabase } = await import('../config/supabaseClient.js');
  return supabase;
}

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
    venue: row.venue_id ? { id: row.venue_id, name: row.venue_name ?? null } : null,
    coordinator: person(row.coordinator_id, row.coordinator_name),
    lineCount: row.line_count ?? 0,
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
    requests: (data?.requests ?? []).map(toQueueRow),
  };
}

/**
 * The dashboard's data.
 *
 * @param {object} query            req.query: { status?, includePast? }
 * @param {object} [options]
 * @param {object} [options.client] a Supabase client, usually a test double
 * @returns {Promise<{needsAction: object[], requests: object[]}>}
 * @throws {ValidationError} a status or includePast that is not valid (400)
 */
export async function getEquipmentRequestQueue(query, { client } = {}) {
  const { value, details } = checkQueueQuery(query);
  throwIfInvalid(details);

  const db = await resolveClient(client);
  const { data, error } = await db.rpc('equipment_request_queue', {
    p_status: value.status,
    p_include_past: value.includePast,
  });

  if (error) {
    if (error.code === '22023') throw new ValidationError(error.message, [{ field: 'status', message: error.message }]);
    throw new Error(error.message || 'Unexpected database error');
  }

  return toQueue(data);
}
