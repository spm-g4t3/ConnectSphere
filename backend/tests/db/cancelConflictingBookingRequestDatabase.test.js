/**
 * Cancelling an event treats its conflicting booking requests as its pending
 * ones: the preview lists them, cancelling withdraws them, and Venue Staff are
 * told. Run against the final schema.
 *
 * SCRUM-258 AC3 with the Week 7 rule that conflicting is a flag on an open
 * request, not an end state.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor } from './helpers/queries.js';

describe('SCRUM-258 AC3: cancelling an event withdraws its conflicting requests', () => {
  let db;
  let organiser;
  let coordinator;
  let venueStaff;
  let venueId;
  let otherVenueId;

  const { one } = queriesFor(() => db);
  const bookingStatus = async (id) =>
    (await one('select status::text as status from bookings where id = $1', [id])).status;

  function makeApprovedEvent() {
    return seedEvent(db, {
      status: 'approved',
      organiser_id: organiser,
      assigned_coordinator_id: coordinator,
      event_name: 'Conflicting cancellation',
    });
  }

  const makeBooking = (eventId, venue, status) =>
    seedBooking(db, { venueId: venue, eventId, status, start: '2026-12-01T09:00:00Z', end: '2026-12-01T10:00:00Z' });

  const cancel = (eventId) =>
    db.query(
      `select cancel_event_request($1, $2, 'Venue issue', 'connectsphere_decision'::event_cancellation_initiator, null)`,
      [eventId, coordinator],
    );

  beforeAll(async () => {
    db = await createSchemaDb();

    organiser = await seedUser(db, { email: 'organiser@test', role: 'event_organiser' });
    coordinator = await seedUser(db, { email: 'coordinator@test', role: 'event_coordinator' });
    venueStaff = await seedUser(db, { email: 'venue-staff@test', role: 'venue_staff' });
    venueId = await seedVenue(db, { name: 'Hall', capacity: 100, setup: 0, turnaround: 0 });
    otherVenueId = await seedVenue(db, { name: 'Annex', location: 'Block B', capacity: 100, setup: 0, turnaround: 0 });
  }, 30000);

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM258_AC3_the_cancellation_preview_lists_a_conflicting_request_among_those_to_withdraw', async () => {
    const eventId = await makeApprovedEvent();
    const conflicting = await makeBooking(eventId, venueId, 'conflicting');
    const pending = await makeBooking(eventId, otherVenueId, 'pending');

    const { preview } = await one('select event_cancellation_impact_preview($1) as preview', [eventId]);

    expect(preview.bookingRequests.count).toBe(2);
    expect(preview.bookingRequests.details.map((d) => [d.id, d.status]).sort()).toEqual(
      [[conflicting, 'conflicting'], [pending, 'pending']].sort(),
    );
    expect(preview.venueBookings.count).toBe(0);
  });

  it('SCRUM258_AC3_cancelling_withdraws_a_conflicting_request_and_tells_venue_staff', async () => {
    const eventId = await makeApprovedEvent();
    const conflicting = await makeBooking(eventId, venueId, 'conflicting');

    await cancel(eventId);

    expect(await bookingStatus(conflicting)).toBe('withdrawn');
    const toStaff = (
      await db.query(
        "select recipient_id from notifications where event_request_id = $1 and type = 'event_cancelled' and payload->>'audience' = 'venue_staff'",
        [eventId],
      )
    ).rows;
    expect(toStaff.map((n) => n.recipient_id)).toEqual([venueStaff]);
  });

  it('SCRUM258_Week7_cancelling_cancels_the_approved_booking_and_leaves_its_converted_hold_converted', async () => {
    const eventId = await makeApprovedEvent();
    const approved = await makeBooking(eventId, venueId, 'approved');
    // The hold an approval converts, written directly.
    const holdId = (
      await one(
        `insert into venue_holds
           (event_request_id, venue_id, placed_by, expires_at, status, converted_at, converted_booking_id)
         values ($1, $2, $3, now() + interval '2 days', 'converted', now(), $4)
         returning id`,
        [eventId, venueId, venueStaff, approved],
      )
    ).id;

    await cancel(eventId);

    expect(await bookingStatus(approved)).toBe('cancelled');
    const hold = await one(
      'select status::text as status, released_at, converted_booking_id from venue_holds where id = $1',
      [holdId],
    );
    expect(hold).toEqual({ status: 'converted', released_at: null, converted_booking_id: approved });
  });
});
