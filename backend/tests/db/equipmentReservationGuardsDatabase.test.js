/**
 * SCRUM-309 for SCRUM-300: the guards added after reviewing AC5 and AC8, run
 * against the final schema in a real Postgres (PGlite).
 *
 * Calls reserve_equipment the way the service does. PGlite has one connection,
 * so the last-unit race (AC3) is tested as two reservations one after the
 * other, which is what the type row's lock makes the real case look like.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedUser } from './helpers/schemaDb.js';
import { queriesFor, refusal } from './helpers/queries.js';
import { reservationSteps } from './helpers/equipment.js';

const START = '2026-12-01T10:00:00Z';
const END = '2026-12-01T12:00:00Z';
const NEW_START = '2026-12-05T10:00:00Z';
const NEW_END = '2026-12-05T12:00:00Z';

describe('SCRUM-300: AC5 and AC8 guards in Postgres', () => {
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


  describe('AC5: a cancelled request releases its reservations', () => {
    it('SCRUM300_AC5_cancelling_the_request_releases_its_reservations_as_the_system', async () => {
      const { event, line } = await reviewed('Projector', 10, 4);
      await reserve(event, reviewerA, line, 2);
      await db.query("update equipment_requests set status = 'cancelled' where event_request_id = $1", [event]);

      const row = await reservation(event);
      expect(row.released_at).not.toBeNull();
      expect(row.release_reason).toBe('request cancelled');
      expect((await events(event)).at(-1)).toMatchObject({ action: 'released', user_id: null, reason: 'request cancelled' });
    });

    it('SCRUM300_AC5_the_units_are_available_to_another_event_afterwards', async () => {
      const type = await newType('Laser', 1);
      const first = await newEvent();
      const second = await newEvent();
      const a = (await add(first, type, 1)).request.lines[0].id;
      const b = (await add(second, type, 1)).request.lines[0].id;
      await start(first, reviewerA);
      await start(second, reviewerB);
      await reserve(first, reviewerA, a, 1);
      expect((await refusal(reserve(second, reviewerB, b, 1)))?.code).toBe('22023');

      await db.query("update equipment_requests set status = 'cancelled' where event_request_id = $1", [first]);
      await reserve(second, reviewerB, b, 1);
      expect(await live(second)).toHaveLength(1);
    });

    it('SCRUM300_AC5_cancelling_twice_records_one_release', async () => {
      const { event, line } = await reviewed('Projector', 10, 4);
      await reserve(event, reviewerA, line, 2);
      await db.query("update equipment_requests set status = 'cancelled' where event_request_id = $1", [event]);
      await db.query("update equipment_requests set status = 'cancelled' where event_request_id = $1", [event]);
      expect((await events(event)).filter((e) => e.action === 'released')).toHaveLength(1);
    });

    it('SCRUM300_AC5_a_reservation_released_by_hand_first_is_not_released_again', async () => {
      const { event, line } = await reviewed('Projector', 10, 4);
      await reserve(event, reviewerA, line, 2);
      const { id } = await reservation(event);
      await release(event, reviewerA, id, 'Wrong item');
      await db.query("update equipment_requests set status = 'cancelled' where event_request_id = $1", [event]);
      const releases = (await events(event)).filter((e) => e.action === 'released');
      expect(releases).toHaveLength(1);
      expect(releases[0].user_id).toBe(reviewerA);
    });

    it('SCRUM300_AC5_cancelling_a_request_with_no_reservations_is_harmless', async () => {
      const { event } = await reviewed('Projector', 10, 4);
      await db.query("update equipment_requests set status = 'cancelled' where event_request_id = $1", [event]);
      expect(await events(event)).toHaveLength(0);
    });

    it('SCRUM300_AC5_another_events_reservations_are_left_alone', async () => {
      const a = await reviewed('Projector', 10, 4);
      const b = await reviewed('Mic', 10, 4);
      await reserve(a.event, reviewerA, a.line, 1);
      await reserve(b.event, reviewerA, b.line, 1);
      await db.query("update equipment_requests set status = 'cancelled' where event_request_id = $1", [a.event]);
      expect((await reservation(b.event)).released_at).toBeNull();
    });

    it('SCRUM300_AC5_cancelling_one_request_does_not_release_the_units_of_another_request_on_the_same_event', async () => {
      const typeA = await newType('Camera', 5);
      const typeB = await newType('Tripod', 5);
      const event = await newEvent();

      const first = (await add(event, typeA, 2)).request;
      await start(event, reviewerA);
      await reserve(event, reviewerA, first.lines[0].id, 1);

      // The database allows a second live request for the event (nothing in 022
      // forbids it), and the newest live one is the one a reviewer works on.
      const second = (await one(
        "insert into equipment_requests (event_request_id, status) values ($1, 'pending_review') returning id",
        [event],
      )).id;
      const secondLine = (await one(
        'insert into equipment_lines (equipment_request_id, equipment_type_id, quantity) values ($1, $2, 3) returning id',
        [second, typeB],
      )).id;
      await start(event, reviewerB);
      await reserve(event, reviewerB, secondLine, 2);

      await db.query("update equipment_requests set status = 'cancelled' where id = $1", [first.id]);

      const left = await rows(
        'select equipment_type_id, quantity, released_at from equipment_reservations where event_request_id = $1 order by quantity',
        [event],
      );
      expect(left).toHaveLength(2);
      expect(left.find((r) => r.equipment_type_id === typeA).released_at).not.toBeNull();
      expect(left.find((r) => r.equipment_type_id === typeB).released_at).toBeNull();
    });
  });

  describe('AC8: never deleted, always with a reason', () => {
    it('SCRUM300_AC8_a_reservation_cannot_be_deleted', async () => {
      const { event, line } = await reviewed('Projector', 10, 4);
      await reserve(event, reviewerA, line, 2);
      const err = await refusal(db.query('delete from equipment_reservations where event_request_id = $1', [event]));
      expect(err?.code).toBe('55000');
      expect(err?.message).toMatch(/Release it instead/);
      expect(await live(event)).toHaveLength(1);
    });

    it('SCRUM300_AC8_a_released_reservation_cannot_be_deleted_either', async () => {
      const { event, line } = await reviewed('Projector', 10, 4);
      await reserve(event, reviewerA, line, 2);
      const { id } = await reservation(event);
      await release(event, reviewerA, id, 'Done');
      const err = await refusal(db.query('delete from equipment_reservations where id = $1', [id]));
      expect(err?.code).toBe('55000');
    });

    it('SCRUM300_AC8_deleting_nothing_is_not_an_error', async () => {
      await expect(db.query("delete from equipment_reservations where id = '00000000-0000-0000-0000-000000000000'")).resolves.not.toThrow();
    });

    it('SCRUM300_AC8_a_new_reservation_records_a_reason', async () => {
      const { event, line } = await reviewed('Projector', 10, 4);
      await reserve(event, reviewerA, line, 2);
      expect((await events(event))[0]).toMatchObject({ action: 'reserved', user_id: reviewerA, reason: 'Reserved for the event' });
    });

    it('SCRUM300_AC8_every_kind_of_history_row_has_a_user_or_system_a_time_and_a_reason', async () => {
      const { event, line } = await reviewed('Projector', 10, 5);
      await reserve(event, reviewerA, line, 3);
      const { id } = await reservation(event);
      await reduce(event, reviewerA, id, 2, 'Less');
      await changePeriod(event);
      await start(event, reviewerA);
      await move(event, reviewerA, id);
      await release(event, reviewerA, id, 'Done');

      const all = await rows(
        'select action, user_id, reason, created_at from equipment_reservation_events where event_request_id = $1 order by id',
        [event],
      );
      expect(all.map((r) => r.action)).toEqual(['reserved', 'reduced', 'flagged', 'moved', 'released']);
      for (const row of all) {
        expect(row.reason).toBeTruthy();
        expect(row.created_at).toBeTruthy();
      }
      expect(all.map((r) => r.user_id)).toEqual([reviewerA, reviewerA, null, reviewerA, reviewerA]);
    });
  });
});
