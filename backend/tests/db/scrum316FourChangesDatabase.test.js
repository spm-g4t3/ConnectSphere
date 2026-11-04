/**
 * Each of the four changes that lower what is usable, run the same way against real reservations made through the real functions, in a
 * real Postgres (PGlite).
 *
 *   damage            a number of units marked damaged
 *   maintenance       a number of units taken out for maintenance
 *   a lower total     the stock count reduced
 *   a retirement      the whole type taken out of use
 *
 * For every one of them: the check lists the reservations that no longer fit,
 * asking changes nothing, cancelling saves nothing, a confirmed save flags them
 * and sends their requests back to Pending review, a Confirmed event stays
 * Confirmed, and the change and each flag record the user, time and reason.
 *
 * The older reservation is made first, so it is the one that keeps its units
 * wherever the change leaves room for only one of the two.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedUser } from './helpers/schemaDb.js';
import { queriesFor } from './helpers/queries.js';
import { reservationSteps, asJson } from './helpers/equipment.js';
import { withSafetyReviewTransitionGuardDisabled } from '../fixtures/safetyReviewTestHelpers.js';

const DAY = 86_400_000;
const BASE = Math.floor((Date.now() + 10 * DAY) / DAY) * DAY;
const hour = (h) => new Date(BASE + h * 3_600_000).toISOString();

// Ten units, two reservations of three held at the same time. After each change
// below there are four usable units (retirement: none), so the second does not fit.
const CHANGES = [
  ['damage', { damaged: 6, note: 'Cracked in transit' }, 'damaged_quantity', 'Fewer units of this equipment are usable (Cracked in transit)', 'second'],
  ['maintenance', { underMaintenance: 6, note: 'Annual service' }, 'under_maintenance_quantity', 'Fewer units of this equipment are usable (Annual service)', 'second'],
  ['a lower total', { total: 4 }, 'total_quantity', 'Fewer units of this equipment are usable', 'second'],
  ['a retirement', { retire: true, note: 'End of life' }, 'retired_at', null, 'both'],
];

describe('SCRUM-310 (SCRUM-316): the four changes that lower what is usable', () => {
  let db;
  let organiser;
  let coordinator;
  let reviewerA;

  const { one, rows } = queriesFor(() => db);
  const steps = reservationSteps(
    () => ({ db, organiser, coordinator, reviewerA }),
    { start: hour(1), end: hour(2), newStart: hour(3), newEnd: hour(4) },
  );
  const { newType, newEvent, add, start, reserve, requestStatus } = steps;

  /** Ten units; an older and a newer reservation of three, each on its own event. */
  async function scene() {
    const type = await newType(`Speaker ${Math.random()}`, 10);
    const made = [];
    for (const age of [1, 2]) {
      const event = await newEvent();
      const state = await add(event, type, 3);
      await start(event, reviewerA);
      await reserve(event, reviewerA, state.request.lines[0].id, 3);
      const { id } = await one('select id from equipment_reservations where event_request_id = $1', [event]);
      await db.query('update equipment_reservations set created_at = $2 where id = $1',
        [id, new Date(Date.UTC(2026, 0, 1, 0, age)).toISOString()]);
      made.push({ event, id });
    }
    return { type, first: made[0], second: made[1] };
  }

  /** apply_equipment_change with exactly the arguments the API sends. */
  async function apply(type, change, confirmed) {
    const { total = null, damaged = null, underMaintenance = null, retire = false, note = null } = change;
    return asJson(await one(
      `select apply_equipment_change($1, $2, $3, $4, $5, $6, '{}'::jsonb, $7, $8::uuid[])::text as answer`,
      [type, reviewerA, total, damaged, underMaintenance, retire, note, confirmed],
    ));
  }

  const lostBy = (shape, { first, second }) => (shape === 'both' ? [first.id, second.id] : [second.id]);
  const idsOf = (answer) => answer.affected.map((r) => r.reservation_id).sort();
  const sorted = (list) => [...list].sort();
  const flaggedRows = (type) =>
    rows('select id from equipment_reservations where equipment_type_id = $1 and flagged order by id', [type]);
  const counts = async () => ({
    events: (await one('select count(*)::int as n from equipment_reservation_events')).n,
    history: (await one('select count(*)::int as n from equipment_type_history')).n,
    notices: (await one('select count(*)::int as n from notifications')).n,
  });

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await seedUser(db, { email: 'organiser@example.com', role: 'event_organiser' });
    coordinator = await seedUser(db, {
      email: 'coordinator@example.com', role: 'event_coordinator', fullName: 'Casey Coordinator',
    });
    reviewerA = await seedUser(db, { email: 'tech-a@example.com', role: 'technical_support_staff' });
  }, 60000);

  afterAll(async () => {
    await db?.close();
  });

  describe.each(CHANGES)('%s', (_label, change, field, reason, shape) => {
    it('SCRUM310_AC1_the_check_lists_the_unended_reservations_the_change_cannot_cover', async () => {
      const s = await scene();

      const answer = await apply(s.type, change, []);

      expect(answer.saved).toBe(false);
      expect(idsOf(answer)).toEqual(sorted(lostBy(shape, s)));
    });

    it('SCRUM310_AC1_a_reservation_that_has_already_ended_is_not_listed', async () => {
      const s = await scene();
      await db.query(
        "update equipment_reservations set start_at = now() - interval '3 days', end_at = now() - interval '2 days' where id = $1",
        [s.second.id],
      );

      const answer = await apply(s.type, change, []);

      expect(idsOf(answer)).not.toContain(s.second.id);
    });

    it('SCRUM310_AC2_asking_without_confirming_saves_nothing_and_flags_nothing', async () => {
      const s = await scene();
      const before = { counts: await counts(), type: await one('select * from equipment_types where id = $1', [s.type]) };

      await apply(s.type, change, []);

      expect(await one('select * from equipment_types where id = $1', [s.type])).toEqual(before.type);
      expect(await counts()).toEqual(before.counts);
      expect(await flaggedRows(s.type)).toEqual([]);
      expect(await requestStatus(s.second.event)).toBe('arranged');
    });

    it('SCRUM310_AC3_the_newer_reservation_is_the_one_that_loses_its_units', async () => {
      const s = await scene();

      const answer = await apply(s.type, change, []);

      expect(idsOf(answer)).toContain(s.second.id);
      if (shape === 'second') expect(idsOf(answer)).not.toContain(s.first.id);
    });

    it('SCRUM310_AC4_a_confirmed_save_changes_the_type_flags_the_listed_reservations_and_sends_their_requests_back', async () => {
      const s = await scene();
      const preview = await apply(s.type, change, []);

      const answer = await apply(s.type, change, preview.affected.map((r) => r.reservation_id));

      expect(answer).toMatchObject({ saved: true, flagged_count: preview.affected.length });
      expect(sorted((await flaggedRows(s.type)).map((r) => r.id))).toEqual(sorted(lostBy(shape, s)));
      expect(await requestStatus(s.second.event)).toBe('pending_review');
      expect(await requestStatus(s.first.event)).toBe(shape === 'both' ? 'pending_review' : 'arranged');
      const row = await one('select * from equipment_types where id = $1', [s.type]);
      expect(row[field]).not.toBeNull();
    });

    it('SCRUM310_AC4_a_confirmation_that_does_not_match_the_check_saves_nothing', async () => {
      const s = await scene();

      const answer = await apply(s.type, change, shape === 'both' ? [s.first.id] : []);

      expect(answer.saved).toBe(false);
      expect(await flaggedRows(s.type)).toEqual([]);
      expect(await requestStatus(s.second.event)).toBe('arranged');
    });

    it('SCRUM310_AC6_a_confirmed_event_stays_confirmed_and_keeps_a_flagged_reservation_to_show', async () => {
      const s = await scene();
      await withSafetyReviewTransitionGuardDisabled(db, () =>
        db.query("update event_requests set status = 'confirmed' where id = $1", [s.second.event]));
      const preview = await apply(s.type, change, []);

      await apply(s.type, change, preview.affected.map((r) => r.reservation_id));

      expect((await one('select status::text as s from event_requests where id = $1', [s.second.event])).s)
        .toBe('confirmed');
      expect((await one(
        'select flagged, released_at from equipment_reservations where id = $1', [s.second.id],
      ))).toMatchObject({ flagged: true, released_at: null });
    });

    it('SCRUM310_AC8_the_change_and_each_flag_record_the_user_the_time_and_the_reason', async () => {
      const s = await scene();
      const preview = await apply(s.type, change, []);
      const started = Date.now();

      await apply(s.type, change, preview.affected.map((r) => r.reservation_id));

      const history = await rows(
        "select field_name, changed_by, changed_at, note from equipment_type_history where equipment_type_id = $1 and field_name = $2",
        [s.type, field],
      );
      expect(history).toHaveLength(1);
      expect(history[0].changed_by).toBe(reviewerA);
      expect(Math.abs(new Date(history[0].changed_at).getTime() - started)).toBeLessThan(60_000);
      if (change.note) expect(history[0].note).toBe(change.note);

      for (const id of lostBy(shape, s)) {
        const events = await rows(
          "select user_id, reason, created_at from equipment_reservation_events where equipment_reservation_id = $1 and action = 'flagged'",
          [id],
        );
        expect(events).toHaveLength(1);
        expect(events[0].user_id).toBe(reviewerA);
        expect(events[0].reason).toBeTruthy();
        if (reason) expect(events[0].reason).toBe(reason);
        expect(Math.abs(new Date(events[0].created_at).getTime() - started)).toBeLessThan(60_000);
      }
    });
  });

  describe('a change that lowers nothing that is held', () => {
    it.each([
      ['damage', { damaged: 2, note: 'Chipped' }],
      ['maintenance', { underMaintenance: 2, note: 'Service' }],
      ['a lower total', { total: 8 }],
    ])('SCRUM310_AC7_%s_that_leaves_room_for_every_reservation_saves_directly', async (_label, change) => {
      const s = await scene();

      const answer = await apply(s.type, change, []);

      expect(answer).toMatchObject({ saved: true, flagged_count: 0, affected: [] });
      expect(await flaggedRows(s.type)).toEqual([]);
      expect(await requestStatus(s.second.event)).toBe('arranged');
    });
  });
});
