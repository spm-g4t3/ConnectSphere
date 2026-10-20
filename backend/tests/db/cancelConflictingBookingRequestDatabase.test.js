/**
 * Cancelling an event treats its conflicting booking requests as its pending
 * ones: the preview lists them, cancelling withdraws them, and Venue Staff are
 * told. Run against the final schema.
 *
 * SCRUM-258 AC3 with the Week 7 rule that conflicting is a flag on an open
 * request, not an end state.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';

describe('SCRUM-258 AC3: cancelling an event withdraws its conflicting requests', () => {
  let db;
  let organiser;
  let coordinator;
  let venueStaff;
  let venueId;
  let otherVenueId;

  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
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

  async function makeBooking(eventId, venue, status) {
    return (
      await one(
        `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
         values ($1, $2, '2026-12-01T09:00:00Z', '2026-12-01T10:00:00Z', $3)
         returning id`,
        [venue, eventId, status],
      )
    ).id;
  }

  const cancel = (eventId) =>
    db.query(
      `select cancel_event_request($1, $2, 'Venue issue', 'connectsphere_decision'::event_cancellation_initiator, null)`,
      [eventId, coordinator],
    );

  beforeAll(async () => {
    db = await createSchemaDb();

    organiser = (await one("insert into auth.users (email) values ('organiser@test') returning id")).id;
    coordinator = (await one("insert into auth.users (email) values ('coordinator@test') returning id")).id;
    venueStaff = (await one("insert into auth.users (email) values ('venue-staff@test') returning id")).id;
    await db.query(
      `insert into profiles (id, role) values
         ($1, 'event_organiser'),
         ($2, 'event_coordinator'),
         ($3, 'venue_staff')`,
      [organiser, coordinator, venueStaff],
    );
    venueId = (
      await one("insert into venues (name, location, max_capacity) values ('Hall', 'Block A', 100) returning id")
    ).id;
    otherVenueId = (
      await one("insert into venues (name, location, max_capacity) values ('Annex', 'Block B', 100) returning id")
    ).id;
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
