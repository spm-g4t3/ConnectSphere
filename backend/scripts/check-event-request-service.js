/**
 * End-to-end proof for the event request service (SCRUM-31).
 *
 * Run with: npm run request:check
 *
 * The 35 unit tests in tests/services/eventRequestService.test.js run against a
 * hand-rolled fake, which answers whatever it was told to answer. Everything
 * below is what a fake cannot prove: that the enum accepts 'draft' and
 * 'submitted', that the not null and check constraints in 001 fire, that the
 * four columns added by 005 exist and hold data, that
 * event_requests_submitted_at_matches_status does what its comment claims, that
 * organiser_id really is a foreign key into auth.users, and that the
 * event_requests_set_updated_at trigger maintains updated_at without the
 * service ever setting it.
 *
 * It is also the first exercise of the service's lazy client. The unit tests
 * always supply a fake, so the default branch -- the dynamic import of
 * supabaseClient.js -- is never taken there. Every service call below omits the
 * client on purpose, so the path production will use is the path being tested.
 * supabase is imported here only for the raw operations a service method has no
 * business exposing: listing users, bypassing the service to attack a
 * constraint directly, counting, and cleaning up.
 *
 * Exits non-zero on any failure.
 */

import { supabase } from '../src/config/supabaseClient.js';
import {
  createEventRequest,
  submitEventRequest,
  changeEventRequestStatus,
  getEventRequestById,
} from '../src/services/eventRequestService.js';
import { ValidationError, NotFoundError, ConflictError } from '../src/errors.js';

const NAME = `__check_request_${Date.now()}`;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// Real future instants, not fixed literals. Submission requires a start that is
// still ahead of now, so a hardcoded date would quietly start failing the day
// it passed -- the exact trap the injectable `now` exists to avoid in tests.
const START = new Date(Date.now() + 30 * DAY).toISOString();
const END = new Date(Date.now() + 30 * DAY + 8 * HOUR).toISOString();

const createdIds = [];
let rowsBefore = null;
let failures = 0;

// Errors from cleanup's own deletes. supabase-js does not throw on a refused
// delete, it returns { error }, so a delete that a foreign key refuses is
// silent unless someone looks. SCRUM-330 found exactly that: the history row
// a submission writes blocked the event delete, and the rows stayed behind.
const cleanupErrors = [];

function check(label, passed, detail = '') {
  console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!passed) failures += 1;
}

/** Remember a row so cleanup can remove it, whatever happens afterwards. */
function track(record) {
  createdIds.push(record.id);
  return record;
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

/** Run one cleanup delete, keeping its error rather than dropping it. */
async function remove(label, query) {
  const { error } = await query;
  if (error) cleanupErrors.push(`${label}: ${error.message}`);
}

async function cleanup() {
  if (createdIds.length === 0) return;

  // Both history tables first: the status history since SCRUM-321 and the
  // assignment history since SCRUM-330. Both are ON DELETE RESTRICT, so the
  // events cannot go while a row of either remains.
  //
  // Assignment history. Since SCRUM-330, submitting a request writes an
  // event_request_assignment_history row, and that table's event_request_id is
  // ON DELETE RESTRICT (014) on purpose: it is an accountability record that
  // must outlive a careless delete. Deleting the events first is refused. And
  // because the events go in one statement, a single refused row keeps every
  // row in that statement -- which is how this script left two behind.
  await remove(
    'assignment history',
    supabase.from('event_request_assignment_history').delete().in('event_request_id', createdIds),
  );
  await remove(
    'status history',
    supabase.from('event_request_status_history').delete().in('event_request_id', createdIds),
  );
  await remove('event requests', supabase.from('event_requests').delete().in('id', createdIds));
}

/** Rows in one table, for the before-and-after comparison. */
async function countRows(table) {
  const { count } = await supabase
    .from(table)
    .select('*', { count: 'exact', head: true });
  return count ?? 0;
}

/** The three tables this script writes to. */
async function countAll() {
  return {
    requests: await countRows('event_requests'),
    history: await countRows('event_request_assignment_history'),
    statusHistory: await countRows('event_request_status_history'),
  };
}

/** The assignment history rows written for one event, oldest first. */
async function historyFor(eventRequestId) {
  const { data, error } = await supabase
    .from('event_request_assignment_history')
    .select('previous_coordinator_id, new_coordinator_id, assigned_by')
    .eq('event_request_id', eventRequestId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`could not read assignment history: ${error.message}`);
  return data ?? [];
}

/** The status history rows written for one event, oldest first. */
async function statusHistoryFor(eventRequestId) {
  const { data, error } = await supabase
    .from('event_request_status_history')
    .select('previous_status, new_status, changed_by, reason, created_at')
    .eq('event_request_id', eventRequestId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`could not read status history: ${error.message}`);
  return data ?? [];
}

async function main() {
  console.log('\nEvent request service check\n');

  rowsBefore = await countAll();

  // --- the Organiser ------------------------------------------------------
  // Read rather than hardcoded. organiser_id references auth.users, so an id
  // invented here would fail with a foreign key violation that looks like a bug
  // in the service rather than an empty user table.
  const { data, error } = await supabase.auth.admin.listUsers();
  if (error) throw new Error(`could not list auth users: ${error.message}`);

  const organiser = data?.users?.[0];
  if (!organiser) {
    throw new Error(
      'no users in auth.users -- create one in the Supabase dashboard first. ' +
      'Every insert below would otherwise fail on the foreign key.',
    );
  }

  const organiserId = organiser.id;
  console.log(`  organiser:   ${organiser.email ?? '(no email)'}  ${organiserId}`);
  console.log(`  rows before: ${rowsBefore.requests} requests, ${rowsBefore.history} history\n`);

  // --- 1. a minimal draft -------------------------------------------------
  // Proves the permissive half of the design against the real schema: a request
  // with nothing but a name is storable. The fake could not show that the enum
  // accepts 'draft', that event_name's length(trim(...)) > 0 check passes, or
  // that created_at and updated_at defaults fire without the service sending them.
  const minimal = track(await createEventRequest({ eventName: NAME }, organiserId));

  check('minimal draft created', Boolean(minimal.id), minimal.id);
  check('status is draft', minimal.status === 'draft', minimal.status);
  check('organiser recorded', minimal.organiserId === organiserId, minimal.organiserId);
  check('submitted_at still null', minimal.submittedAt === null, String(minimal.submittedAt));
  check('created_at set by the database', Boolean(minimal.createdAt), minimal.createdAt);

  // --- 2. a complete draft ------------------------------------------------
  // The three requirement columns from 005 have never held data -- the table was
  // empty before this run. A typo in COLUMN_BY_FIELD would be silent, because
  // PostgREST ignores a key no column matches, so the only way to know the
  // mapping is right is to write a value and read it back.
  const completeInput = {
    eventName: `${NAME}_complete`,
    purpose: 'Connect final-year students with industry partners.',
    description: 'An evening of short talks followed by networking.',
    proposedStart: START,
    proposedEnd: END,
    expectedAttendance: 120,
    venueRequirements: 'A large room, ideally tiered seating.',
    accessibilityRequirements: 'Step-free access to the stage.',
    equipmentRequirements: 'Two handheld microphones and a projector.',
  };

  const complete = track(await createEventRequest(completeInput, organiserId));

  // Kept for the trigger check at the end, before anything updates the row.
  const createdAtAtInsert = complete.createdAt;
  const updatedAtAtInsert = complete.updatedAt;

  check('complete draft created', Boolean(complete.id), complete.id);
  check('purpose stored', complete.purpose === completeInput.purpose);
  check('description stored', complete.description === completeInput.description);
  check('attendance stored', complete.expectedAttendance === 120, String(complete.expectedAttendance));
  check(
    'venue requirements stored (005)',
    complete.venueRequirements === completeInput.venueRequirements,
    complete.venueRequirements,
  );
  check(
    'accessibility requirements stored (005)',
    complete.accessibilityRequirements === completeInput.accessibilityRequirements,
    complete.accessibilityRequirements,
  );
  check(
    'equipment requirements stored (005)',
    complete.equipmentRequirements === completeInput.equipmentRequirements,
    complete.equipmentRequirements,
  );
  check(
    'proposed start round-trips as the same instant',
    new Date(complete.proposedStart).getTime() === new Date(START).getTime(),
    complete.proposedStart,
  );
  check(
    'proposed end round-trips as the same instant',
    new Date(complete.proposedEnd).getTime() === new Date(END).getTime(),
    complete.proposedEnd,
  );

  // --- 3. reading it back -------------------------------------------------
  // A separate round trip, so this reads what Postgres stored rather than what
  // the insert echoed back.
  const readBack = await getEventRequestById(complete.id);

  check('read back by id', readBack.id === complete.id);
  check('event name matches', readBack.eventName === completeInput.eventName);
  check('requirements survive a re-read', readBack.equipmentRequirements === completeInput.equipmentRequirements);
  check(
    'keys are camelCase, not column names',
    'eventName' in readBack && !('event_name' in readBack) && !('organiser_id' in readBack),
    Object.keys(readBack).filter((k) => k.includes('_')).join(',') || 'no snake_case keys',
  );

  // --- 4. submitting ------------------------------------------------------
  // The draft -> submitted move against the real enum and the real constraint.
  // Note no `now` is injected: this is the production path, judged against the
  // server's own clock.
  const beforeSubmit = Date.now();
  const submitted = await submitEventRequest(complete.id);

  check('status becomes submitted', submitted.status === 'submitted', submitted.status);
  check('submitted_at recorded', Boolean(submitted.submittedAt), submitted.submittedAt);

  const skew = Math.abs(new Date(submitted.submittedAt).getTime() - beforeSubmit);
  check('submitted_at is close to now', skew < 60_000, `${skew} ms from the local clock`);

  // SCRUM-321: the same submission records the status change, once, beside
  // the assignment and separate from it.
  const statusAfterSubmit = await statusHistoryFor(complete.id);
  check('exactly one status history row written', statusAfterSubmit.length === 1, String(statusAfterSubmit.length));
  check(
    'the status history row is draft -> submitted, by the organiser',
    statusAfterSubmit[0]?.previous_status === 'draft'
      && statusAfterSubmit[0]?.new_status === 'submitted'
      && statusAfterSubmit[0]?.changed_by === organiserId
      && statusAfterSubmit[0]?.reason === null,
    JSON.stringify(statusAfterSubmit[0] ?? null),
  );
  check('the status history row has a timestamp', Boolean(statusAfterSubmit[0]?.created_at));

  // SCRUM-327 / SCRUM-318: the one production path assigns the coordinator and
  // records it, exactly once. Read back from the tables rather than from the
  // service's return value, so this proves what was stored.
  check('a coordinator is assigned', Boolean(submitted.assignedCoordinatorId), submitted.assignedCoordinatorId);

  const historyAfterSubmit = await historyFor(complete.id);
  check('exactly one history row written', historyAfterSubmit.length === 1, String(historyAfterSubmit.length));
  check(
    'the history row names the assigned coordinator, assigned by the system',
    historyAfterSubmit[0]?.new_coordinator_id === submitted.assignedCoordinatorId
      && historyAfterSubmit[0]?.previous_coordinator_id === null
      && historyAfterSubmit[0]?.assigned_by === null,
    JSON.stringify(historyAfterSubmit[0] ?? null),
  );

  // --- 5. the constraint from 005 is real ---------------------------------
  // Deliberately bypasses the service and attacks the table directly, which is
  // the only way to prove the constraint rather than the code in front of it.
  // The minimal request is still a draft, so setting submitted_at on it must be
  // refused by event_requests_submitted_at_matches_status. If this check ever
  // fails, 005's header comment is describing a guarantee that is not there.
  const { error: constraintError } = await supabase
    .from('event_requests')
    .update({ submitted_at: new Date().toISOString() })
    .eq('id', minimal.id);

  check(
    'database refuses submitted_at on a draft',
    Boolean(constraintError),
    constraintError ? constraintError.code : 'the update was ACCEPTED',
  );
  check(
    'the refusal names the constraint from 005',
    /event_requests_submitted_at_matches_status/.test(constraintError?.message ?? ''),
    constraintError?.message ?? '(no error)',
  );

  // --- 6. an incomplete draft cannot be submitted -------------------------
  // The minimal request has a name and nothing else, which is exactly what
  // SCRUM-11 needs to stay savable. Submission re-reads the stored row and
  // refuses it, listing every gap so the Organiser fixes the form in one pass.
  const incomplete = await failureFrom(submitEventRequest(minimal.id));

  check('incomplete draft refused', incomplete instanceof ValidationError, incomplete?.name ?? 'no error');
  check('reported as 400', incomplete?.status === 400, String(incomplete?.status));

  const gaps = (incomplete?.details ?? []).map((d) => d.field).sort();
  check('every gap listed, not just the first', gaps.length === 4, gaps.join(',') || 'none');

  // A refused submission leaves nothing behind: still a draft, no coordinator,
  // no history row.
  const stillDraft = await getEventRequestById(minimal.id);
  check('the refused request is still a draft', stillDraft.status === 'draft', stillDraft.status);
  check('the refused request has no coordinator', stillDraft.assignedCoordinatorId === null, String(stillDraft.assignedCoordinatorId));
  check('the refused request has no history row', (await historyFor(minimal.id)).length === 0);
  check('the refused request has no status history row', (await statusHistoryFor(minimal.id)).length === 0);

  // --- 7. submitting twice ------------------------------------------------
  // The complete request is already 'submitted' from step 4, so canTransition
  // refuses it. This is the sequential case; the concurrent one is covered by
  // the guard on the update, which a single-threaded script cannot provoke.
  const again = await failureFrom(submitEventRequest(complete.id));

  check('second submit refused', again instanceof ConflictError, again?.name ?? 'no error');
  check('reported as 409', again?.status === 409, String(again?.status));
  check('message names the current status', /submitted/i.test(again?.message ?? ''), again?.message ?? '');

  // The refused second submit changes nothing: same coordinator, still one row.
  const afterAgain = await getEventRequestById(complete.id);
  check(
    'the refused second submit kept the coordinator',
    afterAgain.assignedCoordinatorId === submitted.assignedCoordinatorId,
    String(afterAgain.assignedCoordinatorId),
  );
  check('the refused second submit wrote no history row', (await historyFor(complete.id)).length === 1);
  check('the refused second submit wrote no status history row', (await statusHistoryFor(complete.id)).length === 1);

  // --- 7b. two simultaneous transitions from the same status --------------
  // SCRUM-325. Two real connections to Postgres, so the row lock in
  // change_event_request_status is what decides. Exactly one may succeed: the
  // other finds the request no longer submitted and is refused, and only the
  // winner leaves a history row.
  const holderId = afterAgain.assignedCoordinatorId;
  const race = await Promise.allSettled([
    changeEventRequestStatus(complete.id, {
      expectedStatus: 'submitted',
      newStatus: 'under_review',
      changedBy: holderId,
      expectedCoordinatorId: holderId,
    }),
    changeEventRequestStatus(complete.id, {
      expectedStatus: 'submitted',
      newStatus: 'cancelled',
      changedBy: holderId,
      expectedCoordinatorId: holderId,
    }),
  ]);
  const winners = race.filter((r) => r.status === 'fulfilled');
  const losers = race.filter((r) => r.status === 'rejected');
  check('exactly one of two simultaneous transitions succeeds', winners.length === 1, `${winners.length} succeeded`);
  check(
    'the other is refused as a conflict',
    losers.length === 1 && losers[0].reason instanceof ConflictError,
    losers[0]?.reason?.name ?? 'no error',
  );
  const afterRace = await statusHistoryFor(complete.id);
  check('the race left exactly one more history row', afterRace.length === 2, String(afterRace.length));
  check(
    'and the request is in the status the winner chose',
    winners[0]?.value?.status === (await getEventRequestById(complete.id)).status,
    winners[0]?.value?.status ?? 'no winner',
  );

  // --- 8. submitting something absent -------------------------------------
  const missing = await failureFrom(
    submitEventRequest('00000000-0000-0000-0000-000000000000'),
  );

  check('absent request raises NotFoundError', missing instanceof NotFoundError, missing?.name ?? 'no error');
  check('reported as 404', missing?.status === 404, String(missing?.status));

  // --- 9. an organiser who does not exist ---------------------------------
  // The 23503 path, and the likeliest real failure in production: a stale token
  // or a deleted account. A fake can be told to return the code; only the real
  // database proves the foreign key is actually there to raise it.
  //
  // Wrapped in try/catch rather than failureFrom so that an unexpected success
  // still tracks the row for cleanup.
  let ghostError = null;
  try {
    track(await createEventRequest({ eventName: `${NAME}_ghost` }, '99999999-9999-4999-8999-999999999999'));
  } catch (err) {
    ghostError = err;
  }

  check('unknown organiser refused', ghostError !== null, ghostError?.name ?? 'the insert was ACCEPTED');
  check('translated, not a raw driver error', ghostError instanceof ValidationError, ghostError?.name ?? '');
  check('message names the organiser', /organiser/i.test(ghostError?.message ?? ''), ghostError?.message ?? '');

  // --- 10. the updated_at trigger -----------------------------------------
  // The service never sets updated_at on insert or on submit -- grep it. So if
  // the column has moved since step 2, only event_requests_set_updated_at can
  // have moved it. created_at must not have budged: a trigger that touched both
  // would destroy the distinction submitted_at depends on.
  const afterSubmit = await getEventRequestById(complete.id);

  check(
    'updated_at advanced after the submit',
    new Date(afterSubmit.updatedAt).getTime() > new Date(updatedAtAtInsert).getTime(),
    `${updatedAtAtInsert} -> ${afterSubmit.updatedAt}`,
  );
  check(
    'created_at did not move',
    afterSubmit.createdAt === createdAtAtInsert,
    afterSubmit.createdAt,
  );
}

main()
  .catch((err) => {
    console.error(`\nFailed: ${err.message}`);
    failures += 1;
  })
  .finally(async () => {
    await cleanup();

    // Counted after cleanup so the script proves it left the tables as it found
    // them, rather than asserting it and hoping. Assignment history is counted
    // too, since SCRUM-330: the submission in step 4 writes a row there.
    check('cleanup ran without errors', cleanupErrors.length === 0, cleanupErrors.join('; '));
    if (rowsBefore !== null) {
      const rowsAfter = await countAll();
      check(
        'nothing left behind',
        rowsAfter.requests === rowsBefore.requests
          && rowsAfter.history === rowsBefore.history
          && rowsAfter.statusHistory === rowsBefore.statusHistory,
        `requests ${rowsBefore.requests} -> ${rowsAfter.requests}, `
          + `history ${rowsBefore.history} -> ${rowsAfter.history}, `
          + `status history ${rowsBefore.statusHistory} -> ${rowsAfter.statusHistory}`,
      );
    }

    if (failures > 0) {
      console.error(`\n${failures} check(s) failed.\n`);
      process.exit(1);
    }
    console.log('\nAll checks passed. Created, read, submitted, refused, cleaned up.\n');
  });
