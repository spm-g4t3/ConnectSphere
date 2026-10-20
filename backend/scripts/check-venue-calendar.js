/**
 * End-to-end proof for the venue availability calendar (SCRUM-178, checked by
 * SCRUM-184).
 *
 * Run with: npm run venue-calendar:check   (from backend/, with a real .env)
 *
 * GET /api/venues/:id/calendar is mounted on a throwaway HTTP server with the
 * real router and the real requireAuth/requireRole, and called with real
 * Supabase tokens for real users. Every row it reads was written to the live
 * database by this script, through the same RPCs the app uses wherever one
 * exists, and every one of them is deleted again at the end.
 *
 * The unit, route and flow suites mock Supabase. They prove the calendar sends
 * the right query and shapes what comes back. Only this script can show what
 * the database itself answers, and so that:
 *
 *  - AC1: Venue Staff and Event Coordinators open the calendar, for an active
 *    venue and for a retired one, on a past window too; and (SCRUM-185) a
 *    Coordinator's search with includeRetired=true finds the retired venue,
 *    an Organiser's is 403, and an Organiser's plain search leaves it out;
 *  - AC2: a booking comes back as kind 'booking' with its status ('approved',
 *    or 'flagged_for_review' once an override block flags it through
 *    create_venue_block / flag_bookings_for_block, 014) and its event name, and
 *    a block as kind 'block' with its reason, soonest first;
 *  - AC3: an event request still waiting for a decision has no booking, so
 *    nothing of it reaches the calendar;
 *  - AC5: a cancelled booking and a removed block (remove_venue_block, 015) are
 *    left out, and so are a booking outside the window and a block that only
 *    touches its edge (half-open overlap);
 *  - AC6: an Event Organiser and an Attendee are refused the calendar, and the
 *    /bookings and /blocks routes it is built from; no token is 401;
 *  - and the calendar's own errors: 404 for an unknown venue, 400 for a
 *    missing window.
 *
 * It creates four throwaway auth users with passwords and profiles: Venue
 * Staff, an Event Coordinator, an Event Organiser (event_requests.organiser_id
 * is NOT NULL) and an Attendee. Like venue-blocks:check, the coordinator is a
 * real event_coordinator for the few seconds the script runs, so a Lead could
 * briefly assign it an event, and the override notifies every
 * Event Coordinator on the project; cleanup deletes those notifications.
 *
 * Exits non-zero on any failure, including a failed cleanup step or a row left
 * behind.
 */

import { randomUUID } from 'node:crypto';

import express from 'express';

// supabaseAuth for sign-in, supabaseAdmin (aliased `supabase`) for every query.
// One client for both is the hazard src/config/supabaseClient.js warns about:
// signInWithPassword sets that client's auth state to the signed-in user for
// the rest of the process, so every later query would run as that user under
// row level security and silently return nothing -- cleanup included. See
// check-venue-routes.js.
import { supabase, supabaseAuth } from '../src/config/supabaseClient.js';
import { createVenueRouter } from '../src/routes/venues.js';
import { createVenue } from '../src/services/venueService.js';

const STAMP = Date.now();
const NAME = `__check_calendar_${STAMP}`;
const PASSWORD = `Check-${STAMP}-Aa1!`;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// D: thirty days out, on the hour. Blocks made through create_venue_block must
// end in the future, so the active venue's window is in the future.
const D = Math.floor((Date.now() + 30 * DAY) / HOUR) * HOUR;
const at = (hours) => new Date(D + hours * HOUR).toISOString();

// P: ten days ago, on the hour, for the retired venue's past window.
const P = Math.floor((Date.now() - 10 * DAY) / HOUR) * HOUR;
const past = (hours) => new Date(P + hours * HOUR).toISOString();

// Everything created, so cleanup can delete exactly that and nothing else.
const users = { staff: null, coordinator: null, organiser: null, attendee: null };
const venueIds = [];
const eventIds = [];
const bookingIds = [];

let server = null;
let failures = 0;

function check(label, passed, detail = '') {
  console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!passed) failures += 1;
}

/** Two timestamps name the same instant, whatever offset each is written in. */
function sameInstant(a, b) {
  return a != null && b != null && new Date(a).getTime() === new Date(b).getTime();
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/** Confirms 009-016 are applied before anything is written. Empty means go. */
async function preflight() {
  const missing = [];

  for (const [table, columns] of [
    ['bookings', 'id, status, review_block_id, flagged_at, flagged_by'],
    ['venue_blocks', 'id, removed_at'],
    ['venue_block_history', 'id'],
    ['notifications', 'id'],
    ['event_requests', 'id, assigned_coordinator_id'],
  ]) {
    const { error } = await supabase.from(table).select(columns).limit(1);
    if (error) missing.push(`${table} (${columns}): ${error.message}`);
  }

  // The 013/014 signature of create_venue_block, on a venue that cannot exist,
  // must raise no_data_found. Anything else -- PGRST202 above all -- means the
  // override path this script relies on is missing.
  const { error: rpcError } = await supabase.rpc('create_venue_block', {
    p_venue_id: randomUUID(),
    p_starts_at: at(0),
    p_ends_at: at(1),
    p_reason: 'maintenance',
    p_notes: null,
    p_user_id: null,
    p_confirm_override: false,
    p_acknowledged_booking_ids: [],
  });
  if (rpcError?.code !== 'P0002') {
    missing.push(
      `create_venue_block: expected P0002, got ${rpcError?.code ?? 'no error'} `
        + `${rpcError?.message ?? ''}`.trim(),
    );
  }

  return missing;
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

/** A throwaway confirmed user with a password, and the profile requireAuth reads. */
async function createTestUser(label, role) {
  const { data, error } = await supabase.auth.admin.createUser({
    email: `__check_calendar_${label}_${STAMP}@example.invalid`,
    password: PASSWORD,
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

  return data.user;
}

async function tokenFor(user) {
  const { data, error } = await supabaseAuth.auth.signInWithPassword({
    email: user.email,
    password: PASSWORD,
  });
  if (error) throw new Error(`could not sign in as ${user.email}: ${error.message}`);
  return data.session.access_token;
}

async function insertEvent(label, extra = {}) {
  const { data, error } = await supabase
    .from('event_requests')
    .insert({ organiser_id: users.organiser, event_name: `${NAME}_${label}`, ...extra })
    .select('id, event_name')
    .single();
  if (error) throw new Error(`could not create event request (${label}): ${error.message}`);
  eventIds.push(data.id);
  return data;
}

async function insertBooking(venueId, eventId, startsAt, endsAt, status = 'approved') {
  const { data, error } = await supabase
    .from('bookings')
    .insert({ venue_id: venueId, event_request_id: eventId, starts_at: startsAt, ends_at: endsAt, status })
    .select('id')
    .single();
  if (error) throw new Error(`could not create booking: ${error.message}`);
  bookingIds.push(data.id);
  return data.id;
}

async function readBooking(id) {
  const { data, error } = await supabase
    .from('bookings')
    .select('id, status, review_block_id, flagged_at')
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

/** Every block ever made on this script's venues, removed or not. */
async function blockIdsOnVenues() {
  if (venueIds.length === 0) return [];
  const { data, error } = await supabase.from('venue_blocks').select('id').in('venue_id', venueIds);
  if (error) {
    console.error(`  cleanup: reading blocks failed: ${error.message}`);
    failures += 1;
  }
  return (data ?? []).map((row) => row.id);
}

async function cleanup() {
  if (server) await new Promise((resolve) => server.close(resolve));

  const blockIds = await blockIdsOnVenues();

  // 1. Notifications the override sent, real coordinators' included: each
  //    names a booking or block made here.
  if (blockIds.length > 0) {
    await step('notifications by block', () =>
      supabase.from('notifications').delete().in('block_id', blockIds));
  }
  if (bookingIds.length > 0) {
    await step('notifications by booking', () =>
      supabase.from('notifications').delete().in('booking_id', bookingIds));
  }

  // 2. Bookings BEFORE blocks. review_block_id is ON DELETE SET NULL and 014
  //    pairs it with flagged_at, so deleting the override block first would
  //    null one but not the other and the check would refuse the delete. They
  //    also hold flagged_by, a reference to the staff user.
  if (bookingIds.length > 0) {
    await step('bookings', () => supabase.from('bookings').delete().in('id', bookingIds));
  }

  // 3. Block history before blocks: venue_block_history.block_id is ON DELETE
  //    RESTRICT (016).
  if (blockIds.length > 0) {
    await step('venue_block_history', () =>
      supabase.from('venue_block_history').delete().in('block_id', blockIds));
  }

  // 4. Blocks before venues (venue_id ON DELETE RESTRICT) and before users
  //    (created_by, last_modified_by, removed_by).
  if (venueIds.length > 0) {
    await step('venue_blocks', () => supabase.from('venue_blocks').delete().in('venue_id', venueIds));
  }

  // 5. Event requests before the organiser (organiser_id) and coordinator
  //    (assigned_coordinator_id), both ON DELETE RESTRICT. Their history
  //    tables are RESTRICT too; this script writes none, and deleting them
  //    keeps cleanup correct if that changes.
  if (eventIds.length > 0) {
    await step('assignment history', () =>
      supabase.from('event_request_assignment_history').delete().in('event_request_id', eventIds));
    await step('status history', () =>
      supabase.from('event_request_status_history').delete().in('event_request_id', eventIds));
    await step('event_requests', () => supabase.from('event_requests').delete().in('id', eventIds));
  }

  // 6. Venue history (008 records the creation, 005 the retirement) before the
  //    venues.
  if (venueIds.length > 0) {
    await step('venue_change_history', () =>
      supabase.from('venue_change_history').delete().in('venue_id', venueIds));
    await step('venues', () => supabase.from('venues').delete().in('id', venueIds));
  }

  // 7. Profiles cascade from auth.users, but are deleted explicitly so a
  //    failure surfaces as its own error.
  for (const [label, id] of Object.entries(users)) {
    if (!id) continue;
    await step(`profile (${label})`, () => supabase.from('profiles').delete().eq('id', id));
    await step(`auth user (${label})`, () => supabase.auth.admin.deleteUser(id));
  }
}

/** Prove the cleanup after it has run, rather than assuming it worked. */
async function verifyCleanup() {
  const count = async (table, column, ids) => {
    if (ids.length === 0) return 0;
    const { count: n, error } = await supabase
      .from(table)
      .select('*', { count: 'exact', head: true })
      .in(column, ids);
    if (error) throw new Error(`could not count ${table}: ${error.message}`);
    return n ?? 0;
  };

  const userIds = Object.values(users).filter(Boolean);
  const left = {
    bookings: await count('bookings', 'id', bookingIds),
    blocks: await count('venue_blocks', 'venue_id', venueIds),
    events: await count('event_requests', 'id', eventIds),
    venues: await count('venues', 'id', venueIds),
    profiles: await count('profiles', 'id', userIds),
    users: 0,
  };
  for (const id of userIds) {
    const { data } = await supabase.auth.admin.getUserById(id);
    if (data?.user) left.users += 1;
  }

  check('nothing left behind after cleanup',
    Object.values(left).every((n) => n === 0), JSON.stringify(left));
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function main() {
  console.log('\nVenue calendar check\n');

  // --- preflight -------------------------------------------------------------
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

  // --- users -----------------------------------------------------------------
  const staff = await createTestUser('staff', 'venue_staff');
  const coordinator = await createTestUser('coordinator', 'event_coordinator');
  const organiser = await createTestUser('organiser', 'event_organiser');
  const attendee = await createTestUser('attendee', 'attendee');

  const tokens = {
    staff: await tokenFor(staff),
    coordinator: await tokenFor(coordinator),
    organiser: await tokenFor(organiser),
    attendee: await tokenFor(attendee),
  };

  // --- the real router on an ephemeral port ----------------------------------
  const app = express();
  app.use(express.json());
  app.use('/api/venues', createVenueRouter());
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/venues`;

  const call = (who, path, init = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}),
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  // encodeURIComponent, so an offset's '+' is not read as a space.
  const windowQuery = (from, to) => `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const calendar = (who, venueId, from, to) => call(who, `/${venueId}/calendar${windowQuery(from, to)}`);
  const postBlock = (body, venueId) =>
    call('staff', `/${venueId}/blocks`, { method: 'POST', body: JSON.stringify(body) });

  // --- active venue: requests, bookings, blocks -------------------------------
  const active = await createVenue({ name: `${NAME}_active`, location: `${NAME}_loc`, maxCapacity: 30 }, staff.id);
  venueIds.push(active.id);

  const eventA = await insertEvent('event_a');
  const eventF = await insertEvent('event_f');
  // AC3: submitted and assigned, waiting for a decision. 017 requires a
  // coordinator on every row past draft. It never gets a booking.
  const pending = await insertEvent('pending', {
    status: 'submitted',
    submitted_at: new Date().toISOString(),
    assigned_coordinator_id: coordinator.id,
  });

  // The window is [at(0), at(24)).
  const bookingA = await insertBooking(active.id, eventA.id, at(2), at(4));
  const bookingC = await insertBooking(active.id, eventA.id, at(6), at(8), 'cancelled');
  const bookingF = await insertBooking(active.id, eventF.id, at(10), at(12));
  const bookingOut = await insertBooking(active.id, eventA.id, at(30), at(32));

  console.log('\n  Setup through the block routes');

  // O = [9, 13) overlaps F, so it needs an override, which flags F (014).
  const oBody = { startsAt: at(9), endsAt: at(13), reason: 'renovation' };
  const oConflict = await postBlock(oBody, active.id);
  const oConflictBody = await oConflict.json();
  check('a block over F without override is 409 BLOCK_BOOKING_CONFLICT',
    oConflict.status === 409 && oConflictBody.code === 'BLOCK_BOOKING_CONFLICT',
    `status ${oConflict.status} ${oConflictBody.code}`);

  const oCreated = await postBlock({ ...oBody, confirmOverride: true, acknowledgedBookingIds: [bookingF] }, active.id);
  const oCreatedBody = await oCreated.json();
  check('the override block O is created (201) and flags F',
    oCreated.status === 201
      && oCreatedBody.flaggedBookings?.length === 1
      && oCreatedBody.flaggedBookings[0].bookingId === bookingF,
    `status ${oCreated.status}`);
  const blockO = oCreatedBody.block?.id;
  if (!blockO) throw new Error(`override block was not created: ${JSON.stringify(oCreatedBody)}`);

  const fRow = await readBooking(bookingF);
  check('F is flagged_for_review, pointing at O, with flagged_at set (014)',
    fRow.status === 'flagged_for_review' && fRow.review_block_id === blockO && Boolean(fRow.flagged_at),
    `${fRow.status}, review_block_id ${fRow.review_block_id === blockO ? 'O' : fRow.review_block_id}`);

  const xRes = await postBlock({ startsAt: at(14), endsAt: at(16), reason: 'maintenance', notes: 'Aircon service' }, active.id);
  const blockX = (await xRes.json()).block?.id;
  check('block X is created (201)', xRes.status === 201 && Boolean(blockX), `status ${xRes.status}`);

  const rRes = await postBlock({ startsAt: at(18), endsAt: at(20), reason: 'safety' }, active.id);
  const blockR = (await rRes.json()).block?.id;
  check('block R is created (201)', rRes.status === 201 && Boolean(blockR), `status ${rRes.status}`);
  const rRemoved = await call('staff', `/${active.id}/blocks/${blockR}`, { method: 'DELETE' });
  check('block R is removed through remove_venue_block (204)', rRemoved.status === 204,
    `status ${rRemoved.status}`);

  // E starts exactly where the window ends: touching, not overlapping.
  const eRes = await postBlock({ startsAt: at(24), endsAt: at(26), reason: 'maintenance' }, active.id);
  const blockE = (await eRes.json()).block?.id;
  check('block E touching the window edge is created (201)', eRes.status === 201 && Boolean(blockE),
    `status ${eRes.status}`);

  // --- retired venue: a past booking and an ended block, then retire ----------
  const retired = await createVenue({ name: `${NAME}_retired`, location: `${NAME}_loc`, maxCapacity: 30 }, staff.id);
  venueIds.push(retired.id);
  const eventPast = await insertEvent('event_past');
  const bookingPast = await insertBooking(retired.id, eventPast.id, past(0), past(2));

  // Inserted directly: create_venue_block refuses a block that has already
  // ended, and one on a retired venue. This is the row it would have left.
  const { data: pastBlock, error: pastBlockError } = await supabase
    .from('venue_blocks')
    .insert({
      venue_id: retired.id,
      starts_at: past(3),
      ends_at: past(5),
      reason: 'safety',
      created_by: staff.id,
      last_modified_by: staff.id,
    })
    .select('id')
    .single();
  if (pastBlockError) throw new Error(`could not insert past block: ${pastBlockError.message}`);

  const retiredRes = await call('staff', `/${retired.id}/retire`, { method: 'POST' });
  check('the second venue is retired (200)', retiredRes.status === 200, `status ${retiredRes.status}`);

  // --- AC1 / AC2 / AC5: what the calendar answers -----------------------------
  console.log('\n  AC1 internal roles open the calendar');

  const staffRes = await calendar('staff', active.id, at(0), at(24));
  const staffBody = await staffRes.json();
  check('Venue Staff get 200', staffRes.status === 200, `status ${staffRes.status}`);

  const coordRes = await calendar('coordinator', active.id, at(0), at(24));
  const coordBody = await coordRes.json();
  check('an Event Coordinator gets 200', coordRes.status === 200, `status ${coordRes.status}`);
  check('and the same entries as Venue Staff',
    JSON.stringify(coordBody) === JSON.stringify(staffBody));

  const entries = Array.isArray(staffBody) ? staffBody : [];
  const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
  const label = (id) => ({
    [bookingA]: 'A', [bookingF]: 'F', [bookingC]: 'C', [bookingOut]: 'Out',
    [blockO]: 'O', [blockX]: 'X', [blockR]: 'R', [blockE]: 'E',
  })[id] ?? id;

  console.log('\n  AC2 labels and order');

  check('exactly A, O, F, X, soonest first',
    entries.map((e) => e.id).join(',') === [bookingA, blockO, bookingF, blockX].join(','),
    entries.map((e) => label(e.id)).join(','));
  const starts = entries.map((e) => Date.parse(e.startsAt));
  check('startsAt never goes backwards', starts.every((t, i) => i === 0 || starts[i - 1] <= t));

  const a = byId[bookingA];
  check('A is an approved booking named after its event',
    a?.kind === 'booking' && a.status === 'approved' && a.eventName === eventA.event_name
      && a.eventRequestId === eventA.id
      && sameInstant(a.startsAt, at(2)) && sameInstant(a.endsAt, at(4)),
    JSON.stringify(a ?? null));

  const f = byId[bookingF];
  check('F is a flagged_for_review booking (Booked - under review) with its event name',
    f?.kind === 'booking' && f.status === 'flagged_for_review' && f.eventName === eventF.event_name,
    JSON.stringify(f ?? null));

  const o = byId[blockO];
  check('O is a block with reason renovation',
    o?.kind === 'block' && o.reason === 'renovation'
      && sameInstant(o.startsAt, at(9)) && sameInstant(o.endsAt, at(13)),
    JSON.stringify(o ?? null));

  const x = byId[blockX];
  check('X is a block with reason maintenance and its notes',
    x?.kind === 'block' && x.reason === 'maintenance' && x.notes === 'Aircon service',
    JSON.stringify(x ?? null));

  console.log('\n  AC3 a pending request is not shown as booked');

  check('no entry belongs to the pending request',
    !entries.some((e) => e.eventRequestId === pending.id));
  const { count: pendingBookings, error: pendingError } = await supabase
    .from('bookings')
    .select('*', { count: 'exact', head: true })
    .eq('event_request_id', pending.id);
  check('because it has no booking at all', !pendingError && pendingBookings === 0,
    pendingError?.message ?? `${pendingBookings} booking(s)`);

  console.log('\n  AC5 what the calendar leaves out');

  check('the cancelled booking C is absent', !byId[bookingC]);
  check('the removed block R is absent', !byId[blockR]);
  check('the booking outside the window is absent', !byId[bookingOut]);
  check('the block E touching the window edge is absent', !byId[blockE]);

  // --- AC1: the retired venue, on a past window ------------------------------
  console.log('\n  AC1 a retired venue, a past window');

  const retiredCal = await calendar('coordinator', retired.id, past(-24), past(24));
  const retiredBody = await retiredCal.json();
  check('an Event Coordinator gets 200 for the retired venue', retiredCal.status === 200,
    `status ${retiredCal.status}`);
  const retiredEntries = Array.isArray(retiredBody) ? retiredBody : [];
  check('its past booking then its ended block, soonest first',
    retiredEntries.map((e) => e.id).join(',') === [bookingPast, pastBlock.id].join(','),
    `${retiredEntries.length} entr(ies)`);
  check('the past booking keeps its status and event name',
    retiredEntries[0]?.kind === 'booking' && retiredEntries[0].status === 'approved'
      && retiredEntries[0].eventName === eventPast.event_name);
  check('the ended block keeps its reason',
    retiredEntries[1]?.kind === 'block' && retiredEntries[1].reason === 'safety');

  const retiredStaff = await calendar('staff', retired.id, past(-24), past(24));
  check('Venue Staff get 200 for the retired venue too', retiredStaff.status === 200,
    `status ${retiredStaff.status}`);

  // --- AC1 (SCRUM-185): the retired venue is reachable from search ----------
  // Narrowed to this run's location, so the live catalogue's other venues do
  // not matter.
  console.log('\n  AC1 a retired venue is found by search with includeRetired');

  const searchQuery = (extra = '') => `/search?location=${encodeURIComponent(`${NAME}_loc`)}${extra}`;
  const findRetired = async (res) => {
    const body = await res.json().catch(() => null);
    return Array.isArray(body) ? body.find((v) => v.id === retired.id) : undefined;
  };

  const coordSearch = await call('coordinator', searchQuery('&includeRetired=true'));
  const coordHit = coordSearch.status === 200 ? await findRetired(coordSearch) : undefined;
  check('an Event Coordinator searching with includeRetired=true gets 200', coordSearch.status === 200,
    `status ${coordSearch.status}`);
  check('and the retired venue is listed with a non-null retiredAt',
    Boolean(coordHit) && coordHit.retiredAt != null, coordHit ? `retiredAt ${coordHit.retiredAt}` : 'not listed');

  const organiserFlag = await call('organiser', searchQuery('&includeRetired=true'));
  check('an Event Organiser searching with includeRetired=true gets 403', organiserFlag.status === 403,
    `status ${organiserFlag.status}`);

  const organiserPlain = await call('organiser', searchQuery());
  const organiserHit = organiserPlain.status === 200 ? await findRetired(organiserPlain) : undefined;
  check('an Event Organiser searching without the flag gets 200 without the retired venue',
    organiserPlain.status === 200 && !organiserHit, `status ${organiserPlain.status}`);

  // --- AC6: everyone else is refused ------------------------------------------
  console.log('\n  AC6 Organisers and Attendees are refused');

  for (const who of ['organiser', 'attendee']) {
    for (const [route, path] of [
      ['/calendar', `/${active.id}/calendar${windowQuery(at(0), at(24))}`],
      ['/bookings', `/${active.id}/bookings`],
      ['/blocks', `/${active.id}/blocks`],
    ]) {
      const res = await call(who, path);
      check(`${who} gets 403 on ${route}`, res.status === 403, `status ${res.status}`);
    }
  }

  const anonymous = await calendar(null, active.id, at(0), at(24));
  check('no token gets 401 on /calendar', anonymous.status === 401, `status ${anonymous.status}`);

  // --- the calendar's own errors ---------------------------------------------
  console.log('\n  Errors');

  const unknown = await calendar('staff', randomUUID(), at(0), at(24));
  check('an unknown venue is 404', unknown.status === 404, `status ${unknown.status}`);

  const noWindow = await call('staff', `/${active.id}/calendar`);
  check('a missing window is 400', noWindow.status === 400, `status ${noWindow.status}`);
}

main()
  .catch((err) => {
    console.error(`\nFailed: ${err.message}`);
    failures += 1;
  })
  .finally(async () => {
    await cleanup();
    try {
      await verifyCleanup();
    } catch (err) {
      console.error(`  cleanup: verification failed: ${err.message}`);
      failures += 1;
    }
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed.\n`);
      process.exit(1);
    }
    console.log('\nAll checks passed. Seeded, read through HTTP, refused, cleaned up.\n');
  });
