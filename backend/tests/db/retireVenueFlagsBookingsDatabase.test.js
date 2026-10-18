/**
 * Retiring a venue flags its future approved bookings and tells each event's
 * coordinator (085), against a real Postgres.
 *
 * SCRUM-174 AC5 (the coordinator learns their venue is gone; nothing is
 * cancelled) and AC6 (the notice names the event and the venue).
 *
 * Migrations: notifyVenueStaffBookingRequestDatabase.test.js's stack, with
 * the venue audit and retirement (003-005, 008), 039 for the Lead role, then
 * 084 and 085.
 *
 * Dates: D is the Singapore date 10 days from now, never hard-coded, because
 * only a booking that has not ended is flagged.
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
  '003_venue_audit.sql',
  '004_venue_functions.sql',
  '005_venue_retirement.sql',
  '008_venue_audit_completion.sql',
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
  '039_coordinator_lead_and_safety_officer_roles.sql',
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
  '084_block_flag_notifies_event_coordinator.sql',
  '085_retire_venue_flags_bookings.sql',
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

describe('SCRUM-174: retiring a venue flags its bookings and tells the coordinator (085)', () => {
  let db;
  let organiser;
  let coordinator;
  let staff;
  let leads;
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

  /** A pending request, raised by the coordinator as the API raises it. */
  const request = async (eventId, venueId) =>
    (
      await one(
        `select create_booking_request($1, $2, $3, null, null, $4::jsonb, false, 100, null) as result`,
        [eventId, venueId, coordinator, JSON.stringify({ suitable: true })],
      )
    ).result.booking.id;

  const approve = (bookingId) =>
    db.query(`update bookings set status = 'approved' where id = $1`, [bookingId]);

  const retire = (venueId) => db.query('select retire_venue($1, $2)', [venueId, staff]);

  const booking = (id) => one('select * from bookings where id = $1', [id]);

  const notices = async (bookingId, type) =>
    (
      await db.query(
        `select recipient_id, booking_id, block_id, payload from notifications
          where booking_id = $1 and type = $2 order by recipient_id`,
        [bookingId, type],
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
    leads = [
      await makeUser('l@x', 'event_coordinator_lead'),
      await makeUser('l2@x', 'event_coordinator_lead'),
    ].sort();
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM174_AC5_retiring_a_venue_flags_its_future_approved_bookings_and_tells_their_coordinator', async () => {
    const venue = await makeVenue();
    const id = await request(await makeEvent(), venue);
    await approve(id);

    await retire(venue);

    const flagged = await booking(id);
    expect(flagged.status).toBe('flagged_for_review');
    expect(flagged.review_reason).toBe('venue_details_changed');
    expect(flagged.review_block_id).toBeNull();
    expect(flagged.flagged_by).toBe(staff);
    expect(flagged.flagged_at).not.toBeNull();
    expect((await notices(id, 'booking_flagged_venue_retired')).map((n) => n.recipient_id)).toEqual([
      coordinator,
    ]);
    // A flag with no block still reaches Venue Staff's flagged list (078).
    const list = (await one('select list_flagged_bookings($1) as list', [staff])).list;
    expect(list.find((row) => row.id === id)).toMatchObject({
      review_reason: 'venue_details_changed',
      block_id: null,
    });
  });

  it('SCRUM174_AC5_a_past_booking_is_not_flagged_when_its_venue_retires', async () => {
    const venue = await makeVenue();
    const id = await request(await makeEvent(), venue);
    await db.query(
      `update bookings
          set status = 'approved',
              starts_at = now() - interval '2 days',
              ends_at = now() - interval '2 days' + interval '2 hours'
        where id = $1`,
      [id],
    );

    await retire(venue);

    expect((await booking(id)).status).toBe('approved');
    expect(await notices(id, 'booking_flagged_venue_retired')).toEqual([]);
  });

  it('SCRUM174_AC5_a_pending_request_at_a_retired_venue_is_told_but_not_changed', async () => {
    const venue = await makeVenue();
    const id = await request(await makeEvent(), venue);

    await retire(venue);

    expect((await booking(id)).status).toBe('pending');
    const told = await notices(id, 'booking_request_venue_unavailable');
    expect(told.map((n) => [n.recipient_id, n.block_id, n.payload.cause])).toEqual([
      [coordinator, null, 'retired'],
    ]);
    expect(await notices(id, 'booking_flagged_venue_retired')).toEqual([]);
  });

  it('SCRUM174_AC5_an_unassigned_events_retirement_flag_reaches_the_leads', async () => {
    const venue = await makeVenue();
    const event = await makeEvent();
    const id = await request(event, venue);
    await approve(id);
    await db.query('update event_requests set assigned_coordinator_id = null where id = $1', [event]);

    await retire(venue);

    expect((await booking(id)).status).toBe('flagged_for_review');
    expect((await notices(id, 'booking_flagged_venue_retired')).map((n) => n.recipient_id)).toEqual(
      leads,
    );
  });

  it('SCRUM174_AC6_retirement_notice_names_event_and_venue', async () => {
    const venue = await makeVenue();
    const event = await makeEvent();
    const id = await request(event, venue);
    await approve(id);

    await retire(venue);

    const [notice] = await notices(id, 'booking_flagged_venue_retired');
    const names = await one(
      `select e.event_name, v.name as venue_name, v.retired_at, b.starts_at, b.ends_at
         from bookings b
         join event_requests e on e.id = b.event_request_id
         join venues v on v.id = b.venue_id
        where b.id = $1`,
      [id],
    );
    const iso = (value) => new Date(value).toISOString();
    expect(notice.booking_id).toBe(id);
    expect({
      ...notice.payload,
      startsAt: iso(notice.payload.startsAt),
      endsAt: iso(notice.payload.endsAt),
      retiredAt: iso(notice.payload.retiredAt),
    }).toEqual({
      eventRequestId: event,
      eventName: names.event_name,
      venueId: venue,
      venueName: names.venue_name,
      startsAt: iso(names.starts_at),
      endsAt: iso(names.ends_at),
      retiredAt: iso(names.retired_at),
    });
  });
});
