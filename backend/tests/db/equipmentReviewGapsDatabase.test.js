/**
 * SCRUM-300: the gaps found reviewing 053 and 054, closed by 061, run against a
 * real Postgres (PGlite).
 *
 *   1. A review could be completed while a reservation was still flagged (AC7).
 *   2. A fully reserved request could stick in Under review, because starting
 *      a review never ran the Arranged check.
 *   3. Keep was offered, and always refused, for a reservation flagged by a
 *      date change. The review read now says per reservation whether it can work.
 *
 * The lock-order deadlock between an inventory change and a reservation needs
 * two connections, and PGlite has one, so it is covered by the service tests
 * that map 40P01 to a 409.
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
  '060_equipment_reservation_topup.sql',
  '061_equipment_review_gaps.sql',
];

const START = '2026-12-01T10:00:00Z';
const END = '2026-12-01T12:00:00Z';
const NEW_START = '2026-12-05T14:00:00Z';
const NEW_END = '2026-12-05T16:00:00Z';

const refusal = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
};

describe('SCRUM-300: closing the review gaps in Postgres', () => {
  let db;
  let organiser;
  let coordinator;
  let reviewerA;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const rows = async (sql, params) => (await db.query(sql, params)).rows;
  const asJson = (row) => JSON.parse(row.answer);

  const newUser = async (email) =>
    (await one('insert into auth.users (email) values ($1) returning id', [email])).id;
  const newType = async (name, total) =>
    (await one('insert into equipment_types (name, total_quantity) values ($1, $2) returning id', [`${name} ${Math.random()}`, total])).id;
  const newEvent = async () =>
    (await one(
      `insert into event_requests
         (organiser_id, event_name, status, assigned_coordinator_id, proposed_start, proposed_end)
       values ($1, $2, 'approved', $3, $4, $5) returning id`,
      [organiser, `Event ${Math.random()}`, coordinator, START, END],
    )).id;

  const add = async (event, type, quantity) =>
    asJson(await one('select add_equipment_line($1, $2, $3, $4, null)::text as answer', [event, coordinator, type, quantity]));
  const removeLine = async (event, line) =>
    asJson(await one('select remove_equipment_line($1, $2, $3)::text as answer', [event, coordinator, line]));
  const start = async (event) =>
    asJson(await one('select start_equipment_review($1, $2)::text as answer', [event, reviewerA]));
  const reserve = async (event, line, quantity) =>
    asJson(await one('select reserve_equipment($1, $2, $3, $4)::text as answer', [event, reviewerA, line, quantity]));
  const move = async (event, id) =>
    asJson(await one('select move_equipment_reservation($1, $2, $3, null)::text as answer', [event, reviewerA, id]));
  const keep = async (event, id) =>
    asJson(await one('select keep_equipment_reservation($1, $2, $3, null)::text as answer', [event, reviewerA, id]));
  const markUnavailable = async (event, line, note) =>
    asJson(await one('select mark_equipment_line_unavailable($1, $2, $3, $4)::text as answer', [event, reviewerA, line, note]));
  const complete = async (event) =>
    asJson(await one('select complete_equipment_review($1, $2)::text as answer', [event, reviewerA]));
  const review = async (event) =>
    asJson(await one('select equipment_review_for_event($1)::text as answer', [event]));

  const changePeriod = (event) =>
    db.query('update event_requests set proposed_start = $2, proposed_end = $3 where id = $1', [event, NEW_START, NEW_END]);
  const lineNamed = (state, name) => state.request.lines.find((l) => l.name === name);
  const status = async (event) =>
    (await one("select status::text as s from equipment_requests where event_request_id = $1 and status <> 'cancelled'", [event])).s;
  const history = async (event) =>
    (await rows(
      `select h.action from equipment_review_history h
         join equipment_requests r on r.id = h.equipment_request_id
        where r.event_request_id = $1 order by h.id`,
      [event],
    )).map((row) => row.action);
  const liveReservations = (event) =>
    rows(
      'select id, flagged from equipment_reservations where event_request_id = $1 and released_at is null order by created_at, id',
      [event],
    );

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
  }, 60000);

  it('SCRUM300_runs_a_second_time_without_error', async () => {
    await expect(db.exec(migration('061_equipment_review_gaps.sql'))).resolves.not.toThrow();
  });

  describe('AC7: a review cannot be completed over a flagged reservation', () => {
    /** Line A fully reserved, line B short by four, both flagged by a date change, review restarted. */
    const flaggedReview = async () => {
      const typeA = await newType('Projector', 10);
      const typeB = await newType('Microphone', 1);
      const event = await newEvent();
      const state = await add(event, typeA, 2);
      const withB = await add(event, typeB, 5);
      const lineA = state.request.lines[0].id;
      const lineB = withB.request.lines.find((l) => l.id !== lineA).id;
      await start(event);
      await reserve(event, lineA, 2);
      await reserve(event, lineB, 1);
      await changePeriod(event);
      expect(await status(event)).toBe('pending_review');
      await start(event);
      await markUnavailable(event, lineB, 'Only one microphone exists');
      return { event, lineA, lineB };
    };

    it('SCRUM300_AC7_complete_review_refuses_while_a_reservation_is_flagged', async () => {
      const { event } = await flaggedReview();

      const err = await refusal(complete(event));

      expect(err?.code).toBe('55000');
      expect(err.message).toMatch(/Decide on each flagged reservation/);
      expect(err.message).toMatch(/Still to decide: 2/);
      expect(await status(event)).toBe('under_review');
      expect((await liveReservations(event)).every((r) => r.flagged)).toBe(true);
    });

    it('SCRUM300_AC7_complete_review_works_once_every_flagged_reservation_is_decided', async () => {
      const { event } = await flaggedReview();
      for (const { id } of await liveReservations(event)) await move(event, id);

      const state = await complete(event);

      expect(state.request.status).toBe('cannot_be_fully_arranged');
      expect((await liveReservations(event)).some((r) => r.flagged)).toBe(false);
    });

    it('SCRUM300_AC7_one_flagged_reservation_is_named_in_the_singular', async () => {
      const { event } = await flaggedReview();
      const [first] = await liveReservations(event);
      await move(event, first.id);

      const err = await refusal(complete(event));

      expect(err?.code).toBe('55000');
      expect(err.message).toMatch(/Still to decide: 1/);
    });
  });

  describe('a fully reserved request does not stay Under review', () => {
    it('SCRUM300_AC6_starting_a_review_arranges_a_request_whose_last_short_line_was_removed', async () => {
      const typeA = await newType('Projector', 10);
      const typeB = await newType('Microphone', 1);
      const event = await newEvent();
      const state = await add(event, typeA, 2);
      const withB = await add(event, typeB, 3);
      const lineA = state.request.lines[0].id;
      const lineB = withB.request.lines.find((l) => l.id !== lineA).id;
      await start(event);
      await reserve(event, lineA, 2);
      await reserve(event, lineB, 1);

      const afterRemoval = await removeLine(event, lineB);
      expect(afterRemoval.request.status).toBe('pending_review');

      const started = await start(event);

      expect(started.request.status).toBe('arranged');
      expect(await status(event)).toBe('arranged');
      expect(await history(event)).toEqual(['started', 'interrupted', 'started', 'arranged']);
    });

    it('SCRUM300_AC6_a_request_with_a_short_line_stays_under_review_when_the_review_starts', async () => {
      const type = await newType('Projector', 10);
      const event = await newEvent();
      await add(event, type, 4);

      const started = await start(event);

      expect(started.request.status).toBe('under_review');
      expect(await history(event)).toEqual(['started']);
    });

    it('SCRUM300_AC6_a_flagged_reservation_keeps_a_fully_reserved_request_under_review', async () => {
      const type = await newType('Projector', 10);
      const event = await newEvent();
      const state = await add(event, type, 2);
      await start(event);
      await reserve(event, state.request.lines[0].id, 2);
      expect(await status(event)).toBe('arranged');
      await changePeriod(event);
      expect(await status(event)).toBe('pending_review');

      const started = await start(event);

      expect(started.request.status).toBe('under_review');
      expect((await liveReservations(event))[0].flagged).toBe(true);
    });
  });

  describe('AC7: Keep is offered only where it can work', () => {
    const reservedAndFlagged = async (flagIt) => {
      const type = await newType('Projector', 10);
      const event = await newEvent();
      const state = await add(event, type, 2);
      const line = state.request.lines[0].id;
      await start(event);
      await reserve(event, line, 2);
      await flagIt({ event, type, line });
      return { event, type, line };
    };
    const restart = async (event) => {
      if ((await status(event)) !== 'under_review') await start(event);
      return review(event);
    };
    const reservationOf = (state) => lineNamed(state, state.request.lines[0].name).reservations[0];

    it('SCRUM300_AC7_a_reservation_that_is_not_flagged_cannot_be_kept', async () => {
      const type = await newType('Projector', 10);
      const event = await newEvent();
      const state = await add(event, type, 4);
      await start(event);
      await reserve(event, state.request.lines[0].id, 2);

      const reservation = (await review(event)).request.lines[0].reservations[0];

      expect(reservation.flagged).toBe(false);
      expect(reservation.can_keep).toBe(false);
    });

    it('SCRUM300_AC7_a_date_change_flag_cannot_be_kept_and_the_read_says_so', async () => {
      const { event } = await reservedAndFlagged(({ event: e }) => changePeriod(e));
      const state = await restart(event);
      const reservation = reservationOf(state);

      expect(reservation.flagged).toBe(true);
      expect(reservation.can_keep).toBe(false);
      const err = await refusal(keep(event, reservation.id));
      expect(err?.code).toBe('55000');
      expect(err.message).toMatch(/period no longer matches/);
    });

    it('SCRUM300_AC7_a_line_amended_up_flags_a_reservation_that_can_be_kept', async () => {
      const { event } = await reservedAndFlagged(({ line: l }) =>
        db.query('update equipment_lines set quantity = 3 where id = $1', [l]));
      const state = await restart(event);
      const reservation = reservationOf(state);

      expect(reservation.flagged).toBe(true);
      expect(reservation.can_keep).toBe(true);
      const kept = await keep(event, reservation.id);
      expect(lineNamed(kept, kept.request.lines[0].name).reservations[0].flagged).toBe(false);
    });

    it('SCRUM300_AC7_a_retired_type_flags_a_reservation_that_cannot_be_kept', async () => {
      const { event } = await reservedAndFlagged(({ type }) =>
        db.query('update equipment_types set retired_at = now() where id = $1', [type]));
      const state = await restart(event);

      expect(reservationOf(state).flagged).toBe(true);
      expect(reservationOf(state).can_keep).toBe(false);
    });
  });
});
