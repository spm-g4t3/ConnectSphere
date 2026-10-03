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
 * It creates two throwaway Organisers and, since SCRUM-45, one throwaway Event
 * Coordinator, all with passwords; signs them in for real tokens, raises an
 * event request for each Organiser, drives the routes over HTTP against a
 * server on an ephemeral port, then removes everything it created.
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

// SCRUM-45. The throwaway Event Coordinator. Tracked exactly like the two
// Organisers so cleanup() removes it even when a check above throws.
let coordinatorId = null;
let eventId = null;
let otherEventId = null;

// The request the write section creates through POST / rather than through the
// admin client. Tracked separately because it is the only row here whose whole
// life -- created, edited, submitted, changed -- happens over HTTP, and because
// cleanup() has to find it even if the run fails halfway through that life.
let draftEventId = null;

let server = null;
let failures = 0;

// Errors from cleanup's own deletes, which supabase-js returns rather than
// throws, so a delete a foreign key refuses is silent unless kept. See
// cleanup() and the post-cleanup checks at the bottom of the file.
const cleanupErrors = [];

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
 *
 * SCRUM-45 added the role, as a defaulted parameter rather than a required
 * one, so that both existing call sites below read exactly as they did. Only
 * the queue check needs anything other than an Organiser, and requireAuth
 * resolves the role from this profiles row -- so passing the wrong one here
 * would show up as a 403 on a route that has nothing to do with roles.
 */
async function createTestUser(label, role = 'event_organiser') {
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
    .insert({ id: data.user.id, role, full_name: `Check ${label}` });
  if (profileError) {
    throw new Error(`could not create profile (${label}): ${profileError.message}`);
  }

  return data.user;
}

/**
 * A fixture event request, inserted directly through the admin client.
 *
 * SCRUM-330: assigned_coordinator_id is set explicitly. 017's constraint
 * requires a coordinator on every row past draft, and these two rows are
 * inserted straight at 'submitted'. They are fixtures for the ownership,
 * queue and status-display checks, not a test of submission, so they do not
 * go through submit_event_request. Submission is exercised separately below,
 * by draftEventId, which is created, completed and submitted over HTTP and so
 * is assigned by the real function. A fixed coordinator also keeps these
 * fixtures deterministic, rather than depending on the selection rule and on
 * whoever else is in the database.
 *
 * The coordinator is this script's own throwaway one. Giving it two fixture
 * rows also raises its active-event count, which makes it less likely to be
 * chosen for a real Organiser's submission while the script is running.
 */
async function createEventRequest(ownerId, name, status, assignedCoordinatorId) {
  const { data, error } = await supabase
    .from('event_requests')
    .insert({
      organiser_id: ownerId,
      event_name: name,
      status,
      assigned_coordinator_id: assignedCoordinatorId,
    })
    .select()
    .single();
  if (error) throw new Error(`could not create test event request: ${error.message}`);
  return data.id;
}

/** Run one cleanup step, keeping its error rather than dropping it. */
async function remove(label, query) {
  const { error } = await query;
  if (error) cleanupErrors.push(`${label}: ${error.message}`);
}

async function cleanup() {
  if (server) await new Promise((resolve) => server.close(resolve));

  const eventIds = [draftEventId, eventId, otherEventId].filter(Boolean);

  // Change requests and assignment history before event requests, for the
  // same reason event requests come before users: both reference the row
  // being deleted, so deleting the event first fails and leaves everything
  // behind, and the failure surfaces as a confusing FK refusal on a delete
  // nobody was thinking about.
  //
  // Assignment history is new with SCRUM-330. draftEventId is submitted over
  // HTTP, so submit_event_request writes a history row for it, and that
  // table's event_request_id is ON DELETE RESTRICT (014) on purpose. Its
  // new_coordinator_id is restricted too, which is a second reason it has to
  // go before the coordinator's user below.
  //
  // requested_by and processed_by on change requests reference auth.users, so
  // these also have to run before the user deletes.
  for (const id of eventIds) {
    await remove('change requests', supabase.from('event_change_requests').delete().eq('event_request_id', id));
    await remove('assignment history', supabase.from('event_request_assignment_history').delete().eq('event_request_id', id));
  }

  // Event requests before users: organiser_id and assigned_coordinator_id are
  // both ON DELETE RESTRICT, so deleting a user first fails and leaves both
  // behind.
  for (const id of eventIds) {
    await remove('event request', supabase.from('event_requests').delete().eq('id', id));
  }

  // profiles cascades from auth.users, so deleting the user is enough -- but it
  // is deleted explicitly here so a failure shows up as its own error rather
  // than as a confusing FK refusal on the user delete.
  for (const id of [organiserId, otherOrganiserId, coordinatorId]) {
    if (!id) continue;
    await remove('profile', supabase.from('profiles').delete().eq('id', id));
    await remove('auth user', supabase.auth.admin.deleteUser(id));
  }
}

/**
 * Prove the cleanup, after it has run.
 *
 * The count at the end of main() runs before cleanup by design: it asserts
 * that this run created exactly its three rows. It cannot move after cleanup,
 * because there it would be asking a different question with a different
 * answer (zero). It was also the last check printed, so a run whose cleanup
 * then failed still ended on "All checks passed ... cleaned up". That is how
 * a leftover row from this script went unnoticed. These checks run after
 * cleanup, in addition to that count, and are counted before the final
 * message is chosen.
 */
async function verifyCleanup() {
  check('cleanup ran without errors', cleanupErrors.length === 0, cleanupErrors.join('; '));

  const { count: eventsLeft } = await supabase
    .from('event_requests')
    .select('id', { count: 'exact', head: true })
    .like('event_name', `__check_routes_%_${STAMP}`);

  const eventIds = [draftEventId, eventId, otherEventId].filter(Boolean);
  const { count: historyLeft } = eventIds.length === 0
    ? { count: 0 }
    : await supabase
      .from('event_request_assignment_history')
      .select('id', { count: 'exact', head: true })
      .in('event_request_id', eventIds);

  const userIds = [organiserId, otherOrganiserId, coordinatorId].filter(Boolean);
  const { count: profilesLeft } = userIds.length === 0
    ? { count: 0 }
    : await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .in('id', userIds);

  let usersLeft = 0;
  for (const id of userIds) {
    const { data } = await supabase.auth.admin.getUserById(id);
    if (data?.user) usersLeft += 1;
  }

  check(
    'nothing left behind after cleanup',
    eventsLeft === 0 && historyLeft === 0 && profilesLeft === 0 && usersLeft === 0,
    `${eventsLeft} request(s), ${historyLeft} history row(s), `
      + `${profilesLeft} profile(s), ${usersLeft} user(s)`,
  );
}

async function main() {
  console.log('\nEvent request routes check\n');

  const organiser = await createTestUser('organiser');
  organiserId = organiser.id;
  const other = await createTestUser('other');
  otherOrganiserId = other.id;

  // SCRUM-45. GET /queue is the first route in this file behind a role gate,
  // and a gate is the one thing a fake authenticator cannot prove: the unit
  // suite hands the router a req.user it wrote itself. This user's role comes
  // from a real profiles row, read by the real middleware out of a real JWT.
  const coordinator = await createTestUser('coordinator', 'event_coordinator');
  coordinatorId = coordinator.id;

  eventId = await createEventRequest(organiserId, `__check_routes_mine_${STAMP}`, 'submitted', coordinatorId);
  otherEventId = await createEventRequest(otherOrganiserId, `__check_routes_theirs_${STAMP}`, 'submitted', coordinatorId);

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

  /**
   * The same real token, for the routes that send a body.
   *
   * Separate from authed rather than folded into it with optional arguments,
   * because the Content-Type header is not optional: express.json() only
   * parses a body that declares itself as JSON, and a POST without it arrives
   * as {} -- which for POST / looks exactly like a missing eventName and
   * would fail this script with a 400 that says nothing about what is wrong.
   */
  const authedWrite = (method, path, body) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body ?? {}),
    });

  /** A proposed period safely ahead of the real clock, with a real offset. */
  const futurePeriod = () => {
    const start = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 8 * 60 * 60 * 1000);
    return { proposedStart: start.toISOString(), proposedEnd: end.toISOString() };
  };

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

  // -- SCRUM-29: a request is created over HTTP ------------------------------
  //
  // Everything from here down exercises the five routes that used to 404. The
  // unit suite proves each of them against a fake client; what it cannot prove
  // is the half that only a live database has -- the updated_at trigger, the
  // 005 submitted_at constraint, the foreign key from event_change_requests,
  // and row level security on a real write.
  const created = await authedWrite('POST', '', {
    eventName: `__check_routes_created_${STAMP}`,

    // Both named in the body on purpose. The organiser must come from the
    // token and the status must be 'draft' whatever the caller asks for, and
    // the read-back below is what proves it rather than the response echoing
    // what it was sent.
    organiserId: otherOrganiserId,
    status: 'approved',
  });
  const createdBody = await created.json();
  check('creating a request answers 201', created.status === 201, `status ${created.status}`);

  draftEventId = createdBody.id ?? null;
  if (!draftEventId) {
    throw new Error(`POST / returned no id: ${JSON.stringify(createdBody)}`);
  }

  check(
    'a created request carries its status display',
    createdBody.statusDisplay?.label === 'Draft',
    JSON.stringify(createdBody.statusDisplay),
  );

  const { data: createdRow, error: createdReadError } = await supabaseAdmin
    .from('event_requests')
    .select('organiser_id, status, submitted_at')
    .eq('id', draftEventId)
    .single();
  check(
    'the stored owner is the signed-in organiser, not the one named in the body',
    !createdReadError && createdRow?.organiser_id === organiserId,
    createdRow?.organiser_id,
  );
  check(
    'the stored status is draft, not the one named in the body',
    createdRow?.status === 'draft',
    createdRow?.status,
  );
  check(
    'submitted_at is null on a draft, as the 005 constraint requires',
    createdRow?.submitted_at === null,
    String(createdRow?.submitted_at),
  );

  // -- SCRUM-45: the Coordinator's review queue -----------------------------
  //
  // Placed here, before the edit section below, because draftEventId is still
  // a draft at this point -- and "a draft never reaches the queue" is the
  // privacy boundary of the entire shared-queue design. There is no
  // coordinator_id on event_requests and no assignment model, so the status
  // filter IS the access control, and this is the only place it can be proved
  // against a live table.
  //
  // It is also the first exercise anywhere in this codebase of PostgREST's
  // .in() operator: no other query uses one, so until this runs the status
  // filter is untested against the real driver rather than a hand-rolled fake.
  //
  // State at this moment: eventId is under_review (the AC4 section moved it),
  // otherEventId is submitted and belongs to the OTHER Organiser, and
  // draftEventId is a draft belonging to this one.
  //
  // Nothing in this section or the second queue read below inserts an
  // event_requests row, so the count === 3 assertion at the tail of this
  // script is deliberately left untouched.

  // A second real sign-in, and the hazard this file's header spends eight
  // lines on is live again: signInWithPassword mutates supabaseAuth's
  // in-memory auth state, which now belongs to the coordinator. So the very
  // next thing checked is that the Organiser's already-issued token still
  // works. A token is a string minted once; it does not care who the client
  // signed in as afterwards -- but proving that rather than assuming it is
  // exactly what this script exists for.
  const { data: coordSession, error: coordSignInError } =
    await supabaseAuth.auth.signInWithPassword({
      email: coordinator.email,
      password: PASSWORD,
    });
  if (coordSignInError) {
    throw new Error(`could not sign in as the test coordinator: ${coordSignInError.message}`);
  }
  const coordinatorToken = coordSession.session.access_token;

  /** The same shape as authed(), with the Coordinator's token instead. */
  const asCoordinator = (path = '') =>
    fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${coordinatorToken}` } });

  const organiserStillWorks = await authed();
  check(
    "signing a second user in did not invalidate the organiser's token",
    organiserStillWorks.status === 200,
    `status ${organiserStillWorks.status}`,
  );

  const queueAsOrganiser = await authed('/queue');
  const queueAsOrganiserBody = await queueAsOrganiser.json();
  check(
    'an Event Organiser is refused the queue',
    queueAsOrganiser.status === 403,
    `status ${queueAsOrganiser.status}`,
  );
  check(
    'and the 403 names the role that would work, not the one they have',
    /Event Coordinators/.test(queueAsOrganiserBody.error ?? ''),
    queueAsOrganiserBody.error,
  );

  const queueAnonymous = await fetch(`${base}/queue`);
  check(
    'an unauthenticated request for the queue answers 401, not 403',
    queueAnonymous.status === 401,
    `status ${queueAnonymous.status}`,
  );

  const queueOne = await asCoordinator('/queue');
  const queueOneBody = await queueOne.json();
  check('a coordinator reads the queue', queueOne.status === 200, `status ${queueOne.status}`);
  check(
    'the queue is a bare array',
    Array.isArray(queueOneBody),
    Array.isArray(queueOneBody) ? `${queueOneBody.length} row(s)` : typeof queueOneBody,
  );

  const queued = Array.isArray(queueOneBody) ? queueOneBody : [];

  // The reported bug, proved end to end: a request read by a second person,
  // through the real middleware, against a table whose row level security is
  // deny-all. Every other route in this script answers 404 for a row the
  // caller does not own; this one must not.
  check(
    'the queue contains a request the coordinator does not own',
    queued.some((r) => r.id === eventId)
      && queued.every((r) => r.organiserId !== coordinatorId),
    `${queued.length} row(s)`,
  );
  check(
    'and it spans more than one organiser',
    queued.some((r) => r.organiserId === organiserId)
      && queued.some((r) => r.organiserId === otherOrganiserId),
    `${new Set(queued.map((r) => r.organiserId)).size} distinct organiser(s)`,
  );
  check(
    'every row carries its status display',
    queued.length > 0 && queued.every((r) => typeof r.statusDisplay?.label === 'string'),
    queued.map((r) => r.statusDisplay?.label).join(', '),
  );

  check(
    'a draft never reaches the queue',
    !queued.some((r) => r.id === draftEventId) && !queued.some((r) => r.status === 'draft'),
    queued.map((r) => r.status).join(', '),
  );

  // Oldest waiting first, asserted as a monotonic sequence rather than by
  // index. The rows this script inserts through the admin client carry no
  // submitted_at -- 005 constrains that column on drafts only -- so several
  // of them tie legitimately, and a "wrong row first" failure would be
  // misleading. The actual regression this guards is nullsFirst: false being
  // dropped, which would sort "never recorded" to the head of a queue ordered
  // by how long people have waited; treating null as +Infinity is what
  // catches it.
  const waitedSince = (row) =>
    row.submittedAt === null || row.submittedAt === undefined
      ? Number.POSITIVE_INFINITY
      : new Date(row.submittedAt).getTime();
  check(
    'the queue is ordered oldest waiting first, with no submission time last',
    queued.every((row, i) => i === 0 || waitedSince(queued[i - 1]) <= waitedSince(row)),
    queued.map((r) => r.submittedAt ?? 'null').join(' <= '),
  );

  // -- SCRUM-11: a draft is edited in place ----------------------------------
  const beforePatch = await (await authed(`/${draftEventId}`)).json();

  const patched = await authedWrite('PATCH', `/${draftEventId}`, {
    purpose: 'Connect final-year students with industry partners.',
  });
  const patchedBody = await patched.json();
  check('saving an edit to a draft answers 200', patched.status === 200, `status ${patched.status}`);
  check(
    'the field the edit named was saved',
    patchedBody.purpose === 'Connect final-year students with industry partners.',
    patchedBody.purpose,
  );
  check(
    'the field the edit did not mention is unchanged',
    patchedBody.eventName === `__check_routes_created_${STAMP}`,
    patchedBody.eventName,
  );

  // The one thing no unit test can prove. updated_at is maintained by the
  // event_requests_set_updated_at trigger and the service deliberately never
  // sends it, so a fake client can only ever hand back whatever was queued.
  check(
    'updated_at advanced, which only the trigger can have done',
    new Date(patchedBody.updatedAt).getTime() > new Date(beforePatch.updatedAt).getTime(),
    `${beforePatch.updatedAt} -> ${patchedBody.updatedAt}`,
  );

  const { data: foreignBefore } = await supabaseAdmin
    .from('event_requests')
    .select('event_name, status, updated_at')
    .eq('id', otherEventId)
    .single();

  const foreignPatch = await authedWrite('PATCH', `/${otherEventId}`, {
    eventName: `__check_routes_renamed_by_a_stranger_${STAMP}`,
  });
  check(
    "another organiser's request answers 404 to an edit",
    foreignPatch.status === 404,
    `status ${foreignPatch.status}`,
  );

  const { data: foreignAfter } = await supabaseAdmin
    .from('event_requests')
    .select('event_name, status, updated_at')
    .eq('id', otherEventId)
    .single();
  check(
    'and the foreign row is byte-for-byte untouched',
    foreignAfter?.event_name === foreignBefore?.event_name
      && foreignAfter?.updated_at === foreignBefore?.updated_at,
    `${foreignBefore?.event_name} / ${foreignAfter?.event_name}`,
  );

  // eventId was moved to 'under_review' by the AC4 section above, so it is the
  // ready-made case for "the body was fine, the row's state was not".
  const patchMoved = await authedWrite('PATCH', `/${eventId}`, {
    eventName: `__check_routes_too_late_${STAMP}`,
  });
  check(
    'a request that is no longer a draft answers 409 to an edit',
    patchMoved.status === 409,
    `status ${patchMoved.status}`,
  );

  // A PATCH racing a submit cannot be provoked deterministically from a
  // single-threaded script -- there is no way to hold the read open across the
  // write from here, and a Promise.all of two requests would prove only that
  // one of them won. So the .eq('status','draft') guard is proved by the
  // PGRST116 unit test and by the filter being present in the statement, and
  // that limit is stated here rather than simulated with something that looks
  // like a race and is not. Same honesty as the SCRUM-47 note below.

  // -- SCRUM-10: a draft is submitted for review -----------------------------
  const incomplete = await authedWrite('POST', `/${draftEventId}/submit`);
  const incompleteBody = await incomplete.json();
  check(
    'an incomplete draft cannot be submitted',
    incomplete.status === 400,
    `status ${incomplete.status}`,
  );
  check(
    'and every gap is listed at once, not one per retry',
    Array.isArray(incompleteBody.details) && incompleteBody.details.length > 1,
    `${incompleteBody.details?.length} gap(s): ${incompleteBody.details?.map((d) => d.field).join(', ')}`,
  );

  const completed = await authedWrite('PATCH', `/${draftEventId}`, {
    ...futurePeriod(),
    expectedAttendance: 120,
  });
  check(
    'the remaining gaps can be filled in one PATCH',
    completed.status === 200,
    `status ${completed.status}`,
  );

  const submitted = await authedWrite('POST', `/${draftEventId}/submit`);
  const submittedBody = await submitted.json();
  check('a complete draft is submitted', submitted.status === 200, `status ${submitted.status}`);
  check('the response reports the new status', submittedBody.status === 'submitted', submittedBody.status);

  // The 005 constraint, event_requests_submitted_at_matches_status, satisfied
  // by a real write rather than asserted against a fake's queued row.
  const { data: submittedRow } = await supabaseAdmin
    .from('event_requests')
    .select('status, submitted_at')
    .eq('id', draftEventId)
    .single();
  check(
    'submitted_at was stamped alongside the status, satisfying the 005 constraint',
    submittedRow?.status === 'submitted' && typeof submittedRow?.submitted_at === 'string',
    `${submittedRow?.status} / ${submittedRow?.submitted_at}`,
  );

  const submittedTwice = await authedWrite('POST', `/${draftEventId}/submit`);
  check(
    'a submitted request cannot be submitted again',
    submittedTwice.status === 409,
    `status ${submittedTwice.status}`,
  );

  // -- SCRUM-45: a request submitted over HTTP joins the queue ---------------
  //
  // The half of the queue proof that closes the loop on the reported bug.
  // draftEventId was created, edited and submitted entirely over HTTP by an
  // Organiser, and a moment ago the queue correctly refused to show it while
  // it was a draft. Nothing has happened to it since but the status change,
  // so this is the reported journey end to end: an Organiser submits, and a
  // Coordinator sees it.
  const queueTwo = await asCoordinator('/queue');
  const queueTwoBody = await queueTwo.json();
  const requeued = Array.isArray(queueTwoBody) ? queueTwoBody : [];
  check(
    'a request submitted over HTTP joins the queue',
    queueTwo.status === 200 && requeued.some((r) => r.id === draftEventId),
    `status ${queueTwo.status}, ${requeued.length} row(s)`,
  );
  check(
    'and it arrives carrying the status the submit gave it',
    requeued.find((r) => r.id === draftEventId)?.statusDisplay?.label === 'Submitted',
    requeued.find((r) => r.id === draftEventId)?.statusDisplay?.label,
  );

  // The ownership hole, proved live. otherEventId is made a complete draft
  // first, because a request that could not be submitted anyway would answer
  // 404 for the wrong reason and the check would pass with the pre-check
  // deleted. With the row genuinely submittable, the ONLY thing standing
  // between this call and a foreign submit is the route's pre-check --
  // submitEventRequest takes no organiserId and checks nothing.
  const foreignPeriod = futurePeriod();
  const { error: makeDraftError } = await supabaseAdmin
    .from('event_requests')
    .update({
      status: 'draft',
      submitted_at: null,
      purpose: 'A complete draft belonging to somebody else.',
      proposed_start: foreignPeriod.proposedStart,
      proposed_end: foreignPeriod.proposedEnd,
      expected_attendance: 50,
    })
    .eq('id', otherEventId);
  if (makeDraftError) {
    throw new Error(`could not prepare the foreign draft: ${makeDraftError.message}`);
  }

  const foreignSubmit = await authedWrite('POST', `/${otherEventId}/submit`);
  check(
    "another organiser's submittable draft answers 404, not 200",
    foreignSubmit.status === 404,
    `status ${foreignSubmit.status}`,
  );

  const { data: foreignSubmitAfter } = await supabaseAdmin
    .from('event_requests')
    .select('status, submitted_at')
    .eq('id', otherEventId)
    .single();
  check(
    'and it is still a draft with no submitted_at',
    foreignSubmitAfter?.status === 'draft' && foreignSubmitAfter?.submitted_at === null,
    `${foreignSubmitAfter?.status} / ${foreignSubmitAfter?.submitted_at}`,
  );

  // -- SCRUM-32 / SCRUM-34: change requests ----------------------------------
  const changeOne = await authedWrite('POST', `/${draftEventId}/change-requests`, {
    field: 'venue',
    details: 'A larger room, the RSVPs have doubled.',
  });
  const changeOneBody = await changeOne.json();
  check(
    'a change request against a submitted event answers 201',
    changeOne.status === 201,
    `status ${changeOne.status}`,
  );
  check(
    'it is recorded against the right event, by the signed-in organiser',
    changeOneBody.eventRequestId === draftEventId && changeOneBody.requestedBy === organiserId,
    `${changeOneBody.eventRequestId} / ${changeOneBody.requestedBy}`,
  );
  check(
    'the 201 body carries no fieldLabel -- that shape belongs to the list',
    changeOneBody.fieldLabel === undefined,
    String(changeOneBody.fieldLabel),
  );

  const changeTwo = await authedWrite('POST', `/${draftEventId}/change-requests`, {
    field: 'equipment',
    details: 'Two handheld microphones and a projector.',
  });
  check('a second change request is accepted', changeTwo.status === 201, `status ${changeTwo.status}`);

  const listed = await authed(`/${draftEventId}/change-requests`);
  const listedBody = await listed.json();
  check('the change request list answers 200', listed.status === 200, `status ${listed.status}`);
  check(
    'it is a bare array carrying both requests',
    Array.isArray(listedBody) && listedBody.length === 2,
    `${Array.isArray(listedBody) ? listedBody.length : typeof listedBody}`,
  );

  // Asserted as an ordering rather than by index, so a coarse clock that gave
  // both rows the same created_at reports a tie honestly instead of failing
  // with a misleading "wrong row first".
  const createdTimes = (listedBody ?? []).map((row) => new Date(row.createdAt).getTime());
  check(
    'the list is newest first',
    createdTimes.every((time, i) => i === 0 || createdTimes[i - 1] >= time),
    createdTimes.join(' >= '),
  );

  const venueRow = (listedBody ?? []).find((row) => row.changeField === 'venue');
  check(
    "the venue row carries the label the Organiser's list renders",
    venueRow?.fieldLabel === 'Venue',
    venueRow?.fieldLabel,
  );

  const emptyList = await authed(`/${eventId}/change-requests`);
  const emptyListBody = await emptyList.json();
  check(
    'an event nobody has asked to change answers 200 and an empty array',
    emptyList.status === 200 && Array.isArray(emptyListBody) && emptyListBody.length === 0,
    `status ${emptyList.status}, body ${JSON.stringify(emptyListBody)}`,
  );

  // The reason the route pre-checks ownership rather than trusting the
  // service: getChangeRequestsForEvent answers 400 for a foreign event and 404
  // for a missing one, which is an enumeration oracle. This extends the
  // indistinguishability check already made on GET /:id above to the route
  // that would otherwise reintroduce it.
  const foreignList = await authed(`/${otherEventId}/change-requests`);
  const foreignListBody = await foreignList.json();
  check(
    "another organiser's change request list answers 404, not the service's 400",
    foreignList.status === 404,
    `status ${foreignList.status}`,
  );

  const missingList = await authed('/00000000-0000-4000-8000-000000000000/change-requests');
  const missingListBody = await missingList.json();
  check(
    'a change request list for an id that does not exist answers 404',
    missingList.status === 404,
    `status ${missingList.status}`,
  );
  check(
    'and those two 404s are indistinguishable, so ids cannot be enumerated here either',
    withoutId(foreignListBody, otherEventId)
      === withoutId(missingListBody, '00000000-0000-4000-8000-000000000000'),
    `${withoutId(foreignListBody, otherEventId)} / ${withoutId(missingListBody, '00000000-0000-4000-8000-000000000000')}`,
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
  // Three, not two, since the SCRUM-29 section above creates a third row
  // through POST / rather than through the admin client. Flagged in review
  // because changing a number in an existing assertion looks like editing a
  // test: this is a hand-run check script, not part of the vitest suite, and
  // the plan sanctions this one line explicitly.
  check('only this run\'s three test rows exist, ready for cleanup', count === 3, `${count} row(s)`);
}

main()
  .catch((err) => {
    console.error(`\nFailed: ${err.message}`);
    failures += 1;
  })
  .finally(async () => {
    await cleanup();
    await verifyCleanup();
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed.\n`);
      process.exit(1);
    }
    console.log('\nAll checks passed. Signed in, scoped, tracked a status change, cleaned up.\n');
  });
