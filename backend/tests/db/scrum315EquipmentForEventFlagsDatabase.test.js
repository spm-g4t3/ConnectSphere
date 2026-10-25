/**
 * SCRUM-310 (SCRUM-315): the event record's equipment read shows flagged lines,
 * against the final schema in a real Postgres (PGlite).
 *
 * equipment_for_event is what the coordinator's equipment section reads. Each
 * line now lists the reservations on it that are flagged and not released.
 *
 *   AC5  the lines with a flagged reservation can be told apart, with the reason
 *   AC6  a Confirmed event keeps its status; its lines still show the flags
 *
 * Reservations are inserted directly so the test chooses what is flagged.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedUser } from './helpers/schemaDb.js';
import { readFileSync } from 'node:fs';
import { queriesFor, expectSqlError } from './helpers/queries.js';
import { reservationSteps, asJson, applyEquipmentChange } from './helpers/equipment.js';

const DAY = 86_400_000;
const BASE = Math.floor((Date.now() + 10 * DAY) / DAY) * DAY;
const hour = (h) => new Date(BASE + h * 3_600_000).toISOString();

describe('SCRUM-310 (SCRUM-315): equipment_for_event lists flagged reservations per line', () => {
  let db;
  let organiser;
  let coordinator;
  let reviewer;
  let seq = 0;

  const { one } = queriesFor(() => db);
  const steps = reservationSteps(
    () => ({ db, organiser, coordinator, reviewerA: reviewer }),
    { start: hour(1), end: hour(2), newStart: hour(3), newEnd: hour(4) },
  );
  const { newType, newEvent, add } = steps;
  const newTypeNamed = (total = 10) => newType(`Speaker ${++seq} ${Math.random()}`, total);

  /** The equipment read, as the API gets it. */
  const read = async (event) =>
    asJson(await one('select equipment_for_event($1)::text as answer', [event]));
  const lineOf = (state, id) => state.request.lines.find((line) => line.id === id);

  async function reserve(event, line, type, quantity, from, to, { flagged = false, reason = null, code = null } = {}) {
    const { id } = await one(
      `insert into equipment_reservations
         (equipment_type_id, event_request_id, equipment_line_id, quantity, start_at, end_at,
          flagged, flag_reason, flag_code, flagged_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, case when $7 then now() end) returning id`,
      [type, event, line, quantity, hour(from), hour(to), flagged, reason, code],
    );
    return id;
  }

  /** An approved event with one line of the given quantity. */
  async function eventWithLine(type, quantity = 4) {
    const event = await newEvent();
    const line = (await add(event, type, quantity)).request.lines[0].id;
    return { event, line };
  }

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await seedUser(db, { email: 'organiser@example.com', role: 'event_organiser' });
    coordinator = await seedUser(db, { email: 'coordinator@example.com', role: 'event_coordinator' });
    reviewer = await seedUser(db, { email: 'tech@example.com', role: 'technical_support_staff' });
  }, 60000);

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM310_AC5_an_event_with_no_equipment_request_still_answers_null', async () => {
    const event = await newEvent();
    expect(await read(event)).toEqual({ request: null });
  });

  it('SCRUM310_AC5_a_line_with_no_reservations_has_an_empty_flagged_list', async () => {
    const { event, line } = await eventWithLine(await newTypeNamed());
    expect(lineOf(await read(event), line).flagged_reservations).toEqual([]);
  });

  it('SCRUM310_AC5_a_reservation_that_is_not_flagged_is_not_listed', async () => {
    const type = await newTypeNamed();
    const { event, line } = await eventWithLine(type);
    await reserve(event, line, type, 2, 1, 2);
    expect(lineOf(await read(event), line).flagged_reservations).toEqual([]);
  });

  it('SCRUM310_AC5_a_flagged_reservation_is_listed_with_its_quantity_period_and_reason', async () => {
    const type = await newTypeNamed();
    const { event, line } = await eventWithLine(type);
    const id = await reserve(event, line, type, 3, 1, 2, {
      flagged: true, reason: 'Fewer units of this equipment are usable', code: 'equipment_lost',
    });

    const [flag] = lineOf(await read(event), line).flagged_reservations;

    expect(flag.id).toBe(id);
    expect(flag.quantity).toBe(3);
    expect(new Date(flag.start_at).toISOString()).toBe(hour(1));
    expect(new Date(flag.end_at).toISOString()).toBe(hour(2));
    expect(flag.flag_reason).toBe('Fewer units of this equipment are usable');
    expect(flag.flag_code).toBe('equipment_lost');
    expect(flag.flagged_at).not.toBeNull();
  });

  it('SCRUM310_AC5_a_flag_with_no_reason_is_listed_with_a_null_reason', async () => {
    const type = await newTypeNamed();
    const { event, line } = await eventWithLine(type);
    await reserve(event, line, type, 1, 1, 2, { flagged: true });

    const [flag] = lineOf(await read(event), line).flagged_reservations;

    expect(flag.flag_reason).toBeNull();
    expect(flag.flag_code).toBeNull();
  });

  it('SCRUM310_AC5_a_released_reservation_is_not_listed_even_if_it_was_flagged', async () => {
    const type = await newTypeNamed();
    const { event, line } = await eventWithLine(type);
    const id = await reserve(event, line, type, 2, 1, 2, { flagged: true, reason: 'x' });
    await db.query('update equipment_reservations set released_at = now() where id = $1', [id]);

    expect(lineOf(await read(event), line).flagged_reservations).toEqual([]);
  });

  it('SCRUM310_AC6_the_list_empties_when_the_flag_is_cleared', async () => {
    const type = await newTypeNamed();
    const { event, line } = await eventWithLine(type);
    const id = await reserve(event, line, type, 2, 1, 2, { flagged: true, reason: 'x' });
    expect(lineOf(await read(event), line).flagged_reservations).toHaveLength(1);

    await db.query(
      'update equipment_reservations set flagged = false, flag_reason = null, flagged_at = null where id = $1',
      [id],
    );

    expect(lineOf(await read(event), line).flagged_reservations).toEqual([]);
  });

  it('SCRUM310_AC5_several_flags_on_one_line_are_listed_by_start_time', async () => {
    const type = await newTypeNamed();
    const { event, line } = await eventWithLine(type, 6);
    const later = await reserve(event, line, type, 1, 5, 6, { flagged: true, reason: 'later' });
    const earlier = await reserve(event, line, type, 2, 1, 2, { flagged: true, reason: 'earlier' });
    await reserve(event, line, type, 3, 3, 4); // held, not flagged

    const flags = lineOf(await read(event), line).flagged_reservations;

    expect(flags.map((f) => f.id)).toEqual([earlier, later]);
  });

  it('SCRUM310_AC5_only_the_line_with_the_flag_shows_it', async () => {
    const typeA = await newTypeNamed();
    const typeB = await newTypeNamed();
    const event = await newEvent();
    const lineA = (await add(event, typeA, 2)).request.lines[0].id;
    const lines = (await add(event, typeB, 2)).request.lines;
    const lineB = lines.find((l) => l.id !== lineA).id;
    await reserve(event, lineA, typeA, 2, 1, 2, { flagged: true, reason: 'x' });
    await reserve(event, lineB, typeB, 2, 1, 2);

    const state = await read(event);

    expect(lineOf(state, lineA).flagged_reservations).toHaveLength(1);
    expect(lineOf(state, lineB).flagged_reservations).toEqual([]);
  });

  it('SCRUM310_AC5_flags_on_another_event_do_not_leak_into_this_one', async () => {
    const type = await newTypeNamed();
    const mine = await eventWithLine(type);
    const other = await eventWithLine(type);
    await reserve(other.event, other.line, type, 2, 1, 2, { flagged: true, reason: 'x' });

    expect(lineOf(await read(mine.event), mine.line).flagged_reservations).toEqual([]);
  });

  it('SCRUM310_AC5_a_newer_cancelled_request_does_not_hide_the_live_one_and_its_flags', async () => {
    const type = await newTypeNamed();
    const { event, line } = await eventWithLine(type);
    await reserve(event, line, type, 2, 1, 2, { flagged: true, reason: 'x' });
    const live = (await one('select id from equipment_requests where event_request_id = $1', [event])).id;
    await db.query(
      `insert into equipment_requests (event_request_id, status, created_at)
       values ($1, 'cancelled', now() + interval '1 day')`,
      [event],
    );

    const state = await read(event);

    expect(state.request.id).toBe(live);
    expect(lineOf(state, line).flagged_reservations).toHaveLength(1);
  });

  it('SCRUM310_AC5_the_rest_of_the_answer_is_unchanged', async () => {
    const type = await newTypeNamed();
    const { event, line } = await eventWithLine(type, 4);
    await reserve(event, line, type, 4, 1, 2);

    const state = await read(event);
    const found = lineOf(state, line);

    expect(Object.keys(found).sort()).toEqual(
      ['created_at', 'equipment_type_id', 'flagged_reservations', 'id', 'name', 'outcome',
        'outcome_note', 'quantity', 'reserved', 'technical_notes', 'type_retired', 'updated_at'],
    );
    expect(found.quantity).toBe(4);
    expect(found.reserved).toBe(4);
    expect(Object.keys(state.request).sort()).toEqual(['created_at', 'id', 'lines', 'status', 'updated_at']);
  });

  it('SCRUM310_AC5_a_real_equipment_loss_shows_on_the_line_and_the_event_stays_as_it_was', async () => {
    const type = await newTypeNamed(4);
    const { event, line } = await eventWithLine(type, 4);
    await reserve(event, line, type, 4, 1, 2);
    await db.query('update equipment_types set damaged_quantity = 0 where id = $1', [type]);

    const saved = await applyEquipmentChange(db, type, reviewer, { damaged: 3, note: 'Dropped' });
    expect(saved.saved).toBe(true);

    const [flag] = lineOf(await read(event), line).flagged_reservations;
    expect(flag.flag_reason).toContain('Fewer units of this equipment are usable');
    expect(flag.flag_code).toBe('equipment_lost');
    expect(flag.quantity).toBe(4);
    expect((await one('select status from event_requests where id = $1', [event])).status).toBe('approved');
  });

  it('SCRUM310_AC6_a_confirmed_event_keeps_its_status_and_shows_the_flag', async () => {
    const type = await newTypeNamed();
    const { event, line } = await eventWithLine(type);
    await reserve(event, line, type, 2, 1, 2, { flagged: true, reason: 'Fewer units of this equipment are usable' });
    await db.query('alter table event_requests disable trigger user');
    await db.query("update event_requests set status = 'confirmed' where id = $1", [event]);
    await db.query('alter table event_requests enable trigger user');

    const state = await read(event);

    expect(lineOf(state, line).flagged_reservations).toHaveLength(1);
    expect((await one('select status from event_requests where id = $1', [event])).status).toBe('confirmed');
  });

  describe('the flag code (023)', () => {
    const codeOf = async (id) => (await one('select flag_code from equipment_reservations where id = $1', [id])).flag_code;
    const flagVia = (sql, ids, ...rest) => db.query(sql, [ids, ...rest]);

    it('SCRUM310_AC5_a_loss_flagged_through_the_confirmed_save_gets_the_equipment_lost_code', async () => {
      const type = await newTypeNamed(4);
      const { event, line } = await eventWithLine(type, 4);
      const id = await reserve(event, line, type, 4, 1, 2);

      await applyEquipmentChange(db, type, reviewer, { damaged: 3, note: 'Dropped' });

      expect(await codeOf(id)).toBe('equipment_lost');
    });

    it('SCRUM310_AC5_a_retirement_flags_with_the_equipment_lost_code_too', async () => {
      const type = await newTypeNamed(4);
      const { event, line } = await eventWithLine(type, 2);
      const id = await reserve(event, line, type, 2, 1, 2);

      await applyEquipmentChange(db, type, reviewer, { retire: true });

      expect(await codeOf(id)).toBe('equipment_lost');
    });

    it('SCRUM310_AC5_the_older_flag_function_used_by_the_date_change_flow_sets_no_code', async () => {
      const type = await newTypeNamed();
      const { event, line } = await eventWithLine(type);
      const id = await reserve(event, line, type, 2, 1, 2);

      await flagVia('select flag_equipment_reservations($1::uuid[], $2)', [id], 'The event date or time changed');

      expect(await codeOf(id)).toBeNull();
      const [flag] = lineOf(await read(event), line).flagged_reservations;
      expect(flag.flag_code).toBeNull();
      expect(flag.flag_reason).toBe('The event date or time changed');
    });

    it('SCRUM310_AC5_a_code_can_be_asked_for_by_name', async () => {
      const type = await newTypeNamed();
      const { event, line } = await eventWithLine(type);
      const id = await reserve(event, line, type, 2, 1, 2);

      await flagVia('select flag_equipment_reservations_by($1::uuid[], $2, $3, $4)', [id], 'Lost', reviewer, 'equipment_lost');

      expect(await codeOf(id)).toBe('equipment_lost');
    });

    it('SCRUM310_AC5_asking_for_no_code_gives_none', async () => {
      const type = await newTypeNamed();
      const { event, line } = await eventWithLine(type);
      const id = await reserve(event, line, type, 2, 1, 2);

      await flagVia('select flag_equipment_reservations_by($1::uuid[], $2, $3, null)', [id], 'Other', reviewer);

      expect(await codeOf(id)).toBeNull();
    });

    it('SCRUM310_AC5_a_code_that_is_not_known_is_refused_and_nothing_is_flagged', async () => {
      const type = await newTypeNamed();
      const { event, line } = await eventWithLine(type);
      const id = await reserve(event, line, type, 2, 1, 2);

      await expectSqlError(
        flagVia('select flag_equipment_reservations_by($1::uuid[], $2, $3, $4)', [id], 'x', reviewer, 'made_up'),
        '23514',
        'equipment_reservations_flag_code_known',
      );

      const row = await one('select flagged, flag_code from equipment_reservations where id = $1', [id]);
      expect(row).toEqual({ flagged: false, flag_code: null });
    });

    it('SCRUM310_AC6_clearing_the_flag_clears_the_code', async () => {
      const type = await newTypeNamed();
      const { event, line } = await eventWithLine(type);
      const id = await reserve(event, line, type, 2, 1, 2, { flagged: true, reason: 'x', code: 'equipment_lost' });

      await db.query('update equipment_reservations set flagged = false, flag_reason = null, flagged_at = null where id = $1', [id]);

      expect(await codeOf(id)).toBeNull();
    });

    it('SCRUM310_AC6_a_code_cannot_be_kept_on_a_reservation_that_is_not_flagged', async () => {
      const type = await newTypeNamed();
      const { event, line } = await eventWithLine(type);

      const id = await reserve(event, line, type, 2, 1, 2, { flagged: false, code: 'equipment_lost' });

      expect(await codeOf(id)).toBeNull();
    });

    it('SCRUM310_AC6_a_flag_that_stays_set_keeps_its_code_through_other_updates', async () => {
      const type = await newTypeNamed();
      const { event, line } = await eventWithLine(type);
      const id = await reserve(event, line, type, 2, 1, 2, { flagged: true, reason: 'x', code: 'equipment_lost' });

      await db.query('update equipment_reservations set quantity = 1 where id = $1', [id]);

      expect(await codeOf(id)).toBe('equipment_lost');
    });

    it('SCRUM310_AC5_running_the_migration_again_codes_flags_set_before_it_by_their_reason_and_changes_nothing_else', async () => {
      const type = await newTypeNamed();
      const { event, line } = await eventWithLine(type, 6);
      const fewer = await reserve(event, line, type, 1, 1, 2, { flagged: true, reason: 'Fewer units of this equipment are usable (Dropped)' });
      const retired = await reserve(event, line, type, 1, 3, 4, { flagged: true, reason: 'The equipment type was retired' });
      const moved = await reserve(event, line, type, 1, 5, 6, { flagged: true, reason: 'The event date or time changed' });
      const plain = await reserve(event, line, type, 1, 7, 8, { flagged: true });
      const held = await reserve(event, line, type, 1, 9, 10);

      await db.exec(readFileSync(new URL('../../db/migrations/023_equipment_for_event_flags.sql', import.meta.url), 'utf8'));

      expect(await Promise.all([fewer, retired, moved, plain, held].map(codeOf))).toEqual([
        'equipment_lost', 'equipment_lost', null, null, null,
      ]);
    });

    it('SCRUM310_AC5_a_flag_that_already_has_a_code_is_not_recoded_by_a_rerun', async () => {
      const type = await newTypeNamed();
      const { event, line } = await eventWithLine(type);
      const id = await reserve(event, line, type, 2, 1, 2, { flagged: true, reason: 'The event date or time changed' });

      await db.exec(readFileSync(new URL('../../db/migrations/023_equipment_for_event_flags.sql', import.meta.url), 'utf8'));

      expect(await codeOf(id)).toBeNull();
    });

    it('SCRUM310_AC5_the_old_three_argument_flag_function_is_gone_and_there_is_one_flag_by_function', async () => {
      const { n } = await one(
        "select count(*)::int as n from pg_proc where proname = 'flag_equipment_reservations_by'",
      );

      expect(n).toBe(1);
    });
  });
});
