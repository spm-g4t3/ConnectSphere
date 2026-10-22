import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createSchemaDb, returnToLeadQueue, seedBooking, seedEvent, seedUser, seedVenue,
} from './helpers/schemaDb.js';
import { queriesFor, refusal } from './helpers/queries.js';
import { clientsCanExecute } from './helpers/grants.js';

// SCRUM-539: the Event Coordinator Lead cancels a submitted request nobody holds,
// through the same cancel_event_request and preview the coordinator uses (013).
// Cases: docs/test-cases/SCRUM-539.md.
describe('SCRUM-539: the Lead cancels an unassigned request (013)', () => {
  let db;
  let organiser;
  let coordinator;
  let otherCoordinator;
  let lead;
  let otherLead;
  let venueStaff;
  let technicalSupport;
  let noProfile;
  let venueId;
  let counter = 0;

  const { one, rows } = queriesFor(() => db);

  const cancel = (eventId, who, { reason = '  Organiser no longer needs it  ', initiator = 'organiser_request' } = {}) =>
    db.query(
      'select * from cancel_event_request($1, $2, $3, $4::event_cancellation_initiator, null)',
      [eventId, who, reason, initiator],
    );
  const preview = async (eventId, who) =>
    (await one('select event_cancellation_impact_preview($1, $2) as preview', [eventId, who])).preview;
  const assign = (eventId, by, to = coordinator) =>
    db.query("select * from assign_event_request($1, $2, $3, 'Yours')", [eventId, to, by]);

  /** Submitted, waiting in the Lead's queue: no coordinator. */
  function unassigned(overrides = {}) {
    counter += 1;
    return seedEvent(db, { status: 'submitted', organiser_id: organiser, event_name: `Unassigned ${counter}`, ...overrides });
  }

  function held(status) {
    counter += 1;
    return seedEvent(db, {
      status, organiser_id: organiser, event_name: `Held ${counter}`, assigned_coordinator_id: coordinator,
    });
  }

  /** Everything a refusal must leave as it was (AC7-01). */
  async function snapshot(eventId) {
    return {
      event: await one(
        `select status::text, assigned_coordinator_id, cancellation_reason, cancellation_initiator::text,
                cancelled_by, cancelled_at
           from event_requests where id = $1`,
        [eventId],
      ),
      history: await rows('select * from event_request_status_history where event_request_id = $1 order by id', [eventId]),
      notices: await rows('select id from notifications where event_request_id = $1 order by id', [eventId]),
      bookings: await rows('select id, status::text from bookings where event_request_id = $1 order by id', [eventId]),
      holds: await rows('select id, status::text, released_by from venue_holds where event_request_id = $1 order by id', [eventId]),
    };
  }

  async function expectRefused(eventId, attempt, code) {
    const before = await snapshot(eventId);
    const err = await refusal(attempt());
    expect(err?.code).toBe(code);
    expect(await snapshot(eventId)).toEqual(before);
    return err;
  }

  /**
   * An approved event with a pending and an approved booking, an active hold and
   * an equipment request, sent back to the Lead's queue: rejected, reopened and
   * resubmitted keeps them all (returnToLeadQueue).
   */
  async function unassignedWithArrangements() {
    counter += 1;
    const eventId = await seedEvent(db, {
      status: 'approved',
      organiser_id: organiser,
      event_name: `Back in the queue ${counter}`,
      assigned_coordinator_id: coordinator,
      proposed_start: '2026-12-01T09:00:00Z',
      proposed_end: '2026-12-01T10:00:00Z',
    });
    const pending = await seedBooking(db, { venueId, eventId, status: 'pending' });
    const approved = await seedBooking(db, {
      venueId: await seedVenue(db, { name: `Second hall ${counter}`, setup: 0, turnaround: 0 }), eventId, status: 'approved',
    });
    const hold = (await one(
      `insert into venue_holds (event_request_id, venue_id, placed_by, expires_at)
       values ($1, $2, $3, now() + interval '1 day') returning id`,
      [eventId, await seedVenue(db, { name: `Held hall ${counter}`, setup: 0, turnaround: 0 }), coordinator],
    )).id;
    const equipment = (await one(
      "insert into equipment_requests (event_request_id, status) values ($1, 'pending_review') returning id",
      [eventId],
    )).id;
    await returnToLeadQueue(db, eventId, { coordinator, organiser });
    const row = await one('select status::text, assigned_coordinator_id from event_requests where id = $1', [eventId]);
    expect(row).toEqual({ status: 'submitted', assigned_coordinator_id: null });
    return { eventId, pending, approved, hold, equipment };
  }

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await seedUser(db, { email: 'organiser@test', role: 'event_organiser', fullName: 'Olive Organiser' });
    coordinator = await seedUser(db, { email: 'coordinator@test', role: 'event_coordinator' });
    otherCoordinator = await seedUser(db, { email: 'other-coordinator@test', role: 'event_coordinator' });
    lead = await seedUser(db, { email: 'lead@test', role: 'event_coordinator_lead', fullName: 'Lena Lead' });
    otherLead = await seedUser(db, { email: 'other-lead@test', role: 'event_coordinator_lead' });
    venueStaff = await seedUser(db, { email: 'venue-staff@test', role: 'venue_staff' });
    technicalSupport = await seedUser(db, { email: 'technical-support@test', role: 'technical_support_staff' });
    noProfile = await seedUser(db, { email: 'nobody@test' });
    venueId = await seedVenue(db, { name: 'Hall', capacity: 100, setup: 0, turnaround: 0 });
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });


  describe('AC1, AC2: the Lead cancels a submitted request nobody holds', () => {
    it('SCRUM539_AC1_a_lead_cancels_and_is_recorded_as_the_canceller_with_one_history_row', async () => {
      // AC1-01: the expected coordinator is the holder (null), not the Lead (D2).
      const eventId = await unassigned();

      await cancel(eventId, lead);

      expect(await one(
        `select status::text, cancellation_reason, cancellation_initiator::text, cancelled_by,
                cancelled_at is not null as stamped
           from event_requests where id = $1`,
        [eventId],
      )).toEqual({
        status: 'cancelled',
        cancellation_reason: 'Organiser no longer needs it',
        cancellation_initiator: 'organiser_request',
        cancelled_by: lead,
        stamped: true,
      });
      expect(await rows(
        `select previous_status::text, new_status::text, changed_by, reason
           from event_request_status_history where event_request_id = $1 order by id`,
        [eventId],
      )).toEqual([
        { previous_status: 'submitted', new_status: 'cancelled', changed_by: lead, reason: 'Organiser no longer needs it' },
      ]);
    });

    it('SCRUM539_AC1_a_blank_reason_is_refused_with_22023_and_nothing_changes', async () => {
      // AC1-02, AC7-01.
      const eventId = await unassigned();

      await expectRefused(eventId, () => cancel(eventId, lead, { reason: '   ' }), '22023');
    });

    it('SCRUM539_AC1_no_initiator_is_refused_and_nothing_changes', async () => {
      // AC1-03, AC7-01: the existing null check.
      const eventId = await unassigned();

      await expectRefused(eventId, () => cancel(eventId, lead, { initiator: null }), '22004');
    });

    it('SCRUM539_AC1_a_lead_cancel_releases_the_bookings_hold_and_equipment_and_tells_their_staff', async () => {
      // AC1-04 (trap): an unassigned request can still hold arrangements.
      const { eventId, pending, approved, hold, equipment } = await unassignedWithArrangements();

      await cancel(eventId, lead);

      const bookingStatus = async (id) => (await one('select status::text from bookings where id = $1', [id])).status;
      expect([await bookingStatus(pending), await bookingStatus(approved)]).toEqual(['withdrawn', 'cancelled']);
      expect(await one('select status::text, released_by from venue_holds where id = $1', [hold]))
        .toEqual({ status: 'released', released_by: lead });
      expect((await one('select status::text from equipment_requests where id = $1', [equipment])).status).toBe('cancelled');
      const audiences = await rows(
        `select recipient_id, payload->>'audience' as audience from notifications
          where event_request_id = $1 and type = 'event_cancelled' order by audience`,
        [eventId],
      );
      expect(audiences).toEqual([
        { recipient_id: organiser, audience: 'organiser' },
        { recipient_id: technicalSupport, audience: 'technical_support_staff' },
        { recipient_id: venueStaff, audience: 'venue_staff' },
      ]);
    });

    it('SCRUM539_AC1_a_lead_previews_what_cancelling_an_unassigned_request_releases', async () => {
      // AC1-05, D6: the same preview a coordinator sees.
      const { eventId, pending, approved, hold, equipment } = await unassignedWithArrangements();

      const result = await preview(eventId, lead);

      expect(result).toMatchObject({
        eventRequestId: eventId,
        venueBookings: { count: 1, details: [expect.objectContaining({ id: approved })] },
        bookingRequests: { count: 1, details: [expect.objectContaining({ id: pending })] },
        venueHolds: { count: 1, details: [expect.objectContaining({ id: hold })] },
        equipmentRequests: { count: 1, details: [expect.objectContaining({ id: equipment })] },
      });
    });

    it('SCRUM539_AC2_the_organiser_gets_exactly_one_notice_with_the_reason', async () => {
      // AC2-01.
      const eventId = await unassigned();

      await cancel(eventId, lead);

      expect(await rows(
        `select recipient_id, payload->>'audience' as audience, payload->>'reason' as reason
           from notifications where event_request_id = $1 and type = 'event_cancelled'`,
        [eventId],
      )).toEqual([{ recipient_id: organiser, audience: 'organiser', reason: 'Organiser no longer needs it' }]);
    });

    it('SCRUM539_AC2_the_cancelled_request_leaves_the_unassigned_queue', async () => {
      // AC2-02: the queue's own filter (listUnassignedEventRequests: submitted,
      // no coordinator), asked of the table.
      const eventId = await unassigned();
      const queued = async () => (await rows(
        "select id from event_requests where status = 'submitted' and assigned_coordinator_id is null and id = $1",
        [eventId],
      )).length;
      expect(await queued()).toBe(1);

      await cancel(eventId, lead);

      expect(await queued()).toBe(0);
    });
  });


  describe('AC3: the Lead never cancels a held event', () => {
    it.each(['approved', 'under_review'])(
      'SCRUM539_AC3_a_lead_is_refused_a_held_%s_event_with_42501_and_nothing_changes',
      async (status) => {
        // AC3-01 (trap), AC7-01.
        const eventId = await held(status);

        const err = await expectRefused(eventId, () => cancel(eventId, lead), '42501');

        expect(err.message).toContain('assigned');
        expect(err.message).toContain('nobody holds');
      },
    );

    it('SCRUM539_AC3_a_lead_is_refused_the_preview_of_a_held_event_with_42501', async () => {
      // AC3-02.
      const eventId = await held('approved');

      expect((await refusal(preview(eventId, lead)))?.code).toBe('42501');
    });
  });


  describe('AC4: nobody but a Lead cancels an unassigned request', () => {
    it('SCRUM539_AC4_a_coordinator_is_told_the_request_waits_for_the_lead_with_55000', async () => {
      // AC4-01 (trap), AC7-01: not "only the coordinator assigned".
      const eventId = await unassigned();

      const err = await expectRefused(eventId, () => cancel(eventId, coordinator), '55000');

      expect(err.message).toContain('waiting for the Event Coordinator Lead');
      expect(err.message).not.toContain('Only the coordinator assigned');
    });

    it('SCRUM539_AC4_a_coordinator_is_refused_the_preview_of_an_unassigned_request_with_42501', async () => {
      // AC4-02: the preview's existing wording.
      const eventId = await unassigned();

      const err = await refusal(preview(eventId, coordinator));

      expect(err?.code).toBe('42501');
      expect(err.message).toBe('Only the coordinator assigned to this event can preview its cancellation');
    });

    it('SCRUM539_AC4_a_null_caller_is_refused_by_the_existing_null_check', async () => {
      // AC4-04, AC7-01.
      const eventId = await unassigned();

      await expectRefused(eventId, () => cancel(eventId, null), '22004');
      expect((await refusal(preview(eventId, null)))?.code).toBe('42501');
    });

    it.each([
      ['an_unassigned_request_with_55000', () => unassigned(), '55000'],
      ['a_held_event_with_42501', () => held('approved'), '42501'],
    ])('SCRUM539_AC4_a_user_with_no_profile_is_refused_%s', async (_label, make, code) => {
      // AC4-04, AC7-01: not a Lead, so the unassigned request waits for one.
      const eventId = await make();

      await expectRefused(eventId, () => cancel(eventId, noProfile), code);
      expect((await refusal(preview(eventId, noProfile)))?.code).toBe('42501');
    });

    it('SCRUM539_AC4_a_lead_is_refused_a_draft_with_42501', async () => {
      // AC4-05, AC7-01: a draft is still the Organiser's.
      counter += 1;
      const eventId = await seedEvent(db, { status: 'draft', organiser_id: organiser, event_name: `Draft ${counter}` });

      await expectRefused(eventId, () => cancel(eventId, lead), '42501');
      expect((await refusal(preview(eventId, lead)))?.code).toBe('42501');
    });
  });


  describe('AC5: a cancellation and an assignment have one winner (each order in turn)', () => {
    it('SCRUM539_AC5_assigned_first_the_lead_cancel_is_refused_and_the_assignment_stands', async () => {
      // AC5-01 (trap).
      const eventId = await unassigned();
      await assign(eventId, otherLead);

      await expectRefused(eventId, () => cancel(eventId, lead), '42501');
      expect(await one('select status::text, assigned_coordinator_id from event_requests where id = $1', [eventId]))
        .toEqual({ status: 'submitted', assigned_coordinator_id: coordinator });
    });

    it('SCRUM539_AC5_cancelled_first_the_assignment_is_refused_with_55000_and_the_cancel_stands', async () => {
      // AC5-02.
      const eventId = await unassigned();
      await cancel(eventId, lead);

      await expectRefused(eventId, () => assign(eventId, otherLead), '55000');
      expect((await one('select status::text from event_requests where id = $1', [eventId])).status).toBe('cancelled');
    });

    it('SCRUM539_AC5_a_second_lead_cancel_is_refused_with_55000_not_403', async () => {
      // AC5-03 (trap): the status answers it, not the caller check.
      const eventId = await unassigned();
      await cancel(eventId, lead);

      const err = await expectRefused(eventId, () => cancel(eventId, otherLead), '55000');

      expect(err.message).toContain('cannot be cancelled');
      expect((await snapshot(eventId)).history).toHaveLength(1);
      expect(await rows(
        "select id from notifications where event_request_id = $1 and payload->>'audience' = 'organiser'", [eventId],
      )).toHaveLength(1);
    });
  });


  describe('AC6, AC7: the coordinator path, and the grants', () => {
    it('SCRUM539_AC6_the_assigned_coordinator_still_cancels_their_held_event', async () => {
      // AC6-02.
      const eventId = await held('approved');

      await cancel(eventId, coordinator);

      expect(await one('select status::text, cancelled_by from event_requests where id = $1', [eventId]))
        .toEqual({ status: 'cancelled', cancelled_by: coordinator });
    });

    it('SCRUM539_AC6_a_coordinator_who_no_longer_holds_the_event_is_still_refused', async () => {
      // AC6-02: another coordinator is refused by the caller check, as before.
      const eventId = await held('approved');

      const err = await expectRefused(eventId, () => cancel(eventId, otherCoordinator), '42501');

      expect(err.message).toContain('Only the coordinator assigned');
    });

    it('SCRUM539_AC7_cancel_and_preview_stay_closed_to_the_client_roles', async () => {
      // AC7-02.
      expect(await clientsCanExecute(db, 'cancel_event_request(uuid, uuid, text, event_cancellation_initiator, text)')).toEqual([]);
      expect(await clientsCanExecute(db, 'event_cancellation_impact_preview(uuid, uuid)')).toEqual([]);
    });
  });
});
