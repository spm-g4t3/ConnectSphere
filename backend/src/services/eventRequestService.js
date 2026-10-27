/**
 * Event request service.
 *
 * SCRUM-31, a subtask of SCRUM-10 (Create Event Request).
 *
 * Creates an event request as a draft, reads one back, and moves one from
 * draft to submitted. Most writes go through plain table calls rather than a
 * Postgres function: they touch a single row in a single table, so there is no
 * partly-written record to protect against. Submission is the exception.
 * SCRUM-330 made it assign an Event Coordinator and record that in a second
 * table, and supabase-js has no transactions, so it calls submit_event_request
 * (migration 016) through rpc. Since SCRUM-486 (052) submission assigns
 * nobody -- the Event Coordinator Lead does, through assignEventRequest -- but
 * it still writes the status, its history row and the Lead's notices in one
 * transaction, so it stays an rpc. The reasoning is at submitEventRequest. Since SCRUM-321 every other status change goes through
 * changeEventRequestStatus, which writes the status and its history row in
 * one transaction (migration 021), and submission writes its history row too.
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
 *    submitEventRequest, listEventRequestsForReview and
 *    getEventRequestForCoordinator take none and check none, so a route
 *    calling any of those must prove the caller's right to read or write
 *    itself first. For the first two that proof is ownership; for the two
 *    coordinator reads it is a role gate, because a coordinator may read any
 *    event past draft. The same rule covers coordinators acting on an event
 *    (SCRUM-332): requestEventClarification and reassignEventRequest take the
 *    coordinator, and the event's assigned coordinator is enforced, by the
 *    first itself and by 018's function for the second.
 *    listEventRequestsForCoordinator (SCRUM-333) takes the coordinator and
 *    reads only the events assigned to them. listCoordinators and
 *    listAssignmentHistory (SCRUM-334) take no owner and check none, so their
 *    routes prove the right to read: the role for the coordinator list, and
 *    for the history the same proof the event needs. Role, and the
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

import { checkTimestamp, DATE_ONLY_PATTERN, singaporeToday } from '../validation/timestampValidation.js';
import {
  NEEDS_ATTENTION_CODE,
  MARK_COMPLETED_REASON,
  NOT_CONFIRMED_REASON,
  eventHasEnded,
  clarificationIsOverdue,
  clarificationOverdueReason,
  venueReadinessReason,
  equipmentReadinessReason,
  compareNeedsAttentionItems,
} from '../domain/coordinatorAttentionList.js';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} from '../errors.js';
import { resolveClient } from '../config/resolveClient.js';
import {
  createPgTranslator,
  rejected,
  forbidden,
  invalid,
  conflict,
  notFound,
  untyped,
} from '../http/pgErrors.js';
import {
  validateCreateEventRequest,
  validateUpdateEventRequest,
  validateSubmitEventRequest,
  validateSignificantEventChange,
  validateEventDetailsEdit,
} from '../validation/eventRequestValidation.js';
// The repository's one uuid check, exported from there precisely so it is not
// copied (see its docstring). A pure module, so importing it keeps this
// service loadable without credentials.
import { isPlausibleId, requireCallerId } from '../validation/ids.js';
import {
  STATUS,
  canTransition,
  COORDINATOR_QUEUE_STATUSES,
  ACTIVE_EVENT_STATUSES,
  FINISHED_EVENT_STATUSES,
  getOrganiserStatusLabel,
  getStatusDisplay,
} from '../domain/eventRequestStatus.js';
// Imports nothing itself, so this service stays loadable without credentials.
import { ROLE } from '../domain/userRole.js';
import { BOOKING_STATUS } from '../domain/bookingStatus.js';
import { EQUIPMENT_REQUEST_STATUS } from '../domain/equipmentRequestStatus.js';


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
 * reviewing_coordinator_id went in with SCRUM-331, the first of 025's five to
 * reach a response, because a handover moves it (018) and the person now able
 * to decide the event has to be visible. Each was mapped in toEventRequest in
 * the same change.
 *
 * decision, decision_note, decided_by and decided_at went in with SCRUM-121
 * (SCRUM-19), which completes 025's five. Until then none of the four had
 * reached any API response: nothing wrote them, because no function could
 * record a decision before 029. Now decide_event_request writes them, and
 * SCRUM-19 AC9 asks for the outcome, the note, who decided and when to be
 * recorded and visible, so every read carries them.
 */
const COLUMNS = `
  id, organiser_id, event_name, purpose, description,
  proposed_start, proposed_end, expected_attendance,
  venue_requirements, accessibility_requirements, equipment_requirements,
  status, clarification_note, clarification_reply_by_date,
  assigned_coordinator_id, reviewing_coordinator_id,
  decision, decision_note, decided_by, decided_at,
  cancellation_reason, cancellation_initiator, cancelled_by, cancelled_at,
  created_at, updated_at, submitted_at
`;

/**
 * SCRUM-266: COLUMNS plus each event's booking statuses, embedded along
 * bookings.event_request_id (009), so the event lists and single reads can
 * say whether the event needs attention without a second round trip.
 *
 * SCRUM-315: and its equipment reservations' flags, embedded along
 * equipment_reservations.event_request_id, for the same purpose. A flagged
 * reservation that has not been released keeps a Confirmed event on the list.
 */
const ATTENTION_COLUMNS = `${COLUMNS}, bookings(status), equipment_reservations(flagged, released_at, flag_reason, flag_code)`;

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

// A clarification may ask for any editable field, so the list is the map's keys, in its order.
const CLARIFICATION_AMENDABLE_FIELDS = Object.freeze(Object.keys(COLUMN_BY_FIELD));


// The PT409 hints 096 raises, passed to the client as the error code.
const SIGNIFICANT_CHANGE_CONFLICTS = new Set([
  'EVENT_STATUS_NOT_ALLOWED',
  'SIGNIFICANT_CHANGE_IMPACT_CHANGED',
  // SCRUM-387: edit_event_request_details (022) refuses with these, each a 409
  // whose code the edit form keys on.
  'EVENT_CONFIRMED',
  'SIGNIFICANT_CHANGE_REQUIRED',
  'EVENT_HOLDS_ARRANGEMENTS',
  'EVENT_CHANGED_SINCE_OPENED',
]);

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
// Mirrors event_requests_closing_notes_nonblank (033).
const CLOSING_NOTES_MAX_LENGTH = 2000;

const notFoundEventRequest = notFound('Event request not found');

const translateError = createPgTranslator({
  codes: {
    // check constraint: backwards dates, non-positive attendance, or a
    // submitted_at set on a row that is still a draft (005).
    '23514': rejected,

    // foreign key: organiser_id is the only one on this table, so this means the
    // Organiser does not exist in auth.users -- a stale token, a deleted account,
    // or a hand-made request. The likeliest real failure of the three.
    '23503': (detail) =>
      new ValidationError(
        `Unknown organiser. organiser_id must match an existing user in ` +
        `auth.users: ${detail}`,
      ),

    '23505': (detail) => new ConflictError(`That record already exists: ${detail}`),

    // The next is raised by submit_event_request (016, then 021 and 052), with
    // its own SQLSTATE so it is told apart by code rather than by matching
    // message text.
    //
    // It passes the database's message through unchanged, with no prefix,
    // unlike 23514 above. A check violation's message is written by the Postgres
    // driver for a developer ('new row violates check constraint ...'), so it is
    // wrapped in a sentence a caller can make sense of. This one comes from
    // `raise exception` in our own function, and its text was written to be read
    // by whoever made the request: it names the status the function saw while
    // holding the row lock, which is more accurate than anything this service
    // read a moment earlier.

    // object_not_in_prerequisite_state: the request is no longer a draft. Most
    // likely a second submit that waited on the first one's row lock.
    '55000': conflict(),

    // No P0001 entry, since SCRUM-486 (migration 052). P0001 was submission's
    // "No coordinator is available" (SCRUM-327 AC5), a 503. Submission no
    // longer looks for a coordinator, so it can no longer raise it, and nothing
    // else this module calls raises P0001: 006's process_change_request does,
    // for a change request already processed, but that goes through
    // eventChangeRequestService and its own translator, not this one. A P0001
    // reaching here now is unexpected, so it falls through to the untyped error
    // at the end, a 500, rather than being reported as "try again later".

    // The next three are raised by reassign_event_request (migration 018), and
    // pass the message through unchanged for the same reason as the two above:
    // it comes from `raise exception` in our own function, written to be read.
    //
    // 018's fourth refusal, a handover to the coordinator who already holds the
    // event, uses check_violation (23514) on purpose, to match the history
    // table's own constraint for the same rule. So it arrives through the 23514
    // entry at the top and keeps that entry's prefix. That is unavoidable:
    // 23514 cannot be told apart from a Postgres constraint violation by code
    // alone, and those messages do need the wrapping.

    // insufficient_privilege: the caller is not the event's assigned
    // coordinator (SCRUM-327 AC6). 403 rather than this module's usual 404 for
    // someone else's record: the caller is a coordinator who can already see
    // this event in the shared queue, so the 403 reveals nothing (errors.js
    // explains). Postgres also uses 42501 for its own "permission denied", but
    // the API connects with the secret key, which is never refused on a table.
    '42501': forbidden,

    // invalid_parameter_value: the person named as the new coordinator does not
    // hold the event_coordinator role (018), or a rejection has no reason
    // (decide_event_request, 029, the backstop behind decideEventRequest's own
    // check). A 400 either way, because the request carried a bad value.
    '22023': invalid,

    // serialization_failure: 018's guarded update matched no row, meaning the
    // event changed hands under it. 018 explains why this cannot happen while
    // its row lock holds. If it ever does, the caller gets a conflict to reload
    // from, not a 500.
    '40001': conflict(),

    P0002: notFoundEventRequest,
  },
  messages: [[/not found/i, notFoundEventRequest]],
  // PT409 is matched here, after the message test, so a PT409 whose message
  // says "not found" stays a 404 as it always has.
  fallback: (detail, error) => {
    // SCRUM-489: submit_event_for_safety_review (064) refuses an event that is not
    // ready with every outstanding checklist line as JSON in DETAIL.
    if (error.code === 'PT409' && error.hint === 'EVENT_NOT_READY') {
      return new ConflictError(detail, { code: 'EVENT_NOT_READY', conflicts: parseOutstanding(error.details) });
    }
    // SCRUM-395 (096): the significant-change refusals the panel acts on. Any
    // other PT409 is not one this module raises, so it stays untyped below.
    if (error.code === 'PT409' && SIGNIFICANT_CHANGE_CONFLICTS.has(error.hint)) {
      return new ConflictError(detail, { code: error.hint });
    }

    // Left untyped on purpose. An unrecognised code is not the caller's fault and
    // there is nothing for them to correct, so it must not reach the API dressed
    // as a 400 telling an Organiser to fix their form.
    return untyped(detail);
  },
});

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
    clarificationReplyByDate: row.clarification_reply_by_date ?? null,
    // Null on a draft, which nobody has been assigned yet. `?? null`, as for
    // clarificationNote, so a row read without the column still gives the
    // caller null rather than undefined, and the key is always present.
    assignedCoordinatorId: row.assigned_coordinator_id ?? null,
    // The coordinator who may decide the request (025's
    // decided_by_is_reviewer). Null until the review is started
    // (start_event_review, 029). After a decision it records who decided, even
    // when the event has since been handed to someone else (018).
    reviewingCoordinatorId: row.reviewing_coordinator_id ?? null,
    // SCRUM-19 AC9: the outcome, the note, who decided and when. All four are
    // null until decide_event_request (029) records a decision, and 025's
    // decision_fields_together keeps decision, decidedBy and decidedAt set or
    // null together. `?? null` so an undecided row has the keys, as above.
    decision: row.decision ?? null,
    decisionNote: row.decision_note ?? null,
    decidedBy: row.decided_by ?? null,
    decidedAt: row.decided_at ?? null,
    cancellationReason: row.cancellation_reason ?? null,
    cancellationInitiator: row.cancellation_initiator ?? null,
    cancelledBy: row.cancelled_by ?? null,
    cancelledAt: row.cancelled_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at,
  };
}

/** An embed arrives as an array, or a single object, or not at all. */
function embedded(value) {
  return Array.isArray(value) ? value : [value];
}

/** The booking flag that SCRUM-266 counts. */
const VENUE_ATTENTION_REASON = 'Venue: a booking is flagged for review';
/** flag_code of a reservation flagged because the equipment is unavailable (023). */
// The stored code keeps its name; the screens say "unavailable" (SCRUM-310, D11).
const EQUIPMENT_LOST_CODE = 'equipment_lost';

/**
 * One equipment flag in words. A flag for unavailable equipment says so; any other flag
 * (the event's date or time changed, say) is named for what it is, a flag, so a
 * coordinator is not sent after equipment that did not become unavailable.
 */
function equipmentFlagWording(reservation, { withReason }) {
  const lost = reservation.flag_code === EQUIPMENT_LOST_CODE;
  const label = lost ? 'Equipment unavailable' : 'Equipment flagged for review';
  const reason = typeof reservation.flag_reason === 'string' ? reservation.flag_reason.trim() : '';
  return withReason && reason !== '' ? `${label}: ${reason}` : label;
}

/**
 * SCRUM-266, SCRUM-315 (SCRUM-310 AC6): why a confirmed event needs its
 * coordinator. Only confirmed counts: before that the event is still being
 * arranged, and a flag is one item of that work. The reasons are:
 *
 *   - a venue booking flagged for review (SCRUM-266), and
 *   - an equipment reservation that is flagged and not released. One entry per
 *     distinct flag, worded by its kind (unavailable equipment, or any other flag) and
 *     the reason it was given, so a coordinator reads what happened rather than
 *     a count.
 *
 * Nothing is stored. The list is worked out from the flags as they are now, so
 * an event drops off when the last flag is cleared or released. The embeds are
 * read defensively, as bookingRequestService's one() reads its embeds.
 *
 * The reason text can carry the note Technical Support wrote about the equipment, which
 * is internal, so only coordinator reads include it (withReason). An organiser sees the
 * kind of flag and nothing more.
 *
 * @returns {string[]} empty when the event does not need attention
 */
function attentionReasons(row, { withReason }) {
  if (row.status !== STATUS.CONFIRMED) return [];

  const reasons = [];
  if (embedded(row.bookings).some((booking) => booking?.status === BOOKING_STATUS.FLAGGED_FOR_REVIEW)) {
    reasons.push(VENUE_ATTENTION_REASON);
  }

  reasons.push(...equipmentFlagReasons(row, { withReason }));

  return reasons;
}

/**
 * One entry per distinct flag on the event's flagged, unreleased equipment reservations.
 * Shared by attentionReasons and the Needs attention list (SCRUM-383), so the wording of
 * an equipment flag is defined once.
 */
function equipmentFlagReasons(row, { withReason }) {
  const flagged = embedded(row.equipment_reservations).filter(
    (reservation) => reservation?.flagged === true && !reservation.released_at,
  );
  return [...new Set(flagged.map((reservation) => equipmentFlagWording(reservation, { withReason })))];
}

/**
 * toEventRequest, with needsAttention and its reasons, for a row read with ATTENTION_COLUMNS.
 * forOrganiser leaves the staff's reason text out of the reasons.
 */
function toEventRequestWithAttention(row, { forOrganiser = false } = {}) {
  const reasons = attentionReasons(row, { withReason: !forOrganiser });
  return { ...toEventRequest(row), needsAttention: reasons.length > 0, attentionReasons: reasons };
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
  return toEventRequest(await readEventRequestRow(id, COLUMNS, client));
}

/** The stored row behind getEventRequestById, read with the columns given. */
async function readEventRequestRow(id, columns, client) {
  const db = await resolveClient(client);

  const { data, error } = await db
    .from('event_requests')
    .select(columns)
    .eq('id', id)
    .maybeSingle();

  if (error) throw translateError(error);
  if (!data) throw new NotFoundError(`Event request ${id} not found`);

  return data;
}

/**
 * Submit a draft request for review, moving it draft -> submitted, with no
 * coordinator.
 *
 * SCRUM-10 created this. SCRUM-330 (SCRUM-327 AC1 and AC5) moved the write
 * into the Postgres function submit_event_request, called through rpc.
 * SCRUM-486 (migration 052) took the assignment back out of that function: the
 * customer's Week 7 change 5 sends a new request to the Event Coordinator
 * Lead's unassigned queue instead. In one transaction the function now locks
 * the row, checks it is still a draft, writes status and submitted_at, sets
 * the coordinator and the reviewer to null (a draft reopened from rejected
 * still carries both), and inserts the status history row. It no longer
 * chooses a coordinator, and so it can no longer refuse for want of one. The
 * Lead's assignment is a separate step.
 *
 * Why the write stays in a function: a submission still writes to two tables,
 * the request and its status history, and both must happen or neither.
 * supabase-js has no transactions, since every call is its own HTTP request,
 * so the service cannot guarantee that. A function body can. This is the
 * reasoning venueService.js and process_change_request (006) already follow.
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
 *    exception cannot. And the function makes no completeness check of its
 *    own, so this is the only thing that stops an incomplete draft being
 *    submitted.
 *  - The clock. `now` is passed in as p_submitted_at, so tests can state the
 *    exact instant, as 005 and 016 both record.
 *
 * @param {string} id
 * @param {object} [options]
 * @param {object} [options.client]
 * @param {Date} [options.now]  the submission instant; injected so callers and
 *                              tests are deterministic
 * @param {string} [options.changedBy]  who is submitting, for the status
 *                              history; defaults to the draft's Organiser
 * @returns {Promise<object>} the submitted request, in camelCase;
 *                            assignedCoordinatorId is null until the Lead assigns
 * @throws {NotFoundError}           when no request has that id, at the read or
 *                                   because it vanished before the function ran
 * @throws {ValidationError}         when the stored draft is not complete enough
 *                                   to submit, listing every gap at once
 * @throws {ConflictError}           when the request is no longer a draft
 */
export async function submitEventRequest(id, { client, now = new Date(), changedBy } = {}) {
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
  // is exactly as it was: a refused submission leaves a draft.
  //
  // now.toISOString(), as before: the parameter is timestamptz, and an instant
  // with an explicit offset is unambiguous on the wire.
  //
  // p_changed_by is who the status history records as submitting. The route
  // passes the signed-in Organiser, after proving the draft is theirs. Without
  // one it is the draft's own Organiser, the only person who may submit it, so
  // a caller that has already established ownership need not repeat the id.
  const { data, error } = await db.rpc('submit_event_request', {
    p_event_request_id: id,
    p_submitted_at: now.toISOString(),
    p_changed_by: changedBy ?? current.organiserId,
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

/**
 * Change an event request's status, and record that it changed.
 *
 * SCRUM-321. The one function every status change goes through, apart from
 * submission (see below). A story that moves a request to another status
 * calls this; it does not write the status column itself.
 *
 * In order:
 *
 *  1. canTransition, the one transition rule, on the status the caller last
 *     saw and the one it wants. An illegal move is a ConflictError naming that
 *     status, and nothing is sent to the database.
 *  2. change_event_request_status (migration 021), through rpc. In one
 *     transaction it locks the row, refuses if the row is no longer in
 *     expectedStatus, writes the new status, and inserts the history row:
 *     previous status, new status, who, when, and the reason if one was given.
 *     Status and history are written together or not at all, and
 *     supabase-js has no transactions, so a function is the only way to
 *     guarantee that. 021's header gives the full argument.
 *
 * The rule is asked in two places on purpose. canTransition here refuses an
 * illegal move before any round trip, with the status named. The function
 * (migration 022, restated by 063) holds the same table in SQL and refuses it again under the
 * row lock, because the function is callable by anything that reaches the
 * database, not only this service. A test compares the two tables pair by
 * pair, so they cannot drift unnoticed. The function also checks the thing
 * only it can check reliably, that the status is still what the caller saw.
 *
 * Submitting is not done through this function. It also sets submitted_at,
 * clears the coordinator and the reviewer, and notifies every Lead (052; until
 * SCRUM-486 it chose a coordinator instead), so it has its own,
 * submitEventRequest, and a request cannot reach submitted any other way.
 * Asking for it here is refused.
 *
 * This takes no view on who may make the change. Whoever calls it has already
 * proved that, as every function in this module does.
 *
 * @param {string} id
 * @param {object} change
 * @param {string} change.expectedStatus  the status the caller last saw
 * @param {string} change.newStatus       the status to move to
 * @param {string} change.changedBy       the user causing it, from the JWT
 * @param {string} [change.reason]        why, if a reason was given
 * @param {string} [change.expectedCoordinatorId]
 *        pass the caller's id when they act as the event's assigned
 *        coordinator, and the change is refused if the event has been handed on
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<object>} the request after the change, in camelCase
 * @throws {ValidationError} no changedBy, an overlong reason, or submitted as the target
 * @throws {ConflictError}   the move is not allowed from expectedStatus, or the
 *                           request is no longer in it, or was handed on
 * @throws {NotFoundError}   no such request
 */
export async function changeEventRequestStatus(
  id,
  { expectedStatus, newStatus, changedBy, reason, expectedCoordinatorId = null },
  { client } = {},
) {
  requireCallerId(changedBy, 'changedBy');

  let storedReason = null;
  if (reason !== undefined && reason !== null) {
    if (typeof reason !== 'string') {
      throw new ValidationError('reason must be text');
    }
    storedReason = reason.trim() === '' ? null : reason.trim();
    if (storedReason !== null && storedReason.length > 2000) {
      throw new ValidationError('reason must be 2000 characters or fewer');
    }
  }

  // Before the submitted check below, so that every disallowed move, a move
  // to submitted from anything but a draft included, is refused with the
  // status the request is in (SCRUM-318 AC3).
  if (!canTransition(expectedStatus, newStatus)) {
    throw new ConflictError(
      `An event request with status '${expectedStatus}' cannot change to '${newStatus}'.`,
    );
  }

  if (newStatus === STATUS.SUBMITTED) {
    throw new ValidationError('A request is submitted with submitEventRequest, not by changing its status.');
  }

  const db = await resolveClient(client);
  const { data, error } = await db.rpc('change_event_request_status', {
    p_event_request_id: id,
    p_expected_status: expectedStatus,
    p_new_status: newStatus,
    p_changed_by: changedBy,
    p_reason: storedReason,
    p_expected_coordinator: expectedCoordinatorId,
  });

  if (error) throw translateError(error);

  return toEventRequest(data);
}

/**
 * Ask an Organiser for clarification while reviewing their request.
 *
 * SCRUM-46 created this. SCRUM-332 (SCRUM-327 AC7) makes it check who is
 * asking: only the event's assigned coordinator may send it for clarification.
 * Before SCRUM-332, coordinatorId was checked for being present and then
 * ignored, so any Event Coordinator could do this to any event. SCRUM-321
 * moves the write into changeEventRequestStatus, so the change is recorded in
 * the status history.
 *
 * In order:
 *
 *  1. The read, through getEventRequestForCoordinator, so a draft is the same
 *     404 here as on the coordinator's read, and a coordinator cannot use
 *     this to learn a draft exists.
 *  2. The caller. Someone else's event is a ForbiddenError, before anything is
 *     written. The caller can already see the event, so a 403 reveals nothing
 *     and gives the true reason. It comes before the status check, as in 018:
 *     whether the event could be sent for clarification is a question only
 *     its coordinator has any reason to ask.
 *  3. request_event_clarification_with_fields changes under_review to
 *     pending_clarification and saves the note, the requested fields and the
 *     optional reply-by date in one transaction. The caller is passed as the
 *     expected coordinator, so an event handed to someone else between the
 *     read and write is a 409.
 * 
 *     A submitted request has to be started first, through the Start review
 *     action (startEventReview, SCRUM-19 AC1), which also makes the caller its
 *     reviewing coordinator. decide_event_request (029) still fills in an empty
 *     reviewer, for requests that reached under_review before that.
 *
 * @param {string} id
 * @param {string} note           what the Organiser is asked to clarify
 * @param {string} coordinatorId  the caller, from the JWT -- never the body
 * @param {object} [options]
 * @param {string|null} [options.replyByDate] optional ISO calendar date
 * @param {object} [options.client]
 * @returns {Promise<object>} the request, now pending_clarification, in camelCase
 * @throws {ValidationError} no coordinatorId, a blank or overlong note, or
 *                           an invalid/non-future reply-by date
 * @throws {NotFoundError}   no such request, or it is a draft
 * @throws {ForbiddenError}  the caller is not the event's assigned coordinator
 * @throws {ConflictError}   the status does not allow clarification, or the
 *                           event changed between the read and the write
 */
export async function requestEventClarification(
  id,
  note,
  coordinatorId,
  { replyByDate = null, requestedFields = [], client } = {},
) {
  requireCallerId(coordinatorId, 'coordinatorId');
  if (typeof note !== 'string' || note.trim() === '') {
    throw new ValidationError('clarification note is required');
  }
  const clarificationNote = note.trim();
  if (clarificationNote.length > 2000) {
    throw new ValidationError('clarification note must be 2000 characters or fewer');
  }
  if (
    !Array.isArray(requestedFields) ||
    requestedFields.some((field) => !CLARIFICATION_AMENDABLE_FIELDS.includes(field))
  ) {
    throw new ValidationError('requestedFields must contain only editable event fields');
  }
  const clarificationRequestedFields = [...new Set(requestedFields)];
  let clarificationReplyByDate = null;
  if (replyByDate !== undefined && replyByDate !== null && replyByDate !== '') {
    if (
      typeof replyByDate !== 'string' ||
      !DATE_ONLY_PATTERN.test(replyByDate) ||
      Number.isNaN(Date.parse(`${replyByDate}T00:00:00.000Z`)) ||
      new Date(`${replyByDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== replyByDate ||
      replyByDate <= singaporeToday()
    ) {
      throw new ValidationError('replyByDate must be a valid date in the future');
    }
    clarificationReplyByDate = replyByDate;
  }

  const db = await resolveClient(client);
  const current = await getEventRequestForCoordinator(id, { client: db });

  // SCRUM-486 (SCRUM-519): a submitted request nobody has been assigned is
  // waiting for the Event Coordinator Lead. Checked before the caller, as 052
  // checks it before the caller in start_event_review: there is no coordinator,
  // so there is no "yours" to be wrong about. Without this the caller check
  // below would answer "Only the coordinator assigned ..." about a request that
  // is nobody's. A 409, as 052's 55000 is: not in a state that allows this.
  if (current.status === STATUS.SUBMITTED && current.assignedCoordinatorId == null) {
    throw new ConflictError(
      'This request is waiting for the Event Coordinator Lead to assign it a coordinator, '
        + 'so clarification cannot be requested yet.',
    );
  }

  if (current.assignedCoordinatorId !== coordinatorId) {
    throw new ForbiddenError(
      `Only the coordinator assigned to event request ${id} can request clarification on it.`,
    );
  }

  if (current.status !== STATUS.UNDER_REVIEW) {
    throw new ConflictError(
      `An event request with status '${current.status}' cannot change to '${STATUS.PENDING_CLARIFICATION}'.`,
    );
  }

  const { data, error } = await db.rpc('request_event_clarification_with_fields', {
    p_event_request_id: id,
    p_changed_by: coordinatorId,
    p_expected_coordinator: coordinatorId,
    p_reason: clarificationNote,
    p_reply_by_date: clarificationReplyByDate,
    p_requested_fields: clarificationRequestedFields,
  });
  if (error) throw translateError(error);

  return toEventRequest(data);
}

/**
 * Append the Organiser's reply and only the amendments requested by the Coordinator.
 *
 * The RPC verifies ownership and current status, inserts the immutable reply,
 * returns the status to under_review, and notifies the assigned Coordinator
 * in one transaction. The database refuses fields the open question did not request.
 */
export async function respondToEventClarification(
  id,
  message,
  organiserId,
  amendments = {},
  { client } = {},
) {
  assertOrganiser(organiserId);
  if (typeof message !== 'string' || message.trim() === '') {
    throw new ValidationError('clarification reply is required');
  }
  if (message.trim().length > 2000) {
    throw new ValidationError('clarification reply must be 2000 characters or fewer');
  }
  if (typeof amendments !== 'object' || amendments === null || Array.isArray(amendments)) {
    throw new ValidationError('clarification amendments must be an object');
  }

  const keys = Object.keys(amendments);
  if (keys.some((field) => !CLARIFICATION_AMENDABLE_FIELDS.includes(field))) {
    throw new ValidationError('clarification amendments include an unknown event field');
  }
  const clearFields = {};
  const valuesToValidate = {};
  for (const [field, value] of Object.entries(amendments)) {
    if (field === 'eventName' && (value === null || (typeof value === 'string' && !value.trim()))) {
      throw new ValidationError('eventName cannot be blank');
    }
    if (
      value === null ||
      (typeof value === 'string' && value.trim() === '' && field !== 'eventName')
    ) {
      clearFields[field] = null;
    } else {
      valuesToValidate[field] = value;
    }
  }
  const validatedAmendments = Object.keys(valuesToValidate).length > 0
    ? validateUpdateEventRequest(valuesToValidate)
    : {};
  const updatePayload = { ...validatedAmendments, ...clearFields };

  const db = await resolveClient(client);
  const current = await getEventRequestForOrganiser(id, organiserId, { client: db });

  if (current.status !== STATUS.PENDING_CLARIFICATION) {
    throw new ConflictError('This request is not waiting for clarification. Refresh before editing.');
  }

  const { data, error } = await db.rpc('reply_to_event_clarification_with_amendments', {
    p_event_request_id: id,
    p_organiser_id: organiserId,
    p_reply: message.trim(),
    p_updates: updatePayload,
  });
  if (error) throw translateError(error);

  return toEventRequest(data);
}

export async function closeEventClarification(id, message, coordinatorId, { client } = {}) {
  requireCallerId(coordinatorId, 'coordinatorId');
  if (typeof message !== 'string' || message.trim() === '') {
    throw new ValidationError('clarification closure note is required');
  }
  if (message.trim().length > 2000) {
    throw new ValidationError('clarification closure note must be 2000 characters or fewer');
  }

  const db = await resolveClient(client);
  const current = await getEventRequestForCoordinator(id, { client: db });
  if (current.assignedCoordinatorId !== coordinatorId) {
    throw new ForbiddenError(
      `Only the coordinator assigned to event request ${id} can close its clarification request.`,
    );
  }
  if (current.status !== STATUS.PENDING_CLARIFICATION) {
    throw new ConflictError(
      `An event request with status '${current.status}' cannot close a clarification request.`,
    );
  }

  const { data, error } = await db.rpc('close_event_clarification', {
    p_event_request_id: id,
    p_coordinator_id: coordinatorId,
    p_expected_coordinator: coordinatorId,
    p_message: message.trim(),
  });
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
 * The assigned coordinator starts reviewing a submitted request.
 *
 * SCRUM-346, for SCRUM-19 AC1. The whole change happens in start_event_review
 * (migration 029), called through rpc. In one transaction it locks the row,
 * refuses anyone but the assigned coordinator, refuses any status but
 * submitted, then moves the request to under_review, makes the caller its
 * reviewing coordinator, and writes the status history row.
 *
 * Setting the reviewer is the reason this exists. 025's decided_by_is_reviewer
 * requires the person who decides to be the reviewing coordinator, and before
 * 029 nothing ever set that column, so no decision could be recorded at all.
 * change_event_request_status cannot set it; 029's header gives the full
 * argument for a function of its own.
 *
 * No read first, for the reason reassignEventRequest gives: everything a read
 * could tell this service (does the event exist, is the caller its
 * coordinator, is it submitted) the function answers under its row lock, when
 * the answer cannot change before the write. A blank caller is refused here,
 * because it would never reach the function as a uuid.
 *
 * @param {string} id
 * @param {string} coordinatorId  the caller, from the JWT -- never the body
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<object>} the request, now under_review, in camelCase
 * @throws {ValidationError} no coordinatorId, before any call
 * @throws {ForbiddenError}  the caller is not the event's assigned coordinator
 * @throws {ConflictError}   the request is not submitted, or changed under the call
 * @throws {NotFoundError}   no such request
 */
export async function startEventReview(id, coordinatorId, { client } = {}) {
  requireCallerId(coordinatorId, 'coordinatorId');

  const db = await resolveClient(client);

  const { data, error } = await db.rpc('start_event_review', {
    p_event_request_id: id,
    p_coordinator_id: coordinatorId,
  });

  if (error) throw translateError(error);

  return toEventRequest(data);
}


/** The two decisions a coordinator can make, exactly as 025's enum spells them. */
const DECISIONS = Object.freeze(['approved', 'rejected']);

/**
 * The assigned coordinator approves or rejects a request under review.
 *
 * SCRUM-119 and SCRUM-121, for SCRUM-19 AC1, AC2, AC3, AC5, AC6, AC7 and AC9.
 * The status and the whole decision are written by decide_event_request
 * (migration 029) in one statement, because 025's constraints are checked
 * against the whole row: written apart, each half would leave a row one of
 * them refuses. The function also locks the row, checks the caller is the
 * assigned coordinator and the reviewer, that the request is under review,
 * and (AC6) that an approval's start date has not passed, and writes the
 * status history row with the note as its reason.
 *
 * What the service checks first, before any call:
 *
 *  - decision is exactly 'approved' or 'rejected', lowercase. No
 *    case-folding: those are the enum's values, the frontend sends one from a
 *    button rather than typed text, and accepting 'Approved' would invent a
 *    second spelling the API must honour forever. Anything else would reach
 *    PostgREST as an unreadable enum value and come back as a 500.
 *  - a rejection has a reason. 029 refuses it too (22023), but its refusal is
 *    one sentence in a Postgres exception; this one names decisionNote in
 *    details, so the form can show it beside the field, as every other form
 *    fault in this API is reported. The function's check stays as the
 *    backstop for any caller that does not come through here.
 *  - decidedBy is present.
 *
 * A blank note becomes null, as reassignEventRequest does for a handover note.
 * Sent as spaces it would also fail 021's reason_not_blank on the history row,
 * since the note is that row's reason.
 *
 * `now` is injectable for 016's reason for submitted_at, and it matters more
 * here: AC6 measures "has the start date passed" at this instant, so a test of
 * that boundary needs to state it.
 *
 * @param {string} id
 * @param {object} input
 * @param {string} input.decision        'approved' or 'rejected'
 * @param {string} [input.decisionNote]  required when rejecting
 * @param {string} decidedBy             the caller, from the JWT -- never the body
 * @param {object} [options]
 * @param {object} [options.client]
 * @param {Date}   [options.now]         the decision time
 * @returns {Promise<object>} the request after the decision, in camelCase
 * @throws {ValidationError} a bad decision, a rejection with no reason, or no
 *                           decidedBy, before any call
 * @throws {ForbiddenError}  the caller is not the assigned coordinator or reviewer
 * @throws {ConflictError}   not under review, or an approval whose start date
 *                           has passed, or changed under the call
 * @throws {NotFoundError}   no such request
 */
export async function decideEventRequest(
  id,
  { decision, decisionNote } = {},
  decidedBy,
  { client, now = new Date() } = {},
) {
  if (!DECISIONS.includes(decision)) {
    const message = "must be 'approved' or 'rejected'";
    throw new ValidationError(
      `Invalid decision -- decision: ${message}`,
      [{ field: 'decision', message }],
    );
  }

  const note = typeof decisionNote === 'string' && decisionNote.trim() !== ''
    ? decisionNote
    : null;

  if (decision === 'rejected' && note === null) {
    const message = 'is required when rejecting a request';
    throw new ValidationError(
      `Invalid decision -- decisionNote: ${message}`,
      [{ field: 'decisionNote', message }],
    );
  }

  requireCallerId(decidedBy, 'decidedBy');

  const db = await resolveClient(client);

  const { data, error } = await db.rpc('decide_event_request', {
    p_event_request_id: id,
    p_decision: decision,
    p_decision_note: note,
    p_decided_by: decidedBy,
    p_decided_at: now.toISOString(),
  });

  if (error) throw translateError(error);

  return toEventRequest(data);
}

/**
 * SCRUM-355: the Organiser reopens their rejected request as a draft to revise.
 * reopen_event_request (014) checks the caller and the status under the row
 * lock and moves the rejection into the decision history, so nothing is read first.
 *
 * @throws {NotFoundError} no such request, or someone else's
 * @throws {ConflictError} the request is not rejected; the message names its status
 */
export async function reopenEventRequest(id, organiserId, { client } = {}) {
  requireCallerId(organiserId, 'organiserId');

  const db = await resolveClient(client);

  const { data, error } = await db.rpc('reopen_event_request', {
    p_event_request_id: id,
    p_caller: organiserId,
  });

  if (error) throw translateError(error);

  return toEventRequest(data);
}

const CANCELLATION_INITIATORS = Object.freeze([
  'organiser_request',
  'connectsphere_decision',
]);

/**
 * Read the current cancellation impact. This is a preview only; its Postgres
 * function is stable and does not write. The function also checks that the
 * caller is the event's assigned coordinator.
 */
export async function getEventCancellationImpact(id, coordinatorId, { client } = {}) {
  requireCallerId(coordinatorId, 'coordinatorId');
  const db = await resolveClient(client);
  const { data, error } = await db.rpc('event_cancellation_impact_preview', {
    p_event_request_id: id,
    p_caller: coordinatorId,
  });

  if (error) throw translateError(error);
  return data;
}

/**
 * Cancel an event through the transactional SCRUM-374 function.
 *
 * @param {string} id event request id
 * @param {{reason: string, initiator: string, attendeeMessage?: string}} input
 * @param {string} coordinatorId caller from the authenticated session
 * @param {{client?: object}} options
 */
export async function cancelEventRequest(
  id,
  { reason, initiator, attendeeMessage } = {},
  coordinatorId,
  { client } = {},
) {
  requireCallerId(coordinatorId, 'coordinatorId');
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new ValidationError('Cancellation reason is required and cannot be blank');
  }
  if (!CANCELLATION_INITIATORS.includes(initiator)) {
    throw new ValidationError('Cancellation initiator must be organiser_request or connectsphere_decision');
  }
  if (attendeeMessage !== undefined && attendeeMessage !== null && typeof attendeeMessage !== 'string') {
    throw new ValidationError('Attendee message must be text');
  }

  const db = await resolveClient(client);
  const { data, error } = await db.rpc('cancel_event_request', {
    p_event_request_id: id,
    p_coordinator_id: coordinatorId,
    p_reason: reason.trim(),
    p_initiator: initiator,
    p_attendee_message: typeof attendeeMessage === 'string' ? attendeeMessage.trim() || null : null,
  });

  if (error) throw translateError(error);
  return toEventRequest(data);
}

/**
 * Mark a Confirmed event as completed (SCRUM-379) through the transactional
 * complete_event_request function. The closing notes are for coordinators, so
 * they are added to this response only; toEventRequest never carries them.
 *
 * @param {string} id event request id
 * @param {{closingNotes?: string|null}} input
 * @param {string} coordinatorId caller from the authenticated session
 * @param {{client?: object}} options
 */
export async function completeEventRequest(id, { closingNotes } = {}, coordinatorId, { client } = {}) {
  requireCallerId(coordinatorId, 'coordinatorId');
  if (closingNotes !== undefined && closingNotes !== null && typeof closingNotes !== 'string') {
    throw new ValidationError('Closing notes must be text');
  }
  const notes = typeof closingNotes === 'string' ? closingNotes.trim() || null : null;
  // Characters, as Postgres length() counts them; an emoji is one, though two UTF-16 units.
  if (notes !== null && [...notes].length > CLOSING_NOTES_MAX_LENGTH) {
    throw new ValidationError(`Closing notes can be at most ${CLOSING_NOTES_MAX_LENGTH} characters`);
  }

  const db = await resolveClient(client);
  const { data, error } = await db.rpc('complete_event_request', {
    p_event_request_id: id,
    p_coordinator_id: coordinatorId,
    p_closing_notes: notes,
  });

  if (error) throw translateError(error);
  return { ...toEventRequest(data), closingNotes: data.closing_notes ?? null };
}

/**
 * SCRUM-347: the assigned coordinator rejects an Approved event and releases its
 * arrangements. reject_approved_event (024) checks the caller and the status
 * under the row lock; the reason is checked here too so the form can name the field.
 *
 * @throws {ValidationError} a blank reason, before any call
 * @throws {ForbiddenError}  not the assigned coordinator
 * @throws {ConflictError}   not Approved; code CANCEL_INSTEAD when it is Confirmed
 * @throws {NotFoundError}   no such event
 */
export async function rejectApprovedEvent(id, { reason } = {}, coordinatorId, { client } = {}) {
  requireCallerId(coordinatorId, 'coordinatorId');
  if (typeof reason !== 'string' || reason.trim() === '') {
    const message = 'is required to reject an event';
    throw new ValidationError(`Invalid rejection -- reason: ${message}`, [{ field: 'reason', message }]);
  }

  const db = await resolveClient(client);
  const { data, error } = await db.rpc('reject_approved_event', {
    p_event_request_id: id,
    p_coordinator_id: coordinatorId,
    p_reason: reason.trim(),
  });

  if (error?.hint === 'CANCEL_INSTEAD') throw new ConflictError(error.message, { code: 'CANCEL_INSTEAD' });
  if (error) throw translateError(error);
  return toEventRequest(data);
}

/**
 * Preview a significant change. The database repeats ownership and lifecycle
 * checks, while this service applies SCRUM-10 validation before the RPC.
 */
export async function getSignificantEventChangeImpact(
  id,
  changes,
  coordinatorId,
  { client } = {},
) {
  requireCallerId(coordinatorId, 'coordinatorId');

  const db = await resolveClient(client);
  const current = await getEventRequestForCoordinator(id, { client: db });
  if (current.assignedCoordinatorId !== coordinatorId) {
    throw new ForbiddenError('Only the coordinator assigned to this event can preview its significant change.');
  }
  const normalised = validateSignificantEventChange(changes, current);
  const { data, error } = await db.rpc('preview_significant_event_change', {
    p_event_request_id: id,
    p_changes: normalised,
    p_user_id: coordinatorId,
  });

  if (error) throw translateError(error);
  return data;
}

/**
 * Apply a significant change and its impacts in one Postgres transaction.
 */
export async function applySignificantEventChange(
  id,
  { changes, reason, expectedImpact } = {},
  coordinatorId,
  { client } = {},
) {
  requireCallerId(coordinatorId, 'coordinatorId');
  if (typeof reason !== 'string' || reason.trim() === '' || reason.trim().length > 4000) {
    throw new ValidationError('A reason of 1 to 4,000 characters is required');
  }
  if (
    expectedImpact === null ||
    typeof expectedImpact !== 'object' ||
    Array.isArray(expectedImpact) ||
    !Array.isArray(expectedImpact.venueBookings) ||
    !Array.isArray(expectedImpact.equipmentReservations)
  ) {
    throw new ValidationError('Preview the significant change before applying it');
  }

  const db = await resolveClient(client);
  const current = await getEventRequestForCoordinator(id, { client: db });
  if (current.assignedCoordinatorId !== coordinatorId) {
    throw new ForbiddenError('Only the coordinator assigned to this event can apply its significant change.');
  }
  const normalised = validateSignificantEventChange(changes, current);
  const { data, error } = await db.rpc('apply_significant_event_change', {
    p_event_request_id: id,
    p_changes: normalised,
    p_reason: reason.trim(),
    p_user_id: coordinatorId,
    p_expected_impact: expectedImpact,
  });

  if (error) throw translateError(error);
  return {
    event: toEventRequest(data.event),
    impact: data.impact,
    flaggedBookingIds: data.flaggedBookingIds,
    flaggedReservationCount: data.flaggedReservationCount,
  };
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
    .select(ATTENTION_COLUMNS)
    .eq('organiser_id', organiserId)
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false });

  if (error) throw translateError(error);

  // An Organiser with no requests is an ordinary state -- a new client who has
  // not raised one yet -- so it is an empty list, not a NotFoundError. The ??
  // guards the shape PostgREST returns for an empty result set.
  const rows = data ?? [];

  // SCRUM-486 AC1-06: each row carries its coordinator's name, so the
  // Organiser's row can say who has their request. SCRUM-334 left the name
  // behind a click ("Your coordinator and assignment history") because reading
  // it per row would be one request per row; this is one read for the whole
  // list instead, the two-read pattern listUnassignedEventRequests uses:
  // event_requests and profiles both reference auth.users and not each other,
  // so PostgREST cannot embed the name. Narrowed to this list's coordinators,
  // and skipped when no row has one -- a list of drafts, or of requests still
  // waiting for the Lead, costs no second read.
  const coordinatorIds = rows.map((row) => row.assigned_coordinator_id).filter((id) => id != null);
  const nameOf = coordinatorIds.length > 0 ? await readNames(db, coordinatorIds) : () => null;

  return rows.map((row) => ({
    ...toEventRequestWithAttention(row, { forOrganiser: true }),
    assignedCoordinatorName: nameOf(row.assigned_coordinator_id ?? null),
  }));
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
 * Reads through readEventRequestRow, as getEventRequestById does, so there
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

  const request = toEventRequestWithAttention(
    await readEventRequestRow(id, ATTENTION_COLUMNS, client),
    { forOrganiser: true },
  );

  if (request.organiserId !== organiserId) {
    // Deliberately the same message getEventRequestById raises for an id that
    // does not exist. Two different messages would be the same oracle the
    // status code avoids.
    throw new NotFoundError(`Event request ${id} not found`);
  }

  return request;
}

/** One owner-scoped query keeps the event status and its arrangements in the same snapshot. */
export async function getConfirmedArrangementsForOrganiser(id, organiserId, { client } = {}) {
  assertOrganiser(organiserId);
  if (!isPlausibleId(id)) {
    throw new ValidationError('Invalid event request id', [{ field: 'id', message: 'must be a valid id' }]);
  }
  const db = await resolveClient(client);
  const { data, error } = await db.from('event_requests').select(`
    id, organiser_id, status, proposed_start, proposed_end,
    bookings(id, status, venues(name, location)),
    equipment_requests(id, status, equipment_lines(id, quantity, removed_at, equipment_types(name)))
  `).eq('id', id).eq('organiser_id', organiserId).maybeSingle();
  if (error) throw translateError(error);
  if (!data || data.organiser_id !== organiserId) throw new NotFoundError(`Event request ${id} not found`);

  const confirmed = data.status === STATUS.CONFIRMED;
  return {
    eventRequestId: data.id,
    status: data.status,
    startsAt: confirmed ? data.proposed_start : null,
    endsAt: confirmed ? data.proposed_end : null,
    venues: confirmed ? (data.bookings ?? [])
      .filter((booking) => booking.status === BOOKING_STATUS.APPROVED)
      .map((booking) => ({
        bookingId: booking.id, name: booking.venues?.name ?? null, location: booking.venues?.location ?? null,
      })) : [],
    equipment: confirmed ? (data.equipment_requests ?? [])
      .filter((request) => request.status === EQUIPMENT_REQUEST_STATUS.ARRANGED)
      .flatMap((request) => (request.equipment_lines ?? [])
        .filter((line) => line.removed_at == null)
        .map((line) => ({ lineId: line.id, name: line.equipment_types?.name ?? null, quantity: line.quantity }))) : [],
  };
}


/**
 * One event request, for any Event Coordinator.
 *
 * SCRUM-332, for SCRUM-327 AC7: after a handover the previous coordinator can
 * still view the event, and only stops being able to change it. Before this,
 * no coordinator could read a single event at all. getEventRequestForOrganiser
 * answers 404 to anyone but its Organiser, and the queue covers only
 * submitted, under_review and pending_clarification. So once an event was
 * approved or confirmed, nobody on ConnectSphere's side could open it, while
 * AC6 still let its coordinator hand it over.
 *
 * No organiser id and no coordinator id, and neither is compared. That is the
 * rule this module's header states, and listEventRequestsForReview already
 * follows it: a function that takes no owner checks none, and the caller
 * proves the right to read. Here the proof is the role gate on the route
 * (GET /:id/review, behind coordinatorOnly). Which coordinator holds an event
 * decides who may change it, never who may read it.
 *
 * The one thing refused is a draft, answered with exactly the NotFoundError a
 * missing id gets, message included. A draft is the Organiser's private
 * working copy, and COORDINATOR_QUEUE_STATUSES leaves it out of the queue so
 * that no coordinator learns it exists. A coordinator who guessed a draft's id
 * must learn nothing more than from an id that matches nothing: a 403 would
 * confirm the id, and so would a different message. errors.js limits
 * ForbiddenError to records the caller can already see, and nobody but its
 * Organiser can see a draft.
 *
 * Reads through readEventRequestRow, as getEventRequestForOrganiser does, so
 * there is one definition of what a stored request looks like.
 *
 * @param {string} id
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<object>} the stored request, in camelCase
 * @throws {NotFoundError} when no such request exists, or it is a draft
 */
export async function getEventRequestForCoordinator(id, { client } = {}) {
  const request = toEventRequestWithAttention(await readEventRequestRow(id, ATTENTION_COLUMNS, client));

  if (request.status === STATUS.DRAFT) {
    // The same message getEventRequestById raises for an id that does not
    // exist, for the same reason getEventRequestForOrganiser reuses it.
    throw new NotFoundError(`Event request ${id} not found`);
  }

  return request;
}


/**
 * The status history of one event request, oldest first.
 *
 * SCRUM-322, for SCRUM-318 AC6. Reads what change_event_request_status and
 * submit_event_request (migration 021) wrote into event_request_status_history.
 * Nothing here writes, and nothing re-derives a status: the rows are returned
 * as recorded.
 *
 * Only the event's Organiser and its assigned coordinator may read it. Anyone
 * else, including a coordinator the event is not assigned to, gets exactly the
 * NotFoundError a missing id gets, message included, for the reason
 * getEventRequestForOrganiser gives: a 403, or a different message, would
 * confirm the id exists. The check is here, beside the read, so a second
 * caller cannot forget it. It compares the caller with the stored
 * organiserId and assignedCoordinatorId, so no role is read: a person who is
 * the assigned coordinator is one, and an event with no coordinator (a draft)
 * matches nobody on that side.
 *
 * Each row carries the status before and after as recorded, and the label an
 * Organiser sees for each (SCRUM-323), because the Organiser reads this
 * history and must never be shown an internal name. The raw statuses stay for
 * code that branches on them.
 *
 * Each row also carries the name of the user who caused the change, from
 * profiles.full_name, and not their id. The history table references
 * auth.users, not profiles, so PostgREST cannot join them and the names are a
 * second read. A user with no profile or no name is null rather than a guess;
 * an email address is never offered in its place.
 *
 * An event with no recorded change, a draft or one submitted before 021, is an
 * empty list and not a NotFoundError: the event exists and the caller may read
 * it, so "nothing yet" is the true answer.
 *
 * Not decorated with the whole display (group, description). It carries the
 * label alone.
 *
 * @param {string} id
 * @param {string} userId  the caller, from the JWT -- never the body
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<Array<{previousStatus: string, previousStatusLabel: string,
 *           newStatus: string, newStatusLabel: string,
 *           changedByName: string|null, changedAt: string, reason: string|null}>>}
 * @throws {ValidationError} when no user was supplied
 * @throws {NotFoundError}   no such request, or the caller is neither its
 *                           Organiser nor its assigned coordinator
 */
export async function getEventRequestStatusHistory(id, userId, { client } = {}) {
  requireCallerId(userId, 'userId');

  const db = await resolveClient(client);
  const request = await getEventRequestById(id, { client: db });

  if (request.organiserId !== userId && request.assignedCoordinatorId !== userId) {
    throw new NotFoundError(`Event request ${id} not found`);
  }

  const { data: rows, error } = await db
    .from('event_request_status_history')
    .select('previous_status, new_status, changed_by, reason, created_at')
    .eq('event_request_id', id)
    .order('created_at', { ascending: true });

  if (error) throw translateError(error);
  if (!rows || rows.length === 0) return [];

  const userIds = [...new Set(rows.map((row) => row.changed_by))];
  const { data: profiles, error: profileError } = await db
    .from('profiles')
    .select('id, full_name')
    .in('id', userIds);

  if (profileError) throw translateError(profileError);

  const nameById = new Map(
    (profiles ?? []).map((profile) => [profile.id, profile.full_name?.trim() || null]),
  );

  return rows.map((row) => ({
    previousStatus: row.previous_status,
    previousStatusLabel: getOrganiserStatusLabel(row.previous_status),
    newStatus: row.new_status,
    newStatusLabel: getOrganiserStatusLabel(row.new_status),
    changedByName: nameById.get(row.changed_by) ?? null,
    changedAt: row.created_at,
    reason: row.reason ?? null,
  }));
}

export async function getEventClarificationHistory(id, userId, role, { client } = {}) {
  requireCallerId(userId, 'userId');
  const db = await resolveClient(client);
  const request = await getEventRequestById(id, { client: db });
  const isOwner = request.organiserId === userId;
  // SCRUM-486 (SCRUM-521): the Lead reads it as a coordinator does. The event
  // screen the Lead hands an event over from shows this history, and the
  // route has no role gate of its own, so this check is the gate; with the
  // Lead left out it answered 404 and that section of the screen failed.
  const isCoordinatorTeam =
    (role === ROLE.EVENT_COORDINATOR || role === ROLE.EVENT_COORDINATOR_LEAD)
    && request.status !== STATUS.DRAFT;
  if (!isOwner && !isCoordinatorTeam) {
    throw new NotFoundError(`Event request ${id} not found`);
  }

  const { data: entries, error } = await db
    .from('event_request_clarification_history')
    .select('id, entry_type, message, created_by, reply_by_date, requested_fields, created_at')
    .eq('event_request_id', id)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw translateError(error);
  if (!entries?.length) return [];

  const nameOf = await readNames(db, entries.map((entry) => entry.created_by));
  return entries.map((entry) => ({
    id: entry.id,
    type: entry.entry_type,
    message: entry.message,
    authorName: nameOf(entry.created_by),
    createdAt: entry.created_at,
    replyByDate: entry.reply_by_date ?? null,
    requestedFields: entry.requested_fields ?? [],
  }));
}

/**
 * Who may read a request's decision and change histories: the Organiser, and
 * once it is past draft a Lead or the coordinator assigned to it now. Anyone
 * else gets the same NotFoundError a missing id gets.
 */
async function requireHistoryReader(db, id, userId, role) {
  const request = await getEventRequestById(id, { client: db });
  const pastDraft = request.status !== STATUS.DRAFT;
  const mayRead =
    request.organiserId === userId
    || (pastDraft && role === ROLE.EVENT_COORDINATOR_LEAD)
    || (pastDraft && role === ROLE.EVENT_COORDINATOR && request.assignedCoordinatorId === userId);
  if (!mayRead) {
    throw new NotFoundError(`Event request ${id} not found`);
  }
}

/**
 * SCRUM-355 AC3, AC5: the decisions a request has had that are no longer
 * current, oldest first. An entry superseded by a reopen is what marks a request
 * as a resubmission; an approval superseded by a rejection (SCRUM-347) does not.
 *
 * Narrower than the clarification history: past rejection notes are for the
 * Organiser, the Lead who assigns the request, and the coordinator it is
 * assigned to now (AC5), not every coordinator.
 */
export async function getEventDecisionHistory(id, userId, role, { client } = {}) {
  requireCallerId(userId, 'userId');
  const db = await resolveClient(client);
  await requireHistoryReader(db, id, userId, role);

  const { data: entries, error } = await db
    .from('event_request_decision_history')
    .select('id, decision, decision_note, decided_by, decided_at, superseded_reason, superseded_at')
    .eq('event_request_id', id)
    .order('decided_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw translateError(error);
  if (!entries?.length) return [];

  const nameOf = await readNames(db, entries.map((entry) => entry.decided_by));
  return entries.map((entry) => ({
    id: entry.id,
    decision: entry.decision,
    decisionNote: entry.decision_note ?? null,
    decidedByName: nameOf(entry.decided_by),
    decidedAt: entry.decided_at,
    supersededReason: entry.superseded_reason,
    supersededAt: entry.superseded_at,
  }));
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
 * SCRUM-486 (SCRUM-520), AC2-06: only requests someone holds. Since 052 a
 * submitted request has no coordinator until the Event Coordinator Lead
 * assigns one, and until then it is the Lead's alone: it is listed in the
 * Lead's unassigned queue (listUnassignedEventRequests), and every coordinator
 * action on it is refused (052's start_event_review and decide_event_request,
 * and requestEventClarification here). Listed in this queue it would be a row
 * every coordinator can open and do nothing with. So the read also requires
 * assigned_coordinator_id is not null, and every status it listed before is
 * still listed for a request that has a coordinator.
 *
 * Why there is still a shared queue at all, when every request in it now
 * belongs to somebody. Because the customer distinguishes managing an event
 * from viewing one. Managing is restricted: only the coordinator assigned to
 * an event may act on it (SCRUM-327 AC6, AC7). Viewing is not: SCRUM-444 AC1
 * lets any coordinator view any event, which GET /:id/review already serves
 * (SCRUM-332). This queue is that viewing right as a worklist -- what
 * colleagues have waiting -- and it is what a coordinator covering for a
 * colleague, or choosing who to hand an event to, needs to see. Taking it
 * away would remove something the customer allowed in order to enforce a
 * restriction the customer never made. What SCRUM-486 does reserve is the
 * choice of who takes a new request, which is the Lead's; so the only
 * requests kept out are the ones that belong to nobody. That is a customer
 * distinction, not a preference, and it is the whole of the filter.
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
 * listEventRequestsForCoordinator, below, does show the organiser's name, and
 * that is not a contradiction. The floor is for a queue every coordinator
 * sees, of work most of them do not hold. "My events" holds only the events
 * the caller is responsible for, where contacting the organiser is the job.
 * Its docstring gives the argument in full.
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
    .select(ATTENTION_COLUMNS)
    .in('status', COORDINATOR_QUEUE_STATUSES)
    // SCRUM-486 AC2-06: a request nobody holds is the Lead's (see above).
    .not('assigned_coordinator_id', 'is', null)
    .order('submitted_at', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true });

  if (error) throw translateError(error);

  // An empty queue is the good state, not a missing resource: it means nothing
  // is waiting on a Coordinator. 200 [] all the way up, never a NotFoundError.
  return (data ?? []).map((row) => toEventRequestWithAttention(row));
}


/**
 * Every event assigned to one coordinator, soonest first, each with its
 * organiser's name.
 *
 * SCRUM-333, for SCRUM-327 AC11: each coordinator has a "My events" list
 * showing the events assigned to them, grouped by status, earliest event
 * first. It sits beside the shared queue: the queue is every coordinator's
 * view of work awaiting a decision, whoever holds it, and this is the view of
 * work one person does hold. (Before SCRUM-486 the queue was described as work
 * nobody holds yet; since 052 that work is the Lead's unassigned queue, and
 * this queue lists only requests someone holds.)
 *
 * No status filter. The queue leaves decided statuses out because it is a
 * worklist, and a worklist that kept them would never empty. This is a list
 * of responsibility instead. AC11 groups it by status, which assumes more than
 * the live ones, and a coordinator still needs the event they rejected when
 * its Organiser asks why, or the completed one when a report is due. Leave
 * the terminal statuses out here and there is no way to find them at all,
 * because the coordinator read needs an id. The frontend can collapse the
 * groups that are finished. There is no draft filter, and this used to say
 * none was needed because "a draft never has an assigned coordinator, since
 * assignment happens at submission (016)". That stopped being true twice:
 * SCRUM-318's 022 reopens a rejected request to a draft and leaves its
 * coordinator on it, and since SCRUM-486 (052) assignment does not happen at
 * submission at all. Since SCRUM-355's 015, reopening clears the coordinator
 * too, so a draft reopened since then is not listed here.
 *
 * Why this list shows the organiser's name, when listEventRequestsForReview
 * calls leaving it out "the privacy floor of the shared queue": that floor is
 * for a queue every coordinator sees, of events none of them has taken on, so
 * a coordinator learns what was asked for and not who to contact. These are
 * events the caller is responsible for, and AC7 makes them the one person who
 * can act on them. Contacting the organiser is part of that job. The two lists
 * answer the question differently because the work is the caller's here and
 * nobody's there. profiles has full_name but no email, so a name is all there
 * is to show.
 *
 * Why the names are a second read rather than a join in the select. PostgREST
 * embeds one table in another only along a foreign key between them, and
 * there is none: event_requests.organiser_id references auth.users (001), and
 * so does profiles.id (007). select('..., profiles(full_name)') would fail
 * with "could not find a relationship". Adding that foreign key would need a
 * migration, and would refuse every organiser without a profiles row, which
 * the hand-run check scripts create. So this reads the events, then reads
 * full_name for exactly the organisers in that list with one .in(). Both are
 * reads, so there is nothing to keep atomic between them. The second read is
 * narrowed to the organisers of the caller's own events, so it cannot be used
 * to read anyone else's name.
 *
 * Choices worth defending:
 *
 *  - Ordered by proposed_start ascending, because "earliest event first"
 *    means the event happening soonest. The queue orders by submitted_at
 *    because it asks who has waited longest; this asks what is coming up.
 *    nullsFirst: false because proposed_start is nullable and Postgres sorts
 *    nulls first on ASC, which would put an undated event at the head of a
 *    list ordered by date. The id tiebreak is the queue's, for the queue's
 *    reason.
 *  - The same COLUMNS as every other read, so a row here is the shape GET
 *    /:id/review returns, plus organiserName.
 *  - organiserName flat beside organiserId, not a nested object: every other
 *    field is flat, and a nested { id, fullName } would carry the id twice.
 *    null when full_name is null or the organiser has no profiles row, so the
 *    key is always there.
 *  - No second read for an empty list: no rows, no organisers to name.
 *  - If the name read fails, the call fails. Returning the events with every
 *    name null would look like organisers who never gave a name, and nobody
 *    would know a read had failed.
 *  - A flat array, not grouped. Every list in this API is a bare array, and
 *    grouping by status is presentation.
 *
 * Unpaginated, like every other list here, and unlike the queue it is not
 * bounded by a status filter: it grows with every event the coordinator ever
 * holds. Said here rather than discovered.
 *
 * @param {string} coordinatorId  from the JWT, via requireAuth -- never the client
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<object[]>} possibly empty, in camelCase, each with organiserName
 * @throws {ValidationError} when no coordinator was supplied, before any round trip
 */
export async function listEventRequestsForCoordinator(coordinatorId, { client } = {}) {
  // Refused before the client is touched. Without the caller, the read below
  // would have no filter at all and return every assigned event in the
  // system. The id comes from the token, so a missing one is a caller bug.
  if (typeof coordinatorId !== 'string' || coordinatorId.trim() === '') {
    throw new ValidationError(
      'Invalid coordinator -- coordinatorId: is required',
      [{ field: 'coordinatorId', message: 'is required' }],
    );
  }

  const db = await resolveClient(client);

  const { data, error } = await db
    .from('event_requests')
    .select(ATTENTION_COLUMNS)
    .eq('assigned_coordinator_id', coordinatorId)
    .order('proposed_start', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true });

  if (error) throw translateError(error);

  const rows = data ?? [];

  // Nothing assigned is the good state, not a missing resource.
  if (rows.length === 0) return [];

  const nameOf = await readNames(db, rows.map((row) => row.organiser_id));

  return rows.map((row) => ({
    ...toEventRequestWithAttention(row),
    organiserName: nameOf(row.organiser_id),
  }));
}


/**
 * SCRUM-383 (SCRUM-379 AC7): the events columns the Needs attention list reads. The booking
 * embed of ATTENTION_COLUMNS is left out: venue problems come from the readiness check.
 */
const NEEDS_ATTENTION_COLUMNS = `${COLUMNS}, equipment_reservations(flagged, released_at, flag_reason, flag_code)`;

/** The statuses an event can be on the list in; any other status never is. */
const NEEDS_ATTENTION_STATUSES = Object.freeze([STATUS.CONFIRMED, STATUS.APPROVED, STATUS.PENDING_CLARIFICATION]);

/**
 * SCRUM-383 (SCRUM-379 AC7): the caller's Needs attention list, for the events assigned to them.
 *
 * One item per reason, so an event with two reasons appears twice, each time with the
 * reason it is there for. Earliest event first. Nothing is stored: the list is worked out
 * from the events as they are now, so an item disappears the moment its reason is
 * resolved (the event is completed, confirmed or cancelled, the clarification is answered,
 * a failing readiness item is fixed).
 *
 * The reasons (rules and wording in domain/coordinatorAttentionList.js):
 *   - Confirmed and ended: "Mark as completed"
 *   - Approved and ended: "Not confirmed; cancel"
 *   - a clarification past its reply-by date
 *   - a Confirmed event failing SCRUM-363's readiness check: one reason per failing venue or
 *     equipment item (the date item is ignored: a Confirmed event has always started or is about to)
 *   - a Confirmed event with a flagged equipment reservation (SCRUM-315)
 *
 * Time comes in as `now`, so a test can fix it. Production passes nothing.
 *
 * Readiness is read once per Confirmed event, through the same event_readiness function
 * the submission and SCRUM-363's confirm run. If any of those reads fails the whole call
 * fails: a list that silently left a reason out would look like an event in good order.
 *
 * @param {string} coordinatorId  from the token, never from the request
 * @param {object} [options]
 * @param {object} [options.client]
 * @param {Date} [options.now]
 * @returns {Promise<object[]>}
 */
export async function listNeedsAttention(coordinatorId, { client, now = new Date() } = {}) {
  if (!isPlausibleId(coordinatorId)) {
    throw new ValidationError(
      'Invalid coordinator -- coordinatorId: is required',
      [{ field: 'coordinatorId', message: 'is required' }],
    );
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new ValidationError('Invalid time -- now must be a valid date', [{ field: 'now', message: 'must be a valid date' }]);
  }

  const db = await resolveClient(client);

  const { data, error } = await db
    .from('event_requests')
    .select(NEEDS_ATTENTION_COLUMNS)
    .eq('assigned_coordinator_id', coordinatorId.trim().toLowerCase())
    .in('status', NEEDS_ATTENTION_STATUSES)
    .order('proposed_start', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true });
  if (error) throw translateError(error);

  const rows = data ?? [];
  if (rows.length === 0) return [];

  // The date and "no equipment confirmed" items are not conditions a Confirmed event can
  // lose: it has been confirmed, and the coordinator already confirmed any equipment gap.
  const readinessOf = new Map();
  await Promise.all(
    rows.filter((row) => row.status === STATUS.CONFIRMED).map(async (row) => {
      const { data: readiness, error: readinessError } = await db.rpc('event_readiness', {
        p_event_request_id: row.id,
        p_no_equipment_confirmed: true,
      });
      if (readinessError) throw translateError(readinessError);
      readinessOf.set(row.id, readiness);
    }),
  );

  const nameOf = await readNames(db, rows.map((row) => row.organiser_id));

  const items = [];
  for (const row of rows) {
    const reasons = needsAttentionReasons(row, readinessOf.get(row.id), now);
    const seen = new Map();
    for (const { code, reason } of reasons) {
      // A stable key for the screen: the event, the kind of reason, and which of that kind.
      const nth = seen.get(code) ?? 0;
      seen.set(code, nth + 1);
      items.push({
        id: `${row.id}:${code}:${nth}`,
        code,
        reason,
        eventRequestId: row.id,
        eventName: row.event_name,
        status: row.status,
        proposedStart: row.proposed_start ?? null,
        proposedEnd: row.proposed_end ?? null,
        organiserName: nameOf(row.organiser_id),
        link: `/event-requests/${row.id}`,
      });
    }
  }

  return items.sort(compareNeedsAttentionItems);
}

/** The reasons one event is on the list for, [{ code, reason }], possibly none. */
function needsAttentionReasons(row, readiness, now) {
  const reasons = [];
  const ended = eventHasEnded(row.proposed_end, now);

  if (row.status === STATUS.CONFIRMED) {
    if (ended) reasons.push({ code: NEEDS_ATTENTION_CODE.MARK_COMPLETED, reason: MARK_COMPLETED_REASON });

    const failing = (readiness?.items ?? []).filter((item) => item?.met === false);
    for (const item of failing.filter((i) => i.key === 'venue')) {
      reasons.push({ code: NEEDS_ATTENTION_CODE.VENUE_NOT_READY, reason: venueReadinessReason(item.detail) });
    }
    for (const item of failing.filter((i) => i.key === 'equipment')) {
      reasons.push({ code: NEEDS_ATTENTION_CODE.EQUIPMENT_NOT_READY, reason: equipmentReadinessReason(item.detail) });
    }
    for (const reason of equipmentFlagReasons(row, { withReason: true })) {
      reasons.push({ code: NEEDS_ATTENTION_CODE.EQUIPMENT_FLAGGED, reason });
    }
  }

  if (row.status === STATUS.APPROVED && ended) {
    reasons.push({ code: NEEDS_ATTENTION_CODE.NOT_CONFIRMED, reason: NOT_CONFIRMED_REASON });
  }

  if (row.status === STATUS.PENDING_CLARIFICATION && clarificationIsOverdue(row.clarification_reply_by_date, now)) {
    reasons.push({
      code: NEEDS_ATTENTION_CODE.CLARIFICATION_OVERDUE,
      reason: clarificationOverdueReason(row.clarification_reply_by_date),
    });
  }

  return reasons;
}


/**
 * Read full_name for a set of users, in one request, and return a lookup.
 *
 * The second read listEventRequestsForCoordinator and listAssignmentHistory
 * both make, kept in one place so they cannot drift apart. Nothing has a
 * foreign key to profiles (every user column references auth.users), so
 * PostgREST cannot embed a name in the first read; that argument is in full
 * at listEventRequestsForCoordinator.
 *
 * Each id is asked for once, and nulls are dropped before asking: a null is
 * "nobody", which has no name to read. The lookup answers null for a null id,
 * an id with no profiles row, and a profile whose full_name is null, so a
 * caller always gets a string or null, never undefined.
 *
 * A failed read throws. Returning an empty lookup would give every row a null
 * name, which looks like people who never gave one, and nobody would know a
 * read had failed.
 *
 * @param {object} db         a resolved client
 * @param {Array<string|null>} ids  user ids, repeats and nulls allowed
 * @returns {Promise<(id: string|null) => string|null>}
 */
async function readNames(db, ids) {
  const wanted = [...new Set(ids.filter((id) => id != null))];

  const { data, error } = await db
    .from('profiles')
    .select('id, full_name')
    .in('id', wanted);

  if (error) throw translateError(error);

  const nameById = new Map((data ?? []).map((profile) => [profile.id, profile.full_name ?? null]));

  return (id) => (id == null ? null : nameById.get(id) ?? null);
}


/**
 * Every Event Coordinator, as { id, fullName }, for the reassign picker.
 *
 * SCRUM-334, for SCRUM-327 AC9: the outgoing coordinator chooses who to hand
 * the event to, so the screen needs the people they can choose from.
 *
 * This is the first read in the API that lists users, so it is the first that
 * could be used to enumerate staff. It selects only what the picker shows, the
 * id and the name, never the whole row: no role, no created_at. Who may call it
 * is decided at the route, which puts it behind coordinatorOnly.
 *
 * { id, fullName } because the object is the person, so its keys are that
 * person's columns in camelCase, the rule toEventRequest follows.
 * organiserName on "My events" is prefixed only because it names someone else
 * on an event's row.
 *
 * Ordered by full_name, nulls last, then id. A picker is scanned by a person
 * looking for a colleague, so alphabetical is what they need; id alone would
 * be stable but would look random. full_name is nullable, so a coordinator
 * with no name goes to the end rather than the top, and the id orders those,
 * and any two people with the same name, the same way every time. A
 * coordinator with no name is still listed: they can still take an event.
 *
 * The caller is included. Someone cannot hand an event to themselves, so the
 * picker leaves them out, which is presentation. Doing it here would make
 * this "everyone but me".
 *
 * The role comes from ROLE in domain/userRole.js rather than a literal, so it
 * is the same string requireRole checks. It is also the value 014 and 015
 * select coordinators by.
 *
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<Array<{ id: string, fullName: string|null }>>} possibly empty
 */
export async function listCoordinators({ client } = {}) {
  const db = await resolveClient(client);

  const { data, error } = await db
    .from('profiles')
    .select('id, full_name')
    .eq('role', ROLE.EVENT_COORDINATOR)
    .order('full_name', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true });

  if (error) throw translateError(error);

  // No coordinators is not an error. Nobody can be handed an event, and the
  // picker says so; that is its message to show.
  return (data ?? []).map((profile) => ({
    id: profile.id,
    fullName: profile.full_name ?? null,
  }));
}


/**
 * The Event Coordinator Lead's unassigned queue (SCRUM-486 AC2): every
 * submitted request with no coordinator, oldest first.
 *
 * SCRUM-519. Oldest first by submitted_at, not soonest event as "My events"
 * sorts: the Lead's question is what has waited longest for a person to pick
 * it up, and AC2 says so. id breaks a tie, so two refetches of the same data
 * never reshuffle. Drafts never appear: the filter is status = 'submitted', and
 * a draft is not waiting for anyone yet.
 *
 * Two reads, as listEventRequestsForCoordinator does. event_requests and
 * profiles both reference auth.users and not each other, so PostgREST cannot
 * embed the organiser's name; a second read of profiles, narrowed to this
 * list's organisers, supplies it. "How long it has waited" is submittedAt,
 * left to the screen to show against its own clock.
 *
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<object[]>} each request in camelCase, plus organiserName
 */
export async function listUnassignedEventRequests({ client } = {}) {
  const db = await resolveClient(client);

  const { data, error } = await db
    .from('event_requests')
    .select(COLUMNS)
    .eq('status', STATUS.SUBMITTED)
    .is('assigned_coordinator_id', null)
    .order('submitted_at', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true });

  if (error) throw translateError(error);

  const rows = data ?? [];

  if (rows.length === 0) return [];

  const nameOf = await readNames(db, rows.map((row) => row.organiser_id));

  return rows.map((row) => ({
    ...toEventRequest(row),
    organiserName: nameOf(row.organiser_id),
  }));
}



/**
 * Every Event Coordinator, with their count of active events, for the Lead's
 * assignment picker (SCRUM-486 AC3).
 *
 * SCRUM-519. A read of its own rather than listCoordinators widened, for
 * three reasons. listCoordinators is SCRUM-334's handover picker, read by
 * every coordinator; adding workload to it would show every coordinator
 * everyone's caseload, which no story asked for. Its route is behind
 * coordinatorOnly, and SCRUM-485 pins that a Lead is refused it; widening the
 * gate would undo that deliberately pinned refusal for a need a separate route
 * meets without it. And a route of its own makes its gate say exactly who
 * reads workload: the Lead.
 *
 * Only event_coordinator: the Lead cannot be assigned events (the team's
 * 11 October decision), and one role per account means this excludes every
 * Lead. Ordered by name, then id, never by workload: the system suggests
 * nobody (AC3), and a list sorted by count would put a recommendation at the
 * top in all but name.
 *
 * Two reads: the coordinators, then their active events, counted here. A
 * coordinator with none is listed with 0, not left out. Both reads are
 * readCoordinatorsAndActiveEvents, shared with the Lead's overview (SCRUM-487
 * AC2), so the picker's count and the overview's total are one count.
 *
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<Array<{ id: string, fullName: string|null, activeEvents: number }>>}
 */
export async function listCoordinatorWorkload({ client } = {}) {
  const db = await resolveClient(client);

  // Only the column the count needs: the picker shows a name and a number.
  const { coordinators, events } = await readCoordinatorsAndActiveEvents(db, 'assigned_coordinator_id');

  const countOf = new Map();
  for (const event of events) {
    countOf.set(event.assigned_coordinator_id, (countOf.get(event.assigned_coordinator_id) ?? 0) + 1);
  }

  return coordinators.map((profile) => ({
    id: profile.id,
    fullName: profile.full_name ?? null,
    activeEvents: countOf.get(profile.id) ?? 0,
  }));
}


/**
 * The two reads the picker's workload and the Lead's overview share: every
 * Event Coordinator, by name then id, and their events in an active status.
 *
 * SCRUM-487 (SCRUM-541), extracted from listCoordinatorWorkload as it was, so
 * that "N active events" in SCRUM-486's picker and a coordinator's total in
 * SCRUM-487's overview are the same coordinators counted over the same events
 * (SCRUM-487 D3). Two copies of these reads would agree only until someone
 * changed one of them.
 *
 * `columns` is the caller's: the picker selects only assigned_coordinator_id,
 * and SCRUM-486 pins exactly that select, while the overview also needs status
 * to count each one. Everything else, the role, the order, the narrowing to
 * the coordinators just read and the status set, is fixed here.
 *
 * No coordinators means no second read: there is nobody to count for. A
 * failed read throws through translateError; a zero-filled list would look
 * like coordinators with nothing to do.
 *
 * @param {object} db       a resolved client
 * @param {string} columns  the event columns the caller counts by
 * @returns {Promise<{ coordinators: Array<{ id: string, full_name: string|null }>, events: object[] }>}
 */
async function readCoordinatorsAndActiveEvents(db, columns) {
  const { data: profiles, error: profilesError } = await db
    .from('profiles')
    .select('id, full_name')
    .eq('role', ROLE.EVENT_COORDINATOR)
    .order('full_name', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true });

  if (profilesError) throw translateError(profilesError);

  const coordinators = profiles ?? [];

  if (coordinators.length === 0) return { coordinators, events: [] };

  const { data: events, error: eventsError } = await db
    .from('event_requests')
    .select(columns)
    .in('assigned_coordinator_id', coordinators.map((profile) => profile.id))
    .in('status', ACTIVE_EVENT_STATUSES);

  if (eventsError) throw translateError(eventsError);

  return { coordinators, events: events ?? [] };
}


/**
 * Every Event Coordinator, with their active events counted in total and per
 * status, for the Lead's coordinator overview (SCRUM-487 AC2), and the words
 * for each status the overview shows.
 *
 * SCRUM-541. AC2: "every Event Coordinator with their number of active events
 * and the count in each status". Returned as { statuses, coordinators }:
 * coordinators is { id, fullName, activeEvents, byStatus } per coordinator.
 *
 * SCRUM-546 (SCRUM-487 D9): statuses is { status, label, finished } for every
 * status in ACTIVE_EVENT_STATUSES, then every one in FINISHED_EVENT_STATUSES,
 * in that order. The screen heads the table's columns and fills the status
 * filter from it. Before, the screen took each status's words from an event
 * row it had happened to load with that status, and fell back to the raw key
 * (pending_clarification) for a status no row had shown: a heading that
 * depended on what the filters had fetched. The label is getStatusDisplay's,
 * the same source as every row's statusDisplay, so a column heading and a
 * status badge never give one status two names. They are the Organiser's
 * words ("Requested", "Planning"), the ones on every badge the Lead already
 * sees; coordinator-facing words would be a change to the whole status
 * display, not this read. finished tells the screen which statuses to offer
 * only when the Lead includes finished events (AC3). Changing this response
 * cost nothing: it is new in SCRUM-487 and nothing else reads it.
 *
 * A read of its own rather than byStatus added to listCoordinatorWorkload
 * (SCRUM-487 D3). The picker's response is pinned exactly by SCRUM-486 ("an
 * extra key fails: no role, no recommended"): beside a choice, it shows a name
 * and a number and nothing that reads as advice. The per-status breakdown is
 * the supervision view's. Both count through readCoordinatorsAndActiveEvents,
 * so activeEvents here equals the picker's count for the same coordinator.
 *
 * byStatus has one key for every status in ACTIVE_EVENT_STATUSES, each 0 when
 * the coordinator holds none: a missing key would make the screen guess
 * whether it means none or unknown. The keys come from the constant, not a
 * list written here, so the safety statuses SCRUM-488 added to it appear here
 * with no other change. Naming a status the database enum lacks in the filter
 * would fail the whole read (SCRUM-487 D4), so the enum migration (SCRUM-550)
 * has to reach a database before this list does. activeEvents is the sum of
 * byStatus, so the two can never disagree on one row.
 *
 * Ordered by name, then id, like the picker, never by workload: the overview
 * shows who has what, and does not rank anyone. A coordinator with nothing is
 * listed with zeros, not left out; they are the one most able to take more.
 * Who may call it is decided at the route: leadOnly.
 *
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<{ statuses: Array<{ status: string, label: string, finished: boolean }>,
 *   coordinators: Array<{ id: string, fullName: string|null, activeEvents: number,
 *   byStatus: Object<string, number> }> }>}
 */
export async function listCoordinatorOverview({ client } = {}) {
  const db = await resolveClient(client);

  const { coordinators, events } = await readCoordinatorsAndActiveEvents(db, 'assigned_coordinator_id, status');

  const byStatusOf = new Map(
    coordinators.map((profile) => [profile.id, Object.fromEntries(ACTIVE_EVENT_STATUSES.map((status) => [status, 0]))]),
  );
  for (const event of events) {
    const counts = byStatusOf.get(event.assigned_coordinator_id);
    // The read is narrowed to these coordinators and these statuses, so both
    // always match; the guard keeps activeEvents the sum of byStatus even if
    // a row ever arrived that did not.
    if (counts && Object.hasOwn(counts, event.status)) counts[event.status] += 1;
  }

  const statuses = [
    ...ACTIVE_EVENT_STATUSES.map((status) => ({ status, label: getOrganiserStatusLabel(status), finished: false })),
    ...FINISHED_EVENT_STATUSES.map((status) => ({ status, label: getOrganiserStatusLabel(status), finished: true })),
  ];

  return {
    statuses,
    coordinators: coordinators.map((profile) => {
      const byStatus = byStatusOf.get(profile.id);
      return {
        id: profile.id,
        fullName: profile.full_name ?? null,
        activeEvents: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
        byStatus,
      };
    }),
  };
}


/**
 * Every event someone holds in an active status, for the Lead (SCRUM-486 AC6).
 *
 * The Lead may hand any held event to another coordinator (AC6), from the
 * event's own page. Until this read, nothing linked a Lead to that page: an
 * assigned request leaves the unassigned queue, and the coordinators' queue
 * and "My events" are coordinatorOnly. This is the list that leads there. It
 * was the first slice of SCRUM-487 AC3's list, and SCRUM-487 extended it
 * (SCRUM-542: the filters and finished events, below) rather than replacing
 * it; the per-coordinator counts are listCoordinatorOverview, and the
 * unassigned count is the queue's own read on the screen.
 *
 * ACTIVE_EVENT_STATUSES, not a list of its own, so the events here are exactly
 * the ones the picker counts as "N active events" beside each name, and the
 * safety statuses SCRUM-488 added to that constant are in both. Not
 * the coordinators' queue statuses: those stop at pending clarification, and
 * approved and confirmed events, where an absent coordinator matters most, are
 * the ones a Lead most needs to reach.
 *
 * Earliest event first (SCRUM-487 AC3), by proposed_start, nulls last for the
 * reason listEventRequestsForCoordinator gives, then id so two refetches never
 * reshuffle.
 *
 * SCRUM-487 AC3 (SCRUM-542) adds three options, each applied in the query,
 * not left to the browser (SCRUM-487 D2: finished events only grow, so
 * filtering on the screen would mean fetching every one of them to hide
 * most). Called with none, the read is exactly SCRUM-486 AC6's, and SCRUM-486's
 * tests of it pass unchanged.
 *
 *  - coordinatorId: only that coordinator's events. Checked with isPlausibleId
 *    first, so a malformed id is a 400 rather than Postgres's 22P02. An id
 *    that names no coordinator is an empty list, not a 404: the route would
 *    otherwise tell anyone who calls it which ids are coordinators.
 *  - status: one status. It must be active or finished; draft is a known
 *    status but never in this list, so it is refused like an unknown one.
 *    isKnownStatus would admit draft, so the two arrays decide.
 *  - includeFinished: a boolean, false by default. Adds exactly
 *    FINISHED_EVENT_STATUSES to the statuses read.
 *
 * Every option is checked before any query, so a refused filter costs no
 * round trip. A finished status asked for while finished events are hidden is
 * an empty list without a query: nothing in the list could match, and it is
 * a coherent question with an empty answer, not a malformed one.
 *
 * Only the columns a row shows, not COLUMNS: the row opens the event page,
 * which reads the full event itself. The organiser's and the coordinator's
 * names come from one profiles read narrowed to the people on this list
 * (readNames), skipped when the list is empty, as AC1-06 reads coordinators
 * for the Organiser's list. Who may call it is decided at the route: leadOnly.
 *
 * @param {object} [options]
 * @param {object} [options.client]
 * @param {string} [options.coordinatorId]     only this coordinator's events (SCRUM-487 AC3)
 * @param {string} [options.status]            only this status, active or finished (SCRUM-487 AC3)
 * @param {boolean} [options.includeFinished]  also completed, rejected and cancelled (SCRUM-487 AC3)
 * @returns {Promise<Array<{ id: string, eventName: string, status: string,
 *   proposedStart: string|null, organiserName: string|null,
 *   assignedCoordinatorId: string, assignedCoordinatorName: string|null }>>}
 * @throws {ValidationError} a malformed coordinatorId, a status that is not
 *   active or finished, or an includeFinished that is not a boolean, before any query
 */
export async function listAssignedEventsForLead({ client, coordinatorId, status, includeFinished = false } = {}) {
  if (coordinatorId !== undefined && !isPlausibleId(coordinatorId)) {
    throw new ValidationError(
      'Invalid filter -- coordinatorId: must be a valid id',
      [{ field: 'coordinatorId', message: 'must be a valid id' }],
    );
  }
  if (status !== undefined && !ACTIVE_EVENT_STATUSES.includes(status) && !FINISHED_EVENT_STATUSES.includes(status)) {
    throw new ValidationError(
      'Invalid filter -- status: must be an active or finished status',
      [{ field: 'status', message: 'must be an active or finished status' }],
    );
  }
  if (typeof includeFinished !== 'boolean') {
    throw new ValidationError(
      'Invalid filter -- includeFinished: must be true or false',
      [{ field: 'includeFinished', message: 'must be true or false' }],
    );
  }

  const statuses = includeFinished ? [...ACTIVE_EVENT_STATUSES, ...FINISHED_EVENT_STATUSES] : ACTIVE_EVENT_STATUSES;

  if (status !== undefined) {
    // A finished status while finished events are hidden: nothing can match,
    // so the answer is the empty list, and no query is made to learn it.
    if (!statuses.includes(status)) return [];
  }

  const db = await resolveClient(client);

  let query = db
    .from('event_requests')
    .select('id, event_name, status, proposed_start, organiser_id, assigned_coordinator_id');
  // One status narrows the set to itself; it is already known to be in it.
  query = status === undefined ? query.in('status', statuses) : query.eq('status', status);
  query = query.not('assigned_coordinator_id', 'is', null);
  if (coordinatorId !== undefined) query = query.eq('assigned_coordinator_id', coordinatorId.trim());

  const { data, error } = await query
    .order('proposed_start', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true });

  if (error) throw translateError(error);

  const rows = data ?? [];

  // Nothing held is not a missing resource: 200 [].
  if (rows.length === 0) return [];

  const nameOf = await readNames(db, rows.flatMap((row) => [row.organiser_id, row.assigned_coordinator_id]));

  return rows.map((row) => ({
    id: row.id,
    eventName: row.event_name,
    status: row.status,
    proposedStart: row.proposed_start ?? null,
    organiserName: nameOf(row.organiser_id),
    assignedCoordinatorId: row.assigned_coordinator_id,
    assignedCoordinatorName: nameOf(row.assigned_coordinator_id),
  }));
}


/**
 * The Lead assigns an unassigned submitted request to one Event Coordinator
 * (SCRUM-486 AC3, AC4).
 *
 * SCRUM-519. The write is assign_event_request (052), through rpc: it locks
 * the row, refuses anyone but a Lead, refuses a request that already has a
 * coordinator or is not submitted, refuses an assignee who is not an Event
 * Coordinator, then writes the coordinator, its history row and the two
 * notices in one transaction. A blank note becomes null.
 *
 * AC4 asks for a lost race to be shown who was assigned. 052 says so in its
 * message, but that message also names the event's id, and the screens never
 * show raw server text. So on a 409 this reads who holds the request now and
 * returns them as data: a ConflictError with code ALREADY_ASSIGNED and the
 * coordinator in `conflicts`, which handleError serialises. A 409 for any
 * other reason (the request is no longer submitted) passes through unchanged.
 *
 * @param {string} id
 * @param {object} input
 * @param {string} input.coordinatorId  the Event Coordinator chosen
 * @param {string} [input.note]          optional; the history row's handover note
 * @param {string} assignedBy            the caller, from the JWT -- never the body
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<object>} the request, now assigned, in camelCase
 * @throws {ValidationError} no plausible coordinatorId, before any call
 * @throws {ForbiddenError}  the caller is not a Lead
 * @throws {ConflictError}   already assigned (code ALREADY_ASSIGNED), or not submitted
 * @throws {NotFoundError}   no such request
 */
export async function assignEventRequest(id, { coordinatorId, note } = {}, assignedBy, { client } = {}) {
  if (!isPlausibleId(coordinatorId)) {
    const message = typeof coordinatorId === 'string' && coordinatorId.trim() !== ''
      ? 'must be the id of an Event Coordinator'
      : 'is required';
    throw new ValidationError(
      `Invalid assignment -- coordinatorId: ${message}`,
      [{ field: 'coordinatorId', message }],
    );
  }

  const db = await resolveClient(client);

  const { data, error } = await db.rpc('assign_event_request', {
    p_event_request_id: id,
    p_coordinator_id: coordinatorId.trim(),
    p_assigned_by: assignedBy,
    p_note: typeof note === 'string' && note.trim() !== '' ? note : null,
  });

  if (error) {
    const translated = translateError(error);
    if (translated instanceof ConflictError) {
      const holder = await readHolder(db, id);
      if (holder) {
        throw new ConflictError(
          `This request has already been assigned to ${holder.name ?? 'another coordinator'}.`,
          { code: 'ALREADY_ASSIGNED', conflicts: [{ assignedCoordinatorId: holder.id, assignedCoordinatorName: holder.name }] },
        );
      }
    }
    throw translated;
  }

  return toEventRequest(data);
}

/** Who holds a request now, with their name, or null when nobody does. */
async function readHolder(db, id) {
  const { data, error } = await db
    .from('event_requests')
    .select('assigned_coordinator_id')
    .eq('id', id)
    .maybeSingle();

  if (error || !data?.assigned_coordinator_id) return null;

  const nameOf = await readNames(db, [data.assigned_coordinator_id]);
  return { id: data.assigned_coordinator_id, name: nameOf(data.assigned_coordinator_id) };
}


/**
 * The history columns every view reads. handover_note is not here: it is
 * added only for a coordinator's view (see listAssignmentHistory).
 * event_request_id is not here either, because every row read has the id the
 * caller asked for.
 */
const HISTORY_COLUMNS = 'id, previous_coordinator_id, new_coordinator_id, assigned_by, created_at';


/**
 * One event's assignment history, oldest first.
 *
 * SCRUM-334, for SCRUM-327 AC9 (every handover records who made it, and the
 * note) and AC10 (the Organiser's screen shows the history). Reads
 * event_request_assignment_history (014). 016 wrote a row on submission until
 * SCRUM-486; since 052 the first row is the Lead's assignment
 * (assign_event_request), and every handover writes one (018, widened by 052).
 * The old rows stay, with assigned_by null, and still read as automatic.
 *
 * Its own read, behind its own routes, not folded into the event reads. Folded
 * in, it would put a growing array inside every event read, /mine and /queue
 * included, where nothing shows it. Change requests are separate for the same
 * reason.
 *
 * Takes no owner and checks none, which is this module's rule. The route
 * proves the right to read, with the same proof the event itself needs:
 * ownership for an Organiser, the role for a coordinator.
 *
 * Each entry:
 *
 *   { id,
 *     previousCoordinatorId, previousCoordinatorName,
 *     newCoordinatorId,      newCoordinatorName,
 *     assignedById,          assignedByName,
 *     automatic,
 *     createdAt,
 *     handoverNote }         <- only with includeNotes: true
 *
 * Ids beside names, flat, as organiserId sits beside organiserName on "My
 * events". createdAt keeps the column's name; 014 records that it is the
 * moment the assignment took effect.
 *
 * Why `automatic` is a flag, rather than leaving the client to test
 * assignedById for null. 014 says a null assigned_by means the system assigned
 * the event, on submission or in a backfill. That is the database's
 * convention, and every client would otherwise have to know it. Once names are
 * added it is also ambiguous: assignedByName is null both for the system and
 * for a person with no full_name. So the API states the one fact the screen
 * needs, "assigned automatically" or "handed over by", derived from
 * assigned_by alone, and keeps assignedById as the source.
 *
 * Why the handover note is withheld unless asked for, and why its key is then
 * absent rather than null. The note is written by one coordinator for
 * another, "I'm on leave, the shortlist is in my notes". The Organiser sees
 * who and when, which the customer confirmed, but not the note: if they could
 * read it, coordinators would write it differently or stop writing it, and the
 * handover it exists for would get worse. null already means "no note was
 * written", which is true of every automatic assignment. An absent key means
 * "not sent to you". If both were null, nobody could tell a withheld note from
 * a missing one. Without includeNotes the column is not even selected, so a
 * later change to the mapping cannot leak it. includeNotes defaults to false,
 * so a caller that forgets to choose gets the Organiser's view.
 *
 * Oldest first, then id. A history is a chain, null -> A, A -> B, and a chain
 * is read from its start. 014's index is (event_request_id, created_at desc),
 * newest first, and it still serves this query: Postgres reads a btree index
 * backwards as readily as forwards, so one event's rows are found and returned
 * in order without a sort. id breaks ties the same way every time.
 *
 * Names come from one read of profiles, for every person the history mentions,
 * each asked for once (readNames). No rows, no second read. If the name read
 * fails, the call fails.
 *
 * @param {string} id  the event request
 * @param {object} [view]
 * @param {boolean} [view.includeNotes=false]  true only for a coordinator's view
 * @param {object} [options]
 * @param {object} [options.client]
 * @returns {Promise<object[]>} possibly empty, oldest first, in camelCase
 * @throws {ValidationError} when no event id was supplied, before any round trip
 */
export async function listAssignmentHistory(id, { includeNotes = false } = {}, { client } = {}) {
  // Without an event id the read below would have no filter, and return every
  // assignment ever made.
  if (typeof id !== 'string' || id.trim() === '') {
    throw new ValidationError(
      'Invalid assignment history -- eventRequestId: is required',
      [{ field: 'eventRequestId', message: 'is required' }],
    );
  }

  const columns = includeNotes ? `${HISTORY_COLUMNS}, handover_note` : HISTORY_COLUMNS;

  const db = await resolveClient(client);

  const { data, error } = await db
    .from('event_request_assignment_history')
    .select(columns)
    .eq('event_request_id', id)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  if (error) throw translateError(error);

  const rows = data ?? [];

  // A draft has no history, and that is an ordinary state.
  if (rows.length === 0) return [];

  const nameOf = await readNames(
    db,
    rows.flatMap((row) => [row.previous_coordinator_id, row.new_coordinator_id, row.assigned_by]),
  );

  return rows.map((row) => {
    const entry = {
      id: row.id,
      previousCoordinatorId: row.previous_coordinator_id ?? null,
      previousCoordinatorName: nameOf(row.previous_coordinator_id),
      newCoordinatorId: row.new_coordinator_id,
      newCoordinatorName: nameOf(row.new_coordinator_id),
      assignedById: row.assigned_by ?? null,
      assignedByName: nameOf(row.assigned_by),
      automatic: row.assigned_by == null,
      createdAt: row.created_at,
    };

    // Added only when asked for, so the Organiser's entries have no such key.
    if (includeNotes) entry.handoverNote = row.handover_note ?? null;

    return entry;
  });
}


/** DETAIL's outstanding lines, or none: a malformed DETAIL must not become a 500. */
function parseOutstanding(details) {
  try {
    const items = JSON.parse(details);
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

const SAFETY_NOTE_MAX = 2000;

/**
 * The readiness checklist of SCRUM-489 AC2 and AC3, from event_readiness (075),
 * the same function the submission and SCRUM-363's confirm run.
 *
 * @param {object} options
 * @param {string} options.eventRequestId
 * @param {boolean} [options.noEquipmentConfirmed]
 * @param {object} [options.client]
 * @returns {Promise<{ eventRequestId: string, ready: boolean, items: object[] }>}
 */
export async function getEventReadiness({ client, eventRequestId, noEquipmentConfirmed = false } = {}) {
  if (!isPlausibleId(eventRequestId)) {
    throw new ValidationError('Invalid event request id', [{ field: 'id', message: 'must be a valid id' }]);
  }
  if (typeof noEquipmentConfirmed !== 'boolean') {
    throw new ValidationError(
      'Invalid noEquipmentConfirmed -- must be true or false',
      [{ field: 'noEquipmentConfirmed', message: 'must be true or false' }],
    );
  }

  const db = await resolveClient(client);
  const { data, error } = await db.rpc('event_readiness', {
    p_event_request_id: eventRequestId,
    p_no_equipment_confirmed: noEquipmentConfirmed,
  });
  if (error) throw translateError(error);
  return data;
}

/** Confirm through one RPC; assignment, status and readiness are checked under its locks. */
export async function confirmEventRequest({
  client, eventRequestId, coordinatorId, noEquipmentConfirmed = false, expectedUpdatedAt = null,
} = {}) {
  if (!isPlausibleId(eventRequestId)) {
    throw new ValidationError('Invalid event request id', [{ field: 'id', message: 'must be a valid id' }]);
  }
  if (!isPlausibleId(coordinatorId)) {
    throw new ValidationError('Invalid coordinator id', [{ field: 'coordinatorId', message: 'must be a valid id' }]);
  }
  if (typeof noEquipmentConfirmed !== 'boolean') {
    throw new ValidationError(
      'Invalid noEquipmentConfirmed -- must be true or false',
      [{ field: 'noEquipmentConfirmed', message: 'must be true or false' }],
    );
  }

  if (expectedUpdatedAt !== null) {
    const details = [];
    checkTimestamp({ add: (field, message) => details.push({ field, message }) }, 'expectedUpdatedAt', expectedUpdatedAt);
    if (details.length) throw new ValidationError('Invalid event revision', details);
  }

  const db = await resolveClient(client);
  const { data, error } = await db.rpc('confirm_event_request', {
    p_event_request_id: eventRequestId,
    p_coordinator_id: coordinatorId,
    p_no_equipment_confirmed: noEquipmentConfirmed,
    p_expected_updated_at: expectedUpdatedAt,
  });
  if (error) throw translateError(error);
  return toEventRequest(data);
}

/**
 * The assigned coordinator sends an Approved, ready event to the Safety
 * Officers (SCRUM-489 AC1 to AC6, AC8), through submit_event_for_safety_review
 * (064). The inputs are refused here first, by the database's own rules, so a
 * bad one costs no round trip.
 *
 * @param {object} options
 * @param {string} options.eventRequestId
 * @param {string} options.coordinatorId     the caller, from the token
 * @param {string} [options.note]            for the Safety Officer, up to 2,000 characters
 * @param {boolean} [options.noEquipmentConfirmed]
 * @param {object} [options.client]
 * @returns {Promise<object>} the event, now in Safety review, in camelCase
 */
export async function submitForSafetyReview({
  client, eventRequestId, coordinatorId, note, noEquipmentConfirmed = false,
} = {}) {
  if (!isPlausibleId(eventRequestId)) {
    throw new ValidationError('Invalid event request id', [{ field: 'id', message: 'must be a valid id' }]);
  }
  requireCallerId(coordinatorId, 'coordinatorId');
  if (note !== undefined && note !== null && typeof note !== 'string') {
    throw new ValidationError('Invalid note -- must be text', [{ field: 'note', message: 'must be text' }]);
  }
  const trimmed = typeof note === 'string' ? note.trim() : '';
  if (trimmed.length > SAFETY_NOTE_MAX) {
    throw new ValidationError(
      'The note for the Safety Officer must be 2,000 characters or fewer',
      [{ field: 'note', message: 'must be 2,000 characters or fewer' }],
    );
  }
  if (typeof noEquipmentConfirmed !== 'boolean') {
    throw new ValidationError(
      'Invalid noEquipmentConfirmed -- must be true or false',
      [{ field: 'noEquipmentConfirmed', message: 'must be true or false' }],
    );
  }

  const db = await resolveClient(client);
  const { data, error } = await db.rpc('submit_event_for_safety_review', {
    p_event_request_id: eventRequestId,
    p_coordinator_id: coordinatorId,
    p_note: trimmed === '' ? null : trimmed,
    p_no_equipment_confirmed: noEquipmentConfirmed,
  });
  if (error) throw translateError(error);
  return toEventRequest(data);
}


/**
 * The assigned coordinator edits an event's information (SCRUM-387).
 *
 * The body is validated with SCRUM-10's rules (AC6); everything else, who may
 * edit, in which status, whether a value changed since the form opened, the
 * history and the Organiser's notice, is edit_event_request_details's (022),
 * under the row lock. There is no coordinator pre-check here: the route's gate
 * and the function decide, as SCRUM-539 settled.
 *
 * @param {string} id
 * @param {{changes: object, expected: object, reason: string}} body
 * @param {string} coordinatorId  from the token
 * @param {{client?: object}} [options]
 * @returns {Promise<{event: object, changedFields: string[]}>}
 */
export async function editEventRequestDetails(id, body, coordinatorId, { client } = {}) {
  requireCallerId(coordinatorId, 'coordinatorId');
  // A 400 here, not Postgres's 22P02 from the uuid cast, which is a 500.
  if (!isPlausibleId(id)) {
    throw new ValidationError('Invalid event request id', [{ field: 'id', message: 'must be a valid id' }]);
  }
  const { changes, expected, reason } = validateEventDetailsEdit(body);

  const db = await resolveClient(client);
  const { data, error } = await db.rpc('edit_event_request_details', {
    p_event_request_id: id,
    p_user_id: coordinatorId,
    p_changes: changes,
    p_expected: expected,
    p_reason: reason,
  });

  if (error) throw translateError(error);
  return { event: toEventRequest(data.event), changedFields: data.changedFields };
}

/**
 * An event's field-level change history, newest first (SCRUM-387 AC7): direct
 * edits and significant changes alike, each row with its source.
 *
 * The read rule is getEventDecisionHistory's (D7), shared through requireHistoryReader.
 *
 * @param {string} id
 * @param {string} userId  from the token
 * @param {string} role
 * @param {{client?: object}} [options]
 */
export async function getEventChangeHistory(id, userId, role, { client } = {}) {
  requireCallerId(userId, 'userId');
  // As the edit: a malformed id would otherwise reach getEventRequestById's cast.
  if (!isPlausibleId(id)) {
    throw new ValidationError('Invalid event request id', [{ field: 'id', message: 'must be a valid id' }]);
  }
  const db = await resolveClient(client);
  await requireHistoryReader(db, id, userId, role);

  // One save's rows share changed_at, and a uuid tie-break is random, so they
  // are ordered by field name within it; id only breaks a tie that is left.
  const { data: entries, error } = await db
    .from('event_change_history')
    .select('id, field_name, old_value, new_value, reason, source, changed_by, changed_at')
    .eq('event_request_id', id)
    .order('changed_at', { ascending: false })
    .order('field_name', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw translateError(error);
  if (!entries?.length) return [];

  const nameOf = await readNames(db, entries.map((entry) => entry.changed_by));
  return entries.map((entry) => ({
    id: entry.id,
    field: entry.field_name,
    oldValue: entry.old_value ?? null,
    newValue: entry.new_value ?? null,
    reason: entry.reason,
    source: entry.source,
    changedByName: nameOf(entry.changed_by),
    changedAt: entry.changed_at,
  }));
}
