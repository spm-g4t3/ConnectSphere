import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { addRegistrationNotificationPrerequisites } from '../fixtures/registrationDatabase.js';

const migration = (name) => readFileSync(new URL(`../../db/migrations/${name}`, import.meta.url), 'utf8');
const applyRegistrationMigrations = async () => {
  for (const name of ['092_event_registration_persistence.sql', '093_registration_eligibility.sql', '094_register_for_event.sql']) {
    await db.exec(migration(name));
  }
};
const ORGANISER = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const THIRD = '44444444-4444-4444-8444-444444444444';
const EVENT = '55555555-5555-4555-8555-555555555555';
const MISSING = '99999999-9999-4999-8999-999999999999';
let db;
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const register = async (attendee = ME) => (await one('select register_for_event($1, $2) as result', [EVENT, attendee])).result;
const state = async (attendee = ME) => one('select active_count::int, is_registered from open_event_registration_state($1::uuid[], $2)', [[EVENT], attendee]);
const setup = async (capacity = 3) => (await one(`select setup_event_registration(
  $1, $2, true, clock_timestamp() - interval '1 hour', null, $3, null) as result`, [EVENT, ORGANISER, capacity])).result;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create schema auth; create table auth.users(id uuid primary key);
    create role anon; create role authenticated; create role service_role bypassrls;`);
  for (const name of [
    '001_event_requests.sql', '007_user_roles.sql', '050_event_registration.sql',
    '068_open_event_registration_state.sql', '../migration-history/079_registrations.sql',
    '../migration-history/080_registration_eligibility.sql', '../migration-history/081_register_for_event.sql',
    '082_event_registration_state.sql', '091_event_registration_hardening.sql',
  ]) {
    if (name === '091_event_registration_hardening.sql') await addRegistrationNotificationPrerequisites(db);
    await db.exec(migration(name));
  }
  await db.query('insert into auth.users values ($1), ($2), ($3), ($4)', [ORGANISER, ME, OTHER, THIRD]);
  await db.query(`insert into profiles (id, role) values
    ($1, 'event_organiser'), ($2, 'attendee'), ($3, 'attendee'), ($4, 'attendee')`, [ORGANISER, ME, OTHER, THIRD]);
  await db.query(`insert into event_requests(id, organiser_id, event_name, status, proposed_start)
    values ($1, $2, 'Shared schema', 'confirmed', '2030-01-01')`, [EVENT, ORGANISER]);
  await db.exec('grant select on profiles to service_role; grant select, update on event_requests to service_role;');
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('begin');
  await db.query(`insert into registrations(event_request_id, attendee_id, status) values
    ($1, $2, 'registered'), ($1, $2, 'withdrawn'), ($1, $3, 'cancelled')`, [EVENT, ME, OTHER]);
  await db.query('insert into event_registrations(event_request_id, attendee_id) values ($1, $2), ($1, $3)', [EVENT, THIRD, ME]);
  await applyRegistrationMigrations();
});
afterEach(async () => { await db.exec('rollback'); });

describe('SCRUM22 shared schema with PR 68', () => {
  it('SCRUM22_AC4_AC6_reconciles_legacy_records_without_two_writable_registration_tables', async () => {
    expect(await one("select relkind from pg_class where oid = 'registrations'::regclass")).toEqual({ relkind: 'v' });
    expect(await one('select count(*)::int as count from registrations_legacy_archive')).toEqual({ count: 3 });
    expect(await one('select count(*)::int as count from event_registrations')).toEqual({ count: 3 });
    expect(await state()).toEqual({ active_count: 2, is_registered: true });
    expect(await one("select count(*)::int as count from registrations where status = 'registered'")).toEqual({ count: 2 });
    for (const table of ['registrations', 'registrations_legacy_archive']) {
      expect(await one("select has_table_privilege('service_role', $1, 'update') as allowed", [table])).toEqual({ allowed: false });
    }
  });

  it('SCRUM22_AC4_AC5_AC7_setup_writer_and_browse_share_the_same_active_count_and_last_place', async () => {
    await db.exec('set local role service_role');
    expect(await setup()).toMatchObject({ outcome: 'saved', registeredCount: 2 });
    const saved = await register(OTHER);
    expect(saved).toMatchObject({ outcome: 'registered', registeredCount: 3, registration: { attendeeId: OTHER, eventRequestId: EVENT } });
    expect(await state(OTHER)).toEqual({ active_count: 3, is_registered: true });
    expect(await register(OTHER)).toEqual({ outcome: 'already_registered' });
    expect(await setup(2)).toMatchObject({ outcome: 'invalid', details: [expect.objectContaining({ field: 'registrationCapacity' })] });
    expect(await one('select registration_capacity from event_requests where id = $1', [EVENT])).toEqual({ registration_capacity: 3 });
    expect(await one('select count(*)::int as count from event_registrations')).toEqual({ count: 3 });
  });

  it('SCRUM22_AC4_reuses_a_withdrawn_row_and_does_not_promote_waitlisted_attendees', async () => {
    await setup();
    await db.query("update event_registrations set status = 'withdrawn' where attendee_id = $1", [ME]);
    const previous = await one('select id, created_at from event_registrations where attendee_id = $1', [ME]);
    expect((await register()).registration).toMatchObject({ id: previous.id });
    expect(await one('select id, created_at from event_registrations where attendee_id = $1', [ME])).toEqual(previous);
    await db.query("update event_registrations set status = 'waitlisted' where attendee_id = $1", [THIRD]);
    expect(await register(THIRD)).toEqual({ outcome: 'already_registered' });
    expect(await state(THIRD)).toEqual({ active_count: 1, is_registered: false });
  });

  it('SCRUM22_AC6_rerunning_reconciliation_never_replays_archived_registration_state', async () => {
    await db.query("update event_registrations set status = 'withdrawn' where attendee_id = $1", [ME]);
    const before = (await db.query('select * from event_registrations order by id')).rows;
    await applyRegistrationMigrations();
    expect((await db.query('select * from event_registrations order by id')).rows).toEqual(before);
    expect(await state()).toEqual({ active_count: 1, is_registered: false });
    const functions = await one("select count(*)::int as count, bool_or(prosecdef) as definer from pg_proc where proname = 'register_for_event'");
    expect(functions).toEqual({ count: 1, definer: false });
    expect(await one("select prosecdef from pg_proc where proname = 'setup_event_registration'"))
      .toEqual({ prosecdef: false });
    for (const role of ['anon', 'authenticated']) {
      expect(await one("select has_function_privilege($1, 'setup_event_registration(uuid,uuid,boolean,timestamptz,timestamptz,integer,timestamptz)', 'execute') as allowed", [role]))
        .toEqual({ allowed: false });
    }
  });

  it('SCRUM22_AC6_already_applied_088_is_upgraded_without_replaying_history', async () => {
    // Restore the pre-upgrade fixture, then simulate the earlier deployed revision.
    await db.exec('rollback; begin');
    await db.query('insert into registrations(event_request_id, attendee_id) values ($1, $2)', [EVENT, ME]);
    await db.exec(migration('../migration-history/088_unify_event_registrations.sql'));
    await db.query("update event_registrations set status = 'withdrawn' where attendee_id = $1", [ME]);
    const before = (await db.query('select * from event_registrations order by id')).rows;
    await applyRegistrationMigrations();
    expect((await db.query('select * from event_registrations order by id')).rows).toEqual(before);
    expect(await one('select count(*)::int as count from registrations_legacy_archive')).toEqual({ count: 1 });
    await setup();
    expect((await register()).registration.id).toBe(before[0].id);
  });

  it.each(['event_request_id', 'attendee_id'])('SCRUM22_AC6_shared_%s_has_a_foreign_key', async (column) => {
    await expect(db.query(`insert into event_registrations(event_request_id, attendee_id)
      values ($1, $2)`, [column === 'event_request_id' ? MISSING : EVENT, column === 'attendee_id' ? MISSING : OTHER]))
      .rejects.toMatchObject({ code: '23503' });
  });

  it('SCRUM22_AC4_database_uniqueness_protects_the_shared_table', async () => {
    await expect(db.query('insert into event_registrations(event_request_id, attendee_id) values ($1, $2)', [EVENT, ME]))
      .rejects.toMatchObject({ code: '23505', constraint: 'event_registrations_attendee_once' });
  });

  it.each(['anon', 'authenticated'])('SCRUM22_AC1_shared_table_and_compatibility_view_do_not_bypass_RLS_for_%s', async (role) => {
    await db.exec(`grant select, insert, update, delete on event_registrations to ${role};
      grant select on registrations to ${role}; set local role ${role};`);
    expect((await db.query('select * from event_registrations')).rows).toEqual([]);
    expect((await db.query('select * from registrations')).rows).toEqual([]);
    expect((await db.query("update event_registrations set status = 'registered' returning id")).rows).toEqual([]);
    await expect(db.query('select register_for_event($1, $2)', [EVENT, ME])).rejects.toMatchObject({ code: '42501' });
  });
});
