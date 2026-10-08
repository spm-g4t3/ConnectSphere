/**
 * End-to-end proof for setup and turnaround occupancy (SCRUM-484, sub-task 5).
 *
 * Run with: npm run venue-occupancy:check
 *
 * Requires migrations 032 to 035 (032_venue_occupancy.sql,
 * 033_venue_occupancy_callers.sql, 034_setup_change_recheck.sql,
 * 035_setup_change_recheck_refine.sql) applied in the Supabase SQL Editor.
 * The preflight says what is missing for 032-034, and nothing is written until
 * it passes. 035 keeps update_venue's signature, so it cannot be detected from
 * here: apply it before running. Exits non-zero on any failure.
 *
 * Drives the real services -- venueService, venueBlockService,
 * bookingRequestService, venueCalendarService and notificationService --
 * against the live database, then removes everything it created.
 *
 * The unit, route and PGlite suites prove the rules with mocks or an
 * in-process Postgres. Only this script shows the deployed functions and the
 * JavaScript working together, on the worked example from the SCRUM-484 test
 * cases: venue V at setup 30 and turnaround 45, approved booking A 10:00-12:00,
 * so A occupies [09:30, 12:45).
 *
 *  - AC1/AC2: a venue is created at 30/45 through the service and reads back
 *    both values.
 *  - AC3/AC5: a booking request at 13:14-14:00 occupies [12:44, 14:45) and is
 *    refused as BOOKING_PERIOD_CONFLICT listing A with 09:30-12:45; one at
 *    13:15-14:00 occupies [12:45, 14:45), touches, and is created (then
 *    withdrawn).
 *  - AC6: a block is never padded. 12:00-12:45 meets A's turnaround and is
 *    refused listing A; 12:45-13:30 touches and is created, stored exactly as
 *    typed. It is then removed so it cannot colour AC4 or AC8.
 *  - AC4: findVenuesForEvent and available_venue_ids() leave the venue out at
 *    13:14 and return it at 13:15; the calendar shows A with its occupied
 *    period.
 *  - AC8: approved booking B 13:30-14:30 occupies [13:00, 15:15), clear of A's
 *    12:45. Raising turnaround to 90 makes A occupy [09:30, 13:30) and B
 *    [13:00, 16:00): they overlap 13:00-13:30, so update_venue flags both with
 *    review_reason 'setup_or_turnaround_changed', notifies each event's
 *    assigned coordinator once (booking_flagged_setup_change), returns them
 *    as flaggedBookings, and cancels nothing.
 *  - AC9: venue_change_history records 45 -> 90 and who changed it.
 *
 * Fallbacks, as the other check scripts use them: bookings A and B are
 * inserted directly as approved, because Venue Staff approval (SCRUM-258) is
 * not built; event requests are inserted directly, as check-booking-requests.js
 * does; available_venue_ids is also called as an RPC, as check-venue-blocks.js
 * does, alongside findVenuesForEvent which calls it.
 *
 * It creates throwaway auth users with profiles: a Venue Staff member, two
 * Event Coordinators (one per approved event, so AC8's routing to the assigned
 * coordinator can be told apart) and an Event Organiser
 * (event_requests.organiser_id is NOT NULL). withdraw_booking_request notifies
 * every Venue Staff profile, so real staff get a row for the one withdrawal
 * made here; cleanup deletes notifications by booking id.
 *
 * Times are on the Singapore date 30 days from now, written in +08:00.
 */

import { randomUUID } from 'node:crypto';

import { supabase } from '../src/config/supabaseClient.js';
import {
  createVenue,
  updateVenue,
  getVenueById,
  findVenuesForEvent,
  getVenueHistory,
} from '../src/services/venueService.js';
import {
  createVenueBlock,
  getVenueBlock,
  removeVenueBlock,
} from '../src/services/venueBlockService.js';
import {
  createBookingRequest,
  withdrawBookingRequest,
} from '../src/services/bookingRequestService.js';
import { getVenueCalendar } from '../src/services/venueCalendarService.js';
import { listNotifications } from '../src/services/notificationService.js';
import { ConflictError } from '../src/errors.js';

const STAMP = Date.now();
const NAME = `__check_occupancy_${STAMP}`;
// Unique, so the event search only ever sees this venue.
const LOCATION = `__check_occupancy_location_${STAMP}`;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// D: the Singapore calendar date thirty days out, so every period below is in
// the future (AC8 only re-checks bookings that have not started) and the
// wall-clock times match the worked example exactly.
const D = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Singapore',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date(Date.now() + 30 * DAY));
const at = (hhmm) => `${D}T${hhmm}:00+08:00`;

// Open 08:00-20:00 every day, so findVenuesForEvent's hours check never
// decides an AC4 answer.
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  day_of_week: day,
  opens_at: '08:00',
  closes_at: '20:00',
}));

const users = { staff: null, coordA: null, coordB: null, organiser: null };
let venueId = null;
const eventIds = [];
const bookingIds = new Set();

let failures = 0;

function check(label, passed, detail = '') {
  console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!passed) failures += 1;
}

/** The error a call throws, or null when it resolves. */
async function errorFrom(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

/** Two timestamps name the same instant, whatever offset each is written in. */
function sameInstant(a, b) {
  return a != null && b != null && new Date(a).getTime() === new Date(b).getTime();
}

/** An instant as Singapore wall-clock HH:MM, for readable output. */
function sg(instant) {
  if (instant == null) return String(instant);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Singapore',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(instant));
}

/** The suitability check is N10's and is not built; every venue here passes it. */
const checkSuitability = async () => ({ suitable: true, criteria: [{ criterion: 'capacity', met: true }] });

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/** Confirms 032-034 are applied before anything is written. */
async function preflight() {
  const missing = [];

  // 034 adds review_reason.
  const { error: columnError } = await supabase.from('bookings').select('id, review_reason').limit(1);
  if (columnError) missing.push(`bookings.review_reason (034): ${columnError.message}`);

  // 032: on a venue that cannot exist, the shared function answers no rows.
  // PGRST202 means it is missing.
  const { error: occupancyError } = await supabase.rpc('venue_occupancy_conflicts', {
    p_venue_id: randomUUID(),
    p_starts_at: at('10:00'),
    p_ends_at: at('11:00'),
    p_pad_requested: true,
  });
  if (occupancyError) {
    missing.push(`venue_occupancy_conflicts (032): ${occupancyError.code ?? ''} ${occupancyError.message}`.trim());
  }

  // 033: available_venue_ids over no venues answers no rows.
  const { error: availableError } = await supabase.rpc('available_venue_ids', {
    p_venue_ids: [],
    p_starts_at: at('10:00'),
    p_ends_at: at('11:00'),
  });
  if (availableError) {
    missing.push(`available_venue_ids (033): ${availableError.code ?? ''} ${availableError.message}`.trim());
  }

  // 034: update_venue on a venue that cannot exist must raise no_data_found.
  const { error: updateError } = await supabase.rpc('update_venue', { p_id: randomUUID() });
  if (updateError?.code !== 'P0002') {
    missing.push(
      `update_venue (034): expected P0002, got ${updateError?.code ?? 'no error'} ${updateError?.message ?? ''}`.trim(),
    );
  }

  return missing;
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

/** A throwaway confirmed user, with the profiles row requireAuth reads. */
async function createTestUser(label, role) {
  const { data, error } = await supabase.auth.admin.createUser({
    email: `__check_occupancy_${label}_${STAMP}@example.invalid`,
    email_confirm: true,
  });
  if (error) throw new Error(`could not create test user (${label}): ${error.message}`);

  // Tracked before the profile insert, so cleanup removes the user even if
  // that insert fails.
  users[label] = data.user.id;

  const { error: profileError } = await supabase
    .from('profiles')
    .insert({ id: data.user.id, role, full_name: `Check ${label}` });
  if (profileError) throw new Error(`could not create profile (${label}): ${profileError.message}`);

  return data.user.id;
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

/**
 * An approved booking, inserted directly: Venue Staff approval (SCRUM-258) is
 * not built, so there is no service that produces one.
 */
async function insertApprovedBooking(eventId, startsAt, endsAt) {
  const { data, error } = await supabase
    .from('bookings')
    .insert({
      venue_id: venueId,
      event_request_id: eventId,
      starts_at: startsAt,
      ends_at: endsAt,
      status: 'approved',
    })
    .select('id')
    .single();
  if (error) throw new Error(`could not create test booking: ${error.message}`);
  bookingIds.add(data.id);
  return data.id;
}

async function readBooking(id) {
  const { data, error } = await supabase
    .from('bookings')
    .select('id, starts_at, ends_at, status, review_reason, review_block_id, flagged_at, flagged_by')
    .eq('id', id)
    .single();
  if (error) throw new Error(`could not read booking ${id}: ${error.message}`);
  return data;
}

/** Track bookings a refused request might have left, so cleanup finds them. */
async function trackBookingsOf(eventId) {
  const { data, error } = await supabase.from('bookings').select('id').eq('event_request_id', eventId);
  if (error) throw new Error(`could not read bookings: ${error.message}`);
  for (const row of data ?? []) bookingIds.add(row.id);
  return data ?? [];
}

async function countBlocksOnVenue() {
  const { count, error } = await supabase
    .from('venue_blocks')
    .select('*', { count: 'exact', head: true })
    .eq('venue_id', venueId);
  if (error) throw new Error(`could not count blocks: ${error.message}`);
  return count ?? 0;
}

/** Does findVenuesForEvent offer this venue for the period? */
async function searchOffers(startsAt, endsAt) {
  const found = await findVenuesForEvent({ startsAt, endsAt, expectedAttendance: 10, location: LOCATION });
  return found.some((venue) => venue.id === venueId);
}

/** Does available_venue_ids() (033) answer this venue as free? */
async function rpcSaysFree(startsAt, endsAt) {
  const { data, error } = await supabase.rpc('available_venue_ids', {
    p_venue_ids: [venueId],
    p_starts_at: startsAt,
    p_ends_at: endsAt,
  });
  if (error) throw new Error(`available_venue_ids: ${error.message}`);
  return (data ?? []).some((row) => row.venue_id === venueId);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** Run one cleanup step, logging its own failure so the rest still run. */
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
  // Every booking on the throwaway venue or its events, including any a failed
  // run left half-way.
  for (const eventId of eventIds) {
    try {
      await trackBookingsOf(eventId);
    } catch (err) {
      console.error(`  cleanup: reading bookings failed: ${err.message}`);
      failures += 1;
    }
  }
  if (venueId) {
    const { data, error } = await supabase.from('bookings').select('id').eq('venue_id', venueId);
    if (error) {
      console.error(`  cleanup: reading venue bookings failed: ${error.message}`);
      failures += 1;
    }
    for (const row of data ?? []) bookingIds.add(row.id);
  }
  const bookings = [...bookingIds];

  // Every block ever created on the venue, removed or not.
  let blockIds = [];
  if (venueId) {
    const { data, error } = await supabase.from('venue_blocks').select('id').eq('venue_id', venueId);
    if (error) {
      console.error(`  cleanup: reading blocks failed: ${error.message}`);
      failures += 1;
    }
    blockIds = (data ?? []).map((row) => row.id);
  }

  // 1. Notifications, including the withdrawal notices sent to real Venue
  //    Staff: every one is about a booking or block made here.
  if (bookings.length > 0) {
    await step('notifications by booking', () => supabase.from('notifications').delete().in('booking_id', bookings));
  }
  if (blockIds.length > 0) {
    await step('notifications by block', () => supabase.from('notifications').delete().in('block_id', blockIds));
  }

  // 2. Bookings before blocks (review_block_id) and before events.
  if (bookings.length > 0) {
    await step('bookings', () => supabase.from('bookings').delete().in('id', bookings));
  }

  // 3. Block history before blocks (ON DELETE RESTRICT), blocks before the venue.
  if (blockIds.length > 0) {
    await step('venue_block_history', () => supabase.from('venue_block_history').delete().in('block_id', blockIds));
  }
  if (venueId) {
    await step('venue_blocks', () => supabase.from('venue_blocks').delete().eq('venue_id', venueId));
  }

  // 4. Events, with any assignment history (ON DELETE RESTRICT), before the organiser.
  if (eventIds.length > 0) {
    await step('event_request_assignment_history', () =>
      supabase.from('event_request_assignment_history').delete().in('event_request_id', eventIds));
    await step('event_requests', () => supabase.from('event_requests').delete().in('id', eventIds));
  }

  // 5. Venue history (creation and the AC8 edit) before the venue.
  if (venueId) {
    await step('venue_change_history', () => supabase.from('venue_change_history').delete().eq('venue_id', venueId));
    await step('venues', () => supabase.from('venues').delete().eq('id', venueId));
  }

  // 6. Profiles cascade from auth.users, but are deleted explicitly so a
  //    failure surfaces as its own error.
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
  console.log(`\nVenue occupancy check (D = ${D}, +08:00)\n`);

  // --- preflight: nothing is written unless 032-034 are all there ----------
  const missing = await preflight();
  if (missing.length > 0) {
    for (const line of missing) console.error(`  missing: ${line}`);
    console.error('\nApply migrations 032-034 in the Supabase SQL Editor, then run this again.');
    failures += 1;
    return;
  }
  check('migrations 032-034 are applied', true);

  // --- setup ---------------------------------------------------------------
  const staff = await createTestUser('staff', 'venue_staff');
  const coordA = await createTestUser('coordA', 'event_coordinator');
  const coordB = await createTestUser('coordB', 'event_coordinator');
  await createTestUser('organiser', 'event_organiser');

  // --- 1. AC1/AC2: setup and turnaround are written and read back ---------
  console.log('\n  AC1/AC2 venue setup and turnaround');

  const created = await createVenue(
    { name: NAME, location: LOCATION, maxCapacity: 50, hours: ALL_WEEK, setupMinutes: 30, turnaroundMinutes: 45 },
    staff,
  );
  venueId = created.id;
  check('createVenue returns setup 30 and turnaround 45',
    created.setupMinutes === 30 && created.turnaroundMinutes === 45,
    `${created.setupMinutes}/${created.turnaroundMinutes}`);
  const readBack = await getVenueById(venueId);
  check('getVenueById reads back setup 30 and turnaround 45',
    readBack.setupMinutes === 30 && readBack.turnaroundMinutes === 45,
    `${readBack.setupMinutes}/${readBack.turnaroundMinutes}`);

  // Booking A, 10:00-12:00, occupies [09:30, 12:45).
  const eventA = await makeEvent('A', coordA, at('10:00'), at('12:00'));
  const bookingA = await insertApprovedBooking(eventA, at('10:00'), at('12:00'));

  // --- 2. AC3/AC5: booking requests either side of A's turnaround ---------
  console.log('\n  AC3/AC5 booking request against A (occupies 09:30-12:45)');

  // 13:14-14:00 occupies [12:44, 14:45): one minute into A's turnaround.
  const eventC1 = await makeEvent('C1_1314', coordA, at('13:14'), at('14:00'));
  const refused = await errorFrom(() =>
    createBookingRequest({ eventRequestId: eventC1, venueId }, coordA, { checkSuitability }));
  check('a request at 13:14-14:00 is refused as BOOKING_PERIOD_CONFLICT',
    refused instanceof ConflictError && refused.code === 'BOOKING_PERIOD_CONFLICT',
    `${refused?.constructor?.name} ${refused?.code ?? refused?.message}`);
  const conflictA = refused?.conflicts?.find((c) => c.kind === 'booking' && c.bookingId === bookingA);
  check('the conflict lists exactly A',
    refused?.conflicts?.length === 1 && Boolean(conflictA),
    JSON.stringify(refused?.conflicts?.map((c) => `${c.kind}:${c.bookingId ?? c.blockId}`) ?? null));
  check('with A occupied 09:30-12:45',
    sameInstant(conflictA?.occupiedStartsAt, at('09:30')) && sameInstant(conflictA?.occupiedEndsAt, at('12:45')),
    `${sg(conflictA?.occupiedStartsAt)}-${sg(conflictA?.occupiedEndsAt)}`);
  check('and the venue\'s 30/45 minutes',
    conflictA?.setupMinutes === 30 && conflictA?.turnaroundMinutes === 45,
    `${conflictA?.setupMinutes}/${conflictA?.turnaroundMinutes}`);
  check('nothing was stored for the refused request', (await trackBookingsOf(eventC1)).length === 0);

  // 13:15-14:00 occupies [12:45, 14:45): touches A's end, clear.
  const eventC2 = await makeEvent('C2_1315', coordA, at('13:15'), at('14:00'));
  const requested = await createBookingRequest({ eventRequestId: eventC2, venueId }, coordA, { checkSuitability });
  bookingIds.add(requested.id);
  check('a request at 13:15-14:00 is created, pending', requested.status === 'pending', requested.status);
  await withdrawBookingRequest(requested.id, coordA);
  const withdrawn = await readBooking(requested.id);
  check('and is withdrawn again, so it occupies nothing below', withdrawn.status === 'withdrawn', withdrawn.status);

  // --- 3. AC6: blocks are never padded --------------------------------------
  console.log('\n  AC6 blocks against A');

  const blocksBefore = await countBlocksOnVenue();
  const blockRefused = await errorFrom(() =>
    createVenueBlock(venueId, { startsAt: at('12:00'), endsAt: at('12:45'), reason: 'maintenance' }, staff));
  check('a block at 12:00-12:45 is refused as BLOCK_BOOKING_CONFLICT',
    blockRefused?.status === 409 && blockRefused?.code === 'BLOCK_BOOKING_CONFLICT', blockRefused?.code);
  const blockConflictA = blockRefused?.conflicts?.find((c) => c.bookingId === bookingA);
  check('the conflict lists exactly A',
    blockRefused?.conflicts?.length === 1 && Boolean(blockConflictA),
    JSON.stringify(blockRefused?.conflicts?.map((c) => c.bookingId) ?? null));
  check('with A occupied 09:30-12:45',
    sameInstant(blockConflictA?.occupiedStartsAt, at('09:30')) && sameInstant(blockConflictA?.occupiedEndsAt, at('12:45')),
    `${sg(blockConflictA?.occupiedStartsAt)}-${sg(blockConflictA?.occupiedEndsAt)}`);
  check('no block was written', (await countBlocksOnVenue()) === blocksBefore);

  const blockCreated = await createVenueBlock(
    venueId,
    { startsAt: at('12:45'), endsAt: at('13:30'), reason: 'maintenance' },
    staff,
  );
  const K = blockCreated.block;
  check('a block at 12:45-13:30 is created', Boolean(K?.id));
  check('it flagged nothing', blockCreated.flaggedBookings.length === 0,
    `${blockCreated.flaggedBookings.length} flagged`);
  const storedK = await getVenueBlock(venueId, K.id);
  check('its stored period is exactly as typed, 12:45-13:30',
    sameInstant(storedK.startsAt, at('12:45')) && sameInstant(storedK.endsAt, at('13:30')),
    `${sg(storedK.startsAt)}-${sg(storedK.endsAt)}`);

  // Removed now: an active block at 12:45-13:30 would hide the venue at 13:15
  // (AC4) and would flag A and B on its own in AC8, so neither would prove
  // anything about padding. venue_occupancy_conflicts ignores removed blocks.
  await removeVenueBlock(venueId, K.id, staff);
  const removedK = await getVenueBlock(venueId, K.id);
  check('the block is removed before AC4 and AC8', Boolean(removedK.removedAt), String(removedK.removedAt));

  // --- 4. AC4: search, available_venue_ids and the calendar agree ---------
  console.log('\n  AC4 search and calendar');

  check('findVenuesForEvent leaves the venue out at 13:14-14:00', !(await searchOffers(at('13:14'), at('14:00'))));
  check('findVenuesForEvent offers it at 13:15-14:00', await searchOffers(at('13:15'), at('14:00')));
  check('available_venue_ids leaves it out at 13:14-14:00', !(await rpcSaysFree(at('13:14'), at('14:00'))));
  check('available_venue_ids returns it at 13:15-14:00', await rpcSaysFree(at('13:15'), at('14:00')));

  const dayStart = at('00:00');
  const dayEnd = new Date(Date.parse(dayStart) + DAY).toISOString();
  const calendar = await getVenueCalendar(venueId, { from: dayStart, to: dayEnd });
  const entryA = calendar.find((e) => e.kind === 'booking' && e.id === bookingA);
  check('the calendar for D returns A', Boolean(entryA), `${calendar.length} entries`);
  check('with occupiedStartsAt 09:30 and occupiedEndsAt 12:45',
    sameInstant(entryA?.occupiedStartsAt, at('09:30')) && sameInstant(entryA?.occupiedEndsAt, at('12:45')),
    `${sg(entryA?.occupiedStartsAt)}-${sg(entryA?.occupiedEndsAt)}`);
  check('and its own period 10:00-12:00 unchanged',
    sameInstant(entryA?.startsAt, at('10:00')) && sameInstant(entryA?.endsAt, at('12:00')));
  check('the withdrawn request is not on the calendar',
    !calendar.some((e) => e.kind === 'booking' && e.id === requested.id));

  // --- 5. AC8: a turnaround change re-checks approved bookings ------------
  console.log('\n  AC8 turnaround 45 -> 90');

  // B 13:30-14:30 at 30/45 occupies [13:00, 15:15): 13:00 is after A's 12:45.
  check('13:30-14:30 is free at 30/45 before B is added', await searchOffers(at('13:30'), at('14:30')));
  const eventB = await makeEvent('B', coordB, at('13:30'), at('14:30'));
  const bookingB = await insertApprovedBooking(eventB, at('13:30'), at('14:30'));

  // At 30/90: A occupies [09:30, 13:30), B [13:00, 16:00) -- overlap 13:00-13:30.
  const updated = await updateVenue(venueId, { turnaroundMinutes: 90 }, staff);
  check('updateVenue returns turnaround 90, setup still 30',
    updated.turnaroundMinutes === 90 && updated.setupMinutes === 30,
    `${updated.setupMinutes}/${updated.turnaroundMinutes}`);

  const flagged = updated.flaggedBookings ?? [];
  check('flaggedBookings is exactly A then B',
    flagged.length === 2 && flagged[0].bookingId === bookingA && flagged[1].bookingId === bookingB,
    flagged.map((f) => (f.bookingId === bookingA ? 'A' : f.bookingId === bookingB ? 'B' : f.bookingId)).join(','));
  const fA = flagged.find((f) => f.bookingId === bookingA);
  const fB = flagged.find((f) => f.bookingId === bookingB);
  check('A now occupies 09:30-13:30',
    sameInstant(fA?.occupiedStartsAt, at('09:30')) && sameInstant(fA?.occupiedEndsAt, at('13:30')),
    `${sg(fA?.occupiedStartsAt)}-${sg(fA?.occupiedEndsAt)}`);
  check('B now occupies 13:00-16:00',
    sameInstant(fB?.occupiedStartsAt, at('13:00')) && sameInstant(fB?.occupiedEndsAt, at('16:00')),
    `${sg(fB?.occupiedStartsAt)}-${sg(fB?.occupiedEndsAt)}`);
  check('each carries the new 30/90 minutes',
    flagged.every((f) => f.setupMinutes === 30 && f.turnaroundMinutes === 90));

  for (const [label, id, start, end] of [
    ['A', bookingA, at('10:00'), at('12:00')],
    ['B', bookingB, at('13:30'), at('14:30')],
  ]) {
    const row = await readBooking(id);
    check(`${label} is flagged_for_review, not cancelled`, row.status === 'flagged_for_review', row.status);
    check(`${label} has review_reason setup_or_turnaround_changed and no block`,
      row.review_reason === 'setup_or_turnaround_changed' && row.review_block_id === null,
      `${row.review_reason}, block ${row.review_block_id}`);
    check(`${label} was flagged by the staff member, with flagged_at set`,
      row.flagged_by === staff && Boolean(row.flagged_at));
    check(`${label}'s own period is unchanged`,
      sameInstant(row.starts_at, start) && sameInstant(row.ends_at, end),
      `${sg(row.starts_at)}-${sg(row.ends_at)}`);
  }

  const { data: sent, error: sentError } = await supabase
    .from('notifications')
    .select('recipient_id, booking_id, payload')
    .in('booking_id', [bookingA, bookingB])
    .eq('type', 'booking_flagged_setup_change');
  if (sentError) throw new Error(`could not read notifications: ${sentError.message}`);
  const sentA = (sent ?? []).filter((n) => n.booking_id === bookingA);
  const sentB = (sent ?? []).filter((n) => n.booking_id === bookingB);
  check('one booking_flagged_setup_change per flagged booking',
    sentA.length === 1 && sentB.length === 1, `A ${sentA.length}, B ${sentB.length}`);
  check('A\'s goes to A\'s coordinator, B\'s to B\'s',
    sentA[0]?.recipient_id === coordA && sentB[0]?.recipient_id === coordB);
  check('the payload gives the reason', sentA[0]?.payload?.reason === 'Setup or turnaround time changed',
    sentA[0]?.payload?.reason);

  const inboxA = await listNotifications(coordA);
  check('coordinator A\'s inbox shows the flag for A only',
    inboxA.some((n) => n.type === 'booking_flagged_setup_change' && n.bookingId === bookingA)
      && !inboxA.some((n) => n.bookingId === bookingB),
    `${inboxA.length} in inbox`);

  const { count: cancelledCount, error: cancelledError } = await supabase
    .from('bookings')
    .select('*', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .eq('status', 'cancelled');
  if (cancelledError) throw new Error(`could not count cancelled bookings: ${cancelledError.message}`);
  check('nothing on the venue was cancelled', cancelledCount === 0, `${cancelledCount} cancelled`);
  check('the withdrawn request is still withdrawn', (await readBooking(requested.id)).status === 'withdrawn');

  // --- 6. AC9: the change is in the venue history -------------------------
  console.log('\n  AC9 history');

  const history = await getVenueHistory(venueId);
  const turnaroundRow = history.find((h) => h.newValues?.turnaround_minutes === 90);
  check('a history row records the turnaround change', Boolean(turnaroundRow), `${history.length} rows`);
  check('old 45, new 90',
    turnaroundRow?.oldValues?.turnaround_minutes === 45 && turnaroundRow?.newValues?.turnaround_minutes === 90,
    JSON.stringify({ old: turnaroundRow?.oldValues, new: turnaroundRow?.newValues }));
  check('and only the turnaround changed',
    Object.keys(turnaroundRow?.newValues ?? {}).join(',') === 'turnaround_minutes');
  check('changed_by is the staff member', turnaroundRow?.changedBy === staff);
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
    console.log('\nAll checks passed. Padded, refused, searched, re-checked, flagged, audited, cleaned up.\n');
  });
