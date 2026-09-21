/**
 * End-to-end proof for the event request routes (SCRUM-42).
 *
 * Run with: npm run routes:check
 *
 * The unit suite drives the router with a fake Supabase client and a fake
 * authenticator, which is what lets it run in CI with no .env. That leaves
 * exactly one thing unproved, and it is the part most likely to be wrong: that
 * a real Supabase-issued JWT verifies through the real middleware, and that
 * ownership really scopes against a live table whose row level security is
 * deny-all. This script is that proof.
 *
 * It creates two throwaway Organisers with passwords, signs one of them in for
 * a real token, raises an event request for each, drives the routes over HTTP
 * against a server on an ephemeral port, then removes everything it created.
 *
 * Exits non-zero on any failure.
 */

import express from 'express';

// supabaseAuth for the sign-in, supabaseAdmin for every query. Using one
// client for both is the exact hazard src/config/supabaseClient.js warns
// about: signInWithPassword sets that client's in-memory auth state to the
// signed-in user for the rest of the process, overriding its API key, so every
// later query runs as that user -- subject to the row level security the
// secret key exists to bypass -- and silently returns nothing. An earlier draft
// of this script signed in on the admin client and every check after that point
// failed, including its own cleanup. That is the failure this separation
// prevents, and the check below is what proves it stayed prevented.
import { supabase, supabaseAdmin, supabaseAuth } from '../src/config/supabaseClient.js';
import { createEventRequestRouter } from '../src/routes/eventRequests.js';

const STAMP = Date.now();
const PASSWORD = `Check-${STAMP}-Aa1!`;

let organiserId = null;
let otherOrganiserId = null;
let eventId = null;
let otherEventId = null;
let server = null;
let failures = 0;

function check(label, passed, detail = '') {
  console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!passed) failures += 1;
}

/**
 * A throwaway confirmed user, with a password.
 *
 * check-event-change-request-service.js creates users without one, because it
 * never signs in as them. This script must, so that it gets a genuine access
 * token rather than one it minted itself -- which would prove nothing about
 * the middleware.
 */
async function createTestUser(label) {
  const { data, error } = await supabase.auth.admin.createUser({
    email: `__check_routes_${label}_${STAMP}@example.invalid`,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw new Error(`could not create test user (${label}): ${error.message}`);

  // requireAuth now resolves the caller's role from profiles (007_user_roles.sql)
  // and answers 403 when there is no row, so a throwaway user needs one or every
  // authenticated check below fails for the wrong reason.
  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .insert({ id: data.user.id, role: 'event_organiser', full_name: `Check ${label}` });
  if (profileError) {
    throw new Error(`could not create profile (${label}): ${profileError.message}`);
  }

  return data.user;
}

async function createEventRequest(ownerId, name, status) {
  const { data, error } = await supabase
    .from('event_requests')
    .insert({ organiser_id: ownerId, event_name: name, status })
    .select()
    .single();
  if (error) throw new Error(`could not create test event request: ${error.message}`);
  return data.id;
}

async function cleanup() {
  if (server) await new Promise((resolve) => server.close(resolve));

  // Event requests before users: organiser_id is ON DELETE RESTRICT, so
  // deleting the user first fails and leaves both behind.
  if (eventId) await supabase.from('event_requests').delete().eq('id', eventId);
  if (otherEventId) await supabase.from('event_requests').delete().eq('id', otherEventId);

  // profiles cascades from auth.users, so deleting the user is enough -- but it
  // is deleted explicitly here so a failure shows up as its own error rather
  // than as a confusing FK refusal on the user delete.
  for (const id of [organiserId, otherOrganiserId]) {
    if (!id) continue;
    await supabase.from('profiles').delete().eq('id', id);
    await supabase.auth.admin.deleteUser(id);
  }
}

async function main() {
  console.log('\nEvent request routes check\n');

  const organiser = await createTestUser('organiser');
  organiserId = organiser.id;
  const other = await createTestUser('other');
  otherOrganiserId = other.id;

  eventId = await createEventRequest(organiserId, `__check_routes_mine_${STAMP}`, 'submitted');
  otherEventId = await createEventRequest(otherOrganiserId, `__check_routes_theirs_${STAMP}`, 'submitted');

  // A real sign-in, so the token below is one Supabase issued rather than one
  // this script constructed.
  const { data: session, error: signInError } = await supabaseAuth.auth.signInWithPassword({
    email: organiser.email,
    password: PASSWORD,
  });
  if (signInError) throw new Error(`could not sign in as the test organiser: ${signInError.message}`);
  const token = session.session.access_token;

  // The real router with the real middleware -- nothing injected. This is the
  // production wiring; only the port is different.
  const app = express();
  app.use(express.json());
  app.use('/api/event-requests', createEventRequestRouter());
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/event-requests`;

  const authed = (path = '') =>
    fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });

  // -- the middleware, against a real token ---------------------------------
  const anonymous = await fetch(base);
  check('an unauthenticated request is refused', anonymous.status === 401, `status ${anonymous.status}`);

  const garbage = await fetch(base, { headers: { Authorization: 'Bearer not.a.real.token' } });
  check('a token Supabase does not recognise is refused', garbage.status === 401, `status ${garbage.status}`);

  const mine = await authed();
  check('a real Supabase token is accepted', mine.status === 200, `status ${mine.status}`);

  // The reason this script exists rather than trusting the unit tests: verifying
  // a token must not leave supabaseAdmin authenticated as that user. If it did,
  // this next privileged read would be subject to row level security -- which is
  // deny-all on this table -- and silently return nothing.
  const { data: stillPrivileged, error: privilegedError } = await supabaseAdmin
    .from('event_requests')
    .select('id')
    .eq('id', otherEventId)
    .maybeSingle();
  check(
    'verifying a token leaves the admin client still bypassing RLS',
    !privilegedError && stillPrivileged?.id === otherEventId,
    privilegedError?.message ?? '',
  );

  // -- AC1: ownership really scopes -----------------------------------------
  const mineBody = await mine.json();
  check('the list contains the organiser\'s own request', mineBody.some((r) => r.id === eventId));
  check(
    "the list contains no other organiser's request",
    !mineBody.some((r) => r.id === otherEventId),
    `${mineBody.length} row(s) returned`,
  );

  const theirs = await authed(`/${otherEventId}`);
  check("another organiser's request answers 404", theirs.status === 404, `status ${theirs.status}`);

  const missing = await authed('/00000000-0000-4000-8000-000000000000');
  check('an id that does not exist answers 404', missing.status === 404, `status ${missing.status}`);

  const theirsBody = await theirs.json();
  const missingBody = await missing.json();

  // Compared with each id blanked out, because both messages name the id that
  // was asked for -- which the caller already knew. What must not differ is
  // everything else: if "exists but is not yours" were worded differently from
  // "does not exist", the 404 status would be doing no work and the endpoint
  // would still tell a stranger which ids are real.
  const withoutId = (body, id) => body.error.replace(id, '<id>');
  check(
    'the two 404s are indistinguishable, so ids cannot be enumerated',
    withoutId(theirsBody, otherEventId)
      === withoutId(missingBody, '00000000-0000-4000-8000-000000000000'),
    `${withoutId(theirsBody, otherEventId)} / ${withoutId(missingBody, '00000000-0000-4000-8000-000000000000')}`,
  );

  // -- AC1/AC2: the status payload reaches the client -------------------------
  const one = await authed(`/${eventId}`);
  const oneBody = await one.json();
  check(
    'a single request carries its status display',
    oneBody.statusDisplay?.label === 'Submitted'
      && oneBody.statusDisplay?.group === 'AWAITING_REVIEW',
    JSON.stringify(oneBody.statusDisplay),
  );

  // -- AC4: the status moves, and so does the payload ------------------------
  const before = await (await authed(`/${eventId}/status`)).json();
  check('the status endpoint reports the stored status', before.status === 'submitted', before.label);

  // SCRUM-45 does not exist yet, so the Coordinator's move is made directly.
  // That is the point: AC4 is about the *display* keeping up with a change,
  // whoever made it.
  const { error: moveError } = await supabase
    .from('event_requests')
    .update({ status: 'under_review' })
    .eq('id', eventId);
  if (moveError) throw new Error(`could not move the status: ${moveError.message}`);

  const after = await (await authed(`/${eventId}/status`)).json();
  check('a refetch reflects the new status', after.status === 'under_review', after.label);
  check('the organiser-facing label changed with it', after.label === 'Under Review', after.label);
  check(
    'updated_at advanced, so a change is detectable',
    new Date(after.updatedAt).getTime() > new Date(before.updatedAt).getTime(),
    `${before.updatedAt} -> ${after.updatedAt}`,
  );

  // -- AC4: the list surfaces the changed request first ----------------------
  const relisted = await (await authed()).json();
  check(
    'the most recently changed request is listed first',
    relisted[0]?.id === eventId,
    `first row ${relisted[0]?.id}`,
  );

  // -- SCRUM-47, and the honest limit of what can be proved here -------------
  //
  // event_requests.status is a not-null Postgres enum, so neither fallback is
  // reachable from a real row: a null cannot be stored, and an unrecognised
  // value cannot be either without ALTER TYPE. That is worth stating rather
  // than simulating -- UNAVAILABLE guards a response that did not arrive
  // intact, and UNKNOWN guards a frontend older than the enum. Both are
  // forward-compatibility paths, and the unit tests cover them at the seam
  // where they can actually occur.
  const { data: enumRow } = await supabaseAdmin
    .from('event_requests')
    .select('status')
    .eq('id', eventId)
    .single();
  check(
    'a stored row always has a real status, so UNAVAILABLE is unreachable in production',
    typeof enumRow?.status === 'string' && enumRow.status.length > 0,
    enumRow?.status,
  );

  // -- nothing left behind ---------------------------------------------------
  const { count } = await supabase
    .from('event_requests')
    .select('id', { count: 'exact', head: true })
    .like('event_name', `__check_routes_%_${STAMP}`);
  check('only this run\'s two test rows exist, ready for cleanup', count === 2, `${count} row(s)`);
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
    console.log('\nAll checks passed. Signed in, scoped, tracked a status change, cleaned up.\n');
  });
