/**
 * SCRUM-582: the equipment requests a Technical Support user has reviewed,
 * against the final schema in a real Postgres (PGlite).
 *
 * Named SCRUM582_AC<n>_<what_it_checks>. Reviews are driven with the real
 * functions (start, take over, mark, complete, amend a line). The Safety
 * return is the one exception: it is written the way respond_to_safety_review
 * writes it (a status change and an 'interrupted' row by the Safety Officer),
 * because running a whole Safety review adds nothing to what is read here.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedEvent, seedUser } from './helpers/schemaDb.js';
import { queriesFor, expectSqlError } from './helpers/queries.js';
import { asJson } from './helpers/equipment.js';
import { clientsCanExecute } from './helpers/grants.js';

const START = '2030-03-01T10:00:00Z';
const END = '2030-03-01T12:00:00Z';

describe('SCRUM-582: requests I have reviewed before, in Postgres', () => {
  let db;
  let organiser;
  let coordinator;
  let tech;
  let other;
  let safetyOfficer;
  let projector;
  let counter = 0;

  const { one, rows } = queriesFor(() => db);

  const newType = async (name) =>
    (await one('insert into equipment_types (name, total_quantity) values ($1, 10) returning id', [name])).id;
  const newEvent = (name) =>
    seedEvent(db, {
      status: 'approved',
      organiser_id: organiser,
      event_name: name ?? `Event ${(counter += 1)}`,
      assigned_coordinator_id: coordinator,
      proposed_start: START,
      proposed_end: END,
    });

  const add = async (event, type, quantity) =>
    asJson(await one('select add_equipment_line($1, $2, $3, $4, $5)::text as answer', [event, coordinator, type, quantity, null]));
  const amend = async (event, line, quantity) =>
    asJson(await one('select amend_equipment_line($1, $2, $3, $4)::text as answer', [event, coordinator, line, quantity]));
  const start = async (event, who) =>
    asJson(await one('select start_equipment_review($1, $2)::text as answer', [event, who]));
  const takeOver = async (event, who) =>
    asJson(await one('select take_over_equipment_review($1, $2)::text as answer', [event, who]));
  const mark = async (event, who, line) =>
    asJson(await one('select mark_equipment_line_unavailable($1, $2, $3, $4)::text as answer', [event, who, line, 'None left']));
  const complete = async (event, who) =>
    asJson(await one('select complete_equipment_review($1, $2)::text as answer', [event, who]));
  const mine = async (who = tech, limit) =>
    asJson(await one('select equipment_reviewed_by_me($1, $2)::text as answer', [who, limit ?? 200]));

  /** An approved event with one projector line, and its request id. */
  const eventWithRequest = async (name) => {
    const event = await newEvent(name);
    const state = await add(event, projector, 2);
    return { event, requestId: state.request.id, line: state.request.lines[0].id };
  };
  const entry = (list, event) => list.requests.find((r) => r.event_request_id === event);
  const setStatus = (requestId, status) =>
    db.query('update equipment_requests set status = $2 where id = $1', [requestId, status]);

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await seedUser(db, { email: 'organiser@example.com', role: 'event_organiser' });
    coordinator = await seedUser(db, { email: 'coordinator@example.com', role: 'event_coordinator' });
    tech = await seedUser(db, { email: 'tech@example.com', role: 'technical_support_staff' });
    other = await seedUser(db, { email: 'other-tech@example.com', role: 'technical_support_staff' });
    safetyOfficer = await seedUser(db, { email: 'safety@example.com', role: 'safety_officer' });
    projector = await newType('Projector');
  }, 60000);

  afterAll(async () => {
    await db?.close();
  });

  describe('AC1: the list is my own review history', () => {
    it('SCRUM582_AC1_lists_requests_I_started_and_requests_I_took_over', async () => {
      const first = await eventWithRequest();
      const second = await eventWithRequest();
      await start(first.event, tech);
      await start(second.event, other);
      await takeOver(second.event, tech);

      const found = (await mine()).requests.map((r) => r.event_request_id);
      expect(found).toEqual(expect.arrayContaining([first.event, second.event]));
    });

    it('SCRUM582_AC5_does_not_list_a_request_only_someone_else_reviewed', async () => {
      const theirs = await eventWithRequest();
      await start(theirs.event, other);

      expect((await mine(tech)).requests.map((r) => r.event_request_id)).not.toContain(theirs.event);
      expect((await mine(other)).requests.map((r) => r.event_request_id)).toContain(theirs.event);
    });

    it('SCRUM582_AC1_a_request_nobody_has_started_is_not_listed', async () => {
      const untouched = await eventWithRequest();
      expect((await mine()).requests.map((r) => r.event_request_id)).not.toContain(untouched.event);
    });

    it('SCRUM582_AC1_each_request_appears_once_however_many_times_I_worked_on_it', async () => {
      const { event, line } = await eventWithRequest();
      await start(event, tech);
      await mark(event, tech, line);
      await complete(event, tech);

      expect((await mine()).requests.filter((r) => r.event_request_id === event)).toHaveLength(1);
    });

    it('SCRUM582_AC2_carries_the_event_name_period_and_request_status', async () => {
      const { event } = await eventWithRequest('Annual Dinner');
      await start(event, tech);

      expect(entry(await mine(), event)).toMatchObject({
        event_name: 'Annual Dinner',
        status: 'under_review',
        returned_to_pending: false,
        interrupted_reason: null,
        interrupted_at: null,
      });
      expect(new Date(entry(await mine(), event).proposed_start).toISOString()).toBe('2030-03-01T10:00:00.000Z');
    });

    it('SCRUM582_AC1_the_most_recently_worked_request_comes_first', async () => {
      const older = await eventWithRequest();
      const newer = await eventWithRequest();
      await start(older.event, tech);
      await start(newer.event, tech);
      await db.query(
        "update equipment_review_history set created_at = now() - interval '2 days' where equipment_request_id = $1",
        [older.requestId],
      );

      const ids = (await mine()).requests.map((r) => r.event_request_id);
      expect(ids.indexOf(newer.event)).toBeLessThan(ids.indexOf(older.event));
    });
  });

  describe('AC2: why a review I started ended', () => {
    it('SCRUM582_AC3_a_request_that_came_back_to_pending_review_since_I_worked_on_it_is_marked', async () => {
      const { event, line } = await eventWithRequest();
      await start(event, tech);
      await amend(event, line, 3);

      expect(entry(await mine(), event)).toMatchObject({
        status: 'pending_review',
        returned_to_pending: true,
        interrupted_reason: 'The lines were changed during the review',
      });
      expect(entry(await mine(), event).interrupted_at).not.toBeNull();
    });

    it('SCRUM582_AC2_a_line_change_by_the_coordinator_shows_the_lines_were_changed', async () => {
      const { event, line } = await eventWithRequest();
      await start(event, tech);
      await amend(event, line, 3);

      expect(entry(await mine(), event).interrupted_reason).toBe('The lines were changed during the review');
    });

    it('SCRUM582_AC2_a_reservation_flagged_during_the_review_shows_that_reason', async () => {
      const { event, line } = await eventWithRequest();
      await start(event, tech);
      // What flag_equipment_for_reservations writes before it returns the request to Pending.
      await db.query("select set_config('equipment.interrupt_reason', 'A reservation was flagged during the review. Venue closed.', false)");
      await amend(event, line, 3);
      await db.query("select set_config('equipment.interrupt_reason', '', false)");

      expect(entry(await mine(), event).interrupted_reason).toBe('A reservation was flagged during the review. Venue closed.');
    });

    it('SCRUM582_AC2_a_cancelled_request_shows_it_was_cancelled', async () => {
      const { event, requestId } = await eventWithRequest();
      await start(event, tech);
      await setStatus(requestId, 'cancelled');

      expect(entry(await mine(), event)).toMatchObject({
        status: 'cancelled',
        returned_to_pending: false,
        interrupted_reason: 'The request was cancelled during the review',
      });
    });

    it('SCRUM582_AC2_a_return_from_Safety_shows_the_Safety_reason_even_though_the_row_names_the_Safety_Officer', async () => {
      const { event, requestId, line } = await eventWithRequest();
      await start(event, tech);
      await mark(event, tech, line);
      await complete(event, tech);
      // What respond_to_safety_review writes when the equipment is affected.
      await setStatus(requestId, 'pending_review');
      await db.query(
        `insert into equipment_review_history (equipment_request_id, action, user_id, note)
         values ($1, 'interrupted', $2, 'Returned for review after Safety review')`,
        [requestId, safetyOfficer],
      );

      expect(entry(await mine(), event)).toMatchObject({
        returned_to_pending: true,
        interrupted_reason: 'Returned for review after Safety review',
      });
    });

    it('SCRUM582_AC2_a_review_someone_else_interrupted_later_is_not_blamed_on_my_earlier_one', async () => {
      const { event, line, requestId } = await eventWithRequest();
      await start(event, tech);
      await amend(event, line, 3);
      await start(event, other);
      await setStatus(requestId, 'cancelled');

      // Mine ended with the line change; the cancellation belongs to the other reviewer.
      const mineNow = entry(await mine(tech), event);
      const theirsNow = entry(await mine(other), event);
      expect(mineNow.interrupted_reason).toBe('The lines were changed during the review');
      expect(theirsNow.interrupted_reason).toBe('The request was cancelled during the review');
      expect(new Date(mineNow.interrupted_at).getTime()).toBeLessThanOrEqual(new Date(theirsNow.interrupted_at).getTime());
    });

    it('SCRUM582_AC2_a_request_interrupted_twice_shows_the_latest_reason_not_the_first', async () => {
      const { event, line, requestId } = await eventWithRequest();
      await start(event, tech);
      await amend(event, line, 3);
      await start(event, tech);
      await setStatus(requestId, 'cancelled');

      expect(entry(await mine(), event)).toMatchObject({
        status: 'cancelled',
        interrupted_reason: 'The request was cancelled during the review',
      });
    });

    it('SCRUM582_AC2_a_review_taken_over_by_someone_else_was_not_interrupted_so_shows_no_reason', async () => {
      const { event, line } = await eventWithRequest();
      await start(event, other);
      await takeOver(event, tech);
      await amend(event, line, 3);

      // The other reviewer lost it to a take over, not to the line change: that ended tech's review.
      expect(entry(await mine(other), event).interrupted_reason).toBeNull();
      expect(entry(await mine(tech), event).interrupted_reason).toBe('The lines were changed during the review');
    });

    it('SCRUM582_AC3_a_request_I_took_over_again_after_it_came_back_is_not_marked', async () => {
      const { event, line } = await eventWithRequest();
      await start(event, tech);
      await amend(event, line, 3);
      await start(event, tech);

      expect(entry(await mine(), event)).toMatchObject({
        status: 'under_review',
        returned_to_pending: false,
        interrupted_reason: null,
      });
    });

    it('SCRUM582_AC3_a_request_I_completed_is_not_marked_and_shows_no_interruption', async () => {
      const { event, line } = await eventWithRequest();
      await start(event, tech);
      await mark(event, tech, line);
      await complete(event, tech);

      expect(entry(await mine(), event)).toMatchObject({ interrupted_reason: null, returned_to_pending: false });
    });
  });

  describe('AC2 and AC3: a request that went on past my review', () => {
    it('SCRUM582_AC2_a_request_I_completed_that_is_now_arranged_is_listed_as_arranged_and_not_marked', async () => {
      const { event, requestId, line } = await eventWithRequest();
      await start(event, tech);
      await mark(event, tech, line);
      await complete(event, tech);
      await setStatus(requestId, 'arranged');

      expect(entry(await mine(), event)).toMatchObject({
        status: 'arranged',
        returned_to_pending: false,
        interrupted_reason: null,
      });
    });

    it('SCRUM582_AC3_a_request_returned_by_Safety_after_I_arranged_it_is_marked_again_each_time', async () => {
      const { event, requestId, line } = await eventWithRequest();
      await start(event, tech);
      await mark(event, tech, line);
      await complete(event, tech);
      await setStatus(requestId, 'arranged');
      await setStatus(requestId, 'pending_review');
      await db.query(
        `insert into equipment_review_history (equipment_request_id, action, user_id, note)
         values ($1, 'interrupted', $2, 'Returned for review after Safety review')`,
        [requestId, safetyOfficer],
      );

      expect(entry(await mine(), event)).toMatchObject({ returned_to_pending: true, status: 'pending_review' });
    });
  });

  describe('AC4: the list is a view only', () => {
    it('SCRUM582_AC4_the_function_is_stable_so_viewing_cannot_write', async () => {
      const found = await one("select provolatile from pg_proc where proname = 'equipment_reviewed_by_me'");
      expect(found.provolatile).toBe('s');
    });

    it('SCRUM582_AC4_reading_leaves_the_request_unassigned_and_adds_no_history', async () => {
      const { event, requestId, line } = await eventWithRequest();
      await start(event, tech);
      await amend(event, line, 3);
      const before = {
        request: await one('select status::text as status, reviewer_id, review_started_at from equipment_requests where id = $1', [requestId]),
        history: await rows('select id from equipment_review_history where equipment_request_id = $1 order by id', [requestId]),
      };

      await mine();
      await mine(other);

      expect(await one('select status::text as status, reviewer_id, review_started_at from equipment_requests where id = $1', [requestId])).toEqual(before.request);
      expect(await rows('select id from equipment_review_history where equipment_request_id = $1 order by id', [requestId])).toEqual(before.history);
    });
  });

  describe('AC5: only my own history, only Technical Support staff', () => {
    it.each([
      'event_organiser',
      'event_coordinator',
      'event_coordinator_lead',
      'venue_staff',
      'attendee',
      'safety_officer',
    ])('SCRUM582_AC5_a_%s_is_refused', async (role) => {
      const who = await seedUser(db, { email: `${role}-refused@example.com`, role });
      await expectSqlError(mine(who), '42501');
    });

    it('SCRUM582_AC5_a_missing_caller_or_unknown_user_is_refused', async () => {
      await expectSqlError(mine(null), '42501');
      await expectSqlError(mine('00000000-0000-0000-0000-000000000000'), '42501');
    });

    it('SCRUM582_AC5_a_refused_caller_gets_the_permission_message_and_no_data', async () => {
      await expect(mine(coordinator)).rejects.toMatchObject({
        code: '42501',
        message: 'Only technical support staff can see the requests they have reviewed',
      });
    });

    it('SCRUM582_AC5_a_user_with_no_profile_is_refused', async () => {
      const bare = await seedUser(db, { email: 'no-profile@example.com' });
      await expectSqlError(mine(bare), '42501');
    });

    it('SCRUM582_AC5_a_browser_role_cannot_call_the_function', async () => {
      expect(await clientsCanExecute(db, 'equipment_reviewed_by_me(uuid, integer)')).toEqual([]);
    });
  });

  describe('the cap on the list', () => {
    it('SCRUM582_AC1_a_short_limit_returns_that_many_and_says_the_list_was_cut', async () => {
      const result = await mine(tech, 2);
      expect(result.requests).toHaveLength(2);
      expect(result.truncated).toBe(true);
      expect(result.total).toBeGreaterThan(2);
    });

    it('SCRUM582_AC1_a_list_inside_the_limit_is_not_marked_cut', async () => {
      const result = await mine(tech, 500);
      expect(result.truncated).toBe(false);
      expect(result.total).toBe(result.requests.length);
    });

    it.each([[0], [-5]])('SCRUM582_AC1_a_limit_of_%i_is_raised_to_one_row_not_an_error_or_an_empty_list', async (limit) => {
      const result = await mine(tech, limit);
      expect(result.requests).toHaveLength(1);
      expect(result.truncated).toBe(true);
    });

    it('SCRUM582_AC1_a_missing_limit_uses_the_default_and_a_huge_one_is_capped_without_error', async () => {
      const viaDefault = asJson(await one('select equipment_reviewed_by_me($1, null)::text as answer', [tech]));
      const viaHuge = await mine(tech, 100000);
      const total = viaDefault.total;
      expect(viaDefault.requests).toHaveLength(Math.min(total, 200));
      expect(viaHuge.requests).toHaveLength(Math.min(total, 500));
      expect(viaHuge.total).toBe(total);
    });

    it('SCRUM582_AC1_two_requests_worked_on_at_the_same_moment_always_come_back_in_the_same_order', async () => {
      const a = await eventWithRequest();
      const b = await eventWithRequest();
      await start(a.event, tech);
      await start(b.event, tech);
      await db.query(
        "update equipment_review_history set created_at = '2031-01-01T00:00:00Z' where equipment_request_id = any ($1::uuid[])",
        [[a.requestId, b.requestId]],
      );

      const first = (await mine()).requests.map((r) => r.event_request_id).slice(0, 2);
      const expected = [[a.requestId, a.event], [b.requestId, b.event]]
        .sort((x, y) => (x[0] < y[0] ? 1 : -1))
        .map(([, event]) => event);
      expect(first).toEqual(expected);
      expect((await mine()).requests.map((r) => r.event_request_id).slice(0, 2)).toEqual(first);
    });

    it('SCRUM582_AC1_a_user_with_no_history_gets_an_empty_list', async () => {
      const fresh = await seedUser(db, { email: 'fresh-tech@example.com', role: 'technical_support_staff' });
      expect(await mine(fresh)).toEqual({ requests: [], total: 0, truncated: false });
    });
  });
});
