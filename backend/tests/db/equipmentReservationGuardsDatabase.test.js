/**
 * SCRUM-309 for SCRUM-300: the guards added after reviewing AC5 and AC8, run against a real Postgres (PGlite).
 *
 * Applies 022, 024, 037, 038, 053, 054 and 055, then calls reserve_equipment the way the
 * service will. PGlite has one connection, so the last-unit race (AC3) is tested
 * as two reservations one after the other, which is what the type row's lock
 * makes the real case look like.
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
  '053_equipment_reservations.sql',
  '054_equipment_reservation_actions.sql',
  '055_equipment_reservation_guards.sql',
];

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

describe('SCRUM-300: AC5 and AC8 guards in Postgres', () => {
  let db;
  let organiser;
  let coordinator;
  let reviewerA;
  let reviewerB;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const rows = async (sql, params) => (await db.query(sql, params)).rows;
  const asJson = (row) => JSON.parse(row.answer);

  const newUser = async (email) =>
    (await one('insert into auth.users (email) values ($1) returning id', [email])).id;
  const newType = async (name, total = 10) =>
    (await one('insert into equipment_types (name, total_quantity) values ($1, $2) returning id', [name, total])).id;
  const newEvent = async ({ status = 'approved', start = START, end = END } = {}) =>
    (await one(
      `insert into event_requests
         (organiser_id, event_name, status, assigned_coordinator_id, proposed_start, proposed_end)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [organiser, `Event ${Math.random()}`, status, coordinator, start, end],
    )).id;

  const add = async (event, type, quantity) =>
    asJson(await one('select add_equipment_line($1, $2, $3, $4, null)::text as answer', [event, coordinator, type, quantity]));
  const start = async (event, who) =>
    asJson(await one('select start_equipment_review($1, $2)::text as answer', [event, who]));
  const reserve = async (event, who, line, quantity) =>
    asJson(await one('select reserve_equipment($1, $2, $3, $4)::text as answer', [event, who, line, quantity]));

  const reduce = async (event, who, id, quantity, reason = 'Not needed') =>
    asJson(await one('select reduce_equipment_reservation($1, $2, $3, $4, $5)::text as answer', [event, who, id, quantity, reason]));
  const release = async (event, who, id, reason = 'Returned') =>
    asJson(await one('select release_equipment_reservation($1, $2, $3, $4)::text as answer', [event, who, id, reason]));
  const move = async (event, who, id, reason = null) =>
    asJson(await one('select move_equipment_reservation($1, $2, $3, $4)::text as answer', [event, who, id, reason]));
  const keep = async (event, who, id, reason = null) =>
    asJson(await one('select keep_equipment_reservation($1, $2, $3, $4)::text as answer', [event, who, id, reason]));
  const reservation = (event) =>
    one(
      `select id, quantity, start_at, end_at, flagged, flag_reason, released_at, release_reason
         from equipment_reservations where event_request_id = $1 order by created_at, id limit 1`,
      [event],
    );
  const NEW_START = '2026-12-05T10:00:00Z';
  const NEW_END = '2026-12-05T12:00:00Z';
  const changePeriod = (event, s = NEW_START, e = NEW_END) =>
    db.query('update event_requests set proposed_start = $2, proposed_end = $3 where id = $1', [event, s, e]);
  const lineId = (state, name) => state.request.lines.find((l) => l.name === name).id;
  const live = (event) =>
    rows(
      'select quantity, start_at, end_at from equipment_reservations where event_request_id = $1 and released_at is null',
      [event],
    );
  const events = (event) =>
    rows(
      'select action, user_id, reason, quantity_before, quantity_after, start_after, end_after from equipment_reservation_events where event_request_id = $1 order by id',
      [event],
    );
  const requestStatus = async (event) =>
    (await one("select status::text as s from equipment_requests where event_request_id = $1 and status <> 'cancelled'", [event])).s;

  /** An approved event with one line, already Under review by reviewerA. */
  const reviewed = async (typeName, total, quantity, opts) => {
    const type = await newType(`${typeName} ${Math.random()}`, total);
    const event = await newEvent(opts);
    const state = await add(event, type, quantity);
    await start(event, reviewerA);
    return { event, type, line: state.request.lines[0].id };
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
  }, 60000);

  afterAll(async () => {
    await db?.close();
  });


  it('SCRUM300_runs_a_second_time_without_error', async () => {
    await expect(db.exec(migration('055_equipment_reservation_guards.sql'))).resolves.not.toThrow();
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
