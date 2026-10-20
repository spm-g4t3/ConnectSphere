import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSchemaDb, seedEvent, seedUser } from './helpers/schemaDb.js';
import { queriesFor } from './helpers/queries.js';

const START = '2026-12-01T10:00:00Z';
const END = '2026-12-01T12:00:00Z';

// The Safety Officer's queue, detail and response against the final schema.
// Events are seeded already in Safety review so the queue order can be set;
// the response under test runs through respond_to_safety_review itself.
describe('SCRUM-490: safety review transaction and lifecycle', () => {
  let db;
  let organiser;
  let coordinator;
  let safetyOfficer;
  let otherUser;
  let venueStaff;
  let technicalStaff;
  let venueId;

  const { one, rows } = queriesFor(() => db);
  const json = async (sql, params = []) => JSON.parse((await one(sql, params)).answer);

  const user = (email, role, name) => seedUser(db, { email, role, fullName: name });

  async function event(eventName, enteredAt = '2026-10-10T09:00:00Z') {
    const id = await seedEvent(db, {
      status: 'safety_review',
      organiser_id: organiser,
      assigned_coordinator_id: coordinator,
      event_name: eventName,
      proposed_start: START,
      proposed_end: END,
      expected_attendance: 120,
      accessibility_requirements: 'Step-free access and reserved seating',
      submitted_at: '2026-09-01T09:00:00Z',
    });
    await db.query(
      `insert into event_request_status_history
         (event_request_id, previous_status, new_status, changed_by, reason, created_at)
       values ($1, 'approved', 'safety_review', $2, null, $3)`,
      [id, coordinator, enteredAt],
    );
    return id;
  }

  async function bookedVenue(eventId) {
    return (
      await one(
        `insert into bookings(event_request_id, venue_id, status, starts_at, ends_at, room_layout_code)
         values ($1, $2, 'approved', $3, $4, 'theatre')
         returning id`,
        [eventId, venueId, START, END],
      )
    ).id;
  }

  async function equipment(eventId) {
    const request = await one(
      `insert into equipment_requests(event_request_id, status)
       values ($1, 'arranged') returning id`,
      [eventId],
    );
    const type = await one('insert into equipment_types(name) values ($1) returning id', [`Projector ${eventId}`]);
    const line = await one(
      `insert into equipment_lines(equipment_request_id, equipment_type_id, quantity, technical_notes)
       values ($1, $2, 2, 'Needs a dedicated circuit') returning id`,
      [request.id, type.id],
    );
    await db.query(
      `insert into equipment_reservations
         (equipment_type_id, event_request_id, equipment_line_id, quantity, start_at, end_at)
       values ($1, $2, $3, 2, $4, $5)`,
      [type.id, eventId, line.id, START, END],
    );
    return request.id;
  }

  async function respond(eventId, outcome, note = null, bookingIds = [], equipmentAffected = false, officerId = safetyOfficer) {
    return json(
      `select respond_to_safety_review($1, $2, $3, $4, $5, $6)::text as answer`,
      [eventId, officerId, outcome, note, bookingIds, equipmentAffected],
    );
  }

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await user('organiser@example.com', 'event_organiser', 'Alex Organiser');
    coordinator = await user('coordinator@example.com', 'event_coordinator', 'Casey Coordinator');
    safetyOfficer = await user('safety@example.com', 'safety_officer', 'Riley Safety Officer');
    otherUser = await user('other@example.com', 'event_coordinator', 'Other User');
    venueStaff = await user('venue@example.com', 'venue_staff', 'Venue Staff Member');
    technicalStaff = await user('technical@example.com', 'technical_support_staff', 'Technical Support');
    venueId = (
      await one(
        `insert into venues(name, location, max_capacity, emergency_access, known_restrictions)
         values ('Hall A', 'Level 2', 250, 'Two east exits', null) returning id`,
      )
    ).id;
  });

  afterAll(async () => {
    await db?.close();
  });

  it('refuses direct status changes that have no current Safety Officer response', async () => {
    const eventId = await event('No Response Event');

    const approval = await reject(
      db.query("update event_requests set status = 'safety_approved' where id = $1", [eventId]),
    );
    expect(approval.code).toBe('55000');

    const returnToPlanning = await reject(
      db.query("update event_requests set status = 'approved' where id = $1", [eventId]),
    );
    expect(returnToPlanning.code).toBe('55000');
    expect((await one('select status::text as status from event_requests where id = $1', [eventId])).status)
      .toBe('safety_review');
  });

  it('SCRUM490_AC1_rejects_direct_inserts_into_safety_statuses', async () => {
    await expect(
      db.query(
        `insert into event_requests
           (organiser_id, assigned_coordinator_id, decision, decided_by, decided_at,
            event_name, status, proposed_start, proposed_end, submitted_at)
         values ($1, $2, 'approved', $2, now(), 'Direct insert', 'safety_review', $3, $4, now())`,
        [organiser, coordinator, START, END],
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('lists oldest safety-stage entry first and returns only the arrangements in the review', async () => {
    const later = await event('Later Event', '2026-10-09T09:00:00Z');
    const earlier = await event('Earlier Event', '2026-10-08T09:00:00Z');
    await db.query(
      `insert into safety_review_submissions (event_request_id, submitted_by, note, created_at)
       values ($1, $2, 'Initial crowd movement note', '2026-10-08T09:00:01Z'),
              ($1, $4, 'Follow-up crowd movement note', '2026-10-08T09:30:01Z'),
              ($3, $2, 'Different coordinator note', '2026-10-09T09:00:01Z')`,
      [earlier, coordinator, later, otherUser],
    );
    await db.query(
      `update event_requests
          set submitted_at = case id
            when $1 then '2026-09-02T09:00:00Z'::timestamptz
            when $2 then '2026-09-01T09:00:00Z'::timestamptz
          end
        where id = any($3::uuid[])`,
      [earlier, later, [earlier, later]],
    );
    await bookedVenue(earlier);
    const equipmentRequestId = await equipment(earlier);

    const queue = await json('select safety_review_queue($1)::text as answer', [safetyOfficer]);
    const targetEvents = queue.filter((item) => [earlier, later].includes(item.id));
    expect(targetEvents.map((item) => item.id)).toEqual([earlier, later]);
    expect(targetEvents[0]).toMatchObject({
      eventName: 'Earlier Event',
      coordinatorName: 'Other User',
      venues: ['Hall A'],
    });
    expect(targetEvents[1].coordinatorName).toBe('Casey Coordinator');
    expect(targetEvents[0].waitingSeconds).toBeGreaterThan(targetEvents[1].waitingSeconds);

    const detail = await json('select safety_review_detail($1, $2)::text as answer', [earlier, safetyOfficer]);
    expect(detail.event).toMatchObject({
      eventName: 'Earlier Event',
      expectedAttendance: 120,
      accessibilityRequirements: 'Step-free access and reserved seating',
      coordinatorNote: 'Follow-up crowd movement note',
    });
    expect(detail.venues[0]).toMatchObject({
      name: 'Hall A',
      location: 'Level 2',
      capacity: 250,
      layout: 'Theatre',
      emergencyAccess: 'Two east exits',
      knownRestrictions: null,
    });
    expect(detail.venues[0]).not.toHaveProperty('startsAt');
    expect(detail.venues[0]).not.toHaveProperty('endsAt');
    expect(detail.equipment).toMatchObject({
      requestId: equipmentRequestId,
      lines: [{ name: expect.stringContaining('Projector'), technicalNotes: 'Needs a dedicated circuit' }],
    });
    expect(detail.event).not.toHaveProperty('purpose');
    expect(detail.event).not.toHaveProperty('venueRequirements');
  });

  it('uses the original safety-stage submitter for events predating safety submissions', async () => {
    const eventId = await event('Legacy Safety Event');
    await db.query(
      `update event_request_status_history
          set changed_by = $2
        where event_request_id = $1
          and new_status = 'safety_review'`,
      [eventId, otherUser],
    );

    const queue = await json('select safety_review_queue($1)::text as answer', [safetyOfficer]);
    expect(queue.find((item) => item.id === eventId).coordinatorName).toBe('Other User');
  });

  it('records requested changes, returns only marked arrangements, and notifies the required roles', async () => {
    const eventId = await event('Change Event');
    const bookingId = await bookedVenue(eventId);
    const equipmentRequestId = await equipment(eventId);
    // Requesting the equipment already told Technical Support; count only the response's notices.
    const earlier = (await rows('select id from notifications where event_request_id = $1', [eventId])).map(({ id }) => id);

    const response = await respond(
      eventId,
      'changes_requested',
      'Keep the west exit clear.',
      [bookingId],
      true,
    );

    expect(response).toMatchObject({
      outcome: 'changes_requested',
      eventStatus: 'approved',
      safetyOfficerId: safetyOfficer,
      affectedBookingIds: [bookingId],
      equipmentAffected: true,
    });
    expect((await one('select status::text as status from event_requests where id = $1', [eventId])).status)
      .toBe('approved');
    const flaggedBooking = await one(
      'select status::text as status, review_reason, flagged_at, flagged_by from bookings where id = $1',
      [bookingId],
    );
    expect(flaggedBooking).toMatchObject({
      status: 'flagged_for_review',
      review_reason: 'safety_review',
      flagged_by: safetyOfficer,
    });
    expect(flaggedBooking.flagged_at).not.toBeNull();
    expect((await one('select status::text as status from equipment_requests where id = $1', [equipmentRequestId])).status)
      .toBe('pending_review');
    expect((await one('select released_at is not null as released, release_reason from equipment_reservations where event_request_id = $1', [eventId])))
      .toEqual({ released: true, release_reason: 'Safety review' });
    expect(await rows(
      `select action, user_id, reason, quantity_before, quantity_after
         from equipment_reservation_events where event_request_id = $1`,
      [eventId],
    )).toEqual([{
      action: 'released',
      user_id: safetyOfficer,
      reason: 'Safety review',
      quantity_before: 2,
      quantity_after: 0,
    }]);
    expect((await rows(
      'select type, recipient_id from notifications where event_request_id = $1 and id <> all($2::uuid[])',
      [eventId, earlier],
    ))).toHaveLength(4);
    expect((await rows(
      'select recipient_id from notifications where event_request_id = $1 and type = $2',
      [eventId, 'safety_review_response'],
    )).sort((a, b) => a.recipient_id.localeCompare(b.recipient_id)))
      .toEqual([organiser, coordinator].sort().map((recipient_id) => ({ recipient_id })));
    expect(await rows(
      'select recipient_id from notifications where event_request_id = $1 and type = $2',
      [eventId, 'safety_booking_flagged'],
    )).toEqual([{ recipient_id: venueStaff }]);
    expect(await rows(
      'select recipient_id from notifications where event_request_id = $1 and type = $2',
      [eventId, 'safety_equipment_review'],
    )).toEqual([{ recipient_id: technicalStaff }]);

    const history = await rows(
      'select previous_status::text as previous, new_status::text as next, changed_by, reason from event_request_status_history where event_request_id = $1 order by created_at, id',
      [eventId],
    );
    expect(history.at(-1)).toEqual({
      previous: 'safety_review',
      next: 'approved',
      changed_by: safetyOfficer,
      reason: 'Keep the west exit clear.',
    });
  });

  it('does not alter unmarked arrangements', async () => {
    const eventId = await event('Partial Changes Event');
    const bookingId = await bookedVenue(eventId);
    const equipmentRequestId = await equipment(eventId);

    await respond(eventId, 'rejected', 'The booking needs revision.', [bookingId], false);

    expect((await one('select status::text as status from bookings where id = $1', [bookingId])).status)
      .toBe('flagged_for_review');
    expect((await one('select status::text as status from equipment_requests where id = $1', [equipmentRequestId])).status)
      .toBe('arranged');
    expect((await one('select released_at from equipment_reservations where event_request_id = $1', [eventId])).released_at)
      .toBeNull();
    const response = await one('select outcome, note, affected_booking_ids from safety_review_responses where event_request_id = $1', [eventId]);
    expect(response).toMatchObject({
      outcome: 'rejected',
      note: 'The booking needs revision.',
      affected_booking_ids: [bookingId],
    });
  });

  it('SCRUM490_AC6_and_AC12_approval_sets_safety_approved_before_confirmation', async () => {
    const safeEvent = await event('Safe Event');
    await respond(safeEvent, 'approved');
    expect((await one('select status::text as status from event_requests where id = $1', [safeEvent])).status)
      .toBe('safety_approved');
    await expect(
      db.query(
        `select change_event_request_status($1, 'safety_approved', 'confirmed', $2)`,
        [safeEvent, safetyOfficer],
      ),
    ).resolves.toBeDefined();

    const unsafeEvent = await event('Unsafe Event');
    const refused = await reject(
      db.query(
        `select change_event_request_status($1, 'approved', 'confirmed', $2)`,
        [unsafeEvent, coordinator],
      ),
    );
    expect(refused.code).toBe('55000');
    expect((await one('select status::text as status from event_requests where id = $1', [unsafeEvent])).status)
      .toBe('safety_review');
  });

  // The route admits only Safety Officers; the reads now check the caller too,
  // so the function cannot be called as anyone else.
  const reads = [
    ['SCRUM490_AC1_the_queue', (caller) => one('select safety_review_queue($1)::text as answer', [caller])],
    ['SCRUM490_AC13_the_history', (caller) => one('select safety_review_history($1)::text as answer', [caller])],
    ['SCRUM490_AC3_the_detail', async (caller) => one('select safety_review_detail($1, $2)::text as answer', [await event(`Detail ${Math.random()}`), caller])],
  ];

  it.each(reads)('%s_refuses_a_null_caller_and_non_officers_with_42501', async (_name, read) => {
    for (const caller of [null, coordinator, technicalStaff]) {
      await expect(read(caller), String(caller)).rejects.toMatchObject({
        code: '42501',
        message: 'Only Safety Officers can view safety reviews',
      });
    }
  });

  it('SCRUM490_AC13_a_safety_officer_reads_the_history_of_responses', async () => {
    const eventId = await event('History Event');
    await respond(eventId, 'approved');

    const history = await json('select safety_review_history($1)::text as answer', [safetyOfficer]);

    expect(history.find((item) => item.id === eventId)).toMatchObject({
      outcome: 'approved',
      safetyOfficerName: 'Riley Safety Officer',
    });
  });

  it('requires required notes, rejects non-officers, and refuses repeat responses with current status', async () => {
    const noNote = await event('Missing Note Event');
    await expect(respond(noNote, 'rejected', '  ')).rejects.toMatchObject({ code: '22023' });
    expect((await one('select status::text as status from event_requests where id = $1', [noNote])).status)
      .toBe('safety_review');

    await expect(respond(noNote, 'approved', null, [], false, otherUser))
      .rejects.toMatchObject({ code: '42501' });

    await respond(noNote, 'approved');
    await expect(respond(noNote, 'rejected', 'Second response'))
      .rejects.toMatchObject({ code: '55000', message: expect.stringContaining('safety_approved') });
    expect((await one('select count(*)::integer as count from safety_review_responses where event_request_id = $1', [noNote])).count)
      .toBe(1);
  });

  it('accepts only one response when two Safety Officers respond at once', async () => {
    const eventId = await event('Concurrent Response Event');
    const results = await Promise.allSettled([
      respond(eventId, 'approved', 'Approved by first officer.'),
      respond(eventId, 'rejected', 'Rejected by second officer.'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await one(
      'select count(*)::integer as count from safety_review_responses where event_request_id = $1',
      [eventId],
    )).count).toBe(1);
    expect((await one('select status::text as status from event_requests where id = $1', [eventId])).status)
      .toMatch(/^(safety_approved|approved)$/);
  });
});

async function reject(promise) {
  try {
    await promise;
    throw new Error('Expected the database operation to fail');
  } catch (error) {
    if (error.message === 'Expected the database operation to fail') throw error;
    return error;
  }
}
