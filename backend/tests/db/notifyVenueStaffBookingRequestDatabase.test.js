/**
 * Every Venue Staff user is notified when a coordinator submits a venue
 * booking request (083), against a real Postgres.
 *
 * SCRUM-174 AC1 (who is told, and only for a request that was created) and
 * AC6 (the notice names the event and the venue).
 *
 * Migrations: replaceFlaggedBookingDatabase.test.js's stack, the same
 * stand-ins, then 083.
 *
 * Dates: D is the Singapore date 10 days from now, never hard-coded, because
 * a booking counts only while it has not ended.
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
  '034_setup_change_recheck.sql',
  '040_venue_holds.sql',
  '051_multi_venue_booking_requests.sql',
  '065_booking_decision_statuses.sql',
  'SAFETY_ENUM',
  '066_venue_staff_booking_decisions.sql',
  'SAFETY_REASON',
  '076_reinstate_flagged_booking.sql',
  '077_cancel_flagged_booking.sql',
  '078_list_flagged_bookings.sql',
  '083_notify_venue_staff_booking_request.sql',
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

describe('SCRUM-174: Venue Staff are told of a new booking request (083)', () => {
  let db;
  let organiser;
  let coordinator;
  let staff;
  let otherStaff;
  let counter = 0;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  async function makeUser(email, role) {
    const id = (await one('insert into auth.users (email) values ($1) returning id', [email])).id;
    if (role) await db.query('insert into profiles (id, role) values ($1, $2)', [id, role]);
    return id;
  }

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

  async function makeEvent() {
    counter += 1;
    return (
      await one(
        `insert into event_requests
           (organiser_id, event_name, status, proposed_start, proposed_end,
            expected_attendance, submitted_at, assigned_coordinator_id)
         values ($1, $2, 'approved', $3, $4, 150, now(), $5) returning id`,
        [organiser, `Event ${counter}`, at('14:00'), at('16:00'), coordinator],
      )
    ).id;
  }

  /** create_booking_request as the API calls it. */
  const request = async (eventId, venueId, suitable = true) =>
    (
      await one(
        `select create_booking_request($1, $2, $3, null, null, $4::jsonb, false, 100, null) as result`,
        [eventId, venueId, coordinator, JSON.stringify({ suitable })],
      )
    ).result;

  const submittedNotices = async (eventId) =>
    (
      await db.query(
        `select recipient_id, booking_id, payload from notifications
          where type = 'booking_request_submitted' and payload->>'eventRequestId' = $1`,
        [eventId],
      )
    ).rows;

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
    otherStaff = await makeUser('s2@x', 'venue_staff');
    await makeUser('t@x', 'technical_support_staff');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM174_AC1_every_venue_staff_notified_on_new_request', async () => {
    const event = await makeEvent();

    const created = await request(event, await makeVenue());

    expect(created.outcome).toBe('created');
    const recipients = (await submittedNotices(event)).map((n) => n.recipient_id).sort();
    expect(recipients).toEqual([staff, otherStaff].sort());
  });

  it('SCRUM174_AC6_notice_names_event_and_venue', async () => {
    const event = await makeEvent();
    const venue = await makeVenue();

    const { booking } = await request(event, venue);

    const [notice] = await submittedNotices(event);
    const names = await one(
      `select e.event_name, v.name as venue_name
         from event_requests e, venues v where e.id = $1 and v.id = $2`,
      [event, venue],
    );
    expect(notice.booking_id).toBe(booking.id);
    expect(notice.payload).toEqual({
      eventRequestId: event,
      eventName: names.event_name,
      venueId: venue,
      venueName: names.venue_name,
      startsAt: booking.starts_at,
      endsAt: booking.ends_at,
    });
  });

  it('SCRUM174_AC1_no_notice_when_request_not_created', async () => {
    // Another event's approved booking at the same venue and time is a conflict.
    const venue = await makeVenue();
    const holder = await makeEvent();
    const held = (await request(holder, venue)).booking.id;
    await db.query(`update bookings set status = 'approved' where id = $1`, [held]);
    const clashing = await makeEvent();
    const unsuitable = await makeEvent();

    expect((await request(clashing, venue)).outcome).toBe('conflict');
    expect((await request(unsuitable, await makeVenue(), false)).outcome).toBe(
      'suitability_confirmation_required',
    );

    expect(await submittedNotices(clashing)).toEqual([]);
    expect(await submittedNotices(unsuitable)).toEqual([]);
  });

  it('SCRUM174_AC1_submitted_notice_requires_booking', async () => {
    let error = null;
    try {
      await db.query(
        `insert into notifications (recipient_id, type, booking_id, payload)
         values ($1, 'booking_request_submitted', null, '{}'::jsonb)`,
        [staff],
      );
    } catch (err) {
      error = err;
    }

    expect(error?.code).toBe('23514');
  });
});
