/**
 * Approving a booking request converts the approving event's own hold at that
 * venue instead of releasing it (065, 066), against a real Postgres.
 *
 * SCRUM-258 Week 7: holds are not released on approval; the event's own hold
 * for the same venue becomes converted (SCRUM-491). An expired hold never
 * counts as a booking, and each request is decided on its own.
 *
 * Migrations: conflictingBookingRequestDatabase.test.js's stack (065's enum
 * values must commit before 066 uses them, so each is its own exec).
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
  'SAFETY_ENUM',
  '066_venue_staff_booking_decisions.sql',
];

/** What 014 reads from SCRUM-19's migration, which is not on this branch. */
const DECISION_STAND_IN = `
  alter table event_requests
    add column if not exists reviewing_coordinator_id uuid references auth.users (id);
`;

/** 062's `alter type ... add value` lines, read from the file, not retyped. */
const SAFETY_ENUM = migration('062_safety_statuses.sql')
  .split('\n')
  .filter((line) => line.startsWith('alter type event_request_status add value'))
  .join('\n');

/** D: the Singapore date 10 days from now, as YYYY-MM-DD. */
const D = new Date(Date.now() + 8 * 3600_000 + 10 * 86_400_000).toISOString().slice(0, 10);
/** An instant on D, written at +08:00 (Singapore). */
const at = (hhmm) => `${D}T${hhmm}:00+08:00`;

/** The error a promise rejected with; null if it resolved. */
const refusal = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
};

describe('SCRUM-258 Week 7: approval converts the event\'s own hold (065, 066)', () => {
  let db;
  let organiser;
  let coordinator;
  let staff;
  let counter = 0;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const rows = async (sql, params) => (await db.query(sql, params)).rows;

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

  async function makeEvent({ start = at('14:00'), end = at('16:00'), status = 'approved' } = {}) {
    counter += 1;
    return (
      await one(
        `insert into event_requests
           (organiser_id, event_name, status, proposed_start, proposed_end,
            expected_attendance, submitted_at, assigned_coordinator_id)
         values ($1, $2, $3, $4, $5, 150, now(), $6) returning id`,
        [organiser, `Event ${counter}`, status, start, end, coordinator],
      )
    ).id;
  }

  /** A pending booking request written directly, for the event's own period. */
  async function insertBooking(eventId, venueId) {
    const event = await one('select proposed_start, proposed_end from event_requests where id = $1', [eventId]);
    return (
      await one(
        `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
         values ($1, $2, $3, $4, 'pending') returning id`,
        [venueId, eventId, event.proposed_start, event.proposed_end],
      )
    ).id;
  }

  /** An active hold, unexpired by default; a lapsed one is placed two hours ago. */
  async function insertHold(eventId, venueId, { lapsed = false } = {}) {
    const [placed, expires] = lapsed ? ["now() - interval '2 hours'", "now() - interval '1 hour'"] : ['now()', "now() + interval '2 days'"];
    return (
      await one(
        `insert into venue_holds (event_request_id, venue_id, placed_by, placed_at, expires_at)
         values ($1, $2, $3, ${placed}, ${expires}) returning id`,
        [eventId, venueId, staff],
      )
    ).id;
  }

  const decide = async (bookingId, decision, reason = null) =>
    (
      await one('select decide_booking_request($1, $2, $3, $4, null) as result', [bookingId, staff, decision, reason])
    ).result;

  const holdOf = (id) =>
    one(
      `select status::text as status, converted_at, converted_booking_id, expired_at
         from venue_holds where id = $1`,
      [id],
    );

  /** An event with a pending request and an active hold at a new venue. */
  async function heldRequest() {
    const venueId = await makeVenue();
    const eventId = await makeEvent();
    const bookingId = await insertBooking(eventId, venueId);
    const holdId = await insertHold(eventId, venueId);
    return { venueId, eventId, bookingId, holdId };
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
      if (name === 'STAND_IN') await db.exec(DECISION_STAND_IN);
      else if (name === 'SAFETY_ENUM') await db.exec(SAFETY_ENUM);
      else await db.exec(migration(name));
    }
    organiser = await makeUser('o@x', 'event_organiser');
    coordinator = await makeUser('c@x', 'event_coordinator');
    staff = await makeUser('s@x', 'venue_staff');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('what an approval converts', () => {
    it('SCRUM258_Week7_approval_converts_the_events_own_active_hold_into_the_approved_booking', async () => {
      const { bookingId, holdId } = await heldRequest();

      const result = await decide(bookingId, 'approve');

      expect(result.outcome).toBe('approved');
      expect(result.converted_hold_id).toBe(holdId);
      // Converted, not released or expired: the hold became the booking.
      const hold = await holdOf(holdId);
      expect(hold.status).toBe('converted');
      expect(hold.expired_at).toBeNull();
      expect(hold.converted_at).not.toBeNull();
      expect(hold.converted_booking_id).toBe(bookingId);
    });

    it('SCRUM258_Week7_only_the_hold_at_the_booked_venue_is_converted_not_the_events_other_venue_or_other_events', async () => {
      const { venueId, eventId, bookingId, holdId } = await heldRequest();
      const elsewhere = await makeVenue();
      const ownElsewhere = await insertHold(eventId, elsewhere);
      // Later the same day, so it does not refuse the approval: occupies 17:30-19:45.
      const otherEvent = await makeEvent({ start: at('18:00'), end: at('19:00') });
      const otherEventsHold = await insertHold(otherEvent, venueId);

      const result = await decide(bookingId, 'approve');

      expect(result.converted_hold_id).toBe(holdId);
      expect((await holdOf(ownElsewhere)).status).toBe('active');
      expect((await holdOf(otherEventsHold)).status).toBe('active');
    });

    it('SCRUM258_Week7_a_hold_past_its_expiry_is_not_converted_and_the_expiry_job_still_expires_it', async () => {
      const venueId = await makeVenue();
      const eventId = await makeEvent();
      const bookingId = await insertBooking(eventId, venueId);
      const lapsed = await insertHold(eventId, venueId, { lapsed: true });

      const result = await decide(bookingId, 'approve');

      expect(result.outcome).toBe('approved');
      expect(result.converted_hold_id).toBeNull();
      expect((await holdOf(lapsed)).status).toBe('active');

      await db.query('select process_venue_hold_expiry()');
      const hold = await holdOf(lapsed);
      expect(hold.status).toBe('expired');
      expect(hold.converted_at).toBeNull();
      expect(hold.converted_booking_id).toBeNull();
    });

    it('SCRUM258_Week7_an_approval_with_no_hold_succeeds_and_converts_nothing', async () => {
      const venueId = await makeVenue();
      const bookingId = await insertBooking(await makeEvent(), venueId);

      const result = await decide(bookingId, 'approve');

      expect(result.outcome).toBe('approved');
      expect(result).toHaveProperty('converted_hold_id', null);
    });
  });

  describe('what leaves the hold alone', () => {
    it('SCRUM258_Week7_a_rejection_leaves_the_hold_active', async () => {
      const { bookingId, holdId } = await heldRequest();

      const result = await decide(bookingId, 'reject', 'Under maintenance');

      expect(result.outcome).toBe('rejected');
      expect(result).not.toHaveProperty('converted_hold_id');
      expect(await holdOf(holdId)).toMatchObject({ status: 'active', converted_at: null, converted_booking_id: null });
    });

    it('SCRUM258_Week7_an_approval_refused_for_a_conflict_leaves_the_hold_active', async () => {
      const { venueId, bookingId, holdId } = await heldRequest();
      // Another event's active hold over the same period occupies the venue.
      await insertHold(await makeEvent(), venueId);

      const result = await decide(bookingId, 'approve');

      expect(result.outcome).toBe('conflict');
      expect((await holdOf(holdId)).status).toBe('active');
    });

    it('SCRUM258_Week7_an_approval_refused_for_an_unbookable_event_leaves_the_hold_active', async () => {
      const { eventId, bookingId, holdId } = await heldRequest();
      await db.query("update event_requests set status = 'submitted' where id = $1", [eventId]);

      const err = await refusal(decide(bookingId, 'approve'));

      expect(err?.hint).toBe('EVENT_NOT_BOOKABLE');
      expect((await holdOf(holdId)).status).toBe('active');
    });
  });

  describe('occupancy after conversion', () => {
    const occupants = (venueId) =>
      rows(
        `select kind, id from venue_occupancy_conflicts($1, $2, $3, true, null) order by kind`,
        [venueId, at('14:00'), at('16:00')],
      );

    it('SCRUM258_Week7_after_conversion_the_booking_occupies_the_venue_and_the_hold_no_longer_does', async () => {
      const { venueId, bookingId, holdId } = await heldRequest();
      expect(await occupants(venueId)).toEqual([{ kind: 'hold', id: holdId }]);

      await decide(bookingId, 'approve');

      expect(await occupants(venueId)).toEqual([{ kind: 'booking', id: bookingId }]);
    });

    it('SCRUM258_Week7_the_expiry_job_never_expires_a_converted_hold_even_past_its_expiry', async () => {
      const { bookingId, holdId } = await heldRequest();
      await decide(bookingId, 'approve');
      await db.query(
        `update venue_holds set placed_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
          where id = $1`,
        [holdId],
      );

      await db.query('select process_venue_hold_expiry()');

      expect(await holdOf(holdId)).toMatchObject({ status: 'converted', expired_at: null, converted_booking_id: bookingId });
      expect(
        await rows("select 1 from notifications where venue_hold_id = $1 and type = 'venue_hold_expired'", [holdId]),
      ).toHaveLength(0);
    });
  });

  describe('the converted columns match the status', () => {
    it('SCRUM258_Week7_a_converted_hold_needs_converted_at_and_its_booking', async () => {
      const { bookingId, holdId } = await heldRequest();
      await decide(bookingId, 'approve');

      const noTime = await refusal(db.query('update venue_holds set converted_at = null where id = $1', [holdId]));
      const noBooking = await refusal(db.query('update venue_holds set converted_booking_id = null where id = $1', [holdId]));

      expect(noTime?.constraint).toBe('venue_holds_converted_at_matches_status');
      expect(noBooking?.constraint).toBe('venue_holds_converted_booking_matches_status');
    });

    it('SCRUM258_Week7_a_hold_that_is_not_converted_cannot_carry_converted_at_or_a_booking', async () => {
      const { bookingId, holdId } = await heldRequest();

      const withTime = await refusal(db.query('update venue_holds set converted_at = now() where id = $1', [holdId]));
      const withBooking = await refusal(
        db.query('update venue_holds set converted_booking_id = $2 where id = $1', [holdId, bookingId]),
      );

      expect(withTime?.constraint).toBe('venue_holds_converted_at_matches_status');
      expect(withBooking?.constraint).toBe('venue_holds_converted_booking_matches_status');
    });
  });
});
