import { baselineFiles, createDatabase } from '../../../db/loadSchema.js';
import { withSafetyReviewTransitionGuardDisabled } from '../../fixtures/safetyReviewTestHelpers.js';

// The final schema, built the way production's is: Supabase's preamble (auth
// schema, auth.users, the three API roles) and then every baseline file. Each
// call returns a fresh in-memory database, so suites never share rows.
export function createSchemaDb() {
  return createDatabase(baselineFiles());
}

const DECIDED_STATUSES = ['approved', 'safety_review', 'safety_approved', 'confirmed', 'completed', 'rejected'];
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
