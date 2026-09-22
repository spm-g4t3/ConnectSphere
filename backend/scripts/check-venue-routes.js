/**
 * End-to-end proof for the venue catalogue routes (SCRUM-15).
 *
 * Run with: npm run venue-routes:check
 *
 * npm run venue:check already proves the service layer against a live
 * database. What it cannot prove is the half SCRUM-15's acceptance criteria
 * actually turn on, because none of it existed until the router was mounted:
 * that a real Supabase token resolves to a real role, that an Event Organiser
 * is refused, that a retired venue keeps its bookings, and that changed_by
 * finally holds the person who made the change rather than NULL.
 *
 * One block per acceptance criterion, in order, so a failure names the
 * criterion it breaks.
 *
 * Exits non-zero on any failure.
 */

import express from 'express';

// supabaseAuth for the sign-in, supabaseAdmin for every query. Using one client
// for both is the hazard src/config/supabaseClient.js warns about:
// signInWithPassword sets that client's in-memory auth state to the signed-in
// user for the rest of the process, overriding its API key, so every later
// query runs as that user -- subject to the row level security the secret key
// exists to bypass -- and silently returns nothing. An earlier draft of
// check-event-request-routes.js signed in on the admin client and every check
// after that point failed, including its own cleanup.
import { supabase, supabaseAdmin, supabaseAuth } from '../src/config/supabaseClient.js';
import { createVenueRouter } from '../src/routes/venues.js';

const STAMP = Date.now();
const PASSWORD = `Check-${STAMP}-Aa1!`;

let staffId = null;
let organiserId = null;
let venueId = null;
let eventId = null;
let bookingId = null;
let server = null;
let failures = 0;

function check(label, passed, detail = '') {
  console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!passed) failures += 1;
}

/** A throwaway confirmed user with a password, and the profile row its role lives in. */
async function createTestUser(label, role) {
  const { data, error } = await supabase.auth.admin.createUser({
    email: `__check_venue_${label}_${STAMP}@example.invalid`,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw new Error(`could not create test user (${label}): ${error.message}`);

  // requireAuth reads the role from here and answers 403 without it.
  const { error: profileError } = await supabaseAdmin
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

async function cleanup() {
  if (server) await new Promise((resolve) => server.close(resolve));

  // Order is forced by the foreign keys: bookings and history both point at the
  // venue with on delete restrict, and last_modified_by points at the user.
  if (bookingId) await supabaseAdmin.from('bookings').delete().eq('id', bookingId);
  if (venueId) {
    await supabaseAdmin.from('venue_change_history').delete().eq('venue_id', venueId);
    await supabaseAdmin.from('venues').delete().eq('id', venueId);
  }
  if (eventId) await supabaseAdmin.from('event_requests').delete().eq('id', eventId);

  for (const id of [staffId, organiserId]) {
    if (!id) continue;
    await supabaseAdmin.from('profiles').delete().eq('id', id);
    await supabase.auth.admin.deleteUser(id);
  }
}

async function main() {
  console.log('\nVenue catalogue routes check\n');

  const staff = await createTestUser('staff', 'venue_staff');
  staffId = staff.id;
  const organiser = await createTestUser('organiser', 'event_organiser');
  organiserId = organiser.id;

  const staffToken = await tokenFor(staff);
  const organiserToken = await tokenFor(organiser);

  // The real router with the real middleware -- nothing injected. Production
  // wiring; only the port differs.
  const app = express();
  app.use(express.json());
  app.use('/api/venues', createVenueRouter());
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/venues`;

  const call = (token, path = '', init = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

  // -- the gate ------------------------------------------------------------
  const anonymous = await fetch(base + '/search');
  check('an unauthenticated request is refused', anonymous.status === 401, `status ${anonymous.status}`);

  const garbage = await fetch(base + '/search', { headers: { Authorization: 'Bearer nope' } });
  check('a token Supabase does not recognise is refused', garbage.status === 401, `status ${garbage.status}`);

  const roleResolved = await call(staffToken, '/search');
  check('a real token resolves to a real role from profiles',
    roleResolved.status === 200, `status ${roleResolved.status}`);

  const { data: stillPrivileged, error: privilegedError } = await supabaseAdmin
    .from('profiles').select('id').eq('id', staffId).maybeSingle();
  check('verifying a token leaves the admin client still bypassing RLS',
    !privilegedError && stillPrivileged?.id === staffId, privilegedError?.message ?? '');

  // -- AC1 ------------------------------------------------------------------
  console.log('\n  AC1 -- a venue can be created with every field\n');

  const created = await call(staffToken, '', {
    method: 'POST',
    body: JSON.stringify({
      name: `__check_venue_${STAMP}`,
      location: 'Level 2, SCIS',
      maxCapacity: 40,
      layouts: ['classroom'],
      facilities: ['projector'],
      hours: [{ day_of_week: 1, opens_at: '09:00', closes_at: '18:00' }],
    }),
  });
  const createdBody = await created.json();
  check('Venue Staff can create a venue', created.status === 201,
    `status ${created.status} ${created.status === 201 ? '' : JSON.stringify(createdBody)}`);
  venueId = createdBody.id;

  check('every field supplied was stored',
    createdBody.name === `__check_venue_${STAMP}`
      && createdBody.maxCapacity === 40
      && createdBody.layouts?.includes('classroom')
      && createdBody.facilities?.includes('projector')
      && createdBody.hours?.length === 1,
    JSON.stringify({ layouts: createdBody.layouts, facilities: createdBody.facilities }));

  const organiserCreate = await call(organiserToken, '', {
    method: 'POST',
    body: JSON.stringify({ name: 'nope', location: 'nowhere', maxCapacity: 1 }),
  });
  check('an Event Organiser may not create a venue',
    organiserCreate.status === 403, `status ${organiserCreate.status}`);

  // -- AC2 ------------------------------------------------------------------
  console.log('\n  AC2 -- an authorised change reaches the search\n');

  const updated = await call(staffToken, `/${venueId}`, {
    method: 'PATCH',
    body: JSON.stringify({ location: 'Level 5, SOE' }),
  });
  check('Venue Staff can change a venue', updated.status === 200, `status ${updated.status}`);

  const foundNew = await (await call(staffToken, '/search?location=SOE')).json();
  check('the change is reflected in a subsequent search',
    foundNew.some((v) => v.id === venueId), `${foundNew.length} row(s)`);

  const foundOld = await (await call(staffToken, '/search?location=SCIS')).json();
  check('the old value no longer matches',
    !foundOld.some((v) => v.id === venueId), `${foundOld.length} row(s)`);

  const organiserUpdate = await call(organiserToken, `/${venueId}`, {
    method: 'PATCH',
    body: JSON.stringify({ location: 'hijacked' }),
  });
  check('an Event Organiser may not change a venue',
    organiserUpdate.status === 403, `status ${organiserUpdate.status}`);

  const organiserSearch = await call(organiserToken, '/search');
  check('but any authenticated user may search',
    organiserSearch.status === 200, `status ${organiserSearch.status}`);

  // -- AC3 ------------------------------------------------------------------
  console.log('\n  AC3 -- retirement, and what survives it\n');

  // A booking needs an event request, which needs an organiser.
  const { data: event, error: eventError } = await supabaseAdmin
    .from('event_requests')
    .insert({ organiser_id: organiserId, event_name: `__check_venue_event_${STAMP}`, status: 'submitted' })
    .select().single();
  if (eventError) throw new Error(`could not create test event request: ${eventError.message}`);
  eventId = event.id;

  const { data: booking, error: bookingError } = await supabaseAdmin
    .from('bookings')
    .insert({
      venue_id: venueId,
      event_request_id: eventId,
      starts_at: '2026-06-01T09:00:00+00:00',
      ends_at: '2026-06-01T17:00:00+00:00',
    })
    .select().single();
  if (bookingError) throw new Error(`could not create test booking: ${bookingError.message}`);
  bookingId = booking.id;

  const retired = await call(staffToken, `/${venueId}/retire`, { method: 'POST' });
  const retiredBody = await retired.json();
  check('Venue Staff can retire a venue', retired.status === 200, `status ${retired.status}`);
  check('retiredAt is set from the database clock', Boolean(retiredBody.retiredAt), retiredBody.retiredAt);

  const afterRetire = await (await call(staffToken, '/search')).json();
  check('a retired venue no longer appears in searches',
    !afterRetire.some((v) => v.id === venueId), `${afterRetire.length} row(s)`);

  const stillReadable = await call(staffToken, `/${venueId}`);
  check('a retired venue is still readable by id', stillReadable.status === 200, `status ${stillReadable.status}`);

  const bookings = await (await call(staffToken, `/${venueId}/bookings`)).json();
  check('its past bookings remain viewable',
    Array.isArray(bookings) && bookings.some((b) => b.id === bookingId),
    `${Array.isArray(bookings) ? bookings.length : 0} booking(s)`);

  const { error: deleteError } = await supabaseAdmin.from('venues').delete().eq('id', venueId);
  check('a booked venue cannot be hard-deleted', Boolean(deleteError),
    deleteError ? deleteError.code : 'the delete succeeded, which it must not');

  const alreadyRetired = await call(staffToken, `/${venueId}/retire`, { method: 'POST' });
  check('retiring twice is a conflict', alreadyRetired.status === 409, `status ${alreadyRetired.status}`);

  // -- AC4 ------------------------------------------------------------------
  console.log('\n  AC4 -- the editing user, the timestamp, the previous values\n');

  const history = await (await call(staffToken, `/${venueId}/history`)).json();
  check('the audit trail is readable', Array.isArray(history) && history.length > 0,
    `${Array.isArray(history) ? history.length : 0} row(s)`);

  // The headline. Until the router was mounted and stopped taking the acting
  // user from the request body, changed_by was NULL on every row ever written.
  check('changed_by is the acting user, not NULL',
    history.every((h) => h.changedBy === staffId),
    history.map((h) => h.changedBy).join(', '));

  check('every entry carries a timestamp',
    history.every((h) => Boolean(h.changedAt)));

  const creation = history.find((h) => Object.keys(h.oldValues ?? {}).length === 0);
  check('creating a venue is recorded (008)', Boolean(creation),
    creation ? JSON.stringify(creation.newValues).slice(0, 60) : 'no creation row found');

  const locationChange = history.find((h) => h.oldValues?.location !== undefined);
  check('a scalar change records its previous value',
    locationChange?.oldValues?.location === 'Level 2, SCIS',
    JSON.stringify(locationChange?.oldValues ?? null));

  // Attribute-only changes produced no history row at all before 008: the
  // trigger fires on venues and diffs its columns, and facilities live in a
  // join table.
  await call(staffToken, `/${venueId}`, {
    method: 'PATCH',
    body: JSON.stringify({ facilities: [] }),
  });
  const afterAttribute = await (await call(staffToken, `/${venueId}/history`)).json();
  const attributeChange = afterAttribute.find((h) => h.oldValues?.facilities !== undefined);
  check('an attribute-only change is recorded (008)', Boolean(attributeChange),
    attributeChange ? JSON.stringify(attributeChange.oldValues) : 'no attribute row found');
  check('the attribute change records the previous set',
    Array.isArray(attributeChange?.oldValues?.facilities)
      && attributeChange.oldValues.facilities.includes('projector'),
    JSON.stringify(attributeChange?.oldValues?.facilities ?? null));

  const organiserHistory = await call(organiserToken, `/${venueId}/history`);
  check('the audit trail is restricted to Venue Staff',
    organiserHistory.status === 403, `status ${organiserHistory.status}`);
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
    console.log('\nAll checks passed. Created, changed, searched, retired, audited, cleaned up.\n');
  });
