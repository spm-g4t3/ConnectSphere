/**
 * SCRUM-300: reserving more of an item adds to its existing reservation (migration 057),
 * run against a real Postgres (PGlite).
 *
 * Applies 022, 024, 037, 038, 053, 054, 055 and 057, then calls reserve_equipment the way
 * the service will.
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

describe('SCRUM-300: reserving more adds to the existing reservation', () => {
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


  const liveRows = (event) =>
    rows(
      `select id, quantity, start_at, end_at, flagged from equipment_reservations
        where event_request_id = $1 and released_at is null order by created_at, id`,
      [event],
    );
  const allRows = (event) =>
    rows('select id from equipment_reservations where event_request_id = $1', [event]);

  it('SCRUM300_AC2_runs_a_second_time_without_error', async () => {
    await expect(db.exec(migration('060_equipment_reservation_topup.sql'))).resolves.not.toThrow();
  });

  it('SCRUM300_AC2_reserving_2_and_then_2_more_leaves_one_reservation_of_4', async () => {
    const { event, line } = await reviewed('Projector', 10, 4);
    await reserve(event, reviewerA, line, 2);
    await reserve(event, reviewerA, line, 2);

    const live = await liveRows(event);
    expect(live).toHaveLength(1);
    expect(live[0].quantity).toBe(4);
    expect(await allRows(event)).toHaveLength(1);
  });

  it('SCRUM300_AC2_the_returned_review_shows_one_reservation_for_the_item', async () => {
    const { event, line } = await reviewed('Projector', 10, 4);
    await reserve(event, reviewerA, line, 1);
    const state = await reserve(event, reviewerA, line, 2);

    const item = state.request.lines.find((l) => l.id === line);
    expect(item.reservations).toHaveLength(1);
    expect(item.reservations[0].quantity).toBe(3);
  });

  it('SCRUM300_AC2_the_first_reservation_is_recorded_as_reserved_and_the_top_up_as_increased', async () => {
    const { event, line } = await reviewed('Projector', 10, 4);
    await reserve(event, reviewerA, line, 2);
    await reserve(event, reviewerA, line, 2);

    const history = await events(event);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ action: 'reserved', quantity_after: 2, reason: 'Reserved for the event' });
    expect(history[1]).toMatchObject({
      action: 'increased',
      user_id: reviewerA,
      reason: 'Reserved more for the event',
      quantity_before: 2,
      quantity_after: 4,
    });
    expect(new Date(history[1].start_after).toISOString()).toBe(new Date(START).toISOString());
    expect(new Date(history[1].end_after).toISOString()).toBe(new Date(END).toISOString());
  });

  it('SCRUM300_AC2_both_calls_are_recorded_against_the_same_reservation', async () => {
    const { event, line } = await reviewed('Projector', 10, 4);
    await reserve(event, reviewerA, line, 2);
    await reserve(event, reviewerA, line, 2);
    const ids = await rows(
      'select distinct equipment_reservation_id as id from equipment_reservation_events where event_request_id = $1',
      [event],
    );
    expect(ids).toHaveLength(1);
  });

  it('SCRUM300_AC2_topping_up_to_the_full_quantity_arranges_the_request', async () => {
    const { event, line } = await reviewed('Projector', 10, 4);
    await reserve(event, reviewerA, line, 2);
    expect(await requestStatus(event)).not.toBe('arranged');
    await reserve(event, reviewerA, line, 2);
    expect(await requestStatus(event)).toBe('arranged');
  });

  it('SCRUM300_AC2_a_top_up_above_what_the_item_still_needs_is_refused_and_changes_nothing', async () => {
    const { event, line } = await reviewed('Projector', 10, 4);
    await reserve(event, reviewerA, line, 3);

    const err = await refusal(reserve(event, reviewerA, line, 2));
    expect(err?.code).toBe('22023');
    const live = await liveRows(event);
    expect(live).toHaveLength(1);
    expect(live[0].quantity).toBe(3);
    expect(await events(event)).toHaveLength(1);
  });

  it('SCRUM300_AC2_a_top_up_still_needs_the_units_to_be_available', async () => {
    const type = await newType('Mic', 3);
    const first = await newEvent();
    const second = await newEvent();
    const a = (await add(first, type, 3)).request.lines[0].id;
    const b = (await add(second, type, 2)).request.lines[0].id;
    await start(first, reviewerA);
    await start(second, reviewerB);
    await reserve(first, reviewerA, a, 1);
    await reserve(second, reviewerB, b, 1);

    // 3 in stock: 1 held by the first event, 1 by the second, so 1 is left.
    await reserve(first, reviewerA, a, 1);
    const err = await refusal(reserve(first, reviewerA, a, 1));
    expect(err?.code).toBe('22023');
    expect((await liveRows(first))[0].quantity).toBe(2);
  });

  it('SCRUM300_AC2_another_event_reserving_the_same_type_gets_its_own_reservation', async () => {
    const type = await newType('Cable', 10);
    const first = await newEvent();
    const second = await newEvent();
    const a = (await add(first, type, 2)).request.lines[0].id;
    const b = (await add(second, type, 2)).request.lines[0].id;
    await start(first, reviewerA);
    await start(second, reviewerB);
    await reserve(first, reviewerA, a, 1);
    await reserve(second, reviewerB, b, 1);
    await reserve(second, reviewerB, b, 1);

    expect(await liveRows(first)).toHaveLength(1);
    expect((await liveRows(first))[0].quantity).toBe(1);
    expect((await liveRows(second))[0].quantity).toBe(2);
  });

  it('SCRUM300_AC2_two_different_items_each_keep_their_own_reservation', async () => {
    const typeA = await newType(`Projector ${Math.random()}`, 10);
    const typeB = await newType(`Cable ${Math.random()}`, 10);
    const event = await newEvent();
    await add(event, typeA, 3);
    const state = await add(event, typeB, 3);
    await start(event, reviewerA);
    const lines = state.request.lines.map((l) => l.id);
    await reserve(event, reviewerA, lines[0], 1);
    await reserve(event, reviewerA, lines[1], 1);
    await reserve(event, reviewerA, lines[0], 1);

    const live = await liveRows(event);
    expect(live).toHaveLength(2);
    expect(live.map((r) => r.quantity).sort()).toEqual([1, 2]);
  });

  it('SCRUM300_AC2_a_released_reservation_is_not_topped_up', async () => {
    const { event, line } = await reviewed('Projector', 10, 4);
    const state = await reserve(event, reviewerA, line, 2);
    await release(event, reviewerA, state.request.lines[0].reservations[0].id);
    await reserve(event, reviewerA, line, 2);

    const live = await liveRows(event);
    expect(live).toHaveLength(1);
    expect(live[0].quantity).toBe(2);
    expect(await allRows(event)).toHaveLength(2);
    expect((await events(event)).map((e) => e.action)).toEqual(['reserved', 'released', 'reserved']);
  });

  it('SCRUM300_AC2_a_flagged_reservation_is_not_topped_up', async () => {
    const { event, line } = await reviewed('Projector', 10, 4);
    await reserve(event, reviewerA, line, 2);
    // Raising the line's quantity flags the reservation until the reviewer decides.
    await db.query('update equipment_lines set quantity = 6 where id = $1', [line]);
    expect((await liveRows(event))[0].flagged).toBe(true);
    await start(event, reviewerA);

    await reserve(event, reviewerA, line, 2);

    const live = await liveRows(event);
    expect(live).toHaveLength(2);
    expect(live[0]).toMatchObject({ quantity: 2, flagged: true });
    expect(live[1]).toMatchObject({ quantity: 2, flagged: false });
    expect((await events(event)).map((e) => e.action)).toEqual(['reserved', 'flagged', 'reserved']);
  });

  it('SCRUM300_AC2_a_live_reservation_on_a_different_period_is_not_topped_up', async () => {
    const { event, line } = await reviewed('Projector', 10, 4);
    await reserve(event, reviewerA, line, 2);
    // Defensive: no flow leaves an unflagged reservation on another period, but if one
    // ever existed, adding this event's units to it would hold them for the wrong time.
    await db.query(
      "update equipment_reservations set start_at = '2026-11-01T10:00:00Z', end_at = '2026-11-01T12:00:00Z' where event_request_id = $1",
      [event],
    );
    await reserve(event, reviewerA, line, 2);

    const live = await liveRows(event);
    expect(live).toHaveLength(2);
    expect(live.map((r) => r.quantity)).toEqual([2, 2]);
  });

  it('SCRUM300_AC2_a_moved_reservation_is_topped_up_on_the_new_period', async () => {
    const { event, line } = await reviewed('Projector', 10, 4);
    const state = await reserve(event, reviewerA, line, 2);
    await changePeriod(event);
    await start(event, reviewerA);
    await move(event, reviewerA, state.request.lines[0].reservations[0].id);

    await reserve(event, reviewerA, line, 2);

    const live = await liveRows(event);
    expect(live).toHaveLength(1);
    expect(live[0].quantity).toBe(4);
    expect(new Date(live[0].start_at).toISOString()).toBe(new Date(NEW_START).toISOString());
  });

  it('SCRUM300_AC2_the_history_accepts_the_increased_action_and_still_refuses_unknown_ones', async () => {
    const { event, line } = await reviewed('Projector', 10, 4);
    const state = await reserve(event, reviewerA, line, 1);
    const id = state.request.lines[0].reservations[0].id;
    const insert = (action) =>
      db.query(
        'insert into equipment_reservation_events (equipment_reservation_id, event_request_id, action) values ($1, $2, $3)',
        [id, event, action],
      );
    await expect(insert('increased')).resolves.toBeDefined();
    expect((await refusal(insert('invented')))?.code).toBe('23514');
  });
});
