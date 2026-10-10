/**
 * SCRUM-298 for SCRUM-290: reviewing an equipment request, run against a real
 * Postgres.
 *
 * Applies the real migrations 022 (the equipment tables), 024 (availability),
 * 037 (the line functions) and 038 (the review functions) to an in-process
 * Postgres (PGlite), then calls the functions the way the service does and
 * checks what is left in the tables. Same approach as
 * equipmentLinesDatabase.test.js: no server, no credentials, runs in CI.
 *
 * One stand-in: event_requests, with the columns 022, 024, 037 and 038 read (id,
 * name, status, assigned coordinator and the proposed period).
 *
 * Reservations are inserted directly, because SCRUM-300 (reserve equipment) is
 * not built. AC5 and AC6 are therefore tested at the database edge: the Arranged
 * check is a function SCRUM-300 will call, and these tests call it the same way.
 *
 * Test names are N14_ACn_<what_it_checks>, as SCRUM-298 asks.
 *
 * What PGlite is not: Supabase, and it has one connection, so two starts at the
 * same moment are not exercised. The second of two starts is tested one after the
 * other, which is what the event row's lock makes the real case look like.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name) => readFileSync(resolve(here, '../../db/migrations', name), 'utf8');

const MIGRATIONS = [
  '022_equipment_schema.sql',
  '024_equipment_availability.sql',
  '037_equipment_request_lines.sql',
  '038_equipment_review.sql',
];

const NO_SUCH_ID = '00000000-0000-0000-0000-000000000000';
const START = '2026-12-01T10:00:00Z';
const END = '2026-12-01T12:00:00Z';

const refusal = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
};

describe('SCRUM-290: reviewing an equipment request in Postgres', () => {
  let db;
  let organiser;
  let coordinator;
  let reviewerA;
  let reviewerB;
  let projector;
  let microphone;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const rows = async (sql, params) => (await db.query(sql, params)).rows;
  const asJson = (row) => JSON.parse(row.answer);

  const newUser = async (email) =>
    (await one('insert into auth.users (email) values ($1) returning id', [email])).id;
  const newType = async (name, total = 10) =>
    (await one('insert into equipment_types (name, total_quantity) values ($1, $2) returning id', [name, total])).id;
  const newEvent = async ({ start = START, end = END } = {}) =>
    (await one(
      `insert into event_requests
         (organiser_id, event_name, status, assigned_coordinator_id, proposed_start, proposed_end)
       values ($1, $2, 'approved', $3, $4, $5) returning id`,
      [organiser, `Event ${Math.random()}`, coordinator, start, end],
    )).id;

  const add = async (event, type, quantity, notes = null) =>
    asJson(await one('select add_equipment_line($1, $2, $3, $4, $5)::text as answer', [event, coordinator, type, quantity, notes]));
  const amend = async (event, line, quantity) =>
    asJson(await one('select amend_equipment_line($1, $2, $3, $4)::text as answer', [event, coordinator, line, quantity]));
  const removeLine = async (event, line) =>
    asJson(await one('select remove_equipment_line($1, $2, $3)::text as answer', [event, coordinator, line]));

  const start = async (event, who) =>
    asJson(await one('select start_equipment_review($1, $2)::text as answer', [event, who]));
  const takeOver = async (event, who) =>
    asJson(await one('select take_over_equipment_review($1, $2)::text as answer', [event, who]));
  const mark = async (event, who, line, note) =>
    asJson(await one('select mark_equipment_line_unavailable($1, $2, $3, $4)::text as answer', [event, who, line, note]));
  const unmark = async (event, who, line) =>
    asJson(await one('select clear_equipment_line_outcome($1, $2, $3)::text as answer', [event, who, line]));
  const complete = async (event, who) =>
    asJson(await one('select complete_equipment_review($1, $2)::text as answer', [event, who]));
  const review = async (event) =>
    asJson(await one('select equipment_review_for_event($1)::text as answer', [event]));
  const coordinatorView = async (event) =>
    asJson(await one('select equipment_for_event($1)::text as answer', [event]));
  const arrange = async (requestId, who) =>
    (await one('select arrange_equipment_request_if_complete($1, $2) as answer', [requestId, who])).answer;

  const reserve = async (event, type, line, quantity, { start: s = START, end: e = END } = {}) =>
    (await one(
      `insert into equipment_reservations
         (equipment_type_id, event_request_id, equipment_line_id, quantity, start_at, end_at)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [type, event, line, quantity, s, e],
    )).id;

  const requestRow = (event) =>
    one(
      `select id, status::text as status, reviewer_id, review_started_at
         from equipment_requests where event_request_id = $1 and status <> 'cancelled'`,
      [event],
    );
  const history = (requestId) =>
    rows(
      'select action, user_id, from_user_id, equipment_line_id, note from equipment_review_history where equipment_request_id = $1 order by id',
      [requestId],
    );
  const lineNamed = (state, name) => state.request.lines.find((l) => l.name === name);

  /** An approved event with a projector line (5) and a microphone line (3). */
  const eventWithTwoLines = async () => {
    const event = await newEvent();
    await add(event, projector, 5);
    const state = await add(event, microphone, 3);
    return {
      event,
      projectorLine: lineNamed(state, 'Projector').id,
      microphoneLine: lineNamed(state, 'Microphone').id,
      requestId: state.request.id,
    };
  };

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create schema auth;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text);

      create function set_updated_at() returns trigger language plpgsql as $$
      begin new.updated_at = now(); return new; end $$;

      create type event_request_status as enum (
        'draft', 'submitted', 'under_review', 'pending_clarification',
        'approved', 'confirmed', 'completed', 'rejected', 'cancelled'
      );
      create table event_requests (
        id                      uuid primary key default gen_random_uuid(),
        organiser_id            uuid not null,
        event_name              text not null,
        status                  event_request_status not null default 'draft',
        assigned_coordinator_id uuid,
        proposed_start          timestamptz,
        proposed_end            timestamptz
      );
    `);
    for (const name of MIGRATIONS) await db.exec(migration(name));

    organiser = await newUser('organiser@example.com');
    coordinator = await newUser('coordinator@example.com');
    reviewerA = await newUser('tech-a@example.com');
    reviewerB = await newUser('tech-b@example.com');

    projector = await newType('Projector');
    microphone = await newType('Microphone');
  }, 60000);

  afterAll(async () => {
    await db?.close();
  });


  describe('the migration', () => {
    it('N14_runs_a_second_time_without_error', async () => {
      await expect(db.exec(migration('038_equipment_review.sql'))).resolves.not.toThrow();
    });

    it('N14_the_two_reads_are_stable_so_viewing_cannot_write', async () => {
      const found = await rows(
        "select proname, provolatile from pg_proc where proname in ('equipment_review_for_event', 'equipment_for_event') order by proname",
      );
      expect(found).toEqual([
        { proname: 'equipment_for_event', provolatile: 's' },
        { proname: 'equipment_review_for_event', provolatile: 's' },
      ]);
    });

    it('N14_a_line_cannot_be_marked_without_a_note_by_constraint', async () => {
      const { event, projectorLine } = await eventWithTwoLines();
      const err = await refusal(
        db.query(
          `update equipment_lines
              set outcome = 'cannot_be_provided', outcome_by = $2, outcome_at = now()
            where id = $1`,
          [projectorLine, reviewerA],
        ),
      );
      expect(err.code).toBe('23514');
      expect(event).toBeTruthy();
    });

    it('N14_a_blank_note_is_refused_by_constraint', async () => {
      const { projectorLine } = await eventWithTwoLines();
      const err = await refusal(
        db.query(
          `update equipment_lines
              set outcome = 'cannot_be_provided', outcome_note = '   ', outcome_by = $2, outcome_at = now()
            where id = $1`,
          [projectorLine, reviewerA],
        ),
      );
      expect(err.code).toBe('23514');
    });

    it('N14_under_review_without_a_reviewer_is_refused_by_constraint', async () => {
      const { requestId } = await eventWithTwoLines();
      const err = await refusal(
        db.query("update equipment_requests set status = 'under_review' where id = $1", [requestId]),
      );
      expect(err.code).toBe('23514');
    });
  });


  describe('AC1: only a signed-in reviewer acts', () => {
    it('N14_AC1_a_null_caller_is_refused_with_42501_and_nothing_changes', async () => {
      const { event } = await eventWithTwoLines();
      const err = await refusal(start(event, null));

      expect(err.code).toBe('42501');
      expect((await requestRow(event)).status).toBe('pending_review');
    });
  });


  describe('AC2: starting a review', () => {
    it('N14_AC2_starts_from_pending_review_and_records_the_reviewer_and_time', async () => {
      const { event, requestId } = await eventWithTwoLines();
      const state = await start(event, reviewerA);

      expect(state.request.status).toBe('under_review');
      expect(state.request.reviewer_id).toBe(reviewerA);
      expect(state.request.review_started_at).not.toBeNull();

      const row = await requestRow(event);
      expect(row.status).toBe('under_review');
      expect(row.reviewer_id).toBe(reviewerA);
      expect(row.review_started_at).not.toBeNull();

      const [first] = await history(requestId);
      expect(first).toMatchObject({ action: 'started', user_id: reviewerA });
    });

    it('N14_AC2_a_review_can_start_again_from_cannot_be_fully_arranged', async () => {
      const { event, projectorLine } = await eventWithTwoLines();
      await start(event, reviewerA);
      await mark(event, reviewerA, projectorLine, 'No projectors left');
      const microphoneLine = lineNamed(await review(event), 'Microphone').id;
      await mark(event, reviewerA, microphoneLine, 'None in stock');
      await complete(event, reviewerA);
      expect((await requestRow(event)).status).toBe('cannot_be_fully_arranged');

      const state = await start(event, reviewerB);
      expect(state.request.status).toBe('under_review');
      expect(state.request.reviewer_id).toBe(reviewerB);
    });

    it.each([['under_review'], ['arranged']])(
      'N14_AC2_refuses_a_start_from_%s_with_55000_and_changes_nothing',
      async (status) => {
        const { event, requestId } = await eventWithTwoLines();
        if (status === 'under_review') {
          await start(event, reviewerA);
        } else {
          await db.query("update equipment_requests set status = 'arranged' where id = $1", [requestId]);
        }
        const before = await requestRow(event);

        const err = await refusal(start(event, reviewerB));

        expect(err.code).toBe('55000');
        expect(await requestRow(event)).toEqual(before);
      },
    );

    it('N14_AC2_a_cancelled_request_has_nothing_to_review', async () => {
      const { event, requestId } = await eventWithTwoLines();
      await db.query("update equipment_requests set status = 'cancelled' where id = $1", [requestId]);

      const err = await refusal(start(event, reviewerA));

      expect(err.code).toBe('P0002');
    });

    it('N14_AC2_the_second_of_two_starts_is_refused_and_the_first_stays_reviewer', async () => {
      const { event } = await eventWithTwoLines();
      await start(event, reviewerA);
      const err = await refusal(start(event, reviewerB));

      expect(err.code).toBe('55000');
      expect(err.message).toMatch(/Take over/);
      expect((await requestRow(event)).reviewer_id).toBe(reviewerA);
    });

    it('N14_AC2_answers_P0002_for_an_unknown_event_and_for_an_event_with_no_request', async () => {
      expect((await refusal(start(NO_SUCH_ID, reviewerA))).code).toBe('P0002');

      const bare = await newEvent();
      expect((await refusal(start(bare, reviewerA))).code).toBe('P0002');
    });

    it('N14_AC2_viewing_a_request_changes_nothing', async () => {
      const { event, requestId } = await eventWithTwoLines();
      const before = await requestRow(event);
      const historyBefore = await history(requestId);

      await review(event);
      await coordinatorView(event);

      expect(await requestRow(event)).toEqual(before);
      expect(await history(requestId)).toEqual(historyBefore);
    });
  });


  describe('AC3: who is reviewing, and taking over', () => {
    it('N14_AC3_everyone_reading_the_request_sees_the_reviewer', async () => {
      const { event } = await eventWithTwoLines();
      await start(event, reviewerA);

      expect((await review(event)).request.reviewer_id).toBe(reviewerA);
    });

    it('N14_AC3_another_member_can_take_over_and_the_handover_is_recorded', async () => {
      const { event, requestId } = await eventWithTwoLines();
      await start(event, reviewerA);
      const startedAt = (await requestRow(event)).review_started_at;

      const state = await takeOver(event, reviewerB);

      expect(state.request.reviewer_id).toBe(reviewerB);
      expect((await requestRow(event)).review_started_at).toEqual(startedAt);
      const actions = await history(requestId);
      expect(actions[actions.length - 1]).toMatchObject({
        action: 'taken_over',
        user_id: reviewerB,
        from_user_id: reviewerA,
      });
    });

    it('N14_AC3_the_reviewer_cannot_take_over_their_own_review', async () => {
      const { event } = await eventWithTwoLines();
      await start(event, reviewerA);

      expect((await refusal(takeOver(event, reviewerA))).code).toBe('55000');
    });

    it.each([['pending_review'], ['arranged'], ['cannot_be_fully_arranged']])(
      'N14_AC3_a_take_over_is_refused_when_the_request_is_%s',
      async (status) => {
        const { event, requestId } = await eventWithTwoLines();
        await db.query('update equipment_requests set status = $2::equipment_request_status where id = $1', [requestId, status]);

        expect((await refusal(takeOver(event, reviewerB))).code).toBe('55000');
        expect((await requestRow(event)).reviewer_id).toBeNull();
      },
    );

    it('N14_AC3_only_the_current_reviewer_can_record_an_outcome', async () => {
      const { event, projectorLine } = await eventWithTwoLines();
      await start(event, reviewerA);

      const err = await refusal(mark(event, reviewerB, projectorLine, 'Not enough'));

      expect(err.code).toBe('42501');
      expect(lineNamed(await review(event), 'Projector').outcome).toBeNull();
    });

    it('N14_AC3_only_the_current_reviewer_can_complete', async () => {
      const { event } = await eventWithTwoLines();
      await start(event, reviewerA);

      expect((await refusal(complete(event, reviewerB))).code).toBe('42501');
      expect((await requestRow(event)).status).toBe('under_review');
    });

    it('N14_AC3_after_a_take_over_the_new_reviewer_acts_and_the_old_one_cannot', async () => {
      const { event, projectorLine } = await eventWithTwoLines();
      await start(event, reviewerA);
      await takeOver(event, reviewerB);

      expect((await refusal(mark(event, reviewerA, projectorLine, 'x'))).code).toBe('42501');
      const state = await mark(event, reviewerB, projectorLine, 'No projectors left');
      expect(lineNamed(state, 'Projector').outcome).toBe('cannot_be_provided');
    });

    it('N14_AC3_outcomes_cannot_be_recorded_when_nobody_is_reviewing', async () => {
      const { event, projectorLine } = await eventWithTwoLines();

      expect((await refusal(mark(event, reviewerA, projectorLine, 'x'))).code).toBe('55000');
    });
  });


  describe('AC4: what the review screen is given', () => {
    it('N14_AC4_returns_the_event_fields_and_each_lines_type_quantity_notes_reserved_and_availability', async () => {
      const event = await newEvent();
      await add(event, projector, 5, 'HDMI please');
      const { request } = await add(event, microphone, 3);
      const projectorLine = request.lines.find((l) => l.name === 'Projector').id;
      await reserve(event, projector, projectorLine, 2);

      const state = await review(event);

      expect(state.event).toMatchObject({
        id: event,
        proposed_start: expect.any(String),
        proposed_end: expect.any(String),
        assigned_coordinator_id: coordinator,
      });
      expect(Object.keys(state.event).sort()).toEqual(
        ['assigned_coordinator_id', 'id', 'name', 'proposed_end', 'proposed_start'],
      );
      const line = lineNamed(state, 'Projector');
      expect(line).toMatchObject({ quantity: 5, technical_notes: 'HDMI please', reserved: 2, outcome: null });
      expect(line.availability.found).toBe(true);
      expect(lineNamed(state, 'Microphone')).toMatchObject({ quantity: 3, reserved: 0 });
    });

    it('N14_AC4_the_availability_result_leaves_out_the_events_own_reservations', async () => {
      const type = await newType('Mixing desk', 10);
      const event = await newEvent();
      const other = await newEvent();
      const { request } = await add(event, type, 4);
      const otherState = await add(other, type, 3);

      await reserve(event, type, request.lines[0].id, 4);
      await reserve(other, type, otherState.request.lines[0].id, 3);

      const line = lineNamed(await review(event), 'Mixing desk');

      expect(line.reserved).toBe(4);
      expect(line.availability.reserved).toBe(3);
      expect(line.availability.available).toBe(7);
    });

    it('N14_AC4_availability_is_null_when_the_event_has_no_usable_period', async () => {
      const event = await newEvent({ start: null, end: null });
      await add(event, projector, 1);

      expect(lineNamed(await review(event), 'Projector').availability).toBeNull();
    });
  });


  describe('AC6: Arranged happens automatically, and only on the last full reservation', () => {
    it('N14_AC6_becomes_arranged_exactly_when_the_last_line_is_fully_reserved', async () => {
      const { event, projectorLine, microphoneLine, requestId } = await eventWithTwoLines();
      await start(event, reviewerA);

      await reserve(event, projector, projectorLine, 5);
      expect(await arrange(requestId, reviewerA)).toBe(false);
      expect((await requestRow(event)).status).toBe('under_review');

      await reserve(event, microphone, microphoneLine, 2);
      expect(await arrange(requestId, reviewerA)).toBe(false);

      await reserve(event, microphone, microphoneLine, 1);
      expect(await arrange(requestId, reviewerA)).toBe(true);

      const row = await requestRow(event);
      expect(row.status).toBe('arranged');
      expect(row.reviewer_id).toBeNull();
      expect(row.review_started_at).toBeNull();
      const actions = await history(requestId);
      expect(actions[actions.length - 1]).toMatchObject({ action: 'arranged', user_id: reviewerA });
    });

    it('N14_AC6_does_nothing_when_the_request_is_not_under_review', async () => {
      const { projectorLine, microphoneLine, event, requestId } = await eventWithTwoLines();
      await reserve(event, projector, projectorLine, 5);
      await reserve(event, microphone, microphoneLine, 3);

      expect(await arrange(requestId, reviewerA)).toBe(false);
      expect((await requestRow(event)).status).toBe('pending_review');
    });

    it('N14_AC6_a_mark_left_on_a_line_is_cleared_when_the_request_is_arranged', async () => {
      const { event, projectorLine, microphoneLine, requestId } = await eventWithTwoLines();
      await start(event, reviewerA);
      await mark(event, reviewerA, projectorLine, 'Maybe none');
      await reserve(event, projector, projectorLine, 5);
      await reserve(event, microphone, microphoneLine, 3);

      expect(await arrange(requestId, reviewerA)).toBe(true);
      expect(lineNamed(await review(event), 'Projector').outcome).toBeNull();
    });
  });


  describe('AC7: completing a review', () => {
    it('N14_AC7_a_note_is_required_to_mark_a_line', async () => {
      const { event, projectorLine } = await eventWithTwoLines();
      await start(event, reviewerA);

      for (const note of [null, '', '   ']) {
        const err = await refusal(mark(event, reviewerA, projectorLine, note));
        expect(err.code).toBe('22023');
      }
      expect(lineNamed(await review(event), 'Projector').outcome).toBeNull();
    });

    it('N14_AC7_a_fully_reserved_line_cannot_be_marked', async () => {
      const { event, projectorLine } = await eventWithTwoLines();
      await start(event, reviewerA);
      await reserve(event, projector, projectorLine, 5);

      expect((await refusal(mark(event, reviewerA, projectorLine, 'x'))).code).toBe('55000');
    });

    it('N14_AC7_a_line_that_is_not_on_the_request_is_not_found', async () => {
      const { event } = await eventWithTwoLines();
      await start(event, reviewerA);

      expect((await refusal(mark(event, reviewerA, NO_SUCH_ID, 'x'))).code).toBe('P0002');
    });

    it('N14_AC7_marking_records_the_user_note_and_time_and_the_mark_can_be_taken_off', async () => {
      const { event, projectorLine, requestId } = await eventWithTwoLines();
      await start(event, reviewerA);

      const marked = lineNamed(await mark(event, reviewerA, projectorLine, '  Only two in stock  '), 'Projector');
      expect(marked).toMatchObject({
        outcome: 'cannot_be_provided',
        outcome_note: 'Only two in stock',
        outcome_by: reviewerA,
      });
      expect(marked.outcome_at).not.toBeNull();

      const cleared = lineNamed(await unmark(event, reviewerA, projectorLine), 'Projector');
      expect(cleared).toMatchObject({ outcome: null, outcome_note: null, outcome_by: null, outcome_at: null });

      const actions = (await history(requestId)).map((h) => h.action);
      expect(actions).toEqual(['started', 'line_marked', 'line_unmarked']);
    });

    it('N14_AC7_taking_the_mark_off_an_unmarked_line_records_nothing', async () => {
      const { event, projectorLine, requestId } = await eventWithTwoLines();
      await start(event, reviewerA);

      await unmark(event, reviewerA, projectorLine);

      expect((await history(requestId)).map((h) => h.action)).toEqual(['started']);
    });

    it('N14_AC7_completing_is_refused_while_a_short_line_has_no_note_and_names_it', async () => {
      const { event, projectorLine } = await eventWithTwoLines();
      await start(event, reviewerA);
      await mark(event, reviewerA, projectorLine, 'None left');

      const err = await refusal(complete(event, reviewerA));

      expect(err.code).toBe('22023');
      expect(err.message).toContain('Microphone');
      expect(err.message).not.toContain('Projector');
      expect((await requestRow(event)).status).toBe('under_review');
    });

    it('N14_AC7_completing_with_every_note_present_sets_cannot_be_fully_arranged_and_keeps_reservations', async () => {
      const { event, projectorLine, microphoneLine, requestId } = await eventWithTwoLines();
      await start(event, reviewerA);
      const kept = await reserve(event, projector, projectorLine, 2);
      await mark(event, reviewerA, projectorLine, 'Short by three');
      await mark(event, reviewerA, microphoneLine, 'None in stock');

      const state = await complete(event, reviewerA);

      expect(state.request.status).toBe('cannot_be_fully_arranged');
      const row = await requestRow(event);
      expect(row.reviewer_id).toBeNull();
      expect(row.review_started_at).toBeNull();
      const reservation = await one('select released_at from equipment_reservations where id = $1', [kept]);
      expect(reservation.released_at).toBeNull();
      expect(lineNamed(state, 'Projector')).toMatchObject({ reserved: 2, outcome_note: 'Short by three' });
      const actions = await history(requestId);
      expect(actions[actions.length - 1]).toMatchObject({ action: 'completed', user_id: reviewerA });
    });

    it('N14_AC7_a_fully_reserved_line_does_not_need_a_note_to_complete', async () => {
      const { event, projectorLine, microphoneLine } = await eventWithTwoLines();
      await start(event, reviewerA);
      await reserve(event, projector, projectorLine, 5);
      await mark(event, reviewerA, microphoneLine, 'None in stock');

      expect((await complete(event, reviewerA)).request.status).toBe('cannot_be_fully_arranged');
    });

    it('N14_AC7_completing_is_refused_when_every_line_is_fully_reserved', async () => {
      const { event, projectorLine, microphoneLine } = await eventWithTwoLines();
      await start(event, reviewerA);
      await reserve(event, projector, projectorLine, 5);
      await reserve(event, microphone, microphoneLine, 3);

      const err = await refusal(complete(event, reviewerA));

      expect(err.code).toBe('55000');
      expect((await requestRow(event)).status).toBe('under_review');
    });

    it('N14_AC7_completing_when_not_under_review_is_refused', async () => {
      const { event } = await eventWithTwoLines();

      expect((await refusal(complete(event, reviewerA))).code).toBe('55000');
    });
  });


  describe('AC8: what the coordinator sees', () => {
    it('N14_AC8_each_line_shows_its_reserved_quantity_and_any_cannot_be_provided_note', async () => {
      const { event, projectorLine, microphoneLine } = await eventWithTwoLines();
      await start(event, reviewerA);
      await reserve(event, projector, projectorLine, 2);
      await mark(event, reviewerA, projectorLine, 'Short by three');
      await mark(event, reviewerA, microphoneLine, 'None in stock');
      await complete(event, reviewerA);

      const state = await coordinatorView(event);

      expect(state.request.status).toBe('cannot_be_fully_arranged');
      expect(lineNamed(state, 'Projector')).toMatchObject({
        quantity: 5,
        reserved: 2,
        outcome: 'cannot_be_provided',
        outcome_note: 'Short by three',
      });
      expect(lineNamed(state, 'Microphone')).toMatchObject({ reserved: 0, outcome_note: 'None in stock' });
    });

    it('N14_AC8_the_coordinators_read_does_not_say_who_marked_the_line', async () => {
      const { event, projectorLine } = await eventWithTwoLines();
      await start(event, reviewerA);
      await mark(event, reviewerA, projectorLine, 'None left');

      expect(lineNamed(await coordinatorView(event), 'Projector')).not.toHaveProperty('outcome_by');
    });
  });


  describe('AC9: every action records the user and the time', () => {
    it('N14_AC9_start_take_over_mark_and_complete_each_leave_a_row_with_user_and_time', async () => {
      const { event, projectorLine, microphoneLine, requestId } = await eventWithTwoLines();
      await start(event, reviewerA);
      await takeOver(event, reviewerB);
      await mark(event, reviewerB, projectorLine, 'None left');
      await mark(event, reviewerB, microphoneLine, 'None left');
      await complete(event, reviewerB);

      expect((await history(requestId)).map((h) => [h.action, h.user_id])).toEqual([
        ['started', reviewerA],
        ['taken_over', reviewerB],
        ['line_marked', reviewerB],
        ['line_marked', reviewerB],
        ['completed', reviewerB],
      ]);
      const times = await rows('select created_at from equipment_review_history where equipment_request_id = $1', [requestId]);
      expect(times.every((t) => t.created_at !== null)).toBe(true);
    });

    it('N14_AC9_a_refused_call_writes_no_history', async () => {
      const { event, projectorLine, requestId } = await eventWithTwoLines();
      await start(event, reviewerA);
      await refusal(mark(event, reviewerB, projectorLine, 'x'));
      await refusal(takeOver(event, reviewerA));
      await refusal(complete(event, reviewerB));

      expect((await history(requestId)).map((h) => h.action)).toEqual(['started']);
    });
  });


  describe('the coordinator changes the lines during or after a review (SCRUM-21 meets SCRUM-290)', () => {
    it('N14_a_line_change_during_a_review_ends_it_and_says_so', async () => {
      const { event, requestId, projectorLine } = await eventWithTwoLines();
      await start(event, reviewerA);

      await amend(event, projectorLine, 6);

      const row = await requestRow(event);
      expect(row.status).toBe('pending_review');
      expect(row.reviewer_id).toBeNull();
      expect(row.review_started_at).toBeNull();
      const actions = await history(requestId);
      expect(actions[actions.length - 1]).toMatchObject({ action: 'interrupted', user_id: null, from_user_id: reviewerA });
    });

    it('N14_adding_or_removing_a_line_during_a_review_ends_it', async () => {
      const { event, microphoneLine } = await eventWithTwoLines();
      await start(event, reviewerA);
      const extra = await newType(`Cable ${Math.random()}`);
      await add(event, extra, 1);
      expect((await requestRow(event)).reviewer_id).toBeNull();

      await start(event, reviewerB);
      await removeLine(event, microphoneLine);
      expect((await requestRow(event)).status).toBe('pending_review');
    });

    it('N14_removing_the_last_line_cancels_the_request_and_ends_the_review', async () => {
      const event = await newEvent();
      const state = await add(event, projector, 1);
      const requestId = state.request.id;
      await start(event, reviewerA);

      await removeLine(event, state.request.lines[0].id);

      const row = await one('select status::text as status, reviewer_id from equipment_requests where id = $1', [requestId]);
      expect(row).toEqual({ status: 'cancelled', reviewer_id: null });
    });

    it('N14_amending_a_marked_line_clears_its_outcome_and_leaves_other_marks_alone', async () => {
      const { event, requestId, projectorLine, microphoneLine } = await eventWithTwoLines();
      await start(event, reviewerA);
      await mark(event, reviewerA, projectorLine, 'None left');
      await mark(event, reviewerA, microphoneLine, 'None left');

      await amend(event, projectorLine, 4);

      const state = await review(event);
      expect(lineNamed(state, 'Projector')).toMatchObject({ outcome: null, outcome_note: null, outcome_by: null });
      expect(lineNamed(state, 'Microphone').outcome).toBe('cannot_be_provided');
      const reset = (await history(requestId)).find((h) => h.action === 'line_reset');
      expect(reset).toMatchObject({ equipment_line_id: projectorLine, user_id: null });
    });

    it('N14_a_change_that_changes_nothing_keeps_the_review_and_the_marks', async () => {
      const { event, projectorLine } = await eventWithTwoLines();
      await start(event, reviewerA);
      await mark(event, reviewerA, projectorLine, 'None left');

      await amend(event, projectorLine, 5);

      expect((await requestRow(event)).reviewer_id).toBe(reviewerA);
      expect(lineNamed(await review(event), 'Projector').outcome).toBe('cannot_be_provided');
    });

    it('N14_a_coordinator_change_after_completing_sends_the_request_back_to_pending_review', async () => {
      const { event, projectorLine, microphoneLine } = await eventWithTwoLines();
      await start(event, reviewerA);
      await mark(event, reviewerA, projectorLine, 'None left');
      await mark(event, reviewerA, microphoneLine, 'None left');
      await complete(event, reviewerA);

      await amend(event, projectorLine, 2);

      expect((await requestRow(event)).status).toBe('pending_review');
    });
  });
});
