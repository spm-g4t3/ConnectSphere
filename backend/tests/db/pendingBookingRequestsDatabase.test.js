/**
 * The Venue Staff queue of pending booking requests (066), against a real
 * Postgres.
 *
 * SCRUM-258 AC1: only Venue Staff see it; pending requests, oldest first, each
 * with its own period, attendance and suitability, and the other events'
 * pending requests whose occupied periods overlap it, in submission order.
 * Week 7: occupied = start - setup -> end + turnaround, half-open.
 *
 * Migrations: multiVenueBookingRequestDatabase.test.js's list through 051,
 * then 065 and 066, each in its own exec (065's enum values must commit
 * first). Nothing in 052-063 touches bookings, venues or
 * venue_occupied_period, so none is needed.
 *
 * Each test makes its own venues and events and reads only its own rows from
 * the queue, except the empty queue, which runs first.
 *
 * Dates: D is the Singapore date 10 days from now, never hard-coded.
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
  '051_multi_venue_booking_requests.sql',
  '065_booking_decision_statuses.sql',
  '066_venue_staff_booking_decisions.sql',
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
const ms = (instant) => new Date(instant).getTime();

const SUITABLE = { suitable: true, criteria: [{ criterion: 'Capacity', met: true }] };

/** The error a promise rejected with, as its SQLSTATE; null if it resolved. */
const refusalCode = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err.code;
  }
};

describe('SCRUM-258 AC1: the pending booking requests Venue Staff decide on (066)', () => {
  let db;
  let organiser;
  let coordinator;
  let staff;
  let counter = 0;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  async function makeUser(email, role) {
    const id = (await one('insert into auth.users (email) values ($1) returning id', [email])).id;
    if (role) await db.query('insert into profiles (id, role) values ($1, $2)', [id, role]);
    return id;
  }

  /** A venue with 30 minutes' setup and 45 minutes' turnaround. */
  async function makeVenue() {
    counter += 1;
    return (
      await one(
        `insert into venues (name, location, max_capacity, setup_minutes, turnaround_minutes)
         values ($1, 'Block A', 200, 30, 45) returning id`,
        [`Harbour Room ${counter}`],
      )
    ).id;
  }

  async function makeEvent({ attendance = 150, start = at('14:00'), end = at('16:00') } = {}) {
    counter += 1;
    return (
      await one(
        `insert into event_requests
           (organiser_id, event_name, status, proposed_start, proposed_end,
            expected_attendance, submitted_at, assigned_coordinator_id)
         values ($1, $2, 'approved', $3, $4, $5, now(), $6) returning id`,
        [organiser, `Event ${counter}`, start, end, attendance, coordinator],
      )
    ).id;
  }

  /**
   * A booking written directly, so its period, status and submission time are
   * chosen. A flagged_for_review one carries a removed block and a flag time
   * (014's bookings_review_flag_paired).
   */
  async function insertBooking(eventId, venueId, { start, end, status = 'pending', createdAt = new Date() }) {
    let reviewBlockId = null;
    if (status === 'flagged_for_review') {
      reviewBlockId = (
        await one(
          `insert into venue_blocks (venue_id, starts_at, ends_at, reason, removed_at)
           values ($1, $2, $3, 'maintenance', now()) returning id`,
          [venueId, at('22:00'), at('23:00')],
        )
      ).id;
    }
    const flagged = reviewBlockId !== null;
    return (
      await one(
        `insert into bookings
           (venue_id, event_request_id, starts_at, ends_at, status, review_block_id,
            flagged_at, flagged_by, created_at)
         values ($1, $2, $3, $4, $5, $6, ${flagged ? 'now()' : 'null'}, $7, $8) returning id`,
        [venueId, eventId, start, end, status, reviewBlockId, flagged ? staff : null, createdAt],
      )
    ).id;
  }

  /** A pending request at venueId for a new event, submitted at createdAt. */
  async function pending(venueId, start, end, createdAt) {
    const eventId = await makeEvent();
    const id = await insertBooking(eventId, venueId, { start, end, createdAt });
    return { id, eventId };
  }

  const queue = async (caller = staff) =>
    (await one('select list_pending_booking_requests($1) as result', [caller])).result;

  /** The queue's entry for one booking. */
  const entryFor = async (bookingId) => (await queue()).find((row) => row.id === bookingId);
  const overlapIds = async (bookingId) => (await entryFor(bookingId)).overlapping.map((o) => o.id);

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
    organiser = await makeUser('o@x', 'event_organiser');
    coordinator = await makeUser('c@x', 'event_coordinator');
    staff = await makeUser('s@x', 'venue_staff');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  // First: every later test leaves pending rows behind.
  it('SCRUM258_AC1_an_empty_queue_is_an_empty_array', async () => {
    expect(await queue()).toEqual([]);
  });

  it.each([
    ['a coordinator', () => coordinator],
    ['an organiser', () => organiser],
    ['a null caller', () => null],
    ['a user with no profile', () => '00000000-0000-4000-8000-000000000000'],
  ])('SCRUM258_AC1_only_venue_staff_can_view_the_queue_%s_is_refused', async (_label, caller) => {
    expect(await refusalCode(queue(caller()))).toBe('42501');
  });

  it('SCRUM258_AC1_only_pending_requests_are_listed_oldest_first', async () => {
    const venue = await makeVenue();
    const period = { start: at('09:00'), end: at('10:00') };
    // Inserted newest first, so insertion or id order would get it wrong.
    const newer = await pending(venue, period.start, period.end, at('08:00'));
    const older = await pending(venue, period.start, period.end, at('07:00'));
    const decided = [];
    for (const status of ['approved', 'rejected', 'withdrawn', 'cancelled', 'flagged_for_review']) {
      decided.push(await insertBooking(await makeEvent(), venue, { ...period, status, createdAt: at('06:00') }));
    }

    const ids = (await queue()).map((row) => row.id);

    expect(ids.filter((id) => [newer.id, older.id, ...decided].includes(id))).toEqual([older.id, newer.id]);
    // An approved booking in the same period is not an overlapping pending request.
    expect(await overlapIds(older.id)).toEqual([newer.id]);
  });

  it('SCRUM258_AC1_overlap_counts_setup_and_turnaround', async () => {
    const venue = await makeVenue();
    // Raw 10:00-12:00 and 12:30-14:00 do not meet; occupied 09:30-12:45 and 12:00-14:45 do.
    const a = await pending(venue, at('10:00'), at('12:00'), at('07:00'));
    const b = await pending(venue, at('12:30'), at('14:00'), at('07:01'));

    expect(await overlapIds(a.id)).toEqual([b.id]);
    expect(await overlapIds(b.id)).toEqual([a.id]);
  });

  it('SCRUM258_AC1_occupied_periods_that_only_touch_do_not_overlap', async () => {
    const venue = await makeVenue();
    // A occupies 09:30-12:45; B starts 13:15, so occupies from 12:45.
    const a = await pending(venue, at('10:00'), at('12:00'), at('07:00'));
    const b = await pending(venue, at('13:15'), at('14:00'), at('07:01'));

    expect(await overlapIds(a.id)).toEqual([]);
    expect(await overlapIds(b.id)).toEqual([]);
  });

  it('SCRUM258_AC1_an_overlap_at_another_venue_is_not_listed', async () => {
    const [venueA, venueB] = [await makeVenue(), await makeVenue()];
    const a = await pending(venueA, at('10:00'), at('12:00'), at('07:00'));
    const b = await pending(venueB, at('10:00'), at('12:00'), at('07:01'));

    expect(await overlapIds(a.id)).toEqual([]);
    expect(await overlapIds(b.id)).toEqual([]);
  });

  it('SCRUM258_AC1_overlapping_requests_are_in_submission_order', async () => {
    const venue = await makeVenue();
    const subject = await pending(venue, at('10:00'), at('12:00'), at('07:00'));
    // Written latest first, so only ordering by created_at gives 07:01, 07:02, 07:03.
    const third = await pending(venue, at('11:00'), at('13:00'), at('07:03'));
    const second = await pending(venue, at('09:00'), at('10:30'), at('07:02'));
    const first = await pending(venue, at('11:30'), at('12:30'), at('07:01'));

    const overlapping = (await entryFor(subject.id)).overlapping;

    expect(overlapping.map((o) => o.id)).toEqual([first.id, second.id, third.id]);
    expect(overlapping[0]).toMatchObject({ event_request_id: first.eventId });
    expect(overlapping[0].event_name).toEqual(expect.any(String));
  });

  it('SCRUM258_AC1_each_request_shows_its_own_expected_attendance', async () => {
    const [venueA, venueB] = [await makeVenue(), await makeVenue()];
    const eventId = await makeEvent({ attendance: 150 });
    const request = async (venueId, attendance) =>
      (
        await one(
          'select create_booking_request($1, $2, $3, null, null, $4::jsonb, false, $5) as result',
          [eventId, venueId, coordinator, JSON.stringify(SUITABLE), attendance],
        )
      ).result.booking.id;
    const atA = await request(venueA, 120);
    const atB = await request(venueB, 80);

    expect((await entryFor(atA)).expected_attendance).toBe(120);
    expect((await entryFor(atB)).expected_attendance).toBe(80);
    expect((await entryFor(atA)).suitability_result).toEqual(SUITABLE);
  });

  it('SCRUM258_AC1_the_occupied_period_is_start_minus_setup_to_end_plus_turnaround', async () => {
    const venue = await makeVenue();
    const a = await pending(venue, at('10:00'), at('12:00'), at('07:00'));
    const b = await pending(venue, at('11:00'), at('13:00'), at('07:01'));

    const entry = await entryFor(a.id);

    expect(ms(entry.starts_at)).toBe(ms(at('10:00')));
    expect(ms(entry.occupied_starts_at)).toBe(ms(at('09:30')));
    expect(ms(entry.occupied_ends_at)).toBe(ms(at('12:45')));
    const [other] = entry.overlapping;
    expect(other.id).toBe(b.id);
    expect(ms(other.occupied_starts_at)).toBe(ms(at('10:30')));
    expect(ms(other.occupied_ends_at)).toBe(ms(at('13:45')));
  });
});
