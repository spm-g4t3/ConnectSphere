/**
 * Venue Staff resolving a booking flagged for review.
 *
 * The rules, the locks and the record of the resolution live in
 * reinstate_flagged_booking (076); this module checks the input, makes the
 * call and maps the answer. The client is optional, so it tests without
 * credentials.
 */

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../errors.js';
import { getBookingStatusDisplay } from '../domain/bookingStatus.js';
import { toBookingRequest, toPeriodConflict } from './bookingRequestService.js';
import {
  validateFlaggedBookingId,
  validateResolution,
} from '../validation/flaggedBookingValidation.js';

async function resolveClient(client) {
  if (client) return client;
  const { supabase } = await import('../config/supabaseClient.js');
  return supabase;
}

/** PT409 carries the refusal in its hint, so a client can tell them apart. */
function translateError(error) {
  const code = error.code;
  const message = error.message ?? 'Unexpected database error';

  if (code === '42501') return new ForbiddenError(message);
  if (code === 'P0002') return new NotFoundError(message);
  if (code === 'PT409') return new ConflictError(message, { code: error.hint ?? null });
  // The guarded update matched no row: the booking changed under the call.
  if (code === '40001') return new ConflictError(message, { code: 'BOOKING_CHANGED' });
  if (code === '22023' || code === '23514' || code === '22P02') {
    return new ValidationError(message);
  }
  return new Error(message);
}

function checkCaller(callerId) {
  if (typeof callerId !== 'string' || callerId.trim() === '') {
    throw new ValidationError(
      'Invalid caller -- callerId: is required',
      [{ field: 'callerId', message: 'is required' }],
    );
  }
}

function toResolution(row) {
  return {
    id: row.id,
    outcome: row.outcome,
    reason: row.reason,
    resolvedBy: row.resolved_by,
    resolvedAt: row.created_at,
  };
}

/**
 * Reinstate a flagged booking: approved again, with its flag cleared, once it
 * still covers the event's period and nothing else occupies the venue. Only
 * this booking changes; the event's other bookings are untouched.
 *
 * @param {string} bookingId  the flagged booking's id
 * @param {string} callerId   from the JWT -- never the body
 * @param {object} input      see validateResolution
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<object>} the booking, now approved, with `resolution`
 * @throws {ValidationError} no caller, a malformed id or a missing or long
 *                           reason, before any round trip
 * @throws {NotFoundError}   no such booking
 * @throws {ForbiddenError}  the caller is not Venue Staff
 * @throws {ConflictError}   by code: BOOKING_NOT_FLAGGED,
 *                           SAFETY_FLAG_NOT_REINSTATABLE, EVENT_NOT_BOOKABLE,
 *                           BOOKING_PERIOD_STALE, VENUE_RETIRED,
 *                           BOOKING_PERIOD_CONFLICT (conflicts shaped by
 *                           toPeriodConflict), BOOKING_CHANGED
 */
export async function reinstateFlaggedBooking(bookingId, callerId, input, { client } = {}) {
  checkCaller(callerId);
  const id = validateFlaggedBookingId(bookingId);
  const { reason } = validateResolution(input);

  const db = await resolveClient(client);
  const { data, error } = await db.rpc('reinstate_flagged_booking', {
    p_booking_id: id,
    p_caller: callerId,
    p_reason: reason,
  });

  if (error) throw translateError(error);

  // Something else now occupies the booking's padded period; nothing was written.
  if (data?.outcome === 'conflict') {
    throw new ConflictError('The venue is no longer available for the whole of this booking', {
      code: 'BOOKING_PERIOD_CONFLICT',
      conflicts: (data.conflicts ?? []).map(toPeriodConflict),
    });
  }

  if (data?.outcome !== 'reinstated') {
    throw new Error(`Unexpected outcome from reinstate_flagged_booking: ${data?.outcome}`);
  }

  return {
    ...toBookingRequest(data.booking),
    statusDisplay: getBookingStatusDisplay(data.booking.status),
    resolution: toResolution(data.resolution),
  };
}
