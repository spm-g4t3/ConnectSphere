/**
 * SCRUM-489 (SCRUM-555, SCRUM-556) and SCRUM-363 against the final schema: the
 * readiness check, submitting an Approved event for the Operational Safety
 * Check, and confirming it after the Safety Officer approves.
 * Cases: docs/test-cases/SCRUM-489.md.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { STATUS } from '../../src/domain/eventRequestStatus.js';
import express from 'express';
import request from 'supertest';
import { createEventRequestRouter } from '../../src/routes/eventRequests.js';
import { createSchemaDb, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor, refusal } from './helpers/queries.js';
import { clientsCanExecute } from './helpers/grants.js';
import { pgliteSupabaseClient } from '../fixtures/pgliteSupabaseClient.js';

const DAY = 86_400_000;
const at = (days) => new Date(Date.now() + days * DAY).toISOString();

describe('SCRUM-489: readiness and submission for the safety check', () => {
  let db;
  let organiser;
  let coordinatorA;
  let coordinatorB;
  let lead;
  let attendee;
  let safetyOfficers;
  let hallA;
  let room2;

  const { one } = queriesFor(() => db);

  /** An Approved event held by A, starting in 10 days, with no arrangements. */
  async function event(overrides = {}) {
    return seedEvent(db, {
      status: 'approved',
      organiser_id: organiser,
      reviewing_coordinator_id: coordinatorA,
      event_name: 'IS212 Industry Night',
      proposed_start: at(10),
      proposed_end: at(10.25),
      equipment_requirements: null,
      ...overrides,
    });
  }

  const booking = (eventId, venueId, status = 'approved', { starts = null, ends = null } = {}) =>
    seedBooking(db, { venueId, eventId, status, start: starts, end: ends });

  // A reviewer is required exactly when a request is under review.
  const equipment = async (eventId, status) =>
    (await one(
      `insert into equipment_requests (event_request_id, status, reviewer_id, review_started_at)
       values ($1, $2::equipment_request_status,
               case when $2 = 'under_review' then $3::uuid end, case when $2 = 'under_review' then now() end)
       returning id`,
      [eventId, status, organiser],
    )).id;

  /**
   * Put an event straight into a status, with the decision fields that status
   * requires. Triggers off: this seeds the refusal, not a real move.
   */
  async function putInStatus(id, status) {
    const undecided = ['draft', 'submitted', 'under_review', 'pending_clarification'].includes(status);
    await db.query('alter table event_requests disable trigger all');
    await db.query(
      `update event_requests
          set status        = $2::event_request_status,
              submitted_at  = case when $2 = 'draft' then null else submitted_at end,
              decision      = case when $3 then null when $2 = 'rejected' then 'rejected'::event_request_decision else decision end,
              decision_note = case when $2 = 'rejected' then 'Not this term.' else decision_note end,
              decided_by    = case when $3 then null else decided_by end,
              decided_at    = case when $3 then null else decided_at end
        where id = $1`,
      [id, status, undecided],
    );
    await db.query('alter table event_requests enable trigger all');
  }

  /** An event ready to submit: one approved covering booking, no equipment, a future start. */
  async function readyEvent(overrides = {}) {
    const id = await event(overrides);
    await booking(id, hallA);
    return id;
  }

  const readiness = async (id, confirmed = false) =>
    (await one('select event_readiness($1, $2) as r', [id, confirmed])).r;

  const submit = (id, by = coordinatorA, note = null, confirmed = false) =>
    db.query('select * from submit_event_for_safety_review($1, $2, $3, $4)', [id, by, note, confirmed]);

  const confirm = async (id, by = coordinatorA, acknowledged = false) => {
    const revision = (await one('select updated_at::text as revision from event_requests where id = $1', [id]))?.revision;
    return db.query('select * from confirm_event_request($1, $2, $3, $4::timestamptz)', [id, by, acknowledged, revision]);
  };

  async function readyToConfirm(overrides = {}) {
    const id = await readyEvent(overrides);
    await submit(id, coordinatorA, null, true);
    await db.query("select respond_to_safety_review($1, $2, 'approved', null, '{}', false)", [id, safetyOfficers[0]]);
    return id;
  }

  /** Everything a submission writes, for one event. */
  async function written(id) {
    return {
      event: await one('select status::text as status from event_requests where id = $1', [id]),
      history: (await db.query(
        `select previous_status::text as previous_status, new_status::text as new_status, changed_by, reason
           from event_request_status_history where event_request_id = $1 order by created_at, id`, [id],
      )).rows,
      submissions: (await db.query('select * from safety_review_submissions where event_request_id = $1', [id])).rows,
      notices: (await db.query(
        `select recipient_id, payload from notifications
          where type = 'event_submitted_for_safety_review' and event_request_id = $1 order by recipient_id`, [id],
      )).rows,
    };
  }

  beforeAll(async () => {
    db = await createSchemaDb();

    const user = (email, role, name) => seedUser(db, { email, role, fullName: name });
    organiser = await user('o@x', 'event_organiser', 'Aisha Rahman');
    coordinatorA = await user('a@x', 'event_coordinator', 'Priya Nair');
    coordinatorB = await user('b@x', 'event_coordinator', 'Omar Okafor');
    lead = await user('lead@x', 'event_coordinator_lead', 'Lena Lead');
    attendee = await user('attendee@x', 'attendee', 'Taylor Attendee');
    safetyOfficers = [await user('so1@x', 'safety_officer', 'Sam Safe'), await user('so2@x', 'safety_officer', 'Sol Secure')];
    hallA = await seedVenue(db, { name: 'Hall A', location: 'SMU', setup: 0, turnaround: 0 });
    room2 = await seedVenue(db, { name: 'Room 2', location: 'SMU', capacity: 40, setup: 0, turnaround: 0 });
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });


  // -------------------------------------------------------------------------
  // AC2: the readiness conditions
  // -------------------------------------------------------------------------
  describe('AC2: event_readiness', () => {
    it('SCRUM489_AC2_an_approved_covering_booking_no_equipment_and_a_future_start_is_ready', async () => {
      // AC2-01, AC2-09 (no requirements), AC2-11: the lines in their fixed order.
      const id = await event();
      const bookingId = await booking(id, hallA);

      expect(await readiness(id)).toEqual({
        eventRequestId: id,
        ready: true,
        items: [
          {
            key: 'venue', met: true, detail: 'Approved', bookingId, venueName: 'Hall A',
            startsAt: expect.any(String), endsAt: expect.any(String),
          },
          { key: 'equipment', met: true, detail: 'No equipment requested' },
          { key: 'date', met: true, detail: 'Starts in the future' },
        ],
      });

    });

    it.each([
      ['pending', 'Awaiting approval'],
      ['flagged_for_review', 'Flagged for review'],
    ])('SCRUM489_AC2_a_%s_booking_is_outstanding', async (status, detail) => {
      // AC2-02, AC2-03.
      const id = await event();
      await booking(id, hallA, status);

      const result = await readiness(id);
      expect(result.ready).toBe(false);
      expect(result.items[0]).toMatchObject({ key: 'venue', met: false, detail, venueName: 'Hall A' });
    });

    it('SCRUM489_AC2_an_approved_booking_that_no_longer_covers_the_event_is_outstanding', async () => {
      // AC2-04: the event moved later; the booking ends before the event does.
      const id = await event();
      const times = await one('select proposed_start from event_requests where id = $1', [id]);
      await booking(id, hallA, 'approved', { starts: times.proposed_start, ends: new Date(new Date(times.proposed_start).getTime() + 3_600_000).toISOString() });
      await db.query('update event_requests set proposed_end = proposed_start + interval \'4 hours\' where id = $1', [id]);

      expect((await readiness(id)).items[0]).toMatchObject({
        key: 'venue', met: false, detail: "Does not cover the event's start to end",
      });
    });

    it('SCRUM489_AC2_two_venues_each_a_line_one_met_one_outstanding', async () => {
      // AC2-05, in start order: Room 2's booking starts first.
      const id = await event();
      const times = await one('select proposed_start, proposed_end from event_requests where id = $1', [id]);
      await booking(id, hallA, 'approved');
      await booking(id, room2, 'pending', {
        starts: new Date(new Date(times.proposed_start).getTime() - 3_600_000).toISOString(), ends: times.proposed_end,
      });

      const venues = (await readiness(id)).items.filter((item) => item.key === 'venue');
      expect(venues.map(({ venueName, met, detail }) => ({ venueName, met, detail }))).toEqual([
        { venueName: 'Room 2', met: false, detail: 'Awaiting approval' },
        { venueName: 'Hall A', met: true, detail: 'Approved' },
      ]);
    });

    it('SCRUM489_AC2_no_live_booking_is_one_outstanding_line_and_dead_bookings_are_not_relied_on', async () => {
      // AC2-06, AC2-07, AC2-13: rejected, withdrawn and cancelled bookings are
      // not lines; nor is a venue hold, which is not a booking at all.
      const id = await event();
      for (const status of ['rejected', 'withdrawn', 'cancelled']) await booking(id, hallA, status);
      await db.query("insert into venue_holds (event_request_id, venue_id, placed_by, expires_at) values ($1, $2, $3, now() + interval '2 days')", [id, room2, coordinatorA]);

      expect((await readiness(id)).items[0]).toEqual({ key: 'venue', met: false, detail: 'No venue booking' });
      expect((await readiness(id)).items.filter((item) => item.key === 'venue')).toHaveLength(1);
    });

    it.each([
      ['arranged', true, 'Arranged'],
      ['cannot_be_fully_arranged', false, 'Cannot be fully arranged'],
      ['pending_review', false, 'Pending review'],
      ['under_review', false, 'Under review'],
    ])('SCRUM489_AC2_an_equipment_request_%s_is_met_only_when_arranged', async (status, met, detail) => {
      // AC2-08, in the equipment status's words.
      const id = await readyEvent();
      const requestId = await equipment(id, status);

      expect((await readiness(id)).items.find((item) => item.key === 'equipment'))
        .toEqual({ key: 'equipment', met, detail, equipmentRequestId: requestId });
    });

    it('SCRUM489_AC2_a_cancelled_equipment_request_is_ignored', async () => {
      // AC2-09.
      const id = await readyEvent();
      await equipment(id, 'cancelled');

      const lines = (await readiness(id)).items.filter((item) => item.key === 'equipment');
      expect(lines).toEqual([{ key: 'equipment', met: true, detail: 'No equipment requested' }]);
    });

    it.each([
      ['the start has passed', { proposed_start: at(-1), proposed_end: at(-0.9) }, "The event's start has passed"],
      ['there is no start', { proposed_start: null, proposed_end: null }, 'The event has no start date'],
    ])('SCRUM489_AC2_the_date_is_outstanding_when_%s', async (_label, overrides, detail) => {
      // AC2-10.
      const id = await event(overrides);

      const result = await readiness(id);
      expect(result.items.at(-1)).toEqual({ key: 'date', met: false, detail });
      expect(result.ready).toBe(false);
    });

    it('SCRUM489_AC2_the_date_is_outstanding_with_no_end', async () => {
      const id = await event();
      await db.query('alter table event_requests disable trigger all');
      await db.query('update event_requests set proposed_end = null where id = $1', [id]);
      await db.query('alter table event_requests enable trigger all');

      expect((await readiness(id)).items.at(-1)).toEqual({ key: 'date', met: false, detail: 'The event has no end date' });
    });

    it('SCRUM489_AC2_an_unknown_event_is_not_found', async () => {
      // AC2-12.
      const err = await refusal(readiness('00000000-0000-4000-8000-000000000000'));
      expect(err?.code).toBe('P0002');
    });
  });

  describe('SCRUM-363: shared readiness', () => {
    it.each([
      ['exact coverage', '0 seconds', '0 seconds', true],
      ['wider coverage', '-1 hour', '1 hour', true],
      ['starts one microsecond late', '1 microsecond', '0 seconds', false],
      ['ends one microsecond early', '0 seconds', '-1 microsecond', false],
    ])('SCRUM363_AC2_booking_%s_and_its_period_are_reported', async (_label, startOffset, endOffset, met) => {
      const id = await event();
      const { id: bookingId } = await one(
        `insert into bookings (event_request_id, venue_id, status, starts_at, ends_at)
         select id, $2, 'approved', proposed_start + $3::interval, proposed_end + $4::interval
           from event_requests where id = $1 returning id`,
        [id, hallA, startOffset, endOffset],
      );

      const result = await readiness(id);
      const { starts_at, ends_at } = await one('select starts_at, ends_at from bookings where id = $1', [bookingId]);
      expect(result.ready).toBe(met);
      expect(result.items[0]).toEqual({
        key: 'venue', met, bookingId, venueName: 'Hall A',
        detail: met ? 'Approved' : "Does not cover the event's start to end",
        startsAt: expect.any(String), endsAt: expect.any(String),
      });
      expect(new Date(result.items[0].startsAt)).toEqual(new Date(starts_at));
      expect(new Date(result.items[0].endsAt)).toEqual(new Date(ends_at));
    });

    it.each([
      ['approved', true, 'Approved'],
      ['pending', false, 'Awaiting approval'],
      ['conflicting', false, 'Conflicting, awaiting a decision'],
      ['flagged_for_review', false, 'Flagged for review'],
    ])('SCRUM363_AC2_every_booking_must_pass_including_a_second_%s_booking', async (status, met, detail) => {
      const id = await readyEvent();
      const bookingId = await booking(id, room2, status);
      const result = await readiness(id);

      expect(result.ready).toBe(met);
      expect(result.items.filter((item) => item.key === 'venue')).toHaveLength(2);
      expect(result.items.find((item) => item.bookingId === bookingId)).toMatchObject({ met, detail });
      if (!met) {
        const err = await refusal(submit(id));
        expect(err?.hint).toBe('EVENT_NOT_READY');
        expect(JSON.parse(err.detail)).toEqual(result.items.filter((item) => !item.met));
      }
    });

    it('SCRUM363_AC2_every_active_equipment_request_must_be_arranged_and_cancelled_requests_are_ignored', async () => {
      const id = await readyEvent({ equipment_requirements: 'Projectors' });
      const arranged = await equipment(id, 'arranged');
      const pending = await equipment(id, 'pending_review');
      const reviewing = await equipment(id, 'under_review');
      const unavailable = await equipment(id, 'cannot_be_fully_arranged');
      await equipment(id, 'cancelled');

      const result = await readiness(id, true);
      expect(result.ready).toBe(false);
      expect(result.items.filter((item) => item.key === 'equipment')).toEqual(expect.arrayContaining([
        { key: 'equipment', equipmentRequestId: arranged, met: true, detail: 'Arranged' },
        { key: 'equipment', equipmentRequestId: pending, met: false, detail: 'Pending review' },
        { key: 'equipment', equipmentRequestId: reviewing, met: false, detail: 'Under review' },
        { key: 'equipment', equipmentRequestId: unavailable, met: false, detail: 'Cannot be fully arranged' },
      ]));
      expect(result.items.filter((item) => item.key === 'equipment')).toHaveLength(4);
      expect(result.items.some((item) => item.key === 'no_equipment_confirmation')).toBe(false);
    });

    it.each([null, '', '   ', '\t\r\n\f\v '])(
      'SCRUM363_AC5_blank_requirements_%j_do_not_need_acknowledgement_and_still_submit', async (requirements) => {
        const id = await readyEvent({ equipment_requirements: requirements });
        expect((await readiness(id)).ready).toBe(true);
        expect((await readiness(id)).items.some((item) => item.key === 'no_equipment_confirmation')).toBe(false);
        await submit(id);
        expect((await written(id)).submissions[0].no_equipment_confirmed).toBe(false);
      },
    );

    it('SCRUM363_AC5_cancelled_equipment_does_not_remove_the_need_for_explicit_acknowledgement', async () => {
      const requirements = '\t Projectors\n';
      const id = await readyEvent({ equipment_requirements: requirements });
      await equipment(id, 'cancelled');
      const before = await written(id);

      for (const confirmed of [false, null, true]) {
        const result = await readiness(id, confirmed);
        expect(result.ready).toBe(confirmed === true);
        expect(result.items[1]).toEqual({
          key: 'no_equipment_confirmation', met: confirmed === true,
          detail: 'Confirm that this event needs no equipment', organiserRequirements: requirements,
        });
      }
      expect(await written(id)).toEqual(before);
    });

    it.each([
      ['past', '-1 microsecond', false],
      ['at the boundary', '0 seconds', false],
      ['future', '1 day', true],
    ])('SCRUM363_AC2_start_%s_uses_database_time_and_is_timezone_independent', async (_label, offset, met) => {
      const id = await event();
      await db.exec('begin');
      try {
        await db.query(
          `update event_requests set proposed_start = now() + $2::interval,
             proposed_end = now() + $2::interval + interval '1 hour' where id = $1`, [id, offset],
        );
        for (const zone of ['UTC', 'Asia/Singapore']) {
          await db.query("select set_config('TimeZone', $1, true)", [zone]);
          expect((await readiness(id)).items.at(-1)).toEqual({
            key: 'date', met, detail: met ? 'Starts in the future' : "The event's start has passed",
          });
        }
      } finally {
        await db.exec('rollback');
      }
    });

    it('SCRUM363_AC2_rechecks_current_time_instead_of_the_start_of_a_longer_transaction', async () => {
      const id = await event();
      await db.exec('begin');
      try {
        // Adjacent PGlite calls can share a clock tick; advance before seeding the start.
        await new Promise((resolve) => setTimeout(resolve, 25));
        await db.query(
          `update event_requests set proposed_start = clock_timestamp(),
             proposed_end = clock_timestamp() + interval '1 hour' where id = $1`, [id],
        );
        expect((await one('select proposed_start > now() as after_start from event_requests where id = $1', [id])).after_start).toBe(true);
        expect((await readiness(id)).items.at(-1)).toMatchObject({ met: false, detail: "The event's start has passed" });
      } finally {
        await db.exec('rollback');
      }
    });

    it.each(['0 seconds', '-1 hour'])(
      'SCRUM363_AC2_invalid_event_period_%s_is_rejected_by_the_existing_date_constraint', async (offset) => {
        const id = await event();
        const err = await refusal(db.query(
          'update event_requests set proposed_end = proposed_start + $2::interval where id = $1', [id, offset],
        ));
        expect(err?.code).toBe('23514');
        expect(err?.constraint).toBe('event_requests_dates_ordered');
      },
    );

    it('SCRUM363_AC4_lists_all_conditions_in_a_read_only_transaction_without_changing_arrangements_or_history', async () => {
      const id = await event({ proposed_start: at(-1), proposed_end: at(-0.9) });
      await booking(id, hallA, 'conflicting');
      await booking(id, room2, 'flagged_for_review');
      await equipment(id, 'pending_review');
      const snapshot = async () => ({
        ...await written(id),
        bookings: (await db.query('select * from bookings where event_request_id = $1 order by id', [id])).rows,
        equipment: (await db.query('select * from equipment_requests where event_request_id = $1 order by id', [id])).rows,
      });
      const before = await snapshot();
      await db.exec('begin read only');
      try {
        const result = await readiness(id);
        expect(result.ready).toBe(false);
        expect(result.items.map(({ key, met, detail }) => ({ key, met, detail }))).toEqual([
          { key: 'venue', met: false, detail: expect.any(String) },
          { key: 'venue', met: false, detail: expect.any(String) },
          { key: 'equipment', met: false, detail: 'Pending review' },
          { key: 'date', met: false, detail: "The event's start has passed" },
        ]);
      } finally {
        await db.exec('rollback');
      }
      expect(await snapshot()).toEqual(before);
    });

    it('SCRUM363_AC4_readiness_is_defined_once_and_runs_only_on_the_trusted_backend', async () => {
      expect(Number((await one("select count(*) from pg_proc where proname = 'event_readiness'")).count)).toBe(1);
      expect(await clientsCanExecute(db, 'event_readiness(uuid,boolean)', ['anon', 'authenticated', 'service_role'])).toEqual(['service_role']);
    });
  });

  describe('SCRUM-363: atomic confirmation', () => {
    it('SCRUM363_AC6_HTTP_confirmation_uses_the_real_SQL_transaction_and_returns_safe_repeated_and_not_ready_responses', async () => {
      const pglite = pgliteSupabaseClient(db);
      const client = {
        rpc(fn, args) {
          expect(fn).toBe('confirm_event_request');
          return pglite.rpc(fn, args);
        },
      };
      const app = express().use(express.json()).use('/api/event-requests', createEventRequestRouter({
        client,
        requireAuth: (req, _res, next) => {
          req.user = { id: coordinatorA, role: 'event_coordinator' };
          next();
        },
      }));
      const id = await readyToConfirm();
      const success = await request(app).post(`/api/event-requests/${id}/confirm`).send({});
      expect(success.status).toBe(200);
      expect(success.body).toMatchObject({ id, status: 'confirmed', statusDisplay: { label: 'Confirmed' } });
      expect((await request(app).post(`/api/event-requests/${id}/confirm`).send({})).status).toBe(409);
      expect((await written(id)).history.filter((row) => row.new_status === 'confirmed')).toHaveLength(1);

      const flagged = await readyToConfirm();
      await db.query("update bookings set status = 'flagged_for_review' where event_request_id = $1", [flagged]);
      const failed = await request(app).post(`/api/event-requests/${flagged}/confirm`).send({});
      expect(failed.status).toBe(409);
      expect(failed.body.code).toBe('EVENT_NOT_READY');
      expect(failed.body.conflicts).toEqual((await readiness(flagged)).items.filter((item) => !item.met));
      expect((await written(flagged)).event.status).toBe('safety_approved');

      const needsAcknowledgement = await readyToConfirm({ equipment_requirements: 'Projectors' });
      const unversioned = await request(app).post(`/api/event-requests/${needsAcknowledgement}/confirm`)
        .send({ noEquipmentConfirmed: true });
      expect(unversioned.status).toBe(409);
      expect(unversioned.body.error).toMatch(/refresh/i);
      expect((await written(needsAcknowledgement)).event.status).toBe('safety_approved');
      const { updated_at: expectedUpdatedAt } = await one('select updated_at from event_requests where id = $1', [needsAcknowledgement]);
      const acknowledged = await request(app).post(`/api/event-requests/${needsAcknowledgement}/confirm`)
        .send({ noEquipmentConfirmed: true, expectedUpdatedAt });
      expect(acknowledged.status).toBe(200);
      expect((await written(needsAcknowledgement)).history.at(-1).reason).toMatch(/acknowledged that no equipment is needed/i);
    });

    it('SCRUM363_AC6_a_safety_approved_event_is_confirmed_with_its_coordinator_and_timestamp_in_history', async () => {
      const id = await readyToConfirm();
      const before = await one('select clock_timestamp() as at');
      const { rows: [result] } = await confirm(id);
      const history = (await written(id)).history.filter((row) => row.new_status === 'confirmed');

      expect(result.status).toBe('confirmed');
      expect(history).toEqual([{
        previous_status: 'safety_approved', new_status: 'confirmed', changed_by: coordinatorA, reason: 'Event confirmed.',
      }]);
      const { created_at } = await one("select created_at from event_request_status_history where event_request_id = $1 and new_status = 'confirmed'", [id]);
      expect(new Date(created_at).getTime()).toBeGreaterThanOrEqual(new Date(before.at).getTime());
      expect(new Date(created_at).getTime()).toBeLessThanOrEqual(Date.now());
    });

    it.each([
      ['another coordinator', () => coordinatorB], ['organiser', () => organiser],
      ['lead', () => lead], ['attendee', () => attendee], ['safety officer', () => safetyOfficers[0]], ['null caller', () => null],
    ])('SCRUM363_AC1_%s_is_refused_without_changes', async (_label, caller) => {
      const id = await readyToConfirm();
      const before = await written(id);
      expect((await refusal(confirm(id, caller())))?.code).toBe('42501');
      expect(await written(id)).toEqual(before);
    });

    it.each(['event_organiser', 'event_coordinator_lead', 'venue_staff', 'technical_support_staff', 'attendee', 'safety_officer'])(
      'SCRUM363_AC1_assigned_user_with_database_role_%s_is_refused', async (role) => {
        const id = await readyToConfirm();
        const before = await written(id);
        await db.exec('begin');
        try {
          await db.query('update profiles set role = $2 where id = $1', [coordinatorA, role]);
          expect((await refusal(confirm(id)))?.code).toBe('42501');
        } finally {
          await db.exec('rollback');
        }
        expect(await written(id)).toEqual(before);
      },
    );

    it('SCRUM363_AC1_reassignment_before_confirmation_is_revalidated', async () => {
      const id = await readyToConfirm();
      await db.query('update event_requests set assigned_coordinator_id = $2 where id = $1', [id, coordinatorB]);
      expect((await refusal(confirm(id)))?.code).toBe('42501');
      expect((await confirm(id, coordinatorB)).rows[0].status).toBe('confirmed');
    });

    it('SCRUM363_AC1_an_assigned_caller_without_a_current_profile_is_refused', async () => {
      const id = await readyToConfirm();
      await db.exec('begin');
      try {
        await db.query('delete from profiles where id = $1', [coordinatorA]);
        expect((await refusal(confirm(id)))?.code).toBe('42501');
      } finally {
        await db.exec('rollback');
      }
      expect((await written(id)).event.status).toBe('safety_approved');
    });

    it.each(Object.values(STATUS).filter((status) => status !== STATUS.SAFETY_APPROVED))(
      'SCRUM363_AC1_current_status_%s_is_refused_and_named_without_writes', async (status) => {
        const id = await readyToConfirm();
        await putInStatus(id, status);
        const before = await written(id);
        const err = await refusal(confirm(id));
        expect(err?.code).toBe('55000');
        expect(err?.message).toContain(`current status is ${status}`);
        expect(await written(id)).toEqual(before);
      },
    );

    it('SCRUM363_AC1_missing_and_null_events_are_refused', async () => {
      expect((await refusal(confirm('00000000-0000-4000-8000-000000000000')))?.code).toBe('P0002');
      expect((await refusal(confirm(null)))?.code).toBe('22023');
    });

    it.each(['pending', 'conflicting', 'flagged_for_review', 'cancelled'])(
      'SCRUM363_AC2_booking_changed_to_%s_is_rechecked_after_safety_approval', async (status) => {
        const id = await readyToConfirm();
        await db.query('update bookings set status = $2::booking_status where event_request_id = $1', [id, status]);
        const before = await written(id);
        const err = await refusal(confirm(id));
        expect(err?.hint).toBe('EVENT_NOT_READY');
        expect(JSON.parse(err.detail)).toEqual((await readiness(id)).items.filter((item) => !item.met));
        expect(await written(id)).toEqual(before);
      },
    );

    it('SCRUM363_AC3_all_current_booking_equipment_and_date_failures_are_returned_together', async () => {
      const id = await readyToConfirm();
      await db.query("update bookings set status = 'flagged_for_review' where event_request_id = $1", [id]);
      await booking(id, room2, 'conflicting');
      await equipment(id, 'pending_review');
      await db.query("update event_requests set proposed_start = now() - interval '1 day', proposed_end = now() - interval '23 hours' where id = $1", [id]);
      const before = await written(id);
      const err = await refusal(confirm(id));
      expect(err?.code).toBe('PT409');
      expect(err?.hint).toBe('EVENT_NOT_READY');
      expect(JSON.parse(err.detail)).toEqual((await readiness(id)).items.filter((item) => !item.met));
      expect(JSON.parse(err.detail).map((item) => item.key)).toEqual(['venue', 'venue', 'equipment', 'date']);
      expect(await written(id)).toEqual(before);
    });

    it('SCRUM363_AC5_safety_submission_acknowledgement_is_not_reused_and_explicit_confirmation_is_recorded', async () => {
      const id = await readyToConfirm({ equipment_requirements: 'Projectors' });
      expect((await written(id)).submissions[0].no_equipment_confirmed).toBe(true);
      for (const ack of [false, null]) {
        const err = await refusal(confirm(id, coordinatorA, ack));
        expect(JSON.parse(err.detail).map((item) => item.key)).toEqual(['no_equipment_confirmation']);
      }
      await confirm(id, coordinatorA, true);
      expect((await written(id)).history.find((row) => row.new_status === 'confirmed')).toMatchObject({
        new_status: 'confirmed', changed_by: coordinatorA,
        reason: 'Event confirmed. Coordinator acknowledged that no equipment is needed.',
      });
    });

    it('SCRUM363_AC5_acknowledgement_without_an_observed_revision_cannot_confirm', async () => {
      const id = await readyToConfirm({ equipment_requirements: 'Projectors' });
      const before = await written(id);
      const err = await refusal(db.query('select confirm_event_request($1, $2, true)', [id, coordinatorA]));
      expect(err?.code).toBe('55000');
      expect(err?.message).toMatch(/refresh/i);
      expect(await written(id)).toEqual(before);
    });

    it('SCRUM363_AC5_an_old_acknowledgement_revision_is_refused_after_a_new_safety_cycle', async () => {
      const id = await readyToConfirm({ equipment_requirements: 'Projectors' });
      const oldRevision = (await one('select updated_at::text as revision from event_requests where id = $1', [id])).revision;
      await confirm(id, coordinatorA, true);
      await db.query("select change_event_request_status($1, 'confirmed', 'approved', $2, 'Reopened for replay test', $2)", [id, coordinatorA]);
      await db.query("update event_requests set equipment_requirements = 'Microphones' where id = $1", [id]);
      await submit(id, coordinatorA, null, true);
      await db.query("select respond_to_safety_review($1, $2, 'approved', null, '{}', false)", [id, safetyOfficers[0]]);
      const before = await written(id);
      const err = await refusal(db.query('select confirm_event_request($1, $2, true, $3::timestamptz)', [id, coordinatorA, oldRevision]));
      expect(err?.code).toBe('55000');
      expect(err?.message).toMatch(/refresh/i);
      expect(await written(id)).toEqual(before);
      await confirm(id, coordinatorA, true);
    });

    it('SCRUM363_AC5_reconfirmation_requires_a_new_acknowledgement_after_a_direct_revert_and_fresh_safety_cycle', async () => {
      const id = await readyToConfirm({ equipment_requirements: 'Projectors' });
      await confirm(id, coordinatorA, true);
      await db.query("select change_event_request_status($1, 'confirmed', 'approved', $2, 'Reopened for acknowledgement test', $2)", [id, coordinatorA]);
      expect((await refusal(confirm(id, coordinatorA, true)))?.code).toBe('55000');
      await submit(id, coordinatorA, null, true);
      await db.query("select respond_to_safety_review($1, $2, 'approved', null, '{}', false)", [id, safetyOfficers[0]]);
      expect((await refusal(confirm(id)))?.hint).toBe('EVENT_NOT_READY');
      await confirm(id, coordinatorA, true);
      expect((await written(id)).history.filter((row) => row.new_status === 'confirmed')).toHaveLength(2);
    });

    it('SCRUM363_AC2_a_booking_that_lost_partial_coverage_after_safety_approval_prevents_confirmation', async () => {
      const id = await readyToConfirm();
      await db.query("update bookings set ends_at = ends_at - interval '1 microsecond' where event_request_id = $1", [id]);
      const before = await written(id);
      const err = await refusal(confirm(id));
      expect(err?.hint).toBe('EVENT_NOT_READY');
      expect(JSON.parse(err.detail)).toEqual([expect.objectContaining({ key: 'venue', met: false, detail: "Does not cover the event's start to end" })]);
      expect(await written(id)).toEqual(before);
    });

    it('SCRUM363_AC2_multiple_approved_venues_can_confirm_only_while_each_still_covers_the_period', async () => {
      const id = await readyToConfirm();
      const second = await booking(id, room2, 'approved');
      await db.query("update bookings set ends_at = ends_at - interval '1 microsecond' where id = $1", [second]);
      const err = await refusal(confirm(id));
      expect(JSON.parse(err.detail)).toEqual([expect.objectContaining({ key: 'venue', bookingId: second, met: false })]);
      await db.query('update bookings b set ends_at = e.proposed_end from event_requests e where b.id = $1 and e.id = b.event_request_id', [second]);
      expect((await confirm(id)).rows[0].status).toBe('confirmed');
      expect((await db.query('select * from bookings where event_request_id = $1', [id])).rows).toHaveLength(2);
    });

    it('SCRUM363_AC2_holds_do_not_replace_a_booking_cancelled_after_safety_approval', async () => {
      const id = await readyToConfirm();
      await db.query("update bookings set status = 'cancelled' where event_request_id = $1", [id]);
      await db.query("insert into venue_holds (event_request_id, venue_id, placed_by, expires_at) values ($1, $2, $3, now() + interval '1 day')", [id, hallA, coordinatorA]);
      const before = await written(id);
      const err = await refusal(confirm(id));
      expect(JSON.parse(err.detail)).toEqual([{ key: 'venue', met: false, detail: 'No venue booking' }]);
      expect(await written(id)).toEqual(before);
    });

    it.each([
      ['under_review', false], ['cannot_be_fully_arranged', false], ['arranged', true], ['cancelled', true],
    ])('SCRUM363_AC2_confirmation_revalidates_equipment_%s_created_after_safety_approval', async (status, allowed) => {
      const id = await readyToConfirm();
      const equipmentRequestId = await equipment(id, status);
      const before = await written(id);
      if (allowed) {
        expect((await confirm(id)).rows[0].status).toBe('confirmed');
      } else {
        const err = await refusal(confirm(id));
        expect(err?.hint).toBe('EVENT_NOT_READY');
        expect(JSON.parse(err.detail)).toEqual([expect.objectContaining({ key: 'equipment', met: false, equipmentRequestId })]);
        expect(await written(id)).toEqual(before);
      }
    });

    it.each([
      ['missing start', null, '1 hour', 'The event has no start date'],
      ['missing end', '0 seconds', null, 'The event has no end date'],
      ['past start', '-1 hour', '0 seconds', "The event's start has passed"],
      ['exact start boundary', '0 seconds', '1 hour', "The event's start has passed"],
    ])('SCRUM363_AC2_confirmation_refuses_%s_without_writes', async (_label, starts, ends, detail) => {
      const id = await readyToConfirm();
      await db.query(`update event_requests
        set proposed_start = case when $2::interval is null then null else now() + $2::interval end,
            proposed_end = case when $3::interval is null then null else now() + $3::interval end where id = $1`, [id, starts, ends]);
      const before = await written(id);
      const err = await refusal(confirm(id));
      expect(err?.hint).toBe('EVENT_NOT_READY');
      expect(JSON.parse(err.detail)).toContainEqual({ key: 'date', met: false, detail });
      expect(await written(id)).toEqual(before);
    });

    it('SCRUM363_AC8_confirmed_fields_are_locked_on_the_organiser_patch_endpoint', async () => {
      const id = await readyToConfirm();
      await confirm(id);
      const original = await one('select * from event_requests where id = $1', [id]);
      const client = { from(table) {
        expect(table).toBe('event_requests');
        const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: original, error: null }) };
        return chain;
      } };
      const app = express().use(express.json()).use('/api/event-requests', createEventRequestRouter({
        client, requireAuth: (req, _res, next) => { req.user = { id: organiser, role: 'event_organiser' }; next(); },
      }));
      const response = await request(app).patch(`/api/event-requests/${id}`).send({ eventName: 'Changed directly' });
      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/request a change/i);
      expect(await one('select * from event_requests where id = $1', [id])).toEqual(original);
      expect((await refusal(db.query('select assert_equipment_editable($1, $2)', [id, coordinatorA])))?.code).toBe('55000');
    });

    function changeRequestApp() {
      const client = { async rpc(fn, args) {
        expect(fn).toBe('process_change_request');
        try {
          const { rows: [data] } = await db.query('select * from process_change_request($1, $2, $3, $4)', [
            args.p_change_request_id, args.p_decision, args.p_decision_notes, args.p_processed_by,
          ]);
          return { data, error: null };
        } catch (error) {
          return { data: null, error: { code: error.code, message: error.message } };
        }
      } };
      return express().use(express.json()).use('/api/event-requests', createEventRequestRouter({
        client, requireAuth: (req, _res, next) => { req.user = { id: coordinatorA, role: 'event_coordinator' }; next(); },
      }));
    }

    async function approveChange(id, field, value) {
      const { id: changeId } = await one(`insert into event_change_requests
        (event_request_id, requested_by, change_field, requested_change)
        values ($1, $2, $3, $4) returning id`, [id, organiser, field, value]);
      const response = await request(changeRequestApp())
        .post(`/api/event-requests/change-requests/${changeId}/decision`).send({ decision: 'approved' });
      return { changeId, response };
    }

    it.each([
      ['event_name', 'Renamed after confirmation'],
      ['description', 'Updated description'],
      ['purpose', 'Updated purpose'],
    ])('SCRUM363_AC8_approved_change_request_applies_ordinary_%s_to_a_confirmed_event', async (field, value) => {
      const id = await readyToConfirm();
      await confirm(id);
      const before = await written(id);
      const { changeId, response } = await approveChange(id, field, value);
      expect(response.status).toBe(200);
      expect((await one(`select ${field} as value from event_requests where id = $1`, [id])).value).toBe(value);
      expect(await written(id)).toEqual(before);
      expect((await one('select status from event_change_requests where id = $1', [changeId])).status).toBe('processed');
    });

    it.each([
      ['proposed_start', "proposed_start + interval '1 hour'"],
      ['expected_attendance', 'coalesce(expected_attendance, 1) + 1'],
      ['venue_requirements', "'A larger hall'"],
      ['accessibility_requirements', "'Step-free access'"],
    ])('SCRUM363_AC8_confirmed_%s_is_locked_even_for_a_trusted_table_writer', async (field, value) => {
      const id = await readyToConfirm();
      await confirm(id);
      const before = await written(id);
      const error = await refusal(db.query(`update event_requests set ${field} = ${value} where id = $1`, [id]));
      expect(error?.code).toBe('55000');
      expect(await written(id)).toEqual(before);
    });

    it('SCRUM363_AC2_confirmation_does_not_open_registration_until_independent_settings_allow_it', async () => {
      const id = await readyToConfirm();
      const register = () => db.query('select register_for_event($1, $2) as result', [id, attendee]);
      expect((await register()).rows[0].result).toEqual({ outcome: 'not_found' });
      await confirm(id);
      expect((await register()).rows[0].result).toEqual({ outcome: 'not_found' });
      await expect(db.query('update event_requests set registration_enabled = true where id = $1', [id]))
        .rejects.toMatchObject({ code: '23514', constraint: 'event_requests_enabled_registration_has_window' });
      await db.query("update event_requests set registration_enabled = true, registration_opens_at = clock_timestamp() + interval '1 day' where id = $1", [id]);
      expect((await register()).rows[0].result).toEqual({ outcome: 'not_found' });
      await db.query("update event_requests set registration_opens_at = clock_timestamp() - interval '2 days', registration_closes_at = clock_timestamp() - interval '1 day' where id = $1", [id]);
      expect((await register()).rows[0].result).toEqual({ outcome: 'not_found' });
      expect((await db.query('select * from event_registrations where event_request_id = $1', [id])).rows).toEqual([]);
      await db.query('update event_requests set registration_closes_at = null where id = $1', [id]);
      const { rows: [{ result }] } = await register();
      expect(result).toMatchObject({ outcome: 'registered', registration: { eventRequestId: id, attendeeId: attendee } });
    });

    it.todo('SCRUM363_AC9_organiser_confirmation_notification_requires_SCRUM175');
    it.todo('SCRUM363_AC9_reconfirmation_notifies_only_active_registered_attendees_requires_SCRUM175');
    it('SCRUM363_AC2_actual_registration_settings_workflow_is_independent_of_confirmation', async () => {
      const id = await readyToConfirm();
      const settings = () => one(`select registration_enabled, registration_opens_at,
        registration_closes_at, registration_capacity, registration_withdrawal_deadline
        from event_requests where id = $1`, [id]);
      const settingsHistory = async () => (await db.query(
        'select * from event_registration_settings_history where event_request_id = $1 order by changed_at, id', [id],
      )).rows;
      const save = (enabled) => one(`select setup_event_registration(
        $1, $2, $3, clock_timestamp() - interval '1 day', null, 1, null) as result`, [id, organiser, enabled]);
      const register = () => one('select register_for_event($1, $2) as result', [id, attendee]);

      expect((await save(true)).result).toMatchObject({ outcome: 'saved', registeredCount: 0 });
      const beforeSettings = await settings();
      const beforeHistory = await settingsHistory();
      expect(beforeHistory).toHaveLength(1);
      expect((await register()).result).toEqual({ outcome: 'not_found' });

      await confirm(id);

      expect(await settings()).toEqual(beforeSettings);
      expect(await settingsHistory()).toEqual(beforeHistory);
      expect((await register()).result).toMatchObject({
        outcome: 'registered', registeredCount: 1,
        registration: { eventRequestId: id, attendeeId: attendee },
      });
      expect((await save(false)).result).toMatchObject({ outcome: 'saved', registeredCount: 1 });
      expect((await db.query('select * from event_registrations where event_request_id = $1', [id])).rows)
        .toEqual([expect.objectContaining({ event_request_id: id, attendee_id: attendee, status: 'registered' })]);
    });

    it('SCRUM363_AC6_queued_repeated_confirmations_write_one_history_row', async () => {
      const id = await readyToConfirm();
      // PGlite queues these on one connection; the two-session race is documented separately.
      const results = await Promise.allSettled([confirm(id), confirm(id)]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected').reason.code).toBe('55000');
      expect((await written(id)).history.filter((row) => row.new_status === 'confirmed')).toHaveLength(1);
    });

    it('SCRUM363_AC6_a_history_write_failure_rolls_back_the_status_and_all_other_state', async () => {
      const id = await readyToConfirm();
      const before = await written(id);
      await db.exec(`
        create function fail_test_confirmation_history() returns trigger language plpgsql as $$
        begin
          if new.new_status = 'confirmed' then raise exception 'Injected history failure'; end if;
          return new;
        end $$;
        create trigger fail_test_confirmation_history before insert on event_request_status_history
          for each row execute function fail_test_confirmation_history();
      `);
      try {
        expect((await refusal(confirm(id)))?.code).toBe('P0001');
        expect(await written(id)).toEqual(before);
      } finally {
        await db.exec('drop trigger fail_test_confirmation_history on event_request_status_history; drop function fail_test_confirmation_history()');
      }
      expect((await confirm(id)).rows[0].status).toBe('confirmed');
    });

    it('SCRUM363_AC6_confirmation_preserves_bookings_equipment_registrations_and_registration_settings', async () => {
      const id = await readyToConfirm();
      await equipment(id, 'arranged');
      await db.query("insert into event_registrations (event_request_id, attendee_id) values ($1, $2)", [id, attendee]);
      await db.query("update event_requests set registration_capacity = 20, registration_opens_at = now() + interval '1 day', registration_closes_at = now() + interval '2 days', registration_withdrawal_deadline = now() + interval '3 days' where id = $1", [id]);
      const snapshot = async () => ({
        bookings: (await db.query('select * from bookings where event_request_id = $1', [id])).rows,
        equipment: (await db.query('select * from equipment_requests where event_request_id = $1', [id])).rows,
        registrations: (await db.query('select * from event_registrations where event_request_id = $1', [id])).rows,
        settings: await one('select registration_enabled, registration_capacity, registration_opens_at, registration_closes_at, registration_withdrawal_deadline from event_requests where id = $1', [id]),
        notices: (await db.query('select * from notifications where event_request_id = $1 order by id', [id])).rows,
      });
      const before = await snapshot();
      await confirm(id);
      expect(await snapshot()).toEqual(before);
      expect(before.settings.registration_enabled).toBe(false);
    });

    it('SCRUM363_AC6_confirm_rpc_is_invoker_security_and_backend_only', async () => {
      const { prosecdef, count } = await one("select bool_or(prosecdef) as prosecdef, count(*) as count from pg_proc where proname = 'confirm_event_request'");
      expect(prosecdef).toBe(false);
      expect(Number(count)).toBe(1);
      expect(await clientsCanExecute(db, 'confirm_event_request(uuid,uuid,boolean,timestamptz)', ['anon', 'authenticated', 'service_role'])).toEqual(['service_role']);
    });

    it.each(['anon', 'authenticated'])('SCRUM363_AC1_database_role_%s_cannot_spoof_confirmation_or_write_status_directly', async (role) => {
      const id = await readyToConfirm();
      const before = await written(id);
      // Model Supabase's table grants: deny-all RLS must still stop client roles.
      await db.exec(`grant usage on schema public to ${role};
        grant select, update on event_requests to ${role};
        grant select, insert on event_request_status_history to ${role};`);
      try {
        await db.exec(`set role ${role}`);
        const rpc = await refusal(db.query('select confirm_event_request($1, $2)', [id, coordinatorA]));
        expect(rpc?.code).toBe('42501');
        const direct = await db.query("update event_requests set status = 'confirmed' where id = $1 returning id", [id]);
        expect(direct.rows).toEqual([]);
        const transition = await refusal(db.query("select change_event_request_status($1, 'safety_approved', 'confirmed', $2)", [id, coordinatorA]));
        expect(transition?.code).toBe('P0002');
      } finally {
        await db.exec('reset role');
      }
      expect(await written(id)).toEqual(before);
    });
  });

  describe('the status update safety gate', () => {
    it('SCRUM490_AC12_a_new_event_cannot_start_past_the_safety_gate', async () => {
      const refused = await refusal(
        db.query(
          `insert into event_requests (organiser_id, event_name, status)
           values ($1, 'Bypass event', 'confirmed')`,
          [organiser],
        ),
      );

      expect(refused?.code).toBe('55000');
      expect(Number((await one("select count(*) from event_requests where event_name = 'Bypass event'")).count))
        .toBe(0);
    });

    it('SCRUM490_AC12_direct_status_updates_cannot_skip_submission_or_safety_approval', async () => {
      const id = await readyEvent();

      const enterSafetyReview = await refusal(
        db.query("update event_requests set status = 'safety_review' where id = $1", [id]),
      );
      expect(enterSafetyReview?.code).toBe('55000');
      expect((await one('select status::text as status from event_requests where id = $1', [id])).status)
        .toBe('approved');

      const bypassSafetyReview = await refusal(
        db.query("update event_requests set status = 'confirmed' where id = $1", [id]),
      );
      expect(bypassSafetyReview?.code).toBe('55000');
      expect((await one('select status::text as status from event_requests where id = $1', [id])).status)
        .toBe('approved');
    });

    it('SCRUM490_AC7_a_resubmission_after_changes_rechecks_each_returned_arrangement', async () => {
      const id = await readyEvent();
      const bookingId = (await one(
        'select id from bookings where event_request_id = $1',
        [id],
      )).id;
      const equipmentId = await equipment(id, 'arranged');
      await submit(id, coordinatorA, 'Crowd moves through the east doors.');

      await db.query(
        `insert into safety_review_responses (event_request_id, safety_officer_id, outcome, note)
         values ($1, $2, 'changes_requested', 'Update the exit plan.')`,
        [id, safetyOfficers[0]],
      );
      await db.query("update bookings set status = 'flagged_for_review' where id = $1", [bookingId]);
      await db.query("update equipment_requests set status = 'pending_review' where id = $1", [equipmentId]);
      await db.query("update event_requests set status = 'approved' where id = $1", [id]);
      await db.query(
        `insert into event_request_status_history
           (event_request_id, previous_status, new_status, changed_by, reason)
         values ($1, 'safety_review', 'approved', $2, 'Changes required')`,
        [id, safetyOfficers[0]],
      );

      const refused = await refusal(submit(id, coordinatorA, 'Updated arrangements.'));
      expect(refused?.code).toBe('PT409');
      expect(JSON.parse(refused.detail).map((item) => item.key)).toEqual(['venue', 'equipment']);
      expect((await written(id)).event.status).toBe('approved');
      expect((await written(id)).submissions).toHaveLength(1);

      await db.query("update bookings set status = 'approved' where id = $1", [bookingId]);
      await db.query("update equipment_requests set status = 'arranged' where id = $1", [equipmentId]);
      await submit(id, coordinatorA, 'Updated arrangements.');

      expect((await written(id)).event.status).toBe('safety_review');
      expect((await written(id)).submissions).toHaveLength(2);
    });
  });


  // -------------------------------------------------------------------------
  // AC3: every outstanding item; the read changes nothing
  // -------------------------------------------------------------------------
  describe('AC3: every outstanding item is listed', () => {
    it('SCRUM489_AC3_three_outstanding_items_are_all_listed_in_the_refusal', async () => {
      // AC3-01: a pending booking, equipment that cannot be fully arranged, a
      // past start. All three, not just the first.
      const id = await event({ proposed_start: at(-1), proposed_end: at(-0.9) });
      const bookingId = await booking(id, room2, 'pending');
      const requestId = await equipment(id, 'cannot_be_fully_arranged');

      const err = await refusal(submit(id));

      expect(err?.code).toBe('PT409');
      expect(err.hint).toBe('EVENT_NOT_READY');
      expect(err.message).toBe('This event is not ready for the safety check.');
      expect(JSON.parse(err.detail)).toEqual([
        {
          key: 'venue', met: false, detail: 'Awaiting approval', bookingId, venueName: 'Room 2',
          startsAt: expect.any(String), endsAt: expect.any(String),
        },
        { key: 'equipment', met: false, detail: 'Cannot be fully arranged', equipmentRequestId: requestId },
        { key: 'date', met: false, detail: "The event's start has passed" },
      ]);
    });

    it('SCRUM489_AC3_the_readiness_read_changes_nothing_and_lists_what_the_refusal_lists', async () => {
      // AC3-05.
      const id = await event();
      await booking(id, room2, 'flagged_for_review');
      const before = await written(id);

      const first = await readiness(id);
      const second = await readiness(id);
      const err = await refusal(submit(id));

      expect(second).toEqual(first);
      expect(JSON.parse(err.detail)).toEqual(first.items.filter((item) => !item.met));
      expect(await written(id)).toEqual(before);
    });
  });


  // -------------------------------------------------------------------------
  // AC4: the no-equipment acknowledgement
  // -------------------------------------------------------------------------
  describe('AC4: the no-equipment acknowledgement', () => {
    it('SCRUM489_AC4_requirements_with_no_active_request_need_a_confirmation_and_unconfirmed_are_refused', async () => {
      // AC4-01.
      const id = await readyEvent({ equipment_requirements: 'Two projectors' });

      expect((await readiness(id)).items[1]).toEqual({
        key: 'no_equipment_confirmation', met: false,
        detail: 'Confirm that this event needs no equipment', organiserRequirements: 'Two projectors',
      });
      const err = await refusal(submit(id));
      expect(err?.code).toBe('PT409');
      expect(JSON.parse(err.detail).map((item) => item.key)).toEqual(['no_equipment_confirmation']);
    });

    it('SCRUM489_AC4_confirmed_it_submits_and_the_acknowledgement_is_recorded', async () => {
      // AC4-02.
      const id = await readyEvent({ equipment_requirements: 'Two projectors' });

      await submit(id, coordinatorA, null, true);

      expect((await written(id)).submissions[0].no_equipment_confirmed).toBe(true);
    });

    it('SCRUM489_AC4_whitespace_requirements_or_an_active_request_need_no_confirmation', async () => {
      // AC4-03, AC4-04.
      const blank = await readyEvent({ equipment_requirements: '   ' });
      const requested = await readyEvent({ equipment_requirements: 'Two projectors' });
      await equipment(requested, 'arranged');

      for (const id of [blank, requested]) {
        expect((await readiness(id)).items.map((item) => item.key)).not.toContain('no_equipment_confirmation');
      }
    });

    it('SCRUM489_AC4_a_confirmation_with_nothing_to_confirm_is_stored_false', async () => {
      // AC4-05.
      const id = await readyEvent();

      await submit(id, coordinatorA, null, true);

      expect((await written(id)).submissions[0].no_equipment_confirmed).toBe(false);
    });
  });


  // -------------------------------------------------------------------------
  // AC1: only the assigned coordinator, only while Approved
  // -------------------------------------------------------------------------
  describe('AC1: who may submit, and from which status', () => {
    it.each([
      ['another coordinator', () => coordinatorB],
      ['a Lead', () => lead],
      ['the organiser', () => organiser],
      ['a Safety Officer', () => safetyOfficers[0]],
      ['a null caller', () => null],
    ])('SCRUM489_AC1_%s_is_refused_with_42501_and_nothing_is_written', async (_label, caller) => {
      // AC1-02, AC1-03, AC1-05, AC1-06.
      const id = await readyEvent();
      const before = await written(id);

      const err = await refusal(submit(id, caller()));

      expect(err?.code).toBe('42501');
      expect(err.message).toBe("Only the event's assigned coordinator can submit it for the safety check");
      expect(await written(id)).toEqual(before);
    });

    it.each([
      ['draft', 'a Draft'],
      ['submitted', 'Submitted'],
      ['under_review', 'Under review'],
      ['pending_clarification', 'Pending clarification'],
      ['safety_review', 'Safety review'],
      ['safety_approved', 'Safety approved'],
      ['confirmed', 'Confirmed'],
      ['completed', 'Completed'],
      ['rejected', 'Rejected'],
      ['cancelled', 'Cancelled'],
    ])('SCRUM489_AC1_an_event_that_is_%s_is_refused_naming_its_status', async (status, words) => {
      // AC1-04, AC1-06. The status is set with the triggers off: this tests the
      // refusal, not how an event reaches each status.
      const id = await readyEvent();
      await putInStatus(id, status);
      const before = await written(id);

      const err = await refusal(submit(id));

      expect(err?.code).toBe('55000');
      expect(err.message).toBe(`This event can be submitted for the safety check only while it is Approved. It is ${words}.`);
      expect(await written(id)).toEqual(before);
    });

    it('SCRUM489_AC1_a_second_submission_is_refused_as_safety_review', async () => {
      const id = await readyEvent();
      await submit(id);

      const err = await refusal(submit(id));

      expect(err?.code).toBe('55000');
      expect(err.message).toMatch(/It is Safety review\.$/);
      expect((await written(id)).submissions).toHaveLength(1);
    });

    it('SCRUM489_AC1_a_null_event_is_refused_with_22004', async () => {
      expect((await refusal(submit(null)))?.code).toBe('22004');
    });

    it('SCRUM489_AC1_an_unknown_event_is_refused_with_P0002', async () => {
      expect((await refusal(submit('00000000-0000-4000-8000-000000000000')))?.code).toBe('P0002');
    });
  });


  // -------------------------------------------------------------------------
  // AC5, AC6, AC8: the note, what is recorded, who is told
  // -------------------------------------------------------------------------
  describe('AC5, AC6, AC8: a submission', () => {
    it('SCRUM489_AC6_the_status_history_submission_and_notices_are_written_once', async () => {
      // AC6-01, AC6-02, AC8-01: one history row approved -> safety_review with
      // the coordinator and the note; one submission row; one notice to each
      // Safety Officer and to nobody else.
      const id = await readyEvent();
      const otherNoticesBefore = Number((await one('select count(*) from notifications')).count);

      const { rows: [row] } = await submit(id, coordinatorA, '  Crowd moves through the east doors.  ');
      const after = await written(id);

      expect(row.status).toBe('safety_review');
      expect(after.event.status).toBe('safety_review');
      expect(after.history.at(-1)).toEqual({
        previous_status: 'approved', new_status: 'safety_review', changed_by: coordinatorA,
        reason: 'Crowd moves through the east doors.',
      });
      expect(after.history.filter((entry) => entry.new_status === 'safety_review')).toHaveLength(1);
      expect(after.submissions).toEqual([expect.objectContaining({
        event_request_id: id, submitted_by: coordinatorA, note: 'Crowd moves through the east doors.',
        no_equipment_confirmed: false, created_at: expect.any(Date),
      })]);
      expect(after.notices.map((notice) => notice.recipient_id).sort()).toEqual([...safetyOfficers].sort());
      expect(after.notices[0].payload).toEqual({
        eventRequestId: id, eventName: 'IS212 Industry Night', coordinatorId: coordinatorA,
        coordinatorName: 'Priya Nair', startsAt: expect.any(String), submittedAt: expect.any(String),
      });
      expect(Number((await one('select count(*) from notifications')).count)).toBe(otherNoticesBefore + safetyOfficers.length);
    });

    it.each([
      ['exactly 2,000 characters', 'x'.repeat(2000), 'x'.repeat(2000)],
      ['empty', '', null],
      ['only whitespace', '   ', null],
      ['absent', null, null],
    ])('SCRUM489_AC5_a_note_that_is_%s_is_stored_as_it_should_be', async (_label, note, stored) => {
      // AC5-01, AC5-03: an empty note is no note, in the submission and the history.
      const id = await readyEvent();

      await submit(id, coordinatorA, note);
      const after = await written(id);

      expect(after.submissions[0].note).toBe(stored);
      expect(after.history.at(-1).reason).toBe(stored);
    });

    it('SCRUM489_AC5_a_note_over_2000_characters_is_refused_with_22023', async () => {
      // AC5-02.
      const id = await readyEvent();
      const before = await written(id);

      expect((await refusal(submit(id, coordinatorA, 'x'.repeat(2001))))?.code).toBe('22023');
      expect(await written(id)).toEqual(before);
    });

    it('SCRUM489_AC6_a_submission_row_cannot_be_changed_or_deleted', async () => {
      // AC6-03.
      const id = await readyEvent();
      await submit(id, coordinatorA, 'Original');

      expect((await refusal(db.query("update safety_review_submissions set note = 'Edited' where event_request_id = $1", [id])))?.code).toBe('42501');
      expect((await refusal(db.query('delete from safety_review_submissions where event_request_id = $1', [id])))?.code).toBe('42501');
      expect((await written(id)).submissions[0].note).toBe('Original');
    });

    it('SCRUM489_AC8_with_no_safety_officer_it_still_submits_and_notifies_nobody', async () => {
      // AC8-02.
      const id = await readyEvent();
      await db.query("update profiles set role = 'event_coordinator' where role = 'safety_officer'");
      try {
        await submit(id);
        expect((await written(id)).event.status).toBe('safety_review');
        expect((await written(id)).notices).toEqual([]);
      } finally {
        await db.query('update profiles set role = \'safety_officer\' where id = any($1)', [safetyOfficers]);
      }
    });
  });


  // -------------------------------------------------------------------------
  // AC8-03: the notice type
  // -------------------------------------------------------------------------
  describe('the submission notice', () => {
    it('SCRUM489_AC8_the_type_list_keeps_every_earlier_type_and_the_submission_notice', async () => {
      // A later list that restated an older one would drop the submission notice.
      const { def } = await one("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'notifications_type_known'");
      expect([...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1])).toEqual(expect.arrayContaining([
        'booking_flagged', 'booking_request_withdrawn', 'clarification_requested', 'clarification_replied',
        'clarification_closed', 'booking_flagged_setup_change', 'venue_hold_expired', 'event_cancelled',
        'event_request_awaiting_assignment', 'event_request_assigned', 'event_request_coordinator_assigned',
        'safety_review_response', 'safety_booking_flagged', 'safety_equipment_review',
        'event_submitted_for_safety_review',
      ]));
    });

    it('SCRUM489_AC8_submit_inserts_a_notification_for_each_safety_officer', async () => {
      const id = await readyEvent();

      await submit(id);

      const notices = (await written(id)).notices;
      expect(notices.map(({ recipient_id }) => recipient_id).sort()).toEqual([...safetyOfficers].sort());
      expect(notices[0]).toMatchObject({
        payload: expect.objectContaining({
          eventRequestId: id,
        }),
      });
    });
  });
});
