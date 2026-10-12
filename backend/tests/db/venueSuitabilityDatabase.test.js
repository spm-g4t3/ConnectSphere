/**
 * SCRUM-188 (SCRUM-193/194): the suitability check's Availability criterion
 * and the AC6 recheck, run against a real Postgres.
 *
 * What the SCRUM-484 and SCRUM-491 suites already prove -- the padding edges
 * of venue_occupancy_conflicts() itself, which statuses occupy, lapsed holds,
 * search agreeing with the function -- is not repeated here. What was missing
 * is the suitability service on top of it: every other suitability test feeds
 * the service hand-written occupancy rows. Here the real checkVenueSuitability
 * and checkEventVenues run over a client whose every read and rpc goes to
 * PGlite (the test-case document's harness P2, with the from() reads answered
 * from the same database rather than from stubs), so the own-booking filter,
 * the hold exclusion argument, the stale booking period, `met` and the detail
 * text are all judged on rows Postgres produced.
 *
 * Not proved here: the PostgREST select strings, which the service and route
 * tests pin.
 *
 * Fixture (the document's common one): venue V "Harbour Room", setup 30,
 * turnaround 45, capacity 200, open 07:00-22:00 daily; coordinator C; event E
 * approved, assigned to C, attendance 150; another event EA with an approved
 * booking A at V on D 10:00-12:00, which occupies 09:30-12:45.
 *
 * Dates: D is the Singapore date 10 days from now, as venueHoldsDatabase does,
 * because holds count only while unexpired and update_venue skips started
 * events. Instants are compared with getTime().
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// The check loads venueService.js, which imports the Supabase client
// statically; every read here goes to the PGlite-backed client instead.
vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: {}, supabaseAdmin: {}, default: {} }));

const { checkVenueSuitability, checkEventVenues } = await import(
  '../../src/services/venueSuitabilityService.js'
);

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name) => readFileSync(resolve(here, '../../db/migrations', name), 'utf8');

/** venueHoldsDatabase.test.js's list: through 036, then 040. */
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
  '035_setup_change_recheck_refine.sql',
  '036_venue_safety_facts.sql',
  '040_venue_holds.sql',
];

/** What 014 reads from SCRUM-19's migration, which is not on this branch. */
const DECISION_STAND_IN = `
  alter table event_requests
    add column if not exists reviewing_coordinator_id uuid references auth.users (id);
`;

/** D: the Singapore date 10 days from now, as YYYY-MM-DD. */
const D = new Date(Date.now() + 8 * 3600_000 + 10 * 86_400_000).toISOString().slice(0, 10);
/** An instant on D, written at +08:00 (Singapore). */
const at = (hhmm) => `${D}T${hhmm}:00+08:00`;
const ms = (value) => new Date(value).getTime();
const fromNow = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();

/** D as the detail text names it, e.g. 'Wed 11 Nov', built from D alone. */
const DAY = (() => {
  const [y, m, d] = D.split('-').map(Number);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
  return `${weekday} ${d} ${month}`;
})();

/** A result as checkVenueSuitability stores it, all six met, with checked. */
const STORED_SUITABLE = {
  suitable: true,
  criteria: ['Capacity', 'Operating hours', 'Layout', 'Accessibility', 'Facilities', 'Availability'].map(
    (criterion) => ({ criterion, met: true, detail: 'as stored' }),
  ),
  checked: { layout: null, accessibility: [], facilities: [] },
};

describe('SCRUM-188: suitability judged on real occupancy (PGlite)', () => {
  let db;
  let organiser;
  let staff;
  let coordinator;
  let counter = 0;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const rows = async (sql, params) => (await db.query(sql, params)).rows;

  /**
   * A Supabase client whose reads and rpc go to PGlite: the event, the venue
   * with its attributes, the code lookups, the event's bookings with their
   * venue, and venue_occupancy_conflicts() called with the service's named
   * arguments.
   */
  function pgliteClient() {
    const readVenue = async (id) => {
      const venue = await one(
        `select v.*,
                coalesce((select json_agg(json_build_object('room_layout_code', room_layout_code))
                            from venue_room_layouts where venue_id = v.id), '[]') as venue_room_layouts,
                coalesce((select json_agg(json_build_object('accessibility_feature_code', accessibility_feature_code))
                            from venue_accessibility_features where venue_id = v.id), '[]')
                  as venue_accessibility_features,
                coalesce((select json_agg(json_build_object('facility_code', facility_code))
                            from venue_facilities where venue_id = v.id), '[]') as venue_facilities,
                coalesce((select json_agg(json_build_object('day_of_week', day_of_week,
                                                            'opens_at', opens_at, 'closes_at', closes_at))
                            from venue_operating_hours where venue_id = v.id), '[]') as venue_operating_hours
           from venues v where v.id = $1`,
        [id],
      );
      return { data: venue ?? null, error: null };
    };

    return {
      from(table) {
        const filters = {};
        const chain = {
          select: () => chain,
          eq: (column, value) => {
            filters[column] = value;
            return chain;
          },
          in: (column, values) => {
            filters[column] = values;
            if (table === 'bookings') return chain;
            return rows(`select code from ${table} where code = any($1::text[])`, [values]).then((data) => ({
              data,
              error: null,
            }));
          },
          order: async () => ({
            data: await rows(
              `select b.id, b.venue_id, b.status, b.starts_at, b.ends_at, b.room_layout_code,
                      b.suitability_result, b.suitability_overridden, b.created_at,
                      json_build_object('name', v.name, 'location', v.location) as venues
                 from bookings b join venues v on v.id = b.venue_id
                where b.event_request_id = $1 and b.status::text = any($2::text[])
                order by b.created_at`,
              [filters.event_request_id, filters.status],
            ),
            error: null,
          }),
          maybeSingle: async () => {
            if (table === 'event_requests') {
              return { data: (await one('select * from event_requests where id = $1', [filters.id])) ?? null, error: null };
            }
            return readVenue(filters.id);
          },
        };
        return chain;
      },
      async rpc(fn, args) {
        if (fn !== 'venue_occupancy_conflicts') throw new Error(`unexpected rpc ${fn}`);
        try {
          const data = await rows(
            `select * from venue_occupancy_conflicts(
               p_venue_id => $1::uuid, p_starts_at => $2::timestamptz, p_ends_at => $3::timestamptz,
               p_pad_requested => $4::boolean, p_exclude_hold_event_id => $5::uuid)`,
            [args.p_venue_id, args.p_starts_at, args.p_ends_at, args.p_pad_requested, args.p_exclude_hold_event_id],
          );
          return { data, error: null };
        } catch (error) {
          return { data: null, error: { message: error.message } };
        }
      },
    };
  }

  /** P1: the rows the function returns for the service's arguments, or others. */
  const occupancy = (venueId, startsAt, endsAt, excludeEventId) =>
    rows(
      `select * from venue_occupancy_conflicts(
         p_venue_id => $1, p_starts_at => $2, p_ends_at => $3,
         p_pad_requested => true, p_exclude_hold_event_id => $4)`,
      [venueId, startsAt, endsAt, excludeEventId],
    );

  async function makeUser(role) {
    counter += 1;
    const id = (await one('insert into auth.users (email) values ($1) returning id', [`u${counter}@x`])).id;
    if (role) await db.query('insert into profiles (id, role) values ($1, $2)', [id, role]);
    return id;
  }

  async function makeVenue(setup = 30, turnaround = 45) {
    counter += 1;
    const id = (
      await one(
        `insert into venues (name, location, max_capacity, setup_minutes, turnaround_minutes)
         values ($1, 'Block A', 200, $2, $3) returning id`,
        [`Harbour Room ${counter}`, setup, turnaround],
      )
    ).id;
    await db.query(
      `insert into venue_operating_hours (venue_id, day_of_week, opens_at, closes_at)
       select $1, d, '07:00', '22:00' from generate_series(0, 6) d`,
      [id],
    );
    return id;
  }

  async function makeEvent(startsAt, endsAt, name = null) {
    counter += 1;
    return (
      await one(
        `insert into event_requests
           (organiser_id, event_name, status, proposed_start, proposed_end,
            expected_attendance, submitted_at, assigned_coordinator_id)
         values ($1, $2, 'approved', $3, $4, 150, now(), $5) returning id`,
        [organiser, name ?? `Event ${counter}`, startsAt, endsAt, coordinator],
      )
    ).id;
  }

  async function makeBooking(venueId, eventId, startsAt, endsAt, status = 'approved') {
    return (
      await one(
        `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
         values ($1, $2, $3, $4, $5) returning id`,
        [venueId, eventId, startsAt, endsAt, status],
      )
    ).id;
  }

  async function makeBlock(venueId, startsAt, endsAt) {
    return (
      await one(
        `insert into venue_blocks (venue_id, starts_at, ends_at, reason)
         values ($1, $2, $3, 'maintenance') returning id`,
        [venueId, startsAt, endsAt],
      )
    ).id;
  }

  async function placeHold(eventId, venueId) {
    const { result } = await one('select place_venue_hold($1, $2, $3, $4) as result', [
      eventId,
      venueId,
      fromNow(120),
      staff,
    ]);
    expect(result.outcome).toBe('placed');
    return result.hold.id;
  }

  /** The common fixture: V with EA's approved booking A on D 10:00-12:00. */
  async function fixtureA() {
    const venueId = await makeVenue();
    const otherEventId = await makeEvent(at('10:00'), at('12:00'), 'Gala Night');
    const bookingId = await makeBooking(venueId, otherEventId, at('10:00'), at('12:00'));
    return { venueId, bookingId, otherEventId };
  }

  /** E's own request through the real create_booking_request, as the app makes it. */
  async function requestVenue(eventId, venueId) {
    const { result } = await one(
      'select create_booking_request($1, $2, $3, null, null, $4::jsonb, false) as result',
      [eventId, venueId, coordinator, JSON.stringify(STORED_SUITABLE)],
    );
    expect(result.outcome).toBe('created');
    return result.booking.id;
  }

  const check = (eventId, venueId) =>
    checkVenueSuitability({ eventRequestId: eventId, venueId, userId: coordinator, client: pgliteClient() });
  const recheck = (eventId) => checkEventVenues(eventId, { userId: coordinator, client: pgliteClient() });
  const availabilityOf = (result) => result.criteria.find((c) => c.criterion === 'Availability');

  async function updateVenue(venueId, changes) {
    const names = Object.keys(changes);
    const sql = `select update_venue(p_id => $1, ${names
      .map((n, i) => `p_${n} => $${i + 2}`)
      .join(', ')}, p_user_id => $${names.length + 2}) as result`;
    return (await one(sql, [venueId, ...Object.values(changes), staff])).result;
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
      await db.exec(name === 'STAND_IN' ? DECISION_STAND_IN : migration(name));
    }
    organiser = await makeUser('event_organiser');
    staff = await makeUser('venue_staff');
    coordinator = await makeUser('event_coordinator');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('AC4 / WK7-1: the occupied period, edges and parts', () => {
    it('SCRUM188_AC4_a_padded_conflict_shows_its_occupied_period_and_parts', async () => {
      const { venueId, bookingId } = await fixtureA();
      const eventId = await makeEvent(at('13:14'), at('14:00'));

      const result = await check(eventId, venueId);

      const availability = availabilityOf(result);
      expect(availability.met).toBe(false);
      expect(availability.detail).toBe(
        `Needs 12:44–14:45 on ${DAY} (setup 12:44–13:14, turnaround 14:00–14:45). ` +
          `Booked for Gala Night 09:30–12:45 on ${DAY} (setup 09:30–10:00, turnaround 12:00–12:45)`,
      );
      expect(availability.conflicts).toHaveLength(1);
      expect(availability.conflicts[0]).toMatchObject({ kind: 'booking', id: bookingId, eventName: 'Gala Night' });
      expect(ms(availability.conflicts[0].occupiedStartsAt)).toBe(ms(at('09:30')));
      expect(ms(availability.conflicts[0].occupiedEndsAt)).toBe(ms(at('12:45')));
      expect(result.suitable).toBe(false);
    });

    it('SCRUM188_AC4_touching_is_available_and_says_free_with_the_occupied_period', async () => {
      const { venueId } = await fixtureA();
      const eventId = await makeEvent(at('13:15'), at('14:00'));

      const result = await check(eventId, venueId);

      expect(availabilityOf(result)).toEqual({
        criterion: 'Availability',
        met: true,
        detail: `Free 12:45–14:45 on ${DAY} (incl. 30 min setup, 45 min turnaround)`,
        conflicts: [],
      });
      expect(result.suitable).toBe(true);
    });

    it('SCRUM188_WK7_1_setup_edge_0845_clear_0846_conflict', async () => {
      // The event's turnaround against A's setup: 07:30-08:45 occupies
      // 07:00-09:30, touching A's 09:30; 08:46 reaches a minute in.
      const { venueId, bookingId } = await fixtureA();
      const clear = await check(await makeEvent(at('07:30'), at('08:45')), venueId);
      const clash = await check(await makeEvent(at('07:30'), at('08:46')), venueId);

      expect(availabilityOf(clear).met).toBe(true);
      expect(availabilityOf(clash).met).toBe(false);
      expect(availabilityOf(clash).conflicts.map((c) => c.id)).toEqual([bookingId]);
    });

    it('SCRUM188_AC4_a_block_is_not_padded_and_shows_its_own_period', async () => {
      // Block K 13:00-14:00. 14:30 sets up from 14:00, touching K's end: clear
      // only because K itself is not padded (padded by 45 it would end 14:45).
      const venueId = await makeVenue();
      const blockId = await makeBlock(venueId, at('13:00'), at('14:00'));

      const clear = await check(await makeEvent(at('14:30'), at('15:00')), venueId);
      const clash = await check(await makeEvent(at('14:29'), at('15:00')), venueId);

      expect(availabilityOf(clear).met).toBe(true);
      const availability = availabilityOf(clash);
      expect(availability.met).toBe(false);
      expect(availability.detail).toBe(
        `Needs 13:59–15:45 on ${DAY} (setup 13:59–14:29, turnaround 15:00–15:45). ` +
          `Blocked (maintenance) 13:00–14:00 on ${DAY}`,
      );
      expect(availability.conflicts[0]).toMatchObject({ kind: 'block', id: blockId });
      expect(ms(availability.conflicts[0].occupiedStartsAt)).toBe(ms(at('13:00')));
      expect(ms(availability.conflicts[0].occupiedEndsAt)).toBe(ms(at('14:00')));
    });

    it('SCRUM188_AC4_the_events_own_booking_is_returned_by_sql_and_dropped_by_the_service', async () => {
      const venueId = await makeVenue();
      const eventId = await makeEvent(at('10:00'), at('12:00'));
      const ownId = await makeBooking(venueId, eventId, at('10:00'), at('12:00'));
      const otherEventId = await makeEvent(at('13:00'), at('14:00'), 'Gala Night');
      const otherId = await makeBooking(venueId, otherEventId, at('13:00'), at('14:00'));

      // The SQL has no own-booking exclusion: both come back.
      const sqlRows = await occupancy(venueId, at('10:00'), at('12:00'), eventId);
      expect(sqlRows.map((r) => r.id).sort()).toEqual([ownId, otherId].sort());

      // The service drops its own and keeps the other event's.
      const availability = availabilityOf(await check(eventId, venueId));
      expect(availability.met).toBe(false);
      expect(availability.conflicts.map((c) => c.id)).toEqual([otherId]);
    });
  });

  describe('WK7-2: holds', () => {
    it('SCRUM188_WK7_2_another_events_hold_is_a_conflict_with_the_held_period', async () => {
      const venueId = await makeVenue();
      const holderId = await makeEvent(at('10:00'), at('12:00'), 'Open House');
      const holdId = await placeHold(holderId, venueId);

      const clash = await check(await makeEvent(at('13:14'), at('14:00')), venueId);
      const clear = await check(await makeEvent(at('13:15'), at('14:00')), venueId);

      const availability = availabilityOf(clash);
      expect(availability.met).toBe(false);
      expect(availability.detail).toBe(
        `Needs 12:44–14:45 on ${DAY} (setup 12:44–13:14, turnaround 14:00–14:45). ` +
          `Held for Open House 09:30–12:45 on ${DAY} (setup 09:30–10:00, turnaround 12:00–12:45)`,
      );
      expect(availability.conflicts[0]).toMatchObject({ kind: 'hold', id: holdId, eventName: 'Open House' });
      expect(availabilityOf(clear).met).toBe(true);
    });

    it('SCRUM188_WK7_2_the_events_own_hold_does_not_count', async () => {
      const venueId = await makeVenue();
      const eventId = await makeEvent(at('10:00'), at('12:00'));
      const holdId = await placeHold(eventId, venueId);

      // Without the exclusion the function returns E's own hold, so the
      // argument the service passes is what clears it.
      const unexcluded = await occupancy(venueId, at('10:00'), at('12:00'), null);
      expect(unexcluded.map((r) => [r.kind, r.id])).toEqual([['hold', holdId]]);

      const result = await check(eventId, venueId);
      expect(availabilityOf(result).met).toBe(true);
      expect(result.suitable).toBe(true);
    });
  });

  describe('AC6 / WK7-4: the recheck, judged live', () => {
    it('SCRUM188_AC6_a_moved_event_is_rechecked_against_real_occupancy', async () => {
      const { venueId, bookingId } = await fixtureA();
      const eventId = await makeEvent(at('13:15'), at('14:00'));
      const ownId = await requestVenue(eventId, venueId);

      const [before] = await recheck(eventId);
      expect(before.bookingId).toBe(ownId);
      expect(ms(before.bookingStartsAt)).toBe(ms(at('13:15')));
      expect(availabilityOf(before.current).met).toBe(true);
      expect(before.newlyUnmet).toEqual([]);

      await db.query('update event_requests set proposed_start = $2 where id = $1', [eventId, at('13:14')]);
      const [after] = await recheck(eventId);

      const availability = availabilityOf(after.current);
      expect(availability.met).toBe(false);
      // SCRUM-193/194 (B2): the booking still covers 13:15, so that is named
      // first, then the real conflict with A. E's own booking is never one.
      expect(availability.detail).toBe(
        `Booking covers ${DAY} 13:15–14:00; the event is now ${DAY} 13:14–14:00. ` +
          `Needs 12:44–14:45 on ${DAY} (setup 12:44–13:14, turnaround 14:00–14:45). ` +
          `Booked for Gala Night 09:30–12:45 on ${DAY} (setup 09:30–10:00, turnaround 12:00–12:45)`,
      );
      expect(availability.conflicts.map((c) => c.id)).toEqual([bookingId]);
      expect(after.newlyUnmet).toEqual(['Availability']);
    });

    it('SCRUM188_AC6_a_booking_left_on_the_old_period_is_unavailable_even_when_the_new_one_is_free', async () => {
      // B2 on real rows: create_booking_request copied 13:15-14:00 into the
      // booking; the event moves to a free 16:00-17:00, which the booking does
      // not cover, and other events are still judged against the old period.
      const { venueId } = await fixtureA();
      const eventId = await makeEvent(at('13:15'), at('14:00'));
      await requestVenue(eventId, venueId);

      await db.query('update event_requests set proposed_start = $2, proposed_end = $3 where id = $1', [
        eventId,
        at('16:00'),
        at('17:00'),
      ]);
      const [item] = await recheck(eventId);

      expect(availabilityOf(item.current)).toEqual({
        criterion: 'Availability',
        met: false,
        detail: `Booking covers ${DAY} 13:15–14:00; the event is now ${DAY} 16:00–17:00`,
        conflicts: [],
      });
      expect(item.newlyUnmet).toEqual(['Availability']);
      expect(ms(item.bookingStartsAt)).toBe(ms(at('13:15')));
    });

    it('SCRUM188_WK7_4_a_setup_change_is_rechecked_live_and_named_newly_unmet', async () => {
      // 13:15 touches A's 12:45 at setup 30; at setup 45 A occupies from
      // 09:15 and E from 12:30, so setup + turnaround (90) exceeds the gap (75).
      const { venueId, bookingId } = await fixtureA();
      const eventId = await makeEvent(at('13:15'), at('14:00'));
      await requestVenue(eventId, venueId);

      const [before] = await recheck(eventId);
      expect(availabilityOf(before.current).met).toBe(true);

      await updateVenue(venueId, { setup_minutes: 45 });
      const [after] = await recheck(eventId);

      const availability = availabilityOf(after.current);
      expect(availability.met).toBe(false);
      expect(availability.detail).toBe(
        `Needs 12:30–14:45 on ${DAY} (setup 12:30–13:15, turnaround 14:00–14:45). ` +
          `Booked for Gala Night 09:15–12:45 on ${DAY} (setup 09:15–10:00, turnaround 12:00–12:45)`,
      );
      expect(availability.conflicts.map((c) => c.id)).toEqual([bookingId]);
      expect(after.newlyUnmet).toEqual(['Availability']);
      // Nothing was stored: the request-time verdict is unchanged.
      expect(after.atRequest).toEqual({ suitable: true, unmet: [] });
    });

    it('SCRUM188_WK7_4_a_turnaround_change_also_rechecks', async () => {
      // At turnaround 60, A occupies until 13:00, past E's 12:45 setup start.
      const { venueId, bookingId } = await fixtureA();
      const eventId = await makeEvent(at('13:15'), at('14:00'));
      await requestVenue(eventId, venueId);

      const [before] = await recheck(eventId);
      expect(availabilityOf(before.current).met).toBe(true);

      await updateVenue(venueId, { turnaround_minutes: 60 });
      const [after] = await recheck(eventId);

      const availability = availabilityOf(after.current);
      expect(availability.met).toBe(false);
      expect(availability.conflicts.map((c) => c.id)).toEqual([bookingId]);
      expect(ms(availability.conflicts[0].occupiedEndsAt)).toBe(ms(at('13:00')));
      expect(after.newlyUnmet).toEqual(['Availability']);
    });
  });
});
