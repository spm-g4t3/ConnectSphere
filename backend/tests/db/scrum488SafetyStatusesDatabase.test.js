/**
 * SCRUM-488 AC1 and AC4 (SCRUM-550): the safety_review and safety_approved
 * event statuses and the constraints that decide which statuses a row and its
 * history may hold, against the final schema.
 *
 * The constraints are read from pg_constraint as well as exercised, because a
 * constraint that accepts the right rows can still list a wrong status.
 * Constraint tests seed rows straight into a safety status (seedEvent); moving
 * an event into one goes through the safety check's records, as the status
 * trigger requires.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor, refusal } from './helpers/queries.js';

// Written out, not read from the domain module: the test states what the
// database must hold.
const NINE = [
  'approved', 'cancelled', 'completed', 'confirmed', 'draft',
  'pending_clarification', 'rejected', 'submitted', 'under_review',
];
const SAFETY = ['safety_review', 'safety_approved'];
const ELEVEN = [...NINE, ...SAFETY].sort();

/** The distinct quoted words in a constraint's definition, sorted. */
const quotedWords = (definition) => [...new Set([...definition.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]))].sort();

describe('SCRUM-488 AC1, AC4: the safety statuses and their constraints', () => {
  let db;
  let organiser;
  let coordinator;
  let safetyOfficer;

  const { one } = queriesFor(() => db);
  const definitionOf = async (table, name) => (await one(
    'select pg_get_constraintdef(oid) as definition from pg_constraint where conname = $1 and conrelid = $2::regclass',
    [name, table],
  )).definition;

  /**
   * An event row at `status`, with what a real one has: held by its
   * coordinator once under review, and the approval a decided status requires.
   */
  function insertEvent(status, extra = {}) {
    const reviewed = !['draft', 'submitted', 'cancelled'].includes(status);
    const decided = ['approved', 'confirmed', 'completed', 'rejected', ...SAFETY].includes(status);
    return seedEvent(db, {
      status,
      organiser_id: organiser,
      event_name: `event ${status}`,
      ...(reviewed && { reviewing_coordinator_id: coordinator }),
      ...(decided && { decision_note: status === 'rejected' ? 'Not viable as submitted.' : 'Looks fine.' }),
      ...extra,
    });
  }

  const history = (id, previous, next, reason = null) => db.query(
    `insert into event_request_status_history (event_request_id, previous_status, new_status, changed_by, reason)
     values ($1, $2, $3, $4, $5)`,
    [id, previous, next, coordinator, reason],
  );

  // The status trigger lets an approved event into Safety review only with a
  // submission it would pass (future dates, an approved venue covering them),
  // and out to Safety approved only with the Safety Officer's approval.
  async function submitForSafetyCheck(id) {
    await db.query(
      `update event_requests
          set proposed_start = now() + interval '30 days', proposed_end = now() + interval '30 days 2 hours'
        where id = $1`,
      [id],
    );
    const venueId = await seedVenue(db, { name: `Hall for ${id}`, capacity: 100, setup: 0, turnaround: 0 });
    await seedBooking(db, { venueId: venueId, eventId: id, status: 'approved' });
    await db.query('insert into safety_review_submissions (event_request_id, submitted_by) values ($1, $2)', [id, coordinator]);
  }
  const approveSafetyCheck = (id) => db.query(
    "insert into safety_review_responses (event_request_id, safety_officer_id, outcome) values ($1, $2, 'approved')",
    [id, safetyOfficer],
  );

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await seedUser(db, { email: 'o@x' });
    coordinator = await seedUser(db, { email: 'c@x' });
    safetyOfficer = await seedUser(db, { email: 's@x' });
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM488_AC1_the_enum_has_both_safety_statuses', async () => {
    const { rows: [{ labels }] } = await db.query('select enum_range(null::event_request_status)::text as labels');
    const values = labels.replace(/[{}]/g, '').split(',');

    // Live appended them after cancelled; nothing compares statuses by enum order.
    expect(values).toEqual(expect.arrayContaining(ELEVEN));
    // The enum is append-only: planning stays in it and is refused below.
    expect(values).toContain('planning');
  });

  it('SCRUM488_AC1_the_lifecycle_constraint_lists_exactly_the_eleven_statuses_and_not_planning', async () => {
    const definition = await definitionOf('event_requests', 'event_requests_status_in_lifecycle');

    expect(quotedWords(definition)).toEqual(ELEVEN);
  });

  it('SCRUM488_AC1_both_decided_status_lists_carry_the_safety_statuses_and_not_planning', async () => {
    const requiring = await definitionOf('event_requests', 'event_requests_decided_status_has_decision');
    const allowing = await definitionOf('event_requests', 'event_requests_decision_has_decided_status');

    expect(quotedWords(requiring)).toEqual(
      ['approved', 'completed', 'confirmed', 'rejected', ...SAFETY].sort(),
    );
    // The second list is the first and cancelled.
    expect(quotedWords(allowing)).toEqual(
      ['approved', 'cancelled', 'completed', 'confirmed', 'rejected', ...SAFETY].sort(),
    );
  });

  it('SCRUM488_AC1_the_history_constraint_holds_the_same_eleven_for_both_columns', async () => {
    const definition = await definitionOf(
      'event_request_status_history', 'event_request_status_history_statuses_in_lifecycle',
    );

    expect(quotedWords(definition)).toEqual(ELEVEN);
    expect(definition).toMatch(/previous_status/);
    expect(definition).toMatch(/new_status/);
  });

  it('SCRUM488_AC1_no_status_constraint_still_names_planning_and_each_is_defined_once', async () => {
    const { rows: names } = await db.query(
      `select conname from pg_constraint
        where conrelid in ('event_requests'::regclass, 'event_request_status_history'::regclass)
          and pg_get_constraintdef(oid) ilike '%planning%'`,
    );
    const { rows: counts } = await db.query(
      `select conname, count(*)::int as n from pg_constraint
        where conname in ('event_requests_status_in_lifecycle',
                          'event_requests_decided_status_has_decision',
                          'event_requests_decision_has_decided_status',
                          'event_request_status_history_statuses_in_lifecycle')
        group by conname`,
    );

    expect(names).toEqual([]);
    expect(counts.map((row) => row.n)).toEqual([1, 1, 1, 1]);
  });

  it.each(SAFETY)('SCRUM488_AC1_stores_a_new_event_in_%s_with_its_decision', async (status) => {
    const id = await insertEvent(status);

    const stored = await one('select status::text as status, decision, decided_by from event_requests where id = $1', [id]);
    expect(stored).toEqual({ status, decision: 'approved', decided_by: coordinator });
  });

  it.each(SAFETY)('SCRUM488_AC1_moves_an_approved_event_into_%s_and_keeps_its_decision', async (status) => {
    const id = await insertEvent('approved');
    const { decision, decision_note, decided_by, decided_at } = await one('select * from event_requests where id = $1', [id]);

    await submitForSafetyCheck(id);
    await db.query("update event_requests set status = 'safety_review' where id = $1", [id]);
    if (status === 'safety_approved') {
      await approveSafetyCheck(id);
      await db.query("update event_requests set status = 'safety_approved' where id = $1", [id]);
    }

    const moved = await one('select * from event_requests where id = $1', [id]);
    expect(moved.status).toBe(status);
    expect({ decision: moved.decision, decision_note: moved.decision_note, decided_by: moved.decided_by, decided_at: moved.decided_at })
      .toEqual({ decision, decision_note, decided_by, decided_at });
  });

  it('SCRUM488_AC1_a_cancelled_event_may_come_from_a_safety_status_and_keep_its_approval', async () => {
    const id = await insertEvent('safety_review');

    await db.query("update event_requests set status = 'cancelled' where id = $1", [id]);

    expect((await one('select status::text as status, decision from event_requests where id = $1', [id])))
      .toEqual({ status: 'cancelled', decision: 'approved' });
  });

  it.each(SAFETY)('SCRUM488_AC1_refuses_%s_with_no_decision', async (status) => {
    const err = await refusal(insertEvent(status, {
      decision: null, decision_note: null, decided_by: null, decided_at: null,
    }));

    expect(err.message).toContain('event_requests_decided_status_has_decision');
  });

  it.each(SAFETY)('SCRUM488_AC1_refuses_a_rejection_in_%s_with_no_reason', async (status) => {
    const err = await refusal(insertEvent(status, { decision: 'rejected', decision_note: null }));

    expect(err.message).toContain('event_requests_rejection_has_reason');
  });

  it('SCRUM488_AC1_still_refuses_a_decision_on_a_status_that_is_not_decided', async () => {
    for (const status of ['draft', 'submitted', 'under_review', 'pending_clarification']) {
      const err = await refusal(insertEvent(status, {
        reviewing_coordinator_id: coordinator,
        decision: 'approved', decided_by: coordinator, decided_at: new Date().toISOString(),
      }));

      expect(err?.message, status).toContain('event_requests_decision_has_decided_status');
    }
  });

  it('SCRUM488_AC1_still_refuses_the_retired_planning_status', async () => {
    const err = await refusal(insertEvent('planning'));

    expect(err.message).toContain('event_requests_status_in_lifecycle');
  });

  it('SCRUM488_AC1_still_refuses_an_approval_on_a_row_with_the_decision_fields_split', async () => {
    const err = await refusal(insertEvent('safety_review', { decided_at: null }));

    expect(err.message).toContain('event_requests_decision_fields_together');
  });

  it.each([
    ['approved', 'safety_review'],
    ['safety_review', 'safety_approved'],
    ['safety_review', 'approved'],
    ['safety_approved', 'confirmed'],
    ['safety_approved', 'approved'],
    ['safety_review', 'cancelled'],
  ])('SCRUM488_AC4_stores_a_history_row_for_%s_to_%s', async (previous, next) => {
    const id = await insertEvent('approved');

    await history(id, previous, next, 'Sent back with reasons.');

    const row = await one(
      'select previous_status::text as previous, new_status::text as next, changed_by, reason from event_request_status_history where event_request_id = $1',
      [id],
    );
    expect(row).toEqual({ previous, next, changed_by: coordinator, reason: 'Sent back with reasons.' });
  });

  it.each([
    ['planning', 'approved'],
    ['approved', 'planning'],
  ])('SCRUM488_AC4_still_refuses_a_history_row_for_%s_to_%s', async (previous, next) => {
    const id = await insertEvent('approved');

    const err = await refusal(history(id, previous, next));

    expect(err.message).toContain('event_request_status_history_statuses_in_lifecycle');
  });

  it('SCRUM488_AC4_still_refuses_a_history_row_that_changes_nothing', async () => {
    const id = await insertEvent('safety_review');

    const err = await refusal(history(id, 'safety_review', 'safety_review'));

    expect(err.message).toContain('event_request_status_history_status_changes');
  });
});
