import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerForEvent } from '../../src/services/registrationService.js';
import express from 'express';
import request from 'supertest';
import { createOpenEventRouter } from '../../src/routes/openEvents.js';
import { createRequireAuth } from '../../src/middleware/requireAuth.js';

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name) => readFileSync(resolve(here, '../../db/migrations', name), 'utf8');
const ME = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const THIRD = '77777777-7777-4777-8777-777777777777';
const ORGANISER = '66666666-6666-4666-8666-666666666666';
let db;
let event;
const register = (attendee = ME, eventId = event) => db.query(
  'select register_for_event($1::uuid, $2::uuid) as result', [eventId, attendee],
);
const records = async () => (await db.query(
  'select * from registrations where event_request_id = $1 order by created_at, id', [event],
)).rows;
const seed = (attendee, status = 'registered') => db.query(
  'insert into registrations (event_request_id, attendee_id, status) values ($1, $2, $3)',
  [event, attendee, status],
);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
  `);
  for (const name of ['001_event_requests.sql', '007_user_roles.sql', '079_registrations.sql',
    '080_registration_eligibility.sql', '081_register_for_event.sql']) {
    await db.exec(migration(name));
  }
  // SCRUM-494's settings contract is used by the existing browse service;
  // its schema migration is still a dependency, not implemented by this fixture.
  await db.exec(`
    alter table event_requests
      add column registration_enabled boolean default false,
      add column registration_opens_at timestamptz,
      add column registration_closes_at timestamptz,
      add column registration_capacity integer;
    grant select on profiles to service_role;
    grant select, update on event_requests to service_role;
    create function fail_test_registration() returns trigger language plpgsql as $$
    begin
      if new.event_request_id::text = current_setting('test.fail_event', true) then
        raise exception 'Injected post-insert failure';
      end if;
      return new;
    end;
    $$;
    create trigger fail_test_registration after insert on registrations
      for each row execute function fail_test_registration();
  `);
  await db.query('insert into auth.users (id) values ($1), ($2), ($3), ($4)', [ME, OTHER, ORGANISER, THIRD]);
  await db.query("insert into profiles (id, role) values ($1, 'attendee'), ($2, 'attendee'), ($3, 'event_organiser'), ($4, 'attendee')", [ME, OTHER, ORGANISER, THIRD]);
});
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  event = randomUUID();
  await db.query(`
    insert into event_requests (id, organiser_id, event_name, status, proposed_start,
      registration_enabled, registration_opens_at, registration_closes_at, registration_capacity)
    values ($1, $2, 'Registration test', 'confirmed', clock_timestamp() + interval '2 days',
      true, clock_timestamp() - interval '1 day', clock_timestamp() + interval '1 day', 1)
  `, [event, ORGANISER]);
});

describe('SCRUM39 atomic event registration', () => {
  it('SCRUM39_AC1_takes_the_last_place_and_returns_the_persisted_registration', async () => {
    await db.query('update event_requests set registration_capacity = 2 where id = $1', [event]);
    await seed(OTHER);
    const { rows: [{ result }] } = await register();
    expect(result).toMatchObject({ outcome: 'registered', registration: {
      event_request_id: event, attendee_id: ME, status: 'registered',
    } });
    const saved = await records();
    expect(saved).toHaveLength(2);
    expect(result.registration.id).toBe(saved.find((row) => row.attendee_id === ME).id);
  });

  it('SCRUM39_AC1_refuses_a_full_event_without_changing_records', async () => {
    await seed(OTHER);
    const before = await records();
    await expect(register()).rejects.toMatchObject({ code: '55000', hint: 'EVENT_FULL', message: 'Event is full' });
    expect(await records()).toEqual(before);
  });

  it('SCRUM39_AC1_refuses_an_event_already_over_its_lowered_capacity', async () => {
    await seed(ME);
    await seed(OTHER);
    await expect(register(THIRD)).rejects.toMatchObject({ hint: 'EVENT_FULL' });
    expect(await records()).toHaveLength(2);
  });

  it('SCRUM39_AC1_treats_zero_capacity_as_full', async () => {
    await db.query('update event_requests set registration_capacity = 0 where id = $1', [event]);
    await expect(register()).rejects.toMatchObject({ hint: 'EVENT_FULL' });
    expect(await records()).toEqual([]);
  });

  it('SCRUM39_AC2_returns_already_registered_before_full_for_a_repeat_attempt', async () => {
    await register();
    const before = await records();
    await expect(register()).rejects.toMatchObject({ code: '55000', hint: 'ALREADY_REGISTERED', message: 'Already registered' });
    expect(await records()).toEqual(before);
  });

  it.each(['withdrawn', 'cancelled'])('SCRUM39_AC2_does_not_count_%s_records_as_active', async (status) => {
    await seed(ME, status);
    await seed(OTHER, status);
    await register();
    const saved = await records();
    expect(saved).toHaveLength(3);
    expect(saved.filter((row) => row.status === 'registered')).toHaveLength(1);
  });

  it('SCRUM39_AC3_allows_null_capacity_without_a_venue_capacity_check', async () => {
    await db.query('update event_requests set registration_capacity = null where id = $1', [event]);
    await register();
    await register(OTHER);
    expect(await records()).toHaveLength(2);
    await expect(register()).rejects.toMatchObject({ hint: 'ALREADY_REGISTERED' });
  });

  it('SCRUM39_AC4_allows_only_one_queued_request_for_the_last_place', async () => {
    // PGlite queues these calls on one connection. Real overlapping transactions
    // and lock waiting must also be checked with registrationConcurrency.manual.sql.
    const outcomes = await Promise.allSettled([register(), register(OTHER)]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected').map((result) => result.reason.hint)).toEqual(['EVENT_FULL']);
    expect(await records()).toHaveLength(1);
  });

  it('SCRUM39_AC4_allows_only_one_of_two_queued_requests_from_the_same_attendee', async () => {
    const outcomes = await Promise.allSettled([register(), register()]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected').map((result) => result.reason.hint)).toEqual(['ALREADY_REGISTERED']);
    expect(await records()).toHaveLength(1);
  });

  it('SCRUM39_AC5_rolls_back_a_failure_after_the_insert_and_leaves_the_place_available', async () => {
    await db.query("select set_config('test.fail_event', $1, false)", [event]);
    await expect(register()).rejects.toThrow('Injected post-insert failure');
    expect(await records()).toEqual([]);
    await db.query("select set_config('test.fail_event', '', false)");
    await register(OTHER);
    expect((await records()).map((row) => row.attendee_id)).toEqual([OTHER]);
  });

  it('SCRUM39_AC5_can_roll_back_the_whole_registration_transaction', async () => {
    await db.exec('begin');
    await register();
    await db.exec('rollback');
    expect(await records()).toEqual([]);
    await register(OTHER);
    expect(await records()).toHaveLength(1);
  });

  it.each([
    ['status', 'approved', 'EVENT_NOT_CONFIRMED'],
    ['registration_enabled', false, 'REGISTRATION_DISABLED'],
    ['registration_opens_at', '9999-01-01T00:00:00Z', 'REGISTRATION_NOT_OPEN'],
    ['registration_closes_at', '2000-01-01T00:00:00Z', 'REGISTRATION_CLOSED'],
    ['proposed_start', '2000-01-01T00:00:00Z', 'EVENT_STARTED'],
  ])('SCRUM39_AC5_revalidates_current_%s_in_the_write_transaction', async (column, value, hint) => {
    await db.query(`update event_requests set ${column} = $1 where id = $2`, [value, event]);
    await expect(register()).rejects.toMatchObject({ hint });
    expect(await records()).toEqual([]);
  });

  it.each([
    ['null attendee', null, null, '22023'],
    ['wrong role', ORGANISER, null, '42501'],
    ['unknown attendee', '99999999-9999-4999-8999-999999999999', null, '42501'],
    ['unknown event', ME, '99999999-9999-4999-8999-999999999999', 'P0002'],
  ])('SCRUM39_AC5_refuses_%s_without_inserting', async (_label, attendee, target, code) => {
    await expect(register(attendee, target ?? event)).rejects.toMatchObject({ code });
    expect(await records()).toEqual([]);
  });

  it.each(['anon', 'authenticated'])('SCRUM39_AC5_denies_direct_RPC_execution_by_%s', async (role) => {
    await db.exec(`set role ${role}`);
    try {
      await expect(register()).rejects.toMatchObject({ code: '42501', message: 'permission denied for function register_for_event' });
    } finally { await db.exec('reset role'); }
    expect(await records()).toEqual([]);
  });

  it('SCRUM39_AC5_runs_the_service_with_the_API_role_against_real_SQL', async () => {
    const client = { rpc: async (name, args) => {
      expect(name).toBe('register_for_event');
      try {
        const { rows } = await register(args.p_attendee_id, args.p_event_request_id);
        return { data: rows[0].result, error: null };
      } catch (error) { return { data: null, error }; }
    } };
    await db.exec('set role service_role');
    try {
      const saved = await registerForEvent({ attendeeId: ME, eventId: event, client });
      expect(saved).toMatchObject({ eventRequestId: event, attendeeId: ME, status: 'registered' });
      await expect(registerForEvent({ attendeeId: OTHER, eventId: event, client })).rejects.toMatchObject({ status: 409, code: 'EVENT_FULL' });
      await expect(registerForEvent({ attendeeId: ME, eventId: event, client })).rejects.toMatchObject({ status: 409, code: 'ALREADY_REGISTERED' });
    } finally { await db.exec('reset role'); }
    expect(await records()).toHaveLength(1);
  });

  it('SCRUM36_AC3_verifies_the_HTTP_service_and_SQL_registration_integration', async () => {
    const client = { rpc: async (_name, args) => {
      try {
        const { rows } = await register(args.p_attendee_id, args.p_event_request_id);
        return { data: rows[0].result, error: null };
      } catch (error) { return { error }; }
    } };
    const requireAuth = createRequireAuth({
      verifyToken: async (token) => token === 'attendee-token' ? { id: ME } : null,
      loadRole: async (id) => (await db.query('select role from profiles where id = $1', [id])).rows[0]?.role,
    });
    const app = express().use('/api/open-events', createOpenEventRouter({ client, requireAuth }));
    await db.exec('set role service_role');
    try {
      const success = await request(app).post(`/api/open-events/${event}/registrations`)
        .set('Authorization', 'Bearer attendee-token');
      expect(success.status).toBe(201);
      expect(success.body).toMatchObject({ attendeeId: ME, eventRequestId: event, status: 'registered' });
      expect((await records()).map((row) => row.id)).toEqual([success.body.id]);
      const repeated = await request(app).post(`/api/open-events/${event}/registrations`)
        .set('Authorization', 'Bearer attendee-token');
      expect(repeated.status).toBe(409);
      expect(repeated.body).toMatchObject({ code: 'ALREADY_REGISTERED', error: 'Already registered' });
      expect(await records()).toHaveLength(1);
    } finally { await db.exec('reset role'); }
  });
});
