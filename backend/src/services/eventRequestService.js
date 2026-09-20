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
 *  - No authorisation and no ownership check. Nothing below asks whether the
 *    caller is the Organiser named on the request. That needs the caller's role
 *    and their relationship to the event, both of which arrive with the JWT, so
 *    it belongs in middleware. A service that quietly enforced half of it would
 *    make the other half look unnecessary.
 *  - No saving or editing of an existing draft. That is SCRUM-11, which shares
 *    this table and will add its own function here.
 *  - No status logic of its own. Which moves are legal is answered by
 *    canTransition in src/domain/eventRequestStatus.js; this module asks.
 *  - No minimum notice before a proposed start, and no timezone conversion.
 *    The first is a business rule the customer has not given; the second would
 *    reinterpret a value the timestamptz column already understands.
 */

import { ValidationError, NotFoundError, ConflictError } from '../errors.js';
import {
  validateCreateEventRequest,
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
