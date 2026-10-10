/**
 * Equipment review service: Technical Support Staff review an event's equipment
 * request.
 *
 * SCRUM-290 "Review an Equipment Request - Technical Support Staff". Starting,
 * taking over, marking a line, taking the mark off and completing are each one
 * Postgres function (038_equipment_review.sql) called through rpc, because each
 * changes the request, its lines and the review history together, and separate
 * supabase-js calls cannot be rolled back.
 *
 * Who may call is the route's job (Technical Support Staff only, AC1). Which
 * request, which status and whether the caller is the current reviewer are the
 * database's, answered under the event row's lock, so a check here could only
 * be stale (AC2, AC3). This is the reasoning equipmentLineService.js gives.
 *
 * The caller is always the signed-in user, passed in as userId from the token.
 * Nothing about who is acting is ever read from a body.
 *
 * The functions return ids. The names the screen shows (the reviewer, the
 * assigned coordinator and the booked venue, AC3 and AC4) are read here from the
 * tables that own them, after the database call, so a lookup can never hold the
 * review's locks.
 *
 * SQLSTATEs the functions raise, and what they become:
 *   42501  not the current reviewer, or no caller             ForbiddenError   403
 *   55000  the request is not in a status that allows this    ConflictError    409
 *   40001  the request changed during the call (a backstop)   ConflictError    409
 *   22023  a missing note, or short lines without one         ValidationError  400
 *   P0002  no such event, request or line                     NotFoundError    404
 * Anything else is left untyped, so it reaches the API as a 500.
 */

import {
  ValidationError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} from '../errors.js';
import {
  checkOutcomeNote,
  throwIfInvalid,
  validateEventRequestId,
  validateEquipmentLineId,
} from '../validation/equipmentReviewValidation.js';
import { equipmentRequestStatusLabel } from '../domain/equipmentRequestStatus.js';
import { toAvailabilityResult } from './equipmentAvailabilityService.js';


/** The code a client can match on when the request is not in a state for this. */
export const REVIEW_NOT_ALLOWED = 'EQUIPMENT_REVIEW_NOT_ALLOWED';

const MISSING_NOTES_PREFIX = 'Add a note to each line that cannot be provided.';
const MISSING_NOTES_LIST = /Missing a note: (.*)$/;


/**
 * The client to use. Imported only when none was supplied, so a test that passes
 * its own never reads credentials. Same as equipmentLineService.
 */
async function resolveClient(client) {
  if (client) return client;

  const { supabase } = await import('../config/supabaseClient.js');
  return supabase;
}

/** A blank caller would never reach the function as a uuid. */
function requireUser(userId) {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new ValidationError('userId is required');
  }
  return userId;
}

/** Lines still missing a note, as [{ field: 'lines', message }] plus the names. */
function missingNoteDetails(message) {
  const names = (MISSING_NOTES_LIST.exec(message)?.[1] ?? '')
    .split(', ')
    .map((name) => name.trim())
    .filter(Boolean);

  if (names.length === 0) return [{ field: 'lines', message }];
  return names.map((name) => ({ field: 'lines', message: `${name} needs a note` }));
}

/**
 * Turn a raw Postgres error into a typed one. The messages from 038 are written
 * to be read by Technical Support Staff, so they pass through unchanged.
 */
function translateError(error) {
  if (!error) return null;

  const code = error.code;
  const detail = error.message ?? '';

  if (code === '42501') return new ForbiddenError(detail);

  if (code === '55000' || code === '40001') {
    return new ConflictError(detail, { code: REVIEW_NOT_ALLOWED });
  }

  if (code === '22023') {
    if (detail.startsWith(MISSING_NOTES_PREFIX)) {
      return new ValidationError(detail, missingNoteDetails(detail));
    }
    return new ValidationError(detail, /note/i.test(detail) ? [{ field: 'note', message: detail }] : []);
  }

  // A check constraint backing the functions up. The message is the driver's, so
  // it is wrapped, as the other services do.
  if (code === '23514') {
    return new ValidationError(`A value was rejected by the database: ${detail}`);
  }

  if (code === 'P0002') return new NotFoundError(detail || 'Not found');

  return new Error(detail || 'Unexpected database error');
}


/** One line for the review screen, in camelCase. Built as a literal. */
function toReviewLine(row) {
  return {
    id: row.id,
    equipmentTypeId: row.equipment_type_id,
    name: row.name,
    quantity: row.quantity,
    technicalNotes: row.technical_notes ?? null,
    typeRetired: row.type_retired === true,
    reserved: row.reserved ?? 0,
    shortBy: Math.max(0, row.quantity - (row.reserved ?? 0)),
    outcome: row.outcome ?? null,
    outcomeNote: row.outcome_note ?? null,
    outcomeBy: row.outcome_by ?? null,
    outcomeAt: row.outcome_at ?? null,
    // Null when the event has no period yet; otherwise SCRUM-23's result, so the
    // review reads the same labels and figures as the availability check (AC4).
    availability:
      row.availability === null || row.availability === undefined
        ? null
        : toAvailabilityResult(row.availability, { quantity: row.quantity }),
  };
}

/**
 * What the review screen needs (AC4), or { event: null, request: null } for an
 * event that has never asked for equipment.
 */
export function toReviewState(data) {
  const request = data?.request ?? null;
  if (!request) return { event: null, request: null };

  const event = data.event ?? {};

  return {
    event: {
      id: event.id,
      name: event.name,
      proposedStart: event.proposed_start ?? null,
      proposedEnd: event.proposed_end ?? null,
      assignedCoordinatorId: event.assigned_coordinator_id ?? null,
    },
    request: {
      id: request.id,
      status: request.status,
      statusLabel: equipmentRequestStatusLabel(request.status),
      reviewerId: request.reviewer_id ?? null,
      reviewStartedAt: request.review_started_at ?? null,
      createdAt: request.created_at,
      updatedAt: request.updated_at,
      lines: (request.lines ?? []).map(toReviewLine),
    },
  };
}


/** Names for the people on the screen, by id. A person with no name gets null. */
async function readNames(db, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const { data, error } = await db.from('profiles').select('id, full_name').in('id', unique);
  if (error) throw translateError(error);

  return new Map((data ?? []).map((row) => [row.id, row.full_name ?? null]));
}

/** The statuses under which a booking holds the venue (as venue_occupancy reads them). */
const BOOKED_STATUSES = ['approved', 'flagged_for_review'];

/**
 * The venue the event is booked into, or null. If it somehow holds more than
 * one, the earliest booking's venue is the one shown.
 */
async function readBookedVenue(db, eventRequestId) {
  const { data: bookings, error } = await db
    .from('bookings')
    .select('venue_id, starts_at')
    .eq('event_request_id', eventRequestId)
    .in('status', BOOKED_STATUSES)
    .order('starts_at', { ascending: true })
    .limit(1);
  if (error) throw translateError(error);

  const venueId = bookings?.[0]?.venue_id;
  if (!venueId) return null;

  const { data: venues, error: venueError } = await db
    .from('venues')
    .select('id, name')
    .in('id', [venueId]);
  if (venueError) throw translateError(venueError);

  const venue = venues?.[0];
  return venue ? { id: venue.id, name: venue.name } : null;
}

/** Add the names to a review state. An event with no request has nothing to add. */
async function addNames(db, state) {
  if (!state.request) return state;

  const names = await readNames(db, [state.event.assignedCoordinatorId, state.request.reviewerId]);
  const venue = await readBookedVenue(db, state.event.id);

  return {
    event: {
      ...state.event,
      assignedCoordinatorName: names.get(state.event.assignedCoordinatorId) ?? null,
      venue,
    },
    request: {
      ...state.request,
      reviewerName: state.request.reviewerId ? (names.get(state.request.reviewerId) ?? null) : null,
    },
  };
}


/**
 * The review screen's data (AC3, AC4). Reading never changes anything (AC2).
 *
 * @param {string} eventRequestId
 * @param {object} [options]
 * @param {object} [options.client]
 * @throws {ValidationError} the id is not a UUID
 * @throws {NotFoundError}   no such event
 */
export async function getEquipmentReview(eventRequestId, { client } = {}) {
  validateEventRequestId(eventRequestId);

  const db = await resolveClient(client);
  const { data, error } = await db.rpc('equipment_review_for_event', {
    p_event_request_id: eventRequestId,
  });
  if (error) throw translateError(error);

  return addNames(db, toReviewState(data));
}

/** Run one of the review write functions and return the screen's data. */
async function callReviewFunction(name, args, client) {
  const db = await resolveClient(client);
  const { data, error } = await db.rpc(name, args);
  if (error) throw translateError(error);

  return addNames(db, toReviewState(data));
}

/**
 * Start a review (AC2): Pending review or Cannot be fully arranged becomes Under
 * review, and the caller is recorded as the reviewer.
 *
 * @throws {ConflictError} the request is not in a status a review can start from
 * @throws {NotFoundError} no such event, or it has no equipment request
 */
export async function startEquipmentReview(eventRequestId, userId, { client } = {}) {
  validateEventRequestId(eventRequestId);
  requireUser(userId);

  return callReviewFunction(
    'start_equipment_review',
    { p_event_request_id: eventRequestId, p_user_id: userId },
    client,
  );
}

/**
 * Take over a review that is Under review (AC3). The handover is recorded.
 *
 * @throws {ConflictError} the request is not Under review, or the caller is
 *                         already the reviewer
 */
export async function takeOverEquipmentReview(eventRequestId, userId, { client } = {}) {
  validateEventRequestId(eventRequestId);
  requireUser(userId);

  return callReviewFunction(
    'take_over_equipment_review',
    { p_event_request_id: eventRequestId, p_user_id: userId },
    client,
  );
}

/**
 * Mark a line "Cannot be provided" with the note that says what is missing
 * (AC7). Only the current reviewer.
 *
 * @param {object} input
 * @param {string} input.note  required
 * @throws {ValidationError} no note, or one that is too long
 * @throws {ForbiddenError}  the caller is not the current reviewer
 * @throws {ConflictError}   the request is not Under review, or the line is
 *                           already fully reserved
 */
export async function markEquipmentLineUnavailable(
  eventRequestId,
  lineId,
  input,
  userId,
  { client } = {},
) {
  validateEventRequestId(eventRequestId);
  validateEquipmentLineId(lineId);
  requireUser(userId);

  const { value, details } = checkOutcomeNote(input);
  throwIfInvalid(details);

  return callReviewFunction(
    'mark_equipment_line_unavailable',
    {
      p_event_request_id: eventRequestId,
      p_user_id: userId,
      p_line_id: lineId,
      p_note: value.note,
    },
    client,
  );
}

/** Take the "Cannot be provided" mark off a line. Only the current reviewer. */
export async function clearEquipmentLineOutcome(eventRequestId, lineId, userId, { client } = {}) {
  validateEventRequestId(eventRequestId);
  validateEquipmentLineId(lineId);
  requireUser(userId);

  return callReviewFunction(
    'clear_equipment_line_outcome',
    { p_event_request_id: eventRequestId, p_user_id: userId, p_line_id: lineId },
    client,
  );
}

/**
 * Complete the review (AC7): the request becomes Cannot be fully arranged and
 * reservations are kept. Only the current reviewer. Refused, naming the lines,
 * while a line that is not fully reserved has no note.
 *
 * @throws {ValidationError} lines without a note; details has one entry each
 * @throws {ForbiddenError}  the caller is not the current reviewer
 * @throws {ConflictError}   the request is not Under review, or every line is
 *                           already fully reserved
 */
export async function completeEquipmentReview(eventRequestId, userId, { client } = {}) {
  validateEventRequestId(eventRequestId);
  requireUser(userId);

  return callReviewFunction(
    'complete_equipment_review',
    { p_event_request_id: eventRequestId, p_user_id: userId },
    client,
  );
}
