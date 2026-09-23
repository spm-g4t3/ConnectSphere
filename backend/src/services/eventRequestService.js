/**
 * Event request service.
 *
 * SCRUM-31, a subtask of SCRUM-10 (Create Event Request).
 *
 * Creates an event request as a draft, reads one back, and moves one from
 * draft to submitted. Writes go through plain table calls rather than a
 * Postgres function, unlike venueService.js: an event request is a single row
 * in a single table, so there is no partially-built record to protect against
 * and nothing a function body would buy. The one place ordering does matter --
 * the read-then-write in submitEventRequest -- is handled by guarding the write
 * instead, which is explained where it happens.
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
 *    enforce it; createEventRequest stamps one; getEventRequestById and
 *    submitEventRequest take none and check none, so a route calling either of
 *    those must prove ownership itself first. Role, and the caller's
 *    relationship to an event, arrive with the JWT and belong in middleware.
 *    A service that quietly enforced half of it would make the other half look
 *    unnecessary.
 *  - No status logic of its own. Which moves are legal is answered by
 *    canTransition in src/domain/eventRequestStatus.js; this module asks.
 *    updateEventRequest is the one exception and says why at its own guard:
 *    editing is not a transition, so the transition table has nothing to say
 *    about it.
 *  - No minimum notice before a proposed start, and no timezone conversion.
 *    The first is a business rule the customer has not given; the second would
 *    reinterpret a value the timestamptz column already understands.
 */

import { ValidationError, NotFoundError, ConflictError } from '../errors.js';
import {
  validateCreateEventRequest,
  validateUpdateEventRequest,
  validateSubmitEventRequest,
} from '../validation/eventRequestValidation.js';
import { STATUS, canTransition } from '../domain/eventRequestStatus.js';


/** The columns a caller ever reads, named rather than selected with '*'. */
const COLUMNS = `
  id, organiser_id, event_name, purpose, description,
  proposed_start, proposed_end, expected_attendance,
  venue_requirements, accessibility_requirements, equipment_requirements,
  status, created_at, updated_at, submitted_at
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
 * Submit a draft request for review, moving it draft -> submitted.
 *
 * @param {string} id
 * @param {object} [options]
 * @param {object} [options.client]
 * @param {Date} [options.now]  the submission instant; injected so callers and
 *                              tests are deterministic
 * @returns {Promise<object>} the updated request, in camelCase
 * @throws {NotFoundError}   when no request has that id
 * @throws {ValidationError} when the stored draft is not complete enough to
 *                           submit, listing every gap at once
 * @throws {ConflictError}   when the request is not in a status that can reach
 *                           'submitted', or when another submit got there first
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

  // Asked of the shared transition table rather than tested here as
  // `status === 'draft'`. The rule then lives in one place: the Coordinator
  // stories move requests through the later statuses and reuse the same table,
  // and a local copy would be a second definition to keep in step.
  if (!canTransition(current.status, STATUS.SUBMITTED)) {
    throw new ConflictError(
      `An event request with status '${current.status}' cannot be submitted.`,
    );
  }

  const { data, error } = await db
    .from('event_requests')
    .update({
      status: STATUS.SUBMITTED,

      // An ISO string rather than a Date: the column is timestamptz and an
      // instant with an explicit offset is unambiguous on the wire.
      submitted_at: now.toISOString(),

      // updated_at is left to the trigger, as on insert.
    })
    .eq('id', id)

    // The guard, and the reason the check above is not enough on its own. The
    // read and this write are two round trips with no transaction spanning
    // them, so a second submit arriving in the gap would otherwise write
    // 'submitted' twice: submitted_at would move to the later instant, and
    // review turnaround would be measured from the wrong moment. Filtering on
    // the old status makes the write itself the check -- the loser matches no
    // row. Re-reading before writing would only move the same race one step
    // earlier.
    .eq('status', STATUS.DRAFT)
    .select()
    .single();

  // PGRST116 here is the guard firing, not a missing request: the row was read
  // successfully a moment ago, so the only way the filter matches nothing is
  // that its status is no longer 'draft'. Handled at this site rather than in
  // translateError, which cannot tell this case from an ordinary empty read.
  if (error?.code === 'PGRST116') {
    throw new ConflictError(
      `This event request is no longer a draft -- it was most likely ` +
      `submitted by another request a moment ago.`,
    );
  }

  if (error) throw translateError(error);

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
