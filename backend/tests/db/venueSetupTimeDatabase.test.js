/**
 * SCRUM-484 AC1 and AC9: a venue's setup time, run against a real Postgres.
 *
 * AC1: 023_venue_setup_time.sql adds venues.setup_minutes. A venue that
 * existed before 023 must read setup 0 ("none") once the column is added, and
 * re-running 023 must neither fail nor reset a value or change the CHECK.
 * The text of 023 is pinned in venueSetupTimeMigration.test.js; these apply it.
 *
 * AC9: a setup-only change made through update_venue writes exactly one
 * venue_change_history row (003's record_venue_change trigger) holding just
 * setup_minutes. setupChangeRecheckDatabase.test.js covers a combined setup
 * and turnaround change; this covers setup on its own.
 *
 * PGlite setup copied from setupChangeRecheckDatabase.test.js. Each describe
 * has its own database: AC1 stops at 017 before applying 023 itself, AC9
 * applies the full chain through 034.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name) => readFileSync(resolve(here, '../../db/migrations', name), 'utf8');

const AUTH_STAND_IN = `
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create role anon;
  create role authenticated;
`;

/** The venue chain as it stood before 023: catalogue, audit, turnaround. */
const VENUE_MIGRATIONS_TO_017 = [
  '001_event_requests.sql',
  '007_user_roles.sql',
  '002_venues.sql',
  '003_venue_audit.sql',
  '004_venue_functions.sql',
  '005_venue_retirement.sql',
  '008_venue_audit_completion.sql',
  '017_venue_turnaround.sql',
];

/** The list setupChangeRecheckDatabase.test.js applies, through 034. */
const MIGRATIONS_TO_034 = [
  '001_event_requests.sql',
  '005_event_request_details.sql',
  '007_user_roles.sql',
  '010_event_request_clarifications.sql',
  'STAND_IN',
  '014_coordinator_assignment.sql',
  '002_venues.sql',
  '003_venue_audit.sql',
  '004_venue_functions.sql',
  '005_venue_retirement.sql',
  '008_venue_audit_completion.sql',
  '009_bookings.sql',
  '011_venue_blocks.sql',
  '012_venue_block_creation.sql',
  '013_venue_block_booking_conflicts.sql',
  '014_booking_review_notifications.sql',
  '015_venue_block_amend_remove.sql',
  '017_venue_turnaround.sql',
  '023_venue_setup_time.sql',
  '027_booking_request_statuses.sql',
  '028_booking_status_default_pending.sql',
  '030_create_booking_request.sql',
  '031_withdraw_booking_request.sql',
  '032_venue_occupancy.sql',
  '033_venue_occupancy_callers.sql',
  '034_setup_change_recheck.sql',
];

/** What 014 reads from SCRUM-19's migration, which is not on this branch. */
const DECISION_STAND_IN = `
  alter table event_requests
    add column if not exists reviewing_coordinator_id uuid references auth.users (id);
`;

const ms = (value) => new Date(value).getTime();

async function openDatabase(migrations) {
  const db = new PGlite({ extensions: { btree_gist } });
  await db.exec(AUTH_STAND_IN);
  for (const name of migrations) {
    await db.exec(name === 'STAND_IN' ? DECISION_STAND_IN : migration(name));
  }
  return db;
}


describe('SCRUM-484 AC1: existing venues get setup 0 when 023 adds the column', () => {
  let db;
  let oldHall;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const venue = (id) => one('select setup_minutes, turnaround_minutes from venues where id = $1', [id]);
  const setupCheck = () =>
    one(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conname = 'venues_setup_minutes_allowed' and conrelid = 'venues'::regclass`,
    );

  beforeAll(async () => {
    db = await openDatabase(VENUE_MIGRATIONS_TO_017);
    // Inserted the way a venue existed before 023: no setup_minutes column.
    const hasSetup = await one(
      `select count(*)::int as n from information_schema.columns
        where table_name = 'venues' and column_name = 'setup_minutes'`,
    );
    expect(hasSetup.n).toBe(0);
    oldHall = (
      await one(
        `insert into venues (name, location, max_capacity, turnaround_minutes)
         values ('Old Hall', 'Block B', 120, 30) returning id`,
      )
    ).id;
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM484_AC1_existing_venue_gets_setup_none_when_the_column_is_added', async () => {
    await db.exec(migration('023_venue_setup_time.sql'));

    expect(await venue(oldHall)).toEqual({ setup_minutes: 0, turnaround_minutes: 30 });
  });

  it('SCRUM484_AC1_setup_migration_is_rerunnable_without_resetting_values', async () => {
    const checkBefore = await setupCheck();
    expect(checkBefore.def).toMatch(/setup_minutes/);

    await expect(db.exec(migration('023_venue_setup_time.sql'))).resolves.toBeDefined();

    expect(await venue(oldHall)).toEqual({ setup_minutes: 0, turnaround_minutes: 30 });
    expect(await setupCheck()).toEqual(checkBefore);
  });
});


describe('SCRUM-484 AC9: a setup change made through update_venue is audited', () => {
  let db;
  let staff;
  let counter = 0;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const rows = async (sql, params) => (await db.query(sql, params)).rows;
  const history = (venueId) =>
    rows('select * from venue_change_history where venue_id = $1 order by changed_at, id', [venueId]);

  async function makeUser(role) {
    counter += 1;
    const id = (await one('insert into auth.users (email) values ($1) returning id', [`u${counter}@x`])).id;
    if (role) await db.query('insert into profiles (id, role) values ($1, $2)', [id, role]);
    return id;
  }

  beforeAll(async () => {
    db = await openDatabase(MIGRATIONS_TO_034);
    staff = await makeUser('venue_staff');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM484_AC9_setup_change_writes_one_history_row', async () => {
    const V = (
      await one(
        `insert into venues (name, location, max_capacity)
         values ('Harbour Room', 'Block A', 200) returning id`,
      )
    ).id;
    expect((await one('select setup_minutes from venues where id = $1', [V])).setup_minutes).toBe(0);
    const before = await history(V);
    const startedAt = Date.now();

    await db.query('select update_venue(p_id => $1, p_setup_minutes => 30, p_user_id => $2)', [V, staff]);

    const finishedAt = Date.now();
    const after = await history(V);
    expect(after).toHaveLength(before.length + 1);
    const [row] = after.slice(before.length);
    expect(row.changed_by).toBe(staff);
    expect(row.old_values).toEqual({ setup_minutes: 0 });
    expect(row.new_values).toEqual({ setup_minutes: 30 });
    expect(ms(row.changed_at)).toBeGreaterThanOrEqual(startedAt - 1000);
    expect(ms(row.changed_at)).toBeLessThanOrEqual(finishedAt + 1000);
  });
});
