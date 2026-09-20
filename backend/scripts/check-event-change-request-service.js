/**
 * End-to-end proof for the event change request service
 * (SCRUM-11, SCRUM-33, SCRUM-34, SCRUM-35, SCRUM-37).
 *
 * Run with: npm run change-request:check
 *
 * There is no SCRUM-10 service yet to create an event request through, and
 * both organiser_id and requested_by require a real auth.users row -- RLS
 * cannot be borrowed around that requirement. So this script creates its own
 * throwaway user and event request directly, exercises the change request
 * service against them, then removes everything it created, including the
 * users, the same "clean up after itself" shape as check-venue-service.js.
 *
 * Exits non-zero on any failure.
 */

import { supabase } from '../src/config/supabaseClient.js';
import {
  createChangeRequest,
  createChangeRequestFromClient,
  getChangeRequestsForEvent,
  getChangeRequestById,
  processChangeRequest,
} from '../src/services/eventChangeRequestService.js';

const STAMP = Date.now();

let organiserId = null;
let otherOrganiserId = null;
let coordinatorId = null;
let eventId = null;
let failures = 0;

function check(label, passed, detail = '') {
  console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!passed) failures += 1;
}

/** A throwaway confirmed user, created with the admin API the secret key unlocks. */
async function createTestUser(label) {
  const { data, error } = await supabase.auth.admin.createUser({
    email: `__check_change_request_${label}_${STAMP}@example.invalid`,
    email_confirm: true,
  });
  if (error) throw new Error(`could not create test user (${label}): ${error.message}`);
  return data.user.id;
}

async function cleanup() {
  if (eventId) {
    // Change requests first: their FK to event_requests is ON DELETE CASCADE,
    // so this line is not strictly required, but it keeps the intent explicit
    // rather than relying on cascade behaviour a future migration could change.
    await supabase.from('event_change_requests').delete().eq('event_request_id', eventId);
    await supabase.from('event_requests').delete().eq('id', eventId);
  }
  if (organiserId) await supabase.auth.admin.deleteUser(organiserId);
  if (otherOrganiserId) await supabase.auth.admin.deleteUser(otherOrganiserId);
  if (coordinatorId) await supabase.auth.admin.deleteUser(coordinatorId);
}

async function main() {
  console.log('\nEvent change request service check\n');

  organiserId = await createTestUser('organiser');
  otherOrganiserId = await createTestUser('other');
  coordinatorId = await createTestUser('coordinator');

  const { data: event, error: createEventError } = await supabase
    .from('event_requests')
    .insert({
      organiser_id: organiserId,
      event_name: `__check_event_${STAMP}`,
      status: 'submitted',
    })
    .select()
    .single();
  if (createEventError) throw new Error(`could not create test event: ${createEventError.message}`);
  eventId = event.id;

  // --- AC1 + AC2: request a change, specifying what needs updating ---------
  const request = await createChangeRequest(
    {
      eventRequestId: eventId,
      changeField: 'expected_attendance',
      requestedChange: '120',
    },
    organiserId,
  );

  check('change request created', Boolean(request.id));
  check('recorded against the right event', request.eventRequestId === eventId);
  check('recorded who asked', request.requestedBy === organiserId);
  check('recorded the field', request.changeField === 'expected_attendance');
  check('recorded the new value', request.requestedChange === '120');

  // --- AC3: the system has recorded it against the event --------------------
  const { data: stored } = await supabase
    .from('event_change_requests')
    .select('*')
    .eq('event_request_id', eventId);
  check('stored against the event', stored?.length === 1, `${stored?.length ?? 0} rows`);

  // --- AC4: the Organiser can see whether each request is outstanding, in
  // progress, or processed ---------------------------------------------------
  const second = await createChangeRequest(
    {
      eventRequestId: eventId,
      changeField: 'purpose',
      requestedChange: 'Team offsite, not a client pitch',
    },
    organiserId,
  );

  const list = await getChangeRequestsForEvent(eventId, organiserId);

  check('lists every change request for the event', list.length === 2, `${list.length} items`);
  check('newest first', list[0]?.id === second.id);
  check('new requests default to outstanding', list.every((r) => r.status === 'outstanding'));
  check(
    'shaped for the frontend status list (fieldLabel/details)',
    list.every((r) => typeof r.fieldLabel === 'string'
      && r.fieldLabel.length > 0
      && r.details === r.requestedChange),
  );

  let listRejectedForOtherOrganiser = false;
  try {
    await getChangeRequestsForEvent(eventId, otherOrganiserId);
  } catch (err) {
    listRejectedForOtherOrganiser = err.status === 400;
  }
  check('a different organiser cannot list them', listRejectedForOtherOrganiser);

  let listNotFound = false;
  try {
    await getChangeRequestsForEvent('00000000-0000-0000-0000-000000000000', organiserId);
  } catch (err) {
    listNotFound = err.status === 404;
  }
  check('listing a missing event raises NotFoundError', listNotFound);

  // --- SCRUM-35: one change request is addressable on its own, for review --
  const single = await getChangeRequestById(second.id, organiserId);

  check('fetched the right request', single.id === second.id);
  check('still linked to its event', single.eventRequestId === eventId);
  check(
    'shaped the same as a list item (fieldLabel/details)',
    typeof single.fieldLabel === 'string'
      && single.fieldLabel.length > 0
      && single.details === single.requestedChange,
  );

  let getRejectedForOtherOrganiser = false;
  try {
    await getChangeRequestById(second.id, otherOrganiserId);
  } catch (err) {
    getRejectedForOtherOrganiser = err.status === 400;
  }
  check('a different organiser cannot fetch it directly', getRejectedForOtherOrganiser);

  let getNotFound = false;
  try {
    await getChangeRequestById('00000000-0000-0000-0000-000000000000', organiserId);
  } catch (err) {
    getNotFound = err.status === 404;
  }
  check('fetching a missing change request raises NotFoundError', getNotFound);

  let getMalformedIdRejected = false;
  try {
    await getChangeRequestById('not-a-real-id', organiserId);
  } catch (err) {
    getMalformedIdRejected = err.status === 400;
  }
  check('a malformed changeRequestId is rejected without a network call', getMalformedIdRejected);

  // --- frontend/backend contract fix: the exact wire shape the form sends ---
  const third = await createChangeRequestFromClient(
    eventId,
    { field: 'venue', details: 'Move to the larger hall on Level 3' },
    organiserId,
  );
  check('accepts the client wire shape { field, details }', Boolean(third.id));
  check('maps field -> changeField', third.changeField === 'venue');
  check('maps details -> requestedChange', third.requestedChange === 'Move to the larger hall on Level 3');

  // --- frontend/backend contract fix: venue and equipment are now valid ----
  const equipmentRequest = await createChangeRequest(
    { eventRequestId: eventId, changeField: 'equipment', requestedChange: 'Add two extra microphones' },
    organiserId,
  );
  check('equipment is now a valid changeField', equipmentRequest.changeField === 'equipment');

  // --- AC1: a draft event cannot have a change requested against it --------
  await supabase.from('event_requests').update({ status: 'draft' }).eq('id', eventId);
  let draftRejected = false;
  try {
    await createChangeRequest(
      { eventRequestId: eventId, changeField: 'purpose', requestedChange: 'x' },
      organiserId,
    );
  } catch (err) {
    draftRejected = err.status === 400;
  }
  check('draft event rejected', draftRejected);
  await supabase.from('event_requests').update({ status: 'submitted' }).eq('id', eventId);

  // --- only the event's own organiser may request a change ------------------
  let ownershipRejected = false;
  try {
    await createChangeRequest(
      { eventRequestId: eventId, changeField: 'purpose', requestedChange: 'x' },
      otherOrganiserId,
    );
  } catch (err) {
    ownershipRejected = err.status === 400;
  }
  check('a different organiser is rejected', ownershipRejected);

  // --- not found --------------------------------------------------------------
  let notFound = false;
  try {
    await createChangeRequest(
      {
        eventRequestId: '00000000-0000-0000-0000-000000000000',
        changeField: 'purpose',
        requestedChange: 'x',
      },
      organiserId,
    );
  } catch (err) {
    notFound = err.status === 404;
  }
  check('missing event raises NotFoundError', notFound);

  // --- validation runs before any network call -------------------------------
  let badField = false;
  try {
    await createChangeRequest(
      { eventRequestId: eventId, changeField: 'not_a_real_field', requestedChange: 'x' },
      organiserId,
    );
  } catch (err) {
    badField = err.status === 400;
  }
  check('invalid changeField rejected', badField);

  // --- SCRUM-33: a malformed event id is rejected without a network call ----
  let malformedIdRejected = false;
  try {
    await createChangeRequest(
      { eventRequestId: 'not-a-real-id', changeField: 'purpose', requestedChange: 'x' },
      organiserId,
    );
  } catch (err) {
    malformedIdRejected = err.status === 400;
  }
  check('malformed eventRequestId rejected', malformedIdRejected);

  // --- SCRUM-33: requestedChange must be usable for its changeField --------
  let badAttendanceRejected = false;
  try {
    await createChangeRequest(
      { eventRequestId: eventId, changeField: 'expected_attendance', requestedChange: 'lots' },
      organiserId,
    );
  } catch (err) {
    badAttendanceRejected = err.status === 400;
  }
  check('non-numeric expected_attendance rejected', badAttendanceRejected);

  let badDateRejected = false;
  try {
    await createChangeRequest(
      { eventRequestId: eventId, changeField: 'proposed_start', requestedChange: 'next tuesday' },
      organiserId,
    );
  } catch (err) {
    badDateRejected = err.status === 400;
  }
  check('unparseable proposed_start rejected', badDateRejected);

  // --- SCRUM-37 (AC5): approving a change applies it to the event record ---
  const attendanceChange = await createChangeRequest(
    { eventRequestId: eventId, changeField: 'expected_attendance', requestedChange: '250' },
    organiserId,
  );

  const approved = await processChangeRequest(attendanceChange.id, { decision: 'approved' }, coordinatorId);

  check('approved change request is marked processed', approved.status === 'processed');
  check('decision recorded as approved', approved.decision === 'approved');
  check('processed_by recorded', approved.processedBy === coordinatorId);
  check('processed_at recorded', Boolean(approved.processedAt));

  const { data: eventAfterApproval } = await supabase
    .from('event_requests')
    .select('expected_attendance')
    .eq('id', eventId)
    .single();
  check(
    'event record reflects the approved change',
    eventAfterApproval?.expected_attendance === 250,
    `got ${eventAfterApproval?.expected_attendance}`,
  );

  // --- SCRUM-37: rejecting requires a reason, and never touches the event --
  const nameChange = await createChangeRequest(
    { eventRequestId: eventId, changeField: 'event_name', requestedChange: 'Renamed Event' },
    organiserId,
  );

  let rejectionWithoutReason = false;
  try {
    await processChangeRequest(nameChange.id, { decision: 'rejected' }, coordinatorId);
  } catch (err) {
    rejectionWithoutReason = err.status === 400;
  }
  check('rejecting without a reason is rejected', rejectionWithoutReason);

  const rejected = await processChangeRequest(
    nameChange.id,
    { decision: 'rejected', decisionNotes: 'Event name is already finalised in printed materials' },
    coordinatorId,
  );

  check('rejected change request is marked processed', rejected.status === 'processed');
  check('decision recorded as rejected', rejected.decision === 'rejected');
  check(
    'decision notes recorded',
    rejected.decisionNotes === 'Event name is already finalised in printed materials',
  );

  const { data: eventAfterRejection } = await supabase
    .from('event_requests')
    .select('event_name')
    .eq('id', eventId)
    .single();
  check(
    'event record NOT changed by a rejected request',
    eventAfterRejection?.event_name === `__check_event_${STAMP}`,
    eventAfterRejection?.event_name,
  );

  // --- SCRUM-37: approving venue/equipment records the decision, applies
  // nothing -- there is no column on event_requests for either yet ----------
  const venueApproval = await processChangeRequest(third.id, { decision: 'approved' }, coordinatorId);
  check(
    'venue change request approved with nothing to apply',
    venueApproval.status === 'processed' && venueApproval.decision === 'approved',
  );

  // --- SCRUM-37: a change request cannot be processed twice ----------------
  let alreadyProcessedRejected = false;
  try {
    await processChangeRequest(
      attendanceChange.id,
      { decision: 'rejected', decisionNotes: 'too late' },
      coordinatorId,
    );
  } catch (err) {
    alreadyProcessedRejected = err.status === 400;
  }
  check('processing an already-processed request is rejected', alreadyProcessedRejected);

  // --- SCRUM-37: not found / malformed id -----------------------------------
  let processNotFound = false;
  try {
    await processChangeRequest(
      '00000000-0000-0000-0000-000000000000',
      { decision: 'approved' },
      coordinatorId,
    );
  } catch (err) {
    processNotFound = err.status === 404;
  }
  check('processing a missing change request raises NotFoundError', processNotFound);

  let processMalformedIdRejected = false;
  try {
    await processChangeRequest('not-a-real-id', { decision: 'approved' }, coordinatorId);
  } catch (err) {
    processMalformedIdRejected = err.status === 400;
  }
  check('a malformed changeRequestId is rejected without a network call', processMalformedIdRejected);

  // --- SCRUM-37: a failed apply rolls back the whole decision (atomicity) --
  // This is the entire reason process_change_request is a single Postgres
  // function rather than two supabase-js calls: applying the change and
  // deciding the request must succeed or fail together.
  await supabase
    .from('event_requests')
    .update({ proposed_start: '2026-10-01T09:00:00Z', proposed_end: '2026-10-01T17:00:00Z' })
    .eq('id', eventId);

  const badStartChange = await createChangeRequest(
    { eventRequestId: eventId, changeField: 'proposed_start', requestedChange: '2026-10-02T09:00:00Z' },
    organiserId,
  );

  let applyFailedAsExpected = false;
  try {
    await processChangeRequest(badStartChange.id, { decision: 'approved' }, coordinatorId);
  } catch (err) {
    applyFailedAsExpected = err.status === 400;
  }
  check('approving a change that violates a DB constraint is rejected', applyFailedAsExpected);

  const stillOutstanding = await getChangeRequestById(badStartChange.id, organiserId);
  check(
    'the whole decision rolled back -- request is still open, not processed',
    stillOutstanding.status === 'outstanding' && stillOutstanding.decision === null,
  );

  const { data: eventUnchanged } = await supabase
    .from('event_requests')
    .select('proposed_start')
    .eq('id', eventId)
    .single();
  check(
    'event record unchanged after the failed apply',
    new Date(eventUnchanged?.proposed_start).getTime() === new Date('2026-10-01T09:00:00Z').getTime(),
  );
}

main()
  .catch((err) => {
    console.error(`\nFailed: ${err.message}`);
    failures += 1;
  })
  .finally(async () => {
    await cleanup();
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed.\n`);
      process.exit(1);
    }
    console.log('\nAll checks passed. Created, requested, verified, rejected, cleaned up.\n');
  });
