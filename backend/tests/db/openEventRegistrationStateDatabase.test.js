/** Runs the open-event registration state against SCRUM-494's registration schema. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '../../db/migrations');
const migration = (name) => readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8');

const EVENT_A = '00000000-0000-4000-8000-00000000000a';
const EVENT_B = '00000000-0000-4000-8000-00000000000b';
const EVENT_C = '00000000-0000-4000-8000-00000000000c';
const ME = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const COORDINATOR = '66666666-6666-4666-8666-666666666666';
const ORGANISER = '77777777-7777-4777-8777-777777777777';

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
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create role anon;
    create role authenticated;
    create role service_role;
    create table profiles (id uuid primary key references auth.users(id), role text not null);
  `  );
  await db.exec(migration('001_event_requests.sql'));
  // 091 adds a notification type, so the table 014 creates has to exist.
  await db.exec(`
    create table notifications (
      id uuid primary key default gen_random_uuid(),
      recipient_id uuid not null,
      type text not null,
      event_request_id uuid,
      payload jsonb not null default '{}',
      constraint notifications_type_known check (type in ('booking_flagged'))
    );
  `);
  await db.exec(migration('068_open_event_registration_state.sql'));
  await db.exec(migration('050_event_registration.sql'));
  await db.exec(migration('082_event_registration_state.sql'));
  await db.exec(migration('091_event_registration_hardening.sql'));
  for (const name of ['092_event_registration_persistence.sql', '093_registration_eligibility.sql', '094_register_for_event.sql', '101_registration_status_guards.sql']) {
    await db.exec(migration(name));
  }
  await db.query(
    'insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6), ($7, $8)',
    [ME, 'me@test', OTHER, 'other@test', COORDINATOR, 'coordinator@test', ORGANISER, 'organiser@test'],
  );
  await db.query(
    `insert into profiles (id, role) values ($1, 'attendee'), ($2, 'attendee'), ($3, 'event_coordinator')`,
    [ME, OTHER, COORDINATOR],
  );
  await db.query('insert into event_requests (id, organiser_id, event_name) values ($1, $4, $5), ($2, $4, $5), ($3, $4, $5)', [
    EVENT_A, EVENT_B, EVENT_C, ORGANISER, 'Registration state test',
  ]);

  // 1,200 places taken on A: more than the 1,000 rows an API read returns.
  await db.exec('create temporary table test_attendees as select gen_random_uuid() as id from generate_series(1, 1200)');
  await db.query('insert into auth.users (id) select id from test_attendees');
  await db.query(
    `insert into event_registrations (event_request_id, attendee_id)
     select $1::uuid, id from test_attendees`,
    [EVENT_A],
  );
  await db.query(
    `insert into event_registrations (event_request_id, attendee_id) values
       ($1, $3), ($2, $3)`,
    [EVENT_A, EVENT_B, ME],
  );
  await db.query(
    `insert into event_registrations (event_request_id, attendee_id, status)
       values ($1, $2, 'withdrawn')`,
    [EVENT_C, OTHER],
  );
});

afterAll(async () => {
  await db.close();
});

describe('SCRUM495 open_event_registration_state', () => {
  it('SCRUM495_AC3_counts_every_active_registration_however_many_there_are', async () => {
    const [a] = await state([EVENT_A], OTHER);

    expect(a).toMatchObject({ event_request_id: EVENT_A, active_count: 1201, is_registered: false });
  });

  it('SCRUM494_AC5_excludes_withdrawn_registrations_from_active_capacity', async () => {
    expect(await state([EVENT_C], OTHER)).toEqual([]);
  });

  it('SCRUM495_AC6_finds_the_callers_own_registration_among_more_than_1000', async () => {
    const [a] = await state([EVENT_A], ME);

    expect(a.is_registered).toBe(true);
  });

  it('SCRUM494_AC5_counts_only_registered_places_for_each_event', async () => {
    const rows = await state([EVENT_B, EVENT_C], OTHER);

    expect(rows).toEqual([{ event_request_id: EVENT_B, active_count: 1, is_registered: false }]);
  });

  it('SCRUM495_AC3_returns_one_row_per_event_and_none_for_events_not_asked_about', async () => {
    const rows = await state([EVENT_A, EVENT_B], ME);

    expect(rows.map((row) => row.event_request_id)).toEqual([EVENT_A, EVENT_B]);
    expect(rows.find((row) => row.event_request_id === EVENT_B).is_registered).toBe(true);
  });

  it('SCRUM495_AC7_returns_nothing_for_an_empty_or_null_list', async () => {
    expect(await state([], ME)).toEqual([]);
    expect(await state(null, ME)).toEqual([]);
  });

  it('SCRUM495_AC1_refuses_a_null_caller', async () => {
    await expect(state([EVENT_A], null)).rejects.toThrow(/attendee is required/);
  });

  it('SCRUM495_AC1_refuses_an_account_that_is_not_an_attendee', async () => {
    await expect(state([EVENT_A], COORDINATOR)).rejects.toMatchObject({ code: '42501' });
  });

  it('SCRUM495_AC1_refuses_an_account_that_does_not_exist', async () => {
    await expect(state([EVENT_A], '99999999-9999-4999-8999-999999999999')).rejects.toMatchObject({ code: '42501' });
  });

  it('SCRUM495_AC1_is_not_executable_by_public_anon_or_authenticated', async () => {
    for (const role of ['anon', 'authenticated']) {
      const { rows } = await db.query(
        `select has_function_privilege($1, 'open_event_registration_state(uuid[], uuid)', 'execute') as allowed`,
        [role],
      );
      expect(rows[0].allowed).toBe(false);
    }
  });
});
