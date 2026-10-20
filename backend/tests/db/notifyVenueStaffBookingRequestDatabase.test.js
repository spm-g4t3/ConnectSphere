/**
 * Every Venue Staff user is notified when a coordinator submits a venue
 * booking request, against the final schema in a real Postgres.
 *
 * SCRUM-174 AC1 (who is told, and only for a request that was created) and
 * AC6 (the notice names the event and the venue).
 *
 * Dates: D is the Singapore date 10 days from now, never hard-coded, because
 * a booking counts only while it has not ended.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor } from './helpers/queries.js';
import { at } from '../fixtures/time.js';

describe('SCRUM-174: Venue Staff are told of a new booking request', () => {
  let db;
  let organiser;
  let coordinator;
  let staff;
  let otherStaff;
  let counter = 0;

  const { one } = queriesFor(() => db);

  const makeUser = (email, role) => seedUser(db, { email, role });

  const makeVenue = () => seedVenue(db, { name: `Harbour Room ${++counter}` });

  function makeEvent() {
    counter += 1;
    return seedEvent(db, {
      status: 'approved',
      organiser_id: organiser,
      assigned_coordinator_id: coordinator,
      event_name: `Event ${counter}`,
      proposed_start: at('14:00'),
      proposed_end: at('16:00'),
      expected_attendance: 150,
    });
  }

  /** create_booking_request as the API calls it. */
  const request = async (eventId, venueId, suitable = true) =>
    (
      await one(
        `select create_booking_request($1, $2, $3, null, null, $4::jsonb, false, 100, null) as result`,
        [eventId, venueId, coordinator, JSON.stringify({ suitable })],
      )
    ).result;

  const submittedNotices = async (eventId) =>
    (
      await db.query(
        `select recipient_id, booking_id, payload from notifications
          where type = 'booking_request_submitted' and payload->>'eventRequestId' = $1`,
        [eventId],
      )
    ).rows;

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await makeUser('o@x', 'event_organiser');
    coordinator = await makeUser('c@x', 'event_coordinator');
    staff = await makeUser('s@x', 'venue_staff');
    otherStaff = await makeUser('s2@x', 'venue_staff');
    await makeUser('t@x', 'technical_support_staff');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM174_AC1_every_venue_staff_notified_on_new_request', async () => {
    const event = await makeEvent();

    const created = await request(event, await makeVenue());

    expect(created.outcome).toBe('created');
    const recipients = (await submittedNotices(event)).map((n) => n.recipient_id).sort();
    expect(recipients).toEqual([staff, otherStaff].sort());
  });

  it('SCRUM174_AC6_notice_names_event_and_venue', async () => {
    const event = await makeEvent();
    const venue = await makeVenue();

    const { booking } = await request(event, venue);

    const [notice] = await submittedNotices(event);
    const names = await one(
      `select e.event_name, v.name as venue_name
         from event_requests e, venues v where e.id = $1 and v.id = $2`,
      [event, venue],
    );
    expect(notice.booking_id).toBe(booking.id);
    expect(notice.payload).toEqual({
      eventRequestId: event,
      eventName: names.event_name,
      venueId: venue,
      venueName: names.venue_name,
      startsAt: booking.starts_at,
      endsAt: booking.ends_at,
    });
  });

  it('SCRUM174_AC1_no_notice_when_request_not_created', async () => {
    // Another event's approved booking at the same venue and time is a conflict.
    const venue = await makeVenue();
    const holder = await makeEvent();
    const held = (await request(holder, venue)).booking.id;
    await db.query(`update bookings set status = 'approved' where id = $1`, [held]);
    const clashing = await makeEvent();
    const unsuitable = await makeEvent();

    expect((await request(clashing, venue)).outcome).toBe('conflict');
    expect((await request(unsuitable, await makeVenue(), false)).outcome).toBe(
      'suitability_confirmation_required',
    );

    expect(await submittedNotices(clashing)).toEqual([]);
    expect(await submittedNotices(unsuitable)).toEqual([]);
  });

  it('SCRUM174_AC1_submitted_notice_requires_booking', async () => {
    let error = null;
    try {
      await db.query(
        `insert into notifications (recipient_id, type, booking_id, payload)
         values ($1, 'booking_request_submitted', null, '{}'::jsonb)`,
        [staff],
      );
    } catch (err) {
      error = err;
    }

    expect(error?.code).toBe('23514');
  });
});
