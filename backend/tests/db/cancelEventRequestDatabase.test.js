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

describe('SCRUM-374: cancel_event_request in Postgres', () => {
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

  it('cancels a newly created event arrangement set and closes open change/clarification requests', async () => {
    const eventId = await makeEvent('pending_clarification');
    const bookingId = await makeBooking(eventId, 'pending');
    const holdId = await makeHold(eventId);
    const unrelatedEventId = await makeEvent('approved');
    const unrelatedHoldId = await makeHold(unrelatedEventId);
    const equipmentRequestId = (
      await one(
        `insert into equipment_requests (event_request_id, status)
         values ($1, 'pending_review') returning id`,
        [eventId],
      )
    ).id;
    const changeRequestId = await makeChangeRequest(eventId);
    await db.query(
      `insert into event_request_clarification_history
         (event_request_id, entry_type, message, created_by)
       values ($1, 'question', 'Please clarify the event plan', $2)`,
      [eventId, coordinator],
    );

    const { preview } = await one(
      'select event_cancellation_impact_preview($1) as preview',
      [eventId],
    );
    expect(preview.venueHolds).toMatchObject({
      count: 1,
      details: [expect.objectContaining({ id: holdId, venueName: 'Hall' })],
    });

    await cancel(eventId, coordinator, '  Venue unavailable  ', 'organiser_request');

    const cancelled = await eventRow(eventId);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancellation_reason).toBe('Venue unavailable');
    expect(cancelled.cancellation_initiator).toBe('organiser_request');
    expect(cancelled.cancelled_by).toBe(coordinator);
    expect(cancelled.cancelled_at).not.toBeNull();
    expect(cancelled.attendee_message).toBe('This event will not go ahead.');
    expect(await bookingStatus(bookingId)).toBe('withdrawn');
    expect(await one(
      'select status::text as status, released_at, released_by from venue_holds where id = $1',
      [holdId],
    )).toMatchObject({ status: 'released', released_by: coordinator });
    expect((await one('select status::text as status from venue_holds where id = $1', [unrelatedHoldId])).status)
      .toBe('active');
    expect((await one('select status::text as status from equipment_requests where id = $1', [equipmentRequestId])).status)
      .toBe('cancelled');
    const notifications = (await db.query(
      `select recipient_id, payload
         from notifications
        where event_request_id = $1 and type = 'event_cancelled'`,
      [eventId],
    )).rows;
    expect(notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        recipient_id: organiser,
        payload: expect.objectContaining({
          audience: 'organiser',
          eventName: expect.stringContaining('Cancellation test'),
          reason: 'Venue unavailable',
        }),
      }),
      expect.objectContaining({
        recipient_id: venueStaff,
        payload: expect.objectContaining({ audience: 'venue_staff' }),
      }),
      expect.objectContaining({
        recipient_id: technicalSupport,
        payload: expect.objectContaining({ audience: 'technical_support_staff' }),
      }),
    ]));
    const changeRequest = await one(
      'select status::text as status, decision::text as decision, processed_by, processed_at from event_change_requests where id = $1',
      [changeRequestId],
    );
    expect(changeRequest).toMatchObject({
      status: 'processed',
      decision: 'event_cancelled',
      processed_by: coordinator,
    });
    expect(changeRequest.processed_at).not.toBeNull();
    expect(
      (await db.query(
        `select entry_type, message
           from event_request_clarification_history
          where event_request_id = $1
          order by created_at, id`,
        [eventId],
      )).rows,
    ).toMatchObject([
      { entry_type: 'question', message: 'Please clarify the event plan' },
      { entry_type: 'closure', message: 'Event cancelled' },
    ]);
    expect(await statusHistory(eventId)).toMatchObject([
      { previous_status: 'pending_clarification', new_status: 'cancelled', reason: 'Venue unavailable' },
    ]);
  });

  it('rolls back the status, history, metadata, and earlier releases when a release step fails', async () => {
    const eventId = await makeEvent('approved');
    const bookingId = await makeBooking(eventId, 'approved');
    const changeRequestId = await makeChangeRequest(eventId);
    await db.exec(`
      create function fail_booking_cancellation()
      returns trigger language plpgsql as $$
      begin
        raise exception 'simulated arrangement release failure' using errcode = 'P0001';
      end;
      $$;
      create trigger fail_booking_cancellation
      before update on bookings
      for each row execute function fail_booking_cancellation();
    `);

    await expect(cancel(eventId)).rejects.toMatchObject({ code: 'P0001' });

    expect((await eventRow(eventId)).status).toBe('approved');
    expect((await eventRow(eventId)).cancellation_reason).toBeNull();
    expect(await statusHistory(eventId)).toHaveLength(0);
    expect(await bookingStatus(bookingId)).toBe('approved');
    expect((await one('select status::text as status from event_change_requests where id = $1', [changeRequestId])).status)
      .toBe('outstanding');
    await db.exec('drop trigger fail_booking_cancellation on bookings;');
    await db.exec('drop function fail_booking_cancellation();');
  });

  it('rejects the wrong coordinator without changing anything', async () => {
    const eventId = await makeEvent('submitted');
    const bookingId = await makeBooking(eventId);

    await expect(cancel(eventId, otherCoordinator)).rejects.toMatchObject({ code: '42501' });

    expect((await eventRow(eventId)).status).toBe('submitted');
    expect((await eventRow(eventId)).cancellation_reason).toBeNull();
    expect(await bookingStatus(bookingId)).toBe('approved');
    expect(await statusHistory(eventId)).toHaveLength(0);
  });

  it('rejects an unsupported status with its name and leaves state untouched', async () => {
    const eventId = await makeEvent('draft');
    const error = await db.query(
      `select cancel_event_request($1, $2, 'Reason', 'connectsphere_decision', null)`,
      [eventId, coordinator],
    ).then(() => null, (caught) => caught);

    expect(error.code).toBe('55000');
    expect(error.message).toContain('draft');
    expect((await eventRow(eventId)).status).toBe('draft');
    expect(await statusHistory(eventId)).toHaveLength(0);
  });

  it('rejects a blank reason or missing initiator', async () => {
    const eventId = await makeEvent();

    await expect(cancel(eventId, coordinator, '   ')).rejects.toMatchObject({ code: '22023' });
    await expect(
      db.query(
        'select cancel_event_request($1, $2, $3, null, null)',
        [eventId, coordinator, 'Reason'],
      ),
    ).rejects.toMatchObject({ code: '22004' });
    expect((await eventRow(eventId)).status).toBe('submitted');
  });

  describe.each(['safety_review', 'safety_approved'])('SCRUM561: from %s', (status) => {
    beforeAll(async () => {
      if (!(await one("select 1 as ok from pg_enum where enumlabel = 'safety_review'"))) {
        await db.exec(migration('062_safety_statuses.sql'));
        await db.exec(migration('063_safety_transitions.sql'));
      }
      await db.exec(migration('071_cancel_event_in_safety_status.sql'));
    });

    async function makeSafetyEvent() {
      return (
        await one(
          `insert into event_requests
             (organiser_id, event_name, status, submitted_at, assigned_coordinator_id,
              reviewing_coordinator_id, decision, decided_by, decided_at)
           values ($1, 'Safety cancel', $2::event_request_status, now(), $3, $3, 'approved', $3, now())
           returning id`,
          [organiser, status, coordinator],
        )
      ).id;
    }

    it(`SCRUM561_AC1_AC2_assigned_coordinator_cancels_from_${status}_and_releases_arrangements`, async () => {
      const eventId = await makeSafetyEvent();
      const bookingId = await makeBooking(eventId, 'approved');
      const holdId = await makeHold(eventId);

      await cancel(eventId);

      const event = await eventRow(eventId);
      expect(event.status).toBe('cancelled');
      expect(event.cancellation_reason).toBe('Venue issue');
      expect(await bookingStatus(bookingId)).toBe('cancelled');
      expect((await one('select status::text as status from venue_holds where id = $1', [holdId])).status)
        .not.toBe('active');
      expect((await statusHistory(eventId)).at(-1)).toMatchObject({
        previous_status: status,
        new_status: 'cancelled',
      });
      const notified = (
        await db.query(
          "select recipient_id from notifications where event_request_id = $1 and type = 'event_cancelled'",
          [eventId],
        )
      ).rows.map((row) => row.recipient_id);
      expect(notified).toEqual(expect.arrayContaining([organiser, venueStaff]));
    });

    it(`SCRUM561_AC1_another_coordinator_cannot_cancel_from_${status}`, async () => {
      const eventId = await makeSafetyEvent();

      await expect(cancel(eventId, otherCoordinator)).rejects.toMatchObject({ code: '42501' });
      expect((await eventRow(eventId)).status).toBe(status);
    });
  });
});
