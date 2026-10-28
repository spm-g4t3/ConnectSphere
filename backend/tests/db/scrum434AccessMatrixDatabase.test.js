import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { ROLE } from '../../src/domain/userRole.js';
import { createSchemaDb, seedEvent, seedUser } from './helpers/schemaDb.js';
import { queriesFor, refusal, expectSqlError } from './helpers/queries.js';
import {
  getEventRequestStatusHistory,
  getEventClarificationHistory,
  getEventDecisionHistory,
  getEventChangeHistory,
  listAssignmentHistory,
  getEventRequestForOrganiser,
  reopenEventRequest,
} from '../../src/services/eventRequestService.js';
import { getChangeRequestsForEvent, createChangeRequest } from '../../src/services/eventChangeRequestService.js';
import { pgliteSupabaseClient } from '../fixtures/pgliteSupabaseClient.js';

// SCRUM-434 (AC2, AC3, AC6, AC8): who may read an event's history and who may
// act on it, for each role and each relationship to the event, against the real
// schema and the real services. The histories are written by the real functions
// (assign, review, clarify, reject, reopen), not seeded, so what is read is
// what production would hold. Cases: docs/SCRUM-434.md.
describe('SCRUM-434: access to an event, by role and relationship', () => {
  let db;
  let client;
  let owner;
  let otherOrganiser;
  let assigned;
  let otherCoordinator;
  let lead;
  let venueStaff;
  let technicalSupport;
  let safetyOfficer;
  let attendee;
  let eventId;
  let counter = 0;

  const { one, rows } = queriesFor(() => db);
  const person = (role, fullName) => seedUser(db, { email: `u434${counter += 1}@example.com`, role, fullName });

  const HANDOVER_NOTE = 'Internal handover note for the coordinators only';
  const CLARIFICATION = 'Please confirm the purpose of the event';

  beforeAll(async () => {
    db = await createSchemaDb();
    // The organiser read selects PostgREST embeds (bookings, reservations) that
    // are not SQL; the ownership check under test does not depend on them.
    client = pgliteSupabaseClient(db, {
      columns: (cols) => cols.replace(/,\s*bookings\(status\),\s*equipment_reservations\([^)]*\)/, ''),
    });
    owner = await person(ROLE.EVENT_ORGANISER, 'Owner Organiser');
    otherOrganiser = await person(ROLE.EVENT_ORGANISER, 'Other Organiser');
    assigned = await person(ROLE.EVENT_COORDINATOR, 'Assigned Coordinator');
    otherCoordinator = await person(ROLE.EVENT_COORDINATOR, 'Other Coordinator');
    lead = await person(ROLE.EVENT_COORDINATOR_LEAD, 'The Lead');
    venueStaff = await person(ROLE.VENUE_STAFF, 'Venue Staff');
    technicalSupport = await person(ROLE.TECHNICAL_SUPPORT_STAFF, 'Technical Support');
    safetyOfficer = await person(ROLE.SAFETY_OFFICER, 'Safety Officer');
    attendee = await person(ROLE.ATTENDEE, 'An Attendee');

    // Submitted, assigned with a handover note, reviewed, a clarification asked,
    // then rejected and reopened: every history holds at least one entry.
    eventId = await seedEvent(db, {
      status: 'submitted',
      organiser_id: owner,
      event_name: 'History event',
      purpose: 'Networking',
      proposed_start: new Date(Date.now() + 30 * 86_400_000),
      proposed_end: new Date(Date.now() + 30 * 86_400_000 + 7_200_000),
    });
    await db.query('select assign_event_request($1, $2, $3, $4)', [eventId, assigned, lead, HANDOVER_NOTE]);
    await db.query('select start_event_review($1, $2)', [eventId, assigned]);
    await db.query('select request_event_clarification_with_fields($1, $2, $2, $3, null, array[]::text[])', [eventId, assigned, CLARIFICATION]);
    await db.query("insert into event_change_requests (event_request_id, requested_by, change_field, requested_change) values ($1, $2, 'event_name', 'A better name')", [eventId, owner]);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  const NOT_FOUND = { name: 'NotFoundError', status: 404 };

  // The five history reads, as the routes call them for a caller of `role`.
  const READS = {
    status: (who, role) => getEventRequestStatusHistory(eventId, who, { client }),
    clarification: (who, role) => getEventClarificationHistory(eventId, who, role, { client }),
    decision: (who, role) => getEventDecisionHistory(eventId, who, role, { client }),
    change: (who, role) => getEventChangeHistory(eventId, who, role, { client }),
  };

  describe('AC2: the organiser who owns the event reads its full history', () => {
    it('SCRUM434_AC2_the_owner_reads_status_history', async () => {
      const history = await READS.status(owner, ROLE.EVENT_ORGANISER);
      expect(history.length).toBeGreaterThan(0);
      expect(history.map((entry) => entry.newStatus)).toContain('under_review');
    });

    it('SCRUM434_AC2_the_owner_reads_clarification_history', async () => {
      const history = await READS.clarification(owner, ROLE.EVENT_ORGANISER);
      expect(history.map((entry) => entry.message)).toEqual([CLARIFICATION]);
    });

    it('SCRUM434_AC2_the_owner_reads_decision_history_after_a_rejection_and_reopen', async () => {
      const rejected = await seedEvent(db, {
        status: 'rejected', organiser_id: owner, assigned_coordinator_id: assigned, reviewing_coordinator_id: assigned,
        decision_note: 'The venue is too small', proposed_start: new Date(Date.now() + 40 * 86_400_000), proposed_end: new Date(Date.now() + 40 * 86_400_000 + 7_200_000),
      });
      await db.query('select reopen_event_request($1, $2)', [rejected, owner]);

      const history = await getEventDecisionHistory(rejected, owner, ROLE.EVENT_ORGANISER, { client });

      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ decision: 'rejected', decisionNote: 'The venue is too small' });
    });

    it('SCRUM434_AC2_the_owner_reads_assignment_history_without_the_handover_note', async () => {
      await getEventRequestForOrganiser(eventId, owner, { client });
      const history = await listAssignmentHistory(eventId, { includeNotes: false }, { client });

      expect(history.length).toBeGreaterThan(0);
      expect(JSON.stringify(history)).not.toContain(HANDOVER_NOTE);
    });

    it('SCRUM434_AC2_the_owner_reads_change_requests', async () => {
      const requests = await getChangeRequestsForEvent(eventId, owner, { client });
      expect(requests).toHaveLength(1);
    });

    it('SCRUM434_AC2_the_owner_reads_change_history_and_it_is_empty_before_any_edit', async () => {
      expect(await READS.change(owner, ROLE.EVENT_ORGANISER)).toEqual([]);
    });
  });

  describe('AC6: the backend refuses a read by anyone without a relationship to the event', () => {
    // Other organiser, a coordinator not assigned, venue staff, technical
    // support, safety officer and an attendee: none holds the event.
    const STRANGERS = [
      ['another organiser', () => otherOrganiser, ROLE.EVENT_ORGANISER],
      ['an unassigned coordinator', () => otherCoordinator, ROLE.EVENT_COORDINATOR],
      ['venue staff', () => venueStaff, ROLE.VENUE_STAFF],
      ['technical support', () => technicalSupport, ROLE.TECHNICAL_SUPPORT_STAFF],
      ['a safety officer', () => safetyOfficer, ROLE.SAFETY_OFFICER],
      ['an attendee', () => attendee, ROLE.ATTENDEE],
    ];

    describe.each(STRANGERS)('%s', (_label, who, role) => {
      // Any coordinator reads a submitted event's clarification history: the
      // coordinators work from one shared queue (SCRUM-486), so that read is
      // not limited to the assigned one. Every other history is.
      const refused = Object.keys(READS).filter((kind) => !(role === ROLE.EVENT_COORDINATOR && kind === 'clarification'));
      it.each(refused)('SCRUM434_AC6_%s_history_is_answered_as_not_found', async (kind) => {
        await expect(READS[kind](who(), role)).rejects.toMatchObject(NOT_FOUND);
      });

      it('SCRUM434_AC6_the_organiser_event_read_is_answered_as_not_found', async () => {
        // The routes put a role gate in front of this; behind it, an account
        // that does not own the event is answered as if it did not exist.
        await expect(getEventRequestForOrganiser(eventId, who(), { client })).rejects.toMatchObject(NOT_FOUND);
      });

      it('SCRUM434_AC6_change_requests_are_refused', async () => {
        await expect(getChangeRequestsForEvent(eventId, who(), { client })).rejects.toBeTruthy();
      });
    });

    it('SCRUM434_AC6_a_refusal_for_a_stranger_is_the_same_as_for_an_id_that_does_not_exist', async () => {
      const missing = '00000000-0000-4000-8000-000000000000';
      const real = await refusal(getEventRequestStatusHistory(eventId, otherOrganiser, { client }));
      const none = await refusal(getEventRequestStatusHistory(missing, otherOrganiser, { client }));

      expect(real.status).toBe(none.status);
      expect(real.message.replace(eventId, 'ID')).toBe(none.message.replace(missing, 'ID'));
    });
  });

  describe('AC6: coordinators see history only where their role allows', () => {
    it('SCRUM434_AC6_the_assigned_coordinator_reads_the_status_clarification_decision_and_change_history', async () => {
      for (const kind of Object.keys(READS)) {
        await expect(READS[kind](assigned, ROLE.EVENT_COORDINATOR)).resolves.toBeInstanceOf(Array);
      }
    });

    it('SCRUM434_AC6_the_lead_reads_clarification_decision_and_change_history', async () => {
      for (const kind of ['clarification', 'decision', 'change']) {
        await expect(READS[kind](lead, ROLE.EVENT_COORDINATOR_LEAD)).resolves.toBeInstanceOf(Array);
      }
    });

    it('SCRUM434_AC6_a_draft_is_not_readable_by_any_coordinator_or_the_lead', async () => {
      const draft = await seedEvent(db, { status: 'draft', organiser_id: owner });
      for (const [who, role] of [[assigned, ROLE.EVENT_COORDINATOR], [lead, ROLE.EVENT_COORDINATOR_LEAD]]) {
        await expect(getEventClarificationHistory(draft, who, role, { client })).rejects.toMatchObject(NOT_FOUND);
        await expect(getEventDecisionHistory(draft, who, role, { client })).rejects.toMatchObject(NOT_FOUND);
        await expect(getEventChangeHistory(draft, who, role, { client })).rejects.toMatchObject(NOT_FOUND);
      }
    });
  });

  describe('AC3: only the owner reopens a rejected request', () => {
    async function rejectedEvent() {
      return seedEvent(db, {
        status: 'rejected', organiser_id: owner, assigned_coordinator_id: assigned, reviewing_coordinator_id: assigned,
        decision_note: 'Not suitable', proposed_start: new Date(Date.now() + 50 * 86_400_000), proposed_end: new Date(Date.now() + 50 * 86_400_000 + 7_200_000),
      });
    }

    it('SCRUM434_AC3_the_owner_reopens_a_rejected_request_as_a_draft', async () => {
      const id = await rejectedEvent();
      const reopened = await reopenEventRequest(id, owner, { client });
      expect(reopened.status).toBe('draft');
    });

    it('SCRUM434_AC3_another_organiser_cannot_reopen_it_and_the_event_stays_rejected', async () => {
      const id = await rejectedEvent();
      const before = await one('select * from event_requests where id = $1', [id]);

      await expect(reopenEventRequest(id, otherOrganiser, { client })).rejects.toMatchObject(NOT_FOUND);

      expect(await one('select * from event_requests where id = $1', [id])).toEqual(before);
    });

    it.each([
      ['coordinator', () => assigned],
      ['lead', () => lead],
      ['venue staff', () => venueStaff],
      ['technical support', () => technicalSupport],
      ['safety officer', () => safetyOfficer],
      ['attendee', () => attendee],
    ])('SCRUM434_AC3_a_%s_cannot_reopen_it_and_the_event_stays_rejected', async (_label, who) => {
      const id = await rejectedEvent();
      const before = await one('select * from event_requests where id = $1', [id]);

      await expectSqlError(db.query('select * from reopen_event_request($1, $2)', [id, who()]), '42501');

      expect(await one('select * from event_requests where id = $1', [id])).toEqual(before);
    });

    it.each(['submitted', 'approved', 'confirmed', 'cancelled'])(
      'SCRUM434_AC3_a_%s_request_cannot_be_reopened_by_its_owner',
      async (status) => {
        const id = await seedEvent(db, {
          status, organiser_id: owner, assigned_coordinator_id: status === 'submitted' ? null : assigned,
          reviewing_coordinator_id: status === 'submitted' ? null : assigned,
          ...(status === 'cancelled' && { cancellation_reason: 'x', cancellation_initiator: 'organiser_request', cancelled_by: assigned, cancelled_at: new Date() }),
        });
        const before = await one('select * from event_requests where id = $1', [id]);

        const err = await refusal(db.query('select * from reopen_event_request($1, $2)', [id, owner]));

        expect(err).not.toBeNull();
        expect(await one('select * from event_requests where id = $1', [id])).toEqual(before);
      },
    );
  });

  describe('AC8: a refused attempt leaves every table unchanged', () => {
    const TABLES = [
      'event_requests',
      'event_request_status_history',
      'event_request_clarification_history',
      'event_request_decision_history',
      'event_request_assignment_history',
      'event_change_requests',
      'event_change_history',
      'notifications',
    ];
    const snapshot = async () => Object.fromEntries(
      await Promise.all(TABLES.map(async (table) => [table, await rows(`select * from ${table} order by 1`)])),
    );

    it('SCRUM434_AC8_another_organiser_asking_for_a_change_creates_no_row', async () => {
      const before = await snapshot();

      const err = await refusal(createChangeRequest(
        { eventRequestId: eventId, changeField: 'event_name', requestedChange: 'Hijacked' },
        otherOrganiser,
        { client },
      ));

      expect(err).not.toBeNull();
      expect(await snapshot()).toEqual(before);
    });

    it.each([
      ['a venue staff', () => venueStaff],
      ['a technical support', () => technicalSupport],
      ['an attendee', () => attendee],
      ['a safety officer', () => safetyOfficer],
    ])('SCRUM434_AC8_%s_account_cannot_assign_the_event', async (_label, who) => {
      const before = await snapshot();

      const err = await refusal(db.query('select assign_event_request($1, $2, $3, null)', [eventId, otherCoordinator, who()]));

      expect(err).not.toBeNull();
      expect(await snapshot()).toEqual(before);
    });

    it.each([
      ['another organiser', () => otherOrganiser],
      ['an attendee', () => attendee],
      ['venue staff', () => venueStaff],
    ])('SCRUM434_AC8_%s_cannot_decide_the_event', async (_label, who) => {
      const before = await snapshot();

      const err = await refusal(db.query("select decide_event_request($1, 'rejected', 'No', $2, now())", [eventId, who()]));

      expect(err).not.toBeNull();
      expect(await snapshot()).toEqual(before);
    });
  });

  describe('AC7: an account holds exactly one role', () => {
    it('SCRUM434_AC7_profiles_store_a_single_role_per_account', async () => {
      const columns = await rows(
        "select column_name, data_type from information_schema.columns where table_name = 'profiles' and column_name like '%role%'",
      );
      expect(columns).toEqual([{ column_name: 'role', data_type: expect.stringMatching(/USER-DEFINED|text/) }]);
    });

    it('SCRUM434_AC7_a_second_profile_for_the_same_account_is_refused', async () => {
      const before = await rows('select id, role from profiles order by id');

      const err = await refusal(db.query("insert into profiles (id, role) values ($1, 'attendee')", [owner]));

      expect(err?.code).toBe('23505');
      expect(await rows('select id, role from profiles order by id')).toEqual(before);
    });
  });
});
