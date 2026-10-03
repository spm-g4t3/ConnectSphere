/**
 * End-to-end proof for coordinator assignment (SCRUM-327, checked by SCRUM-335).
 *
 * Run with: npm run assignment:check
 *
 * The unit suite has over a thousand tests, every one against a fake client.
 * They prove the services call the right Postgres function with the right
 * arguments and turn each SQLSTATE into the right error. They cannot prove
 * what the functions themselves do, because a fake returns whatever it was
 * given. This script is the other half: it runs the real functions from 015,
 * 016, 017, 018 and 019 against the real database, through the real services.
 *
 *   1. The selection rule (015): fewest active events, then longest without a
 *      new assignment, then never assigned first, coordinators only.
 *   2. Assign on submission (016): one coordinator, one history row.
 *   3. The constraint (017): nothing past draft without a coordinator.
 *   4. Reassignment (018): a handover, the reviewer following it, and each
 *      refusal by its SQLSTATE.
 *   5. Permissions (SCRUM-332, 019): only the assigned coordinator changes an
 *      event; any coordinator reads it.
 *   6. The reads (SCRUM-333, SCRUM-334): "My events" and the history.
 *
 * It creates its own users: four coordinators, one Organiser, and one Venue
 * Staff member who is the perfect candidate in every way except their role.
 * It removes them, and everything they touched, at the end. Cleanup is checked
 * like any other step: every delete's error is kept, and the last checks count
 * what is left.
 *
 * TWO HAZARDS, both handled below rather than hoped away:
 *
 *  - The coordinators created here are real candidates for a real submission.
 *    pick_event_coordinator ranks every profile with the role, and to test the
 *    rule these coordinators are deliberately made the best candidates in turn.
 *    If an Organiser submits a genuine request while this runs, it may be
 *    assigned to one of them. cleanup() looks for any event it did not create
 *    that names one of its users, and re-homes it: it removes the history row
 *    naming the test coordinator, asks pick_event_coordinator again once the
 *    test profiles are gone, and records the assignment the event should have
 *    had. It says so loudly. Without this the test user could not be deleted,
 *    because every coordinator column is ON DELETE RESTRICT, and the real event
 *    would be left held by an account that is about to vanish.
 *
 *  - Every event submitted here gets a history row, and history's
 *    event_request_id is ON DELETE RESTRICT (014), as are new_coordinator_id
 *    and assigned_by. So the delete order is fixed: change requests, then
 *    history, then events, then users. In the other order the first delete is
 *    refused and everything after it is left behind.
 *
 * And one precondition. The rule compares these coordinators with the real
 * ones. A real coordinator with no active events and no assignment history
 * would tie with or beat the test's intended winner, and then the checks
 * would be measuring the live data, not the rule. preconditionHolds() checks
 * for one first and, if it finds one, skips the selection checks with a
 * failure that says why, rather than reporting a result it cannot stand
 * behind.
 *
 * Exits non-zero on any failure.
 */

import { supabase } from '../src/config/supabaseClient.js';
import {
  createEventRequest,
  submitEventRequest,
  reassignEventRequest,
  requestEventClarification,
  getEventRequestForCoordinator,
  listEventRequestsForCoordinator,
  listAssignmentHistory,
  listCoordinators,
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

// The statuses 015 counts as active. Repeated here only to set up and describe
// fixtures, never to decide anything the function decides.
const ACTIVE = ['submitted', 'under_review', 'pending_clarification', 'approved', 'planning', 'confirmed'];

// Fixed instants for the history rows that set up the tie-break. Far in the
// past on purpose: older than any real assignment, so a real coordinator's
// history can never be older than the one the test intends to win.
const LONG_AGO = {
  first: '2000-01-01T00:00:00Z',
  second: '2000-01-02T00:00:00Z',
  third: '2000-01-03T00:00:00Z',
};

// Everything created, tracked the moment it exists, so cleanup can find it
// whatever fails afterwards.
const users = {};            // label -> id
const createdEventIds = [];
let countsBefore = null;
let rehomed = [];
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
 * req.user.id. The full_name is what organiserName and the history's names
 * are checked against.
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

/**
 * An event inserted directly, already assigned, to give a coordinator a known
 * workload. These are fixtures for the rule, not tests of submission, so they
 * skip submit_event_request on purpose: the rule must be measured against
 * workloads the script chose, not ones the rule itself produced.
 */
async function insertEvent(label, { status, coordinator, proposedStart = null }) {
  const { data, error } = await supabase
    .from('event_requests')
    .insert({
      organiser_id: users.organiser,
      event_name: `${NAME}_${label}`,
      status,
      assigned_coordinator_id: coordinator,
      proposed_start: proposedStart,
    })
    .select('id')
    .single();
  if (error) throw new Error(`could not insert event ${label}: ${error.message}`);
  createdEventIds.push(data.id);
  return data.id;
}

/**
 * A history row with a chosen created_at, which is the only way to set up a
 * tie-break deterministically: 015's step 3 reads max(created_at) per
 * coordinator, and real assignments made a moment apart are too close to
 * reason about.
 */
async function insertHistory(eventId, coordinator, createdAt) {
  const { error } = await supabase
    .from('event_request_assignment_history')
    .insert({
      event_request_id: eventId,
      previous_coordinator_id: null,
      new_coordinator_id: coordinator,
      assigned_by: null,
      created_at: createdAt,
    });
  if (error) throw new Error(`could not insert history: ${error.message}`);
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
  return submitEventRequest(draft.id);
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

async function setStatus(eventId, status) {
  const { error } = await supabase.from('event_requests').update({ status }).eq('id', eventId);
  if (error) throw new Error(`could not set status: ${error.message}`);
}

/**
 * Is there a real coordinator who would beat the test's intended winners?
 *
 * The intended winners always have no active events, and either no history or
 * history from 2000-01-01 to 2000-01-03. A real coordinator with no active
 * events and no history, or history at least that old, would tie with or beat
 * them, and the result would depend on the live data and on uuid order. Any
 * real coordinator with at least one active event, or with an assignment since
 * 2000-01-03, cannot.
 */
async function preconditionHolds() {
  const { data: real, error } = await supabase
    .from('profiles')
    .select('id, full_name')
    .eq('role', 'event_coordinator')
    .not('id', 'in', `(${userIds().join(',')})`);
  if (error) throw new Error(`could not read coordinators: ${error.message}`);

  const blockers = [];
  for (const coordinator of real ?? []) {
    const { count: active } = await supabase
      .from('event_requests')
      .select('id', { count: 'exact', head: true })
      .eq('assigned_coordinator_id', coordinator.id)
      .in('status', ACTIVE);

    const { data: latest } = await supabase
      .from('event_request_assignment_history')
      .select('created_at')
      .eq('new_coordinator_id', coordinator.id)
      .order('created_at', { ascending: false })
      .limit(1);

    const lastAssigned = latest?.[0]?.created_at ?? null;
    const tooOld = lastAssigned === null || new Date(lastAssigned) <= new Date(LONG_AGO.third);
    if ((active ?? 0) === 0 && tooOld) blockers.push(coordinator.full_name ?? coordinator.id);
  }

  console.log(`  real coordinators: ${(real ?? []).length}, none idle and never assigned: ${blockers.length === 0}`);
  return blockers;
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
    changeRequests: await countRows('event_change_requests'),
    profiles: await countRows('profiles'),
  };
}

/** Run one cleanup step, keeping its error rather than dropping it. */
async function remove(label, query) {
  const { error } = await query;
  if (error) cleanupErrors.push(`${label}: ${error.message}`);
}

/**
 * Events this script did not create that name one of its users.
 *
 * The first hazard in the header. Only possible if a real Organiser submitted
 * while this ran and the rule chose a test coordinator, or a real coordinator
 * handed something to one. Looked for on every coordinator column, and on
 * organiser_id too, though nothing outside this script uses the test
 * Organiser.
 */
async function findForeignEvents() {
  const ids = userIds().join(',');
  if (!ids) return [];

  const { data, error } = await supabase
    .from('event_requests')
    .select('id, event_name, assigned_coordinator_id, reviewing_coordinator_id')
    .or(`assigned_coordinator_id.in.(${ids}),reviewing_coordinator_id.in.(${ids}),organiser_id.in.(${ids})`);
  if (error) {
    cleanupErrors.push(`find foreign events: ${error.message}`);
    return [];
  }

  return (data ?? []).filter((row) => !createdEventIds.includes(row.id));
}

/**
 * Give a real event back to a real coordinator.
 *
 * Runs after the test profiles are deleted, so pick_event_coordinator can only
 * choose among real coordinators. The history row naming the test coordinator
 * is removed and replaced with the automatic assignment the event should have
 * had, so its history still starts with exactly one system row. The update and
 * the insert are two requests, not one transaction; this is a recovery path
 * for a rare collision, and it reports every step it could not complete.
 */
async function rehome(event) {
  const ids = userIds().join(',');

  await remove(
    `history naming test users on real event ${event.id}`,
    supabase
      .from('event_request_assignment_history')
      .delete()
      .eq('event_request_id', event.id)
      .or(`new_coordinator_id.in.(${ids}),previous_coordinator_id.in.(${ids}),assigned_by.in.(${ids})`),
  );

  const { data: chosen, error: pickError } = await supabase
    .rpc('pick_event_coordinator', { p_event_request_id: event.id });
  if (pickError || !chosen) {
    cleanupErrors.push(
      `real event ${event.id} (${event.event_name}) is held by a test coordinator and no real `
        + `coordinator could be chosen for it${pickError ? `: ${pickError.message}` : ''}`,
    );
    return;
  }

  const reviewerWasTest = userIds().includes(event.reviewing_coordinator_id);
  await remove(
    `re-assign real event ${event.id}`,
    supabase
      .from('event_requests')
      .update({
        assigned_coordinator_id: chosen,
        ...(reviewerWasTest ? { reviewing_coordinator_id: null } : {}),
      })
      .eq('id', event.id),
  );
  await remove(
    `history for re-assigned real event ${event.id}`,
    supabase.from('event_request_assignment_history').insert({
      event_request_id: event.id,
      previous_coordinator_id: null,
      new_coordinator_id: chosen,
      assigned_by: null,
    }),
  );

  console.log(
    `\n  NOTE: real event "${event.event_name}" (${event.id}) was assigned to a test coordinator `
      + `while this ran. It has been re-assigned to ${chosen} and its history row replaced.`,
  );
  rehomed.push(event.id);
}

async function cleanup() {
  const foreign = await findForeignEvents();

  // The order is the second hazard in the header: change requests, history and
  // events before users, because each references the next.
  if (createdEventIds.length > 0) {
    await remove(
      'change requests',
      supabase.from('event_change_requests').delete().in('event_request_id', createdEventIds),
    );
    await remove(
      'assignment history',
      supabase.from('event_request_assignment_history').delete().in('event_request_id', createdEventIds),
    );
    await remove('event requests', supabase.from('event_requests').delete().in('id', createdEventIds));
  }

  // Profiles before the re-home, so the rule cannot choose a test coordinator
  // again, and before the auth users, so a failure shows as its own error.
  for (const [label, id] of Object.entries(users)) {
    await remove(`profile ${label}`, supabase.from('profiles').delete().eq('id', id));
  }

  for (const event of foreign) await rehome(event);

  for (const [label, id] of Object.entries(users)) {
    await remove(`auth user ${label}`, supabase.auth.admin.deleteUser(id));
  }
}

/**
 * Prove the cleanup, after it has run: this run's rows by id, and every table
 * by count.
 *
 * The by-id check is the strict one: none of this run's events, history,
 * change requests, profiles or users remain. The counts are the wider net, in
 * case something was created that was never tracked. They allow for real
 * events re-homed above, each of which is a real event and a real history row
 * that rightly stay.
 */
async function verifyCleanup() {
  check('cleanup ran without errors', cleanupErrors.length === 0, cleanupErrors.join('; '));

  const ids = userIds();
  const { count: eventsLeft } = await supabase
    .from('event_requests')
    .select('id', { count: 'exact', head: true })
    .like('event_name', `${NAME}%`);

  const { count: historyLeft } = createdEventIds.length === 0
    ? { count: 0 }
    : await supabase
      .from('event_request_assignment_history')
      .select('id', { count: 'exact', head: true })
      .in('event_request_id', createdEventIds);

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
    eventsLeft === 0 && historyLeft === 0 && profilesLeft === 0 && usersLeft === 0,
    `${eventsLeft} event(s), ${historyLeft} history row(s), ${profilesLeft} profile(s), ${usersLeft} user(s)`,
  );

  if (countsBefore) {
    const after = await countAll();
    const extra = rehomed.length;
    console.log(
      `\n  counts before -> after:  event_requests ${countsBefore.events} -> ${after.events}, `
        + `history ${countsBefore.history} -> ${after.history}, `
        + `change requests ${countsBefore.changeRequests} -> ${after.changeRequests}, `
        + `profiles ${countsBefore.profiles} -> ${after.profiles}`,
    );
    // If this fails while the by-id check above passes, this run left nothing of
    // its own: someone else wrote to the shared database while it ran. The
    // detail says so, so the failure is not read as a leak.
    const balanced = after.events === countsBefore.events + extra
      && after.history === countsBefore.history + extra
      && after.changeRequests === countsBefore.changeRequests
      && after.profiles === countsBefore.profiles;
    check(
      'every table is back to its starting count',
      balanced,
      balanced
        ? (extra ? `allowing for ${extra} real event(s) re-homed` : 'no real events touched')
        : 'counts moved: if nothing of this run is left (above), another user wrote during the run',
    );
  }
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

async function main() {
  console.log('\nCoordinator assignment check\n');

  countsBefore = await countAll();
  console.log(
    `  counts before: event_requests ${countsBefore.events}, history ${countsBefore.history}, `
      + `change requests ${countsBefore.changeRequests}, profiles ${countsBefore.profiles}`,
  );

  await createUser('organiser', 'event_organiser');
  await createUser('A', 'event_coordinator');
  await createUser('B', 'event_coordinator');
  await createUser('C', 'event_coordinator');

  // Not a coordinator, and otherwise the ideal candidate: no events and no
  // history, so on every key the rule ranks by, V would come first. If the role
  // filter were missing, V would win the very first submission.
  await createUser('V', 'venue_staff');

  // -- 1. The selection rule (SCRUM-329, AC2-4) ------------------------------
  section('1. the selection rule (015)');

  const blockers = await preconditionHolds();
  let s1 = null;
  let s2 = null;
  let s3 = null;

  if (blockers.length > 0) {
    check(
      'precondition: no real coordinator is idle and never assigned',
      false,
      `${blockers.join(', ')} would compete with the test coordinators, so the rule cannot be `
        + 'isolated from the live data. Selection checks skipped.',
    );
  } else {
    // Workloads, chosen so each step can only pass for the right reason:
    //   A: no active events, last assigned 2000-01-03 (most recent of the three)
    //   B: one active event,  last assigned 2000-01-01 (the oldest)
    //   C: two active events, last assigned 2000-01-02
    // A wins only if active count comes before the time since last assignment.
    // Ranked by time alone, B would win.
    const aCancelled = await insertEvent('a_cancelled', { status: 'cancelled', coordinator: users.A });
    await insertHistory(aCancelled, users.A, LONG_AGO.third);

    const bActive = await insertEvent('b_active', { status: 'submitted', coordinator: users.B });
    await insertHistory(bActive, users.B, LONG_AGO.first);

    // C's two keep a proposed start, one dated and one not, for the ordering
    // check on "My events" in section 6.
    const cFirst = await insertEvent('c_dated', {
      status: 'submitted',
      coordinator: users.C,
      proposedStart: new Date(Date.now() + 10 * DAY).toISOString(),
    });
    const cSecond = await insertEvent('c_undated', { status: 'under_review', coordinator: users.C });
    await insertHistory(cFirst, users.C, LONG_AGO.second);

    s1 = await submitDraft('s1');
    check(
      'fewest active events wins, ahead of who waited longest',
      s1.assignedCoordinatorId === users.A,
      `went to ${labelOf(s1.assignedCoordinatorId)}; expected A (0 active), not B (oldest)`,
    );
    check(
      'a non-coordinator is never chosen, though best on every other key',
      s1.assignedCoordinatorId !== users.V,
      `went to ${labelOf(s1.assignedCoordinatorId)}`,
    );

    // Now a tie on active events. B and C drop to none; A has one (s1).
    //   B: last assigned 2000-01-01, C: last assigned 2000-01-02
    // The one waiting longest since their last new assignment wins: B.
    await setStatus(bActive, 'cancelled');
    await setStatus(cFirst, 'cancelled');
    await setStatus(cSecond, 'cancelled');

    s2 = await submitDraft('s2');
    check(
      'on a tie, the coordinator longest without a new assignment wins',
      s2.assignedCoordinatorId === users.B,
      `went to ${labelOf(s2.assignedCoordinatorId)}; expected B (2000-01-01), not C (2000-01-02)`,
    );

    // A coordinator who has never been assigned anything, against C, who has
    // no active events and was last assigned in 2000. Never beats any date:
    // 015 sorts that null first. With nulls last, C would win.
    //
    // Created only now, because from the moment it exists it is the best
    // candidate there is, for this script's submissions and anyone else's.
    await createUser('D', 'event_coordinator');
    s3 = await submitDraft('s3');
    check(
      'a coordinator never assigned anything sorts first',
      s3.assignedCoordinatorId === users.D,
      `went to ${labelOf(s3.assignedCoordinatorId)}; expected D (no history), not C (2000-01-02)`,
    );

    const { count: vEvents } = await supabase
      .from('event_requests')
      .select('id', { count: 'exact', head: true })
      .eq('assigned_coordinator_id', users.V);
    const { count: vHistory } = await supabase
      .from('event_request_assignment_history')
      .select('id', { count: 'exact', head: true })
      .eq('new_coordinator_id', users.V);
    check(
      'across all three submissions, the Venue Staff member received nothing',
      vEvents === 0 && vHistory === 0,
      `${vEvents} event(s), ${vHistory} history row(s)`,
    );
  }

  // Sections 2 to 6 need s1. If the selection checks were skipped, submit one
  // anyway: whoever the rule picks, the remaining checks use that coordinator.
  if (!s1) s1 = await submitDraft('s1');
  const holder = s1.assignedCoordinatorId;

  // -- 2. Assign on submission (SCRUM-330, AC1) ------------------------------
  section('2. assign on submission (016)');

  const s1History = await historyOf(s1.id);
  check('the submission wrote exactly one history row', s1History.length === 1, `${s1History.length} row(s)`);
  check(
    'the event and its history name the same coordinator',
    s1History[0]?.new_coordinator_id === holder,
    `${labelOf(s1History[0]?.new_coordinator_id)} / ${labelOf(holder)}`,
  );
  check(
    'it is a first assignment: no previous coordinator',
    s1History[0]?.previous_coordinator_id === null,
    String(s1History[0]?.previous_coordinator_id),
  );
  check(
    'made by the system: assigned_by is null',
    s1History[0]?.assigned_by === null,
    String(s1History[0]?.assigned_by),
  );
  check(
    'submitted_at and the history row created_at both exist',
    Boolean(s1.submittedAt) && Boolean(s1History[0]?.created_at),
    `${s1.submittedAt} / ${s1History[0]?.created_at}`,
  );

  // -- 3. The constraint (017) -----------------------------------------------
  section('3. no event past draft without a coordinator (017)');

  // Straight at the table, bypassing every function, which is the only way to
  // prove the constraint rather than the code in front of it.
  const { data: orphan, error: orphanError } = await supabase
    .from('event_requests')
    .insert({ organiser_id: users.organiser, event_name: `${NAME}_orphan`, status: 'submitted' })
    .select('id')
    .single();
  if (orphan?.id) createdEventIds.push(orphan.id);
  check(
    'a submitted event with no coordinator is refused with 23514',
    orphanError?.code === '23514',
    orphanError ? `${orphanError.code}: ${orphanError.message}` : 'the insert was ACCEPTED',
  );
  check(
    'the refusal names 017\'s constraint',
    /event_requests_assigned_when_submitted/.test(orphanError?.message ?? ''),
    orphanError?.message ?? '(no error)',
  );

  // -- 4. Reassignment (SCRUM-331, AC6, AC7, AC9) ----------------------------
  section('4. reassignment (018)');

  // The handover goes to C, who holds nothing active. Before it, s1 is given a
  // reviewer: the outgoing coordinator, as if they had started the review.
  // No decision has been made, so 018 must move the reviewer with the event.
  const receiver = holder === users.C ? users.B : users.C;
  const { error: reviewerError } = await supabase
    .from('event_requests')
    .update({ reviewing_coordinator_id: holder })
    .eq('id', s1.id);
  if (reviewerError) throw new Error(`could not set the reviewer: ${reviewerError.message}`);

  const NOTE = 'On leave from Monday. The venue shortlist is in my notes.';
  const handedOver = await reassignEventRequest(
    s1.id,
    { newCoordinatorId: receiver, handoverNote: NOTE },
    holder,
  );
  check(
    'a valid handover moves the event',
    handedOver.assignedCoordinatorId === receiver,
    labelOf(handedOver.assignedCoordinatorId),
  );
  check(
    'and the reviewer moves with it, because no decision has been made',
    handedOver.reviewingCoordinatorId === receiver,
    labelOf(handedOver.reviewingCoordinatorId),
  );

  const afterHandover = await historyOf(s1.id);
  const handoverRow = afterHandover[afterHandover.length - 1];
  check('the handover added one history row', afterHandover.length === 2, `${afterHandover.length} row(s)`);
  check(
    'naming the outgoing coordinator as previous',
    handoverRow?.previous_coordinator_id === holder,
    labelOf(handoverRow?.previous_coordinator_id),
  );
  check(
    'and a real person as assigned_by, not the system',
    handoverRow?.assigned_by === holder,
    labelOf(handoverRow?.assigned_by),
  );
  check('with the note', handoverRow?.handover_note === NOTE, handoverRow?.handover_note);

  // Each refusal, against the event as the handover left it.
  checkRefusal(
    'the previous coordinator can no longer hand it over (42501)',
    await failureFrom(reassignEventRequest(s1.id, { newCoordinatorId: users.A === holder ? users.B : users.A }, holder)),
    ForbiddenError,
    403,
  );
  checkRefusal(
    'a new coordinator without the role is refused (22023)',
    await failureFrom(reassignEventRequest(s1.id, { newCoordinatorId: users.V }, receiver)),
    ValidationError,
    400,
  );
  const toSelf = await failureFrom(reassignEventRequest(s1.id, { newCoordinatorId: receiver }, receiver));
  checkRefusal('handing it to the current holder is refused (23514)', toSelf, ValidationError, 400);
  check(
    'and the message is 018\'s own, not the history constraint\'s',
    /already assigned to that coordinator/.test(toSelf?.message ?? ''),
    toSelf?.message,
  );

  // A cancelled event cannot be handed over. Inserted here, held by the
  // receiver, so the caller check passes and only the status is in question.
  const cancelled = await insertEvent('cancelled_held', { status: 'cancelled', coordinator: receiver });
  checkRefusal(
    'a status outside the five AC6 allows is refused (55000)',
    await failureFrom(reassignEventRequest(cancelled, { newCoordinatorId: holder }, receiver)),
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
    afterRefusals.length === 2 && s1Row?.assigned_coordinator_id === receiver,
    `${afterRefusals.length} history row(s), held by ${labelOf(s1Row?.assigned_coordinator_id)}`,
  );

  // -- 5. Permissions (SCRUM-332, AC7) ---------------------------------------
  section('5. only the assigned coordinator changes an event (SCRUM-332, 019)');

  checkRefusal(
    'clarification by a coordinator who does not hold the event is refused',
    await failureFrom(requestEventClarification(s1.id, 'Please confirm numbers.', holder)),
    ForbiddenError,
    403,
  );

  const change = await createChangeRequest(
    { eventRequestId: s1.id, changeField: 'venue', requestedChange: 'A larger room.' },
    users.organiser,
  );
  checkRefusal(
    'a change request decision by a coordinator who does not hold the event is refused (019, 42501)',
    await failureFrom(processChangeRequest(change.id, { decision: 'approved' }, holder)),
    ForbiddenError,
    403,
  );

  const { data: stillOpen } = await supabase
    .from('event_change_requests')
    .select('status')
    .eq('id', change.id)
    .single();
  check('and the change request is still open', stillOpen?.status === 'outstanding', stillOpen?.status);

  const decided = await processChangeRequest(change.id, { decision: 'approved' }, receiver);
  check(
    'the assigned coordinator can decide it',
    decided.status === 'processed' && decided.processedBy === receiver,
    `${decided.status}, by ${labelOf(decided.processedBy)}`,
  );

  // The positive path of the clarification guard: the update now filters on
  // assigned_coordinator_id, and this proves PostgREST accepts that filter and
  // the row matches it.
  const clarified = await requestEventClarification(s1.id, 'Please confirm numbers.', receiver);
  check(
    'the assigned coordinator can request clarification',
    clarified.status === 'pending_clarification',
    clarified.status,
  );

  // getEventRequestForCoordinator takes no caller at all: any coordinator may
  // read any event past draft, and the route's role gate is the only proof
  // needed. So "a coordinator who does not hold it can read it" is proved by
  // the read succeeding with no caller, for an event the queue does not carry.
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

  // -- 6. The reads (SCRUM-333, SCRUM-334) -----------------------------------
  section('6. "My events" and the history (SCRUM-333, SCRUM-334)');

  const mine = await listEventRequestsForCoordinator(receiver);
  check(
    'My events holds only events assigned to that coordinator',
    mine.length > 0 && mine.every((event) => event.assignedCoordinatorId === receiver),
    `${mine.length} event(s)`,
  );
  check(
    'including the one just handed to them, and a cancelled one',
    mine.some((event) => event.id === s1.id) && mine.some((event) => event.id === cancelled),
  );

  // Ordered by proposed_start, soonest first, undated last. Asserted as a
  // monotonic sequence over the whole list, with null as +Infinity, so a real
  // event on this coordinator could not make it fail for the wrong reason.
  const when = (event) => (event.proposedStart ? new Date(event.proposedStart).getTime() : Number.POSITIVE_INFINITY);
  check(
    'ordered by event date, soonest first, undated last',
    mine.every((event, i) => i === 0 || when(mine[i - 1]) <= when(event)),
    mine.map((event) => event.proposedStart ?? 'null').join(' <= '),
  );
  const ownRow = mine.find((event) => event.id === s1.id);
  check(
    'each row carries the organiser\'s name',
    ownRow?.organiserName === 'Check Assign organiser',
    ownRow?.organiserName,
  );

  const forCoordinators = await listAssignmentHistory(s1.id, { includeNotes: true });
  check(
    'the history is oldest first',
    forCoordinators.length === 2 && forCoordinators[0].automatic && !forCoordinators[1].automatic
      && new Date(forCoordinators[0].createdAt) <= new Date(forCoordinators[1].createdAt),
    forCoordinators.map((entry) => (entry.automatic ? 'automatic' : 'handover')).join(' -> '),
  );
  check(
    'with names, read from profiles',
    forCoordinators[1]?.previousCoordinatorName === `Check Assign ${labelOf(holder)}`
      && forCoordinators[1]?.newCoordinatorName === `Check Assign ${labelOf(receiver)}`,
    `${forCoordinators[1]?.previousCoordinatorName} -> ${forCoordinators[1]?.newCoordinatorName}`,
  );
  check(
    'the coordinators\' view carries the note',
    forCoordinators[1]?.handoverNote === NOTE && 'handoverNote' in forCoordinators[0],
    forCoordinators[1]?.handoverNote,
  );

  const forOrganiser = await listAssignmentHistory(s1.id, { includeNotes: false });
  check(
    'the Organiser\'s view has no handoverNote key at all',
    forOrganiser.length === 2 && forOrganiser.every((entry) => !('handoverNote' in entry)),
    `${forOrganiser.length} entr(ies)`,
  );

  const pickerList = await listCoordinators();
  const pickerIds = pickerList.map((coordinator) => coordinator.id);
  check(
    'the coordinator list holds the coordinators and nobody else',
    [users.A, users.B, users.C].every((id) => pickerIds.includes(id))
      && !pickerIds.includes(users.V) && !pickerIds.includes(users.organiser),
    `${pickerList.length} coordinator(s)`,
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
    console.log('\nAll checks passed. Chose, assigned, refused, handed over, read, cleaned up.\n');
  });
