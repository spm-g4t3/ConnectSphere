/**
 * Booking decisions alongside the safety review, against the final schema:
 * the decision notices are known types, cancellation still withdraws a
 * conflicting request and tells Venue Staff and Safety Officers, and
 * event_readiness treats a conflicting booking as an unmet venue line.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';

describe('SCRUM-258: booking decisions alongside the safety review', () => {
  let db;
  let organiser;
  let coordinator;
  let venueStaff;
  let safetyOfficers;
  let hall;
  let annex;

  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
  const refusal = async (promise) => {
    try {
      await promise;
      return null;
    } catch (err) {
      return err;
    }
  };
  const bookingStatus = async (id) =>
    (await one('select status::text as status from bookings where id = $1', [id])).status;

  /** An Approved event held by the coordinator, starting in 10 days for 6 hours. */
  function approvedEvent(name = 'Booking decisions') {
    const start = Date.now() + 10 * 86_400_000;
    return seedEvent(db, {
      status: 'approved',
      organiser_id: organiser,
      assigned_coordinator_id: coordinator,
      event_name: name,
      proposed_start: new Date(start),
      proposed_end: new Date(start + 6 * 3_600_000),
    });
  }

  /** A booking covering the event's proposed start to end. */
  async function booking(eventId, venueId, status) {
    return (
      await one(
        `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
         select $1, id, proposed_start, proposed_end, $3::booking_status from event_requests where id = $2
         returning id`,
        [venueId, eventId, status],
      )
    ).id;
  }

  const cancel = (eventId) =>
    db.query(
      `select cancel_event_request($1, $2, 'Venue issue', 'connectsphere_decision'::event_cancellation_initiator, null)`,
      [eventId, coordinator],
    );

  const cancelNotices = async (eventId, audience) =>
    (
      await db.query(
        `select recipient_id from notifications
          where event_request_id = $1 and type = 'event_cancelled' and payload->>'audience' = $2
          order by recipient_id`,
        [eventId, audience],
      )
    ).rows.map((row) => row.recipient_id);

  const readiness = async (id) => (await one('select event_readiness($1, false) as r', [id])).r;

  beforeAll(async () => {
    db = await createSchemaDb();

    const user = async (email, role) => {
      const id = (await one('insert into auth.users (email) values ($1) returning id', [email])).id;
      await db.query('insert into profiles (id, role, full_name) values ($1, $2, $3)', [id, role, email]);
      return id;
    };
    organiser = await user('o@x', 'event_organiser');
    coordinator = await user('c@x', 'event_coordinator');
    venueStaff = await user('vs@x', 'venue_staff');
    safetyOfficers = [await user('so1@x', 'safety_officer'), await user('so2@x', 'safety_officer')].sort();
    hall = (await one("insert into venues (name, location, max_capacity) values ('Hall', 'SMU', 200) returning id")).id;
    annex = (await one("insert into venues (name, location, max_capacity) values ('Annex', 'SMU', 200) returning id")).id;
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('notifications_type_known', () => {
    it.each(['booking_request_approved', 'booking_request_rejected', 'booking_request_conflicting'])(
      'SCRUM258_AC6_a_%s_notification_is_accepted_after_071_and_075',
      async (type) => {
        const eventId = await approvedEvent();
        const bookingId = await booking(eventId, hall, 'pending');

        const err = await refusal(
          db.query('insert into notifications (recipient_id, type, booking_id, event_request_id) values ($1, $2, $3, $4)', [
            coordinator,
            type,
            bookingId,
            eventId,
          ]),
        );

        expect(err).toBeNull();
      },
    );

    it('SCRUM258_AC6_071s_types_are_still_accepted_after_075', async () => {
      const eventId = await approvedEvent();
      for (const type of ['safety_review_response', 'event_submitted_for_safety_review', 'event_cancelled']) {
        const err = await refusal(
          db.query('insert into notifications (recipient_id, type, event_request_id) values ($1, $2, $3)', [
            coordinator,
            type,
            eventId,
          ]),
        );
        expect(err, type).toBeNull();
      }
    });

    it('SCRUM258_AC6_an_unknown_type_is_still_refused', async () => {
      const err = await refusal(
        db.query("insert into notifications (recipient_id, type) values ($1, 'not_a_type')", [coordinator]),
      );

      expect(err?.code).toBe('23514');
    });
  });

  describe('cancel_event_request', () => {
    it('SCRUM258_AC3_cancelling_an_event_whose_only_open_request_is_conflicting_tells_venue_staff_and_withdraws_it', async () => {
      const eventId = await approvedEvent();
      const conflicting = await booking(eventId, hall, 'conflicting');

      await cancel(eventId);

      expect(await bookingStatus(conflicting)).toBe('withdrawn');
      expect(await cancelNotices(eventId, 'venue_staff')).toEqual([venueStaff]);
    });

    it('SCRUM258_AC3_cancelling_an_event_with_no_venue_requests_does_not_tell_venue_staff', async () => {
      const eventId = await approvedEvent();

      await cancel(eventId);

      expect(await cancelNotices(eventId, 'venue_staff')).toEqual([]);
    });

    it('SCRUM258_AC3_cancelling_from_safety_review_still_tells_the_safety_officers', async () => {
      const eventId = await approvedEvent();
      await booking(eventId, hall, 'approved');
      await db.query('select submit_event_for_safety_review($1, $2, null, false)', [eventId, coordinator]);
      expect((await one('select status::text as status from event_requests where id = $1', [eventId])).status).toBe(
        'safety_review',
      );

      await cancel(eventId);

      expect(await cancelNotices(eventId, 'safety_officer')).toEqual(safetyOfficers);
      expect(await cancelNotices(eventId, 'venue_staff')).toEqual([venueStaff]);
    });
  });

  describe('event_readiness', () => {
    it('SCRUM258_AC3_a_conflicting_booking_is_a_venue_line_that_is_never_met', async () => {
      const eventId = await approvedEvent();
      const bookingId = await booking(eventId, hall, 'conflicting');

      const r = await readiness(eventId);

      expect(r.ready).toBe(false);
      // Each venue line also carries its booking's period.
      const period = { startsAt: expect.any(String), endsAt: expect.any(String) };
      expect(r.items.filter((i) => i.key === 'venue')).toEqual([
        { key: 'venue', met: false, detail: 'Conflicting, awaiting a decision', bookingId, venueName: 'Hall', ...period },
      ]);
    });

    it('SCRUM258_AC3_a_conflicting_booking_keeps_the_event_not_ready_beside_an_approved_covering_one', async () => {
      const eventId = await approvedEvent();
      const approved = await booking(eventId, hall, 'approved');
      const conflicting = await booking(eventId, annex, 'conflicting');
      const period = { startsAt: expect.any(String), endsAt: expect.any(String) };

      const r = await readiness(eventId);

      expect(r.ready).toBe(false);
      const venueLines = r.items.filter((i) => i.key === 'venue');
      expect(venueLines).toHaveLength(2);
      expect(venueLines).toEqual(
        expect.arrayContaining([
          { key: 'venue', met: true, detail: 'Approved', bookingId: approved, venueName: 'Hall', ...period },
          {
            key: 'venue',
            met: false,
            detail: 'Conflicting, awaiting a decision',
            bookingId: conflicting,
            venueName: 'Annex',
            ...period,
          },
        ]),
      );
    });
  });
});
