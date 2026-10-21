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
 * SCRUM-525 adds the real createBookingRequest over the same client: its
 * create_booking_request rpc runs on PGlite too, so a request's own
 * attendance is judged, stored and rechecked end to end.
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
import { createSchemaDb, seedBlock, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor } from './helpers/queries.js';
import { D, at, fromNow } from '../fixtures/time.js';

// The check loads venueService.js, which imports the Supabase client
// statically; every read here goes to the PGlite-backed client instead.
vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: {}, supabaseAdmin: {}, default: {} }));

const { checkVenueSuitability, checkEventVenues } = await import(
  '../../src/services/venueSuitabilityService.js'
);
const { createBookingRequest } = await import('../../src/services/bookingRequestService.js');
const { ConflictError } = await import('../../src/errors.js');

const ms = (value) => new Date(value).getTime();

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

  const { one, rows } = queriesFor(() => db);

  /**
   * A Supabase client whose reads and rpc go to PGlite: the event, the venue
   * with its attributes, the code lookups, the event's bookings with their
   * venue, and venue_occupancy_conflicts() called with the service's named
   * arguments. SCRUM-525: create_booking_request too, with its error passed
   * back in PostgREST's shape (code, message, hint, details), so the
   * service's own translation of a refusal is what is tested.
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
                      b.expected_attendance, b.suitability_result, b.suitability_overridden, b.created_at,
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
        if (fn === 'create_booking_request') {
          try {
            const { result } = await one(
              `select create_booking_request(
                 p_event_request_id => $1::uuid, p_venue_id => $2::uuid, p_requested_by => $3::uuid,
                 p_room_layout_code => $4::text, p_setup_notes => $5::text, p_suitability => $6::jsonb,
                 p_confirm_unsuitable => $7::boolean, p_expected_attendance => $8::integer) as result`,
              [
                args.p_event_request_id, args.p_venue_id, args.p_requested_by, args.p_room_layout_code,
                args.p_setup_notes, JSON.stringify(args.p_suitability), args.p_confirm_unsuitable,
                args.p_expected_attendance,
              ],
            );
            return { data: result, error: null };
          } catch (error) {
            return {
              data: null,
              error: { code: error.code, message: error.message, hint: error.hint, details: error.detail },
            };
          }
        }
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

  const makeUser = (role) => seedUser(db, { email: `u${++counter}@x`, role });

  async function makeVenue(setup = 30, turnaround = 45, capacity = 200) {
    const id = await seedVenue(db, { name: `Harbour Room ${++counter}`, capacity, setup, turnaround });
    await db.query(
      `insert into venue_operating_hours (venue_id, day_of_week, opens_at, closes_at)
       select $1, d, '07:00', '22:00' from generate_series(0, 6) d`,
      [id],
    );
    return id;
  }

  function makeEvent(startsAt, endsAt, name = null) {
    counter += 1;
    return seedEvent(db, {
      status: 'approved',
      organiser_id: organiser,
      assigned_coordinator_id: coordinator,
      event_name: name ?? `Event ${counter}`,
      proposed_start: startsAt,
      proposed_end: endsAt,
      expected_attendance: 150,
    });
  }

  const makeBooking = (venueId, eventId, startsAt, endsAt, status = 'approved') =>
    seedBooking(db, { venueId, eventId, status, start: startsAt, end: endsAt });

  const makeBlock = (venueId, startsAt, endsAt) => seedBlock(db, { venueId, start: startsAt, end: endsAt });

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
      'select create_booking_request($1, $2, $3, null, null, $4::jsonb, false, $5) as result',
      [eventId, venueId, coordinator, JSON.stringify(STORED_SUITABLE), 150],
    );
    expect(result.outcome).toBe('created');
    return result.booking.id;
  }

  /** SCRUM-525: the real service path, as the form calls it, over the PGlite client. */
  const requestThroughService = (eventId, venueId, input = {}) =>
    createBookingRequest({ eventRequestId: eventId, venueId, ...input }, coordinator, { client: pgliteClient() });

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
    db = await createSchemaDb();
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

  describe('SCRUM-525: each booking judged on its own attendance', () => {
    it('SCRUM525_AC3_flow_two_bookings_are_judged_on_their_own_attendance', async () => {
      // FL-02 (R7, R15). Event E has attendance 150; venues A and B hold 100
      // each. A is requested for 40 people, B for 120 (the coordinator
      // confirms B's Capacity shortfall, as the form asks). Both requests go
      // through the real createBookingRequest and create_booking_request, so
      // what is stored is what the service judged.
      const venueA = await makeVenue(30, 45, 100);
      const venueB = await makeVenue(30, 45, 100);
      const eventId = await makeEvent(at('14:00'), at('16:00'));

      const bookingA = await requestThroughService(eventId, venueA, { expectedAttendance: 40 });
      const bookingB = await requestThroughService(eventId, venueB, {
        expectedAttendance: 120,
        confirmUnsuitable: true,
        acknowledgedCriteria: ['Capacity'],
      });
      expect(bookingA.expectedAttendance).toBe(40);
      expect(bookingB.expectedAttendance).toBe(120);

      // The recheck judges each booking on its own number, never the event's
      // 150 -- which would fail A and judge B on a number nobody asked for.
      const items = await recheck(eventId);
      const a = items.find((item) => item.venueId === venueA);
      const b = items.find((item) => item.venueId === venueB);
      expect(a).toMatchObject({ expectedAttendance: 40, attendanceSource: 'booking', error: null });
      expect(b).toMatchObject({ expectedAttendance: 120, attendanceSource: 'booking', error: null });
      expect(a.current.criteria.find((c) => c.criterion === 'Capacity'))
        .toMatchObject({ met: true, detail: 'Capacity 100 ≥ expected attendance 40' });
      expect(b.current.criteria.find((c) => c.criterion === 'Capacity'))
        .toMatchObject({ met: false, detail: 'Capacity 100 < expected attendance 120' });
    });

    it('SCRUM525_AC1_a_duplicate_at_an_approved_venue_is_refused_as_existing_not_unsuitable', async () => {
      // B-AC1 ordering (R3). E already holds an approved booking at A, and A
      // is too small for this request (120 > 100), so Capacity is unmet; the
      // coordinator confirms that one shortfall, as the form would. The
      // service judges suitability before create_booking_request, so it is
      // the own-booking filter in judgeVenue that keeps E's approved booking
      // out of Availability. Without it Availability is unmet too, is not
      // among the acknowledged criteria, and the duplicate is misreported as
      // SUITABILITY_CONFIRMATION_REQUIRED instead of reaching step 6.
      const venueId = await makeVenue(30, 45, 100);
      const eventId = await makeEvent(at('17:00'), at('19:00'));
      const approvedId = await makeBooking(venueId, eventId, at('17:00'), at('19:00'), 'approved');

      const err = await requestThroughService(eventId, venueId, {
        expectedAttendance: 120,
        confirmUnsuitable: true,
        acknowledgedCriteria: ['Capacity'],
      }).catch((e) => e);

      expect(err).toBeInstanceOf(ConflictError);
      expect(err.code).toBe('BOOKING_REQUEST_EXISTS');
      expect(err.conflicts).toEqual([{ kind: 'booking_request', bookingId: approvedId }]);
      const { n } = await one(
        `select count(*)::int as n from bookings where event_request_id = $1`,
        [eventId],
      );
      expect(n).toBe(1);
    });
  });
});
