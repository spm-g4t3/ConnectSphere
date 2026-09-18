/**
 * Event change request service.
 *
 * SCRUM-11: lets an Event Organiser request a change to an event they have
 * already submitted, and record which piece of information or arrangement
 * the change is about (AC1, AC2, AC3).
 *
 * Input is validated before any network call (eventChangeRequestValidation.js).
 * The database (005_event_change_requests.sql) remains the backstop for
 * anything validation deliberately does not check -- an event_request_id
 * that does not exist, for instance -- and translateError turns that into a
 * typed error, the same division venueService.js uses.
 */

import { supabase } from '../config/supabaseClient.js';
import { ValidationError, NotFoundError } from '../errors.js';
import { validateCreateChangeRequest } from '../validation/eventChangeRequestValidation.js';
import { STATUS } from '../domain/eventRequestStatus.js';

/**
 * Turn a raw Postgres error into a typed one.
 *
 * Without this the caller gets a driver message like
 * 'new row violates check constraint "event_change_requests_requested_change_check"',
 * which says nothing useful to whoever submitted the request.
 */
function translateError(error) {
  if (!error) return null;

  const code = error.code;
  const detail = error.message ?? '';

  // check constraint: blank requested_change slipping past validation
  if (code === '23514') {
    return new ValidationError(`A value was rejected by the database: ${detail}`);
  }

  // foreign key: event_request_id or requested_by does not exist
  if (code === '23503') {
    return new ValidationError(`Referenced record does not exist: ${detail}`);
  }

  return new Error(detail || 'Unexpected database error');
}

/** Shape returned to callers: camelCase, independent of the column names. */
function toChangeRequest(row) {
  return {
    id: row.id,
    eventRequestId: row.event_request_id,
    requestedBy: row.requested_by,
    changeField: row.change_field,
    requestedChange: row.requested_change,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Request a change to an event that has already been submitted.
 *
 * AC1: only a submitted event can have a change requested against it -- a
 * draft is edited directly, which is SCRUM-11's other subtask, not this one.
 * AC2: changeField says what the request is about; requestedChange says
 * what it should become.
 * AC3: recording the request is exactly what the insert below does.
 *
 * @param {object} input
 * @param {string} input.eventRequestId
 * @param {string} input.changeField
 * @param {string} input.requestedChange
 * @param {string} organiserId  the Organiser making the request
 * @returns {Promise<object>} the created change request
 * @throws {ValidationError} bad input, a draft event, or someone else's event
 * @throws {NotFoundError} the event does not exist
 */
export async function createChangeRequest(input, organiserId) {
  if (typeof organiserId !== 'string' || organiserId.trim() === '') {
    // Not part of the request body -- this comes from the caller's own
    // identity, so a missing value is the caller's bug, not the Organiser's.
    throw new ValidationError('organiserId is required');
  }

  const request = validateCreateChangeRequest(input);

  // Loaded fresh rather than trusted from the caller: status and ownership
  // are exactly what is being checked, so they have to come from what is
  // actually stored.
  const { data: event, error: fetchError } = await supabase
    .from('event_requests')
    .select('id, organiser_id, status')
    .eq('id', request.eventRequestId)
    .maybeSingle();

  if (fetchError) throw translateError(fetchError);
  if (!event) throw new NotFoundError(`Event request ${request.eventRequestId} not found`);

  if (event.status === STATUS.DRAFT) {
    throw new ValidationError('Cannot request a change to a draft event; submit it first');
  }

  if (event.organiser_id !== organiserId) {
    throw new ValidationError('Only the event organiser may request a change to this event');
  }

  const { data, error } = await supabase
    .from('event_change_requests')
    .insert({
      event_request_id: request.eventRequestId,
      requested_by: organiserId,
      change_field: request.changeField,
      requested_change: request.requestedChange,
    })
    .select()
    .single();

  if (error) throw translateError(error);

  return toChangeRequest(data);
}
