/**
 * SCRUM-484 (sub-task 5): venue search's availability rule, run against a
 * real Postgres through available_venue_ids() (033).
 *
 * Before SCRUM-484 search decided availability in JavaScript: SCRUM-139's
 * domain/venueOccupancy.js (isVenueFree, paddedPeriod, overlaps) read rows
 * through services/venueOccupancyService.js (findOccupancies). AC4 asks for
 * ONE calculation, so both files were removed and search now asks
 * available_venue_ids(), which calls venue_occupancy_conflicts() (032) -- the
 * same function the block writers, the booking request and the calendar use.
 *
 * Every behavioural case from those two test files is re-pointed here, with
 * its SCRUM20_... name kept, so `grep -rn SCRUM20_AC5 backend/tests` still
 * finds each edge (B-AC5-15). Cases that only tested JavaScript internals
 * with no SQL meaning -- MAX_BUFFER_MINUTES, Object.isFrozen on the status
 * list, the short-circuit order of isVenueFree, the per-venue Map shape and
 * the read errors of findOccupancies -- were dropped; the service-level error
 * translation is covered in tests/services/venueService.test.js.
 *
 * Also here: the behaviour of SCRUM-130's findBlockedVenueIds, which
 * searchVenues used for its dated catalogue search and which SCRUM-484
 * removed in favour of available_venue_ids() -- a removed block is ignored,
 * a block that only touches the period is clear, an active block excludes
 * the venue.
 *
 * The database is the final schema.
 *
 * Dates: fixed +08:00 instants on D = 2026-11-11 (a Wednesday). Nothing here
 * reads now(): available_venue_ids has no "future" rule.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';

/** A Singapore-local instant, on D = 2026-11-11 unless another date is given. */
const sgt = (hhmm, date = '2026-11-11') => `${date}T${hhmm}:00+08:00`;

/** The names this file keeps from SCRUM-139's two removed test files. */
const MOVED_NAMES = [];
/** `it`, recording the name, so B-AC5-15 can check none was lost. */
const moved = (name, fn) => {
  MOVED_NAMES.push(name);
  return it(name, fn);
};

/**
 * The plain AC5 edges against a 10:00-12:00 request at a 0/0 venue:
 * [name, from, to, free]. Shared by bookings and blocks, as in SCRUM-139.
 */
const PLAIN_EDGES = [
  ['ending_at_requested_start_does_not_overlap', '08:00', '10:00', true],
  ['starting_at_requested_end_does_not_overlap', '12:00', '14:00', true],
  ['ending_one_minute_after_start_overlaps', '08:00', '10:01', false],
  ['starting_one_minute_before_end_overlaps', '11:59', '14:00', false],
  ['containing_the_period_overlaps', '09:00', '13:00', false],
  ['inside_the_period_overlaps', '10:30', '11:00', false],
];

describe('SCRUM-484: venue search availability through available_venue_ids', () => {
  let db;
  let organiser;
  let coordinator;
  let counter = 0;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  async function makeVenue(setup = 0, turnaround = 0) {
    counter += 1;
    return (
      await one(
        `insert into venues (name, location, max_capacity, setup_minutes, turnaround_minutes)
         values ($1, 'Block A', 200, $2, $3) returning id`,
        [`Search Hall ${counter}`, setup, turnaround],
      )
    ).id;
  }

  function makeEvent() {
    counter += 1;
    return seedEvent(db, {
      status: 'approved',
      organiser_id: organiser,
      assigned_coordinator_id: coordinator,
      event_name: `Event ${counter}`,
      proposed_start: sgt('10:00'),
      proposed_end: sgt('12:00'),
      expected_attendance: 150,
    });
  }

  async function makeBooking(venueId, startsAt, endsAt, status = 'approved') {
    const eventId = await makeEvent();
    return (
      await one(
        `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
         values ($1, $2, $3, $4, $5) returning id`,
        [venueId, eventId, startsAt, endsAt, status],
      )
    ).id;
  }

  async function makeBlock(venueId, startsAt, endsAt, { removed = false } = {}) {
    return (
      await one(
        `insert into venue_blocks (venue_id, starts_at, ends_at, reason, removed_at)
         values ($1, $2, $3, 'maintenance', ${removed ? 'now()' : 'null'}) returning id`,
        [venueId, startsAt, endsAt],
      )
    ).id;
  }

  /** available_venue_ids' rows, raw. */
  async function availableRows(venueIds, startsAt, endsAt) {
    return (
      await db.query('select * from available_venue_ids($1::uuid[], $2::timestamptz, $3::timestamptz)', [
        venueIds,
        startsAt,
        endsAt,
      ])
    ).rows;
  }

  /** The free ids, sorted. */
  async function freeIds(venueIds, startsAt, endsAt) {
    return (await availableRows(venueIds, startsAt, endsAt)).map((r) => r.venue_id).sort();
  }

  /** Is this one venue free for [startsAt, endsAt)? */
  async function isFree(venueId, startsAt, endsAt) {
    return (await freeIds([venueId], startsAt, endsAt)).includes(venueId);
  }

  /** A venue at these minutes with these bookings and blocks ([from, to] pairs). */
  async function venueWith({ setup = 0, turnaround = 0, bookings = [], blocks = [] } = {}) {
    const venueId = await makeVenue(setup, turnaround);
    for (const [from, to, status] of bookings) await makeBooking(venueId, from, to, status);
    for (const [from, to] of blocks) await makeBlock(venueId, from, to);
    return venueId;
  }

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = (await one("insert into auth.users (email) values ('o@x') returning id")).id;
    coordinator = (await one("insert into auth.users (email) values ('c@x') returning id")).id;
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  // -------------------------------------------------------------------------
  // SCRUM484 AC4: search asks the shared function (B-AC4-04)
  // -------------------------------------------------------------------------
  describe('SCRUM484 AC4 the worked example through search', () => {
    it('SCRUM484_AC4_search_worked_example_1314_hidden_1315_shown', async () => {
      // Common fixture: V at 30/45, approved booking A 10:00-12:00 occupies
      // 09:30-12:45. A 13:14 request pads back to 12:44 and is hidden; 13:15
      // pads back to 12:45, touches, and is shown.
      const v = await venueWith({ setup: 30, turnaround: 45, bookings: [[sgt('10:00'), sgt('12:00')]] });

      expect(await freeIds([v], sgt('13:14'), sgt('14:00'))).toEqual([]);
      expect(await freeIds([v], sgt('13:15'), sgt('14:00'))).toEqual([v]);
    });

    it('SCRUM484_AC4_search_answers_with_one_venue_id_column', async () => {
      // `returns table (venue_id uuid)`: the shape venueService reads.
      const v = await makeVenue();
      const rows = await availableRows([v], sgt('10:00'), sgt('12:00'));
      expect(rows).toEqual([{ venue_id: v }]);
    });

    it('SCRUM484_AC4_search_agrees_with_venue_occupancy_conflicts', async () => {
      // Free means exactly "venue_occupancy_conflicts(..., true) returns no
      // row", for a booking clash, a block clash and a free venue.
      const booked = await venueWith({ setup: 30, turnaround: 45, bookings: [[sgt('10:00'), sgt('12:00')]] });
      const blocked = await venueWith({ setup: 30, turnaround: 45, blocks: [[sgt('13:00'), sgt('14:00')]] });
      const clear = await makeVenue(30, 45);
      const req = [sgt('13:14'), sgt('14:29')];

      for (const v of [booked, blocked, clear]) {
        const conflicts = (
          await db.query(
            'select count(*)::int as n from venue_occupancy_conflicts($1::uuid, $2::timestamptz, $3::timestamptz, true)',
            [v, ...req],
          )
        ).rows[0].n;
        expect(await isFree(v, ...req)).toBe(conflicts === 0);
      }
      expect(await freeIds([booked, blocked, clear], ...req)).toEqual([clear]);
    });
  });

  describe('SCRUM484 available_venue_ids edges', () => {
    it('SCRUM484_AC4_available_venue_ids_null_bound_returns_no_venue', async () => {
      // Fails closed: a null bound would otherwise make every venue look free.
      const v = await makeVenue();
      expect(await freeIds([v], null, sgt('12:00'))).toEqual([]);
      expect(await freeIds([v], sgt('10:00'), null)).toEqual([]);
    });

    it('SCRUM484_AC4_available_venue_ids_empty_array_returns_nothing', async () => {
      expect(await freeIds([], sgt('10:00'), sgt('12:00'))).toEqual([]);
    });

    it('SCRUM484_AC4_available_venue_ids_answers_a_repeated_id_once', async () => {
      const v = await makeVenue();
      const rows = await availableRows([v, v, v], sgt('10:00'), sgt('12:00'));
      expect(rows).toEqual([{ venue_id: v }]);
    });

    it('SCRUM484_AC4_available_venue_ids_skips_a_null_id', async () => {
      const v = await makeVenue();
      expect(await freeIds([v, null], sgt('10:00'), sgt('12:00'))).toEqual([v]);
    });
  });

  // -------------------------------------------------------------------------
  // SCRUM-130's findBlockedVenueIds, removed by SCRUM-484: its behaviour,
  // through the function that replaced it.
  // -------------------------------------------------------------------------
  describe('SCRUM17 AC2 a dated search leaves out blocked venues (was findBlockedVenueIds)', () => {
    it('SCRUM17_AC2_SCRUM484_an_active_block_excludes_the_venue', async () => {
      const blocked = await venueWith({ blocks: [[sgt('11:00'), sgt('11:30')]] });
      const clear = await makeVenue();
      expect(await freeIds([blocked, clear], sgt('10:00'), sgt('12:00'))).toEqual([clear]);
    });

    it('SCRUM17_AC2_SCRUM484_a_removed_block_is_ignored', async () => {
      const v = await makeVenue();
      await makeBlock(v, sgt('10:00'), sgt('12:00'), { removed: true });
      expect(await isFree(v, sgt('10:00'), sgt('12:00'))).toBe(true);
    });

    it('SCRUM17_AC2_SCRUM484_a_block_touching_the_period_is_clear', async () => {
      // At a 0/0 venue, a block ending at the start or starting at the end.
      const v = await venueWith({ blocks: [[sgt('08:00'), sgt('10:00')], [sgt('12:00'), sgt('14:00')]] });
      expect(await isFree(v, sgt('10:00'), sgt('12:00'))).toBe(true);
    });

    it('SCRUM17_AC2_SCRUM484_a_venue_with_several_blocks_is_left_out_once', async () => {
      const v = await venueWith({ blocks: [[sgt('10:00'), sgt('10:30')], [sgt('11:00'), sgt('11:30')]] });
      const clear = await makeVenue();
      expect(await freeIds([v, clear], sgt('09:00'), sgt('13:00'))).toEqual([clear]);
    });

    it('SCRUM17_AC2_SCRUM484_decision_5_a_booked_venue_is_left_out_too', async () => {
      // The side effect decision 5 accepts: the dated catalogue search now
      // hides a venue booked in the window, not only a blocked one.
      const v = await venueWith({ bookings: [[sgt('10:30'), sgt('11:00')]] });
      expect(await isFree(v, sgt('10:00'), sgt('12:00'))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Moved from tests/domain/venueOccupancy.test.js (SCRUM-139)
  // -------------------------------------------------------------------------
  describe('SCRUM20 AC5 overlaps is strict at both edges', () => {
    // SCRUM-139's overlaps(aStart, aEnd, bStart, bEnd) on abstract units. Here
    // a unit is a minute after 10:00 at a 0/0 venue: b is a booking, a the
    // request, and the request is free exactly when they do not overlap. The
    // symmetry check swaps which period is the booking.
    const plus = (mins) => new Date(Date.parse(sgt('10:00')) + mins * 60_000).toISOString();

    it.each([
      ['touching at a.end == b.start', 0, 10, 10, 20, false],
      ['touching at a.start == b.end', 10, 20, 0, 10, false],
      ['one unit over a.end', 0, 11, 10, 20, true],
      ['one unit over a.start', 9, 20, 0, 10, true],
      ['a contains b', 0, 30, 10, 20, true],
      ['a inside b', 12, 18, 10, 20, true],
      ['identical periods', 10, 20, 10, 20, true],
      ['disjoint before', 0, 5, 10, 20, false],
      ['disjoint after', 25, 30, 10, 20, false],
    ])('SCRUM20_AC5_overlaps_%s', async (_name, aStart, aEnd, bStart, bEnd, expected) => {
      const v1 = await venueWith({ bookings: [[plus(bStart), plus(bEnd)]] });
      expect(await isFree(v1, plus(aStart), plus(aEnd))).toBe(!expected);
      // Symmetric: the rule does not care which period is which.
      const v2 = await venueWith({ bookings: [[plus(aStart), plus(aEnd)]] });
      expect(await isFree(v2, plus(bStart), plus(bEnd))).toBe(!expected);
    });
    MOVED_NAMES.push('SCRUM20_AC5_overlaps_%s');
  });

  describe('SCRUM20 AC5 paddedPeriod', () => {
    // paddedPeriod is now venue_occupied_period (032), applied to both the
    // booking and the request. Each case is checked by where search's edges
    // fall, which is what the padded period decides.
    moved('SCRUM20_AC5_padded_period_subtracts_setup_and_adds_turnaround', async () => {
      // The worked example: 10:00-12:00 with 30/45 occupies 09:30-12:45, so
      // a request may start from 13:15 (its setup from 12:45) or end by 08:45
      // (its turnaround to 09:30).
      const v = await venueWith({ setup: 30, turnaround: 45, bookings: [[sgt('10:00'), sgt('12:00')]] });
      expect(await isFree(v, sgt('13:15'), sgt('14:00'))).toBe(true);
      expect(await isFree(v, sgt('13:14'), sgt('14:00'))).toBe(false);
      expect(await isFree(v, sgt('07:30'), sgt('08:45'))).toBe(true);
      expect(await isFree(v, sgt('07:30'), sgt('08:46'))).toBe(false);
    });

    moved('SCRUM20_AC5_padded_period_with_zero_buffers_is_the_raw_period', async () => {
      const v = await venueWith({ bookings: [[sgt('10:00'), sgt('12:00')]] });
      expect(await isFree(v, sgt('12:00'), sgt('13:00'))).toBe(true);
      expect(await isFree(v, sgt('11:59'), sgt('13:00'))).toBe(false);
      expect(await isFree(v, sgt('09:00'), sgt('10:00'))).toBe(true);
      expect(await isFree(v, sgt('09:00'), sgt('10:01'))).toBe(false);
    });

    moved('SCRUM20_AC5_padded_period_ignores_the_offset_a_timestamp_was_written_with', async () => {
      // The booking is written at +08:00; the same request instants written
      // at +08:00, Z and -05:00 get the same answers.
      const v = await venueWith({ setup: 30, turnaround: 45, bookings: [[sgt('10:00'), sgt('12:00')]] });
      const writings = {
        clear: [sgt('13:15'), '2026-11-11T05:15:00Z', '2026-11-11T00:15:00-05:00'],
        clash: [sgt('13:14'), '2026-11-11T05:14:00Z', '2026-11-11T00:14:00-05:00'],
      };
      for (const start of writings.clear) expect(await isFree(v, start, sgt('14:00'))).toBe(true);
      for (const start of writings.clash) expect(await isFree(v, start, sgt('14:00'))).toBe(false);
    });

    moved('SCRUM20_AC5_padded_period_accepts_dates', async () => {
      // The request bound as Date objects rather than strings.
      const v = await venueWith({ setup: 30, turnaround: 45, bookings: [[sgt('10:00'), sgt('12:00')]] });
      expect(await isFree(v, new Date(sgt('13:15')), new Date(sgt('14:00')))).toBe(true);
      expect(await isFree(v, new Date(sgt('13:14')), new Date(sgt('14:00')))).toBe(false);
    });

    moved('SCRUM20_AC5_padded_period_crosses_midnight', async () => {
      // Booking 00:15-23:30 on D at 30/45 occupies (D-1) 23:45 to (D+1) 00:15.
      // A request on D-1 must end by 23:00 (its turnaround to 23:45); one on
      // D+1 may start from 00:45 (its setup from 00:15).
      const v = await venueWith({ setup: 30, turnaround: 45, bookings: [[sgt('00:15'), sgt('23:30')]] });
      expect(await isFree(v, sgt('22:00', '2026-11-10'), sgt('23:00', '2026-11-10'))).toBe(true);
      expect(await isFree(v, sgt('22:00', '2026-11-10'), sgt('23:01', '2026-11-10'))).toBe(false);
      expect(await isFree(v, sgt('00:45', '2026-11-12'), sgt('02:00', '2026-11-12'))).toBe(true);
      expect(await isFree(v, sgt('00:44', '2026-11-12'), sgt('02:00', '2026-11-12'))).toBe(false);
    });
  });

  describe('SCRUM20 AC6 occupying statuses', () => {
    // The constants are now 032's allow-list: status in ('approved',
    // 'flagged_for_review'). MAX_BUFFER_MINUTES and the frozen-array check
    // had no SQL meaning and were dropped.
    moved('SCRUM20_AC6_occupying_statuses_are_exactly_approved_and_flagged', async () => {
      const statuses = ['approved', 'flagged_for_review', 'pending', 'rejected', 'withdrawn', 'cancelled'];
      const venues = {};
      for (const status of statuses) {
        venues[status] = await venueWith({ bookings: [[sgt('10:30'), sgt('11:30'), status]] });
      }

      const free = await freeIds(Object.values(venues), sgt('10:00'), sgt('12:00'));

      const hidden = statuses.filter((s) => !free.includes(venues[s]));
      expect(hidden).toEqual(['approved', 'flagged_for_review']);
    });

    moved('SCRUM20_AC6_occupying_statuses_exclude_cancelled', async () => {
      const v = await venueWith({ bookings: [[sgt('10:00'), sgt('12:00'), 'cancelled']] });
      expect(await isFree(v, sgt('10:00'), sgt('12:00'))).toBe(true);
    });
  });

  describe('SCRUM20 AC5 isVenueFree with zero buffers: bookings', () => {
    it.each(PLAIN_EDGES)('SCRUM20_AC5_booking_%s', async (_name, from, to, free) => {
      const v = await venueWith({ bookings: [[sgt(from), sgt(to)]] });
      expect(await isFree(v, sgt('10:00'), sgt('12:00'))).toBe(free);
    });
    MOVED_NAMES.push('SCRUM20_AC5_booking_%s');
  });

  describe('SCRUM20 AC5 isVenueFree with zero buffers: blocks', () => {
    it.each(PLAIN_EDGES)('SCRUM20_AC5_block_%s', async (_name, from, to, free) => {
      const v = await venueWith({ blocks: [[sgt(from), sgt(to)]] });
      expect(await isFree(v, sgt('10:00'), sgt('12:00'))).toBe(free);
    });
    MOVED_NAMES.push('SCRUM20_AC5_block_%s');

    moved('SCRUM20_AC5_block_containing_the_period_overlaps (whole-day block)', async () => {
      // B-AC5-12 exactly as written: 2026-11-11 00:00 to 2026-11-12 00:00.
      const v = await venueWith({ blocks: [[sgt('00:00'), sgt('00:00', '2026-11-12')]] });
      expect(await isFree(v, sgt('10:00'), sgt('12:00'))).toBe(false);
    });
  });

  describe('SCRUM20 AC5 zero buffers equal the plain edge cases', () => {
    const cases = PLAIN_EDGES.flatMap(([name, from, to, free]) => [
      [`booking_${name}`, from, to, 'booking', free],
      [`block_${name}`, from, to, 'block', free],
    ]);

    it.each(cases)('SCRUM20_AC5_zero_buffers_equal_the_plain_edge_cases: %s', async (_name, from, to, kind, free) => {
      // B-AC5-25: with both minutes at 0, a booking and a block at the same
      // period give the same answer, and it is the plain edge rule's.
      const v = await venueWith(kind === 'booking' ? { bookings: [[sgt(from), sgt(to)]] } : { blocks: [[sgt(from), sgt(to)]] });
      expect(await isFree(v, sgt('10:00'), sgt('12:00'))).toBe(free);
    });
    MOVED_NAMES.push('SCRUM20_AC5_zero_buffers_equal_the_plain_edge_cases: %s');
  });

  describe('SCRUM20 AC5 isVenueFree pads bookings and the request', () => {
    // Venue 30/45; booking 10:00-12:00 occupies 09:30-12:45.
    const worked = () => venueWith({ setup: 30, turnaround: 45, bookings: [[sgt('10:00'), sgt('12:00')]] });

    moved('SCRUM20_AC5_padded_request_touching_padded_booking_end_is_kept', async () => {
      // B-AC5-15: request 13:15 pads back to 12:45, touching 12:45.
      const v = await worked();
      expect(await isFree(v, sgt('13:15'), sgt('14:00'))).toBe(true);
      expect(await isFree(v, sgt('13:15'), sgt('14:15'))).toBe(true);
    });

    moved('SCRUM20_AC5_padded_request_one_minute_into_turnaround_is_excluded', async () => {
      // B-AC5-16
      const v = await worked();
      expect(await isFree(v, sgt('13:14'), sgt('14:00'))).toBe(false);
      expect(await isFree(v, sgt('13:14'), sgt('14:15'))).toBe(false);
    });

    moved('SCRUM20_AC5_request_ending_well_before_padded_booking_is_kept', async () => {
      // B-AC5-17
      const v = await worked();
      expect(await isFree(v, sgt('07:00'), sgt('08:15'))).toBe(true);
      expect(await isFree(v, sgt('07:15'), sgt('08:15'))).toBe(true);
    });

    moved('SCRUM20_AC5_padded_request_touching_padded_booking_start_is_kept', async () => {
      // B-AC5-18: ending 08:45 pads forward to 09:30.
      const v = await worked();
      expect(await isFree(v, sgt('07:45'), sgt('08:45'))).toBe(true);
    });

    moved('SCRUM20_AC5_padded_request_one_minute_into_setup_is_excluded', async () => {
      // B-AC5-19
      const v = await worked();
      expect(await isFree(v, sgt('07:46'), sgt('08:46'))).toBe(false);
    });

    moved('SCRUM20_AC5_request_setup_alone_causes_overlap', async () => {
      // B-AC5-20: at 30/0 a request 12:00-13:00 occupies 11:30-13:00, so its
      // own setup runs into the booking; at 0/0 it only touches.
      const padded = await venueWith({ setup: 30, turnaround: 0, bookings: [[sgt('10:00'), sgt('12:00')]] });
      const plain = await venueWith({ bookings: [[sgt('10:00'), sgt('12:00')]] });
      expect(await isFree(padded, sgt('12:00'), sgt('13:00'))).toBe(false);
      expect(await isFree(plain, sgt('12:00'), sgt('13:00'))).toBe(true);
    });

    moved('SCRUM20_AC5_booking_turnaround_alone_sets_the_edge', async () => {
      // B-AC5-21: at 0/45 the booking occupies until 12:45.
      const v = await venueWith({ setup: 0, turnaround: 45, bookings: [[sgt('10:00'), sgt('12:00')]] });
      expect(await isFree(v, sgt('12:30'), sgt('13:30'))).toBe(false);
      expect(await isFree(v, sgt('12:45'), sgt('13:45'))).toBe(true);
    });

    moved('SCRUM20_AC5_any_one_clashing_booking_among_many_excludes', async () => {
      const v = await venueWith({
        setup: 30,
        turnaround: 45,
        bookings: [
          [sgt('07:00'), sgt('08:00')],
          [sgt('10:00'), sgt('12:00')],
          [sgt('16:00'), sgt('17:00')],
        ],
      });
      expect(await isFree(v, sgt('13:14'), sgt('14:00'))).toBe(false);
      expect(await isFree(v, sgt('13:15'), sgt('14:00'))).toBe(true);
    });
  });

  describe('SCRUM20 AC5 isVenueFree compares blocks raw against the padded request', () => {
    const blocked = (from, to) => venueWith({ setup: 30, turnaround: 45, blocks: [[sgt(from), sgt(to)]] });

    moved('SCRUM20_AC5_padded_start_touching_block_end_is_kept (block 08:00-09:45)', async () => {
      // Request 10:15 pads back to 09:45, touching the block's end.
      const v = await blocked('08:00', '09:45');
      expect(await isFree(v, sgt('10:15'), sgt('11:00'))).toBe(true);
    });

    moved('SCRUM20_AC5_padded_start_inside_block_is_excluded (block 08:00-09:45)', async () => {
      const v = await blocked('08:00', '09:45');
      expect(await isFree(v, sgt('10:14'), sgt('11:00'))).toBe(false);
    });

    moved('SCRUM20_AC5_padded_start_inside_block_is_excluded', async () => {
      // B-AC5-22: block 13:00-14:00; request 14:15 pads back to 13:45.
      const v = await blocked('13:00', '14:00');
      expect(await isFree(v, sgt('14:15'), sgt('15:00'))).toBe(false);
    });

    moved('SCRUM20_AC5_padded_start_touching_block_end_is_kept', async () => {
      // B-AC5-23
      const v = await blocked('13:00', '14:00');
      expect(await isFree(v, sgt('14:30'), sgt('15:00'))).toBe(true);
    });

    moved('SCRUM20_AC5_padded_end_against_block_start_edge', async () => {
      // B-AC5-24: block 16:00-17:00. Ending 15:15 pads to 16:00 (kept);
      // ending 15:16 pads to 16:01 (excluded).
      const v = await blocked('16:00', '17:00');
      expect(await isFree(v, sgt('14:30'), sgt('15:15'))).toBe(true);
      expect(await isFree(v, sgt('14:30'), sgt('15:16'))).toBe(false);
    });

    moved('SCRUM20_AC5_block_is_not_padded_where_a_booking_would_be', async () => {
      // The same period as a booking and as a block, against the same
      // request: the booking (padded 09:30-12:45) clashes with a request
      // padded from 12:44; the block (raw 10:00-12:00) does not.
      const asBooking = await venueWith({ setup: 30, turnaround: 45, bookings: [[sgt('10:00'), sgt('12:00')]] });
      const asBlock = await blocked('10:00', '12:00');
      expect(await isFree(asBooking, sgt('13:14'), sgt('14:00'))).toBe(false);
      expect(await isFree(asBlock, sgt('13:14'), sgt('14:00'))).toBe(true);
    });
  });

  describe('SCRUM20 AC6 isVenueFree branches', () => {
    moved('SCRUM20_AC6_no_bookings_and_no_blocks_is_free', async () => {
      const v = await makeVenue(30, 45);
      expect(await isFree(v, sgt('10:00'), sgt('12:00'))).toBe(true);
    });

    moved('SCRUM20_AC6_blocks_are_checked_when_no_booking_clashes', async () => {
      const blockClash = await venueWith({ bookings: [[sgt('07:00'), sgt('08:00')]], blocks: [[sgt('10:30'), sgt('11:00')]] });
      const noClash = await venueWith({ bookings: [[sgt('07:00'), sgt('08:00')]], blocks: [[sgt('13:00'), sgt('14:00')]] });
      expect(await isFree(blockClash, sgt('10:00'), sgt('12:00'))).toBe(false);
      expect(await isFree(noClash, sgt('10:00'), sgt('12:00'))).toBe(true);
    });

    moved('SCRUM20_AC6_answers_a_boolean_and_nothing_else', async () => {
      // The SQL answer is yes or no per venue -- a venue id or nothing --
      // never why (SCRUM-145).
      const v = await venueWith({ bookings: [[sgt('10:30'), sgt('11:00')]] });
      const clear = await makeVenue();
      const rows = await availableRows([v, clear], sgt('10:00'), sgt('12:00'));
      expect(rows).toEqual([{ venue_id: clear }]);
    });

    moved('SCRUM20_AC5_rows_with_utc_timestamps_compare_as_instants', async () => {
      // The booking written in UTC, the request at +08:00.
      const v = await venueWith({
        setup: 30,
        turnaround: 45,
        bookings: [['2026-11-11T02:00:00+00:00', '2026-11-11T04:00:00+00:00']],
      });
      expect(await isFree(v, sgt('13:14'), sgt('14:00'))).toBe(false);
      expect(await isFree(v, sgt('13:15'), sgt('14:00'))).toBe(true);
    });

    moved('SCRUM20_AC5_request_as_dates_is_accepted', async () => {
      const v = await venueWith({ setup: 30, turnaround: 45, bookings: [[sgt('10:00'), sgt('12:00')]] });
      expect(await isFree(v, new Date(sgt('13:15')), new Date(sgt('14:00')))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Moved from tests/services/venueOccupancyService.test.js (SCRUM-139)
  // findOccupancies read rows for isVenueFree; its observable behaviour --
  // which rows count, for which venue -- is now available_venue_ids'.
  // -------------------------------------------------------------------------
  describe('SCRUM20 findOccupancies: what the reads counted', () => {
    moved('SCRUM20_AC6_empty_ids_answer_an_empty_map_without_a_query', async () => {
      // No venues asked about, none answered. (That the service makes no
      // call at all is pinned in venueService.test.js.)
      expect(await freeIds([], sgt('10:00'), sgt('12:00'))).toEqual([]);
    });

    moved('SCRUM20_AC5_both_reads_are_issued', async () => {
      // Bookings and blocks are both counted, in one call.
      const booked = await venueWith({ bookings: [[sgt('10:30'), sgt('11:00')]] });
      const blocked = await venueWith({ blocks: [[sgt('10:30'), sgt('11:00')]] });
      const clear = await makeVenue();
      expect(await freeIds([booked, blocked, clear], sgt('10:00'), sgt('12:00'))).toEqual([clear]);
    });

    moved('SCRUM20_AC5_booking_query_uses_strict_lt_and_gt', async () => {
      // B-AC5-07: bookings touching either edge do not count.
      const v = await venueWith({ bookings: [[sgt('08:00'), sgt('10:00')], [sgt('12:00'), sgt('14:00')]] });
      expect(await isFree(v, sgt('10:00'), sgt('12:00'))).toBe(true);
    });

    moved('SCRUM20_AC6_booking_query_filters_on_the_occupying_statuses', async () => {
      // B-AC6-02/03: pending, rejected, withdrawn and cancelled never count.
      const v = await venueWith({
        bookings: ['pending', 'rejected', 'withdrawn', 'cancelled'].map((s) => [sgt('10:30'), sgt('11:30'), s]),
      });
      expect(await isFree(v, sgt('10:00'), sgt('12:00'))).toBe(true);
    });

    moved('SCRUM20_AC5_block_query_uses_strict_lt_and_gt', async () => {
      // B-AC5-14 and B-AC6-06: only active blocks, touching is clear.
      const v = await venueWith({ blocks: [[sgt('08:00'), sgt('10:00')], [sgt('12:00'), sgt('14:00')]] });
      await makeBlock(v, sgt('10:30'), sgt('11:00'), { removed: true });
      expect(await isFree(v, sgt('10:00'), sgt('12:00'))).toBe(true);
    });

    moved('SCRUM20_AC5_read_window_is_the_same_instant_whatever_the_offset', async () => {
      const v = await venueWith({ setup: 30, turnaround: 45, bookings: [[sgt('10:00'), sgt('12:00')]] });
      expect(await isFree(v, '2026-11-11T05:14:00Z', '2026-11-11T06:00:00Z')).toBe(false);
      expect(await isFree(v, '2026-11-11T05:15:00Z', new Date('2026-11-11T06:00:00Z'))).toBe(true);
    });

    moved('SCRUM20_AC6_rows_are_grouped_per_venue_and_every_id_is_present', async () => {
      // Each venue is judged on its own rows: A booked, B blocked, C clear.
      const a = await venueWith({ bookings: [[sgt('10:30'), sgt('11:30')], [sgt('13:00'), sgt('14:00')]] });
      const b = await venueWith({ blocks: [[sgt('10:00'), sgt('12:00')]] });
      const c = await makeVenue();
      expect(await freeIds([a, b, c], sgt('10:00'), sgt('12:00'))).toEqual([c]);
    });

    moved('SCRUM20_AC6_each_venue_gets_its_own_arrays', async () => {
      // A booking on one venue never hides another.
      const a = await venueWith({ bookings: [[sgt('10:30'), sgt('11:30')]] });
      const b = await makeVenue();
      expect(await freeIds([a, b], sgt('10:00'), sgt('12:00'))).toEqual([b]);
    });
  });

  // -------------------------------------------------------------------------
  // B-AC5-15: none of SCRUM-139's edge cases was lost in the move.
  // -------------------------------------------------------------------------
  describe('SCRUM484 AC5 the SCRUM-139 cases survive the move', () => {
    it('SCRUM484_AC5_scrum139_edge_cases_survive_the_move', () => {
      // Every SCRUM20_AC5_ edge from domain/venueOccupancy.test.js that had a
      // SQL meaning is here under its old name.
      const required = [
        'SCRUM20_AC5_overlaps_%s',
        'SCRUM20_AC5_padded_period_subtracts_setup_and_adds_turnaround',
        'SCRUM20_AC5_padded_period_with_zero_buffers_is_the_raw_period',
        'SCRUM20_AC5_padded_period_ignores_the_offset_a_timestamp_was_written_with',
        'SCRUM20_AC5_padded_period_crosses_midnight',
        'SCRUM20_AC5_booking_%s',
        'SCRUM20_AC5_block_%s',
        'SCRUM20_AC5_zero_buffers_equal_the_plain_edge_cases: %s',
        'SCRUM20_AC5_padded_request_touching_padded_booking_end_is_kept',
        'SCRUM20_AC5_padded_request_one_minute_into_turnaround_is_excluded',
        'SCRUM20_AC5_request_ending_well_before_padded_booking_is_kept',
        'SCRUM20_AC5_padded_request_touching_padded_booking_start_is_kept',
        'SCRUM20_AC5_padded_request_one_minute_into_setup_is_excluded',
        'SCRUM20_AC5_request_setup_alone_causes_overlap',
        'SCRUM20_AC5_booking_turnaround_alone_sets_the_edge',
        'SCRUM20_AC5_padded_start_touching_block_end_is_kept',
        'SCRUM20_AC5_padded_start_inside_block_is_excluded',
        'SCRUM20_AC5_padded_end_against_block_start_edge',
        'SCRUM20_AC5_block_is_not_padded_where_a_booking_would_be',
      ];
      for (const name of required) expect(MOVED_NAMES).toContain(name);
    });
  });
});
