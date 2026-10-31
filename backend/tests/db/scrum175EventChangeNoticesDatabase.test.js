import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor } from './helpers/queries.js';
import { decideBooking } from './helpers/bookingFlow.js';
import { flagForReason } from './helpers/flaggedBookings.js';
import { at } from '../fixtures/time.js';

// The notices 042's functions send when an event is confirmed, moved to
// another venue or cancelled, against the final schema.
describe('SCRUM-175: confirmation, venue change and cancellation notices', () => {
  let db;
  let organiser;
  let coordinator;
  let staff;
  let safetyOfficer;
  let attendees;
  let counter = 0;

  const { one, rows } = queriesFor(() => db);

  const makeVenue = () => seedVenue(db, { name: `Hall ${++counter}`, setup: 0, turnaround: 0 });

  function makeEvent(status = 'approved') {
    counter += 1;
    return seedEvent(db, {
      status,
      organiser_id: organiser,
      reviewing_coordinator_id: coordinator,
      event_name: `Event ${counter}`,
      proposed_start: at('14:00'),
      proposed_end: at('16:00'),
      expected_attendance: 150,
      equipment_requirements: null,
    });
  }

  /** One registration per attendee, in the order given; the rest have none. */
  async function register(eventId, statuses) {
    for (const [index, status] of statuses.entries()) {
      await db.query(
        'insert into event_registrations (event_request_id, attendee_id, status) values ($1, $2, $3)',
        [eventId, attendees[index], status],
      );
    }
  }

  /** An approved event with approved bookings, taken through safety review to Safety approved. */
  async function safetyApproved(venueIds) {
    const id = await makeEvent();
    for (const venueId of venueIds) await seedBooking(db, { venueId, eventId: id, status: 'approved' });
    await db.query('select submit_event_for_safety_review($1, $2, null, true)', [id, coordinator]);
    await db.query("select respond_to_safety_review($1, $2, 'approved', null, '{}', false)", [id, safetyOfficer]);
    return id;
  }

  // Stands in for an earlier confirmation that a significant change undid.
  const confirmedBefore = (eventId) => db.query(
    `insert into event_request_status_history (event_request_id, previous_status, new_status, changed_by, reason)
     values ($1, 'safety_approved', 'confirmed', $2, 'Event confirmed.')`,
    [eventId, coordinator],
  );

  async function confirm(eventId) {
    const { revision } = await one('select updated_at::text as revision from event_requests where id = $1', [eventId]);
    await db.query('select confirm_event_request($1, $2, false, $3::timestamptz)', [eventId, coordinator, revision]);
  }

  const notices = (eventId, type, audience) => rows(
    `select recipient_id, payload from notifications
      where event_request_id = $1 and type = $2 and payload->>'audience' = $3
      order by recipient_id`,
    [eventId, type, audience],
  );
  const recipients = async (eventId, type, audience) =>
    (await notices(eventId, type, audience)).map((n) => n.recipient_id);
  const sorted = (ids) => [...ids].sort();

  /** A confirmed event's approved booking at a fresh venue, flagged as a venue setup change flags one. */
  async function flaggedBooking(eventId) {
    const venueId = await makeVenue();
    const { result } = await one(
      `select create_booking_request($1, $2, $3, null, null, '{"suitable": true}'::jsonb, false, 100, null) as result`,
      [eventId, venueId, coordinator],
    );
    await decideBooking(db, result.booking.id, { caller: staff, decision: 'approve' });
    await flagForReason(db, result.booking.id, { reason: 'setup_or_turnaround_changed', flaggedBy: staff });
    return { bookingId: result.booking.id, venueId };
  }

  async function approveReplacement(eventId, venueId, replacesId) {
    const { result } = await one(
      `select create_booking_request($1, $2, $3, null, null, '{"suitable": true}'::jsonb, false, 100, $4) as result`,
      [eventId, venueId, coordinator, replacesId],
    );
    return decideBooking(db, result.booking.id, { caller: staff, decision: 'approve' });
  }

  const cancel = (eventId, message) => db.query(
    `select cancel_event_request($1, $2, 'Sponsor pulled out', 'connectsphere_decision'::event_cancellation_initiator, $3)`,
    [eventId, coordinator, message],
  );

  const nameOf = async (venueId) => (await one('select name from venues where id = $1', [venueId])).name;
  const eventName = async (eventId) => (await one('select event_name from event_requests where id = $1', [eventId])).event_name;

  beforeAll(async () => {
    db = await createSchemaDb();
    const user = (email, role) => seedUser(db, { email, role });
    organiser = await user('o@x', 'event_organiser');
    coordinator = await user('c@x', 'event_coordinator');
    staff = await user('s@x', 'venue_staff');
    safetyOfficer = await user('so@x', 'safety_officer');
    attendees = [];
    for (let i = 0; i < 4; i += 1) attendees.push(await user(`a${i}@x`, 'attendee'));
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('AC1: confirming tells the Organiser', () => {
    it('SCRUM175_AC1_the_organiser_is_told_the_event_is_confirmed_with_its_venues', async () => {
      const [hallA, hallB] = [await makeVenue(), await makeVenue()];
      const id = await safetyApproved([hallA, hallB]);

      await confirm(id);

      const sent = await notices(id, 'event_confirmed', 'organiser');
      expect(sent).toHaveLength(1);
      expect(sent[0].recipient_id).toBe(organiser);
      const { payload } = sent[0];
      expect(payload).toMatchObject({
        audience: 'organiser',
        eventRequestId: id,
        eventName: await eventName(id),
        reconfirmed: false,
      });
      expect(new Date(payload.startsAt)).toEqual(new Date(at('14:00')));
      expect(new Date(payload.endsAt)).toEqual(new Date(at('16:00')));
      expect(payload.confirmedAt).toEqual(expect.any(String));
      expect(payload.venues.map((v) => v.venueName).sort()).toEqual([await nameOf(hallA), await nameOf(hallB)].sort());
      expect(new Date(payload.venues[0].startsAt)).toEqual(new Date(at('14:00')));
    });

    it('SCRUM175_AC1_a_cancelled_booking_is_not_listed_as_a_venue', async () => {
      const [kept, dropped] = [await makeVenue(), await makeVenue()];
      const id = await safetyApproved([kept]);
      await seedBooking(db, { venueId: dropped, eventId: id, status: 'cancelled' });

      await confirm(id);

      const [{ payload }] = await notices(id, 'event_confirmed', 'organiser');
      expect(payload.venues.map((v) => v.venueName)).toEqual([await nameOf(kept)]);
    });
  });

  describe('AC2: a re-confirmation tells registered attendees', () => {
    it('SCRUM175_AC2_registered_attendees_are_told_of_a_reconfirmation', async () => {
      const hall = await makeVenue();
      const id = await safetyApproved([hall]);
      await confirmedBefore(id);
      await register(id, ['registered', 'registered', 'withdrawn', 'cancelled']);

      await confirm(id);

      const sent = await notices(id, 'event_confirmed', 'attendee');
      expect(sent.map((n) => n.recipient_id)).toEqual(sorted([attendees[0], attendees[1]]));
      expect(sent[0].payload).toEqual({
        audience: 'attendee',
        eventRequestId: id,
        eventName: await eventName(id),
        startsAt: expect.any(String),
        endsAt: expect.any(String),
        confirmedAt: expect.any(String),
        reconfirmed: true,
        venueNames: [await nameOf(hall)],
      });
      expect((await notices(id, 'event_confirmed', 'organiser'))[0].payload.reconfirmed).toBe(true);
    });

    it('SCRUM175_AC2_a_first_confirmation_tells_attendees_nothing', async () => {
      const id = await safetyApproved([await makeVenue()]);
      await register(id, ['registered']);

      await confirm(id);

      expect(await recipients(id, 'event_confirmed', 'attendee')).toEqual([]);
      expect(await recipients(id, 'event_confirmed', 'organiser')).toEqual([organiser]);
    });
  });

  describe('AC3: a replacement at another venue tells registered attendees', () => {
    it('SCRUM175_AC3_registered_attendees_are_told_the_new_and_previous_venue', async () => {
      const id = await makeEvent('confirmed');
      const flagged = await flaggedBooking(id);
      await register(id, ['registered', 'waitlisted', 'withdrawn']);
      const newVenue = await makeVenue();

      await approveReplacement(id, newVenue, flagged.bookingId);

      const sent = await notices(id, 'event_venue_changed', 'attendee');
      expect(sent).toEqual([{
        recipient_id: attendees[0],
        payload: {
          audience: 'attendee',
          eventRequestId: id,
          eventName: await eventName(id),
          previousVenueName: await nameOf(flagged.venueId),
          venueName: await nameOf(newVenue),
        },
      }]);
    });

    it('SCRUM175_AC3_cancelling_a_flagged_booking_tells_attendees_nothing', async () => {
      const id = await makeEvent('confirmed');
      const flagged = await flaggedBooking(id);
      await register(id, ['registered']);

      await db.query('select cancel_flagged_booking($1, $2, $3)', [flagged.bookingId, coordinator, 'Venue no longer fits']);

      expect(await recipients(id, 'event_venue_changed', 'attendee')).toEqual([]);
    });

    // create_booking_request refuses a request at a venue the event has a
    // flagged booking at, so this resolution is written directly.
    it('SCRUM175_AC3_a_replacement_at_the_same_venue_tells_attendees_nothing', async () => {
      const id = await makeEvent('confirmed');
      const venueId = await makeVenue();
      const old = await seedBooking(db, { venueId, eventId: id, status: 'cancelled' });
      const replacement = await seedBooking(db, { venueId, eventId: id, status: 'approved', start: at('15:00'), end: at('17:00') });
      await register(id, ['registered']);
      const { id: resolution } = await one(
        `insert into booking_resolutions (booking_id, outcome, reason, resolved_by, replacement_booking_id)
         values ($1, 'replaced', 'Replaced by an approved booking', $2, $3) returning id`,
        [old, staff, replacement],
      );

      await db.query("select notify_flagged_booking_resolved($1, 'venue_staff')", [resolution]);

      expect(await recipients(id, 'event_venue_changed', 'attendee')).toEqual([]);
      expect(await rows(
        "select 1 from notifications where booking_id = $1 and type = 'flagged_booking_resolved'", [old],
      )).toHaveLength(2);
    });
  });

  describe('AC6: cancelling tells registered and waitlisted attendees', () => {
    it('SCRUM175_AC6_registered_and_waitlisted_attendees_get_the_attendee_message', async () => {
      const id = await makeEvent('confirmed');
      await register(id, ['registered', 'waitlisted', 'withdrawn', 'cancelled']);

      await cancel(id, '  We will run it next term.  ');

      const sent = await notices(id, 'event_cancelled', 'attendee');
      expect(sent.map((n) => n.recipient_id)).toEqual(sorted([attendees[0], attendees[1]]));
      const { cancelled_at: cancelledAt } = await one('select cancelled_at from event_requests where id = $1', [id]);
      for (const { payload } of sent) {
        expect(payload).toEqual({
          audience: 'attendee',
          eventRequestId: id,
          eventName: await eventName(id),
          message: 'We will run it next term.',
          cancelledAt: expect.any(String),
        });
        expect(new Date(payload.cancelledAt)).toEqual(cancelledAt);
      }
    });

    it('SCRUM175_AC6_a_blank_attendee_message_is_sent_as_null', async () => {
      const id = await makeEvent('confirmed');
      await register(id, ['registered']);

      await cancel(id, '   ');

      const [{ payload }] = await notices(id, 'event_cancelled', 'attendee');
      expect(payload.message).toBeNull();
    });
  });

  describe('AC7: attendees never see the internal reason', () => {
    it('SCRUM175_AC7_attendee_cancellation_payloads_carry_no_reason', async () => {
      const id = await makeEvent('confirmed');
      await register(id, ['registered', 'waitlisted']);

      await cancel(id, null);

      const sent = await notices(id, 'event_cancelled', 'attendee');
      expect(sent).toHaveLength(2);
      for (const { payload } of sent) {
        expect(payload).not.toHaveProperty('reason');
        expect(JSON.stringify(payload)).not.toContain('Sponsor pulled out');
      }
      // The organiser's notice still carries it.
      expect((await notices(id, 'event_cancelled', 'organiser'))[0].payload.reason).toBe('Sponsor pulled out');
    });

    it('SCRUM175_AC7_a_date_change_tells_attendees_without_the_reason', async () => {
      const id = await makeEvent('confirmed');
      await register(id, ['registered']);
      // A significant change re-checks the submission fields; makeEvent leaves purpose out.
      await db.query("update event_requests set purpose = 'Talk' where id = $1", [id]);

      await db.query(
        `select apply_significant_event_change($1, jsonb_build_object('proposedStart', $2::text, 'proposedEnd', $3::text),
                'Speaker moved', $4)`,
        [id, at('15:00'), at('17:00'), coordinator],
      );

      const [attendee] = await rows(
        "select recipient_id, payload from notifications where event_request_id = $1 and type = 'event_significant_change_attendee'",
        [id],
      );
      expect(attendee.recipient_id).toBe(attendees[0]);
      expect(attendee.payload).not.toHaveProperty('reason');
      expect(JSON.stringify(attendee.payload)).not.toContain('Speaker moved');
      // The organiser's notice still carries it.
      const organiserNotice = await one(
        "select recipient_id, payload from notifications where event_request_id = $1 and type = 'event_significant_change'",
        [id],
      );
      expect(organiserNotice.recipient_id).toBe(organiser);
      expect(organiserNotice.payload.reason).toBe('Speaker moved');
    });
  });
});
