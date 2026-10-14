/**
 * SCRUM-251: bookings.status defaults to pending, run against a real Postgres.
 *
 * Applies the real migrations to an in-process Postgres (PGlite): 001 and 002
 * are the tables 009 references, 009 and 011 create bookings and the
 * booking_status enum, 013 adds the approved-only overlap helper, 027 adds the
 * request statuses and 028 is the migration under test.
 *
 * The inserts here are plain SQL that name no status, so no application code
 * can supply one. That is deliberate: a default set in the service layer
 * would otherwise hide a database default that is still 'approved'. (Nothing
 * in backend/src inserts a booking today; this is the path any future writer's
 * omitted status takes.)
 *
 * One approved booking is inserted BEFORE 028 runs, to prove existing rows
 * keep their status.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { BOOKING_STATUS } from '../../src/domain/bookingStatus.js';

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name) => readFileSync(resolve(here, '../../db/migrations', name), 'utf8');

const BEFORE_028 = [
  '001_event_requests.sql',
  '002_venues.sql',
  '009_bookings.sql',
  '011_venue_blocks.sql',
  '013_venue_block_booking_conflicts.sql',
  '027_booking_request_statuses.sql',
];
const MIGRATION_028 = '028_booking_status_default_pending.sql';

describe('SCRUM-251: the booking status default in Postgres', () => {
  let db;
  let venueId;
  let eventId;
  let existingBookingId;
  let hour = 0;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

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
      : one(
          `insert into bookings (venue_id, event_request_id, starts_at, ends_at, status)
           values ($1, $2, ${start}, ${end}, $4) returning id, status`,
          [...times, status],
        );
  }

  beforeAll(async () => {
    db = new PGlite({ extensions: { btree_gist } });
    await db.exec(`
      create schema auth;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text);
    `);
    for (const name of BEFORE_028) await db.exec(migration(name));

    const organiser = await one(`insert into auth.users (email) values ('o@example.com') returning id`);
    venueId = (
      await one(
        `insert into venues (name, location, max_capacity) values ('Hall', 'Block A', 100) returning id`,
      )
    ).id;
    eventId = (
      await one(`insert into event_requests (organiser_id, event_name) values ($1, 'Gala') returning id`, [
        organiser.id,
      ])
    ).id;

    // Before 028 the default is still 'approved'; this row is what 028 must not touch.
    const before = await insertBooking();
    expect(before.status).toBe('approved');
    existingBookingId = before.id;

    await db.exec(migration(MIGRATION_028));
    // 067 appends conflicting, so every status in the JS vocabulary exists.
    await db.exec(migration('067_conflicting_booking_status.sql'));
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

  it('SCRUM251_leaves_a_booking_that_already_existed_approved', async () => {
    const row = await one('select status from bookings where id = $1', [existingBookingId]);
    expect(row.status).toBe('approved');
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

  it('SCRUM251_can_be_run_again_without_error_or_change', async () => {
    await db.exec(migration(MIGRATION_028));
    expect((await insertBooking()).status).toBe('pending');
    expect((await one('select status from bookings where id = $1', [existingBookingId])).status).toBe(
      'approved',
    );
  });
});
