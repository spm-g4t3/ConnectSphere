/**
 * Event request service.
 *
 * SCRUM-31, a subtask of SCRUM-10 (Create Event Request).
 *
 * Creates an event request as a draft, reads one back, and moves one from
 * draft to submitted. Most writes go through plain table calls rather than a
 * Postgres function: they touch a single row in a single table, so there is no
 * partly-written record to protect against. Submission is the exception.
 * Since SCRUM-330 it also assigns an Event Coordinator and records that in a
 * second table, and supabase-js has no transactions, so it calls
 * submit_event_request (migration 016) through rpc. The reasoning is at
 * submitEventRequest.
 *
 * Input is validated before any network call (SCRUM-30). The constraints in
 * 001_event_requests.sql and 005_event_request_details.sql remain the backstop
 * for anything validation deliberately does not check, and for writes made
 * outside this service; translateError turns those into typed errors.
 *
 * Deliberately NOT done here:
 *
 *  - No authorisation, and no ownership check except where a function is
 *    handed an organiserId and says so in its name or signature. The rule is
 *    worth stating precisely, because it decides what a route still has to do:
 *    getEventRequestForOrganiser and updateEventRequest take the Organiser and
 *    enforce it; createEventRequest stamps one; getEventRequestById,
 *    submitEventRequest and listEventRequestsForReview take none and check
 *    none, so a route calling any of those must prove the caller's right to
 *    read or write itself first. For the first two that proof is ownership;
 *    for listEventRequestsForReview it is a role gate, because the whole point
 *    of a review queue is that it crosses every Organiser. Role, and the
 *    caller's relationship to an event, arrive with the JWT and belong in
 *    middleware. A service that quietly enforced half of it would make the
 *    other half look unnecessary.
 *  - No status logic of its own. Which moves are legal is answered by
 *    canTransition in src/domain/eventRequestStatus.js; this module asks.
 *    updateEventRequest is the one exception and says why at its own guard:
 *    editing is not a transition, so the transition table has nothing to say
 *    about it.
 *  - No minimum notice before a proposed start, and no timezone conversion.
 *    The first is a business rule the customer has not given; the second would
 *    reinterpret a value the timestamptz column already understands.
 */

import {
  ValidationError,
  NotFoundError,
  ConflictError,
  ServiceUnavailableError,
  ForbiddenError,
} from '../errors.js';
import {
  validateCreateEventRequest,
  validateUpdateEventRequest,
  validateSubmitEventRequest,
} from '../validation/eventRequestValidation.js';
// The repository's one uuid check, exported from there precisely so it is not
// copied (see its docstring). A pure module, so importing it keeps this
// service loadable without credentials.
import { isPlausibleId } from '../validation/eventChangeRequestValidation.js';
import {
  STATUS,
  canTransition,
  COORDINATOR_QUEUE_STATUSES,
} from '../domain/eventRequestStatus.js';


/**
 * The columns a caller ever reads, named rather than selected with '*'.
 *
 * Naming the columns means a column added to the database is invisible to the
 * API until it is added here too. That is how the five decision columns from
 * 010 (decision, decision_note, decided_by, decided_at,
 * reviewing_coordinator_id) existed in the database without appearing in any
 * API response.
 *
 * assigned_coordinator_id went in with SCRUM-330 (migration 014).
 * reviewing_coordinator_id went in with SCRUM-331, the first of 010's five to
 * reach a response, because a handover moves it (018) and the person now able
 * to decide the event has to be visible. Each was mapped in toEventRequest in
 * the same change. The other four decision columns are still absent, and stay
 * absent until a story needs them.
 */
const COLUMNS = `
  id, organiser_id, event_name, purpose, description,
  proposed_start, proposed_end, expected_attendance,
  venue_requirements, accessibility_requirements, equipment_requirements,
  status, clarification_note, assigned_coordinator_id, reviewing_coordinator_id,
  created_at, updated_at, submitted_at
`;

/**
 * The two vocabularies this module bridges: camelCase above it, the column
 * names from 001 and 005 below. Held in one place because getting a single
 * entry wrong is silent -- PostgREST ignores a key no column matches, so a
 * requirement would simply vanish with no error to notice.
 */
const COLUMN_BY_FIELD = Object.freeze({
  eventName: 'event_name',
  purpose: 'purpose',
  description: 'description',
  proposedStart: 'proposed_start',
  proposedEnd: 'proposed_end',
  expectedAttendance: 'expected_attendance',
  venueRequirements: 'venue_requirements',
  accessibilityRequirements: 'accessibility_requirements',
  equipmentRequirements: 'equipment_requirements',
});


/**
 * Resolve the Supabase client, importing the default one only if needed.
 *
 * A deliberate deviation from venueService.js, which imports the client
 * statically at the top of the file. Someone will ask why the two differ, so:
 * src/config/supabaseClient.js throws at import time when SUPABASE_URL or
 * SUPABASE_SECRET_KEY is missing -- on purpose, so a misconfigured server fails
 * at startup rather than on its first query. A static import here would drag
 * that throw into every test run of this module and force credentials on anyone
 * running the suite, CI included. Deferring it to a dynamic import, reached only
 * when no client was supplied, keeps the service unit-testable without a .env
 * while leaving production behaviour identical: ESM caches the module, so the
 * import costs one resolution on the first call and nothing afterwards.
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
 * Mirrors venueService.translateError. Without it the caller gets a driver
 * message like 'new row violates check constraint
 * "event_requests_dates_ordered"', which says nothing useful to whoever
 * submitted the form.
 *
 * PGRST116 is deliberately absent. PostgREST raises it whenever .single() is
 * asked for exactly one row and finds none, which means two different things
 * here: on the guarded update it means someone else submitted first, and on a
 * read it means the row does not exist. One is a conflict, the other is a
 * not-found, so a shared translator would have to guess and would mislabel
 * every legitimate empty read. It is handled at the update site instead, where
 * the surrounding code knows which of the two it is looking at.
 */
function translateError(error) {
  if (!error) return null;

  const code = error.code;
  const detail = error.message ?? '';

  // check constraint: backwards dates, non-positive attendance, or a
  // submitted_at set on a row that is still a draft (005).
  if (code === '23514') {
    return new ValidationError(`A value was rejected by the database: ${detail}`);
  }

  // foreign key: organiser_id is the only one on this table, so this means the
  // Organiser does not exist in auth.users -- a stale token, a deleted account,
  // or a hand-made request. The likeliest real failure of the three.
  if (code === '23503') {
    return new ValidationError(
      `Unknown organiser. organiser_id must match an existing user in ` +
      `auth.users: ${detail}`,
    );
  }

  if (code === '23505') {
    return new ConflictError(`That record already exists: ${detail}`);
  }

  // The next two are raised by submit_event_request (migration 016), each with
  // its own SQLSTATE so they can be told apart by code rather than by matching
  // message text.
  //
  // Both pass the database's message through unchanged, with no prefix,
  // unlike 23514 above. A check violation's message is written by the Postgres
  // driver for a developer ('new row violates check constraint ...'), so it is
  // wrapped in a sentence a caller can make sense of. These two come from
  // `raise exception` in our own function, and their text was written to be
  // read by whoever made the request. The no-coordinator message is SCRUM-327
  // AC5's exact wording. The not-a-draft message names the status the function
  // saw while holding the row lock, which is more accurate than anything this
  // service read a moment earlier.

  // object_not_in_prerequisite_state: the request is no longer a draft. Most
  // likely a second submit that waited on the first one's row lock.
  if (code === '55000') {
    return new ConflictError(detail);
  }

  // raise_exception: no Event Coordinator is available (AC5). 016 raises
  // P0001 for that and nothing else. Nothing else this module calls raises
  // P0001; 006's process_change_request does, for a change request already
  // processed, but that goes through eventChangeRequestService and its own
  // translator, not this one. A future function that raises P0001 for another
  // reason and is called from here would need its own SQLSTATE, or it would
  // arrive as a 503.
  if (code === 'P0001') {
    return new ServiceUnavailableError(detail);
  }

  // The next three are raised by reassign_event_request (migration 018), and
  // pass the message through unchanged for the same reason as the two above:
  // it comes from `raise exception` in our own function, written to be read.
  //
  // 018's fourth refusal, a handover to the coordinator who already holds the
  // event, uses check_violation (23514) on purpose, to match the history
  // table's own constraint for the same rule. So it arrives through the 23514
  // branch at the top and keeps that branch's prefix. That is unavoidable:
  // 23514 cannot be told apart from a Postgres constraint violation by code
  // alone, and those messages do need the wrapping.

  // insufficient_privilege: the caller is not the event's assigned
  // coordinator (SCRUM-327 AC6). 403 rather than this module's usual 404 for
  // someone else's record: the caller is a coordinator who can already see
  // this event in the shared queue, so the 403 reveals nothing (errors.js
  // explains). Postgres also uses 42501 for its own "permission denied", but
  // the API connects with the secret key, which is never refused on a table.
  if (code === '42501') {
    return new ForbiddenError(detail);
  }

  // invalid_parameter_value: the person named as the new coordinator does not
  // hold the event_coordinator role. A 400, because the request named the
  // wrong person.
  if (code === '22023') {
    return new ValidationError(detail);
  }

  // serialization_failure: 018's guarded update matched no row, meaning the
  // event changed hands under it. 018 explains why this cannot happen while
  // its row lock holds. If it ever does, the caller gets a conflict to reload
  // from, not a 500.
  if (code === '40001') {
    return new ConflictError(detail);
  }

  if (code === 'P0002' || /not found/i.test(detail)) {
    return new NotFoundError(detail || 'Event request not found');
  }

  // Left untyped on purpose. An unrecognised code is not the caller's fault and
  // there is nothing for them to correct, so it must not reach the API dressed
  // as a 400 telling an Organiser to fix their form.
  return new Error(detail || 'Unexpected database error');
}

/**
 * The camelCase view of a stored row.
 *
 * Built as an explicit literal, as venueService.getVenueById does, so no
 * snake_case key can leak upward and the shape a caller receives is readable
 * here rather than inferred from a loop.
 */
function toEventRequest(row) {
  return {
    id: row.id,
    organiserId: row.organiser_id,
    eventName: row.event_name,
    purpose: row.purpose,
    description: row.description,
    proposedStart: row.proposed_start,
    proposedEnd: row.proposed_end,
    expectedAttendance: row.expected_attendance,
    venueRequirements: row.venue_requirements,
    accessibilityRequirements: row.accessibility_requirements,
    equipmentRequirements: row.equipment_requirements,
    status: row.status,
    clarificationNote: row.clarification_note ?? null,
    // Null on a draft, which nobody has been assigned yet. `?? null`, as for
    // clarificationNote, so a row read without the column still gives the
    // caller null rather than undefined, and the key is always present.
    assignedCoordinatorId: row.assigned_coordinator_id ?? null,
    // The coordinator who may decide the request (010's
    // decided_by_is_reviewer). Null until someone starts the review. After a
    // decision it records who decided, even when the event has since been
    // handed to someone else (018).
    reviewingCoordinatorId: row.reviewing_coordinator_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at,
  };
}

/**
 * The column payload for a validated request.
 *
 * Only fields the caller actually supplied are included. The validator already
 * distinguishes "not answered" (key absent) from "cleared" (key present, null),
 * and carrying that distinction through means an omitted requirement is left to
 * the column default rather than written as a decision the Organiser never made.
 */
function toColumns(validated) {
  const payload = {};

  for (const [field, column] of Object.entries(COLUMN_BY_FIELD)) {
    if (validated[field] !== undefined) payload[column] = validated[field];
  }

  return payload;
}

/**
 * The Organiser must be named, and it is not a field the Organiser can fix.
 *
 * Checked here rather than left to the not-null constraint: the database would
 * refuse it too, but a round trip later and with a message naming a column.
 * Reported on its own rather than collected alongside form faults, because it
 * does not come from the form -- it comes from the token, so a missing one is a
 * caller or middleware bug and mixing it into a list of things to correct would
 * tell the Organiser to fix something they cannot see.
 */
function assertOrganiser(organiserId) {
  if (typeof organiserId !== 'string' || organiserId.trim() === '') {
    throw new ValidationError(
      'Invalid event request details -- organiserId: is required',
      [{ field: 'organiserId', message: 'is required' }],
    );
  }
}


/**
 * Create an event request as a draft.
 *
 * `now` is not read. Creation deliberately does not look at the clock: a draft
 * may be written one day and edited over several more, so its dates are a
 * working guess until it is submitted.
 *
 * @param {object} input        camelCase fields, as validateCreateEventRequest expects
 * @param {string} organiserId  the Organiser this request belongs to, from the JWT
 * @param {object} [options]
 * @param {object} [options.client]  Supabase client; the shared one by default
 * @returns {Promise<object>} the stored request, in camelCase
 * @throws {ValidationError} for bad input or a missing organiserId, before any
 *                           network call is made
 */
export async function createEventRequest(input, organiserId, { client } = {}) {
  assertOrganiser(organiserId);

  // Throws before the client is even resolved, so a bad form costs no round
  // trip and the Organiser gets a message about their form rather than a
  // driver message about a constraint.
  const validated = validateCreateEventRequest(input);

  const db = await resolveClient(client);

  const { data, error } = await db
    .from('event_requests')
    .insert({
      ...toColumns(validated),
      organiser_id: organiserId,

      // Stated rather than left to the column default. The service then says
      // what it means, instead of a reader having to open a migration to learn
      // what a created request is -- and the value cannot drift if a later
      // migration changes the default from another branch.
      status: STATUS.DRAFT,

      // created_at, updated_at and submitted_at are deliberately absent.
      // The first two are database defaults, and updated_at is maintained by
      // the event_requests_set_updated_at trigger, so a value sent from here
      // would be overwritten on the next write anyway -- sending one only
      // invites disagreement about which clock is authoritative. submitted_at
      // must stay null while the row is a draft: the
      // event_requests_submitted_at_matches_status constraint from 005 rejects
      // the insert outright otherwise.
    })
    .select()
    .single();

  if (error) throw translateError(error);

  return toEventRequest(data);
}

/**
 * Read one event request.
 *
 * maybeSingle rather than single: PostgREST answers single() with PGRST116 when
 * it finds no row, and an absent request is an ordinary outcome here, not a
 * driver-level fault. maybeSingle returns data: null instead, which this
 * function turns into the NotFoundError the caller can act on.
 *
 * @param {string} id
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<object>} the request, in camelCase
 * @throws {NotFoundError} when no request has that id
 */
export async function getEventRequestById(id, { client } = {}) {
  const db = await resolveClient(client);

  const { data, error } = await db
    .from('event_requests')
    .select(COLUMNS)
    .eq('id', id)
    .maybeSingle();

  if (error) throw translateError(error);
  if (!data) throw new NotFoundError(`Event request ${id} not found`);

  return toEventRequest(data);
}

/**
 * Submit a draft request for review, moving it draft -> submitted and
 * assigning it an Event Coordinator.
 *
 * SCRUM-10 created this. SCRUM-330 (SCRUM-327 AC1 and AC5) changed how it
 * writes. It reads the row and validates it here, then hands the write to the
 * Postgres function submit_event_request (migration 016) through rpc. In one
 * transaction, that function locks the row, checks it is still a draft, picks
 * a coordinator with pick_event_coordinator (015), writes status, submitted_at
 * and assigned_coordinator_id, and inserts the assignment history row.
 *
 * Why the write moved: a submission now writes to two tables, and every part
 * has to happen or none of it. The request must not end up submitted without a
 * coordinator, and the coordinator must not be recorded without the history
 * row. supabase-js has no transactions, since every call is its own HTTP
 * request, so the service cannot guarantee that. A function body can. This is
 * the reasoning venueService.js and process_change_request (006) already
 * follow.
 *
 * What left this function with the write, and why it must not come back:
 *
 *  - The canTransition check. The function makes the same check, under the
 *    row lock, which is the only place it is reliable. This service's read is
 *    already out of date by the time it could act on it. A second copy here
 *    would be the same rule in two places, able to disagree, and the
 *    function's copy is the one that counts. A request that is not a draft is
 *    therefore refused by the function (55000), and translateError turns that
 *    into a ConflictError carrying the function's message.
 *  - The PGRST116 guard on `.eq('status', 'draft')`. It existed because the read
 *    and the write were two separate requests with nothing holding the row in
 *    between. The function holds a row lock instead: a second concurrent
 *    submit waits, then finds the row no longer a draft, which is the same
 *    55000.
 *
 * What stays here, and why:
 *
 *  - The read, for the NotFoundError and because validation needs the row.
 *  - validateSubmitEventRequest. It reports every gap at once, which a raised
 *    exception cannot. And 016's function makes no completeness check of its
 *    own, so this is the only thing that stops an incomplete draft being
 *    submitted and given a coordinator.
 *  - The clock. `now` is passed in as p_submitted_at, so tests can state the
 *    exact instant, as 005 and 016 both record.
 *
 * @param {string} id
 * @param {object} [options]
 * @param {object} [options.client]
 * @param {Date} [options.now]  the submission instant; injected so callers and
 *                              tests are deterministic
 * @returns {Promise<object>} the submitted request, in camelCase, including
 *                            assignedCoordinatorId
 * @throws {NotFoundError}           when no request has that id, at the read or
 *                                   because it vanished before the function ran
 * @throws {ValidationError}         when the stored draft is not complete enough
 *                                   to submit, listing every gap at once
 * @throws {ConflictError}           when the request is no longer a draft
 * @throws {ServiceUnavailableError} when no Event Coordinator is available;
 *                                   the request stays a draft (AC5)
 */
export async function submitEventRequest(id, { client, now = new Date() } = {}) {
  const db = await resolveClient(client);

  // Read through getEventRequestById rather than repeating the query, so there
  // is one definition of what a stored request looks like and the NotFoundError
  // comes for free.
  const current = await getEventRequestById(id, { client: db });

  // Re-validated against the stored row, not against anything a client sent.
  // This is the point of submission being a separate step: a draft is saved
  // permissively by design -- the enum starts at 'draft' and SCRUM-11 depends
  // on partial saves working -- so the row may legitimately be incomplete, and
  // the Coordinator must not be handed a request they cannot act on. Every gap
  // is reported at once so the Organiser fixes the form in one pass.
  validateSubmitEventRequest(current, { now });

  // One call, and no write of this service's own before or after it. A raised
  // refusal rolls back everything the function did, so on any error the row
  // is exactly as it was -- AC5's "the request stays a draft".
  //
  // now.toISOString(), as before: the parameter is timestamptz, and an instant
  // with an explicit offset is unambiguous on the wire.
  const { data, error } = await db.rpc('submit_event_request', {
    p_event_request_id: id,
    p_submitted_at: now.toISOString(),
  });

  if (error) throw translateError(error);

  // The function returns the updated event_requests row, so it maps the same
  // way as every other row this module hands back.
  return toEventRequest(data);
}

/**
 * Save an Organiser's edits to their own draft.
 *
 * SCRUM-11. Positional order matches venueService.updateVenue(id, changes,
 * userId), with this module's options bag appended, so the two update
 * functions on this codebase read the same way round.
 *
 * Both validations run before any round trip: a bad body costs nothing, and
 * the Organiser gets a message about their form rather than a driver message
 * about a constraint. Existence and ownership are then answered in one call by
 * getEventRequestForOrganiser, which raises the same NotFoundError for a
 * request that does not exist and one that belongs to someone else -- see the
 * note in errors.js on why that is 404 and not 403.
 *
 * Three guards, and each is doing separate work:
 *
 *  - the status check below turns "the body was fine, the row's state was not"
 *    into a 409. Asked of the status directly and deliberately NOT routed
 *    through canTransition: editing is not a transition, the row does not
 *    move, and ALLOWED_TRANSITIONS therefore has nothing to say about it.
 *    Asking anyway would be a category error dressed as reuse.
 *  - .eq('status', 'draft') on the write is the one that matters. The read
 *    above and this write are two round trips with no transaction spanning
 *    them, so a submit landing in the gap would otherwise let this write
 *    mutate a request the Coordinator is already reading. Filtering on the old
 *    status makes the write itself the check -- the loser matches no row.
 *  - .eq('organiser_id', ...) can never fire, because organiser_id never
 *    changes and ownership was proved a moment ago. It is there so the
 *    statement sent to a deny-all table is *structurally* incapable of
 *    touching a foreign row, rather than safe only because of a check made
 *    earlier in a different round trip.
 *
 * updated_at and submitted_at are safe by construction rather than by
 * discipline, which is worth stating so nobody has to re-derive it nervously:
 * toColumns iterates COLUMN_BY_FIELD, a frozen allow-list of exactly nine
 * columns. updated_at, submitted_at, status, organiser_id and id are not in
 * it and no request body can put them there. So the trigger stays the sole
 * authority on updated_at, and event_requests_submitted_at_matches_status
 * cannot be violated from here.
 *
 * @param {string} id
 * @param {object} changes      any subset of the request's fields
 * @param {string} organiserId  from the JWT, via requireAuth -- never the body
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<object>} the updated request, in camelCase -- byte for
 *                            byte the shape create, submit and both reads return
 * @throws {ValidationError} bad input, an empty change set, or no organiser
 * @throws {NotFoundError}   no such request, or it is someone else's
 * @throws {ConflictError}   the request is no longer a draft, whether that was
 *                           already true or became true mid-flight
 */
export async function updateEventRequest(id, changes, organiserId, { client } = {}) {
  assertOrganiser(organiserId);

  const validated = validateUpdateEventRequest(changes);

  const db = await resolveClient(client);

  const current = await getEventRequestForOrganiser(id, organiserId, { client: db });

  if (current.status !== STATUS.DRAFT) {
    throw new ConflictError(
      `An event request with status '${current.status}' can no longer be edited ` +
      `directly. Request a change against it instead.`,
    );
  }

  const { data, error } = await db
    .from('event_requests')
    .update(toColumns(validated))
    .eq('id', id)
    .eq('organiser_id', organiserId)
    .eq('status', STATUS.DRAFT)
    .select()
    .single();

  // PGRST116 here is the draft guard firing, not a missing request: the row was
  // read successfully a moment ago and its ownership proved, so the only filter
  // that can have stopped matching is the status one. Handled at this site
  // rather than in translateError, which cannot tell this case from an ordinary
  // empty read -- its own comment says so.
  if (error?.code === 'PGRST116') {
    throw new ConflictError(
      `This event request is no longer a draft -- it was most likely submitted ` +
      `a moment ago. Reload it before editing again.`,
    );
  }

  if (error) throw translateError(error);

  return toEventRequest(data);
}

/** Ask an Organiser for clarification while reviewing their request. */
export async function requestEventClarification(id, note, coordinatorId, { client } = {}) {
  if (typeof coordinatorId !== 'string' || coordinatorId.trim() === '') {
    throw new ValidationError('coordinatorId is required');
  }
  if (typeof note !== 'string' || note.trim() === '') {
    throw new ValidationError('clarification note is required');
  }
  const clarificationNote = note.trim();
  if (clarificationNote.length > 2000) {
    throw new ValidationError('clarification note must be 2000 characters or fewer');
  }

  const db = await resolveClient(client);
  const current = await getEventRequestById(id, { client: db });
  if (!canTransition(current.status, STATUS.PENDING_CLARIFICATION)) {
    throw new ConflictError(
      `An event request with status '${current.status}' cannot be sent for clarification.`,
    );
  }

  const { data, error } = await db
    .from('event_requests')
    .update({ status: STATUS.PENDING_CLARIFICATION, clarification_note: clarificationNote })
    .eq('id', id)
    .eq('status', current.status)
    .select()
    .single();

  if (error?.code === 'PGRST116') {
    throw new ConflictError('The request changed while clarification was being sent. Refresh and try again.');
  }
  if (error) throw translateError(error);
  return toEventRequest(data);
}

/** Save the Organiser's amendments and return the request to Coordinator review. */
export async function respondToEventClarification(id, changes, organiserId, { client } = {}) {
  assertOrganiser(organiserId);
  const validated = validateUpdateEventRequest(changes);
  const db = await resolveClient(client);
  const current = await getEventRequestForOrganiser(id, organiserId, { client: db });

  if (current.status !== STATUS.PENDING_CLARIFICATION) {
    throw new ConflictError('This request is not waiting for clarification. Refresh before editing.');
  }

  const { data, error } = await db
    .from('event_requests')
    .update({
      ...toColumns(validated),
      status: STATUS.UNDER_REVIEW,
      clarification_note: null,
    })
    .eq('id', id)
    .eq('organiser_id', organiserId)
    .eq('status', STATUS.PENDING_CLARIFICATION)
    .select()
    .single();

  if (error?.code === 'PGRST116') {
    throw new ConflictError('This request is no longer waiting for clarification. Refresh before editing.');
  }
  if (error) throw translateError(error);
  return toEventRequest(data);
}


/**
 * Hand an event to another Event Coordinator.
 *
 * SCRUM-331, for SCRUM-327 AC6 (only the assigned coordinator may hand an
 * event over, and only in the statuses the AC names), AC7 (the new coordinator
 * can then act on it) and AC9 (the handover records who made it, and the
 * note).
 *
 * The whole handover happens in reassign_event_request (migration 018), called
 * through rpc. In one transaction it locks the row, checks the caller is the
 * assigned coordinator, the status allows a handover and the new coordinator
 * holds the role, then moves assigned_coordinator_id (and
 * reviewing_coordinator_id, if no decision has been made) and writes the
 * history row. Two tables, all or nothing, and supabase-js has no
 * transactions, so this is the same reasoning submitEventRequest gives.
 *
 * No read first, unlike submitEventRequest. Submission reads the row to
 * validate the Organiser's form against it. A handover has no form to check
 * against the row: everything a read could tell this service (does the event
 * exist, is the caller its coordinator, does its status allow a handover) the
 * function answers itself, under its row lock, when the answer cannot change
 * before the write. A read here would only add a round trip whose answer could
 * already be out of date.
 *
 * What the service does check, before any call:
 *
 *  - newCoordinatorId is present, not blank, and shaped like a uuid. The
 *    function refuses a null itself (22023), but never sees an empty or
 *    malformed id. p_new_coordinator_id is a uuid parameter, so PostgREST
 *    fails to read such a value as one (22P02) before the function body runs,
 *    and translateError does not recognise that code, so it would surface as
 *    a 500. Checking here turns it into a 400 that names the field, and takes
 *    no lock to do it.
 *  - A blank handoverNote becomes null. 014 makes that the service's job, and
 *    018 stores whatever it is handed. A note of spaces says nothing.
 *
 * What it deliberately does not check: whether the new coordinator holds the
 * role. The function checks that while holding a lock on their profile, so
 * the answer is true when the handover commits. A check here would read the
 * role in a separate request, and could already be out of date.
 *
 * The signature has the shape of updateEventRequest(id, changes, organiserId):
 * the caller's request in one object, the person acting separately, from the
 * token. Two of the values are uuids, and as positional arguments they could
 * be swapped without any error.
 *
 * @param {string} id                       the event request
 * @param {object} changes                  the request body
 * @param {string} changes.newCoordinatorId the coordinator taking the event
 * @param {string} [changes.handoverNote]   optional, for the new coordinator
 * @param {string} assignedBy               the caller, from the JWT -- never the body
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<object>} the event after the handover, in camelCase
 * @throws {ValidationError} newCoordinatorId missing, blank or malformed
 *                           (before any call); the named person is not an
 *                           Event Coordinator; or they already hold the event
 * @throws {ForbiddenError}  the caller is not the event's assigned coordinator
 * @throws {NotFoundError}   no such event
 * @throws {ConflictError}   the status does not allow a handover, or the event
 *                           changed hands during this one
 */
export async function reassignEventRequest(id, changes, assignedBy, { client } = {}) {
  const { newCoordinatorId, handoverNote } = changes ?? {};

  if (!isPlausibleId(newCoordinatorId)) {
    const message = typeof newCoordinatorId === 'string' && newCoordinatorId.trim() !== ''
      ? 'must be the id of an Event Coordinator'
      : 'is required';
    throw new ValidationError(
      `Invalid handover -- newCoordinatorId: ${message}`,
      [{ field: 'newCoordinatorId', message }],
    );
  }

  const note = typeof handoverNote === 'string' && handoverNote.trim() !== ''
    ? handoverNote
    : null;

  const db = await resolveClient(client);

  const { data, error } = await db.rpc('reassign_event_request', {
    p_event_request_id: id,
    p_new_coordinator_id: newCoordinatorId.trim(),
    p_assigned_by: assignedBy,
    p_handover_note: note,
  });

  if (error) throw translateError(error);

  return toEventRequest(data);
}


/**
 * Every event request belonging to one Organiser, most recently changed first.
 *
 * SCRUM-42, a subtask of SCRUM-14 (Track Event Request Status).
 *
 * The ordering is the acceptance criterion, not a cosmetic default. AC4 asks
 * that the displayed status keep up with changes to the request, and updated_at
 * is maintained by the event_requests_set_updated_at trigger (001), so the
 * request whose status just moved sorts to the top of the Organiser's list. The
 * secondary sort on id exists because a bulk update writes the same now() to
 * several rows, and an undefined tiebreak would let the list reshuffle between
 * two refetches that read identical data.
 *
 * No new index is needed: idx_event_requests_organiser_status (001) leads on
 * organiser_id and its own comment names SCRUM-14 as the reason it exists.
 *
 * @param {string} organiserId  from the JWT, via requireAuth -- never from the client
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<object[]>} possibly empty, in camelCase
 * @throws {ValidationError} when no organiser was supplied, before any round trip
 */
export async function listEventRequestsForOrganiser(organiserId, { client } = {}) {
  assertOrganiser(organiserId);

  const db = await resolveClient(client);

  const { data, error } = await db
    .from('event_requests')
    .select(COLUMNS)
    .eq('organiser_id', organiserId)
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false });

  if (error) throw translateError(error);

  // An Organiser with no requests is an ordinary state -- a new client who has
  // not raised one yet -- so it is an empty list, not a NotFoundError. The ??
  // guards the shape PostgREST returns for an empty result set.
  return (data ?? []).map(toEventRequest);
}


/**
 * One event request, but only if it belongs to this Organiser.
 *
 * SCRUM-42. AC1 says the Organiser can view the status of *their* request, so
 * the ownership test lives here beside the read rather than in the route: a
 * second caller cannot then forget it, which is the same reasoning
 * eventChangeRequestService.getChangeRequestsForEvent already follows.
 *
 * Someone else's request is a NotFoundError, not a ForbiddenError. A 403 would
 * confirm the id exists, which turns this endpoint into an enumeration oracle
 * over a table whose row level security is deny-all specifically so that the
 * API can be the only gate.
 *
 * Reads through getEventRequestById rather than repeating the query, so there
 * is one definition of what a stored request looks like -- the same reason
 * submitEventRequest gives for doing it.
 *
 * @param {string} id
 * @param {string} organiserId  from the JWT, via requireAuth
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<object>} the stored request, in camelCase
 * @throws {ValidationError} when no organiser was supplied
 * @throws {NotFoundError}   when no such request exists, or it is someone else's
 */
export async function getEventRequestForOrganiser(id, organiserId, { client } = {}) {
  assertOrganiser(organiserId);

  const request = await getEventRequestById(id, { client });

  if (request.organiserId !== organiserId) {
    // Deliberately the same message getEventRequestById raises for an id that
    // does not exist. Two different messages would be the same oracle the
    // status code avoids.
    throw new NotFoundError(`Event request ${id} not found`);
  }

  return request;
}


/**
 * Every event request awaiting a decision, oldest waiting first.
 *
 * SCRUM-45. The Event Coordinator's review queue, and the fix for the reported
 * bug that a submitted request never appears on the Coordinator side: until
 * now every read in this module was scoped to one organiser_id, so a second
 * person could not see the row at all.
 *
 * No organiserId, and assertOrganiser is deliberately NOT called. That is the
 * rule this module's header states rather than an exception to it: a function
 * taking no organiser checks none, and the caller proves the right to read.
 * Here the proof is the role gate on the route, which is the only proof
 * available -- a queue that crosses every Organiser is precisely a read that
 * no ownership check could scope.
 *
 * Which statuses count is not decided here. COORDINATOR_QUEUE_STATUSES owns
 * that, and its docstring carries the argument -- including that excluding
 * `draft` is the access control for a queue every Coordinator can see.
 *
 * Four choices worth defending:
 *
 *  - The same COLUMNS every other read uses, so a queue row is byte-identical
 *    in shape to the row GET /:id returns. That is what lets the Coordinator UI
 *    render a full detail panel from a row it already holds instead of paying
 *    for a second route.
 *
 *  - submitted_at ASC -- oldest waiting first. updated_at DESC, which the
 *    organiser list uses above, would be actively wrong here: it is maintained
 *    by a trigger, so a Coordinator merely touching a request would bounce it
 *    back to the top of their own queue and bury whatever has actually been
 *    waiting longest.
 *
 *  - nullsFirst: false is mandatory, not a default spelled out. 005's check
 *    constrains submitted_at on drafts only, so a non-draft row may legitimately
 *    carry a null one, and Postgres sorts nulls first on ASC. "No recorded
 *    submission time" must go to the back rather than jump a queue ordered by
 *    how long people have waited.
 *
 *  - The id tiebreak is the same one listEventRequestsForOrganiser gives its
 *    own reason for: a bulk update writes a single now() across many rows, and
 *    an undefined tiebreak lets two refetches of identical data come back in
 *    different orders.
 *
 * No join to profiles, so organiser_id comes back as a bare uuid with no name
 * attached. That is the established answer on this codebase (venueService's
 * changedBy and eventRequestId do the same) and it is also the privacy floor
 * of the shared queue: a Coordinator learns what was asked for, not who to
 * contact about it. Render it as an identifier.
 *
 * Unpaginated, like every other list in this API. Bounded in practice by the
 * status filter -- a decided request drops out -- but say it rather than
 * discover it.
 *
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<object[]>} possibly empty, in camelCase, across all Organisers
 */
export async function listEventRequestsForReview({ client } = {}) {
  const db = await resolveClient(client);

  const { data, error } = await db
    .from('event_requests')
    .select(COLUMNS)
    .in('status', COORDINATOR_QUEUE_STATUSES)
    .order('submitted_at', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true });

  if (error) throw translateError(error);

  // An empty queue is the good state, not a missing resource: it means nothing
  // is waiting on a Coordinator. 200 [] all the way up, never a NotFoundError.
  return (data ?? []).map(toEventRequest);
}
