/**
 * SCRUM-491: tentative venue holds with an expiry, run against a real
 * Postgres.
 *
 * 040_venue_holds.sql adds venue_holds, place_venue_hold() and
 * process_venue_hold_expiry(), and makes a hold a third kind of row in the
 * shared venue_occupancy_conflicts() (032), with a fifth parameter that
 * leaves one event's holds out. create_booking_request and
 * available_venue_ids() pass the requesting event through it, so an event's
 * own hold never blocks its own request or search. These tests call the
 * real functions.
 *
 * Acceptance criteria carried in the test names:
 *   AC1  only Venue Staff can place a hold
 *   AC2  one Approved event, one venue; placer, time and a future expiry
 *   AC3  several venues per event, one active hold per (event, venue)
 *   AC4  no hold over an occupying booking, a block or another event's hold;
 *        the conflict comes back with its period
 *   AC5  a hold blocks other events' requests and search, not its own
 *   AC6  (the calendar's read) hold rows carry the holding event's name
 *   AC7  a lapsed hold occupies nothing at once, job or no job
 *   AC8  the expiry notifies the assigned coordinator once
 *
 * Fixture: each test makes its own venue (30 minutes setup, 45 turnaround)
 * and events, so no test sees another's rows. D is the Singapore date 10
 * days from now; instants are compared with getTime(), never as strings.
 *
 * Migrations: setupChangeRecheckDatabase.test.js's list, plus 036 (the
 * latest update_venue, which must still ignore holds), 040, and 051
 * (SCRUM-525), which redefines create_booking_request with 040's step 7 and
 * an 8th argument, the request's expected attendance.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name) => readFileSync(resolve(here, '../../db/migrations', name), 'utf8');

const MIGRATIONS = [
  '001_event_requests.sql',
  '005_event_request_details.sql',
  '007_user_roles.sql',
  '010_event_request_clarifications.sql',
  'STAND_IN',
  '014_coordinator_assignment.sql',
  '002_venues.sql',
  '003_venue_audit.sql',
  '004_venue_functions.sql',
  '005_venue_retirement.sql',
  '008_venue_audit_completion.sql',
  '009_bookings.sql',
  '011_venue_blocks.sql',
  '012_venue_block_creation.sql',
  '013_venue_block_booking_conflicts.sql',
  '014_booking_review_notifications.sql',
  '015_venue_block_amend_remove.sql',
  '017_venue_turnaround.sql',
  '023_venue_setup_time.sql',
  '027_booking_request_statuses.sql',
  '028_booking_status_default_pending.sql',
  '030_create_booking_request.sql',
  '031_withdraw_booking_request.sql',
  '032_venue_occupancy.sql',
  '033_venue_occupancy_callers.sql',
  '034_setup_change_recheck.sql',
  '035_setup_change_recheck_refine.sql',
  '036_venue_safety_facts.sql',
  '040_venue_holds.sql',
  '051_multi_venue_booking_requests.sql',
];

/** What 014 reads from SCRUM-19's migration, which is not on this branch. */
const DECISION_STAND_IN = `
  alter table event_requests
    add column if not exists reviewing_coordinator_id uuid references auth.users (id);
`;

/** D: the Singapore date 10 days from now, as YYYY-MM-DD. */
const D = new Date(Date.now() + 8 * 3600_000 + 10 * 86_400_000).toISOString().slice(0, 10);
/** An instant on D, written at +08:00 (Singapore). */
const at = (hhmm) => `${D}T${hhmm}:00+08:00`;
const ms = (value) => new Date(value).getTime();
/** An instant `minutes` from now (negative: in the past). */
const fromNow = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();

const SUITABLE = { suitable: true, criteria: [{ criterion: 'capacity', met: true }] };

describe('SCRUM-491: tentative venue holds (040)', () => {
  let db;
  let organiser;
  let staff;
  let coordinator;
  let counter = 0;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const rows = async (sql, params) => (await db.query(sql, params)).rows;

  async function makeUser(role) {
    counter += 1;
    const id = (await one('insert into auth.users (email) values ($1) returning id', [`u${counter}@x`])).id;
    if (role) await db.query('insert into profiles (id, role) values ($1, $2)', [id, role]);
    return id;
  }

  async function makeVenue(setup = 30, turnaround = 45) {
    counter += 1;
    return (
      await one(
        `insert into venues (name, location, max_capacity, setup_minutes, turnaround_minutes)
         values ($1, 'Block A', 200, $2, $3) returning id`,
        [`Harbour Room ${counter}`, setup, turnaround],
      )
    ).id;
  }

  async function makeEvent(startsAt, endsAt, { status = 'approved', coordinatorId = coordinator } = {}) {
    counter += 1;
    return (
      await one(
        `insert into event_requests
           (organiser_id, event_name, status, proposed_start, proposed_end,
            expected_attendance, submitted_at, assigned_coordinator_id)
         values ($1, $2, $3, $4, $5, 150, now(), $6) returning id`,
        [organiser, `Event ${counter}`, status, startsAt, endsAt, coordinatorId],
      )
    ).id;
  }

  async function makeBlock(venueId, startsAt, endsAt) {
    return (
      await one(
        `insert into venue_blocks (venue_id, starts_at, ends_at, reason)
         values ($1, $2, $3, 'maintenance') returning id`,
        [venueId, startsAt, endsAt],
      )
    ).id;
  }

  async function makeBooking(venueId, startsAt, endsAt, coordinatorId = coordinator) {
    const eventId = await makeEvent(startsAt, endsAt, { coordinatorId });
    const id = (
      await one(
        `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
         values ($1, $2, $3, $4, 'approved') returning id`,
        [venueId, eventId, startsAt, endsAt],
      )
    ).id;
    return { id, eventId };
  }

  /** place_venue_hold's jsonb, or the error it raised. */
  async function place(eventId, venueId, expiresAt = fromNow(120), placedBy = staff) {
    try {
      return (
        await one('select place_venue_hold($1, $2, $3, $4) as result', [eventId, venueId, expiresAt, placedBy])
      ).result;
    } catch (error) {
      return { error };
    }
  }

  /** A hold written directly, so a lapsed-but-active one can exist. */
  async function insertHold(eventId, venueId, { placedAt = fromNow(-120), expiresAt = fromNow(-5) } = {}) {
    return (
      await one(
        `insert into venue_holds (event_request_id, venue_id, placed_by, placed_at, expires_at)
         values ($1, $2, $3, $4, $5) returning id`,
        [eventId, venueId, staff, placedAt, expiresAt],
      )
    ).id;
  }

  async function requestBooking(eventId, venueId) {
    return (
      await one(
        'select create_booking_request($1, $2, $3, null, null, $4::jsonb, false, $5) as result',
        [eventId, venueId, coordinator, JSON.stringify(SUITABLE), 150],
      )
    ).result;
  }

  async function freeVenues(venueIds, startsAt, endsAt, excludeEventId = null) {
    return (
      await rows('select venue_id from available_venue_ids($1::uuid[], $2, $3, $4)', [
        venueIds,
        startsAt,
        endsAt,
        excludeEventId,
      ])
    ).map((r) => r.venue_id);
  }

  beforeAll(async () => {
    db = new PGlite({ extensions: { btree_gist } });
    await db.exec(`
      create schema auth;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text);
      create role anon;
      create role authenticated;
    `);
    for (const name of MIGRATIONS) {
      await db.exec(name === 'STAND_IN' ? DECISION_STAND_IN : migration(name));
    }
    organiser = await makeUser('event_organiser');
    staff = await makeUser('venue_staff');
    coordinator = await makeUser('event_coordinator');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('AC1/AC2: who, what and when', () => {
    it('SCRUM491_AC2_a_hold_records_event_venue_placer_time_and_expiry', async () => {
      const venueId = await makeVenue();
      const eventId = await makeEvent(at('10:00'), at('12:00'));
      const expiresAt = fromNow(90);

      const result = await place(eventId, venueId, expiresAt);

      expect(result.outcome).toBe('placed');
      const hold = result.hold;
      expect(hold.event_request_id).toBe(eventId);
      expect(hold.venue_id).toBe(venueId);
      expect(hold.placed_by).toBe(staff);
      expect(hold.placed_at).toBeTruthy();
      expect(ms(hold.expires_at)).toBe(ms(expiresAt));
      expect(hold.status).toBe('active');
      expect(hold.expired_at).toBeNull();
    });

    it('SCRUM491_AC1_only_venue_staff_can_place_a_hold', async () => {
      const venueId = await makeVenue();
      const eventId = await makeEvent(at('10:00'), at('12:00'));

      for (const placer of [coordinator, organiser, await makeUser(null), null]) {
        const { error } = await place(eventId, venueId, fromNow(60), placer);
        expect(error?.code).toBe('42501');
      }
      expect((await one('select count(*)::int as n from venue_holds where venue_id = $1', [venueId])).n).toBe(0);
    });

    it('SCRUM491_AC2_only_an_approved_event_can_be_held', async () => {
      const venueId = await makeVenue();
      for (const status of ['submitted', 'under_review', 'confirmed', 'rejected']) {
        const eventId = await makeEvent(at('10:00'), at('12:00'), { status });
        const { error } = await place(eventId, venueId);
        expect(error?.code, status).toBe('PT409');
        expect(error?.hint, status).toBe('EVENT_NOT_APPROVED');
      }
    });

    it('SCRUM491_AC2_an_event_without_dates_cannot_be_held', async () => {
      const venueId = await makeVenue();
      const eventId = await makeEvent(null, null);

      const { error } = await place(eventId, venueId);

      expect(error?.hint).toBe('EVENT_DATES_MISSING');
    });

    it('SCRUM491_AC2_expiry_is_required_and_in_the_future', async () => {
      const venueId = await makeVenue();
      const eventId = await makeEvent(at('10:00'), at('12:00'));

      expect((await place(eventId, venueId, null)).error?.code).toBe('22023');
      expect((await place(eventId, venueId, fromNow(-1))).error?.code).toBe('22023');
    });

    it('SCRUM491_AC4_a_retired_venue_cannot_be_held', async () => {
      const venueId = await makeVenue();
      await db.query('update venues set retired_at = now() where id = $1', [venueId]);
      const eventId = await makeEvent(at('10:00'), at('12:00'));

      const { error } = await place(eventId, venueId);

      expect(error?.hint).toBe('VENUE_RETIRED');
    });

    it('SCRUM491_AC2_a_missing_event_or_venue_is_not_found', async () => {
      const venueId = await makeVenue();
      const eventId = await makeEvent(at('10:00'), at('12:00'));
      const missing = '00000000-0000-4000-8000-000000000000';

      expect((await place(missing, venueId)).error?.code).toBe('P0002');
      expect((await place(eventId, missing)).error?.code).toBe('P0002');
    });
  });

  describe('AC3: one active hold per event at each venue', () => {
    it('SCRUM491_AC3_a_second_hold_for_the_same_event_and_venue_is_refused', async () => {
      const venueId = await makeVenue();
      const eventId = await makeEvent(at('10:00'), at('12:00'));
      const first = await place(eventId, venueId);

      const { error } = await place(eventId, venueId);

      expect(error?.hint).toBe('HOLD_EXISTS');
      expect(error?.detail).toBe(first.hold.id);
    });

    it('SCRUM491_AC3_one_event_can_hold_two_venues', async () => {
      const eventId = await makeEvent(at('10:00'), at('12:00'));

      const a = await place(eventId, await makeVenue());
      const b = await place(eventId, await makeVenue());

      expect(a.outcome).toBe('placed');
      expect(b.outcome).toBe('placed');
    });

    it('SCRUM491_AC3_two_events_can_hold_one_venue_at_different_times', async () => {
      const venueId = await makeVenue();
      // 10:00-12:00 occupies 09:30-12:45; 13:15 sets up from 12:45, touching.
      const first = await place(await makeEvent(at('10:00'), at('12:00')), venueId);
      const second = await place(await makeEvent(at('13:15'), at('14:00')), venueId);

      expect(first.outcome).toBe('placed');
      expect(second.outcome).toBe('placed');
    });

    it('SCRUM491_AC3_a_lapsed_hold_does_not_stop_a_new_one_for_the_same_pair', async () => {
      const venueId = await makeVenue();
      const eventId = await makeEvent(at('10:00'), at('12:00'));
      const lapsed = await insertHold(eventId, venueId);

      const result = await place(eventId, venueId);

      expect(result.outcome).toBe('placed');
      const old = await one('select status, expired_at from venue_holds where id = $1', [lapsed]);
      expect(old.status).toBe('expired');
      expect(old.expired_at).not.toBeNull();
    });
  });

  describe('AC4: conflicts, each with its period', () => {
    it('SCRUM491_AC4_a_hold_over_an_approved_booking_is_refused_with_its_period', async () => {
      const venueId = await makeVenue();
      const booking = await makeBooking(venueId, at('10:00'), at('12:00'));
      const eventId = await makeEvent(at('13:14'), at('14:00'));

      const result = await place(eventId, venueId);

      expect(result.outcome).toBe('conflict');
      expect(result.conflicts).toHaveLength(1);
      const [c] = result.conflicts;
      expect(c.kind).toBe('booking');
      expect(c.booking_id).toBe(booking.id);
      expect(ms(c.occupied_starts_at)).toBe(ms(at('09:30')));
      expect(ms(c.occupied_ends_at)).toBe(ms(at('12:45')));
      expect((await one('select count(*)::int as n from venue_holds where venue_id = $1', [venueId])).n).toBe(0);
    });

    it('SCRUM491_AC4_periods_that_only_touch_do_not_conflict', async () => {
      const venueId = await makeVenue();
      await makeBooking(venueId, at('10:00'), at('12:00'));

      const result = await place(await makeEvent(at('13:15'), at('14:00')), venueId);

      expect(result.outcome).toBe('placed');
    });

    it('SCRUM491_AC4_a_hold_over_a_block_is_refused_with_its_period', async () => {
      const venueId = await makeVenue();
      const blockId = await makeBlock(venueId, at('13:00'), at('14:00'));

      const result = await place(await makeEvent(at('14:29'), at('15:00')), venueId);

      expect(result.outcome).toBe('conflict');
      expect(result.conflicts[0].kind).toBe('block');
      expect(result.conflicts[0].block_id).toBe(blockId);
      expect(ms(result.conflicts[0].starts_at)).toBe(ms(at('13:00')));
      expect(ms(result.conflicts[0].ends_at)).toBe(ms(at('14:00')));
    });

    it('SCRUM491_AC4_a_hold_over_another_events_hold_is_refused_naming_it', async () => {
      const venueId = await makeVenue();
      const holderId = await makeEvent(at('10:00'), at('12:00'));
      const held = await place(holderId, venueId);

      const result = await place(await makeEvent(at('11:00'), at('11:30')), venueId);

      expect(result.outcome).toBe('conflict');
      const [c] = result.conflicts;
      expect(c.kind).toBe('hold');
      expect(c.hold_id).toBe(held.hold.id);
      expect(c.event_request_id).toBe(holderId);
      expect(c.event_name).toMatch(/^Event /);
      expect(ms(c.occupied_starts_at)).toBe(ms(at('09:30')));
      expect(ms(c.occupied_ends_at)).toBe(ms(at('12:45')));
    });
  });

  describe('AC5: other events are blocked, the holder is not', () => {
    it('SCRUM491_AC5_another_events_booking_request_is_refused_by_the_hold', async () => {
      const venueId = await makeVenue();
      const held = await place(await makeEvent(at('10:00'), at('12:00')), venueId);

      const result = await requestBooking(await makeEvent(at('11:00'), at('11:30')), venueId);

      expect(result.outcome).toBe('conflict');
      expect(result.conflicts.map((c) => c.kind)).toEqual(['hold']);
      expect(result.conflicts[0].hold_id).toBe(held.hold.id);
    });

    it('SCRUM491_AC5_the_holding_events_own_request_is_not_blocked', async () => {
      const venueId = await makeVenue();
      const eventId = await makeEvent(at('10:00'), at('12:00'));
      await place(eventId, venueId);

      const result = await requestBooking(eventId, venueId);

      expect(result.outcome).toBe('created');
    });

    it('SCRUM491_AC5_search_hides_a_held_venue_except_from_the_holder', async () => {
      const venueId = await makeVenue();
      const eventId = await makeEvent(at('10:00'), at('12:00'));
      await place(eventId, venueId);

      expect(await freeVenues([venueId], at('11:00'), at('11:30'))).toEqual([]);
      expect(await freeVenues([venueId], at('11:00'), at('11:30'), eventId)).toEqual([venueId]);
    });

    it('SCRUM491_AC5_conflicts_keep_blocks_then_bookings_then_holds', async () => {
      const venueId = await makeVenue(0, 0);
      const holdId = (await place(await makeEvent(at('09:00'), at('10:00')), venueId)).hold.id;
      const booking = await makeBooking(venueId, at('10:00'), at('11:00'));
      const blockId = await makeBlock(venueId, at('11:00'), at('12:00'));

      const result = await requestBooking(await makeEvent(at('09:00'), at('12:00')), venueId);

      expect(result.conflicts.map((c) => c.kind)).toEqual(['block', 'booking', 'hold']);
      expect(result.conflicts.map((c) => c.block_id ?? c.booking_id ?? c.hold_id)).toEqual([
        blockId,
        booking.id,
        holdId,
      ]);
    });
  });

  describe('AC6: the shared read names the holding event', () => {
    it('SCRUM491_AC6_conflicts_return_hold_rows_with_the_event_name', async () => {
      const venueId = await makeVenue();
      const eventId = await makeEvent(at('10:00'), at('12:00'));
      const held = await place(eventId, venueId);
      const name = (await one('select event_name from event_requests where id = $1', [eventId])).event_name;

      const found = await rows(
        `select * from venue_occupancy_conflicts($1, $2, $3, false)`,
        [venueId, `${D}T00:00:00+08:00`, `${D}T23:59:00+08:00`],
      );

      expect(found).toHaveLength(1);
      expect(found[0].kind).toBe('hold');
      expect(found[0].id).toBe(held.hold.id);
      expect(found[0].event_name).toBe(name);
      expect(ms(found[0].starts_at)).toBe(ms(at('10:00')));
      expect(ms(found[0].occupied_ends_at)).toBe(ms(at('12:45')));
    });
  });

  describe('AC7: a lapsed hold occupies nothing, at once', () => {
    it('SCRUM491_AC7_a_lapsed_active_hold_is_ignored_by_placing_requests_and_search', async () => {
      const venueId = await makeVenue();
      await insertHold(await makeEvent(at('10:00'), at('12:00')), venueId);

      expect(await freeVenues([venueId], at('11:00'), at('11:30'))).toEqual([venueId]);
      expect((await requestBooking(await makeEvent(at('11:00'), at('11:30')), venueId)).outcome).toBe('created');
    });

    it('SCRUM491_AC7_a_lapsed_hold_does_not_block_a_new_hold', async () => {
      const venueId = await makeVenue();
      await insertHold(await makeEvent(at('10:00'), at('12:00')), venueId);

      const result = await place(await makeEvent(at('11:00'), at('11:30')), venueId);

      expect(result.outcome).toBe('placed');
    });

    it('SCRUM491_AC7_an_expired_hold_is_never_a_booking', async () => {
      const venueId = await makeVenue();
      const eventId = await makeEvent(at('10:00'), at('12:00'));
      await insertHold(eventId, venueId);

      await one('select process_venue_hold_expiry() as n');

      expect((await one('select count(*)::int as n from bookings where event_request_id = $1', [eventId])).n).toBe(0);
    });
  });

  describe('AC8: the expiry job', () => {
    it('SCRUM491_AC8_expiry_runs_twice_expires_once_and_notifies_once', async () => {
      const venueId = await makeVenue();
      const coordinatorId = await makeUser('event_coordinator');
      const eventId = await makeEvent(at('10:00'), at('12:00'), { coordinatorId });
      const expiresAt = fromNow(-5);
      const holdId = await insertHold(eventId, venueId, { expiresAt });

      const first = (await one('select process_venue_hold_expiry() as n')).n;
      const second = (await one('select process_venue_hold_expiry() as n')).n;

      expect(first).toBeGreaterThanOrEqual(1);
      expect(second).toBe(0);
      const hold = await one('select status, expired_at from venue_holds where id = $1', [holdId]);
      expect(hold.status).toBe('expired');
      expect(hold.expired_at).not.toBeNull();

      const notes = await rows('select * from notifications where venue_hold_id = $1', [holdId]);
      expect(notes).toHaveLength(1);
      expect(notes[0].recipient_id).toBe(coordinatorId);
      expect(notes[0].type).toBe('venue_hold_expired');
      const venueName = (await one('select name from venues where id = $1', [venueId])).name;
      const eventName = (await one('select event_name from event_requests where id = $1', [eventId])).event_name;
      expect(notes[0].payload).toMatchObject({ eventName, venueName, eventRequestId: eventId, venueId });
      expect(ms(notes[0].payload.expiresAt)).toBe(ms(expiresAt));
    });

    it('SCRUM491_AC8_no_coordinator_means_expired_but_no_notice', async () => {
      const venueId = await makeVenue();
      const eventId = await makeEvent(at('10:00'), at('12:00'), { coordinatorId: null });
      const holdId = await insertHold(eventId, venueId);

      await one('select process_venue_hold_expiry() as n');

      expect((await one('select status from venue_holds where id = $1', [holdId])).status).toBe('expired');
      expect(await rows('select id from notifications where venue_hold_id = $1', [holdId])).toEqual([]);
    });

    it('SCRUM491_AC8_an_unexpired_hold_is_left_alone', async () => {
      const venueId = await makeVenue();
      const held = await place(await makeEvent(at('10:00'), at('12:00')), venueId);

      await one('select process_venue_hold_expiry() as n');

      expect((await one('select status from venue_holds where id = $1', [held.hold.id])).status).toBe('active');
    });

    it('SCRUM491_AC8_a_hold_expired_notice_needs_a_hold', async () => {
      await expect(
        db.query("insert into notifications (recipient_id, type) values ($1, 'venue_hold_expired')", [coordinator]),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('holds do not change the block and setup-change writers', () => {
    it('SCRUM491_AC4_a_block_over_a_hold_succeeds_and_lists_no_holds', async () => {
      const venueId = await makeVenue();
      await place(await makeEvent(at('10:00'), at('12:00')), venueId);

      const result = (
        await one(
          `select create_venue_block($1, $2, $3, 'maintenance', null, $4, false, null) as result`,
          [venueId, at('10:30'), at('11:30'), staff],
        )
      ).result;

      expect(result.outcome).toBe('created');
      expect(result.affected_bookings).toEqual([]);
      expect(result.flagged_bookings).toEqual([]);
    });

    it('SCRUM491_AC4_a_setup_change_flags_nothing_because_of_a_hold', async () => {
      const venueId = await makeVenue(0, 0);
      const booking = await makeBooking(venueId, at('10:00'), at('12:00'));
      await place(await makeEvent(at('12:30'), at('13:00')), venueId);

      const result = (
        await one('select update_venue(p_id => $1, p_setup_minutes => 0, p_turnaround_minutes => 45, p_user_id => $2) as result', [
          venueId,
          staff,
        ])
      ).result;

      expect(result.flagged_bookings).toEqual([]);
      expect((await one('select status from bookings where id = $1', [booking.id])).status).toBe('approved');
    });
  });

  describe('one version of each function', () => {
    it('SCRUM491_AC5_pg_proc_has_one_version_of_each_and_four_argument_calls_work', async () => {
      for (const name of ['venue_occupancy_conflicts', 'available_venue_ids', 'create_booking_request', 'place_venue_hold']) {
        const { n } = await one('select count(*)::int as n from pg_proc where proname = $1', [name]);
        expect(n, name).toBe(1);
      }
      const venueId = await makeVenue();
      await expect(
        rows('select * from venue_occupancy_conflicts($1, $2, $3, true)', [venueId, at('10:00'), at('11:00')]),
      ).resolves.toEqual([]);
      await expect(freeVenues([venueId], at('10:00'), at('11:00'))).resolves.toEqual([venueId]);
    });

    it('SCRUM491_AC1_execute_is_revoked_on_the_writers', async () => {
      for (const signature of [
        'place_venue_hold(uuid, uuid, timestamptz, uuid)',
        'process_venue_hold_expiry()',
      ]) {
        for (const role of ['anon', 'authenticated']) {
          const { allowed } = await one(`select has_function_privilege($1, $2, 'execute') as allowed`, [role, signature]);
          expect(allowed, `${role} ${signature}`).toBe(false);
        }
      }
    });
  });
});
