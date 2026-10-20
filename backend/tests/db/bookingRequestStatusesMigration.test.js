/**
 * SCRUM-250: the booking request statuses, run against the final schema in an
 * in-process Postgres (PGlite), so it needs no server or credentials and runs
 * in CI.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BOOKING_STATUS } from '../../src/domain/bookingStatus.js';
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';

const refusal = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
};

describe('SCRUM-250: booking request statuses in Postgres', () => {
  let db;
  let venueId;
  let eventId;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  const enumValues = async () =>
    (
      await db.query(
        `select e.enumlabel from pg_enum e
           join pg_type t on t.oid = e.enumtypid
          where t.typname = 'booking_status'
          order by e.enumsortorder`,
      )
    ).rows.map((row) => row.enumlabel);

  async function insertBooking(status, hours = 0) {
    const row = await one(
      `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
       values ($1, $2, now() + ($3 || ' hours')::interval, now() + ($3 || ' hours')::interval + interval '1 hour', $4)
       returning id, status`,
      [venueId, eventId, String(hours), status],
    );
    return row;
  }

  beforeAll(async () => {
    db = await createSchemaDb();
    const organiser = await one(`insert into auth.users (email) values ('o@example.com') returning id`);
    venueId = (
      await one(
        `insert into venues (name, location, max_capacity) values ('Hall', 'Block A', 100) returning id`,
      )
    ).id;
    eventId = await seedEvent(db, { organiser_id: organiser.id, event_name: 'Gala' });
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  it('SCRUM250_keeps_the_existing_statuses_and_appends_the_request_statuses_in_order', async () => {
    // The request statuses follow the original three; conflicting (SCRUM-492's
    // decisions) and released come after them.
    expect(await enumValues()).toEqual([
      'approved',
      'flagged_for_review',
      'cancelled',
      'pending',
      'rejected',
      'withdrawn',
      'conflicting',
      'released',
    ]);
  });

  it('SCRUM250_the_database_enum_matches_the_JS_vocabulary', async () => {
    expect(await enumValues()).toEqual(Object.values(BOOKING_STATUS));
  });

  it.each(['pending', 'rejected', 'withdrawn'])('SCRUM250_stores_a_%s_booking', async (status) => {
    const row = await insertBooking(status, 10);
    expect(row.status).toBe(status);
  });

  it('SCRUM250_still_refuses_a_status_that_is_not_in_the_vocabulary', async () => {
    const err = await refusal(insertBooking('declined', 20));
    expect(err?.code).toBe('22P02');
  });
});
