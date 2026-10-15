/**
 * SCRUM-489 (SCRUM-555, SCRUM-556): migration 064 on a real Postgres (PGlite):
 * the readiness check shared with SCRUM-363, and submitting an Approved event for
 * the Operational Safety Check. Cases: docs/test-cases/SCRUM-489.md.
 *
 * Migrations: the event lifecycle up to 052 as scrum488SafetyStatusesDatabase
 * applies it; 002, 009, 011 and 027 for venues and bookings with every status
 * (011 needs btree_gist); 022 and 038 for equipment requests and their words;
 * 062 and 063 for the safety statuses; then 064.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name) => readFileSync(resolve(here, '../../db/migrations', name), 'utf8');

const LIFECYCLE = [
  '001_event_requests.sql',
  '005_event_request_details.sql',
  '007_user_roles.sql',
  '010_event_request_clarifications.sql',
  '025_event_request_decisions.sql',
  '014_coordinator_assignment.sql',
  '015_assignment_function.sql',
  '016_submit_event_request.sql',
  '017_require_assigned_coordinator.sql',
  '020_event_status_lifecycle.sql',
  '021_event_status_history.sql',
  '022_event_status_transitions.sql',
  '029_event_request_decisions_functions.sql',
  '006_event_change_requests.sql',
  '019_change_request_decision_coordinator.sql',
  '039_coordinator_lead_and_safety_officer_roles.sql',
];
const ARRANGEMENTS = [
  '002_venues.sql',
  '009_bookings.sql',
  '011_venue_blocks.sql',
  '027_booking_request_statuses.sql',
  '022_equipment_schema.sql',
  '038_equipment_review.sql',
];
const MIGRATION = '064_safety_review_submission.sql';

const DAY = 86_400_000;
const at = (days) => new Date(Date.now() + days * DAY).toISOString();

describe('SCRUM-489: migration 064, readiness and submission for the safety check', () => {
  let db;
  let organiser;
  let coordinatorA;
  let coordinatorB;
  let lead;
  let safetyOfficers;
  let hallA;
  let room2;

  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
  const refusal = async (promise) => {
    try {
      await promise;
      return null;
    } catch (err) {
      return err;
    }
  };

  /** An Approved event held by A, starting in 10 days, with no arrangements. */
  async function event(overrides = {}) {
    const fields = {
      event_name: 'IS212 Industry Night',
      proposed_start: at(10),
      proposed_end: at(10.25),
      equipment_requirements: null,
      ...overrides,
    };
    return (await one(
      `insert into event_requests
         (organiser_id, event_name, status, submitted_at, assigned_coordinator_id, reviewing_coordinator_id,
          decision, decided_by, decided_at, proposed_start, proposed_end, equipment_requirements)
       values ($1, $2, 'approved', now(), $3, $3, 'approved', $3, now(), $4, $5, $6) returning id`,
      [organiser, fields.event_name, coordinatorA, fields.proposed_start, fields.proposed_end, fields.equipment_requirements],
    )).id;
  }

  async function booking(eventId, venueId, status = 'approved', { starts = null, ends = null } = {}) {
    const times = await one('select proposed_start, proposed_end from event_requests where id = $1', [eventId]);
    return (await one(
      `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
       values ($1, $2, $3, $4, $5::booking_status) returning id`,
      [venueId, eventId, starts ?? times.proposed_start, ends ?? times.proposed_end, status],
    )).id;
  }

  // 038 requires a reviewer exactly when a request is under review.
  const equipment = async (eventId, status) =>
    (await one(
      `insert into equipment_requests (event_request_id, status, reviewer_id, review_started_at)
       values ($1, $2::equipment_request_status,
               case when $2 = 'under_review' then $3::uuid end, case when $2 = 'under_review' then now() end)
       returning id`,
      [eventId, status, organiser],
    )).id;

  /**
   * Put an event straight into a status, with the decision fields 025 and 062
   * require there. Triggers off: this seeds the refusal, not a real move.
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
    db = new PGlite({ extensions: { btree_gist } });
    await db.exec(`
      create schema auth;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text);
      create role anon;
      create role authenticated;
      create role service_role;
    `);
    for (const name of LIFECYCLE) await db.exec(migration(name));
    // The notifications table 052 writes to, in the shape the other suites build.
    await db.exec(`
      create table notifications (
        id uuid primary key default gen_random_uuid(),
        recipient_id uuid not null references auth.users (id) on delete cascade,
        type text not null,
        booking_id uuid,
        block_id uuid,
        venue_hold_id uuid,
        payload jsonb not null default '{}',
        read_at timestamptz,
        created_at timestamptz not null default now(),
        constraint notifications_type_known check (type in ('booking_flagged'))
      );
    `);
    await db.exec('alter table event_requests add column clarification_reply_by_date date');
    await db.exec(migration('052_lead_assignment.sql'));
    await db.exec(migration('042_event_cancellation_fields.sql'));
    for (const name of ARRANGEMENTS) await db.exec(migration(name));
    await db.exec(migration('062_safety_statuses.sql'));
    await db.exec(migration('063_safety_transitions.sql'));
    await db.exec(migration(MIGRATION));
    // A stand-in for 040's holds, as cancelEventRequestDatabase builds it: AC2-13
    // needs a hold to exist, and event_readiness must not count it.
    await db.exec(`
      create table venue_holds (
        id uuid primary key default gen_random_uuid(),
        event_request_id uuid not null references event_requests (id),
        venue_id uuid not null references venues (id),
        expires_at timestamptz not null,
        status text not null default 'active'
      );
    `);

    const user = async (email, role, name) => {
      const id = (await one('insert into auth.users (email) values ($1) returning id', [email])).id;
      await db.query('insert into profiles (id, role, full_name) values ($1, $2, $3)', [id, role, name]);
      return id;
    };
    organiser = await user('o@x', 'event_organiser', 'Aisha Rahman');
    coordinatorA = await user('a@x', 'event_coordinator', 'Priya Nair');
    coordinatorB = await user('b@x', 'event_coordinator', 'Omar Okafor');
    lead = await user('lead@x', 'event_coordinator_lead', 'Lena Lead');
    safetyOfficers = [await user('so1@x', 'safety_officer', 'Sam Safe'), await user('so2@x', 'safety_officer', 'Sol Secure')];
    hallA = (await one("insert into venues (name, location, max_capacity) values ('Hall A', 'SMU', 200) returning id")).id;
    room2 = (await one("insert into venues (name, location, max_capacity) values ('Room 2', 'SMU', 40) returning id")).id;
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
          { key: 'venue', met: true, detail: 'Approved', bookingId, venueName: 'Hall A' },
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
      await db.query("insert into venue_holds (event_request_id, venue_id, expires_at) values ($1, $2, now() + interval '2 days')", [id, room2]);

      expect((await readiness(id)).items[0]).toEqual({ key: 'venue', met: false, detail: 'No venue booking' });
      expect((await readiness(id)).items.filter((item) => item.key === 'venue')).toHaveLength(1);
    });

    it.each([
      ['arranged', true, 'Arranged'],
      ['cannot_be_fully_arranged', false, 'Cannot be fully arranged'],
      ['pending_review', false, 'Pending review'],
      ['under_review', false, 'Under review'],
    ])('SCRUM489_AC2_an_equipment_request_%s_is_met_only_when_arranged', async (status, met, detail) => {
      // AC2-08, in 038's words.
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
        { key: 'venue', met: false, detail: 'Awaiting approval', bookingId, venueName: 'Room 2' },
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
  // AC6-05, AC8-03: the migration itself
  // -------------------------------------------------------------------------
  describe('064 itself', () => {
    it('SCRUM489_AC8_the_type_list_keeps_every_earlier_type_and_adds_this_storys', async () => {
      // AC8-03: 052's eleven, SCRUM-490's three, and this story's one.
      const { def } = await one("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'notifications_type_known'");
      expect([...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1])).toEqual([
        'booking_flagged', 'booking_request_withdrawn', 'clarification_requested', 'clarification_replied',
        'clarification_closed', 'booking_flagged_setup_change', 'venue_hold_expired', 'event_cancelled',
        'event_request_awaiting_assignment', 'event_request_assigned', 'event_request_coordinator_assigned',
        'safety_review_response', 'safety_booking_flagged', 'safety_equipment_review',
        'event_submitted_for_safety_review',
      ]);
    });

    it('SCRUM489_AC6_064_is_safe_to_run_twice', async () => {
      // AC6-05.
      await db.exec(migration(MIGRATION));

      const count = async (sql) => Number((await one(sql)).count);
      expect(await count("select count(*) from pg_constraint where conname = 'notifications_type_known'")).toBe(1);
      expect(await count("select count(*) from pg_trigger where tgname = 'safety_review_submissions_immutable'")).toBe(1);
      expect(await count("select count(*) from pg_proc where proname = 'submit_event_for_safety_review'")).toBe(1);
      expect(await count("select count(*) from pg_proc where proname = 'event_readiness'")).toBe(1);
      const id = await readyEvent();
      await submit(id);
      expect((await written(id)).event.status).toBe('safety_review');
    });
  });
});
