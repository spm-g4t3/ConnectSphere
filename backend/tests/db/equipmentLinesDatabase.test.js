/**
 * SCRUM-248 for SCRUM-21: the equipment line functions, run against the final
 * schema in a real Postgres (PGlite).
 *
 * Calls the functions the way the service does and checks what is left in the
 * tables. Events are seeded straight into the status under test.
 *
 * Test names are SCRUM21_ACn_<what_it_checks>, matching the SCRUM-19 test
 * document, so each test traces back to its criterion.
 *
 * What PGlite is not: Supabase, and it has one connection, so two writers at
 * the same moment are not exercised here. The functions lock the event row for
 * that, as start_event_review does.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedEvent, seedUser } from './helpers/schemaDb.js';
import { queriesFor, refusal } from './helpers/queries.js';
import { asJson } from './helpers/equipment.js';

const NO_SUCH_ID = '00000000-0000-0000-0000-000000000000';

describe('SCRUM-21: recording equipment lines in Postgres', () => {
  let db;
  let organiser;
  let coordinator;
  let otherCoordinator;
  let techSupport;
  let projector;
  let microphone;
  let retiredType;

  const { one } = queriesFor(() => db);

  const newUser = (email) => seedUser(db, { email });
  const newType = async (name, { retired = false } = {}) =>
    (await one(
      `insert into equipment_types (name, total_quantity, retired_at)
       values ($1, 10, ${retired ? 'now()' : 'null'}) returning id`,
      [name],
    )).id;
  const newEvent = (status = 'approved', assigned = coordinator) =>
    seedEvent(db, { status, organiser_id: organiser, event_name: `Event ${Math.random()}`, assigned_coordinator_id: assigned });

  const add = async (event, who, type, quantity, notes = null) =>
    asJson(await one('select add_equipment_line($1, $2, $3, $4, $5)::text as answer', [event, who, type, quantity, notes]));
  const amend = async (event, who, line, quantity = null, notes = null, changeNotes = false) =>
    asJson(await one(
      'select amend_equipment_line($1, $2, $3, $4, $5, $6)::text as answer',
      [event, who, line, quantity, notes, changeNotes],
    ));
  const remove = async (event, who, line) =>
    asJson(await one('select remove_equipment_line($1, $2, $3)::text as answer', [event, who, line]));
  const read = async (event) =>
    asJson(await one('select equipment_for_event($1)::text as answer', [event]));

  // Under review needs a reviewer and a start time; every other status needs neither.
  const setRequestStatus = (event, status) =>
    db.query(
      `update equipment_requests
          set status = $2::equipment_request_status,
              reviewer_id = case when $2 = 'under_review' then $3::uuid end,
              review_started_at = case when $2 = 'under_review' then now() end
        where event_request_id = $1`,
      [event, status, techSupport],
    );
  const reserve = async (event, type, line) =>
    (await one(
      `insert into equipment_reservations
         (equipment_type_id, event_request_id, equipment_line_id, quantity, start_at, end_at)
       values ($1, $2, $3, 1, '2026-12-01T10:00:00Z', '2026-12-01T12:00:00Z') returning id`,
      [type, event, line],
    )).id;
  const reservation = (id) => one('select flagged, released_at, released_by, release_reason from equipment_reservations where id = $1', [id]);
  const lineByName = (state, name) => state.request.lines.find((line) => line.name === name);

  beforeAll(async () => {
    db = await createSchemaDb();

    organiser = await newUser('organiser@example.com');
    coordinator = await newUser('coordinator@example.com');
    otherCoordinator = await newUser('other-coordinator@example.com');
    techSupport = await newUser('tech@example.com');

    projector = await newType('Projector');
    microphone = await newType('Microphone');
    retiredType = await newType('Retired rig', { retired: true });
  }, 60000);

  afterAll(async () => {
    await db?.close();
  });


  describe('the read function', () => {
    it('SCRUM21_equipment_for_event_is_stable_so_a_read_cannot_write', async () => {
      const row = await one("select provolatile from pg_proc where proname = 'equipment_for_event'");
      expect(row.provolatile).toBe('s');
    });
  });


  describe('AC1: who may change equipment, and when', () => {
    it.each([
      ['an unassigned coordinator', () => otherCoordinator],
      ['the organiser', () => organiser],
      ['technical support staff', () => techSupport],
      ['nobody', () => null],
    ])('SCRUM21_AC1_refuses_%s_with_42501_and_changes_nothing', async (_label, who) => {
      const event = await newEvent();
      const err = await refusal(add(event, who(), projector, 1));

      expect(err.code).toBe('42501');
      expect((await read(event)).request).toBeNull();
    });

    it.each([
      ['draft', 'a Draft'],
      ['submitted', 'Submitted'],
      ['under_review', 'Under review'],
      ['pending_clarification', 'Pending clarification'],
      ['rejected', 'Rejected'],
      ['cancelled', 'Cancelled'],
      ['completed', 'Completed'],
    ])('SCRUM21_AC1_refuses_a_%s_event_with_55000_naming_the_status_in_words', async (status, words) => {
      const event = await newEvent(status);
      const err = await refusal(add(event, coordinator, projector, 1));

      expect(err.code).toBe('55000');
      expect(err.message).toContain(words);
      expect((await read(event)).request).toBeNull();
    });

    it('SCRUM21_AC1_answers_P0002_for_an_event_that_does_not_exist', async () => {
      const err = await refusal(add(NO_SUCH_ID, coordinator, projector, 1));
      expect(err.code).toBe('P0002');
    });

    it('SCRUM21_AC10_a_confirmed_event_is_refused_with_the_significant_change_message', async () => {
      const event = await newEvent('confirmed');
      const err = await refusal(add(event, coordinator, projector, 1));

      expect(err.code).toBe('55000');
      expect(err.message).toMatch(/significant change/);
    });
  });


  describe('AC2 to AC5: adding lines', () => {
    it('SCRUM21_AC5_the_first_line_creates_a_pending_review_request', async () => {
      const event = await newEvent();
      const state = await add(event, coordinator, projector, 2, '  needs HDMI  ');

      expect(state.request.status).toBe('pending_review');
      expect(state.request.lines).toHaveLength(1);
      expect(state.request.lines[0]).toMatchObject({ name: 'Projector', quantity: 2, technical_notes: 'needs HDMI' });
    });

    it.each([[0], [-1], [null]])('SCRUM21_AC3_refuses_a_quantity_of_%s_with_22023', async (quantity) => {
      const event = await newEvent();
      const err = await refusal(add(event, coordinator, projector, quantity));

      expect(err.code).toBe('22023');
      expect((await read(event)).request).toBeNull();
    });

    it('SCRUM21_AC2_refuses_a_type_that_does_not_exist', async () => {
      const event = await newEvent();
      const err = await refusal(add(event, coordinator, NO_SUCH_ID, 1));
      expect(err.code).toBe('22023');
    });

    it('SCRUM21_AC2_refuses_a_retired_type_and_says_so', async () => {
      const event = await newEvent();
      const err = await refusal(add(event, coordinator, retiredType, 1));

      expect(err.code).toBe('22023');
      expect(err.message).toMatch(/retired/);
    });

    it('SCRUM21_AC4_refuses_the_same_type_twice_with_23505_and_keeps_one_line', async () => {
      const event = await newEvent();
      await add(event, coordinator, projector, 1);
      const err = await refusal(add(event, coordinator, projector, 3));

      expect(err.code).toBe('23505');
      expect((await read(event)).request.lines).toHaveLength(1);
    });

    it('SCRUM21_AC4_the_table_itself_still_refuses_a_duplicate_naming_the_rule', async () => {
      const event = await newEvent();
      const state = await add(event, coordinator, projector, 1);
      const err = await refusal(db.query(
        'insert into equipment_lines (equipment_request_id, equipment_type_id, quantity) values ($1, $2, 1)',
        [state.request.id, projector],
      ));

      expect(err.code).toBe('23505');
      expect(err.message).toContain('equipment_lines_one_per_type');
    });

    it.each([['under_review'], ['arranged'], ['cannot_be_fully_arranged']])(
      'SCRUM21_AC7_adding_a_line_returns_a_%s_request_to_pending_review',
      async (status) => {
        const event = await newEvent();
        await add(event, coordinator, projector, 1);
        await setRequestStatus(event, status);

        const state = await add(event, coordinator, microphone, 1);
        expect(state.request.status).toBe('pending_review');
      },
    );
  });


  describe('AC6 and AC7: amending lines', () => {
    it('SCRUM21_AC7_amending_returns_the_request_to_pending_review_and_flags_only_that_lines_reservations', async () => {
      const event = await newEvent();
      await add(event, coordinator, projector, 2);
      const state = await add(event, coordinator, microphone, 4);
      const projectorLine = lineByName(state, 'Projector').id;
      const microphoneLine = lineByName(state, 'Microphone').id;
      const projectorReservation = await reserve(event, projector, projectorLine);
      const microphoneReservation = await reserve(event, microphone, microphoneLine);
      await setRequestStatus(event, 'arranged');

      const after = await amend(event, coordinator, projectorLine, 5);

      expect(after.request.status).toBe('pending_review');
      expect(lineByName(after, 'Projector').quantity).toBe(5);
      expect((await reservation(projectorReservation)).flagged).toBe(true);
      expect((await reservation(projectorReservation)).released_at).toBeNull();
      expect((await reservation(microphoneReservation)).flagged).toBe(false);
    });

    it('SCRUM21_AC6_notes_can_be_cleared_when_the_change_flag_is_set', async () => {
      const event = await newEvent();
      const line = (await add(event, coordinator, projector, 2, 'old note')).request.lines[0].id;

      const after = await amend(event, coordinator, line, null, null, true);
      expect(after.request.lines[0].technical_notes).toBeNull();
    });

    it('SCRUM21_AC6_an_amendment_that_changes_nothing_leaves_the_status_and_flags_alone', async () => {
      const event = await newEvent();
      const line = (await add(event, coordinator, projector, 2, 'x')).request.lines[0].id;
      const reservationId = await reserve(event, projector, line);
      await setRequestStatus(event, 'arranged');

      const after = await amend(event, coordinator, line, 2);

      expect(after.request.status).toBe('arranged');
      expect((await reservation(reservationId)).flagged).toBe(false);
    });

    it('SCRUM21_AC6_refuses_an_empty_amendment_and_a_non_positive_quantity_with_22023', async () => {
      const event = await newEvent();
      const line = (await add(event, coordinator, projector, 2)).request.lines[0].id;

      expect((await refusal(amend(event, coordinator, line))).code).toBe('22023');
      expect((await refusal(amend(event, coordinator, line, 0))).code).toBe('22023');
    });

    it('SCRUM21_AC6_refuses_a_missing_line_and_a_line_of_another_event_with_P0002', async () => {
      const event = await newEvent();
      const otherEvent = await newEvent();
      await add(event, coordinator, projector, 2);
      const foreignLine = (await add(otherEvent, coordinator, projector, 2)).request.lines[0].id;

      expect((await refusal(amend(event, coordinator, foreignLine, 3))).code).toBe('P0002');
      expect((await refusal(amend(event, coordinator, NO_SUCH_ID, 3))).code).toBe('P0002');
    });

    it('SCRUM21_AC1_an_unassigned_coordinator_cannot_amend', async () => {
      const event = await newEvent();
      const line = (await add(event, coordinator, projector, 2)).request.lines[0].id;

      expect((await refusal(amend(event, otherCoordinator, line, 3))).code).toBe('42501');
      expect(lineByName(await read(event), 'Projector').quantity).toBe(2);
    });
  });


  describe('AC6 to AC9: removing lines', () => {
    it('SCRUM21_AC7_removing_a_line_releases_only_its_reservations_and_returns_to_pending_review', async () => {
      const event = await newEvent();
      await add(event, coordinator, projector, 2);
      const state = await add(event, coordinator, microphone, 1);
      const projectorLine = lineByName(state, 'Projector').id;
      const microphoneLine = lineByName(state, 'Microphone').id;
      const projectorReservation = await reserve(event, projector, projectorLine);
      const microphoneReservation = await reserve(event, microphone, microphoneLine);
      await setRequestStatus(event, 'arranged');

      const after = await remove(event, coordinator, projectorLine);

      expect(after.request.status).toBe('pending_review');
      expect(after.request.lines).toHaveLength(1);
      const released = await reservation(projectorReservation);
      expect(released.released_at).not.toBeNull();
      // A release the system makes for a removed line records no person.
      expect(released.released_by).toBeNull();
      expect(released.release_reason).toBe('line removed');
      expect((await reservation(microphoneReservation)).released_at).toBeNull();
    });

    it('SCRUM21_AC7_a_reservation_is_released_never_deleted', async () => {
      const event = await newEvent();
      const line = (await add(event, coordinator, projector, 2)).request.lines[0].id;
      await add(event, coordinator, microphone, 1);
      const reservationId = await reserve(event, projector, line);

      await remove(event, coordinator, line);

      expect(await reservation(reservationId)).toBeDefined();
    });

    it('SCRUM21_AC8_removing_the_last_line_cancels_the_request_and_releases_its_reservations', async () => {
      const event = await newEvent();
      const line = (await add(event, coordinator, projector, 2)).request.lines[0].id;
      const reservationId = await reserve(event, projector, line);

      const after = await remove(event, coordinator, line);

      expect(after.request.status).toBe('cancelled');
      expect(after.request.lines).toHaveLength(0);
      expect((await reservation(reservationId)).release_reason).toBe('request cancelled');
    });

    it('SCRUM21_AC9_adding_after_cancelled_creates_a_new_request_and_keeps_the_cancelled_one', async () => {
      const event = await newEvent();
      const line = (await add(event, coordinator, projector, 2)).request.lines[0].id;
      const cancelledId = (await remove(event, coordinator, line)).request.id;

      const after = await add(event, coordinator, projector, 1);

      expect(after.request.id).not.toBe(cancelledId);
      expect(after.request.status).toBe('pending_review');
      expect(after.request.lines).toHaveLength(1);
      const cancelled = await one('select status::text as status from equipment_requests where id = $1', [cancelledId]);
      expect(cancelled.status).toBe('cancelled');
    });

    it('SCRUM21_AC4_a_type_can_be_added_again_after_its_line_was_removed', async () => {
      const event = await newEvent();
      const first = (await add(event, coordinator, projector, 2)).request.lines[0].id;
      await add(event, coordinator, microphone, 1);
      await remove(event, coordinator, first);

      const after = await add(event, coordinator, projector, 7);
      expect(lineByName(after, 'Projector').quantity).toBe(7);
    });

    it('SCRUM21_AC1_an_unassigned_coordinator_cannot_remove', async () => {
      const event = await newEvent();
      const line = (await add(event, coordinator, projector, 2)).request.lines[0].id;

      expect((await refusal(remove(event, otherCoordinator, line))).code).toBe('42501');
      expect((await read(event)).request.lines).toHaveLength(1);
    });
  });


  describe('atomicity', () => {
    it('SCRUM21_atomic_a_failure_partway_through_changes_nothing', async () => {
      const event = await newEvent();
      const line = (await add(event, coordinator, projector, 2)).request.lines[0].id;
      await reserve(event, projector, line);
      await setRequestStatus(event, 'arranged');

      await db.exec(`
        create function force_failure() returns trigger language plpgsql as $$
        begin raise exception 'forced failure'; end $$;
        create trigger force_failure_trigger before update on equipment_reservations
          for each row execute function force_failure();
      `);
      const err = await refusal(amend(event, coordinator, line, 9));
      await db.exec('drop trigger force_failure_trigger on equipment_reservations');

      expect(err.message).toMatch(/forced failure/);
      const state = await read(event);
      expect(lineByName(state, 'Projector').quantity).toBe(2);
      expect(state.request.status).toBe('arranged');
    });
  });


  describe('AC11: reading', () => {
    it('SCRUM21_AC11_an_event_that_never_asked_for_equipment_has_no_request', async () => {
      const event = await newEvent();
      expect((await read(event)).request).toBeNull();
    });
  });
});
