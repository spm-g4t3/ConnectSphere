/**
 * End-to-end proof for venue blocks (SCRUM-17, checked by SCRUM-132).
 *
 * Run with: npm run venue-blocks:check
 *
 * Drives the real services -- venueBlockService, notificationService and
 * venueService -- against the live database, through the functions and
 * triggers in 011-016, then removes everything it created.
 *
 * This is the counterpart to the unit and flow suites, which mock Supabase.
 * Those prove the services send the right RPC with the right arguments and
 * translate what comes back. Only this script can show what the database
 * itself does with them:
 *
 *  - that periods really are half-open, so a block touching a booking or
 *    another block at its edge is not a conflict (013, 011's exclusion);
 *  - that an override really flags the booking, records which block and
 *    which user flagged it, and notifies every Event Coordinator (014);
 *  - that a flagged booking no longer conflicts, so an amendment does not
 *    list it again (015);
 *  - that amend and remove record the amending user, refuse an ended or
 *    removed block, and leave flagged bookings flagged (015);
 *  - that the audit trigger writes the trail in the right order with the
 *    right authors (016);
 *  - that search and the calendar window leave a blocked venue out (SCRUM-130);
 *  - and that nothing here ever moves a booking's own period.
 *
 * It creates four throwaway auth users with profiles: two Venue Staff (so the
 * amending user can be told apart from the creator), an Event Coordinator
 * (to read a notification) and an Event Organiser (event_requests.organiser_id
 * is NOT NULL).
 *
 * Exits non-zero on any failure.
 */

import { randomUUID } from 'node:crypto';

import { supabase } from '../src/config/supabaseClient.js';
import { createVenue, searchVenues } from '../src/services/venueService.js';
import {
  createVenueBlock,
  listVenueBlocks,
  findBlockedVenueIds,
  getVenueBlock,
  updateVenueBlock,
  removeVenueBlock,
  getVenueBlockHistory,
} from '../src/services/venueBlockService.js';
import { listNotifications } from '../src/services/notificationService.js';

const STAMP = Date.now();
const NAME = `__check_blocks_${STAMP}`;
// Unique, so the search checks only ever see this venue.
const LOCATION = `__check_blocks_location_${STAMP}`;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// D: thirty days out, on the hour, so every period below is in the future
// and reads cleanly in the output.
const D = Math.floor((Date.now() + 30 * DAY) / HOUR) * HOUR;
const at = (hours) => new Date(D + hours * HOUR).toISOString();

const users = { staff1: null, staff2: null, coordinator: null, organiser: null };
let venueId = null;
let eventId = null;
const bookingIds = [];

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

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/**
 * Confirms 011-016 are applied before anything is written. Returns a list of
 * what is missing; empty means go.
 */
async function preflight() {
  const missing = [];

  for (const [table, columns] of [
    ['venue_blocks', 'id'],
    ['notifications', 'id'],
    ['venue_block_history', 'id'],
    ['bookings', 'status, review_block_id, flagged_at, flagged_by'],
  ]) {
    const { error } = await supabase.from(table).select(columns).limit(1);
    if (error) missing.push(`${table} (${columns}): ${error.message}`);
  }

  // update_venue_block (015) on a venue that cannot exist must raise
  // no_data_found. Any other answer -- PGRST202 above all -- means the
  // function is missing or out of date. Every parameter is named so the call
  // resolves to the 015 signature and nothing else.
  const { error: rpcError } = await supabase.rpc('update_venue_block', {
    p_venue_id: randomUUID(),
    p_block_id: randomUUID(),
    p_starts_at: null,
    p_ends_at: null,
    p_reason: null,
    p_notes: null,
    p_notes_supplied: false,
    p_user_id: null,
    p_confirm_override: false,
    p_acknowledged_booking_ids: [],
  });
  if (rpcError?.code !== 'P0002') {
    missing.push(
      `update_venue_block: expected P0002, got ${rpcError?.code ?? 'no error'} ` +
        `${rpcError?.message ?? ''}`.trim(),
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
    email: `__check_blocks_${label}_${STAMP}@example.invalid`,
    email_confirm: true,
  });
  if (error) throw new Error(`could not create test user (${label}): ${error.message}`);

  // Tracked before the profile insert, so cleanup removes the user even if
  // that insert fails.
  users[label] = data.user.id;

  const { error: profileError } = await supabase
    .from('profiles')
    .insert({ id: data.user.id, role, full_name: `Check ${label}` });
  if (profileError) {
    throw new Error(`could not create profile (${label}): ${profileError.message}`);
  }

  return data.user.id;
}

async function insertBooking(startsAt, endsAt) {
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
  bookingIds.push(data.id);
  return data.id;
}

async function readBooking(id) {
  const { data, error } = await supabase
    .from('bookings')
    .select('id, starts_at, ends_at, status, review_block_id, flagged_by')
    .eq('id', id)
    .single();
  if (error) throw new Error(`could not read booking ${id}: ${error.message}`);
  return data;
}

async function countBlocksOnVenue() {
  const { count, error } = await supabase
    .from('venue_blocks')
    .select('*', { count: 'exact', head: true })
    .eq('venue_id', venueId);
  if (error) throw new Error(`could not count blocks: ${error.message}`);
  return count ?? 0;
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
  // Every block ever created on the throwaway venue, removed or not, including
  // any a failed run left half-way.
  let blockIds = [];
  if (venueId) {
    const { data, error } = await supabase
      .from('venue_blocks')
      .select('id')
      .eq('venue_id', venueId);
    if (error) {
      console.error(`  cleanup: reading blocks failed: ${error.message}`);
      failures += 1;
    }
    blockIds = (data ?? []).map((row) => row.id);
  }

  // 1. Notifications, including those sent to real coordinators on the
  //    project: every one is about a booking or block made here.
  if (blockIds.length > 0) {
    await step('notifications by block', () =>
      supabase.from('notifications').delete().in('block_id', blockIds));
  }
  if (bookingIds.length > 0) {
    await step('notifications by booking', () =>
      supabase.from('notifications').delete().in('booking_id', bookingIds));
  }

  // 2. Bookings BEFORE blocks. review_block_id is ON DELETE SET NULL, and 014
  //    pairs it with flagged_at, so deleting a block that flagged a booking
  //    would null one but not the other and the check would refuse the delete.
  if (bookingIds.length > 0) {
    await step('bookings', () => supabase.from('bookings').delete().in('id', bookingIds));
  }

  // 3. History before blocks: venue_block_history.block_id is ON DELETE RESTRICT.
  if (blockIds.length > 0) {
    await step('venue_block_history', () =>
      supabase.from('venue_block_history').delete().in('block_id', blockIds));
  }

  // 4. Blocks before the venue: venue_blocks.venue_id is ON DELETE RESTRICT.
  if (venueId) {
    await step('venue_blocks', () => supabase.from('venue_blocks').delete().eq('venue_id', venueId));
  }

  // 5. The event request before the organiser: organiser_id is ON DELETE RESTRICT.
  if (eventId) {
    await step('event_requests', () => supabase.from('event_requests').delete().eq('id', eventId));
  }

  // 6-7. Venue history (008 records the creation) before the venue.
  if (venueId) {
    await step('venue_change_history', () =>
      supabase.from('venue_change_history').delete().eq('venue_id', venueId));
    await step('venues', () => supabase.from('venues').delete().eq('id', venueId));
  }

  // 8-9. Profiles cascade from auth.users, but are deleted explicitly so a
  //      failure surfaces as its own error.
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
  console.log('\nVenue blocks check\n');

  // --- preflight: nothing is written unless 011-016 are all there ----------
  const missing = await preflight();
  if (missing.length > 0) {
    for (const line of missing) console.error(`  missing: ${line}`);
    console.error('\nApply migrations 011-016 in the Supabase SQL Editor, then run this again.');
    failures += 1;
    return;
  }
  check('migrations 011-016 are applied', true);

  // --- setup ---------------------------------------------------------------
  const staff1 = await createTestUser('staff1', 'venue_staff');
  const staff2 = await createTestUser('staff2', 'venue_staff');
  const coordinator = await createTestUser('coordinator', 'event_coordinator');
  const organiser = await createTestUser('organiser', 'event_organiser');

  const venue = await createVenue({ name: NAME, location: LOCATION, maxCapacity: 30 }, staff1);
  venueId = venue.id;

  const { data: event, error: eventError } = await supabase
    .from('event_requests')
    .insert({ organiser_id: organiser, event_name: `${NAME}_event` })
    .select('id')
    .single();
  if (eventError) throw new Error(`could not create test event request: ${eventError.message}`);
  eventId = event.id;

  const B1 = { start: at(10), end: at(12) };
  const B2 = { start: at(14), end: at(16) };
  const b1 = await insertBooking(B1.start, B1.end);
  const b2 = await insertBooking(B2.start, B2.end);

  // --- 1. AC1: validation, creation, half-open edges, block-on-block -------
  console.log('\n  AC1 create');

  const blocksBefore = await countBlocksOnVenue();
  const invalid = await errorFrom(() =>
    createVenueBlock(venueId, { startsAt: at(9), endsAt: at(8), reason: 'maintenance' }, staff1));
  check('a reversed period is refused with ValidationError', invalid?.status === 400,
    `status ${invalid?.status}`);
  const invalidOther = await errorFrom(() =>
    createVenueBlock(venueId, { startsAt: at(8), endsAt: at(9), reason: 'other' }, staff1));
  check('"other" without notes is refused with ValidationError', invalidOther?.status === 400,
    `status ${invalidOther?.status}`);
  check('nothing was written by a refused request', (await countBlocksOnVenue()) === blocksBefore);

  // X ends exactly where B1 starts: touching is not overlapping.
  const createdX = await createVenueBlock(
    venueId,
    { startsAt: at(8), endsAt: at(10), reason: 'maintenance', notes: 'Aircon service' },
    staff1,
  );
  const X = createdX.block;
  check('block X touching B1 at its edge is created with no conflict', Boolean(X.id));
  check('X flagged nothing', createdX.flaggedBookings.length === 0,
    `${createdX.flaggedBookings.length} flagged`);
  check('X records its creator', X.createdBy === staff1 && X.lastModifiedBy === staff1);

  const overlapsX = await errorFrom(() =>
    createVenueBlock(venueId, { startsAt: at(9), endsAt: at(11), reason: 'safety' }, staff1));
  check('a block overlapping X is refused with BLOCK_OVERLAPS_BLOCK',
    overlapsX?.status === 409 && overlapsX?.code === 'BLOCK_OVERLAPS_BLOCK', overlapsX?.code);
  check('and names X as the clashing block', overlapsX?.conflicts?.[0]?.blockId === X.id,
    JSON.stringify(overlapsX?.conflicts ?? null));

  // --- 2. AC3: conflict with no override writes nothing --------------------
  console.log('\n  AC3 conflict');

  const mInput = { startsAt: at(10), endsAt: at(13), reason: 'renovation' };
  const conflict = await errorFrom(() => createVenueBlock(venueId, mInput, staff1));
  check('M over B1 without override answers BLOCK_BOOKING_CONFLICT',
    conflict?.status === 409 && conflict?.code === 'BLOCK_BOOKING_CONFLICT', conflict?.code);
  check('the conflict lists exactly B1',
    conflict?.conflicts?.length === 1 && conflict.conflicts[0].bookingId === b1,
    JSON.stringify(conflict?.conflicts?.map((c) => c.bookingId) ?? null));
  check('no block was written', (await countBlocksOnVenue()) === 1);
  check('B1 is still approved', (await readBooking(b1)).status === 'approved');

  // --- 3. AC3: override flags B1 and notifies every coordinator ------------
  console.log('\n  AC3 override');

  const { count: coordinatorCount, error: coordinatorError } = await supabase
    .from('profiles')
    .select('*', { count: 'exact', head: true })
    .eq('role', 'event_coordinator');
  if (coordinatorError) throw new Error(`could not count coordinators: ${coordinatorError.message}`);

  const createdM = await createVenueBlock(
    venueId,
    { ...mInput, confirmOverride: true, acknowledgedBookingIds: [b1] },
    staff1,
  );
  const M = createdM.block;
  check('M is created with the override', Boolean(M.id));
  check('M reports B1 as flagged',
    createdM.flaggedBookings.length === 1 && createdM.flaggedBookings[0].bookingId === b1,
    JSON.stringify(createdM.flaggedBookings.map((f) => f.bookingId)));

  const b1Flagged = await readBooking(b1);
  check('B1 is flagged_for_review', b1Flagged.status === 'flagged_for_review', b1Flagged.status);
  check('B1 points at M', b1Flagged.review_block_id === M.id);
  check('B1 was flagged by staff1', b1Flagged.flagged_by === staff1);

  const { count: sentCount, error: sentError } = await supabase
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .eq('block_id', M.id)
    .eq('booking_id', b1);
  if (sentError) throw new Error(`could not count notifications: ${sentError.message}`);
  check('one notification per Event Coordinator', sentCount === coordinatorCount,
    `${sentCount} sent, ${coordinatorCount} coordinators`);

  const inbox = await listNotifications(coordinator);
  check('the coordinator sees booking_flagged for B1 and M',
    inbox.some((n) => n.type === 'booking_flagged' && n.bookingId === b1 && n.blockId === M.id),
    `${inbox.length} in inbox`);

  // --- 4. AC4: staff2 shortens M; flagged B1 no longer conflicts -----------
  console.log('\n  AC4 shorten');

  const shortened = await updateVenueBlock(venueId, M.id, { endsAt: at(12) }, staff2);
  check('shortening M raises no conflict', sameInstant(shortened.block.endsAt, at(12)),
    shortened.block.endsAt);
  check('a flagged booking is not listed or flagged again', shortened.flaggedBookings.length === 0,
    `${shortened.flaggedBookings.length} flagged`);
  check('lastModifiedBy is staff2', shortened.block.lastModifiedBy === staff2);
  check('createdBy is still staff1', shortened.block.createdBy === staff1);

  // --- 5. AC4: extend M over B2 --------------------------------------------
  console.log('\n  AC4 extend');

  const extendConflict = await errorFrom(() =>
    updateVenueBlock(venueId, M.id, { endsAt: at(15) }, staff2));
  check('extending over B2 answers BLOCK_BOOKING_CONFLICT',
    extendConflict?.code === 'BLOCK_BOOKING_CONFLICT', extendConflict?.code);
  check('the conflict lists only B2',
    extendConflict?.conflicts?.length === 1 && extendConflict.conflicts[0].bookingId === b2,
    JSON.stringify(extendConflict?.conflicts?.map((c) => c.bookingId) ?? null));

  const extended = await updateVenueBlock(
    venueId,
    M.id,
    { endsAt: at(15), confirmOverride: true, acknowledgedBookingIds: [b2] },
    staff2,
  );
  check('the override extends M', sameInstant(extended.block.endsAt, at(15)), extended.block.endsAt);
  check('B2 is reported flagged',
    extended.flaggedBookings.length === 1 && extended.flaggedBookings[0].bookingId === b2);
  const b2Flagged = await readBooking(b2);
  check('B2 is flagged_for_review by staff2',
    b2Flagged.status === 'flagged_for_review' && b2Flagged.flagged_by === staff2
      && b2Flagged.review_block_id === M.id,
    `${b2Flagged.status}, by ${b2Flagged.flagged_by === staff2 ? 'staff2' : b2Flagged.flagged_by}`);

  // --- 6. AC2: the calendar window and search ------------------------------
  console.log('\n  AC2 calendar and search');

  const dayWindow = await listVenueBlocks(venueId, { from: at(0), to: at(24) });
  check('the window lists X then M',
    dayWindow.length === 2 && dayWindow[0].id === X.id && dayWindow[1].id === M.id,
    dayWindow.map((b) => b.id === X.id ? 'X' : b.id === M.id ? 'M' : b.id).join(','));
  check('with their reasons',
    dayWindow[0]?.reason === 'maintenance' && dayWindow[1]?.reason === 'renovation');

  // M is now [D+10h, D+15h); a window starting at its end only touches it.
  const edgeWindow = await listVenueBlocks(venueId, { from: at(15), to: at(16) });
  check('a window touching M\'s end leaves M out', !edgeWindow.some((b) => b.id === M.id),
    `${edgeWindow.length} listed`);

  const blockedDuring = await findBlockedVenueIds(at(11), at(12));
  check('findBlockedVenueIds names the venue during M', blockedDuring.includes(venueId));
  const blockedAfter = await findBlockedVenueIds(at(20), at(21));
  check('and not outside it', !blockedAfter.includes(venueId));

  const searchDuring = await searchVenues({ location: LOCATION, startsAt: at(11), endsAt: at(12) });
  check('search leaves the venue out during M', !searchDuring.some((v) => v.id === venueId),
    `${searchDuring.length} found`);
  const searchAfter = await searchVenues({ location: LOCATION, startsAt: at(20), endsAt: at(21) });
  check('search includes it outside any block', searchAfter.some((v) => v.id === venueId),
    `${searchAfter.length} found`);

  // --- 7. An ended block cannot be amended or removed -----------------------
  console.log('\n  Ended block');

  // Inserted directly: the service and create_venue_block both refuse a
  // block that has already ended, which is exactly the point.
  const eStart = new Date(Date.now() - 10 * DAY).toISOString();
  const eEnd = new Date(Date.now() - 10 * DAY + 2 * HOUR).toISOString();
  const { data: E, error: eError } = await supabase
    .from('venue_blocks')
    .insert({
      venue_id: venueId,
      starts_at: eStart,
      ends_at: eEnd,
      reason: 'maintenance',
      created_by: staff1,
      last_modified_by: staff1,
    })
    .select('id')
    .single();
  if (eError) throw new Error(`could not insert ended block: ${eError.message}`);

  const amendEnded = await errorFrom(() =>
    updateVenueBlock(venueId, E.id, { reason: 'safety' }, staff2));
  check('amending an ended block answers BLOCK_ENDED', amendEnded?.code === 'BLOCK_ENDED',
    amendEnded?.code);
  const removeEnded = await errorFrom(() => removeVenueBlock(venueId, E.id, staff2));
  check('removing an ended block answers BLOCK_ENDED', removeEnded?.code === 'BLOCK_ENDED',
    removeEnded?.code);

  const pastWindow = await listVenueBlocks(venueId, {
    from: new Date(Date.now() - 11 * DAY).toISOString(),
    to: new Date(Date.now() - 9 * DAY).toISOString(),
  });
  check('a past window still lists the ended block', pastWindow.some((b) => b.id === E.id),
    `${pastWindow.length} listed`);

  // --- 8. AC4: staff2 removes M --------------------------------------------
  console.log('\n  AC4 remove');

  await removeVenueBlock(venueId, M.id, staff2);
  const removedM = await getVenueBlock(venueId, M.id);
  check('removedAt is set', Boolean(removedM.removedAt), String(removedM.removedAt));
  check('removedBy is staff2', removedM.removedBy === staff2);

  const activeAfter = await listVenueBlocks(venueId);
  check('M is gone from the active list', !activeAfter.some((b) => b.id === M.id),
    `${activeAfter.length} active`);

  const searchRemoved = await searchVenues({ location: LOCATION, startsAt: at(11), endsAt: at(12) });
  check('search includes the venue again in M\'s old period',
    searchRemoved.some((v) => v.id === venueId), `${searchRemoved.length} found`);

  const b1After = await readBooking(b1);
  const b2After = await readBooking(b2);
  check('B1 and B2 are still flagged after removal',
    b1After.status === 'flagged_for_review' && b2After.status === 'flagged_for_review',
    `${b1After.status}, ${b2After.status}`);

  const removeAgain = await errorFrom(() => removeVenueBlock(venueId, M.id, staff2));
  check('removing again answers BLOCK_REMOVED', removeAgain?.code === 'BLOCK_REMOVED',
    removeAgain?.code);

  // --- 9. AC4: the history ---------------------------------------------------
  console.log('\n  AC4 history');

  const history = await getVenueBlockHistory(venueId, M.id);
  const who = (id) =>
    Object.entries(users).find(([, userId]) => userId === id)?.[0] ?? String(id);
  check('actions are removed, amended, amended, created',
    history.map((h) => h.action).join(',') === 'removed,amended,amended,created',
    history.map((h) => h.action).join(','));
  check('by staff2, staff2, staff2, staff1',
    history.map((h) => who(h.changedBy)).join(',') === 'staff2,staff2,staff2,staff1',
    history.map((h) => who(h.changedBy)).join(','));
  const firstAmendment = history[2];
  check('the first amendment records the original end',
    sameInstant(firstAmendment?.oldValues?.ends_at, at(13)),
    String(firstAmendment?.oldValues?.ends_at));

  const wrongVenue = await errorFrom(() => getVenueBlockHistory(randomUUID(), M.id));
  check('history through the wrong venue answers 404', wrongVenue?.status === 404,
    `status ${wrongVenue?.status}`);

  // --- 10. AC4: nothing changed a booking's period -------------------------
  console.log('\n  AC4 booking periods');

  check('B1\'s period is exactly as inserted',
    sameInstant(b1After.starts_at, B1.start) && sameInstant(b1After.ends_at, B1.end),
    `${b1After.starts_at} - ${b1After.ends_at}`);
  check('B2\'s period is exactly as inserted',
    sameInstant(b2After.starts_at, B2.start) && sameInstant(b2After.ends_at, B2.end),
    `${b2After.starts_at} - ${b2After.ends_at}`);
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
    console.log('\nAll checks passed. Created, overridden, amended, removed, audited, cleaned up.\n');
  });
