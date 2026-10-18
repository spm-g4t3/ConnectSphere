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
  async function readyEventArrangedBySCRUM300() {
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
      [hall, id],
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
    await db.exec(migration('052_lead_assignment.sql'));
    await db.exec(migration('042_event_cancellation_fields.sql'));
    for (const name of RESERVATIONS) await db.exec(migration(name));
    await db.exec(migration('062_safety_statuses.sql'));
    await db.exec(migration('063_safety_transitions.sql'));
    await db.exec(migration('064_safety_review_submission.sql'));
    for (const name of ['071_safety_review.sql', '072_safety_review_history.sql', '073_safety_review_gates.sql',
      '098_event_readiness_details.sql', '099_confirmation_revision.sql']) {
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
});
