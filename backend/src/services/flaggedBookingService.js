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

import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { resolveClient } from '../config/resolveClient.js';
import {
  createPgTranslator,
  forCodes,
  forbidden,
  hintConflict,
  conflict,
  invalid,
} from '../http/pgErrors.js';
import { BOOKING_STATUS, getBookingStatusDisplay } from '../domain/bookingStatus.js';
import {
  suitabilityAtNewTimes,
  suitabilityForApproval,
  toBookingRequest,
  toPeriodConflict,
} from './bookingRequestService.js';
import {
  validateFlaggedBookingEventId,
  validateFlaggedBookingId,
  validateReinstatement,
  validateResolution,
} from '../validation/flaggedBookingValidation.js';

/** PT409 carries the refusal in its hint, so a client can tell them apart. */
const translateError = createPgTranslator({
  missingMessage: 'Unexpected database error',
  codes: {
    '42501': forbidden,
    P0002: (message) => new NotFoundError(message),
    PT409: hintConflict(),
    // The guarded update matched no row: the booking changed under the call.
    '40001': conflict('BOOKING_CHANGED'),
    ...forCodes(['22023', '23514', '22P02'], invalid),
  },
  fallback: (message) => new Error(message),
});

function checkCaller(callerId) {
  if (typeof callerId !== 'string' || callerId.trim() === '') {
    throw new ValidationError(
      'Invalid caller -- callerId: is required',
      [{ field: 'callerId', message: 'is required' }],
    );
  }
}

// previousStartsAt/previousEndsAt are set only when a reinstatement moved the
// booking to its event's new period.
function toResolution(row) {
  return {
    id: row.id,
    outcome: row.outcome,
    reason: row.reason,
    resolvedBy: row.resolved_by,
    resolvedAt: row.created_at,
    previousStartsAt: row.previous_starts_at ?? null,
    previousEndsAt: row.previous_ends_at ?? null,
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

/** One live request raised to replace a flagged booking (078, section 3). */
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
    replacementRequests: (row.replacement_requests ?? []).map(toReplacementRequest),
  };
}

/**
 * Whether reinstating the booking moves it: it can be reinstated and no longer
 * covers its event's period (reinstate_flagged_booking, step 6).
 */
function movesOnReinstate(row) {
  if (row.reinstatable !== true || row.event_starts_at == null || row.event_ends_at == null) return false;
  const covers =
    new Date(row.starts_at) <= new Date(row.event_starts_at) &&
    new Date(row.ends_at) >= new Date(row.event_ends_at);
  return !covers;
}

/**
 * Every booking flagged for review, oldest flag first, each with what flagged
 * it: a block, a review reason, or both when a safety flag sits on a block's,
 * and the live requests replacing it.
 *
 * SCRUM-593: each also carries suitabilityAtNewTimes, the suitability at the
 * event's current period when reinstating would move the booking there (see
 * bookingRequestService's suitabilityAtNewTimes), else null.
 *
 * @param {string} callerId  from the JWT -- never the client
 * @param {object} [options]
 * @param {object} [options.client]
 * @param {Function} [options.checkSuitability]  the N10 check
 * @returns {Promise<object[]>} possibly empty, in camelCase
 * @throws {ValidationError} when no caller was supplied, before any round trip
 * @throws {ForbiddenError}  the caller is not Venue Staff
 */
export async function listFlaggedBookings(callerId, { client, checkSuitability } = {}) {
  checkCaller(callerId);

  const db = await resolveClient(client);
  const { data, error } = await db.rpc('list_flagged_bookings', { p_caller: callerId });

  if (error) throw translateError(error);

  // 078 always answers an array, '[]' when nothing is flagged.
  if (!Array.isArray(data)) {
    throw new Error('Unexpected result from list_flagged_bookings');
  }

  return Promise.all(
    data.map(async (row) => ({
      ...toFlaggedBooking(row),
      suitabilityAtNewTimes: await suitabilityAtNewTimes(row, movesOnReinstate(row), {
        checkSuitability,
        client: db,
      }),
    })),
  );
}

/**
 * One event's bookings flagged for review, for its assigned coordinator: the
 * shape listFlaggedBookings gives.
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

  return data.map(toFlaggedBooking);
}

/**
 * Reinstate a flagged booking: approved again, with its flag cleared, once
 * nothing else occupies the venue. A booking the event has moved off is
 * checked, and approved, at the event's current period; one that still covers
 * it keeps its own. Only this booking changes; the event's other bookings are
 * untouched.
 *
 * SCRUM-593: input also names the period Venue Staff were shown
 * (expectedStartsAt, expectedEndsAt); if the booking would now be reinstated
 * at another, nothing is written and this throws BOOKING_PERIOD_CHANGED. A
 * reinstatement that moves the booking records the suitability at the new
 * period (suitabilityForApproval), unsuitable or not, as
 * approval_suitability_result; the request-time result and override stay.
 *
 * @param {string} bookingId  the flagged booking's id
 * @param {string} callerId   from the JWT -- never the body
 * @param {object} input      see validateReinstatement
 * @param {object} [options]
 * @param {object} [options.client]
 * @param {Function} [options.checkSuitability]  the N10 check
 * @returns {Promise<object>} the booking, now approved, with `resolution`
 * @throws {ValidationError} no caller, a malformed id, a missing or long
 *                           reason, or a missing or malformed expected
 *                           period, before any round trip
 * @throws {NotFoundError}   no such booking
 * @throws {ForbiddenError}  the caller is not Venue Staff
 * @throws {ConflictError}   by code: BOOKING_NOT_FLAGGED,
 *                           SAFETY_FLAG_NOT_REINSTATABLE, EVENT_NOT_BOOKABLE,
 *                           BOOKING_PERIOD_STALE (the event has no period),
 *                           BOOKING_PERIOD_CHANGED (not the period shown),
 *                           VENUE_RETIRED, BOOKING_PERIOD_CONFLICT (conflicts
 *                           shaped by toPeriodConflict), BOOKING_CHANGED
 */
export async function reinstateFlaggedBooking(bookingId, callerId, input, { client, checkSuitability } = {}) {
  checkCaller(callerId);
  const id = validateFlaggedBookingId(bookingId);
  const { reason, ...period } = validateReinstatement(input);

  const db = await resolveClient(client);
  const suitability = await suitabilityForApproval(db, id, period, { checkSuitability });
  const { data, error } = await db.rpc('reinstate_flagged_booking', {
    p_booking_id: id,
    p_caller: callerId,
    p_reason: reason,
    p_expected_starts_at: period.startsAt,
    p_expected_ends_at: period.endsAt,
    p_suitability: suitability,
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
