/**
 * The event's assigned coordinator or Venue Staff cancel a booking flagged for
 * review (077), against a real Postgres.
 *
 * SCRUM-266 AC3 and AC5 at the SQL level: any flag can be cancelled, the
 * cancelled booking frees the venue so the coordinator can request it again,
 * the event is untouched, and every cancellation leaves a booking_resolutions
 * row with a snapshot of the flag. Week 7: each booking of an event is
 * resolved on its own.
 *
 * Migrations: reinstateFlaggedBookingDatabase.test.js's stack (with its
 * stand-ins for SCRUM-19, 062's enum values and 071's review reason), then 077.
 *
 * Dates: D is the Singapore date 10 days from now, never hard-coded, because
 * a block or hold counts only while it has not ended.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name) => readFileSync(resolve(here, '../../db/migrations', name), 'utf8');
const MIGRATION_077 = '077_cancel_flagged_booking.sql';

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
  '034_setup_change_recheck.sql',
  '040_venue_holds.sql',
  '051_multi_venue_booking_requests.sql',
  '065_booking_decision_statuses.sql',
  'SAFETY_ENUM',
  '066_venue_staff_booking_decisions.sql',
  'SAFETY_REASON',
  '076_reinstate_flagged_booking.sql',
  MIGRATION_077,
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

/** 071's review-reason list, which adds 'safety_review' to 034's. */
const SAFETY_REASON = `
  alter table bookings drop constraint if exists bookings_review_reason_known;
  alter table bookings
    add constraint bookings_review_reason_known
    check (review_reason in ('setup_or_turnaround_changed', 'safety_review'));
`;

/** D: the Singapore date 10 days from now, as YYYY-MM-DD. */
const D = new Date(Date.now() + 8 * 3600_000 + 10 * 86_400_000).toISOString().slice(0, 10);
/** An instant on D, written at +08:00 (Singapore). */
const at = (hhmm) => `${D}T${hhmm}:00+08:00`;

const NO_ONE = '00000000-0000-4000-8000-000000000000';

/** The error a promise rejected with; null if it resolved. */
const refusal = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
};

describe('SCRUM-266 AC3 and AC5: cancelling a flagged booking (077)', () => {
  let db;
  let organiser;
  let coordinator;
  let otherCoordinator;
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

  async function makeEvent({ status = 'approved', start = at('14:00'), end = at('16:00'), assigned } = {}) {
    counter += 1;
    return (
      await one(
        `insert into event_requests
           (organiser_id, event_name, status, proposed_start, proposed_end,
            expected_attendance, submitted_at, assigned_coordinator_id)
         values ($1, $2, $3, $4, $5, 150, now(), $6) returning id`,
        [organiser, `Event ${counter}`, status, start, end, assigned === undefined ? coordinator : assigned],
      )
    ).id;
  }

  /** A pending booking for the event's own period, written directly. */
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

  const decide = async (bookingId, decision = 'approve', reason = null) =>
    (
      await one('select decide_booking_request($1, $2, $3, $4, null) as result', [
        bookingId,
        staff,
        decision,
        reason,
      ])
    ).result;

  /** A booking approved by Venue Staff, so its decision is recorded. */
  async function approved(venueId, eventId) {
    const id = await insertBooking(eventId, venueId);
    expect((await decide(id)).outcome).toBe('approved');
    return id;
  }

  /** A block over start-end, created with the override that flags bookingIds. */
  async function blockFlagging(venueId, start, end, bookingIds) {
    const { result } = await one(
      `select create_venue_block($1, $2, $3, 'maintenance', null, $4, true, $5::uuid[]) as result`,
      [venueId, start, end, staff, bookingIds],
    );
    expect(result.outcome).toBe('created');
    return result.block.id;
  }

  /**
   * An approved booking flagged by a block over 15:00-17:00 on its venue: an
   * event 14:00-16:00 at a fresh venue unless one is given.
   */
  async function flagged({ venueId, eventId } = {}) {
    const venue = venueId ?? (await makeVenue());
    const event = eventId ?? (await makeEvent());
    const id = await approved(venue, event);
    const blockId = await blockFlagging(venue, at('15:00'), at('17:00'), [id]);
    expect((await bookingRow(id)).status).toBe('flagged_for_review');
    return { id, venueId: venue, eventId: event, blockId };
  }

  /** An approved booking flagged by a reason rather than a block, as 034 and 071 flag them. */
  async function flaggedFor(reviewReason, { eventId } = {}) {
    const venueId = await makeVenue();
    const event = eventId ?? (await makeEvent());
    const id = await approved(venueId, event);
    await db.query(
      `update bookings
          set status = 'flagged_for_review', review_reason = $2, flagged_at = now(), flagged_by = $3
        where id = $1`,
      [id, reviewReason, staff],
    );
    return { id, venueId, eventId: event };
  }

  const cancel = async (bookingId, { caller = coordinator, reason = 'Venue no longer fits' } = {}) =>
    (await one('select cancel_flagged_booking($1, $2, $3) as result', [bookingId, caller, reason])).result;

  const reinstate = async (bookingId) =>
    (
      await one('select reinstate_flagged_booking($1, $2, $3) as result', [bookingId, staff, 'Block moved'])
    ).result;

  const bookingRow = (id) => one('select * from bookings where id = $1', [id]);
  const eventRow = (id) => one('select * from event_requests where id = $1', [id]);
  const resolutionsFor = (id) => rows('select * from booking_resolutions where booking_id = $1', [id]);

  /** Refused with PT409 and the hint, leaving the booking and the record unchanged. */
  async function expectNotFlagged(id) {
    const before = await bookingRow(id);
    const resolutionsBefore = await resolutionsFor(id);
    const err = await refusal(cancel(id));
    expect(err?.code).toBe('PT409');
    expect(err?.hint).toBe('BOOKING_NOT_FLAGGED');
    expect(await bookingRow(id)).toEqual(before);
    expect(await resolutionsFor(id)).toEqual(resolutionsBefore);
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
      else if (name === 'SAFETY_REASON') await db.exec(SAFETY_REASON);
      else await db.exec(migration(name));
    }
    organiser = await makeUser('o@x', 'event_organiser');
    coordinator = await makeUser('c@x', 'event_coordinator');
    otherCoordinator = await makeUser('c2@x', 'event_coordinator');
    staff = await makeUser('s@x', 'venue_staff');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('AC3: the assigned coordinator or Venue Staff cancel it', () => {
    it('SCRUM266_AC3_the_assigned_coordinator_cancels_a_flagged_booking', async () => {
      const { id } = await flagged();

      const result = await cancel(id, { caller: coordinator });

      expect(result.outcome).toBe('cancelled');
      expect(result.booking).toMatchObject({ id, status: 'cancelled' });
      expect(result.resolution).toMatchObject({ booking_id: id, outcome: 'cancelled', resolved_by: coordinator });
      expect((await bookingRow(id)).status).toBe('cancelled');
    });

    it('SCRUM266_AC3_venue_staff_cancel_a_flagged_booking', async () => {
      const { id } = await flagged();

      const result = await cancel(id, { caller: staff });

      expect(result.outcome).toBe('cancelled');
      expect(result.resolution.resolved_by).toBe(staff);
      expect((await bookingRow(id)).status).toBe('cancelled');
    });

    it('SCRUM266_AC3_venue_staff_cancel_a_booking_whose_event_has_no_coordinator', async () => {
      const { id } = await flagged({ eventId: await makeEvent({ assigned: null }) });

      expect((await cancel(id, { caller: staff })).outcome).toBe('cancelled');
    });

    it.each([
      ['another coordinator', () => otherCoordinator],
      ['an organiser', () => organiser],
      ['a null caller', () => null],
      ['a user with no profile', () => NO_ONE],
    ])('SCRUM266_AC3_%s_is_refused_with_42501', async (_label, caller) => {
      const { id } = await flagged();
      const before = await bookingRow(id);

      expect((await refusal(cancel(id, { caller: caller() })))?.code).toBe('42501');
      expect(await bookingRow(id)).toEqual(before);
      expect(await resolutionsFor(id)).toEqual([]);
    });

    it('SCRUM266_AC3_a_null_caller_is_refused_when_the_event_has_no_coordinator', async () => {
      const { id } = await flagged({ eventId: await makeEvent({ assigned: null }) });

      expect((await refusal(cancel(id, { caller: null })))?.code).toBe('42501');
      expect((await bookingRow(id)).status).toBe('flagged_for_review');
    });

    it('SCRUM266_AC3_a_safety_review_flag_can_be_cancelled', async () => {
      const { id } = await flaggedFor('safety_review');

      expect((await cancel(id)).outcome).toBe('cancelled');
      expect(await bookingRow(id)).toMatchObject({ status: 'cancelled', review_reason: 'safety_review' });
    });

    it('SCRUM266_AC3_a_setup_change_flag_can_be_cancelled', async () => {
      const { id } = await flaggedFor('setup_or_turnaround_changed');

      expect((await cancel(id, { caller: staff })).outcome).toBe('cancelled');
      expect(await bookingRow(id)).toMatchObject({
        status: 'cancelled',
        review_reason: 'setup_or_turnaround_changed',
        review_block_id: null,
      });
    });

    it.each([
      ['pending', async (venue, event) => insertBooking(event, venue)],
      ['approved', async (venue, event) => approved(venue, event)],
      [
        'rejected',
        async (venue, event) => {
          const id = await insertBooking(event, venue);
          await decide(id, 'reject', 'No');
          return id;
        },
      ],
      [
        'cancelled',
        async (venue, event) => {
          const { id } = await flagged({ venueId: venue, eventId: event });
          await db.query("update bookings set status = 'cancelled' where id = $1", [id]);
          return id;
        },
      ],
    ])('SCRUM266_AC3_a_%s_booking_is_not_flagged_and_is_refused', async (status, make) => {
      const id = await make(await makeVenue(), await makeEvent());
      expect((await bookingRow(id)).status).toBe(status);

      await expectNotFlagged(id);
    });
  });

  describe('AC3: the venue is free again and the event is untouched', () => {
    it('SCRUM266_AC3_after_cancelling_the_coordinator_can_request_the_same_venue_again', async () => {
      const { id, venueId, eventId, blockId } = await flagged();
      const request = () =>
        one(
          `select create_booking_request($1, $2, $3, null, null, '{"suitable": true}'::jsonb, false, 100) as result`,
          [eventId, venueId, coordinator],
        );

      // While flagged, 066 step 6 refuses a second request at this venue.
      const blocked = await refusal(request());
      expect(blocked?.hint).toBe('BOOKING_FLAGGED_FOR_REVIEW');

      await cancel(id);
      await db.query('update venue_blocks set removed_at = now() where id = $1', [blockId]);
      const { result } = await request();

      expect(result.outcome).toBe('created');
      expect(result.booking).toMatchObject({ venue_id: venueId, event_request_id: eventId, status: 'pending' });
      expect(result.booking.id).not.toBe(id);
    });

    it('SCRUM266_AC3_after_cancelling_the_coordinator_can_request_another_venue', async () => {
      const { id, eventId } = await flagged();
      await cancel(id);

      const { result } = await one(
        `select create_booking_request($1, $2, $3, null, null, '{"suitable": true}'::jsonb, false, 100) as result`,
        [eventId, await makeVenue(), coordinator],
      );

      expect(result.outcome).toBe('created');
    });

    it('SCRUM266_AC3_a_cancelled_booking_no_longer_occupies_the_venue', async () => {
      const { id, venueId } = await flagged();
      const occupants = async () =>
        (
          await rows(
            `select id from venue_occupancy_conflicts($1, $2, $3, true, null) where kind = 'booking'`,
            [venueId, at('14:00'), at('16:00')],
          )
        ).map((r) => r.id);
      expect(await occupants()).toEqual([id]);

      await cancel(id);

      expect(await occupants()).toEqual([]);
    });

    it.each(['approved', 'safety_review', 'safety_approved', 'confirmed'])(
      'SCRUM266_AC3_the_%s_event_keeps_its_status_and_fields',
      async (status) => {
        const eventId = await makeEvent();
        const { id } = await flagged({ eventId });
        await db.query('update event_requests set status = $2 where id = $1', [eventId, status]);
        const before = await eventRow(eventId);

        expect((await cancel(id)).outcome).toBe('cancelled');

        expect(await eventRow(eventId)).toEqual(before);
      },
    );

    it('SCRUM266_AC3_cancelling_locks_the_event_then_the_booking_and_never_the_venue', () => {
      const sql = migration(MIGRATION_077);
      const start = sql.indexOf('create or replace function cancel_flagged_booking');
      const body = sql.slice(start, sql.indexOf('$$;', start));

      const eventLock = body.search(/from\s+event_requests\s+where\s+id\s*=\s*v_event_id\s+for update/);
      const bookingLock = body.search(/from\s+bookings\s+where\s+id\s*=\s*p_booking_id\s+for update/);
      const record = body.indexOf('insert into booking_resolutions');

      expect(eventLock).toBeGreaterThan(-1);
      expect(bookingLock).toBeGreaterThan(eventLock);
      expect(record).toBeGreaterThan(bookingLock);
      expect(body).not.toMatch(/from\s+venues/);
      expect(body).not.toMatch(/security definer/i);
    });
  });

  describe('AC5: the resolution is recorded and the flag kept', () => {
    it('SCRUM266_AC5_cancelling_records_outcome_who_why_when_and_the_flag_and_keeps_it_on_the_booking', async () => {
      const { id, blockId } = await flagged();
      const before = await bookingRow(id);
      const startedAt = Date.now();

      const result = await cancel(id, { reason: '  Moving to a bigger room  ' });

      const recorded = await resolutionsFor(id);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        booking_id: id,
        outcome: 'cancelled',
        reason: 'Moving to a bigger room',
        resolved_by: coordinator,
        review_block_id: blockId,
        review_reason: null,
        flagged_by: staff,
        replacement_booking_id: null,
      });
      expect(recorded[0].flagged_at).toEqual(before.flagged_at);
      expect(recorded[0].created_at.getTime()).toBeGreaterThanOrEqual(startedAt - 5_000);

      // Only the status moves: the flag and the decision stay as they were.
      expect(await bookingRow(id)).toEqual({ ...before, status: 'cancelled' });

      expect(result.resolution).toMatchObject({
        id: recorded[0].id,
        booking_id: id,
        outcome: 'cancelled',
        reason: 'Moving to a bigger room',
        resolved_by: coordinator,
      });
      expect(result.resolution.created_at).toEqual(expect.any(String));
      expect(result.booking).toMatchObject({ id, status: 'cancelled', review_block_id: blockId });
    });

    it.each(['setup_or_turnaround_changed', 'safety_review'])(
      'SCRUM266_AC5_a_%s_flag_is_snapshotted_by_venue_staff_and_kept',
      async (reviewReason) => {
        const { id } = await flaggedFor(reviewReason);
        const before = await bookingRow(id);

        await cancel(id, { caller: staff });

        const recorded = await resolutionsFor(id);
        expect(recorded).toEqual([
          expect.objectContaining({
            outcome: 'cancelled',
            resolved_by: staff,
            review_reason: reviewReason,
            review_block_id: null,
            flagged_by: staff,
          }),
        ]);
        expect(recorded[0].flagged_at).toEqual(before.flagged_at);
        expect(await bookingRow(id)).toEqual({ ...before, status: 'cancelled' });
      },
    );

    it.each([
      ['no reason', null],
      ['an empty reason', ''],
      ['a blank reason', '   '],
    ])('SCRUM266_AC5_%s_is_refused_with_22023', async (_label, reason) => {
      const { id } = await flagged();

      expect((await refusal(cancel(id, { reason })))?.code).toBe('22023');
      expect((await bookingRow(id)).status).toBe('flagged_for_review');
      expect(await resolutionsFor(id)).toEqual([]);
    });

    it('SCRUM266_AC5_a_reason_over_1000_characters_is_refused_with_23514', async () => {
      const { id } = await flagged();

      expect((await refusal(cancel(id, { reason: 'x'.repeat(1001) })))?.code).toBe('23514');
      expect((await bookingRow(id)).status).toBe('flagged_for_review');
      expect(await resolutionsFor(id)).toEqual([]);
    });

    it('SCRUM266_AC5_a_reason_of_exactly_1000_characters_after_trimming_is_accepted', async () => {
      const { id } = await flagged();

      const result = await cancel(id, { reason: `  ${'x'.repeat(1000)}  ` });

      expect(result.outcome).toBe('cancelled');
      expect(result.resolution.reason).toHaveLength(1000);
    });

    it('SCRUM266_AC5_an_unknown_booking_is_not_found', async () => {
      expect((await refusal(cancel('00000000-0000-4000-8000-000000000001')))?.code).toBe('P0002');
    });

    it('SCRUM266_AC5_a_cancelled_booking_cannot_be_cancelled_again', async () => {
      const { id } = await flagged();
      await cancel(id);

      await expectNotFlagged(id);
      expect(await resolutionsFor(id)).toHaveLength(1);
    });

    it('SCRUM266_AC5_a_cancelled_booking_cannot_be_reinstated', async () => {
      const { id, blockId } = await flagged();
      await cancel(id);
      await db.query('update venue_blocks set removed_at = now() where id = $1', [blockId]);
      const before = await bookingRow(id);

      const err = await refusal(reinstate(id));

      expect(err?.code).toBe('PT409');
      expect(err?.hint).toBe('BOOKING_NOT_FLAGGED');
      expect(await bookingRow(id)).toEqual(before);
      expect(await resolutionsFor(id)).toHaveLength(1);
    });

    it('SCRUM266_AC5_the_function_is_not_granted_to_anon_or_authenticated', async () => {
      const grants = await one(
        `select has_function_privilege('anon', 'cancel_flagged_booking(uuid, uuid, text)', 'execute') as anon,
                has_function_privilege('authenticated', 'cancel_flagged_booking(uuid, uuid, text)', 'execute') as authenticated`,
      );
      expect(grants).toEqual({ anon: false, authenticated: false });
    });
  });

  describe('Week 7: each booking is resolved on its own', () => {
    it('SCRUM266_W7_cancelling_one_booking_leaves_the_events_other_flagged_booking_untouched', async () => {
      const eventId = await makeEvent();
      const a = await flagged({ eventId });
      const b = await flagged({ eventId });
      const otherBefore = await bookingRow(b.id);

      expect((await cancel(a.id)).outcome).toBe('cancelled');

      expect((await bookingRow(a.id)).status).toBe('cancelled');
      expect(await bookingRow(b.id)).toEqual(otherBefore);
      expect(await resolutionsFor(b.id)).toEqual([]);
    });

    it('SCRUM266_W7_cancelling_a_flagged_booking_leaves_the_events_approved_booking_untouched', async () => {
      const eventId = await makeEvent();
      const a = await flagged({ eventId });
      const kept = await approved(await makeVenue(), eventId);
      const keptBefore = await bookingRow(kept);

      await cancel(a.id);

      expect(await bookingRow(kept)).toEqual(keptBefore);
    });
  });

  describe('the migration is re-runnable', () => {
    it('SCRUM266_AC5_running_077_again_keeps_the_function_and_the_records', async () => {
      const { id } = await flagged();
      await cancel(id);

      await db.exec(migration(MIGRATION_077));
      await db.exec(migration(MIGRATION_077));

      expect(await resolutionsFor(id)).toHaveLength(1);
      const second = await flagged();
      expect((await cancel(second.id)).outcome).toBe('cancelled');
      const { count } = await one(
        `select count(*)::int as count from pg_proc where proname = 'cancel_flagged_booking'`,
      );
      expect(count).toBe(1);
    });
  });
});
