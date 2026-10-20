import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor } from './helpers/queries.js';

// cancel_event_request against the final schema.
describe('SCRUM-374: cancel_event_request in Postgres', () => {
  let db;
  let organiser;
  let coordinator;
  let otherCoordinator;
  let venueStaff;
  let technicalSupport;
  let venueId;

  const { one } = queriesFor(() => db);
  const eventRow = (id) => one('select * from event_requests where id = $1', [id]);
  const statusHistory = async (id) =>
    (await db.query(
      'select previous_status::text, new_status::text, reason from event_request_status_history where event_request_id = $1 order by created_at, id',
      [id],
    )).rows;
  const bookingStatus = async (id) =>
    (await one('select status::text as status from bookings where id = $1', [id])).status;

  function makeEvent(status = 'submitted') {
    return seedEvent(db, {
      status,
      organiser_id: organiser,
      event_name: `Cancellation test ${status}`,
      assigned_coordinator_id: coordinator,
    });
  }

  const makeBooking = (eventId, status = 'approved') =>
    seedBooking(db, { venueId, eventId, status, start: '2026-12-01T09:00:00Z', end: '2026-12-01T10:00:00Z' });

  async function makeHold(eventId) {
    return (
      await one(
        `insert into venue_holds (event_request_id, venue_id, placed_by, expires_at)
         values ($1, $2, $3, now() + interval '1 day')
         returning id`,
        [eventId, venueId, coordinator],
      )
    ).id;
  }

  async function makeChangeRequest(eventId) {
    return (
      await one(
        `insert into event_change_requests
           (event_request_id, requested_by, change_field, requested_change)
         values ($1, $2, 'other', 'Change the event format')
         returning id`,
        [eventId, organiser],
      )
    ).id;
  }

  const cancel = (eventId, who = coordinator, reason = 'Venue issue', initiator = 'connectsphere_decision') =>
    db.query(
      `select cancel_event_request($1, $2, $3, $4::event_cancellation_initiator, $5)`,
      [eventId, who, reason, initiator, 'This event will not go ahead.'],
    );

  beforeAll(async () => {
    db = await createSchemaDb();

    organiser = await seedUser(db, { email: 'organiser@test', role: 'event_organiser' });
    coordinator = await seedUser(db, { email: 'coordinator@test', role: 'event_coordinator' });
    otherCoordinator = await seedUser(db, { email: 'other-coordinator@test', role: 'event_coordinator' });
    venueStaff = await seedUser(db, { email: 'venue-staff@test', role: 'venue_staff' });
    technicalSupport = await seedUser(db, { email: 'technical-support@test', role: 'technical_support_staff' });
    venueId = await seedVenue(db, { name: 'Hall', capacity: 100, setup: 0, turnaround: 0 });
  }, 30000);

  afterAll(async () => {
    await db?.close();
  });

  it('cancels a newly created event arrangement set and closes open change/clarification requests', async () => {
    const eventId = await makeEvent('pending_clarification');
    const bookingId = await makeBooking(eventId, 'pending');
    const holdId = await makeHold(eventId);
    const unrelatedEventId = await makeEvent('approved');
    const unrelatedHoldId = await makeHold(unrelatedEventId);
    const equipmentRequestId = (
      await one(
        `insert into equipment_requests (event_request_id, status)
         values ($1, 'pending_review') returning id`,
        [eventId],
      )
    ).id;
    const changeRequestId = await makeChangeRequest(eventId);
    await db.query(
      `insert into event_request_clarification_history
         (event_request_id, entry_type, message, created_by)
       values ($1, 'question', 'Please clarify the event plan', $2)`,
      [eventId, coordinator],
    );

    const { preview } = await one(
      'select event_cancellation_impact_preview($1, $2) as preview',
      [eventId, coordinator],
    );
    expect(preview.venueHolds).toMatchObject({
      count: 1,
      details: [expect.objectContaining({ id: holdId, venueName: 'Hall' })],
    });

    await cancel(eventId, coordinator, '  Venue unavailable  ', 'organiser_request');

    const cancelled = await eventRow(eventId);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancellation_reason).toBe('Venue unavailable');
    expect(cancelled.cancellation_initiator).toBe('organiser_request');
    expect(cancelled.cancelled_by).toBe(coordinator);
    expect(cancelled.cancelled_at).not.toBeNull();
    expect(cancelled.attendee_message).toBe('This event will not go ahead.');
    expect(await bookingStatus(bookingId)).toBe('withdrawn');
    expect(await one(
      'select status::text as status, released_at, released_by from venue_holds where id = $1',
      [holdId],
    )).toMatchObject({ status: 'released', released_by: coordinator });
    expect((await one('select status::text as status from venue_holds where id = $1', [unrelatedHoldId])).status)
      .toBe('active');
    expect((await one('select status::text as status from equipment_requests where id = $1', [equipmentRequestId])).status)
      .toBe('cancelled');
    const notifications = (await db.query(
      `select recipient_id, payload
         from notifications
        where event_request_id = $1 and type = 'event_cancelled'`,
      [eventId],
    )).rows;
    expect(notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        recipient_id: organiser,
        payload: expect.objectContaining({
          audience: 'organiser',
          eventName: expect.stringContaining('Cancellation test'),
          reason: 'Venue unavailable',
        }),
      }),
      expect.objectContaining({
        recipient_id: venueStaff,
        payload: expect.objectContaining({ audience: 'venue_staff' }),
      }),
      expect.objectContaining({
        recipient_id: technicalSupport,
        payload: expect.objectContaining({ audience: 'technical_support_staff' }),
      }),
    ]));
    const changeRequest = await one(
      'select status::text as status, decision::text as decision, processed_by, processed_at from event_change_requests where id = $1',
      [changeRequestId],
    );
    expect(changeRequest).toMatchObject({
      status: 'processed',
      decision: 'event_cancelled',
      processed_by: coordinator,
    });
    expect(changeRequest.processed_at).not.toBeNull();
    expect(
      (await db.query(
        `select entry_type, message
           from event_request_clarification_history
          where event_request_id = $1
          order by created_at, id`,
        [eventId],
      )).rows,
    ).toMatchObject([
      { entry_type: 'question', message: 'Please clarify the event plan' },
      { entry_type: 'closure', message: 'Event cancelled' },
    ]);
    expect(await statusHistory(eventId)).toMatchObject([
      { previous_status: 'pending_clarification', new_status: 'cancelled', reason: 'Venue unavailable' },
    ]);
  });

  it('rolls back the status, history, metadata, and earlier releases when a release step fails', async () => {
    const eventId = await makeEvent('approved');
    const bookingId = await makeBooking(eventId, 'approved');
    const changeRequestId = await makeChangeRequest(eventId);
    await db.exec(`
      create function fail_booking_cancellation()
      returns trigger language plpgsql as $$
      begin
        raise exception 'simulated arrangement release failure' using errcode = 'P0001';
      end;
      $$;
      create trigger fail_booking_cancellation
      before update on bookings
      for each row execute function fail_booking_cancellation();
    `);

    await expect(cancel(eventId)).rejects.toMatchObject({ code: 'P0001' });

    expect((await eventRow(eventId)).status).toBe('approved');
    expect((await eventRow(eventId)).cancellation_reason).toBeNull();
    expect(await statusHistory(eventId)).toHaveLength(0);
    expect(await bookingStatus(bookingId)).toBe('approved');
    expect((await one('select status::text as status from event_change_requests where id = $1', [changeRequestId])).status)
      .toBe('outstanding');
    await db.exec('drop trigger fail_booking_cancellation on bookings;');
    await db.exec('drop function fail_booking_cancellation();');
  });

  it('rejects the wrong coordinator without changing anything', async () => {
    const eventId = await makeEvent('submitted');
    const bookingId = await makeBooking(eventId);

    await expect(cancel(eventId, otherCoordinator)).rejects.toMatchObject({ code: '42501' });

    expect((await eventRow(eventId)).status).toBe('submitted');
    expect((await eventRow(eventId)).cancellation_reason).toBeNull();
    expect(await bookingStatus(bookingId)).toBe('approved');
    expect(await statusHistory(eventId)).toHaveLength(0);
  });

  it('rejects an unsupported status with its name and leaves state untouched', async () => {
    const eventId = await makeEvent('draft');
    const error = await db.query(
      `select cancel_event_request($1, $2, 'Reason', 'connectsphere_decision', null)`,
      [eventId, coordinator],
    ).then(() => null, (caught) => caught);

    expect(error.code).toBe('55000');
    expect(error.message).toContain('draft');
    expect((await eventRow(eventId)).status).toBe('draft');
    expect(await statusHistory(eventId)).toHaveLength(0);
  });

  it('rejects a blank reason or missing initiator', async () => {
    const eventId = await makeEvent();

    await expect(cancel(eventId, coordinator, '   ')).rejects.toMatchObject({ code: '22023' });
    await expect(
      db.query(
        'select cancel_event_request($1, $2, $3, null, null)',
        [eventId, coordinator, 'Reason'],
      ),
    ).rejects.toMatchObject({ code: '22004' });
    expect((await eventRow(eventId)).status).toBe('submitted');
  });

  describe.each(['safety_review', 'safety_approved'])('SCRUM561: from %s', (status) => {
    function makeSafetyEvent() {
      return seedEvent(db, {
        status, organiser_id: organiser, event_name: 'Safety cancel', assigned_coordinator_id: coordinator,
      });
    }

    it(`SCRUM561_AC1_AC2_assigned_coordinator_cancels_from_${status}_and_releases_arrangements`, async () => {
      const eventId = await makeSafetyEvent();
      const bookingId = await makeBooking(eventId, 'approved');
      const holdId = await makeHold(eventId);

      await cancel(eventId);

      const event = await eventRow(eventId);
      expect(event.status).toBe('cancelled');
      expect(event.cancellation_reason).toBe('Venue issue');
      expect(await bookingStatus(bookingId)).toBe('cancelled');
      expect((await one('select status::text as status from venue_holds where id = $1', [holdId])).status)
        .not.toBe('active');
      expect((await statusHistory(eventId)).at(-1)).toMatchObject({
        previous_status: status,
        new_status: 'cancelled',
      });
      const notified = (
        await db.query(
          "select recipient_id from notifications where event_request_id = $1 and type = 'event_cancelled'",
          [eventId],
        )
      ).rows.map((row) => row.recipient_id);
      expect(notified).toEqual(expect.arrayContaining([organiser, venueStaff]));
    });

    it(`SCRUM561_AC2_${status}_preview_lists_the_arrangements_and_cancel_releases_equipment_and_notifies_staff`, async () => {
      const eventId = await makeSafetyEvent();
      const bookingId = await makeBooking(eventId, 'approved');
      const holdId = await makeHold(eventId);
      const equipmentRequestId = (
        await one(
          `insert into equipment_requests (event_request_id, status)
           values ($1, 'pending_review') returning id`,
          [eventId],
        )
      ).id;
      const changeRequestId = await makeChangeRequest(eventId);

      const { preview } = await one(
        'select event_cancellation_impact_preview($1, $2) as preview',
        [eventId, coordinator],
      );
      expect(preview.venueBookings.count).toBe(1);
      expect(preview.venueHolds.details).toEqual([expect.objectContaining({ id: holdId })]);
      expect(preview.equipmentRequests.count).toBe(1);

      await cancel(eventId, coordinator, '  Called off in the safety check  ', 'organiser_request');

      const cancelled = await eventRow(eventId);
      expect(cancelled).toMatchObject({
        status: 'cancelled',
        cancellation_reason: 'Called off in the safety check',
        cancellation_initiator: 'organiser_request',
        cancelled_by: coordinator,
      });
      expect(cancelled.cancelled_at).not.toBeNull();
      expect(await bookingStatus(bookingId)).toBe('cancelled');
      expect((await one('select status::text as status from equipment_requests where id = $1', [equipmentRequestId])).status)
        .toBe('cancelled');
      expect((await one('select status::text as status from event_change_requests where id = $1', [changeRequestId])).status)
        .toBe('processed');
      const audiences = (
        await db.query(
          "select recipient_id, payload->>'audience' as audience from notifications where event_request_id = $1 and type = 'event_cancelled'",
          [eventId],
        )
      ).rows;
      expect(audiences).toEqual(expect.arrayContaining([
        expect.objectContaining({ recipient_id: organiser, audience: 'organiser' }),
        expect.objectContaining({ recipient_id: venueStaff, audience: 'venue_staff' }),
        expect.objectContaining({ recipient_id: technicalSupport, audience: 'technical_support_staff' }),
      ]));
    });

    it(`SCRUM561_AC1_a_blank_reason_is_refused_from_${status}`, async () => {
      const eventId = await makeSafetyEvent();

      await expect(cancel(eventId, coordinator, '  ')).rejects.toMatchObject({ code: '22023' });
      expect((await eventRow(eventId)).status).toBe(status);
    });

    it(`SCRUM561_AC1_another_coordinator_cannot_cancel_from_${status}`, async () => {
      const eventId = await makeSafetyEvent();

      await expect(cancel(eventId, otherCoordinator)).rejects.toMatchObject({ code: '42501' });
      expect((await eventRow(eventId)).status).toBe(status);
    });
  });
});
