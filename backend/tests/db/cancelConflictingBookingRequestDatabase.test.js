/**
 * Cancelling an event treats its conflicting booking requests as its pending
 * ones (069): the preview lists them, cancelling withdraws them, and Venue
 * Staff are told.
 *
 * SCRUM-258 AC3 with the Week 7 rule that conflicting is a flag on an open
 * request, not an end state. Uses cancelEventReleasesReservationsDatabase's
 * stack (through 054), then 049 (the preview 069 restates), 067, 069, 070 and 071.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name) => readFileSync(resolve(here, '../../db/migrations', name), 'utf8');
const BASE = [
  '001_event_requests.sql',
  '005_event_request_details.sql',
  '007_user_roles.sql',
  '010_event_request_clarifications.sql',
  '006_event_change_requests.sql',
];
const ASSIGNMENT = [
  '014_coordinator_assignment.sql',
  '015_assignment_function.sql',
  '016_submit_event_request.sql',
  '017_require_assigned_coordinator.sql',
];
const LIFECYCLE = [
  '020_event_status_lifecycle.sql',
  '021_event_status_history.sql',
  '022_event_status_transitions.sql',
];
const EQUIPMENT = [
  '024_equipment_availability.sql',
  '037_equipment_request_lines.sql',
  '038_equipment_review.sql',
  '053_equipment_reservations.sql',
  '054_equipment_reservation_actions.sql',
];

describe('SCRUM-258 AC3: cancelling an event withdraws its conflicting requests (069)', () => {
  let db;
  let organiser;
  let coordinator;
  let venueStaff;
  let venueId;
  let otherVenueId;

  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
  const bookingStatus = async (id) =>
    (await one('select status::text as status from bookings where id = $1', [id])).status;

  async function makeApprovedEvent() {
    return (
      await one(
        `insert into event_requests
           (organiser_id, event_name, status, assigned_coordinator_id, submitted_at,
            reviewing_coordinator_id, decision, decided_by, decided_at)
         values ($1, 'Conflicting cancellation', 'approved', $2, now(), $2, 'approved', $2, now())
         returning id`,
        [organiser, coordinator],
      )
    ).id;
  }

  async function makeBooking(eventId, venue, status) {
    return (
      await one(
        `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
         values ($1, $2, '2026-12-01T09:00:00Z', '2026-12-01T10:00:00Z', $3)
         returning id`,
        [venue, eventId, status],
      )
    ).id;
  }

  const cancel = (eventId) =>
    db.query(
      `select cancel_event_request($1, $2, 'Venue issue', 'connectsphere_decision'::event_cancellation_initiator, null)`,
      [eventId, coordinator],
    );

  beforeAll(async () => {
    db = new PGlite({ extensions: { btree_gist } });
    await db.exec(`
      create schema auth;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text);
      create role anon;
      create role authenticated;
      create role service_role;
    `);
    for (const name of BASE) await db.exec(migration(name));
    await db.exec(migration('025_event_request_decisions.sql'));
    for (const name of ASSIGNMENT) await db.exec(migration(name));
    for (const name of LIFECYCLE) await db.exec(migration(name));
    await db.exec(migration('019_change_request_decision_coordinator.sql'));

    await db.exec(`
      create table notifications (
        id uuid primary key default gen_random_uuid(),
        recipient_id uuid not null references auth.users(id) on delete cascade,
        type text not null,
        booking_id uuid,
        block_id uuid,
        payload jsonb not null default '{}',
        read_at timestamptz,
        created_at timestamptz not null default now(),
        constraint notifications_type_known check (type in ('booking_flagged'))
      );
      create function reply_to_event_clarification(uuid, uuid, text)
      returns event_requests language sql as $$ select null::event_requests $$;
    `);
    await db.exec(migration('030_event_clarification_reply_by.sql'));
    await db.exec(migration('026_clarification_amendment_fields.sql'));
    await db.exec(migration('002_venues.sql'));
    await db.exec(migration('009_bookings.sql'));
    await db.exec(migration('011_venue_blocks.sql'));
    await db.exec(migration('027_booking_request_statuses.sql'));
    await db.exec(migration('022_equipment_schema.sql'));
    await db.exec(migration('042_event_cancellation_fields.sql'));
    await db.exec('alter table equipment_lines add column removed_at timestamptz');
    await db.exec(migration('043_release_event_arrangements.sql'));
    await db.exec(migration('045_cancel_event_request.sql'));
    await db.exec(`
      create type venue_hold_status as enum ('active', 'expired');
      create table venue_holds (
        id uuid primary key default gen_random_uuid(),
        event_request_id uuid not null references event_requests(id),
        venue_id uuid not null references venues(id),
        placed_by uuid not null references auth.users(id),
        placed_at timestamptz not null default now(),
        expires_at timestamptz not null,
        status venue_hold_status not null default 'active',
        expired_at timestamptz
      );
    `);
    await db.exec(migration('047_add_released_venue_hold_status.sql'));
    await db.exec(migration('048_complete_event_cancellation_existing_arrangements.sql'));
    for (const name of EQUIPMENT) await db.exec(migration(name));
    await db.exec(migration('049_filter_cancelled_equipment_from_cancellation_preview.sql'));
    // 067's enum value must commit before 069 uses it, so each is its own exec.
    await db.exec(migration('067_conflicting_booking_status.sql'));
    await db.exec(migration('069_withdraw_conflicting_on_cancellation.sql'));
    // 070's enum value must commit before 071's converted-hold columns use it.
    await db.exec(migration('070_converted_venue_hold_status.sql'));
    await db.exec(migration('071_convert_event_hold_on_approval.sql'));

    organiser = (await one("insert into auth.users (email) values ('organiser@test') returning id")).id;
    coordinator = (await one("insert into auth.users (email) values ('coordinator@test') returning id")).id;
    venueStaff = (await one("insert into auth.users (email) values ('venue-staff@test') returning id")).id;
    await db.query(
      `insert into profiles (id, role) values
         ($1, 'event_organiser'),
         ($2, 'event_coordinator'),
         ($3, 'venue_staff')`,
      [organiser, coordinator, venueStaff],
    );
    venueId = (
      await one("insert into venues (name, location, max_capacity) values ('Hall', 'Block A', 100) returning id")
    ).id;
    otherVenueId = (
      await one("insert into venues (name, location, max_capacity) values ('Annex', 'Block B', 100) returning id")
    ).id;
  }, 30000);

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM258_AC3_the_cancellation_preview_lists_a_conflicting_request_among_those_to_withdraw', async () => {
    const eventId = await makeApprovedEvent();
    const conflicting = await makeBooking(eventId, venueId, 'conflicting');
    const pending = await makeBooking(eventId, otherVenueId, 'pending');

    const { preview } = await one('select event_cancellation_impact_preview($1) as preview', [eventId]);

    expect(preview.bookingRequests.count).toBe(2);
    expect(preview.bookingRequests.details.map((d) => [d.id, d.status]).sort()).toEqual(
      [[conflicting, 'conflicting'], [pending, 'pending']].sort(),
    );
    expect(preview.venueBookings.count).toBe(0);
  });

  it('SCRUM258_AC3_cancelling_withdraws_a_conflicting_request_and_tells_venue_staff', async () => {
    const eventId = await makeApprovedEvent();
    const conflicting = await makeBooking(eventId, venueId, 'conflicting');

    await cancel(eventId);

    expect(await bookingStatus(conflicting)).toBe('withdrawn');
    const toStaff = (
      await db.query(
        "select recipient_id from notifications where event_request_id = $1 and type = 'event_cancelled' and payload->>'audience' = 'venue_staff'",
        [eventId],
      )
    ).rows;
    expect(toStaff.map((n) => n.recipient_id)).toEqual([venueStaff]);
  });

  it('SCRUM258_Week7_cancelling_cancels_the_approved_booking_and_leaves_its_converted_hold_converted', async () => {
    const eventId = await makeApprovedEvent();
    const approved = await makeBooking(eventId, venueId, 'approved');
    // The hold 071 converts on approval, written directly: decide is not in this stack.
    const holdId = (
      await one(
        `insert into venue_holds
           (event_request_id, venue_id, placed_by, expires_at, status, converted_at, converted_booking_id)
         values ($1, $2, $3, now() + interval '2 days', 'converted', now(), $4)
         returning id`,
        [eventId, venueId, venueStaff, approved],
      )
    ).id;

    await cancel(eventId);

    expect(await bookingStatus(approved)).toBe('cancelled');
    const hold = await one(
      'select status::text as status, released_at, converted_booking_id from venue_holds where id = $1',
      [holdId],
    );
    expect(hold).toEqual({ status: 'converted', released_at: null, converted_booking_id: approved });
  });
});
