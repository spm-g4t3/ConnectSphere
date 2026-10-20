/**
 * SCRUM-486 (SCRUM-518), AC10-07: venue holds still expire once the Lead's
 * assignment notices exist.
 *
 * process_venue_hold_expiry marks a lapsed hold expired and writes its
 * venue_hold_expired notice in one statement; if notifications_type_known did
 * not allow the type, the notice insert would fail and take the expiry with
 * it, so holds would silently stop expiring. This runs it on the final
 * schema, with an event that has its coordinator, as in production.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';

const fromNow = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();

describe('SCRUM-486 AC10-07: venue holds still expire', () => {
  let db;
  let organiser;
  let staff;
  let coordinator;
  let counter = 0;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  async function makeUser(role) {
    counter += 1;
    const id = (await one('insert into auth.users (email) values ($1) returning id', [`u${counter}@x`])).id;
    await db.query('insert into profiles (id, role) values ($1, $2)', [id, role]);
    return id;
  }

  /** An approved event with its coordinator, and a hold on a venue that lapsed five minutes ago. */
  async function lapsedHold() {
    counter += 1;
    const venueId = (await one(
      `insert into venues (name, location, max_capacity, setup_minutes, turnaround_minutes)
       values ($1, 'Block A', 200, 30, 45) returning id`,
      [`Harbour Room ${counter}`],
    )).id;
    const eventId = await seedEvent(db, {
      status: 'approved',
      organiser_id: organiser,
      assigned_coordinator_id: coordinator,
      event_name: `Event ${counter}`,
      proposed_start: fromNow(14_400),
      proposed_end: fromNow(14_520),
      expected_attendance: 150,
    });
    const holdId = (await one(
      `insert into venue_holds (event_request_id, venue_id, placed_by, placed_at, expires_at)
       values ($1, $2, $3, $4, $5) returning id`,
      [eventId, venueId, staff, fromNow(-120), fromNow(-5)],
    )).id;
    return holdId;
  }

  const holdStatus = async (holdId) => (await one('select status from venue_holds where id = $1', [holdId])).status;

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await makeUser('event_organiser');
    staff = await makeUser('venue_staff');
    coordinator = await makeUser('event_coordinator');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM486_AC10_a_lapsed_hold_still_expires_and_is_notified_after_052', async () => {
    // AC10-07: process_venue_hold_expiry marks the hold expired and writes its
    // venue_hold_expired notice.
    const holdId = await lapsedHold();

    await one('select process_venue_hold_expiry() as n');

    expect(await holdStatus(holdId)).toBe('expired');
    const notice = await one(
      "select recipient_id, type from notifications where venue_hold_id = $1", [holdId],
    );
    expect(notice).toEqual({ recipient_id: coordinator, type: 'venue_hold_expired' });
  });
});
