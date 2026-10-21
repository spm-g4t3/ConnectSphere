/**
 * SCRUM-489 (SCRUM-559): the seam with SCRUM-300's reservations, against the
 * final schema in PGlite. event_readiness reads the equipment request's status,
 * so SCRUM-300's meaning of Arranged should flow through unchanged:
 *
 *   a request is arranged only when every line is fully reserved;
 *   flag_equipment_reservations sends an arranged request back to
 *   pending_review when a reservation is flagged.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getConfirmedArrangementsForOrganiser } from '../../src/services/eventRequestService.js';
import { createAttendeeEventSqlClient } from '../fixtures/attendeeEventSqlClient.js';
import { getAttendeeEvent } from '../../src/services/attendeeEventService.js';
import { createSchemaDb, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor, refusal } from './helpers/queries.js';
import { clientsCanExecute } from './helpers/grants.js';

const DAY = 86_400_000;
const at = (days) => new Date(Date.now() + days * DAY).toISOString();

describe('SCRUM-489 (SCRUM-559): readiness reads SCRUM-300\'s Arranged', () => {
  let db;
  let organiser;
  let coordinator;
  let technician;
  let safetyOfficer;
  let hall;

  const { one } = queriesFor(() => db);

  const readiness = async (id) => (await one('select event_readiness($1) as r', [id])).r;
  const equipmentLine = async (id) => (await readiness(id)).items.find((item) => item.key === 'equipment');
  const requestStatus = async (id) =>
    (await one("select status::text as s from equipment_requests where event_request_id = $1 and status <> 'cancelled'", [id])).s;

  /**
   * An Approved event held by the coordinator, otherwise ready (an approved
   * covering booking, a future start), with one line of two projectors that
   * Technical Support has reserved in full through SCRUM-300's own path.
   */
  async function readyEventArrangedBySCRUM300(venueId = hall) {
    const id = await seedEvent(db, {
      status: 'approved',
      organiser_id: organiser,
      assigned_coordinator_id: coordinator,
      event_name: 'IS212 Industry Night',
      proposed_start: at(10),
      proposed_end: at(10.25),
    });
    await seedBooking(db, { venueId, eventId: id, status: 'approved' });
    const projector = (await one(
      'insert into equipment_types (name, total_quantity) values ($1, 10) returning id', [`Projector ${Math.random()}`],
    )).id;
    await db.query('select add_equipment_line($1, $2, $3, 2)', [id, coordinator, projector]);
    const line = (await one(
      `select l.id from equipment_lines l join equipment_requests r on r.id = l.equipment_request_id
        where r.event_request_id = $1`, [id],
    )).id;
    await db.query('select start_equipment_review($1, $2)', [id, technician]);
    await db.query('select reserve_equipment($1, $2, $3, 2)', [id, technician, line]);
    const reservation = (await one(
      'select id from equipment_reservations where event_request_id = $1 and released_at is null', [id],
    )).id;
    return { id, reservation };
  }

  beforeAll(async () => {
    db = await createSchemaDb();

    const user = (email, role, name) => seedUser(db, { email, role, fullName: name });
    organiser = await user('o@x', 'event_organiser', 'Aisha Rahman');
    coordinator = await user('a@x', 'event_coordinator', 'Priya Nair');
    technician = await user('t@x', 'technical_support_staff', 'Tan Tech');
    safetyOfficer = await user('so@x', 'safety_officer', 'Sam Safe');
    hall = await seedVenue(db, { name: 'Hall A', location: 'SMU', setup: 0, turnaround: 0 });
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });


  it('SCRUM489_AC2_a_request_scrum300_arranged_by_reserving_in_full_reads_as_met', async () => {
    // AC2-14: reserve_equipment's arrange check, not a seeded status, makes the line met.
    const { id } = await readyEventArrangedBySCRUM300();

    expect(await requestStatus(id)).toBe('arranged');
    expect(await equipmentLine(id)).toMatchObject({ key: 'equipment', met: true, detail: 'Arranged' });
    expect((await readiness(id)).ready).toBe(true);
  });

  it('SCRUM489_AC2_a_flagged_reservation_makes_equipment_outstanding', async () => {
    // AC2-15: flag_equipment_reservations sends the request back to pending_review; readiness follows,
    // and the submission is refused with the line it read.
    const { id, reservation } = await readyEventArrangedBySCRUM300();

    await db.query('select flag_equipment_reservations($1::uuid[], $2)', [[reservation], 'The type was marked unusable']);

    expect(await requestStatus(id)).toBe('pending_review');
    const line = await equipmentLine(id);
    expect(line.met).toBe(false);
    expect((await readiness(id)).ready).toBe(false);

    const err = await refusal(db.query('select submit_event_for_safety_review($1, $2)', [id, coordinator]));
    expect(err?.code).toBe('PT409');
    expect(err.hint).toBe('EVENT_NOT_READY');
    expect(JSON.parse(err.detail)).toEqual([line]);
    expect((await one('select status::text as s from event_requests where id = $1', [id])).s).toBe('approved');
  });

  it('SCRUM363_AC2_an_actual_reservation_flag_after_safety_approval_blocks_confirmation_without_releasing_equipment', async () => {
    const { id, reservation } = await readyEventArrangedBySCRUM300();
    await db.query('select submit_event_for_safety_review($1, $2)', [id, coordinator]);
    await db.query("select respond_to_safety_review($1, $2, 'approved', null, '{}', false)", [id, safetyOfficer]);
    await db.query('select flag_equipment_reservations($1::uuid[], $2)', [[reservation], 'Equipment condition changed']);
    const before = await one('select * from equipment_reservations where id = $1', [reservation]);
    const err = await refusal(db.query('select confirm_event_request($1, $2)', [id, coordinator]));
    expect(err?.hint).toBe('EVENT_NOT_READY');
    expect(JSON.parse(err.detail)).toEqual([expect.objectContaining({ key: 'equipment', met: false, detail: 'Pending review' })]);
    expect(await requestStatus(id)).toBe('pending_review');
    expect(before.flagged).toBe(true);
    expect(before.released_at).toBeNull();
    expect(await one('select * from equipment_reservations where id = $1', [reservation])).toEqual(before);
    expect((await one('select status::text as s from event_requests where id = $1', [id])).s).toBe('safety_approved');
    expect(Number((await one("select count(*) from event_request_status_history where event_request_id = $1 and new_status = 'confirmed'", [id])).count)).toBe(0);
  });

  it('SCRUM363_AC7_the_owner_reads_actual_confirmed_booking_and_reserved_equipment_records_and_planning_hides_them', async () => {
    const { id } = await readyEventArrangedBySCRUM300();
    await db.query('select submit_event_for_safety_review($1, $2)', [id, coordinator]);
    await db.query("select respond_to_safety_review($1, $2, 'approved', null, '{}', false)", [id, safetyOfficer]);
    await db.query('select confirm_event_request($1, $2)', [id, coordinator]);
    const client = { from(table) {
      expect(table).toBe('event_requests');
      const filters = {};
      // Translate only the read service's embedded relationships to SQL; no arrangement is stubbed.
      const chain = {
        select: () => chain,
        eq: (key, value) => { filters[key] = value; return chain; },
        maybeSingle: async () => ({ error: null, data: await one(`
          select e.id, e.organiser_id, e.status, e.proposed_start, e.proposed_end,
            (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'status', b.status,
              'venues', jsonb_build_object('name', v.name, 'location', v.location))), '[]')
             from bookings b join venues v on v.id = b.venue_id where b.event_request_id = e.id) as bookings,
            (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status,
              'equipment_lines', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id,
                'quantity', l.quantity, 'removed_at', l.removed_at,
                'equipment_types', jsonb_build_object('name', t.name))), '[]')
                from equipment_lines l join equipment_types t on t.id = l.equipment_type_id
               where l.equipment_request_id = r.id))), '[]')
             from equipment_requests r where r.event_request_id = e.id) as equipment_requests
          from event_requests e where e.id = $1 and e.organiser_id = $2`, [filters.id, filters.organiser_id]) }),
      };
      return chain;
    } };
    const visible = await getConfirmedArrangementsForOrganiser(id, organiser, { client });
    expect(visible.status).toBe('confirmed');
    expect(visible.venues).toEqual([expect.objectContaining({ name: 'Hall A', location: 'SMU' })]);
    expect(visible.equipment).toEqual([expect.objectContaining({ name: expect.stringMatching(/^Projector /), quantity: 2 })]);
    await expect(getConfirmedArrangementsForOrganiser(id, technician, { client })).rejects.toMatchObject({ status: 404 });
    // This isolates visibility on a status change; the full significant-change workflow is still a dependency.
    await db.query("select change_event_request_status($1, 'confirmed', 'approved', $2, 'Visibility check', $2)", [id, coordinator]);
    expect(await getConfirmedArrangementsForOrganiser(id, organiser, { client })).toMatchObject({ status: 'approved', startsAt: null, endsAt: null, venues: [], equipment: [] });
  });
  describe('SCRUM363 confirmation through significant changes', () => {
    async function confirmedEvent(venueId = hall) {
      const { id } = await readyEventArrangedBySCRUM300(venueId);
      await db.query("update event_requests set purpose = 'Community talk', expected_attendance = 50 where id = $1", [id]);
      await db.query('select submit_event_for_safety_review($1, $2)', [id, coordinator]);
      await db.query("select respond_to_safety_review($1, $2, 'approved', null, '{}', false)", [id, safetyOfficer]);
      await db.query('select confirm_event_request($1, $2)', [id, coordinator]);
      return id;
    }

    it('SCRUM363_AC8_actual_significant_change_preserves_field_locks_and_reconfirms_after_fresh_safety_review', async () => {
      const id = await confirmedEvent();
      await expect(db.query('update event_requests set expected_attendance = 60 where id = $1', [id]))
        .rejects.toMatchObject({ code: '55000' });
      const attendee = await seedUser(db, { email: 'cycle-attendee@test', role: 'attendee' });
      const registration = await one('insert into event_registrations(event_request_id, attendee_id) values ($1, $2) returning *', [id, attendee]);
      const changed = await one("select apply_significant_event_change($1, '{\"expectedAttendance\":60}', 'Attendance revised', $2) as result", [id, coordinator]);
      expect(changed.result.event).toMatchObject({ status: 'approved', expected_attendance: 60, registration_enabled: false });
      expect((await db.query('select * from event_registrations where event_request_id = $1', [id])).rows).toEqual([registration]);
      await expect(db.query('select confirm_event_request($1, $2)', [id, coordinator])).rejects.toMatchObject({ code: '55000' });
      await db.query('select submit_event_for_safety_review($1, $2)', [id, coordinator]);
      await db.query("select respond_to_safety_review($1, $2, 'approved', null, '{}', false)", [id, safetyOfficer]);
      await db.query('select confirm_event_request($1, $2)', [id, coordinator]);
      expect(await one('select status::text as status, registration_enabled from event_requests where id = $1', [id]))
        .toEqual({ status: 'confirmed', registration_enabled: false });
      const history = (await db.query("select changed_by from event_request_status_history where event_request_id = $1 and new_status = 'confirmed'", [id])).rows;
      expect(history).toEqual([{ changed_by: coordinator }, { changed_by: coordinator }]);
      expect(Number((await one('select count(*) from safety_review_submissions where event_request_id = $1', [id])).count)).toBe(2);
      expect((await db.query('select * from event_registrations where event_request_id = $1', [id])).rows).toEqual([registration]);
    });

    async function approveChange(id, field, value) {
      const { id: changeId } = await one(`insert into event_change_requests
        (event_request_id, requested_by, change_field, requested_change)
        values ($1, $2, $3, $4) returning id`, [id, organiser, field, value]);
      await db.query("select process_change_request($1, 'approved', 'Organiser asked to move it', $2)", [changeId, coordinator]);
      return changeId;
    }

    it('SCRUM363_AC8_an_approved_date_change_request_on_a_confirmed_event_returns_it_to_approved_and_flags_its_booking', async () => {
      const id = await confirmedEvent();
      const { proposed_start: start } = await one('select proposed_start from event_requests where id = $1', [id]);
      const moved = new Date(start.getTime() - 30 * 60000);
      const changeId = await approveChange(id, 'proposed_start', moved.toISOString());
      expect(await one('select status::text as status, proposed_start from event_requests where id = $1', [id]))
        .toEqual({ status: 'approved', proposed_start: moved });
      expect(await one('select status::text as status from bookings where event_request_id = $1', [id]))
        .toEqual({ status: 'flagged_for_review' });
      expect(await one('select status, decision from event_change_requests where id = $1', [changeId]))
        .toEqual({ status: 'processed', decision: 'approved' });
      expect(await one("select reason from event_change_history where event_request_id = $1 and field_name = 'proposedStart'", [id]))
        .toEqual({ reason: 'Organiser asked to move it' });
    });

    it('SCRUM363_AC8_an_approved_attendance_change_request_on_a_confirmed_event_goes_through_the_significant_change', async () => {
      const id = await confirmedEvent();
      await approveChange(id, 'expected_attendance', '75');
      expect(await one('select status::text as status, expected_attendance from event_requests where id = $1', [id]))
        .toEqual({ status: 'approved', expected_attendance: 75 });
      expect(Number((await one("select count(*) from notifications where event_request_id = $1 and type = 'event_significant_change'", [id])).count)).toBe(1);
    });

    it('SCRUM363_AC8_an_unusable_change_request_value_rolls_back_the_decision_on_a_confirmed_event', async () => {
      const id = await confirmedEvent();
      const { id: changeId } = await one(`insert into event_change_requests
        (event_request_id, requested_by, change_field, requested_change)
        values ($1, $2, 'expected_attendance', '0') returning id`, [id, organiser]);
      await expect(db.query("select process_change_request($1, 'approved', null, $2)", [changeId, coordinator]))
        .rejects.toMatchObject({ code: '22023' });
      expect(await one('select status::text as status, expected_attendance from event_requests where id = $1', [id]))
        .toEqual({ status: 'confirmed', expected_attendance: 50 });
      expect(await one('select status, decision from event_change_requests where id = $1', [changeId]))
        .toEqual({ status: 'outstanding', decision: null });
    });

    // SCRUM-24 AC7 through the real lifecycle functions, not status fixtures.
    it('SCRUM24_AC7_attendee_read_follows_change_request_safety_review_and_reconfirmation', async () => {
      const venueId = await seedVenue(db, { name: 'Lifecycle hall', location: 'SMU Level 2', setup: 0, turnaround: 0 });
      const id = await confirmedEvent(venueId);
      const booking = await one('select id from bookings where event_request_id = $1', [id]);
      const reservation = await one('select id from equipment_reservations where event_request_id = $1', [id]);
      const attendee = await seedUser(db, { email: 'scrum24-attendee@test', role: 'attendee' });
      const venueStaff = await seedUser(db, { email: 'scrum24-venue@test', role: 'venue_staff' });
      await db.query('insert into event_registrations(event_request_id, attendee_id) values ($1, $2)', [id, attendee]);
      const read = () => getAttendeeEvent({
        user: { id: attendee, role: 'attendee' }, eventRequestId: id, client: createAttendeeEventSqlClient(db),
      });
      const venueSeen = [{ bookingId: booking.id, name: 'Lifecycle hall', location: 'SMU Level 2', underReview: false }];
      const unavailable = { eventRequestId: id, state: 'unavailable', eventName: 'IS212 Industry Night' };

      const { proposed_start: start } = await one('select proposed_start from event_requests where id = $1', [id]);
      expect(await read()).toMatchObject({ state: 'confirmed', venues: venueSeen });
      expect(new Date((await read()).startsAt)).toEqual(start);

      // A later start stays inside the booking, so the hall can be reinstated.
      const moved = new Date(start.getTime() + 30 * 60000);
      await approveChange(id, 'proposed_start', moved.toISOString());
      expect(await read()).toEqual(unavailable);

      await db.query('select reinstate_flagged_booking($1, $2, $3)', [booking.id, venueStaff, 'Hall still free']);
      await db.query('select start_equipment_review($1, $2)', [id, technician]);
      await db.query('select move_equipment_reservation($1, $2, $3, $4)',
        [id, technician, reservation.id, 'Moved to the new start']);
      await db.query('select submit_event_for_safety_review($1, $2)', [id, coordinator]);
      expect(await read()).toEqual(unavailable);
      await db.query("select respond_to_safety_review($1, $2, 'approved', null, '{}', false)", [id, safetyOfficer]);
      expect(await read()).toEqual(unavailable);
      await db.query('select confirm_event_request($1, $2)', [id, coordinator]);

      const reconfirmed = await read();
      expect(reconfirmed).toMatchObject({ state: 'confirmed', venues: venueSeen });
      expect(new Date(reconfirmed.startsAt)).toEqual(moved);
    });

    it('SCRUM363_AC8_flagged_arrangements_require_real_resolution_and_fresh_safety_approval_before_reconfirmation', async () => {
      const venueId = await seedVenue(db, { name: 'Review hall', location: 'SMU', setup: 0, turnaround: 0 });
      const id = await confirmedEvent(venueId);
      const booking = await one('select id from bookings where event_request_id = $1', [id]);
      const reservation = await one('select * from equipment_reservations where event_request_id = $1', [id]);
      const venueStaff = await seedUser(db, { email: 'cycle-venue@test', role: 'venue_staff' });

      await db.query(`select apply_significant_event_change($1,
        '{"venueRequirements":"Review the existing hall", "equipmentChange":true}', 'Review arrangements', $2)`, [id, coordinator]);
      await db.query('select flag_equipment_reservations($1::uuid[], $2)',
        [[reservation.id], 'Equipment requires review after the planning change']);
      expect(await one('select status::text as status from event_requests where id = $1', [id]))
        .toEqual({ status: 'approved' });
      expect((await readiness(id)).items.filter((item) => !item.met).map((item) => item.key))
        .toEqual(['venue', 'equipment']);
      await expect(db.query('select submit_event_for_safety_review($1, $2)', [id, coordinator]))
        .rejects.toMatchObject({ code: 'PT409' });

      const resolved = await one('select reinstate_flagged_booking($1, $2, $3) as result',
        [booking.id, venueStaff, 'Hall remains suitable']);
      expect(resolved.result.outcome).toBe('reinstated');
      expect((await readiness(id)).ready).toBe(false);
      await db.query('select start_equipment_review($1, $2)', [id, technician]);
      await db.query('select keep_equipment_reservation($1, $2, $3, $4)',
        [id, technician, reservation.id, 'Existing equipment still meets the requirements']);
      expect((await readiness(id)).ready).toBe(true);
      await expect(db.query('select confirm_event_request($1, $2)', [id, coordinator]))
        .rejects.toMatchObject({ code: '55000' });

      await db.query('select submit_event_for_safety_review($1, $2)', [id, coordinator]);
      await db.query("select respond_to_safety_review($1, $2, 'approved', null, '{}', false)", [id, safetyOfficer]);
      await db.query('select confirm_event_request($1, $2)', [id, coordinator]);
      expect(await one('select status::text as status from event_requests where id = $1', [id]))
        .toEqual({ status: 'confirmed' });
      expect(await one('select id, quantity, released_at, flagged from equipment_reservations where id = $1', [reservation.id]))
        .toEqual({ id: reservation.id, quantity: reservation.quantity, released_at: null, flagged: false });
      expect(Number((await one("select count(*) from event_request_status_history where event_request_id = $1 and new_status = 'confirmed'", [id])).count)).toBe(2);
      expect(Number((await one('select count(*) from booking_resolutions where booking_id = $1', [booking.id])).count)).toBe(1);
    });

    it('SCRUM363_AC8_significant_change_is_one_invoker_security_function_for_the_backend_only', async () => {
      const fn = await one("select count(*)::int as count, bool_or(prosecdef) as definer from pg_proc where proname = 'apply_significant_event_change'");
      expect(fn).toEqual({ count: 1, definer: false });
      expect(await clientsCanExecute(db, 'apply_significant_event_change(uuid,jsonb,text,uuid,jsonb)', ['anon', 'authenticated', 'service_role']))
        .toEqual(['service_role']);
    });

    it('SCRUM363_AC8_a_failed_significant_change_rolls_back_the_early_transition_and_all_history', async () => {
      const id = await confirmedEvent();
      const snapshot = async () => ({
        event: await one('select * from event_requests where id = $1', [id]),
        statusHistory: (await db.query('select * from event_request_status_history where event_request_id = $1 order by id', [id])).rows,
        changes: (await db.query('select * from event_change_history where event_request_id = $1 order by id', [id])).rows,
        notifications: (await db.query('select * from notifications where event_request_id = $1 order by id', [id])).rows,
      });
      const before = await snapshot();
      await db.exec(`create function fail_test_significant_change() returns trigger language plpgsql as $$
        begin raise exception 'Injected change history failure'; end $$;
        create trigger fail_test_significant_change before insert on event_change_history
          for each row execute function fail_test_significant_change();`);
      try {
        await expect(db.query("select apply_significant_event_change($1, '{\"expectedAttendance\":60}', 'Attendance revised', $2)", [id, coordinator]))
          .rejects.toThrow('Injected change history failure');
        expect(await snapshot()).toEqual(before);
      } finally {
        await db.exec('drop trigger fail_test_significant_change on event_change_history; drop function fail_test_significant_change()');
      }
    });
  });
});
