/**
 * Booking request service.
 *
 * SCRUM-252, a subtask of SCRUM-243 (Submit a Venue Booking Request).
 *
 * A coordinator requests a venue for an approved, safety-checked or confirmed
 * event. The request is a bookings row in the 'pending' status, written by
 * create_booking_request in 066_decide_booking_request.sql (first written by
 * 030) rather than by a direct insert, for the reason 012 gives
 * for block creation: the checks have
 * to hold until the insert commits, and supabase-js gives each call its own
 * transaction. The function locks the event row and then the venue row ("for
 * share", the protocol SCRUM-17's migrations 013 to 015 set out for the booking
 * writer), and only then checks the event, the venue, the period and the
 * event's live request at this venue (SCRUM-525: one per venue, not one per
 * event, since 051).
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
 *    requested only with confirmUnsuitable and, since SCRUM-193/194, only
 *    when acknowledgedCriteria names every criterion it does not meet. The
 *    default checker is
 *    venueSuitabilityService.js (SCRUM-190); the request carries the
 *    accessibility and facility codes it judges, and the caller, so the
 *    check enforces the assigned coordinator itself.
 *  - What the function raises or answers is turned into typed errors, with the
 *    conflicting records in `conflicts` for the UI.
 *
 * SCRUM-484: 033_venue_occupancy_callers.sql redefines the function's period
 * check to call venue_occupancy_conflicts() (032), so the event's period and
 * every occupying booking's are padded with the venue's setup and turnaround,
 * and flagged bookings count as occupying. This module only maps the result.
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
import {
  validateCreateBookingRequest,
  validateBookingRequestId,
  validateRejectBookingRequest,
} from '../validation/bookingRequestValidation.js';
import { getEventRequestForCoordinator } from './eventRequestService.js';
import { checkVenueSuitability } from './venueSuitabilityService.js';
import { STATUS } from '../domain/eventRequestStatus.js';
import { BOOKING_STATUS, getBookingStatusDisplay } from '../domain/bookingStatus.js';
import { toSuitabilityRecord } from '../domain/suitabilityRecord.js';

/**
 * The event statuses a venue can be requested for (SCRUM-243 AC1), and since
 * SCRUM-260 approved for: past approval and still live, through the safety
 * check. create_booking_request and decide_booking_request (068) hold the same list.
 */
const BOOKABLE_EVENT_STATUSES = Object.freeze([
  STATUS.APPROVED,
  STATUS.SAFETY_REVIEW,
  STATUS.SAFETY_APPROVED,
  STATUS.CONFIRMED,
]);

/** The shape gen_random_uuid() produces; what a clashing booking's id looks like. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres codes that mean "the input was wrong", whoever caught it. */
const VALIDATION_CODES = new Set([
  '23514', // check constraint: setup notes too long
  // invalid_parameter_value: no suitability result, or an expected attendance
  // below 1 or above the event's (051)
  '22023',
  // numeric_value_out_of_range: an expectedAttendance above Postgres's integer
  // maximum. checkAttendance refuses one (MAX_ATTENDANCE), so this is a
  // backstop for a caller that skips validation; it is still the caller's
  // input that was wrong, so a 400, not a 500.
  '22003',
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

  // serialization_failure: withdraw_booking_request's or decide_booking_request's
  // guarded update matched no row, meaning the request changed under it. 031
  // explains why that cannot happen while the locks hold; if it does, the
  // caller reloads.
  if (code === '40001') {
    return new ConflictError(detail, { code: 'BOOKING_CHANGED' });
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
 * One thing in the way of the period, in camelCase: a venue block, an
 * occupying booking (approved or flagged_for_review, SCRUM-484), or another
 * event's active hold (SCRUM-491).
 *
 * SCRUM-484 (AC7): both kinds carry the occupied period and the venue's
 * setup and turnaround minutes from venue_occupancy_conflicts() (032/033).
 * For a booking, occupiedStartsAt/occupiedEndsAt are its period padded by the
 * venue's minutes, so the screen can show "Setup · Event · Turnaround". For a
 * block they equal its own period -- a block is never padded -- and the
 * minutes say how far this event's own setup and turnaround reached into it.
 * Mapped here, not recomputed, so the formula stays in one place (AC4).
 *
 * SCRUM-491 (AC4, AC5): a third kind, 'hold', is another event's active
 * tentative hold (040). It carries the holding event and its occupied period,
 * padded like a booking. Exported so venueHoldService.js maps the conflicts
 * place_venue_hold returns the same way; both lists are built by
 * occupancy_conflict_json() in 040.
 *
 * @param {object} entry  from create_booking_request's or place_venue_hold's
 *                        conflicts list
 */
export function toPeriodConflict(entry) {
  const occupied = {
    occupiedStartsAt: entry.occupied_starts_at,
    occupiedEndsAt: entry.occupied_ends_at,
    setupMinutes: entry.setup_minutes,
    turnaroundMinutes: entry.turnaround_minutes,
  };
  if (entry.kind === 'block') {
    return {
      kind: 'block',
      blockId: entry.block_id,
      startsAt: entry.starts_at,
      endsAt: entry.ends_at,
      reason: entry.reason,
      ...occupied,
    };
  }
  if (entry.kind === 'hold') {
    return {
      kind: 'hold',
      holdId: entry.hold_id,
      eventRequestId: entry.event_request_id,
      eventName: entry.event_name,
      startsAt: entry.starts_at,
      endsAt: entry.ends_at,
      ...occupied,
    };
  }
  return {
    kind: 'booking',
    bookingId: entry.booking_id,
    eventRequestId: entry.event_request_id,
    eventName: entry.event_name,
    startsAt: entry.starts_at,
    endsAt: entry.ends_at,
    ...occupied,
  };
}

/**
 * PostgREST embeds a many-to-one as an object, but an array if it were ever
 * read as one-to-many. Read defensively, as venueCalendarService does.
 */
function one(embedded) {
  return Array.isArray(embedded) ? embedded[0] : embedded;
}

/** What the list reads: the booking, with its event and its venue embedded. */
const LIST_COLUMNS = `
  id, event_request_id, venue_id, starts_at, ends_at, status,
  room_layout_code, setup_notes, suitability_overridden, created_at, flagged_at, review_reason,
  venues(name, location),
  event_requests!inner(event_name, status, assigned_coordinator_id)
`;

/**
 * One row of the coordinator's list, in camelCase, with the event and venue
 * details beside the request.
 *
 * statusDisplay is the label and group for the status (domain/bookingStatus.js),
 * so the screen keeps no copy of the vocabulary. flaggedAt is the review
 * indicator for a booking a venue block has flagged (014); null otherwise.
 * reviewReason is the code a setup or turnaround change stored when it
 * flagged the booking (034, 'setup_or_turnaround_changed'); null for a block
 * flag or an unflagged booking.
 *
 * @param {object} row  from LIST_COLUMNS
 */
function toBookingRequestListItem(row) {
  const event = one(row.event_requests) ?? {};
  const venue = one(row.venues) ?? {};
  return {
    id: row.id,
    eventRequestId: row.event_request_id,
    eventName: event.event_name ?? null,
    eventStatus: event.status ?? null,
    venueId: row.venue_id,
    venueName: venue.name ?? null,
    venueLocation: venue.location ?? null,
    status: row.status,
    statusDisplay: getBookingStatusDisplay(row.status),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    roomLayoutCode: row.room_layout_code ?? null,
    setupNotes: row.setup_notes ?? null,
    suitabilityOverridden: row.suitability_overridden ?? false,
    flaggedAt: row.flagged_at ?? null,
    reviewReason: row.review_reason ?? null,
    createdAt: row.created_at,
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
    // SCRUM-525: the attendance this venue was requested for (051).
    expectedAttendance: row.expected_attendance ?? null,
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
 * The checker's answer, checked. It crosses a module boundary that N10 owns,
 * and it is stored as given, so a malformed one is a fault here and not
 * something to pass to the database.
 *
 * SCRUM-190: `checked` -- the period, attendance and requirement codes the
 * check judged -- is kept when the checker gives it, so suitability_result
 * records what was assessed and Venue Staff read the verdict against it. It
 * is optional so a checker that gives none (a test double) still passes; only
 * suitable and criteria are required, as before.
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
  const suitability = { suitable: result.suitable, criteria: result.criteria };
  if (typeof result.checked === 'object' && result.checked !== null) {
    suitability.checked = result.checked;
  }
  return suitability;
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
 * @throws {ValidationError} bad input, before any network call; or an
 *                           expectedAttendance above the event's, once read
 * @throws {NotFoundError}   no such event, or no such venue
 * @throws {ForbiddenError}  the caller is not the event's assigned coordinator
 * @throws {ConflictError}   by code: EVENT_NOT_BOOKABLE, EVENT_DATES_MISSING,
 *                           EVENT_ATTENDANCE_MISSING (SCRUM-525: neither the
 *                           request nor the event gives an attendance),
 *                           VENUE_RETIRED, BOOKING_REQUEST_EXISTS and
 *                           BOOKING_FLAGGED_FOR_REVIEW at this venue
 *                           (conflicts name the existing booking),
 *                           BOOKING_PERIOD_CONFLICT
 *                           (conflicts are blocks, occupying bookings and
 *                           other events' active holds (SCRUM-491),
 *                           each with its occupied period, shaped by
 *                           toPeriodConflict), SUITABILITY_CONFIRMATION_REQUIRED
 *                           (conflicts are the criteria not met)
 *
 * SCRUM-190: input may also carry accessibility and facilities, code lists
 * passed to the checker with the caller. An unknown code is a ValidationError
 * from the check, before anything is written.
 *
 * SCRUM-525: input may also carry expectedAttendance, the number of people
 * this venue is for; absent, it is the event's. That one number is both the
 * one Capacity is judged on and the one stored on the booking, so the verdict
 * the coordinator saw is about what Venue Staff will read. A number above the
 * event's (when it has one) is a ValidationError on expectedAttendance, before
 * the check or the function runs. With neither number, this
 * throws EVENT_ATTENDANCE_MISSING after the coordinator and status checks (a
 * stranger learns nothing about the event) and before the check or the
 * function runs, so nothing is judged against no number and nothing written.
 *
 * SCRUM-193/194 (F2, SCRUM-188 AC7, "any criterion the coordinator chose to
 * override"): input may carry acknowledgedCriteria, the criterion labels the
 * coordinator accepts the venue does not meet. An unsuitable result counts as
 * confirmed only when confirmUnsuitable is true AND every criterion the check
 * (run here, now) found unmet is named there. Otherwise this throws
 * SUITABILITY_CONFIRMATION_REQUIRED, with the unmet criteria as conflicts,
 * before create_booking_request is called and so before anything is written.
 * That is what stops a confirmation given against an earlier check -- one
 * where only Capacity failed, say -- from also covering an Availability
 * failure that has appeared since: the coordinator is asked again, naming
 * the new criterion. confirmUnsuitable alone, without the names, is therefore
 * asked again too. No migration was needed: the overridden criteria are the
 * unmet ones of the stored result, and they are now exactly the ones the
 * coordinator named (domain/suitabilityRecord.js derives them).
 *
 * The race that remains is small: between this check and the moment
 * create_booking_request takes its locks, the venue's attributes (an
 * update_venue) or, when the request takes the event's attendance, that
 * attendance could change. The function
 * re-checks the period under its locks, so a new booking, block or hold is
 * still refused as BOOKING_PERIOD_CONFLICT; an attribute change in that
 * window is not re-judged, and the stored result is the one computed here.
 * SCRUM-188 AC6's recheck-on-view then reports it on the event.
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
      `A venue can only be requested for an approved, safety-checked or confirmed event; this one is ${event.status}`,
      { code: 'EVENT_NOT_BOOKABLE' },
    );
  }

  // SCRUM-525 (R4, R12): the request's own number, else the event's. Refused
  // here, not left to the check or to 051's guard, so neither runs without one.
  const expectedAttendance = request.expectedAttendance ?? event.expectedAttendance ?? null;
  if (expectedAttendance === null) {
    throw new ConflictError(
      'This event has no expected attendance; give one for this venue to request it',
      { code: 'EVENT_ATTENDANCE_MISSING' },
    );
  }
  // AC2: a venue is never for more people than the event. Checked only here,
  // at request time, so lowering the event's attendance later leaves
  // existing bookings valid. 051 repeats it under the event lock.
  if (
    request.expectedAttendance !== null &&
    event.expectedAttendance != null &&
    request.expectedAttendance > event.expectedAttendance
  ) {
    const message = `must be at most the event's expected attendance (${event.expectedAttendance})`;
    throw new ValidationError(`Invalid booking request -- expectedAttendance: ${message}`, [
      { field: 'expectedAttendance', message },
    ]);
  }

  const suitability = checkedSuitability(
    await checkSuitability({
      eventRequestId: request.eventRequestId,
      venueId: request.venueId,
      roomLayoutCode: request.roomLayoutCode,
      accessibility: request.accessibility,
      facilities: request.facilities,
      expectedAttendance,
      userId,
      client: db,
    }),
  );

  // SCRUM-193/194 (F2): an unsuitable venue is confirmed only for the
  // criteria the coordinator named; see the doc comment.
  let confirmUnsuitable = request.confirmUnsuitable;
  if (!suitability.suitable) {
    const unmet = suitability.criteria.filter((criterion) => criterion?.met === false);
    const acknowledged = new Set(request.acknowledgedCriteria);
    confirmUnsuitable =
      request.confirmUnsuitable && unmet.every((criterion) => acknowledged.has(criterion.criterion));
    if (!confirmUnsuitable) {
      throw new ConflictError(
        'This venue does not meet the event\'s requirements; confirm to request it anyway',
        { code: 'SUITABILITY_CONFIRMATION_REQUIRED', conflicts: unmet },
      );
    }
  }

  const { data, error } = await db.rpc('create_booking_request', {
    p_event_request_id: request.eventRequestId,
    p_venue_id: request.venueId,
    p_requested_by: userId,
    p_room_layout_code: request.roomLayoutCode,
    p_setup_notes: request.setupNotes,
    p_suitability: suitability,
    p_confirm_unsuitable: confirmUnsuitable,
    // SCRUM-525: the number just judged, so what is stored is what was checked.
    p_expected_attendance: expectedAttendance,
  });

  if (error) throw translateError(error);

  // Blocks or occupying bookings meet the event's occupied period -- both
  // padded with the venue's setup and turnaround (SCRUM-484, 033); nothing
  // was written.
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

/**
 * The coordinator's booking requests and their statuses.
 *
 * SCRUM-255. Every booking on an event assigned to the caller, newest first,
 * whatever its status: pending, approved, flagged for review, rejected,
 * withdrawn and cancelled. The caller is the only input and comes from the
 * token; there is no parameter that could ask for someone else's.
 *
 * The scope is the event's assigned coordinator, the same rule that gates
 * creating and withdrawing (030, 031). It is applied in the query, as an inner
 * join on the event narrowed by assigned_coordinator_id, so a booking on
 * anyone else's event is never read. The rows are then checked against the
 * caller once more in code. That repeats a rule, which this codebase usually
 * avoids, and is kept on purpose: this is the read that could leak another
 * coordinator's requests, and a filter PostgREST silently ignores -- a
 * misspelt embed or column -- would otherwise fail open. After a handover the
 * new coordinator sees the event's requests and the previous one no longer
 * does, which is the point of scoping to the assigned coordinator.
 *
 * Shaped for the list: the event's name and status, and the venue's name and
 * location, so the screen needs no second read. A booking that predates
 * requests has no requester, layout or notes, and those read null.
 *
 * @param {string} coordinatorId  from the JWT -- never the client
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<object[]>} possibly empty, in camelCase
 * @throws {ValidationError} when no coordinator was supplied, before any round trip
 */
export async function listBookingRequestsForCoordinator(coordinatorId, { client } = {}) {
  // Refused before the client is touched: without the caller the read would
  // have no filter at all.
  if (typeof coordinatorId !== 'string' || coordinatorId.trim() === '') {
    throw new ValidationError(
      'Invalid coordinator -- coordinatorId: is required',
      [{ field: 'coordinatorId', message: 'is required' }],
    );
  }

  const db = await resolveClient(client);

  const { data, error } = await db
    .from('bookings')
    .select(LIST_COLUMNS)
    .eq('event_requests.assigned_coordinator_id', coordinatorId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: true });

  if (error) throw translateError(error);

  return (data ?? [])
    .filter((row) => one(row.event_requests)?.assigned_coordinator_id === coordinatorId)
    .map(toBookingRequestListItem);
}

/**
 * One open (pending or conflicting) request clashing with another, in
 * camelCase (SCRUM-259).
 *
 * @param {object} entry  from list_pending_booking_requests' `overlapping`
 */
function toOverlappingRequest(entry) {
  return {
    id: entry.id,
    eventRequestId: entry.event_request_id,
    eventName: entry.event_name ?? null,
    startsAt: entry.starts_at,
    endsAt: entry.ends_at,
    occupiedStartsAt: entry.occupied_starts_at,
    occupiedEndsAt: entry.occupied_ends_at,
    createdAt: entry.created_at,
  };
}

/**
 * One row of the Venue Staff queue, in camelCase. The suitability record is
 * shaped by toSuitabilityRecord, as on the venue's bookings list, so both
 * screens show the same verdict and overridden criteria.
 *
 * @param {object} row  one element of list_pending_booking_requests (065)
 */
function toPendingBookingRequest(row) {
  // Pending or conflicting (068); a row without one is from 065, all pending.
  const status = row.status ?? BOOKING_STATUS.PENDING;
  return {
    id: row.id,
    eventRequestId: row.event_request_id,
    eventName: row.event_name ?? null,
    eventStatus: row.event_status ?? null,
    venueId: row.venue_id,
    venueName: row.venue_name ?? null,
    venueLocation: row.venue_location ?? null,
    status,
    statusDisplay: getBookingStatusDisplay(status),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    occupiedStartsAt: row.occupied_starts_at ?? null,
    occupiedEndsAt: row.occupied_ends_at ?? null,
    expectedAttendance: row.expected_attendance ?? null,
    roomLayoutCode: row.room_layout_code ?? null,
    venueRequirements: row.venue_requirements ?? null,
    accessibilityRequirements: row.accessibility_requirements ?? null,
    setupNotes: row.setup_notes ?? null,
    ...toSuitabilityRecord(row),
    requestedBy: row.requested_by ?? null,
    createdAt: row.created_at,
    overlapping: (row.overlapping ?? []).map(toOverlappingRequest),
  };
}

/**
 * The pending booking requests Venue Staff decide on (SCRUM-259, SCRUM-258 AC1).
 *
 * Pending and conflicting requests (068), each with its status. Oldest first,
 * every venue, each with the other events' open requests at
 * its venue whose occupied periods overlap, in submission order. Read through
 * list_pending_booking_requests (065), which refuses anyone but Venue Staff
 * (42501, a ForbiddenError) and pads periods with venue_occupied_period(), so
 * the formula is not repeated here.
 *
 * @param {string} callerId  from the JWT -- never the client
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<object[]>} possibly empty, in camelCase
 * @throws {ValidationError} when no caller was supplied, before any round trip
 * @throws {ForbiddenError}  the caller is not Venue Staff
 */
export async function listPendingBookingRequests(callerId, { client } = {}) {
  checkCaller(callerId);

  const db = await resolveClient(client);

  const { data, error } = await db.rpc('list_pending_booking_requests', { p_caller: callerId });

  if (error) throw translateError(error);

  return (Array.isArray(data) ? data : []).map(toPendingBookingRequest);
}

/**
 * Withdraw a pending booking request.
 *
 * SCRUM-253. Goes through withdraw_booking_request (031), which locks the
 * event and the booking, checks the caller is the event's assigned coordinator
 * and that the request is still pending, and changes it in one guarded update
 * that also notifies Venue Staff. As with reassigning an event, there is no
 * pre-check here: the question that matters is answered under the lock, where
 * it cannot change before the write.
 *
 * A conflicting request can be withdrawn as a pending one can (068). Any other
 * -- including one already withdrawn -- is a ConflictError and nothing is
 * changed. Withdrawing twice is not a success the
 * second time.
 *
 * @param {string} bookingId  the request's id
 * @param {string} userId     the caller, from the JWT -- never the body
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<object>} the request, now withdrawn, shaped by toBookingRequest
 * @throws {ValidationError} no user, or a malformed id, before any network call
 * @throws {NotFoundError}   no such booking request
 * @throws {ForbiddenError}  the caller is not the event's assigned coordinator
 * @throws {ConflictError}   BOOKING_NOT_PENDING, or the request changed under
 *                           the call
 */
export async function withdrawBookingRequest(bookingId, userId, { client } = {}) {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new ValidationError('A signed-in user is required to withdraw a booking request');
  }
  const id = validateBookingRequestId(bookingId);

  const db = await resolveClient(client);

  const { data, error } = await db.rpc('withdraw_booking_request', {
    p_booking_id: id,
    p_requested_by: userId,
  });

  if (error) throw translateError(error);

  if (data?.outcome !== 'withdrawn') {
    throw new Error(`Unexpected outcome from withdraw_booking_request: ${data?.outcome}`);
  }

  const booking = toBookingRequest(data.booking);
  if (booking.status !== BOOKING_STATUS.WITHDRAWN) {
    throw new Error(`withdraw_booking_request returned a ${booking.status} booking, not a withdrawn one`);
  }
  return booking;
}

/**
 * A decided request: toBookingRequest's fields and the decision recorded with
 * it (066). suggestedAlternative is null when none was given, and both texts
 * are null on an approval.
 *
 * @param {object} row  snake_case, from to_jsonb in decide_booking_request
 */
function toDecidedBookingRequest(row) {
  return {
    ...toBookingRequest(row),
    statusDisplay: getBookingStatusDisplay(row.status),
    decidedBy: row.decided_by ?? null,
    decidedAt: row.decided_at ?? null,
    decisionReason: row.decision_reason ?? null,
    suggestedAlternative: row.suggested_alternative ?? null,
  };
}

/**
 * One call to decide_booking_request (068) and its answer, shared by approve
 * and reject. The function checks the caller is Venue Staff, locks the event,
 * the venue (approval only) and the booking, refuses a request that is not
 * pending, and writes the decision and the coordinator's notice together.
 */
async function decideBookingRequest(
  bookingId,
  callerId,
  decision,
  { reason = null, suggestedAlternative = null, client } = {},
) {
  const db = await resolveClient(client);

  const { data, error } = await db.rpc('decide_booking_request', {
    p_booking_id: bookingId,
    p_caller: callerId,
    p_decision: decision,
    p_reason: reason,
    p_suggested_alternative: suggestedAlternative,
  });

  if (error) throw translateError(error);

  // Something now occupies the request's padded period; nothing was written.
  if (data?.outcome === 'conflict') {
    throw new ConflictError('The venue is no longer available for the whole of this request', {
      code: 'BOOKING_PERIOD_CONFLICT',
      conflicts: (data.conflicts ?? []).map(toPeriodConflict),
    });
  }

  const expected = decision === 'approve' ? BOOKING_STATUS.APPROVED : BOOKING_STATUS.REJECTED;
  if (data?.outcome !== expected) {
    throw new Error(`Unexpected outcome from decide_booking_request: ${data?.outcome}`);
  }

  const booking = toDecidedBookingRequest(data.booking);
  if (booking.status !== expected) {
    throw new Error(`decide_booking_request returned a ${booking.status} booking, not ${expected}`);
  }
  if (decision !== 'approve') return booking;

  // The other events' requests this approval marked conflicting (068).
  return {
    ...booking,
    markedConflicting: Array.isArray(data.marked_conflicting) ? data.marked_conflicting : [],
  };
}

/** The Venue Staff caller, from the JWT; refused before any round trip. */
function checkCaller(callerId) {
  if (typeof callerId !== 'string' || callerId.trim() === '') {
    throw new ValidationError(
      'Invalid caller -- callerId: is required',
      [{ field: 'callerId', message: 'is required' }],
    );
  }
}

/**
 * Approve a pending booking request (SCRUM-260, SCRUM-258 AC2, AC3, AC5).
 *
 * Under its locks, decide_booking_request re-checks that the event is still
 * approved, in the safety check or confirmed, that the request is for the
 * event's current period, and that its occupied period meets no occupying
 * booking, block or other event's active hold. Two approvals at one venue take
 * turns on the venue lock, so only one of two overlapping requests can pass.
 * Only this request changes; the event's other bookings are untouched.
 *
 * Other events' pending requests whose occupied periods overlap this one are
 * marked conflicting and their coordinators notified (068); their ids come
 * back as `markedConflicting`. A conflicting request can itself be approved
 * once nothing occupies its period.
 *
 * @param {string} bookingId  the request's id
 * @param {string} callerId   from the JWT -- never the body
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<object>} the request, now approved, shaped by
 *                            toDecidedBookingRequest, plus markedConflicting
 *                            (ids, possibly empty)
 * @throws {ValidationError} no caller, or a malformed id, before any round trip
 * @throws {NotFoundError}   no such booking request
 * @throws {ForbiddenError}  the caller is not Venue Staff
 * @throws {ConflictError}   by code: BOOKING_NOT_PENDING, EVENT_NOT_BOOKABLE,
 *                           BOOKING_PERIOD_STALE (the event has moved since the
 *                           request), VENUE_RETIRED, BOOKING_PERIOD_CONFLICT
 *                           (conflicts shaped by toPeriodConflict),
 *                           BOOKING_CHANGED
 */
export async function approveBookingRequest(bookingId, callerId, { client } = {}) {
  checkCaller(callerId);
  const id = validateBookingRequestId(bookingId);

  return decideBookingRequest(id, callerId, 'approve', { client });
}

/**
 * Reject a pending booking request (SCRUM-260, SCRUM-258 AC4, AC6).
 *
 * A reason is required, and an alternative venue or arrangement may be
 * suggested; both are stored on the request with who decided and when, and the
 * coordinator is notified. Allowed whatever the event's status: refusing a
 * request books nothing, so there is no reason to keep a pending one open.
 *
 * @param {string} bookingId  the request's id
 * @param {string} callerId   from the JWT -- never the body
 * @param {object} input      see validateRejectBookingRequest
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<object>} the request, now rejected, shaped by
 *                            toDecidedBookingRequest
 * @throws {ValidationError} no caller, a malformed id, a blank reason, or a
 *                           text too long, before any round trip
 * @throws {NotFoundError}   no such booking request
 * @throws {ForbiddenError}  the caller is not Venue Staff
 * @throws {ConflictError}   BOOKING_NOT_PENDING, or BOOKING_CHANGED
 */
export async function rejectBookingRequest(bookingId, callerId, input, { client } = {}) {
  checkCaller(callerId);
  const id = validateBookingRequestId(bookingId);
  const { reason, suggestedAlternative } = validateRejectBookingRequest(input);

  return decideBookingRequest(id, callerId, 'reject', { reason, suggestedAlternative, client });
}
