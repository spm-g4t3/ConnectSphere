import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';
import { queriesFor } from './helpers/queries.js';
import { clientsCanExecute } from './helpers/grants.js';

// Registration settings, the writer, the browse read and the read-only
// registrations view, all on the one event_registrations table.
const ORGANISER = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const THIRD = '44444444-4444-4444-8444-444444444444';
const EVENT = '55555555-5555-4555-8555-555555555555';
const COORDINATOR = '66666666-6666-4666-8666-666666666666';
const MISSING = '99999999-9999-4999-8999-999999999999';
let db;
const { one } = queriesFor(() => db);
const register = async (attendee = ME) => (await one('select register_for_event($1, $2) as result', [EVENT, attendee])).result;
const state = async (attendee = ME) => one('select active_count::int, is_registered from open_event_registration_state($1::uuid[], $2)', [[EVENT], attendee]);
const setup = async (capacity = 3) => (await one(`select setup_event_registration(
  $1, $2, true, clock_timestamp() - interval '1 hour', null, $3, null) as result`, [EVENT, ORGANISER, capacity])).result;

beforeAll(async () => {
  db = await createSchemaDb();
  await db.query('insert into auth.users (id) values ($1), ($2), ($3), ($4), ($5)', [ORGANISER, ME, OTHER, THIRD, COORDINATOR]);
  await db.query(`insert into profiles (id, role) values
    ($1, 'event_organiser'), ($2, 'attendee'), ($3, 'attendee'), ($4, 'attendee'), ($5, 'event_coordinator')`,
  [ORGANISER, ME, OTHER, THIRD, COORDINATOR]);
  await seedEvent(db, {
    id: EVENT, status: 'confirmed', organiser_id: ORGANISER, reviewing_coordinator_id: COORDINATOR,
    event_name: 'Shared schema', purpose: 'Registration', expected_attendance: 50,
    proposed_start: '2030-01-01', proposed_end: '2030-01-02',
  });
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('begin');
  // Two places taken and one cancelled registration.
  await db.query(`insert into event_registrations(event_request_id, attendee_id, status) values
    ($1, $2, 'registered'), ($1, $3, 'registered'), ($1, $4, 'cancelled')`, [EVENT, THIRD, ME, OTHER]);
});
afterEach(async () => { await db.exec('rollback'); });

describe('SCRUM22 one registration table', () => {
  it('SCRUM22_AC2_AC6_start_changes_notify_and_preserve_registrations_while_the_writer_refuses_the_moved_event', async () => {
    await one(`select setup_event_registration(
      $1, $2, true, clock_timestamp() + interval '1 day', null, 3, null) as result`, [EVENT, ORGANISER]);
    const before = (await db.query('select * from event_registrations order by id')).rows;
    // A confirmed event's start moves only through a significant change, which
    // returns it to Approved; here it moves before the registration opening.
    await db.query(
      "select apply_significant_event_change($1, jsonb_build_object('proposedStart', clock_timestamp() + interval '1 hour'), 'Start moved.', $2)",
      [EVENT, COORDINATOR],
    );
    expect(await one('select registration_enabled, registration_capacity from event_requests where id = $1', [EVENT]))
      .toEqual({ registration_enabled: true, registration_capacity: 3 });
    expect(await one('select type, payload from notifications where event_request_id = $1 and recipient_id = $2', [EVENT, ORGANISER]))
      .toMatchObject({ type: 'registration_schedule_conflict', payload: { fields: ['registrationOpensAt'] } });
    expect(await register(OTHER)).toEqual({ outcome: 'not_found' });
    expect((await db.query('select * from event_registrations order by id')).rows).toEqual(before);
    const disabled = await one('select setup_event_registration($1, $2, false, null, null, 3, null) as result', [EVENT, ORGANISER]);
    expect(disabled.result).toMatchObject({ outcome: 'saved', registeredCount: 2, settings: { enabled: false } });
    expect(await state()).toEqual({ active_count: 2, is_registered: true });
  });

  it('SCRUM22_AC4_the_registrations_view_reads_the_one_table_and_is_not_writable', async () => {
    expect(await one("select relkind from pg_class where oid = 'registrations'::regclass")).toEqual({ relkind: 'v' });
    expect(await state()).toEqual({ active_count: 2, is_registered: true });
    expect(await one("select count(*)::int as count from registrations where status = 'registered'")).toEqual({ count: 2 });
    expect(await one("select has_table_privilege('service_role', 'registrations', 'update') as allowed")).toEqual({ allowed: false });
  });

  it('SCRUM22_AC4_AC5_AC7_setup_writer_and_browse_share_the_same_active_count_and_last_place', async () => {
    await db.query("update event_registrations set status = 'withdrawn' where attendee_id = $1", [OTHER]);
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

  // SCRUM-474 replaced "registering never promotes": a queued attendee now takes
  // a free place before anyone registers, so registration cannot jump the queue.
  it('SCRUM22_AC4_reuses_a_withdrawn_row_and_SCRUM474_AC9_serves_the_queue_first', async () => {
    await setup();
    await db.query("update event_registrations set status = 'withdrawn' where attendee_id = $1", [ME]);
    const previous = await one('select id, created_at from event_registrations where attendee_id = $1', [ME]);
    expect((await register()).registration).toMatchObject({ id: previous.id });
    expect(await one('select id, created_at from event_registrations where attendee_id = $1', [ME])).toEqual(previous);
    await db.query("update event_registrations set status = 'waitlisted' where attendee_id = $1", [THIRD]);
    // The catch-up gave THIRD the place, so this attempt succeeded (SCRUM-460 issue 2).
    expect(await register(THIRD)).toMatchObject({
      outcome: 'registered', registration: { attendeeId: THIRD, status: 'registered' },
    });
    expect(await state(THIRD)).toEqual({ active_count: 2, is_registered: true });
  });

  it('SCRUM22_AC6_registration_writers_are_defined_once_invoker_security_and_backend_only', async () => {
    const functions = await one("select count(*)::int as count, bool_or(prosecdef) as definer from pg_proc where proname = 'register_for_event'");
    expect(functions).toEqual({ count: 1, definer: false });
    expect(await one("select prosecdef from pg_proc where proname = 'setup_event_registration'"))
      .toEqual({ prosecdef: false });
    expect(await clientsCanExecute(db, 'setup_event_registration(uuid,uuid,boolean,timestamptz,timestamptz,integer,timestamptz,boolean)'))
      .toEqual([]);
  });

  it.each(['event_request_id', 'attendee_id'])('SCRUM22_AC6_shared_%s_has_a_foreign_key', async (column) => {
    await expect(db.query(`insert into event_registrations(event_request_id, attendee_id)
      values ($1, $2)`, [column === 'event_request_id' ? MISSING : EVENT, column === 'attendee_id' ? MISSING : OTHER]))
      .rejects.toMatchObject({ code: '23503' });
  });

  it('SCRUM41_AC1_preserves_registrations_when_the_event_is_deleted', async () => {
    await expect(db.query('delete from event_requests where id = $1', [EVENT]))
      .rejects.toMatchObject({ code: '23001', constraint: 'event_registrations_event_request_id_fkey' });
  });

  it('SCRUM41_AC1_preserves_registrations_when_the_account_is_deleted', async () => {
    // An account with no profile, so only its registration holds it.
    const { id } = await one('insert into auth.users default values returning id');
    await db.query('insert into event_registrations(event_request_id, attendee_id) values ($1, $2)', [EVENT, id]);
    await expect(db.query('delete from auth.users where id = $1', [id]))
      .rejects.toMatchObject({ code: '23001', constraint: 'event_registrations_attendee_id_fkey' });
  });

  it.each([['unknown', '23514'], [null, '23502']])('SCRUM41_AC1_rejects_status_%s', async (status, code) => {
    await expect(db.query('insert into event_registrations(event_request_id, attendee_id, status) values ($1, $2, $3)',
      [EVENT, ORGANISER, status])).rejects.toMatchObject({ code });
  });

  it.each(['anon', 'authenticated'])('SCRUM41_AC1_denies_direct_table_privileges_to_%s', async (role) => {
    for (const table of ['event_registrations', 'registrations']) {
      for (const privilege of ['select', 'insert', 'update', 'delete']) {
        expect(await one('select has_table_privilege($1, $2, $3) as allowed', [role, table, privilege]), `${table} ${privilege}`)
          .toEqual({ allowed: false });
      }
    }
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
