/**
 * Equipment line service: an event's equipment requirements.
 *
 * SCRUM-244, a subtask of SCRUM-21 "Record Equipment Requirements for an Event -
 * Event Coordinator".
 *
 * The assigned coordinator of an Approved event adds, amends and removes
 * equipment lines, and anyone with the coordinator role reads them. Each write
 * is one Postgres function (037_equipment_request_lines.sql) called through
 * rpc, because a line change also changes the request's status and may flag or
 * release reservations, and separate supabase-js calls cannot be rolled back.
 *
 * No read before the write, apart from the two a validation message needs. The
 * function answers everything else under the event row's lock, when the answer
 * cannot change before the write: does the event exist, is the caller its
 * assigned coordinator, is it Approved. This is startEventReview's reasoning.
 *
 * Input is validated before any call (equipmentLineValidation.js). Two rules
 * need a read, so they are added to the same list of problems and a caller
 * still sees every invalid field at once: the type exists and is not retired,
 * and the type is not already on the event. The function refuses the same
 * things again under its lock, for two writers racing.
 *
 * The caller is always the signed-in user, passed in as coordinatorId from the
 * token. Nothing about who is acting is ever read from a body.
 *
 * SQLSTATEs the functions raise, and what they become:
 *   42501  not the event's assigned coordinator         ForbiddenError    403
 *   55000  the event is not Approved                    ConflictError     409
 *   22023  a bad quantity, or an unknown or retired type ValidationError   400
 *   23505  the type is already on the event             ValidationError   400
 *   P0002  no such event, or no such line               NotFoundError     404
 * Anything else is left untyped, so it reaches the API as a 500 and never
 * dressed as a 400 telling a coordinator to fix a form they did not get wrong.
 */

import { ValidationError, NotFoundError } from '../errors.js';
import { resolveClient } from '../config/resolveClient.js';
import {
  createPgTranslator,
  forbidden,
  conflict,
  rejected,
  notFound,
} from '../http/pgErrors.js';
import {
  checkAddEquipmentLine,
  checkAmendEquipmentLine,
  throwIfInvalid,
  validateEventRequestId,
  validateEquipmentLineId,
} from '../validation/equipmentLineValidation.js';
import { requireCallerId } from '../validation/ids.js';
import { equipmentRequestStatusLabel } from '../domain/equipmentRequestStatus.js';



/** Which field a 22023 message is about, so the form can show it beside the field. */
function detailsFor(message) {
  if (/quantity/i.test(message)) return [{ field: 'quantity', message }];
  if (/equipment type/i.test(message)) return [{ field: 'equipmentTypeId', message }];
  if (/nothing to change/i.test(message)) return [{ field: 'changes', message }];
  return [];
}

/**
 * Turn a raw Postgres error into a typed one. The messages from 037 are
 * written to be read by a coordinator, so they pass through unchanged.
 */
const translateError = createPgTranslator({
  codes: {
    '42501': forbidden,
    // The event is not Approved: wrong status, or Confirmed (AC10).
    '55000': conflict('EVENT_NOT_APPROVED'),
    '23505': (detail) =>
      new ValidationError(detail || 'That equipment type is already on this event', [
        { field: 'equipmentTypeId', message: 'is already on this event' },
      ]),
    '22023': (detail) => new ValidationError(detail, detailsFor(detail)),
    // A check constraint backing the function up. The message is the driver's,
    // so it is wrapped, as the other services do.
    '23514': rejected,
    P0002: notFound('Not found'),
  },
});


/**
 * One flagged reservation on a line (SCRUM-315), in camelCase. reason is null
 * for a flag that was set without one, and the screen words that case itself.
 * code says what kind of flag it is, so the screen does not call every flag
 * "equipment unavailable".
 */
function toFlaggedReservation(row) {
  return {
    id: row.id,
    quantity: row.quantity,
    startAt: row.start_at,
    endAt: row.end_at,
    reason: row.flag_reason ?? null,
    // 'equipment_lost' when the equipment is unavailable; null for any other flag (023).
    code: row.flag_code ?? null,
    flaggedAt: row.flagged_at ?? null,
  };
}

/** One line, in camelCase. Built as a literal so no snake_case key leaks upward. */
function toLine(row) {
  return {
    id: row.id,
    equipmentTypeId: row.equipment_type_id,
    name: row.name,
    quantity: row.quantity,
    technicalNotes: row.technical_notes ?? null,
    typeRetired: row.type_retired === true,
    // SCRUM-297: what technical support has done with the line (038). reserved
    // is how many are held for it; outcome is 'cannot_be_provided' once a
    // reviewer has marked it, with the reason in outcomeNote.
    reserved: row.reserved ?? 0,
    outcome: row.outcome ?? null,
    outcomeNote: row.outcome_note ?? null,
    // SCRUM-315 (023): the reservations on this line that are flagged and not
    // released, for example after equipment became unavailable. Empty when there are none.
    flaggedReservations: Array.isArray(row.flagged_reservations)
      ? row.flagged_reservations.map(toFlaggedReservation)
      : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The event's current equipment request and its lines, or { request: null } for
 * an event that has never asked for equipment.
 */
function toEquipmentState(data) {
  const request = data?.request ?? null;
  if (!request) return { request: null };

  return {
    request: {
      id: request.id,
      status: request.status,
      statusLabel: equipmentRequestStatusLabel(request.status),
      createdAt: request.created_at,
      updatedAt: request.updated_at,
      lines: (request.lines ?? []).map(toLine),
    },
  };
}


/** A blank caller would never reach the function as a uuid. */
function requireCoordinator(coordinatorId) {
  return requireCallerId(coordinatorId, 'coordinatorId');
}

/**
 * The two reads a validation message needs: is the type real and in use, and is
 * it already on this event. Only asked once the type id itself is a readable
 * UUID, and the second only once the first has passed.
 */
async function readTypeFaults(db, eventRequestId, equipmentTypeId) {
  const { data: type, error } = await db
    .from('equipment_types')
    .select('id, retired_at')
    .eq('id', equipmentTypeId)
    .maybeSingle();
  if (error) throw translateError(error);

  if (!type) {
    return [{ field: 'equipmentTypeId', message: 'is not an equipment type' }];
  }
  if (type.retired_at) {
    return [{ field: 'equipmentTypeId', message: 'is retired and cannot be chosen' }];
  }

  const { data, error: readError } = await db.rpc('equipment_for_event', {
    p_event_request_id: eventRequestId,
  });
  if (readError) throw translateError(readError);

  const lines = data?.request?.lines ?? [];
  if (lines.some((line) => line.equipment_type_id === equipmentTypeId)) {
    return [{ field: 'equipmentTypeId', message: 'is already on this event' }];
  }
  return [];
}


/**
 * An event's equipment: its current request and lines (AC11).
 *
 * Any Event Coordinator may read it; the route gates on the role. An event id
 * that matches nothing is a 404, not an empty answer, so a mistyped id is not
 * mistaken for an event with no equipment.
 *
 * @param {string} eventRequestId
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<{request: object|null}>}
 * @throws {ValidationError} the id is not a UUID
 * @throws {NotFoundError}   no such event
 */
export async function listEventEquipment(eventRequestId, { client } = {}) {
  validateEventRequestId(eventRequestId);

  const db = await resolveClient(client);

  const { data: event, error: eventError } = await db
    .from('event_requests')
    .select('id')
    .eq('id', eventRequestId)
    .maybeSingle();
  if (eventError) throw translateError(eventError);
  if (!event) throw new NotFoundError('Event request not found');

  const { data, error } = await db.rpc('equipment_for_event', {
    p_event_request_id: eventRequestId,
  });
  if (error) throw translateError(error);

  return toEquipmentState(data);
}

/**
 * The assigned coordinator adds a line (AC2 to AC5, AC7, AC9).
 *
 * @param {string} eventRequestId
 * @param {object} input
 * @param {string} input.equipmentTypeId
 * @param {number} input.quantity            a whole number above zero
 * @param {string} [input.technicalNotes]
 * @param {string} coordinatorId             the caller, from the JWT, never the body
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<{request: object}>} the event's equipment after the change
 * @throws {ValidationError} every invalid field together; no coordinatorId
 * @throws {ForbiddenError}  the caller is not the assigned coordinator
 * @throws {ConflictError}   the event is not Approved
 * @throws {NotFoundError}   no such event
 */
export async function addEquipmentLine(eventRequestId, input, coordinatorId, { client } = {}) {
  validateEventRequestId(eventRequestId);
  requireCoordinator(coordinatorId);

  const { value, details } = checkAddEquipmentLine(input);
  const db = await resolveClient(client);

  if (value?.equipmentTypeId) {
    details.push(...(await readTypeFaults(db, eventRequestId, value.equipmentTypeId)));
  }
  throwIfInvalid(details);

  const { data, error } = await db.rpc('add_equipment_line', {
    p_event_request_id: eventRequestId,
    p_coordinator_id: coordinatorId,
    p_equipment_type_id: value.equipmentTypeId,
    p_quantity: value.quantity,
    p_technical_notes: value.technicalNotes,
  });
  if (error) throw translateError(error);

  return toEquipmentState(data);
}

/**
 * The assigned coordinator amends a line's quantity, its technical notes, or
 * both (AC6, AC7). Sending technicalNotes as null or blank clears them.
 * Changing the type is refused: remove the line and add a new one.
 *
 * @param {string} eventRequestId
 * @param {string} lineId
 * @param {object} changes
 * @param {number} [changes.quantity]
 * @param {string|null} [changes.technicalNotes]
 * @param {string} coordinatorId             the caller, from the JWT, never the body
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<{request: object}>}
 * @throws {ValidationError} nothing to change, a bad value, or a type change
 * @throws {ForbiddenError}  the caller is not the assigned coordinator
 * @throws {ConflictError}   the event is not Approved
 * @throws {NotFoundError}   no such event, or no such line on it
 */
export async function amendEquipmentLine(
  eventRequestId,
  lineId,
  changes,
  coordinatorId,
  { client } = {},
) {
  validateEventRequestId(eventRequestId);
  validateEquipmentLineId(lineId);
  requireCoordinator(coordinatorId);

  const { value, details } = checkAmendEquipmentLine(changes);
  throwIfInvalid(details);

  const db = await resolveClient(client);

  const { data, error } = await db.rpc('amend_equipment_line', {
    p_event_request_id: eventRequestId,
    p_coordinator_id: coordinatorId,
    p_line_id: lineId,
    p_quantity: value.quantity,
    p_technical_notes: value.technicalNotes,
    p_change_notes: value.changeNotes,
  });
  if (error) throw translateError(error);

  return toEquipmentState(data);
}

/**
 * The assigned coordinator removes a line (AC6, AC7, AC8). Its reservations are
 * released. Removing the last line cancels the request.
 *
 * @param {string} eventRequestId
 * @param {string} lineId
 * @param {string} coordinatorId             the caller, from the JWT, never the body
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<{request: object}>}
 * @throws {ForbiddenError} the caller is not the assigned coordinator
 * @throws {ConflictError}  the event is not Approved
 * @throws {NotFoundError}  no such event, or no such line on it
 */
export async function removeEquipmentLine(eventRequestId, lineId, coordinatorId, { client } = {}) {
  validateEventRequestId(eventRequestId);
  validateEquipmentLineId(lineId);
  requireCoordinator(coordinatorId);

  const db = await resolveClient(client);

  const { data, error } = await db.rpc('remove_equipment_line', {
    p_event_request_id: eventRequestId,
    p_coordinator_id: coordinatorId,
    p_line_id: lineId,
  });
  if (error) throw translateError(error);

  return toEquipmentState(data);
}
