import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSchemaDb, seedBlock, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor } from './helpers/queries.js';

const START = '2040-12-01T10:00:00Z';
const END = '2040-12-01T12:00:00Z';

// apply_significant_event_change and its preview against the final schema.
describe('SCRUM-395 significant event change database transaction', () => {
  let db;
  let organiser;
  let coordinator;
  let otherCoordinator;
  let attendeeOne;
  let attendeeTwo;
  let venueStaff;
  let technicalStaff;
  let eventId;
  let safetyReviewEventId;
  let smallVenueId;
  let largeVenueId;
  let reservationId;

  const { one, rows } = queriesFor(() => db);

  const user = (email, role) => seedUser(db, { email, role });

  function makeEvent(status = 'confirmed') {
    return seedEvent(db, {
      status,
      organiser_id: organiser,
      assigned_coordinator_id: coordinator,
      event_name: 'Tech Talk',
      purpose: 'Knowledge sharing',
      proposed_start: START,
      proposed_end: END,
      expected_attendance: 80,
      venue_requirements: 'Lecture space',
      accessibility_requirements: 'Step-free access',
    });
  }

  const makeBooking = (forEvent, venueId) =>
    seedBooking(db, { venueId, eventId: forEvent, status: 'approved', start: START, end: END });

  // A live reservation needs the request and line it was reserved for.
  async function makeReservation(forEvent, name, quantity) {
    const typeId = (await one(
      'insert into equipment_types(name, total_quantity) values ($1, 10) returning id',
      [name],
    )).id;
    const requestId = (await one(
      'insert into equipment_requests(event_request_id) values ($1) returning id',
      [forEvent],
    )).id;
    const lineId = (await one(
      `insert into equipment_lines(equipment_request_id, equipment_type_id, quantity)
       values ($1, $2, $3) returning id`,
      [requestId, typeId, quantity],
    )).id;
    return (await one(
      `insert into equipment_reservations
         (event_request_id, equipment_type_id, equipment_line_id, quantity, start_at, end_at)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [forEvent, typeId, lineId, quantity, START, END],
    )).id;
  }

  async function applyChange(forEvent, changes, reason, expectedImpact = null) {
    return (await one(
      `select apply_significant_event_change($1, $2::jsonb, $3, $4, $5::jsonb) as result`,
      [forEvent, JSON.stringify(changes), reason, coordinator,
        expectedImpact && JSON.stringify(expectedImpact)],
    )).result;
  }

  beforeAll(async () => {
    db = await createSchemaDb();
    await db.exec("set time zone 'UTC'");

    organiser = await user('organiser@test', 'event_organiser');
    coordinator = await user('coordinator@test', 'event_coordinator');
    otherCoordinator = await user('other@test', 'event_coordinator');
    attendeeOne = await user('attendee-1@test', 'attendee');
    attendeeTwo = await user('attendee-2@test', 'attendee');
    venueStaff = await user('venue-staff@test', 'venue_staff');
    technicalStaff = await user('technical-staff@test', 'technical_support_staff');
    smallVenueId = await seedVenue(db, { name: 'Small Hall', capacity: 50, setup: 15, turnaround: 30 });
    largeVenueId = await seedVenue(db, { name: 'Large Hall', location: 'Block B', capacity: 150, setup: 15, turnaround: 15 });

    eventId = await makeEvent();
    await makeBooking(eventId, smallVenueId);
    await makeBooking(eventId, largeVenueId);
    reservationId = await makeReservation(eventId, 'Projector', 2);
    await db.query(
      `insert into event_registrations(event_request_id, attendee_id)
       values ($1, $2), ($1, $3)`,
      [eventId, attendeeOne, attendeeTwo],
    );

  });

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM395_AC3_previews_each_booking_with_its_own_venue_occupied_period', async () => {
    const overCapacity = await one(
      `select significant_event_change_impact($1, $2::jsonb) as impact`,
      [eventId, JSON.stringify({ expectedAttendance: 120 })],
    );
    const impacted = overCapacity.impact.venueBookings;
    expect(impacted).toHaveLength(1);
    expect(impacted[0].venueName).toBe('Small Hall');

    const underCapacity = await one(
      `select significant_event_change_impact($1, $2::jsonb) as impact`,
      [eventId, JSON.stringify({ expectedAttendance: 40 })],
    );
    expect(underCapacity.impact.venueBookings).toEqual([]);

    const periodChange = await one(
      `select significant_event_change_impact($1, $2::jsonb) as impact`,
      [eventId, JSON.stringify({
        proposedStart: '2040-12-02T10:00:00Z',
        proposedEnd: '2040-12-02T12:00:00Z',
      })],
    );
    expect(periodChange.impact.venueBookings).toHaveLength(2);
    const small = periodChange.impact.venueBookings.find((booking) => booking.venueName === 'Small Hall');
    expect(small.occupiedStartsAt).toBe('2040-12-02T09:45:00+00:00');
    expect(small.occupiedEndsAt).toBe('2040-12-02T12:30:00+00:00');
    expect(periodChange.impact.equipmentReservations).toHaveLength(1);
    expect(periodChange.impact.registeredAttendeesToNotify).toBe(2);

    const requirementsOnly = await one(
      `select significant_event_change_impact($1, $2::jsonb) as impact`,
      [eventId, JSON.stringify({ venueRequirements: 'A larger room' })],
    );
    expect(requirementsOnly.impact.venueBookings).toHaveLength(2);
    expect(requirementsOnly.impact.registeredAttendeesToNotify).toBe(0);

    const accessibilityOnly = await one(
      `select significant_event_change_impact($1, $2::jsonb) as impact`,
      [eventId, JSON.stringify({ accessibilityRequirements: 'Accessible seating' })],
    );
    expect(accessibilityOnly.impact.venueBookings).toHaveLength(2);
    expect(accessibilityOnly.impact.registeredAttendeesToNotify).toBe(0);
  });

  it('SCRUM395_AC1_requires_the_assigned_coordinator_and_an_allowed_status', async () => {
    await expect(db.query(
      `select preview_significant_event_change($1, $2::jsonb, $3)`,
      [eventId, JSON.stringify({ expectedAttendance: 90 }), otherCoordinator],
    )).rejects.toThrow(/assigned event coordinator/i);
    await expect(db.query(
      `select apply_significant_event_change($1, $2::jsonb, $3, $4)`,
      [eventId, JSON.stringify({ expectedAttendance: 90 }), 'Not assigned', otherCoordinator],
    )).rejects.toThrow(/assigned event coordinator/i);

    const submittedId = await makeEvent('submitted');
    await expect(db.query(
      `select preview_significant_event_change($1, $2::jsonb, $3)`,
      [submittedId, JSON.stringify({ expectedAttendance: 90 }), coordinator],
    )).rejects.toThrow(/does not allow a significant change/i);
    await expect(db.query(
      `select apply_significant_event_change($1, $2::jsonb, $3, $4)`,
      [submittedId, JSON.stringify({ expectedAttendance: 90 }), 'Wrong status', coordinator],
    )).rejects.toThrow(/does not allow a significant change/i);
  });

  it('SCRUM395_AC2_rejects_timestamps_without_a_utc_offset', async () => {
    await expect(db.query(
      `select significant_event_change_impact($1, $2::jsonb)`,
      [
        eventId,
        JSON.stringify({ proposedStart: '2040-12-02T10:00:00' }),
      ],
    )).rejects.toThrow(/ISO timestamp/i);
  });

  it('SCRUM395_AC4_applies_the_previewed_fields_flags_arrangements_and_records_history', async () => {
    const changes = {
      proposedStart: '2040-12-02T10:00:00Z',
      proposedEnd: '2040-12-02T12:00:00Z',
      expectedAttendance: 120,
      venueRequirements: 'A larger lecture space',
    };
    const preview = await one(
      `select preview_significant_event_change($1, $2::jsonb, $3) as impact`,
      [eventId, JSON.stringify(changes), coordinator],
    );
    const applied = await one(
      `select apply_significant_event_change($1, $2::jsonb, $3, $4) as result`,
      [eventId, JSON.stringify(changes), 'Updated event needs', coordinator],
    );

    expect(applied.result.impact).toEqual(preview.impact);
    expect(applied.result.event.status).toBe('approved');
    expect(applied.result.event.proposed_start).toBe('2040-12-02T10:00:00+00:00');
    expect(applied.result.flaggedBookingIds).toHaveLength(2);
    expect(applied.result.flaggedReservationCount).toBe(1);
    expect(await one(
      'select count(*)::int as count from event_change_history where event_request_id = $1',
      [eventId],
    )).toEqual({ count: 4 });
    expect(await one(
      `select array_agg(field_name order by field_name) as fields
         from event_change_history where event_request_id = $1`,
      [eventId],
    )).toEqual({
      fields: ['expectedAttendance', 'proposedEnd', 'proposedStart', 'venueRequirements'],
    });
    expect(await one(
      'select flagged, flag_reason from equipment_reservations where id = $1',
      [reservationId],
    )).toEqual({ flagged: true, flag_reason: 'The event date or time changed' });
    expect(await one(
      'select count(*)::int as count from notifications where event_request_id = $1 and type = $2',
      [eventId, 'event_significant_change_attendee'],
    )).toEqual({ count: 2 });
    expect(await one(
      'select count(*)::int as count from notifications where event_request_id = $1 and type = $2',
      [eventId, 'event_significant_change'],
    )).toEqual({ count: 1 });
    expect(await one(
      'select count(*)::int as count from notifications where event_request_id = $1 and type = $2',
      [eventId, 'booking_flagged_event_change'],
    )).toEqual({ count: 2 });
    expect((await rows(
      `select recipient_id from notifications
        where event_request_id = $1 and type = 'booking_flagged_event_change'`,
      [eventId],
    )).every((notice) => notice.recipient_id === venueStaff)).toBe(true);
    expect(await rows(
      `select reason from equipment_reservation_events
        where equipment_reservation_id = $1 and action = 'flagged'`,
      [reservationId],
    )).toEqual([{ reason: 'The event date or time changed' }]);
  });

  it('SCRUM395_AC5_refuses_to_apply_when_the_impact_changed_after_preview', async () => {
    const staleEventId = await makeEvent();
    const changes = { expectedAttendance: 120 };
    const preview = await one(
      `select preview_significant_event_change($1, $2::jsonb, $3) as impact`,
      [staleEventId, JSON.stringify(changes), coordinator],
    );
    await makeBooking(staleEventId, smallVenueId);

    await expect(db.query(
      `select apply_significant_event_change($1, $2::jsonb, $3, $4, $5::jsonb)`,
      [
        staleEventId,
        JSON.stringify(changes),
        'More attendees expected',
        coordinator,
        JSON.stringify(preview.impact),
      ],
    )).rejects.toThrow(/impact changed/i);

    expect(await one(
      'select expected_attendance from event_requests where id = $1',
      [staleEventId],
    )).toEqual({ expected_attendance: 80 });
    expect(await one(
      `select count(*)::int as count from bookings
        where event_request_id = $1 and status = 'approved'`,
      [staleEventId],
    )).toEqual({ count: 1 });
    expect(await one(
      'select count(*)::int as count from event_change_history where event_request_id = $1',
      [staleEventId],
    )).toEqual({ count: 0 });
  });

  it('SCRUM395_AC6_reinstating_a_flagged_booking_clears_its_flag_reason', async () => {
    const flagged = await one(
      `select id from bookings
        where event_request_id = $1 and status = 'flagged_for_review'
        order by id limit 1`,
      [eventId],
    );
    await db.query(
      `update bookings
          set status = 'approved',
              flagged_at = null,
              flagged_by = null,
              review_block_id = null,
              review_reason = null
        where id = $1`,
      [flagged.id],
    );

    expect(await one(
      'select status, flag_reason from bookings where id = $1',
      [flagged.id],
    )).toEqual({ status: 'approved', flag_reason: null });
  });

  it('SCRUM395_AC4_closes_a_pending_safety_review_and_returns_safety_stages_to_approved', async () => {
    safetyReviewEventId = await makeEvent('safety_review');
    const submission = await one(
      'insert into safety_review_submissions(event_request_id, submitted_by) values ($1, $2) returning id',
      [safetyReviewEventId, coordinator],
    );
    await db.query(
      `select apply_significant_event_change($1, $2::jsonb, $3, $4)`,
      [
        safetyReviewEventId,
        JSON.stringify({ accessibilityRequirements: 'Step-free access throughout' }),
        'Accessibility update',
        coordinator,
      ],
    );
    expect(await one(
      'select status from event_requests where id = $1',
      [safetyReviewEventId],
    )).toEqual({ status: 'approved' });
    expect(await one(
      'select safety_review_submission_id, closed_by, reason from safety_review_closures where event_request_id = $1',
      [safetyReviewEventId],
    )).toEqual({
      safety_review_submission_id: submission.id,
      closed_by: coordinator,
      reason: 'Accessibility update',
    });

    const safetyApprovedEventId = await makeEvent('safety_approved');
    await db.query(
      `select apply_significant_event_change($1, $2::jsonb, $3, $4)`,
      [
        safetyApprovedEventId,
        JSON.stringify({ accessibilityRequirements: 'Accessible seating required' }),
        'Accessibility update',
        coordinator,
      ],
    );
    expect(await one(
      'select status from event_requests where id = $1',
      [safetyApprovedEventId],
    )).toEqual({ status: 'approved' });
  });

  it('SCRUM395_AC8_records_an_equipment_change_without_editing_equipment_lines', async () => {
    const equipmentChangeEventId = await makeEvent();
    const original = await one(
      'select expected_attendance from event_requests where id = $1',
      [equipmentChangeEventId],
    );

    const result = await one(
      `select apply_significant_event_change($1, $2::jsonb, $3, $4) as result`,
      [equipmentChangeEventId, JSON.stringify({ equipmentChange: true }), 'Equipment changed', coordinator],
    );

    expect(result.result.event.status).toBe('approved');
    expect(result.result.impact.equipmentChangeRecorded).toBe(true);
    expect(await one(
      'select field_name, reason from event_change_history where event_request_id = $1',
      [equipmentChangeEventId],
    )).toEqual({ field_name: 'equipment', reason: 'Equipment changed' });
    expect(await one(
      'select expected_attendance from event_requests where id = $1',
      [equipmentChangeEventId],
    )).toEqual(original);
  });

  it('SCRUM395_AC5_rolls_everything_back_if_reservation_flagging_fails', async () => {
    const rollbackEvent = await makeEvent();
    const before = await one('select * from event_requests where id = $1', [rollbackEvent]);
    const rollbackBookingId = await makeBooking(rollbackEvent, smallVenueId);
    const rollbackReservationId = await makeReservation(rollbackEvent, 'Rollback projector', 1);
    // Replaced inside a transaction, so the final rollback restores the real function.
    await db.exec('begin');
    try {
      await db.exec(`
        create or replace function flag_equipment_reservations(p_reservation_ids uuid[], p_reason text)
        returns integer language plpgsql as $$
        begin
          raise exception 'forced reservation failure';
        end;
        $$
      `);
      await db.exec('savepoint before_change');

      await expect(db.query(
        `select apply_significant_event_change($1, $2::jsonb, $3, $4)`,
        [
          rollbackEvent,
          JSON.stringify({
            proposedStart: '2040-12-03T10:00:00Z',
            proposedEnd: '2040-12-03T12:00:00Z',
          }),
          'Forced rollback',
          coordinator,
        ],
      )).rejects.toThrow(/forced reservation failure/);
      await db.exec('rollback to savepoint before_change');

      expect(await one('select * from event_requests where id = $1', [rollbackEvent])).toEqual(before);
      expect(await one(
        'select flagged from equipment_reservations where id = $1',
        [rollbackReservationId],
      )).toEqual({ flagged: false });
      expect(await one(
        'select status, flagged_at, flag_reason from bookings where id = $1',
        [rollbackBookingId],
      )).toEqual({ status: 'approved', flagged_at: null, flag_reason: null });
      expect(await one(
        'select count(*)::int as count from event_change_history where event_request_id = $1',
        [rollbackEvent],
      )).toEqual({ count: 0 });
    } finally {
      await db.exec('rollback');
    }
  });

  it('SCRUM395_AC2_rejects_a_blank_reason_without_saving_fields', async () => {
    const before = await one('select * from event_requests where id = $1', [eventId]);
    await expect(db.query(
      `select apply_significant_event_change($1, $2::jsonb, $3, $4)`,
      [eventId, JSON.stringify({ expectedAttendance: 121 }), '  ', coordinator],
    )).rejects.toThrow(/reason/i);
    expect(await one('select * from event_requests where id = $1', [eventId])).toEqual(before);
  });

  it('SCRUM395_AC4_keeps_a_venue_block_as_the_flag_reason_when_the_event_also_changes', async () => {
    const blockedEvent = await makeEvent();
    const bookingId = await makeBooking(blockedEvent, smallVenueId);
    // A real block row for the flag to point at, clear of every booking here.
    const blockId = await seedBlock(db, { venueId: smallVenueId, start: '2039-01-01T00:00:00Z', end: '2039-01-02T00:00:00Z' });
    await db.query(
      `update bookings
          set status = 'flagged_for_review', review_block_id = $2, flagged_at = now()
        where id = $1`,
      [bookingId, blockId],
    );

    await applyChange(blockedEvent, {
      proposedStart: '2040-12-04T10:00:00Z',
      proposedEnd: '2040-12-04T12:00:00Z',
    }, 'Moved by a day');

    expect(await one(
      'select status, flag_reason, review_block_id from bookings where id = $1',
      [bookingId],
    )).toEqual({ status: 'flagged_for_review', flag_reason: 'venue_block', review_block_id: blockId });
  });

  it('SCRUM395_AC4_labels_a_safety_review_flag_as_safety_review_and_keeps_it', async () => {
    const safetyFlaggedEvent = await makeEvent();
    const bookingId = await makeBooking(safetyFlaggedEvent, smallVenueId);
    await db.query(
      `update bookings
          set status = 'flagged_for_review', review_reason = 'safety_review', flagged_at = now()
        where id = $1`,
      [bookingId],
    );
    expect(await one('select flag_reason from bookings where id = $1', [bookingId]))
      .toEqual({ flag_reason: 'safety_review' });

    await applyChange(safetyFlaggedEvent, { expectedAttendance: 120 }, 'More attendees');

    expect(await one(
      'select status, review_reason, flag_reason from bookings where id = $1',
      [bookingId],
    )).toEqual({
      status: 'flagged_for_review',
      review_reason: 'safety_review',
      flag_reason: 'safety_review',
    });
  });

  it('SCRUM395_AC9_lists_pending_venue_requests_leaves_them_open_and_tells_venue_staff', async () => {
    const movedEvent = await makeEvent();
    const request = (venueId, status) => seedBooking(db, { venueId, eventId: movedEvent, status, start: START, end: END });
    const pendingId = await request(smallVenueId, 'pending');
    const conflictingId = await request(largeVenueId, 'conflicting');

    const attendanceOnly = await one(
      `select preview_significant_event_change($1, $2::jsonb, $3) as impact`,
      [movedEvent, JSON.stringify({ expectedAttendance: 90 }), coordinator],
    );
    expect(attendanceOnly.impact.pendingBookingRequests).toEqual([]);

    const changes = { proposedStart: '2040-12-05T10:00:00Z', proposedEnd: '2040-12-05T12:00:00Z' };
    const preview = await one(
      `select preview_significant_event_change($1, $2::jsonb, $3) as impact`,
      [movedEvent, JSON.stringify(changes), coordinator],
    );
    expect(preview.impact.pendingBookingRequests).toEqual(expect.arrayContaining([
      {
        id: pendingId,
        venueName: 'Small Hall',
        startsAt: '2040-12-01T10:00:00+00:00',
        endsAt: '2040-12-01T12:00:00+00:00',
      },
      expect.objectContaining({ id: conflictingId, venueName: 'Large Hall' }),
    ]));
    expect(preview.impact.pendingBookingRequests).toHaveLength(2);
    expect(preview.impact.venueBookings).toEqual([]);

    const applied = await applyChange(movedEvent, changes, 'Speaker moved', preview.impact);

    expect(applied.impact).toEqual(preview.impact);
    expect(await rows(
      'select id, status, flagged_at from bookings where event_request_id = $1 order by status',
      [movedEvent],
    )).toEqual([
      { id: pendingId, status: 'pending', flagged_at: null },
      { id: conflictingId, status: 'conflicting', flagged_at: null },
    ]);
    const notices = await rows(
      `select recipient_id, booking_id, payload from notifications
        where event_request_id = $1 and type = 'booking_request_event_change'
        order by booking_id = $2 desc`,
      [movedEvent, pendingId],
    );
    expect(notices).toHaveLength(2);
    expect(notices.every((notice) => notice.recipient_id === venueStaff)).toBe(true);
    expect(notices.map((notice) => notice.booking_id)).toEqual([pendingId, conflictingId]);
    expect(notices[0].payload).toEqual({
      eventRequestId: movedEvent,
      eventName: 'Tech Talk',
      venueName: 'Small Hall',
      startsAt: '2040-12-01T10:00:00+00:00',
      endsAt: '2040-12-01T12:00:00+00:00',
      newStartsAt: '2040-12-05T10:00:00+00:00',
      newEndsAt: '2040-12-05T12:00:00+00:00',
      reason: 'Speaker moved',
    });
  });

  it('SCRUM395_AC9_tells_technical_support_once_and_sends_the_coordinator_no_equipment_flag', async () => {
    const movedEvent = await makeEvent();
    const movedReservationId = await makeReservation(movedEvent, 'Microphone', 1);
    // Setting up the request notifies technical support; only the change's notices count here.
    await db.query('delete from notifications where event_request_id = $1', [movedEvent]);

    await applyChange(movedEvent, {
      proposedStart: '2040-12-06T10:00:00Z',
      proposedEnd: '2040-12-06T12:00:00Z',
    }, 'Hall closed that day');

    const equipmentNotices = await rows(
      `select recipient_id, type, payload ->> 'change' as change from notifications
        where event_request_id = $1 and type like 'equipment%'`,
      [movedEvent],
    );
    expect(equipmentNotices.filter((notice) => notice.recipient_id === technicalStaff)).toEqual([
      { recipient_id: technicalStaff, type: 'equipment_request_changed', change: 'event_period' },
    ]);
    expect(equipmentNotices.filter((notice) => notice.recipient_id === coordinator)).toEqual([
      { recipient_id: coordinator, type: 'equipment_request_changed', change: 'event_period' },
    ]);
    expect(await one(
      'select flagged, flag_reason from equipment_reservations where id = $1',
      [movedReservationId],
    )).toEqual({ flagged: true, flag_reason: 'The event date or time changed' });
  });
});
