/**
 * A coordinator lists their event's flagged bookings and requests a venue to
 * replace one; approving that request resolves the flag (078), against a real
 * Postgres.
 *
 * SCRUM-266 AC1 for the coordinator's list (list_event_flagged_bookings), and
 * Week 7 for replacing (create_booking_request's p_replaces_booking_id,
 * decide_booking_request's step 14 and the 'replaced' resolution it records).
 *
 * Migrations: listFlaggedBookingsDatabase.test.js's stack, the same stand-ins.
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
const MIGRATION_078 = '078_list_flagged_bookings.sql';

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
  MIGRATION_078,
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

const NO_SUCH_ID = '00000000-0000-4000-8000-000000000000';

/** The error a promise rejected with; null if it resolved. */
const refusal = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
};

describe('SCRUM-266: a coordinator lists and replaces flagged bookings (078)', () => {
  let db;
  let organiser;
  let coordinator;
  let otherCoordinator;
  let staff;
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

  async function makeEvent({ assigned } = {}) {
    counter += 1;
    return (
      await one(
        `insert into event_requests
           (organiser_id, event_name, status, proposed_start, proposed_end,
            expected_attendance, submitted_at, assigned_coordinator_id)
         values ($1, $2, 'approved', $3, $4, 150, now(), $5) returning id`,
        [organiser, `Event ${counter}`, at('14:00'), at('16:00'), assigned ?? coordinator],
      )
    ).id;
  }

  /** create_booking_request as the API calls it, optionally naming a booking it replaces. */
  const request = async (eventId, venueId, replacesId = null, caller = coordinator) =>
    (
      await one(
        `select create_booking_request($1, $2, $3, null, null, '{"suitable": true}'::jsonb, false, 100, $4)
           as result`,
        [eventId, venueId, caller, replacesId],
      )
    ).result;

  const decide = async (bookingId, decision = 'approve', reason = null) =>
    (
      await one('select decide_booking_request($1, $2, $3, $4, null) as result', [
        bookingId,
        staff,
        decision,
        reason,
      ])
    ).result;

  /** An approved booking at a fresh venue, flagged with a reason (as 034 and 071 flag them). */
  async function flagged(eventId, reviewReason = 'setup_or_turnaround_changed') {
    const venueId = await makeVenue();
    const created = await request(eventId, venueId);
    expect((await decide(created.booking.id)).outcome).toBe('approved');
    await db.query(
      `update bookings
          set status = 'flagged_for_review', review_reason = $2, flagged_at = now(), flagged_by = $3
        where id = $1`,
      [created.booking.id, reviewReason, staff],
    );
    return created.booking.id;
  }

  const listForEvent = async (eventId, caller = coordinator) =>
    (await one('select list_event_flagged_bookings($1, $2) as result', [caller, eventId])).result;

  const bookingRow = (id) => one('select * from bookings where id = $1', [id]);
  const noticesFor = async (bookingId) =>
    (
      await db.query(
        `select recipient_id, payload from notifications
          where booking_id = $1 and type = 'flagged_booking_resolved'
          order by payload->>'audience'`,
        [bookingId],
      )
    ).rows;
  const resolutionsOf = async (id) =>
    (await db.query('select * from booking_resolutions where booking_id = $1 order by created_at', [id])).rows;

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
    otherCoordinator = await makeUser('c2@x', 'event_coordinator');
    staff = await makeUser('s@x', 'venue_staff');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('AC1: the coordinator lists one event\'s flagged bookings', () => {
    it('SCRUM266_AC1_only_this_events_flagged_bookings_in_the_venue_staff_shape', async () => {
      const event = await makeEvent();
      const isFlagged = await flagged(event);
      const approved = (await request(event, await makeVenue())).booking.id;
      await decide(approved);
      await flagged(await makeEvent());

      const listed = await listForEvent(event);

      expect(listed.map((row) => row.id)).toEqual([isFlagged]);
      const staffView = (await one('select list_flagged_bookings($1) as result', [staff])).result.find(
        (row) => row.id === isFlagged,
      );
      expect(listed[0]).toEqual(staffView);
    });

    it('SCRUM266_AC1_an_event_with_nothing_flagged_is_an_empty_array', async () => {
      expect(await listForEvent(await makeEvent())).toEqual([]);
    });

    it.each([
      ['another coordinator', () => otherCoordinator],
      ['Venue Staff', () => staff],
      ['the organiser', () => organiser],
      ['a null caller', () => null],
    ])('SCRUM266_AC1_%s_is_refused_with_42501', async (_label, caller) => {
      const event = await makeEvent();
      await flagged(event);

      expect((await refusal(listForEvent(event, caller())))?.code).toBe('42501');
    });

    it('SCRUM266_AC1_an_unknown_event_is_P0002', async () => {
      expect((await refusal(listForEvent(NO_SUCH_ID)))?.code).toBe('P0002');
    });

    it('SCRUM266_AC1_the_function_is_not_granted_to_anon_or_authenticated', async () => {
      const grants = await one(
        `select has_function_privilege('anon', 'list_event_flagged_bookings(uuid, uuid)', 'execute') as anon,
                has_function_privilege('authenticated', 'list_event_flagged_bookings(uuid, uuid)', 'execute')
                  as authenticated`,
      );
      expect(grants).toEqual({ anon: false, authenticated: false });
    });
  });

  describe('W7: each flagged booking lists the live requests replacing it', () => {
    it('SCRUM266_W7_pending_and_conflicting_replacements_are_listed_oldest_first', async () => {
      const event = await makeEvent();
      const isFlagged = await flagged(event);
      const otherFlagged = await flagged(event);
      const venueA = await makeVenue();
      const first = (await request(event, venueA, isFlagged)).booking;
      const second = (await request(event, await makeVenue(), isFlagged)).booking;
      await db.query(`update bookings set status = 'conflicting' where id = $1`, [second.id]);
      // Spelled out, so the order tested is created_at's and not the id tiebreak.
      await db.query(`update bookings set created_at = now() - interval '2 minutes' where id = $1`, [first.id]);
      await db.query(`update bookings set created_at = now() - interval '1 minute' where id = $1`, [second.id]);
      first.created_at = (await bookingRow(first.id)).created_at;
      const rejected = (await request(event, await makeVenue(), isFlagged)).booking.id;
      await decide(rejected, 'reject', 'Not available');
      const forTheOther = (await request(event, await makeVenue(), otherFlagged)).booking.id;

      const listed = await listForEvent(event);
      const row = listed.find((r) => r.id === isFlagged);

      expect(row.replacement_requests.map((r) => r.id)).toEqual([first.id, second.id]);
      expect(row.replacement_requests[0]).toEqual({
        id: first.id,
        venue_id: venueA,
        venue_name: (await one('select name from venues where id = $1', [venueA])).name,
        status: 'pending',
        starts_at: first.starts_at,
        ends_at: first.ends_at,
        created_at: expect.any(String),
      });
      expect(new Date(row.replacement_requests[0].created_at)).toEqual(first.created_at);
      expect(row.replacement_requests[1].status).toBe('conflicting');
      expect(listed.find((r) => r.id === otherFlagged).replacement_requests.map((r) => r.id)).toEqual([
        forTheOther,
      ]);
    });
  });

  describe('W7: Venue Staff see that a flagged booking is being replaced', () => {
    const staffListed = async (bookingId) =>
      (await one('select list_flagged_bookings($1) as result', [staff])).result.find((row) => row.id === bookingId);
    const queued = async (bookingId) =>
      (await one('select list_pending_booking_requests($1) as result', [staff])).result.find(
        (row) => row.id === bookingId,
      );

    it('SCRUM266_W7_venue_staff_list_carries_a_live_replacement_and_drops_a_rejected_or_withdrawn_one', async () => {
      const event = await makeEvent();
      const isFlagged = await flagged(event);
      const rejected = (await request(event, await makeVenue(), isFlagged)).booking.id;
      await decide(rejected, 'reject', 'Not available');
      const withdrawn = (await request(event, await makeVenue(), isFlagged)).booking.id;
      await one('select withdraw_booking_request($1, $2)', [withdrawn, coordinator]);
      const live = (await request(event, await makeVenue(), isFlagged)).booking.id;

      const row = await staffListed(isFlagged);

      expect(row.replacement_requests.map((r) => r.id)).toEqual([live]);
      expect(row.replacement_requests).toEqual((await listForEvent(event))[0].replacement_requests);
    });

    it('SCRUM266_W7_the_queue_names_the_still_flagged_booking_a_request_replaces', async () => {
      const event = await makeEvent();
      const isFlagged = await flagged(event);
      const flaggedBooking = await bookingRow(isFlagged);
      const venue = await one('select v.name from venues v where v.id = $1', [flaggedBooking.venue_id]);
      const replacement = (await request(event, await makeVenue(), isFlagged)).booking.id;
      const ordinary = (await request(await makeEvent(), await makeVenue())).booking.id;

      const row = await queued(replacement);

      expect(row.replaces).toEqual({
        booking_id: isFlagged,
        venue_name: venue.name,
        starts_at: expect.any(String),
        ends_at: expect.any(String),
      });
      expect(new Date(row.replaces.starts_at)).toEqual(flaggedBooking.starts_at);
      expect(new Date(row.replaces.ends_at)).toEqual(flaggedBooking.ends_at);
      expect((await queued(ordinary)).replaces).toBeNull();
    });

    it.each([
      ['reinstated', () => ['select reinstate_flagged_booking($1, $2, $3)', staff, 'Block moved']],
      ['cancelled', () => ['select cancel_flagged_booking($1, $2, $3)', coordinator, 'Not needed']],
    ])('SCRUM266_W7_once_the_flagged_booking_is_%s_the_queue_shows_no_replaces', async (_label, resolve) => {
      const event = await makeEvent();
      const isFlagged = await flagged(event);
      const replacement = (await request(event, await makeVenue(), isFlagged)).booking.id;
      const [sql, caller, reason] = resolve();
      await one(sql, [isFlagged, caller, reason]);

      const row = await queued(replacement);

      expect(row.status).toBe('pending');
      expect(row.replaces).toBeNull();
    });
  });

  describe('W7: a booking request names the flagged booking it replaces', () => {
    it('SCRUM266_W7_a_request_replacing_this_events_flagged_booking_is_created_and_records_it', async () => {
      const event = await makeEvent();
      const isFlagged = await flagged(event);

      const result = await request(event, await makeVenue(), isFlagged);

      expect(result.outcome).toBe('created');
      expect(result.booking.replaces_booking_id).toBe(isFlagged);
      expect((await bookingRow(result.booking.id)).replaces_booking_id).toBe(isFlagged);
    });

    it('SCRUM266_W7_replacing_a_booking_that_is_not_flagged_is_refused', async () => {
      const event = await makeEvent();
      const approved = (await request(event, await makeVenue())).booking.id;
      await decide(approved);

      const err = await refusal(request(event, await makeVenue(), approved));

      expect(err?.code).toBe('PT409');
      expect(err?.hint).toBe('REPLACED_BOOKING_NOT_FLAGGED');
    });

    it.each([
      ['another event\'s flagged booking', async () => flagged(await makeEvent())],
      ['a booking that does not exist', async () => NO_SUCH_ID],
    ])('SCRUM266_W7_replacing_%s_is_refused', async (_label, make) => {
      const replaces = await make();

      const err = await refusal(request(await makeEvent(), await makeVenue(), replaces));

      expect(err?.code).toBe('PT409');
      expect(err?.hint).toBe('REPLACED_BOOKING_NOT_ON_EVENT');
    });

    it('SCRUM266_W7_a_refused_replacement_writes_nothing', async () => {
      const event = await makeEvent();
      const venue = await makeVenue();
      await refusal(request(event, venue, NO_SUCH_ID));

      const { count } = await one(
        'select count(*)::int as count from bookings where event_request_id = $1 and venue_id = $2',
        [event, venue],
      );
      expect(count).toBe(0);
    });
  });

  describe('W7: approving the replacement resolves the flag', () => {
    it('SCRUM266_W7_approving_cancels_the_flagged_booking_and_records_a_replaced_resolution', async () => {
      const event = await makeEvent();
      const isFlagged = await flagged(event);
      const before = await bookingRow(isFlagged);
      const replacement = (await request(event, await makeVenue(), isFlagged)).booking.id;

      const result = await decide(replacement);

      expect(result.outcome).toBe('approved');
      expect(result.replaced_booking_id).toBe(isFlagged);
      expect((await bookingRow(replacement)).status).toBe('approved');
      const after = await bookingRow(isFlagged);
      expect(after.status).toBe('cancelled');
      // The flag stays on the cancelled booking, as 077 leaves it.
      expect(after.review_reason).toBe(before.review_reason);
      const resolutions = await resolutionsOf(isFlagged);
      expect(resolutions).toHaveLength(1);
      expect(resolutions[0]).toMatchObject({
        outcome: 'replaced',
        replacement_booking_id: replacement,
        resolved_by: staff,
        reason: 'Replaced by an approved booking',
        review_reason: before.review_reason,
        flagged_by: before.flagged_by,
      });
      expect(resolutions[0].flagged_at).toEqual(before.flagged_at);
    });

    it('SCRUM266_W7_approving_a_replacement_tells_the_coordinator_both_bookings', async () => {
      const event = await makeEvent();
      const isFlagged = await flagged(event);
      const flaggedRow = await bookingRow(isFlagged);
      const newVenue = await makeVenue();
      const replacement = (await request(event, newVenue, isFlagged)).booking.id;

      await decide(replacement);

      const [resolution] = await resolutionsOf(isFlagged);
      const replacementRow = await bookingRow(replacement);
      const venueName = async (id) => (await one('select name from venues where id = $1', [id])).name;
      const notices = await noticesFor(isFlagged);
      expect(notices).toEqual([
        {
          recipient_id: coordinator,
          payload: {
            audience: 'coordinator',
            outcome: 'replaced',
            eventRequestId: event,
            eventName: (await one('select event_name from event_requests where id = $1', [event])).event_name,
            venueId: flaggedRow.venue_id,
            venueName: await venueName(flaggedRow.venue_id),
            startsAt: expect.any(String),
            endsAt: expect.any(String),
            reason: 'Replaced by an approved booking',
            resolvedAt: expect.any(String),
            resolvedByRole: 'venue_staff',
            replacementBookingId: replacement,
            replacementVenueName: await venueName(newVenue),
            replacementStartsAt: expect.any(String),
            replacementEndsAt: expect.any(String),
          },
        },
      ]);
      const { payload } = notices[0];
      expect(payload.reason).toBe(resolution.reason);
      expect(new Date(payload.resolvedAt)).toEqual(resolution.created_at);
      expect(new Date(payload.startsAt)).toEqual(flaggedRow.starts_at);
      expect(new Date(payload.replacementStartsAt)).toEqual(replacementRow.starts_at);
      expect(new Date(payload.replacementEndsAt)).toEqual(replacementRow.ends_at);
    });

    it('SCRUM266_W7_a_confirmed_events_organiser_is_told_of_the_replacement_too', async () => {
      const event = await makeEvent();
      const isFlagged = await flagged(event);
      const replacement = (await request(event, await makeVenue(), isFlagged)).booking.id;
      await db.query(`update event_requests set status = 'confirmed' where id = $1`, [event]);

      await decide(replacement);

      const notices = await noticesFor(isFlagged);
      expect(notices.map((n) => [n.payload.audience, n.recipient_id])).toEqual([
        ['coordinator', coordinator],
        ['organiser', organiser],
      ]);
      expect(notices[1].payload).toEqual({ ...notices[0].payload, audience: 'organiser' });
    });

    it('SCRUM266_W7_a_safety_flag_is_replaced_too', async () => {
      const event = await makeEvent();
      const isFlagged = await flagged(event, 'safety_review');
      const replacement = (await request(event, await makeVenue(), isFlagged)).booking.id;

      await decide(replacement);

      expect((await bookingRow(isFlagged)).status).toBe('cancelled');
      expect((await resolutionsOf(isFlagged)).map((r) => r.outcome)).toEqual(['replaced']);
    });

    it('SCRUM266_W7_approving_after_the_flag_was_reinstated_changes_nothing_else', async () => {
      const event = await makeEvent();
      const isFlagged = await flagged(event);
      const replacement = (await request(event, await makeVenue(), isFlagged)).booking.id;
      await one('select reinstate_flagged_booking($1, $2, $3)', [isFlagged, staff, 'Block moved']);

      const result = await decide(replacement);

      expect(result.outcome).toBe('approved');
      expect(result.replaced_booking_id).toBeNull();
      expect((await bookingRow(isFlagged)).status).toBe('approved');
      expect((await resolutionsOf(isFlagged)).map((r) => r.outcome)).toEqual(['reinstated']);
      // Only the reinstatement was announced; approving the stale replacement adds nothing.
      expect((await noticesFor(isFlagged)).map((n) => n.payload.outcome)).toEqual(['reinstated']);
    });

    it('SCRUM266_W7_approving_after_the_flag_was_cancelled_changes_nothing_else', async () => {
      const event = await makeEvent();
      const isFlagged = await flagged(event);
      const replacement = (await request(event, await makeVenue(), isFlagged)).booking.id;
      await one('select cancel_flagged_booking($1, $2, $3)', [isFlagged, coordinator, 'Not needed']);

      const result = await decide(replacement);

      expect(result.outcome).toBe('approved');
      expect((await bookingRow(isFlagged)).status).toBe('cancelled');
      expect((await resolutionsOf(isFlagged)).map((r) => r.outcome)).toEqual(['cancelled']);
      // The coordinator cancelled it, so nobody was told, and approving adds nothing.
      expect(await noticesFor(isFlagged)).toEqual([]);
    });

    it('SCRUM266_W7_rejecting_the_replacement_leaves_the_flag', async () => {
      const event = await makeEvent();
      const isFlagged = await flagged(event);
      const replacement = (await request(event, await makeVenue(), isFlagged)).booking.id;

      expect((await decide(replacement, 'reject', 'Not available')).outcome).toBe('rejected');

      expect((await bookingRow(isFlagged)).status).toBe('flagged_for_review');
      expect(await resolutionsOf(isFlagged)).toEqual([]);
      expect(await noticesFor(isFlagged)).toEqual([]);
    });

    it('SCRUM266_W7_replacing_one_booking_leaves_the_events_other_bookings_and_status_alone', async () => {
      const event = await makeEvent();
      const replaced = await flagged(event);
      const otherFlagged = await flagged(event);
      const otherApproved = (await request(event, await makeVenue())).booking.id;
      expect((await decide(otherApproved)).outcome).toBe('approved');
      const flaggedBefore = await bookingRow(otherFlagged);
      const approvedBefore = await bookingRow(otherApproved);
      const eventBefore = await one('select status, updated_at from event_requests where id = $1', [event]);
      const replacement = (await request(event, await makeVenue(), replaced)).booking.id;

      expect((await decide(replacement)).replaced_booking_id).toBe(replaced);

      expect((await bookingRow(replaced)).status).toBe('cancelled');
      expect(await bookingRow(otherFlagged)).toEqual(flaggedBefore);
      expect(await bookingRow(otherApproved)).toEqual(approvedBefore);
      expect(await resolutionsOf(otherFlagged)).toEqual([]);
      expect(await resolutionsOf(otherApproved)).toEqual([]);
      expect(await one('select status, updated_at from event_requests where id = $1', [event])).toEqual(eventBefore);
      expect((await listForEvent(event)).map((b) => b.id)).toEqual([otherFlagged]);
    });

    it('SCRUM266_W7_once_replaced_the_booking_drops_off_the_coordinators_list', async () => {
      const event = await makeEvent();
      const isFlagged = await flagged(event);
      const replacement = (await request(event, await makeVenue(), isFlagged)).booking.id;

      await decide(replacement);

      expect(await listForEvent(event)).toEqual([]);
    });
  });

  describe('the migration is re-runnable', () => {
    it('SCRUM266_W7_running_078_again_keeps_one_of_each_function_and_the_column', async () => {
      const event = await makeEvent();
      const isFlagged = await flagged(event);
      const replacement = (await request(event, await makeVenue(), isFlagged)).booking.id;

      await db.exec(migration(MIGRATION_078));
      await db.exec(migration(MIGRATION_078));

      const fns = await one(
        `select count(*) filter (where proname = 'create_booking_request')::int as create,
                count(*) filter (where proname = 'list_pending_booking_requests')::int as queue
           from pg_proc`,
      );
      expect(fns).toEqual({ create: 1, queue: 1 });
      expect((await bookingRow(replacement)).replaces_booking_id).toBe(isFlagged);
      const grants = await one(
        `select has_function_privilege('anon',
                  'create_booking_request(uuid, uuid, uuid, text, text, jsonb, boolean, integer, uuid)',
                  'execute') as anon,
                has_function_privilege('anon', 'flagged_bookings_json(uuid)', 'execute') as helper,
                has_function_privilege('anon', 'list_pending_booking_requests(uuid)', 'execute') as queue`,
      );
      expect(grants).toEqual({ anon: false, helper: false, queue: false });
    });
  });
});
