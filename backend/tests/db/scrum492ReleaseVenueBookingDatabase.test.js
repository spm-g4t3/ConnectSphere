/**
 * SCRUM-492 (SCRUM-564 to SCRUM-566): migrations 088 and 089 on a real Postgres
 * (PGlite). The coordinator releases one approved venue booking; the event and
 * its other bookings are untouched; other events' requests the release alone
 * made Conflicting go back to Pending. Cases: docs/test-cases/SCRUM-492.md.
 *
 * Migrations: cancelFlaggedBookingDatabase.test.js's stack (077 for AC8's
 * proof that a flag is still cancelled through SCRUM-266), plus 039 for the
 * Lead's role, 052's
 * profile_display_name (read from the file, not retyped), 078 for the latest
 * create and decide functions, then 088 on its own and 089.
 *
 * Dates: D is the Singapore date 10 days from now, because a block or hold
 * counts only while it has not ended.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name) => readFileSync(resolve(here, '../../db/migrations', name), 'utf8');
const MIGRATION_088 = '088_booking_released_status.sql';
const MIGRATION_089 = '089_release_venue_booking.sql';

const MIGRATIONS = [
  '001_event_requests.sql',
  '005_event_request_details.sql',
  '007_user_roles.sql',
  '039_coordinator_lead_and_safety_officer_roles.sql',
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
  'DISPLAY_NAME',
  '065_booking_decision_statuses.sql',
  'SAFETY_ENUM',
  '066_venue_staff_booking_decisions.sql',
  'SAFETY_REASON',
  '076_reinstate_flagged_booking.sql',
  '077_cancel_flagged_booking.sql',
  '078_list_flagged_bookings.sql',
  'LIVE_ONLY_TYPE',
  MIGRATION_088,
  MIGRATION_089,
];

/** What 014 reads from SCRUM-19's migration, which this stack leaves out. */
const DECISION_STAND_IN = `
  alter table event_requests
    add column if not exists reviewing_coordinator_id uuid references auth.users (id);
`;

/** 052's profile_display_name, cut from the file: the rest of 052 needs the lifecycle. */
const DISPLAY_NAME = migration('052_lead_assignment.sql').match(
  /create or replace function profile_display_name[\s\S]*?\n\$\$;/,
)[0];

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

/**
 * A type the live database has and no dev migration adds (SCRUM-174's, applied
 * live from an unmerged branch), so AC6-06 can prove 089 keeps it.
 */
const LIVE_ONLY_TYPE = `
  do $$
  declare v_def text;
  begin
    select pg_get_constraintdef(oid) into v_def from pg_constraint where conname = 'notifications_type_known';
    alter table notifications drop constraint notifications_type_known;
    execute 'alter table notifications add constraint notifications_type_known '
            || replace(v_def, '''flagged_booking_resolved''', '''flagged_booking_resolved'', ''booking_request_submitted''');
  end;
  $$;
`;

const STAND_INS = { STAND_IN: DECISION_STAND_IN, DISPLAY_NAME, SAFETY_ENUM, SAFETY_REASON, LIVE_ONLY_TYPE };

/** D: the Singapore date 10 days from now, as YYYY-MM-DD. */
const D = new Date(Date.now() + 8 * 3600_000 + 10 * 86_400_000).toISOString().slice(0, 10);
/** An instant on D, written at +08:00 (Singapore). */
const at = (hhmm) => `${D}T${hhmm}:00+08:00`;

const NO_ONE = '00000000-0000-4000-8000-000000000000';
const REASON = 'Moving the workshop to Hall B';

const refusal = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
};

describe('SCRUM-492: releasing one venue booking (088, 089)', () => {
  let db;
  let organiser;
  let coordinator;
  let otherCoordinator;
  let lead;
  let staff;
  let staff2;
  let counter = 0;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const rows = async (sql, params) => (await db.query(sql, params)).rows;

  async function makeUser(email, role, fullName = null) {
    const id = (await one('insert into auth.users (email) values ($1) returning id', [email])).id;
    if (role) await db.query('insert into profiles (id, role, full_name) values ($1, $2, $3)', [id, role, fullName]);
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

  async function makeEvent({ status = 'approved', start = at('13:00'), end = at('14:00'), assigned } = {}) {
    counter += 1;
    return (
      await one(
        `insert into event_requests
           (organiser_id, event_name, status, proposed_start, proposed_end,
            expected_attendance, submitted_at, assigned_coordinator_id)
         values ($1, $2, $3, $4, $5, 150, now(), $6) returning id`,
        [organiser, `Event ${counter}`, status, start, end, assigned === undefined ? coordinator : assigned],
      )
    ).id;
  }

  /**
   * A booking for the event's own period, written directly, as a pending
   * request unless told otherwise. Approval refuses any other period (078).
   */
  async function insertBooking(eventId, venueId, { status = 'pending' } = {}) {
    return (
      await one(
        `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
         select $1, id, proposed_start, proposed_end, $3::booking_status
           from event_requests where id = $2 returning id`,
        [venueId, eventId, status],
      )
    ).id;
  }

  const decide = async (bookingId) =>
    (await one("select decide_booking_request($1, $2, 'approve', null, null) as result", [bookingId, staff])).result;

  /** A request approved by Venue Staff, so its decision is recorded. */
  async function approved(venueId, eventId) {
    const id = await insertBooking(eventId, venueId);
    expect((await decide(id)).outcome).toBe('approved');
    return id;
  }

  const release = async (bookingId, { caller = coordinator, reason = REASON } = {}) =>
    (await one('select release_venue_booking($1, $2, $3) as result', [bookingId, caller, reason])).result;

  const bookingRow = (id) => one('select * from bookings where id = $1', [id]);
  const eventRow = (id) => one('select * from event_requests where id = $1', [id]);
  const statusOf = async (id) => (await bookingRow(id)).status;
  const noticeCount = async () => Number((await one('select count(*) as n from notifications')).n);
  const noticesAbout = (bookingId, type) =>
    rows('select recipient_id, payload from notifications where booking_id = $1 and type = $2 order by recipient_id', [bookingId, type]);

  /** Everything a refusal must leave as it was. */
  async function snapshot(eventId) {
    return {
      event: await eventRow(eventId),
      bookings: await rows('select * from bookings where event_request_id = $1 order by id', [eventId]),
      notices: await noticeCount(),
    };
  }

  beforeAll(async () => {
    db = new PGlite({ extensions: { btree_gist } });
    await db.exec(`
      create schema auth;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text);
      create role anon;
      create role authenticated;
    `);
    // 088 is its own exec, as it is its own execution in Supabase.
    for (const name of MIGRATIONS) await db.exec(STAND_INS[name] ?? migration(name));

    organiser = await makeUser('o@x', 'event_organiser', 'Olive Organiser');
    coordinator = await makeUser('c@x', 'event_coordinator', 'Priya Nair');
    otherCoordinator = await makeUser('c2@x', 'event_coordinator', 'Omar Okafor');
    lead = await makeUser('l@x', 'event_coordinator_lead', 'Lena Lead');
    staff = await makeUser('s@x', 'venue_staff', 'Sam Staff');
    staff2 = await makeUser('s2@x', 'venue_staff', 'Sol Staff');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });


  // -------------------------------------------------------------------------
  // AC1: who, which event, which booking
  // -------------------------------------------------------------------------
  describe('AC1: only the assigned coordinator, only an Approved event, only an approved booking', () => {
    it('SCRUM492_AC1_the_assigned_coordinator_releases_an_approved_booking', async () => {
      // AC1-01.
      const venue = await makeVenue();
      const id = await approved(venue, await makeEvent());

      const result = await release(id);

      expect(result.outcome).toBe('released');
      expect(result.booking).toMatchObject({ id, status: 'released', released_by: coordinator });
      expect(result.returned_to_pending).toEqual([]);
    });

    it.each([
      ['another_coordinator', () => otherCoordinator],
      ['a_Lead', () => lead],
      ['Venue_Staff', () => staff],
      ['the_organiser', () => organiser],
      ['a_user_with_no_profile', () => NO_ONE],
      ['a_null_caller', () => null],
    ])('SCRUM492_AC1_%s_is_refused_with_42501_and_nothing_is_written', async (_label, caller) => {
      // AC1-02, AC1-10.
      const event = await makeEvent();
      const id = await approved(await makeVenue(), event);
      const before = await snapshot(event);

      const err = await refusal(release(id, { caller: caller() }));

      expect(err?.code).toBe('42501');
      expect(await snapshot(event)).toEqual(before);
    });

    it.each([
      'draft', 'submitted', 'under_review', 'pending_clarification', 'safety_review',
      'safety_approved', 'confirmed', 'completed', 'rejected', 'cancelled',
    ])('SCRUM492_AC1_an_event_that_is_%s_is_refused_with_event_not_approved', async (status) => {
      // AC1-03, AC1-10: the booking is approved while the event is, then the
      // event moves on.
      const event = await makeEvent();
      const id = await approved(await makeVenue(), event);
      // A draft has no submitted_at (005).
      await db.query(
        `update event_requests set status = $2::event_request_status,
                submitted_at = case when $2 = 'draft' then null else submitted_at end
          where id = $1`,
        [event, status],
      );
      const before = await snapshot(event);

      const err = await refusal(release(id));

      expect(err?.code).toBe('PT409');
      expect(err.hint).toBe('EVENT_NOT_APPROVED');
      expect(err.message).toContain(status);
      expect(await snapshot(event)).toEqual(before);
    });

    it('SCRUM492_AC1_a_flagged_booking_is_refused_and_pointed_to_flagged_bookings', async () => {
      // AC1-04, AC8-01.
      const event = await makeEvent();
      const id = await approved(await makeVenue(), event);
      await db.query(
        `update bookings set status = 'flagged_for_review', review_reason = 'safety_review',
                flagged_at = now(), flagged_by = $2 where id = $1`,
        [id, staff],
      );
      const before = await snapshot(event);

      const err = await refusal(release(id));

      expect(err?.code).toBe('PT409');
      expect(err.hint).toBe('BOOKING_NOT_APPROVED');
      expect(err.message).toContain('Flagged bookings');
      expect(await snapshot(event)).toEqual(before);
    });

    it.each(['pending', 'conflicting'])(
      'SCRUM492_AC1_a_%s_request_is_refused_and_pointed_to_withdraw',
      async (status) => {
        // AC1-05, AC8-02.
        const event = await makeEvent();
        const id = await insertBooking(event, await makeVenue(), { status });
        const before = await snapshot(event);

        const err = await refusal(release(id));

        expect(err?.code).toBe('PT409');
        expect(err.hint).toBe('BOOKING_NOT_APPROVED');
        expect(err.message).toContain('withdraw it instead');
        expect(await snapshot(event)).toEqual(before);
      },
    );

    it.each(['released', 'cancelled', 'rejected', 'withdrawn'])(
      'SCRUM492_AC1_a_%s_booking_is_refused_naming_its_status',
      async (status) => {
        // AC1-06.
        const event = await makeEvent();
        const venue = await makeVenue();
        let id;
        if (status === 'released') {
          id = await approved(venue, event);
          await release(id);
        } else if (status === 'cancelled') {
          id = await approved(venue, event);
          await db.query("update bookings set status = 'cancelled' where id = $1", [id]);
        } else {
          id = await insertBooking(event, venue, { status });
        }
        const before = await snapshot(event);

        const err = await refusal(release(id));

        expect(err?.code).toBe('PT409');
        expect(err.hint).toBe('BOOKING_NOT_APPROVED');
        expect(err.message).toContain(`is ${status}`);
        expect(await snapshot(event)).toEqual(before);
      },
    );

    it.each([
      ['null', null],
      ['empty', ''],
      ['only_spaces', '     '],
    ])('SCRUM492_AC1_a_reason_that_is_%s_is_refused_with_22023', async (_label, reason) => {
      // AC1-07, AC1-10. btrim trims spaces, as 077's check does; the service
      // refuses any whitespace-only reason before the rpc.
      const event = await makeEvent();
      const id = await approved(await makeVenue(), event);
      const before = await snapshot(event);

      const err = await refusal(release(id, { reason }));

      expect(err?.code).toBe('22023');
      expect(await snapshot(event)).toEqual(before);
    });

    it('SCRUM492_AC1_a_reason_of_1001_characters_is_refused_with_23514_and_1000_is_accepted', async () => {
      // AC1-08.
      const event = await makeEvent();
      const venue = await makeVenue();
      const first = await approved(venue, event);
      const second = await approved(await makeVenue(), event);
      const before = await snapshot(event);

      const err = await refusal(release(first, { reason: `  ${'x'.repeat(1001)}  ` }));
      expect(err?.code).toBe('23514');
      expect(await snapshot(event)).toEqual(before);

      expect((await release(second, { reason: `  ${'x'.repeat(1000)}  ` })).outcome).toBe('released');
      expect((await bookingRow(second)).release_reason).toHaveLength(1000);
    });

    it('SCRUM492_AC1_an_unknown_booking_is_refused_with_p0002', async () => {
      // AC1-09.
      const before = await noticeCount();

      expect((await refusal(release(NO_ONE)))?.code).toBe('P0002');
      expect(await noticeCount()).toBe(before);
    });
  });


  // -------------------------------------------------------------------------
  // AC2: only this booking changes
  // -------------------------------------------------------------------------
  describe('AC2: the booking becomes Released; the others stay approved', () => {
    it('SCRUM492_AC2_releasing_one_of_three_leaves_the_other_two_unchanged', async () => {
      // AC2-01, AC2-02.
      const event = await makeEvent();
      const [a, b, c] = [
        await approved(await makeVenue(), event),
        await approved(await makeVenue(), event),
        await approved(await makeVenue(), event),
      ];
      const [beforeA, beforeC] = [await bookingRow(a), await bookingRow(c)];
      const beforeB = await bookingRow(b);

      await release(b);

      expect(await bookingRow(a)).toEqual(beforeA);
      expect(await bookingRow(c)).toEqual(beforeC);
      const after = await bookingRow(b);
      expect(after.status).toBe('released');
      expect([after.decided_by, after.decided_at, after.decision_reason])
        .toEqual([beforeB.decided_by, beforeB.decided_at, beforeB.decision_reason]);
    });

    it('SCRUM492_AC2_the_last_approved_booking_can_be_released_and_the_event_stays_approved', async () => {
      // AC2-03, D7.
      const event = await makeEvent();
      const id = await approved(await makeVenue(), event);

      await release(id);

      expect((await eventRow(event)).status).toBe('approved');
      expect(Number((await one(
        "select count(*) as n from bookings where event_request_id = $1 and status::text = 'approved'", [event],
      )).n)).toBe(0);
    });

    it('SCRUM492_AC2_an_undecided_approved_booking_is_released_and_stays_final', async () => {
      // AC2-04, D6: approved with decided_at null, as an approval older than 066 is.
      const event = await makeEvent();
      const id = await insertBooking(event, await makeVenue(), { status: 'approved' });
      expect((await bookingRow(id)).decided_at).toBeNull();

      await release(id);

      expect(await statusOf(id)).toBe('released');
      const err = await refusal(db.query("update bookings set status = 'approved' where id = $1", [id]));
      expect(err?.code).toBe('42501');
      expect(await statusOf(id)).toBe('released');
    });
  });


  // -------------------------------------------------------------------------
  // AC3: the period is free at once
  // -------------------------------------------------------------------------
  it('SCRUM492_AC3_the_released_period_has_no_occupant', async () => {
    // AC3-01, D10: venue_occupancy_conflicts (040) is unchanged.
    const venue = await makeVenue();
    const id = await approved(venue, await makeEvent());
    const occupants = () =>
      rows('select kind, id from venue_occupancy_conflicts($1, $2, $3, true)', [venue, at('13:00'), at('14:00')]);
    expect(await occupants()).toEqual([{ kind: 'booking', id }]);

    await release(id);

    expect(await occupants()).toEqual([]);
  });


  // -------------------------------------------------------------------------
  // AC4: Conflicting requests this release alone blocked go back to Pending
  // -------------------------------------------------------------------------
  describe('AC4: freed Conflicting requests return to Pending', () => {
    /**
     * Venue V; another event's request R for 13:00-17:00 at V; then this
     * event's booking B for 13:00-14:00 at V, approved, which marks R
     * conflicting (078 step 12). With 30/45 minutes, B occupies 12:30-14:45.
     */
    async function conflictingBehind({ assigned } = {}) {
      const venue = await makeVenue();
      const other = await makeEvent({
        start: at('13:00'), end: at('17:00'), assigned: assigned === undefined ? otherCoordinator : assigned,
      });
      const request = await insertBooking(other, venue);
      const releasing = await makeEvent();
      const booking = await approved(venue, releasing);
      expect(await statusOf(request)).toBe('conflicting');
      return { venue, other, request, releasing, booking };
    }

    it('SCRUM492_AC4_a_request_blocked_only_by_the_released_booking_returns_to_pending', async () => {
      // AC4-01.
      const { venue, other, request, releasing, booking } = await conflictingBehind();

      const result = await release(booking);

      expect(result.returned_to_pending).toEqual([request]);
      expect(await statusOf(request)).toBe('pending');
      const notices = await noticesAbout(request, 'booking_request_conflict_cleared');
      expect(notices).toEqual([{
        recipient_id: otherCoordinator,
        payload: {
          eventRequestId: other,
          eventName: (await eventRow(other)).event_name,
          venueId: venue,
          venueName: expect.stringMatching(/^Harbour Room/),
          startsAt: expect.any(String),
          endsAt: expect.any(String),
          releasedBookingId: booking,
          releasedEventName: (await eventRow(releasing)).event_name,
        },
      }]);
    });

    it('SCRUM492_AC4_a_request_still_blocked_by_another_approved_booking_stays_conflicting', async () => {
      // AC4-02: a third event's booking 15:30-17:00 still occupies R's period.
      const { venue, request, booking } = await conflictingBehind();
      await approved(venue, await makeEvent({ start: at('15:30'), end: at('17:00') }));

      const result = await release(booking);

      expect(result.returned_to_pending).toEqual([]);
      expect(await statusOf(request)).toBe('conflicting');
      expect(await noticesAbout(request, 'booking_request_conflict_cleared')).toEqual([]);
    });

    it('SCRUM492_AC4_of_two_requests_only_the_one_nothing_else_blocks_returns_to_pending', async () => {
      // AC4-01 with AC4-02: R1 (13:00-14:00) clashed only with B; R2
      // (13:00-17:00) also with C (15:30-17:00), which occupies 15:00-17:45.
      const venue = await makeVenue();
      const r1 = await insertBooking(await makeEvent({ assigned: otherCoordinator }), venue);
      const r2 = await insertBooking(
        await makeEvent({ start: at('13:00'), end: at('17:00'), assigned: otherCoordinator }),
        venue,
      );
      const booking = await approved(venue, await makeEvent());
      await approved(venue, await makeEvent({ start: at('15:30'), end: at('17:00') }));
      expect([await statusOf(r1), await statusOf(r2)]).toEqual(['conflicting', 'conflicting']);

      const result = await release(booking);

      expect(result.returned_to_pending).toEqual([r1]);
      expect([await statusOf(r1), await statusOf(r2)]).toEqual(['pending', 'conflicting']);
      expect(await noticesAbout(r1, 'booking_request_conflict_cleared')).toHaveLength(1);
      expect(await noticesAbout(r2, 'booking_request_conflict_cleared')).toEqual([]);
    });

    it('SCRUM492_AC4_a_request_still_covered_by_a_block_stays_conflicting', async () => {
      // AC4-03.
      const { venue, request, booking } = await conflictingBehind();
      const { result } = await one(
        "select create_venue_block($1, $2, $3, 'maintenance', null, $4, false, '{}'::uuid[]) as result",
        [venue, at('16:00'), at('17:00'), staff],
      );
      expect(result.outcome).toBe('created');

      expect((await release(booking)).returned_to_pending).toEqual([]);
      expect(await statusOf(request)).toBe('conflicting');
      expect(await noticesAbout(request, 'booking_request_conflict_cleared')).toEqual([]);
    });

    it('SCRUM492_AC4_a_request_still_covered_by_another_events_hold_stays_conflicting', async () => {
      // AC4-04: a third event, 16:00-17:00, holds the venue.
      const { venue, request, booking } = await conflictingBehind();
      const holder = await makeEvent({ start: at('16:00'), end: at('17:00') });
      await db.query(
        "insert into venue_holds (event_request_id, venue_id, placed_by, expires_at) values ($1, $2, $3, now() + interval '2 days')",
        [holder, venue, coordinator],
      );

      expect((await release(booking)).returned_to_pending).toEqual([]);
      expect(await statusOf(request)).toBe('conflicting');
    });

    it.each([
      ['at_a_different_venue', true],
      ['at_the_same_venue_for_a_period_that_does_not_overlap', false],
    ])('SCRUM492_AC4_a_conflicting_request_%s_is_untouched', async (_label, elsewhere) => {
      // AC4-05, AC4-06: R is conflicting with nothing left occupying it (its
      // blocker was cancelled, D11), and is not this release's to free.
      const venue = await makeVenue();
      const requestVenue = elsewhere ? await makeVenue() : venue;
      const period = elsewhere ? { start: at('13:00'), end: at('14:00') } : { start: at('19:00'), end: at('20:00') };
      const request = await insertBooking(await makeEvent({ ...period, assigned: otherCoordinator }), requestVenue);
      const blocker = await approved(requestVenue, await makeEvent(period));
      await db.query("update bookings set status = 'cancelled' where id = $1", [blocker]);
      expect(await statusOf(request)).toBe('conflicting');
      const booking = await approved(venue, await makeEvent());

      expect((await release(booking)).returned_to_pending).toEqual([]);
      expect(await statusOf(request)).toBe('conflicting');
    });

    it('SCRUM492_AC4_a_pending_request_is_untouched', async () => {
      // AC4-07: raised after the approval, so never marked conflicting.
      const venue = await makeVenue();
      const booking = await approved(venue, await makeEvent());
      const request = await insertBooking(
        await makeEvent({ start: at('13:00'), end: at('17:00'), assigned: otherCoordinator }),
        venue,
      );

      expect((await release(booking)).returned_to_pending).toEqual([]);
      expect(await statusOf(request)).toBe('pending');
      expect(await noticesAbout(request, 'booking_request_conflict_cleared')).toEqual([]);
    });

    it('SCRUM492_AC4_a_freed_request_with_no_coordinator_returns_to_pending_and_nobody_is_told', async () => {
      // AC4-08.
      const { request, booking } = await conflictingBehind({ assigned: null });

      expect((await release(booking)).returned_to_pending).toEqual([request]);
      expect(await statusOf(request)).toBe('pending');
      expect(await noticesAbout(request, 'booking_request_conflict_cleared')).toEqual([]);
    });

    it('SCRUM492_AC4_a_freed_request_can_then_be_approved', async () => {
      // AC4-09.
      const { request, booking } = await conflictingBehind();
      await release(booking);

      expect((await decide(request)).outcome).toBe('approved');
    });
  });


  // -------------------------------------------------------------------------
  // AC6: the record, kept and final; Venue Staff told
  // -------------------------------------------------------------------------
  describe('AC6: the release is recorded, kept, final, and Venue Staff are told', () => {
    it('SCRUM492_AC6_the_release_is_recorded_trimmed_with_who_and_when', async () => {
      // AC6-01, AC6-04.
      const event = await makeEvent();
      const id = await approved(await makeVenue(), event);
      const count = async () => Number((await one('select count(*) as n from bookings')).n);
      const before = await count();

      await release(id, { reason: '  Moving to Hall B  ' });

      const row = await bookingRow(id);
      expect(row).toMatchObject({ status: 'released', released_by: coordinator, release_reason: 'Moving to Hall B' });
      expect(row.released_at).toBeInstanceOf(Date);
      expect(await count()).toBe(before);
    });

    it.each([
      ['set_back_to_approved', "status = 'approved'"],
      ['cancelled', "status = 'cancelled'"],
      ['given_a_new_reason', "release_reason = 'Another reason'"],
      ['given_another_releaser', 'released_by = decided_by'],
      ['cleared', "status = 'approved', released_by = null, released_at = null, release_reason = null"],
    ])('SCRUM492_AC6_a_released_booking_cannot_be_%s', async (_label, change) => {
      // AC6-02.
      const id = await approved(await makeVenue(), await makeEvent());
      await release(id);
      const before = await bookingRow(id);

      const err = await refusal(db.query(`update bookings set ${change} where id = $1`, [id]));

      expect(err?.code).toBe('42501');
      expect(await bookingRow(id)).toEqual(before);
    });

    it.each(['pending', 'conflicting', 'withdrawn', 'rejected'])(
      'SCRUM492_AC6_only_an_approved_booking_can_become_released_%s',
      async (status) => {
        // AC6-02, D6: refused by the trigger itself, not only by the function.
        // Undecided, so 076's early return would let it through; a rejection
        // must be decided (066).
        const event = await makeEvent();
        let id;
        if (status === 'rejected') {
          id = await insertBooking(event, await makeVenue());
          await db.query("select decide_booking_request($1, $2, 'reject', 'Under renovation', null)", [id, staff]);
        } else {
          id = await insertBooking(event, await makeVenue(), { status });
        }
        const before = await bookingRow(id);
        expect(before.status).toBe(status);

        const err = await refusal(db.query(
          `update bookings set status = 'released', released_by = $2, released_at = now(), release_reason = 'x'
            where id = $1`,
          [id, coordinator],
        ));

        expect(err?.code).toBe('42501');
        expect(await bookingRow(id)).toEqual(before);
      },
    );

    it.each([
      ['released_without_its_record', "status = 'released'"],
      ['a_record_without_the_released_status', "released_by = $2, released_at = now(), release_reason = 'Why'"],
      ['released_with_part_of_its_record', "status = 'released', released_at = now(), release_reason = 'Why'"],
      ['a_reason_with_spaces_around_it', "status = 'released', released_by = $2, released_at = now(), release_reason = ' Why '"],
      ['a_reason_of_1001_characters', `status = 'released', released_by = $2, released_at = now(), release_reason = '${'x'.repeat(1001)}'`],
    ])('SCRUM492_AC6_the_constraints_refuse_%s', async (_label, change) => {
      // AC6-03: on an undecided approved booking, so the trigger lets the write
      // reach the constraints.
      const id = await insertBooking(await makeEvent(), await makeVenue(), { status: 'approved' });
      const params = change.includes('$2') ? [id, coordinator] : [id];

      const err = await refusal(db.query(`update bookings set ${change} where id = $1`, params));

      expect(err?.code).toBe('23514');
      expect(await statusOf(id)).toBe('approved');
    });

    it('SCRUM492_AC6_every_venue_staff_member_is_told_and_nobody_else', async () => {
      // AC6-05.
      const event = await makeEvent();
      const venue = await makeVenue();
      const id = await approved(venue, event);

      await release(id, { reason: 'Moving to Hall B' });

      const notices = await rows('select recipient_id, type, payload from notifications where booking_id = $1 and type = $2', [id, 'booking_released']);
      expect(notices.map((n) => n.recipient_id).sort()).toEqual([staff, staff2].sort());
      expect(notices[0].payload).toEqual({
        eventRequestId: event,
        eventName: (await eventRow(event)).event_name,
        venueId: venue,
        venueName: expect.stringMatching(/^Harbour Room/),
        startsAt: expect.any(String),
        endsAt: expect.any(String),
        releasedBy: coordinator,
        releasedByName: 'Priya Nair',
        reason: 'Moving to Hall B',
      });
      expect(await rows(
        "select type from notifications where booking_id = $1 and type <> 'booking_request_approved' and type <> 'booking_released'", [id],
      )).toEqual([]);
    });

    it('SCRUM492_AC6_the_type_list_keeps_a_live_only_type_and_accepts_both_new_ones', async () => {
      // AC6-06: booking_request_submitted was seeded before 089 ran.
      const { def } = await one(
        "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'notifications_type_known'",
      );
      for (const type of ['booking_request_submitted', 'booking_released', 'booking_request_conflict_cleared', 'flagged_booking_resolved']) {
        expect(def).toContain(`'${type}'`);
      }
      const err = await refusal(db.query(
        "insert into notifications (recipient_id, type, payload) values ($1, 'not_a_type', '{}')", [staff],
      ));
      expect(err?.code).toBe('23514');
    });

    it('SCRUM492_AC6_088_and_089_are_safe_to_run_twice', async () => {
      // AC6-07.
      await db.exec(migration(MIGRATION_088));
      await db.exec(migration(MIGRATION_089));

      const counts = await one(`
        select (select count(*) from pg_proc where proname = 'release_venue_booking') as functions,
               (select count(*) from pg_trigger where tgname = 'bookings_decision_final') as triggers,
               (select count(*) from pg_constraint where conname = 'notifications_type_known') as type_lists,
               (select count(*) from pg_constraint
                 where conname in ('bookings_release_paired', 'bookings_release_matches_status',
                                   'bookings_release_reason_length')) as release_checks,
               (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid
                 where t.typname = 'booking_status' and e.enumlabel = 'released') as released_values
      `);
      expect(Object.values(counts).map(Number)).toEqual([1, 1, 1, 3, 1]);
    });
  });


  // -------------------------------------------------------------------------
  // AC3, AC5, AC8 (SCRUM-568): what is already built, after a release
  // -------------------------------------------------------------------------
  describe('AC3: search and the calendar see the period as free', () => {
    it('SCRUM492_AC3_search_offers_the_released_venue_again', async () => {
      // AC3-02: available_venue_ids (040), which venue search calls, asks
      // venue_occupancy_conflicts with the period padded.
      const venue = await makeVenue();
      const id = await approved(venue, await makeEvent());
      const free = async () =>
        (await rows('select venue_id from available_venue_ids($1::uuid[], $2, $3)', [[venue], at('13:00'), at('14:00')]))
          .map((r) => r.venue_id);
      expect(await free()).toEqual([]);

      await release(id);

      expect(await free()).toEqual([venue]);
    });

    it('SCRUM492_AC3_the_calendars_read_shows_no_released_booking', async () => {
      // AC3-03: the calendar's one bookings read, as venueCalendarService.js
      // makes it: the day as a window, unpadded (p_pad_requested false).
      const venue = await makeVenue();
      const id = await approved(venue, await makeEvent());
      const bookingsShown = async () =>
        (await rows(
          "select id from venue_occupancy_conflicts($1, $2, $3, false) where kind = 'booking'",
          [venue, at('00:00'), at('23:59')],
        )).map((r) => r.id);
      expect(await bookingsShown()).toEqual([id]);

      await release(id);

      expect(await bookingsShown()).toEqual([]);
    });
  });

  describe('AC5: a new request can follow', () => {
    const request = async (eventId, venueId) =>
      (await one(
        `select create_booking_request($1, $2, $3, null, null, '{"suitable": true}'::jsonb, false, 100) as result`,
        [eventId, venueId, coordinator],
      )).result;

    it('SCRUM492_AC5_after_a_release_the_same_venue_and_period_can_be_requested_again', async () => {
      // AC5-01: the released row is neither a live request (078 step 6) nor an
      // occupant (078 step 7).
      const event = await makeEvent();
      const venue = await makeVenue();
      const id = await approved(venue, event);
      expect((await refusal(request(event, venue)))?.hint).toBe('BOOKING_REQUEST_EXISTS');

      await release(id);
      const result = await request(event, venue);

      expect(result.outcome).toBe('created');
      expect(result.booking).toMatchObject({ venue_id: venue, event_request_id: event, status: 'pending' });
      expect(result.booking.id).not.toBe(id);
      expect(await statusOf(id)).toBe('released');
    });

    it('SCRUM492_AC5_after_a_release_another_venue_can_be_requested', async () => {
      // AC5-02.
      const event = await makeEvent();
      await release(await approved(await makeVenue(), event));

      const result = await request(event, await makeVenue());

      expect(result.outcome).toBe('created');
      expect(result.booking.status).toBe('pending');
    });
  });

  describe('AC8: flagged and pending are still handled where they were', () => {
    it('SCRUM492_AC8_a_flagged_booking_is_refused_release_and_still_cancelled_through_scrum266', async () => {
      // AC8-03, with AC8-01's refusal: 089's restated trigger keeps 076's
      // flagged -> cancelled move.
      const id = await approved(await makeVenue(), await makeEvent());
      await db.query(
        `update bookings set status = 'flagged_for_review', review_reason = 'safety_review',
                flagged_at = now(), flagged_by = $2 where id = $1`,
        [id, staff],
      );
      expect((await refusal(release(id)))?.hint).toBe('BOOKING_NOT_APPROVED');

      const { result } = await one('select cancel_flagged_booking($1, $2, $3) as result', [id, coordinator, 'Venue no longer fits']);

      expect(result.outcome).toBe('cancelled');
      expect(await statusOf(id)).toBe('cancelled');
    });

    it('SCRUM492_AC8_a_pending_request_is_refused_release_and_still_withdrawn_through_scrum253', async () => {
      // AC8-04, with AC8-02's refusal.
      const id = await insertBooking(await makeEvent(), await makeVenue());
      expect((await refusal(release(id)))?.hint).toBe('BOOKING_NOT_APPROVED');

      const { result } = await one('select withdraw_booking_request($1, $2) as result', [id, coordinator]);

      expect(result.outcome).toBe('withdrawn');
      expect(await statusOf(id)).toBe('withdrawn');
    });
  });


  // -------------------------------------------------------------------------
  // AC7: the event's status does not change
  // -------------------------------------------------------------------------
  it('SCRUM492_AC7_the_event_is_unchanged_by_a_release', async () => {
    // AC7-01: column for column. This stack has no status history table
    // (021); nothing in 089 writes to event_requests or the history.
    const event = await makeEvent();
    const first = await approved(await makeVenue(), event);
    const second = await approved(await makeVenue(), event);
    const before = await eventRow(event);

    await release(first);
    expect(await eventRow(event)).toEqual(before);
    await release(second);
    expect(await eventRow(event)).toEqual(before);
  });
});
