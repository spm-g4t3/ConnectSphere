/**
 * Which reservations a lower usable quantity would affect, against the final schema in a
 * real Postgres (PGlite).
 *
 * equipment_over_commitment goes through the type's held reservations that have not ended,
 * oldest first. Each is kept if, at every moment of its period, it fits within the new usable
 * quantity alongside the ones already kept; otherwise it is affected. It never writes.
 * equipment_change_affected adds the before and after figures and the rule for when a change
 * can leave anything short, so the preview and the save agree.
 *
 * Reservations are inserted directly with a chosen created_at, so "oldest" is set by the
 * test and not by how fast the statements ran.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedUser } from './helpers/schemaDb.js';
import { queriesFor, refusal } from './helpers/queries.js';
import { reservationSteps, asJson } from './helpers/equipment.js';
import { clientsCanExecute } from './helpers/grants.js';
import { withSafetyReviewTransitionGuardDisabled } from '../fixtures/safetyReviewTestHelpers.js';

const DAY = 86_400_000;
// A day ten days ahead at midnight UTC; every period below is hours after it.
const BASE = Math.floor((Date.now() + 10 * DAY) / DAY) * DAY;
const hour = (h) => new Date(BASE + h * 3_600_000).toISOString();

describe('SCRUM-310 (SCRUM-311): the over-commitment calculation', () => {
  let db;
  let organiser;
  let coordinator;
  let coordinatorName;
  let reviewerA;
  let seq = 0;

  const { one, rows } = queriesFor(() => db);
  const { newType, newEvent, add } = reservationSteps(
    () => ({ db, organiser, coordinator, reviewerA }),
    { start: hour(1), end: hour(2), newStart: hour(3), newEnd: hour(4) },
  );

  /**
   * One held reservation of `quantity` units from hour `from` to hour `to`,
   * created `order` minutes after a fixed moment so the oldest is the lowest.
   */
  async function reserved(type, order, quantity, from, to, { flagged = false } = {}) {
    const event = await newEvent({ start: hour(from), end: hour(to) });
    const line = (await add(event, type, quantity)).request.lines[0].id;
    const created = new Date(Date.UTC(2026, 0, 1, 0, order)).toISOString();
    const { id } = await one(
      `insert into equipment_reservations
         (equipment_type_id, event_request_id, equipment_line_id, quantity, start_at, end_at,
          flagged, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [type, event, line, quantity, hour(from), hour(to), flagged, created],
    );
    return { id, event };
  }

  const check = async (type, usableAfter, caller = reviewerA) =>
    asJson(await one('select equipment_over_commitment($1, $2, $3)::text as answer', [type, usableAfter, caller]));
  const affectedIds = async (type, usableAfter) => (await check(type, usableAfter)).map((r) => r.reservation_id);

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await seedUser(db, { email: 'organiser@example.com', role: 'event_organiser' });
    coordinatorName = 'Casey Coordinator';
    coordinator = await seedUser(db, {
      email: 'coordinator@example.com', role: 'event_coordinator', fullName: coordinatorName,
    });
    reviewerA = await seedUser(db, { email: 'tech-a@example.com', role: 'technical_support_staff' });
  }, 60000);

  afterAll(async () => {
    await db?.close();
  });

  const newTypeNamed = (total = 20) => newType(`Projector ${++seq} ${Math.random()}`, total);

  describe('who may ask, and what is refused', () => {
    it('SCRUM310_AC1_a_null_caller_is_refused_with_42501', async () => {
      const type = await newTypeNamed();
      const error = await refusal(check(type, 1, null));
      expect(error?.code).toBe('42501');
    });

    it('SCRUM310_AC1_only_technical_support_staff_may_ask', async () => {
      const type = await newTypeNamed();
      for (const caller of [coordinator, organiser]) {
        expect((await refusal(check(type, 1, caller)))?.code).toBe('42501');
      }
    });

    it('SCRUM310_AC1_a_negative_or_missing_usable_quantity_is_refused_with_22023', async () => {
      const type = await newTypeNamed();
      expect((await refusal(check(type, -1)))?.code).toBe('22023');
      expect((await refusal(check(type, null)))?.code).toBe('22023');
    });

    it('SCRUM310_AC1_an_unknown_type_is_refused_with_P0002', async () => {
      const error = await refusal(check('00000000-0000-4000-8000-000000000000', 1));
      expect(error?.code).toBe('P0002');
    });

    it('SCRUM310_AC1_the_client_roles_cannot_execute_it_and_service_role_can', async () => {
      const fn = 'equipment_over_commitment(uuid, integer, uuid)';
      expect(await clientsCanExecute(db, fn, ['anon', 'authenticated', 'service_role'])).toEqual(['service_role']);
    });
  });

  describe('it only reads', () => {
    it('SCRUM310_AC1_the_function_is_declared_stable', async () => {
      const { provolatile } = await one(
        "select provolatile from pg_proc where proname = 'equipment_over_commitment'",
      );
      expect(provolatile).toBe('s');
    });

    it('SCRUM310_AC1_asking_changes_no_reservation_and_writes_no_history_or_notice', async () => {
      const type = await newTypeNamed();
      await reserved(type, 1, 3, 10, 12);
      await reserved(type, 2, 3, 11, 13);

      const snapshot = async () => ({
        reservations: await rows(
          'select id, flagged, flag_reason, released_at, updated_at from equipment_reservations order by id',
        ),
        events: (await one('select count(*)::int as n from equipment_reservation_events')).n,
        notices: (await one('select count(*)::int as n from notifications')).n,
        requests: await rows('select id, status::text as s from equipment_requests order by id'),
      });

      const before = await snapshot();
      expect(await affectedIds(type, 0)).toHaveLength(2);
      expect(await snapshot()).toEqual(before);
    });
  });

  describe('AC1: which reservations count', () => {
    it('SCRUM310_AC1_a_type_with_no_reservations_has_nothing_affected', async () => {
      const type = await newTypeNamed();
      expect(await check(type, 0)).toEqual([]);
    });

    it('SCRUM310_AC1_reservations_that_have_ended_are_ignored', async () => {
      const type = await newTypeNamed();
      // BASE is ten days ahead, so 300 hours (12.5 days) back is two and a half days ago.
      await reserved(type, 1, 5, -300, -298);
      expect(await check(type, 0)).toEqual([]);
    });

    it('SCRUM310_AC1_released_reservations_are_ignored', async () => {
      const type = await newTypeNamed();
      const { id } = await reserved(type, 1, 5, 10, 12);
      await db.query(
        "update equipment_reservations set released_at = now(), release_reason = 'Returned' where id = $1",
        [id],
      );
      expect(await check(type, 0)).toEqual([]);
    });

    it('SCRUM310_AC1_another_types_reservations_are_ignored', async () => {
      const type = await newTypeNamed();
      const other = await newTypeNamed();
      await reserved(other, 1, 5, 10, 12);
      expect(await check(type, 0)).toEqual([]);
    });

    it('SCRUM310_AC3_a_flagged_reservation_still_takes_part_in_the_pass', async () => {
      const type = await newTypeNamed();
      const first = await reserved(type, 1, 3, 10, 12, { flagged: true });
      const second = await reserved(type, 2, 3, 10, 12);
      // The flagged one is the oldest, so it keeps its units and the newer loses.
      expect(await affectedIds(type, 3)).toEqual([second.id]);
      expect(first.id).not.toBe(second.id);
    });
  });

  describe('AC3: oldest first, kept if it fits at every moment', () => {
    it('SCRUM310_AC3_everything_fits_when_the_usable_quantity_covers_the_peak', async () => {
      const type = await newTypeNamed();
      await reserved(type, 1, 3, 10, 12);
      await reserved(type, 2, 3, 11, 13);
      expect(await check(type, 6)).toEqual([]);
    });

    it('SCRUM310_AC3_of_two_overlapping_reservations_the_older_is_kept', async () => {
      const type = await newTypeNamed();
      const older = await reserved(type, 1, 3, 10, 12);
      const newer = await reserved(type, 2, 3, 11, 13);
      expect(await affectedIds(type, 5)).toEqual([newer.id]);
      expect(older.id).not.toBe(newer.id);
    });

    it('SCRUM310_AC3_oldest_means_made_first_not_earliest_in_time', async () => {
      const type = await newTypeNamed();
      const madeFirstButLater = await reserved(type, 1, 3, 20, 22);
      const madeSecondButSooner = await reserved(type, 2, 3, 20, 22);
      const earlierSlot = await reserved(type, 3, 3, 10, 12);
      // The first two clash; the one made first keeps its units whatever its date.
      expect(await affectedIds(type, 3)).toEqual([madeSecondButSooner.id]);
      expect(madeFirstButLater.id).not.toBe(earlierSlot.id);
    });

    it('SCRUM310_AC3_reservations_that_do_not_overlap_are_all_kept', async () => {
      const type = await newTypeNamed();
      await reserved(type, 1, 4, 10, 12);
      await reserved(type, 2, 4, 13, 15);
      expect(await check(type, 4)).toEqual([]);
    });

    it('SCRUM310_AC3_one_ending_as_another_starts_does_not_overlap_it', async () => {
      const type = await newTypeNamed();
      await reserved(type, 1, 4, 10, 12);
      await reserved(type, 2, 4, 12, 14);
      expect(await check(type, 4)).toEqual([]);
    });

    it('SCRUM310_AC3_partly_overlapping_reservations_are_judged_at_each_moment', async () => {
      const type = await newTypeNamed();
      await reserved(type, 1, 3, 10, 12); // A, kept
      const b = await reserved(type, 2, 3, 11, 13); // B, 3 + 3 at 11:00 is over 5
      await reserved(type, 3, 2, 12, 14); // C, B is not kept, A has ended by 12:00
      await reserved(type, 4, 2, 10, 11); // D, 3 + 2 at 10:00 is 5, fits
      expect(await affectedIds(type, 5)).toEqual([b.id]);
    });

    it('SCRUM310_AC3_a_peak_inside_a_long_reservation_is_found', async () => {
      const type = await newTypeNamed();
      await reserved(type, 1, 2, 10, 14); // A holds 2 all four hours
      await reserved(type, 2, 2, 10, 11); // B, 2 + 2 is 4, kept
      await reserved(type, 3, 2, 11, 12); // C, A + C is 4, kept
      // D starts at 10:30 while A and B are both held: 2 + 2 + 1 is 5.
      const d = await reserved(type, 4, 1, 10.5, 11.5);
      expect(await affectedIds(type, 4)).toEqual([d.id]);
    });

    it('SCRUM310_AC3_an_affected_reservation_does_not_take_up_room_for_later_ones', async () => {
      const type = await newTypeNamed();
      await reserved(type, 1, 3, 10, 12); // kept
      const b = await reserved(type, 2, 3, 10, 12); // affected, so it holds nothing
      await reserved(type, 3, 2, 10, 12); // 3 + 2 is 5, fits because B was dropped
      expect(await affectedIds(type, 5)).toEqual([b.id]);
    });

    it('SCRUM310_AC3_one_reservation_larger_than_the_usable_quantity_is_affected', async () => {
      const type = await newTypeNamed();
      const big = await reserved(type, 1, 5, 10, 12);
      expect(await affectedIds(type, 3)).toEqual([big.id]);
    });

    it('SCRUM310_AC1_a_usable_quantity_of_zero_affects_every_held_reservation', async () => {
      const type = await newTypeNamed();
      const a = await reserved(type, 1, 1, 10, 12);
      const b = await reserved(type, 2, 1, 14, 16);
      expect(await affectedIds(type, 0)).toEqual([a.id, b.id]);
    });
  });

  describe('AC2: what the staff member is shown for each one', () => {
    it('SCRUM310_AC2_each_affected_reservation_names_the_event_period_quantity_and_coordinator', async () => {
      const type = await newTypeNamed();
      await reserved(type, 1, 3, 10, 12);
      const { id, event } = await reserved(type, 2, 3, 11, 13);
      await db.query("update event_requests set event_name = 'Hack Night' where id = $1", [event]);

      const [row] = await check(type, 5);
      expect(row).toMatchObject({
        reservation_id: id,
        event_request_id: event,
        event_name: 'Hack Night',
        quantity: 3,
        coordinator_id: coordinator,
        coordinator_name: coordinatorName,
        flagged: false,
      });
      expect(new Date(row.start_at).toISOString()).toBe(hour(11));
      expect(new Date(row.end_at).toISOString()).toBe(hour(13));
    });

    it('SCRUM310_AC2_the_list_is_in_the_order_the_reservations_were_made', async () => {
      const type = await newTypeNamed();
      const first = await reserved(type, 1, 1, 10, 12);
      const second = await reserved(type, 2, 1, 20, 22);
      const third = await reserved(type, 3, 1, 15, 17);
      expect(await affectedIds(type, 0)).toEqual([first.id, second.id, third.id]);
    });
  });

  describe('boundaries and stacking', () => {
    it('SCRUM310_AC3_a_peak_exactly_equal_to_the_usable_quantity_fits', async () => {
      const type = await newTypeNamed();
      await reserved(type, 1, 3, 10, 12);
      await reserved(type, 2, 2, 11, 13);
      expect(await check(type, 5)).toEqual([]);
    });

    it('SCRUM310_AC3_one_unit_below_that_peak_affects_the_newer_reservation', async () => {
      const type = await newTypeNamed();
      await reserved(type, 1, 3, 10, 12);
      const newer = await reserved(type, 2, 2, 11, 13);
      expect(await affectedIds(type, 4)).toEqual([newer.id]);
    });

    it('SCRUM310_AC3_a_usable_quantity_above_everything_held_affects_nothing', async () => {
      const type = await newTypeNamed();
      await reserved(type, 1, 5, 10, 12);
      await reserved(type, 2, 5, 10, 12);
      expect(await check(type, 1000)).toEqual([]);
    });

    it('SCRUM310_AC3_reservations_held_together_add_up_and_the_one_that_tips_it_is_affected', async () => {
      const type = await newTypeNamed();
      await reserved(type, 1, 2, 10, 12);
      await reserved(type, 2, 2, 10, 12);
      await reserved(type, 3, 2, 10, 12);
      const tips = await reserved(type, 4, 1, 10, 12);
      expect(await affectedIds(type, 6)).toEqual([tips.id]);
    });

    it('SCRUM310_AC3_the_peak_is_the_most_held_at_once_not_the_sum_of_everything_that_touches', async () => {
      const type = await newTypeNamed();
      await reserved(type, 1, 3, 10, 11); // A
      await reserved(type, 2, 3, 12, 13); // B, never at the same time as A
      const c = await reserved(type, 3, 3, 10, 13); // C meets A, then B
      // A, B and C total 9, but at most two are held at once (6).
      expect(await check(type, 6)).toEqual([]);
      expect(await affectedIds(type, 5)).toEqual([c.id]);
    });

    it('SCRUM310_AC3_reservations_made_at_the_same_instant_are_ordered_by_id', async () => {
      const type = await newTypeNamed();
      const a = await reserved(type, 1, 3, 10, 12);
      const b = await reserved(type, 1, 3, 10, 12);
      const [kept, dropped] = [a.id, b.id].sort();
      expect(await affectedIds(type, 3)).toEqual([dropped]);
      expect(kept).not.toBe(dropped);
    });

    it('SCRUM310_AC1_a_reservation_already_under_way_still_counts', async () => {
      const type = await newTypeNamed();
      // Began 250 hours before the base day and ends at it: running now.
      const running = await reserved(type, 1, 2, -250, 0);
      expect(await affectedIds(type, 0)).toEqual([running.id]);
    });

    it.each(['confirmed', 'safety_review'])(
      'SCRUM310_AC1_a_reservation_on_a_%s_event_is_still_checked',
      async (status) => {
        const type = await newTypeNamed();
        // Equipment lines can only be added while the event is Approved, so the
        // reservation is made first and the event then moved to the later status.
        const { id, event } = await reserved(type, 1, 2, 10, 12);
        await withSafetyReviewTransitionGuardDisabled(db, () =>
          db.query('update event_requests set status = $2 where id = $1', [event, status]));
        expect((await one('select status::text as s from event_requests where id = $1', [event])).s).toBe(status);
        expect(await affectedIds(type, 0)).toEqual([id]);
      },
    );

    it('SCRUM310_AC1_a_retired_type_still_answers_and_all_its_held_reservations_are_affected', async () => {
      const type = await newTypeNamed();
      const a = await reserved(type, 1, 1, 10, 12);
      const b = await reserved(type, 2, 1, 10, 12);
      await db.query('update equipment_types set retired_at = now() where id = $1', [type]);
      expect(await affectedIds(type, 0)).toEqual([a.id, b.id]);
    });

    it('SCRUM310_AC1_a_request_cancelled_after_the_reservation_no_longer_counts', async () => {
      const type = await newTypeNamed();
      const gone = await reserved(type, 1, 3, 10, 12);
      const stays = await reserved(type, 2, 3, 10, 12);
      await db.query(
        "update equipment_requests set status = 'cancelled' where event_request_id = $1",
        [gone.event],
      );
      // The cancelled request released its reservation, so the other no longer clashes.
      expect(await check(type, 3)).toEqual([]);
      expect(stays.id).not.toBe(gone.id);
    });
  });

  describe('who may not ask', () => {
    it.each([
      'event_organiser', 'event_coordinator', 'event_coordinator_lead', 'venue_staff',
      'safety_officer', 'attendee', 'technical_support',
    ])('SCRUM310_AC1_a_%s_is_refused_with_42501', async (role) => {
      const type = await newTypeNamed();
      const caller = await seedUser(db, { email: `${role}-${++seq}@example.com`, role });
      expect((await refusal(check(type, 1, caller)))?.code).toBe('42501');
    });

    it('SCRUM310_AC1_a_caller_with_no_profile_is_refused_with_42501', async () => {
      const type = await newTypeNamed();
      const bare = await seedUser(db, { email: `bare-${++seq}@example.com` });
      expect((await refusal(check(type, 1, bare)))?.code).toBe('42501');
      expect((await refusal(check(type, 1, '00000000-0000-4000-8000-000000000001')))?.code).toBe('42501');
    });

    it('SCRUM310_AC1_a_missing_type_id_is_refused_with_P0002', async () => {
      expect((await refusal(check(null, 1)))?.code).toBe('P0002');
    });
  });

  describe('equipment_change_affected: the before and after figures and when to check', () => {
    const change = async (type, args = {}, caller = reviewerA) => {
      const { total = null, damaged = null, underMaintenance = null, retire = false } = args;
      return asJson(await one(
        'select equipment_change_affected($1, $2, $3, $4, $5, $6)::text as answer',
        [type, caller, total, damaged, underMaintenance, retire],
      ));
    };
    const withCondition = (type, columns) =>
      db.query(
        `update equipment_types set ${Object.keys(columns).map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`,
        [type, ...Object.values(columns)],
      );

    it('SCRUM310_AC1_a_null_caller_and_other_roles_are_refused_with_42501', async () => {
      const type = await newTypeNamed(10);
      expect((await refusal(change(type, { total: 5 }, null)))?.code).toBe('42501');
      for (const caller of [coordinator, organiser]) {
        expect((await refusal(change(type, { total: 5 }, caller)))?.code).toBe('42501');
      }
    });

    it('SCRUM310_AC1_an_unknown_type_is_refused_with_P0002', async () => {
      const error = await refusal(change('00000000-0000-4000-8000-000000000000', { total: 5 }));
      expect(error?.code).toBe('P0002');
    });

    it('SCRUM310_AC1_a_change_that_takes_the_usable_quantity_below_zero_is_refused_with_22023', async () => {
      const type = await newTypeNamed(10);
      expect((await refusal(change(type, { damaged: 11 })))?.code).toBe('22023');
    });

    it.each([
      ['a smaller total', { total: 6 }, [10, 6]],
      ['more damaged', { damaged: 4 }, [10, 6]],
      ['more under maintenance', { underMaintenance: 3 }, [10, 7]],
      ['both conditions', { damaged: 4, underMaintenance: 3 }, [10, 3]],
      ['a total with a condition', { total: 8, damaged: 4 }, [10, 4]],
      ['everything unusable', { damaged: 10 }, [10, 0]],
      ['a retirement', { retire: true }, [10, 0]],
      ['a larger total', { total: 20 }, [10, 20]],
      ['less damage', { damaged: 0 }, [10, 10]],
    ])('SCRUM310_AC1_%s_reports_the_usable_quantity_before_and_after', async (_label, args, [before, after]) => {
      const type = await newTypeNamed(10);
      const answer = await change(type, args);
      expect([answer.usable_before, answer.usable_after]).toEqual([before, after]);
    });

    it('SCRUM310_AC1_quantities_left_out_stay_as_they_are', async () => {
      const type = await newTypeNamed(10);
      await withCondition(type, { damaged_quantity: 2, under_maintenance_quantity: 1 });
      const answer = await change(type, { total: 8 });
      expect([answer.usable_before, answer.usable_after]).toEqual([7, 5]);
    });

    it('SCRUM310_AC1_a_change_that_lowers_the_usable_quantity_lists_the_same_reservations_as_the_check', async () => {
      const type = await newTypeNamed(10);
      await reserved(type, 1, 4, 10, 12);
      const lost = await reserved(type, 2, 4, 10, 12);

      const answer = await change(type, { total: 6 });

      expect(answer.affected.map((r) => r.reservation_id)).toEqual([lost.id]);
      expect(answer.affected).toEqual(await check(type, 6));
    });

    it.each([
      ['a larger total', { total: 20 }],
      ['less damage', { damaged: 0 }],
      ['a swap that keeps the usable quantity', { total: 11, damaged: 1 }],
    ])('SCRUM310_AC7_%s_lists_nobody_even_when_the_type_is_already_over_committed', async (_label, args) => {
      const type = await newTypeNamed(10);
      await reserved(type, 1, 9, 10, 12);
      await withCondition(type, { damaged_quantity: 8 });

      const answer = await change(type, args);

      expect(answer.affected).toEqual([]);
    });

    it('SCRUM310_AC4_a_retirement_lists_the_reservations_even_when_no_unit_was_usable', async () => {
      const type = await newTypeNamed(4);
      const held = await reserved(type, 1, 2, 10, 12);
      await withCondition(type, { damaged_quantity: 4 });

      const answer = await change(type, { retire: true });

      expect(answer.usable_before).toBe(0);
      expect(answer.affected.map((r) => r.reservation_id)).toEqual([held.id]);
    });

    it('SCRUM310_AC1_it_only_reads', async () => {
      const type = await newTypeNamed(10);
      await reserved(type, 1, 4, 10, 12);
      await reserved(type, 2, 4, 10, 12);
      const before = await rows('select * from equipment_reservations order by id');

      await change(type, { retire: true });

      expect(await rows('select * from equipment_reservations order by id')).toEqual(before);
      expect((await one(
        "select provolatile from pg_proc where proname = 'equipment_change_affected'",
      )).provolatile).toBe('s');
    });

    it('SCRUM310_AC1_the_client_roles_cannot_execute_the_new_functions_and_service_role_can', async () => {
      for (const fn of [
        'equipment_change_affected(uuid, uuid, integer, integer, integer, boolean)',
        'equipment_over_commitment_unchecked(uuid, integer)',
        'flag_equipment_reservation_ids(uuid[], text, uuid, text)',
        'equipment_loss_reason(boolean, text)',
      ]) {
        expect(await clientsCanExecute(db, fn, ['anon', 'authenticated', 'service_role']), fn).toEqual(['service_role']);
      }
    });

    it('SCRUM310_AC1_the_unchecked_calculation_refuses_a_negative_figure_and_an_unknown_type', async () => {
      const type = await newTypeNamed(10);
      const unchecked = (id, usable) =>
        one('select equipment_over_commitment_unchecked($1, $2)::text as answer', [id, usable]);
      expect((await refusal(unchecked(type, -1)))?.code).toBe('22023');
      expect((await refusal(unchecked('00000000-0000-4000-8000-000000000000', 1)))?.code).toBe('P0002');
    });
  });

  describe('against a plain brute-force reading of the rule', () => {
    // Every start and end below is a whole hour, so sampling each one-hour slot
    // is exact: a reservation fits when no slot it covers holds more than the
    // usable quantity once it is added to the ones already kept.
    function expectedAffected(list, usable) {
      const kept = [];
      const affected = [];
      for (const r of list) {
        let peak = 0;
        for (let slot = r.from; slot < r.to; slot += 1) {
          const held = kept
            .filter((k) => k.from <= slot && slot < k.to)
            .reduce((sum, k) => sum + k.quantity, 0);
          peak = Math.max(peak, held);
        }
        if (peak + r.quantity > usable) affected.push(r.index);
        else kept.push(r);
      }
      return affected;
    }

    // A fixed generator, so a failure is the same failure every run.
    function random(seed) {
      let state = seed;
      return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    it.each([11, 22, 33, 44, 55, 66])(
      'SCRUM310_AC3_seed_%i_matches_the_brute_force_answer_for_several_usable_quantities',
      async (seed) => {
        const next = random(seed);
        const type = await newTypeNamed(50);
        const list = [];
        const ids = [];
        for (let index = 0; index < 10; index += 1) {
          const from = 10 + Math.floor(next() * 10);
          const to = from + 1 + Math.floor(next() * 4);
          const quantity = 1 + Math.floor(next() * 4);
          const { id } = await reserved(type, index + 1, quantity, from, to);
          list.push({ index, from, to, quantity });
          ids.push(id);
        }

        for (const usable of [0, 2, 4, 6, 9, 30]) {
          const expected = expectedAffected(list, usable).map((i) => ids[i]);
          expect(await affectedIds(type, usable), `seed ${seed}, usable ${usable}`).toEqual(expected);
        }
      },
    );
  });
});
