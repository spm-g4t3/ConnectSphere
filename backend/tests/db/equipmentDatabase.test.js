/**
 * SCRUM-72: the equipment schema and the availability function, run against a
 * real Postgres.
 *
 * Every other test of these tables fakes the Supabase client or reads the
 * migration as text, so none of them can see a constraint fire or a query count
 * rows. This one applies the real migrations to an in-process Postgres (PGlite)
 * and writes bad rows straight at the tables, bypassing every service, the way
 * SCRUM-72 asks. It needs no database server and no credentials, so it runs in CI.
 * It reuses the harness of eventStatusLifecycleDatabase.test.js.
 *
 * Migrations applied, in order: 001 (event_requests and set_updated_at), 022
 * (the equipment tables) and 024 (the availability function). Neither 022 nor
 * 024 reads anything later than 001. auth.users is a stand-in, as in the
 * lifecycle test.
 *
 * Two halves:
 *   - SCRUM66_...  each constraint of 022 refuses a direct bad write. A check
 *     constraint answers 23514, and the message names it. The two uniqueness
 *     rules (one line per type per request, one name per type) answer 23505,
 *     which is the code for a unique violation, not 23514.
 *   - SCRUM23_...  the availability function counts what AC3 to AC12 say it
 *     counts, with the same boundary cases the live check builds.
 *
 * What PGlite is not: Supabase. Row level security and the API's secret key are
 * not exercised. npm run equipment-availability:check runs the function against
 * the shared Supabase.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name) => readFileSync(resolve(here, '../../db/migrations', name), 'utf8');

const MIGRATIONS = ['001_event_requests.sql', '022_equipment_schema.sql', '024_equipment_availability.sql'];

const at = (time) => `2026-12-01T${time}:00Z`;

const refusal = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
};

describe('SCRUM-72: the equipment schema and availability function in Postgres', () => {
  let db;
  let organiser;
  let base; // a type, an event, a request and a line the bad writes hang off

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  const newType = async ({ name, total = 10, damaged = 0, maintenance = 0, retired = false } = {}) =>
    (await one(
      `insert into equipment_types (name, total_quantity, damaged_quantity, under_maintenance_quantity, retired_at)
       values ($1, $2, $3, $4, ${retired ? 'now()' : 'null'}) returning id`,
      [name ?? `type ${randomUUID()}`, total, damaged, maintenance],
    )).id;
  const newEvent = async (name) =>
    (await one('insert into event_requests (organiser_id, event_name) values ($1, $2) returning id', [organiser, name])).id;
  const newRequest = async (eventId) =>
    (await one('insert into equipment_requests (event_request_id) values ($1) returning id', [eventId])).id;
  const newLine = async (requestId, typeId, quantity = 1) =>
    (await one(
      'insert into equipment_lines (equipment_request_id, equipment_type_id, quantity) values ($1, $2, $3) returning id',
      [requestId, typeId, quantity],
    )).id;
  const reserve = ({ type, event, line, quantity, start, end, flagged = false, released = false }) =>
    one(
      `insert into equipment_reservations
         (equipment_type_id, event_request_id, equipment_line_id, quantity, start_at, end_at, flagged, released_at)
       values ($1, $2, $3, $4, $5, $6, $7, ${released ? "'2026-11-01T00:00:00Z'" : 'null'}) returning id`,
      [type, event, line, quantity, start, end, flagged],
    );

  async function availability(typeId, start, end, eventId = null) {
    const row = await one(
      'select equipment_availability($1::uuid, $2::timestamptz, $3::timestamptz, $4::uuid)::text as answer',
      [typeId, start, end, eventId],
    );
    return JSON.parse(row.answer);
  }

  const snapshot = async () => ({
    types: await one('select count(*)::int as n, coalesce(sum(total_quantity + damaged_quantity + under_maintenance_quantity), 0)::int as q from equipment_types'),
    requests: await one('select count(*)::int as n from equipment_requests'),
    lines: await one('select count(*)::int as n, coalesce(sum(quantity), 0)::int as q from equipment_lines'),
    reservations: await one('select count(*)::int as n, coalesce(sum(quantity), 0)::int as q from equipment_reservations'),
  });

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create schema auth;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text);
    `);
    for (const name of MIGRATIONS) await db.exec(migration(name));

    organiser = (await one("insert into auth.users (email) values ('organiser@example.com') returning id")).id;

    const type = await newType({ name: 'Base projector', total: 10 });
    const event = await newEvent('Base event');
    const request = await newRequest(event);
    const line = await newLine(request, type, 2);
    base = { type, event, request, line };
  }, 60000);

  afterAll(async () => {
    await db?.close();
  });


  describe('the migrations', () => {
    it('SCRUM66_022_and_024_apply_cleanly_and_can_be_applied_again', async () => {
      await db.exec(migration('022_equipment_schema.sql'));
      await db.exec(migration('024_equipment_availability.sql'));

      const tables = await db.query(
        "select table_name from information_schema.tables where table_name like 'equipment_%' order by table_name",
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        'equipment_lines',
        'equipment_requests',
        'equipment_reservations',
        'equipment_types',
      ]);
    });
  });


  describe('SCRUM-66: every constraint refuses a direct bad write', () => {
    it.each([
      ['a blank name', 'equipment_types_name_not_blank', "insert into equipment_types (name, total_quantity) values ('   ', 1)"],
      ['a negative total', 'equipment_types_total_not_negative', "insert into equipment_types (name, total_quantity) values ('neg total', -1)"],
      ['a negative damaged quantity', 'equipment_types_damaged_not_negative', "insert into equipment_types (name, total_quantity, damaged_quantity) values ('neg damaged', 5, -1)"],
      ['a negative under-maintenance quantity', 'equipment_types_maintenance_not_negative', "insert into equipment_types (name, total_quantity, under_maintenance_quantity) values ('neg maintenance', 5, -1)"],
      ['damaged above the total', 'equipment_types_unusable_within_total', "insert into equipment_types (name, total_quantity, damaged_quantity) values ('too damaged', 2, 3)"],
      ['under maintenance above the total', 'equipment_types_unusable_within_total', "insert into equipment_types (name, total_quantity, under_maintenance_quantity) values ('too serviced', 2, 3)"],
      ['damaged plus under maintenance above the total', 'equipment_types_unusable_within_total', "insert into equipment_types (name, total_quantity, damaged_quantity, under_maintenance_quantity) values ('too much', 5, 3, 3)"],
    ])('SCRUM66_refuses_%s_with_23514_naming_%s', async (_label, constraint, sql) => {
      const err = await refusal(db.query(sql));

      expect(err?.code).toBe('23514');
      expect(err.message).toContain(constraint);
    });

    it('SCRUM66_refuses_an_update_that_pushes_damaged_plus_maintenance_above_the_total', async () => {
      const id = await newType({ total: 4, damaged: 1 });

      const err = await refusal(db.query('update equipment_types set under_maintenance_quantity = 4 where id = $1', [id]));

      expect(err?.code).toBe('23514');
      expect(err.message).toContain('equipment_types_unusable_within_total');
    });

    it('SCRUM66_refuses_an_update_that_drops_the_total_below_damaged_plus_maintenance', async () => {
      const id = await newType({ total: 6, damaged: 2, maintenance: 2 });

      const err = await refusal(db.query('update equipment_types set total_quantity = 3 where id = $1', [id]));

      expect(err?.code).toBe('23514');
      expect(err.message).toContain('equipment_types_unusable_within_total');
    });

    it.each([
      ['a line quantity of zero', 0],
      ['a negative line quantity', -3],
    ])('SCRUM66_refuses_%s_with_23514_naming_equipment_lines_quantity_positive', async (_label, quantity) => {
      const err = await refusal(
        db.query('insert into equipment_lines (equipment_request_id, equipment_type_id, quantity) values ($1, $2, $3)', [
          base.request,
          await newType(),
          quantity,
        ]),
      );

      expect(err?.code).toBe('23514');
      expect(err.message).toContain('equipment_lines_quantity_positive');
    });

    it('SCRUM66_refuses_a_second_line_for_the_same_type_on_a_request_with_23505', async () => {
      const err = await refusal(
        db.query('insert into equipment_lines (equipment_request_id, equipment_type_id, quantity) values ($1, $2, 1)', [
          base.request,
          base.type,
        ]),
      );

      expect(err?.code).toBe('23505');
      expect(err.message).toContain('equipment_lines_one_per_type');
    });

    it('SCRUM66_allows_the_same_type_on_a_different_request', async () => {
      const otherRequest = await newRequest(await newEvent('Another event'));

      await expect(newLine(otherRequest, base.type, 1)).resolves.toBeTruthy();
    });

    const reservationRow = (overrides) => ({
      type: base.type,
      event: base.event,
      line: base.line,
      quantity: 1,
      start: at('10:00'),
      end: at('12:00'),
      ...overrides,
    });

    it.each([
      ['a reservation quantity of zero', 'equipment_reservations_quantity_positive', { quantity: 0 }],
      ['a negative reservation quantity', 'equipment_reservations_quantity_positive', { quantity: -2 }],
      ['a reservation ending before it starts', 'equipment_reservations_period_valid', { start: at('12:00'), end: at('10:00') }],
      ['a reservation ending exactly when it starts', 'equipment_reservations_period_valid', { start: at('10:00'), end: at('10:00') }],
    ])('SCRUM66_refuses_%s_with_23514_naming_%s', async (_label, constraint, overrides) => {
      const err = await refusal(reserve(reservationRow(overrides)));

      expect(err?.code).toBe('23514');
      expect(err.message).toContain(constraint);
    });

    it.each([
      ['who released it', 'released_by', 'null'],
      ['why it was released', 'release_reason', "'moved'"],
    ])('SCRUM66_refuses_release_details_%s_without_a_release_time', async (_label, column, value) => {
      const userId = (await one("insert into auth.users (email) values ($1) returning id", [`${randomUUID()}@example.com`])).id;
      const set = column === 'released_by' ? `'${userId}'` : value;

      const err = await refusal(
        db.query(
          `insert into equipment_reservations (equipment_type_id, event_request_id, equipment_line_id, quantity, start_at, end_at, ${column})
           values ($1, $2, $3, 1, $4, $5, ${set})`,
          [base.type, base.event, base.line, at('10:00'), at('12:00')],
        ),
      );

      expect(err?.code).toBe('23514');
      expect(err.message).toContain('equipment_reservations_release_consistent');
    });

    it('SCRUM66_allows_release_details_once_a_reservation_is_released', async () => {
      await expect(
        db.query(
          `insert into equipment_reservations (equipment_type_id, event_request_id, equipment_line_id, quantity, start_at, end_at, released_at, release_reason)
           values ($1, $2, $3, 1, $4, $5, now(), 'event cancelled')`,
          [base.type, base.event, base.line, at('10:00'), at('12:00')],
        ),
      ).resolves.toBeTruthy();
    });

    it('SCRUM66_refuses_a_name_that_differs_only_in_capitalisation_or_spacing_with_23505', async () => {
      await newType({ name: 'Unique Mixer' });

      for (const name of ['unique mixer', 'UNIQUE MIXER', '  Unique Mixer  ']) {
        const err = await refusal(db.query('insert into equipment_types (name, total_quantity) values ($1, 1)', [name]));

        expect(err?.code).toBe('23505');
        expect(err.message).toContain('equipment_types_name_unique');
      }
    });

    it('SCRUM66_refuses_an_unknown_request_status_with_22P02', async () => {
      const err = await refusal(db.query("insert into equipment_requests (event_request_id, status) values ($1, 'bogus')", [base.event]));

      expect(err?.code).toBe('22P02');
      expect(err.message).toContain('equipment_request_status');
    });

    it.each([
      ['a request for an event that does not exist', (id) => db.query('insert into equipment_requests (event_request_id) values ($1)', [id])],
      ['a line for a request that does not exist', (id) => db.query('insert into equipment_lines (equipment_request_id, equipment_type_id, quantity) values ($1, $2, 1)', [id, base.type])],
      ['a line for a type that does not exist', (id) => db.query('insert into equipment_lines (equipment_request_id, equipment_type_id, quantity) values ($1, $2, 1)', [base.request, id])],
      ['a reservation for a type that does not exist', (id) => reserve({ type: id, event: base.event, line: base.line, quantity: 1, start: at('10:00'), end: at('12:00') })],
      ['a reservation for an event that does not exist', (id) => reserve({ type: base.type, event: id, line: base.line, quantity: 1, start: at('10:00'), end: at('12:00') })],
      ['a reservation for a line that does not exist', (id) => reserve({ type: base.type, event: base.event, line: id, quantity: 1, start: at('10:00'), end: at('12:00') })],
    ])('SCRUM66_refuses_%s_with_23503', async (_label, write) => {
      const err = await refusal(write(randomUUID()));

      expect(err?.code).toBe('23503');
    });

    it('SCRUM66_accepts_the_boundary_values_the_constraints_allow', async () => {
      await expect(newType({ total: 0 })).resolves.toBeTruthy();
      await expect(newType({ total: 5, damaged: 5 })).resolves.toBeTruthy();
      await expect(newType({ total: 5, damaged: 3, maintenance: 2 })).resolves.toBeTruthy();
      await expect(reserve({ type: base.type, event: base.event, line: base.line, quantity: 1, start: at('10:00'), end: '2026-12-01T10:00:01Z' })).resolves.toBeTruthy();
    });

    it('SCRUM66_a_refused_write_leaves_nothing_behind', async () => {
      const before = await snapshot();

      await refusal(db.query("insert into equipment_types (name, total_quantity, damaged_quantity) values ('nothing left', 1, 5)"));
      await refusal(reserve({ type: base.type, event: base.event, line: base.line, quantity: 0, start: at('10:00'), end: at('12:00') }));

      expect(await snapshot()).toEqual(before);
    });

    it('SCRUM66_updated_at_moves_when_a_type_changes', async () => {
      const id = await newType({ name: 'Clock test' });
      const before = (await one('select updated_at from equipment_types where id = $1', [id])).updated_at;
      await new Promise((resolve) => setTimeout(resolve, 20));

      await db.query('update equipment_types set location = $1 where id = $2', ['Store 9', id]);

      const after = (await one('select updated_at from equipment_types where id = $1', [id])).updated_at;
      expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
    });
  });


  describe('SCRUM-23: the availability function', () => {
    // The period under test is 10:00 to 12:00. All of one type, 10 total, 1 damaged
    // and 1 under maintenance, so 8 usable before any reservation.
    let world;

    beforeAll(async () => {
      const eventA = await newEvent('Own event');
      const eventB = await newEvent('Other event');
      const type = await newType({ name: 'World projector', total: 10, damaged: 1, maintenance: 1 });
      const lineA = await newLine(await newRequest(eventA), type, 2);
      const lineB = await newLine(await newRequest(eventB), type, 7);
      const r = (event, line, quantity, start, end, extra = {}) => reserve({ type, event, line, quantity, start: at(start), end: at(end), ...extra });

      await r(eventB, lineB, 1, '08:00', '10:00'); // ends exactly at the start
      await r(eventB, lineB, 1, '12:00', '14:00'); // starts exactly at the end
      await r(eventB, lineB, 2, '09:00', '11:00'); // straddles the start
      await r(eventB, lineB, 1, '10:30', '11:30'); // inside
      await r(eventB, lineB, 1, '11:00', '13:00', { flagged: true }); // straddles the end, flagged
      await r(eventB, lineB, 3, '10:00', '12:00', { released: true }); // released
      await r(eventA, lineA, 2, '10:00', '12:00'); // the asking event's own

      world = { type, eventA, eventB };
    }, 30000);

    it('SCRUM23_AC3_available_is_total_minus_damaged_minus_maintenance_minus_reserved', async () => {
      const answer = await availability(world.type, at('10:00'), at('12:00'));

      expect(answer).toMatchObject({ found: true, retired: false, total: 10, damaged: 1, under_maintenance: 1, reserved: 6, available: 2 });
    });

    it('SCRUM23_AC4_a_reservation_ending_exactly_at_the_start_or_starting_exactly_at_the_end_does_not_overlap', async () => {
      const { reservations } = await availability(world.type, at('10:00'), at('12:00'));
      const starts = reservations.map((reservation) => reservation.start_at);

      expect(starts.some((start) => start.startsWith('2026-12-01T08:00'))).toBe(false);
      expect(starts.some((start) => start.startsWith('2026-12-01T12:00'))).toBe(false);
    });

    it('SCRUM23_AC4_a_reservation_straddling_a_boundary_or_inside_the_period_overlaps', async () => {
      const { reservations } = await availability(world.type, at('10:00'), at('12:00'));

      expect(reservations.map((reservation) => reservation.quantity).sort()).toEqual([1, 1, 2, 2]);
    });

    it('SCRUM23_AC4_periods_touching_a_reservation_see_only_what_really_overlaps', async () => {
      // 08:00 to 09:00 overlaps only the 08:00 to 10:00 reservation (1); the 09:00 one starts exactly at its end
      expect((await availability(world.type, at('08:00'), at('09:00'))).reserved).toBe(1);
      // 12:00 to 13:00: the 11:00 to 13:00 one (1) and the 12:00 to 14:00 one (1); the 10:00 to 12:00 ones end exactly at its start
      expect((await availability(world.type, at('12:00'), at('13:00'))).reserved).toBe(2);
    });

    it('SCRUM23_AC5_damaged_and_under_maintenance_come_off_the_total_even_with_no_reservations', async () => {
      const answer = await availability(world.type, at('16:00'), at('18:00'));

      expect(answer).toMatchObject({ reserved: 0, available: 8 });
      expect(answer.reservations).toEqual([]);
    });

    it('SCRUM23_AC6_a_flagged_reservation_counts_and_a_released_one_does_not', async () => {
      const { reservations, reserved } = await availability(world.type, at('10:00'), at('12:00'));

      expect(reservations.some((reservation) => reservation.flagged === true)).toBe(true);
      expect(reservations.some((reservation) => reservation.quantity === 3)).toBe(false);
      expect(reserved).toBe(6);
    });

    it('SCRUM23_AC7_the_asking_events_own_reservations_are_left_out', async () => {
      const answer = await availability(world.type, at('10:00'), at('12:00'), world.eventA);

      expect(answer).toMatchObject({ reserved: 4, available: 4 });
      expect(answer.reservations.some((reservation) => reservation.event_request_id === world.eventA)).toBe(false);
    });

    it('SCRUM23_AC7_another_events_reservations_still_count_for_the_asking_event', async () => {
      const answer = await availability(world.type, at('10:00'), at('12:00'), world.eventB);

      // event B holds six of the seven reservations, and they are left out for B: only event A's 2 remain
      expect(answer.reserved).toBe(2);
      expect(answer.reservations.some((reservation) => reservation.event_request_id === world.eventA)).toBe(true);
    });

    it('SCRUM23_AC7_an_event_with_no_reservations_excludes_nothing', async () => {
      expect((await availability(world.type, at('10:00'), at('12:00'), randomUUID())).reserved).toBe(6);
    });

    it('SCRUM23_AC10_lists_each_overlapping_reservation_with_event_name_period_and_quantity_in_start_order', async () => {
      const { reservations } = await availability(world.type, at('10:00'), at('12:00'));

      expect(reservations).toHaveLength(4);
      for (const reservation of reservations) {
        expect(typeof reservation.event_name).toBe('string');
        expect(reservation.start_at).toBeTruthy();
        expect(reservation.end_at).toBeTruthy();
        expect(reservation.quantity).toBeGreaterThan(0);
      }
      const starts = reservations.map((reservation) => new Date(reservation.start_at).getTime());
      expect(starts).toEqual([...starts].sort((a, b) => a - b));
      expect(reservations.map((reservation) => reservation.event_name)).toContain('Own event');
    });

    it('SCRUM23_AC8_an_over_committed_type_returns_the_raw_negative_figure', async () => {
      const type = await newType({ name: 'Over-committed', total: 10, damaged: 1, maintenance: 1 });
      const event = await newEvent('Greedy event');
      const line = await newLine(await newRequest(event), type, 5);
      await reserve({ type, event, line, quantity: 5, start: at('10:00'), end: at('12:00') });
      await reserve({ type, event, line, quantity: 6, start: at('10:00'), end: at('12:00') });

      // 10 - 1 - 1 - 11 = -3: reserving and the equipment-lost check need to see it
      expect((await availability(type, at('10:00'), at('12:00'))).available).toBe(-3);
    });

    it('SCRUM23_AC11_an_unknown_type_answers_found_false', async () => {
      expect(await availability(randomUUID(), at('10:00'), at('12:00'))).toEqual({ found: false, retired: false });
    });

    it('SCRUM23_AC11_a_retired_type_answers_retired_true_and_nothing_else', async () => {
      const type = await newType({ name: 'Retired kit', retired: true });

      expect(await availability(type, at('10:00'), at('12:00'))).toEqual({ found: true, retired: true });
    });

    it.each([
      ['an end before the start', at('12:00'), at('10:00')],
      ['an end equal to the start', at('10:00'), at('10:00')],
    ])('SCRUM23_AC2_the_function_refuses_%s_with_22023', async (_label, start, end) => {
      const err = await refusal(availability(base.type, start, end));

      expect(err?.code).toBe('22023');
    });

    it('SCRUM23_AC2_the_function_refuses_a_missing_period_with_22023', async () => {
      const err = await refusal(db.query('select equipment_availability($1::uuid, null, null, null)', [base.type]));

      expect(err?.code).toBe('22023');
    });

    it('SCRUM23_AC12_the_function_is_declared_stable_so_postgres_refuses_any_write_in_it', async () => {
      const row = await one("select provolatile from pg_proc where proname = 'equipment_availability'");

      expect(row.provolatile).toBe('s');
    });

    it('SCRUM23_AC12_running_checks_changes_no_row_in_any_equipment_table', async () => {
      const before = await snapshot();

      await availability(world.type, at('10:00'), at('12:00'));
      await availability(world.type, at('10:00'), at('12:00'), world.eventA);
      await availability(randomUUID(), at('10:00'), at('12:00'));
      await availability(world.type, at('16:00'), at('18:00'));

      expect(await snapshot()).toEqual(before);
    });
  });
});
