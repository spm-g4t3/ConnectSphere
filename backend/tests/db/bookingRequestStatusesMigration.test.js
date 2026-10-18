/**
 * SCRUM-250: the booking request statuses, run against a real Postgres.
 *
 * Applies the real migrations to an in-process Postgres (PGlite), so it needs
 * no server or credentials and runs in CI. 001 and 002 are the tables 009
 * references, 009 and 011 create bookings and the booking_status enum, 013 adds
 * the overlap helper that only looks at approved bookings, and
 * 027 is the migration under test. The auth schema is a stand-in for
 * Supabase's.
 *
 * One approved booking is inserted BEFORE 027 runs, to prove existing data
 * survives it untouched.
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

const BEFORE_027 = [
  '001_event_requests.sql',
  '002_venues.sql',
  '009_bookings.sql',
  '011_venue_blocks.sql',
  '013_venue_block_booking_conflicts.sql',
];
const MIGRATION_027 = '027_booking_request_statuses.sql';

const refusal = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
};

/**
 * The JS vocabulary as 027 leaves the enum: 065 appends conflicting later, and
 * 088 (SCRUM-492) released.
 */
const STATUSES_THROUGH_027 = Object.values(BOOKING_STATUS).filter(
  (status) => status !== BOOKING_STATUS.CONFLICTING && status !== BOOKING_STATUS.RELEASED,
);

describe('SCRUM-250: booking request statuses in Postgres', () => {
  let db;
  let venueId;
  let eventId;
  let existingBookingId;

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
    db = new PGlite({ extensions: { btree_gist } });
    await db.exec(`
      create schema auth;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text);
    `);
    for (const name of BEFORE_027) await db.exec(migration(name));

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
    existingBookingId = (await insertBooking('approved')).id;

    await db.exec(migration(MIGRATION_027));
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  it('SCRUM250_keeps_the_existing_statuses_and_appends_the_request_statuses_in_order', async () => {
    expect(await enumValues()).toEqual([
      'approved',
      'flagged_for_review',
      'cancelled',
      'pending',
      'rejected',
      'withdrawn',
    ]);
  });

  it('SCRUM250_the_database_enum_matches_the_JS_vocabulary', async () => {
    expect(await enumValues()).toEqual(STATUSES_THROUGH_027);
  });

  it('SCRUM250_leaves_an_existing_booking_untouched', async () => {
    const row = await one('select status, venue_id from bookings where id = $1', [
      existingBookingId,
    ]);
    expect(row).toEqual({ status: 'approved', venue_id: venueId });
  });

  it('SCRUM250_leaves_the_default_at_approved_for_SCRUM_251', async () => {
    const row = await one(
      `insert into bookings (venue_id, event_request_id, starts_at, ends_at)
       values ($1, $2, now() + interval '100 hours', now() + interval '101 hours')
       returning status`,
      [venueId, eventId],
    );
    expect(row.status).toBe('approved');
  });

  it.each(['pending', 'rejected', 'withdrawn'])('SCRUM250_stores_a_%s_booking', async (status) => {
    const row = await insertBooking(status, 10);
    expect(row.status).toBe(status);
  });

  it('SCRUM250_still_refuses_a_status_that_is_not_in_the_vocabulary', async () => {
    const err = await refusal(insertBooking('declined', 20));
    expect(err?.code).toBe('22P02');
  });

  it('SCRUM250_only_approved_bookings_conflict_with_a_period', async () => {
    const conflicts = await db.query(
      `select booking_id from venue_block_booking_conflicts($1, now() - interval '1 day', now() + interval '30 days')`,
      [venueId],
    );
    const statuses = (
      await db.query('select status from bookings where id = any ($1)', [
        conflicts.rows.map((r) => r.booking_id),
      ])
    ).rows.map((r) => r.status);
    expect(statuses.length).toBeGreaterThan(0);
    expect(new Set(statuses)).toEqual(new Set(['approved']));
  });

  it('SCRUM250_can_be_run_again_without_error_or_change', async () => {
    await db.exec(migration(MIGRATION_027));
    expect(await enumValues()).toEqual(STATUSES_THROUGH_027);
  });
});
