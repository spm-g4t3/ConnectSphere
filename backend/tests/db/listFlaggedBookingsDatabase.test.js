/**
 * Venue Staff list the bookings flagged for review, against the final schema
 * in a real Postgres.
 *
 * SCRUM-266 AC1 at the SQL level: only flagged bookings are listed, oldest
 * flag first, each with what flagged it (a block, a review reason, or both
 * when a safety flag sits on a block's), the event and the venue.
 *
 * The database is shared by every case, so each case reads only the rows it
 * made, except the empty list, which runs first.
 *
 * Dates: D is the Singapore date 10 days from now, never hard-coded, because
 * a block or hold counts only while it has not ended.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, returnToLeadQueue, seedEvent } from './helpers/schemaDb.js';

/** D: the Singapore date 10 days from now, as YYYY-MM-DD. */
const D = new Date(Date.now() + 8 * 3600_000 + 10 * 86_400_000).toISOString().slice(0, 10);
/** An instant on D, written at +08:00 (Singapore). */
const at = (hhmm) => `${D}T${hhmm}:00+08:00`;
/** The same instant whatever offset jsonb wrote it with. */
const ms = (value) => new Date(value).getTime();

const NO_ONE = '00000000-0000-4000-8000-000000000000';

/** Every key list_flagged_bookings writes on an element, in no particular order. */
const KEYS = [
  'id', 'event_request_id', 'venue_id', 'starts_at', 'ends_at',
  'occupied_starts_at', 'occupied_ends_at', 'flagged_at', 'flagged_by', 'review_reason',
  'event_name', 'event_status', 'event_starts_at', 'event_ends_at', 'assigned_coordinator_id',
  'venue_name', 'venue_location', 'block_id', 'block_reason', 'block_notes',
  'block_starts_at', 'block_ends_at', 'block_removed_at', 'reinstatable', 'replacement_requests',
];

/** The error a promise rejected with; null if it resolved. */
const refusal = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
};

describe('SCRUM-266 AC1: listing flagged bookings', () => {
  let db;
  let organiser;
  let coordinator;
  let staff;
  let counter = 0;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

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

  function makeEvent({ status = 'approved', start = at('14:00'), end = at('16:00') } = {}) {
    counter += 1;
    return seedEvent(db, {
      status,
      organiser_id: organiser,
      assigned_coordinator_id: coordinator,
      event_name: `Event ${counter}`,
      proposed_start: start,
      proposed_end: end,
      expected_attendance: 150,
    });
  }

  /** A pending booking for the event's own period, written directly. */
  async function insertBooking(eventId, venueId) {
    const event = await one('select proposed_start, proposed_end from event_requests where id = $1', [eventId]);
    return (
      await one(
        `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
         values ($1, $2, $3, $4, 'pending') returning id`,
        [venueId, eventId, event.proposed_start, event.proposed_end],
      )
    ).id;
  }

  const decide = async (bookingId, decision = 'approve', reason = null) =>
    (
      await one('select decide_booking_request($1, $2, $3, $4, null) as result', [
        bookingId,
        staff,
        decision,
        reason,
      ])
    ).result;

  /** A booking approved by Venue Staff, so its decision is recorded. */
  async function approved(venueId, eventId) {
    const id = await insertBooking(eventId, venueId);
    expect((await decide(id)).outcome).toBe('approved');
    return id;
  }

  /** A block over start-end, created with the override that flags bookingIds. */
  async function blockFlagging(venueId, start, end, bookingIds, notes = null) {
    const { result } = await one(
      `select create_venue_block($1, $2, $3, 'maintenance', $6, $4, true, $5::uuid[]) as result`,
      [venueId, start, end, staff, bookingIds, notes],
    );
    expect(result.outcome).toBe('created');
    return result.block.id;
  }

  /**
   * An approved booking flagged by a block over 15:00-17:00 on its venue: an
   * event 14:00-16:00 at a fresh venue unless one is given.
   */
  async function flagged({ venueId, eventId, notes } = {}) {
    const venue = venueId ?? (await makeVenue());
    const event = eventId ?? (await makeEvent());
    const id = await approved(venue, event);
    const blockId = await blockFlagging(venue, at('15:00'), at('17:00'), [id], notes);
    expect((await bookingRow(id)).status).toBe('flagged_for_review');
    return { id, venueId: venue, eventId: event, blockId };
  }

  /** An approved booking flagged by a reason rather than a block, as a venue setup change or a safety review flags them. */
  async function flaggedFor(reviewReason, { eventId } = {}) {
    const venueId = await makeVenue();
    const event = eventId ?? (await makeEvent());
    const id = await approved(venueId, event);
    await db.query(
      `update bookings
          set status = 'flagged_for_review', review_reason = $2, flagged_at = now(), flagged_by = $3
        where id = $1`,
      [id, reviewReason, staff],
    );
    return { id, venueId, eventId: event };
  }

  /** A booking flagged before flags were recorded: flagged_for_review with no time, block or reason. */
  async function flaggedBefore014() {
    const venueId = await makeVenue();
    const eventId = await makeEvent();
    const id = await insertBooking(eventId, venueId);
    await db.query(`update bookings set status = 'flagged_for_review' where id = $1`, [id]);
    return { id, venueId, eventId };
  }

  const list = async (caller = staff) =>
    (await one('select list_flagged_bookings($1) as result', [caller])).result;

  /** The listed elements for these ids, in the order the function gave them. */
  const listedOnly = async (ids) => (await list()).filter((row) => ids.includes(row.id));
  const listedOne = async (id) => {
    const found = await listedOnly([id]);
    expect(found).toHaveLength(1);
    return found[0];
  };

  const bookingRow = (id) => one('select * from bookings where id = $1', [id]);

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await makeUser('o@x', 'event_organiser');
    coordinator = await makeUser('c@x', 'event_coordinator');
    staff = await makeUser('s@x', 'venue_staff');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  // First, while nothing is flagged.
  it('SCRUM266_AC1_nothing_flagged_is_an_empty_array', async () => {
    await approved(await makeVenue(), await makeEvent());

    expect(await list()).toEqual([]);
  });

  describe('who can list them', () => {
    it.each([
      ['a coordinator', () => coordinator],
      ['an organiser', () => organiser],
      ['a null caller', () => null],
      ['a user with no profile', () => NO_ONE],
    ])('SCRUM266_AC1_%s_is_refused_with_42501', async (_label, caller) => {
      await flagged();

      expect((await refusal(list(caller())))?.code).toBe('42501');
    });

    it('SCRUM266_AC1_the_function_is_not_granted_to_anon_or_authenticated', async () => {
      const grants = await one(
        `select has_function_privilege('anon', 'list_flagged_bookings(uuid)', 'execute') as anon,
                has_function_privilege('authenticated', 'list_flagged_bookings(uuid)', 'execute') as authenticated`,
      );
      expect(grants).toEqual({ anon: false, authenticated: false });
    });
  });

  describe('which bookings are listed', () => {
    it('SCRUM266_AC1_only_flagged_bookings_are_listed', async () => {
      const event = await makeEvent();
      const pending = await insertBooking(event, await makeVenue());
      const approvedId = await approved(await makeVenue(), event);
      const rejected = await insertBooking(event, await makeVenue());
      await decide(rejected, 'reject', 'No');
      const withdrawn = await insertBooking(event, await makeVenue());
      await db.query(`update bookings set status = 'withdrawn' where id = $1`, [withdrawn]);
      const cancelled = await insertBooking(event, await makeVenue());
      await db.query(`update bookings set status = 'cancelled' where id = $1`, [cancelled]);
      const isFlagged = (await flagged({ eventId: event })).id;

      const statuses = await Promise.all(
        [pending, approvedId, rejected, withdrawn, cancelled].map(async (id) => (await bookingRow(id)).status),
      );
      expect(statuses).toEqual(['pending', 'approved', 'rejected', 'withdrawn', 'cancelled']);

      const listed = await listedOnly([pending, approvedId, rejected, withdrawn, cancelled, isFlagged]);
      expect(listed.map((row) => row.id)).toEqual([isFlagged]);
    });

    it('SCRUM266_AC1_every_listed_booking_is_flagged_for_review', async () => {
      const ids = (await list()).map((row) => row.id);
      expect(ids.length).toBeGreaterThan(0);
      const { count } = await one(
        `select count(*)::int as count from bookings where id = any($1::uuid[]) and status <> 'flagged_for_review'`,
        [ids],
      );
      expect(count).toBe(0);
      const { flaggedCount } = await one(
        `select count(*)::int as "flaggedCount" from bookings where status = 'flagged_for_review'`,
      );
      expect(ids).toHaveLength(flaggedCount);
    });

    it('SCRUM266_AC1_a_reinstated_booking_drops_out', async () => {
      const { id, venueId, blockId } = await flagged();
      expect(await listedOnly([id])).toHaveLength(1);

      await one('select remove_venue_block($1, $2, $3)', [venueId, blockId, staff]);
      const { result } = await one('select reinstate_flagged_booking($1, $2, $3) as result', [
        id,
        staff,
        'Block removed',
      ]);
      expect(result.outcome).toBe('reinstated');

      expect(await listedOnly([id])).toEqual([]);
    });

    it('SCRUM266_AC1_a_cancelled_flagged_booking_drops_out', async () => {
      const { id } = await flagged();
      expect(await listedOnly([id])).toHaveLength(1);

      const { result } = await one('select cancel_flagged_booking($1, $2, $3) as result', [
        id,
        coordinator,
        'Venue no longer fits',
      ]);
      expect(result.outcome).toBe('cancelled');

      expect(await listedOnly([id])).toEqual([]);
    });

    it('SCRUM266_AC1_oldest_flag_first_with_a_pre_014_flag_first_then_created_at_then_id', async () => {
      const early = '2026-01-01T00:00:00+00:00';
      const late = '2026-02-01T00:00:00+00:00';
      const newest = (await flagged()).id;
      const tieLater = (await flagged()).id;
      const tieEarlier = (await flagged()).id;
      const pre014 = (await flaggedBefore014()).id;
      const sameA = (await flaggedFor('setup_or_turnaround_changed')).id;
      const sameB = (await flaggedFor('setup_or_turnaround_changed')).id;

      const set = (id, flaggedAt, createdAt) =>
        db.query('update bookings set flagged_at = $2, created_at = $3 where id = $1', [id, flaggedAt, createdAt]);
      await set(newest, late, '2025-01-01T00:00:00+00:00');
      await set(tieLater, early, '2025-06-02T00:00:00+00:00');
      await set(tieEarlier, early, '2025-06-01T00:00:00+00:00');
      await set(sameA, early, '2025-07-01T00:00:00+00:00');
      await set(sameB, early, '2025-07-01T00:00:00+00:00');
      // The row with no flag time was created last, and still comes first.
      await db.query(`update bookings set created_at = '2025-12-01T00:00:00+00:00' where id = $1`, [pre014]);
      const [firstSame, secondSame] = [sameA, sameB].sort();

      const listed = await listedOnly([newest, tieLater, tieEarlier, pre014, sameA, sameB]);

      expect(listed.map((row) => row.id)).toEqual([pre014, tieEarlier, tieLater, firstSame, secondSame, newest]);
      expect(listed[0]).toMatchObject({
        flagged_at: null,
        flagged_by: null,
        review_reason: null,
        block_id: null,
        reinstatable: true,
      });
    });
  });

  describe('what flagged each booking', () => {
    it('SCRUM266_AC1_a_block_flag_shows_the_block_reason_notes_and_period', async () => {
      const { id, blockId } = await flagged({ notes: 'Roof repair' });

      const row = await listedOne(id);

      expect(row).toMatchObject({
        block_id: blockId,
        block_reason: 'maintenance',
        block_notes: 'Roof repair',
        block_removed_at: null,
        review_reason: null,
        flagged_by: staff,
        reinstatable: true,
      });
      expect(ms(row.block_starts_at)).toBe(ms(at('15:00')));
      expect(ms(row.block_ends_at)).toBe(ms(at('17:00')));
      expect(row.flagged_at).not.toBeNull();
    });

    it('SCRUM266_AC1_a_removed_block_shows_when_it_was_removed_and_the_booking_stays_flagged', async () => {
      const { id, venueId, blockId } = await flagged();

      await one('select remove_venue_block($1, $2, $3)', [venueId, blockId, staff]);

      const row = await listedOne(id);
      const block = await one('select removed_at from venue_blocks where id = $1', [blockId]);
      expect(row.block_id).toBe(blockId);
      expect(row.block_removed_at).not.toBeNull();
      expect(ms(row.block_removed_at)).toBe(ms(block.removed_at));
      expect(row.reinstatable).toBe(true);
    });

    it('SCRUM266_AC1_a_setup_change_flag_shows_its_reason_and_no_block', async () => {
      const { id } = await flaggedFor('setup_or_turnaround_changed');

      expect(await listedOne(id)).toMatchObject({
        review_reason: 'setup_or_turnaround_changed',
        block_id: null,
        block_reason: null,
        block_notes: null,
        block_starts_at: null,
        block_ends_at: null,
        block_removed_at: null,
        flagged_by: staff,
        reinstatable: true,
      });
    });

    it('SCRUM266_AC1_a_safety_flag_on_a_block_flag_shows_both_and_is_not_reinstatable', async () => {
      const { id, blockId } = await flagged({ notes: 'Lift out of service' });
      // As a safety review flags it: the reason and time change, the block stays.
      await db.query(
        `update bookings set review_reason = 'safety_review', flagged_at = now(), flagged_by = $2 where id = $1`,
        [id, coordinator],
      );

      const row = await listedOne(id);

      expect(row).toMatchObject({
        review_reason: 'safety_review',
        block_id: blockId,
        block_reason: 'maintenance',
        block_notes: 'Lift out of service',
        flagged_by: coordinator,
        reinstatable: false,
      });
      expect(ms(row.block_starts_at)).toBe(ms(at('15:00')));
    });

    it('SCRUM266_AC1_a_safety_flag_alone_is_not_reinstatable', async () => {
      const { id } = await flaggedFor('safety_review');

      expect(await listedOne(id)).toMatchObject({ review_reason: 'safety_review', block_id: null, reinstatable: false });
    });

    it.each(['event_changed', 'venue_details_changed'])(
      'SCRUM266_AC1_a_%s_flag_is_listed_and_reinstatable',
      async (reason) => {
        const { id } = await flaggedFor(reason);

        expect(await listedOne(id)).toMatchObject({ review_reason: reason, block_id: null, reinstatable: true });
      },
    );
  });

  describe('the booking, its event and its venue', () => {
    it('SCRUM266_AC1_each_element_has_exactly_the_documented_keys', async () => {
      const { id } = await flagged();

      expect(Object.keys(await listedOne(id)).sort()).toEqual([...KEYS].sort());
    });

    it('SCRUM266_AC1_shows_the_event_name_status_proposed_period_and_assigned_coordinator', async () => {
      const eventId = await makeEvent({ status: 'confirmed', start: at('14:00'), end: at('16:00') });
      const { id, venueId } = await flagged({ eventId });
      const event = await one('select event_name from event_requests where id = $1', [eventId]);
      const venue = await one('select name from venues where id = $1', [venueId]);

      const row = await listedOne(id);

      expect(row).toMatchObject({
        event_request_id: eventId,
        venue_id: venueId,
        event_name: event.event_name,
        event_status: 'confirmed',
        assigned_coordinator_id: coordinator,
        venue_name: venue.name,
        venue_location: 'Block A',
      });
      expect(ms(row.event_starts_at)).toBe(ms(at('14:00')));
      expect(ms(row.event_ends_at)).toBe(ms(at('16:00')));
    });

    it('SCRUM266_AC1_an_event_with_no_coordinator_shows_a_null_coordinator', async () => {
      const { id, eventId } = await flagged();
      await returnToLeadQueue(db, eventId, { coordinator, organiser });

      expect((await listedOne(id)).assigned_coordinator_id).toBeNull();
    });

    it('SCRUM266_AC1_the_event_period_is_its_current_one_not_the_bookings', async () => {
      const eventId = await makeEvent();
      const { id } = await flagged({ eventId });
      await db.query(
        'update event_requests set proposed_start = $2, proposed_end = $3 where id = $1',
        [eventId, at('18:00'), at('20:00')],
      );

      const row = await listedOne(id);

      expect(ms(row.starts_at)).toBe(ms(at('14:00')));
      expect(ms(row.ends_at)).toBe(ms(at('16:00')));
      expect(ms(row.event_starts_at)).toBe(ms(at('18:00')));
      expect(ms(row.event_ends_at)).toBe(ms(at('20:00')));
    });

    it('SCRUM266_AC1_the_occupied_period_adds_setup_before_and_turnaround_after', async () => {
      const { id } = await flagged();

      const row = await listedOne(id);

      expect(ms(row.starts_at)).toBe(ms(at('14:00')));
      expect(ms(row.ends_at)).toBe(ms(at('16:00')));
      expect(ms(row.occupied_starts_at)).toBe(ms(at('13:30')));
      expect(ms(row.occupied_ends_at)).toBe(ms(at('16:45')));
    });
  });

  describe('review reasons', () => {
    it.each(['setup_or_turnaround_changed', 'safety_review', 'event_changed', 'venue_details_changed'])(
      'SCRUM266_AC1_the_review_reason_%s_is_accepted',
      async (reason) => {
        const { id } = await flaggedFor(reason);
        expect((await bookingRow(id)).review_reason).toBe(reason);
      },
    );

    it('SCRUM266_AC1_an_unknown_review_reason_is_refused_with_23514', async () => {
      const { id } = await flaggedFor('event_changed');

      const err = await refusal(db.query(`update bookings set review_reason = 'made_up' where id = $1`, [id]));

      expect(err?.code).toBe('23514');
      expect((await bookingRow(id)).review_reason).toBe('event_changed');
    });
  });

});
