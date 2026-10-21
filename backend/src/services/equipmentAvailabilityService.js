/**
 * The equipment availability check.
 *
 * SCRUM-23, SCRUM-67 and SCRUM-69. A thin wrapper over the equipment_availability
 * function in 024_equipment_availability.sql, which holds the calculation so it
 * lives in exactly one place. The wrapper does only what a database function
 * should not: it validates the request, floors the quantity at zero for display
 * (AC8), picks the result label, turns an unknown or retired type into an
 * "Unavailable" with a message instead of an error (AC11), and names things the
 * way the API does.
 *
 * It never writes (AC12): the function is `stable`, so Postgres would refuse.
 * It has no request or response handling, so the review of an equipment request
 * (SCRUM-290) can call it directly.
 */

import { supabase } from '../config/supabaseClient.js';
import { ValidationError } from '../errors.js';
import { createPgTranslator } from '../http/pgErrors.js';
import { validateAvailabilityRequest } from '../validation/equipmentAvailabilityValidation.js';
import {
  AVAILABILITY_RESULT,
  NOT_FOUND_MESSAGE,
  RETIRED_MESSAGE,
  deriveAvailabilityResult,
} from '../domain/equipmentAvailabilityResult.js';

/** 22023 is the function refusing a period that does not end after it starts. */
const translateError = createPgTranslator({
  codes: { '22023': (_, error) => new ValidationError(`The period was rejected: ${error.message}`) },
});

function toReservation(row) {
  return {
    id: row.id,
    eventRequestId: row.event_request_id,
    eventName: row.event_name,
    quantity: row.quantity,
    startAt: row.start_at,
    endAt: row.end_at,
    flagged: row.flagged,
  };
}

/** An unknown or retired type: Unavailable, with the reason (AC11). */
function cannotBeUsed(request, message) {
  return {
    result: AVAILABILITY_RESULT.UNAVAILABLE,
    quantityRequested: request.quantity,
    quantityAvailable: 0,
    message,
    breakdown: null,
    reservations: [],
  };
}

/**
 * Turn the function's answer into the check's result.
 *
 * Exported for the tests; callers use checkEquipmentAvailability.
 *
 * @param {object|null} answer  what equipment_availability returned
 * @param {{quantity: number}} request
 */
export function toAvailabilityResult(answer, request) {
  if (!answer || answer.found === false) return cannotBeUsed(request, NOT_FOUND_MESSAGE);
  if (answer.retired === true) return cannotBeUsed(request, RETIRED_MESSAGE);

  // Negative means over-committed; people are shown zero (AC8).
  const available = Math.max(0, answer.available);

  return {
    result: deriveAvailabilityResult(answer.available, request.quantity),
    quantityRequested: request.quantity,
    quantityAvailable: available,
    message: null,
    breakdown: {
      total: answer.total,
      damaged: answer.damaged,
      underMaintenance: answer.under_maintenance,
      damagedOrUnderMaintenance: answer.damaged + answer.under_maintenance,
      reserved: answer.reserved,
      available,
    },
    reservations: (answer.reservations ?? []).map(toReservation),
  };
}

/**
 * Check how much of an equipment type is available for a period.
 *
 * @param {object} input  { equipmentTypeId, quantity, startAt, endAt, eventRequestId? }
 * @returns {Promise<object>} { result, quantityRequested, quantityAvailable,
 *   message, breakdown, reservations }; for an unknown or retired type the
 *   result is Unavailable, the message says why and there is no breakdown
 * @throws {ValidationError} listing every invalid input, before any query
 */
export async function checkEquipmentAvailability(input) {
  const request = validateAvailabilityRequest(input);

  const { data, error } = await supabase.rpc('equipment_availability', {
    p_equipment_type_id: request.equipmentTypeId,
    p_start_at: request.startAt,
    p_end_at: request.endAt,
    p_event_request_id: request.eventRequestId,
  });

  if (error) throw translateError(error);

  return toAvailabilityResult(data, request);
}
