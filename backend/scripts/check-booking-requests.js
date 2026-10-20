/**
 * End-to-end and concurrency proof for venue booking requests (SCRUM-243,
 * checked by SCRUM-256) and Venue Staff decisions on them (SCRUM-258, checked
 * by SCRUM-264).
 *
 * Run with: npm run booking-requests:check
 *
 * Drives the real services -- bookingRequestService, venueBlockService,
 * venueService and eventRequestService -- against the live database, through
 * create_booking_request, withdraw_booking_request and decide_booking_request
 * (066), then removes everything it created.
 *
 * The unit, route and PGlite suites prove the rules. PGlite is one connection,
 * so it can never show two transactions meeting on a row lock, and the fakes
 * the route tests use are not a database at all. Only this script can show:
 *
 *  - that the PostgREST embed filter the coordinator's list relies on really
 *    scopes to the assigned coordinator, and follows a handover;
 *  - that the default for an omitted status is pending on the real column (028);
 *  - that simultaneous requests for one event leave at most one active request
 *    per venue: at different venues all are created, at the same venue only
 *    one is (051's per-venue rule, under 030's event row lock);
 *  - that a request racing a venue block ends in a state some serial order
 *    explains, with no deadlock or stray error (the venue "for share" /
 *    "for no key update" protocol of 012 to 015);
 *  - that a withdrawal racing another withdrawal, a Venue Staff rejection and
 *    a handover each leaves exactly one winner and no overwritten state (the
 *    event and booking locks and the guarded update, 031 and 066);
 *  - SCRUM-258 AC2: that two approvals of different events' overlapping
 *    requests at one venue, made at the same moment, approve exactly one; the
 *    other is left conflicting, naming the winner (066's venue lock);
 *  - that two decisions on one request, an approval racing a withdrawal, and
 *    an approval racing a venue block each end in a state some serial order
 *    explains, with the winner's decision and notices only.
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
 * and both are accepted.
 *
 * Requires the full schema: backend/db/baseline/ plus every file in
 * backend/db/migrations/ (see the repo README). The preflight probes the
 * request columns, functions and statuses it uses and says what is missing;
 * nothing is written until it passes.
 * Exits non-zero on any failure.
 *
 * It creates throwaway auth users: two Venue Staff, two Event Coordinators and
 * an Event Organiser. withdraw_booking_request notifies every Venue Staff
 * profile, and a block over an approved booking every Event Coordinator, so
 * real staff and coordinators receive a notification row for some of what is
 * done here; cleanup deletes every notification by booking id, as
 * check-venue-blocks.js does for coordinators.
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
  listPendingBookingRequests,
  approveBookingRequest,
  rejectBookingRequest,
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

/** Confirms 027-031, 051, 065 and 066 are applied before anything is written. */
async function preflight() {
  const missing = [];

  const { error: columnError } = await supabase
    .from('bookings')
    .select('status, requested_by, room_layout_code, setup_notes, suitability_result, suitability_overridden')
    .limit(1);
  if (columnError) missing.push(`bookings request columns (030): ${columnError.message}`);

  // Neither function can find an event or booking that does not exist, and both
  // must say so with no_data_found. PGRST202 means the function is missing.
  // p_expected_attendance is passed so a database still on 040's 7-argument
  // create_booking_request answers PGRST202 here, not P0002: without it the
  // preflight would pass on 040 and every request below would fail.
  const { error: createError } = await supabase.rpc('create_booking_request', {
    p_event_request_id: randomUUID(),
    p_venue_id: randomUUID(),
    p_requested_by: randomUUID(),
    p_room_layout_code: null,
    p_setup_notes: null,
    p_suitability: { suitable: true, criteria: [] },
    p_confirm_unsuitable: false,
    p_expected_attendance: 1,
  });
  if (createError?.code !== 'P0002') {
    missing.push(`create_booking_request (051): expected P0002, got ${createError?.code ?? 'no error'} ${createError?.message ?? ''}`.trim());
  }

  const { error: withdrawError } = await supabase.rpc('withdraw_booking_request', {
    p_booking_id: randomUUID(),
    p_requested_by: randomUUID(),
  });
  if (withdrawError?.code !== 'P0002') {
    missing.push(`withdraw_booking_request (031): expected P0002, got ${withdrawError?.code ?? 'no error'} ${withdrawError?.message ?? ''}`.trim());
  }

  // 065: an enum value it does not know is refused as 22P02, so a filter on
  // each new value proves both were added.
  const { error: conflictingError } = await supabase.from('bookings').select('id').eq('status', 'conflicting').limit(1);
  if (conflictingError) missing.push(`booking status 'conflicting' (065): ${conflictingError.message}`);
  const { error: convertedError } = await supabase.from('venue_holds').select('id').eq('status', 'converted').limit(1);
  if (convertedError) missing.push(`venue hold status 'converted' (065): ${convertedError.message}`);

  // 066: both functions refuse a caller with no profile as 42501 before they
  // read anything else; PGRST202 means the function is missing.
  const { error: decideError } = await supabase.rpc('decide_booking_request', {
    p_booking_id: randomUUID(),
    p_caller: randomUUID(),
    p_decision: 'approve',
    p_reason: null,
    p_suggested_alternative: null,
  });
  if (decideError?.code !== '42501') {
    missing.push(`decide_booking_request (066): expected 42501, got ${decideError?.code ?? 'no error'} ${decideError?.message ?? ''}`.trim());
  }

  const { error: queueError } = await supabase.rpc('list_pending_booking_requests', { p_caller: randomUUID() });
  if (queueError?.code !== '42501') {
    missing.push(`list_pending_booking_requests (066): expected 42501, got ${queueError?.code ?? 'no error'} ${queueError?.message ?? ''}`.trim());
  }

  // 066's decision columns, which the decision races read back.
  const { error: decisionColumnError } = await supabase
    .from('bookings')
    .select('decided_by, decided_at, decision_reason, suggested_alternative')
    .limit(1);
  if (decisionColumnError) missing.push(`bookings decision columns (066): ${decisionColumnError.message}`);

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

async function notificationCount(bookingId, type) {
  const { count, error } = await supabase
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .eq('booking_id', bookingId)
    .eq('type', type);
  if (error) throw new Error(`could not count notifications: ${error.message}`);
  return count ?? 0;
}

const withdrawnNotificationCount = (bookingId) => notificationCount(bookingId, 'booking_request_withdrawn');

/** What decide_booking_request (066) records on the booking, as stored. */
async function decisionOf(bookingId) {
  const { data, error } = await supabase
    .from('bookings')
    .select('status, decided_by, decided_at, decision_reason, suggested_alternative, review_block_id')
    .eq('id', bookingId)
    .single();
  if (error) throw new Error(`could not read booking ${bookingId}: ${error.message}`);
  return data;
}

async function activeBlocksAt(venueId) {
  const { data, error } = await supabase
    .from('venue_blocks')
    .select('id')
    .eq('venue_id', venueId)
    .is('removed_at', null);
  if (error) throw new Error(`could not read blocks: ${error.message}`);
  return data ?? [];
}

/** The ids of the bookings occupying a period at a venue, unpadded. */
async function occupyingBookingIds(venueId, startsAt, endsAt) {
  const { data, error } = await supabase.rpc('venue_occupancy_conflicts', {
    p_venue_id: venueId,
    p_starts_at: startsAt,
    p_ends_at: endsAt,
    p_pad_requested: false,
  });
  if (error) throw new Error(`could not read occupancy: ${error.message}`);
  return (data ?? []).filter((row) => row.kind === 'booking').map((row) => row.id);
}

const sameInstant = (a, b) => a != null && b != null && new Date(a).getTime() === new Date(b).getTime();
const reasonOf = (result) => result.reason?.code ?? result.reason?.message ?? '';

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
  // but are removed explicitly so a failure surfaces as its own error. By booking
  // id, so every type goes: withdrawn, flagged and 066's approved, rejected and
  // conflicting.
  if (bookings.length > 0) {
    await step('notifications by booking', () => supabase.from('notifications').delete().in('booking_id', bookings));
  }
  if (blockIds.length > 0) {
    await step('notifications by block', () => supabase.from('notifications').delete().in('block_id', blockIds));
  }
  // Holds before bookings (a converted hold names its booking) and events. No
  // race here places one, but an approval converts any it finds.
  if (eventIds.length > 0) {
    await step('venue_holds', () => supabase.from('venue_holds').delete().in('event_request_id', eventIds));
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
    console.error('\nThe database is missing part of the schema. Apply backend/db/baseline/01-09 (a fresh');
    console.error('project only), then each file in backend/db/migrations/ in order, in the Supabase SQL');
    console.error('Editor, then run this again.');
    failures += 1;
    return;
  }
  check('the schema this check needs is applied', true);

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
  // SCRUM-525 (051): one live request per (event, venue), so requests for one
  // event at three different venues are all created, however they interleave
  // on the event row lock. Before 051 exactly one won; this now catches that
  // rule creeping back as much as a lost or doubled row.
  console.log('\n  race: simultaneous requests for one event at different venues');

  for (let round = 1; round <= ROUNDS; round += 1) {
    const eventId = await makeEvent(`race1_${round}`, coordA, at(200 + round * 24), at(208 + round * 24));
    const racers = [];
    for (let i = 0; i < 3; i += 1) racers.push(await makeVenue(`race1_${round}_${i}`));

    const results = await startTogether(racers.map((venueId) => () => request(eventId, venueId, coordA)));
    await trackBookingsOf(eventId);

    const losses = rejected(results);
    const active = await activeBookingsOf(eventId);
    check(`round ${round}: all three are created`, fulfilled(results).length === 3, `${fulfilled(results).length} succeeded`);
    check(`round ${round}: nothing is refused`, losses.length === 0,
      losses.map((r) => r.reason?.code ?? r.reason?.message).join(','));
    check(`round ${round}: each venue holds exactly one active request`,
      active.length === 3 && racers.every((venueId) => active.filter((b) => b.venue_id === venueId).length === 1),
      `${active.length} active`);
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

  // The two rules at once: two requests for venue 1 and one for venue 2, all
  // for one event. The venue 2 request must never be refused because of the
  // venue 1 pair, and the venue 1 pair must still leave only one.
  console.log('\n  race: simultaneous requests for one event, two at one venue and one at another');

  for (let round = 1; round <= ROUNDS; round += 1) {
    const eventId = await makeEvent(`race1m_${round}`, coordA, at(1400 + round * 24), at(1408 + round * 24));
    const venue1 = await makeVenue(`race1m_${round}_1`);
    const venue2 = await makeVenue(`race1m_${round}_2`);

    const results = await startTogether([
      () => request(eventId, venue1, coordA),
      () => request(eventId, venue1, coordA),
      () => request(eventId, venue2, coordA),
    ]);
    await trackBookingsOf(eventId);

    const wins = fulfilled(results);
    const losses = rejected(results);
    const active = await activeBookingsOf(eventId);
    const activeAt = (venueId) => active.filter((b) => b.venue_id === venueId).length;
    check(`round ${round}: exactly two succeed, one at each venue`,
      wins.length === 2 &&
        wins.filter((r) => r.value.venueId === venue1).length === 1 &&
        wins.filter((r) => r.value.venueId === venue2).length === 1,
      wins.map((r) => r.value.venueId === venue1 ? 'V1' : r.value.venueId === venue2 ? 'V2' : '?').join(','));
    check(`round ${round}: the other venue 1 request is refused as BOOKING_REQUEST_EXISTS`,
      losses.length === 1 && results[2].status === 'fulfilled' &&
        losses[0].reason instanceof ConflictError && losses[0].reason.code === 'BOOKING_REQUEST_EXISTS',
      losses.map((r) => r.reason?.code ?? r.reason?.message).join(','));
    check(`round ${round}: each venue holds exactly one active request`,
      active.length === 2 && activeAt(venue1) === 1 && activeAt(venue2) === 1,
      `${activeAt(venue1)} at V1, ${activeAt(venue2)} at V2`);
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

  // --- 6. race: a withdrawal and a Venue Staff rejection ------------------
  // Both lock the event and then the booking (031, 066), so one waits for the
  // other and then finds the request no longer open.
  console.log('\n  race: a withdrawal and a Venue Staff rejection of the same request');

  for (let round = 1; round <= ROUNDS; round += 1) {
    const eventId = await makeEvent(`race3b_${round}`, coordA, at(1000 + round * 24), at(1008 + round * 24));
    const booking = await request(eventId, await makeVenue(`race3b_${round}`), coordA);

    const [withdrawResult, rejectResult] = await startTogether([
      () => withdrawBookingRequest(booking.id, coordA),
      () => rejectBookingRequest(booking.id, users.staff1, { reason: 'Venue unavailable' }),
    ]);

    const stored = await decisionOf(booking.id);
    const withdrawWon = withdrawResult.status === 'fulfilled';
    const rejectWon = rejectResult.status === 'fulfilled';
    const loser = withdrawWon ? rejectResult : withdrawResult;

    check(`round ${round}: exactly one of the two wins`, withdrawWon !== rejectWon,
      `withdraw ${withdrawWon}, reject ${rejectWon}`);
    check(`round ${round}: the loser is refused as BOOKING_NOT_PENDING`,
      loser.status === 'rejected' && loser.reason instanceof ConflictError && loser.reason.code === 'BOOKING_NOT_PENDING',
      reasonOf(loser));
    check(`round ${round}: the final status is the winner's, never overwritten`,
      stored.status === (withdrawWon ? 'withdrawn' : 'rejected'), stored.status);
    check(`round ${round}: a decision is recorded only if the rejection won`,
      rejectWon
        ? stored.decided_by === users.staff1 && stored.decision_reason === 'Venue unavailable'
        : stored.decided_by === null && stored.decided_at === null && stored.decision_reason === null,
      JSON.stringify({ by: stored.decided_by, reason: stored.decision_reason }));
    check(`round ${round}: Venue Staff are told only if the withdrawal won`,
      (await withdrawnNotificationCount(booking.id)) === (withdrawWon ? staffCount : 0));
    check(`round ${round}: the coordinator is told of a rejection only if it won`,
      (await notificationCount(booking.id, 'booking_request_rejected')) === (rejectWon ? 1 : 0));
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

  // --- 8. race: two approvals of overlapping requests (SCRUM-258 AC2) -----
  // Two events' requests overlap at one venue, and two Venue Staff approve one
  // each at the same moment. 066's venue lock makes them take turns, so the
  // second re-checks after the first has committed and must find it.
  console.log('\n  race (SCRUM-258 AC2): two approvals of different events\' overlapping requests at one venue');

  const approvalTally = { first: 0, second: 0 };
  for (let round = 1; round <= ROUNDS; round += 1) {
    const base = 1600 + round * 24;
    const venueId = await makeVenue(`race4a_${round}`);
    const eventX = await makeEvent(`race4a_${round}_x`, coordA, at(base + 9), at(base + 17));
    const eventY = await makeEvent(`race4a_${round}_y`, coordB, at(base + 12), at(base + 20));
    const x = await request(eventX, venueId, coordA);
    const y = await request(eventY, venueId, coordB);

    const results = await startTogether([
      () => approveBookingRequest(x.id, users.staff1),
      () => approveBookingRequest(y.id, users.staff2),
    ]);

    const wins = fulfilled(results);
    const losses = rejected(results);
    check(`round ${round}: exactly one approval succeeds`, wins.length === 1,
      `${wins.length} succeeded; ${losses.map(reasonOf).join(',')}`);
    // With no single winner the checks below have nothing to compare against.
    if (wins.length !== 1) continue;

    const xWon = results[0].status === 'fulfilled';
    approvalTally[xWon ? 'first' : 'second'] += 1;
    const winner = xWon ? x : y;
    const loser = xWon ? y : x;
    const err = losses[0].reason;

    check(`round ${round}: the other is refused as a period conflict naming the winner`,
      err instanceof ConflictError && err.code === 'BOOKING_PERIOD_CONFLICT' &&
        err.conflicts.some((c) => c.kind === 'booking' && c.bookingId === winner.id),
      `${err?.constructor?.name} ${err?.code ?? err?.message}`);
    check(`round ${round}: the winner reports the other as marked conflicting`,
      wins[0].value.markedConflicting.includes(loser.id), JSON.stringify(wins[0].value.markedConflicting));

    const storedWinner = await decisionOf(winner.id);
    const storedLoser = await decisionOf(loser.id);
    check(`round ${round}: the winner is approved and the other conflicting, undecided`,
      storedWinner.status === 'approved' && storedLoser.status === 'conflicting' && storedLoser.decided_by === null,
      `${storedWinner.status} / ${storedLoser.status}`);
    check(`round ${round}: one approval notice, for the winner only`,
      (await notificationCount(winner.id, 'booking_request_approved')) === 1 &&
        (await notificationCount(loser.id, 'booking_request_approved')) === 0);
    check(`round ${round}: the other's coordinator is told once of the conflict`,
      (await notificationCount(loser.id, 'booking_request_conflicting')) === 1);

    // A conflicting request never occupies the venue: only the winner does.
    const occupying = await occupyingBookingIds(venueId, at(base), at(base + 24));
    check(`round ${round}: only the winner occupies the venue`,
      occupying.length === 1 && occupying[0] === winner.id, JSON.stringify(occupying));

    const queue = await listPendingBookingRequests(users.staff1);
    const queuedLoser = queue.find((row) => row.id === loser.id);
    check(`round ${round}: the queue shows the other as conflicting with the winner, and not the winner`,
      queuedLoser?.status === 'conflicting' &&
        queuedLoser.conflictingWith.some((c) => c.bookingId === winner.id) &&
        !queue.some((row) => row.id === winner.id),
      queuedLoser ? queuedLoser.status : 'not queued');
  }
  console.log(`  info  ${approvalTally.first} round(s) the first approval won, ${approvalTally.second} the second`);

  // --- 9. race: two decisions on the same request -------------------------
  // Both lock the event and then the booking, so the second finds it decided.
  // Two different staff decide, so decided_by tells whose decision was kept.
  const REASON = 'Venue closed for maintenance';
  const ALTERNATIVE = 'The hall next door';
  const decisionRaces = [
    {
      label: 'an approval and a rejection',
      tag: 'race5a',
      offset: 1800,
      decisions: (id) => [
        { by: users.staff1, status: 'approved', reason: null, alternative: null,
          run: () => approveBookingRequest(id, users.staff1) },
        { by: users.staff2, status: 'rejected', reason: REASON, alternative: ALTERNATIVE,
          run: () => rejectBookingRequest(id, users.staff2, { reason: REASON, suggestedAlternative: ALTERNATIVE }) },
      ],
    },
    {
      label: 'two approvals',
      tag: 'race5b',
      offset: 2000,
      decisions: (id) => [
        { by: users.staff1, status: 'approved', reason: null, alternative: null,
          run: () => approveBookingRequest(id, users.staff1) },
        { by: users.staff2, status: 'approved', reason: null, alternative: null,
          run: () => approveBookingRequest(id, users.staff2) },
      ],
    },
  ];

  for (const race of decisionRaces) {
    console.log(`\n  race: ${race.label} of the same request by two Venue Staff`);

    for (let round = 1; round <= ROUNDS; round += 1) {
      const base = race.offset + round * 24;
      const eventId = await makeEvent(`${race.tag}_${round}`, coordA, at(base + 9), at(base + 17));
      const booking = await request(eventId, await makeVenue(`${race.tag}_${round}`), coordA);

      const decisions = race.decisions(booking.id);
      const results = await startTogether(decisions.map((d) => d.run));
      const winIndex = results.findIndex((r) => r.status === 'fulfilled');
      const losses = rejected(results);

      check(`round ${round}: exactly one decision succeeds`, fulfilled(results).length === 1,
        `${fulfilled(results).length} succeeded; ${losses.map(reasonOf).join(',')}`);
      check(`round ${round}: the other is refused as BOOKING_NOT_PENDING`,
        losses.length === 1 && losses[0].reason instanceof ConflictError && losses[0].reason.code === 'BOOKING_NOT_PENDING',
        losses.map(reasonOf).join(','));
      if (winIndex === -1) continue;

      const won = decisions[winIndex];
      const stored = await decisionOf(booking.id);
      check(`round ${round}: the stored decision is the winner's, never overwritten`,
        stored.status === won.status && stored.decided_by === won.by &&
          sameInstant(stored.decided_at, results[winIndex].value.decidedAt) &&
          stored.decision_reason === won.reason && stored.suggested_alternative === won.alternative,
        JSON.stringify({ status: stored.status, winner: won.status, sameStaff: stored.decided_by === won.by }));

      const approvedNotices = await notificationCount(booking.id, 'booking_request_approved');
      const rejectedNotices = await notificationCount(booking.id, 'booking_request_rejected');
      check(`round ${round}: the coordinator is told once, of the winning decision`,
        approvedNotices + rejectedNotices === 1 &&
          (won.status === 'approved' ? approvedNotices : rejectedNotices) === 1,
        `${approvedNotices} approved, ${rejectedNotices} rejected`);
    }
  }

  // --- 10. race: an approval and the coordinator's withdrawal -------------
  console.log('\n  race: an approval and a withdrawal of the same request');

  for (let round = 1; round <= ROUNDS; round += 1) {
    const base = 2200 + round * 24;
    const eventId = await makeEvent(`race6_${round}`, coordA, at(base + 9), at(base + 17));
    const booking = await request(eventId, await makeVenue(`race6_${round}`), coordA);

    const [approveResult, withdrawResult] = await startTogether([
      () => approveBookingRequest(booking.id, users.staff1),
      () => withdrawBookingRequest(booking.id, coordA),
    ]);

    const approveWon = approveResult.status === 'fulfilled';
    const withdrawWon = withdrawResult.status === 'fulfilled';
    const loser = approveWon ? withdrawResult : approveResult;
    const stored = await decisionOf(booking.id);

    check(`round ${round}: exactly one of the two wins`, approveWon !== withdrawWon,
      `approve ${approveWon}, withdraw ${withdrawWon}`);
    check(`round ${round}: the loser is refused as BOOKING_NOT_PENDING`,
      loser.status === 'rejected' && loser.reason instanceof ConflictError && loser.reason.code === 'BOOKING_NOT_PENDING',
      reasonOf(loser));
    check(`round ${round}: the final status is the winner's, never overwritten`,
      stored.status === (approveWon ? 'approved' : 'withdrawn'), stored.status);
    check(`round ${round}: a decision is recorded only if the approval won`,
      approveWon ? stored.decided_by === users.staff1 : stored.decided_by === null && stored.decided_at === null);
    check(`round ${round}: the coordinator is told of an approval only if it won`,
      (await notificationCount(booking.id, 'booking_request_approved')) === (approveWon ? 1 : 0));
    check(`round ${round}: Venue Staff are told of a withdrawal only if it won`,
      (await withdrawnNotificationCount(booking.id)) === (withdrawWon ? staffCount : 0));
  }

  // --- 11. race: an approval and a venue block over the same period -------
  // Both lock the venue "for no key update" (066, 033), so they take turns.
  // Block first: the approval's re-check finds the block and writes nothing.
  // Approval first: the block meets an approved booking, so 033's gate refuses
  // it unless that booking was acknowledged, when it is created and flags it.
  const blockRaces = [
    { label: 'unacknowledged', tag: 'race7a', offset: 2400, acknowledge: false },
    { label: 'acknowledging the request', tag: 'race7b', offset: 2600, acknowledge: true },
  ];

  for (const race of blockRaces) {
    console.log(`\n  race: an approval and a venue block (${race.label}) over the same period`);

    const tallyBlock = { approvalFirst: 0, blockFirst: 0 };
    for (let round = 1; round <= ROUNDS; round += 1) {
      const base = race.offset + round * 24;
      const eventId = await makeEvent(`${race.tag}_${round}`, coordA, at(base + 9), at(base + 17));
      const venueId = await makeVenue(`${race.tag}_${round}`);
      const booking = await request(eventId, venueId, coordA);

      const blockInput = { startsAt: at(base + 8), endsAt: at(base + 18), reason: 'maintenance' };
      if (race.acknowledge) {
        blockInput.confirmOverride = true;
        blockInput.acknowledgedBookingIds = [booking.id];
      }

      const [approveResult, blockResult] = await startTogether([
        () => approveBookingRequest(booking.id, users.staff1),
        () => createVenueBlock(venueId, blockInput, users.staff2),
      ]);

      const approveWon = approveResult.status === 'fulfilled';
      const blockCreated = blockResult.status === 'fulfilled';
      const blocks = await activeBlocksAt(venueId);
      const stored = await decisionOf(booking.id);
      const approvedNotices = await notificationCount(booking.id, 'booking_request_approved');

      if (approveWon) {
        tallyBlock.approvalFirst += 1;
        if (race.acknowledge) {
          const blockId = blockResult.value?.block?.id;
          check(`round ${round}: an acknowledged block after the approval is created and flags it`,
            blockCreated && blocks.length === 1 &&
              blockResult.value.flaggedBookings.some((b) => b.bookingId === booking.id),
            reasonOf(blockResult));
          check(`round ${round}: the booking is flagged for review against that block`,
            stored.status === 'flagged_for_review' && stored.review_block_id === blockId, stored.status);
        } else {
          const err = blockResult.reason;
          check(`round ${round}: a block after the approval is refused, naming the booking`,
            !blockCreated && err instanceof ConflictError && err.code === 'BLOCK_BOOKING_CONFLICT' &&
              err.conflicts.some((c) => c.bookingId === booking.id),
            `${err?.constructor?.name} ${err?.code ?? err?.message}`);
          check(`round ${round}: no block was stored and the booking stays approved`,
            blocks.length === 0 && stored.status === 'approved', `${blocks.length} block(s), ${stored.status}`);
        }
        check(`round ${round}: the approval was recorded and the coordinator told once`,
          stored.decided_by === users.staff1 && approvedNotices === 1, `${approvedNotices} notice(s)`);
      } else {
        tallyBlock.blockFirst += 1;
        const err = approveResult.reason;
        const blockId = blockResult.value?.block?.id;
        check(`round ${round}: a refused approval means the block was created first`, blockCreated && blocks.length === 1,
          reasonOf(blockResult));
        check(`round ${round}: the approval is a period conflict naming the block`,
          err instanceof ConflictError && err.code === 'BOOKING_PERIOD_CONFLICT' &&
            err.conflicts.some((c) => c.kind === 'block' && c.blockId === blockId),
          `${err?.constructor?.name} ${err?.code ?? err?.message}`);
        check(`round ${round}: the request is still pending, undecided, with no approval notice`,
          stored.status === 'pending' && stored.decided_by === null && approvedNotices === 0, stored.status);
        if (race.acknowledge) {
          check(`round ${round}: a block before the approval flags nothing`,
            blockResult.value?.flaggedBookings.length === 0);
        }
      }
    }
    console.log(`  info  ${tallyBlock.approvalFirst} round(s) approval first, ${tallyBlock.blockFirst} block first`);
  }
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
    console.log('\nAll checks passed. Requested, raced, decided, withdrawn, listed, cleaned up.\n');
  });
