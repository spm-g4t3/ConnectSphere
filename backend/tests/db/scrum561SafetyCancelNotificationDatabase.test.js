import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';

// cancel_event_request from the safety statuses, against the final schema.
describe('SCRUM-561: cancelling from Safety review tells the Safety Officers', () => {
  let db;
  let organiser;
  let coordinator;
  let safetyOfficers;
  let venueId;

  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
  const cancel = (id) =>
    db.query(
      "select cancel_event_request($1, $2, 'Venue issue', 'connectsphere_decision'::event_cancellation_initiator, null)",
      [id, coordinator],
    );
  const officerNotices = async (id) =>
    (await db.query(
      `select recipient_id, payload->>'audience' as audience
         from notifications
        where event_request_id = $1 and type = 'event_cancelled' and payload->>'audience' = 'safety_officer'
        order by recipient_id`,
      [id],
    )).rows;

  // The real lifecycle: an Approved event with a covering booking, submitted by its coordinator.
  async function eventInSafetyReview() {
    const id = await seedEvent(db, {
      status: 'approved',
      organiser_id: organiser,
      reviewing_coordinator_id: coordinator,
      event_name: 'Safety cancel',
      proposed_start: new Date(Date.now() + 10 * 86_400_000),
      proposed_end: new Date(Date.now() + 10.25 * 86_400_000),
    });
    await db.query(
      `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
       select $1, id, proposed_start, proposed_end, 'approved' from event_requests where id = $2`,
      [venueId, id],
    );
    await db.query('select submit_event_for_safety_review($1, $2, null, false)', [id, coordinator]);
    return id;
  }

  beforeAll(async () => {
    db = await createSchemaDb();

    const user = async (email, role) => {
      const id = (await one('insert into auth.users (email) values ($1) returning id', [email])).id;
      await db.query('insert into profiles (id, role, full_name) values ($1, $2, $3)', [id, role, email]);
      return id;
    };
    organiser = await user('o@x', 'event_organiser');
    coordinator = await user('c@x', 'event_coordinator');
    safetyOfficers = [await user('so1@x', 'safety_officer'), await user('so2@x', 'safety_officer')];
    await user('plain@x', 'venue_staff');
    venueId = (await one("insert into venues (name, location, max_capacity) values ('Hall', 'SMU', 200) returning id")).id;
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM561_AC2_cancelling_from_safety_review_notifies_the_same_officers_who_were_asked_to_review', async () => {
    const id = await eventInSafetyReview();
    const submitted = (await db.query(
      "select recipient_id from notifications where type = 'event_submitted_for_safety_review' and event_request_id = $1 order by recipient_id",
      [id],
    )).rows.map((row) => row.recipient_id);
    expect(submitted.sort()).toEqual([...safetyOfficers].sort());

    await cancel(id);

    const notices = await officerNotices(id);
    expect(notices.map((row) => row.recipient_id).sort()).toEqual(submitted);
  });

  it('SCRUM561_AC2_cancelling_from_safety_approved_does_not_notify_the_officers_again', async () => {
    const id = await eventInSafetyReview();
    await db.query(
      "insert into safety_review_responses (event_request_id, safety_officer_id, outcome) values ($1, $2, 'approved')",
      [id, safetyOfficers[0]],
    );
    await db.query(
      "select change_event_request_status($1, 'safety_review', 'safety_approved', $2, null, $2)",
      [id, coordinator],
    );

    await cancel(id);

    expect(await officerNotices(id)).toEqual([]);
  });
});
