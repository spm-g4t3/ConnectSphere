/**
 * SCRUM-489 (SCRUM-558): what an event submitted for the safety check already
 * gets from earlier stories, proved from a real submission on PGlite.
 *
 *   AC7: 052's assert_equipment_editable refuses every equipment change in
 *        safety_review as a significant change (add, amend, remove).
 *   AC8: the event reads to its organiser as "Safety check" (SCRUM-488's label).
 *
 * Migrations as scrum489SafetyReviewSubmissionDatabase applies them, plus 024
 * and 037 for the equipment line functions. 052 runs after 037 here, as on the
 * live database, so 052's guard (the one that names the safety statuses) wins.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { STATUS, getStatusDisplay } from '../../src/domain/eventRequestStatus.js';

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

const DAY = 86_400_000;
const at = (days) => new Date(Date.now() + days * DAY).toISOString();

describe('SCRUM-489 (SCRUM-558): an event in the safety check, from a real submission', () => {
  let db;
  let organiser;
  let coordinator;
  let hall;
  let projector;
  let microphone;

  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
  const refusal = async (promise) => {
    try {
      await promise;
      return null;
    } catch (err) {
      return err;
    }
  };

  const add = (event, type, quantity) =>
    db.query('select add_equipment_line($1, $2, $3, $4)', [event, coordinator, type, quantity]);
  const amend = (event, line, quantity) =>
    db.query('select amend_equipment_line($1, $2, $3, $4)', [event, coordinator, line, quantity]);
  const remove = (event, line) =>
    db.query('select remove_equipment_line($1, $2, $3)', [event, coordinator, line]);

  /** The event's equipment, every column a change could touch. */
  const equipmentOf = async (event) => ({
    requests: (await db.query(
      'select id, status::text as status, updated_at from equipment_requests where event_request_id = $1 order by id', [event],
    )).rows,
    lines: (await db.query(
      `select l.id, l.equipment_type_id, l.quantity, l.technical_notes, l.removed_at
         from equipment_lines l join equipment_requests r on r.id = l.equipment_request_id
        where r.event_request_id = $1 order by l.id`, [event],
    )).rows,
  });

  /**
   * An Approved event with a covering approved booking and one projector line,
   * submitted for the safety check. The line is added while Approved, through
   * 037, so the equipment is the coordinator's real record.
   */
  async function submittedEventWithALine() {
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
    await add(id, projector, 2);
    // Technical Support's review is SCRUM-21's; its outcome is seeded here.
    await db.query("update equipment_requests set status = 'arranged' where event_request_id = $1", [id]);
    await db.query('select submit_event_for_safety_review($1, $2)', [id, coordinator]);

    const line = (await one(
      `select l.id from equipment_lines l join equipment_requests r on r.id = l.equipment_request_id
        where r.event_request_id = $1`, [id],
    )).id;
    return { id, line };
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
    await db.exec(migration('062_safety_statuses.sql'));
    await db.exec(migration('063_safety_transitions.sql'));
    await db.exec(migration('064_safety_review_submission.sql'));

    const user = async (email, role, name) => {
      const id = (await one('insert into auth.users (email) values ($1) returning id', [email])).id;
      await db.query('insert into profiles (id, role, full_name) values ($1, $2, $3)', [id, role, name]);
      return id;
    };
    organiser = await user('o@x', 'event_organiser', 'Aisha Rahman');
    coordinator = await user('a@x', 'event_coordinator', 'Priya Nair');
    await user('so@x', 'safety_officer', 'Sam Safe');
    hall = (await one("insert into venues (name, location, max_capacity) values ('Hall A', 'SMU', 200) returning id")).id;
    projector = (await one("insert into equipment_types (name, total_quantity) values ('Projector', 10) returning id")).id;
    microphone = (await one("insert into equipment_types (name, total_quantity) values ('Microphone', 10) returning id")).id;
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });


  describe('AC7: equipment is locked once submitted', () => {
    it('SCRUM489_AC7_the_submission_put_the_event_in_safety_review_with_its_line_recorded', async () => {
      // The ground the next cases stand on: a real submission, a real line.
      const { id, line } = await submittedEventWithALine();

      expect((await one('select status::text as status from event_requests where id = $1', [id])).status)
        .toBe(STATUS.SAFETY_REVIEW);
      expect((await equipmentOf(id)).lines).toEqual([
        expect.objectContaining({ id: line, equipment_type_id: projector, quantity: 2, removed_at: null }),
      ]);
    });

    it.each([
      ['adding_a_line', ({ id }) => add(id, microphone, 1)],
      ['amending_the_line', ({ id, line }) => amend(id, line, 5)],
      ['removing_the_line', ({ id, line }) => remove(id, line)],
    ])('SCRUM489_AC7_%s_in_safety_review_is_refused_as_a_significant_change_and_nothing_changes', async (_label, change) => {
      // AC7-01.
      const event = await submittedEventWithALine();
      const before = await equipmentOf(event.id);

      const err = await refusal(change(event));

      expect(err?.code).toBe('55000');
      expect(err.message).toBe('Equipment on this event can only be changed as a significant change');
      expect(await equipmentOf(event.id)).toEqual(before);
    });
  });


  describe('AC8: what the organiser reads', () => {
    it('SCRUM489_AC8_a_submitted_event_reads_to_its_organiser_as_safety_check', async () => {
      // AC8-04. The status the submission left, through the one display every
      // organiser view uses (SCRUM-488 AC5 pins the words for a seeded row).
      const { id } = await submittedEventWithALine();
      const { status } = await one('select status::text as status from event_requests where id = $1', [id]);

      const display = getStatusDisplay(status);

      expect(display.label).toBe('Safety check');
      for (const shown of [display.label, display.description]) {
        expect(shown).not.toContain('safety_review');
        expect(shown).not.toContain('Safety review');
      }
    });
  });
});
