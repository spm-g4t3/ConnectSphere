/**
 * Migration 075 on PGlite: 071 and 074 restated notifications_type_known and
 * cancel_event_request after 066 and 067, so 075 puts the booking-decision
 * changes back and teaches 064's event_readiness about 'conflicting'.
 *
 * Stack: cancelConflictingBookingRequestDatabase's (through 067), plus 029, 039
 * and 052 for the safety lifecycle as scrum561SafetyCancelNotificationDatabase
 * applies it, then 062-064 and 071-075 in filename order.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '../../db/migrations');
const migration = (name) => readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8');
const MIGRATION = '075_booking_decisions_after_safety_review.sql';

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
  '029_event_request_decisions_functions.sql',
];
const EQUIPMENT = [
  '024_equipment_availability.sql',
  '037_equipment_request_lines.sql',
  '038_equipment_review.sql',
  '053_equipment_reservations.sql',
  '054_equipment_reservation_actions.sql',
];
const SAFETY = [
  '062_safety_statuses.sql',
  '063_safety_transitions.sql',
  '064_safety_review_submission.sql',
  '071_safety_review.sql',
  '072_safety_review_history.sql',
  '073_safety_review_gates.sql',
  '074_cancel_event_in_safety_status.sql',
];

const SQL_FILES = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();
const normalised = (file) => migration(file).replace(/--[^\n]*/g, '').toLowerCase().replace(/\s+/g, ' ');

/** The last migration, in filename order, whose text (comments stripped) includes `needle`. */
const latestFileWith = (needle) => SQL_FILES.filter((file) => normalised(file).includes(needle)).at(-1);

describe('SCRUM-258: booking decisions restated after the safety review migrations (075)', () => {
  let db;
  let organiser;
  let coordinator;
  let venueStaff;
  let safetyOfficers;
  let hall;
  let annex;

  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
  const refusal = async (promise) => {
    try {
      await promise;
      return null;
    } catch (err) {
      return err;
    }
  };
  const bookingStatus = async (id) =>
    (await one('select status::text as status from bookings where id = $1', [id])).status;

  /** An Approved event held by the coordinator, starting in 10 days for 6 hours. */
  async function approvedEvent(name = 'Booking decisions') {
    return (
      await one(
        `insert into event_requests
           (organiser_id, event_name, status, submitted_at, assigned_coordinator_id, reviewing_coordinator_id,
            decision, decided_by, decided_at, proposed_start, proposed_end)
         values ($1, $2, 'approved', now(), $3, $3, 'approved', $3, now(),
                 now() + interval '10 days', now() + interval '10 days 6 hours')
         returning id`,
        [organiser, name, coordinator],
      )
    ).id;
  }

  /** A booking covering the event's proposed start to end. */
  async function booking(eventId, venueId, status) {
    return (
      await one(
        `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
         select $1, id, proposed_start, proposed_end, $3::booking_status from event_requests where id = $2
         returning id`,
        [venueId, eventId, status],
      )
    ).id;
  }

  const cancel = (eventId) =>
    db.query(
      `select cancel_event_request($1, $2, 'Venue issue', 'connectsphere_decision'::event_cancellation_initiator, null)`,
      [eventId, coordinator],
    );

  const cancelNotices = async (eventId, audience) =>
    (
      await db.query(
        `select recipient_id from notifications
          where event_request_id = $1 and type = 'event_cancelled' and payload->>'audience' = $2
          order by recipient_id`,
        [eventId, audience],
      )
    ).rows.map((row) => row.recipient_id);

  const readiness = async (id) => (await one('select event_readiness($1, false) as r', [id])).r;

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
    await db.exec(migration('039_coordinator_lead_and_safety_officer_roles.sql'));

    await db.exec(`
      create table notifications (
        id uuid primary key default gen_random_uuid(),
        recipient_id uuid not null references auth.users(id) on delete cascade,
        type text not null,
        booking_id uuid,
        block_id uuid,
        venue_hold_id uuid,
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
    await db.exec(migration('052_lead_assignment.sql'));
    await db.exec(migration('002_venues.sql'));
    await db.exec(migration('009_bookings.sql'));
    await db.exec(migration('011_venue_blocks.sql'));
    await db.exec(migration('017_venue_turnaround.sql'));
    await db.exec(migration('023_venue_setup_time.sql'));
    await db.exec(migration('027_booking_request_statuses.sql'));
    await db.exec(migration('032_venue_occupancy.sql'));
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
    // 065's enum values must commit before 066 and 067 use them, so each is its own exec.
    await db.exec(migration('065_booking_decision_statuses.sql'));
    await db.exec(migration('066_venue_staff_booking_decisions.sql'));
    await db.exec(migration('067_withdraw_conflicting_on_cancellation.sql'));
    for (const name of SAFETY) await db.exec(migration(name));
    await db.exec(migration(MIGRATION));

    const user = async (email, role) => {
      const id = (await one('insert into auth.users (email) values ($1) returning id', [email])).id;
      await db.query('insert into profiles (id, role, full_name) values ($1, $2, $3)', [id, role, email]);
      return id;
    };
    organiser = await user('o@x', 'event_organiser');
    coordinator = await user('c@x', 'event_coordinator');
    venueStaff = await user('vs@x', 'venue_staff');
    safetyOfficers = [await user('so1@x', 'safety_officer'), await user('so2@x', 'safety_officer')].sort();
    hall = (await one("insert into venues (name, location, max_capacity) values ('Hall', 'SMU', 200) returning id")).id;
    annex = (await one("insert into venues (name, location, max_capacity) values ('Annex', 'SMU', 200) returning id")).id;
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('notifications_type_known', () => {
    it.each(['booking_request_approved', 'booking_request_rejected', 'booking_request_conflicting'])(
      'SCRUM258_AC6_a_%s_notification_is_accepted_after_071_and_075',
      async (type) => {
        const eventId = await approvedEvent();
        const bookingId = await booking(eventId, hall, 'pending');

        const err = await refusal(
          db.query('insert into notifications (recipient_id, type, booking_id, event_request_id) values ($1, $2, $3, $4)', [
            coordinator,
            type,
            bookingId,
            eventId,
          ]),
        );

        expect(err).toBeNull();
      },
    );

    it('SCRUM258_AC6_071s_types_are_still_accepted_after_075', async () => {
      const eventId = await approvedEvent();
      for (const type of ['safety_review_response', 'event_submitted_for_safety_review', 'event_cancelled']) {
        const err = await refusal(
          db.query('insert into notifications (recipient_id, type, event_request_id) values ($1, $2, $3)', [
            coordinator,
            type,
            eventId,
          ]),
        );
        expect(err, type).toBeNull();
      }
    });

    it('SCRUM258_AC6_the_list_is_071s_plus_the_three_decision_types', async () => {
      const { def } = await one(
        "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'notifications_type_known'",
      );

      expect([...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1])).toEqual([
        'booking_flagged', 'booking_request_withdrawn', 'clarification_requested', 'clarification_replied',
        'clarification_closed', 'booking_flagged_setup_change', 'venue_hold_expired', 'event_cancelled',
        'event_request_awaiting_assignment', 'event_request_assigned', 'event_request_coordinator_assigned',
        'safety_review_response', 'safety_booking_flagged', 'safety_equipment_review',
        'event_submitted_for_safety_review',
        'booking_request_approved', 'booking_request_rejected', 'booking_request_conflicting',
      ]);
    });

    it('SCRUM258_AC6_an_unknown_type_is_still_refused', async () => {
      const err = await refusal(
        db.query("insert into notifications (recipient_id, type) values ($1, 'not_a_type')", [coordinator]),
      );

      expect(err?.code).toBe('23514');
    });
  });

  describe('cancel_event_request', () => {
    it('SCRUM258_AC3_cancelling_an_event_whose_only_open_request_is_conflicting_tells_venue_staff_and_withdraws_it', async () => {
      const eventId = await approvedEvent();
      const conflicting = await booking(eventId, hall, 'conflicting');

      await cancel(eventId);

      expect(await bookingStatus(conflicting)).toBe('withdrawn');
      expect(await cancelNotices(eventId, 'venue_staff')).toEqual([venueStaff]);
    });

    it('SCRUM258_AC3_cancelling_an_event_with_no_venue_requests_does_not_tell_venue_staff', async () => {
      const eventId = await approvedEvent();

      await cancel(eventId);

      expect(await cancelNotices(eventId, 'venue_staff')).toEqual([]);
    });

    it('SCRUM258_AC3_cancelling_from_safety_review_still_tells_the_safety_officers', async () => {
      const eventId = await approvedEvent();
      await booking(eventId, hall, 'approved');
      await db.query('select submit_event_for_safety_review($1, $2, null, false)', [eventId, coordinator]);
      expect((await one('select status::text as status from event_requests where id = $1', [eventId])).status).toBe(
        'safety_review',
      );

      await cancel(eventId);

      expect(await cancelNotices(eventId, 'safety_officer')).toEqual(safetyOfficers);
      expect(await cancelNotices(eventId, 'venue_staff')).toEqual([venueStaff]);
    });
  });

  describe('event_readiness', () => {
    it('SCRUM258_AC3_a_conflicting_booking_is_a_venue_line_that_is_never_met', async () => {
      const eventId = await approvedEvent();
      const bookingId = await booking(eventId, hall, 'conflicting');

      const r = await readiness(eventId);

      expect(r.ready).toBe(false);
      expect(r.items.filter((i) => i.key === 'venue')).toEqual([
        { key: 'venue', met: false, detail: 'Conflicting, awaiting a decision', bookingId, venueName: 'Hall' },
      ]);
    });

    it('SCRUM258_AC3_a_conflicting_booking_keeps_the_event_not_ready_beside_an_approved_covering_one', async () => {
      const eventId = await approvedEvent();
      const approved = await booking(eventId, hall, 'approved');
      const conflicting = await booking(eventId, annex, 'conflicting');

      const r = await readiness(eventId);

      expect(r.ready).toBe(false);
      const venueLines = r.items.filter((i) => i.key === 'venue');
      expect(venueLines).toHaveLength(2);
      expect(venueLines).toEqual(
        expect.arrayContaining([
          { key: 'venue', met: true, detail: 'Approved', bookingId: approved, venueName: 'Hall' },
          {
            key: 'venue',
            met: false,
            detail: 'Conflicting, awaiting a decision',
            bookingId: conflicting,
            venueName: 'Annex',
          },
        ]),
      );
    });
  });

  describe('075 itself', () => {
    it('SCRUM258_AC3_075_is_the_latest_definition_of_cancel_event_request_and_event_readiness', () => {
      expect(latestFileWith('create or replace function cancel_event_request(')).toBe(MIGRATION);
      expect(latestFileWith('create or replace function event_readiness(')).toBe(MIGRATION);
    });

    it('SCRUM258_AC6_075_is_the_latest_migration_setting_notifications_type_known', () => {
      expect(latestFileWith('add constraint notifications_type_known')).toBe(MIGRATION);
    });
  });
});
