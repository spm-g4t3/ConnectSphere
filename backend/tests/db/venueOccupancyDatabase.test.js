/**
 * SCRUM-484 (sub-task 2): the shared occupied-period functions, run against a
 * real Postgres.
 *
 * venue_occupied_period() is the formula [start - setup, end + turnaround),
 * and venue_occupancy_conflicts() returns every booking and block occupying a
 * venue during a period. These tests call both against the final schema, so
 * the worked example (10:00-12:00 at 30/45 occupies 09:30-12:45), every
 * touching edge (AC5), the occupying statuses (AC4) and the venue's own
 * minutes (AC3) are exercised rather than read as text.
 *
 * Why PGlite: CI has no database, but PGlite is Postgres compiled to run
 * in-process, so tstzrange, '[)' bounds and && behave exactly as in Supabase.
 * No server or credentials are needed.
 *
 * Dates: fixed +08:00 instants on D = 2026-11-11. Nothing here reads now().
 * Instants are compared with getTime(), never as wall-clock strings.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedBlock, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor } from './helpers/queries.js';

/** An instant on D = 2026-11-11, written at +08:00 (Singapore). */
const at = (hhmm) => `2026-11-11T${hhmm}:00+08:00`;
/** The same day's instant, as epoch milliseconds. */
const ms = (iso) => new Date(iso).getTime();

describe('SCRUM-484: venue_occupied_period and venue_occupancy_conflicts in Postgres', () => {
  let db;
  let organiser;
  let coordinator;
  let counter = 0;

  const { one } = queriesFor(() => db);

  const makeVenue = (setup = 30, turnaround = 45) =>
    seedVenue(db, { name: `Hall ${++counter}`, setup, turnaround });

  async function setMinutes(venueId, setup, turnaround) {
    await db.query('update venues set setup_minutes = $2, turnaround_minutes = $3 where id = $1', [
      venueId,
      setup,
      turnaround,
    ]);
  }

  function makeEvent() {
    counter += 1;
    return seedEvent(db, {
      status: 'approved',
      organiser_id: organiser,
      assigned_coordinator_id: coordinator,
      event_name: `Event ${counter}`,
      proposed_start: at('10:00'),
      proposed_end: at('12:00'),
      expected_attendance: 150,
    });
  }

  async function makeBooking(venueId, status, startsAt, endsAt) {
    return seedBooking(db, { venueId, eventId: await makeEvent(), status, start: startsAt, end: endsAt });
  }

  const makeBlock = (venueId, startsAt, endsAt, removed = false) =>
    seedBlock(db, { venueId, start: startsAt, end: endsAt, removed });

  /** venue_occupied_period's range, as instants and bound flags. */
  async function period(startsAt, endsAt, setup, turnaround) {
    const row = await one(
      `select lower(r) as lo, upper(r) as hi, lower_inc(r) as lo_inc, upper_inc(r) as hi_inc
         from (select venue_occupied_period($1::timestamptz, $2::timestamptz, $3::integer, $4::integer) as r) s`,
      [startsAt, endsAt, setup, turnaround],
    );
    return { lo: new Date(row.lo).getTime(), hi: new Date(row.hi).getTime(), loInc: row.lo_inc, hiInc: row.hi_inc };
  }

  /** venue_occupancy_conflicts' rows. */
  async function conflicts(venueId, startsAt, endsAt, padRequested) {
    return (
      await db.query('select * from venue_occupancy_conflicts($1::uuid, $2::timestamptz, $3::timestamptz, $4::boolean)', [
        venueId,
        startsAt,
        endsAt,
        padRequested,
      ])
    ).rows;
  }

  /** The identifying columns of each row, with instants as epoch ms. */
  const pinned = (rows) =>
    rows.map((r) => ({
      kind: r.kind,
      id: r.id,
      occupied_starts_at: new Date(r.occupied_starts_at).getTime(),
      occupied_ends_at: new Date(r.occupied_ends_at).getTime(),
    }));

  /** The expected row for booking A (10:00-12:00 at 30/45): occupies 09:30-12:45. */
  const rowA = (id) => ({ kind: 'booking', id, occupied_starts_at: ms(at('09:30')), occupied_ends_at: ms(at('12:45')) });
  /** The expected row for block K (13:00-14:00): occupies its own period. */
  const rowK = (id) => ({ kind: 'block', id, occupied_starts_at: ms(at('13:00')), occupied_ends_at: ms(at('14:00')) });

  /** Fixture A: venue V at 30/45 with an approved booking 10:00-12:00 on D. */
  async function fixtureA(setup = 30, turnaround = 45) {
    const venueId = await makeVenue(setup, turnaround);
    const bookingId = await makeBooking(venueId, 'approved', at('10:00'), at('12:00'));
    return { venueId, bookingId };
  }

  /** Fixture K: venue V at 30/45, no bookings, an active block 13:00-14:00 on D. */
  async function fixtureK() {
    const venueId = await makeVenue(30, 45);
    const blockId = await makeBlock(venueId, at('13:00'), at('14:00'));
    return { venueId, blockId };
  }

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await seedUser(db, { email: 'o@x' });
    coordinator = await seedUser(db, { email: 'c@x' });
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('AC3: the occupied period', () => {
    it('SCRUM484_AC3_worked_example_10_to_12_with_30_and_45_occupies_0930_to_1245', async () => {
      expect(await period(at('10:00'), at('12:00'), 30, 45)).toEqual({
        lo: ms(at('09:30')),
        hi: ms(at('12:45')),
        loInc: true,
        hiInc: false,
      });
    });

    it('SCRUM484_AC3_zero_setup_and_turnaround_is_the_raw_period', async () => {
      expect(await period(at('10:00'), at('12:00'), 0, 0)).toEqual({
        lo: ms(at('10:00')),
        hi: ms(at('12:00')),
        loInc: true,
        hiInc: false,
      });
    });

    it('SCRUM484_AC3_setup_only_moves_the_start', async () => {
      const p = await period(at('10:00'), at('12:00'), 30, 0);
      expect([p.lo, p.hi]).toEqual([ms(at('09:30')), ms(at('12:00'))]);
    });

    it('SCRUM484_AC3_turnaround_only_moves_the_end', async () => {
      const p = await period(at('10:00'), at('12:00'), 0, 45);
      expect([p.lo, p.hi]).toEqual([ms(at('10:00')), ms(at('12:45'))]);
    });

    it('SCRUM484_AC3_largest_options_pad_two_hours_each_side', async () => {
      const p = await period(at('10:00'), at('12:00'), 120, 120);
      expect([p.lo, p.hi]).toEqual([ms(at('08:00')), ms(at('14:00'))]);
    });

    it('SCRUM484_AC3_setup_can_cross_midnight', async () => {
      const p = await period(at('00:30'), at('02:00'), 60, 0);
      expect(p.lo).toBe(ms('2026-11-10T23:30:00+08:00'));
      expect(p.hi).toBe(ms(at('02:00')));
    });

    it('SCRUM484_AC3_offset_written_does_not_change_the_period', async () => {
      const utc = await period('2026-11-11T02:00:00Z', '2026-11-11T04:00:00Z', 30, 45);
      const sgt = await period(at('10:00'), at('12:00'), 30, 45);
      expect(utc).toEqual(sgt);
      expect(utc.lo).toBe(ms(at('09:30')));
      expect(utc.hi).toBe(ms(at('12:45')));
    });

    it('SCRUM484_AC3_changing_the_venue_minutes_changes_the_answer', async () => {
      const { venueId, bookingId } = await fixtureA();

      expect(pinned(await conflicts(venueId, at('13:00'), at('14:00'), true))).toEqual([rowA(bookingId)]);

      await setMinutes(venueId, 0, 0);
      expect(await conflicts(venueId, at('13:00'), at('14:00'), true)).toEqual([]);
    });
  });

  describe('AC4: the occupying statuses', () => {
    it('SCRUM484_AC4_only_approved_and_flagged_bookings_occupy', async () => {
      const venueId = await makeVenue(30, 45);
      const ids = {};
      for (const status of ['approved', 'flagged_for_review', 'pending', 'rejected', 'withdrawn', 'cancelled']) {
        ids[status] = await makeBooking(venueId, status, at('10:30'), at('11:30'));
      }

      const rows = await conflicts(venueId, at('10:00'), at('12:00'), true);

      expect(rows.map((r) => r.status).sort()).toEqual(['approved', 'flagged_for_review']);
      expect(rows.map((r) => r.id).sort()).toEqual([ids.approved, ids.flagged_for_review].sort());
      for (const r of rows) {
        expect(r.kind).toBe('booking');
        expect(new Date(r.occupied_starts_at).getTime()).toBe(ms(at('10:00')));
        expect(new Date(r.occupied_ends_at).getTime()).toBe(ms(at('12:15')));
      }
    });
  });

  describe('AC5: booking vs booking (pad_requested true)', () => {
    it('SCRUM484_AC5_request_touching_turnaround_end_is_clear', async () => {
      const { venueId } = await fixtureA();
      expect(await conflicts(venueId, at('13:15'), at('14:00'), true)).toEqual([]);
    });

    it('SCRUM484_AC5_request_one_minute_into_turnaround_conflicts', async () => {
      const { venueId, bookingId } = await fixtureA();
      const rows = await conflicts(venueId, at('13:14'), at('14:00'), true);
      expect(pinned(rows)).toEqual([rowA(bookingId)]);
      expect(rows[0]).toMatchObject({ status: 'approved', reason: null, setup_minutes: 30, turnaround_minutes: 45 });
      expect(rows[0].event_name).toMatch(/^Event /);
      expect(new Date(rows[0].starts_at).getTime()).toBe(ms(at('10:00')));
      expect(new Date(rows[0].ends_at).getTime()).toBe(ms(at('12:00')));
    });

    it('SCRUM484_AC5_request_touching_setup_start_is_clear', async () => {
      const { venueId } = await fixtureA();
      expect(await conflicts(venueId, at('07:30'), at('08:45'), true)).toEqual([]);
    });

    it('SCRUM484_AC5_request_one_minute_into_setup_conflicts', async () => {
      const { venueId, bookingId } = await fixtureA();
      expect(pinned(await conflicts(venueId, at('07:30'), at('08:46'), true))).toEqual([rowA(bookingId)]);
    });

    it('SCRUM484_AC5_request_ending_0815_is_clear_with_a_gap', async () => {
      const { venueId } = await fixtureA();
      expect(await conflicts(venueId, at('07:00'), at('08:15'), true)).toEqual([]);
    });

    it('SCRUM484_AC5_zero_minutes_give_the_plain_edge_rule', async () => {
      const { venueId, bookingId } = await fixtureA(0, 0);
      expect(await conflicts(venueId, at('12:00'), at('13:00'), true)).toEqual([]);
      expect(await conflicts(venueId, at('08:00'), at('10:00'), true)).toEqual([]);
      expect(pinned(await conflicts(venueId, at('11:59'), at('13:00'), true))).toEqual([
        { kind: 'booking', id: bookingId, occupied_starts_at: ms(at('10:00')), occupied_ends_at: ms(at('12:00')) },
      ]);
    });
  });

  describe('AC5: block vs booking (pad_requested false, block raw)', () => {
    it('SCRUM484_AC5_block_touching_turnaround_end_is_clear', async () => {
      const { venueId } = await fixtureA();
      expect(await conflicts(venueId, at('12:45'), at('13:30'), false)).toEqual([]);
    });

    it('SCRUM484_AC5_block_touching_setup_start_is_clear', async () => {
      const { venueId } = await fixtureA();
      expect(await conflicts(venueId, at('08:00'), at('09:30'), false)).toEqual([]);
    });

    it('SCRUM484_AC5_block_one_minute_into_turnaround_conflicts', async () => {
      const { venueId, bookingId } = await fixtureA();
      expect(pinned(await conflicts(venueId, at('12:44'), at('13:30'), false))).toEqual([rowA(bookingId)]);
    });

    it('SCRUM484_AC5_block_one_minute_into_setup_conflicts', async () => {
      const { venueId, bookingId } = await fixtureA();
      expect(pinned(await conflicts(venueId, at('08:00'), at('09:31'), false))).toEqual([rowA(bookingId)]);
    });
  });

  describe('AC5: requested event vs block (block K, 13:00-14:00)', () => {
    it('SCRUM484_AC5_request_setup_touching_block_end_is_clear', async () => {
      const { venueId } = await fixtureK();
      expect(await conflicts(venueId, at('14:30'), at('15:00'), true)).toEqual([]);
    });

    it('SCRUM484_AC5_request_setup_one_minute_into_block_conflicts', async () => {
      const { venueId, blockId } = await fixtureK();
      const rows = await conflicts(venueId, at('14:29'), at('15:00'), true);
      expect(pinned(rows)).toEqual([rowK(blockId)]);
      // A block row carries the venue's minutes, and no booking fields.
      expect(rows[0]).toMatchObject({
        status: null,
        event_request_id: null,
        event_name: null,
        reason: 'maintenance',
        setup_minutes: 30,
        turnaround_minutes: 45,
      });
      expect(new Date(rows[0].starts_at).getTime()).toBe(ms(at('13:00')));
      expect(new Date(rows[0].ends_at).getTime()).toBe(ms(at('14:00')));
    });

    it('SCRUM484_AC5_request_turnaround_against_block_start_edge', async () => {
      const { venueId, blockId } = await fixtureK();
      expect(await conflicts(venueId, at('11:00'), at('12:15'), true)).toEqual([]);
      expect(pinned(await conflicts(venueId, at('11:00'), at('12:16'), true))).toEqual([rowK(blockId)]);
    });
  });

  describe('what else is and is not returned', () => {
    it('SCRUM484_AC4_removed_blocks_are_not_returned', async () => {
      const venueId = await makeVenue(30, 45);
      await makeBlock(venueId, at('13:00'), at('14:00'), true);
      expect(await conflicts(venueId, at('13:00'), at('14:00'), true)).toEqual([]);
      expect(await conflicts(venueId, at('13:00'), at('14:00'), false)).toEqual([]);
    });

    it('SCRUM484_AC3_unknown_venue_returns_no_rows', async () => {
      const missing = '00000000-0000-4000-8000-000000000000';
      expect(await conflicts(missing, at('10:00'), at('12:00'), true)).toEqual([]);
    });

    it('SCRUM484_AC4_bookings_and_blocks_come_back_together_in_occupied_order', async () => {
      const { venueId, bookingId } = await fixtureA();
      const blockId = await makeBlock(venueId, at('13:00'), at('14:00'));
      expect(pinned(await conflicts(venueId, at('09:00'), at('15:00'), false))).toEqual([
        rowA(bookingId),
        rowK(blockId),
      ]);
    });
  });

  describe('the index pre-filter never drops a real conflict', () => {
    it('SCRUM484_AC4_prefilter_keeps_a_conflict_reached_only_by_large_setup', async () => {
      // Booking 10:00-12:00 at 120/0 occupies [08:00, 12:00); a raw request
      // [07:00, 08:30) reaches it only through the booking's setup.
      const { venueId, bookingId } = await fixtureA(120, 0);
      expect(pinned(await conflicts(venueId, at('07:00'), at('08:30'), false))).toEqual([
        { kind: 'booking', id: bookingId, occupied_starts_at: ms(at('08:00')), occupied_ends_at: ms(at('12:00')) },
      ]);
    });

    it('SCRUM484_AC4_prefilter_keeps_a_conflict_reached_only_by_large_turnaround', async () => {
      // Booking 10:00-12:00 at 0/120 occupies [10:00, 14:00); a raw request
      // [13:30, 14:00) reaches it only through the booking's turnaround.
      const { venueId, bookingId } = await fixtureA(0, 120);
      expect(pinned(await conflicts(venueId, at('13:30'), at('14:00'), false))).toEqual([
        { kind: 'booking', id: bookingId, occupied_starts_at: ms(at('10:00')), occupied_ends_at: ms(at('14:00')) },
      ]);
    });
  });

  describe('the calendar window (sub-task 6)', () => {
    it('SCRUM484_AC4_calendar_window_includes_a_booking_by_its_setup', async () => {
      // B-AC4-14. venueCalendarService.readBookings asks
      // venue_occupancy_conflicts(venue, from, to, false) and keeps the
      // booking rows. Window 08:00-09:45 misses A's raw 10:00 start but meets
      // its 09:30 setup, so A is on the calendar; window 12:45-14:00 only
      // touches A's turnaround end, so nothing is.
      const { venueId, bookingId } = await fixtureA();
      const bookingsIn = async (from, to) =>
        (await conflicts(venueId, from, to, false)).filter((r) => r.kind === 'booking');

      expect(pinned(await bookingsIn(at('08:00'), at('09:45')))).toEqual([rowA(bookingId)]);
      expect(await bookingsIn(at('12:45'), at('14:00'))).toEqual([]);
    });
  });
});
