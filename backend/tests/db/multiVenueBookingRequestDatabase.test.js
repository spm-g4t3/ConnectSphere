/**
 * SCRUM-525: several venue requests for one event, each with its own expected
 * attendance, run against a real Postgres.
 *
 * bookings.expected_attendance is nullable and > 0; create_booking_request
 * takes p_expected_attendance (required, at least 1, else 22023). Step 6
 * refuses a second live request (pending, approved, flagged_for_review) only
 * at the same venue; step 7's conflict check is unchanged. Run against the
 * final schema.
 *
 * The cases are the "PGlite (ST2)" rows of SCRUM-525-test-cases.md, named as
 * the document names them (B-AC1-01 .. B-AC8-01), plus one for the column's
 * check constraint. Rules: R2, R3, R5, R6, R8, R10.
 *
 * Fixture (the document's): venues A and B, capacity 200, setup 30,
 * turnaround 45; coordinator C; event E approved, assigned to C, attendance
 * 150, on D 14:00-16:00; another event EA on the same period. Each test makes
 * its own venues and events, so no test sees another's rows.
 *
 * Dates: D is the Singapore date 10 days from now, never hard-coded, because
 * a hold counts only while unexpired.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';

/** D: the Singapore date 10 days from now, as YYYY-MM-DD. */
const D = new Date(Date.now() + 8 * 3600_000 + 10 * 86_400_000).toISOString().slice(0, 10);
/** An instant on D, written at +08:00 (Singapore). */
const at = (hhmm) => `${D}T${hhmm}:00+08:00`;
const START = at('14:00');
const END = at('16:00');

const SUITABLE = { suitable: true, criteria: [{ criterion: 'Capacity', met: true }] };
const LIVE = ['pending', 'approved', 'flagged_for_review'];

/** The error a promise rejected with, as {code, hint, detail}; null if it resolved. */
const refusal = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return { code: err.code, hint: err.hint ?? null, detail: err.detail ?? null };
  }
};

describe('SCRUM-525: several venue requests per event', () => {
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

  function makeEvent({ status = 'approved', attendance = 150, coordinatorId = coordinator } = {}) {
    counter += 1;
    return seedEvent(db, {
      status,
      organiser_id: organiser,
      assigned_coordinator_id: coordinatorId,
      event_name: `Event ${counter}`,
      proposed_start: START,
      proposed_end: END,
      expected_attendance: attendance,
    });
  }

  /**
   * A booking of eventId at venueId on D 14:00-16:00, written directly in any
   * status. A flagged_for_review one carries a block and a flag time
   * (bookings_review_flag_paired) and who flagged it; the block is a removed
   * one late on D, so it occupies nothing itself.
   */
  async function insertBooking(eventId, venueId, status) {
    let reviewBlockId = null;
    if (status === 'flagged_for_review') {
      reviewBlockId = (
        await one(
          `insert into venue_blocks (venue_id, starts_at, ends_at, reason, removed_at)
           values ($1, $2, $3, 'maintenance', now()) returning id`,
          [venueId, at('22:00'), at('23:00')],
        )
      ).id;
    }
    const flagged = reviewBlockId !== null;
    return (
      await one(
        `insert into bookings
           (venue_id, event_request_id, starts_at, ends_at, status, review_block_id, flagged_at, flagged_by)
         values ($1, $2, $3, $4, $5, $6, ${flagged ? 'now()' : 'null'}, $7) returning id`,
        [venueId, eventId, START, END, status, reviewBlockId, flagged ? staff : null],
      )
    ).id;
  }

  /** create_booking_request as the API calls it, with an expected attendance. */
  async function request(eventId, venueId, attendance = 150, { layout = null, by = coordinator } = {}) {
    return (
      await one(
        'select create_booking_request($1, $2, $3, $4, null, $5::jsonb, false, $6, null) as result',
        [eventId, venueId, by, layout, JSON.stringify(SUITABLE), attendance],
      )
    ).result;
  }

  /** A pending request through the real function, its booking id. */
  async function pendingAt(eventId, venueId) {
    const result = await request(eventId, venueId);
    expect(result.outcome).toBe('created');
    return result.booking.id;
  }

  const countFor = async (eventId) =>
    (await one('select count(*)::int as n from bookings where event_request_id = $1', [eventId])).n;
  const bookingRow = (id) => one('select * from bookings where id = $1', [id]);

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await makeUser('o@x', 'event_organiser');
    coordinator = await makeUser('c1@x', 'event_coordinator');
    otherCoordinator = await makeUser('c2@x', 'event_coordinator');
    staff = await makeUser('s@x', 'venue_staff');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('AC1: one live request per venue, several venues per event', () => {
    it.each(['approved', 'confirmed'])('SCRUM525_AC1_a_%s_event_can_request_a_second_venue', async (status) => {
      const [venueA, venueB] = [await makeVenue(), await makeVenue()];
      const eventId = await makeEvent({ status });
      const atA = await pendingAt(eventId, venueA);

      const result = await request(eventId, venueB);

      expect(result.outcome).toBe('created');
      expect(result.booking.venue_id).toBe(venueB);
      const { rows } = await db.query(
        'select id, venue_id, status from bookings where event_request_id = $1 order by created_at, id',
        [eventId],
      );
      expect(rows).toEqual([
        { id: atA, venue_id: venueA, status: 'pending' },
        { id: result.booking.id, venue_id: venueB, status: 'pending' },
      ]);
    });

    it('SCRUM525_AC1_the_same_venue_again_is_refused_naming_the_first', async () => {
      for (const status of ['pending', 'approved']) {
        const venueA = await makeVenue();
        const eventId = await makeEvent();
        const firstId = status === 'pending' ? await pendingAt(eventId, venueA) : await insertBooking(eventId, venueA, status);

        const error = await refusal(request(eventId, venueA));

        expect(error, status).toEqual({ code: 'PT409', hint: 'BOOKING_REQUEST_EXISTS', detail: firstId });
        expect(await countFor(eventId), status).toBe(1);
      }
    });

    it.each(['rejected', 'withdrawn', 'cancelled'])('SCRUM525_AC1_a_%s_request_frees_its_venue', async (status) => {
      const venueA = await makeVenue();
      const eventId = await makeEvent();
      await insertBooking(eventId, venueA, status);

      const result = await request(eventId, venueA);

      expect(result.outcome).toBe('created');
      expect(result.booking.venue_id).toBe(venueA);
      expect(await countFor(eventId)).toBe(2);
    });

    it('SCRUM525_AC1_a_flagged_booking_blocks_its_own_venue_only', async () => {
      const [venueA, venueB] = [await makeVenue(), await makeVenue()];
      const eventId = await makeEvent();
      const flaggedId = await insertBooking(eventId, venueA, 'flagged_for_review');

      const sameVenue = await refusal(request(eventId, venueA));
      expect(sameVenue).toEqual({ code: 'PT409', hint: 'BOOKING_FLAGGED_FOR_REVIEW', detail: flaggedId });
      expect(await countFor(eventId)).toBe(1);

      const otherVenue = await request(eventId, venueB);
      expect(otherVenue.outcome).toBe('created');
      expect(otherVenue.booking.venue_id).toBe(venueB);
    });
  });

  describe('AC2: each request stores its own expected attendance', () => {
    it('SCRUM525_AC2_attendance_below_1_is_refused_and_1_is_stored', async () => {
      const venueA = await makeVenue();
      const eventId = await makeEvent();

      for (const attendance of [0, null]) {
        const error = await refusal(request(eventId, venueA, attendance));
        expect(error, String(attendance)).toEqual({ code: '22023', hint: null, detail: null });
        expect(await countFor(eventId), String(attendance)).toBe(0);
      }

      const result = await request(eventId, venueA, 1);
      expect(result.outcome).toBe('created');
      expect((await bookingRow(result.booking.id)).expected_attendance).toBe(1);
    });

    it('SCRUM525_AC2_each_request_stores_its_own_attendance_and_layout', async () => {
      const [venueA, venueB] = [await makeVenue(), await makeVenue()];
      const eventId = await makeEvent({ attendance: 150 });

      const atA = await request(eventId, venueA, 120, { layout: 'theatre' });
      const atB = await request(eventId, venueB, 40, { layout: 'u_shape' });

      const rowA = await bookingRow(atA.booking.id);
      const rowB = await bookingRow(atB.booking.id);
      expect([rowA.expected_attendance, rowA.room_layout_code]).toEqual([120, 'theatre']);
      expect([rowB.expected_attendance, rowB.room_layout_code]).toEqual([40, 'u_shape']);
    });

    it('SCRUM525_AC2_attendance_above_the_events_is_refused_and_equal_is_stored', async () => {
      // The event expects 150, so 151 at one venue is 22023 and nothing
      // is written; 150 is the boundary and goes through.
      const venueA = await makeVenue();
      const eventId = await makeEvent({ attendance: 150 });

      const error = await refusal(request(eventId, venueA, 151));
      expect(error).toEqual({ code: '22023', hint: null, detail: null });
      expect(await countFor(eventId)).toBe(0);

      const result = await request(eventId, venueA, 150);
      expect(result.outcome).toBe('created');
      expect((await bookingRow(result.booking.id)).expected_attendance).toBe(150);
    });

    it('SCRUM525_AC2_an_event_without_attendance_caps_nothing', async () => {
      const venueA = await makeVenue();
      const eventId = await makeEvent({ attendance: null });

      const result = await request(eventId, venueA, 500);
      expect(result.outcome).toBe('created');
    });

    it('SCRUM525_AC2_the_column_refuses_0_and_keeps_null_for_old_rows', async () => {
      const venueA = await makeVenue();
      const eventId = await makeEvent();
      const insert = (attendance) =>
        db.query(
          `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status, expected_attendance)
           values ($1, $2, $3, $4, 'rejected', $5)`,
          [venueA, eventId, START, END, attendance],
        );

      expect((await refusal(insert(0)))?.code).toBe('23514');
      expect(await countFor(eventId)).toBe(0);
      expect(await refusal(insert(1))).toBeNull();
      expect(await refusal(insert(null))).toBeNull();
    });

    it('SCRUM525_AC2_only_one_create_booking_request_remains', async () => {
      const { rows } = await db.query("select pronargs from pg_proc where proname = 'create_booking_request'");
      expect(rows).toEqual([{ pronargs: 9 }]);

      const old = await one(
        "select to_regprocedure('create_booking_request(uuid, uuid, uuid, text, text, jsonb, boolean)') as oid",
      );
      expect(old.oid).toBeNull();

      for (const role of ['anon', 'authenticated']) {
        const { allowed } = await one(
          `select has_function_privilege($1, 'create_booking_request(uuid, uuid, uuid, text, text, jsonb, boolean, integer, uuid)', 'execute') as allowed`,
          [role],
        );
        expect(allowed, role).toBe(false);
      }

      // A caller still on the 7-argument call resolves, through the default,
      // and is refused for the missing attendance; nothing is written.
      const venueA = await makeVenue();
      const eventId = await makeEvent();
      const error = await refusal(
        db.query('select create_booking_request($1, $2, $3, null, null, $4::jsonb, false)', [
          eventId,
          venueA,
          coordinator,
          JSON.stringify(SUITABLE),
        ]),
      );
      expect(error?.code).toBe('22023');
      expect(await countFor(eventId)).toBe(0);
    });
  });

  describe('AC4: an event never conflicts with itself across venues; other conflicts stand', () => {
    it('SCRUM525_AC4_the_events_booking_at_one_venue_never_conflicts_at_another', async () => {
      const [venueA, venueB] = [await makeVenue(), await makeVenue()];
      const eventId = await makeEvent();
      // Approved, so it occupies A over E's own padded period.
      await insertBooking(eventId, venueA, 'approved');

      const result = await request(eventId, venueB);

      expect(result.outcome).toBe('created');
      expect(result.booking.venue_id).toBe(venueB);
    });

    it.each([
      [
        'a_block',
        async (venueB) =>
          (
            await one(
              `insert into venue_blocks (venue_id, starts_at, ends_at, reason)
               values ($1, $2, $3, 'maintenance') returning id`,
              [venueB, START, END],
            )
          ).id,
        'block',
        'block_id',
      ],
      [
        'another_events_approved_booking',
        async (venueB) => insertBooking(await makeEvent(), venueB, 'approved'),
        'booking',
        'booking_id',
      ],
      [
        'another_events_active_hold',
        async (venueB) =>
          (
            await one(
              `insert into venue_holds (event_request_id, venue_id, placed_by, expires_at)
               values ($1, $2, $3, now() + interval '1 hour') returning id`,
              [await makeEvent(), venueB, staff],
            )
          ).id,
        'hold',
        'hold_id',
      ],
    ])('SCRUM525_AC4_%s_at_the_other_venue_still_conflicts', async (_label, occupy, kind, idKey) => {
      const [venueA, venueB] = [await makeVenue(), await makeVenue()];
      const eventId = await makeEvent();
      await pendingAt(eventId, venueA);
      const occupierId = await occupy(venueB);

      const result = await request(eventId, venueB);

      expect(result.outcome).toBe('conflict');
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].kind).toBe(kind);
      expect(result.conflicts[0][idKey]).toBe(occupierId);
      expect(await countFor(eventId)).toBe(1);
    });
  });

  describe('AC6: withdrawing one request', () => {
    it('SCRUM525_AC6_withdrawing_one_request_leaves_the_others_pending', async () => {
      const [venueA, venueB] = [await makeVenue(), await makeVenue()];
      const eventId = await makeEvent();
      const atA = await pendingAt(eventId, venueA);
      const atB = await pendingAt(eventId, venueB);

      const { result } = await one('select withdraw_booking_request($1, $2) as result', [atA, coordinator]);

      expect(result.outcome).toBe('withdrawn');
      expect(result.booking.id).toBe(atA);
      expect((await bookingRow(atA)).status).toBe('withdrawn');
      expect((await bookingRow(atB)).status).toBe('pending');
    });
  });

  describe('AC8: who raised each request, and when', () => {
    it('SCRUM525_AC8_each_request_records_its_own_requester_and_time', async () => {
      const [venueA, venueB] = [await makeVenue(), await makeVenue()];
      const eventId = await makeEvent();

      // The database's own clock around each request, so each created_at is
      // pinned to the call that wrote it: a time copied from the other
      // booking, from the event, or from a fixed default would fall outside
      // its window.
      const dbNow = async () => (await one('select now() as t')).t.getTime();

      const beforeA = await dbNow();
      const atA = await request(eventId, venueA, 150, { by: coordinator });
      const afterA = await dbNow();
      await db.query('update event_requests set assigned_coordinator_id = $2 where id = $1', [eventId, otherCoordinator]);
      const beforeB = await dbNow();
      const atB = await request(eventId, venueB, 150, { by: otherCoordinator });
      const afterB = await dbNow();

      const rowA = await bookingRow(atA.booking.id);
      const rowB = await bookingRow(atB.booking.id);
      expect(rowA.requested_by).toBe(coordinator);
      expect(rowB.requested_by).toBe(otherCoordinator);
      const createdA = rowA.created_at.getTime();
      const createdB = rowB.created_at.getTime();
      expect(createdA).toBeGreaterThanOrEqual(beforeA);
      expect(createdA).toBeLessThanOrEqual(afterA);
      expect(createdB).toBeGreaterThanOrEqual(beforeB);
      expect(createdB).toBeLessThanOrEqual(afterB);
      expect(createdB).toBeGreaterThanOrEqual(createdA);
    });
  });
});
