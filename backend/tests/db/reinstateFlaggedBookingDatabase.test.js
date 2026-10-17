/**
 * Venue Staff reinstate a booking flagged for review (076), against a real
 * Postgres.
 *
 * SCRUM-266 AC2 and AC5 at the SQL level: a flagged booking goes back to
 * approved only while it still covers the event's period and nothing else
 * occupies its padded period, a safety flag is never reinstated, and every
 * reinstatement leaves a booking_resolutions row with a snapshot of the flag
 * it cleared. Week 7: each booking of an event is resolved on its own.
 *
 * Migrations: decideBookingRequestDatabase.test.js's stack plus 034 (the
 * review_reason column and the flag pairing), then 076. 071's
 * bookings_review_reason_known is applied alone as a stand-in, so a booking
 * can carry the 'safety_review' flag without 071's other dependencies.
 *
 * Bookings are approved through decide_booking_request, so decided_at is set
 * and 066's trigger applies to every later move, and flagged through
 * create_venue_block's override, as Venue Staff flag them.
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
const MIGRATION_076 = '076_reinstate_flagged_booking.sql';

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
  MIGRATION_076,
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

describe('SCRUM-266 AC2 and AC5: reinstating a flagged booking (076)', () => {
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

  async function makeEvent({ status = 'approved', start = at('14:00'), end = at('16:00') } = {}) {
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

  const reinstate = async (bookingId, { caller = staff, reason = 'Block moved' } = {}) =>
    (
      await one('select reinstate_flagged_booking($1, $2, $3) as result', [bookingId, caller, reason])
    ).result;

  const bookingRow = (id) => one('select * from bookings where id = $1', [id]);
  const resolutionsFor = (id) => rows('select * from booking_resolutions where booking_id = $1', [id]);

  /** Refused with PT409 and the hint, leaving the booking and the record unchanged. */
  async function expectRefused(id, hint) {
    const before = await bookingRow(id);
    const err = await refusal(reinstate(id));
    expect(err?.code).toBe('PT409');
    expect(err?.hint).toBe(hint);
    expect(await bookingRow(id)).toEqual(before);
    expect(await resolutionsFor(id)).toEqual([]);
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
    staff = await makeUser('s@x', 'venue_staff');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('AC2: a reinstatement re-checks the occupied period', () => {
    it('SCRUM266_AC2_a_block_shortened_off_the_booking_lets_it_be_reinstated', async () => {
      const venue = await makeVenue();
      const event = await makeEvent();
      const id = await approved(venue, event);
      const blockId = await blockFlagging(venue, at('15:00'), at('18:00'), [id]);

      // Occupied 13:30-16:45; the block now starts after the turnaround ends.
      const { result: amended } = await one(
        `select update_venue_block($1, $2, $3, null, null, null, false, $4, false, null) as result`,
        [venue, blockId, at('17:00'), staff],
      );
      expect(amended.outcome).not.toBe('conflict');

      const result = await reinstate(id);

      expect(result.outcome).toBe('reinstated');
      expect(result.booking).toMatchObject({ id, status: 'approved' });
      expect((await bookingRow(id)).status).toBe('approved');
    });

    it('SCRUM266_AC2_a_block_still_over_the_booking_is_a_conflict_and_nothing_is_written', async () => {
      const { id, blockId } = await flagged();
      const before = await bookingRow(id);

      const result = await reinstate(id);

      expect(result.outcome).toBe('conflict');
      expect(result.conflicts.map((c) => [c.kind, c.block_id])).toEqual([['block', blockId]]);
      expect(result).not.toHaveProperty('booking');
      expect(await bookingRow(id)).toEqual(before);
      expect(await resolutionsFor(id)).toEqual([]);
    });

    it('SCRUM266_AC2_a_removed_block_no_longer_conflicts', async () => {
      const { id, blockId } = await flagged();
      await db.query('update venue_blocks set removed_at = now() where id = $1', [blockId]);

      expect((await reinstate(id)).outcome).toBe('reinstated');
    });

    it('SCRUM266_AC2_another_approved_booking_inside_the_setup_and_turnaround_padding_is_a_conflict', async () => {
      const { id, venueId, blockId } = await flagged();
      await db.query('update venue_blocks set removed_at = now() where id = $1', [blockId]);
      // Raw 16:30-17:30 misses 14:00-16:00; occupied 16:00-18:15 meets 13:30-16:45.
      const other = await makeEvent({ start: at('16:30'), end: at('17:30') });
      const otherId = (
        await one(
          `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
           values ($1, $2, $3, $4, 'approved') returning id`,
          [venueId, other, at('16:30'), at('17:30')],
        )
      ).id;
      const before = await bookingRow(id);

      const result = await reinstate(id);

      expect(result.outcome).toBe('conflict');
      expect(result.conflicts.map((c) => [c.kind, c.booking_id])).toEqual([['booking', otherId]]);
      expect(result.conflicts[0]).toMatchObject({ setup_minutes: 30, turnaround_minutes: 45 });
      expect(await bookingRow(id)).toEqual(before);
      expect(await resolutionsFor(id)).toEqual([]);
    });

    it('SCRUM266_AC2_another_booking_whose_padding_only_touches_does_not_conflict', async () => {
      const { id, venueId, blockId } = await flagged();
      await db.query('update venue_blocks set removed_at = now() where id = $1', [blockId]);
      // Occupied from 16:45, exactly where this booking's turnaround ends.
      const other = await makeEvent({ start: at('17:15'), end: at('18:00') });
      await db.query(
        `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
         values ($1, $2, $3, $4, 'approved')`,
        [venueId, other, at('17:15'), at('18:00')],
      );

      expect((await reinstate(id)).outcome).toBe('reinstated');
    });

    it('SCRUM266_AC2_a_booking_no_longer_covering_the_moved_event_period_is_stale', async () => {
      const { id, eventId } = await flagged();
      await db.query(
        'update event_requests set proposed_start = $2, proposed_end = $3 where id = $1',
        [eventId, at('18:00'), at('20:00')],
      );

      await expectRefused(id, 'BOOKING_PERIOD_STALE');
    });

    it('SCRUM266_AC2_an_event_with_no_period_is_covered_by_nothing', async () => {
      const { id, eventId } = await flagged();
      await db.query('update event_requests set proposed_start = null, proposed_end = null where id = $1', [eventId]);

      await expectRefused(id, 'BOOKING_PERIOD_STALE');
    });

    it('SCRUM266_AC2_a_booking_that_covers_a_shortened_event_period_can_be_reinstated', async () => {
      const { id, eventId, blockId } = await flagged();
      await db.query('update venue_blocks set removed_at = now() where id = $1', [blockId]);
      await db.query(
        'update event_requests set proposed_start = $2, proposed_end = $3 where id = $1',
        [eventId, at('14:30'), at('15:30')],
      );

      expect((await reinstate(id)).outcome).toBe('reinstated');
    });

    it('SCRUM266_AC2_a_safety_review_flag_cannot_be_reinstated', async () => {
      const venue = await makeVenue();
      const id = await approved(venue, await makeEvent());
      await db.query(
        `update bookings
            set status = 'flagged_for_review', review_reason = 'safety_review', flagged_at = now(), flagged_by = $2
          where id = $1`,
        [id, staff],
      );

      await expectRefused(id, 'SAFETY_FLAG_NOT_REINSTATABLE');
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
    ])('SCRUM266_AC2_a_%s_booking_is_not_flagged_and_is_refused', async (_status, make) => {
      const id = await make(await makeVenue(), await makeEvent());

      await expectRefused(id, 'BOOKING_NOT_FLAGGED');
    });

    it.each(['cancelled', 'rejected', 'completed', 'under_review'])(
      'SCRUM266_AC2_a_booking_for_a_%s_event_is_refused_as_not_bookable',
      async (status) => {
        const { id, eventId } = await flagged();
        await db.query('update event_requests set status = $2 where id = $1', [eventId, status]);

        await expectRefused(id, 'EVENT_NOT_BOOKABLE');
      },
    );

    it.each(['safety_review', 'safety_approved', 'confirmed'])(
      'SCRUM266_AC2_a_booking_for_a_%s_event_can_be_reinstated',
      async (status) => {
        const { id, eventId, blockId } = await flagged();
        await db.query('update venue_blocks set removed_at = now() where id = $1', [blockId]);
        await db.query('update event_requests set status = $2 where id = $1', [eventId, status]);

        expect((await reinstate(id)).outcome).toBe('reinstated');
      },
    );

    it('SCRUM266_AC2_a_booking_at_a_retired_venue_is_refused', async () => {
      const { id, venueId } = await flagged();
      await db.query('update venues set retired_at = now() where id = $1', [venueId]);

      await expectRefused(id, 'VENUE_RETIRED');
    });

    it('SCRUM266_AC2_reinstatement_locks_event_then_venue_then_booking_before_the_recheck', () => {
      const sql = migration(MIGRATION_076);
      const start = sql.indexOf('create or replace function reinstate_flagged_booking');
      const body = sql.slice(start, sql.indexOf('$$;', start));

      const eventLock = body.search(/from\s+event_requests\s+where\s+id\s*=\s*v_event_id\s+for update/);
      const venueLock = body.search(/from\s+venues\s+where\s+id\s*=\s*v_venue_id\s+for no key update/);
      const bookingLock = body.search(/from\s+bookings\s+where\s+id\s*=\s*p_booking_id\s+for update/);
      const recheck = body.indexOf('venue_occupancy_conflicts(');

      expect(eventLock).toBeGreaterThan(-1);
      expect(venueLock).toBeGreaterThan(eventLock);
      expect(bookingLock).toBeGreaterThan(venueLock);
      expect(recheck).toBeGreaterThan(bookingLock);
      expect(body).not.toMatch(/security definer/i);
    });
  });

  describe('AC2: only Venue Staff, with a reason', () => {
    it.each([
      ['a coordinator', () => coordinator],
      ['an organiser', () => organiser],
      ['a null caller', () => null],
      ['a user with no profile', () => NO_ONE],
    ])('SCRUM266_AC2_%s_is_refused_with_42501', async (_label, caller) => {
      const { id, blockId } = await flagged();
      await db.query('update venue_blocks set removed_at = now() where id = $1', [blockId]);
      const before = await bookingRow(id);

      expect((await refusal(reinstate(id, { caller: caller() })))?.code).toBe('42501');
      expect(await bookingRow(id)).toEqual(before);
      expect(await resolutionsFor(id)).toEqual([]);
    });

    it.each([
      ['no reason', null],
      ['an empty reason', ''],
      ['a blank reason', '   '],
    ])('SCRUM266_AC5_%s_is_refused_with_22023', async (_label, reason) => {
      const { id } = await flagged();

      expect((await refusal(reinstate(id, { reason })))?.code).toBe('22023');
      expect((await bookingRow(id)).status).toBe('flagged_for_review');
    });

    it('SCRUM266_AC5_a_reason_over_1000_characters_is_refused_with_23514', async () => {
      const { id } = await flagged();

      expect((await refusal(reinstate(id, { reason: 'x'.repeat(1001) })))?.code).toBe('23514');
      expect((await bookingRow(id)).status).toBe('flagged_for_review');
    });

    it('SCRUM266_AC5_a_reason_of_exactly_1000_characters_after_trimming_is_accepted', async () => {
      const { id, blockId } = await flagged();
      await db.query('update venue_blocks set removed_at = now() where id = $1', [blockId]);

      const result = await reinstate(id, { reason: `  ${'x'.repeat(1000)}  ` });

      expect(result.outcome).toBe('reinstated');
      expect(result.resolution.reason).toHaveLength(1000);
    });

    it('SCRUM266_AC2_an_unknown_booking_is_not_found', async () => {
      expect((await refusal(reinstate('00000000-0000-4000-8000-000000000001')))?.code).toBe('P0002');
    });

    it('SCRUM266_AC2_the_function_is_not_granted_to_anon_or_authenticated', async () => {
      const grants = await one(
        `select has_function_privilege('anon', 'reinstate_flagged_booking(uuid, uuid, text)', 'execute') as anon,
                has_function_privilege('authenticated', 'reinstate_flagged_booking(uuid, uuid, text)', 'execute') as authenticated`,
      );
      expect(grants).toEqual({ anon: false, authenticated: false });
    });
  });

  describe('AC5: the resolution is recorded and the flag cleared', () => {
    it('SCRUM266_AC5_reinstating_records_outcome_who_why_when_and_the_flag_it_cleared', async () => {
      const { id, blockId } = await flagged();
      await db.query('update venue_blocks set removed_at = now() where id = $1', [blockId]);
      const before = await bookingRow(id);
      const startedAt = Date.now();

      const result = await reinstate(id, { reason: '  The block was moved  ' });

      const recorded = await resolutionsFor(id);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        booking_id: id,
        outcome: 'reinstated',
        reason: 'The block was moved',
        resolved_by: staff,
        review_block_id: blockId,
        review_reason: null,
        flagged_by: staff,
        replacement_booking_id: null,
      });
      expect(recorded[0].flagged_at).toEqual(before.flagged_at);
      expect(recorded[0].created_at.getTime()).toBeGreaterThanOrEqual(startedAt - 5_000);

      const after = await bookingRow(id);
      expect(after).toMatchObject({
        status: 'approved',
        flagged_at: null,
        flagged_by: null,
        review_block_id: null,
        review_reason: null,
        decided_by: before.decided_by,
        decision_reason: before.decision_reason,
        suggested_alternative: before.suggested_alternative,
      });
      expect(after.decided_at).toEqual(before.decided_at);

      expect(result.resolution).toMatchObject({
        id: recorded[0].id,
        booking_id: id,
        outcome: 'reinstated',
        reason: 'The block was moved',
        resolved_by: staff,
      });
      expect(result.resolution.created_at).toEqual(expect.any(String));
      expect(result.booking).toMatchObject({ id, status: 'approved', flagged_at: null, review_block_id: null });
    });

    it('SCRUM266_AC5_a_setup_change_flag_is_snapshotted_with_its_reason', async () => {
      const venue = await makeVenue();
      const id = await approved(venue, await makeEvent());
      await db.query(
        `update bookings
            set status = 'flagged_for_review', review_reason = 'setup_or_turnaround_changed',
                flagged_at = now(), flagged_by = $2
          where id = $1`,
        [id, staff],
      );

      expect((await reinstate(id)).outcome).toBe('reinstated');
      expect(await resolutionsFor(id)).toEqual([
        expect.objectContaining({ review_reason: 'setup_or_turnaround_changed', review_block_id: null }),
      ]);
      expect((await bookingRow(id)).review_reason).toBeNull();
    });

    it('SCRUM266_AC5_a_booking_flagged_before_014_with_no_flag_time_can_be_reinstated', async () => {
      const id = await approved(await makeVenue(), await makeEvent());
      // 011 flagged by status alone; 014 added flagged_at without backfilling it.
      await db.query(`update bookings set status = 'flagged_for_review' where id = $1`, [id]);

      expect((await reinstate(id)).outcome).toBe('reinstated');
      expect(await resolutionsFor(id)).toEqual([
        expect.objectContaining({ outcome: 'reinstated', flagged_at: null, review_block_id: null, review_reason: null }),
      ]);
    });

    it('SCRUM266_AC5_a_reinstated_booking_cannot_be_reinstated_again', async () => {
      const { id, blockId } = await flagged();
      await db.query('update venue_blocks set removed_at = now() where id = $1', [blockId]);
      await reinstate(id);

      const err = await refusal(reinstate(id));

      expect(err?.code).toBe('PT409');
      expect(err?.hint).toBe('BOOKING_NOT_FLAGGED');
      expect(await resolutionsFor(id)).toHaveLength(1);
    });

    it('SCRUM266_AC5_a_reinstated_booking_occupies_the_venue_again', async () => {
      const { id, venueId, blockId } = await flagged();
      await db.query('update venue_blocks set removed_at = now() where id = $1', [blockId]);
      await reinstate(id);

      const later = await makeEvent();
      const laterId = await insertBooking(later, venueId);
      const result = await decide(laterId);

      expect(result.outcome).toBe('conflict');
      expect(result.conflicts.map((c) => c.booking_id)).toEqual([id]);
    });

    it.each([
      ['approved_to_rejected', 'approved', "status = 'rejected', decision_reason = 'x'"],
      ['approved_to_pending', 'approved', "status = 'pending'"],
      ['flagged_to_pending', 'flagged', "status = 'pending'"],
      ['flagged_to_rejected', 'flagged', "status = 'rejected'"],
      ['rejected_to_approved', 'rejected', "status = 'approved'"],
      ['changing_who_decided_while_flagged', 'flagged', 'decided_by = $2'],
    ])('SCRUM266_AC5_the_trigger_still_refuses_%s', async (_label, state, set) => {
      let id;
      if (state === 'flagged') ({ id } = await flagged());
      else if (state === 'approved') id = await approved(await makeVenue(), await makeEvent());
      else {
        id = await insertBooking(await makeEvent(), await makeVenue());
        await decide(id, 'reject', 'No');
      }
      const before = await bookingRow(id);

      const params = set.includes('$2') ? [id, coordinator] : [id];
      const err = await refusal(db.query(`update bookings set ${set} where id = $1`, params));

      expect(err?.code).toBe('42501');
      expect(await bookingRow(id)).toEqual(before);
    });

    it('SCRUM266_AC5_the_trigger_still_lets_a_flagged_booking_be_cancelled', async () => {
      const { id } = await flagged();

      await db.query("update bookings set status = 'cancelled' where id = $1", [id]);

      expect((await bookingRow(id)).status).toBe('cancelled');
    });

    describe('booking_resolutions constraints', () => {
      const insertResolution = async (bookingId, { outcome = 'reinstated', reason = 'Why', replacement = null } = {}) =>
        db.query(
          `insert into booking_resolutions (booking_id, outcome, reason, resolved_by, flagged_at, replacement_booking_id)
           values ($1, $2, $3, $4, now(), $5)`,
          [bookingId, outcome, reason, staff, replacement],
        );

      it.each([
        ['a replacement without the booking that replaced it', { outcome: 'replaced' }],
        ['a replacement booking on a reinstatement', { outcome: 'reinstated', replacement: 'SELF' }],
        ['an unknown outcome', { outcome: 'ignored' }],
        ['a blank reason', { reason: '   ' }],
        ['an untrimmed reason', { reason: ' Why ' }],
        ['a reason over 1000 characters', { reason: 'x'.repeat(1001) }],
      ])('SCRUM266_AC5_the_table_refuses_%s', async (_label, options) => {
        const { id } = await flagged();
        const replacement = options.replacement === 'SELF' ? id : options.replacement;

        const err = await refusal(insertResolution(id, { ...options, replacement }));

        expect(err?.code).toBe('23514');
      });

      it('SCRUM266_AC5_the_table_accepts_a_replacement_naming_its_booking_and_a_cancellation', async () => {
        const { id } = await flagged();
        const other = await insertBooking(await makeEvent(), await makeVenue());

        await insertResolution(id, { outcome: 'replaced', replacement: other });
        await insertResolution(id, { outcome: 'cancelled' });

        expect((await resolutionsFor(id)).map((r) => r.outcome).sort()).toEqual(['cancelled', 'replaced']);
      });

      it('SCRUM266_AC5_a_booking_with_a_resolution_cannot_be_deleted', async () => {
        const { id, blockId } = await flagged();
        await db.query('update venue_blocks set removed_at = now() where id = $1', [blockId]);
        await reinstate(id);

        // 23001: `on delete restrict` answers restrict_violation, not 23503.
        expect((await refusal(db.query('delete from bookings where id = $1', [id])))?.code).toBe('23001');
      });
    });
  });

  describe('AC6: reinstating notifies the event\'s people', () => {
    const noticesFor = (bookingId) =>
      rows(
        `select recipient_id, payload from notifications
          where booking_id = $1 and type = 'flagged_booking_resolved'
          order by payload->>'audience'`,
        [bookingId],
      );

    /** A flagged booking whose block is gone, for an event in the given status. */
    async function reinstatable(status) {
      const eventId = await makeEvent();
      const f = await flagged({ eventId });
      await db.query('update venue_blocks set removed_at = now() where id = $1', [f.blockId]);
      await db.query('update event_requests set status = $2 where id = $1', [eventId, status]);
      return f;
    }

    it('SCRUM266_AC6_reinstating_tells_the_coordinator_what_was_recorded', async () => {
      const { id, venueId, eventId } = await reinstatable('approved');

      await reinstate(id, { reason: '  The block was moved  ' });

      const [resolution] = await resolutionsFor(id);
      const booking = await bookingRow(id);
      const event = await one('select event_name from event_requests where id = $1', [eventId]);
      const venue = await one('select name from venues where id = $1', [venueId]);
      const notices = await noticesFor(id);
      expect(notices).toEqual([
        {
          recipient_id: coordinator,
          payload: {
            audience: 'coordinator',
            outcome: 'reinstated',
            eventRequestId: eventId,
            eventName: event.event_name,
            venueId,
            venueName: venue.name,
            startsAt: expect.any(String),
            endsAt: expect.any(String),
            reason: 'The block was moved',
            resolvedAt: expect.any(String),
            resolvedByRole: 'venue_staff',
            replacementBookingId: null,
            replacementVenueName: null,
            replacementStartsAt: null,
            replacementEndsAt: null,
          },
        },
      ]);
      const { payload } = notices[0];
      expect(payload.reason).toBe(resolution.reason);
      expect(new Date(payload.resolvedAt)).toEqual(resolution.created_at);
      expect(new Date(payload.startsAt)).toEqual(booking.starts_at);
      expect(new Date(payload.endsAt)).toEqual(booking.ends_at);
    });

    it('SCRUM266_AC6_reinstating_a_confirmed_events_booking_tells_the_organiser_too', async () => {
      const { id } = await reinstatable('confirmed');

      await reinstate(id);

      const notices = await noticesFor(id);
      expect(notices.map((n) => [n.payload.audience, n.recipient_id])).toEqual([
        ['coordinator', coordinator],
        ['organiser', organiser],
      ]);
      expect(notices[1].payload).toEqual({ ...notices[0].payload, audience: 'organiser' });
    });

    it.each(['approved', 'safety_review', 'safety_approved'])(
      'SCRUM266_AC6_the_organiser_of_a_%s_event_is_not_told',
      async (status) => {
        const { id } = await reinstatable(status);

        await reinstate(id);

        expect((await noticesFor(id)).map((n) => n.payload.audience)).toEqual(['coordinator']);
      },
    );

    it('SCRUM266_AC6_a_conflict_notifies_nobody', async () => {
      const { id, eventId } = await flagged();
      await db.query(`update event_requests set status = 'confirmed' where id = $1`, [eventId]);

      expect((await reinstate(id)).outcome).toBe('conflict');

      expect(await noticesFor(id)).toEqual([]);
    });

    it('SCRUM266_AC6_076_keeps_every_type_075_allows_and_a_rerun_changes_nothing', async () => {
      const types = async () => {
        const { def } = await one(
          `select pg_get_constraintdef(oid) as def from pg_constraint
            where conrelid = 'notifications'::regclass and conname = 'notifications_type_known'`,
        );
        return [...def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
      };
      // 075's v_ours, read from the file so a type it gains is checked too.
      const sql075 = migration('075_notification_types_after_safety_review.sql');
      const list075 = sql075.slice(sql075.indexOf('v_ours'), sql075.indexOf('];'));
      const from075 = [...list075.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
      expect(from075).toContain('booking_request_conflicting');

      const before = await types();
      expect(before).toEqual(expect.arrayContaining([...from075, 'flagged_booking_resolved']));

      await db.exec(migration(MIGRATION_076));

      expect(await types()).toEqual(before);
    });
  });

  describe('Week 7: each booking is resolved on its own', () => {
    it('SCRUM266_W7_reinstating_one_booking_leaves_the_events_other_flagged_booking_untouched', async () => {
      const eventId = await makeEvent();
      const a = await flagged({ eventId });
      const b = await flagged({ eventId });
      await db.query('update venue_blocks set removed_at = now() where id = $1', [a.blockId]);
      const otherBefore = await bookingRow(b.id);

      expect((await reinstate(a.id)).outcome).toBe('reinstated');

      expect((await bookingRow(a.id)).status).toBe('approved');
      expect(await bookingRow(b.id)).toEqual(otherBefore);
      expect(await resolutionsFor(b.id)).toEqual([]);
    });

    it('SCRUM266_W7_a_conflict_on_one_booking_does_not_stop_another_of_the_same_event', async () => {
      const eventId = await makeEvent();
      const a = await flagged({ eventId });
      const b = await flagged({ eventId });
      await db.query('update venue_blocks set removed_at = now() where id = $1', [b.blockId]);

      expect((await reinstate(a.id)).outcome).toBe('conflict');
      expect((await reinstate(b.id)).outcome).toBe('reinstated');
      expect((await bookingRow(a.id)).status).toBe('flagged_for_review');
    });
  });

  describe('the migration is re-runnable', () => {
    it('SCRUM266_AC5_running_076_again_keeps_the_function_the_trigger_and_the_records', async () => {
      const { id, blockId } = await flagged();
      await db.query('update venue_blocks set removed_at = now() where id = $1', [blockId]);
      await reinstate(id);

      await db.exec(migration(MIGRATION_076));
      await db.exec(migration(MIGRATION_076));

      expect(await resolutionsFor(id)).toHaveLength(1);
      const second = await flagged();
      await db.query('update venue_blocks set removed_at = now() where id = $1', [second.blockId]);
      expect((await reinstate(second.id)).outcome).toBe('reinstated');
      const { count } = await one(
        `select count(*)::int as count from pg_trigger
          where tgrelid = 'bookings'::regclass and tgname = 'bookings_decision_final'`,
      );
      expect(count).toBe(1);
    });
  });
});
