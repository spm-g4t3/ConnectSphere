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
 * SCRUM-35: persisting a change request linked to its event (AC3) is already
 * what createChangeRequest's insert does -- event_request_id is a foreign
 * key, not a loose reference, so the link cannot outlive the event or point
 * at one that never existed. What SCRUM-35 adds is getChangeRequestById:
 * being "tracked and reviewed later" means a single request must be
 * addressable on its own, not only reachable by first listing its event's
 * requests and finding it in the page.
 *
 * SCRUM-37 (AC5): processChangeRequest decides a change request -- approve
 * or reject -- and, only on approval, applies it back onto the event
 * record. The decision and the application happen together inside a single
 * Postgres transaction (process_change_request in
 * 006_event_change_requests.sql), the same reasoning createVenue
 * and updateVenue in venueService.js already rely on: two separate
 * supabase-js calls are two separate HTTP requests with no shared
 * transaction, so a rejected write to event_requests could otherwise leave
 * a change request marked processed for a change that was never actually
 * made. The Coordinator route calls this service with the decision payload
 * directly; unlike createChangeRequestFromClient below, it needs no separate
 * adapter because its wire and service shapes already match.
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
 * The database (006_event_change_requests.sql) remains the backstop for
 * anything validation deliberately does not check -- an event_request_id
 * that does not exist, for instance -- and translateError turns that into a
 * typed error, the same division venueService.js uses.
 */

import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
} from '../errors.js';
import {
  validateCreateChangeRequest,
  validateProcessChangeRequest,
  isPlausibleId,
} from '../validation/eventChangeRequestValidation.js';
import { STATUS } from '../domain/eventRequestStatus.js';
import { CHANGE_FIELD_LABEL } from '../domain/eventChangeField.js';

/**
 * Resolve the Supabase client, importing the default one only if needed.
 *
 * Deliberately character-identical to resolveClient in eventRequestService.js,
 * and here for the same reason: src/config/supabaseClient.js throws at import
 * time when SUPABASE_URL or SUPABASE_SECRET_KEY is missing -- on purpose, so a
 * misconfigured server fails at startup rather than on its first query. This
 * module used to import it statically, which meant that any module importing
 * this one inherited that throw. That was survivable while nothing did; it
 * stops being survivable the moment a router imports this service, because an
 * import-time throw fails the whole test *file* at collection rather than
 * failing one test, and takes every unrelated case in it down too.
 *
 * Deferring to a dynamic import reached only when no client was supplied keeps
 * production behaviour identical: ESM caches the module, so what comes back is
 * the same object identity the static import produced, one resolution on the
 * first call and nothing afterwards. The only observable difference is *when* a
 * missing-.env throw fires -- import time becomes first call.
 *
 * The seam is for testing, not for configuration. There is still exactly one
 * real client, and it is still created in exactly one place.
 *
 * @param {object} [client] a client supplied by the caller, usually a test
 * @returns {Promise<object>} that client, or the shared default one
 */
async function resolveClient(client) {
  if (client) return client;

  const { supabase } = await import('../config/supabaseClient.js');
  return supabase;
}

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

  // check constraint: blank requested_change slipping past validation, or an
  // approved change process_change_request could not apply (e.g. a new
  // proposed_start that would now fall after proposed_end)
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

  // raised by process_change_request (019) when the caller is not the
  // assigned coordinator of the change request's event (SCRUM-332). The
  // function's own message, written for the coordinator, passed through
  // unchanged, as eventRequestService does for 018's 42501. A 403 rather than
  // a 404, because a coordinator can already read the event and its change
  // requests (errors.js gives the argument). Matched by code, before the two
  // message patterns below; 019 words its message so it matches neither.
  if (code === '42501') {
    return new ForbiddenError(detail);
  }

  if (code === '55000') {
    return new ConflictError(detail);
  }

  // raised by process_change_request when the id matches nothing
  if (code === 'P0002' || /not found/i.test(detail)) {
    return new NotFoundError(detail || 'Change request not found');
  }

  // raised by process_change_request when the request has already been decided
  if (/already been processed/i.test(detail)) {
    return new ValidationError(detail);
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
    decision: row.decision ?? null,
    decisionNotes: row.decision_notes ?? null,
    processedBy: row.processed_by ?? null,
    processedAt: row.processed_at ?? null,
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
 * @param {object} [options]
 * @param {object} [options.client]  Supabase client; the shared one by default
 * @returns {Promise<object>} the created change request
 * @throws {ValidationError} bad input, a draft event, or someone else's event
 * @throws {NotFoundError} the event does not exist
 */
export async function createChangeRequest(input, organiserId, { client } = {}) {
  if (typeof organiserId !== 'string' || organiserId.trim() === '') {
    // Not part of the request body -- this comes from the caller's own
    // identity, so a missing value is the caller's bug, not the Organiser's.
    throw new ValidationError('organiserId is required');
  }

  const request = validateCreateChangeRequest(input);

  // Resolved after the cheap local guards, not before, so a bad body still
  // costs no client resolution and no round trip.
  const db = await resolveClient(client);

  // Loaded fresh rather than trusted from the caller: status and ownership
  // are exactly what is being checked, so they have to come from what is
  // actually stored.
  const { data: event, error: fetchError } = await db
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

  const { data, error } = await db
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
 * @param {object} [options]
 * @param {object} [options.client]  forwarded verbatim to createChangeRequest
 * @returns {Promise<object>} same shape as createChangeRequest
 * @throws {ValidationError} bad input, a draft event, or someone else's event
 * @throws {NotFoundError} the event does not exist
 */
export async function createChangeRequestFromClient(
  eventRequestId,
  payload,
  organiserId,
  { client } = {},
) {
  const { field, details } = payload && typeof payload === 'object' ? payload : {};

  // Forwarded rather than resolved here. This function makes no query of its
  // own, so resolving would mean resolving twice -- and, worse, a caller that
  // supplied a client would find it silently ignored by the one function most
  // likely to be reached from a route.
  return createChangeRequest(
    { eventRequestId, changeField: field, requestedChange: details },
    organiserId,
    { client },
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
 * @param {object} [options]
 * @param {object} [options.client]  Supabase client; the shared one by default
 * @returns {Promise<object[]>} each item usable either by its internal
 *   names (changeField, requestedChange) or the Organiser-facing ones
 *   (fieldLabel, details, status) -- see toOrganiserView
 * @throws {ValidationError} organiserId missing, or the event belongs to someone else
 * @throws {NotFoundError} the event does not exist
 */
export async function getChangeRequestsForEvent(eventRequestId, organiserId, { client } = {}) {
  if (typeof organiserId !== 'string' || organiserId.trim() === '') {
    throw new ValidationError('organiserId is required');
  }

  const db = await resolveClient(client);

  // Same "load it fresh, do not trust the caller" reasoning as
  // createChangeRequest: ownership is exactly what is being checked.
  const { data: event, error: fetchError } = await db
    .from('event_requests')
    .select('id, organiser_id')
    .eq('id', eventRequestId)
    .maybeSingle();

  if (fetchError) throw translateError(fetchError);
  if (!event) throw new NotFoundError(`Event request ${eventRequestId} not found`);

  if (event.organiser_id !== organiserId) {
    throw new ValidationError('Only the event organiser may view its change requests');
  }

  const { data, error } = await db
    .from('event_change_requests')
    .select('*')
    .eq('event_request_id', eventRequestId)
    .order('created_at', { ascending: false });

  if (error) throw translateError(error);

  return data.map(toOrganiserView);
}

/** List one event's organiser-submitted change requests for Coordinator review. */
export async function getChangeRequestsForCoordinator(eventRequestId, { client } = {}) {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from('event_change_requests')
    .select('*')
    .eq('event_request_id', eventRequestId)
    .order('created_at', { ascending: false });

  if (error) throw translateError(error);
  return (data ?? []).map(toOrganiserView);
}

/**
 * Fetch one change request by its own id, so it can be opened and reviewed
 * directly -- from a link, a notification, or a status list -- rather than
 * only by listing every request for its event and finding it in the page
 * (SCRUM-35: "tracked and reviewed later").
 *
 * The event is not known in advance here, unlike getChangeRequestsForEvent,
 * so ownership is checked by joining to event_requests through the foreign
 * key event_change_requests.event_request_id already enforces -- the same
 * link that makes AC3 ("recorded against the relevant event") more than a
 * loose reference in the first place.
 *
 * @param {string} changeRequestId
 * @param {string} organiserId  the Organiser asking to see it
 * @param {object} [options]
 * @param {object} [options.client]  Supabase client; the shared one by default
 * @returns {Promise<object>} same shape as an item from getChangeRequestsForEvent
 * @throws {ValidationError} organiserId missing, changeRequestId not
 *   id-shaped, or the request belongs to someone else's event
 * @throws {NotFoundError} no change request exists with that id
 */
export async function getChangeRequestById(changeRequestId, organiserId, { client } = {}) {
  if (typeof organiserId !== 'string' || organiserId.trim() === '') {
    throw new ValidationError('organiserId is required');
  }

  // Rejected before the network call for the same reason SCRUM-33 rejects a
  // malformed eventRequestId early: a value that is not id-shaped at all can
  // never name a real change request, so there is nothing a query can add.
  if (!isPlausibleId(changeRequestId)) {
    throw new ValidationError('changeRequestId must be a valid id');
  }

  const db = await resolveClient(client);

  // event_requests is embedded through the event_request_id foreign key so
  // ownership can be checked in the same round trip, the same technique
  // venueService.js uses to pull in a venue's attribute tables.
  const { data, error } = await db
    .from('event_change_requests')
    .select('*, event_requests ( organiser_id )')
    .eq('id', changeRequestId)
    .maybeSingle();

  if (error) throw translateError(error);
  if (!data) throw new NotFoundError(`Change request ${changeRequestId} not found`);

  if (data.event_requests.organiser_id !== organiserId) {
    throw new ValidationError('Only the event organiser may view this change request');
  }

  return toOrganiserView(data);
}

/**
 * Decide a change request -- approve or reject it -- and, only on approval,
 * apply it back onto the event record (SCRUM-37, AC5).
 *
 * Deciding and applying happen together inside process_change_request
 * (006_event_change_requests.sql), a single Postgres transaction:
 * if applying the change to event_requests fails -- a rejected
 * proposed_start that would now fall after proposed_end, for instance --
 * the decision itself is rolled back too, so a change request can never be
 * left marked processed for a change that was never actually made.
 *
 * Authorisation is split in two, and neither half is in this function. The
 * route checks the role: only an Event Coordinator gets this far. The
 * database checks which coordinator: since SCRUM-332, process_change_request
 * (019) refuses anyone but the event's assigned coordinator, with 42501, while
 * holding a lock on the event, so a handover cannot land between the check and
 * the decision. translateError turns that into a ForbiddenError. processedBy
 * is the person checked, and the person recorded as deciding, so the two
 * cannot differ.
 *
 * Checked in the function rather than here because a check here would take
 * three round trips (the change request, its event, then the call), and a
 * handover could commit between the second and the third. 019's header gives
 * the full argument.
 *
 * @param {string} changeRequestId
 * @param {object} decisionInput
 * @param {string} decisionInput.decision        'approved' | 'rejected'
 * @param {string} [decisionInput.decisionNotes]  required when rejecting
 * @param {string} processedBy  who is deciding
 * @param {object} [options]
 * @param {object} [options.client]  Supabase client; the shared one by default
 * @returns {Promise<object>} the change request, updated with its outcome
 * @throws {ValidationError} bad input, an already-processed request, or a
 *   missing rejection reason
 * @throws {NotFoundError} no change request exists with that id
 * @throws {ForbiddenError} processedBy is not the event's assigned coordinator
 */
export async function processChangeRequest(
  changeRequestId,
  decisionInput,
  processedBy,
  { client } = {},
) {
  if (typeof processedBy !== 'string' || processedBy.trim() === '') {
    // Not part of decisionInput -- this comes from the caller's own
    // identity, so a missing value is the caller's bug, not the reviewer's.
    throw new ValidationError('processedBy is required');
  }

  const decision = validateProcessChangeRequest({
    changeRequestId,
    ...(decisionInput && typeof decisionInput === 'object' ? decisionInput : {}),
  });

  const db = await resolveClient(client);

  const { data, error } = await db.rpc('process_change_request', {
    p_change_request_id: decision.changeRequestId,
    p_decision: decision.decision,
    p_decision_notes: decision.decisionNotes,
    p_processed_by: processedBy,
  });

  if (error) throw translateError(error);

  return toOrganiserView(data);
}
