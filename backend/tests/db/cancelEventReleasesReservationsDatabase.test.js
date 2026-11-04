/**
 * SCRUM-305 for SCRUM-300: cancelling an event releases its live equipment
 * reservations through release_equipment_reservations (054), so the history
 * records a system release with the cancellation reason. Runs against the
 * final schema, like cancelEventRequestDatabase.test.js.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor } from './helpers/queries.js';

describe('SCRUM-300 with SCRUM-370: cancelling an event releases its reserved equipment', () => {
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

  const approvedEventWithReservation = async (quantity = 2) => {
    const eventId = await makeEvent('approved');
    await db.query(
      "update event_requests set proposed_start = '2026-12-01T10:00:00Z', proposed_end = '2026-12-01T12:00:00Z' where id = $1",
      [eventId],
    );
    const type = (await one(
      "insert into equipment_types (name, total_quantity) values ($1, 10) returning id",
      [`Projector ${Math.random()}`],
    )).id;
    const state = JSON.parse((await one(
      'select add_equipment_line($1, $2, $3, $4, null)::text as answer',
      [eventId, coordinator, type, quantity + 1],
    )).answer);
    await db.query('select start_equipment_review($1, $2)', [eventId, technicalSupport]);
    await db.query('select reserve_equipment($1, $2, $3, $4)', [eventId, technicalSupport, state.request.lines[0].id, quantity]);
    return eventId;
  };

  const reservationsOf = async (eventId) =>
    (await db.query(
      'select id, quantity, released_at, released_by, release_reason from equipment_reservations where event_request_id = $1',
      [eventId],
    )).rows;
  const historyOf = async (eventId) =>
    (await db.query(
      'select action, user_id, reason, quantity_before, quantity_after from equipment_reservation_events where event_request_id = $1 order by id',
      [eventId],
    )).rows;

  it('SCRUM300_AC5_cancelling_releases_live_reservations_and_records_a_system_release', async () => {
    const eventId = await approvedEventWithReservation(2);
    await cancel(eventId, coordinator, 'Venue unavailable');

    const [reservation] = await reservationsOf(eventId);
    expect(reservation.released_at).not.toBeNull();
    expect(reservation.released_by).toBeNull();
    expect(reservation.release_reason).toBe('event cancelled');

    const history = await historyOf(eventId);
    expect(history.map((row) => row.action)).toEqual(['reserved', 'released']);
    expect(history[1]).toMatchObject({
      user_id: null,
      reason: 'event cancelled',
      quantity_before: 2,
      quantity_after: 0,
    });
    expect((await one("select status::text as status from equipment_requests where event_request_id = $1", [eventId])).status)
      .toBe('cancelled');
  });

  it('SCRUM300_AC5_the_reservation_row_is_kept_not_deleted', async () => {
    const eventId = await approvedEventWithReservation(1);
    await cancel(eventId);
    expect(await reservationsOf(eventId)).toHaveLength(1);
  });

  it('SCRUM300_AC5_another_events_reservation_is_left_alone', async () => {
    const cancelled = await approvedEventWithReservation(1);
    const other = await approvedEventWithReservation(1);
    await cancel(cancelled);
    const [reservation] = await reservationsOf(other);
    expect(reservation.released_at).toBeNull();
    expect((await historyOf(other)).map((row) => row.action)).toEqual(['reserved']);
  });

  it('SCRUM300_AC5_the_released_units_are_available_again', async () => {
    const eventId = await approvedEventWithReservation(3);
    const typeId = (await one('select equipment_type_id as id from equipment_reservations where event_request_id = $1', [eventId])).id;
    const before = await one(
      "select (equipment_availability($1, '2026-12-01T10:00:00Z', '2026-12-01T12:00:00Z', null) ->> 'available')::int as available",
      [typeId],
    );
    await cancel(eventId);
    const after = await one(
      "select (equipment_availability($1, '2026-12-01T10:00:00Z', '2026-12-01T12:00:00Z', null) ->> 'available')::int as available",
      [typeId],
    );
    expect(after.available).toBe(before.available + 3);
  });

  it('SCRUM300_AC5_an_already_released_reservation_is_not_released_twice', async () => {
    const eventId = await approvedEventWithReservation(1);
    const [reservation] = await reservationsOf(eventId);
    await db.query('select release_equipment_reservation($1, $2, $3, $4)', [eventId, technicalSupport, reservation.id, 'Not needed']);
    await cancel(eventId);
    const released = (await historyOf(eventId)).filter((row) => row.action === 'released');
    expect(released).toHaveLength(1);
    expect(released[0].user_id).toBe(technicalSupport);
  });

  it('SCRUM300_AC5_a_cancel_that_is_refused_releases_nothing', async () => {
    const eventId = await approvedEventWithReservation(1);
    await expect(cancel(eventId, coordinator, '   ')).rejects.toThrow();
    const [reservation] = await reservationsOf(eventId);
    expect(reservation.released_at).toBeNull();
  });
});
