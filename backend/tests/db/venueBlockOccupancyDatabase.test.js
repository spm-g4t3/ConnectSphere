/**
 * SCRUM-484 (Phase 1): the venue block writers decide overlap through the
 * shared occupied period, run against a real Postgres.
 *
 * create_venue_block, update_venue_block and flag_bookings_for_block treat a
 * booking as overlapping a block when the booking's OCCUPIED period -- padded
 * with the venue's setup and turnaround -- meets the block's own, unpadded
 * period (AC6), through venue_occupancy_conflicts(..., false). These tests
 * call the real functions on the final schema, so the worked example's edges
 * (AC5), the block's stored period, the override flag and the conflict JSON
 * (AC7) are exercised, not read as text.
 *
 * Common fixture (the test-case doc's): venue V at 30/45, an approved booking
 * A on D 10:00-12:00, which occupies 09:30-12:45. Each test makes its own
 * venue, so no test sees another's rows.
 *
 * Dates: the block writers refuse a block that has already ended (now()), so
 * D is the Singapore date 10 days from when the test runs, never hard-coded.
 * Instants are compared with getTime(), never as wall-clock strings.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedBlock, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor } from './helpers/queries.js';
import { at } from '../fixtures/time.js';

const ms = (value) => new Date(value).getTime();

describe('SCRUM-484: venue block writers use the occupied period', () => {
  let db;
  let organiser;
  let staff;
  let coordinator;
  let counter = 0;

  const { one } = queriesFor(() => db);

  const makeVenue = (setup = 30, turnaround = 45) =>
    seedVenue(db, { name: `Harbour Room ${++counter}`, setup, turnaround });

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

  /** A raw block row, inserted directly (not through create_venue_block). */
  const insertBlock = (venueId, startsAt, endsAt, removed = false) =>
    seedBlock(db, { venueId, start: startsAt, end: endsAt, removed });

  /**
   * A booking. A flagged_for_review one needs a block and a flag time
   * (bookings_review_flag_paired); it points at a removed block on the
   * same venue, far from D's events, so that block occupies nothing.
   */
  async function makeBooking(venueId, status, startsAt, endsAt) {
    const eventId = await makeEvent();
    let reviewBlockId = null;
    if (status === 'flagged_for_review') {
      reviewBlockId = await insertBlock(venueId, at('22:00'), at('23:00'), true);
    }
    return seedBooking(db, { venueId, eventId, status, start: startsAt, end: endsAt, reviewBlockId });
  }

  async function fixtureA(setup = 30, turnaround = 45) {
    const venueId = await makeVenue(setup, turnaround);
    const bookingId = await makeBooking(venueId, 'approved', at('10:00'), at('12:00'));
    return { venueId, bookingId };
  }

  async function createBlock(venueId, startsAt, endsAt, { confirm = false, acknowledged = null } = {}) {
    return (
      await one(
        `select create_venue_block($1, $2, $3, 'maintenance', null, $4, $5, $6::uuid[]) as result`,
        [venueId, startsAt, endsAt, staff, confirm, acknowledged],
      )
    ).result;
  }

  async function updateBlock(venueId, blockId, startsAt, endsAt, { confirm = false, acknowledged = null } = {}) {
    return (
      await one(
        `select update_venue_block($1, $2, $3, $4, null, null, false, $5, $6, $7::uuid[]) as result`,
        [venueId, blockId, startsAt, endsAt, staff, confirm, acknowledged],
      )
    ).result;
  }

  const bookingRow = async (id) => one('select * from bookings where id = $1', [id]);
  const blocksOn = async (venueId) =>
    (await db.query('select * from venue_blocks where venue_id = $1 and removed_at is null order by starts_at', [venueId]))
      .rows;
  const conflictIds = (result) => (result.conflicts ?? []).map((c) => c.booking_id);

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await seedUser(db, { email: 'o@x' });
    staff = await seedUser(db, { email: 's@x', role: 'venue_staff' });
    coordinator = await seedUser(db, { email: 'c1@x', role: 'event_coordinator' });
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('AC6: a block meets a booking by the booking occupied period', () => {
    it('SCRUM484_AC6_block_inside_setup_conflicts', async () => {
      const { venueId, bookingId } = await fixtureA();

      const result = await createBlock(venueId, at('09:30'), at('10:00'));

      expect(result.outcome).toBe('conflict');
      expect(conflictIds(result)).toEqual([bookingId]);
      expect(await blocksOn(venueId)).toEqual([]);
    });

    it('SCRUM484_AC6_block_inside_turnaround_conflicts', async () => {
      const { venueId, bookingId } = await fixtureA();

      const result = await createBlock(venueId, at('12:00'), at('12:45'));

      expect(result.outcome).toBe('conflict');
      expect(conflictIds(result)).toEqual([bookingId]);
      expect(await blocksOn(venueId)).toEqual([]);
    });

    it('SCRUM484_AC6_block_touching_padded_end_is_created_without_conflict', async () => {
      const { venueId, bookingId } = await fixtureA();

      const result = await createBlock(venueId, at('12:45'), at('13:30'));

      expect(result.outcome).toBe('created');
      expect(result.affected_bookings).toEqual([]);
      expect(result.flagged_bookings).toEqual([]);
      expect((await bookingRow(bookingId)).status).toBe('approved');
    });

    it('SCRUM484_AC6_block_touching_padded_start_is_created_without_conflict', async () => {
      const { venueId, bookingId } = await fixtureA();

      const result = await createBlock(venueId, at('08:00'), at('09:30'));

      expect(result.outcome).toBe('created');
      expect(result.affected_bookings).toEqual([]);
      expect((await bookingRow(bookingId)).status).toBe('approved');
    });

    it('SCRUM484_AC6_block_period_is_stored_as_typed_and_override_flags_by_turnaround', async () => {
      const { venueId, bookingId } = await fixtureA();

      const result = await createBlock(venueId, at('12:00'), at('12:45'), {
        confirm: true,
        acknowledged: [bookingId],
      });

      expect(result.outcome).toBe('created');
      // The block is exactly what staff typed: no setup or turnaround added.
      expect(ms(result.block.starts_at)).toBe(ms(at('12:00')));
      expect(ms(result.block.ends_at)).toBe(ms(at('12:45')));
      const [stored] = await blocksOn(venueId);
      expect(ms(stored.starts_at)).toBe(ms(at('12:00')));
      expect(ms(stored.ends_at)).toBe(ms(at('12:45')));
      // A clashes only through its turnaround, and is still flagged.
      const flagged = await bookingRow(bookingId);
      expect(flagged.status).toBe('flagged_for_review');
      expect(flagged.review_block_id).toBe(result.block.id);
      expect(flagged.flagged_at).not.toBeNull();
      expect(result.flagged_bookings.map((f) => f.booking_id)).toEqual([bookingId]);
    });

    it('SCRUM484_AC6_amending_a_block_into_turnaround_conflicts', async () => {
      const { venueId, bookingId } = await fixtureA();
      const created = await createBlock(venueId, at('13:00'), at('14:00'));
      expect(created.outcome).toBe('created');

      const result = await updateBlock(venueId, created.block.id, at('12:30'), at('14:00'));

      expect(result.outcome).toBe('conflict');
      expect(conflictIds(result)).toEqual([bookingId]);
      // Nothing written: the block keeps its old period.
      const [stored] = await blocksOn(venueId);
      expect(ms(stored.starts_at)).toBe(ms(at('13:00')));
    });

    it('SCRUM484_AC6_flag_for_block_skips_a_booking_only_touching', async () => {
      const { venueId, bookingId } = await fixtureA();
      const created = await createBlock(venueId, at('12:45'), at('13:30'));
      expect(created.outcome).toBe('created');

      const rows = (
        await db.query('select * from flag_bookings_for_block($1, $2::uuid[], $3)', [
          created.block.id,
          [bookingId],
          staff,
        ])
      ).rows;

      expect(rows).toEqual([]);
      expect((await bookingRow(bookingId)).status).toBe('approved');
    });

    it('SCRUM484_AC6_zero_minutes_keep_todays_block_behaviour', async () => {
      const { venueId, bookingId } = await fixtureA(0, 0);

      const result = await createBlock(venueId, at('12:00'), at('13:00'));

      expect(result.outcome).toBe('created');
      expect(result.affected_bookings).toEqual([]);
      expect((await bookingRow(bookingId)).status).toBe('approved');
    });

    it('SCRUM484_AC6_block_vs_block_is_still_raw', async () => {
      const venueId = await makeVenue(30, 45);
      const first = await createBlock(venueId, at('08:00'), at('09:00'));
      expect(first.outcome).toBe('created');

      const result = await createBlock(venueId, at('09:00'), at('10:00'));

      expect(result.outcome).toBe('created');
      expect(await blocksOn(venueId)).toHaveLength(2);
    });

    it('SCRUM484_AC6_flagged_booking_is_not_a_block_override_candidate', async () => {
      const venueId = await makeVenue(30, 45);
      const flaggedId = await makeBooking(venueId, 'flagged_for_review', at('10:00'), at('12:00'));
      const before = await bookingRow(flaggedId);

      const result = await createBlock(venueId, at('12:00'), at('12:30'));

      expect(result.outcome).toBe('created');
      expect(result.affected_bookings).toEqual([]);
      expect(result.flagged_bookings).toEqual([]);
      const after = await bookingRow(flaggedId);
      expect(after.review_block_id).toBe(before.review_block_id);
    });
  });

  describe('AC7: the conflict JSON carries the occupied period', () => {
    it('SCRUM484_AC7_conflict_json_comes_from_the_shared_function', async () => {
      const { venueId, bookingId } = await fixtureA();

      const result = await createBlock(venueId, at('12:00'), at('12:30'));

      expect(result.outcome).toBe('conflict');
      const [item] = result.conflicts;
      expect(item.booking_id).toBe(bookingId);
      expect(ms(item.starts_at)).toBe(ms(at('10:00')));
      expect(ms(item.ends_at)).toBe(ms(at('12:00')));
      expect(ms(item.occupied_starts_at)).toBe(ms(at('09:30')));
      expect(ms(item.occupied_ends_at)).toBe(ms(at('12:45')));
      expect(item.setup_minutes).toBe(30);
      expect(item.turnaround_minutes).toBe(45);
    });

    it('SCRUM484_AC7_zero_minutes_occupied_equals_event', async () => {
      const { venueId, bookingId } = await fixtureA(0, 0);

      const result = await createBlock(venueId, at('11:00'), at('11:30'));

      expect(result.outcome).toBe('conflict');
      const [item] = result.conflicts;
      expect(item.booking_id).toBe(bookingId);
      expect(ms(item.occupied_starts_at)).toBe(ms(item.starts_at));
      expect(ms(item.occupied_ends_at)).toBe(ms(item.ends_at));
      expect(item.setup_minutes).toBe(0);
      expect(item.turnaround_minutes).toBe(0);
    });
  });

  describe('AC4: every block writer asks the shared function', () => {
    const OCCUPIED_KEYS = ['occupied_starts_at', 'occupied_ends_at', 'setup_minutes', 'turnaround_minutes'];

    it('SCRUM484_AC4_block_create_in_turnaround_lists_the_four_occupied_keys', async () => {
      const { venueId } = await fixtureA();

      const result = await createBlock(venueId, at('12:00'), at('12:45'));

      expect(result.outcome).toBe('conflict');
      expect(Object.keys(result.conflicts[0])).toEqual(
        expect.arrayContaining(['booking_id', 'event_request_id', 'event_name', 'starts_at', 'ends_at', ...OCCUPIED_KEYS]),
      );
    });

    it('SCRUM484_AC4_block_amend_in_turnaround_lists_the_four_occupied_keys', async () => {
      const { venueId, bookingId } = await fixtureA();
      const created = await createBlock(venueId, at('13:00'), at('14:00'));

      const result = await updateBlock(venueId, created.block.id, at('12:44'), at('14:00'));

      expect(result.outcome).toBe('conflict');
      expect(conflictIds(result)).toEqual([bookingId]);
      expect(Object.keys(result.conflicts[0])).toEqual(expect.arrayContaining(OCCUPIED_KEYS));
      expect(ms(result.conflicts[0].occupied_ends_at)).toBe(ms(at('12:45')));
    });

    it('SCRUM484_AC4_block_amend_touching_turnaround_end_is_updated', async () => {
      const { venueId, bookingId } = await fixtureA();
      const created = await createBlock(venueId, at('13:00'), at('14:00'));

      const result = await updateBlock(venueId, created.block.id, at('12:45'), at('14:00'));

      expect(result.outcome).toBe('updated');
      expect(result.affected_bookings).toEqual([]);
      expect((await bookingRow(bookingId)).status).toBe('approved');
    });

    it('SCRUM484_AC4_amend_override_flags_a_booking_by_its_turnaround', async () => {
      const { venueId, bookingId } = await fixtureA();
      const created = await createBlock(venueId, at('13:00'), at('14:00'));

      const result = await updateBlock(venueId, created.block.id, at('12:30'), at('14:00'), {
        confirm: true,
        acknowledged: [bookingId],
      });

      expect(result.outcome).toBe('updated');
      expect(result.flagged_bookings.map((f) => f.booking_id)).toEqual([bookingId]);
      const flagged = await bookingRow(bookingId);
      expect(flagged.status).toBe('flagged_for_review');
      expect(flagged.review_block_id).toBe(created.block.id);
    });

    it('SCRUM484_AC4_flag_for_block_flags_a_booking_whose_turnaround_meets_the_block', async () => {
      const { venueId, bookingId } = await fixtureA();
      // Inserted directly so flag_bookings_for_block is the only thing judging.
      const blockId = await insertBlock(venueId, at('12:00'), at('12:30'));

      const rows = (
        await db.query('select * from flag_bookings_for_block($1, $2::uuid[], $3)', [blockId, [bookingId], staff])
      ).rows;

      expect(rows.map((r) => r.booking_id)).toEqual([bookingId]);
      const flagged = await bookingRow(bookingId);
      expect(flagged.status).toBe('flagged_for_review');
      expect(flagged.review_block_id).toBe(blockId);
      expect(flagged.flagged_by).toBe(staff);
      const notes = (
        await db.query('select * from notifications where booking_id = $1 and block_id = $2', [bookingId, blockId])
      ).rows;
      expect(notes).toHaveLength(1);
      expect(notes[0].type).toBe('booking_flagged');
      expect(notes[0].recipient_id).toBe(coordinator);
    });
  });
});
