// eventRequestService.js
//
// Matches the REAL backend contract, inferred from
// backend/scripts/check-event-request-service.js (which exercises the actual
// eventRequestService.js/eventRequestValidation.js you have but didn't
// upload directly). Field names below are taken verbatim from that script's
// assertions, e.g. `complete.venueRequirements`, `complete.organiserId`,
// `submitted.submittedAt`.
//
// Key backend behaviours this service reflects:
//   - createEventRequest never submits — every new request starts as 'draft'
//     (SCRUM-10 AC3), so creation and submission are two separate calls.
//   - submitEventRequest validates completeness server-side and returns
//     every failing field at once (SCRUM-10 AC4) — a ValidationError with
//     a `details` array of { field, message }.
//   - Submitting a non-draft request is refused (409/ConflictError) —
//     SCRUM-10 AC6.
//   - The backend scopes "my requests" by the authenticated organiser
//     (SCRUM-10 AC8) — this service doesn't pass an organiserId; the
//     Express layer derives it from the authenticated session.
//
// ROUTES: every function in this file now resolves to a real route mounted at
// /api/event-requests in backend/src/app.js, and every request-shaped response
// carries `statusDisplay` — the label, group and description, produced by the
// backend so this app keeps no copy of the status vocabulary.
//
// This note used to say that POST /event-requests, PATCH /event-requests/:id
// and POST /:id/submit were unmounted and would 404. That stopped being true
// when SCRUM-29 and SCRUM-11's routes landed, and a stale warning about a 404
// is worse than none: it sends the next reader looking for a backend gap that
// is already closed.
//
// getEventRequestQueue was the first call here that is not the Organiser's own
// data (SCRUM-45). It is gated on the Event Coordinator role server-side, so
// a 403 from it is an ordinary outcome for any other role rather than a fault.
// The SCRUM-327 calls at the bottom of this file are the same kind, and are
// introduced there.

import { apiClient } from "./apiClient";
import { getData, patchData, postData } from "./apiData";

/**
 * Creates a new event request as a draft (SCRUM-29).
 *
 * @param {Object} input
 * @param {string} input.eventName
 * @param {string} [input.purpose]
 * @param {string} [input.description]
 * @param {string} [input.proposedStart]   ISO datetime
 * @param {string} [input.proposedEnd]     ISO datetime
 * @param {number} [input.expectedAttendance]
 * @param {string} [input.venueRequirements]
 * @param {string} [input.accessibilityRequirements]
 * @param {string} [input.equipmentRequirements]
 * @returns {Promise<Object>} the created request, status 'draft'
 */
export async function createEventRequest(input) {
  return postData("/event-requests", input);
}

/**
 * Saves changes to an existing draft (SCRUM-11). Only valid while status
 * is still 'draft' — once submitted, further changes go through the
 * change-request flow (SCRUM-32/34) instead.
 *
 * @param {string} id
 * @param {Object} input  same shape as createEventRequest's input
 */
export async function updateEventRequest(id, input) {
  return patchData(`/event-requests/${id}`, input);
}

/**
 * Submits a draft request (SCRUM-10 AC4-7). The backend validates
 * completeness and moves status draft -> submitted, recording submittedAt.
 *
 * On failure, throws with err.response.data.details as an array of
 * { field, message } — every gap at once, not just the first (AC4).
 *
 * @param {string} id
 * @returns {Promise<Object>} the request, now status 'submitted'
 */
export async function submitEventRequest(id) {
  return postData(`/event-requests/${id}/submit`);
}

export async function requestEventClarification(
  id,
  note,
  replyByDate = null,
  requestedFields = [],
) {
  return postData(`/event-requests/${id}/clarification`, {
    note,
    replyByDate,
    requestedFields,
  });
}

export async function respondToEventClarification(id, message, amendments = {}) {
  return patchData(
    `/event-requests/${id}/clarification-response`,
    { message, amendments },
  );
}

export async function closeEventClarification(id, note) {
  return postData(
    `/event-requests/${id}/clarification/close`,
    { note },
  );
}

export async function getEventClarificationHistory(id) {
  return getData(`/event-requests/${id}/clarification-history`);
}

// SCRUM-355: reopen a rejected request as a draft. A 409's message names the
// request's current status, so it can be shown as it is.
export async function reopenEventRequest(id) {
  return postData(`/event-requests/${id}/reopen`);
}

// SCRUM-355: past decisions, oldest first; empty if it was never resubmitted.
export async function getEventDecisionHistory(id) {
  return getData(`/event-requests/${id}/decision-history`);
}

// SCRUM-387: the assigned coordinator edits an event's information. `expected`
// is what the form showed for each changed field; a stale one is a 409.
export async function updateEventRequestDetails(id, { changes, expected, reason }) {
  return patchData(`/event-requests/${id}/details`, { changes, expected, reason });
}

// SCRUM-387: each field change recorded for the event, newest first.
export async function getEventChangeHistory(id) {
  return getData(`/event-requests/${id}/change-history`);
}


export async function getCoordinatorChangeRequests(eventRequestId) {
  return getData(
    `/event-requests/${eventRequestId}/change-requests/review`,
  );
}

// SCRUM-402: the whole group is decided. `decision` is { decision,
// decisionNotes, expectedImpact? }, the impact the preview returned.
export async function processCoordinatorChangeRequest(changeRequestId, decision) {
  return postData(
    `/event-requests/change-requests/${changeRequestId}/decision`,
    decision,
  );
}

// SCRUM-402 AC4: what accepting the group would do; changes nothing.
export async function previewCoordinatorChangeRequest(changeRequestId) {
  return getData(`/event-requests/change-requests/${changeRequestId}/preview`);
}

/**
 * Fetches one event request by id.
 */
export async function getEventRequestById(id) {
  return getData(`/event-requests/${id}`);
}

/**
 * Fetches every event request belonging to the signed-in Organiser
 * (SCRUM-10 AC8 — an Organiser sees only their own requests). The backend
 * derives "mine" from the authenticated session, not a passed-in id.
 *
 * @returns {Promise<Array>}
 */
export async function getMyEventRequests() {
  return getData("/event-requests");
}

/**
 * Every event request awaiting a decision, oldest waiting first (SCRUM-45).
 *
 * The Event Coordinator's review queue, and the only read in this file that
 * crosses Organisers: the backend gates it on the event_coordinator role
 * rather than scoping it to the caller, because a queue nobody owns is
 * exactly the thing an ownership check cannot narrow. A 403 therefore means
 * "not a Coordinator", not "something went wrong" — handle it as a message,
 * not as a failure.
 *
 * Rows are the same shape getMyEventRequests returns, `statusDisplay`
 * included, so readStatusDisplay and statusClassName work on them unchanged
 * and the queue needs no status vocabulary of its own. They are also complete:
 * the backend selects the same columns GET /:id does, which is why the detail
 * panel renders from the row already in hand and there is no second fetch.
 *
 * organiserId arrives as a bare uuid. No endpoint resolves it to a name —
 * that is deliberate, not missing — so render it as an identifier.
 *
 * @returns {Promise<Array>} possibly empty; an empty queue is the good state
 */
export async function getEventRequestQueue() {
  return getData("/event-requests/queue");
}

export async function getEventCancellationImpact(id) {
  return getData(
    `/event-requests/${id}/cancellation-impact`,
  );
}

export async function previewSignificantEventChange(id, changes) {
  return postData(
    `/event-requests/${id}/significant-change-impact`,
    { changes },
  );
}

export async function applySignificantEventChange(id, { changes, reason, expectedImpact }) {
  return postData(
    `/event-requests/${id}/significant-change`,
    { changes, reason, expectedImpact },
  );
}

export async function cancelEventRequest(
  id,
  { reason, initiator, attendeeMessage },
) {
  return postData(`/event-requests/${id}/cancel`, {
    reason,
    initiator,
    attendeeMessage,
  });
}

/**
 * SCRUM-347: the assigned coordinator rejects an Approved event and releases its
 * arrangements. A 409 with code CANCEL_INSTEAD means the event is Confirmed.
 */
export async function rejectApprovedEvent(id, { reason }) {
  return postData(`/event-requests/${id}/rejection`, { reason });
}

/**
 * SCRUM-384 (SCRUM-379 AC1, AC2): the assigned coordinator marks a Confirmed event that has ended
 * as completed. `closingNotes` is optional; blank is sent as no notes. The reply is the event with
 * `closingNotes`, which only a coordinator is ever given. A 409 with code EVENT_FINAL means the
 * event is already Completed or Cancelled; its message is the server's.
 */
export async function completeEventRequest(id, { closingNotes } = {}) {
  const notes = typeof closingNotes === "string" ? closingNotes.trim() : "";
  return postData(`/event-requests/${id}/complete`, notes ? { closingNotes: notes } : {});
}

/**
 * SCRUM-384 (SCRUM-379 AC7): the signed-in coordinator's Needs attention list, one item per
 * reason, earliest event first: { id, code, reason, eventRequestId, eventName, status,
 * proposedStart, proposedEnd, organiserName, link }. `link` is the screen that opens the event.
 * The list is the caller's from the token; a 403 means "not a coordinator". [] is the good state.
 *
 * @returns {Promise<Array>}
 */
export async function getNeedsAttention() {
  return getData("/event-requests/needs-attention");
}

/**
 * SCRUM-489 AC2-AC4: the safety check's readiness checklist,
 * { eventRequestId, ready, items }. The flag is sent only when true, so the
 * plain read is the path alone.
 */
export async function getEventReadiness(id, { noEquipmentConfirmed } = {}) {
  const path = `/event-requests/${id}/readiness`;
  const response = noEquipmentConfirmed === true
    ? await apiClient.get(path, { params: { noEquipmentConfirmed: "true" } })
    : await apiClient.get(path);
  return response.data;
}

/**
 * SCRUM-489 AC6: submits an Approved event for the safety check. Returns the
 * event, now in safety_review. A 409 with code EVENT_NOT_READY carries the
 * outstanding lines as `conflicts`.
 */
export async function submitForSafetyReview(id, { note, noEquipmentConfirmed = false } = {}) {
  return postData(`/event-requests/${id}/safety-review`, {
    note,
    noEquipmentConfirmed,
  });
}

export async function confirmEventRequest(id, { noEquipmentConfirmed = false, expectedUpdatedAt } = {}) {
  return postData(`/event-requests/${id}/confirm`, {
    noEquipmentConfirmed,
    ...(expectedUpdatedAt != null ? { expectedUpdatedAt } : {}),
  });
}

export async function getConfirmedArrangements(id) {
  return getData(`/event-requests/${id}/confirmed-arrangements`);
}

// ---------------------------------------------------------------------------
// SCRUM-327: coordinator assignment
// ---------------------------------------------------------------------------
// The six calls below are the frontend half of SCRUM-331 to SCRUM-334. The
// backend for all six is built and tested; no component calls these yet. They
// are added on their own first so the app behaves exactly as before, and each
// screen that uses one can be built and reviewed separately.
//
// Every one of them is role-gated or ownership-scoped on the server. Nothing
// here decides who may see what: a call the caller is not entitled to make
// comes back as a 403 or a 404, and the component turns that into a message.

/**
 * Every event assigned to the signed-in coordinator, "My events" (SCRUM-333).
 *
 * Every status, decided and finished ones included: this is the list of what
 * the coordinator is responsible for, not a worklist that empties. Drafts
 * never appear, because a draft has no coordinator yet.
 *
 * Ordered by the backend, earliest event first by proposedStart, with events
 * that have no date at the end. Not re-sorted here, for the reason
 * ReviewQueue gives: the server already answered "what is coming up soonest",
 * and a second answer in the client is how two screens start disagreeing.
 * Grouping by status, which SCRUM-327 AC11 asks for, is the component's job.
 *
 * Each row is the shape getMyEventRequests returns, statusDisplay included,
 * plus organiserName: the Organiser's name, or null when they have none on
 * record. This is the one list that carries a name. The shared queue
 * deliberately does not, because it is everyone's queue; these are events the
 * coordinator is responsible for, where contacting the Organiser is the job.
 *
 * Gated on the event_coordinator role, so a 403 means "not a coordinator",
 * not a fault. The list is the caller's from the token; there is no parameter
 * that could ask for someone else's.
 *
 * @returns {Promise<Array>} possibly empty; nothing assigned is the good state
 */
export async function getMyAssignedEvents() {
  return getData("/event-requests/mine");
}

/**
 * One event, for any Event Coordinator (SCRUM-332).
 *
 * Not only the assigned coordinator: every coordinator can read every event
 * past draft. Which coordinator holds an event decides who may change it,
 * never who may read it, and SCRUM-327 AC7 says the previous coordinator can
 * still view an event they handed over.
 *
 * This is how a coordinator opens an event the queue no longer carries. The
 * queue holds only submitted, under_review and pending_clarification, so an
 * approved or confirmed event, the ones "My events" lists, can only be opened
 * through here. getEventRequestById reads the Organiser's route, which answers
 * 404 to anyone who did not organise the event.
 *
 * A draft answers 404, the same as an id that does not exist. That is
 * deliberate: a draft is the Organiser's private working copy, and no
 * coordinator is meant to learn that one exists.
 *
 * The response is the same shape as a queue row, statusDisplay included,
 * without organiserName.
 *
 * @param {string} id
 * @returns {Promise<Object>}
 */
export async function getEventRequestForReview(id) {
  return getData(`/event-requests/${id}/review`);
}

/**
 * Every Event Coordinator, for the reassign picker (SCRUM-334).
 *
 * Each entry is { id, fullName }, in name order, with anyone who has no name
 * on record at the end. fullName can be null: a coordinator with no name is
 * still someone an event can be handed to, so the picker has to show them
 * some other way rather than drop them.
 *
 * The list includes the caller. Nobody can hand an event to themselves, so
 * the picker should leave the signed-in user out, matching on id: the user in
 * AuthContext has no name to compare. That is the picker's job; the server
 * returns the plain list.
 *
 * Gated on the event_coordinator role. This is the first call in the app that
 * lists people, and nothing outside the reassign screen needs it.
 *
 * @returns {Promise<Array<{id: string, fullName: string|null}>>} possibly empty
 */
export async function listCoordinators() {
  return getData("/event-requests/coordinators");
}

/**
 * One event's assignment history, the Organiser's view (SCRUM-334, SCRUM-327
 * AC10).
 *
 * Oldest first, so it reads as a chain: assigned to A on submission, then
 * handed from A to B, then from B to C. Each entry:
 *
 *   { id,
 *     previousCoordinatorId, previousCoordinatorName,
 *     newCoordinatorId,      newCoordinatorName,
 *     assignedById,          assignedByName,
 *     automatic,
 *     createdAt }
 *
 * Two things a caller must understand before rendering one:
 *
 *  - automatic: true means the system assigned the event when it was
 *    submitted, which only happened before SCRUM-486; every row written since
 *    names the Lead or the coordinator who made it. There is no person behind
 *    an automatic row, so assignedById and
 *    assignedByName are null by design, not because data is missing. Render
 *    it as "Assigned automatically", not as a handover by nobody. Test
 *    automatic rather than assignedByName, because a name is also null for a
 *    person who has none on record.
 *  - previousCoordinatorId and previousCoordinatorName are null on the first
 *    entry, because nobody held the event before it was assigned.
 *
 * Any name can be null when the person has none on record. createdAt is an
 * ISO timestamp: when that assignment took effect.
 *
 * There is no handoverNote key, and that is deliberate. The note is written by
 * one coordinator for another ("I'm on leave, the shortlist is in my notes"),
 * and the Organiser sees who and when, never the note. The key is absent
 * rather than null so that "not sent to you" is never confused with "none was
 * written".
 *
 * Organiser-scoped: someone else's event answers 404, exactly as a missing
 * one does. A coordinator calling this gets the same 404 for an event they
 * did not organise; their view is getAssignmentHistoryForReview.
 *
 * @param {string} id
 * @returns {Promise<Array>} possibly empty: a draft has no history yet
 */
export async function getAssignmentHistory(id) {
  return getData(`/event-requests/${id}/assignments`);
}

/**
 * One event's assignment history, a coordinator's view (SCRUM-334, SCRUM-327
 * AC9).
 *
 * The same entries as getAssignmentHistory, oldest first, with the same two
 * rules: automatic: true means the system assigned it on submission and the
 * assignedBy fields are null by design, and the previous coordinator is null
 * on the first entry because nobody held the event before. Each entry also
 * carries handoverNote: the note's text, or null when none was written, which
 * is always so on an automatic assignment.
 *
 * Any coordinator gets the notes, not only the one now assigned. The note is
 * written for the coordinator team, and the Organiser is the reader it is
 * kept from. Limiting it to the current coordinator would hide every note from
 * the person who wrote it, since writing one means handing the event away.
 *
 * Gated on the event_coordinator role, so a 403 means "not a coordinator". A
 * draft or a missing id answers 404, as getEventRequestForReview does.
 *
 * @param {string} id
 * @returns {Promise<Array>} possibly empty
 */
export async function getAssignmentHistoryForReview(id) {
  return getData(`/event-requests/${id}/assignments/review`);
}

/**
 * Hand an event to another Event Coordinator, with an optional note
 * (SCRUM-331, SCRUM-327 AC6 and AC9).
 *
 * Only the event's assigned coordinator may do this. The person handing over
 * is whoever is signed in, taken from the token on the server; nothing sent
 * here can name someone else.
 *
 * The body is exactly { newCoordinatorId, handoverNote }. A blank or omitted
 * note is stored as no note.
 *
 * Returns the event after the handover, statusDisplay included, with
 * assignedCoordinatorId now the new coordinator, so a screen can redraw from
 * the response.
 *
 * The status codes a caller will want to tell apart:
 *
 *   403  the caller is not the event's assigned coordinator, or is not a
 *        coordinator at all. It may have just been handed to someone else.
 *   400  newCoordinatorId is missing or not an id, the person named is not an
 *        Event Coordinator, or they already hold the event. A missing or
 *        malformed id carries err.response.data.details naming the field.
 *   409  the event's status does not allow a handover (only submitted,
 *        under_review, pending_clarification, approved and confirmed do), or
 *        it changed hands while this request was in flight.
 *   404  the event does not exist.
 *
 * The 403 and 400 messages are written by the database and name ids, so they
 * read badly as they are. Show a message chosen by status code instead, the
 * way ReviewQueue does.
 *
 * @param {string} id
 * @param {Object} handover
 * @param {string} handover.newCoordinatorId  an id from listCoordinators
 * @param {string} [handover.handoverNote]    optional, for the new coordinator
 * @returns {Promise<Object>} the event after the handover
 */
export async function reassignEventRequest(id, { newCoordinatorId, handoverNote }) {
  return postData(`/event-requests/${id}/reassign`, {
    newCoordinatorId,
    handoverNote,
  });
}

// ---------------------------------------------------------------------------
// SCRUM-486 (SCRUM-519): the Event Coordinator Lead's queue and assignment
// ---------------------------------------------------------------------------
// All three are gated on event_coordinator_lead server-side.

/**
 * Every submitted request nobody has been assigned yet, oldest submission
 * first (SCRUM-486 AC2). Each carries organiserName and submittedAt, from
 * which the screen says how long it has waited. Possibly empty.
 *
 * @returns {Promise<Object[]>}
 */
export async function listUnassignedEventRequests() {
  return getData("/event-requests/unassigned");
}

/**
 * Every Event Coordinator, with their count of active events, for the Lead's
 * picker (SCRUM-486 AC3). In name order, never workload order: the system
 * suggests nobody. Leads are never in it; they cannot be assigned events.
 *
 * @returns {Promise<Array<{id: string, fullName: string|null, activeEvents: number}>>}
 */
export async function listCoordinatorWorkload() {
  return getData("/event-requests/coordinator-workload");
}

/**
 * Every event someone holds in an active status, earliest event first, for
 * the Lead (SCRUM-486 AC6): the way to an assigned event's page, where the
 * Lead hands it over. Each row is { id, eventName, status, statusDisplay,
 * proposedStart, organiserName, assignedCoordinatorId,
 * assignedCoordinatorName }. Possibly empty.
 *
 * SCRUM-487 AC3 (SCRUM-544): the Lead's filters, sent as query parameters
 * and applied by the server (SCRUM-487 D2). Only the filters that are set are
 * sent, and includeFinished only as "true": the server reads "true", "false"
 * or absent and refuses anything else, so "off" is simply not sending it.
 * Called with nothing, the request is exactly SCRUM-486's: no params at all.
 *
 * @param {object} [filters]
 * @param {string} [filters.coordinatorId]     only this coordinator's events
 * @param {string} [filters.status]            only this status
 * @param {boolean} [filters.includeFinished]  also completed, rejected and cancelled
 * @returns {Promise<Object[]>}
 */
export async function listAssignedEventsForLead(filters = {}) {
  const params = {};
  if (filters.coordinatorId) params.coordinatorId = filters.coordinatorId;
  if (filters.status) params.status = filters.status;
  if (filters.includeFinished) params.includeFinished = "true";

  const response = Object.keys(params).length > 0
    ? await apiClient.get("/event-requests/assigned", { params })
    : await apiClient.get("/event-requests/assigned");
  return response.data;
}

/**
 * Every Event Coordinator with their active events counted in total and per
 * status, for the Lead's overview (SCRUM-487 AC2), and the words for each
 * status. Returns { statuses, coordinators }: statuses is { status, label,
 * finished } for every active status then every finished one (SCRUM-546,
 * D9); each coordinator is { id, fullName, activeEvents, byStatus }, byStatus
 * keyed by every active status, 0 where there are none. Coordinators in name
 * order, never workload order. Gated on event_coordinator_lead server-side.
 *
 * @returns {Promise<{statuses: Array<{status: string, label: string, finished: boolean}>,
 *   coordinators: Array<{id: string, fullName: string|null, activeEvents: number, byStatus: Object<string, number>}>}>}
 */
export async function listCoordinatorOverview() {
  return getData("/event-requests/coordinator-overview");
}

/**
 * The Lead assigns an unassigned request to one Event Coordinator (SCRUM-486
 * AC3). The note is optional and becomes the assignment history's handover
 * note; the Organiser never sees it.
 *
 * A 409 whose err.response.data.code is "ALREADY_ASSIGNED" means another
 * Lead got there first; err.response.data.conflicts[0].assignedCoordinatorName
 * says who (AC4). Any other 409 means the request is no longer submitted.
 * 400 is no coordinator chosen, or someone who is not an Event Coordinator;
 * 403 is not a Lead; 404 is no such request.
 *
 * @param {string} id
 * @param {{coordinatorId: string, note?: string}} assignment
 * @returns {Promise<Object>} the request, now assigned
 */
export async function assignEventRequest(id, { coordinatorId, note }) {
  return postData(`/event-requests/${id}/assign`, {
    coordinatorId,
    note,
  });
}

// ---------------------------------------------------------------------------
// SCRUM-19: starting a review, and deciding a request
// ---------------------------------------------------------------------------
// The frontend half of SCRUM-346, SCRUM-119 and SCRUM-121. The backend writes
// both through migration 029's functions, which check under a row lock that
// the caller is the event's assigned coordinator and that the request is in
// the right status. Nothing here decides who may do what.

/**
 * Start reviewing a submitted request (SCRUM-19 AC1).
 *
 * Moves it from submitted to under_review and makes the signed-in coordinator
 * its reviewing coordinator, the one person the database then allows to
 * decide it. No body: the caller is taken from the token.
 *
 * Returns the request after the change, statusDisplay included, so a screen
 * can redraw from the response.
 *
 * The status codes a caller will want to tell apart:
 *
 *   403  the caller is not the event's assigned coordinator, or is not a
 *        coordinator at all. It may have just been handed to someone else.
 *   409  the request is not submitted any more: someone started the review
 *        already, or it moved on.
 *   404  the request does not exist.
 *
 * The 403 and 409 messages are written by the database and name ids, so show
 * a message chosen by status code instead, as ReviewQueue does.
 *
 * @param {string} id
 * @returns {Promise<Object>} the request, now under review
 */
export async function startEventReview(id) {
  return postData(`/event-requests/${id}/start-review`);
}

/**
 * Approve or reject a request under review (SCRUM-19 AC2-AC9).
 *
 * The body is exactly { decision, decisionNote }. decision is 'approved' or
 * 'rejected', lowercase, nothing else. A rejection needs a reason in
 * decisionNote; an approval's note is optional. Who decided and when are not
 * sent: the server takes the caller from the token and the time from its own
 * clock.
 *
 * Returns the request after the decision, with decision, decisionNote,
 * decidedBy and decidedAt filled in and statusDisplay updated.
 *
 * The status codes a caller will want to tell apart:
 *
 *   400  the decision value is not one of the two, or a rejection has no
 *        reason. A missing reason carries err.response.data.details naming
 *        decisionNote.
 *   403  the caller is not the event's assigned coordinator, or someone else
 *        is recorded as reviewing it.
 *   409  one of two things, sharing a code on purpose (029's header): the
 *        request is not under review (not started yet, waiting on a
 *        clarification, or already decided), or, for an approval only, the
 *        event's proposed start date has passed or is missing (AC6). The
 *        remedy for the second is to agree a new date with the organiser or
 *        reject the request, so a screen should say that, not a generic
 *        failure.
 *   404  the request does not exist.
 *
 * The database's messages name ids, so show a message chosen by status code.
 *
 * @param {string} id
 * @param {Object} decision
 * @param {'approved'|'rejected'} decision.decision
 * @param {string} [decision.decisionNote]  required when rejecting
 * @returns {Promise<Object>} the request after the decision
 */
export async function decideEventRequest(id, { decision, decisionNote }) {
  return postData(`/event-requests/${id}/decision`, {
    decision,
    decisionNote,
  });
}
