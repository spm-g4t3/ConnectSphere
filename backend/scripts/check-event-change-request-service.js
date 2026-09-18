/**
 * End-to-end proof for the event change request service (SCRUM-11, SCRUM-33).
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
import { createChangeRequest } from '../src/services/eventChangeRequestService.js';

const STAMP = Date.now();

let organiserId = null;
let otherOrganiserId = null;
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
}

async function main() {
  console.log('\nEvent change request service check\n');

  organiserId = await createTestUser('organiser');
  otherOrganiserId = await createTestUser('other');

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
