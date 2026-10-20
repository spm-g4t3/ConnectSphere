import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createSchemaDb, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor, refusal } from './helpers/queries.js';

// The cancellation impact preview against the final schema.
describe('SCRUM-373: event_cancellation_impact_preview in Postgres', () => {
  let db;
  let organiser;
  let coordinator;
  let eventId;
  let otherEventId;
  let venueIds;
  let equipmentTypeId;

  const { one } = queriesFor(() => db);

  // Approved and assigned: only the assigned coordinator may preview (011).
  const makeEvent = (name) =>
    seedEvent(db, { status: 'approved', organiser_id: organiser, event_name: name, assigned_coordinator_id: coordinator });

  const makeBooking = (forEvent, venueId, status) =>
    seedBooking(db, { venueId, eventId: forEvent, status, start: '2026-12-01T09:00:00Z', end: '2026-12-01T10:00:00Z' });

  beforeAll(async () => {
    db = await createSchemaDb();

    organiser = await seedUser(db, { email: 'organiser@test' });
    coordinator = await seedUser(db, { email: 'coordinator@test', role: 'event_coordinator' });
    eventId = await makeEvent('Preview event');
    otherEventId = await makeEvent('Other event');
    venueIds = await Promise.all(
      ['Hall A', 'Hall B', 'Hall C'].map((name) => seedVenue(db, { name, capacity: 100, setup: 0, turnaround: 0 })),
    );
    equipmentTypeId = (
      await one("insert into equipment_types (name, total_quantity) values ('Projector', 10) returning id")
    ).id;
  });

  afterAll(async () => {
    await db?.close();
  });

  it('returns separate counts and details for active venue bookings and pending requests', async () => {
    await makeBooking(eventId, venueIds[0], 'approved');
    await makeBooking(eventId, venueIds[1], 'flagged_for_review');
    await makeBooking(eventId, venueIds[2], 'pending');
    await makeBooking(eventId, venueIds[0], 'rejected');
    await makeBooking(otherEventId, venueIds[0], 'approved');

    const { preview } = await one(
      'select event_cancellation_impact_preview($1, $2) as preview',
      [eventId, coordinator],
    );

    expect(preview.venueBookings.count).toBe(2);
    expect(preview.venueBookings.details.map((booking) => booking.status).sort())
      .toEqual(['approved', 'flagged_for_review']);
    expect(preview.venueBookings.details.map((booking) => booking.venueName).sort())
      .toEqual(['Hall A', 'Hall B']);
    expect(preview.bookingRequests.count).toBe(1);
    expect(preview.bookingRequests.details[0]).toMatchObject({
      status: 'pending',
      venueName: 'Hall C',
      venueLocation: 'Block A',
    });
  });

  it('returns equipment requests, their lines, and only active reservation impacts', async () => {
    const requestId = (
      await one(
        `insert into equipment_requests (event_request_id, status)
         values ($1, 'arranged') returning id`,
        [eventId],
      )
    ).id;
    const lineId = (
      await one(
        `insert into equipment_lines (equipment_request_id, equipment_type_id, quantity, technical_notes)
         values ($1, $2, 2, 'HDMI required') returning id`,
        [requestId, equipmentTypeId],
      )
    ).id;
    await db.query(
      `insert into equipment_reservations
         (equipment_type_id, event_request_id, equipment_line_id, quantity, start_at, end_at)
       values ($1, $2, $3, 2, '2026-12-01T09:00:00Z', '2026-12-01T10:00:00Z')`,
      [equipmentTypeId, eventId, lineId],
    );
    await db.query(
      `insert into equipment_reservations
         (equipment_type_id, event_request_id, equipment_line_id, quantity, start_at, end_at,
          released_at, release_reason)
       values ($1, $2, $3, 1, '2026-12-01T09:00:00Z', '2026-12-01T10:00:00Z',
               '2026-11-01T00:00:00Z', 'previous release')`,
      [equipmentTypeId, eventId, lineId],
    );

    const { preview } = await one(
      'select event_cancellation_impact_preview($1, $2) as preview',
      [eventId, coordinator],
    );

    expect(preview.equipmentRequests.count).toBe(1);
    expect(preview.equipmentRequests.details[0]).toMatchObject({
      id: requestId,
      status: 'arranged',
      lines: [{
        id: lineId,
        equipmentName: 'Projector',
        quantity: 2,
        technicalNotes: 'HDMI required',
      }],
    });
    expect(preview.equipmentReservations.count).toBe(1);
    expect(preview.equipmentReservations.details[0]).toMatchObject({
      equipmentName: 'Projector',
      equipmentLineId: lineId,
      quantity: 2,
      flagged: false,
    });
  });

  it('excludes cancelled equipment requests from the impact preview', async () => {
    const cancelledRequestId = (
      await one(
        `insert into equipment_requests (event_request_id, status)
         values ($1, 'cancelled') returning id`,
        [eventId],
      )
    ).id;

    const { preview } = await one(
      'select event_cancellation_impact_preview($1, $2) as preview',
      [eventId, coordinator],
    );

    expect(preview.equipmentRequests.details).not.toContainEqual(
      expect.objectContaining({ id: cancelledRequestId }),
    );
    expect(preview.equipmentRequests.count).toBe(
      preview.equipmentRequests.details.length,
    );
  });

  it('excludes removed equipment lines from the request details', async () => {
    const requestId = (
      await one(
        `insert into equipment_requests (event_request_id, status)
         values ($1, 'arranged') returning id`,
        [eventId],
      )
    ).id;
    const otherEquipmentTypeId = (
      await one(
        "insert into equipment_types (name, total_quantity) values ('Microphone', 10) returning id",
      )
    ).id;
    const activeLineId = (
      await one(
        `insert into equipment_lines (equipment_request_id, equipment_type_id, quantity)
         values ($1, $2, 1) returning id`,
        [requestId, equipmentTypeId],
      )
    ).id;
    const removedLineId = (
      await one(
        `insert into equipment_lines (equipment_request_id, equipment_type_id, quantity, removed_at)
         values ($1, $2, 1, now()) returning id`,
        [requestId, otherEquipmentTypeId],
      )
    ).id;

    const { preview } = await one(
      'select event_cancellation_impact_preview($1, $2) as preview',
      [eventId, coordinator],
    );
    const request = preview.equipmentRequests.details.find((item) => item.id === requestId);

    expect(request.lines.map((line) => line.id)).toContain(activeLineId);
    expect(request.lines.map((line) => line.id)).not.toContain(removedLineId);
  });

  it('changes no database rows and rejects a missing event', async () => {
    const before = await one(
      `select
         coalesce((select jsonb_agg(to_jsonb(b) order by b.id) from bookings b), '[]') as bookings,
         coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from equipment_requests r), '[]') as requests,
         coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from equipment_reservations r), '[]') as reservations`,
    );

    const first = await one('select event_cancellation_impact_preview($1, $2) as preview', [eventId, coordinator]);
    const second = await one('select event_cancellation_impact_preview($1, $2) as preview', [eventId, coordinator]);
    const after = await one(
      `select
         coalesce((select jsonb_agg(to_jsonb(b) order by b.id) from bookings b), '[]') as bookings,
         coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from equipment_requests r), '[]') as requests,
         coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from equipment_reservations r), '[]') as reservations`,
    );

    expect(first.preview).toEqual(second.preview);
    expect(after).toEqual(before);
    await expect(
      db.query('select event_cancellation_impact_preview($1, $2)', [randomUUID(), coordinator]),
    ).rejects.toMatchObject({ code: 'P0002' });
  });

  describe('AC1: only the assigned coordinator previews', () => {
    // The route checks the caller; since 011 the function does too, so a
    // direct call cannot read another coordinator's event.
    it('SCRUM370_AC1_a_null_caller_is_refused_with_42501', async () => {
      const err = await refusal(db.query('select event_cancellation_impact_preview($1, null)', [eventId]));

      expect(err?.code).toBe('42501');
    });

    it('SCRUM370_AC1_a_coordinator_who_is_not_the_assigned_one_is_refused_with_42501', async () => {
      const other = await seedUser(db, { email: 'other-coordinator@test', role: 'event_coordinator' });

      const err = await refusal(db.query('select event_cancellation_impact_preview($1, $2)', [eventId, other]));

      expect(err?.code).toBe('42501');
      expect(err?.message).toBe('Only the coordinator assigned to this event can preview its cancellation');
    });

    it('SCRUM370_AC1_the_assigned_coordinator_without_the_coordinator_role_is_refused_with_42501', async () => {
      const formerCoordinator = await seedUser(db, { email: 'former-coordinator@test', role: 'venue_staff' });
      const assigned = await seedEvent(db, {
        status: 'approved', organiser_id: organiser, event_name: 'Wrong role', assigned_coordinator_id: formerCoordinator,
      });

      const err = await refusal(db.query('select event_cancellation_impact_preview($1, $2)', [assigned, formerCoordinator]));

      expect(err?.code).toBe('42501');
    });
  });
});
