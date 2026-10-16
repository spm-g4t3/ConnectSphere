import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name) => readFileSync(resolve(here, '../../db/migrations', name), 'utf8');

const LIFECYCLE = [
  '001_event_requests.sql',
  '005_event_request_details.sql',
  '007_user_roles.sql',
  '010_event_request_clarifications.sql',
  '025_event_request_decisions.sql',
  '014_coordinator_assignment.sql',
  '015_assignment_function.sql',
  '016_submit_event_request.sql',
  '017_require_assigned_coordinator.sql',
  '020_event_status_lifecycle.sql',
  '021_event_status_history.sql',
  '022_event_status_transitions.sql',
  '029_event_request_decisions_functions.sql',
  '006_event_change_requests.sql',
  '019_change_request_decision_coordinator.sql',
  '039_coordinator_lead_and_safety_officer_roles.sql',
];
const ARRANGEMENTS = [
  '002_venues.sql',
  '009_bookings.sql',
  '011_venue_blocks.sql',
  '027_booking_request_statuses.sql',
  '022_equipment_schema.sql',
  '038_equipment_review.sql',
];
const CANCELLATION = [
  '042_event_cancellation_fields.sql',
  '043_release_event_arrangements.sql',
  '045_cancel_event_request.sql',
];

describe('SCRUM-561: cancelling from Safety review tells the Safety Officers', () => {
  let db;
  let organiser;
  let coordinator;
  let safetyOfficers;
  let venueId;

  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
  const cancel = (id) =>
    db.query(
      "select cancel_event_request($1, $2, 'Venue issue', 'connectsphere_decision'::event_cancellation_initiator, null)",
      [id, coordinator],
    );
  const officerNotices = async (id) =>
    (await db.query(
      `select recipient_id, payload->>'audience' as audience
         from notifications
        where event_request_id = $1 and type = 'event_cancelled' and payload->>'audience' = 'safety_officer'
        order by recipient_id`,
      [id],
    )).rows;

  // The real lifecycle: an Approved event with a covering booking, submitted by its coordinator.
  async function eventInSafetyReview() {
    const id = (await one(
      `insert into event_requests
         (organiser_id, event_name, status, submitted_at, assigned_coordinator_id, reviewing_coordinator_id,
          decision, decided_by, decided_at, proposed_start, proposed_end)
       values ($1, 'Safety cancel', 'approved', now(), $2, $2, 'approved', $2, now(),
               now() + interval '10 days', now() + interval '10 days 6 hours') returning id`,
      [organiser, coordinator],
    )).id;
    await db.query(
      `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
       select $1, id, proposed_start, proposed_end, 'approved' from event_requests where id = $2`,
      [venueId, id],
    );
    await db.query('select submit_event_for_safety_review($1, $2, null, false)', [id, coordinator]);
    return id;
  }

  beforeAll(async () => {
    db = new PGlite({ extensions: { btree_gist } });
    await db.exec(`
      create schema auth;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text);
      create role anon;
      create role authenticated;
      create role service_role;
    `);
    for (const name of LIFECYCLE) await db.exec(migration(name));
    await db.exec(`
      create table notifications (
        id uuid primary key default gen_random_uuid(),
        recipient_id uuid not null references auth.users (id) on delete cascade,
        type text not null,
        booking_id uuid,
        block_id uuid,
        venue_hold_id uuid,
        payload jsonb not null default '{}',
        read_at timestamptz,
        created_at timestamptz not null default now(),
        constraint notifications_type_known check (type in ('booking_flagged'))
      );
    `);
    await db.exec('alter table event_requests add column clarification_reply_by_date date');
    await db.exec(`
      create function reply_to_event_clarification(uuid, uuid, text)
      returns event_requests language sql as $$ select null::event_requests $$;
    `);
    await db.exec(migration('030_event_clarification_reply_by.sql'));
    await db.exec(migration('026_clarification_amendment_fields.sql'));
    await db.exec(migration('052_lead_assignment.sql'));
    await db.exec(migration(CANCELLATION[0]));
    for (const name of ARRANGEMENTS) await db.exec(migration(name));
    for (const name of CANCELLATION.slice(1)) await db.exec(migration(name));
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
    await db.exec(migration('062_safety_statuses.sql'));
    await db.exec(migration('063_safety_transitions.sql'));
    await db.exec(migration('064_safety_review_submission.sql'));
    await db.exec(migration('071_cancel_event_in_safety_status.sql'));

    const user = async (email, role) => {
      const id = (await one('insert into auth.users (email) values ($1) returning id', [email])).id;
      await db.query('insert into profiles (id, role, full_name) values ($1, $2, $3)', [id, role, email]);
      return id;
    };
    organiser = await user('o@x', 'event_organiser');
    coordinator = await user('c@x', 'event_coordinator');
    safetyOfficers = [await user('so1@x', 'safety_officer'), await user('so2@x', 'safety_officer')];
    await user('plain@x', 'venue_staff');
    venueId = (await one("insert into venues (name, location, max_capacity) values ('Hall', 'SMU', 200) returning id")).id;
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM561_AC2_cancelling_from_safety_review_notifies_the_same_officers_who_were_asked_to_review', async () => {
    const id = await eventInSafetyReview();
    const submitted = (await db.query(
      "select recipient_id from notifications where type = 'event_submitted_for_safety_review' and event_request_id = $1 order by recipient_id",
      [id],
    )).rows.map((row) => row.recipient_id);
    expect(submitted.sort()).toEqual([...safetyOfficers].sort());

    await cancel(id);

    const notices = await officerNotices(id);
    expect(notices.map((row) => row.recipient_id).sort()).toEqual(submitted);
  });

  it('SCRUM561_AC2_cancelling_from_safety_approved_does_not_notify_the_officers_again', async () => {
    const id = await eventInSafetyReview();
    await db.query(
      "select change_event_request_status($1, 'safety_review', 'safety_approved', $2, null, $2)",
      [id, coordinator],
    );

    await cancel(id);

    expect(await officerNotices(id)).toEqual([]);
  });
});
