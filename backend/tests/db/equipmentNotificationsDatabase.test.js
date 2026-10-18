/**
 * SCRUM-176: equipment notifications (097), run against a real Postgres (PGlite).
 *
 * The notifications are written by triggers on the equipment tables, so each
 * test makes the change the way the product does (the same SQL functions) and
 * reads what the database wrote.
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

const OUR_TYPES = [
  'equipment_requested',
  'equipment_request_changed',
  'equipment_request_cancelled',
  'equipment_arranged',
  'equipment_not_fully_arranged',
  'equipment_flagged',
];

describe('SCRUM-176: equipment notifications in Postgres', () => {
  let db;
  let organiser;
  let coordinator;
  let otherCoordinator;
  let techA;
  let techB;
  let venueStaff;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const rows = async (sql, params) => (await db.query(sql, params)).rows;
  const asJson = (row) => JSON.parse(row.answer);

  const newUser = async (email, role) => {
    const id = (await one('insert into auth.users (email) values ($1) returning id', [email])).id;
    await db.query('insert into profiles (id, role) values ($1, $2)', [id, role]);
    return id;
  };
  const newType = async (name, total) =>
    (await one(
      'insert into equipment_types (name, total_quantity) values ($1, $2) returning id',
      [`${name} ${Math.random()}`, total],
    )).id;
  const newEvent = async () =>
    (await one(
      `insert into event_requests
         (organiser_id, event_name, status, assigned_coordinator_id, proposed_start, proposed_end)
       values ($1, $2, 'approved', $3, $4, $5) returning id`,
      [organiser, `Event ${Math.random()}`, coordinator, START, END],
    )).id;

  const add = async (event, type, quantity, notes = null) =>
    asJson(await one(
      'select add_equipment_line($1, $2, $3, $4, $5)::text as answer',
      [event, coordinator, type, quantity, notes],
    ));
  const amend = async (event, line, quantity, notes = null, changeNotes = false) =>
    asJson(await one(
      'select amend_equipment_line($1, $2, $3, $4, $5, $6)::text as answer',
      [event, coordinator, line, quantity, notes, changeNotes],
    ));
  const removeLine = async (event, line) =>
    asJson(await one('select remove_equipment_line($1, $2, $3)::text as answer', [event, coordinator, line]));
  const start = async (event) =>
    asJson(await one('select start_equipment_review($1, $2)::text as answer', [event, techA]));
  const reserve = async (event, line, quantity) =>
    asJson(await one('select reserve_equipment($1, $2, $3, $4)::text as answer', [event, techA, line, quantity]));
  const markUnavailable = async (event, line, note) =>
    asJson(await one('select mark_equipment_line_unavailable($1, $2, $3, $4)::text as answer', [event, techA, line, note]));
  const complete = async (event) =>
    asJson(await one('select complete_equipment_review($1, $2)::text as answer', [event, techA]));
  const changePeriod = (event) =>
    db.query('update event_requests set proposed_start = $2, proposed_end = $3 where id = $1', [event, NEW_START, NEW_END]);

  /** Every notification for the event, oldest first. */
  const notes = (event, type) =>
    rows(
      `select recipient_id, type, event_request_id, payload, created_at
         from notifications
        where event_request_id = $1 and ($2::text is null or type = $2)
        order by created_at, id`,
      [event, type ?? null],
    );
  const forUser = (list, user) => list.filter((n) => n.recipient_id === user);
  const types = (list) => list.map((n) => n.type);
  const clear = () => db.query('delete from notifications');

  /** An approved event with one line, ready to review. */
  const eventWithLine = async (quantity = 2, total = 10) => {
    const type = await newType('Projector', total);
    const event = await newEvent();
    const state = await add(event, type, quantity);
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
      create table profiles (id uuid primary key references auth.users (id), role text not null);

      -- As it stands on dev, plus one type from a migration that is not on dev
      -- yet, to show 097 keeps what it did not write.
      create table notifications (
        id               uuid primary key default gen_random_uuid(),
        recipient_id     uuid not null references auth.users (id) on delete cascade,
        type             text not null,
        event_request_id uuid references event_requests (id) on delete cascade,
        payload          jsonb not null default '{}',
        read_at          timestamptz,
        created_at       timestamptz not null default now(),
        constraint notifications_type_known check (
          type in ('booking_flagged', 'event_cancelled', 'safety_review_response')
        )
      );
    `);
    for (const name of MIGRATIONS) await db.exec(migration(name));
    await db.exec(migration('097_equipment_notifications.sql'));

    organiser = await newUser('organiser@example.com', 'event_organiser');
    coordinator = await newUser('coordinator@example.com', 'event_coordinator');
    otherCoordinator = await newUser('other-coordinator@example.com', 'event_coordinator');
    techA = await newUser('tech-a@example.com', 'technical_support_staff');
    techB = await newUser('tech-b@example.com', 'technical_support_staff');
    venueStaff = await newUser('venue@example.com', 'venue_staff');
  }, 60000);

  afterAll(async () => {
    await db?.close();
  });

  describe('the migration', () => {
    it('SCRUM176_runs_a_second_time_without_error_or_a_duplicate_trigger', async () => {
      await expect(db.exec(migration('097_equipment_notifications.sql'))).resolves.not.toThrow();

      const { event } = await eventWithLine(1);

      expect(await notes(event, 'equipment_requested')).toHaveLength(2);
    });

    it('SCRUM176_keeps_the_types_it_did_not_add_and_adds_its_six', async () => {
      const event = await newEvent();
      const insert = (type) =>
        db.query('insert into notifications (recipient_id, type, event_request_id) values ($1, $2, $3)', [
          coordinator,
          type,
          event,
        ]);

      for (const type of ['booking_flagged', 'event_cancelled', 'safety_review_response', ...OUR_TYPES]) {
        await expect(insert(type)).resolves.toBeDefined();
      }
      await expect(insert('not_a_type')).rejects.toThrow(/notifications_type_known/);
    });
  });

  describe('AC1 and AC2: Technical Support is told when equipment is requested', () => {
    it('SCRUM176_AC1_every_technical_support_user_is_told_and_nobody_else', async () => {
      await clear();
      const { event } = await eventWithLine(2);

      const requested = await notes(event, 'equipment_requested');

      expect(requested.map((n) => n.recipient_id).sort()).toEqual([techA, techB].sort());
      expect(await notes(event)).toHaveLength(2);
      for (const other of [organiser, coordinator, otherCoordinator, venueStaff]) {
        expect(forUser(await notes(event), other)).toEqual([]);
      }
    });

    it('SCRUM176_AC2_names_the_event_the_equipment_type_and_the_quantity', async () => {
      await clear();
      const type = await newType('Wireless microphone', 10);
      const event = await newEvent();
      await add(event, type, 4, 'Two handheld, two clip-on');

      const [first] = await notes(event, 'equipment_requested');
      const name = (await one('select event_name from event_requests where id = $1', [event])).event_name;
      const typeName = (await one('select name from equipment_types where id = $1', [type])).name;

      expect(first.payload).toMatchObject({
        eventRequestId: event,
        eventName: name,
        audience: 'technical_support_staff',
        lines: [{ equipmentType: typeName, quantity: 4, reserved: 0, outcome: null }],
      });
    });

    it('SCRUM176_AC1_a_refused_request_notifies_nobody', async () => {
      await clear();
      const type = await newType('Projector', 10);
      const event = await newEvent();

      await expect(
        db.query('select add_equipment_line($1, $2, $3, 0, null)', [event, coordinator, type]),
      ).rejects.toThrow();

      expect(await notes(event)).toEqual([]);
    });
  });

  describe('AC3 and AC4: the coordinator is told how the request ended', () => {
    it('SCRUM176_AC3_the_coordinator_is_told_when_every_line_is_reserved', async () => {
      const { event, line } = await eventWithLine(2);
      await start(event);
      await clear();

      await reserve(event, line, 2);

      const arranged = await notes(event, 'equipment_arranged');
      expect(arranged).toHaveLength(1);
      expect(arranged[0].recipient_id).toBe(coordinator);
      expect(arranged[0].payload.audience).toBe('event_coordinator');
      expect(arranged[0].payload.lines).toEqual([
        expect.objectContaining({ quantity: 2, reserved: 2 }),
      ]);
      expect(await notes(event)).toHaveLength(1);
    });

    it('SCRUM176_AC3_a_partial_reservation_does_not_say_arranged', async () => {
      const { event, line } = await eventWithLine(3);
      await start(event);
      await clear();

      await reserve(event, line, 1);

      expect(await notes(event, 'equipment_arranged')).toEqual([]);
    });

    it('SCRUM176_AC4_the_coordinator_is_told_which_line_could_not_be_provided', async () => {
      const typeA = await newType('Projector', 10);
      const typeB = await newType('Microphone', 1);
      const event = await newEvent();
      const first = await add(event, typeA, 2);
      const second = await add(event, typeB, 5);
      const lineA = first.request.lines[0].id;
      const lineB = second.request.lines.find((l) => l.id !== lineA).id;
      await start(event);
      await reserve(event, lineA, 2);
      await reserve(event, lineB, 1);
      await markUnavailable(event, lineB, 'Only one microphone exists');
      await clear();

      await complete(event);

      const outcome = await notes(event, 'equipment_not_fully_arranged');
      expect(outcome).toHaveLength(1);
      expect(outcome[0].recipient_id).toBe(coordinator);
      const short = outcome[0].payload.lines.find((l) => l.reserved < l.quantity);
      expect(short).toMatchObject({ quantity: 5, reserved: 1, outcome: 'cannot_be_provided' });
      expect(await notes(event)).toHaveLength(1);
    });

    it('SCRUM176_AC4_a_reviewer_marking_a_line_notifies_nobody_until_the_review_is_completed', async () => {
      const { event, line } = await eventWithLine(3, 1);
      await start(event);
      await clear();

      await markUnavailable(event, line, 'Not available that day');

      expect(await notes(event)).toEqual([]);
    });
  });

  describe('AC5: a change after the request is told to Technical Support', () => {
    it('SCRUM176_AC5_adding_another_line_is_a_change_not_a_new_request', async () => {
      const { event } = await eventWithLine(2);
      await clear();
      const type = await newType('Speaker', 10);

      await add(event, type, 1);

      const changed = await notes(event, 'equipment_request_changed');
      expect(changed.map((n) => n.recipient_id).sort()).toEqual([techA, techB].sort());
      expect(changed[0].payload).toMatchObject({ change: 'added', lines: [{ quantity: 1 }] });
      expect(await notes(event, 'equipment_requested')).toEqual([]);
    });

    it('SCRUM176_AC5_amending_a_quantity_says_what_it_was', async () => {
      const { event, line } = await eventWithLine(2);
      await clear();

      await amend(event, line, 5);

      const changed = await notes(event, 'equipment_request_changed');
      expect(changed).toHaveLength(2);
      expect(changed[0].payload).toMatchObject({
        change: 'amended',
        previousQuantity: 2,
        notesChanged: false,
        lines: [{ quantity: 5 }],
      });
    });

    it('SCRUM176_AC5_amending_only_the_notes_says_so', async () => {
      const { event, line } = await eventWithLine(2);
      await clear();

      await amend(event, line, null, 'Needs an HDMI adapter', true);

      const [changed] = await notes(event, 'equipment_request_changed');
      expect(changed.payload).toMatchObject({ change: 'amended', previousQuantity: 2, notesChanged: true });
    });

    it('SCRUM176_AC5_an_amendment_that_changes_nothing_is_not_a_notification', async () => {
      const { event, line } = await eventWithLine(2);
      await clear();

      await amend(event, line, 2);

      expect(await notes(event)).toEqual([]);
    });

    it('SCRUM176_AC5_removing_one_of_several_lines_is_a_change', async () => {
      const typeA = await newType('Projector', 10);
      const typeB = await newType('Speaker', 10);
      const event = await newEvent();
      const first = await add(event, typeA, 2);
      const second = await add(event, typeB, 1);
      const lineB = second.request.lines.find((l) => l.id !== first.request.lines[0].id).id;
      await clear();

      await removeLine(event, lineB);

      const changed = await notes(event, 'equipment_request_changed');
      expect(changed).toHaveLength(2);
      expect(changed[0].payload).toMatchObject({ change: 'removed', lines: [{ quantity: 1 }] });
      expect(await notes(event, 'equipment_request_cancelled')).toEqual([]);
    });

    it('SCRUM176_AC5_removing_the_last_line_is_told_once_as_a_cancellation', async () => {
      const { event, line } = await eventWithLine(2);
      await clear();

      await removeLine(event, line);

      const cancelled = await notes(event, 'equipment_request_cancelled');
      expect(cancelled.map((n) => n.recipient_id).sort()).toEqual([techA, techB].sort());
      expect(cancelled[0].payload).toMatchObject({
        reason: 'The last line was removed',
        lines: [{ quantity: 2 }],
      });
      expect(await notes(event)).toHaveLength(2);
    });

    it('SCRUM176_AC5_a_new_request_after_a_cancelled_one_is_a_request_again', async () => {
      const { event, line } = await eventWithLine(2);
      await removeLine(event, line);
      await clear();
      const type = await newType('Speaker', 10);

      await add(event, type, 1);

      expect(types(await notes(event))).toEqual(['equipment_requested', 'equipment_requested']);
    });

    it('SCRUM176_AC5_a_date_change_tells_technical_support_and_the_coordinator_once', async () => {
      const typeA = await newType('Projector', 10);
      const typeB = await newType('Speaker', 10);
      const event = await newEvent();
      const first = await add(event, typeA, 2);
      const second = await add(event, typeB, 1);
      const lineA = first.request.lines[0].id;
      const lineB = second.request.lines.find((l) => l.id !== lineA).id;
      await start(event);
      await reserve(event, lineA, 2);
      await reserve(event, lineB, 1);
      await clear();

      await changePeriod(event);

      const changed = await notes(event, 'equipment_request_changed');
      expect(changed.map((n) => n.recipient_id).sort()).toEqual([techA, techB, coordinator].sort());
      expect(forUser(changed, coordinator)[0].payload).toMatchObject({ change: 'event_period', audience: 'event_coordinator' });
      expect(new Date(changed[0].payload.startsAt).toISOString()).toBe(new Date(NEW_START).toISOString());
      expect(await notes(event)).toHaveLength(3);
    });

    it('SCRUM176_AC5_amending_a_reserved_line_tells_the_coordinator_nothing_about_their_own_edit', async () => {
      const { event, line } = await eventWithLine(2);
      await start(event);
      await reserve(event, line, 2);
      await clear();

      await amend(event, line, 3);

      expect(forUser(await notes(event), coordinator)).toEqual([]);
      expect(types(await notes(event))).toEqual(['equipment_request_changed', 'equipment_request_changed']);
    });
  });

  describe('AC6: the coordinator is told when reserved equipment becomes unavailable', () => {
    it('SCRUM176_AC6_retiring_a_reserved_type_tells_the_coordinator', async () => {
      const { event, type, line } = await eventWithLine(2);
      await start(event);
      await reserve(event, line, 2);
      await clear();

      await db.query('update equipment_types set retired_at = now() where id = $1', [type]);

      const flagged = await notes(event, 'equipment_flagged');
      const typeName = (await one('select name from equipment_types where id = $1', [type])).name;
      expect(flagged).toHaveLength(1);
      expect(flagged[0].recipient_id).toBe(coordinator);
      expect(flagged[0].payload).toMatchObject({
        equipmentType: typeName,
        reason: 'The equipment type was retired',
        audience: 'event_coordinator',
      });
      expect(await notes(event)).toHaveLength(1);
    });

    it('SCRUM176_AC6_fewer_usable_units_tells_the_coordinator_of_each_affected_event', async () => {
      const type = await newType('Projector', 4);
      const first = await newEvent();
      const second = await newEvent();
      for (const event of [first, second]) {
        const state = await add(event, type, 2);
        await start(event);
        await reserve(event, state.request.lines[0].id, 2);
      }
      await clear();

      await db.query('update equipment_types set damaged_quantity = 2, total_quantity = 3 where id = $1', [type]);

      for (const event of [first, second]) {
        const flagged = await notes(event, 'equipment_flagged');
        expect(flagged).toHaveLength(1);
        expect(flagged[0].payload.reason).toBe('Fewer units of this equipment are usable');
      }
    });

    it('SCRUM176_AC6_the_flag_only_notifies_and_leaves_the_reservation_for_people_to_decide', async () => {
      const { event, type, line } = await eventWithLine(2);
      await start(event);
      await reserve(event, line, 2);

      await db.query('update equipment_types set retired_at = now() where id = $1', [type]);

      const reservation = await one(
        'select flagged, released_at from equipment_reservations where event_request_id = $1',
        [event],
      );
      expect(reservation).toMatchObject({ flagged: true, released_at: null });
    });

    it('SCRUM176_AC6_a_type_nobody_reserved_notifies_nobody', async () => {
      const type = await newType('Spare cable', 10);
      await clear();

      await db.query('update equipment_types set retired_at = now() where id = $1', [type]);

      expect(await rows('select 1 from notifications')).toEqual([]);
    });
  });

  describe('AC7: every notification points at its event', () => {
    it('SCRUM176_AC7_each_type_carries_the_event_request_id_the_inbox_links_with', async () => {
      await clear();
      const type = await newType('Projector', 10);
      const event = await newEvent();
      const state = await add(event, type, 2);
      const line = state.request.lines[0].id;
      await amend(event, line, 3);
      await start(event);
      await reserve(event, line, 3);
      await db.query('update equipment_types set retired_at = now() where id = $1', [type]);
      await removeLine(event, line);

      const all = await notes(event);

      expect(new Set(types(all))).toEqual(
        new Set([
          'equipment_requested',
          'equipment_request_changed',
          'equipment_arranged',
          'equipment_flagged',
          'equipment_request_cancelled',
        ]),
      );
      for (const n of all) {
        expect(n.event_request_id).toBe(event);
        expect(n.payload.eventRequestId).toBe(event);
      }
    });

    it('SCRUM176_AC7_an_event_without_a_coordinator_still_tells_technical_support', async () => {
      const { event, line } = await eventWithLine(1);
      await start(event);
      await reserve(event, line, 1);
      await db.query('update event_requests set assigned_coordinator_id = null where id = $1', [event]);
      await clear();

      await changePeriod(event);

      const changed = await notes(event, 'equipment_request_changed');
      expect(changed.map((n) => n.recipient_id).sort()).toEqual([techA, techB].sort());
    });
  });
});
