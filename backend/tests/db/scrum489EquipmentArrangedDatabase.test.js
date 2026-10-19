/**
 * SCRUM-489 (SCRUM-559): the seam with SCRUM-300's reservations, on PGlite.
 * event_readiness reads the equipment request's status, so SCRUM-300's meaning
 * of Arranged should flow through unchanged:
 *
 *   053 arranges a request only when every line is fully reserved;
 *   061's flag_equipment_reservations sends an arranged request back to
 *   pending_review when a reservation is flagged.
 *
 * Migrations as scrum489EquipmentLockDatabase applies them, plus SCRUM-300's
 * 053, 054, 055, 060 and 061, in number order before 062 to 064.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getConfirmedArrangementsForOrganiser } from '../../src/services/eventRequestService.js';

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
  '024_equipment_availability.sql',
  '037_equipment_request_lines.sql',
  '038_equipment_review.sql',
];
const RESERVATIONS = [
  '053_equipment_reservations.sql',
  '054_equipment_reservation_actions.sql',
  '055_equipment_reservation_guards.sql',
  '060_equipment_reservation_topup.sql',
  '061_equipment_review_gaps.sql',
];

const DAY = 86_400_000;
const at = (days) => new Date(Date.now() + days * DAY).toISOString();

describe('SCRUM-489 (SCRUM-559): readiness reads SCRUM-300\'s Arranged', () => {
  let db;
  let organiser;
  let coordinator;
  let technician;
  let safetyOfficer;
  let hall;

  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
  const refusal = async (promise) => {
    try {
      await promise;
      return null;
    } catch (err) {
      return err;
    }
  };

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
    const id = (await one(
      `insert into event_requests
         (organiser_id, event_name, status, submitted_at, assigned_coordinator_id, reviewing_coordinator_id,
          decision, decided_by, decided_at, proposed_start, proposed_end)
       values ($1, 'IS212 Industry Night', 'approved', now(), $2, $2, 'approved', $2, now(), $3, $4) returning id`,
      [organiser, coordinator, at(10), at(10.25)],
    )).id;
    await db.query(
      `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
       select $1, id, proposed_start, proposed_end, 'approved' from event_requests where id = $2`,
      [venueId, id],
    );
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
    db = new PGlite({ extensions: { btree_gist } });
    await db.exec(`
      create schema auth;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text);
      create role anon;
      create role authenticated;
      create role service_role;
    `);
    for (const name of LIFECYCLE) await db.exec(migration(name));
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
    for (const name of ARRANGEMENTS) await db.exec(migration(name));
    for (const name of ['017_venue_turnaround.sql', '023_venue_setup_time.sql',
      '032_venue_occupancy.sql', '040_venue_holds.sql']) {
      await db.exec(migration(name));
    }
    await db.exec(migration('052_lead_assignment.sql'));
    await db.exec(migration('042_event_cancellation_fields.sql'));
    for (const name of RESERVATIONS) await db.exec(migration(name));
    await db.exec(migration('062_safety_statuses.sql'));
    await db.exec(migration('063_safety_transitions.sql'));
    await db.exec(migration('064_safety_review_submission.sql'));
    for (const name of ['071_safety_review.sql', '072_safety_review_history.sql', '073_safety_review_gates.sql',
      '098_event_readiness_details.sql', '099_confirmation_revision.sql',
      '102_confirmed_significant_field_lock.sql']) {
      await db.exec(migration(name));
    }

    const user = async (email, role, name) => {
      const id = (await one('insert into auth.users (email) values ($1) returning id', [email])).id;
      await db.query('insert into profiles (id, role, full_name) values ($1, $2, $3)', [id, role, name]);
      return id;
    };
    organiser = await user('o@x', 'event_organiser', 'Aisha Rahman');
    coordinator = await user('a@x', 'event_coordinator', 'Priya Nair');
    technician = await user('t@x', 'technical_support_staff', 'Tan Tech');
    safetyOfficer = await user('so@x', 'safety_officer', 'Sam Safe');
    hall = (await one("insert into venues (name, location, max_capacity) values ('Hall A', 'SMU', 200) returning id")).id;
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });


  it('SCRUM489_AC2_a_request_scrum300_arranged_by_reserving_in_full_reads_as_met', async () => {
    // AC2-14: 053's arrange check, not a seeded status, makes the line met.
    const { id } = await readyEventArrangedBySCRUM300();

    expect(await requestStatus(id)).toBe('arranged');
    expect(await equipmentLine(id)).toMatchObject({ key: 'equipment', met: true, detail: 'Arranged' });
    expect((await readiness(id)).ready).toBe(true);
  });

  it('SCRUM489_AC2_a_flagged_reservation_makes_equipment_outstanding', async () => {
    // AC2-15: 061 sends the request back to pending_review; readiness follows,
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
  describe('SCRUM363 confirmation with dev significant changes', () => {
    beforeAll(async () => {
      await db.exec(`alter table bookings
        add column if not exists review_block_id uuid,
        add column if not exists flagged_at timestamptz,
        add column if not exists flagged_by uuid references auth.users(id);`);
      for (const name of ['065_booking_decision_statuses.sql', '066_venue_staff_booking_decisions.sql',
        '076_reinstate_flagged_booking.sql', '078_list_flagged_bookings.sql',
        '050_event_registration.sql', '091_event_registration_hardening.sql',
        '092_event_registration_persistence.sql', '096_significant_event_change.sql',
        '100_significant_change_confirmation_compatibility.sql']) {
        await db.exec(migration(name));
      }
    });

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
      const attendee = (await one("insert into auth.users (email) values ('cycle-attendee@test') returning id")).id;
      await db.query("insert into profiles(id, role) values ($1, 'attendee')", [attendee]);
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

    it('SCRUM363_AC8_flagged_arrangements_require_real_resolution_and_fresh_safety_approval_before_reconfirmation', async () => {
      const venue = await one("insert into venues (name, location, max_capacity) values ('Review hall', 'SMU', 200) returning id");
      const id = await confirmedEvent(venue.id);
      const booking = await one('select id from bookings where event_request_id = $1', [id]);
      const reservation = await one('select * from equipment_reservations where event_request_id = $1', [id]);
      const venueStaff = (await one("insert into auth.users (email) values ('cycle-venue@test') returning id")).id;
      await db.query("insert into profiles(id, role) values ($1, 'venue_staff')", [venueStaff]);

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

    it('SCRUM363_AC8_compatibility_migration_is_rerunnable_invoker_security_and_backend_only', async () => {
      await db.exec(migration('100_significant_change_confirmation_compatibility.sql'));
      const fn = await one("select count(*)::int as count, bool_or(prosecdef) as definer from pg_proc where proname = 'apply_significant_event_change'");
      expect(fn).toEqual({ count: 1, definer: false });
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const { allowed } = await one("select has_function_privilege($1, 'apply_significant_event_change(uuid,jsonb,text,uuid,jsonb)', 'execute') as allowed", [role]);
        expect(allowed).toBe(role === 'service_role');
      }
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
