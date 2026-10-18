import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { ACTIVE_REGISTRATION_STATUS } from '../../src/domain/registrationAvailability.js';

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name) => readFileSync(resolve(here, '../../db/migrations', name), 'utf8');
const ME = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const EVENT = '00000000-0000-4000-8000-00000000000a';
const OTHER_EVENT = '00000000-0000-4000-8000-00000000000b';
const MISSING = '99999999-9999-4999-8999-999999999999';
let db;

const register = (event = EVENT, attendee = ME, status = ACTIVE_REGISTRATION_STATUS) => db.query(
  'insert into registrations (event_request_id, attendee_id, status) values ($1, $2, $3) returning *',
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
  for (const name of ['001_event_requests.sql', '007_user_roles.sql', '068_open_event_registration_state.sql', '../migration-history/079_registrations.sql']) {
    await db.exec(migration(name));
  }
  await db.query('insert into auth.users (id) values ($1), ($2)', [ME, OTHER]);
  await db.query("insert into profiles (id, role) values ($1, 'attendee'), ($2, 'attendee')", [ME, OTHER]);
  await db.query(
    `insert into event_requests (id, organiser_id, event_name, status)
     values ($1, $3, 'First event', 'confirmed'), ($2, $3, 'Second event', 'confirmed')`,
    [EVENT, OTHER_EVENT, OTHER],
  );
});

afterAll(async () => { await db.close(); });
beforeEach(async () => { await db.exec('begin'); });
afterEach(async () => { await db.exec('rollback'); });

describe('SCRUM41 historical persistence upgrade input', () => {
  it('SCRUM41_AC1_persists_the_account_event_and_database_defaults', async () => {
    await db.exec('set local role service_role');
    const { rows: [saved] } = await db.query(
      'insert into registrations (event_request_id, attendee_id) values ($1, $2) returning *',
      [EVENT, ME],
    );
    expect(saved).toMatchObject({ event_request_id: EVENT, attendee_id: ME, status: ACTIVE_REGISTRATION_STATUS });
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.created_at).toBeInstanceOf(Date);
    expect(saved.updated_at).toEqual(saved.created_at);
    expect((await db.query('select * from registrations where id = $1', [saved.id])).rows).toEqual([saved]);
  });

  it('SCRUM41_AC1_queries_by_attendee_and_by_event', async () => {
    await register();
    await register(OTHER_EVENT);
    await register(EVENT, OTHER);
    const mine = await db.query('select event_request_id from registrations where attendee_id = $1 order by event_request_id', [ME]);
    expect(mine.rows).toEqual([{ event_request_id: EVENT }, { event_request_id: OTHER_EVENT }]);
    const attendees = await db.query('select attendee_id from registrations where event_request_id = $1 order by attendee_id', [EVENT]);
    expect(attendees.rows).toEqual([{ attendee_id: ME }, { attendee_id: OTHER }]);
  });

  it.each([
    ['missing event', MISSING, ME, '23503'],
    ['missing account', EVENT, MISSING, '23503'],
    ['null event', null, ME, '23502'],
    ['null account', EVENT, null, '23502'],
  ])('SCRUM41_AC1_rejects_a_%s', async (_label, event, attendee, code) => {
    await expect(register(event, attendee)).rejects.toMatchObject({ code });
  });

  it.each(['event', 'account'])('SCRUM41_AC1_preserves_history_when_the_%s_is_deleted', async (parent) => {
    await register();
    const sql = parent === 'event' ? 'delete from event_requests where id = $1' : 'delete from auth.users where id = $1';
    await expect(db.query(sql, [parent === 'event' ? EVENT : ME])).rejects.toMatchObject({
      code: '23001',
      constraint: parent === 'event' ? 'registrations_event_request_id_fkey' : 'registrations_attendee_id_fkey',
    });
  });

  it('SCRUM41_AC1_rejects_duplicate_active_registrations', async () => {
    await register();
    await expect(register()).rejects.toMatchObject({ code: '23505', constraint: 'idx_registrations_active_attendee_event' });
  });

  it.each(['withdrawn', 'cancelled'])('SCRUM41_AC1_retains_%s_history_and_allows_a_new_registration', async (status) => {
    const { rows: [original] } = await register();
    await db.query('update registrations set status = $1, updated_at = $2 where id = $3', [status, '2000-01-01T00:00:00Z', original.id]);
    const { rows: [next] } = await register();
    expect(next.id).not.toBe(original.id);
    const { rows: [history] } = await db.query('select * from registrations where id = $1', [original.id]);
    expect(history.status).toBe(status);
    expect(history.created_at).toEqual(original.created_at);
    expect(history.updated_at.getUTCFullYear()).not.toBe(2000);
    const { rows } = await db.query('select active_count::int, is_registered from open_event_registration_state($1::uuid[], $2)', [[EVENT], ME]);
    expect(rows).toEqual([{ active_count: 1, is_registered: true }]);
  });

  it('SCRUM41_AC1_rejects_reactivating_history_while_a_place_is_already_held', async () => {
    const { rows: [history] } = await register(EVENT, ME, 'withdrawn');
    await register();
    await expect(db.query("update registrations set status = 'registered' where id = $1", [history.id])).rejects.toMatchObject({ code: '23505' });
  });

  it.each(['unknown', null])('SCRUM41_AC1_rejects_status_%s', async (status) => {
    await expect(register(EVENT, ME, status)).rejects.toMatchObject({ code: status === null ? '23502' : '23514' });
  });

  it('SCRUM41_AC1_keeps_registrations_when_the_event_status_changes', async () => {
    const { rows: [saved] } = await register();
    for (const status of ['approved', 'confirmed', 'cancelled']) {
      await db.query('update event_requests set status = $1 where id = $2', [status, EVENT]);
      expect((await db.query('select * from registrations where id = $1', [saved.id])).rows).toEqual([saved]);
    }
  });

  it('SCRUM41_AC1_reruns_the_migration_without_losing_records', async () => {
    const { rows: [saved] } = await register();
    await db.exec(migration('../migration-history/079_registrations.sql'));
    expect((await db.query('select * from registrations where id = $1', [saved.id])).rows).toEqual([saved]);
    await expect(register()).rejects.toMatchObject({ code: '23505' });
  });

  it.each(['anon', 'authenticated'])('SCRUM41_AC1_denies_direct_table_privileges_to_%s', async (role) => {
    for (const privilege of ['select', 'insert', 'update', 'delete']) {
      const { rows } = await db.query("select has_table_privilege($1, 'registrations', $2) as allowed", [role, privilege]);
      expect(rows[0].allowed).toBe(false);
    }
    await db.exec(`set local role ${role}`);
    await expect(register()).rejects.toMatchObject({ code: '42501' });
  });

  it.each(['anon', 'authenticated'])('SCRUM41_AC1_RLS_hides_records_even_if_%s_has_table_grants', async (role) => {
    await register();
    await db.exec(`grant select, insert, update, delete on registrations to ${role}; set local role ${role}`);
    expect((await db.query('select * from registrations')).rows).toEqual([]);
    expect((await db.query("update registrations set status = 'withdrawn' returning id")).rows).toEqual([]);
    expect((await db.query('delete from registrations returning id')).rows).toEqual([]);
    await expect(register(OTHER_EVENT)).rejects.toMatchObject({ code: '42501' });
  });
});
