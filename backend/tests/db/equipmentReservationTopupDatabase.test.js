/**
 * SCRUM-300: reserving more of an item adds to its existing reservation, run
 * against the final schema in a real Postgres (PGlite).
 *
 * Calls reserve_equipment the way the service does.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedUser } from './helpers/schemaDb.js';
import { queriesFor, refusal } from './helpers/queries.js';
import { reservationSteps } from './helpers/equipment.js';

const START = '2026-12-01T10:00:00Z';
const END = '2026-12-01T12:00:00Z';
const NEW_START = '2026-12-05T10:00:00Z';
const NEW_END = '2026-12-05T12:00:00Z';

describe('SCRUM-300: reserving more adds to the existing reservation', () => {
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


  const liveRows = (event) =>
    rows(
      `select id, quantity, start_at, end_at, flagged from equipment_reservations
        where event_request_id = $1 and released_at is null order by created_at, id`,
      [event],
    );
  const allRows = (event) =>
    rows('select id from equipment_reservations where event_request_id = $1', [event]);

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
