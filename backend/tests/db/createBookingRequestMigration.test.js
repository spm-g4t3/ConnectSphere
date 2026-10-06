/**
 * SCRUM-252: create_booking_request, run against a real Postgres.
 *
 * Applies the real migrations to an in-process Postgres (PGlite), so the
 * function's refusals, outcomes and rollbacks are exercised rather than read as
 * text. No server or credentials are needed, so this runs in CI.
 *
 * Applied in order: 001, 005, 007, 010, a stand-in for SCRUM-19's decision
 * column (014 reads it and it is not on this branch, as in
 * eventStatusLifecycleDatabase.test.js), 014, then 002, 009, 011, 013, 014
 * (booking review and notifications), 027, 028 and 030.
 *
 * What PGlite is not: a second connection. It runs one query at a time, so it
 * cannot show two real transactions blocking each other on the row locks. The
 * locking protocol is therefore pinned two other ways here: the function text
 * must take the event lock before the venue lock and take the venue lock
 * `for share`, and the duplicate checks are shown to hold once the first
 * request has committed. Broader concurrency coverage is SCRUM-256's.
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
  '013_venue_block_booking_conflicts.sql',
  '014_booking_review_notifications.sql',
  '027_booking_request_statuses.sql',
  '028_booking_status_default_pending.sql',
  '030_create_booking_request.sql',
];

/** What 014 reads from SCRUM-19's migration, which is not on this branch. */
const DECISION_STAND_IN = `
  alter table event_requests
    add column if not exists reviewing_coordinator_id uuid references auth.users (id);
`;

const START = '2026-12-01T09:00:00+00:00';
const END = '2026-12-01T17:00:00+00:00';

const SUITABLE = { suitable: true, criteria: [{ criterion: 'capacity', met: true }] };
const UNSUITABLE = {
  suitable: false,
  criteria: [{ criterion: 'capacity', met: false, detail: 'Capacity 80 < expected attendance 150' }],
};

const refusal = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
};

describe('SCRUM-252: create_booking_request in Postgres', () => {
  let db;
  let organiser;
  let coordinator;
  let otherCoordinator;
  let counter = 0;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const bookingsFor = async (eventId) =>
    (await db.query('select * from bookings where event_request_id = $1 order by created_at, id', [eventId])).rows;

  async function makeVenue(extra = {}) {
    counter += 1;
    const row = await one(
      `insert into venues (name, location, max_capacity) values ($1, 'Block A', 200) returning id`,
      [`Hall ${counter}`],
    );
    if (extra.retired) await db.query('update venues set retired_at = now() where id = $1', [row.id]);
    return row.id;
  }

  async function makeEvent(extra = {}) {
    counter += 1;
    const cols = {
      organiser_id: organiser,
      event_name: `Event ${counter}`,
      status: 'approved',
      proposed_start: START,
      proposed_end: END,
      expected_attendance: 150,
      venue_requirements: 'Tiered seating',
      accessibility_requirements: 'Step-free entrance',
      submitted_at: new Date().toISOString(),
      assigned_coordinator_id: coordinator,
      ...extra,
    };
    const keys = Object.keys(cols);
    return (
      await one(
        `insert into event_requests (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning id`,
        Object.values(cols),
      )
    ).id;
  }

  async function makeBooking(venueId, eventId, status, startsAt = START, endsAt = END) {
    return (
      await one(
        `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
         values ($1, $2, $3, $4, $5) returning id`,
        [venueId, eventId, startsAt, endsAt, status],
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

  /** The function's answer, as the API calls it. */
  async function request(eventId, venueId, o = {}) {
    const row = await one(
      'select create_booking_request($1, $2, $3, $4, $5, $6::jsonb, $7) as result',
      [
        eventId,
        venueId,
        o.requestedBy === undefined ? coordinator : o.requestedBy,
        o.layout ?? null,
        o.notes ?? null,
        o.suitability === undefined ? JSON.stringify(SUITABLE) : o.suitability && JSON.stringify(o.suitability),
        o.confirm ?? false,
      ],
    );
    return row.result;
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
    organiser = (await one("insert into auth.users (email) values ('o@x') returning id")).id;
    coordinator = (await one("insert into auth.users (email) values ('c1@x') returning id")).id;
    otherCoordinator = (await one("insert into auth.users (email) values ('c2@x') returning id")).id;
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('a valid request', () => {
    it('SCRUM252_creates_a_pending_booking_for_the_events_own_period', async () => {
      const eventId = await makeEvent();
      const venueId = await makeVenue();

      const result = await request(eventId, venueId, { layout: 'theatre', notes: 'Extra tables' });

      expect(result.outcome).toBe('created');
      expect(result.booking).toMatchObject({
        status: 'pending',
        venue_id: venueId,
        event_request_id: eventId,
        requested_by: coordinator,
        room_layout_code: 'theatre',
        setup_notes: 'Extra tables',
        venue_requirements: 'Tiered seating',
        accessibility_requirements: 'Step-free entrance',
        suitability_overridden: false,
      });
      expect(new Date(result.booking.starts_at).toISOString()).toBe(new Date(START).toISOString());
      expect(new Date(result.booking.ends_at).toISOString()).toBe(new Date(END).toISOString());
      expect(result.booking.suitability_result).toEqual(SUITABLE);
      expect(await bookingsFor(eventId)).toHaveLength(1);
    });

    it('SCRUM252_is_pending_even_though_the_function_never_reads_the_column_default', async () => {
      const eventId = await makeEvent();
      const result = await request(eventId, await makeVenue());
      const stored = await one('select status from bookings where id = $1', [result.booking.id]);
      expect(stored.status).toBe('pending');
    });

    it('SCRUM252_accepts_a_confirmed_event', async () => {
      const eventId = await makeEvent({ status: 'confirmed' });
      expect((await request(eventId, await makeVenue())).outcome).toBe('created');
    });

    it('SCRUM252_setup_notes_and_layout_are_optional', async () => {
      const result = await request(await makeEvent(), await makeVenue());
      expect(result.booking).toMatchObject({ room_layout_code: null, setup_notes: null });
    });

    it('SCRUM252_the_pending_request_is_what_the_venue_staff_pending_list_reads', async () => {
      const eventId = await makeEvent();
      const venueId = await makeVenue();
      const { booking } = await request(eventId, venueId);

      const pending = (
        await db.query(`select id from bookings where status = 'pending' and venue_id = $1`, [venueId])
      ).rows;

      expect(pending).toEqual([{ id: booking.id }]);
    });
  });

  describe('who and which event', () => {
    it('SCRUM252_refuses_a_coordinator_who_is_not_assigned_to_the_event', async () => {
      const eventId = await makeEvent();
      const err = await refusal(request(eventId, await makeVenue(), { requestedBy: otherCoordinator }));
      expect(err.code).toBe('42501');
      expect(await bookingsFor(eventId)).toHaveLength(0);
    });

    it('SCRUM252_refuses_a_null_requester', async () => {
      const err = await refusal(request(await makeEvent(), await makeVenue(), { requestedBy: null }));
      expect(err.code).toBe('42501');
    });

    it.each(['draft', 'submitted', 'under_review', 'pending_clarification', 'planning', 'completed', 'rejected', 'cancelled'])(
      'SCRUM252_refuses_an_event_that_is_%s',
      async (status) => {
        const extra = status === 'draft' ? { assigned_coordinator_id: null, submitted_at: null } : {};
        const eventId = await makeEvent({ status, ...extra });
        const err = await refusal(request(eventId, await makeVenue()));
        expect(err.code).toBe(status === 'draft' ? '42501' : 'PT409');
        if (status !== 'draft') expect(err.hint).toBe('EVENT_NOT_BOOKABLE');
        expect(await bookingsFor(eventId)).toHaveLength(0);
      },
    );

    it('SCRUM252_refuses_an_event_with_no_proposed_period', async () => {
      const eventId = await makeEvent({ proposed_start: null, proposed_end: null });
      const err = await refusal(request(eventId, await makeVenue()));
      expect(err).toMatchObject({ code: 'PT409', hint: 'EVENT_DATES_MISSING' });
    });

    it('SCRUM252_reports_an_unknown_event_and_an_unknown_venue_as_not_found', async () => {
      const missing = '00000000-0000-4000-8000-000000000000';
      expect((await refusal(request(missing, await makeVenue()))).code).toBe('P0002');
      expect((await refusal(request(await makeEvent(), missing))).code).toBe('P0002');
    });
  });

  describe('the venue', () => {
    it('SCRUM252_refuses_a_retired_venue', async () => {
      const eventId = await makeEvent();
      const err = await refusal(request(eventId, await makeVenue({ retired: true })));
      expect(err).toMatchObject({ code: 'PT409', hint: 'VENUE_RETIRED' });
      expect(await bookingsFor(eventId)).toHaveLength(0);
    });

    it('SCRUM252_refuses_an_unknown_layout_and_writes_nothing', async () => {
      const eventId = await makeEvent();
      const err = await refusal(request(eventId, await makeVenue(), { layout: 'no_such_layout' }));
      expect(err.code).toBe('23503');
      expect(await bookingsFor(eventId)).toHaveLength(0);
    });

    it('SCRUM252_refuses_setup_notes_over_1000_characters', async () => {
      const err = await refusal(request(await makeEvent(), await makeVenue(), { notes: 'x'.repeat(1001) }));
      expect(err.code).toBe('23514');
    });
  });

  describe('the period', () => {
    it('SCRUM252_names_an_overlapping_venue_block', async () => {
      const eventId = await makeEvent();
      const venueId = await makeVenue();
      const blockId = await makeBlock(venueId, '2026-12-01T12:00:00+00:00', '2026-12-01T13:00:00+00:00');

      const result = await request(eventId, venueId);

      expect(result.outcome).toBe('conflict');
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]).toMatchObject({ kind: 'block', block_id: blockId, reason: 'maintenance' });
      expect(await bookingsFor(eventId)).toHaveLength(0);
    });

    it('SCRUM252_names_an_overlapping_approved_booking_and_its_event', async () => {
      const eventId = await makeEvent();
      const otherEventId = await makeEvent();
      const venueId = await makeVenue();
      const bookingId = await makeBooking(venueId, otherEventId, 'approved', '2026-12-01T16:00:00+00:00', '2026-12-01T20:00:00+00:00');

      const result = await request(eventId, venueId);

      expect(result.outcome).toBe('conflict');
      expect(result.conflicts[0]).toMatchObject({
        kind: 'booking',
        booking_id: bookingId,
        event_request_id: otherEventId,
      });
      expect(result.conflicts[0].event_name).toMatch(/^Event /);
    });

    it('SCRUM252_lists_blocks_and_bookings_together', async () => {
      const venueId = await makeVenue();
      await makeBlock(venueId, '2026-12-01T08:00:00+00:00', '2026-12-01T10:00:00+00:00');
      await makeBooking(venueId, await makeEvent(), 'approved', '2026-12-01T15:00:00+00:00', '2026-12-01T18:00:00+00:00');

      const result = await request(await makeEvent(), venueId);

      expect(result.conflicts.map((c) => c.kind)).toEqual(['block', 'booking']);
    });

    it.each(['pending', 'rejected', 'withdrawn', 'cancelled'])(
      'SCRUM252_a_%s_booking_does_not_conflict',
      async (status) => {
        const venueId = await makeVenue();
        await makeBooking(venueId, await makeEvent(), status);
        expect((await request(await makeEvent(), venueId)).outcome).toBe('created');
      },
    );

    it('SCRUM252_a_removed_block_does_not_conflict', async () => {
      const venueId = await makeVenue();
      await makeBlock(venueId, START, END, true);
      expect((await request(await makeEvent(), venueId)).outcome).toBe('created');
    });

    it('SCRUM252_a_period_that_only_touches_at_an_edge_is_clear', async () => {
      const venueId = await makeVenue();
      await makeBlock(venueId, '2026-12-01T17:00:00+00:00', '2026-12-01T18:00:00+00:00');
      await makeBooking(venueId, await makeEvent(), 'approved', '2026-12-01T07:00:00+00:00', '2026-12-01T09:00:00+00:00');
      expect((await request(await makeEvent(), venueId)).outcome).toBe('created');
    });
  });

  describe('one live request per event', () => {
    it('SCRUM252_refuses_a_second_request_for_the_same_event_and_names_the_first', async () => {
      const eventId = await makeEvent();
      const first = await request(eventId, await makeVenue());

      const err = await refusal(request(eventId, await makeVenue()));

      expect(err).toMatchObject({ code: 'PT409', hint: 'BOOKING_REQUEST_EXISTS', detail: first.booking.id });
      expect(await bookingsFor(eventId)).toHaveLength(1);
    });

    it('SCRUM252_the_same_event_cannot_hold_two_requests_at_different_venues', async () => {
      const eventId = await makeEvent();
      await request(eventId, await makeVenue());
      const err = await refusal(request(eventId, await makeVenue()));
      expect(err.hint).toBe('BOOKING_REQUEST_EXISTS');
    });

    it('SCRUM252_an_existing_approved_booking_counts', async () => {
      const eventId = await makeEvent();
      const approved = await makeBooking(await makeVenue(), eventId, 'approved');
      const err = await refusal(request(eventId, await makeVenue()));
      expect(err).toMatchObject({ hint: 'BOOKING_REQUEST_EXISTS', detail: approved });
    });

    it('SCRUM252_a_booking_flagged_for_review_counts_and_is_named_as_such', async () => {
      const eventId = await makeEvent();
      const flagged = await makeBooking(await makeVenue(), eventId, 'flagged_for_review');
      const err = await refusal(request(eventId, await makeVenue()));
      expect(err).toMatchObject({ code: 'PT409', hint: 'BOOKING_FLAGGED_FOR_REVIEW', detail: flagged });
    });

    it('SCRUM252_names_the_flagged_booking_in_preference_to_another_live_one', async () => {
      const eventId = await makeEvent();
      await makeBooking(await makeVenue(), eventId, 'pending');
      const flagged = await makeBooking(await makeVenue(), eventId, 'flagged_for_review');
      const err = await refusal(request(eventId, await makeVenue()));
      expect(err).toMatchObject({ hint: 'BOOKING_FLAGGED_FOR_REVIEW', detail: flagged });
    });

    it.each(['rejected', 'withdrawn', 'cancelled'])(
      'SCRUM252_a_%s_booking_does_not_stop_a_new_request',
      async (status) => {
        const eventId = await makeEvent();
        await makeBooking(await makeVenue(), eventId, status);
        expect((await request(eventId, await makeVenue())).outcome).toBe('created');
      },
    );

    it('SCRUM252_another_events_request_does_not_count', async () => {
      await request(await makeEvent(), await makeVenue());
      expect((await request(await makeEvent(), await makeVenue())).outcome).toBe('created');
    });

    it('SCRUM252_two_events_can_request_the_same_venue_for_different_periods', async () => {
      const venueId = await makeVenue();
      const a = await makeEvent();
      const b = await makeEvent({ proposed_start: '2026-12-02T09:00:00+00:00', proposed_end: '2026-12-02T17:00:00+00:00' });
      expect((await request(a, venueId)).outcome).toBe('created');
      expect((await request(b, venueId)).outcome).toBe('created');
    });
  });

  describe('suitability', () => {
    it('SCRUM252_a_failed_check_needs_confirmation_and_writes_nothing', async () => {
      const eventId = await makeEvent();

      const result = await request(eventId, await makeVenue(), { suitability: UNSUITABLE });

      expect(result).toMatchObject({ outcome: 'suitability_confirmation_required', suitability: UNSUITABLE });
      expect(await bookingsFor(eventId)).toHaveLength(0);
    });

    it('SCRUM252_a_confirmed_failure_is_requested_and_recorded_as_overridden', async () => {
      const eventId = await makeEvent();

      const result = await request(eventId, await makeVenue(), { suitability: UNSUITABLE, confirm: true });

      expect(result.outcome).toBe('created');
      expect(result.booking).toMatchObject({ status: 'pending', suitability_overridden: true });
      expect(result.booking.suitability_result).toEqual(UNSUITABLE);
    });

    it('SCRUM252_confirming_a_suitable_venue_is_not_recorded_as_an_override', async () => {
      const result = await request(await makeEvent(), await makeVenue(), { confirm: true });
      expect(result.booking.suitability_overridden).toBe(false);
    });

    it('SCRUM252_a_conflict_is_reported_before_the_suitability_gate', async () => {
      const venueId = await makeVenue();
      await makeBlock(venueId, START, END);
      const result = await request(await makeEvent(), venueId, { suitability: UNSUITABLE });
      expect(result.outcome).toBe('conflict');
    });

    it.each([
      ['no result', null],
      ['a result with no suitable flag', { criteria: [] }],
      ['a suitable flag that is not a boolean', { suitable: 'yes', criteria: [] }],
    ])('SCRUM252_refuses_%s_instead_of_assuming_suitable', async (_label, suitability) => {
      const eventId = await makeEvent();
      const err = await refusal(request(eventId, await makeVenue(), { suitability }));
      expect(err.code).toBe('22023');
      expect(await bookingsFor(eventId)).toHaveLength(0);
    });
  });

  describe('SCRUM-256: authorization after a handover and the persisted request', () => {
    it('SCRUM256_a_handover_moves_the_right_to_request_to_the_new_coordinator', async () => {
      const eventId = await makeEvent();
      const venueId = await makeVenue();
      await db.query('update event_requests set assigned_coordinator_id = $1 where id = $2', [otherCoordinator, eventId]);

      const err = await refusal(request(eventId, venueId, { requestedBy: coordinator }));
      expect(err.code).toBe('42501');
      expect(await bookingsFor(eventId)).toHaveLength(0);

      const result = await request(eventId, venueId, { requestedBy: otherCoordinator });
      expect(result.booking).toMatchObject({ status: 'pending', requested_by: otherCoordinator });
    });

    it('SCRUM256_the_request_keeps_the_period_and_requirements_the_event_had_when_it_was_made', async () => {
      const eventId = await makeEvent();
      const { booking } = await request(eventId, await makeVenue());

      await db.query(
        `update event_requests
            set proposed_start = '2027-01-01T09:00:00+00', proposed_end = '2027-01-01T17:00:00+00',
                venue_requirements = 'Changed', accessibility_requirements = 'Changed'
          where id = $1`,
        [eventId],
      );

      const stored = await one('select * from bookings where id = $1', [booking.id]);
      expect(new Date(stored.starts_at).toISOString()).toBe(new Date(START).toISOString());
      expect(new Date(stored.ends_at).toISOString()).toBe(new Date(END).toISOString());
      expect(stored).toMatchObject({ venue_requirements: 'Tiered seating', accessibility_requirements: 'Step-free entrance' });
    });

    it('SCRUM256_a_request_is_attributed_to_the_caller_not_to_anyone_the_event_names', async () => {
      const eventId = await makeEvent({ organiser_id: organiser });
      const { booking } = await request(eventId, await makeVenue());
      expect(booking.requested_by).toBe(coordinator);
      expect(booking.requested_by).not.toBe(organiser);
    });
  });

  describe('SCRUM-256: the interval convention at the edges of the event period', () => {
    // The event runs 09:00-17:00. Periods are half-open, as in 011 and 013: one
    // that only touches an edge is clear, and one that reaches a second inside is not.
    const EDGES = [
      ['ends exactly when the event starts', '2026-12-01T07:00:00+00:00', '2026-12-01T09:00:00+00:00', false],
      ['starts exactly when the event ends', '2026-12-01T17:00:00+00:00', '2026-12-01T19:00:00+00:00', false],
      ['ends one second after the event starts', '2026-12-01T07:00:00+00:00', '2026-12-01T09:00:01+00:00', true],
      ['starts one second before the event ends', '2026-12-01T16:59:59+00:00', '2026-12-01T19:00:00+00:00', true],
      ['sits wholly inside the event', '2026-12-01T11:00:00+00:00', '2026-12-01T12:00:00+00:00', true],
      ['wholly contains the event', '2026-12-01T06:00:00+00:00', '2026-12-01T20:00:00+00:00', true],
      ['matches the event exactly', START, END, true],
    ];

    it.each(EDGES)('SCRUM256_a_venue_block_that_%s', async (_label, startsAt, endsAt, conflicts) => {
      const venueId = await makeVenue();
      await makeBlock(venueId, startsAt, endsAt);
      const result = await request(await makeEvent(), venueId);
      expect(result.outcome).toBe(conflicts ? 'conflict' : 'created');
    });

    it.each(EDGES)('SCRUM256_an_approved_booking_that_%s', async (_label, startsAt, endsAt, conflicts) => {
      const venueId = await makeVenue();
      await makeBooking(venueId, await makeEvent(), 'approved', startsAt, endsAt);
      const result = await request(await makeEvent(), venueId);
      expect(result.outcome).toBe(conflicts ? 'conflict' : 'created');
    });

    it('SCRUM256_a_block_or_booking_at_another_venue_is_not_in_the_way', async () => {
      const venueId = await makeVenue();
      const elsewhere = await makeVenue();
      await makeBlock(elsewhere, START, END);
      await makeBooking(elsewhere, await makeEvent(), 'approved');
      expect((await request(await makeEvent(), venueId)).outcome).toBe('created');
    });
  });

  describe('SCRUM-256: a booking flagged by a real venue block (N24)', () => {
    const DAY = 86_400_000;
    const iso = (offsetDays, hour) => {
      const d = new Date(Date.now() + offsetDays * DAY);
      d.setUTCHours(hour, 0, 0, 0);
      return d.toISOString();
    };

    it('SCRUM256_an_event_whose_booking_a_block_flagged_cannot_request_another_venue', async () => {
      const eventId = await makeEvent();
      const flaggedVenue = await makeVenue();
      const bookingId = await makeBooking(flaggedVenue, eventId, 'approved', iso(20, 9), iso(20, 17));

      // The SCRUM-17 override: Venue Staff confirm, and 014 flags the booking.
      const created = await one(
        `select create_venue_block($1, $2, $3, 'maintenance', null, null, true, $4::uuid[]) as result`,
        [flaggedVenue, iso(20, 8), iso(20, 18), [bookingId]],
      );
      expect(created.result.outcome).toBe('created');
      expect((await one('select status from bookings where id = $1', [bookingId])).status).toBe('flagged_for_review');

      const err = await refusal(request(eventId, await makeVenue()));

      expect(err).toMatchObject({ code: 'PT409', hint: 'BOOKING_FLAGGED_FOR_REVIEW', detail: bookingId });
      expect(await bookingsFor(eventId)).toHaveLength(1);
    });

    it('SCRUM256_once_the_flagged_booking_is_cancelled_the_event_can_request_again', async () => {
      const eventId = await makeEvent();
      const venueId = await makeVenue();
      const bookingId = await makeBooking(venueId, eventId, 'flagged_for_review');
      expect((await refusal(request(eventId, await makeVenue()))).hint).toBe('BOOKING_FLAGGED_FOR_REVIEW');

      // What SCRUM-266's cancel will do.
      await db.query(`update bookings set status = 'cancelled' where id = $1`, [bookingId]);

      expect((await request(eventId, await makeVenue())).outcome).toBe('created');
    });
  });

  describe('the locking protocol and who may call', () => {
    const sql = readFileSync(
      resolve(here, '../../db/migrations/030_create_booking_request.sql'),
      'utf8',
    )
      .replace(/--[^\n]*/g, '')
      .replace(/\s+/g, ' ')
      .toLowerCase();

    it('SCRUM252_locks_the_event_row_for_update_before_the_venue_row', () => {
      const event = sql.indexOf('from event_requests where id = p_event_request_id for update');
      const venue = sql.indexOf('from venues where id = p_venue_id for share');
      expect(event).toBeGreaterThan(-1);
      expect(venue).toBeGreaterThan(event);
    });

    it('SCRUM252_takes_the_venue_lock_for_share_so_it_conflicts_with_block_creation_and_retirement', () => {
      expect(sql).toContain('for share');
      // The lock create_venue_block (012 to 015) holds, which "for share" conflicts with.
      expect(sql).not.toContain('for no key update');
    });

    it('SCRUM252_does_the_duplicate_and_conflict_checks_after_both_locks', () => {
      const venueLock = sql.indexOf('for share');
      expect(sql.indexOf("b.status in ('pending', 'approved', 'flagged_for_review')")).toBeGreaterThan(venueLock);
      expect(sql.indexOf('from venue_blocks vb')).toBeGreaterThan(venueLock);
      expect(sql.indexOf('insert into bookings')).toBeGreaterThan(venueLock);
    });

    it('SCRUM252_is_not_callable_by_the_publishable_roles', async () => {
      const signature = 'create_booking_request(uuid, uuid, uuid, text, text, jsonb, boolean)';
      for (const role of ['anon', 'authenticated']) {
        const row = await one('select has_function_privilege($1, $2, $3) as allowed', [role, signature, 'execute']);
        expect(row.allowed).toBe(false);
      }
    });

    it('SCRUM252_can_be_applied_again_without_error', async () => {
      await db.exec(migration('030_create_booking_request.sql'));
      expect((await request(await makeEvent(), await makeVenue())).outcome).toBe('created');
    });
  });
});
