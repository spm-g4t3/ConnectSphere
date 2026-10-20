/**
 * SCRUM-251: bookings.status defaults to pending, run against the final schema
 * in a real Postgres (PGlite).
 *
 * The inserts here are plain SQL that name no status, so no application code
 * can supply one. That is deliberate: a default set in the service layer
 * would otherwise hide a database default that is still 'approved'.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BOOKING_STATUS } from '../../src/domain/bookingStatus.js';
import { createSchemaDb, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor } from './helpers/queries.js';

describe('SCRUM-251: the booking status default in Postgres', () => {
  let db;
  let venueId;
  let eventId;
  let organiserId;
  let hour = 0;

  const { one } = queriesFor(() => db);

  /** A booking over its own one-hour slot, so none overlap; status only if given. */
  async function insertBooking(status) {
    hour += 2;
    const times = [venueId, eventId, String(hour)];
    const start = `now() + ($3 || ' hours')::interval`;
    const end = `now() + ($3 || ' hours')::interval + interval '1 hour'`;
    return status === undefined
      ? one(
          `insert into bookings (venue_id, event_request_id, starts_at, ends_at)
           values ($1, $2, ${start}, ${end}) returning id, status`,
          times,
        )
      : status === BOOKING_STATUS.RELEASED
        // A released booking records who released it, when and why.
        ? one(
            `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status,
                                   released_by, released_at, release_reason)
             values ($1, $2, ${start}, ${end}, $4, $5, now(), 'Fixture release') returning id, status`,
            [...times, status, organiserId],
          )
        : one(
            `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
             values ($1, $2, ${start}, ${end}, $4) returning id, status`,
            [...times, status],
          );
  }

  beforeAll(async () => {
    db = await createSchemaDb();
    organiserId = await seedUser(db, { email: 'o@example.com' });
    venueId = await seedVenue(db, { name: 'Hall', capacity: 100, setup: 0, turnaround: 0 });
    eventId = await seedEvent(db, { organiser_id: organiserId, event_name: 'Gala' });
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  it('SCRUM251_a_booking_inserted_without_a_status_is_pending', async () => {
    const row = await insertBooking();
    expect(row.status).toBe('pending');
  });

  it('SCRUM251_the_column_default_is_pending', async () => {
    const row = await one(
      `select column_default, is_nullable from information_schema.columns
        where table_name = 'bookings' and column_name = 'status'`,
    );
    expect(row.column_default).toMatch(/^'pending'::booking_status$/);
    expect(row.is_nullable).toBe('NO');
  });

  it.each(Object.values(BOOKING_STATUS))(
    'SCRUM251_keeps_an_explicit_%s_status',
    async (status) => {
      const row = await insertBooking(status);
      expect(row.status).toBe(status);
    },
  );

  it('SCRUM251_an_explicit_null_status_is_still_refused', async () => {
    hour += 2;
    await expect(
      db.query(
        `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
         values ($1, $2, now() + ($3 || ' hours')::interval, now() + ($3 || ' hours')::interval + interval '1 hour', null)`,
        [venueId, eventId, String(hour)],
      ),
    ).rejects.toMatchObject({ code: '23502' });
  });
});
