/**
 * SCRUM-383 (SCRUM-379 AC7): listNeedsAttention on the real schema.
 *
 * The service runs against a PGlite database built from the baseline and every migration, through
 * the shared PostgREST adapter. Time is passed in as `now` and the database clock that
 * complete_event_request reads is pinned, so no test depends on when it runs. Every event time is a
 * fixed offset from NOW. Each assertion is on the items the service returns.
 */
import { describe, it, expect, beforeAll } from 'vitest';

import { listNeedsAttention } from '../../src/services/eventRequestService.js';
import { ValidationError } from '../../src/errors.js';
import { pgliteSupabaseClient } from '../fixtures/pgliteSupabaseClient.js';
import { withSafetyReviewTransitionGuardDisabled } from '../fixtures/safetyReviewTestHelpers.js';
import { useSchemaDb, seedEvent, seedUser, seedVenue, seedBooking } from './helpers/schemaDb.js';
import { queriesFor } from './helpers/queries.js';

// 09:00 UTC is 17:00 in Singapore on the same date.
const NOW_ISO = '2030-06-15T09:00:00Z';
const NOW = new Date(NOW_ISO);
const at = (seconds) => new Date(NOW.getTime() + seconds * 1000).toISOString();
const HOUR = 3600;

const RESERVATION_EMBED = (table) =>
  `(select coalesce(json_agg(json_build_object(
      'flagged', r.flagged, 'released_at', r.released_at, 'flag_reason', r.flag_reason, 'flag_code', r.flag_code)), '[]'::json)
      from equipment_reservations r where r.event_request_id = ${table}.id) as equipment_reservations`;
const RESERVATION_TEXT = /\bequipment_reservations\(flagged, released_at, flag_reason, flag_code\)/;

function pgliteClient(db) {
  return pgliteSupabaseClient(db, {
    columns(cols, table) {
      if (/\w+\(/.test(cols.replace(RESERVATION_TEXT, ''))) {
        throw new Error(`pgliteClient: an embed in "${cols}" is not on this path`);
      }
      return cols.replace(RESERVATION_TEXT, RESERVATION_EMBED(table));
    },
  });
}

describe('SCRUM-383: the Needs attention list on the real schema', () => {
  const getDb = useSchemaDb();
  let db;
  let client;
  let organiser;
  let coordinator;
  let otherCoordinator;
  let technicalSupport;
  let venueSequence = 0;
  let typeSequence = 0;

  const { one, rows } = queriesFor(() => getDb());

  const list = (who = coordinator, now = NOW) => listNeedsAttention(who, { client, now });
  const reasonsOf = (items, eventId) => items.filter((i) => i.eventRequestId === eventId).map((i) => [i.code, i.reason]);
  const idsOf = (items) => [...new Set(items.map((i) => i.eventRequestId))];

  beforeAll(async () => {
    db = getDb();
    client = pgliteClient(db);
    organiser = await seedUser(db, { email: 'organiser383@example.com', role: 'event_organiser', fullName: 'Olivia Organiser' });
    coordinator = await seedUser(db, { email: 'coordinator383@example.com', role: 'event_coordinator' });
    otherCoordinator = await seedUser(db, { email: 'other383@example.com', role: 'event_coordinator' });
    technicalSupport = await seedUser(db, { email: 'tech383@example.com', role: 'technical_support_staff' });
    // complete_event_request reads event_clock(); pinned so completing an event is deterministic.
    await db.query(`create or replace function event_clock() returns timestamptz language sql as $$ select '${NOW_ISO}'::timestamptz $$`);
  }, 120_000);

  // Equipment can only be added while the event is not yet Confirmed, so an event that is to be
  // Confirmed with equipment gets its request first and is flipped to Confirmed last.
  async function addEquipment(eventId, status = 'pending_review') {
    const typeId = (await one(
      'insert into equipment_types (name, total_quantity) values ($1, 10) returning id',
      [`Speaker 383 ${(typeSequence += 1)}`],
    )).id;
    const state = JSON.parse((await one(
      'select add_equipment_line($1, $2, $3, $4, null)::text as answer', [eventId, coordinator, typeId, 2],
    )).answer);
    const request = await one('select id from equipment_requests where event_request_id = $1', [eventId]);
    if (status !== 'pending_review') {
      // under_review needs a reviewer and a start time; every other status needs neither.
      await db.query(
        `update equipment_requests
            set status = $2::equipment_request_status,
                reviewer_id = case when $2 = 'under_review' then $3::uuid end,
                review_started_at = case when $2 = 'under_review' then now() end
          where id = $1`,
        [request.id, status, technicalSupport],
      );
    }
    return { requestId: request.id, typeId, lineId: state.request.lines[0].id };
  }

  // An event in `status`, running from `start` to `end`. `booking` adds a booking at its own venue
  // (any status, covering the event unless `bookingEnd` says otherwise). `equipment` adds an
  // equipment request in that status.
  async function event({
    status, start = at(-3 * HOUR), end = at(-HOUR), assigned = coordinator, name, booking = null,
    bookingEnd = null, equipment = null, extra = {},
  }) {
    const insertStatus = status === 'confirmed' ? 'approved' : status;
    const eventId = await seedEvent(db, {
      status: insertStatus,
      organiser_id: organiser,
      event_name: name ?? `Event ${status} ${(venueSequence += 1)}`,
      assigned_coordinator_id: assigned,
      reviewing_coordinator_id: assigned,
      proposed_start: start,
      proposed_end: end,
      ...extra,
    });
    const made = { eventId };
    if (equipment) Object.assign(made, await addEquipment(eventId, equipment));
    if (booking) {
      const venueId = await seedVenue(db, { name: `Venue 383 ${(venueSequence += 1)}` });
      // A released booking must carry who released it and why (bookings_release_paired).
      const insertAs = booking === 'released' ? 'approved' : booking;
      made.bookingId = await seedBooking(db, {
        venueId, eventId, status: insertAs, start, end: bookingEnd ?? end,
      });
      if (booking === 'released') {
        await db.query(
          `update bookings set status = 'released', released_at = now(), released_by = $2, release_reason = 'Not needed' where id = $1`,
          [made.bookingId, coordinator],
        );
      }
    }
    if (status === 'confirmed') {
      await withSafetyReviewTransitionGuardDisabled(db, () => db.query(
        "update event_requests set status = 'confirmed' where id = $1", [eventId],
      ));
    }
    return made;
  }

  // A Confirmed event with an approved booking covering it and no equipment: passes readiness.
  const readyConfirmed = (opts = {}) => event({ status: 'confirmed', booking: 'approved', ...opts });

  const wordsFor = async (status) => (await one('select equipment_request_status_words($1) as words', [status])).words;

  // Any one test reads only the events it made, so the shared database is never reset.
  const only = (items, ...eventIds) => items.filter((i) => eventIds.includes(i.eventRequestId));

  describe('Confirmed and ended: Mark as completed', () => {
    it('SCRUM379_AC7_a_confirmed_event_that_ended_an_hour_ago_is_listed_to_be_marked_completed', async () => {
      const { eventId } = await readyConfirmed({ start: at(-3 * HOUR), end: at(-HOUR), name: 'Ended confirmed' });

      const items = only(await list(), eventId);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        code: 'MARK_COMPLETED',
        reason: 'Mark as completed',
        eventRequestId: eventId,
        eventName: 'Ended confirmed',
        status: 'confirmed',
        link: `/event-requests/${eventId}`,
        organiserName: 'Olivia Organiser',
      });
    });

    it('SCRUM379_AC7_an_event_ending_exactly_now_is_listed', async () => {
      const { eventId } = await readyConfirmed({ start: at(-2 * HOUR), end: at(0) });
      expect(reasonsOf(await list(), eventId)).toEqual([['MARK_COMPLETED', 'Mark as completed']]);
    });

    it('SCRUM379_AC7_an_event_ending_one_second_from_now_is_not_listed', async () => {
      const { eventId } = await readyConfirmed({ start: at(-2 * HOUR), end: at(1) });
      expect(reasonsOf(await list(), eventId)).toEqual([]);
    });

    it('SCRUM379_AC7_an_event_ending_one_second_ago_is_listed', async () => {
      const { eventId } = await readyConfirmed({ start: at(-2 * HOUR), end: at(-1) });
      expect(reasonsOf(await list(), eventId)).toEqual([['MARK_COMPLETED', 'Mark as completed']]);
    });

    it('SCRUM379_AC7_an_event_still_running_is_not_listed', async () => {
      const { eventId } = await readyConfirmed({ start: at(-HOUR), end: at(HOUR) });
      expect(reasonsOf(await list(), eventId)).toEqual([]);
    });

    it('SCRUM379_AC7_an_event_in_the_future_that_is_ready_is_not_listed', async () => {
      const { eventId } = await readyConfirmed({ start: at(24 * HOUR), end: at(26 * HOUR) });
      expect(reasonsOf(await list(), eventId)).toEqual([]);
    });

    it('SCRUM379_AC7_the_end_instant_is_compared_not_its_written_offset', async () => {
      // 08:59:59 UTC written as 16:59:59 Singapore time is one second before NOW; 09:00:01 is after.
      const before = await readyConfirmed({ start: '2030-06-15T14:00:00+08:00', end: '2030-06-15T16:59:59+08:00' });
      const after = await readyConfirmed({ start: '2030-06-15T14:00:00+08:00', end: '2030-06-15T17:00:01+08:00' });
      const items = await list();
      expect(reasonsOf(items, before.eventId)).toEqual([['MARK_COMPLETED', 'Mark as completed']]);
      expect(reasonsOf(items, after.eventId)).toEqual([]);
    });

    it('SCRUM379_AC7_listing_is_the_same_instant_the_event_can_be_completed', async () => {
      const { eventId } = await readyConfirmed({ start: at(-2 * HOUR), end: at(0) });
      expect(reasonsOf(await list(), eventId)).toHaveLength(1);
      const completed = await one('select status::text as status from complete_event_request($1, $2, null)', [eventId, coordinator]);
      expect(completed.status).toBe('completed');
    });
  });

  describe('Approved and ended: Not confirmed; cancel', () => {
    it('SCRUM379_AC7_an_approved_event_that_ended_is_listed_to_be_cancelled', async () => {
      const { eventId } = await event({ status: 'approved' });
      expect(reasonsOf(await list(), eventId)).toEqual([['NOT_CONFIRMED', 'Not confirmed; cancel']]);
    });

    it('SCRUM379_AC7_an_approved_event_ending_exactly_now_is_listed', async () => {
      const { eventId } = await event({ status: 'approved', start: at(-HOUR), end: at(0) });
      expect(reasonsOf(await list(), eventId)).toEqual([['NOT_CONFIRMED', 'Not confirmed; cancel']]);
    });

    it('SCRUM379_AC7_an_approved_event_ending_one_second_from_now_is_not_listed', async () => {
      const { eventId } = await event({ status: 'approved', start: at(-HOUR), end: at(1) });
      expect(reasonsOf(await list(), eventId)).toEqual([]);
    });

    it('SCRUM379_AC7_an_approved_event_still_to_come_is_not_listed', async () => {
      const { eventId } = await event({ status: 'approved', start: at(48 * HOUR), end: at(50 * HOUR) });
      expect(reasonsOf(await list(), eventId)).toEqual([]);
    });

    it('SCRUM379_AC7_an_approved_event_is_not_asked_for_readiness_or_marked_completed', async () => {
      const { eventId } = await event({ status: 'approved' });
      expect(reasonsOf(await list(), eventId).map(([code]) => code)).toEqual(['NOT_CONFIRMED']);
    });
  });

  describe('Overdue clarification', () => {
    const waiting = (replyBy, extra = {}) => event({
      status: 'pending_clarification',
      start: at(48 * HOUR),
      end: at(50 * HOUR),
      extra: { clarification_note: 'Please say more', clarification_reply_by_date: replyBy, ...extra },
    });

    it('SCRUM379_AC7_a_clarification_past_its_reply_by_date_is_listed_with_the_date', async () => {
      const { eventId } = await waiting('2030-06-14');
      expect(reasonsOf(await list(), eventId)).toEqual([
        ['CLARIFICATION_OVERDUE', 'Clarification overdue: reply was due 2030-06-14'],
      ]);
    });

    it('SCRUM379_AC7_a_clarification_due_today_in_singapore_is_not_yet_overdue', async () => {
      // NOW is 17:00 on 2030-06-15 in Singapore.
      const { eventId } = await waiting('2030-06-15');
      expect(reasonsOf(await list(), eventId)).toEqual([]);
    });

    it('SCRUM379_AC7_the_same_clarification_is_overdue_one_second_into_the_next_singapore_day', async () => {
      const { eventId } = await waiting('2030-06-15');
      // 16:00:00 UTC on the 15th is 00:00:00 on the 16th in Singapore.
      expect(reasonsOf(await list(coordinator, new Date('2030-06-15T15:59:59Z')), eventId)).toEqual([]);
      expect(reasonsOf(await list(coordinator, new Date('2030-06-15T16:00:00Z')), eventId)).toEqual([
        ['CLARIFICATION_OVERDUE', 'Clarification overdue: reply was due 2030-06-15'],
      ]);
    });

    it('SCRUM379_AC7_a_clarification_due_tomorrow_is_not_listed', async () => {
      const { eventId } = await waiting('2030-06-16');
      expect(reasonsOf(await list(), eventId)).toEqual([]);
    });

    it('SCRUM379_AC7_a_clarification_with_no_reply_by_date_is_not_listed', async () => {
      const { eventId } = await waiting(null);
      expect(reasonsOf(await list(), eventId)).toEqual([]);
    });

    it('SCRUM379_AC7_an_overdue_date_on_an_event_that_is_not_waiting_is_not_listed', async () => {
      // A reply returns the event to review; the old date must not keep it on the list.
      const { eventId } = await waiting('2030-06-10');
      await db.query("select change_event_request_status($1, 'pending_clarification', 'under_review', $2)", [eventId, coordinator]);
      expect(reasonsOf(await list(), eventId)).toEqual([]);
    });
  });

  describe('Confirmed but no longer ready', () => {
    const future = { start: at(48 * HOUR), end: at(50 * HOUR) };

    it('SCRUM379_AC7_a_confirmed_event_with_no_venue_booking_is_listed', async () => {
      const { eventId } = await event({ status: 'confirmed', ...future });
      expect(reasonsOf(await list(), eventId)).toEqual([['VENUE_NOT_READY', 'No valid venue booking']]);
    });

    it('SCRUM379_AC7_a_flagged_venue_booking_is_listed_as_flagged_for_review', async () => {
      const { eventId } = await event({ status: 'confirmed', booking: 'flagged_for_review', ...future });
      expect(reasonsOf(await list(), eventId)).toEqual([['VENUE_NOT_READY', 'Venue booking flagged for review']]);
    });

    it.each([
      ['pending', 'Venue booking: Awaiting approval'],
      ['conflicting', 'Venue booking: Conflicting, awaiting a decision'],
    ])('SCRUM379_AC7_a_%s_venue_booking_is_listed', async (status, reason) => {
      const { eventId } = await event({ status: 'confirmed', booking: status, ...future });
      expect(reasonsOf(await list(), eventId)).toEqual([['VENUE_NOT_READY', reason]]);
    });

    it('SCRUM379_AC7_an_approved_booking_that_does_not_cover_the_event_is_listed', async () => {
      const { eventId } = await event({ status: 'confirmed', booking: 'approved', bookingEnd: at(49 * HOUR), ...future });
      expect(reasonsOf(await list(), eventId)).toEqual([
        ['VENUE_NOT_READY', "Venue booking: Does not cover the event's start to end"],
      ]);
    });

    it('SCRUM379_AC7_an_approved_booking_that_covers_the_event_is_not_listed', async () => {
      const { eventId } = await event({ status: 'confirmed', booking: 'approved', ...future });
      expect(reasonsOf(await list(), eventId)).toEqual([]);
    });

    it.each(['rejected', 'withdrawn', 'released', 'cancelled'])(
      'SCRUM379_AC7_a_%s_booking_does_not_count_as_a_venue_so_the_event_has_no_valid_booking',
      async (status) => {
        const { eventId } = await event({ status: 'confirmed', booking: status, ...future });
        expect(reasonsOf(await list(), eventId)).toEqual([['VENUE_NOT_READY', 'No valid venue booking']]);
      },
    );

    it.each([
      ['pending_review'],
      ['under_review'],
      ['cannot_be_fully_arranged'],
    ])('SCRUM379_AC7_an_equipment_request_%s_is_listed_in_the_readiness_words', async (status) => {
      const { eventId } = await event({ status: 'confirmed', booking: 'approved', ...future, equipment: status });

      expect(reasonsOf(await list(), eventId)).toEqual([
        ['EQUIPMENT_NOT_READY', `Equipment request: ${await wordsFor(status)}`],
      ]);
    });

    it('SCRUM379_AC7_the_pending_review_wording_matches_the_example_in_the_story', async () => {
      const { eventId } = await event({ status: 'confirmed', booking: 'approved', ...future, equipment: 'pending_review' });
      expect(reasonsOf(await list(), eventId)).toEqual([['EQUIPMENT_NOT_READY', 'Equipment request: Pending review']]);
    });

    it('SCRUM379_AC7_an_arranged_equipment_request_is_not_listed', async () => {
      const { eventId } = await event({ status: 'confirmed', booking: 'approved', ...future, equipment: 'arranged' });
      expect(reasonsOf(await list(), eventId)).toEqual([]);
    });

    it('SCRUM379_AC7_a_cancelled_equipment_request_is_ignored_by_readiness_so_it_is_not_listed', async () => {
      const { eventId } = await event({ status: 'confirmed', booking: 'approved', ...future, equipment: 'cancelled' });
      expect(reasonsOf(await list(), eventId)).toEqual([]);
    });

    it('SCRUM379_AC7_the_date_item_never_lists_a_confirmed_event_whose_start_has_passed', async () => {
      // The readiness check says "the event's start has passed"; that is not a reason here.
      const { eventId } = await event({ status: 'confirmed', booking: 'approved', start: at(-HOUR), end: at(HOUR) });
      expect(reasonsOf(await list(), eventId)).toEqual([]);
    });

    it('SCRUM379_AC7_unconfirmed_equipment_requirements_do_not_list_an_event_the_coordinator_already_confirmed', async () => {
      const { eventId } = await event({
        status: 'confirmed', booking: 'approved', ...future, extra: { equipment_requirements: 'Two microphones' },
      });
      expect(reasonsOf(await list(), eventId)).toEqual([]);
    });

    it('SCRUM379_AC7_each_failing_item_is_its_own_reason_and_matches_the_readiness_function', async () => {
      const { eventId } = await event({ status: 'confirmed', booking: 'pending', ...future, equipment: 'under_review' });

      const readiness = JSON.parse((await one('select event_readiness($1, true)::text as answer', [eventId])).answer);
      const failing = readiness.items.filter((i) => i.met === false && (i.key === 'venue' || i.key === 'equipment'));

      const items = only(await list(), eventId);
      expect(items).toHaveLength(failing.length);
      expect(items.map((i) => i.code)).toEqual(['VENUE_NOT_READY', 'EQUIPMENT_NOT_READY']);
    });

    it('SCRUM379_AC7_two_unmet_venue_bookings_are_two_reasons_with_distinct_keys', async () => {
      const { eventId } = await event({ status: 'confirmed', booking: 'pending', ...future });
      const secondVenue = await seedVenue(db, { name: `Venue 383 second ${(venueSequence += 1)}` });
      await seedBooking(db, { venueId: secondVenue, eventId, status: 'flagged_for_review', start: future.start, end: future.end });

      const items = only(await list(), eventId);
      expect(items.map((i) => i.reason).sort()).toEqual([
        'Venue booking flagged for review',
        'Venue booking: Awaiting approval',
      ]);
      expect(new Set(items.map((i) => i.id)).size).toBe(2);
    });
  });

  describe('flagged equipment on a Confirmed event', () => {
    const reserved = async (eventId, { typeId, lineId }, { flagged, code = null, reason = null }) => (await one(
      `insert into equipment_reservations
         (equipment_type_id, event_request_id, equipment_line_id, quantity, start_at, end_at, flagged, flag_reason, flag_code, flagged_at)
       values ($1, $2, $3, 1, $4, $5, $6, $7, $8, ${flagged ? 'now()' : 'null'}) returning id`,
      [typeId, eventId, lineId, at(48 * HOUR), at(50 * HOUR), flagged, reason, code],
    )).id;
    const confirmedHolding = async () => {
      const made = await event({
        status: 'confirmed', booking: 'approved', equipment: 'arranged', start: at(48 * HOUR), end: at(50 * HOUR),
      });
      return made;
    };

    it('SCRUM379_AC7_a_flagged_unreleased_reservation_is_listed_with_its_reason_and_clears_when_released', async () => {
      const made = await confirmedHolding();
      expect(reasonsOf(await list(), made.eventId)).toEqual([]);

      const id = await reserved(made.eventId, made, { flagged: true, code: 'equipment_lost', reason: 'Dropped' });
      expect(reasonsOf(await list(), made.eventId)).toEqual([['EQUIPMENT_FLAGGED', 'Equipment unavailable: Dropped']]);

      await db.query('update equipment_reservations set released_at = now() where id = $1', [id]);
      expect(reasonsOf(await list(), made.eventId)).toEqual([]);
    });

    it('SCRUM379_AC7_a_date_change_flag_is_worded_as_flagged_for_review_not_unavailable', async () => {
      const made = await confirmedHolding();
      await reserved(made.eventId, made, { flagged: true, code: null, reason: 'The event date or time changed' });
      expect(reasonsOf(await list(), made.eventId)).toEqual([
        ['EQUIPMENT_FLAGGED', 'Equipment flagged for review: The event date or time changed'],
      ]);
    });

    it('SCRUM379_AC7_an_unflagged_reservation_is_not_listed', async () => {
      const made = await confirmedHolding();
      await reserved(made.eventId, made, { flagged: false });
      expect(reasonsOf(await list(), made.eventId)).toEqual([]);
    });

    it('SCRUM379_AC7_the_entry_stays_while_any_flagged_reservation_remains', async () => {
      const made = await confirmedHolding();
      const first = await reserved(made.eventId, made, { flagged: true, code: 'equipment_lost', reason: 'Lost in transit' });
      const second = await reserved(made.eventId, made, { flagged: true, code: 'equipment_lost', reason: 'Broken' });

      await db.query('update equipment_reservations set released_at = now() where id = $1', [first]);
      expect(reasonsOf(await list(), made.eventId)).toEqual([['EQUIPMENT_FLAGGED', 'Equipment unavailable: Broken']]);

      await db.query('update equipment_reservations set released_at = now() where id = $1', [second]);
      expect(reasonsOf(await list(), made.eventId)).toEqual([]);
    });

    it('SCRUM379_AC7_the_same_flag_on_two_reservations_is_one_reason', async () => {
      const made = await confirmedHolding();
      await reserved(made.eventId, made, { flagged: true, code: 'equipment_lost', reason: 'Lost' });
      await reserved(made.eventId, made, { flagged: true, code: 'equipment_lost', reason: 'Lost' });
      expect(reasonsOf(await list(), made.eventId)).toEqual([['EQUIPMENT_FLAGGED', 'Equipment unavailable: Lost']]);
    });
  });

  describe('an event with several reasons', () => {
    it('SCRUM379_AC7_appears_once_per_reason_in_the_documented_order', async () => {
      const { eventId } = await event({ status: 'confirmed', equipment: 'pending_review' });

      expect(reasonsOf(await list(), eventId)).toEqual([
        ['MARK_COMPLETED', 'Mark as completed'],
        ['VENUE_NOT_READY', 'No valid venue booking'],
        ['EQUIPMENT_NOT_READY', 'Equipment request: Pending review'],
      ]);
    });

    it('SCRUM379_AC7_the_items_of_one_event_have_distinct_stable_ids', async () => {
      const { eventId } = await event({ status: 'confirmed', name: 'Stable ids', equipment: 'pending_review' });

      const first = only(await list(), eventId).map((i) => i.id);
      const second = only(await list(), eventId).map((i) => i.id);

      expect(first).toEqual([
        `${eventId}:MARK_COMPLETED:0`,
        `${eventId}:VENUE_NOT_READY:0`,
        `${eventId}:EQUIPMENT_NOT_READY:0`,
      ]);
      expect(second).toEqual(first);
    });
  });

  describe('whose events are listed, and which statuses', () => {
    it('SCRUM379_AC7_another_coordinators_events_are_never_listed_and_the_callers_are_not_in_theirs', async () => {
      const mine = await readyConfirmed({ name: 'Mine' });
      const theirs = await readyConfirmed({ assigned: otherCoordinator, name: 'Theirs' });

      const forMe = await list(coordinator);
      const forThem = await list(otherCoordinator);

      expect(idsOf(forMe)).toContain(mine.eventId);
      expect(idsOf(forMe)).not.toContain(theirs.eventId);
      expect(idsOf(forThem)).toContain(theirs.eventId);
      expect(idsOf(forThem)).not.toContain(mine.eventId);
    });

    it('SCRUM379_AC7_a_coordinator_with_nothing_assigned_gets_an_empty_list', async () => {
      const nobody = await seedUser(db, { email: 'nobody383@example.com', role: 'event_coordinator' });
      expect(await list(nobody)).toEqual([]);
    });

    it('SCRUM379_AC7_an_unknown_but_well_formed_coordinator_id_gets_an_empty_list', async () => {
      expect(await list('99999999-9999-4999-8999-999999999999')).toEqual([]);
    });

    it.each([
      'draft', 'submitted', 'under_review', 'safety_review', 'safety_approved', 'rejected', 'completed', 'cancelled',
    ])('SCRUM379_AC7_an_ended_%s_event_is_never_listed', async (status) => {
      const { eventId } = await event({ status, booking: null });
      expect(reasonsOf(await list(), eventId)).toEqual([]);
    });

    it('SCRUM379_AC7_an_event_nobody_is_assigned_to_is_never_listed', async () => {
      const eventId = await seedEvent(db, {
        status: 'submitted', organiser_id: organiser, event_name: 'Unassigned', proposed_start: at(-3 * HOUR), proposed_end: at(-HOUR),
      });
      expect(idsOf(await list())).not.toContain(eventId);
    });
  });

  describe('order', () => {
    it('SCRUM379_AC7_the_earliest_event_comes_first_whatever_order_they_were_made_in', async () => {
      const cases = [
        await readyConfirmed({ start: at(-30 * HOUR), end: at(-29 * HOUR), assigned: otherCoordinator, name: 'Third' }),
        await readyConfirmed({ start: at(-50 * HOUR), end: at(-49 * HOUR), assigned: otherCoordinator, name: 'First' }),
        await event({ status: 'approved', start: at(-40 * HOUR), end: at(-39 * HOUR), assigned: otherCoordinator, name: 'Second' }),
      ];
      const items = (await list(otherCoordinator)).filter((i) => cases.some((c) => c.eventId === i.eventRequestId));
      expect(items.map((i) => i.eventName)).toEqual(['First', 'Second', 'Third']);
    });

    it('SCRUM379_AC7_events_starting_at_the_same_instant_are_ordered_by_id_and_keep_their_reasons_together', async () => {
      const owner = await seedUser(db, { email: 'tie383@example.com', role: 'event_coordinator' });
      const first = await readyConfirmed({ start: at(-9 * HOUR), end: at(-8 * HOUR), assigned: owner });
      const second = await readyConfirmed({ start: at(-9 * HOUR), end: at(-8 * HOUR), assigned: owner });
      const items = await list(owner);

      expect(items.map((i) => i.eventRequestId)).toEqual([first.eventId, second.eventId].sort());
    });

    it('SCRUM379_AC7_an_event_with_no_start_is_last', async () => {
      const owner = await seedUser(db, { email: 'nostart383@example.com', role: 'event_coordinator' });
      const dated = await event({ status: 'approved', assigned: owner, start: at(-5 * HOUR), end: at(-4 * HOUR), name: 'Dated' });
      const undated = await event({
        status: 'pending_clarification', assigned: owner, start: null, end: null, name: 'Undated',
        extra: { clarification_note: 'Dates?', clarification_reply_by_date: '2030-06-01' },
      });
      const items = await list(owner);
      expect(items.map((i) => i.eventName)).toEqual(['Dated', 'Undated']);
      expect(items[1].proposedStart).toBeNull();
      expect([dated.eventId, undated.eventId]).toEqual(items.map((i) => i.eventRequestId));
    });

    it('SCRUM379_AC7_the_list_is_the_same_on_every_call', async () => {
      const first = await list(otherCoordinator);
      const second = await list(otherCoordinator);
      expect(second).toEqual(first);
    });
  });

  describe('an item disappears once it is resolved', () => {
    it('SCRUM379_AC7_completing_the_event_removes_its_mark_as_completed_item', async () => {
      const { eventId } = await readyConfirmed({ start: at(-3 * HOUR), end: at(-HOUR) });
      expect(reasonsOf(await list(), eventId)).toHaveLength(1);

      await db.query('select * from complete_event_request($1, $2, null)', [eventId, coordinator]);

      expect(reasonsOf(await list(), eventId)).toEqual([]);
    });

    it('SCRUM379_AC7_cancelling_an_unconfirmed_event_removes_its_item', async () => {
      const { eventId } = await event({ status: 'approved' });
      expect(reasonsOf(await list(), eventId)).toHaveLength(1);

      await db.query("select change_event_request_status($1, 'approved', 'cancelled', $2)", [eventId, coordinator]);

      expect(reasonsOf(await list(), eventId)).toEqual([]);
    });

    it('SCRUM379_AC7_cancelling_a_confirmed_event_removes_every_item_it_had', async () => {
      const { eventId } = await event({ status: 'confirmed' });
      expect(reasonsOf(await list(), eventId).length).toBeGreaterThan(1);

      await db.query("select change_event_request_status($1, 'confirmed', 'cancelled', $2)", [eventId, coordinator]);

      expect(reasonsOf(await list(), eventId)).toEqual([]);
    });

    it('SCRUM379_AC7_approving_the_booking_removes_the_venue_item_and_arranging_equipment_removes_the_equipment_item', async () => {
      const future = { start: at(48 * HOUR), end: at(50 * HOUR) };
      const { eventId, bookingId, requestId } = await event({
        status: 'confirmed', booking: 'pending', equipment: 'pending_review', ...future,
      });
      expect(reasonsOf(await list(), eventId).map(([code]) => code)).toEqual(['VENUE_NOT_READY', 'EQUIPMENT_NOT_READY']);

      await db.query("update bookings set status = 'approved' where id = $1", [bookingId]);
      expect(reasonsOf(await list(), eventId).map(([code]) => code)).toEqual(['EQUIPMENT_NOT_READY']);

      await db.query("update equipment_requests set status = 'arranged' where id = $1", [requestId]);
      expect(reasonsOf(await list(), eventId)).toEqual([]);
    });

    it('SCRUM379_AC7_moving_the_clock_past_the_end_adds_the_item_and_moving_it_back_removes_it', async () => {
      const { eventId } = await readyConfirmed({ start: at(HOUR), end: at(2 * HOUR) });
      expect(reasonsOf(await list(coordinator, NOW), eventId)).toEqual([]);
      expect(reasonsOf(await list(coordinator, new Date(NOW.getTime() + 2 * HOUR * 1000)), eventId)).toHaveLength(1);
      expect(reasonsOf(await list(coordinator, NOW), eventId)).toEqual([]);
    });
  });

  describe('input', () => {
    it.each([undefined, null, '', '   ', 'not-an-id', 42, {}])(
      'SCRUM379_AC7_the_coordinator_%s_is_refused_before_the_database_is_read',
      async (bad) => {
        const calls = [];
        const spy = { from: (...a) => { calls.push(a); return client.from(...a); }, rpc: (...a) => { calls.push(a); return client.rpc(...a); } };
        await expect(listNeedsAttention(bad, { client: spy, now: NOW })).rejects.toBeInstanceOf(ValidationError);
        expect(calls).toEqual([]);
      },
    );

    it.each([undefined, null, 'now', 0, new Date('nope'), {}])(
      'SCRUM379_AC7_the_time_%s_is_refused_unless_it_is_omitted',
      async (bad) => {
        const run = listNeedsAttention(coordinator, { client, now: bad });
        if (bad === undefined) {
          await expect(run).resolves.toBeInstanceOf(Array);
        } else {
          await expect(run).rejects.toBeInstanceOf(ValidationError);
        }
      },
    );

    it('SCRUM379_AC7_an_upper_case_padded_coordinator_id_is_the_same_coordinator', async () => {
      const { eventId } = await readyConfirmed({ name: 'Case test' });
      const items = await listNeedsAttention(` ${coordinator.toUpperCase()} `, { client, now: NOW });
      expect(idsOf(items)).toContain(eventId);
    });
  });

  describe('failures', () => {
    it('SCRUM379_AC7_a_failed_event_read_is_an_error_not_an_empty_list', async () => {
      const broken = { from: () => ({ select: () => ({ eq: () => ({ in: () => ({ order: () => ({ order: async () => ({ data: null, error: { code: '08006', message: 'connection lost' } }) }) }) }) }) }) };
      await expect(listNeedsAttention(coordinator, { client: broken, now: NOW })).rejects.toBeTruthy();
    });

    it('SCRUM379_AC7_a_failed_readiness_read_fails_the_whole_call_rather_than_leaving_a_reason_out', async () => {
      await readyConfirmed({ name: 'Readiness fails' });
      const failing = {
        from: (...a) => client.from(...a),
        rpc: async () => ({ data: null, error: { code: '08006', message: 'connection lost' } }),
      };
      await expect(listNeedsAttention(coordinator, { client: failing, now: NOW })).rejects.toBeTruthy();
    });
  });

  describe('nothing is stored', () => {
    it('SCRUM379_AC7_listing_changes_nothing_in_the_database', async () => {
      const { eventId } = await readyConfirmed({ name: 'Read only' });
      const before = await rows('select updated_at, status::text from event_requests where id = $1', [eventId]);
      const counts = async () => (await one(
        `select (select count(*) from event_request_status_history) as history,
                (select count(*) from notifications) as notifications`,
      ));
      const countsBefore = await counts();

      await list();
      await list();

      expect(await rows('select updated_at, status::text from event_requests where id = $1', [eventId])).toEqual(before);
      expect(await counts()).toEqual(countsBefore);
    });
  });
});
