/**
 * SCRUM-484 AC8: changing a venue's setup or turnaround re-checks its
 * approved, not-yet-started bookings -- run against a real Postgres.
 *
 * When either minute really changes, update_venue flags (in the same transaction) every approved
 * booking whose event has not started and whose occupied period, padded with
 * the NEW minutes, now overlaps another approved booking or an active block.
 * The reason is stored as the code 'setup_or_turnaround_changed', each
 * flagged event's assigned coordinator is notified, and the flagged bookings
 * come back as {flagged_bookings}. These tests call the real function on the
 * final schema.
 *
 * Fixture (the test-case doc's): V at 0/0. On future day D: A approved
 * 10:00-12:00 (event EA, coordinator C1), B approved 12:30-14:00 (EB, C2),
 * C approved 16:00-17:00 (EC, C3), active block K 18:00-19:00, E approved
 * 19:15-20:00 (EE, C1). C4 is a coordinator assigned to nothing. Unless
 * stated, Venue Staff U calls update_venue(V, setup 30, turnaround 45).
 * After the change: A [09:30, 12:45) and B [12:00, 14:45) overlap; C
 * [15:30, 17:45) is clear; E [18:45, 20:45) overlaps K. Every test builds its
 * own venue and coordinators, so no test sees another's rows.
 *
 * Two decisions of the 2026-10-08 AC review hold: a flagged_for_review booking
 * counts as the other booking (it still occupies the room), and only clashes
 * the change CREATED are flagged -- a candidate already clashing under the old
 * minutes is left alone, so reducing the minutes never flags anything. The
 * tests that depend on the two decisions say so.
 *
 * Dates: update_venue uses now() for "not started", so D is the Singapore
 * date 10 days from when the test runs (at least 7, per the doc's Rules), and
 * "past" is D - 14. Instants are compared with getTime(), never as strings.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedBlock, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { expectSqlError, queriesFor } from './helpers/queries.js';
import { at, sgDate } from '../fixtures/time.js';

/** PAST: D - 14. */
const PAST = sgDate(-4);
const ms = (value) => new Date(value).getTime();
const iso = (value) => new Date(value).toISOString();

const REASON_CODE = 'setup_or_turnaround_changed';
const REASON_TEXT = 'Setup or turnaround time changed';
const SETUP_TYPE = 'booking_flagged_setup_change';
const UNASSIGNED = 'unassigned';

describe('SCRUM-484 AC8: update_venue re-checks bookings on a setup or turnaround change', () => {
  let db;
  let organiser;
  let staff;
  let bystander;
  let counter = 0;

  const { one, rows } = queriesFor(() => db);

  const makeUser = (role) => seedUser(db, { email: `u${++counter}@x`, role });

  const makeVenue = (setup = 0, turnaround = 0) =>
    seedVenue(db, { name: `Harbour Room ${++counter}`, setup, turnaround });

  /**
   * An approved event has a coordinator: the one named, or a fresh one.
   * UNASSIGNED is a rejected event reopened and resubmitted, which keeps its
   * bookings while it waits in the Lead's queue with no coordinator.
   */
  async function makeEvent(coordinatorId) {
    const unassigned = coordinatorId === UNASSIGNED;
    const assigned = unassigned ? null : coordinatorId ?? await makeUser('event_coordinator');
    counter += 1;
    return seedEvent(db, {
      status: unassigned ? 'submitted' : 'approved',
      organiser_id: organiser,
      assigned_coordinator_id: assigned,
      event_name: `Event ${counter}`,
      proposed_start: at('10:00'),
      proposed_end: at('12:00'),
      expected_attendance: 150,
    });
  }

  /** A raw block row, inserted directly. */
  const insertBlock = (venueId, startsAt, endsAt, removed = false) =>
    seedBlock(db, { venueId, start: startsAt, end: endsAt, removed });

  /**
   * A booking, written directly. A flagged_for_review one is flagged by a
   * block, as 014 writes it; that block is removed and far from D's events,
   * so it occupies nothing.
   */
  async function makeBooking(venueId, status, startsAt, endsAt, coordinatorId = null) {
    const eventId = await makeEvent(coordinatorId);
    let blockId = null;
    if (status === 'flagged_for_review') {
      blockId = await insertBlock(venueId, at('22:00'), at('23:00'), true);
    }
    return seedBooking(db, { venueId, eventId, status, start: startsAt, end: endsAt, reviewBlockId: blockId });
  }

  /** The doc's fixture: V at 0/0, A, B, C, K, E and coordinators C1-C4. */
  async function fixture({ setup = 0, turnaround = 0, ebCoordinator = true, order = 'AB' } = {}) {
    const V = await makeVenue(setup, turnaround);
    const C1 = await makeUser('event_coordinator');
    const C2 = await makeUser('event_coordinator');
    const C3 = await makeUser('event_coordinator');
    const C4 = await makeUser('event_coordinator');
    const ids = {};
    const makeA = async () => {
      ids.A = await makeBooking(V, 'approved', at('10:00'), at('12:00'), C1);
    };
    const makeB = async () => {
      ids.B = await makeBooking(V, 'approved', at('12:30'), at('14:00'), ebCoordinator ? C2 : UNASSIGNED);
    };
    if (order === 'AB') {
      await makeA();
      await makeB();
    } else {
      await makeB();
      await makeA();
    }
    ids.C = await makeBooking(V, 'approved', at('16:00'), at('17:00'), C3);
    ids.K = await insertBlock(V, at('18:00'), at('19:00'));
    ids.E = await makeBooking(V, 'approved', at('19:15'), at('20:00'), C1);
    return { V, C1, C2, C3, C4, ...ids };
  }

  /** update_venue with named arguments; returns its jsonb. */
  async function updateVenue(venueId, args = {}, userId = staff) {
    const names = Object.keys(args);
    const sql = `select update_venue(p_id => $1, ${names
      .map((n, i) => `p_${n} => $${i + 2}`)
      .join(', ')}${names.length ? ', ' : ''}p_user_id => $${names.length + 2}) as result`;
    return (await one(sql, [venueId, ...Object.values(args), userId])).result;
  }

  const change = (venueId, setup = 30, turnaround = 45) =>
    updateVenue(venueId, { setup_minutes: setup, turnaround_minutes: turnaround });

  const booking = async (id) => one('select * from bookings where id = $1', [id]);
  const status = async (id) => (await booking(id)).status;
  const flaggedIds = (result) => result.flagged_bookings.map((b) => b.booking_id);
  const notificationsFor = async (bookingIds) =>
    rows('select * from notifications where booking_id = any($1::uuid[]) order by created_at, id', [bookingIds]);

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await makeUser(null);
    staff = await makeUser('venue_staff');
    // An event coordinator no event is assigned to, in every test.
    bystander = await makeUser('event_coordinator');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });


  describe('schema: the flag, the reason and the notification types', () => {
    it('SCRUM484_AC8_flag_constraint_rejects_bad_direct_writes', async () => {
      const V = await makeVenue();
      const blockId = await insertBlock(V, at('22:00'), at('23:00'), true);
      const id = await makeBooking(V, 'approved', at('10:00'), at('12:00'));

      // (a) a flag time with neither a block nor a review reason still carries
      // a reason: the flag-reason trigger files it under the event-change category.
      await db.query('update bookings set flagged_at = now() where id = $1', [id]);
      expect((await booking(id)).flag_reason).toBe('event_change');
      await db.query('update bookings set flagged_at = null where id = $1', [id]);
      expect((await booking(id)).flag_reason).toBeNull();
      // (b) a reason without a flag time
      await expectSqlError(
        db.query('update bookings set review_reason = $2 where id = $1', [id, REASON_CODE]),
        '23514',
        'bookings_review_flag_paired',
      );
      // a reason that is not a known code
      await expectSqlError(
        db.query('update bookings set review_reason = $2, flagged_at = now() where id = $1', [id, 'because']),
        '23514',
        'bookings_review_reason_known',
      );
      // (c) a block flag, as 014 writes it
      await db.query(
        "update bookings set status = 'flagged_for_review', review_block_id = $2, flagged_at = now() where id = $1",
        [id, blockId],
      );
      // (d) a reason flag
      const other = await makeBooking(V, 'approved', at('13:00'), at('14:00'));
      await db.query(
        "update bookings set status = 'flagged_for_review', review_reason = $2, flagged_at = now() where id = $1",
        [other, REASON_CODE],
      );
      expect((await booking(id)).review_block_id).toBe(blockId);
      expect((await booking(other)).review_reason).toBe(REASON_CODE);
    });

    it('SCRUM484_AC8_clarification_types_are_accepted_by_the_type_list', async () => {
      const V = await makeVenue();
      const blockId = await insertBlock(V, at('22:00'), at('23:00'), true);
      const bookingId = await makeBooking(V, 'approved', at('10:00'), at('12:00'));
      const insert = (type, bId, kId) =>
        db.query('insert into notifications (recipient_id, type, booking_id, block_id) values ($1, $2, $3, $4)', [
          bystander,
          type,
          bId,
          kId,
        ]);

      await insert('booking_flagged', bookingId, blockId);
      await insert('booking_request_withdrawn', bookingId, null);
      // Refused since 031 dropped them; 034 lists them again.
      await insert('clarification_requested', null, null);
      await insert('clarification_replied', null, null);
      await insert('clarification_closed', null, null);
      await insert(SETUP_TYPE, bookingId, null);

      await expectSqlError(insert('nonsense', bookingId, null), '23514', 'notifications_type_known');
    });

    it('SCRUM484_AC8_new_type_needs_a_booking_but_not_a_block', async () => {
      const V = await makeVenue();
      const bookingId = await makeBooking(V, 'approved', at('10:00'), at('12:00'));
      const insert = (type, bId) =>
        db.query('insert into notifications (recipient_id, type, booking_id) values ($1, $2, $3)', [
          bystander,
          type,
          bId,
        ]);

      await insert(SETUP_TYPE, bookingId);
      await expectSqlError(insert(SETUP_TYPE, null), '23514', 'notifications_setup_change_needs_booking');
      // 014's rule for booking_flagged still holds: it needs a block.
      await expectSqlError(insert('booking_flagged', bookingId), '23514', 'notifications_booking_flagged_needs_refs');
    });

  });


  describe('behaviour: what the re-check flags', () => {
    it('SCRUM484_AC8_newly_overlapping_pair_are_both_flagged', async () => {
      const f = await fixture();
      const before = Date.now();

      await change(f.V);

      for (const id of [f.A, f.B]) {
        const row = await booking(id);
        expect(row.status, id).toBe('flagged_for_review');
        expect(row.review_reason).toBe(REASON_CODE);
        expect(row.review_block_id).toBeNull();
        expect(row.flagged_by).toBe(staff);
        expect(row.flagged_at).not.toBeNull();
        expect(ms(row.flagged_at)).toBeGreaterThanOrEqual(before - 1000);
        expect(ms(row.flagged_at)).toBeLessThanOrEqual(Date.now() + 1000);
      }
    });

    it('SCRUM484_AC8_flagging_does_not_depend_on_order', async () => {
      // Built both ways round, so whichever row the re-check meets first,
      // the overlap is judged on the pre-flag snapshot and both are flagged.
      for (const order of ['AB', 'BA']) {
        const f = await fixture({ order });
        const result = await change(f.V);
        expect(await status(f.A), order).toBe('flagged_for_review');
        expect(await status(f.B), order).toBe('flagged_for_review');
        expect(flaggedIds(result).sort(), order).toEqual([f.A, f.B, f.E].sort());
      }
    });

    it('SCRUM484_AC8_clear_booking_is_not_touched', async () => {
      const f = await fixture();
      const before = await booking(f.C);

      const result = await change(f.V);

      // bookings has no updated_at column, so the whole row is compared.
      expect(await booking(f.C)).toEqual(before);
      expect(before.status).toBe('approved');
      expect(before.flagged_at).toBeNull();
      expect(before.review_reason).toBeNull();
      expect(flaggedIds(result)).not.toContain(f.C);
    });

    it('SCRUM484_AC8_overlap_with_a_block_counts', async () => {
      const f = await fixture();
      const blockBefore = await one('select * from venue_blocks where id = $1', [f.K]);

      await change(f.V);

      const e = await booking(f.E);
      expect(e.status).toBe('flagged_for_review');
      expect(e.review_reason).toBe(REASON_CODE);
      // Flagged for the change, not by the block: no block is named.
      expect(e.review_block_id).toBeNull();
      expect(await one('select * from venue_blocks where id = $1', [f.K])).toEqual(blockBefore);
    });

    it('SCRUM484_AC8_touching_a_block_after_the_change_is_clear', async () => {
      const f = await fixture();
      const G = await makeBooking(f.V, 'approved', at('07:30'), at('08:00'));
      await insertBlock(f.V, at('06:00'), at('07:00'));

      const result = await change(f.V);

      // G occupies [07:00, 08:45): it only touches K2 and ends before A's 09:30.
      expect(await status(G)).toBe('approved');
      expect(flaggedIds(result)).not.toContain(G);
    });

    it('SCRUM484_AC8_past_bookings_are_not_rechecked', async () => {
      const f = await fixture();
      const P = await makeBooking(f.V, 'approved', at('10:00', PAST), at('12:00', PAST));
      const Q = await makeBooking(f.V, 'approved', at('12:30', PAST), at('14:00', PAST));

      const result = await change(f.V);

      // They would overlap after padding, as A and B do, but are in the past.
      expect(await status(P)).toBe('approved');
      expect(await status(Q)).toBe('approved');
      expect(flaggedIds(result)).not.toContain(P);
      expect(flaggedIds(result)).not.toContain(Q);
    });

    it('SCRUM484_AC8_started_event_is_not_flagged_but_still_occupies', async () => {
      const f = await fixture();
      const now = Date.now();
      const sEnd = now + 60 * 60_000;
      const S = await makeBooking(f.V, 'approved', iso(now - 30 * 60_000), iso(sEnd));
      const T = await makeBooking(f.V, 'approved', iso(sEnd + 20 * 60_000), iso(sEnd + 80 * 60_000));

      const result = await change(f.V);

      // S has started: never a candidate. T's 30-minute setup reaches back
      // into S's 45-minute turnaround, and S is approved, so T is flagged.
      expect(await status(S)).toBe('approved');
      expect(await status(T)).toBe('flagged_for_review');
      expect(flaggedIds(result)).toContain(T);
      expect(flaggedIds(result)).not.toContain(S);
    });

    it('SCRUM484_AC8_already_flagged_booking_is_left_alone', async () => {
      const f = await fixture();
      const F = await makeBooking(f.V, 'flagged_for_review', at('14:15'), at('14:45'));
      const before = await booking(F);

      const result = await change(f.V);

      // Since 035 F also counts as the other booking. Padded it occupies
      // [13:45, 15:30): it meets B (flagged anyway, for A) and only touches
      // C's [15:30, 17:45), so the flagged set is the fixture's A, B, E.
      expect(flaggedIds(result).sort()).toEqual([f.A, f.B, f.E].sort());
      const after = await booking(F);
      expect(after).toEqual(before);
      expect(after.review_block_id).not.toBeNull();
      expect(after.review_reason).toBeNull();
      expect(flaggedIds(result)).not.toContain(F);
      expect(await notificationsFor([F])).toEqual([]);
    });

    it('SCRUM484_AC8_flagged_booking_counts_as_the_other_booking', async () => {
      // Reversed by the user's 2026-10-08 AC review decision (035): this was
      // SCRUM484_AC8_flagged_booking_is_not_the_other_booking, which held
      // under 034's "another APPROVED booking". A flagged booking still holds
      // the room everywhere else (032), so it holds it here too.
      //
      // At 0/0, A (approved) 10:00-12:00 and F (already flagged) 12:30-13:00
      // are 30 minutes apart: no clash before the change. At 30/45, A
      // occupies [09:30, 12:45) and F [12:00, 13:45): they now overlap, so A
      // is flagged. F is already flagged, so it is never a candidate and is
      // left exactly as it was.
      const V = await makeVenue();
      const C1 = await makeUser('event_coordinator');
      const A = await makeBooking(V, 'approved', at('10:00'), at('12:00'), C1);
      const F = await makeBooking(V, 'flagged_for_review', at('12:30'), at('13:00'), C1);
      const fBefore = await booking(F);

      const result = await change(V);

      const a = await booking(A);
      expect(a.status).toBe('flagged_for_review');
      expect(a.review_reason).toBe(REASON_CODE);
      expect(a.review_block_id).toBeNull();
      expect(flaggedIds(result)).toEqual([A]);
      expect(ms(result.flagged_bookings[0].occupied_starts_at)).toBe(ms(at('09:30')));
      expect(ms(result.flagged_bookings[0].occupied_ends_at)).toBe(ms(at('12:45')));
      expect(await booking(F)).toEqual(fBefore);
      // A's coordinator is told about A; nothing is written for F.
      expect((await notificationsFor([A])).map((n) => n.recipient_id)).toEqual([C1]);
      expect(await notificationsFor([F])).toEqual([]);
    });

    it('SCRUM484_AC8_cancelled_and_pending_neither_change_nor_cause_flags', async () => {
      const f = await fixture();
      const X = await makeBooking(f.V, 'cancelled', at('14:50'), at('15:20'));
      const W = await makeBooking(f.V, 'pending', at('14:50'), at('15:20'));

      const result = await change(f.V);

      expect(await status(X)).toBe('cancelled');
      expect(await status(W)).toBe('pending');
      // C's [15:30, 17:45) would meet X's or W's padded period, but neither occupies.
      expect(await status(f.C)).toBe('approved');
      expect(flaggedIds(result)).not.toContain(f.C);
      expect(await notificationsFor([X, W, f.C])).toEqual([]);
    });

    it('SCRUM484_AC8_reducing_the_times_flags_nothing', async () => {
      const V = await makeVenue(30, 45);
      const C1 = await makeUser('event_coordinator');
      const A = await makeBooking(V, 'approved', at('10:00'), at('12:00'), C1);
      const B = await makeBooking(V, 'approved', at('13:15'), at('14:00'), C1);

      const result = await change(V, 15, 15);

      expect(result).toEqual({ flagged_bookings: [] });
      expect(await status(A)).toBe('approved');
      expect(await status(B)).toBe('approved');
      expect(await notificationsFor([A, B])).toEqual([]);
    });

    it('SCRUM484_AC8_reducing_does_not_unflag', async () => {
      const V = await makeVenue(30, 45);
      const B = await makeBooking(V, 'approved', at('12:30'), at('14:00'));
      await db.query(
        "update bookings set status = 'flagged_for_review', review_reason = $2, flagged_at = now(), flagged_by = $3 where id = $1",
        [B, REASON_CODE, staff],
      );
      const before = await booking(B);

      const result = await change(V, 0, 0);

      expect(result).toEqual({ flagged_bookings: [] });
      expect(await booking(B)).toEqual(before);
    });

    it('SCRUM484_AC8_going_back_to_zero_flags_and_unflags_nothing', async () => {
      const f = await fixture();
      await change(f.V);
      const all = [f.A, f.B, f.C, f.E];
      const before = await Promise.all(all.map(booking));
      const notesBefore = await notificationsFor(all);

      const result = await change(f.V, 0, 0);

      expect(result).toEqual({ flagged_bookings: [] });
      expect(await Promise.all(all.map(booking))).toEqual(before);
      expect(await notificationsFor(all)).toEqual(notesBefore);
    });

    it('SCRUM484_AC8_unchanged_minutes_trigger_no_recheck', async () => {
      // Bad seed: A and A2 already overlap at 0/0. AC8 is about what a
      // CHANGE caused, so an edit that leaves both minutes alone flags neither.
      const V = await makeVenue(0, 0);
      const A = await makeBooking(V, 'approved', at('10:00'), at('12:00'));
      const A2 = await makeBooking(V, 'approved', at('10:30'), at('11:00'));

      const renamed = await updateVenue(V, { name: `Harbour Room 2 ${V}` });
      const same = await updateVenue(V, { setup_minutes: 0 });

      expect(renamed).toEqual({ flagged_bookings: [] });
      expect(same).toEqual({ flagged_bookings: [] });
      expect(await status(A)).toBe('approved');
      expect(await status(A2)).toBe('approved');
      expect(await notificationsFor([A, A2])).toEqual([]);
    });

    it('SCRUM484_AC8_unknown_venue_raises_no_data_found', async () => {
      const missing = (await one('select gen_random_uuid() as id')).id;
      await expectSqlError(change(missing), 'P0002');
    });
  });


  describe('behaviour: only clashes the change created are flagged', () => {
    // The user's 2026-10-08 AC review decision: a booking already clashing
    // under the OLD minutes was not put there by this change, so it is left
    // alone; reducing the minutes therefore never flags anything.

    it('SCRUM484_AC8_a_clash_that_existed_before_the_change_is_not_flagged', async () => {
      // V at 30/45. A 10:00-12:00 occupies [09:30, 12:45); B 12:30-14:00
      // occupies [12:00, 14:45): they already overlap by 45 minutes. Turnaround
      // 45 -> 60: A [09:30, 13:00), B [12:00, 15:00) -- still overlapping, but
      // the clash is not new, so neither is flagged.
      const V = await makeVenue(30, 45);
      const C1 = await makeUser('event_coordinator');
      const C2 = await makeUser('event_coordinator');
      const A = await makeBooking(V, 'approved', at('10:00'), at('12:00'), C1);
      const B = await makeBooking(V, 'approved', at('12:30'), at('14:00'), C2);
      const period = async (id, setup, turnaround) => {
        const r = await one(
          `select lower(p) as s, upper(p) as e
             from (select venue_occupied_period(starts_at, ends_at, $2, $3) as p from bookings where id = $1) x`,
          [id, setup, turnaround],
        );
        return [ms(r.s), ms(r.e)];
      };
      // The arithmetic above, checked against 032's function.
      expect(await period(A, 30, 45)).toEqual([ms(at('09:30')), ms(at('12:45'))]);
      expect(await period(B, 30, 45)).toEqual([ms(at('12:00')), ms(at('14:45'))]);
      expect(await period(A, 30, 60)).toEqual([ms(at('09:30')), ms(at('13:00'))]);
      expect(await period(B, 30, 60)).toEqual([ms(at('12:00')), ms(at('15:00'))]);
      const before = [await booking(A), await booking(B)];

      const result = await updateVenue(V, { turnaround_minutes: 60 });

      expect(result).toEqual({ flagged_bookings: [] });
      expect([await booking(A), await booking(B)]).toEqual(before);
      expect(await notificationsFor([A, B])).toEqual([]);
      // The change itself went through.
      expect(await one('select setup_minutes, turnaround_minutes from venues where id = $1', [V])).toEqual({
        setup_minutes: 30,
        turnaround_minutes: 60,
      });
    });

    it('SCRUM484_AC8_reducing_never_flags_even_with_an_existing_clash', async () => {
      // V at 30/45 with A [09:30, 12:45) and B [12:00, 14:45) already
      // overlapping. Setup 30 -> 15: A [09:45, 12:45), B [12:15, 14:45) still
      // overlap. 034 flagged both here (it looked only at the new minutes);
      // 035 flags nothing, because reducing can only shrink the clashing set.
      const V = await makeVenue(30, 45);
      const C1 = await makeUser('event_coordinator');
      const A = await makeBooking(V, 'approved', at('10:00'), at('12:00'), C1);
      const B = await makeBooking(V, 'approved', at('12:30'), at('14:00'), C1);
      const before = [await booking(A), await booking(B)];

      const result = await updateVenue(V, { setup_minutes: 15 });

      expect(result).toEqual({ flagged_bookings: [] });
      expect([await booking(A), await booking(B)]).toEqual(before);
      expect(await notificationsFor([A, B])).toEqual([]);
      expect(await rows('select 1 from notifications where recipient_id = $1', [C1])).toEqual([]);
      expect((await one('select setup_minutes from venues where id = $1', [V])).setup_minutes).toBe(15);
    });

    it('SCRUM484_AC8_only_the_new_member_of_a_clash_is_flagged', async () => {
      // V at 30/45 (setup 30, turnaround 45).
      //   A 10:00-12:00 -> [09:30, 12:45)
      //   B 12:30-14:00 -> [12:00, 14:45)   A and B already overlap.
      //   C 15:20-16:00 -> [14:50, 16:45)   clear of B by 5 minutes.
      // Turnaround 45 -> 60:
      //   A -> [09:30, 13:00), B -> [12:00, 15:00), C -> [14:50, 17:00).
      //   A and B still overlap (old clash: neither flagged); C now overlaps
      //   B on [14:50, 15:00) -- a clash this change created -- so only C is
      //   flagged. B is in the new clash too, but it already clashed with A
      //   under the old minutes, so it is in the old set and left alone.
      const V = await makeVenue(30, 45);
      const C1 = await makeUser('event_coordinator');
      const C2 = await makeUser('event_coordinator');
      const C3 = await makeUser('event_coordinator');
      const A = await makeBooking(V, 'approved', at('10:00'), at('12:00'), C1);
      const B = await makeBooking(V, 'approved', at('12:30'), at('14:00'), C2);
      const C = await makeBooking(V, 'approved', at('15:20'), at('16:00'), C3);
      // Before: C clears B; A and B clash (032's function, padded, at 30/45).
      const clashes = async (id) =>
        (
          await rows(
            `select c.id from bookings b, venue_occupancy_conflicts(b.venue_id, b.starts_at, b.ends_at, true) c
              where b.id = $1 and c.kind = 'booking' and c.id <> b.id order by c.id`,
            [id],
          )
        ).map((r) => r.id);
      expect(await clashes(A)).toEqual([B]);
      expect(await clashes(C)).toEqual([]);
      const before = { A: await booking(A), B: await booking(B) };

      const result = await updateVenue(V, { turnaround_minutes: 60 });

      // After: C meets B, and A and B still meet.
      expect(await clashes(C)).toEqual([B]);
      expect(await clashes(A)).toEqual([B]);

      expect(flaggedIds(result)).toEqual([C]);
      const [row] = result.flagged_bookings;
      expect(ms(row.starts_at)).toBe(ms(at('15:20')));
      expect(ms(row.ends_at)).toBe(ms(at('16:00')));
      expect(ms(row.occupied_starts_at)).toBe(ms(at('14:50')));
      expect(ms(row.occupied_ends_at)).toBe(ms(at('17:00')));
      expect(row.setup_minutes).toBe(30);
      expect(row.turnaround_minutes).toBe(60);

      const c = await booking(C);
      expect(c.status).toBe('flagged_for_review');
      expect(c.review_reason).toBe(REASON_CODE);
      expect(c.flagged_by).toBe(staff);
      expect(await booking(A)).toEqual(before.A);
      expect(await booking(B)).toEqual(before.B);

      // Only C's coordinator is told, with C's new occupied period.
      const notes = await notificationsFor([A, B, C]);
      expect(notes.map((n) => [n.recipient_id, n.booking_id])).toEqual([[C3, C]]);
      expect(ms(notes[0].payload.occupiedStartsAt)).toBe(ms(at('14:50')));
      expect(ms(notes[0].payload.occupiedEndsAt)).toBe(ms(at('17:00')));
      expect(notes[0].payload.turnaroundMinutes).toBe(60);
    });

    it('SCRUM484_AC8_name_only_edit_skips_the_old_clash_check', async () => {
      // Observed by wrapping venue_occupancy_conflicts, inside a transaction
      // that is rolled back, with a stand-in that logs the venue's minutes at
      // the moment it is asked and then calls the real function. A call made
      // with the OLD minutes can only be the old-set check (before
      // the venues row is updated); one with the new minutes is the re-check.
      const V = await makeVenue(0, 0);
      const A = await makeBooking(V, 'approved', at('10:00'), at('12:00'));
      await makeBooking(V, 'approved', at('12:30'), at('14:00'));

      await db.exec('begin');
      try {
        await db.exec(`
          create temp table occupancy_calls (n serial, setup integer, turnaround integer);
          alter function venue_occupancy_conflicts(uuid, timestamptz, timestamptz, boolean, uuid)
            rename to venue_occupancy_conflicts_real;
          create function venue_occupancy_conflicts(
            p_venue_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_pad_requested boolean,
            p_exclude_hold_event_id uuid default null
          )
          returns table (
            kind text, id uuid, status booking_status, event_request_id uuid, event_name text,
            reason venue_block_reason, starts_at timestamptz, ends_at timestamptz,
            occupied_starts_at timestamptz, occupied_ends_at timestamptz,
            setup_minutes integer, turnaround_minutes integer
          )
          language plpgsql volatile as $w$
          begin
            insert into occupancy_calls (setup, turnaround)
            select v.setup_minutes, v.turnaround_minutes from venues v where v.id = p_venue_id;
            return query select * from venue_occupancy_conflicts_real(
              p_venue_id, p_starts_at, p_ends_at, p_pad_requested, p_exclude_hold_event_id);
          end;
          $w$;
        `);
        const calls = async () => rows('select setup, turnaround from occupancy_calls order by n');

        // A name-only edit, and one that passes the same minutes: neither
        // asks the shared function anything.
        await updateVenue(V, { name: `Renamed ${V}` });
        await updateVenue(V, { setup_minutes: 0, turnaround_minutes: 0 });
        expect(await calls()).toEqual([]);

        // Control: a real change asks it once per candidate with the old
        // minutes (the old set, 0/0), then once per candidate with the new
        // (the re-check, 30/45). Two approved candidates here.
        const result = await change(V);
        expect(await calls()).toEqual([
          { setup: 0, turnaround: 0 },
          { setup: 0, turnaround: 0 },
          { setup: 30, turnaround: 45 },
          { setup: 30, turnaround: 45 },
        ]);
        // And the wrapper changed nothing about the answer.
        expect(flaggedIds(result)).toContain(A);
      } finally {
        await db.exec('rollback');
      }
      // The real function is back under its own name.
      expect(
        (await one("select count(*)::int as n from pg_proc where proname = 'venue_occupancy_conflicts_real'")).n,
      ).toBe(0);
    });
  });


  describe('behaviour: who is told, what comes back, what is kept', () => {
    it('SCRUM484_AC8_only_the_assigned_coordinator_is_notified', async () => {
      const f = await fixture();
      const { now: startedAt } = await one('select now() as now');

      await change(f.V);

      const notes = await rows(
        `select n.recipient_id, n.booking_id, n.block_id, n.type
           from notifications n
           join bookings b on b.id = n.booking_id
          where b.venue_id = $1`,
        [f.V],
      );
      expect(notes.every((n) => n.type === SETUP_TYPE)).toBe(true);
      expect(notes.every((n) => n.block_id === null)).toBe(true);
      const pairs = notes.map((n) => `${n.recipient_id}:${n.booking_id}`).sort();
      expect(pairs).toEqual([`${f.C1}:${f.A}`, `${f.C1}:${f.E}`, `${f.C2}:${f.B}`].sort());

      // C3 (clear booking), C4 (no event) and any other coordinator get
      // nothing from this change. (The schema tests wrote rows to the
      // bystander directly, so only this change's rows -- notifications of
      // this type created since it started -- are looked at.)
      for (const nobody of [f.C3, f.C4, bystander]) {
        expect(
          await rows('select 1 from notifications where recipient_id = $1 and type = $2 and created_at >= $3', [
            nobody,
            SETUP_TYPE,
            startedAt,
          ]),
          nobody,
        ).toEqual([]);
      }
    });

    it('SCRUM484_AC8_notification_payload_names_the_new_occupied_period', async () => {
      const f = await fixture();
      const { name: venueName } = await one('select name from venues where id = $1', [f.V]);
      const { event_name: eventName } = await one(
        'select er.event_name from event_requests er join bookings b on b.event_request_id = er.id where b.id = $1',
        [f.A],
      );

      await change(f.V);

      const [note] = await notificationsFor([f.A]);
      const p = note.payload;
      expect(Object.keys(p).sort()).toEqual(
        [
          'venueName',
          'eventName',
          'startsAt',
          'endsAt',
          'occupiedStartsAt',
          'occupiedEndsAt',
          'setupMinutes',
          'turnaroundMinutes',
          'reason',
        ].sort(),
      );
      expect(p.venueName).toBe(venueName);
      expect(p.eventName).toBe(eventName);
      expect(ms(p.startsAt)).toBe(ms(at('10:00')));
      expect(ms(p.endsAt)).toBe(ms(at('12:00')));
      expect(ms(p.occupiedStartsAt)).toBe(ms(at('09:30')));
      expect(ms(p.occupiedEndsAt)).toBe(ms(at('12:45')));
      expect(p.setupMinutes).toBe(30);
      expect(p.turnaroundMinutes).toBe(45);
      expect(p.reason).toBe(REASON_TEXT);
    });

    it('SCRUM484_AC8_unassigned_event_is_flagged_without_a_notification', async () => {
      const f = await fixture({ ebCoordinator: false });

      const result = await change(f.V);

      expect(await status(f.B)).toBe('flagged_for_review');
      expect(flaggedIds(result)).toContain(f.B);
      expect(await notificationsFor([f.B])).toEqual([]);
      // The others are still told.
      expect((await notificationsFor([f.A, f.E])).length).toBe(2);
    });

    it('SCRUM484_AC8_nothing_is_cancelled_or_removed', async () => {
      const f = await fixture();
      const counts = async () => ({
        statuses: await rows(
          'select status::text as status, count(*)::int as n from bookings where venue_id = $1 group by 1 order by 1',
          [f.V],
        ),
        bookings: (await one('select count(*)::int as n from bookings where venue_id = $1', [f.V])).n,
        blocks: (await one('select count(*)::int as n from venue_blocks where venue_id = $1', [f.V])).n,
        activeBlocks: (await one('select count(*)::int as n from venue_blocks where venue_id = $1 and removed_at is null', [f.V])).n,
      });
      const before = await counts();

      await change(f.V);

      const after = await counts();
      expect(before.statuses).toEqual([{ status: 'approved', n: 4 }]);
      expect(after.statuses).toEqual([
        { status: 'approved', n: 1 },
        { status: 'flagged_for_review', n: 3 },
      ]);
      expect(after.bookings).toBe(before.bookings);
      expect(after.blocks).toBe(before.blocks);
      expect(after.activeBlocks).toBe(before.activeBlocks);
    });

    it('SCRUM484_AC8_returns_exactly_the_flagged_bookings_soonest_first', async () => {
      const f = await fixture();

      const result = await change(f.V);

      expect(Object.keys(result)).toEqual(['flagged_bookings']);
      const list = result.flagged_bookings;
      expect(list.map((b) => b.booking_id)).toEqual([f.A, f.B, f.E]);
      const events = await rows('select id, event_request_id from bookings where id = any($1::uuid[])', [
        [f.A, f.B, f.E],
      ]);
      const eventOf = Object.fromEntries(events.map((r) => [r.id, r.event_request_id]));
      const expected = {
        [f.A]: ['10:00', '12:00', '09:30', '12:45'],
        [f.B]: ['12:30', '14:00', '12:00', '14:45'],
        [f.E]: ['19:15', '20:00', '18:45', '20:45'],
      };
      for (const row of list) {
        // The block-conflict row shape (033), so the service maps it the same way.
        expect(Object.keys(row).sort()).toEqual(
          [
            'booking_id',
            'event_request_id',
            'event_name',
            'starts_at',
            'ends_at',
            'occupied_starts_at',
            'occupied_ends_at',
            'setup_minutes',
            'turnaround_minutes',
          ].sort(),
        );
        const [s, e, os, oe] = expected[row.booking_id];
        expect(row.event_request_id).toBe(eventOf[row.booking_id]);
        expect(row.event_name).toMatch(/^Event \d+$/);
        expect(ms(row.starts_at)).toBe(ms(at(s)));
        expect(ms(row.ends_at)).toBe(ms(at(e)));
        expect(ms(row.occupied_starts_at)).toBe(ms(at(os)));
        expect(ms(row.occupied_ends_at)).toBe(ms(at(oe)));
        expect(row.setup_minutes).toBe(30);
        expect(row.turnaround_minutes).toBe(45);
      }
      // And every booking flagged is listed, no more.
      const flagged = await rows(
        "select id from bookings where venue_id = $1 and status = 'flagged_for_review' order by starts_at",
        [f.V],
      );
      expect(flagged.map((r) => r.id)).toEqual([f.A, f.B, f.E]);
    });
  });


  describe('AC9: the change is audited once', () => {
    const history = (venueId) =>
      rows('select * from venue_change_history where venue_id = $1 order by changed_at, id', [venueId]);

    it('SCRUM484_AC9_recheck_adds_no_extra_history_rows', async () => {
      const f = await fixture();
      const before = await history(f.V);
      const startedAt = Date.now();

      const result = await change(f.V);

      expect(flaggedIds(result)).toHaveLength(3);
      const after = await history(f.V);
      expect(after).toHaveLength(before.length + 1);
      const [row] = after.slice(before.length);
      expect(row.changed_by).toBe(staff);
      expect(row.old_values).toEqual({ setup_minutes: 0, turnaround_minutes: 0 });
      expect(row.new_values).toEqual({ setup_minutes: 30, turnaround_minutes: 45 });
      expect(ms(row.changed_at)).toBeGreaterThanOrEqual(startedAt - 1000);
      expect(ms(row.changed_at)).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it('SCRUM484_AC9_unchanged_edit_writes_no_history_row', async () => {
      const f = await fixture();
      const before = await history(f.V);

      await change(f.V, 0, 0);

      expect(await history(f.V)).toEqual(before);
    });
  });
});
