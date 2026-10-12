/**
 * End-to-end proof for coordinator assignment, against the live database.
 *
 * Run with: npm run assignment:check
 *
 * First written for SCRUM-327 (checked by SCRUM-335), when submission chose a
 * coordinator automatically. Rewritten for SCRUM-486 (SCRUM-522), because the
 * customer changed that requirement on 11 October: a submitted request now
 * goes to the Event Coordinator Lead, who assigns it to a coordinator by hand.
 * Migration 052 made the change. What the script used to prove, and what it
 * proves now:
 *
 *   1. Was: the selection rule (015) -- fewest active events, then longest
 *      without an assignment. 052 leaves pick_event_coordinator in the
 *      database, but nothing calls it any more, so testing it would prove a
 *      rule the system no longer uses. Now: submission assigns nobody. The
 *      request is submitted with no coordinator and no assignment-history row,
 *      every Lead is told it is waiting, it is in the Lead's queue, and it is
 *      not in the coordinators' shared queue.
 *   2. Was: assign on submission (016) -- one coordinator, one history row,
 *      assigned_by null for "the system". Now: the Lead assigns
 *      (assign_event_request, 052) -- one coordinator, one history row whose
 *      assigned_by is the Lead, the coordinator and the Organiser told; every
 *      refusal by its code, a second assignment told who won, and the request
 *      out of the Lead's queue and into the shared one. And the real AC4 race:
 *      two Leads assigning at once, on separate connections, which no test
 *      suite here can do.
 *   3. Was: 017's constraint refused a submitted event with no coordinator.
 *      Now: 052's relaxed constraint allows exactly that and still refuses any
 *      later status without one.
 *   4. Reassignment: a holder's handover, unchanged, and beside it the Lead's
 *      (AC6): a Lead who does not hold the event moves it, the history names
 *      the Lead, and the coordinator it was taken from is refused after. An
 *      unassigned request is refused as "assign, not reassign".
 *   5. Permissions: only the holder acts; any coordinator reads. Unchanged.
 *   6. The reads: "My events", the history (old automatic rows and new Lead
 *      rows side by side, AC9-03), and both coordinator lists.
 *
 * It creates its own users: an Organiser, an Event Coordinator Lead, three
 * coordinators, and a Venue Staff member used as someone who may not be
 * assigned. It removes them and everything they touched, and checks that it
 * did: every delete's error is kept, and the last checks count what is left.
 *
 * HAZARDS, each handled below rather than hoped away:
 *
 *  - Every real Lead is notified of this script's submissions (052 tells every
 *    Lead a request is waiting). Those rows are real Leads' notifications in a
 *    shared project, so cleanup deletes every notification about an event this
 *    run created, and notifications are counted before and after like every
 *    other table. Until cleanup runs, a real Lead who looks will see them.
 *  - The test coordinators are real choices in a real Lead's picker while this
 *    runs. If a Lead assigns a real request to one, the test user cannot be
 *    deleted (every coordinator column is ON DELETE RESTRICT). cleanup() looks
 *    for such events and, if one is still submitted, returns it to the Lead's
 *    queue (no coordinator, the history rows naming test users removed). That
 *    is the state it was in before the Lead chose; 052's constraint allows it
 *    only at submitted. Anything further along is reported as a cleanup
 *    failure naming the event, for a Lead to hand over by hand. Before
 *    SCRUM-486 this re-homed the event with pick_event_coordinator; there is no
 *    automatic choice to fall back on now, and inventing one would undo the
 *    change the customer asked for.
 *  - Delete order. event_request_assignment_history and (since SCRUM-321)
 *    event_request_status_history both reference event_requests ON DELETE
 *    RESTRICT, and name users the same way. So: notifications, change
 *    requests, status history, assignment history, events, then users. The
 *    version before SCRUM-522 did not delete status history, so once 021 was
 *    live its event delete would have been refused (inferred from 021's
 *    foreign key; not observed, since this script has not been run since).
 *
 * Exits non-zero on any failure.
 */

import { supabase } from '../src/config/supabaseClient.js';
import {
  createEventRequest,
  submitEventRequest,
  assignEventRequest,
  reassignEventRequest,
  startEventReview,
  requestEventClarification,
  getEventRequestForCoordinator,
  listEventRequestsForCoordinator,
  listEventRequestsForReview,
  listUnassignedEventRequests,
  listAssignmentHistory,
  listCoordinators,
  listCoordinatorWorkload,
} from '../src/services/eventRequestService.js';
import {
  createChangeRequest,
  processChangeRequest,
} from '../src/services/eventChangeRequestService.js';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} from '../src/errors.js';

const STAMP = Date.now();
const NAME = `__check_assign_${STAMP}`;

const DAY = 24 * 60 * 60 * 1000;

// Everything created, tracked the moment it exists, so cleanup can find it
// whatever fails afterwards.
const users = {};            // label -> id
const createdEventIds = [];
let countsBefore = null;
let returnedToQueue = [];
let failures = 0;

// supabase-js returns a refused delete as { error } rather than throwing, so a
// delete a foreign key refuses is silent unless someone keeps it.
const cleanupErrors = [];

function check(label, passed, detail = '') {
  console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!passed) failures += 1;
}

function section(title) {
  console.log(`\n  -- ${title}`);
}

/** Await a rejection and hand back the error, or null if it resolved. */
async function failureFrom(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

/** A refusal of the expected type and status, reported in one line. */
function checkRefusal(label, err, ErrorType, status) {
  check(
    label,
    err instanceof ErrorType && err.status === status,
    err ? `${err.name} ${err.status}: ${err.message}` : 'it was ACCEPTED',
  );
}

/** Ids of the test users, in a stable order. */
function userIds() {
  return Object.values(users).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A throwaway user with a profiles row.
 *
 * No password: nothing here signs in. Every action goes through the services,
 * which take the acting user as an argument, exactly as the routes pass
 * req.user.id. The full_name is what the names in lists and refusals are
 * checked against.
 */
async function createUser(label, role) {
  const { data, error } = await supabase.auth.admin.createUser({
    email: `__check_assign_${label}_${STAMP}@example.invalid`,
    email_confirm: true,
  });
  if (error) throw new Error(`could not create user ${label}: ${error.message}`);
  users[label] = data.user.id;

  const { error: profileError } = await supabase
    .from('profiles')
    .insert({ id: data.user.id, role, full_name: `Check Assign ${label}` });
  if (profileError) throw new Error(`could not create profile ${label}: ${profileError.message}`);

  return data.user.id;
}

/** An event inserted directly, for fixtures no function should make. */
async function insertEvent(label, { status, coordinator }) {
  const { data, error } = await supabase
    .from('event_requests')
    .insert({
      organiser_id: users.organiser,
      event_name: `${NAME}_${label}`,
      status,
      assigned_coordinator_id: coordinator,
      submitted_at: status === 'draft' ? null : new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) throw new Error(`could not insert event ${label}: ${error.message}`);
  createdEventIds.push(data.id);
  return data.id;
}

/** A complete draft, made and submitted through the real services. */
async function submitDraft(label) {
  const start = new Date(Date.now() + 30 * DAY);
  const draft = await createEventRequest({
    eventName: `${NAME}_${label}`,
    purpose: 'A coordinator assignment check.',
    proposedStart: start.toISOString(),
    proposedEnd: new Date(start.getTime() + 8 * 60 * 60 * 1000).toISOString(),
    expectedAttendance: 40,
  }, users.organiser);
  createdEventIds.push(draft.id);
  return submitEventRequest(draft.id, { changedBy: users.organiser });
}

/** The history rows for one event, oldest first, straight from the table. */
async function historyOf(eventId) {
  const { data, error } = await supabase
    .from('event_request_assignment_history')
    .select('*')
    .eq('event_request_id', eventId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw new Error(`could not read history: ${error.message}`);
  return data;
}

/** The notifications about one event, straight from the table. */
async function noticesAbout(eventId) {
  const { data, error } = await supabase
    .from('notifications')
    .select('recipient_id, type, payload')
    .eq('payload->>eventRequestId', eventId);
  if (error) throw new Error(`could not read notifications: ${error.message}`);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Counting and cleanup
// ---------------------------------------------------------------------------

async function countRows(table) {
  const { count } = await supabase.from(table).select('*', { count: 'exact', head: true });
  return count ?? 0;
}

async function countAll() {
  return {
    events: await countRows('event_requests'),
    history: await countRows('event_request_assignment_history'),
    statusHistory: await countRows('event_request_status_history'),
    changeRequests: await countRows('event_change_requests'),
    notifications: await countRows('notifications'),
    profiles: await countRows('profiles'),
  };
}

function describeCounts(c) {
  return `event_requests ${c.events}, history ${c.history}, status history ${c.statusHistory}, `
    + `change requests ${c.changeRequests}, notifications ${c.notifications}, profiles ${c.profiles}`;
}

/** Run one cleanup step, keeping its error rather than dropping it. */
async function remove(label, query) {
  const { error } = await query;
  if (error) cleanupErrors.push(`${label}: ${error.message}`);
}

/**
 * Events this script did not create that name one of its users: a real Lead
 * assigned or handed a real request to a test coordinator while this ran (the
 * second hazard in the header).
 */
async function findForeignEvents() {
  const ids = userIds().join(',');
  if (!ids) return [];

  const { data, error } = await supabase
    .from('event_requests')
    .select('id, event_name, status, assigned_coordinator_id, reviewing_coordinator_id')
    .or(`assigned_coordinator_id.in.(${ids}),reviewing_coordinator_id.in.(${ids}),organiser_id.in.(${ids})`);
  if (error) {
    cleanupErrors.push(`find foreign events: ${error.message}`);
    return [];
  }

  return (data ?? []).filter((row) => !createdEventIds.includes(row.id));
}

/**
 * Put a real request back in the Lead's queue, as it was before a Lead chose
 * a test coordinator for it. Only at submitted: 052's constraint allows no
 * coordinator there and nowhere later, and later would mean work had begun
 * under a test account that is about to vanish, which needs a person.
 */
async function returnToQueue(event) {
  if (event.status !== 'submitted') {
    cleanupErrors.push(
      `real event ${event.id} (${event.event_name}) is ${event.status} and held by a test coordinator; `
        + 'a Lead must hand it to a real coordinator before the test user can be removed',
    );
    return;
  }

  const ids = userIds().join(',');
  await remove(
    `history naming test users on real event ${event.id}`,
    supabase
      .from('event_request_assignment_history')
      .delete()
      .eq('event_request_id', event.id)
      .or(`new_coordinator_id.in.(${ids}),previous_coordinator_id.in.(${ids}),assigned_by.in.(${ids})`),
  );
  await remove(
    `return real event ${event.id} to the Lead's queue`,
    supabase
      .from('event_requests')
      .update({ assigned_coordinator_id: null, reviewing_coordinator_id: null })
      .eq('id', event.id),
  );

  console.log(
    `\n  NOTE: real event "${event.event_name}" (${event.id}) was assigned to a test coordinator `
      + 'while this ran. It is back in the Event Coordinator Lead\'s queue, unassigned.',
  );
  returnedToQueue.push(event.id);
}

async function cleanup() {
  const foreign = await findForeignEvents();

  // The order is the third hazard in the header.
  if (createdEventIds.length > 0) {
    // Every notification about this run's events, including real Leads'.
    await remove(
      'notifications about this run\'s events',
      supabase.from('notifications').delete().in('payload->>eventRequestId', createdEventIds),
    );
    await remove(
      'change requests',
      supabase.from('event_change_requests').delete().in('event_request_id', createdEventIds),
    );
    await remove(
      'status history',
      supabase.from('event_request_status_history').delete().in('event_request_id', createdEventIds),
    );
    await remove(
      'assignment history',
      supabase.from('event_request_assignment_history').delete().in('event_request_id', createdEventIds),
    );
    await remove('event requests', supabase.from('event_requests').delete().in('id', createdEventIds));
  }

  for (const event of foreign) await returnToQueue(event);

  for (const [label, id] of Object.entries(users)) {
    await remove(`profile ${label}`, supabase.from('profiles').delete().eq('id', id));
  }
  for (const [label, id] of Object.entries(users)) {
    await remove(`auth user ${label}`, supabase.auth.admin.deleteUser(id));
  }
}

/**
 * Prove the cleanup, after it has run: this run's rows by id, and every table
 * by count.
 */
async function verifyCleanup() {
  check('cleanup ran without errors', cleanupErrors.length === 0, cleanupErrors.join('; '));

  const ids = userIds();
  const { count: eventsLeft } = await supabase
    .from('event_requests')
    .select('id', { count: 'exact', head: true })
    .like('event_name', `${NAME}%`);

  const byEvent = async (table, column = 'event_request_id') => (createdEventIds.length === 0
    ? 0
    : (await supabase.from(table).select('id', { count: 'exact', head: true }).in(column, createdEventIds)).count);

  const historyLeft = await byEvent('event_request_assignment_history');
  const statusLeft = await byEvent('event_request_status_history');
  const noticesLeft = await byEvent('notifications', 'payload->>eventRequestId');

  const { count: profilesLeft } = ids.length === 0
    ? { count: 0 }
    : await supabase.from('profiles').select('id', { count: 'exact', head: true }).in('id', ids);

  let usersLeft = 0;
  for (const id of ids) {
    const { data } = await supabase.auth.admin.getUserById(id);
    if (data?.user) usersLeft += 1;
  }

  check(
    'nothing of this run is left behind',
    eventsLeft === 0 && historyLeft === 0 && statusLeft === 0 && noticesLeft === 0
      && profilesLeft === 0 && usersLeft === 0,
    `${eventsLeft} event(s), ${historyLeft} history row(s), ${statusLeft} status row(s), `
      + `${noticesLeft} notification(s), ${profilesLeft} profile(s), ${usersLeft} user(s)`,
  );

  if (countsBefore) {
    const after = await countAll();
    console.log(`\n  counts before: ${describeCounts(countsBefore)}`);
    console.log(`  counts after:  ${describeCounts(after)}`);
    // A real event returned to the queue loses its history row(s) naming a
    // test coordinator, so history may end lower than it started; that is
    // reported, not hidden.
    const balanced = after.events === countsBefore.events
      && after.statusHistory === countsBefore.statusHistory
      && after.changeRequests === countsBefore.changeRequests
      && after.notifications === countsBefore.notifications
      && after.profiles === countsBefore.profiles
      && (returnedToQueue.length > 0 || after.history === countsBefore.history);
    // If this fails while the by-id check above passes, this run left nothing
    // of its own: someone else wrote to the shared database while it ran.
    check(
      'every table is back to its starting count',
      balanced,
      balanced
        ? (returnedToQueue.length ? `allowing for ${returnedToQueue.length} real event(s) returned to the queue` : 'no real events touched')
        : 'counts moved: if nothing of this run is left (above), another user wrote during the run',
    );
  }
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

async function main() {
  console.log('\nCoordinator assignment check (the Lead assigns, SCRUM-486)\n');

  countsBefore = await countAll();
  console.log(`  counts before: ${describeCounts(countsBefore)}`);

  await createUser('organiser', 'event_organiser');
  await createUser('L', 'event_coordinator_lead');
  // A second Lead, for the race in section 2 (AC4-05).
  await createUser('L2', 'event_coordinator_lead');
  await createUser('A', 'event_coordinator');
  await createUser('B', 'event_coordinator');
  await createUser('C', 'event_coordinator');
  // Not a coordinator: may not be assigned or handed anything.
  await createUser('V', 'venue_staff');

  // -- 1. Submission assigns nobody (SCRUM-486 AC1, AC2, AC10) ----------------
  section('1. submission assigns nobody; the request waits for the Lead (052)');

  const s1 = await submitDraft('s1');
  check('the request is submitted', s1.status === 'submitted', s1.status);
  check(
    'with no coordinator and no reviewer',
    s1.assignedCoordinatorId === null && s1.reviewingCoordinatorId === null,
    `${labelOf(s1.assignedCoordinatorId)} / ${labelOf(s1.reviewingCoordinatorId)}`,
  );
  check('and no assignment-history row, because nothing was assigned', (await historyOf(s1.id)).length === 0);

  const { count: leads } = await supabase
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'event_coordinator_lead');
  const waiting = (await noticesAbout(s1.id)).filter((n) => n.type === 'event_request_awaiting_assignment');
  check(
    'every Lead is told it is waiting, the test Lead among them',
    waiting.length === leads && waiting.some((n) => n.recipient_id === users.L),
    `${waiting.length} notice(s) for ${leads} Lead(s)`,
  );

  const queue = await listUnassignedEventRequests();
  check('it is in the Lead\'s queue', queue.some((event) => event.id === s1.id));
  check(
    'and not in the coordinators\' shared queue (AC2-06)',
    !(await listEventRequestsForReview()).some((event) => event.id === s1.id),
  );

  // -- 2. The Lead assigns (SCRUM-486 AC3, AC4, AC9, AC10) --------------------
  section('2. the Lead assigns (assign_event_request, 052)');

  // Each refusal first, while the request is still unassigned.
  checkRefusal(
    'a coordinator cannot make the first assignment (42501)',
    await failureFrom(assignEventRequest(s1.id, { coordinatorId: users.B }, users.A)),
    ForbiddenError,
    403,
  );
  checkRefusal(
    'someone who is not an Event Coordinator cannot be assigned (22023)',
    await failureFrom(assignEventRequest(s1.id, { coordinatorId: users.V }, users.L)),
    ValidationError,
    400,
  );
  checkRefusal(
    'nor can a Lead (22023)',
    await failureFrom(assignEventRequest(s1.id, { coordinatorId: users.L }, users.L)),
    ValidationError,
    400,
  );
  check('none of those wrote anything', (await historyOf(s1.id)).length === 0);

  const ASSIGN_NOTE = 'Yours from today.';
  const assigned = await assignEventRequest(s1.id, { coordinatorId: users.A, note: ASSIGN_NOTE }, users.L);
  check('the Lead\'s assignment gives it a coordinator', assigned.assignedCoordinatorId === users.A, labelOf(assigned.assignedCoordinatorId));

  const assignedHistory = await historyOf(s1.id);
  check('one history row', assignedHistory.length === 1, `${assignedHistory.length} row(s)`);
  check(
    'a first assignment, made by the Lead, with the note',
    assignedHistory[0]?.previous_coordinator_id === null
      && assignedHistory[0]?.new_coordinator_id === users.A
      && assignedHistory[0]?.assigned_by === users.L
      && assignedHistory[0]?.handover_note === ASSIGN_NOTE,
    `previous ${labelOf(assignedHistory[0]?.previous_coordinator_id)}, new ${labelOf(assignedHistory[0]?.new_coordinator_id)}, `
      + `by ${labelOf(assignedHistory[0]?.assigned_by)}`,
  );

  const afterAssign = await noticesAbout(s1.id);
  const toCoordinator = afterAssign.find((n) => n.type === 'event_request_assigned');
  const toOrganiser = afterAssign.find((n) => n.type === 'event_request_coordinator_assigned');
  check(
    'the coordinator is told, with the note',
    toCoordinator?.recipient_id === users.A && toCoordinator?.payload?.note === ASSIGN_NOTE,
    toCoordinator ? labelOf(toCoordinator.recipient_id) : 'no notice',
  );
  check(
    'the Organiser is told who, and not the note',
    toOrganiser?.recipient_id === users.organiser
      && toOrganiser?.payload?.coordinatorName === 'Check Assign A'
      && !('note' in (toOrganiser?.payload ?? {})),
    toOrganiser ? JSON.stringify(toOrganiser.payload) : 'no notice',
  );

  const second = await failureFrom(assignEventRequest(s1.id, { coordinatorId: users.B }, users.L));
  checkRefusal('a second assignment is refused (AC4)', second, ConflictError, 409);
  check(
    'and is told who was assigned, as data the screen can show',
    second?.code === 'ALREADY_ASSIGNED' && second?.conflicts?.[0]?.assignedCoordinatorName === 'Check Assign A',
    second ? `${second.code} ${JSON.stringify(second.conflicts)}` : '(no error)',
  );

  check('it has left the Lead\'s queue', !(await listUnassignedEventRequests()).some((event) => event.id === s1.id));
  check('and is in the shared queue now that someone holds it', (await listEventRequestsForReview()).some((event) => event.id === s1.id));

  // AC4-05, the real race. Two Leads assign the same request at once, each
  // through its own HTTP request and so its own Postgres connection, which is
  // the one thing the PGlite suite cannot do (it has one connection; see
  // SCRUM486_AC4_of_two_leads_assigning_at_once_... for what it does prove).
  // What decides here is 052's row lock: the second transaction waits on
  // `for update` until the first commits, then reads the coordinator the
  // first wrote and refuses. Several rounds, because whether the two actually
  // overlap on a given round depends on timing; every round must still end
  // with exactly one winner, one history row, and a loser told who won.
  const ROUNDS = 5;
  for (let round = 1; round <= ROUNDS; round += 1) {
    const raced = await submitDraft(`race_${round}`);
    const outcomes = await Promise.allSettled([
      assignEventRequest(raced.id, { coordinatorId: users.A }, users.L),
      assignEventRequest(raced.id, { coordinatorId: users.B }, users.L2),
    ]);
    const won = outcomes.filter((o) => o.status === 'fulfilled');
    const lost = outcomes.filter((o) => o.status === 'rejected');
    const winner = won[0]?.value?.assignedCoordinatorId;
    const raceHistory = await historyOf(raced.id);

    check(
      `race ${round}: exactly one of two Leads assigning at once wins`,
      won.length === 1 && lost.length === 1,
      `${won.length} won, ${lost.length} lost`,
    );
    check(
      `race ${round}: the other is told who won (ALREADY_ASSIGNED)`,
      lost[0]?.reason instanceof ConflictError
        && lost[0].reason.code === 'ALREADY_ASSIGNED'
        && lost[0].reason.conflicts?.[0]?.assignedCoordinatorId === winner,
      lost[0]?.reason ? `${lost[0].reason.code}: ${lost[0].reason.message}` : 'nothing was refused',
    );
    check(
      `race ${round}: one history row, naming the winner`,
      raceHistory.length === 1 && raceHistory[0].new_coordinator_id === winner,
      `${raceHistory.length} row(s), winner ${labelOf(winner)}`,
    );

    // Out of the active count, so section 6's workload figures are about the
    // events set up for them. A cancelled request may keep its coordinator.
    const { error: cancelError } = await supabase
      .from('event_requests')
      .update({ status: 'cancelled' })
      .eq('id', raced.id);
    if (cancelError) throw new Error(`could not cancel race event ${round}: ${cancelError.message}`);
  }

  // -- 3. The constraint, relaxed (052) ---------------------------------------
  section('3. no coordinator is allowed at submitted, and only there (052)');

  // Straight at the table, bypassing every function, which is the only way to
  // prove the constraint rather than the code in front of it. 017 refused the
  // first of these; 052 allows it, because the request now waits for the Lead.
  const { data: waitingRow, error: waitingError } = await supabase
    .from('event_requests')
    .insert({ organiser_id: users.organiser, event_name: `${NAME}_waiting`, status: 'submitted' })
    .select('id')
    .single();
  if (waitingRow?.id) createdEventIds.push(waitingRow.id);
  check(
    'a submitted event with no coordinator is accepted',
    !waitingError && Boolean(waitingRow?.id),
    waitingError ? `${waitingError.code}: ${waitingError.message}` : 'accepted',
  );

  const { data: orphan, error: orphanError } = await supabase
    .from('event_requests')
    .insert({ organiser_id: users.organiser, event_name: `${NAME}_orphan`, status: 'under_review' })
    .select('id')
    .single();
  if (orphan?.id) createdEventIds.push(orphan.id);
  check(
    'an event under review with no coordinator is refused with 23514',
    orphanError?.code === '23514',
    orphanError ? `${orphanError.code}: ${orphanError.message}` : 'the insert was ACCEPTED',
  );
  check(
    'the refusal names the constraint',
    /event_requests_assigned_when_submitted/.test(orphanError?.message ?? ''),
    orphanError?.message ?? '(no error)',
  );

  // -- 4. Reassignment (SCRUM-327 AC6, and SCRUM-486 AC5, AC6) ----------------
  section('4. reassignment by the holder, and by the Lead (052)');

  // The holder's handover, as SCRUM-327 has it. Before it, s1 is given a
  // reviewer, as if A had started the review; no decision has been made, so
  // the reviewer moves with the event.
  const { error: reviewerError } = await supabase
    .from('event_requests')
    .update({ reviewing_coordinator_id: users.A })
    .eq('id', s1.id);
  if (reviewerError) throw new Error(`could not set the reviewer: ${reviewerError.message}`);

  const NOTE = 'On leave from Monday. The venue shortlist is in my notes.';
  const handedOver = await reassignEventRequest(s1.id, { newCoordinatorId: users.C, handoverNote: NOTE }, users.A);
  check('the holder hands it over', handedOver.assignedCoordinatorId === users.C, labelOf(handedOver.assignedCoordinatorId));
  check(
    'and the reviewer moves with it, because no decision has been made',
    handedOver.reviewingCoordinatorId === users.C,
    labelOf(handedOver.reviewingCoordinatorId),
  );

  const afterHandover = await historyOf(s1.id);
  const handoverRow = afterHandover[afterHandover.length - 1];
  check('the handover added one history row', afterHandover.length === 2, `${afterHandover.length} row(s)`);
  check(
    'naming A as previous and A as the one who made it',
    handoverRow?.previous_coordinator_id === users.A && handoverRow?.assigned_by === users.A,
    `${labelOf(handoverRow?.previous_coordinator_id)}, by ${labelOf(handoverRow?.assigned_by)}`,
  );
  check('with the note', handoverRow?.handover_note === NOTE, handoverRow?.handover_note);

  checkRefusal(
    'the previous coordinator can no longer hand it over (42501)',
    await failureFrom(reassignEventRequest(s1.id, { newCoordinatorId: users.B }, users.A)),
    ForbiddenError,
    403,
  );
  checkRefusal(
    'a new coordinator without the role is refused (22023)',
    await failureFrom(reassignEventRequest(s1.id, { newCoordinatorId: users.V }, users.C)),
    ValidationError,
    400,
  );
  const toSelf = await failureFrom(reassignEventRequest(s1.id, { newCoordinatorId: users.C }, users.C));
  checkRefusal('handing it to the current holder is refused (23514)', toSelf, ValidationError, 400);
  check(
    'and the message is the function\'s own, not the history constraint\'s',
    /already assigned to that coordinator/.test(toSelf?.message ?? ''),
    toSelf?.message,
  );

  // A cancelled event cannot be handed over. Held by B, so B's caller check
  // passes and only the status is in question.
  const cancelled = await insertEvent('cancelled_held', { status: 'cancelled', coordinator: users.B });
  checkRefusal(
    'a status outside the ones AC5 allows is refused (55000)',
    await failureFrom(reassignEventRequest(cancelled, { newCoordinatorId: users.A }, users.B)),
    ConflictError,
    409,
  );

  // A null caller, straight at the function, on an event nobody holds. 052
  // keeps 018's explicit null check ahead of everything, so the code says the
  // caller was refused (42501), not the missing coordinator (55000).
  const unheld = await insertEvent('cancelled_unheld', { status: 'cancelled', coordinator: null });
  const { error: nullCallerError } = await supabase.rpc('reassign_event_request', {
    p_event_request_id: unheld,
    p_new_coordinator_id: users.C,
    p_assigned_by: null,
    p_handover_note: null,
  });
  check(
    'a null caller is refused as the caller (42501), even on an event nobody holds',
    nullCallerError?.code === '42501',
    nullCallerError ? `${nullCallerError.code}: ${nullCallerError.message}` : 'the call was ACCEPTED',
  );

  // SCRUM-486 AC6: the Lead, who does not hold it, hands it from C to B.
  const LEAD_NOTE = 'C is moving to the Open Day team.';
  const leadMoved = await reassignEventRequest(s1.id, { newCoordinatorId: users.B, handoverNote: LEAD_NOTE }, users.L);
  check('the Lead, who does not hold it, hands it over', leadMoved.assignedCoordinatorId === users.B, labelOf(leadMoved.assignedCoordinatorId));
  const leadRow = (await historyOf(s1.id)).at(-1);
  check(
    'the history names C as previous and the Lead as the one who made it',
    leadRow?.previous_coordinator_id === users.C && leadRow?.new_coordinator_id === users.B && leadRow?.assigned_by === users.L,
    `${labelOf(leadRow?.previous_coordinator_id)} -> ${labelOf(leadRow?.new_coordinator_id)}, by ${labelOf(leadRow?.assigned_by)}`,
  );
  checkRefusal(
    'and C, whose event the Lead moved, can no longer hand it over (42501)',
    await failureFrom(reassignEventRequest(s1.id, { newCoordinatorId: users.A }, users.C)),
    ForbiddenError,
    403,
  );

  // AC5-05: a request nobody holds is assigned, not reassigned, even by a Lead.
  checkRefusal(
    'an unassigned request cannot be reassigned, even by the Lead (55000)',
    await failureFrom(reassignEventRequest(waitingRow.id, { newCoordinatorId: users.A }, users.L)),
    ConflictError,
    409,
  );

  const afterRefusals = await historyOf(s1.id);
  const { data: s1Row } = await supabase
    .from('event_requests')
    .select('assigned_coordinator_id')
    .eq('id', s1.id)
    .single();
  check(
    'none of the refusals wrote anything',
    afterRefusals.length === 3 && s1Row?.assigned_coordinator_id === users.B,
    `${afterRefusals.length} history row(s), held by ${labelOf(s1Row?.assigned_coordinator_id)}`,
  );

  // -- 5. Permissions (SCRUM-332, SCRUM-486 AC7) ------------------------------
  section('5. only the holder changes an event; any coordinator reads it');

  checkRefusal(
    'clarification by a coordinator who no longer holds it is refused',
    await failureFrom(requestEventClarification(s1.id, 'Please confirm numbers.', users.C)),
    ForbiddenError,
    403,
  );
  checkRefusal(
    'clarification on a request nobody holds is refused as waiting for the Lead, not as someone else\'s (409)',
    await failureFrom(requestEventClarification(waitingRow.id, 'Please confirm numbers.', users.A)),
    ConflictError,
    409,
  );

  const change = await createChangeRequest(
    { eventRequestId: s1.id, changeField: 'venue', requestedChange: 'A larger room.' },
    users.organiser,
  );
  checkRefusal(
    'a change request decision by a coordinator who does not hold the event is refused (019, 42501)',
    await failureFrom(processChangeRequest(change.id, { decision: 'approved' }, users.C)),
    ForbiddenError,
    403,
  );
  const decided = await processChangeRequest(change.id, { decision: 'approved' }, users.B);
  check(
    'the holder the Lead chose can decide it',
    decided.status === 'processed' && decided.processedBy === users.B,
    `${decided.status}, by ${labelOf(decided.processedBy)}`,
  );

  // Clarification is asked only under review. Before SCRUM-19 removed the
  // auto-start, asking on a submitted request started the review as a side
  // effect, and the version of this script before SCRUM-522 relied on that;
  // now the holder starts the review first, as on the screen.
  const started = await startEventReview(s1.id, users.B);
  check('the holder the Lead chose can start the review', started.status === 'under_review' && started.reviewingCoordinatorId === users.B, started.status);
  const clarified = await requestEventClarification(s1.id, 'Please confirm numbers.', users.B);
  check('and can request clarification', clarified.status === 'pending_clarification', clarified.status);

  const readCancelled = await getEventRequestForCoordinator(cancelled);
  check(
    'any coordinator can read an event the queue does not carry (cancelled)',
    readCancelled.id === cancelled && readCancelled.status === 'cancelled',
    readCancelled.status,
  );

  const draft = await createEventRequest({ eventName: `${NAME}_draft` }, users.organiser);
  createdEventIds.push(draft.id);
  const draftRead = await failureFrom(getEventRequestForCoordinator(draft.id));
  const missingRead = await failureFrom(getEventRequestForCoordinator('00000000-0000-4000-8000-000000000000'));
  check(
    'a draft is hidden from coordinators, answered exactly like a missing id',
    draftRead instanceof NotFoundError
      && draftRead.message.replace(draft.id, '<id>')
        === missingRead?.message.replace('00000000-0000-4000-8000-000000000000', '<id>'),
    `${draftRead?.name}: ${draftRead?.message}`,
  );

  // -- 6. The reads (SCRUM-333, SCRUM-334, SCRUM-486 AC3, AC9) -----------------
  section('6. "My events", the history, and both coordinator lists');

  const mine = await listEventRequestsForCoordinator(users.B);
  check(
    'My events holds only events assigned to that coordinator',
    mine.length > 0 && mine.every((event) => event.assignedCoordinatorId === users.B),
    `${mine.length} event(s)`,
  );
  check(
    'including the one the Lead handed them, and a cancelled one',
    mine.some((event) => event.id === s1.id) && mine.some((event) => event.id === cancelled),
  );
  const ownRow = mine.find((event) => event.id === s1.id);
  check('each row carries the organiser\'s name', ownRow?.organiserName === 'Check Assign organiser', ownRow?.organiserName);

  const forCoordinators = await listAssignmentHistory(s1.id, { includeNotes: true });
  check(
    'the history is oldest first: the Lead\'s assignment, A\'s handover, the Lead\'s handover',
    forCoordinators.map((entry) => entry.assignedByName).join(' | ')
      === 'Check Assign L | Check Assign A | Check Assign L',
    forCoordinators.map((entry) => entry.assignedByName).join(' | '),
  );
  check(
    'no row of the new model reads as automatic',
    forCoordinators.every((entry) => entry.automatic === false),
  );
  check(
    'the coordinators\' view carries the notes',
    forCoordinators.map((entry) => entry.handoverNote).join(' | ') === `${ASSIGN_NOTE} | ${NOTE} | ${LEAD_NOTE}`,
  );
  const forOrganiser = await listAssignmentHistory(s1.id, { includeNotes: false });
  check(
    'the Organiser\'s view has no handoverNote key at all',
    forOrganiser.length === 3 && forOrganiser.every((entry) => !('handoverNote' in entry)),
    `${forOrganiser.length} entr(ies)`,
  );

  // AC9-03. Events assigned before SCRUM-486 have a history row with
  // assigned_by null, written by 016 on submission. Those rows are in the live
  // data beside the Lead's, so the label must still read them as automatic.
  // One such row is made here, in 016's exact shape.
  const legacy = await insertEvent('legacy_automatic', { status: 'submitted', coordinator: users.A });
  const { error: legacyError } = await supabase.from('event_request_assignment_history').insert({
    event_request_id: legacy,
    previous_coordinator_id: null,
    new_coordinator_id: users.A,
    assigned_by: null,
  });
  if (legacyError) throw new Error(`could not insert the legacy history row: ${legacyError.message}`);
  const legacyHistory = await listAssignmentHistory(legacy, { includeNotes: true });
  check(
    'a pre-SCRUM-486 row still reads as automatic, with no one named (AC9-03)',
    legacyHistory.length === 1 && legacyHistory[0].automatic === true && legacyHistory[0].assignedByName === null,
    JSON.stringify(legacyHistory[0]),
  );

  const pickerIds = (await listCoordinators()).map((coordinator) => coordinator.id);
  check(
    'the coordinators\' handover list holds coordinators and nobody else',
    [users.A, users.B, users.C].every((id) => pickerIds.includes(id))
      && ![users.V, users.organiser, users.L].some((id) => pickerIds.includes(id)),
  );

  const workload = await listCoordinatorWorkload();
  const workloadOf = (id) => workload.find((coordinator) => coordinator.id === id)?.activeEvents;
  check(
    'the Lead\'s picker lists coordinators only, never a Lead (AC3)',
    [users.A, users.B, users.C].every((id) => workload.some((c) => c.id === id))
      && ![users.V, users.organiser, users.L].some((id) => workload.some((c) => c.id === id)),
  );
  check(
    'with each one\'s active events: A the legacy request, B the handed-over one, C none',
    workloadOf(users.A) === 1 && workloadOf(users.B) === 1 && workloadOf(users.C) === 0,
    `A ${workloadOf(users.A)}, B ${workloadOf(users.B)}, C ${workloadOf(users.C)}`,
  );
}

/** A test user's label for a uuid, so failures read as "A" rather than a uuid. */
function labelOf(id) {
  if (!id) return String(id);
  const entry = Object.entries(users).find(([, value]) => value === id);
  return entry ? entry[0] : `a real user ${id}`;
}

main()
  .catch((err) => {
    console.error(`\nFailed: ${err.message}`);
    failures += 1;
  })
  .finally(async () => {
    await cleanup();
    await verifyCleanup();
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed.\n`);
      process.exit(1);
    }
    console.log('\nAll checks passed. Submitted, assigned by the Lead, refused, handed over, read, cleaned up.\n');
  });
