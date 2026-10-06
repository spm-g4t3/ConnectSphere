/**
 * Booking request service.
 *
 * SCRUM-252, a subtask of SCRUM-243 (Submit a Venue Booking Request).
 *
 * A coordinator requests a venue for an approved or confirmed event. The
 * request is a bookings row in the 'pending' status, written by
 * create_booking_request in 030_create_booking_request.sql rather than by a
 * direct insert, for the reason 012 gives for block creation: the checks have
 * to hold until the insert commits, and supabase-js gives each call its own
 * transaction. The function locks the event row and then the venue row ("for
 * share", the protocol SCRUM-17's migrations 013 to 015 set out for the booking
 * writer), and only then checks the event, the venue, the period and the
 * event's existing requests.
 *
 * What this module adds around that function:
 *
 *  - Input is validated before any network call.
 *  - The event is read first, so an unknown event, a coordinator who does not
 *    hold it, or an event in the wrong status is refused before the suitability
 *    check runs. This is the pattern requestEventClarification uses. It is a
 *    courtesy: the function checks the same things again under its lock, and
 *    that is the answer that counts.
 *  - Suitability (N10) is computed here, server-side, through an injectable
 *    checker, and passed to the function. A venue that is not suitable is
 *    requested only with confirmUnsuitable. N10 is not built, so the default
 *    checker fails closed; see venueSuitabilityService.js.
 *  - What the function raises or answers is turned into typed errors, with the
 *    conflicting records in `conflicts` for the UI.
 *
 * Not here: notifying Venue Staff. SCRUM-174 owns the types and recipients and
 * it is not built; 030 marks where its insert goes.
 *
 * The service takes an optional client for the reason eventRequestService.js
 * gives, so it can be tested without credentials.
 */

import {
  ValidationError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} from '../errors.js';
import { validateCreateBookingRequest } from '../validation/bookingRequestValidation.js';
import { getEventRequestForCoordinator } from './eventRequestService.js';
import { checkVenueSuitability } from './venueSuitabilityService.js';
import { STATUS } from '../domain/eventRequestStatus.js';
import { BOOKING_STATUS } from '../domain/bookingStatus.js';

/** The event statuses a venue can be requested for (SCRUM-243 AC1). */
const BOOKABLE_EVENT_STATUSES = Object.freeze([STATUS.APPROVED, STATUS.CONFIRMED]);

/** The shape gen_random_uuid() produces; what a clashing booking's id looks like. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres codes that mean "the input was wrong", whoever caught it. */
const VALIDATION_CODES = new Set([
  '23514', // check constraint: setup notes too long
  '22023', // invalid_parameter_value: no suitability result from the caller
  '23502', // not null
  '22P02', // invalid text representation
]);

async function resolveClient(client) {
  if (client) return client;

  const { supabase } = await import('../config/supabaseClient.js');
  return supabase;
}

/**
 * Turn a raw Postgres error into a typed one.
 *
 * PT409 carries the reason in its hint, so a client can tell the refusals apart
 * without reading prose. BOOKING_REQUEST_EXISTS and BOOKING_FLAGGED_FOR_REVIEW
 * carry the existing booking's id in DETAIL, which becomes the conflict list;
 * only a uuid is trusted there.
 */
function translateError(error) {
  const code = error.code;
  const detail = error.message ?? '';

  if (VALIDATION_CODES.has(code)) {
    return new ValidationError(`A value was rejected by the database: ${detail}`);
  }

  // Reached only for the layout: the venue and event rows were locked, and the
  // requester is the authenticated user.
  if (code === '23503') {
    return new ValidationError(`A referenced record does not exist: ${detail}`);
  }

  if (code === 'P0002') {
    return new NotFoundError(detail || 'Event request or venue not found');
  }

  if (code === '42501') {
    return new ForbiddenError(detail);
  }

  if (code === 'PT409') {
    const hint = error.hint ?? null;
    const bookingId = typeof error.details === 'string' ? error.details.trim() : '';
    const conflicts =
      (hint === 'BOOKING_REQUEST_EXISTS' || hint === 'BOOKING_FLAGGED_FOR_REVIEW') &&
      UUID_PATTERN.test(bookingId)
        ? [{ kind: 'booking_request', bookingId }]
        : [];
    return new ConflictError(detail, { code: hint, conflicts });
  }

  return new Error(detail || 'Unexpected database error');
}

/**
 * One thing in the way of the period, in camelCase: a venue block, or an
 * approved booking.
 *
 * @param {object} entry  from create_booking_request's conflicts list
 */
function toPeriodConflict(entry) {
  if (entry.kind === 'block') {
    return {
      kind: 'block',
      blockId: entry.block_id,
      startsAt: entry.starts_at,
      endsAt: entry.ends_at,
      reason: entry.reason,
    };
  }
  return {
    kind: 'booking',
    bookingId: entry.booking_id,
    eventRequestId: entry.event_request_id,
    eventName: entry.event_name,
    startsAt: entry.starts_at,
    endsAt: entry.ends_at,
  };
}

/**
 * A bookings row for a request, in the camelCase every other service returns.
 *
 * @param {object} row  snake_case, from to_jsonb in create_booking_request
 */
export function toBookingRequest(row) {
  return {
    id: row.id,
    eventRequestId: row.event_request_id,
    venueId: row.venue_id,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    roomLayoutCode: row.room_layout_code ?? null,
    venueRequirements: row.venue_requirements ?? null,
    accessibilityRequirements: row.accessibility_requirements ?? null,
    setupNotes: row.setup_notes ?? null,
    suitability: row.suitability_result ?? null,
    suitabilityOverridden: row.suitability_overridden ?? false,
    requestedBy: row.requested_by ?? null,
    createdAt: row.created_at,
  };
}

/**
 * The checker's answer, checked. It crosses a module boundary that N10 will
 * own, and it is stored as given, so a malformed one is a fault here and not
 * something to pass to the database.
 */
function checkedSuitability(result) {
  if (
    typeof result !== 'object' ||
    result === null ||
    typeof result.suitable !== 'boolean' ||
    !Array.isArray(result.criteria)
  ) {
    throw new Error('The suitability check returned an unusable result');
  }
  return { suitable: result.suitable, criteria: result.criteria };
}

/**
 * Request a venue for an event.
 *
 * @param {object} input        see validateCreateBookingRequest
 * @param {string} userId       the caller, from the JWT -- never the body
 * @param {object} [options]
 * @param {object} [options.client]
 * @param {Function} [options.checkSuitability]  the N10 check; see
 *                              venueSuitabilityService.js for its contract
 * @returns {Promise<object>} the new pending request, shaped by toBookingRequest
 * @throws {ValidationError} bad input, before any network call
 * @throws {NotFoundError}   no such event, or no such venue
 * @throws {ForbiddenError}  the caller is not the event's assigned coordinator
 * @throws {ConflictError}   by code: EVENT_NOT_BOOKABLE, EVENT_DATES_MISSING,
 *                           VENUE_RETIRED, BOOKING_REQUEST_EXISTS and
 *                           BOOKING_FLAGGED_FOR_REVIEW (conflicts name the
 *                           existing booking), BOOKING_PERIOD_CONFLICT
 *                           (conflicts are blocks and approved bookings, shaped
 *                           by toPeriodConflict), SUITABILITY_CONFIRMATION_REQUIRED
 *                           (conflicts are the criteria not met)
 * @throws {ServiceUnavailableError} the suitability check is not available
 */
export async function createBookingRequest(
  input,
  userId,
  { client, checkSuitability = checkVenueSuitability } = {},
) {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new ValidationError('A signed-in user is required to request a venue');
  }
  const request = validateCreateBookingRequest(input);

  const db = await resolveClient(client);

  const event = await getEventRequestForCoordinator(request.eventRequestId, { client: db });

  if (event.assignedCoordinatorId !== userId) {
    throw new ForbiddenError(
      `Only the coordinator assigned to event request ${event.id} can request a venue for it.`,
    );
  }

  if (!BOOKABLE_EVENT_STATUSES.includes(event.status)) {
    throw new ConflictError(
      `A venue can only be requested for an approved or confirmed event; this one is ${event.status}`,
      { code: 'EVENT_NOT_BOOKABLE' },
    );
  }

  const suitability = checkedSuitability(
    await checkSuitability({
      eventRequestId: request.eventRequestId,
      venueId: request.venueId,
      roomLayoutCode: request.roomLayoutCode,
      client: db,
    }),
  );

  const { data, error } = await db.rpc('create_booking_request', {
    p_event_request_id: request.eventRequestId,
    p_venue_id: request.venueId,
    p_requested_by: userId,
    p_room_layout_code: request.roomLayoutCode,
    p_setup_notes: request.setupNotes,
    p_suitability: suitability,
    p_confirm_unsuitable: request.confirmUnsuitable,
  });

  if (error) throw translateError(error);

  // Blocks or approved bookings overlap the event's period; nothing was written.
  if (data?.outcome === 'conflict') {
    throw new ConflictError('The venue is not available for the whole of this event', {
      code: 'BOOKING_PERIOD_CONFLICT',
      conflicts: (data.conflicts ?? []).map(toPeriodConflict),
    });
  }

  // The venue is not suitable and the coordinator has not confirmed; nothing
  // was written. The UI warns, then resends with confirmUnsuitable.
  if (data?.outcome === 'suitability_confirmation_required') {
    throw new ConflictError(
      'This venue does not meet the event\'s requirements; confirm to request it anyway',
      {
        code: 'SUITABILITY_CONFIRMATION_REQUIRED',
        conflicts: suitability.criteria.filter((criterion) => criterion?.met === false),
      },
    );
  }

  // An outcome this build does not know. Failing loudly beats reporting a
  // request that may not exist.
  if (data?.outcome !== 'created') {
    throw new Error(`Unexpected outcome from create_booking_request: ${data?.outcome}`);
  }

  const booking = toBookingRequest(data.booking);
  if (booking.status !== BOOKING_STATUS.PENDING) {
    throw new Error(`create_booking_request returned a ${booking.status} booking, not a pending one`);
  }
  return booking;
}
