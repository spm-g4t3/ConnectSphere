/**
 * SCRUM-379 AC5 and AC6, on the real schema: everything a Confirmed event had is still readable
 * once it is Completed, and the status history says who completed it and when.
 *
 * One event is taken from Approved to Confirmed with a venue booking, reserved equipment,
 * a clarification entry, a past decision and a change request. Each read is taken before and
 * after complete_event_request, and the two are compared. The database clock that
 * complete_event_request reads is pinned, and every event time is a fixed offset from it, so no
 * test depends on when it runs.
 */
import { describe, it, expect, beforeAll } from 'vitest';

import {
  getConfirmedArrangementsForOrganiser,
  getEventChangeHistory,
  getEventClarificationHistory,
  getEventDecisionHistory,
  getEventRequestForCoordinator,
  getEventRequestForOrganiser,
  getEventRequestStatusHistory,
} from '../../src/services/eventRequestService.js';
import { ROLE } from '../../src/domain/userRole.js';
import { pgliteSupabaseClient } from '../fixtures/pgliteSupabaseClient.js';
import { queriesFor } from './helpers/queries.js';
import { useSchemaDb, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';

// One hour after the event below ends (it runs 09:00 to 11:00 UTC on 2099-01-01).
const NOW_ISO = '2099-01-01T12:00:00Z';
const NOTES = 'Attendance 180 of 200.';

// The event reads embed bookings(status) and equipment_reservations(...), which are PostgREST
// syntax; here they become the equivalent subqueries.
const BOOKING_STATUS_EMBED = (table) =>
  `(select coalesce(json_agg(json_build_object('status', b.status)), '[]'::json)
      from bookings b where b.event_request_id = ${table}.id) as bookings`;
const RESERVATION_EMBED = (table) =>
  `(select coalesce(json_agg(json_build_object(
      'flagged', r.flagged, 'released_at', r.released_at, 'flag_reason', r.flag_reason, 'flag_code', r.flag_code)), '[]'::json)
      from equipment_reservations r where r.event_request_id = ${table}.id) as equipment_reservations`;
const RESERVATION_EMBED_TEXT = /\bequipment_reservations\(flagged, released_at, flag_reason, flag_code\)/;

// The arrangements read embeds the booking's venue and the equipment request's lines.
const ARRANGEMENTS_COLUMNS = `
  e.id, e.organiser_id, e.status, e.proposed_start, e.proposed_end,
  (select coalesce(json_agg(json_build_object('id', b.id, 'status', b.status,
      'venues', json_build_object('name', v.name, 'location', v.location))), '[]'::json)
     from bookings b join venues v on v.id = b.venue_id where b.event_request_id = e.id) as bookings,
  (select coalesce(json_agg(json_build_object('id', r.id, 'status', r.status,
      'equipment_lines', (select coalesce(json_agg(json_build_object('id', l.id, 'quantity', l.quantity,
          'removed_at', l.removed_at, 'equipment_types', json_build_object('name', t.name))), '[]'::json)
        from equipment_lines l join equipment_types t on t.id = l.equipment_type_id
       where l.equipment_request_id = r.id))), '[]'::json)
     from equipment_requests r where r.event_request_id = e.id) as equipment_requests`;

const pgliteClient = (db) => pgliteSupabaseClient(db, {
  columns(cols, table) {
    if (/equipment_requests\(id, status, equipment_lines/.test(cols)) {
      // `e` is the alias the select list above uses; the adapter selects from the bare table name.
      return ARRANGEMENTS_COLUMNS.replace(/\be\./g, `${table}.`).replace(/= e\.id/g, `= ${table}.id`);
    }
    const rest = cols.replace(/\bbookings\(status\)/, '').replace(RESERVATION_EMBED_TEXT, '');
    if (/\w+\(/.test(rest)) throw new Error(`pgliteClient: an embed in "${cols}" is not on this path`);
    return cols
      .replace(/\bbookings\(status\)/, BOOKING_STATUS_EMBED(table))
      .replace(RESERVATION_EMBED_TEXT, RESERVATION_EMBED(table));
  },
});

describe('SCRUM-379 AC5, AC6: a Completed event stays readable, on the real schema', () => {
  const getDb = useSchemaDb();
  let db;
  let organiser;
  let coordinator;
  let otherCoordinator;
  let lead;
  let safetyOfficer;
  let technician;
  let otherOrganiser;
  let eventId;
  let client;
  let before;
  let after;

  const { one, rows } = queriesFor(() => getDb());

  async function readEverything() {
    const asOrganiser = (read) => read(eventId, organiser);
    return {
      status: (await getEventRequestForOrganiser(eventId, organiser, { client })).status,
      coordinatorView: await getEventRequestForCoordinator(eventId, { client }),
      arrangements: await getConfirmedArrangementsForOrganiser(eventId, organiser, { client }),
      statusHistoryOrganiser: await getEventRequestStatusHistory(eventId, organiser, { client }),
      statusHistoryCoordinator: await getEventRequestStatusHistory(eventId, coordinator, { client }),
      clarificationOrganiser: await asOrganiser((id, who) => getEventClarificationHistory(id, who, ROLE.EVENT_ORGANISER, { client })),
      clarificationCoordinator: await getEventClarificationHistory(eventId, otherCoordinator, ROLE.EVENT_COORDINATOR, { client }),
      decisionsOrganiser: await asOrganiser((id, who) => getEventDecisionHistory(id, who, ROLE.EVENT_ORGANISER, { client })),
      decisionsCoordinator: await getEventDecisionHistory(eventId, coordinator, ROLE.EVENT_COORDINATOR, { client }),
      decisionsLead: await getEventDecisionHistory(eventId, lead, ROLE.EVENT_COORDINATOR_LEAD, { client }),
      changesOrganiser: await asOrganiser((id, who) => getEventChangeHistory(id, who, ROLE.EVENT_ORGANISER, { client })),
      changesCoordinator: await getEventChangeHistory(eventId, coordinator, ROLE.EVENT_COORDINATOR, { client }),
    };
  }

  beforeAll(async () => {
    db = getDb();
    client = pgliteClient(db);

    organiser = await seedUser(db, { email: 'organiser379r@example.com', role: 'event_organiser', fullName: 'Olivia Organiser' });
    otherOrganiser = await seedUser(db, { email: 'other-organiser379r@example.com', role: 'event_organiser', fullName: 'Oscar Other' });
    coordinator = await seedUser(db, { email: 'coordinator379r@example.com', role: 'event_coordinator', fullName: 'Priya Nair' });
    otherCoordinator = await seedUser(db, { email: 'other379r@example.com', role: 'event_coordinator', fullName: 'Omar Other' });
    lead = await seedUser(db, { email: 'lead379r@example.com', role: 'event_coordinator_lead', fullName: 'Lena Lead' });
    safetyOfficer = await seedUser(db, { email: 'safety379r@example.com', role: 'safety_officer', fullName: 'Sam Safe' });
    technician = await seedUser(db, { email: 'tech379r@example.com', role: 'technical_support_staff', fullName: 'Tan Tech' });
    const hall = await seedVenue(db, { name: 'Hall A 379r', location: 'SMU Level 1', setup: 0, turnaround: 0 });

    // Reservations and the safety review need the event dated ahead, so it is dated far ahead and the
    // database clock is pinned to just after its end. Moving its dates instead would send the equipment
    // back for review, which is not what time passing does.
    eventId = await seedEvent(db, {
      status: 'approved',
      organiser_id: organiser,
      event_name: 'Industry Night',
      assigned_coordinator_id: coordinator,
      reviewing_coordinator_id: coordinator,
      proposed_start: '2099-01-01T09:00:00Z',
      proposed_end: '2099-01-01T11:00:00Z',
    });
    await seedBooking(db, { venueId: hall, eventId, status: 'approved' });
    const projector = (await one(
      'insert into equipment_types (name, total_quantity) values ($1, 10) returning id', ['Projector 379r'],
    )).id;
    await db.query('select add_equipment_line($1, $2, $3, 2)', [eventId, coordinator, projector]);
    const line = (await one(
      `select l.id from equipment_lines l join equipment_requests r on r.id = l.equipment_request_id
        where r.event_request_id = $1`, [eventId],
    )).id;
    await db.query('select start_equipment_review($1, $2)', [eventId, technician]);
    await db.query('select reserve_equipment($1, $2, $3, 2)', [eventId, technician, line]);
    await db.query('select submit_event_for_safety_review($1, $2)', [eventId, coordinator]);
    await db.query("select respond_to_safety_review($1, $2, 'approved', null, '{}', false)", [eventId, safetyOfficer]);
    await db.query('select confirm_event_request($1, $2)', [eventId, coordinator]);

    await db.query(
      `insert into event_request_clarification_history (event_request_id, entry_type, message, created_by)
       values ($1, 'question', 'Please confirm the expected turnout', $2)`,
      [eventId, coordinator],
    );
    await db.query(
      `insert into event_request_decision_history
         (event_request_id, decision, decision_note, decided_by, decided_at, superseded_reason, superseded_by)
       values ($1, 'rejected', 'Needs a bigger venue', $2, '2030-01-02T03:00:00Z', 'reopened_for_revision', $2)`,
      [eventId, coordinator],
    );
    await db.query(
      `insert into event_change_requests (event_request_id, requested_by, change_field, requested_change)
       values ($1, $2, 'other', 'Change the format')`,
      [eventId, organiser],
    );

    await db.query(`create or replace function event_clock() returns timestamptz language sql as $$ select '${NOW_ISO}'::timestamptz $$`);
    before = await readEverything();
    await db.query('select * from complete_event_request($1, $2, $3)', [eventId, coordinator, NOTES]);
    after = await readEverything();
  }, 120_000);

  describe('AC5: every record stays viewable', () => {
    it('SCRUM379_AC5_the_fixture_is_a_confirmed_event_with_every_kind_of_record_before_completion', () => {
      expect(before.status).toBe('confirmed');
      expect(before.arrangements.venues).toHaveLength(1);
      expect(before.arrangements.equipment).toHaveLength(1);
      expect(before.clarificationOrganiser).toHaveLength(1);
      expect(before.decisionsOrganiser).toHaveLength(1);
      expect(before.changesOrganiser).toBeDefined();
    });

    it('SCRUM379_AC5_the_organiser_still_reads_the_event_details', () => {
      expect(after.status).toBe('completed');
    });

    it('SCRUM379_AC5_a_coordinator_still_reads_the_event_details', () => {
      expect(after.coordinatorView).toMatchObject({
        id: eventId, eventName: 'Industry Night', status: 'completed', organiserId: organiser,
      });
      expect(after.coordinatorView.proposedStart).toEqual(before.coordinatorView.proposedStart);
      expect(after.coordinatorView.proposedEnd).toEqual(before.coordinatorView.proposedEnd);
    });

    it('SCRUM379_AC5_the_organiser_still_reads_the_kept_venue_booking', () => {
      expect(after.arrangements.status).toBe('completed');
      expect(after.arrangements.venues).toEqual(before.arrangements.venues);
      expect(after.arrangements.venues[0]).toMatchObject({ name: 'Hall A 379r', location: 'SMU Level 1' });
    });

    it('SCRUM379_AC5_the_organiser_still_reads_the_arranged_equipment', () => {
      expect(after.arrangements.equipment).toEqual(before.arrangements.equipment);
      expect(after.arrangements.equipment[0]).toMatchObject({ name: 'Projector 379r', quantity: 2 });
    });

    it('SCRUM379_AC5_the_arrangements_carry_the_event_dates', () => {
      expect(after.arrangements).toMatchObject({ startsAt: before.arrangements.startsAt, endsAt: before.arrangements.endsAt });
      expect(after.arrangements.startsAt).not.toBeNull();
    });

    it('SCRUM379_AC5_the_clarification_history_is_unchanged_for_the_organiser_and_for_any_coordinator', () => {
      expect(after.clarificationOrganiser).toEqual(before.clarificationOrganiser);
      expect(after.clarificationCoordinator).toEqual(before.clarificationCoordinator);
      expect(after.clarificationOrganiser[0]).toMatchObject({ type: 'question', message: 'Please confirm the expected turnout', authorName: 'Priya Nair' });
    });

    it('SCRUM379_AC5_the_decision_history_is_unchanged_for_the_organiser_the_coordinator_and_the_lead', () => {
      expect(after.decisionsOrganiser).toEqual(before.decisionsOrganiser);
      expect(after.decisionsCoordinator).toEqual(before.decisionsCoordinator);
      expect(after.decisionsLead).toEqual(before.decisionsLead);
      expect(after.decisionsOrganiser[0]).toMatchObject({ decision: 'rejected', decisionNote: 'Needs a bigger venue', decidedByName: 'Priya Nair' });
    });

    it('SCRUM379_AC5_the_change_history_is_unchanged_for_the_organiser_and_the_coordinator', () => {
      expect(after.changesOrganiser).toEqual(before.changesOrganiser);
      expect(after.changesCoordinator).toEqual(before.changesCoordinator);
    });

    it('SCRUM379_AC5_the_status_history_keeps_every_earlier_row_and_adds_one', () => {
      expect(after.statusHistoryOrganiser).toHaveLength(before.statusHistoryOrganiser.length + 1);
      expect(after.statusHistoryOrganiser.slice(0, -1)).toEqual(before.statusHistoryOrganiser);
    });

    it('SCRUM379_AC5_the_organiser_and_the_assigned_coordinator_read_the_same_status_history', () => {
      expect(after.statusHistoryCoordinator).toEqual(after.statusHistoryOrganiser);
    });

    it('SCRUM379_AC5_the_records_are_still_kept_in_the_tables', async () => {
      expect(Number((await one('select count(*) from bookings where event_request_id = $1', [eventId])).count)).toBe(1);
      expect(Number((await one(
        'select count(*) from equipment_lines l join equipment_requests r on r.id = l.equipment_request_id where r.event_request_id = $1',
        [eventId],
      )).count)).toBe(1);
      expect(Number((await one('select count(*) from event_request_clarification_history where event_request_id = $1', [eventId])).count)).toBe(1);
      expect(Number((await one('select count(*) from event_request_decision_history where event_request_id = $1', [eventId])).count)).toBe(1);
    });
  });

  describe('AC5: the reads are still closed to people who may not have them', () => {
    it('SCRUM379_AC5_another_organiser_cannot_read_the_completed_event', async () => {
      await expect(getEventRequestForOrganiser(eventId, otherOrganiser, { client })).rejects.toMatchObject({ status: 404 });
      await expect(getConfirmedArrangementsForOrganiser(eventId, otherOrganiser, { client })).rejects.toMatchObject({ status: 404 });
      await expect(getEventRequestStatusHistory(eventId, otherOrganiser, { client })).rejects.toMatchObject({ status: 404 });
      await expect(getEventDecisionHistory(eventId, otherOrganiser, ROLE.EVENT_ORGANISER, { client })).rejects.toMatchObject({ status: 404 });
    });

    it('SCRUM379_AC5_a_coordinator_who_is_not_assigned_cannot_read_the_status_or_decision_history', async () => {
      await expect(getEventRequestStatusHistory(eventId, otherCoordinator, { client })).rejects.toMatchObject({ status: 404 });
      await expect(getEventDecisionHistory(eventId, otherCoordinator, ROLE.EVENT_COORDINATOR, { client })).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('AC6: who completed it and when', () => {
    it('SCRUM379_AC6_the_organiser_sees_the_status_Completed', async () => {
      const history = after.statusHistoryOrganiser;
      expect(history.at(-1)).toMatchObject({ previousStatus: 'confirmed', newStatus: 'completed', newStatusLabel: 'Completed' });
    });

    it('SCRUM379_AC6_the_completion_row_names_the_coordinator', () => {
      expect(after.statusHistoryOrganiser.at(-1).changedByName).toBe('Priya Nair');
    });

    it('SCRUM379_AC6_the_completion_row_has_the_date_and_time_and_is_the_last_row', () => {
      const rowsInOrder = after.statusHistoryOrganiser;
      const completion = rowsInOrder.at(-1);
      expect(Number.isNaN(Date.parse(completion.changedAt))).toBe(false);
      const times = rowsInOrder.map((row) => Date.parse(row.changedAt));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    });

    it('SCRUM379_AC6_exactly_one_completion_row_exists_and_the_stored_row_matches', async () => {
      const stored = await rows(
        `select previous_status::text as previous, new_status::text as next, changed_by
           from event_request_status_history where event_request_id = $1 and new_status = 'completed'`,
        [eventId],
      );
      expect(stored).toEqual([{ previous: 'confirmed', next: 'completed', changed_by: coordinator }]);
    });

    it('SCRUM379_AC6_the_closing_notes_never_reach_the_organiser_status_history', () => {
      expect(JSON.stringify(after.statusHistoryOrganiser)).not.toContain('Attendance 180');
      expect(JSON.stringify(after.arrangements)).not.toContain('Attendance 180');
      expect(JSON.stringify(after.changesOrganiser)).not.toContain('Attendance 180');
    });
  });

  it('SCRUM379_AC5_a_completed_event_is_not_changed_by_reading_it', async () => {
    const first = await one('select * from event_requests where id = $1', [eventId]);
    await readEverything();
    expect(await one('select * from event_requests where id = $1', [eventId])).toEqual(first);
  });
});
