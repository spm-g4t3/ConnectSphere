/**
 * End-to-end proof for a venue's emergency access and known restrictions
 * (SCRUM-493, sub-task 5).
 *
 * Run with: npm run venue-safety-facts:check
 *
 * Requires migrations 032 to 036 (032_venue_occupancy.sql,
 * 033_venue_occupancy_callers.sql, 034_setup_change_recheck.sql,
 * 035_setup_change_recheck_refine.sql, 036_venue_safety_facts.sql) applied in
 * the Supabase SQL Editor. 036 replaces 035's update_venue, so 032-035 must be
 * in place first. The preflight checks that 036 is there -- both columns, and
 * update_venue taking p_emergency_access -- and nothing is written until it
 * passes. Exits non-zero on any failure.
 *
 * Drives the real venueService -- createVenue, updateVenue, getVenueById,
 * getVenueHistory and retireVenue -- against the live database, then removes
 * everything it created.
 *
 *  - AC1/AC2: a venue created with emergency access "  Exit A to car park \n"
 *    and no known restrictions reads back as "Exit A to car park", with
 *    knownRestrictions null ("not recorded").
 *  - AC4: an edit to only the known restrictions leaves exactly one new
 *    venue_change_history row, holding only known_restrictions (old null, new
 *    the text) and the Venue Staff member who made it.
 *  - Clearing: an edit with emergency access "" stores NULL, and reads null.
 *  - AC6: on a second venue at setup 30 / turnaround 45, two approved bookings
 *    that already clash (10:00-12:00 occupies to 12:45, 12:30-14:00 from
 *    12:00) are left alone by a text-only edit: flaggedBookings is [], both
 *    stay approved, and neither booking has a notification.
 *  - AC5: the first venue's emergency access is saved again as "Exit B to
 *    the field", then the venue is retired; getVenueById still returns both
 *    "Exit B to the field" and "No open flames".
 *
 * Fallbacks, as check-venue-occupancy.js uses them: the two approved bookings
 * and their events are inserted directly, because Venue Staff approval
 * (SCRUM-258) is not built and event requests have no service that produces
 * an approved, assigned one.
 *
 * It creates throwaway auth users with profiles: a Venue Staff member, an
 * Event Coordinator (assigned to both events, so a stray notification would
 * have a recipient) and an Event Organiser (event_requests.organiser_id is
 * NOT NULL).
 *
 * Times are on the Singapore date 30 days from now, written in +08:00.
 */

import { randomUUID } from 'node:crypto';

import { supabase } from '../src/config/supabaseClient.js';
import {
  createVenue,
  updateVenue,
  getVenueById,
  getVenueHistory,
  retireVenue,
} from '../src/services/venueService.js';

const STAMP = Date.now();
const NAME = `__check_safety_facts_${STAMP}`;
const LOCATION = `__check_safety_facts_location_${STAMP}`;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// D: the Singapore calendar date thirty days out, so both bookings are in the
// future -- update_venue only ever re-checks bookings that have not started,
// so a past pair would prove nothing about AC6.
const D = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Singapore',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date(Date.now() + 30 * DAY));
const at = (hhmm) => `${D}T${hhmm}:00+08:00`;

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  day_of_week: day,
  opens_at: '08:00',
  closes_at: '20:00',
}));

const users = { staff: null, coord: null, organiser: null };
const venueIds = [];
const eventIds = [];
const bookingIds = new Set();

let failures = 0;

function check(label, passed, detail = '') {
  console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!passed) failures += 1;
}

/** JSON for readable output, including undefined. */
const show = (value) => (value === undefined ? 'undefined' : JSON.stringify(value));

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/** Confirms 036 is applied before anything is written. */
async function preflight() {
  const missing = [];

  // 036 adds both columns. limit(0) reads no rows, only whether they exist.
  const { error: columnError } = await supabase
    .from('venues')
    .select('id, emergency_access, known_restrictions')
    .limit(0);
  if (columnError) {
    missing.push(`venues.emergency_access / known_restrictions (036): ${columnError.message}`);
  }

  // 036: update_venue takes p_emergency_access. On a venue that cannot exist
  // it must raise no_data_found; PGRST202 ("could not find the function")
  // means the old signature is still deployed.
  const { error: updateError } = await supabase.rpc('update_venue', {
    p_id: randomUUID(),
    p_emergency_access: 'preflight',
  });
  if (updateError?.code !== 'P0002') {
    missing.push(
      `update_venue with p_emergency_access (036): expected P0002, got ${updateError?.code ?? 'no error'} ${updateError?.message ?? ''}`.trim(),
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
    email: `__check_safety_facts_${label}_${STAMP}@example.invalid`,
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

/** createVenue, tracking the id for cleanup. */
async function makeVenue(input, staff) {
  const created = await createVenue(input, staff);
  venueIds.push(created.id);
  return created;
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
async function insertApprovedBooking(venueId, eventId, startsAt, endsAt) {
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
    .select('id, status, review_reason, flagged_at')
    .eq('id', id)
    .single();
  if (error) throw new Error(`could not read booking ${id}: ${error.message}`);
  return data;
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
  // Every booking on the throwaway venues or events, including any a failed
  // run left half-way.
  if (eventIds.length > 0) {
    const { data, error } = await supabase.from('bookings').select('id').in('event_request_id', eventIds);
    if (error) {
      console.error(`  cleanup: reading event bookings failed: ${error.message}`);
      failures += 1;
    }
    for (const row of data ?? []) bookingIds.add(row.id);
  }
  if (venueIds.length > 0) {
    const { data, error } = await supabase.from('bookings').select('id').in('venue_id', venueIds);
    if (error) {
      console.error(`  cleanup: reading venue bookings failed: ${error.message}`);
      failures += 1;
    }
    for (const row of data ?? []) bookingIds.add(row.id);
  }
  const bookings = [...bookingIds];

  // Blocks are never made here, but a venue cannot be deleted while one
  // references it, so any found are removed with their history.
  let blockIds = [];
  if (venueIds.length > 0) {
    const { data, error } = await supabase.from('venue_blocks').select('id').in('venue_id', venueIds);
    if (error) {
      console.error(`  cleanup: reading blocks failed: ${error.message}`);
      failures += 1;
    }
    blockIds = (data ?? []).map((row) => row.id);
  }

  // 1. Notifications (AC6 expects none, but a failed run may have left some).
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

  // 3. Block history before blocks (ON DELETE RESTRICT), blocks before the venues.
  if (blockIds.length > 0) {
    await step('venue_block_history', () => supabase.from('venue_block_history').delete().in('block_id', blockIds));
    await step('venue_blocks', () => supabase.from('venue_blocks').delete().in('id', blockIds));
  }

  // 4. Events, with any assignment history (ON DELETE RESTRICT), before the organiser.
  if (eventIds.length > 0) {
    await step('event_request_assignment_history', () =>
      supabase.from('event_request_assignment_history').delete().in('event_request_id', eventIds));
    await step('event_requests', () => supabase.from('event_requests').delete().in('id', eventIds));
  }

  // 5. Venue history (creation, the edits and the retirement) before the venues.
  if (venueIds.length > 0) {
    await step('venue_change_history', () => supabase.from('venue_change_history').delete().in('venue_id', venueIds));
    await step('venues', () => supabase.from('venues').delete().in('id', venueIds));
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
  console.log(`\nVenue safety facts check (D = ${D}, +08:00)\n`);

  // --- preflight: nothing is written unless 036 is there -------------------
  const missing = await preflight();
  if (missing.length > 0) {
    for (const line of missing) console.error(`  missing: ${line}`);
    console.error('\nApply migrations 032-036 in the Supabase SQL Editor, then run this again.');
    failures += 1;
    return;
  }
  check('migration 036 is applied', true);

  // --- setup ---------------------------------------------------------------
  const staff = await createTestUser('staff', 'venue_staff');
  const coord = await createTestUser('coord', 'event_coordinator');
  await createTestUser('organiser', 'event_organiser');

  // --- 1. AC1/AC2: create, trimmed, and "not recorded" ---------------------
  console.log('\n  AC1/AC2 create with emergency access, no restrictions');

  const created = await makeVenue(
    {
      name: `${NAME}_V1`,
      location: LOCATION,
      maxCapacity: 50,
      hours: ALL_WEEK,
      emergencyAccess: '  Exit A to car park \n',
    },
    staff,
  );
  const v1 = created.id;
  check('createVenue returns emergencyAccess trimmed',
    created.emergencyAccess === 'Exit A to car park', show(created.emergencyAccess));
  check('and knownRestrictions null', created.knownRestrictions === null, show(created.knownRestrictions));

  const readBack = await getVenueById(v1);
  check('getVenueById reads back "Exit A to car park"',
    readBack.emergencyAccess === 'Exit A to car park', show(readBack.emergencyAccess));
  check('getVenueById reads knownRestrictions as null (not recorded)',
    readBack.knownRestrictions === null, show(readBack.knownRestrictions));

  // --- 2. AC4: one history row for a restrictions-only edit ---------------
  console.log('\n  AC4 edit only the known restrictions');

  const historyBefore = await getVenueHistory(v1);
  const beforeIds = new Set(historyBefore.map((h) => h.id));
  const restricted = await updateVenue(v1, { knownRestrictions: 'No open flames' }, staff);
  check('updateVenue returns knownRestrictions "No open flames"',
    restricted.knownRestrictions === 'No open flames', show(restricted.knownRestrictions));
  check('and keeps emergencyAccess', restricted.emergencyAccess === 'Exit A to car park',
    show(restricted.emergencyAccess));

  const historyAfter = await getVenueHistory(v1);
  const newRows = historyAfter.filter((h) => !beforeIds.has(h.id));
  check('exactly one new venue_change_history row', newRows.length === 1, `${newRows.length} new`);
  const row = newRows[0];
  check('old_values holds only known_restrictions, null',
    Object.keys(row?.oldValues ?? {}).join(',') === 'known_restrictions'
      && row?.oldValues?.known_restrictions === null,
    show(row?.oldValues));
  check('new_values holds only known_restrictions, "No open flames"',
    Object.keys(row?.newValues ?? {}).join(',') === 'known_restrictions'
      && row?.newValues?.known_restrictions === 'No open flames',
    show(row?.newValues));
  check('changedBy is the staff member', row?.changedBy === staff, show(row?.changedBy));

  // --- 3. Clearing: "" stores NULL -----------------------------------------
  console.log('\n  Clear emergency access with ""');

  const cleared = await updateVenue(v1, { emergencyAccess: '' }, staff);
  check('updateVenue returns emergencyAccess null', cleared.emergencyAccess === null, show(cleared.emergencyAccess));
  const clearedRead = await getVenueById(v1);
  check('getVenueById reads emergencyAccess as null', clearedRead.emergencyAccess === null,
    show(clearedRead.emergencyAccess));
  check('and still has knownRestrictions "No open flames"', clearedRead.knownRestrictions === 'No open flames',
    show(clearedRead.knownRestrictions));

  // --- 4. AC6: a text-only edit never re-checks bookings ------------------
  console.log('\n  AC6 text-only edit on a venue with an existing clash (30/45)');

  const second = await makeVenue(
    {
      name: `${NAME}_V2`,
      location: LOCATION,
      maxCapacity: 50,
      hours: ALL_WEEK,
      setupMinutes: 30,
      turnaroundMinutes: 45,
    },
    staff,
  );
  const v2 = second.id;
  check('second venue is at setup 30, turnaround 45',
    second.setupMinutes === 30 && second.turnaroundMinutes === 45,
    `${second.setupMinutes}/${second.turnaroundMinutes}`);

  // P occupies [09:30, 12:45), Q [12:00, 14:45): they already overlap.
  const eventP = await makeEvent('P', coord, at('10:00'), at('12:00'));
  const eventQ = await makeEvent('Q', coord, at('12:30'), at('14:00'));
  const bookingP = await insertApprovedBooking(v2, eventP, at('10:00'), at('12:00'));
  const bookingQ = await insertApprovedBooking(v2, eventQ, at('12:30'), at('14:00'));

  const textOnly = await updateVenue(
    v2,
    { emergencyAccess: 'Exit B via loading bay', knownRestrictions: 'No amplified sound after 22:00' },
    staff,
  );
  check('updateVenue saves both texts',
    textOnly.emergencyAccess === 'Exit B via loading bay'
      && textOnly.knownRestrictions === 'No amplified sound after 22:00');
  check('flaggedBookings is []',
    Array.isArray(textOnly.flaggedBookings) && textOnly.flaggedBookings.length === 0,
    show(textOnly.flaggedBookings));

  for (const [label, id] of [['10:00-12:00', bookingP], ['12:30-14:00', bookingQ]]) {
    const b = await readBooking(id);
    check(`booking ${label} is still approved, never flagged`,
      b.status === 'approved' && b.review_reason === null && b.flagged_at === null,
      `${b.status}, ${b.review_reason}, ${b.flagged_at}`);
  }

  const { data: sent, error: sentError } = await supabase
    .from('notifications')
    .select('id, type, booking_id')
    .in('booking_id', [bookingP, bookingQ]);
  if (sentError) throw new Error(`could not read notifications: ${sentError.message}`);
  check('no notification exists for either booking', (sent ?? []).length === 0,
    `${(sent ?? []).length} found`);

  // --- 5. AC5: retiring keeps both fields ----------------------------------
  console.log('\n  AC5 retire the first venue');

  // Both fields hold text before the retire, so AC5 shows text surviving in
  // each, not just a null.
  const resaved = await updateVenue(v1, { emergencyAccess: 'Exit B to the field' }, staff);
  check('emergencyAccess is saved again as "Exit B to the field" before retiring',
    resaved.emergencyAccess === 'Exit B to the field', show(resaved.emergencyAccess));

  const retired = await retireVenue(v1, staff);
  check('retireVenue sets retiredAt', Boolean(retired.retiredAt), show(retired.retiredAt));
  const retiredRead = await getVenueById(v1);
  check('getVenueById still returns the retired venue', Boolean(retiredRead.retiredAt));
  check('with emergencyAccess as last saved, "Exit B to the field"',
    retiredRead.emergencyAccess === 'Exit B to the field', show(retiredRead.emergencyAccess));
  check('and knownRestrictions as last saved, "No open flames"',
    retiredRead.knownRestrictions === 'No open flames', show(retiredRead.knownRestrictions));
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
    console.log('\nAll checks passed. Trimmed, audited, cleared, left unflagged, retired, cleaned up.\n');
  });
