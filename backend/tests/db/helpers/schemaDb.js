import { beforeAll, afterAll } from 'vitest';

import { baselineFiles, createDatabase } from '../../../db/loadSchema.js';
import { withSafetyReviewTransitionGuardDisabled } from '../../fixtures/safetyReviewTestHelpers.js';

// The final schema, built the way production's is: Supabase's preamble (auth
// schema, auth.users, the three API roles) and then every baseline file. Each
// call returns a fresh in-memory database, so suites never share rows.
export function createSchemaDb() {
  return createDatabase(baselineFiles());
}

// One built schema per test file, opened before its tests and closed after.
// Returns a getter, because the database only exists once beforeAll has run.
export function useSchemaDb(timeout = 60_000) {
  let db;
  beforeAll(async () => {
    db = await createSchemaDb();
  }, timeout);
  afterAll(async () => {
    await db?.close();
  });
  return () => db;
}

// Every SQL and PL/pgSQL function in public, by name, with its source as
// written (comments included). An overload would make a name ambiguous here,
// as it does for PostgREST (PGRST203), so one is refused.
export async function functionSources(db) {
  const { rows } = await db.query(
    `select p.proname as name, p.prosrc as source
       from pg_proc p
       join pg_language l on l.oid = p.prolang
      where p.pronamespace = 'public'::regnamespace
        and l.lanname in ('sql', 'plpgsql')`,
  );
  const sources = {};
  for (const { name, source } of rows) {
    if (name in sources) throw new Error(`${name} is overloaded`);
    sources[name] = source;
  }
  return sources;
}

const DECIDED_STATUSES =['approved', 'safety_review', 'safety_approved', 'confirmed', 'completed', 'rejected'];
const UNASSIGNED_STATUSES = ['draft', 'submitted', 'cancelled'];
const INSERT_REFUSED_STATUSES = ['safety_review', 'safety_approved', 'confirmed'];

// Seeds an event already in `status`, filling the columns event_requests'
// checks demand of that status. The coordinator (reviewing, else assigned) is
// also the decider, as event_requests_decided_by_is_reviewer requires.
export async function seedEvent(db, { status = 'draft', ...overrides } = {}) {
  const coordinator = overrides.reviewing_coordinator_id ?? overrides.assigned_coordinator_id ?? null;
  const decided = DECIDED_STATUSES.includes(status) || (status === 'cancelled' && overrides.decision != null);
  const decision = overrides.decision ?? (status === 'rejected' ? 'rejected' : 'approved');
  const row = {
    event_name: 'Seeded event',
    status,
    ...(status !== 'draft' && { submitted_at: new Date() }),
    ...(!UNASSIGNED_STATUSES.includes(status) && { assigned_coordinator_id: coordinator }),
    ...(decided && {
      reviewing_coordinator_id: coordinator,
      decision,
      decided_by: coordinator,
      decided_at: new Date(),
      ...(decision === 'rejected' && { decision_note: 'Seeded rejection' }),
    }),
    ...overrides,
  };
  const columns = Object.keys(row);
  const insert = () => db.query(
    `insert into event_requests (${columns.join(', ')})
     values (${columns.map((_, index) => `$${index + 1}`).join(', ')})
     returning id`,
    Object.values(row),
  );
  // The safety trigger refuses these statuses on insert: real events reach them
  // only through the workflow, which a fixture skips.
  const { rows } = INSERT_REFUSED_STATUSES.includes(status)
    ? await withSafetyReviewTransitionGuardDisabled(db, insert)
    : await insert();
  return rows[0].id;
}

// Rejects, reopens and resubmits an approved event through the real functions.
// It keeps its bookings and holds and waits in the Lead's queue with no
// coordinator: the only way an event with bookings has none.
export async function returnToLeadQueue(db, eventId, { coordinator, organiser }) {
  await db.query("select change_event_request_status($1, 'approved', 'rejected', $2)", [eventId, coordinator]);
  await db.query("select change_event_request_status($1, 'rejected', 'draft', $2)", [eventId, organiser]);
  await db.query('select submit_event_request($1, now(), $2)', [eventId, organiser]);
}

// An auth user, with a profile only when a role is given (some tests need a
// user the role checks cannot place). A null full_name is the column's own default.
export async function seedUser(db, { email, role, fullName = null }) {
  const { rows } = await db.query('insert into auth.users (email) values ($1) returning id', [email]);
  const { id } = rows[0];
  if (role) await db.query('insert into profiles (id, role, full_name) values ($1, $2, $3)', [id, role, fullName]);
  return id;
}

// The caller names the venue: venue names must be unique, and most files share
// one counter between their venues and events.
export async function seedVenue(db, { name, location = 'Block A', capacity = 200, setup = 30, turnaround = 45 }) {
  const { rows } = await db.query(
    `insert into venues (name, location, max_capacity, setup_minutes, turnaround_minutes)
     values ($1, $2, $3, $4, $5) returning id`,
    [name, location, capacity, setup, turnaround],
  );
  return rows[0].id;
}

// A booking written directly, skipping create_booking_request. Without times
// it takes its event's period. A review block also stamps flagged_at, as
// bookings_review_flag_paired requires of a flagged_for_review booking.
export async function seedBooking(
  db,
  { venueId, eventId, status = 'pending', start, end, reviewBlockId = null, requestedBy = null },
) {
  let [startsAt, endsAt] = [start, end];
  if (startsAt == null || endsAt == null) {
    const { rows } = await db.query('select proposed_start, proposed_end from event_requests where id = $1', [eventId]);
    startsAt ??= rows[0].proposed_start;
    endsAt ??= rows[0].proposed_end;
  }
  const { rows } = await db.query(
    `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status, review_block_id, flagged_at, requested_by)
     values ($1, $2, $3, $4, $5, $6, ${reviewBlockId ? 'now()' : 'null'}, $7) returning id`,
    [venueId, eventId, startsAt, endsAt, status, reviewBlockId, requestedBy],
  );
  return rows[0].id;
}

// A maintenance block written directly, skipping create_venue_block's checks.
// A removed one occupies nothing.
export async function seedBlock(db, { venueId, start, end, removed = false }) {
  const { rows } = await db.query(
    `insert into venue_blocks (venue_id, starts_at, ends_at, reason, removed_at)
     values ($1, $2, $3, 'maintenance', ${removed ? 'now()' : 'null'}) returning id`,
    [venueId, start, end],
  );
  return rows[0].id;
}
