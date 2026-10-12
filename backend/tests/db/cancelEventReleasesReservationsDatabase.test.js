/**
 * SCRUM-305 for SCRUM-300: cancelling an event releases its live equipment
 * reservations through release_equipment_reservations (054), so the history
 * records a system release with the cancellation reason. Uses the same setup as
 * cancelEventRequestDatabase.test.js.
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

describe('SCRUM-300 with SCRUM-370: cancelling an event releases its reserved equipment', () => {
  let db;
  let organiser;
  let coordinator;
  let otherCoordinator;
  let venueStaff;
  let technicalSupport;
  let venueId;

  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
  const eventRow = (id) => one('select * from event_requests where id = $1', [id]);
  const statusHistory = async (id) =>
    (await db.query(
      'select previous_status::text, new_status::text, reason from event_request_status_history where event_request_id = $1 order by created_at, id',
      [id],
    )).rows;
  const bookingStatus = async (id) =>
    (await one('select status::text as status from bookings where id = $1', [id])).status;

  async function makeEvent(status = 'submitted') {
    const cols = {
      organiser_id: organiser,
      event_name: `Cancellation test ${status}`,
      status,
      assigned_coordinator_id: coordinator,
    };
    if (status !== 'draft') cols.submitted_at = new Date().toISOString();
    if (status === 'approved' || status === 'confirmed') {
      Object.assign(cols, {
        reviewing_coordinator_id: coordinator,
        decision: 'approved',
        decided_by: coordinator,
        decided_at: new Date().toISOString(),
      });
    }
    const keys = Object.keys(cols);
    return (
      await one(
        `insert into event_requests (${keys.join(',')})
         values (${keys.map((_, index) => `$${index + 1}`).join(',')})
         returning id`,
        Object.values(cols),
      )
    ).id;
  }

  async function makeBooking(eventId, status = 'approved') {
    return (
      await one(
        `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
         values ($1, $2, '2026-12-01T09:00:00Z', '2026-12-01T10:00:00Z', $3)
         returning id`,
        [venueId, eventId, status],
      )
    ).id;
  }

  async function makeHold(eventId) {
    return (
      await one(
        `insert into venue_holds (event_request_id, venue_id, placed_by, expires_at)
         values ($1, $2, $3, now() + interval '1 day')
         returning id`,
        [eventId, venueId, coordinator],
      )
    ).id;
  }

  async function makeChangeRequest(eventId) {
    return (
      await one(
        `insert into event_change_requests
           (event_request_id, requested_by, change_field, requested_change)
         values ($1, $2, 'other', 'Change the event format')
         returning id`,
        [eventId, organiser],
      )
    ).id;
  }

  const cancel = (eventId, who = coordinator, reason = 'Venue issue', initiator = 'connectsphere_decision') =>
    db.query(
      `select cancel_event_request($1, $2, $3, $4::event_cancellation_initiator, $5)`,
      [eventId, who, reason, initiator, 'This event will not go ahead.'],
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
    for (const m of ['024_equipment_availability.sql', '037_equipment_request_lines.sql', '038_equipment_review.sql', '053_equipment_reservations.sql', '054_equipment_reservation_actions.sql']) await db.exec(migration(m));

    organiser = (await one("insert into auth.users (email) values ('organiser@test') returning id")).id;
    coordinator = (await one("insert into auth.users (email) values ('coordinator@test') returning id")).id;
    otherCoordinator = (await one("insert into auth.users (email) values ('other-coordinator@test') returning id")).id;
    venueStaff = (await one("insert into auth.users (email) values ('venue-staff@test') returning id")).id;
    technicalSupport = (await one("insert into auth.users (email) values ('technical-support@test') returning id")).id;
    await db.query(
      `insert into profiles (id, role) values
         ($1, 'event_organiser'),
         ($2, 'event_coordinator'),
         ($3, 'event_coordinator'),
         ($4, 'venue_staff'),
         ($5, 'technical_support_staff')`,
      [organiser, coordinator, otherCoordinator, venueStaff, technicalSupport],
    );
    venueId = (
      await one("insert into venues (name, location, max_capacity) values ('Hall', 'Block A', 100) returning id")
    ).id;
  }, 30000);

  afterAll(async () => {
    await db?.close();
  });

  const approvedEventWithReservation = async (quantity = 2) => {
    const eventId = await makeEvent('approved');
    await db.query(
      "update event_requests set proposed_start = '2026-12-01T10:00:00Z', proposed_end = '2026-12-01T12:00:00Z' where id = $1",
      [eventId],
    );
    const type = (await one(
      "insert into equipment_types (name, total_quantity) values ($1, 10) returning id",
      [`Projector ${Math.random()}`],
    )).id;
    const state = JSON.parse((await one(
      'select add_equipment_line($1, $2, $3, $4, null)::text as answer',
      [eventId, coordinator, type, quantity + 1],
    )).answer);
    await db.query('select start_equipment_review($1, $2)', [eventId, technicalSupport]);
    await db.query('select reserve_equipment($1, $2, $3, $4)', [eventId, technicalSupport, state.request.lines[0].id, quantity]);
    return eventId;
  };

  const reservationsOf = async (eventId) =>
    (await db.query(
      'select id, quantity, released_at, released_by, release_reason from equipment_reservations where event_request_id = $1',
      [eventId],
    )).rows;
  const historyOf = async (eventId) =>
    (await db.query(
      'select action, user_id, reason, quantity_before, quantity_after from equipment_reservation_events where event_request_id = $1 order by id',
      [eventId],
    )).rows;

  it('N18_AC5_cancelling_releases_live_reservations_and_records_a_system_release', async () => {
    const eventId = await approvedEventWithReservation(2);
    await cancel(eventId, coordinator, 'Venue unavailable');

    const [reservation] = await reservationsOf(eventId);
    expect(reservation.released_at).not.toBeNull();
    expect(reservation.released_by).toBeNull();
    expect(reservation.release_reason).toBe('event cancelled');

    const history = await historyOf(eventId);
    expect(history.map((row) => row.action)).toEqual(['reserved', 'released']);
    expect(history[1]).toMatchObject({
      user_id: null,
      reason: 'event cancelled',
      quantity_before: 2,
      quantity_after: 0,
    });
    expect((await one("select status::text as status from equipment_requests where event_request_id = $1", [eventId])).status)
      .toBe('cancelled');
  });

  it('N18_AC5_the_reservation_row_is_kept_not_deleted', async () => {
    const eventId = await approvedEventWithReservation(1);
    await cancel(eventId);
    expect(await reservationsOf(eventId)).toHaveLength(1);
  });

  it('N18_AC5_another_events_reservation_is_left_alone', async () => {
    const cancelled = await approvedEventWithReservation(1);
    const other = await approvedEventWithReservation(1);
    await cancel(cancelled);
    const [reservation] = await reservationsOf(other);
    expect(reservation.released_at).toBeNull();
    expect((await historyOf(other)).map((row) => row.action)).toEqual(['reserved']);
  });

  it('N18_AC5_the_released_units_are_available_again', async () => {
    const eventId = await approvedEventWithReservation(3);
    const typeId = (await one('select equipment_type_id as id from equipment_reservations where event_request_id = $1', [eventId])).id;
    const before = await one(
      "select (equipment_availability($1, '2026-12-01T10:00:00Z', '2026-12-01T12:00:00Z', null) ->> 'available')::int as available",
      [typeId],
    );
    await cancel(eventId);
    const after = await one(
      "select (equipment_availability($1, '2026-12-01T10:00:00Z', '2026-12-01T12:00:00Z', null) ->> 'available')::int as available",
      [typeId],
    );
    expect(after.available).toBe(before.available + 3);
  });

  it('N18_AC5_an_already_released_reservation_is_not_released_twice', async () => {
    const eventId = await approvedEventWithReservation(1);
    const [reservation] = await reservationsOf(eventId);
    await db.query('select release_equipment_reservation($1, $2, $3, $4)', [eventId, technicalSupport, reservation.id, 'Not needed']);
    await cancel(eventId);
    const released = (await historyOf(eventId)).filter((row) => row.action === 'released');
    expect(released).toHaveLength(1);
    expect(released[0].user_id).toBe(technicalSupport);
  });

  it('N18_AC5_a_cancel_that_is_refused_releases_nothing', async () => {
    const eventId = await approvedEventWithReservation(1);
    await expect(cancel(eventId, coordinator, '   ')).rejects.toThrow();
    const [reservation] = await reservationsOf(eventId);
    expect(reservation.released_at).toBeNull();
  });
});
