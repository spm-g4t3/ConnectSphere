import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createSchemaDb, seedBooking, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor } from './helpers/queries.js';

// The cancellation impact preview against the final schema.
describe('SCRUM-373: event_cancellation_impact_preview in Postgres', () => {
  let db;
  let organiser;
  let eventId;
  let otherEventId;
  let venueIds;
  let equipmentTypeId;

  const { one } = queriesFor(() => db);

  async function makeEvent(name) {
    return (
      await one(
        'insert into event_requests (organiser_id, event_name) values ($1, $2) returning id',
        [organiser, name],
      )
    ).id;
  }

  const makeBooking = (forEvent, venueId, status) =>
    seedBooking(db, { venueId, eventId: forEvent, status, start: '2026-12-01T09:00:00Z', end: '2026-12-01T10:00:00Z' });

  beforeAll(async () => {
    db = await createSchemaDb();

    organiser = await seedUser(db, { email: 'organiser@test' });
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
      'select event_cancellation_impact_preview($1) as preview',
      [eventId],
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
      'select event_cancellation_impact_preview($1) as preview',
      [eventId],
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
      'select event_cancellation_impact_preview($1) as preview',
      [eventId],
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
      'select event_cancellation_impact_preview($1) as preview',
      [eventId],
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

    const first = await one('select event_cancellation_impact_preview($1) as preview', [eventId]);
    const second = await one('select event_cancellation_impact_preview($1) as preview', [eventId]);
    const after = await one(
      `select
         coalesce((select jsonb_agg(to_jsonb(b) order by b.id) from bookings b), '[]') as bookings,
         coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from equipment_requests r), '[]') as requests,
         coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from equipment_reservations r), '[]') as reservations`,
    );

    expect(first.preview).toEqual(second.preview);
    expect(after).toEqual(before);
    await expect(
      db.query('select event_cancellation_impact_preview($1)', [randomUUID()]),
    ).rejects.toMatchObject({ code: 'P0002' });
  });
});
