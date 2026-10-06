/**
 * End-to-end and concurrency proof for venue booking requests (SCRUM-243,
 * checked by SCRUM-256).
 *
 * Run with: npm run booking-requests:check
 *
 * Drives the real services -- bookingRequestService, venueBlockService,
 * venueService and eventRequestService -- against the live database, through
 * create_booking_request (030) and withdraw_booking_request (031), then removes
 * everything it created.
 *
 * The unit, route and PGlite suites prove the rules. PGlite is one connection,
 * so it can never show two transactions meeting on a row lock, and the fakes
 * the route tests use are not a database at all. Only this script can show:
 *
 *  - that the PostgREST embed filter the coordinator's list relies on really
 *    scopes to the assigned coordinator, and follows a handover;
 *  - that the default for an omitted status is pending on the real column (028);
 *  - that simultaneous requests for one event leave at most one active request,
 *    at different venues and at the same venue (the event row lock, 030);
 *  - that a request racing a venue block ends in a state some serial order
 *    explains, with no deadlock or stray error (the venue "for share" /
 *    "for no key update" protocol of 012 to 015);
 *  - that a withdrawal racing another withdrawal, a staff-style status change
 *    and a handover each leaves exactly one winner and no overwritten state
 *    (the event and booking locks and the guarded update, 031).
 *
 * How the races are made deterministic. Each is started from a start gate: every
 * call is created first, then the gate opens and they all begin together, so the
 * result never depends on which call happened to be created first. No sleeps are
 * used. Which call wins is up to the database, so every assertion is about an
 * outcome that holds for EVERY serial order, never about who won, and each race
 * runs several rounds on fresh data because one run only samples one
 * interleaving.
 *
 * What it cannot do, stated so nobody assumes otherwise. It talks to Postgres
 * through PostgREST, which gives each call its own transaction, so it cannot
 * hold a transaction open while a second one is observed waiting. A test that
 * pins "the request waited for the block's lock" needs a direct connection. For
 * the same reason a request racing a block cannot tell "block first, request
 * refused" from "request first, block over a pending request": both are legal,
 * and both are accepted. The race with a staff status change uses a guarded
 * UPDATE as a stand-in, because Venue Staff approval and rejection (SCRUM-258)
 * do not exist yet; replace it with the real transition when they do.
 *
 * Requires migrations 027 to 031. The preflight says what is missing, and
 * nothing is written until it passes. Exits non-zero on any failure.
 *
 * It creates throwaway auth users: two Venue Staff, two Event Coordinators and
 * an Event Organiser. withdraw_booking_request notifies every Venue Staff
 * profile, so real staff receive a notification row for each withdrawal made
 * here; cleanup deletes them by booking id, as check-venue-blocks.js does for
 * coordinators.
 */

import { randomUUID } from 'node:crypto';

import { supabase } from '../src/config/supabaseClient.js';
import { createVenue } from '../src/services/venueService.js';
import { createVenueBlock } from '../src/services/venueBlockService.js';
import { reassignEventRequest } from '../src/services/eventRequestService.js';
import {
  createBookingRequest,
  withdrawBookingRequest,
  listBookingRequestsForCoordinator,
} from '../src/services/bookingRequestService.js';
import { ConflictError, ForbiddenError } from '../src/errors.js';

const STAMP = Date.now();
const NAME = `__check_requests_${STAMP}`;
const LOCATION = `__check_requests_location_${STAMP}`;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const D = Math.floor((Date.now() + 30 * DAY) / HOUR) * HOUR;
const at = (hours) => new Date(D + hours * HOUR).toISOString();

/** How many times each race is run on fresh data. */
const ROUNDS = 5;

const users = { staff1: null, staff2: null, coordA: null, coordB: null, organiser: null };
const venueIds = [];
const eventIds = [];
const bookingIds = new Set();

let failures = 0;

function check(label, passed, detail = '') {
  console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!passed) failures += 1;
}

/** The suitability check is N10's and is not built; every venue here passes it. */
const checkSuitability = async () => ({ suitable: true, criteria: [{ criterion: 'capacity', met: true }] });

// ---------------------------------------------------------------------------
// Synchronisation
// ---------------------------------------------------------------------------

/**
 * Start every call together and settle them all.
 *
 * Each call is wrapped before any starts, then the gate opens in one step, so
 * none has a head start from being created earlier in the array. This is
 * synchronisation by a barrier, not by waiting for a length of time.
 */
function startTogether(calls) {
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const running = calls.map((call) => gate.then(call));
  open();
  return Promise.allSettled(running);
}

const fulfilled = (results) => results.filter((r) => r.status === 'fulfilled');
const rejected = (results) => results.filter((r) => r.status === 'rejected');

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/** Confirms 027-031 are applied before anything is written. */
async function preflight() {
  const missing = [];

  const { error: columnError } = await supabase
    .from('bookings')
    .select('status, requested_by, room_layout_code, setup_notes, suitability_result, suitability_overridden')
    .limit(1);
  if (columnError) missing.push(`bookings request columns (030): ${columnError.message}`);

  // Neither function can find an event or booking that does not exist, and both
  // must say so with no_data_found. PGRST202 means the function is missing.
  const { error: createError } = await supabase.rpc('create_booking_request', {
    p_event_request_id: randomUUID(),
    p_venue_id: randomUUID(),
    p_requested_by: randomUUID(),
    p_room_layout_code: null,
    p_setup_notes: null,
    p_suitability: { suitable: true, criteria: [] },
    p_confirm_unsuitable: false,
  });
  if (createError?.code !== 'P0002') {
    missing.push(`create_booking_request (030): expected P0002, got ${createError?.code ?? 'no error'} ${createError?.message ?? ''}`.trim());
  }

  const { error: withdrawError } = await supabase.rpc('withdraw_booking_request', {
    p_booking_id: randomUUID(),
    p_requested_by: randomUUID(),
  });
  if (withdrawError?.code !== 'P0002') {
    missing.push(`withdraw_booking_request (031): expected P0002, got ${withdrawError?.code ?? 'no error'} ${withdrawError?.message ?? ''}`.trim());
  }

  return missing;
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

async function createTestUser(label, role) {
  const { data, error } = await supabase.auth.admin.createUser({
    email: `__check_requests_${label}_${STAMP}@example.invalid`,
    email_confirm: true,
  });
  if (error) throw new Error(`could not create test user (${label}): ${error.message}`);

  users[label] = data.user.id;

  const { error: profileError } = await supabase
    .from('profiles')
    .insert({ id: data.user.id, role, full_name: `Check ${label}` });
  if (profileError) throw new Error(`could not create profile (${label}): ${profileError.message}`);

  return data.user.id;
}

async function makeVenue(label) {
  const venue = await createVenue(
    { name: `${NAME}_${label}`, location: LOCATION, maxCapacity: 100 },
    users.staff1,
  );
  venueIds.push(venue.id);
  return venue.id;
}

/** An approved event assigned to `coordinator`, with its own period. */
async function makeEvent(label, coordinator, startsAt, endsAt) {
  const { data, error } = await supabase
    .from('event_requests')
    .insert({
      organiser_id: users.organiser,
      event_name: `${NAME}_${label}`,
      status: 'approved',
      proposed_start: startsAt,
      proposed_end: endsAt,
      expected_attendance: 10,
      submitted_at: new Date().toISOString(),
      assigned_coordinator_id: coordinator,
    })
    .select('id')
    .single();
  if (error) throw new Error(`could not create test event (${label}): ${error.message}`);
  eventIds.push(data.id);
  return data.id;
}

/** Requests a venue, remembering the booking so cleanup can remove it. */
async function request(eventId, venueId, userId) {
  const booking = await createBookingRequest({ eventRequestId: eventId, venueId }, userId, {
    checkSuitability,
  });
  bookingIds.add(booking.id);
  return booking;
}

/** Track bookings a race may have created, whichever call won. */
async function trackBookingsOf(eventId) {
  const { data, error } = await supabase.from('bookings').select('id').eq('event_request_id', eventId);
  if (error) throw new Error(`could not read bookings: ${error.message}`);
  for (const row of data ?? []) bookingIds.add(row.id);
}

const ACTIVE = ['pending', 'approved', 'flagged_for_review'];

async function activeBookingsOf(eventId) {
  const { data, error } = await supabase
    .from('bookings')
    .select('id, status, venue_id')
    .eq('event_request_id', eventId)
    .in('status', ACTIVE);
  if (error) throw new Error(`could not read bookings: ${error.message}`);
  return data ?? [];
}

async function statusOf(bookingId) {
  const { data, error } = await supabase.from('bookings').select('status').eq('id', bookingId).single();
  if (error) throw new Error(`could not read booking ${bookingId}: ${error.message}`);
  return data.status;
}

async function withdrawnNotificationCount(bookingId) {
  const { count, error } = await supabase
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .eq('booking_id', bookingId)
    .eq('type', 'booking_request_withdrawn');
  if (error) throw new Error(`could not count notifications: ${error.message}`);
  return count ?? 0;
}

async function venueStaffCount() {
  const { count, error } = await supabase
    .from('profiles')
    .select('*', { count: 'exact', head: true })
    .eq('role', 'venue_staff');
  if (error) throw new Error(`could not count venue staff: ${error.message}`);
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function step(label, fn) {
  try {
    const result = await fn();
    if (result?.error) {
      console.error(`  cleanup: ${label} failed: ${result.error.message}`);
      failures += 1;
    }
  } catch (err) {
    console.error(`  cleanup: ${label} failed: ${err.message}`);
    failures += 1;
  }
}

async function cleanup() {
  // Bookings a race created that no call returned (a refused call can still
  // have left nothing, but a winner whose response was lost would not be known).
  for (const eventId of eventIds) {
    try {
      await trackBookingsOf(eventId);
    } catch (err) {
      console.error(`  cleanup: reading bookings failed: ${err.message}`);
      failures += 1;
    }
  }
  const bookings = [...bookingIds];

  let blockIds = [];
  if (venueIds.length > 0) {
    const { data, error } = await supabase.from('venue_blocks').select('id').in('venue_id', venueIds);
    if (error) {
      console.error(`  cleanup: reading blocks failed: ${error.message}`);
      failures += 1;
    }
    blockIds = (data ?? []).map((row) => row.id);
  }

  // Notifications first: they reference bookings and blocks with ON DELETE CASCADE,
  // but are removed explicitly so a failure surfaces as its own error.
  if (bookings.length > 0) {
    await step('notifications by booking', () => supabase.from('notifications').delete().in('booking_id', bookings));
  }
  if (blockIds.length > 0) {
    await step('notifications by block', () => supabase.from('notifications').delete().in('block_id', blockIds));
  }
  // Bookings before blocks (review_block_id) and before events (cascade, but explicit).
  if (bookings.length > 0) {
    await step('bookings', () => supabase.from('bookings').delete().in('id', bookings));
  }
  if (blockIds.length > 0) {
    await step('venue_block_history', () => supabase.from('venue_block_history').delete().in('block_id', blockIds));
  }
  if (venueIds.length > 0) {
    await step('venue_blocks', () => supabase.from('venue_blocks').delete().in('venue_id', venueIds));
  }
  // Assignment history is ON DELETE RESTRICT on the event (014): handovers wrote rows.
  if (eventIds.length > 0) {
    await step('event_request_assignment_history', () =>
      supabase.from('event_request_assignment_history').delete().in('event_request_id', eventIds));
    await step('event_requests', () => supabase.from('event_requests').delete().in('id', eventIds));
  }
  if (venueIds.length > 0) {
    await step('venue_change_history', () => supabase.from('venue_change_history').delete().in('venue_id', venueIds));
    await step('venues', () => supabase.from('venues').delete().in('id', venueIds));
  }
  for (const [label, id] of Object.entries(users)) {
    if (!id) continue;
    await step(`profile (${label})`, () => supabase.from('profiles').delete().eq('id', id));
    await step(`auth user (${label})`, () => supabase.auth.admin.deleteUser(id));
  }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function main() {
  console.log('\nBooking requests check\n');

  const missing = await preflight();
  if (missing.length > 0) {
    for (const line of missing) console.error(`  missing: ${line}`);
    console.error('\nApply migrations 027-031 in the Supabase SQL Editor, then run this again.');
    failures += 1;
    return;
  }
  check('migrations 027-031 are applied', true);

  // --- setup ---------------------------------------------------------------
  await createTestUser('staff1', 'venue_staff');
  await createTestUser('staff2', 'venue_staff');
  const coordA = await createTestUser('coordA', 'event_coordinator');
  const coordB = await createTestUser('coordB', 'event_coordinator');
  await createTestUser('organiser', 'event_organiser');

  // --- 1. a request is pending, and the default is pending too ------------
  console.log('\n  AC creation and default status');

  const venue0 = await makeVenue('single');
  const event0 = await makeEvent('single', coordA, at(9), at(17));
  const booking0 = await request(event0, venue0, coordA);
  check('a new request is pending', booking0.status === 'pending', booking0.status);
  check('it carries the event\'s own period', new Date(booking0.startsAt).getTime() === new Date(at(9)).getTime());
  check('and who requested it', booking0.requestedBy === coordA);

  const { data: defaulted, error: defaultError } = await supabase
    .from('bookings')
    .insert({ venue_id: venue0, event_request_id: event0, starts_at: at(100), ends_at: at(101) })
    .select('id, status')
    .single();
  if (defaultError) throw new Error(`could not insert a booking with no status: ${defaultError.message}`);
  bookingIds.add(defaulted.id);
  check('a booking inserted with no status is pending (028)', defaulted.status === 'pending', defaulted.status);

  // --- 2. the coordinator's list is scoped to the assigned coordinator ----
  console.log('\n  coordinator list isolation (the real PostgREST embed filter)');

  const venueB = await makeVenue('listB');
  const eventB = await makeEvent('listB', coordB, at(9), at(17));
  const bookingB = await request(eventB, venueB, coordB);

  const idsFor = async (coordinatorId) =>
    (await listBookingRequestsForCoordinator(coordinatorId)).map((row) => row.id);

  const listA = await idsFor(coordA);
  const listB = await idsFor(coordB);
  check('coordinator A sees A\'s request', listA.includes(booking0.id));
  check('coordinator A does not see B\'s request', !listA.includes(bookingB.id));
  check('coordinator B sees B\'s request', listB.includes(bookingB.id));
  check('coordinator B does not see A\'s request', !listB.includes(booking0.id));
  const rowA = (await listBookingRequestsForCoordinator(coordA)).find((row) => row.id === booking0.id);
  check('a row carries the event, venue and status display',
    rowA?.eventName === `${NAME}_single` && rowA?.venueName === `${NAME}_single` && rowA?.statusDisplay?.label === 'Pending',
    JSON.stringify({ e: rowA?.eventName, v: rowA?.venueName, s: rowA?.statusDisplay?.label }));
  const everyScoped = (await listBookingRequestsForCoordinator(coordA)).every((row) => row.eventRequestId === event0);
  check('every row A is shown is on an event assigned to A', everyScoped);

  // --- 3. race: one event, different venues --------------------------------
  console.log('\n  race: simultaneous requests for one event at different venues');

  for (let round = 1; round <= ROUNDS; round += 1) {
    const eventId = await makeEvent(`race1_${round}`, coordA, at(200 + round * 24), at(208 + round * 24));
    const racers = [];
    for (let i = 0; i < 3; i += 1) racers.push(await makeVenue(`race1_${round}_${i}`));

    const results = await startTogether(racers.map((venueId) => () => request(eventId, venueId, coordA)));
    await trackBookingsOf(eventId);

    const wins = fulfilled(results);
    const losses = rejected(results);
    const active = await activeBookingsOf(eventId);
    check(`round ${round}: exactly one of three succeeds`, wins.length === 1, `${wins.length} succeeded`);
    check(`round ${round}: the others are refused as BOOKING_REQUEST_EXISTS`,
      losses.length === 2 && losses.every((r) => r.reason instanceof ConflictError && r.reason.code === 'BOOKING_REQUEST_EXISTS'),
      losses.map((r) => r.reason?.code ?? r.reason?.message).join(','));
    check(`round ${round}: exactly one active request is stored`, active.length === 1, `${active.length} active`);
    check(`round ${round}: the stored one is the one that succeeded`, active[0]?.id === wins[0]?.value?.id);
  }

  console.log('\n  race: simultaneous requests for one event at the SAME venue');

  for (let round = 1; round <= ROUNDS; round += 1) {
    const eventId = await makeEvent(`race1s_${round}`, coordA, at(400 + round * 24), at(408 + round * 24));
    const venueId = await makeVenue(`race1s_${round}`);

    const results = await startTogether([
      () => request(eventId, venueId, coordA),
      () => request(eventId, venueId, coordA),
    ]);
    await trackBookingsOf(eventId);

    const active = await activeBookingsOf(eventId);
    check(`round ${round}: exactly one succeeds`, fulfilled(results).length === 1, `${fulfilled(results).length} succeeded`);
    check(`round ${round}: exactly one active request is stored`, active.length === 1, `${active.length} active`);
  }

  // --- 4. race: a request against a venue block ---------------------------
  console.log('\n  race: a request and a venue block over the same period');

  const tally = { requestFirst: 0, blockFirst: 0 };
  for (let round = 1; round <= ROUNDS; round += 1) {
    const base = 600 + round * 24;
    const eventId = await makeEvent(`race2_${round}`, coordA, at(base + 9), at(base + 17));
    const venueId = await makeVenue(`race2_${round}`);

    const [requestResult, blockResult] = await startTogether([
      () => request(eventId, venueId, coordA),
      () => createVenueBlock(venueId, { startsAt: at(base + 8), endsAt: at(base + 18), reason: 'maintenance' }, users.staff1),
    ]);
    await trackBookingsOf(eventId);

    const blockCreated = blockResult.status === 'fulfilled';
    const requestCreated = requestResult.status === 'fulfilled';
    const blockId = blockResult.value?.block?.id;

    // A pending request is not an approved booking, so a block never refuses
    // because of one: the block is created whichever call got there first.
    check(`round ${round}: the block is created whichever call won`, blockCreated,
      blockResult.reason?.message ?? '');

    if (requestCreated) {
      tally.requestFirst += 1;
      check(`round ${round}: a request that succeeded is pending`, requestResult.value.status === 'pending');
    } else {
      tally.blockFirst += 1;
      const err = requestResult.reason;
      check(`round ${round}: a refused request is a period conflict naming the block`,
        err instanceof ConflictError && err.code === 'BOOKING_PERIOD_CONFLICT' &&
          err.conflicts.some((c) => c.kind === 'block' && c.blockId === blockId),
        `${err?.constructor?.name} ${err?.code ?? err?.message}`);
      check(`round ${round}: nothing was stored for a refused request`, (await activeBookingsOf(eventId)).length === 0);
    }
  }
  console.log(`  info  ${tally.requestFirst} round(s) request first, ${tally.blockFirst} block first`);

  // --- 5. race: two withdrawals -------------------------------------------
  console.log('\n  race: two withdrawals of the same request');

  const staffCount = await venueStaffCount();

  for (let round = 1; round <= ROUNDS; round += 1) {
    const eventId = await makeEvent(`race3a_${round}`, coordA, at(800 + round * 24), at(808 + round * 24));
    const booking = await request(eventId, await makeVenue(`race3a_${round}`), coordA);

    const results = await startTogether([
      () => withdrawBookingRequest(booking.id, coordA),
      () => withdrawBookingRequest(booking.id, coordA),
    ]);

    const losses = rejected(results);
    check(`round ${round}: exactly one withdrawal succeeds`, fulfilled(results).length === 1, `${fulfilled(results).length} succeeded`);
    check(`round ${round}: the other is refused as BOOKING_NOT_PENDING`,
      losses.length === 1 && losses[0].reason instanceof ConflictError && losses[0].reason.code === 'BOOKING_NOT_PENDING',
      losses[0]?.reason?.code ?? losses[0]?.reason?.message);
    check(`round ${round}: the request is withdrawn`, (await statusOf(booking.id)) === 'withdrawn');
    check(`round ${round}: Venue Staff were told once, not twice`,
      (await withdrawnNotificationCount(booking.id)) === staffCount, `${await withdrawnNotificationCount(booking.id)} of ${staffCount}`);
  }

  // --- 6. race: a withdrawal and a staff-style status change ---------------
  console.log('\n  race: a withdrawal and a status change (guarded UPDATE stand-in for SCRUM-258)');

  for (let round = 1; round <= ROUNDS; round += 1) {
    const eventId = await makeEvent(`race3b_${round}`, coordA, at(1000 + round * 24), at(1008 + round * 24));
    const booking = await request(eventId, await makeVenue(`race3b_${round}`), coordA);

    // What an approval must do: change the status only while it is still pending.
    const standIn = async () => {
      const { data, error } = await supabase
        .from('bookings')
        .update({ status: 'approved' })
        .eq('id', booking.id)
        .eq('status', 'pending')
        .select('id');
      if (error) throw new Error(error.message);
      return data ?? [];
    };

    const [withdrawResult, approveResult] = await startTogether([
      () => withdrawBookingRequest(booking.id, coordA),
      standIn,
    ]);

    const finalStatus = await statusOf(booking.id);
    const notifications = await withdrawnNotificationCount(booking.id);
    const withdrawWon = withdrawResult.status === 'fulfilled';
    const approveWon = approveResult.status === 'fulfilled' && approveResult.value.length === 1;

    check(`round ${round}: exactly one of the two wins`, withdrawWon !== approveWon,
      `withdraw ${withdrawWon}, approve ${approveWon}`);
    check(`round ${round}: the final status is the winner's, never overwritten`,
      finalStatus === (withdrawWon ? 'withdrawn' : 'approved'), finalStatus);
    check(`round ${round}: Venue Staff are told only if the withdrawal won`,
      notifications === (withdrawWon ? staffCount : 0), `${notifications}`);
    if (!withdrawWon) {
      const err = withdrawResult.reason;
      check(`round ${round}: a withdrawal that lost is BOOKING_NOT_PENDING`,
        err instanceof ConflictError && err.code === 'BOOKING_NOT_PENDING', err?.code ?? err?.message);
    }
  }

  // --- 7. race: a withdrawal and a handover --------------------------------
  console.log('\n  race: a withdrawal and a handover of the event');

  const handedOver = [];

  for (let round = 1; round <= ROUNDS; round += 1) {
    const eventId = await makeEvent(`race3c_${round}`, coordA, at(1200 + round * 24), at(1208 + round * 24));
    const booking = await request(eventId, await makeVenue(`race3c_${round}`), coordA);
    handedOver.push(booking.id);

    const [withdrawResult, handoverResult] = await startTogether([
      () => withdrawBookingRequest(booking.id, coordA),
      () => reassignEventRequest(eventId, { newCoordinatorId: coordB }, coordA),
    ]);

    const withdrawWon = withdrawResult.status === 'fulfilled';
    const finalStatus = await statusOf(booking.id);
    const { data: event } = await supabase.from('event_requests').select('assigned_coordinator_id').eq('id', eventId).single();

    check(`round ${round}: the handover always succeeds`, handoverResult.status === 'fulfilled', handoverResult.reason?.message ?? '');
    check(`round ${round}: the event ends with the new coordinator`, event?.assigned_coordinator_id === coordB);
    check(`round ${round}: a withdrawal either succeeded first or was refused as not theirs`,
      withdrawWon || withdrawResult.reason instanceof ForbiddenError,
      withdrawResult.reason?.constructor?.name ?? '');
    check(`round ${round}: the status matches the outcome`, finalStatus === (withdrawWon ? 'withdrawn' : 'pending'), finalStatus);
    check(`round ${round}: Venue Staff are told only if it was withdrawn`,
      (await withdrawnNotificationCount(booking.id)) === (withdrawWon ? staffCount : 0));
  }

  // The list follows the handover: every event A gave to B in the last race now
  // lists its request for B and no longer for A.
  const listAfter = await idsFor(coordA);
  const listBAfter = await idsFor(coordB);
  check('after the handovers, A no longer sees those events\' requests',
    handedOver.every((id) => !listAfter.includes(id)), `${handedOver.filter((id) => listAfter.includes(id)).length} still shown`);
  check('and B now sees all of them',
    handedOver.every((id) => listBAfter.includes(id)), `${handedOver.filter((id) => !listBAfter.includes(id)).length} missing`);
  check('A still sees the request on an event A kept', listAfter.includes(booking0.id));
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
    console.log('\nAll checks passed. Requested, raced, withdrawn, listed, cleaned up.\n');
  });
