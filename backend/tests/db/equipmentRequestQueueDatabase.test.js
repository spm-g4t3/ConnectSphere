/**
 * SCRUM-284: the equipment request queue (056), against a real Postgres (PGlite).
 *
 * Named SCRUM284_AC<n>_<what_it_checks>, the ACs being SCRUM-284's. Applies 022, 024, 037,
 * 038, 053, 054, 055, 056 and 060 and calls equipment_request_queue the way the
 * service does, as a Technical Support user.
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
  '056_equipment_request_queue.sql',
  '060_equipment_reservation_topup.sql',
];

const refusal = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
};

const day = (n, hour = 10) => {
  const d = new Date(Date.UTC(2030, 0, n, hour));
  return d.toISOString();
};
const plus = (iso, hours) => new Date(new Date(iso).getTime() + hours * 3600 * 1000).toISOString();

describe('SCRUM-284: the equipment request queue in Postgres', () => {
  let db;
  let organiser;
  let coordinator;
  let sam;
  let tech;
  let alex;
  let hall;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const asJson = (row) => JSON.parse(row.answer);

  const newUser = async (email, name, role = 'event_coordinator') => {
    const id = (await one('insert into auth.users (email) values ($1) returning id', [email])).id;
    await db.query('insert into profiles (id, full_name, role) values ($1, $2, $3)', [id, name, role]);
    return id;
  };
  const newType = async (name, total = 10) =>
    (await one('insert into equipment_types (name, total_quantity) values ($1, $2) returning id', [name, total])).id;

  /** An approved event with a period, one request and `lines` lines. */
  const makeEvent = async ({ name, start = day(10), end = plus(day(10), 2), lines = 1, status = 'approved' } = {}) => {
    const event = (await one(
      `insert into event_requests
         (organiser_id, event_name, status, assigned_coordinator_id, proposed_start, proposed_end)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [organiser, name ?? `Event ${Math.random()}`, status, coordinator, start, end],
    )).id;
    let lineIds = [];
    for (let i = 0; i < lines; i += 1) {
      const type = await newType(`Type ${Math.random()}`, 10);
      const state = asJson(
        await one('select add_equipment_line($1, $2, $3, $4, null)::text as answer', [event, coordinator, type, 2]),
      );
      lineIds = state.request.lines.map((l) => l.id);
    }
    return { event, lineIds };
  };

  const setStatus = (event, status) =>
    db.query('update equipment_requests set status = $2::equipment_request_status where event_request_id = $1', [event, status]);
  const startReview = (event, who) => one('select start_equipment_review($1, $2)::text as answer', [event, who]);
  const queueFor = async (caller, status = null, includePast = false, limit = 200) =>
    asJson(await one('select equipment_request_queue($1, $2, $3, $4)::text as answer', [caller, status, includePast, limit]));
  const queue = (status = null, includePast = false, limit = 200) => queueFor(tech, status, includePast, limit);
  const rowFor = (list, event) => list.find((r) => r.event_request_id === event);
  const names = (list) => list.map((r) => r.event_name);

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create schema auth;
      create role anon;
      create role authenticated;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text);
      create table profiles (id uuid primary key references auth.users(id), full_name text, role text);

      create function set_updated_at() returns trigger language plpgsql as $$
      begin new.updated_at = now(); return new; end $$;

      create type event_request_status as enum (
        'draft', 'submitted', 'under_review', 'pending_clarification',
        'approved', 'safety_review', 'safety_approved', 'confirmed', 'completed', 'rejected', 'cancelled'
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
      create table venues (id uuid primary key default gen_random_uuid(), name text not null);
      create type booking_status as enum ('approved', 'flagged_for_review', 'cancelled');
      create table bookings (
        id               uuid primary key default gen_random_uuid(),
        venue_id         uuid not null references venues(id),
        event_request_id uuid not null references event_requests(id) on delete cascade,
        starts_at        timestamptz not null,
        ends_at          timestamptz not null,
        status           booking_status not null default 'approved'
      );
    `);
    for (const name of MIGRATIONS) await db.exec(migration(name));

    organiser = await newUser('organiser@example.com', 'Olive Organiser');
    coordinator = await newUser('coordinator@example.com', 'Rae Tan');
    sam = await newUser('sam@example.com', 'Sam Lee');
    alex = await newUser('alex@example.com', 'Alex Koh');
    tech = await newUser('tech@example.com', 'Tessa Support', 'technical_support_staff');
    hall = (await one("insert into venues (name) values ('Hall A') returning id")).id;
  }, 60000);

  afterAll(async () => {
    await db?.close();
  });


  it('SCRUM284_AC1_the_old_function_with_no_caller_check_is_gone', async () => {
    const old = await one("select to_regprocedure('equipment_request_queue(text, boolean)') as fn");
    expect(old.fn).toBeNull();
  });

  it('SCRUM284_AC1_the_function_is_not_granted_to_anon_or_authenticated', async () => {
    const grants = await one(
      `select has_function_privilege('anon', 'equipment_request_queue(uuid, text, boolean, integer)', 'execute') as anon,
              has_function_privilege('authenticated', 'equipment_request_queue(uuid, text, boolean, integer)', 'execute') as authenticated`,
    );
    expect(grants).toEqual({ anon: false, authenticated: false });
  });

  describe('AC1: only Technical Support Staff can read it', () => {
    it.each([
      ['a coordinator', () => coordinator],
      ['an organiser-role profile', () => organiser],
      ['a user with no profile', () => '00000000-0000-4000-8000-000000000000'],
      ['no caller', () => null],
    ])('SCRUM284_AC1_%s_is_refused_with_42501', async (_label, who) => {
      expect((await refusal(queueFor(who())))?.code).toBe('42501');
    });

    it('SCRUM284_AC1_a_technical_support_user_can_read_it', async () => {
      await expect(queue()).resolves.toHaveProperty('needs_action');
    });
  });

  it('SCRUM284_AC2_an_empty_database_gives_two_empty_lists', async () => {
    const result = await queue();
    expect(result.needs_action).toEqual([]);
    expect(result.requests).toEqual([]);
  });


  describe('AC3 and AC6: what a row shows, and nothing more', () => {
    it('SCRUM284_AC3_a_row_carries_the_listed_fields_and_no_others', async () => {
      const { event } = await makeEvent({ name: 'Row Shape', lines: 2 });
      const row = rowFor((await queue()).requests, event);
      expect(Object.keys(row).sort()).toEqual([
        'coordinator_id',
        'coordinator_name',
        'event_name',
        'event_request_id',
        'flag_reasons',
        'flagged_count',
        'item_count',
        'proposed_end',
        'proposed_start',
        'reviewer_id',
        'reviewer_name',
        'status',
        'venues',
      ]);
    });

    it('SCRUM284_AC3_a_row_shows_the_event_the_coordinator_the_item_count_and_the_status', async () => {
      const { event } = await makeEvent({ name: 'Annual Dinner', lines: 3 });
      const row = rowFor((await queue()).requests, event);
      expect(row).toMatchObject({
        event_name: 'Annual Dinner',
        coordinator_id: coordinator,
        coordinator_name: 'Rae Tan',
        item_count: 6,
        status: 'pending_review',
        reviewer_id: null,
        reviewer_name: null,
        venues: [],
      });
      expect(new Date(row.proposed_start).toISOString()).toBe(day(10));
      expect(new Date(row.proposed_end).toISOString()).toBe(plus(day(10), 2));
    });

    it('SCRUM284_AC3_the_reviewer_is_shown_while_the_request_is_under_review', async () => {
      const { event } = await makeEvent({ name: 'Being Reviewed' });
      await startReview(event, sam);
      const row = rowFor((await queue()).requests, event);
      expect(row).toMatchObject({ status: 'under_review', reviewer_id: sam, reviewer_name: 'Sam Lee' });
    });

    it('SCRUM284_AC3_there_is_no_reviewer_once_the_request_is_no_longer_under_review', async () => {
      const { event } = await makeEvent({ name: 'Review Finished' });
      await startReview(event, sam);
      await setStatus(event, 'arranged');
      const row = rowFor((await queue()).requests, event);
      expect(row).toMatchObject({ status: 'arranged', reviewer_id: null, reviewer_name: null });
    });

    it('SCRUM284_AC3_the_booked_venue_is_shown_when_there_is_one', async () => {
      const { event } = await makeEvent({ name: 'Has Venue' });
      await db.query('insert into bookings (venue_id, event_request_id, starts_at, ends_at) values ($1, $2, $3, $4)', [
        hall, event, day(10), plus(day(10), 2),
      ]);
      expect(rowFor((await queue()).requests, event)).toMatchObject({ venues: [{ id: hall, name: 'Hall A' }] });
    });

    it('SCRUM284_AC3_a_booking_under_review_still_shows_its_venue_and_a_cancelled_one_does_not', async () => {
      const flagged = await makeEvent({ name: 'Booking Flagged' });
      await db.query(
        "insert into bookings (venue_id, event_request_id, starts_at, ends_at, status) values ($1, $2, $3, $4, 'flagged_for_review')",
        [hall, flagged.event, day(10), plus(day(10), 2)],
      );
      const cancelled = await makeEvent({ name: 'Booking Cancelled' });
      await db.query(
        "insert into bookings (venue_id, event_request_id, starts_at, ends_at, status) values ($1, $2, $3, $4, 'cancelled')",
        [hall, cancelled.event, day(10), plus(day(10), 2)],
      );
      const list = (await queue()).requests;
      expect(rowFor(list, flagged.event).venues).toEqual([{ id: hall, name: 'Hall A' }]);
      expect(rowFor(list, cancelled.event).venues).toEqual([]);
    });

    it('SCRUM284_AC3_an_event_with_two_venues_shows_one_row_naming_both_earliest_first', async () => {
      const { event } = await makeEvent({ name: 'Two Bookings' });
      const other = (await one("insert into venues (name) values ('Hall B') returning id")).id;
      await db.query('insert into bookings (venue_id, event_request_id, starts_at, ends_at) values ($1, $2, $3, $4)', [
        other, event, day(11), plus(day(11), 2),
      ]);
      await db.query('insert into bookings (venue_id, event_request_id, starts_at, ends_at) values ($1, $2, $3, $4)', [
        hall, event, day(10), plus(day(10), 2),
      ]);
      const list = (await queue()).requests.filter((r) => r.event_request_id === event);
      expect(list).toHaveLength(1);
      expect(list[0].venues).toEqual([
        { id: hall, name: 'Hall A' },
        { id: other, name: 'Hall B' },
      ]);
    });

    it('SCRUM284_AC3_two_bookings_at_the_same_venue_name_it_once', async () => {
      const { event } = await makeEvent({ name: 'Same Venue Twice' });
      for (const d of [10, 11]) {
        await db.query('insert into bookings (venue_id, event_request_id, starts_at, ends_at) values ($1, $2, $3, $4)', [
          hall, event, day(d), plus(day(d), 2),
        ]);
      }
      expect(rowFor((await queue()).requests, event).venues).toEqual([{ id: hall, name: 'Hall A' }]);
    });

    it('SCRUM284_AC3_the_item_count_adds_up_units_across_lines', async () => {
      const { event } = await makeEvent({ name: 'Mics And Projectors', lines: 0 });
      const mics = await newType('Mics', 50);
      const projectors = await newType('Projectors', 50);
      await db.query('select add_equipment_line($1, $2, $3, 20, null)', [event, coordinator, mics]);
      await db.query('select add_equipment_line($1, $2, $3, 2, null)', [event, coordinator, projectors]);
      expect(rowFor((await queue()).requests, event).item_count).toBe(22);
    });

    it('SCRUM284_AC3_a_removed_line_is_not_counted', async () => {
      const { event, lineIds } = await makeEvent({ name: 'One Removed', lines: 2 });
      await db.query('update equipment_lines set removed_at = now() where id = $1', [lineIds[0]]);
      expect(rowFor((await queue()).requests, event).item_count).toBe(2);
    });

    it('SCRUM284_AC3_a_coordinator_with_no_name_gives_null_and_the_row_is_still_listed', async () => {
      const nameless = await newUser('nameless@example.com', null);
      const { event } = await makeEvent({ name: 'Nameless Coordinator' });
      await db.query('update event_requests set assigned_coordinator_id = $2 where id = $1', [event, nameless]);
      expect(rowFor((await queue()).requests, event)).toMatchObject({ coordinator_id: nameless, coordinator_name: null });
    });
  });


  describe('AC2: every status, filtered, sorted and limited to events that have not ended', () => {
    it('SCRUM284_AC2_every_status_is_listed', async () => {
      const made = {};
      for (const status of ['pending_review', 'under_review', 'arranged', 'cannot_be_fully_arranged', 'cancelled']) {
        made[status] = (await makeEvent({ name: `All statuses ${status}` })).event;
        if (status === 'under_review') await startReview(made[status], sam);
        else if (status !== 'pending_review') await setStatus(made[status], status);
      }
      const list = (await queue()).requests;
      for (const [status, event] of Object.entries(made)) {
        expect(rowFor(list, event)?.status, status).toBe(status);
      }
    });

    it('SCRUM284_AC2_filtering_by_status_returns_only_that_status', async () => {
      const a = await makeEvent({ name: 'Filter Arranged' });
      const b = await makeEvent({ name: 'Filter Pending' });
      await setStatus(a.event, 'arranged');
      const arranged = (await queue('arranged')).requests;
      expect(rowFor(arranged, a.event)).toBeDefined();
      expect(rowFor(arranged, b.event)).toBeUndefined();
      expect(arranged.every((r) => r.status === 'arranged')).toBe(true);
    });

    it('SCRUM284_AC2_an_unknown_status_is_refused_with_22023', async () => {
      const err = await refusal(queue('finished'));
      expect(err?.code).toBe('22023');
    });

    it('SCRUM284_AC2_a_status_with_the_wrong_case_is_refused_not_guessed', async () => {
      expect((await refusal(queue('ARRANGED')))?.code).toBe('22023');
    });

    it('SCRUM284_AC2_the_list_is_sorted_by_event_start_earliest_first', async () => {
      await makeEvent({ name: 'Sort C', start: day(22), end: plus(day(22), 2) });
      await makeEvent({ name: 'Sort A', start: day(20), end: plus(day(20), 2) });
      await makeEvent({ name: 'Sort B', start: day(21), end: plus(day(21), 2) });
      const sorted = names((await queue()).requests).filter((n) => n.startsWith('Sort '));
      expect(sorted).toEqual(['Sort A', 'Sort B', 'Sort C']);
    });

    it('SCRUM284_AC2_an_event_with_no_period_yet_is_listed_after_the_dated_ones', async () => {
      const { event } = await makeEvent({ name: 'No Period Yet' });
      await db.query('update event_requests set proposed_start = null, proposed_end = null where id = $1', [event]);
      const list = (await queue()).requests;
      expect(rowFor(list, event)).toBeDefined();
      expect(list.at(-1).event_request_id).toBe(event);
    });

    it('SCRUM284_AC2_events_that_have_ended_are_hidden_by_default', async () => {
      const { event } = await makeEvent({ name: 'Already Over' });
      await db.query("update event_requests set proposed_start = '2020-01-01T10:00:00Z', proposed_end = '2020-01-01T12:00:00Z' where id = $1", [event]);
      expect(rowFor((await queue()).requests, event)).toBeUndefined();
    });

    it('SCRUM284_AC2_including_past_events_brings_them_back', async () => {
      const { event } = await makeEvent({ name: 'Over But Wanted' });
      await db.query("update event_requests set proposed_start = '2020-01-01T10:00:00Z', proposed_end = '2020-01-01T12:00:00Z' where id = $1", [event]);
      expect(rowFor((await queue(null, true)).requests, event)).toBeDefined();
    });

    it('SCRUM284_AC2_an_event_that_is_still_running_counts_as_not_ended', async () => {
      const { event } = await makeEvent({ name: 'Running Now' });
      await db.query("update event_requests set proposed_start = now() - interval '1 hour', proposed_end = now() + interval '1 hour' where id = $1", [event]);
      expect(rowFor((await queue()).requests, event)).toBeDefined();
    });

    it('SCRUM284_AC2_an_event_with_no_equipment_request_is_not_listed', async () => {
      const event = (await one(
        "insert into event_requests (organiser_id, event_name, status, proposed_start, proposed_end) values ($1, 'No Equipment', 'approved', $2, $3) returning id",
        [organiser, day(10), plus(day(10), 2)],
      )).id;
      expect(rowFor((await queue(null, true)).requests, event)).toBeUndefined();
    });

    it('SCRUM284_AC2_an_event_with_a_live_and_a_newer_cancelled_request_is_one_row_for_the_live_one', async () => {
      const { event } = await makeEvent({ name: 'Live Then Cancelled' });
      await db.query(
        "insert into equipment_requests (event_request_id, status, created_at) values ($1, 'cancelled', now() + interval '1 hour')",
        [event],
      );
      const list = (await queue()).requests.filter((r) => r.event_request_id === event);
      expect(list).toHaveLength(1);
      expect(list[0].status).toBe('pending_review');
    });

    it('SCRUM284_AC2_an_event_with_a_cancelled_and_a_newer_live_request_is_one_row_for_the_live_one', async () => {
      const { event } = await makeEvent({ name: 'Cancelled Then Live' });
      await setStatus(event, 'cancelled');
      await db.query("insert into equipment_requests (event_request_id, status) values ($1, 'pending_review')", [event]);
      const list = (await queue()).requests.filter((r) => r.event_request_id === event);
      expect(list).toHaveLength(1);
      expect(list[0].status).toBe('pending_review');
    });

    it('SCRUM284_AC2_an_event_whose_only_request_is_cancelled_shows_it_as_cancelled', async () => {
      const { event } = await makeEvent({ name: 'Only Cancelled' });
      await setStatus(event, 'cancelled');
      const list = (await queue()).requests.filter((r) => r.event_request_id === event);
      expect(list).toHaveLength(1);
      expect(list[0].status).toBe('cancelled');
    });
  });


  describe('AC4: the Needs action section', () => {
    it('SCRUM284_AC4_a_pending_review_request_needs_action', async () => {
      const { event } = await makeEvent({ name: 'Needs Pending' });
      expect(rowFor((await queue()).needs_action, event)).toBeDefined();
    });

    it('SCRUM284_AC4_requests_that_need_nothing_are_left_out', async () => {
      const under = await makeEvent({ name: 'Quiet Under Review' });
      await startReview(under.event, sam);
      const arranged = await makeEvent({ name: 'Quiet Arranged' });
      await setStatus(arranged.event, 'arranged');
      const cannot = await makeEvent({ name: 'Quiet Cannot' });
      await setStatus(cannot.event, 'cannot_be_fully_arranged');
      const cancelled = await makeEvent({ name: 'Quiet Cancelled' });
      await setStatus(cancelled.event, 'cancelled');
      const needs = (await queue()).needs_action;
      for (const e of [under, arranged, cannot, cancelled]) expect(rowFor(needs, e.event)).toBeUndefined();
    });

    it.each(['rejected', 'draft', 'submitted', 'under_review', 'pending_clarification', 'completed'])(
      'SCRUM284_AC4_a_pending_request_on_a_%s_event_is_not_offered_for_action',
      async (eventStatus) => {
        // Lines can only be added while the event is Approved; the status moves on afterwards.
        const { event } = await makeEvent({ name: `Not reservable ${eventStatus}` });
        await db.query('update event_requests set status = $2::event_request_status where id = $1', [event, eventStatus]);
        const result = await queue();
        expect(rowFor(result.needs_action, event)).toBeUndefined();
        // It is still listed with every request, so it can be opened.
        expect(rowFor(result.requests, event)).toBeDefined();
      },
    );

    it('SCRUM284_AC4_a_flagged_request_on_a_rejected_event_is_not_offered_for_action', async () => {
      const { event, lineIds } = await makeEvent({ name: 'Flagged then rejected', start: day(15), end: plus(day(15), 2) });
      await startReview(event, sam);
      await db.query('select reserve_equipment($1, $2, $3, 2)', [event, sam, lineIds[0]]);
      await db.query('update event_requests set proposed_start = $2, proposed_end = $3 where id = $1', [event, day(16), plus(day(16), 2)]);
      expect(rowFor((await queue()).needs_action, event)).toBeDefined();

      await db.query("update event_requests set status = 'rejected' where id = $1", [event]);

      const result = await queue();
      expect(rowFor(result.needs_action, event)).toBeUndefined();
      expect(rowFor(result.requests, event)).toBeDefined();
    });

    it.each(['safety_review', 'safety_approved'])(
      'SCRUM284_AC4_a_pending_request_on_a_%s_event_needs_action',
      async (eventStatus) => {
        const { event } = await makeEvent({ name: `Safety pending ${eventStatus}` });
        await db.query('update event_requests set status = $2::event_request_status where id = $1', [event, eventStatus]);
        expect(rowFor((await queue()).needs_action, event)).toBeDefined();
      },
    );

    it('SCRUM284_AC4_a_flagged_reservation_on_a_safety_review_event_needs_action', async () => {
      const { event, lineIds } = await makeEvent({ name: 'Flagged in safety review', start: day(15), end: plus(day(15), 2) });
      await startReview(event, sam);
      await db.query('select reserve_equipment($1, $2, $3, 2)', [event, sam, lineIds[0]]);
      await db.query("update event_requests set status = 'safety_review' where id = $1", [event]);
      await db.query('update event_requests set proposed_start = $2, proposed_end = $3 where id = $1', [event, day(16), plus(day(16), 2)]);

      const row = rowFor((await queue()).needs_action, event);
      expect(row).toBeDefined();
      expect(row.flagged_count).toBe(1);
    });

    it('SCRUM284_AC4_a_pending_request_on_an_ended_event_still_needs_action', async () => {
      const { event } = await makeEvent({ name: 'Ended but unresolved' });
      await db.query("update event_requests set proposed_start = '2020-01-01T10:00:00Z', proposed_end = '2020-01-01T12:00:00Z' where id = $1", [event]);
      const result = await queue();
      expect(rowFor(result.needs_action, event)).toBeDefined();
      // AC2 still holds: the requests list leaves ended events out by default.
      expect(rowFor(result.requests, event)).toBeUndefined();
    });

    it('SCRUM284_AC4_the_past_events_option_does_not_change_needs_action', async () => {
      const { event } = await makeEvent({ name: 'Ended, option off and on' });
      await db.query("update event_requests set proposed_start = '2020-01-01T10:00:00Z', proposed_end = '2020-01-01T12:00:00Z' where id = $1", [event]);
      const without = await queue();
      const withPast = await queue(null, true);
      expect(withPast.needs_action).toEqual(without.needs_action);
      expect(withPast.needs_action_total).toBe(without.needs_action_total);
    });

    it('SCRUM284_AC4_a_confirmed_event_still_needs_action', async () => {
      const { event } = await makeEvent({ name: 'Confirmed and pending' });
      await db.query("update event_requests set status = 'confirmed' where id = $1", [event]);
      expect(rowFor((await queue()).needs_action, event)).toBeDefined();
    });

    it('SCRUM284_AC4_a_flagged_reservation_puts_the_request_there_with_its_reason', async () => {
      const { event, lineIds } = await makeEvent({ name: 'Flagged One', start: day(15), end: plus(day(15), 2) });
      await startReview(event, sam);
      await db.query('select reserve_equipment($1, $2, $3, 2)', [event, sam, lineIds[0]]);
      await db.query('update event_requests set proposed_start = $2, proposed_end = $3 where id = $1', [event, day(16), plus(day(16), 2)]);

      const row = rowFor((await queue()).needs_action, event);
      expect(row).toBeDefined();
      expect(row.flagged_count).toBe(1);
      expect(row.flag_reasons).toHaveLength(1);
      expect(row.flag_reasons[0]).toMatch(/\S/);
    });

    it('SCRUM284_AC4_a_flagged_request_is_still_there_when_the_status_filter_hides_its_status', async () => {
      const { event, lineIds } = await makeEvent({ name: 'Flagged Filtered Out', start: day(15), end: plus(day(15), 2) });
      await startReview(event, sam);
      await db.query('select reserve_equipment($1, $2, $3, 2)', [event, sam, lineIds[0]]);
      await db.query('update event_requests set proposed_start = $2, proposed_end = $3 where id = $1', [event, day(16), plus(day(16), 2)]);

      const result = await queue('arranged');
      expect(rowFor(result.requests, event)).toBeUndefined();
      expect(rowFor(result.needs_action, event)).toBeDefined();
    });

    it('SCRUM284_AC4_a_request_with_a_flag_on_one_of_two_reservations_counts_one', async () => {
      const { event, lineIds } = await makeEvent({ name: 'Two Reservations', lines: 2, start: day(15), end: plus(day(15), 2) });
      await startReview(event, sam);
      const state = asJson(await one('select equipment_review_for_event($1)::text as answer', [event]));
      for (const line of state.request.lines) {
        await db.query('select reserve_equipment($1, $2, $3, 1)', [event, sam, line.id]);
      }
      const [first] = (await db.query('select id from equipment_reservations where event_request_id = $1 order by id', [event])).rows;
      await db.query('update equipment_reservations set flagged = true, flag_reason = $2 where id = $1', [first.id, 'one only']);
      const row = rowFor((await queue()).needs_action, event);
      expect(row.flagged_count).toBe(1);
      expect(row.flag_reasons).toEqual(['one only']);
      expect(lineIds.length).toBeGreaterThan(0);
    });

    it('SCRUM284_AC4_a_released_flagged_reservation_no_longer_counts', async () => {
      const { event, lineIds } = await makeEvent({ name: 'Flag Then Release', start: day(15), end: plus(day(15), 2) });
      await startReview(event, sam);
      await db.query('select reserve_equipment($1, $2, $3, 2)', [event, sam, lineIds[0]]);
      await db.query('update event_requests set proposed_start = $2, proposed_end = $3 where id = $1', [event, day(16), plus(day(16), 2)]);
      await startReview(event, sam);
      const reservation = (await one('select id from equipment_reservations where event_request_id = $1', [event])).id;
      await db.query('select release_equipment_reservation($1, $2, $3, $4)', [event, sam, reservation, 'Not needed']);
      await setStatus(event, 'arranged');
      expect(rowFor((await queue()).needs_action, event)).toBeUndefined();
    });

    it('SCRUM284_AC4_an_unflagged_reservation_does_not_put_a_request_there', async () => {
      const { event, lineIds } = await makeEvent({ name: 'Reserved Quietly', start: day(15), end: plus(day(15), 2) });
      await startReview(event, sam);
      await db.query('select reserve_equipment($1, $2, $3, 2)', [event, sam, lineIds[0]]);
      const row = rowFor((await queue()).requests, event);
      expect(row.flagged_count).toBe(0);
      expect(row.flag_reasons).toEqual([]);
      expect(rowFor((await queue()).needs_action, event)).toBeUndefined();
    });

    it('SCRUM284_AC4_the_section_is_sorted_earliest_event_first', async () => {
      await makeEvent({ name: 'Need Late', start: day(28), end: plus(day(28), 2) });
      await makeEvent({ name: 'Need Early', start: day(26), end: plus(day(26), 2) });
      await makeEvent({ name: 'Need Middle', start: day(27), end: plus(day(27), 2) });
      const needs = names((await queue()).needs_action).filter((n) => n.startsWith('Need '));
      expect(needs).toEqual(['Need Early', 'Need Middle', 'Need Late']);
    });

    it('SCRUM284_AC4_the_same_request_is_in_both_lists_with_the_same_row', async () => {
      const { event } = await makeEvent({ name: 'Both Lists' });
      const result = await queue();
      expect(rowFor(result.needs_action, event)).toEqual(rowFor(result.requests, event));
    });
  });


  describe('the limit', () => {
    it('SCRUM284_AC2_each_list_is_cut_at_the_limit_and_says_so', async () => {
      for (let i = 0; i < 3; i += 1) await makeEvent({ name: `Capped ${i}` });
      const result = await queue(null, false, 2);
      expect(result.requests).toHaveLength(2);
      expect(result.requests_truncated).toBe(true);
      expect(result.needs_action).toHaveLength(2);
      expect(result.needs_action_truncated).toBe(true);
    });

    it('SCRUM284_AC4_the_totals_count_every_row_not_just_the_ones_returned', async () => {
      const all = await queue();
      const capped = await queue(null, false, 2);
      expect(capped.requests).toHaveLength(2);
      expect(capped.requests_total).toBe(all.requests.length);
      expect(capped.needs_action).toHaveLength(2);
      expect(capped.needs_action_total).toBe(all.needs_action.length);
      expect(capped.requests_total).toBeGreaterThan(2);
    });

    it('SCRUM284_AC4_the_totals_follow_the_filters_that_apply_to_each_list', async () => {
      const arranged = await queue('arranged');
      expect(arranged.requests_total).toBe(arranged.requests.length);
      // The status filter does not narrow Needs action, so its total is unchanged.
      expect(arranged.needs_action_total).toBe((await queue()).needs_action_total);
    });

    it('SCRUM284_AC2_the_cut_keeps_the_earliest_events', async () => {
      const all = (await queue()).requests;
      const capped = (await queue(null, false, 2)).requests;
      expect(capped.map((r) => r.event_request_id)).toEqual(all.slice(0, 2).map((r) => r.event_request_id));
    });

    it('SCRUM284_AC2_a_list_within_the_limit_is_not_marked_truncated', async () => {
      const result = await queue();
      expect(result.requests_truncated).toBe(false);
      expect(result.needs_action_truncated).toBe(false);
    });

    it('SCRUM284_AC2_a_limit_below_one_still_returns_a_row', async () => {
      expect((await queue(null, false, 0)).requests).toHaveLength(1);
    });
  });
});
