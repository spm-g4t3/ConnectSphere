/**
 * SCRUM-495: migration 068 counts places and finds the caller's own
 * registration in the database, so no row limit can cut a count short.
 *
 * Runs the real migration on an in-process Postgres (PGlite) against a stand-in
 * `registrations` table, since SCRUM-22's own migration is not on dev yet.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { ACTIVE_REGISTRATION_STATUS } from '../../src/domain/registrationAvailability.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(here, '../../db/migrations/068_open_event_registration_state.sql');

const EVENT_A = '00000000-0000-4000-8000-00000000000a';
const EVENT_B = '00000000-0000-4000-8000-00000000000b';
const EVENT_C = '00000000-0000-4000-8000-00000000000c';
const ME = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';

let db;

const state = async (ids, attendee) => {
  const { rows } = await db.query(
    'select event_request_id, active_count::int as active_count, is_registered from open_event_registration_state($1::uuid[], $2::uuid) order by event_request_id',
    [ids, attendee],
  );
  return rows;
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create table registrations (
      id uuid primary key default gen_random_uuid(),
      event_request_id uuid not null,
      attendee_id uuid not null,
      status text not null
    );
  `);
  await db.exec(readFileSync(MIGRATION, 'utf8'));

  // 1,200 places taken on A: more than the 1,000 rows an API read returns.
  await db.query(
    `insert into registrations (event_request_id, attendee_id, status)
     select $1::uuid, gen_random_uuid(), 'registered' from generate_series(1, 1200)`,
    [EVENT_A],
  );
  await db.query(
    `insert into registrations (event_request_id, attendee_id, status) values
       ($1, $3, 'registered'), ($1, $4, 'withdrawn'), ($2, $4, 'withdrawn')`,
    [EVENT_B, EVENT_C, ME, OTHER],
  );
  await db.query(`insert into registrations (event_request_id, attendee_id, status) values ($1, $2, 'registered')`, [
    EVENT_A,
    ME,
  ]);
});

afterAll(async () => {
  await db.close();
});

describe('SCRUM495 open_event_registration_state', () => {
  it('SCRUM495_counts_every_registration_however_many_there_are', async () => {
    const [a] = await state([EVENT_A], OTHER);

    expect(a).toMatchObject({ event_request_id: EVENT_A, active_count: 1201, is_registered: false });
  });

  it('SCRUM495_finds_the_callers_own_registration_among_more_than_1000', async () => {
    const [a] = await state([EVENT_A], ME);

    expect(a.is_registered).toBe(true);
  });

  it('SCRUM495_counts_only_registered_and_ignores_withdrawn', async () => {
    const rows = await state([EVENT_B, EVENT_C], OTHER);

    expect(rows).toEqual([{ event_request_id: EVENT_B, active_count: 1, is_registered: false }]);
  });

  it('SCRUM495_returns_one_row_per_event_and_none_for_events_not_asked_about', async () => {
    const rows = await state([EVENT_A, EVENT_B], ME);

    expect(rows.map((row) => row.event_request_id)).toEqual([EVENT_A, EVENT_B]);
    expect(rows.find((row) => row.event_request_id === EVENT_B).is_registered).toBe(true);
  });

  it('SCRUM495_returns_nothing_for_an_empty_or_null_list', async () => {
    expect(await state([], ME)).toEqual([]);
    expect(await state(null, ME)).toEqual([]);
  });

  it('SCRUM495_refuses_a_null_caller', async () => {
    await expect(state([EVENT_A], null)).rejects.toThrow(/attendee is required/);
  });

  it('SCRUM495_uses_the_status_the_application_treats_as_holding_a_place', () => {
    const sql = readFileSync(MIGRATION, 'utf8').replace(/--[^\n]*/g, '');

    expect(sql).toContain(`r.status = '${ACTIVE_REGISTRATION_STATUS}'`);
  });
});
