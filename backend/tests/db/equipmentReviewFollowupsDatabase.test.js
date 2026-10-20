/**
 * SCRUM-300: review follow-ups, run against the final schema in a real Postgres
 * (PGlite).
 *
 *   1. Keep and Move count every live reservation on the line against its need.
 *   2. The five reservation actions lock the equipment type before the request.
 *   3. The review history says why a flag ended a review.
 *
 * PGlite has one connection, so the lock order itself is checked against a real
 * server by hand (two connections). Here the order is pinned by reading each
 * function's source from pg_proc.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedUser } from './helpers/schemaDb.js';
import { queriesFor, refusal } from './helpers/queries.js';
import { asJson, singleReviewerSteps } from './helpers/equipment.js';

const START = '2026-12-01T10:00:00Z';
const END = '2026-12-01T12:00:00Z';
const NEW_START = '2026-12-05T14:00:00Z';
const NEW_END = '2026-12-05T16:00:00Z';

describe('SCRUM-300: review follow-ups in Postgres', () => {
  let db;
  let organiser;
  let coordinator;
  let reviewerA;

  const { one, rows } = queriesFor(() => db);
  const {
    newType, newEvent, add, removeLine, start, reserve, move, reduce, release, keep,
    markUnavailable, complete, review, changePeriod, lineNamed, status, history, liveReservations,
  } = singleReviewerSteps(() => ({ db, organiser, coordinator, reviewerA }), {
    start: START, end: END, newStart: NEW_START, newEnd: NEW_END,
  });

  beforeAll(async () => {
    db = await createSchemaDb();

    organiser = await seedUser(db, { email: 'organiser@example.com' });
    coordinator = await seedUser(db, { email: 'coordinator@example.com' });
    // Starting a review needs the Technical Support role (011).
    reviewerA = await seedUser(db, { email: 'tech-a@example.com', role: 'technical_support_staff' });
  }, 60000);

  const amend = async (event, line, quantity) =>
    asJson(await one('select amend_equipment_line($1, $2, $3, $4)::text as answer', [event, coordinator, line, quantity]));
  const notes = async (event) =>
    (await rows(
      `select h.note from equipment_review_history h
         join equipment_requests r on r.id = h.equipment_request_id
        where r.event_request_id = $1 and h.action = 'interrupted' order by h.id`,
      [event],
    )).map((row) => row.note);

  /** Line needs 4. A is reserved (2), the date changes, B is reserved (2) for the new date, then the line is cut to 2. */
  const twoReservationsOnACutLine = async () => {
    const type = await newType('Projector', 10);
    const event = await newEvent();
    const line = (await add(event, type, 4)).request.lines[0].id;
    await start(event);
    await reserve(event, line, 2);
    await changePeriod(event);
    await start(event);
    await reserve(event, line, 2);
    await db.query('update equipment_lines set quantity = 2 where id = $1', [line]);
    await start(event);
    const [a, b] = await liveReservations(event);
    return { event, line, type, a: a.id, b: b.id };
  };
  const canKeepOf = async (event, id) =>
    (await review(event)).request.lines[0].reservations.find((r) => r.id === id).can_keep;

  describe('AC7: Keep and Move count every reservation on the line', () => {
    it('SCRUM300_AC7_two_flagged_reservations_that_together_hold_too_much_cannot_be_kept', async () => {
      const { event, b } = await twoReservationsOnACutLine();

      expect(await canKeepOf(event, b)).toBe(false);
      const err = await refusal(keep(event, b));

      expect(err?.code).toBe('55000');
      expect(err.message).toMatch(/more than the line now needs/);
      expect((await liveReservations(event)).every((r) => r.flagged)).toBe(true);
    });

    it('SCRUM300_AC7_a_move_that_leaves_the_line_holding_too_much_is_refused', async () => {
      const { event, a } = await twoReservationsOnACutLine();

      const err = await refusal(move(event, a));

      expect(err?.code).toBe('22023');
      expect(err.message).toMatch(/hold 4 but the line now needs 2/);
    });

    it('SCRUM300_AC7_the_second_action_on_a_line_that_needs_2_is_refused_after_the_first', async () => {
      const { event, a, b } = await twoReservationsOnACutLine();
      await release(event, a);
      const kept = await keep(event, b);
      expect(kept.request.lines[0].reserved).toBe(2);

      const err = await refusal(move(event, b));

      expect(err?.code).toBe('55000');
    });

    it('SCRUM300_AC7_releasing_one_lets_the_other_be_kept_and_the_request_arrange', async () => {
      const { event, a, b } = await twoReservationsOnACutLine();
      await release(event, a);

      expect(await canKeepOf(event, b)).toBe(true);
      const state = await keep(event, b);

      expect(state.request.status).toBe('arranged');
    });

    it('SCRUM300_AC7_reducing_the_new_one_clears_its_flag_and_the_old_one_can_then_be_moved', async () => {
      const { event, a, b } = await twoReservationsOnACutLine();
      await reduce(event, a, 1);
      expect(await canKeepOf(event, b)).toBe(false);
      const afterReduce = await reduce(event, b, 1);
      expect(afterReduce.request.lines[0].reservations.find((r) => r.id === b).flagged).toBe(false);

      const state = await move(event, a);

      expect(state.request.lines[0].reserved).toBe(2);
      expect(state.request.status).toBe('arranged');
    });

    it('SCRUM300_AC7_reducing_a_kept_candidate_clears_its_flag_once_the_line_fits', async () => {
      const { event, a, b } = await twoReservationsOnACutLine();
      await release(event, a);
      const [only] = await liveReservations(event);
      expect(only.id).toBe(b);

      const state = await reduce(event, b, 1);
      const left = state.request.lines[0].reservations[0];

      expect(left.flagged).toBe(false);
    });
  });

  describe('AC2: what the screen offers matches what the server takes', () => {
    it('SCRUM300_AC2_a_type_can_be_on_a_request_only_once', async () => {
      const type = await newType('Projector', 10);
      const event = await newEvent();
      await add(event, type, 2);

      const err = await refusal(add(event, type, 1));

      expect(err?.code).toBe('23505');
    });

    it('SCRUM300_AC2_the_units_offered_are_exactly_the_units_the_server_takes', async () => {
      const type = await newType('Projector', 5);
      const other = await newEvent();
      await start(other).catch(() => {});
      const otherLine = (await add(other, type, 2)).request.lines[0].id;
      await start(other);
      await reserve(other, otherLine, 2);

      const event = await newEvent();
      const line = (await add(event, type, 4)).request.lines[0].id;
      await start(event);
      await reserve(event, line, 1);

      const shown = (await review(event)).request.lines[0];
      const offered = Math.max(0, Math.min(shown.quantity - shown.reserved, shown.availability.available - shown.reserved));

      expect(offered).toBe(2);
      expect((await refusal(reserve(event, line, offered + 1)))?.code).toBe('22023');
      const state = await reserve(event, line, offered);
      expect(state.request.lines[0].reserved).toBe(1 + offered);
    });
  });

  describe('AC8: the history says why a flag ended the review', () => {
    // The line needs 4 and holds 2, so the review stays open.
    const underReview = async () => {
      const type = await newType('Projector', 10);
      const event = await newEvent();
      const line = (await add(event, type, 4)).request.lines[0].id;
      await start(event);
      await reserve(event, line, 2);
      return { event, type, line };
    };

    it('SCRUM300_AC8_a_date_change_is_named_as_the_reason', async () => {
      const { event } = await underReview();
      await changePeriod(event);

      expect(await notes(event)).toEqual(['A reservation was flagged during the review. The event date or time changed.']);
    });

    it('SCRUM300_AC8_fewer_usable_units_is_named_as_the_reason', async () => {
      const { event, type } = await underReview();
      await db.query('update equipment_types set damaged_quantity = 9 where id = $1', [type]);

      expect(await notes(event)).toEqual(['A reservation was flagged during the review. Fewer units of this equipment are usable.']);
    });

    it('SCRUM300_AC8_a_retired_type_is_named_as_the_reason', async () => {
      const { event, type } = await underReview();
      await db.query('update equipment_types set retired_at = now() where id = $1', [type]);

      expect(await notes(event)).toEqual(['A reservation was flagged during the review. The equipment type was retired.']);
    });

    it('SCRUM300_AC8_changing_a_reserved_line_names_the_line_change_as_the_reason', async () => {
      const { event, line } = await underReview();
      await amend(event, line, 3);

      expect(await notes(event)).toEqual(['A reservation was flagged during the review. The line quantity or notes were changed.']);
    });

    it('SCRUM300_AC8_changing_a_line_with_no_reservation_still_says_the_lines_were_changed', async () => {
      const type = await newType('Projector', 10);
      const event = await newEvent();
      const line = (await add(event, type, 4)).request.lines[0].id;
      await start(event);
      await amend(event, line, 3);

      expect(await notes(event)).toEqual(['The lines were changed during the review']);
    });

    it('SCRUM300_AC8_a_cancellation_still_says_the_request_was_cancelled', async () => {
      const { event } = await underReview();
      await db.query("update equipment_requests set status = 'cancelled' where event_request_id = $1", [event]);

      expect(await notes(event)).toEqual(['The request was cancelled during the review']);
    });

    it('SCRUM300_AC8_the_reason_does_not_leak_into_later_changes_in_the_same_transaction', async () => {
      const { event, line } = await underReview();
      await db.exec('begin');
      await db.query('update event_requests set proposed_start = $2, proposed_end = $3 where id = $1', [event, NEW_START, NEW_END]);
      const afterFlag = (await one("select current_setting('equipment.interrupt_reason', true) as v")).v;
      await db.exec('commit');
      await start(event);
      await amend(event, line, 3);

      expect(afterFlag).toBe('');
      expect((await notes(event)).at(-1)).toBe('The lines were changed during the review');
    });
  });

  describe('AC3: the type is locked before the request', () => {
    const source = async (name) =>
      (await one('select prosrc from pg_proc where proname = $1', [name])).prosrc;

    it.each([
      ['reserve_equipment', 'lock_equipment_type_of_line'],
      ['reduce_equipment_reservation', 'lock_equipment_type_of_reservation'],
      ['release_equipment_reservation', 'lock_equipment_type_of_reservation'],
      ['move_equipment_reservation', 'lock_equipment_type_of_reservation'],
      ['keep_equipment_reservation', 'lock_equipment_type_of_reservation'],
    ])('SCRUM300_AC3_%s_locks_the_type_first', async (fn, helper) => {
      const text = await source(fn);

      expect(text.indexOf(helper)).toBeGreaterThan(-1);
      expect(text.indexOf(helper)).toBeLessThan(text.indexOf('lock_equipment_request('));
      expect(text).not.toMatch(/from equipment_types[\s\S]*for update/);
    });

    it('SCRUM300_AC3_locking_the_type_of_something_that_does_not_exist_does_nothing', async () => {
      const missing = '00000000-0000-0000-0000-000000000000';

      await expect(db.query('select lock_equipment_type_of_line($1)', [missing])).resolves.toBeDefined();
      await expect(db.query('select lock_equipment_type_of_reservation($1)', [missing])).resolves.toBeDefined();
    });

    it('SCRUM300_AC3_two_events_still_cannot_both_take_the_last_unit', async () => {
      const type = await newType('Last one', 1);
      const first = await newEvent();
      const second = await newEvent();
      const l1 = (await add(first, type, 1)).request.lines[0].id;
      const l2 = (await add(second, type, 1)).request.lines[0].id;
      await start(first);
      await start(second);
      await reserve(first, l1, 1);

      const err = await refusal(reserve(second, l2, 1));

      expect(err?.code).toBe('22023');
      expect(err.message).toMatch(/Only 0 available/);
    });
  });
});
