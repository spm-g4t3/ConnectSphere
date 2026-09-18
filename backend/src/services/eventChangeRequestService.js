/**
 * Event change request service.
 *
 * SCRUM-11: lets an Event Organiser request a change to an event they have
 * already submitted, and record which piece of information or arrangement
 * the change is about (AC1, AC2, AC3).
 *
 * SCRUM-33: the "correct event" half of validation lives here rather than in
 * eventChangeRequestValidation.js, because confirming an event exists and
 * belongs to the caller needs the database. The shape checks that do not --
 * is this even id-shaped, is this value usable for this field -- are already
 * done by the time input reaches this function.
 *
 * SCRUM-34 (AC4): getChangeRequestsForEvent lets an Organiser see whether
 * each of their requests is outstanding, in progress, or processed.
 *
 * Frontend/backend contract fix: createChangeRequestFromClient accepts the
 * wire shape frontend/changeRequestService.js already sends -- POST
 * /event-requests/:id/change-requests with body { field, details } and the
 * event id only in the URL, not the body -- so a future Express route can
 * hand this function req.params.id and req.body directly. createChangeRequest
 * itself keeps its own names (changeField, requestedChange), which mirror the
 * database columns (change_field, requested_change); the translation lives
 * here rather than by teaching either the database or the frontend a second
 * vocabulary.
 *
 * Input is validated before any network call (eventChangeRequestValidation.js).
 * The database (005_event_change_requests.sql, 006_event_change_request_status.sql,
 * 007_event_change_field_venue_equipment.sql) remains the backstop for
 * anything validation deliberately does not check -- an event_request_id
 * that does not exist, for instance -- and translateError turns that into a
 * typed error, the same division venueService.js uses.
 */

import { supabase } from '../config/supabaseClient.js';
import { ValidationError, NotFoundError } from '../errors.js';
import { validateCreateChangeRequest } from '../validation/eventChangeRequestValidation.js';
import { STATUS } from '../domain/eventRequestStatus.js';
import { CHANGE_FIELD_LABEL } from '../domain/eventChangeField.js';

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

  // malformed uuid: a backstop for callers that bypass validateCreateChangeRequest
  // (SCRUM-33 rejects this earlier, in words an Organiser can read, but a
  // direct caller of the service should not get a raw driver message either)
  if (code === '22P02') {
    return new ValidationError(`Invalid id format: ${detail}`);
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
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Shape a change request the way the Organiser-facing status list expects it
 * (frontend/changeRequestService.js documents the shape it wants as
 * `{ id, fieldLabel, details, status, createdAt }`). Layered on top of
 * toChangeRequest as extra keys rather than a rename, so nothing that
 * already reads changeField/requestedChange breaks.
 */
function toOrganiserView(row) {
  const base = toChangeRequest(row);
  return {
    ...base,
    fieldLabel: CHANGE_FIELD_LABEL[base.changeField] ?? base.changeField,
    details: base.requestedChange,
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

/**
 * Same as createChangeRequest, but accepts the wire shape the change request
 * form already sends (frontend/ChangeRequestForm.jsx via
 * frontend/changeRequestService.js#submitChangeRequest): the event id comes
 * from the URL, not the request body, and the body itself is
 * `{ field, details }` rather than `{ changeField, requestedChange }`.
 *
 * Exists so a future Express route can call this with req.params.id,
 * req.body and the authenticated user's id exactly as they arrive, with
 * neither the route nor the frontend needing to learn this service's
 * internal names.
 *
 * @param {string} eventRequestId  from the URL path, e.g. req.params.id
 * @param {object} payload
 * @param {string} payload.field    which piece of info/arrangement changes
 * @param {string} payload.details  the new value, or a description of the change
 * @param {string} organiserId  the Organiser making the request
 * @returns {Promise<object>} same shape as createChangeRequest
 * @throws {ValidationError} bad input, a draft event, or someone else's event
 * @throws {NotFoundError} the event does not exist
 */
export async function createChangeRequestFromClient(eventRequestId, payload, organiserId) {
  const { field, details } = payload && typeof payload === 'object' ? payload : {};

  return createChangeRequest(
    { eventRequestId, changeField: field, requestedChange: details },
    organiserId,
  );
}

/**
 * List the change requests made against one event, newest first, so the
 * Organiser can see which are outstanding, in progress, or processed (AC4).
 *
 * Ownership is checked the same way createChangeRequest checks it: an
 * Organiser may see change requests for an event, but only their own event.
 *
 * @param {string} eventRequestId
 * @param {string} organiserId  the Organiser asking to see them
 * @returns {Promise<object[]>} each item usable either by its internal
 *   names (changeField, requestedChange) or the Organiser-facing ones
 *   (fieldLabel, details, status) -- see toOrganiserView
 * @throws {ValidationError} organiserId missing, or the event belongs to someone else
 * @throws {NotFoundError} the event does not exist
 */
export async function getChangeRequestsForEvent(eventRequestId, organiserId) {
  if (typeof organiserId !== 'string' || organiserId.trim() === '') {
    throw new ValidationError('organiserId is required');
  }

  // Same "load it fresh, do not trust the caller" reasoning as
  // createChangeRequest: ownership is exactly what is being checked.
  const { data: event, error: fetchError } = await supabase
    .from('event_requests')
    .select('id, organiser_id')
    .eq('id', eventRequestId)
    .maybeSingle();

  if (fetchError) throw translateError(fetchError);
  if (!event) throw new NotFoundError(`Event request ${eventRequestId} not found`);

  if (event.organiser_id !== organiserId) {
    throw new ValidationError('Only the event organiser may view its change requests');
  }

  const { data, error } = await supabase
    .from('event_change_requests')
    .select('*')
    .eq('event_request_id', eventRequestId)
    .order('created_at', { ascending: false });

  if (error) throw translateError(error);

  return data.map(toOrganiserView);
}
