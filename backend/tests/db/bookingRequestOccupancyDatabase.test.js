/**
 * SCRUM-484 (Phase 1): create_booking_request checks the period through the
 * shared occupied period, run against a real Postgres.
 *
 * 033_venue_occupancy_callers.sql replaces 030's step 7 -- an inline raw block
 * query plus venue_block_booking_conflicts() -- with one call to
 * venue_occupancy_conflicts(p_venue_id, start, end, true) from 032. So:
 *   - the requested event is padded with the venue's setup and turnaround, as
 *     is every booking it is compared with (decision 1);
 *   - flagged_for_review bookings occupy, as well as approved ones
 *     (decision 2); pending and cancelled ones do not;
 *   - blocks stay raw, but the request's own setup or turnaround reaching
 *     into one is a conflict;
 *   - each conflict item gains occupied_starts_at, occupied_ends_at,
 *     setup_minutes and turnaround_minutes (AC7).
 * The text is pinned in venueOccupancyCallersMigration.test.js.
 *
 * Common fixture (the test-case doc's): venue V at 30/45, an approved booking
 * A on D 10:00-12:00, which occupies 09:30-12:45. The earliest a next event
 * may start is 13:15. Each test makes its own venue.
 *
 * Migrations: the same list as venueBlockOccupancyDatabase.test.js, through
 * 033, then 040 (SCRUM-491), whose create_booking_request is 033's with step
 * 7 also counting other events' active holds. Every case above the hold one
 * holds no venue, so each still tests 033's rule unchanged.
 *
 * Dates: D is the Singapore date 10 days from when the test runs, never
 * hard-coded. Instants are compared with getTime().
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
  '040_venue_holds.sql',
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

const SUITABLE = { suitable: true, criteria: [{ criterion: 'capacity', met: true }] };
const OCCUPIED_KEYS = ['occupied_starts_at', 'occupied_ends_at', 'setup_minutes', 'turnaround_minutes'];

describe('SCRUM-484: create_booking_request uses the occupied period (033)', () => {
  let db;
  let organiser;
  let coordinator;
  let counter = 0;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

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

  async function makeEvent(startsAt, endsAt) {
    counter += 1;
    const cols = {
      organiser_id: organiser,
      event_name: `Event ${counter}`,
      status: 'approved',
      proposed_start: startsAt,
      proposed_end: endsAt,
      expected_attendance: 150,
      submitted_at: new Date().toISOString(),
      assigned_coordinator_id: coordinator,
    };
    const keys = Object.keys(cols);
    return (
      await one(
        `insert into event_requests (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning id`,
        Object.values(cols),
      )
    ).id;
  }

  async function makeBlock(venueId, startsAt, endsAt, removed = false) {
    return (
      await one(
        `insert into venue_blocks (venue_id, starts_at, ends_at, reason, removed_at)
         values ($1, $2, $3, 'maintenance', ${removed ? 'now()' : 'null'}) returning id`,
        [venueId, startsAt, endsAt],
      )
    ).id;
  }

  /**
   * A booking on its own event. A flagged_for_review one needs a block and a
   * flag time (014's bookings_review_flag_paired); it points at a removed
   * block late on D, which occupies nothing.
   */
  async function makeBooking(venueId, status, startsAt, endsAt) {
    const eventId = await makeEvent(startsAt, endsAt);
    let reviewBlockId = null;
    if (status === 'flagged_for_review') {
      reviewBlockId = await makeBlock(venueId, at('22:00'), at('23:00'), true);
    }
    return (
      await one(
        `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status, review_block_id, flagged_at)
         values ($1, $2, $3, $4, $5, $6, ${reviewBlockId ? 'now()' : 'null'}) returning id`,
        [venueId, eventId, startsAt, endsAt, status, reviewBlockId],
      )
    ).id;
  }

  /** create_booking_request for a new event on startsAt-endsAt at venueId. */
  async function requestFor(venueId, startsAt, endsAt) {
    const eventId = await makeEvent(startsAt, endsAt);
    const row = await one(
      'select create_booking_request($1, $2, $3, null, null, $4::jsonb, false) as result',
      [eventId, venueId, coordinator, JSON.stringify(SUITABLE)],
    );
    return { eventId, result: row.result };
  }

  async function fixtureA(setup = 30, turnaround = 45) {
    const venueId = await makeVenue(setup, turnaround);
    const bookingId = await makeBooking(venueId, 'approved', at('10:00'), at('12:00'));
    return { venueId, bookingId };
  }

  const ids = (result) => (result.conflicts ?? []).map((c) => c.booking_id ?? c.block_id);

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
    organiser = (await one("insert into auth.users (email) values ('o@x') returning id")).id;
    coordinator = (await one("insert into auth.users (email) values ('c1@x') returning id")).id;
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('AC4/AC5: both periods padded, touching is clear', () => {
    it('SCRUM484_AC4_booking_request_worked_example_1314_refused_1315_created', async () => {
      const { venueId, bookingId } = await fixtureA();

      const eb = await requestFor(venueId, at('13:14'), at('14:00'));
      const ec = await requestFor(venueId, at('13:15'), at('14:00'));

      expect(eb.result.outcome).toBe('conflict');
      expect(ids(eb.result)).toEqual([bookingId]);
      expect(ec.result.outcome).toBe('created');
      expect(ec.result.booking.status).toBe('pending');
      expect(ec.result.booking.venue_id).toBe(venueId);
    });

    it('SCRUM484_AC5_booking_request_touching_setup_start_is_created', async () => {
      const { venueId } = await fixtureA();

      // 07:30-08:45 occupies 07:00-09:30, touching A's 09:30.
      const { result } = await requestFor(venueId, at('07:30'), at('08:45'));

      expect(result.outcome).toBe('created');
    });

    it('SCRUM484_AC5_booking_request_one_minute_into_setup_conflicts', async () => {
      const { venueId, bookingId } = await fixtureA();

      const { result } = await requestFor(venueId, at('07:30'), at('08:46'));

      expect(result.outcome).toBe('conflict');
      expect(ids(result)).toEqual([bookingId]);
    });

    it('SCRUM484_AC5_booking_request_at_zero_minutes_uses_the_plain_edge', async () => {
      const { venueId, bookingId } = await fixtureA(0, 0);

      const clear = await requestFor(venueId, at('12:00'), at('13:00'));
      const clash = await requestFor(venueId, at('11:59'), at('13:00'));

      expect(clear.result.outcome).toBe('created');
      expect(clash.result.outcome).toBe('conflict');
      expect(ids(clash.result)).toEqual([bookingId]);
    });
  });

  describe('decision 2: which bookings occupy', () => {
    it('SCRUM484_AC4_booking_request_counts_flagged_bookings', async () => {
      const venueId = await makeVenue(30, 45);
      const flaggedId = await makeBooking(venueId, 'flagged_for_review', at('10:00'), at('12:00'));

      const { result } = await requestFor(venueId, at('13:00'), at('14:00'));

      expect(result.outcome).toBe('conflict');
      expect(ids(result)).toEqual([flaggedId]);
      expect(result.conflicts[0].kind).toBe('booking');
    });

    it('SCRUM484_AC4_booking_request_ignores_pending_and_cancelled_bookings', async () => {
      const venueId = await makeVenue(30, 45);
      await makeBooking(venueId, 'pending', at('10:00'), at('12:00'));
      await makeBooking(venueId, 'cancelled', at('10:00'), at('12:00'));

      const { result } = await requestFor(venueId, at('11:00'), at('11:30'));

      expect(result.outcome).toBe('created');
    });
  });

  describe('blocks stay raw, but the request own padding counts', () => {
    it('SCRUM484_AC4_booking_request_setup_reaching_into_a_block_conflicts', async () => {
      const venueId = await makeVenue(30, 45);
      const blockId = await makeBlock(venueId, at('13:00'), at('14:00'));

      // 14:29 starts setting up at 13:59, a minute inside the block.
      const clash = await requestFor(venueId, at('14:29'), at('15:00'));
      // 14:30 starts setting up at 14:00, exactly when the block ends.
      const clear = await requestFor(venueId, at('14:30'), at('15:00'));

      expect(clash.result.outcome).toBe('conflict');
      expect(ids(clash.result)).toEqual([blockId]);
      expect(clash.result.conflicts[0].kind).toBe('block');
      expect(clear.result.outcome).toBe('created');
    });

    it('SCRUM484_AC4_booking_request_turnaround_reaching_into_a_block_conflicts', async () => {
      const venueId = await makeVenue(30, 45);
      const blockId = await makeBlock(venueId, at('13:00'), at('14:00'));

      // 12:15 + 45 = 13:00 touches; 12:16 + 45 = 13:01 overlaps.
      const clear = await requestFor(venueId, at('11:00'), at('12:15'));
      const clash = await requestFor(venueId, at('11:00'), at('12:16'));

      expect(clear.result.outcome).toBe('created');
      expect(clash.result.outcome).toBe('conflict');
      expect(ids(clash.result)).toEqual([blockId]);
    });

    it('SCRUM484_AC4_booking_request_ignores_a_removed_block', async () => {
      const venueId = await makeVenue(30, 45);
      await makeBlock(venueId, at('13:00'), at('14:00'), true);

      const { result } = await requestFor(venueId, at('13:00'), at('14:00'));

      expect(result.outcome).toBe('created');
    });
  });

  describe('AC7: conflict items carry the occupied period', () => {
    it('SCRUM484_AC7_booking_request_conflict_items_carry_the_four_occupied_fields', async () => {
      const { venueId, bookingId } = await fixtureA();
      const blockId = await makeBlock(venueId, at('13:00'), at('14:00'));

      // 12:30-13:30 occupies 12:00-14:15, which meets A's 09:30-12:45 and
      // the block 13:00-14:00.
      const { result } = await requestFor(venueId, at('12:30'), at('13:30'));

      expect(result.outcome).toBe('conflict');
      // 030's order is kept: blocks first, then bookings.
      expect(result.conflicts.map((c) => c.kind)).toEqual(['block', 'booking']);
      expect(ids(result)).toEqual([blockId, bookingId]);

      const [block, booking] = result.conflicts;
      for (const item of result.conflicts) {
        expect(Object.keys(item)).toEqual(expect.arrayContaining(OCCUPIED_KEYS));
      }

      // The booking: its own period, and its occupied period padded 30/45.
      expect(ms(booking.starts_at)).toBe(ms(at('10:00')));
      expect(ms(booking.ends_at)).toBe(ms(at('12:00')));
      expect(ms(booking.occupied_starts_at)).toBe(ms(at('09:30')));
      expect(ms(booking.occupied_ends_at)).toBe(ms(at('12:45')));
      expect(booking.setup_minutes).toBe(30);
      expect(booking.turnaround_minutes).toBe(45);

      // The block: never padded, so occupied equals its own period; the
      // minutes are the venue's, for the request's own padding.
      expect(ms(block.occupied_starts_at)).toBe(ms(at('13:00')));
      expect(ms(block.occupied_ends_at)).toBe(ms(at('14:00')));
      expect(ms(block.starts_at)).toBe(ms(at('13:00')));
      expect(ms(block.ends_at)).toBe(ms(at('14:00')));
      expect(block.setup_minutes).toBe(30);
      expect(block.turnaround_minutes).toBe(45);
    });

    it('SCRUM484_AC7_booking_request_conflict_writes_nothing', async () => {
      const { venueId } = await fixtureA();

      const { eventId, result } = await requestFor(venueId, at('13:14'), at('14:00'));

      expect(result.outcome).toBe('conflict');
      const row = await one('select count(*)::int as n from bookings where event_request_id = $1', [eventId]);
      expect(row.n).toBe(0);
    });
  });

  describe('SCRUM-491: another event\'s active hold conflicts like a booking', () => {
    it('SCRUM491_AC5_booking_request_over_another_events_hold_conflicts_with_its_period', async () => {
      const venueId = await makeVenue(30, 45);
      const holderId = await makeEvent(at('10:00'), at('12:00'));
      const holdId = (
        await one(
          `insert into venue_holds (event_request_id, venue_id, placed_by, expires_at)
           values ($1, $2, $3, now() + interval '1 hour') returning id`,
          [holderId, venueId, coordinator],
        )
      ).id;

      const clash = await requestFor(venueId, at('13:14'), at('14:00'));
      const clear = await requestFor(venueId, at('13:15'), at('14:00'));

      expect(clash.result.outcome).toBe('conflict');
      expect(clash.result.conflicts).toHaveLength(1);
      const [hold] = clash.result.conflicts;
      expect(hold.kind).toBe('hold');
      expect(hold.hold_id).toBe(holdId);
      expect(hold.event_request_id).toBe(holderId);
      expect(ms(hold.occupied_starts_at)).toBe(ms(at('09:30')));
      expect(ms(hold.occupied_ends_at)).toBe(ms(at('12:45')));
      expect(Object.keys(hold)).toEqual(expect.arrayContaining(OCCUPIED_KEYS));
      expect(clear.result.outcome).toBe('created');
    });
  });
});
