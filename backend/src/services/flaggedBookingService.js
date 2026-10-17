/**
 * Bookings flagged for review: Venue Staff list them and reinstate them, the
 * event's coordinator lists that event's, and the coordinator or Venue Staff
 * cancel them.
 *
 * The rules, the locks and the record of the resolution live in
 * list_flagged_bookings and list_event_flagged_bookings (078),
 * reinstate_flagged_booking (076) and
 * cancel_flagged_booking (077); this module checks the input, makes the call
 * and maps the answer. The client is optional, so it tests without
 * credentials.
 */

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../errors.js';
import { BOOKING_STATUS, getBookingStatusDisplay } from '../domain/bookingStatus.js';
import { toBookingRequest, toPeriodConflict } from './bookingRequestService.js';
import {
  validateFlaggedBookingEventId,
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

/** The booking as the API shows it, with the resolution just recorded. */
function toResolvedBooking(data) {
  return {
    ...toBookingRequest(data.booking),
    statusDisplay: getBookingStatusDisplay(data.booking.status),
    resolution: toResolution(data.resolution),
  };
}

/** The block that flagged the booking, or null when no block did. */
function toFlagBlock(row) {
  if (!row.block_id) return null;
  return {
    id: row.block_id,
    reason: row.block_reason ?? null,
    notes: row.block_notes ?? null,
    startsAt: row.block_starts_at ?? null,
    endsAt: row.block_ends_at ?? null,
    removedAt: row.block_removed_at ?? null,
  };
}

/** @param {object} row  one element of list_flagged_bookings (078) */
function toFlaggedBooking(row) {
  return {
    id: row.id,
    eventRequestId: row.event_request_id,
    venueId: row.venue_id,
    statusDisplay: getBookingStatusDisplay(BOOKING_STATUS.FLAGGED_FOR_REVIEW),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    occupiedStartsAt: row.occupied_starts_at ?? null,
    occupiedEndsAt: row.occupied_ends_at ?? null,
    // Null on a booking flagged before 014, which recorded no flag time.
    flaggedAt: row.flagged_at ?? null,
    flaggedBy: row.flagged_by ?? null,
    reviewReason: row.review_reason ?? null,
    eventName: row.event_name ?? null,
    eventStatus: row.event_status ?? null,
    eventStartsAt: row.event_starts_at ?? null,
    eventEndsAt: row.event_ends_at ?? null,
    assignedCoordinatorId: row.assigned_coordinator_id ?? null,
    venueName: row.venue_name ?? null,
    venueLocation: row.venue_location ?? null,
    block: toFlagBlock(row),
    reinstatable: row.reinstatable === true,
  };
}

/**
 * Every booking flagged for review, oldest flag first, each with what flagged
 * it: a block, a review reason, or both when a safety flag sits on a block's.
 *
 * @param {string} callerId  from the JWT -- never the client
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<object[]>} possibly empty, in camelCase
 * @throws {ValidationError} when no caller was supplied, before any round trip
 * @throws {ForbiddenError}  the caller is not Venue Staff
 */
export async function listFlaggedBookings(callerId, { client } = {}) {
  checkCaller(callerId);

  const db = await resolveClient(client);
  const { data, error } = await db.rpc('list_flagged_bookings', { p_caller: callerId });

  if (error) throw translateError(error);

  // 078 always answers an array, '[]' when nothing is flagged.
  if (!Array.isArray(data)) {
    throw new Error('Unexpected result from list_flagged_bookings');
  }

  return data.map(toFlaggedBooking);
}

/** One live request raised to replace a flagged booking (078, section 4). */
function toReplacementRequest(row) {
  return {
    id: row.id,
    venueId: row.venue_id,
    venueName: row.venue_name ?? null,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdAt: row.created_at,
  };
}

/**
 * One event's bookings flagged for review, for its assigned coordinator: the
 * shape listFlaggedBookings gives, each with the live requests replacing it.
 *
 * @param {string} eventRequestId
 * @param {string} callerId  from the JWT -- never the client
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<object[]>} possibly empty, in camelCase
 * @throws {ValidationError} no caller or a malformed event id, before any round trip
 * @throws {NotFoundError}   no such event
 * @throws {ForbiddenError}  the caller is not the event's assigned coordinator
 */
export async function listEventFlaggedBookings(eventRequestId, callerId, { client } = {}) {
  checkCaller(callerId);
  const eventId = validateFlaggedBookingEventId(eventRequestId);

  const db = await resolveClient(client);
  const { data, error } = await db.rpc('list_event_flagged_bookings', {
    p_caller: callerId,
    p_event_request_id: eventId,
  });

  if (error) throw translateError(error);

  if (!Array.isArray(data)) {
    throw new Error('Unexpected result from list_event_flagged_bookings');
  }

  return data.map((row) => ({
    ...toFlaggedBooking(row),
    replacementRequests: (row.replacement_requests ?? []).map(toReplacementRequest),
  }));
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

  return toResolvedBooking(data);
}

/**
 * Cancel a flagged booking, whatever flagged it. The flag stays on the booking
 * as a record; the event and its other bookings are untouched, and the
 * coordinator can then request another venue or period.
 *
 * @param {string} bookingId  the flagged booking's id
 * @param {string} callerId   from the JWT -- never the body
 * @param {object} input      see validateResolution
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<object>} the booking, now cancelled, with `resolution`
 * @throws {ValidationError} no caller, a malformed id or a missing or long
 *                           reason, before any round trip
 * @throws {NotFoundError}   no such booking
 * @throws {ForbiddenError}  the caller is neither the event's assigned
 *                           coordinator nor Venue Staff
 * @throws {ConflictError}   by code: BOOKING_NOT_FLAGGED, BOOKING_CHANGED
 */
export async function cancelFlaggedBooking(bookingId, callerId, input, { client } = {}) {
  checkCaller(callerId);
  const id = validateFlaggedBookingId(bookingId);
  const { reason } = validateResolution(input);

  const db = await resolveClient(client);
  const { data, error } = await db.rpc('cancel_flagged_booking', {
    p_booking_id: id,
    p_caller: callerId,
    p_reason: reason,
  });

  if (error) throw translateError(error);

  if (data?.outcome !== 'cancelled') {
    throw new Error(`Unexpected outcome from cancel_flagged_booking: ${data?.outcome}`);
  }

  return toResolvedBooking(data);
}
