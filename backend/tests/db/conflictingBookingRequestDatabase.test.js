/**
 * Approving a request marks the other events' overlapping pending requests
 * conflicting and tells their coordinators (065, 066), against a real Postgres.
 *
 * SCRUM-258 AC3 at the SQL level, with the Week 7 rules: overlap is of the
 * padded occupied periods, each request is decided on its own, and a change
 * flags and notifies but never decides. So a conflicting request is a flag on
 * an open request, not an outcome: it stays in the Venue Staff queue, can be
 * rejected, withdrawn, or approved once its clash is gone, still counts as the
 * event's live request at that venue, and never occupies the venue.
 *
 * Migrations: decideBookingRequestDatabase.test.js's stack (065's enum value
 * must commit before 066 uses it, so each is its own exec).
 *
 * PGlite is one connection, so the lock order 066 takes is not raced here.
 *
 * Dates: D is the Singapore date 10 days from now, never hard-coded.
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
const MIGRATION_066 = '066_venue_staff_booking_decisions.sql';

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
  '040_venue_holds.sql',
  '051_multi_venue_booking_requests.sql',
  '065_booking_decision_statuses.sql',
  'SAFETY_ENUM',
  MIGRATION_066,
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

/** D: the Singapore date 10 days from now, as YYYY-MM-DD. */
const D = new Date(Date.now() + 8 * 3600_000 + 10 * 86_400_000).toISOString().slice(0, 10);
/** An instant on D, written at +08:00 (Singapore). */
const at = (hhmm) => `${D}T${hhmm}:00+08:00`;

const SUITABLE = { suitable: true, criteria: [{ criterion: 'Capacity', met: true }] };

/** The error a promise rejected with; null if it resolved. */
const refusal = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
};

/** The quoted words of the notifications_type_known check a migration sets. */
const notificationTypes = (sql) => {
  const start = sql.indexOf('add constraint notifications_type_known');
  const list = sql.slice(start, sql.indexOf(');', start));
  return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
};

/** A function's body as a migration defines it, comments stripped. */
const functionBody = (file, name) => {
  const sql = migration(file).replace(/--[^\n]*/g, '');
  const start = sql.indexOf(`create or replace function ${name}(`);
  return sql.slice(start, sql.indexOf('$$;', start));
};

describe('SCRUM-258 AC3: overlapping requests become conflicting (065, 066)', () => {
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

  async function makeEvent({ start = at('14:00'), end = at('16:00'), assignedTo = coordinator } = {}) {
    counter += 1;
    return (
      await one(
        `insert into event_requests
           (organiser_id, event_name, status, proposed_start, proposed_end,
            expected_attendance, submitted_at, assigned_coordinator_id)
         values ($1, $2, 'approved', $3, $4, 150, now(), $5) returning id`,
        [organiser, `Event ${counter}`, start, end, assignedTo],
      )
    ).id;
  }

  /** A booking written directly, for the event's own period. */
  async function insertBooking(eventId, venueId, status = 'pending') {
    const event = await one('select proposed_start, proposed_end from event_requests where id = $1', [eventId]);
    return (
      await one(
        `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
         values ($1, $2, $3, $4, $5) returning id`,
        [venueId, eventId, event.proposed_start, event.proposed_end, status],
      )
    ).id;
  }

  /** A pending request at venueId for a new event on start-end. */
  async function pending(venueId, start = at('14:00'), end = at('16:00'), eventOptions = {}) {
    const eventId = await makeEvent({ start, end, ...eventOptions });
    return { id: await insertBooking(eventId, venueId), eventId };
  }

  const decide = async (bookingId, decision, reason = null) =>
    (
      await one('select decide_booking_request($1, $2, $3, $4, null) as result', [
        bookingId,
        staff,
        decision,
        reason,
      ])
    ).result;

  const statusOf = async (id) => (await one('select status::text as status from bookings where id = $1', [id])).status;
  const noticesFor = (bookingId, type) =>
    rows('select * from notifications where booking_id = $1 and type = $2', [bookingId, type]);
  const sorted = (ids) => [...ids].sort();

  /** An approved booking at venueId and a request that it has made conflicting. */
  async function conflictingBehindApproval(venueId) {
    const approved = await pending(venueId, at('10:00'), at('12:00'));
    const conflicting = await pending(venueId, at('11:00'), at('13:00'));
    await decide(approved.id, 'approve');
    expect(await statusOf(conflicting.id)).toBe('conflicting');
    return { approved, conflicting };
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

  describe('what an approval marks', () => {
    it('SCRUM258_AC3_approval_marks_only_other_events_requests_whose_occupied_periods_overlap', async () => {
      const [venue, elsewhere] = [await makeVenue(), await makeVenue()];
      // Approved 14:00-16:00 occupies 13:30-16:45.
      const approving = await pending(venue);
      const ownElsewhere = await insertBooking(approving.eventId, elsewhere);
      const raw = await pending(venue, at('15:00'), at('17:00'));
      // Raw 16:30 starts after 16:00, but its setup from 16:00 meets the turnaround.
      const padded = await pending(venue, at('16:30'), at('17:30'));
      // Occupied from 16:45, exactly where the approved turnaround ends.
      const touching = await pending(venue, at('17:15'), at('18:00'));
      const otherVenue = await pending(elsewhere, at('14:00'), at('16:00'));

      const result = await decide(approving.id, 'approve');

      expect(result.outcome).toBe('approved');
      expect(result.marked_conflicting).toEqual(sorted([raw.id, padded.id]));
      expect(await statusOf(raw.id)).toBe('conflicting');
      expect(await statusOf(padded.id)).toBe('conflicting');
      expect(await statusOf(touching.id)).toBe('pending');
      expect(await statusOf(otherVenue.id)).toBe('pending');
      expect(await statusOf(ownElsewhere)).toBe('pending');
    });

    it('SCRUM258_AC3_an_approval_with_nothing_overlapping_marks_nothing', async () => {
      const { id } = await pending(await makeVenue());

      expect((await decide(id, 'approve')).marked_conflicting).toEqual([]);
    });

    it('SCRUM258_AC3_rejecting_marks_nothing_and_notifies_no_one_of_a_conflict', async () => {
      const venue = await makeVenue();
      const rejected = await pending(venue);
      const other = await pending(venue);

      const result = await decide(rejected.id, 'reject', 'Closed');

      expect(result.outcome).toBe('rejected');
      expect(result.marked_conflicting).toBeUndefined();
      expect(await statusOf(other.id)).toBe('pending');
      expect(await noticesFor(other.id, 'booking_request_conflicting')).toEqual([]);
    });
  });

  describe('who is told', () => {
    it('SCRUM258_AC3_each_marked_requests_coordinator_is_told_once_which_booking_was_approved', async () => {
      const venue = await makeVenue();
      const approving = await pending(venue);
      const mine = await pending(venue, at('15:00'), at('17:00'));
      const theirs = await pending(venue, at('13:00'), at('15:00'), { assignedTo: otherCoordinator });

      await decide(approving.id, 'approve');

      const [toMine] = await noticesFor(mine.id, 'booking_request_conflicting');
      const [toTheirs, extra] = await noticesFor(theirs.id, 'booking_request_conflicting');
      expect(extra).toBeUndefined();
      expect(toTheirs.recipient_id).toBe(otherCoordinator);
      expect(toMine.recipient_id).toBe(coordinator);
      expect(toTheirs.payload).toMatchObject({
        eventRequestId: theirs.eventId,
        venueId: venue,
        approvedBookingId: approving.id,
        approvedEventRequestId: approving.eventId,
      });
      expect(new Date(toTheirs.payload.startsAt).getTime()).toBe(new Date(at('13:00')).getTime());
      expect(new Date(toTheirs.payload.approvedStartsAt).getTime()).toBe(new Date(at('14:00')).getTime());
      // The approving event's own coordinator hears of the approval, not of a conflict.
      expect(await noticesFor(approving.id, 'booking_request_conflicting')).toEqual([]);
    });

    it('SCRUM258_AC3_a_request_whose_event_has_no_coordinator_is_still_marked_with_no_notice', async () => {
      const venue = await makeVenue();
      const approving = await pending(venue);
      const orphan = await pending(venue, at('15:00'), at('17:00'), { assignedTo: null });

      expect((await decide(approving.id, 'approve')).marked_conflicting).toEqual([orphan.id]);
      expect(await statusOf(orphan.id)).toBe('conflicting');
      expect(await noticesFor(orphan.id, 'booking_request_conflicting')).toEqual([]);
    });

    it('SCRUM258_AC3_an_already_conflicting_request_is_not_marked_or_notified_again', async () => {
      const venue = await makeVenue();
      const { conflicting } = await conflictingBehindApproval(venue);
      // Occupied 13:30-16:45: clear of the 10:00-12:00 approval (to 12:45), over 11:00-13:00 (to 13:45).
      const second = await pending(venue, at('14:00'), at('16:00'));

      const result = await decide(second.id, 'approve');

      expect(result.outcome).toBe('approved');
      expect(result.marked_conflicting).toEqual([]);
      expect(await noticesFor(conflicting.id, 'booking_request_conflicting')).toHaveLength(1);
    });
  });

  describe('conflicting is a flag on an open request', () => {
    it('SCRUM258_AC3_a_conflicting_request_never_occupies_the_venue', async () => {
      const venue = await makeVenue();
      const flagged = await pending(venue, at('14:00'), at('16:00'));
      await db.query("update bookings set status = 'conflicting' where id = $1", [flagged.id]);

      const occupants = await rows('select * from venue_occupancy_conflicts($1, $2, $3, true, null)', [
        venue,
        at('14:00'),
        at('16:00'),
      ]);
      const later = await makeEvent({ start: at('15:00'), end: at('17:00') });
      const { result } = await one(
        'select create_booking_request($1, $2, $3, null, null, $4::jsonb, false, 150) as result',
        [later, venue, coordinator, JSON.stringify(SUITABLE)],
      );
      const third = await pending(venue, at('13:00'), at('15:00'));

      expect(occupants).toEqual([]);
      expect(result.outcome).toBe('created');
      expect((await decide(third.id, 'approve')).outcome).toBe('approved');
    });

    it('SCRUM258_AC3_a_conflicting_request_stays_in_the_queue_with_its_status_and_in_others_overlaps', async () => {
      const venue = await makeVenue();
      const { approved, conflicting } = await conflictingBehindApproval(venue);
      // Occupied 13:30-15:45: over the conflicting one (to 13:45), clear of the approval (to 12:45).
      const newcomer = await pending(venue, at('14:00'), at('15:00'));

      const { queue } = await one('select list_pending_booking_requests($1) as queue', [staff]);
      const byId = new Map(queue.map((item) => [item.id, item]));

      expect(byId.has(approved.id)).toBe(false);
      expect(byId.get(conflicting.id)?.status).toBe('conflicting');
      expect(byId.get(newcomer.id)?.status).toBe('pending');
      expect(byId.get(newcomer.id).overlapping.map((o) => o.id)).toEqual([conflicting.id]);
    });

    it('SCRUM258_AC3_a_conflicting_request_can_be_rejected', async () => {
      const { conflicting } = await conflictingBehindApproval(await makeVenue());

      const result = await decide(conflicting.id, 'reject', 'Already booked');

      expect(result.outcome).toBe('rejected');
      expect(result.booking).toMatchObject({ status: 'rejected', decided_by: staff });
      expect(await noticesFor(conflicting.id, 'booking_request_rejected')).toHaveLength(1);
    });

    it('SCRUM258_AC3_a_conflicting_request_cannot_be_approved_while_the_approved_clash_stands', async () => {
      const { approved, conflicting } = await conflictingBehindApproval(await makeVenue());

      const result = await decide(conflicting.id, 'approve');

      expect(result.outcome).toBe('conflict');
      expect(result.conflicts.map((c) => [c.kind, c.booking_id])).toEqual([['booking', approved.id]]);
      expect(await statusOf(conflicting.id)).toBe('conflicting');
    });

    it('SCRUM258_AC3_a_conflicting_request_stays_flagged_and_becomes_approvable_once_the_clash_is_gone', async () => {
      const { approved, conflicting } = await conflictingBehindApproval(await makeVenue());
      await db.query("update bookings set status = 'cancelled' where id = $1", [approved.id]);

      // Never reverts by itself: the Coordinator or Venue Staff decide.
      expect(await statusOf(conflicting.id)).toBe('conflicting');
      expect((await decide(conflicting.id, 'approve')).outcome).toBe('approved');
      expect(await statusOf(conflicting.id)).toBe('approved');
    });

    it('SCRUM258_AC3_the_coordinator_can_withdraw_a_conflicting_request_and_venue_staff_are_told', async () => {
      const { conflicting } = await conflictingBehindApproval(await makeVenue());

      const { result } = await one('select withdraw_booking_request($1, $2) as result', [conflicting.id, coordinator]);

      expect(result.outcome).toBe('withdrawn');
      expect(await statusOf(conflicting.id)).toBe('withdrawn');
      expect((await noticesFor(conflicting.id, 'booking_request_withdrawn')).map((n) => n.recipient_id)).toEqual([staff]);
    });

    it('SCRUM258_AC3_a_conflicting_request_is_still_the_events_live_request_at_that_venue', async () => {
      const venue = await makeVenue();
      const { conflicting } = await conflictingBehindApproval(venue);

      const err = await refusal(
        db.query('select create_booking_request($1, $2, $3, null, null, $4::jsonb, false, 150)', [
          conflicting.eventId,
          venue,
          coordinator,
          JSON.stringify(SUITABLE),
        ]),
      );

      expect(err?.code).toBe('PT409');
      expect(err?.hint).toBe('BOOKING_REQUEST_EXISTS');
      expect(err?.detail).toBe(conflicting.id);
    });

    it('SCRUM258_AC3_a_decided_request_can_never_be_conflicting', async () => {
      const { approved } = await conflictingBehindApproval(await makeVenue());

      const err = await refusal(db.query("update bookings set status = 'conflicting' where id = $1", [approved.id]));

      expect(err?.code).toBe('23514');
    });
  });

  describe('what the queue says a conflicting request clashes with', () => {
    const queueItem = async (id) => {
      const { queue } = await one('select list_pending_booking_requests($1) as queue', [staff]);
      return queue.find((item) => item.id === id);
    };
    const ms = (value) => new Date(value).getTime();

    it('SCRUM258_AC3_a_conflicting_item_names_the_approved_event_and_its_period', async () => {
      const { approved, conflicting } = await conflictingBehindApproval(await makeVenue());
      const approvedName = (await one('select event_name from event_requests where id = $1', [approved.eventId]))
        .event_name;

      const [clash, extra] = (await queueItem(conflicting.id)).conflicting_with;

      expect(extra).toBeUndefined();
      expect(clash).toMatchObject({
        booking_id: approved.id,
        event_request_id: approved.eventId,
        event_name: approvedName,
      });
      expect(ms(clash.starts_at)).toBe(ms(at('10:00')));
      expect(ms(clash.ends_at)).toBe(ms(at('12:00')));
      // Padded by the venue's 30 minutes' setup and 45 minutes' turnaround.
      expect(ms(clash.occupied_starts_at)).toBe(ms(at('09:30')));
      expect(ms(clash.occupied_ends_at)).toBe(ms(at('12:45')));
    });

    it('SCRUM258_AC3_a_flagged_for_review_booking_is_still_named_as_it_still_holds_the_venue', async () => {
      const { approved, conflicting } = await conflictingBehindApproval(await makeVenue());
      await db.query("update bookings set status = 'flagged_for_review' where id = $1", [approved.id]);

      const item = await queueItem(conflicting.id);

      expect(item.conflicting_with.map((c) => c.booking_id)).toEqual([approved.id]);
    });

    it('SCRUM258_AC3_once_the_approved_booking_is_cancelled_the_item_names_nothing_but_stays_conflicting', async () => {
      const { approved, conflicting } = await conflictingBehindApproval(await makeVenue());
      await db.query("update bookings set status = 'cancelled' where id = $1", [approved.id]);

      const item = await queueItem(conflicting.id);

      expect(item.status).toBe('conflicting');
      expect(item.conflicting_with).toEqual([]);
    });

    it('SCRUM258_AC3_a_pending_item_names_nothing_even_beside_an_approved_booking', async () => {
      const venue = await makeVenue();
      await conflictingBehindApproval(venue);
      // Overlaps the approval but arrived after it, so nothing marked it.
      const later = await pending(venue, at('11:30'), at('12:30'));
      expect(await statusOf(later.id)).toBe('pending');

      expect((await queueItem(later.id)).conflicting_with).toEqual([]);
    });

    it('SCRUM258_AC3_a_block_or_another_events_hold_over_a_conflicting_item_is_not_named', async () => {
      const venue = await makeVenue();
      const { approved, conflicting } = await conflictingBehindApproval(venue);
      // Both over the conflicting request's 10:30-13:45, and clear of the approval's 09:30-12:45.
      await db.query(
        "insert into venue_blocks (venue_id, starts_at, ends_at, reason) values ($1, $2, $3, 'maintenance')",
        [venue, at('12:50'), at('13:10')],
      );
      const holder = await makeEvent({ start: at('13:30'), end: at('14:00') });
      await db.query(
        `insert into venue_holds (event_request_id, venue_id, placed_by, expires_at)
         values ($1, $2, $3, now() + interval '1 day')`,
        [holder, venue, staff],
      );

      const occupants = await rows('select kind from venue_occupancy_conflicts($1, $2, $3, true, $4)', [
        venue,
        at('11:00'),
        at('13:00'),
        conflicting.eventId,
      ]);
      const item = await queueItem(conflicting.id);

      // Both do occupy that period, so leaving them out is the filter's doing.
      expect(occupants.map((o) => o.kind).sort()).toEqual(['block', 'booking', 'hold']);
      expect(item.conflicting_with.map((c) => c.booking_id)).toEqual([approved.id]);
    });
  });

  describe('the shared surfaces 066 sets', () => {
    // A later story restating the list from an older migration would drop the
    // decision types; the list that wins is the highest-numbered one.
    it('SCRUM258_AC3_the_latest_notification_list_keeps_the_decision_types', () => {
      const setters = readdirSync(MIGRATIONS_DIR)
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .filter((name) => migration(name).includes('add constraint notifications_type_known'));
      const latest = notificationTypes(migration(setters.at(-1)));

      expect(setters).toContain(MIGRATION_066);
      expect(latest).toEqual(
        expect.arrayContaining(['booking_request_approved', 'booking_request_rejected', 'booking_request_conflicting']),
      );
    });

    it('SCRUM258_AC3_a_conflicting_notice_must_name_its_booking', async () => {
      const err = await refusal(
        db.query("insert into notifications (recipient_id, type) values ($1, 'booking_request_conflicting')", [coordinator]),
      );

      expect(err?.code).toBe('23514');
    });

    // The queue and the marking must agree on what overlaps, so both ask one function.
    it('SCRUM258_Week7_approval_marks_through_pending_request_overlaps', () => {
      const body = functionBody(MIGRATION_066, 'decide_booking_request');
      const marking = body.slice(body.indexOf("set status = 'conflicting'") - 600);

      expect(marking).toMatch(/pending_request_overlaps\s*\(/);
    });
  });
});
