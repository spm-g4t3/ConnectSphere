/**
 * SCRUM-303 to SCRUM-306 for SCRUM-300: reduce, release, move, keep, automatic
 * release and flagging, run against the final schema in a real Postgres (PGlite).
 *
 * Calls reserve_equipment the way the service does. PGlite has one connection,
 * so the last-unit race (AC3) is tested as two reservations one after the
 * other, which is what the type row's lock makes the real case look like.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedUser } from './helpers/schemaDb.js';
import { queriesFor, refusal } from './helpers/queries.js';
import { asJson, reservationSteps } from './helpers/equipment.js';
import { withSafetyReviewTransitionGuardDisabled } from '../fixtures/safetyReviewTestHelpers.js';

const START = '2026-12-01T10:00:00Z';
const END = '2026-12-01T12:00:00Z';
const NEW_START = '2026-12-05T10:00:00Z';
const NEW_END = '2026-12-05T12:00:00Z';

describe('SCRUM-300: changing and flagging reservations in Postgres', () => {
  let db;
  let organiser;
  let coordinator;
  let reviewerA;
  let reviewerB;

  const { one, rows } = queriesFor(() => db);
  const {
    newType, newEvent, add, start, reserve, reduce, release, move, keep,
    reservation, changePeriod, lineId, live, events, requestStatus, reviewed,
  } = reservationSteps(() => ({ db, organiser, coordinator, reviewerA }), {
    start: START, end: END, newStart: NEW_START, newEnd: NEW_END,
  });
  // Jumps the event to a status without the safety workflow's submission and
  // response rows, which these equipment tests do not need.
  const setStatus = (event, status) =>
    withSafetyReviewTransitionGuardDisabled(db, () =>
      db.query('update event_requests set status = $2::event_request_status where id = $1', [event, status]));

  beforeAll(async () => {
    db = await createSchemaDb();

    organiser = await seedUser(db, { email: 'organiser@example.com', role: 'event_organiser' });
    coordinator = await seedUser(db, { email: 'coordinator@example.com', role: 'event_coordinator' });
    reviewerA = await seedUser(db, { email: 'tech-a@example.com', role: 'technical_support_staff' });
    reviewerB = await seedUser(db, { email: 'tech-b@example.com', role: 'technical_support_staff' });
  }, 60000);

  afterAll(async () => {
    await db?.close();
  });


  describe('AC1: the statuses that allow reserving', () => {
    it('SCRUM300_AC1_the_list_is_approved_the_two_safety_statuses_and_confirmed', async () => {
      const { s } = await one('select equipment_reservable_event_statuses() as s');
      expect(s).toEqual(['approved', 'safety_review', 'safety_approved', 'confirmed']);
    });

    it('SCRUM300_AC1_the_refusal_names_the_statuses_in_the_list', async () => {
      // Narrow the list, read the message, then put the real definition back.
      const { def } = await one("select pg_get_functiondef('equipment_reservable_event_statuses'::regproc) as def");
      await db.exec(`create or replace function equipment_reservable_event_statuses()
        returns text[] language sql immutable as $$ select array['approved']::text[] $$;`);
      try {
        const event = await newEvent({ status: 'rejected' });
        const err = await refusal(db.query('select assert_event_allows_reservations($1)', [event]));
        expect(err?.code).toBe('55000');
        expect(err?.message).toBe('Equipment can only be reserved while the event is Approved. This event is Rejected.');
      } finally {
        await db.exec(def);
      }
    });

    it.each(['safety_review', 'safety_approved'])(
      'SCRUM300_AC1_reserve_reduce_and_release_work_while_the_event_is_in_%s',
      async (eventStatus) => {
        const { event, line } = await reviewed('Projector', 10, 4);
        await setStatus(event, eventStatus);

        await reserve(event, reviewerA, line, 3);
        const { id } = await reservation(event);
        await reduce(event, reviewerA, id, 1, 'Only one needed');
        expect((await reservation(event)).quantity).toBe(1);
        await release(event, reviewerA, id);
        expect((await reservation(event)).released_at).not.toBeNull();
      },
    );

    it.each(['safety_review', 'safety_approved'])(
      'SCRUM300_AC1_a_flagged_reservation_can_be_moved_while_the_event_is_in_%s',
      async (eventStatus) => {
        const { event, line } = await reviewed('Projector', 10, 2);
        await reserve(event, reviewerA, line, 2);
        await changePeriod(event);
        await start(event, reviewerA);
        await setStatus(event, eventStatus);
        const { id } = await reservation(event);

        await move(event, reviewerA, id);

        expect((await reservation(event)).flagged).toBe(false);
        expect(await requestStatus(event)).toBe('arranged');
      },
    );
  });

  describe('AC4: reduce and release', () => {
    it('SCRUM300_AC4_reduce_lowers_the_quantity_and_records_who_and_why', async () => {
      const { event, line } = await reviewed('Projector', 10, 4);
      await reserve(event, reviewerA, line, 3);
      const { id } = await reservation(event);
      await reduce(event, reviewerA, id, 1, 'Only one needed');
      expect((await reservation(event)).quantity).toBe(1);
      const last = (await events(event)).at(-1);
      expect(last).toMatchObject({ action: 'reduced', user_id: reviewerA, reason: 'Only one needed', quantity_before: 3, quantity_after: 1 });
    });

    it.each([3, 4, 0, null])('SCRUM300_AC4_reduce_to_%s_is_refused', async (quantity) => {
      const { event, line } = await reviewed('Projector', 10, 4);
      await reserve(event, reviewerA, line, 3);
      const { id } = await reservation(event);
      const err = await refusal(reduce(event, reviewerA, id, quantity));
      expect(err?.code).toBe('22023');
    });

    it('SCRUM300_AC4_a_reason_is_required_to_reduce_and_to_release', async () => {
      const { event, line } = await reviewed('Projector', 10, 4);
      await reserve(event, reviewerA, line, 3);
      const { id } = await reservation(event);
      expect((await refusal(reduce(event, reviewerA, id, 1, '  ')))?.code).toBe('22023');
      expect((await refusal(release(event, reviewerA, id, '')))?.code).toBe('22023');
      expect((await reservation(event)).released_at).toBeNull();
    });

    it('SCRUM300_AC4_release_keeps_the_row_and_records_the_release', async () => {
      const { event, line } = await reviewed('Projector', 10, 4);
      await reserve(event, reviewerA, line, 3);
      const { id } = await reservation(event);
      await release(event, reviewerA, id, 'Wrong item');
      const row = await reservation(event);
      expect(row.released_at).not.toBeNull();
      expect(row.release_reason).toBe('Wrong item');
      expect((await events(event)).at(-1)).toMatchObject({ action: 'released', user_id: reviewerA });
    });

    it('SCRUM300_AC4_only_the_current_reviewer_can_reduce_or_release', async () => {
      const { event, line } = await reviewed('Projector', 10, 4);
      await reserve(event, reviewerA, line, 3);
      const { id } = await reservation(event);
      expect((await refusal(reduce(event, reviewerB, id, 1)))?.code).toBe('42501');
      expect((await refusal(release(event, reviewerB, id)))?.code).toBe('42501');
    });

    it('SCRUM300_AC4_a_released_reservation_cannot_be_released_again', async () => {
      const { event, line } = await reviewed('Projector', 10, 4);
      await reserve(event, reviewerA, line, 3);
      const { id } = await reservation(event);
      await release(event, reviewerA, id);
      expect((await refusal(release(event, reviewerA, id)))?.code).toBe('55000');
    });

    it('SCRUM300_AC4_another_events_reservation_is_not_found', async () => {
      const a = await reviewed('Projector', 10, 4);
      const b = await reviewed('Mic', 10, 4);
      await reserve(b.event, reviewerA, b.line, 1);
      const { id } = await reservation(b.event);
      expect((await refusal(release(a.event, reviewerA, id)))?.code).toBe('P0002');
    });
  });

  describe('AC5: automatic release', () => {
    it('SCRUM300_AC5_removing_a_line_releases_its_reservations_as_the_system', async () => {
      const { event, line } = await reviewed('Projector', 10, 4);
      await reserve(event, reviewerA, line, 2);
      await db.query('select remove_equipment_line($1, $2, $3)', [event, coordinator, line]);
      const row = await reservation(event);
      expect(row.release_reason).toBe('request cancelled');
      expect((await events(event)).at(-1)).toMatchObject({ action: 'released', user_id: null, reason: 'request cancelled' });
    });

    it('SCRUM300_AC5_an_event_that_is_completed_releases_everything_with_a_reason', async () => {
      const { event, line } = await reviewed('Projector', 10, 4);
      await reserve(event, reviewerA, line, 2);
      await setStatus(event, 'confirmed');
      await db.query("update event_requests set status = 'completed' where id = $1", [event]);
      const row = await reservation(event);
      expect(row.release_reason).toBe('event completed');
      expect((await events(event)).at(-1)).toMatchObject({ action: 'released', user_id: null });
    });
  });

  describe('AC6: flagging', () => {
    it('SCRUM300_AC6_a_date_change_flags_keeps_the_hold_and_sends_the_request_back', async () => {
      const { event, line } = await reviewed('Projector', 10, 2);
      await reserve(event, reviewerA, line, 2);
      expect(await requestStatus(event)).toBe('arranged');
      await changePeriod(event);
      const row = await reservation(event);
      expect(row.flagged).toBe(true);
      expect(row.flag_reason).toMatch(/date or time/);
      expect(row.quantity).toBe(2);
      expect(new Date(row.start_at).toISOString()).toBe('2026-12-01T10:00:00.000Z');
      expect(await requestStatus(event)).toBe('pending_review');
      expect((await events(event)).at(-1)).toMatchObject({ action: 'flagged', user_id: null });
    });

    it('SCRUM300_AC6_amending_a_line_flags_its_reservations_with_a_reason', async () => {
      const { event, line } = await reviewed('Projector', 10, 4);
      await reserve(event, reviewerA, line, 2);
      await db.query('select amend_equipment_line($1, $2, $3, 3)', [event, coordinator, line]);
      const row = await reservation(event);
      expect(row.flagged).toBe(true);
      expect(row.flag_reason).toMatch(/line quantity or notes/);
      expect(await requestStatus(event)).toBe('pending_review');
    });

    it('SCRUM300_AC6_a_type_losing_usable_units_flags_only_over_committed_reservations', async () => {
      const a = await reviewed('Lamp', 4, 2);
      await reserve(a.event, reviewerA, a.line, 2);
      await db.query('update equipment_types set damaged_quantity = 3 where id = $1', [a.type]);
      expect((await reservation(a.event)).flagged).toBe(true);

      const b = await reviewed('Cable', 4, 2);
      await reserve(b.event, reviewerA, b.line, 2);
      await db.query('update equipment_types set damaged_quantity = 1 where id = $1', [b.type]);
      expect((await reservation(b.event)).flagged).toBe(false);
    });

    it('SCRUM300_AC6_retiring_a_type_flags_its_reservations', async () => {
      const { event, line, type } = await reviewed('Lamp', 4, 2);
      await reserve(event, reviewerA, line, 2);
      await db.query('update equipment_types set retired_at = now() where id = $1', [type]);
      expect((await reservation(event)).flagged).toBe(true);
    });

    it('SCRUM300_AC6_a_change_that_does_not_move_the_period_flags_nothing', async () => {
      const { event, line } = await reviewed('Projector', 10, 2);
      await reserve(event, reviewerA, line, 2);
      await db.query("update event_requests set event_name = 'Renamed' where id = $1", [event]);
      expect((await reservation(event)).flagged).toBe(false);
    });

    it('SCRUM300_AC6_the_review_read_lists_each_reservation_with_its_flag', async () => {
      const { event, line } = await reviewed('Projector', 10, 4);
      await reserve(event, reviewerA, line, 2);
      await changePeriod(event);
      await start(event, reviewerA);
      const state = asJson(await one('select equipment_review_for_event($1)::text as answer', [event]));
      const [res] = state.request.lines[0].reservations;
      expect(res).toMatchObject({ quantity: 2, flagged: true });
    });
  });

  describe('AC7: resolving a flag', () => {
    const flaggedOne = async (total = 10, need = 2) => {
      const ctx = await reviewed('Projector', total, need);
      await reserve(ctx.event, reviewerA, ctx.line, need);
      await changePeriod(ctx.event);
      await start(ctx.event, reviewerA);
      ctx.id = (await reservation(ctx.event)).id;
      return ctx;
    };

    it('SCRUM300_AC7_move_takes_the_current_period_clears_the_flag_and_arranges', async () => {
      const { event, id } = await flaggedOne();
      await move(event, reviewerA, id);
      const row = await reservation(event);
      expect(row.flagged).toBe(false);
      expect(new Date(row.start_at).toISOString()).toBe('2026-12-05T10:00:00.000Z');
      expect(await requestStatus(event)).toBe('arranged');
      expect((await events(event)).at(-1)).toMatchObject({ action: 'moved', user_id: reviewerA });
    });

    it('SCRUM300_AC7_move_is_refused_when_the_new_period_lacks_units_and_stays_flagged', async () => {
      const { event, id, type } = await flaggedOne(2, 2);
      const other = await newEvent({ start: NEW_START, end: NEW_END });
      const otherLine = (await add(other, type, 2)).request.lines[0].id;
      await start(other, reviewerB);
      await reserve(other, reviewerB, otherLine, 1);
      const err = await refusal(move(event, reviewerA, id));
      expect(err?.code).toBe('22023');
      expect(err?.message).toMatch(/Only 1 available/);
      expect((await reservation(event)).flagged).toBe(true);
    });

    it('SCRUM300_AC7_move_does_not_count_the_reservation_against_itself', async () => {
      const { event, id } = await flaggedOne(2, 2);
      await db.query("update event_requests set proposed_start = '2026-12-01T11:00:00Z', proposed_end = '2026-12-01T13:00:00Z' where id = $1", [event]);
      await move(event, reviewerA, id);
      expect((await reservation(event)).flagged).toBe(false);
    });

    it('SCRUM300_AC7_only_a_flagged_reservation_can_be_moved_or_kept', async () => {
      const { event, line } = await reviewed('Projector', 10, 3);
      await reserve(event, reviewerA, line, 1);
      const { id } = await reservation(event);
      expect((await refusal(move(event, reviewerA, id)))?.code).toBe('55000');
      expect((await refusal(keep(event, reviewerA, id)))?.code).toBe('55000');
    });

    it('SCRUM300_AC7_keep_is_refused_while_the_period_does_not_match', async () => {
      const { event, id } = await flaggedOne();
      const err = await refusal(keep(event, reviewerA, id));
      expect(err?.code).toBe('55000');
      expect(err?.message).toMatch(/period no longer matches/);
    });

    it('SCRUM300_AC7_keep_works_when_the_event_goes_back_to_the_original_period', async () => {
      const { event, id } = await flaggedOne();
      await changePeriod(event, START, END);
      await keep(event, reviewerA, id, 'Date reverted');
      expect((await reservation(event)).flagged).toBe(false);
      expect((await events(event)).at(-1)).toMatchObject({ action: 'kept', reason: 'Date reverted' });
      expect(await requestStatus(event)).toBe('arranged');
    });

    it('SCRUM300_AC7_keep_is_refused_when_the_line_now_needs_less', async () => {
      const { event, line } = await reviewed('Projector', 10, 4);
      await reserve(event, reviewerA, line, 4);
      await db.query('select amend_equipment_line($1, $2, $3, 2)', [event, coordinator, line]);
      await start(event, reviewerA);
      const { id } = await reservation(event);
      const err = await refusal(keep(event, reviewerA, id));
      expect(err?.message).toMatch(/more than the line now needs/);
    });

    it('SCRUM300_AC7_keep_is_refused_when_the_type_is_over_committed', async () => {
      const { event, line, type } = await reviewed('Projector', 4, 2);
      await reserve(event, reviewerA, line, 2);
      await db.query('select amend_equipment_line($1, $2, $3, 2)', [event, coordinator, line]);
      await db.query('update equipment_types set damaged_quantity = 3 where id = $1', [type]);
      await start(event, reviewerA);
      const { id } = await reservation(event);
      const err = await refusal(keep(event, reviewerA, id));
      expect(err?.message).toMatch(/over-committed/);
    });

    it('SCRUM300_AC7_reducing_a_flagged_reservation_that_now_fits_clears_the_flag', async () => {
      const { event, line } = await reviewed('Projector', 10, 4);
      await reserve(event, reviewerA, line, 4);
      await db.query('select amend_equipment_line($1, $2, $3, 2)', [event, coordinator, line]);
      await start(event, reviewerA);
      const { id } = await reservation(event);
      await reduce(event, reviewerA, id, 2, 'Line now needs 2');
      expect((await reservation(event)).flagged).toBe(false);
      expect(await requestStatus(event)).toBe('arranged');
    });

    it('SCRUM300_AC7_reducing_a_reservation_whose_period_is_wrong_leaves_it_flagged', async () => {
      const { event, id } = await flaggedOne(10, 3);
      await reduce(event, reviewerA, id, 1, 'Smaller');
      expect((await reservation(event)).flagged).toBe(true);
    });

    it('SCRUM300_AC7_releasing_a_flagged_reservation_takes_it_off_the_flagged_list', async () => {
      const { event, id } = await flaggedOne();
      await release(event, reviewerA, id, 'Not needed any more');
      const state = asJson(await one('select equipment_review_for_event($1)::text as answer', [event]));
      expect(state.request.lines[0].reservations).toEqual([]);
    });
  });

  describe('guards on the newer actions', () => {
    const flagged = async () => {
      const ctx = await reviewed('Projector', 10, 2);
      await reserve(ctx.event, reviewerA, ctx.line, 2);
      await changePeriod(ctx.event);
      await start(ctx.event, reviewerA);
      ctx.id = (await reservation(ctx.event)).id;
      return ctx;
    };

    it('SCRUM300_move_and_keep_refuse_anyone_but_the_current_reviewer', async () => {
      const { event, id } = await flagged();
      expect((await refusal(move(event, reviewerB, id)))?.code).toBe('42501');
      expect((await refusal(keep(event, reviewerB, id)))?.code).toBe('42501');
      expect((await reservation(event)).flagged).toBe(true);
    });

    it('SCRUM300_move_keep_reduce_and_release_refuse_when_the_request_is_not_under_review', async () => {
      const { event, id } = await flagged();
      await db.query("update equipment_requests set status = 'pending_review' where event_request_id = $1 and status <> 'cancelled'", [event]);
      for (const call of [
        () => move(event, reviewerA, id),
        () => keep(event, reviewerA, id),
        () => reduce(event, reviewerA, id, 1),
        () => release(event, reviewerA, id),
      ]) {
        expect((await refusal(call()))?.code).toBe('55000');
      }
    });

    it('SCRUM300_reduce_release_move_and_keep_refuse_when_the_event_status_does_not_allow_it', async () => {
      const { event, id } = await flagged();
      await db.query("update event_requests set status = 'rejected' where id = $1", [event]);
      for (const call of [
        () => move(event, reviewerA, id),
        () => keep(event, reviewerA, id),
        () => reduce(event, reviewerA, id, 1),
        () => release(event, reviewerA, id),
      ]) {
        const err = await refusal(call());
        expect(err?.code).toBe('55000');
        expect(err?.message).toMatch(/Approved, Safety review, Safety approved or Confirmed\. This event is Rejected/);
      }
    });

    it('SCRUM300_a_refused_action_writes_no_history', async () => {
      const { event, id } = await flagged();
      const before = (await events(event)).length;
      await refusal(reduce(event, reviewerB, id, 1));
      await refusal(release(event, reviewerA, id, ' '));
      await refusal(keep(event, reviewerA, id));
      expect((await events(event)).length).toBe(before);
    });

    it('SCRUM300_a_released_reservation_cannot_be_moved_kept_or_reduced', async () => {
      const { event, id } = await flagged();
      await release(event, reviewerA, id);
      for (const call of [
        () => move(event, reviewerA, id),
        () => keep(event, reviewerA, id),
        () => reduce(event, reviewerA, id, 1),
      ]) {
        expect((await refusal(call()))?.code).toBe('55000');
      }
    });

    it('SCRUM300_a_made_up_reservation_id_is_not_found', async () => {
      const { event } = await flagged();
      const none = '00000000-0000-0000-0000-000000000000';
      expect((await refusal(release(event, reviewerA, none)))?.code).toBe('P0002');
      expect((await refusal(move(event, reviewerA, none)))?.code).toBe('P0002');
    });

    it('SCRUM300_move_to_a_type_that_has_since_been_retired_is_refused', async () => {
      const { event, id, type } = await flagged();
      await db.query('update equipment_types set retired_at = now() where id = $1', [type]);
      const err = await refusal(move(event, reviewerA, id));
      expect(err?.code).toBe('55000');
    });

    it('SCRUM300_move_is_refused_when_the_event_has_lost_its_period', async () => {
      const { event, id } = await flagged();
      await db.query('update event_requests set proposed_start = null where id = $1', [event]);
      expect((await refusal(move(event, reviewerA, id)))?.code).toBe('55000');
    });

    it('SCRUM300_move_is_refused_when_the_reservation_holds_more_than_the_line_needs', async () => {
      const { event, line, id } = await flagged();
      await db.query('select amend_equipment_line($1, $2, $3, 1)', [event, coordinator, line]);
      await start(event, reviewerA);
      const err = await refusal(move(event, reviewerA, id));
      expect(err?.code).toBe('22023');
      expect(err?.message).toMatch(/Reduce it first/);
    });
  });

  describe('flag side effects', () => {
    it('SCRUM300_AC6_flagging_clears_the_reviewer_and_the_request_goes_back_to_pending_review', async () => {
      const { event, line } = await reviewed('Projector', 10, 4);
      await reserve(event, reviewerA, line, 2);
      expect(await requestStatus(event)).toBe('under_review');
      await changePeriod(event);
      expect(await requestStatus(event)).toBe('pending_review');
      const request = await one(
        "select reviewer_id from equipment_requests where event_request_id = $1 and status <> 'cancelled'",
        [event],
      );
      expect(request.reviewer_id).toBeNull();
    });

    it('SCRUM300_AC6_the_old_reviewer_can_no_longer_act_after_a_flag', async () => {
      const { event, line } = await reviewed('Projector', 10, 4);
      await reserve(event, reviewerA, line, 2);
      await changePeriod(event);
      const { id } = await reservation(event);
      expect((await refusal(release(event, reviewerA, id)))?.code).toBe('55000');
    });

    it('SCRUM300_AC6_flagging_twice_records_one_flag', async () => {
      const { event, line } = await reviewed('Projector', 10, 4);
      await reserve(event, reviewerA, line, 2);
      await changePeriod(event);
      await changePeriod(event, '2026-12-06T10:00:00Z', '2026-12-06T12:00:00Z');
      const flags = (await events(event)).filter((e) => e.action === 'flagged');
      expect(flags).toHaveLength(1);
    });

    it('SCRUM300_AC6_a_released_reservation_is_not_flagged_by_a_date_change', async () => {
      const { event, line } = await reviewed('Projector', 10, 4);
      await reserve(event, reviewerA, line, 2);
      const { id } = await reservation(event);
      await release(event, reviewerA, id);
      await changePeriod(event);
      expect((await reservation(event)).flagged).toBe(false);
      expect((await events(event)).filter((e) => e.action === 'flagged')).toHaveLength(0);
    });

    it('SCRUM300_AC6_a_cancelled_request_is_left_cancelled_by_a_flag', async () => {
      const { event, line } = await reviewed('Projector', 10, 4);
      await reserve(event, reviewerA, line, 2);
      await db.query("update equipment_requests set status = 'cancelled' where event_request_id = $1", [event]);
      await changePeriod(event);
      const row = await one('select status::text as s from equipment_requests where event_request_id = $1', [event]);
      expect(row.s).toBe('cancelled');
    });

    it('SCRUM300_AC7_more_can_still_be_reserved_on_a_line_that_has_a_flagged_reservation_but_it_cannot_arrange', async () => {
      const { event, line } = await reviewed('Projector', 10, 3);
      await reserve(event, reviewerA, line, 1);
      await db.query('update equipment_reservations set flagged = true where equipment_line_id = $1', [line]);
      await reserve(event, reviewerA, line, 2);
      expect(await requestStatus(event)).toBe('under_review');
    });
  });
});