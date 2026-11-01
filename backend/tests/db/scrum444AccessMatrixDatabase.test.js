import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { ROLE } from '../../src/domain/userRole.js';
import { createSchemaDb, functionSources, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor, refusal } from './helpers/queries.js';
import { approveBooking } from './helpers/bookingFlow.js';
import { clientsCanExecute } from './helpers/grants.js';
import { listEventRequestsForReview, getEventClarificationHistory } from '../../src/services/eventRequestService.js';
import { pgliteSupabaseClient } from '../fixtures/pgliteSupabaseClient.js';

// SCRUM-444 (SCRUM-446, 447, 450, 451; SCRUM-448 for 055): every coordinator
// action refuses a coordinator who does not hold the event, before and after a
// handover; only the Lead hands an event over; a refusal changes nothing. On the
// full schema, statuses reached through the real workflow functions; only a
// Confirmed event that has ended is seeded. Cases: docs/test-cases/SCRUM-444.md.
const here = dirname(fileURLToPath(import.meta.url));
const sql055 = readFileSync(resolve(here, '../../db/migrations/055_reassign_lead_only.sql'), 'utf8');
const baseline = readFileSync(resolve(here, '../../db/baseline/02_event_requests.sql'), 'utf8');

describe('SCRUM-444: only the assigned coordinator acts; only the Lead hands over', () => {
  let db;
  let client;
  let organiser;
  let holder;
  let newHolder;
  let other;
  let lead;
  let safetyOfficer;
  let venueStaff;
  let attendee;
  let equipmentType;
  let counter = 0;

  const { one, rows } = queriesFor(() => db);
  const DAY = 24 * 60 * 60 * 1000;
  const at = (days) => new Date(Date.now() + days * DAY);
  const NAME = 'Tech Talk';

  // ---- reaching each status through the real functions, held by `holder` ----

  async function assigned() {
    counter += 1;
    const id = await seedEvent(db, {
      status: 'submitted', organiser_id: organiser, event_name: NAME, purpose: 'Networking',
      expected_attendance: 100, proposed_start: at(10 + counter), proposed_end: at(10.25 + counter),
    });
    await db.query("select assign_event_request($1, $2, $3, 'Yours')", [id, holder, lead]);
    return { id };
  }
  async function underReview() {
    const ctx = await assigned();
    await db.query('select start_event_review($1, $2)', [ctx.id, holder]);
    return ctx;
  }
  async function pendingClarification() {
    const ctx = await underReview();
    await db.query(
      "select request_event_clarification_with_fields($1, $2, $2, 'Numbers?', null, array['purpose'])",
      [ctx.id, holder],
    );
    return ctx;
  }
  async function approved() {
    const ctx = await underReview();
    await db.query("select decide_event_request($1, 'approved', 'Looks good', $2, now())", [ctx.id, holder]);
    return ctx;
  }
  const hall = () => seedVenue(db, { name: `Hall 444-${counter}-${Math.random()}`, capacity: 200, setup: 0, turnaround: 0 });
  async function withApprovedBooking() {
    const ctx = await approved();
    return { ...ctx, booking: await approveBooking(db, { venueId: await hall(), eventId: ctx.id, caller: venueStaff }) };
  }
  async function withPendingBooking() {
    const ctx = await approved();
    return { ...ctx, booking: await seedBooking(db, { venueId: await hall(), eventId: ctx.id, requestedBy: holder }) };
  }
  async function withHall() {
    const ctx = await approved();
    return { ...ctx, venue: await hall() };
  }
  async function safetyApproved() {
    const ctx = await withApprovedBooking();
    await db.query('select submit_event_for_safety_review($1, $2, null, true)', [ctx.id, holder]);
    await db.query("select respond_to_safety_review($1, $2, 'approved', null, '{}', false)", [ctx.id, safetyOfficer]);
    return ctx;
  }
  async function withChangeRequest() {
    const ctx = await approved();
    const { id: cr } = await one(
      "select * from create_change_request_group($1, $2, '[{\"changeField\": \"purpose\", \"requestedChange\": \"New\"}]'::jsonb, null)",
      [ctx.id, organiser],
    );
    return { ...ctx, cr };
  }
  async function withEquipmentLine() {
    const ctx = await approved();
    await db.query('select add_equipment_line($1, $2, $3, 1, null)', [ctx.id, holder, equipmentType]);
    const { id: line } = await one(
      'select l.id from equipment_lines l join equipment_requests r on r.id = l.equipment_request_id where r.event_request_id = $1',
      [ctx.id],
    );
    return { ...ctx, line };
  }
  async function confirmedAndEnded() {
    counter += 1;
    const id = await seedEvent(db, {
      status: 'confirmed', organiser_id: organiser, assigned_coordinator_id: holder, reviewing_coordinator_id: holder,
      event_name: NAME, proposed_start: at(-2), proposed_end: at(-1.9),
    });
    return { id };
  }

  // Every AC2 action, as `who`. The setup leaves `holder` holding the event.
  // Each is 42501 but one: the clarification request's only check in SQL is
  // change_event_request_status's expected coordinator, 40001 (the 403 a
  // non-holder gets over HTTP is requestEventClarification's own).
  const ACTIONS = [
    ['start_review', assigned, ({ id }, who) => db.query('select start_event_review($1, $2)', [id, who])],
    ['request_clarification', underReview, ({ id }, who) => db.query(
      "select request_event_clarification_with_fields($1, $2, $2, 'Numbers?', null, '{}'::text[])", [id, who]), '40001'],
    ['close_clarification', pendingClarification, ({ id }, who) => db.query(
      "select close_event_clarification($1, $2, $2, 'Settled by phone')", [id, who])],
    ['approve', underReview, ({ id }, who) => db.query(
      "select decide_event_request($1, 'approved', 'Fine', $2, now())", [id, who])],
    ['reject', underReview, ({ id }, who) => db.query(
      "select decide_event_request($1, 'rejected', 'No', $2, now())", [id, who])],
    ['reject_approved', approved, ({ id }, who) => db.query(
      "select reject_approved_event($1, $2, 'Too late now')", [id, who])],
    ['edit_details', underReview, ({ id }, who) => db.query(
      'select edit_event_request_details($1, $2, $3::jsonb, $4::jsonb, $5)',
      [id, who, JSON.stringify({ eventName: 'A new name' }), JSON.stringify({ eventName: NAME }), 'Asked by email'])],
    ['significant_change', approved, ({ id }, who) => db.query(
      'select apply_significant_event_change($1, $2::jsonb, $3, $4)',
      [id, JSON.stringify({ proposedStart: at(40).toISOString(), proposedEnd: at(40.25).toISOString() }), 'Moved', who])],
    ['process_change_request', withChangeRequest, ({ cr }, who) => db.query(
      "select * from process_change_request($1, 'rejected', 'Not now', $2)", [cr, who])],
    ['submit_safety_review', withApprovedBooking, ({ id }, who) => db.query(
      'select submit_event_for_safety_review($1, $2, null, true)', [id, who])],
    ['confirm', safetyApproved, async ({ id }, who) => {
      const { revision } = await one('select updated_at::text as revision from event_requests where id = $1', [id]);
      return db.query('select confirm_event_request($1, $2, false, $3::timestamptz)', [id, who, revision]);
    }],
    ['cancel', approved, ({ id }, who) => db.query(
      "select cancel_event_request($1, $2, 'Venue issue', 'connectsphere_decision'::event_cancellation_initiator, null)", [id, who])],
    ['complete', confirmedAndEnded, ({ id }, who) => db.query(
      "select complete_event_request($1, $2, 'It went well')", [id, who])],
    ['release_booking', withApprovedBooking, ({ booking }, who) => db.query(
      "select release_venue_booking($1, $2, 'Moving the event')", [booking, who])],
    ['request_venue', withHall, ({ id, venue }, who) => db.query(
      "select create_booking_request($1, $2, $3, null, null, '{\"suitable\": true}'::jsonb, false, 100)", [id, venue, who])],
    ['withdraw_venue_request', withPendingBooking, ({ booking }, who) => db.query(
      'select withdraw_booking_request($1, $2)', [booking, who])],
    ['add_equipment_line', approved, ({ id }, who) => db.query(
      'select add_equipment_line($1, $2, $3, 1, null)', [id, who, equipmentType])],
    ['amend_equipment_line', withEquipmentLine, ({ id, line }, who) => db.query(
      'select amend_equipment_line($1, $2, $3, 2)', [id, who, line])],
    ['remove_equipment_line', withEquipmentLine, ({ id, line }, who) => db.query(
      'select remove_equipment_line($1, $2, $3)', [id, who, line])],
  ];

  // ---- AC6: everything a refusal must leave as it was ----

  async function snapshot(id) {
    const of = (sql) => rows(sql, [id]);
    return {
      event: await of('select * from event_requests where id = $1'),
      statusHistory: await of('select * from event_request_status_history where event_request_id = $1 order by 1'),
      clarifications: await of('select * from event_request_clarification_history where event_request_id = $1 order by 1'),
      decisions: await of('select * from event_request_decision_history where event_request_id = $1 order by 1'),
      assignments: await of('select * from event_request_assignment_history where event_request_id = $1 order by 1'),
      changeRequests: await of('select * from event_change_requests where event_request_id = $1 order by 1'),
      changeHistory: await of('select * from event_change_history where event_request_id = $1 order by 1'),
      bookings: await of('select * from bookings where event_request_id = $1 order by 1'),
      equipmentRequests: await of('select * from equipment_requests where event_request_id = $1 order by 1'),
      equipmentLines: await of(
        'select l.* from equipment_lines l join equipment_requests r on r.id = l.equipment_request_id where r.event_request_id = $1 order by 1'),
      notifications: await rows('select * from notifications order by 1'),
    };
  }
  async function expectRefused(id, attempt, code = '42501') {
    const before = await snapshot(id);
    const err = await refusal(attempt());
    expect(err?.code).toBe(code);
    expect(await snapshot(id)).toEqual(before);
    return err;
  }
  const reassign = (id, to, by, note = null) =>
    db.query('select * from reassign_event_request($1, $2, $3, $4)', [id, to, by, note]);

  beforeAll(async () => {
    db = await createSchemaDb();
    // The coordinator reads select PostgREST embeds (bookings, reservations)
    // that are not SQL; the rules under test do not depend on them.
    client = pgliteSupabaseClient(db, {
      columns: (cols) => cols.replace(/,\s*bookings\(status\),\s*equipment_reservations\([^)]*\)/, ''),
    });
    organiser = await seedUser(db, { email: 'o444@test', role: 'event_organiser', fullName: 'Olive Organiser' });
    holder = await seedUser(db, { email: 'a444@test', role: 'event_coordinator', fullName: 'Priya Nair' });
    newHolder = await seedUser(db, { email: 'b444@test', role: 'event_coordinator', fullName: 'Marcus Tan' });
    other = await seedUser(db, { email: 'c444@test', role: 'event_coordinator', fullName: 'Omar Other' });
    lead = await seedUser(db, { email: 'l444@test', role: 'event_coordinator_lead', fullName: 'Lena Lead' });
    safetyOfficer = await seedUser(db, { email: 's444@test', role: 'safety_officer' });
    venueStaff = await seedUser(db, { email: 'v444@test', role: 'venue_staff' });
    attendee = await seedUser(db, { email: 't444@test', role: 'attendee' });
    ({ id: equipmentType } = await one(
      "insert into equipment_types (name, total_quantity) values ('Projector 444', 10) returning id"));
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('AC2, AC6: a coordinator who does not hold the event is refused every action', () => {
    it.each(ACTIONS)('SCRUM444_AC2_another_coordinator_cannot_%s_and_nothing_changes', async (_name, setup, act, code) => {
      const ctx = await setup();

      await expectRefused(ctx.id, () => act(ctx, other), code);
    });

    it.each(ACTIONS)('SCRUM444_AC2_the_holder_can_%s_from_the_same_state', async (_name, setup, act) => {
      // The control: each refusal above is about the caller, not the state.
      const ctx = await setup();

      expect(await refusal(act(ctx, holder))).toBeNull();
    });
  });

  describe('AC4: after the Lead hands A\'s event to B, A is a non-holder', () => {
    it.each(ACTIONS)('SCRUM444_AC4_after_a_handover_the_previous_holder_cannot_%s', async (_name, setup, act, code) => {
      const ctx = await setup();
      await reassign(ctx.id, newHolder, lead, 'Over to you');

      await expectRefused(ctx.id, () => act(ctx, holder), code);
    });

    it('SCRUM444_AC4_the_new_holder_can_act', async () => {
      const { id } = await underReview();
      await reassign(id, newHolder, lead);

      await db.query("select decide_event_request($1, 'approved', 'Fine', $2, now())", [id, newHolder]);

      expect(await one('select status::text as status, decided_by from event_requests where id = $1', [id]))
        .toEqual({ status: 'approved', decided_by: newHolder });
    });

    it('SCRUM444_AC4_the_queue_and_the_clarification_history_move_with_the_event', async () => {
      const { id } = await pendingClarification();
      const queued = async (who) => (await listEventRequestsForReview(who, { client })).map((event) => event.id);
      const clarifications = (who) => getEventClarificationHistory(id, who, ROLE.EVENT_COORDINATOR, { client });

      expect(await queued(holder)).toContain(id);
      expect(await queued(newHolder)).not.toContain(id);
      await expect(clarifications(holder)).resolves.toHaveLength(1);

      await reassign(id, newHolder, lead);

      expect(await queued(holder)).not.toContain(id);
      expect(await queued(newHolder)).toContain(id);
      await expect(clarifications(holder)).rejects.toMatchObject({ status: 404, message: `Event request ${id} not found` });
      await expect(clarifications(newHolder)).resolves.toHaveLength(1);
    });
  });

  describe('AC1: the queue is the caller\'s', () => {
    it('SCRUM444_AC1_the_queue_lists_only_the_callers_events', async () => {
      const mine = (await underReview()).id;
      const theirs = (await underReview()).id;
      await reassign(theirs, other, lead);

      const queue = (await listEventRequestsForReview(holder, { client })).map((event) => event.id);

      expect(queue).toContain(mine);
      expect(queue).not.toContain(theirs);
      expect(await listEventRequestsForReview(other, { client })).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: theirs, assignedCoordinatorId: other })]),
      );
    });
  });

  describe('AC3: only the Lead hands an event over (055)', () => {
    it('SCRUM444_AC3_the_holder_is_refused_reassign_with_42501_and_nothing_changes', async () => {
      const { id } = await underReview();

      const err = await expectRefused(id, () => reassign(id, newHolder, holder, 'On leave'));

      expect(err.message).toBe(`only the Event Coordinator Lead can hand over event request ${id}`);
    });

    it.each([
      ['a_null_caller', () => null],
      ['another_coordinator', () => other],
      ['the_organiser', () => organiser],
      ['venue_staff', () => venueStaff],
      ['a_safety_officer', () => safetyOfficer],
      ['an_attendee', () => attendee],
    ])('SCRUM444_AC3_%s_is_refused_reassign_with_42501', async (_label, who) => {
      const { id } = await underReview();

      await expectRefused(id, () => reassign(id, newHolder, who()));
    });

    it('SCRUM444_AC3_the_lead_reassigns', async () => {
      const { id } = await underReview();

      const { rows: [moved] } = await reassign(id, newHolder, lead, 'Priya is on leave');

      expect(moved.assigned_coordinator_id).toBe(newHolder);
      expect(await rows(
        `select previous_coordinator_id, new_coordinator_id, assigned_by, handover_note
           from event_request_assignment_history where event_request_id = $1 and previous_coordinator_id is not null`,
        [id],
      )).toEqual([{ previous_coordinator_id: holder, new_coordinator_id: newHolder, assigned_by: lead, handover_note: 'Priya is on leave' }]);
      const notices = await rows(
        `select recipient_id, type, payload->>'previousCoordinatorId' as previous from notifications
          where event_request_id = $1 and payload->>'previousCoordinatorId' is not null order by type`,
        [id],
      );
      expect(notices).toEqual([
        { recipient_id: newHolder, type: 'event_request_assigned', previous: holder },
        { recipient_id: organiser, type: 'event_request_coordinator_assigned', previous: holder },
      ]);
    });

    it('SCRUM444_AC3_055_is_rerunnable_and_keeps_one_overload', async () => {
      await db.exec(sql055);
      await db.exec(sql055);

      const { count } = await one("select count(*)::int as count from pg_proc where proname = 'reassign_event_request'");
      expect(count).toBe(1);
      expect(await clientsCanExecute(db, 'reassign_event_request(uuid, uuid, uuid, text)')).toEqual([]);
    });

    it('SCRUM444_AC3_055_changes_only_the_callers_check', async () => {
      // The body live runs is 055's, and against the baseline's it differs only
      // in the caller check: the holder branch gone, the Lead's message in.
      const bodyOf = (text, from = 0) => {
        const start = text.indexOf('as $$', text.indexOf('create or replace function reassign_event_request(', from)) + 'as $$'.length;
        return text.slice(start, text.indexOf('$$;', start));
      };
      const source = (await functionSources(db)).reassign_event_request;
      expect(source.replace(/\r\n/g, '\n')).toBe(bodyOf(sql055).replace(/\r\n/g, '\n'));

      // Lines in one and not the other; the lookup's lines differ only in
      // indent, since it no longer sits inside the "not the holder" branch.
      const before = bodyOf(baseline).replace(/\r\n/g, '\n').split('\n');
      const after = source.replace(/\r\n/g, '\n').split('\n');
      expect(before.filter((line) => !after.includes(line))).toEqual([
        '  -- The holder, or a Lead. A null caller is refused explicitly, as in 018.',
        "  -- The Lead's role is looked up only when the caller is not the holder, so",
        "  -- the holder's handover reads exactly as it did in 018.",
        '  if p_assigned_by is not null and v_outgoing is distinct from p_assigned_by then',
        '    perform 1',
        '       from profiles p',
        '      where p.id = p_assigned_by',
        "        and p.role = 'event_coordinator_lead'",
        '        for share;',
        '    v_is_lead := found;',
        '  if p_assigned_by is null or (v_outgoing is distinct from p_assigned_by and not v_is_lead) then',
        "    raise exception 'only the coordinator assigned to event request %, or the Event Coordinator Lead, can hand it over',",
      ]);
      expect(after.filter((line) => !before.includes(line))).toEqual([
        '  -- The Lead only (SCRUM-444 AC3): the holder may no longer hand an event over.',
        '  -- A null caller is refused explicitly, as in 018.',
        '    where p.id = p_assigned_by',
        "      and p.role = 'event_coordinator_lead'",
        '  v_is_lead := found;',
        '  if p_assigned_by is null or not v_is_lead then',
        "    raise exception 'only the Event Coordinator Lead can hand over event request %',",
      ]);
    });
  });

  describe('AC5: closing notes come only from the holder', () => {
    it('SCRUM444_AC5_a_non_holder_cannot_complete_the_event_with_notes', async () => {
      const { id } = await confirmedAndEnded();

      await expectRefused(id, () => db.query("select complete_event_request($1, $2, 'Written by someone else')", [id, other]));

      expect(await one('select status::text as status, closing_notes from event_requests where id = $1', [id]))
        .toEqual({ status: 'confirmed', closing_notes: null });
    });
  });
});
