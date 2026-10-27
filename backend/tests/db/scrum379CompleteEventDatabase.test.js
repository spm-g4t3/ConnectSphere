/**
 * SCRUM-379: complete_event_request (034) and the closing notes column (033),
 * against the final schema. Test names carry the acceptance criterion they cover.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, functionSources, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor, expectSqlError, refusal } from './helpers/queries.js';
import { withSafetyReviewTransitionGuardDisabled } from '../fixtures/safetyReviewTestHelpers.js';

const migration = (name) => new URL(`../../db/migrations/${name}`, import.meta.url);

// complete_event_request reads time through event_clock(). The suite replaces it with
// this fixed instant, so no test depends on the real clock or on how long a run takes.
// 17:00 UTC is 01:00 on the next day in Singapore, so the UTC and SGT dates differ.
const FIXED_NOW = '2030-06-15T17:00:00Z';
const SGT = 480;
const pad = (n) => String(n).padStart(2, '0');

// FIXED_NOW plus `seconds`, written with a UTC offset, e.g. 2030-06-16T00:59:00+08:00.
function at(seconds = 0, offsetMinutes = 0) {
  const shifted = new Date(Date.parse(FIXED_NOW) + seconds * 1000 + offsetMinutes * 60_000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${shifted.toISOString().slice(0, 19)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

describe('SCRUM-379: complete_event_request in Postgres', () => {
  let db;
  let organiser;
  let coordinator;
  let otherCoordinator;
  let technicalSupport;
  let attendee;
  let venueId;

  const { one, rows } = queriesFor(() => db);
  const eventRow = (id) => one('select * from event_requests where id = $1', [id]);
  const statusHistory = (id) => rows(
    `select previous_status::text, new_status::text, changed_by, reason, created_at
       from event_request_status_history where event_request_id = $1 order by created_at, id`,
    [id],
  );
  const reservationsOf = (id) => rows(
    'select quantity, released_at, released_by, release_reason from equipment_reservations where event_request_id = $1',
    [id],
  );
  const changeRequestsOf = (id) => rows(
    'select status::text as status, decision::text as decision, processed_by from event_change_requests where event_request_id = $1 order by created_at, id',
    [id],
  );

  // Equipment type names are unique; a counter keeps them distinct without randomness.
  let typeSequence = 0;

  const complete = (eventId, who = coordinator, notes = null) =>
    db.query('select * from complete_event_request($1, $2, $3)', [eventId, who, notes]);

  // A Confirmed event ending at `endAt` (any offset; default two hours before the pinned
  // clock), optionally holding reservations on `lines` equipment lines.
  async function confirmedEvent({
    endAt = at(-7200), withEquipment = false, lines = 1, assigned = coordinator,
  } = {}) {
    const eventId = await seedEvent(db, {
      status: 'approved',
      organiser_id: organiser,
      event_name: 'Completion test',
      assigned_coordinator_id: assigned,
      reviewing_coordinator_id: assigned,
    });
    const lineIds = [];
    if (withEquipment) {
      // Reservations need the event dated ahead; the end is moved to `endAt` afterwards.
      await db.query(
        "update event_requests set proposed_start = '2099-01-01T09:00:00Z', proposed_end = '2099-01-01T11:00:00Z' where id = $1",
        [eventId],
      );
      for (let i = 0; i < lines; i += 1) {
        const type = (await one(
          'insert into equipment_types (name, total_quantity) values ($1, 10) returning id',
          [`Projector ${(typeSequence += 1)}`],
        )).id;
        const state = JSON.parse((await one(
          'select add_equipment_line($1, $2, $3, $4, null)::text as answer',
          [eventId, coordinator, type, 3],
        )).answer);
        lineIds.push(state.request.lines.map((line) => line.id).find((id) => !lineIds.includes(id)));
      }
      await db.query('select start_equipment_review($1, $2)', [eventId, technicalSupport]);
      for (const lineId of lineIds) {
        await db.query('select reserve_equipment($1, $2, $3, $4)', [eventId, technicalSupport, lineId, 2]);
      }
    }
    await db.query(
      `update event_requests
          set proposed_start = $2::timestamptz - interval '2 hours', proposed_end = $2::timestamptz
        where id = $1`,
      [eventId, endAt],
    );
    await withSafetyReviewTransitionGuardDisabled(db, () => db.query(
      "update event_requests set status = 'confirmed' where id = $1",
      [eventId],
    ));
    return eventId;
  }

  const lineIdsOf = async (eventId) => (await rows(
    `select l.id from equipment_lines l join equipment_requests r on r.id = l.equipment_request_id
      where r.event_request_id = $1 order by l.created_at, l.id`,
    [eventId],
  )).map((row) => row.id);

  async function changeRequest(eventId, status = 'outstanding') {
    const id = (await one(
      `insert into event_change_requests (event_request_id, requested_by, change_field, requested_change)
       values ($1, $2, 'other', 'Change the format') returning id`,
      [eventId, organiser],
    )).id;
    if (status === 'in_progress') {
      await db.query("update event_change_requests set status = 'in_progress' where id = $1", [id]);
    }
    if (status === 'processed') {
      await db.query(
        "update event_change_requests set status = 'processed', decision = 'rejected', processed_by = $2 where id = $1",
        [id, coordinator],
      );
    }
    return id;
  }

  // Everything a refusal must leave alone.
  async function snapshot(eventId) {
    return {
      event: await eventRow(eventId),
      history: await statusHistory(eventId),
      reservations: await reservationsOf(eventId),
      changeRequests: await changeRequestsOf(eventId),
    };
  }

  beforeAll(async () => {
    db = await createSchemaDb();
    await db.exec(`create or replace function event_clock() returns timestamptz language sql as $$ select '${FIXED_NOW}'::timestamptz $$`);
    organiser = await seedUser(db, { email: 'organiser@test', role: 'event_organiser' });
    coordinator = await seedUser(db, { email: 'coordinator@test', role: 'event_coordinator' });
    otherCoordinator = await seedUser(db, { email: 'other-coordinator@test', role: 'event_coordinator' });
    technicalSupport = await seedUser(db, { email: 'technical-support@test', role: 'technical_support_staff' });
    attendee = await seedUser(db, { email: 'attendee@test', role: 'attendee' });
    venueId = await seedVenue(db, { name: 'Hall', capacity: 100, setup: 0, turnaround: 0 });
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('AC1: who, which status, and when', () => {
    it('SCRUM379_AC1_the_assigned_coordinator_completes_a_confirmed_event_after_its_end', async () => {
      const eventId = await confirmedEvent();
      const event = (await complete(eventId)).rows[0];
      expect(event.status).toBe('completed');
      expect((await eventRow(eventId)).status).toBe('completed');
    });

    it('SCRUM379_AC1_an_event_that_ended_one_second_ago_can_be_completed', async () => {
      const eventId = await confirmedEvent({ endAt: at(-1) });
      expect((await complete(eventId)).rows[0].status).toBe('completed');
    });

    it('SCRUM379_AC1_an_event_ending_exactly_at_the_current_time_can_be_completed', async () => {
      const eventId = await confirmedEvent({ endAt: at(0) });
      expect((await complete(eventId)).rows[0].status).toBe('completed');
    });

    it('SCRUM379_AC1_an_event_that_ends_in_one_minute_is_refused_with_a_message_about_the_end_time', async () => {
      const eventId = await confirmedEvent({ endAt: at(60) });
      const before = await snapshot(eventId);
      const error = await refusal(complete(eventId));
      expect(error.code).toBe('55000');
      expect(error.message).toMatch(/has not ended yet/);
      expect(await snapshot(eventId)).toEqual(before);
    });

    it('SCRUM379_AC1_an_event_with_no_end_time_cannot_be_completed', async () => {
      const eventId = await confirmedEvent();
      await db.exec(`alter table event_requests disable trigger event_requests_confirmed_fields`);
      await db.query('update event_requests set proposed_start = null, proposed_end = null where id = $1', [eventId]);
      await db.exec(`alter table event_requests enable trigger event_requests_confirmed_fields`);
      const error = await refusal(complete(eventId));
      expect(error.code).toBe('55000');
      expect((await eventRow(eventId)).status).toBe('confirmed');
    });

    it('SCRUM379_AC1_a_coordinator_who_is_not_assigned_is_refused_and_nothing_changes', async () => {
      const eventId = await confirmedEvent({ withEquipment: true });
      await changeRequest(eventId);
      const before = await snapshot(eventId);
      const error = await refusal(complete(eventId, otherCoordinator));
      expect(error.code).toBe('42501');
      expect(error.message).toMatch(/Only the coordinator assigned/);
      expect(await snapshot(eventId)).toEqual(before);
    });

    it.each([
      ['the organiser', () => organiser],
      ['an attendee', () => attendee],
      ['technical support staff', () => technicalSupport],
    ])('SCRUM379_AC1_%s_is_refused', async (_name, who) => {
      const eventId = await confirmedEvent();
      const before = await snapshot(eventId);
      const error = await refusal(complete(eventId, who()));
      expect(error.code).toBe('42501');
      expect(await snapshot(eventId)).toEqual(before);
    });

    it('SCRUM379_AC1_a_missing_caller_or_event_id_is_refused', async () => {
      const eventId = await confirmedEvent();
      await expectSqlError(complete(eventId, null), '22004');
      await expectSqlError(complete(null, coordinator), '22004');
      expect((await eventRow(eventId)).status).toBe('confirmed');
    });

    it('SCRUM379_AC1_an_unknown_event_is_not_found', async () => {
      await expectSqlError(complete('00000000-0000-0000-0000-000000000000'), 'P0002');
    });

    it.each([
      'draft', 'submitted', 'under_review', 'pending_clarification', 'approved',
      'safety_review', 'safety_approved', 'rejected', 'cancelled', 'completed',
    ])('SCRUM379_AC1_a_%s_event_is_refused_with_a_message_naming_its_status', async (status) => {
      const eventId = await seedEvent(db, {
        status,
        organiser_id: organiser,
        event_name: `Status ${status}`,
        assigned_coordinator_id: coordinator,
        reviewing_coordinator_id: coordinator,
        proposed_start: '2020-01-01T09:00:00Z',
        proposed_end: '2020-01-01T11:00:00Z',
      });
      const before = await snapshot(eventId);
      const error = await refusal(complete(eventId));
      expect(error.code).toBe('55000');
      expect(error.message).toContain(`has status ${status}`);
      expect(await snapshot(eventId)).toEqual(before);
    });
  });

  describe('AC2: closing notes', () => {
    it('SCRUM379_AC2_notes_are_stored_with_the_event', async () => {
      const eventId = await confirmedEvent();
      const event = (await complete(eventId, coordinator, 'Attendance 180 of 200. Projector failed at 7pm.')).rows[0];
      expect(event.closing_notes).toBe('Attendance 180 of 200. Projector failed at 7pm.');
      expect((await eventRow(eventId)).closing_notes).toBe('Attendance 180 of 200. Projector failed at 7pm.');
    });

    it('SCRUM379_AC2_notes_are_optional', async () => {
      const eventId = await confirmedEvent();
      await complete(eventId);
      expect((await eventRow(eventId)).closing_notes).toBeNull();
    });

    it.each([[''], ['   '], ['\n\t ']])('SCRUM379_AC2_blank_notes_%j_are_stored_as_null', async (notes) => {
      const eventId = await confirmedEvent();
      await complete(eventId, coordinator, notes);
      expect((await eventRow(eventId)).closing_notes).toBeNull();
    });

    it('SCRUM379_AC2_notes_are_trimmed', async () => {
      const eventId = await confirmedEvent();
      await complete(eventId, coordinator, '  All went well.  ');
      expect((await eventRow(eventId)).closing_notes).toBe('All went well.');
    });

    it('SCRUM379_AC2_notes_of_exactly_2000_characters_are_accepted', async () => {
      const eventId = await confirmedEvent();
      await complete(eventId, coordinator, 'x'.repeat(2000));
      expect((await eventRow(eventId)).closing_notes).toHaveLength(2000);
    });

    it('SCRUM379_AC2_notes_over_2000_characters_are_refused_and_nothing_changes', async () => {
      const eventId = await confirmedEvent({ withEquipment: true });
      const before = await snapshot(eventId);
      await expectSqlError(complete(eventId, coordinator, 'x'.repeat(2001)), '22023');
      expect(await snapshot(eventId)).toEqual(before);
    });

    it('SCRUM379_AC2_notes_with_a_quote_or_semicolon_are_stored_as_written', async () => {
      const eventId = await confirmedEvent();
      const notes = `Guest said "great"; 3 left early'; drop table event_requests; --`;
      await complete(eventId, coordinator, notes);
      expect((await eventRow(eventId)).closing_notes).toBe(notes);
    });

    it.each(['draft', 'submitted', 'approved', 'confirmed', 'cancelled'])(
      'SCRUM379_AC2_the_database_rejects_notes_on_a_%s_row',
      async (status) => {
        const eventId = await seedEvent(db, {
          status,
          organiser_id: organiser,
          assigned_coordinator_id: coordinator,
          reviewing_coordinator_id: coordinator,
        });
        await expectSqlError(
          db.query('update event_requests set closing_notes = $2 where id = $1', [eventId, 'sneaky']),
          '23514',
          'event_requests_closing_notes_only_completed',
        );
      },
    );

    it('SCRUM379_AC2_the_database_rejects_empty_notes_on_a_completed_row', async () => {
      const eventId = await seedEvent(db, {
        status: 'completed',
        organiser_id: organiser,
        assigned_coordinator_id: coordinator,
        reviewing_coordinator_id: coordinator,
      });
      await expectSqlError(
        db.query("update event_requests set closing_notes = '  ' where id = $1", [eventId]),
        '23514',
        'event_requests_closing_notes_nonblank',
      );
    });
  });

  describe('AC3: Completed is final', () => {
    it('SCRUM379_AC3_nothing_leads_out_of_completed', async () => {
      const { rows: transitions } = await db.query(
        `select s::text as status, event_request_status_allows('completed', s) as allowed
           from unnest(enum_range(null::event_request_status)) as s`,
      );
      expect(transitions.filter((row) => row.allowed)).toEqual([]);
    });

    it('SCRUM379_AC3_a_completed_event_cannot_be_completed_again', async () => {
      const eventId = await confirmedEvent();
      await complete(eventId, coordinator, 'First');
      const error = await refusal(complete(eventId, coordinator, 'Second'));
      expect(error.code).toBe('55000');
      const after = await eventRow(eventId);
      expect(after.closing_notes).toBe('First');
      expect(await statusHistory(eventId)).toHaveLength(1);
    });

    it('SCRUM379_AC3_a_completed_event_cannot_be_cancelled', async () => {
      const eventId = await confirmedEvent();
      await complete(eventId);
      await expectSqlError(
        db.query(
          "select cancel_event_request($1, $2, 'Too late', 'connectsphere_decision'::event_cancellation_initiator, null)",
          [eventId, coordinator],
        ),
        '55000',
      );
      expect((await eventRow(eventId)).status).toBe('completed');
    });
  });

  describe('AC4: the same action releases, closes and keeps', () => {
    it('SCRUM379_AC4_live_equipment_reservations_are_released_with_the_reason_event_completed', async () => {
      const eventId = await confirmedEvent({ withEquipment: true });
      expect((await reservationsOf(eventId))[0].released_at).toBeNull();

      await complete(eventId);

      const [reservation] = await reservationsOf(eventId);
      expect(reservation.released_at).not.toBeNull();
      expect(reservation.release_reason).toBe('event completed');
      // A system release, like the one on cancellation: no person is recorded on the reservation.
      expect(reservation.released_by).toBeNull();
      const history = await rows(
        'select action, reason, quantity_after from equipment_reservation_events where event_request_id = $1 order by id',
        [eventId],
      );
      // The fixture moves the dates into the past, which flags the reservation first.
      // What matters: it is released exactly once, last, with this reason.
      const released = history.filter((row) => row.action === 'released');
      expect(released).toHaveLength(1);
      expect(history.at(-1)).toMatchObject({ action: 'released', reason: 'event completed', quantity_after: 0 });
    });

    it('SCRUM379_AC4_released_reservation_rows_are_kept_not_deleted', async () => {
      const eventId = await confirmedEvent({ withEquipment: true });
      await complete(eventId);
      expect(await reservationsOf(eventId)).toHaveLength(1);
    });

    it("SCRUM379_AC4_another_event's_reservations_are_left_alone", async () => {
      const completed = await confirmedEvent({ withEquipment: true });
      const other = await confirmedEvent({ withEquipment: true });
      await complete(completed);
      expect((await reservationsOf(other))[0].released_at).toBeNull();
    });

    it('SCRUM379_AC4_an_event_with_no_equipment_completes_cleanly', async () => {
      const eventId = await confirmedEvent();
      await complete(eventId);
      expect(await reservationsOf(eventId)).toEqual([]);
    });

    it('SCRUM379_AC4_open_change_requests_are_closed_with_the_outcome_event_completed', async () => {
      const eventId = await confirmedEvent();
      await changeRequest(eventId, 'outstanding');
      await changeRequest(eventId, 'in_progress');
      await complete(eventId);
      const requests = await changeRequestsOf(eventId);
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request).toMatchObject({ status: 'processed', decision: 'event_completed', processed_by: coordinator });
      }
    });

    it('SCRUM379_AC4_a_change_request_already_processed_keeps_its_own_outcome', async () => {
      const eventId = await confirmedEvent();
      await changeRequest(eventId, 'processed');
      await complete(eventId);
      expect((await changeRequestsOf(eventId))[0]).toMatchObject({ status: 'processed', decision: 'rejected' });
    });

    it("SCRUM379_AC4_another_event's_change_requests_are_left_alone", async () => {
      const completed = await confirmedEvent();
      const other = await confirmedEvent();
      await changeRequest(other);
      await complete(completed);
      expect((await changeRequestsOf(other))[0]).toMatchObject({ status: 'outstanding', decision: null });
    });

    it('SCRUM379_AC4_the_venue_booking_is_kept_as_a_history_record', async () => {
      const eventId = await confirmedEvent();
      const bookingId = await seedBooking(db, {
        venueId, eventId, status: 'approved', start: '2026-12-01T09:00:00Z', end: '2026-12-01T10:00:00Z',
      });
      await complete(eventId);
      const booking = await one('select status::text as status, released_at from bookings where id = $1', [bookingId]);
      expect(booking).toMatchObject({ status: 'approved', released_at: null });
    });

    it('SCRUM379_AC4_registration_is_closed_because_a_completed_event_is_not_confirmed', async () => {
      const eventId = await confirmedEvent();
      await complete(eventId);
      // register_for_event reports a refusal as an outcome and hides why, so the
      // reason is read from the eligibility check it calls.
      const result = await one('select register_for_event($1, $2) as result', [eventId, attendee]);
      expect(result.result).toEqual({ outcome: 'not_found' });
      await expectSqlError(db.query('select assert_event_registration_eligible($1, $2)', [eventId, attendee]), '55000');
      expect(await rows('select 1 from event_registrations where event_request_id = $1', [eventId])).toEqual([]);
    });
  });

  describe('AC6: who completed it and when', () => {
    it('SCRUM379_AC6_the_status_history_records_the_coordinator_and_the_time', async () => {
      const eventId = await confirmedEvent();
      await complete(eventId);
      const history = await statusHistory(eventId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        previous_status: 'confirmed',
        new_status: 'completed',
        changed_by: coordinator,
      });
      expect(history[0].created_at).toBeInstanceOf(Date);
    });
  });

  describe('atomicity', () => {
    it('SCRUM379_AC4_a_forced_failure_rolls_everything_back', async () => {
      const eventId = await confirmedEvent({ withEquipment: true });
      await changeRequest(eventId);
      const before = await snapshot(eventId);

      // The change-request update is the last step, so failing it proves the
      // status change, the notes and the equipment release all roll back.
      await db.exec(`
        create function pg_temp_fail_change_request() returns trigger language plpgsql as $$
        begin raise exception 'forced failure' using errcode = 'P0001'; end $$;
        create trigger zz_force_failure before update on event_change_requests
          for each row execute function pg_temp_fail_change_request();
      `);
      try {
        const error = await refusal(complete(eventId, coordinator, 'Should not survive'));
        expect(error.message).toMatch(/forced failure/);
      } finally {
        await db.exec('drop trigger zz_force_failure on event_change_requests; drop function pg_temp_fail_change_request();');
      }

      expect(await snapshot(eventId)).toEqual(before);
      expect((await eventRow(eventId)).closing_notes).toBeNull();
    });
  });

  describe('migrations', () => {
    it('SCRUM379_AC2_the_closing_notes_migration_runs_twice_without_error', async () => {
      const scratch = await createSchemaDb();
      try {
        const sql = readFileSync(migration('033_event_closing_notes.sql'), 'utf8');
        await scratch.exec(sql);
        await scratch.exec(sql);
        const { rows: constraints } = await scratch.query(
          `select conname from pg_constraint
            where conrelid = 'event_requests'::regclass and conname like 'event_requests_closing_notes%'
            order by conname`,
        );
        expect(constraints.map((row) => row.conname)).toEqual([
          'event_requests_closing_notes_nonblank',
          'event_requests_closing_notes_only_completed',
        ]);
      } finally {
        await scratch.close();
      }
    });

    it('SCRUM379_AC4_the_complete_function_migration_runs_twice_without_error', async () => {
      const scratch = await createSchemaDb();
      try {
        const sql = readFileSync(migration('034_complete_event_request.sql'), 'utf8');
        await scratch.exec(sql);
        await scratch.exec(sql);
        const { rows: found } = await scratch.query(
          "select count(*)::int as n from pg_proc where proname = 'complete_event_request'",
        );
        expect(found[0].n).toBe(1);
        const { rows: values } = await scratch.query(
          "select count(*)::int as n from unnest(enum_range(null::change_request_decision)) v where v::text = 'event_completed'",
        );
        expect(values[0].n).toBe(1);
      } finally {
        await scratch.close();
      }
    });

    it('SCRUM379_AC1_client_roles_cannot_call_the_function_but_the_api_role_can', async () => {
      const { rows: grants } = await db.query(
        `select r as role,
                has_function_privilege(r, 'complete_event_request(uuid, uuid, text)', 'execute') as allowed
           from unnest(array['anon', 'authenticated', 'service_role']) as r`,
      );
      expect(Object.fromEntries(grants.map((row) => [row.role, row.allowed]))).toEqual({
        anon: false,
        authenticated: false,
        service_role: true,
      });
    });
  });

  describe('time: instants, not wall-clock times', () => {
    // The clock is pinned to FIXED_NOW, so every case below is exact and repeatable.
    // SGT is UTC+8 with no daylight saving. Event times are timestamptz, so the rule
    // compares two instants; the offset an event was written with, or the session's
    // time zone, cannot change the result.
    const OFFSETS = [['SGT +08:00', SGT], ['UTC', 0], ['-08:00', -480], ['+14:00', 840], ['-12:00', -720]];
    const completedAfter = async (endAt) => (await complete(await confirmedEvent({ endAt }))).rows[0].status;

    it('SCRUM379_AC1_the_suite_pins_the_clock_to_one_fixed_instant', async () => {
      const { now } = await one('select event_clock()::text as now');
      expect(new Date(now).toISOString()).toBe(new Date(FIXED_NOW).toISOString());
    });

    it.each(OFFSETS)('SCRUM379_AC1_an_event_that_ended_a_minute_before_the_clock_in_%s_can_be_completed', async (_name, offset) => {
      expect(await completedAfter(at(-60, offset))).toBe('completed');
    });

    it.each(OFFSETS)('SCRUM379_AC1_an_event_that_ends_exactly_at_the_clock_in_%s_can_be_completed', async (_name, offset) => {
      expect(await completedAfter(at(0, offset))).toBe('completed');
    });

    it.each(OFFSETS)('SCRUM379_AC1_an_event_that_ends_a_minute_after_the_clock_in_%s_is_refused', async (_name, offset) => {
      const eventId = await confirmedEvent({ endAt: at(60, offset) });
      const before = await snapshot(eventId);
      const error = await refusal(complete(eventId));
      expect(error.code).toBe('55000');
      expect(error.message).toMatch(/has not ended yet/);
      expect(await snapshot(eventId)).toEqual(before);
    });

    it('SCRUM379_AC1_one_second_after_the_clock_is_refused_and_one_second_before_is_accepted', async () => {
      expect((await refusal(complete(await confirmedEvent({ endAt: at(1) })))).code).toBe('55000');
      expect(await completedAfter(at(-1))).toBe('completed');
    });

    it('SCRUM379_AC1_the_boundary_holds_to_the_microsecond', async () => {
      expect((await refusal(complete(await confirmedEvent({ endAt: '2030-06-15T17:00:00.000001Z' })))).code).toBe('55000');
      expect(await completedAfter('2030-06-15T16:59:59.999999Z')).toBe('completed');
    });

    it.each(['Asia/Singapore', 'UTC', 'America/Los_Angeles', 'Pacific/Kiritimati'])(
      'SCRUM379_AC1_the_result_does_not_depend_on_the_session_time_zone_%s',
      async (zone) => {
        await db.query(`set time zone '${zone}'`);
        try {
          const past = await confirmedEvent({ endAt: at(-60) });
          const future = await confirmedEvent({ endAt: at(60) });
          expect((await complete(past)).rows[0].status).toBe('completed');
          const error = await refusal(complete(future));
          expect(error.code).toBe('55000');
          expect((await eventRow(future)).status).toBe('confirmed');
        } finally {
          await db.query('reset time zone');
        }
      },
    );

    // The clock is 01:00 on 16 June in Singapore but 17:00 on 15 June in UTC. An end time
    // whose written digits look "later" than the clock's UTC digits is still in the past
    // once its offset is applied.
    it.each([
      ['2030-06-15T23:59:00+08:00', 'completed'],
      ['2030-06-16T00:59:00+08:00', 'completed'],
      ['2030-06-16T01:00:00+08:00', 'completed'],
      ['2030-06-16T01:01:00+08:00', 'refused'],
      ['2030-06-16T23:59:00+08:00', 'refused'],
    ])('SCRUM379_AC1_an_end_time_written_in_singapore_time_%s_is_%s', async (endAt, outcome) => {
      const eventId = await confirmedEvent({ endAt });
      if (outcome === 'completed') {
        expect((await complete(eventId)).rows[0].status).toBe('completed');
      } else {
        expect((await refusal(complete(eventId))).code).toBe('55000');
        expect((await eventRow(eventId)).status).toBe('confirmed');
      }
    });
  });

  describe('the clock itself', () => {
    it('SCRUM379_AC1_the_function_reads_time_only_through_event_clock', async () => {
      const source = (await functionSources(db)).complete_event_request;
      expect(source).toContain('event_clock()');
      expect(source).not.toMatch(/clock_timestamp\(\)|\bnow\(\)|current_timestamp/i);
    });

    it('SCRUM379_AC1_unpinned_event_clock_is_the_real_current_time', async () => {
      // Monotonic by definition, so this holds however long the run takes.
      const scratch = await createSchemaDb();
      try {
        const { rows: result } = await scratch.query(
          'select now() <= event_clock() as after_start, event_clock() <= clock_timestamp() as before_end',
        );
        expect(result[0]).toEqual({ after_start: true, before_end: true });
      } finally {
        await scratch.close();
      }
    });

    it('SCRUM379_AC1_client_roles_cannot_call_event_clock', async () => {
      const { rows: grants } = await db.query(
        `select r as role, has_function_privilege(r, 'event_clock()', 'execute') as allowed
           from unnest(array['anon', 'authenticated', 'service_role']) as r`,
      );
      expect(Object.fromEntries(grants.map((row) => [row.role, row.allowed]))).toEqual({
        anon: false,
        authenticated: false,
        service_role: true,
      });
    });
  });

  describe('more equipment and more notes', () => {
    it('SCRUM379_AC4_every_reservation_on_several_lines_is_released_exactly_once', async () => {
      const eventId = await confirmedEvent({ withEquipment: true, lines: 3 });
      expect(await reservationsOf(eventId)).toHaveLength(3);

      await complete(eventId);

      const reservations = await reservationsOf(eventId);
      expect(reservations).toHaveLength(3);
      for (const reservation of reservations) {
        expect(reservation.released_at).not.toBeNull();
        expect(reservation.release_reason).toBe('event completed');
      }
      const released = await rows(
        "select equipment_reservation_id from equipment_reservation_events where event_request_id = $1 and action = 'released'",
        [eventId],
      );
      expect(released).toHaveLength(3);
      expect(new Set(released.map((row) => row.equipment_reservation_id)).size).toBe(3);
    });

    it('SCRUM379_AC4_a_reservation_released_earlier_keeps_its_own_reason_and_is_not_released_twice', async () => {
      const eventId = await confirmedEvent({ withEquipment: true, lines: 2 });
      const [firstLine] = await lineIdsOf(eventId);
      await db.query("select release_equipment_reservations($1, $2, 'manual release', $3)", [eventId, firstLine, technicalSupport]);

      await complete(eventId);

      expect((await reservationsOf(eventId)).map((row) => row.release_reason).sort())
        .toEqual(['event completed', 'manual release']);
      const released = await rows(
        "select reason from equipment_reservation_events where event_request_id = $1 and action = 'released' order by id",
        [eventId],
      );
      expect(released.map((row) => row.reason).sort()).toEqual(['event completed', 'manual release']);
    });

    it('SCRUM379_AC4_a_reservation_row_is_never_written_to_the_other_events_history', async () => {
      const completed = await confirmedEvent({ withEquipment: true, lines: 2 });
      const other = await confirmedEvent({ withEquipment: true, lines: 2 });
      const before = await rows('select action from equipment_reservation_events where event_request_id = $1 order by id', [other]);
      await complete(completed);
      const after = await rows('select action from equipment_reservation_events where event_request_id = $1 order by id', [other]);
      expect(after).toEqual(before);
    });

    it('SCRUM379_AC2_emoji_and_non_latin_notes_are_stored_as_written', async () => {
      const eventId = await confirmedEvent();
      const notes = '会议顺利 \u{1F600} café ñ';
      await complete(eventId, coordinator, notes);
      expect((await eventRow(eventId)).closing_notes).toBe(notes);
    });

    it('SCRUM379_AC2_interior_line_breaks_are_kept_and_only_the_ends_are_trimmed', async () => {
      const eventId = await confirmedEvent();
      await complete(eventId, coordinator, '\n  Line one\n\nLine two  \n');
      expect((await eventRow(eventId)).closing_notes).toBe('Line one\n\nLine two');
    });

    it('SCRUM379_AC2_the_limit_counts_characters_not_bytes', async () => {
      const ok = await confirmedEvent();
      await complete(ok, coordinator, '\u{1F600}'.repeat(2000));
      expect([...(await eventRow(ok)).closing_notes]).toHaveLength(2000);

      const tooLong = await confirmedEvent();
      await expectSqlError(complete(tooLong, coordinator, '\u{1F600}'.repeat(2001)), '22023');
      expect((await eventRow(tooLong)).status).toBe('confirmed');
    });

    it('SCRUM379_AC4_the_function_takes_the_event_row_lock_before_it_reads_the_status', async () => {
      // A static guard, not a concurrency test: PGlite has one connection, so two
      // simultaneous completions cannot be run. This fails if the lock is removed.
      const source = (await functionSources(db)).complete_event_request;
      const lock = source.search(/from event_requests\s+where id = p_event_request_id\s+for update/);
      const statusCheck = source.search(/status::text is distinct from 'confirmed'/);
      expect(lock).toBeGreaterThan(-1);
      expect(statusCheck).toBeGreaterThan(lock);
    });
  });
});
