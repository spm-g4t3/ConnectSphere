import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createSchemaDb, seedBooking, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor } from './helpers/queries.js';

// release_event_arrangements against the final schema.
describe('SCRUM-372: release_event_arrangements in Postgres', () => {
  let db;
  let organiser;
  let otherEvent;
  let equipmentType;
  let venueIds;

  const { one } = queriesFor(() => db);
  const status = async (id) => (await one('select status::text as status from bookings where id = $1', [id])).status;
  const reservation = async (id) => one(
    'select released_at, released_by, release_reason from equipment_reservations where id = $1',
    [id],
  );

  async function makeEvent(name = `Event ${randomUUID()}`) {
    return (
      await one(
        'insert into event_requests (organiser_id, event_name) values ($1, $2) returning id',
        [organiser, name],
      )
    ).id;
  }

  const makeBooking = (eventId, venueId, bookingStatus) =>
    seedBooking(db, { venueId, eventId, status: bookingStatus, start: '2026-12-01T09:00:00Z', end: '2026-12-01T10:00:00Z' });

  async function makeEquipmentReservation(eventId, { released = false } = {}) {
    const requestId = (
      await one(
        `insert into equipment_requests (event_request_id, status)
         values ($1, 'arranged')
         returning id`,
        [eventId],
      )
    ).id;
    const lineId = (
      await one(
        `insert into equipment_lines (equipment_request_id, equipment_type_id, quantity)
         values ($1, $2, 2)
         returning id`,
        [requestId, equipmentType],
      )
    ).id;
    const reservationId = (
      await one(
        `insert into equipment_reservations
           (equipment_type_id, event_request_id, equipment_line_id, quantity, start_at, end_at,
            released_at, released_by, release_reason)
         values ($1, $2, $3, 2, '2026-12-01T09:00:00Z', '2026-12-01T10:00:00Z',
                 ${released ? "'2026-11-01T00:00:00Z'" : 'null'},
                 ${released ? 'null' : 'null'},
                 ${released ? "'previous release'" : 'null'})
         returning id`,
        [equipmentType, eventId, lineId],
      )
    ).id;
    return { requestId, reservationId };
  }

  beforeAll(async () => {
    db = await createSchemaDb();

    organiser = await seedUser(db, { email: 'organiser@test' });
    otherEvent = await makeEvent('Unrelated event');
    equipmentType = (
      await one("insert into equipment_types (name, total_quantity) values ('Projector', 10) returning id")
    ).id;
    venueIds = await Promise.all(
      ['Hall A', 'Hall B', 'Hall C'].map((name) => seedVenue(db, { name, capacity: 100, setup: 0, turnaround: 0 })),
    );
  });

  afterAll(async () => {
    await db?.close();
  });

  it('withdraws pending requests and cancels every approved/flagged venue booking', async () => {
    const eventId = await makeEvent();
    const pending = await makeBooking(eventId, venueIds[0], 'pending');
    const approvedA = await makeBooking(eventId, venueIds[0], 'approved');
    const flagged = await makeBooking(eventId, venueIds[1], 'flagged_for_review');
    const approvedB = await makeBooking(eventId, venueIds[2], 'approved');
    const rejected = await makeBooking(eventId, venueIds[2], 'rejected');
    const withdrawn = await makeBooking(eventId, venueIds[2], 'withdrawn');
    const unrelated = await makeBooking(otherEvent, venueIds[0], 'approved');

    await db.query("select release_event_arrangements($1, 'event cancelled')", [eventId]);

    expect(await status(pending)).toBe('withdrawn');
    expect(await status(approvedA)).toBe('cancelled');
    expect(await status(flagged)).toBe('cancelled');
    expect(await status(approvedB)).toBe('cancelled');
    expect(await status(rejected)).toBe('rejected');
    expect(await status(withdrawn)).toBe('withdrawn');
    expect(await status(unrelated)).toBe('approved');
    expect((await one('select status::text as status from event_requests where id = $1', [eventId])).status)
      .toBe('draft');
  });

  it('cancels equipment requests and releases active reservations with the supplied reason', async () => {
    const eventId = await makeEvent();
    const { requestId, reservationId } = await makeEquipmentReservation(eventId);
    const { reservationId: priorReservationId } = await makeEquipmentReservation(eventId, { released: true });
    const { reservationId: otherReservationId } = await makeEquipmentReservation(otherEvent);

    await db.query("select release_event_arrangements($1, 'event rejected')", [eventId]);

    expect((await one('select status::text as status from equipment_requests where id = $1', [requestId])).status)
      .toBe('cancelled');
    const released = await reservation(reservationId);
    expect(released.released_at).not.toBeNull();
    expect(released.released_by).toBeNull();
    expect(released.release_reason).toBe('event rejected');
    expect(await reservation(priorReservationId)).toMatchObject({ release_reason: 'previous release' });
    expect(await reservation(otherReservationId)).toMatchObject({
      released_at: null,
      released_by: null,
      release_reason: null,
    });
  });

  it('refuses a blank reason and an unknown event without applying writes', async () => {
    const eventId = await makeEvent();
    const bookingId = await makeBooking(eventId, venueIds[0], 'approved');

    await expect(db.query("select release_event_arrangements($1, '  ')", [eventId]))
      .rejects.toMatchObject({ code: '22023' });
    await expect(db.query("select release_event_arrangements($1, 'event cancelled')", [randomUUID()]))
      .rejects.toMatchObject({ code: 'P0002' });
    expect(await status(bookingId)).toBe('approved');
  });
});
