import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createSchemaDb, functionSources, seedEvent } from './helpers/schemaDb.js';

// assert_registration_withdrawable against the final schema, on a stubbed clock.
const ME = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const COORDINATOR = '66666666-6666-4666-8666-666666666666';
const MISSING = '99999999-9999-4999-8999-999999999999';
const DEADLINE = '2026-10-18T10:00:00Z';
let db;
let event;

const withdrawableEvent = (overrides = {}) => seedEvent(db, {
  status: 'confirmed',
  organiser_id: COORDINATOR,
  reviewing_coordinator_id: COORDINATOR,
  event_name: 'Event',
  proposed_start: '2026-10-20T10:00:00Z',
  registration_enabled: true,
  registration_opens_at: '2026-10-10T10:00:00Z',
  registration_withdrawal_deadline: DEADLINE,
  ...overrides,
});
const seedRegistration = async (attendee = ME, status = 'registered', eventId = event) => (await db.query(
  `insert into event_registrations (event_request_id, attendee_id, status)
   values ($1, $2, $3) returning id`, [eventId, attendee, status],
)).rows[0].id;
const check = (registration, attendee = ME) => db.query(
  'select (assert_registration_withdrawable($1::uuid, $2::uuid)).*', [registration, attendee],
);
const at = (time) => db.query("select set_config('test.withdrawal_time', $1, true)", [time]);
const eventState = async () => ({
  registrations: (await db.query(
    'select * from event_registrations where event_request_id = $1 order by id', [event],
  )).rows,
  event: (await db.query('select * from event_requests where id = $1', [event])).rows[0],
});

beforeAll(async () => {
  db = await createSchemaDb();
  await db.query('insert into auth.users (id) values ($1), ($2), ($3)', [ME, OTHER, COORDINATOR]);
  await db.query(`insert into profiles (id, role) values ($1, 'attendee'), ($2, 'attendee'),
    ($3, 'event_coordinator')`, [ME, OTHER, COORDINATOR]);
  event = await withdrawableEvent();
  // Override the clock only in this test database to exercise the exact deadline
  // without adding a caller-controlled time argument to the production function.
  await db.exec(`
    create function public.clock_timestamp() returns timestamptz language sql
      as $$ select current_setting('test.withdrawal_time')::timestamptz $$;
    set search_path = public, pg_catalog;
  `);
});
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec('begin');
  await at('2026-10-16T10:00:00Z');
});
afterEach(async () => { await db.exec('rollback'); });

describe('SCRUM27 withdrawal eligibility in PostgreSQL', () => {
  it('SCRUM27_AC1_accepts_the_owner_of_a_confirmed_registration_and_returns_it', async () => {
    const id = await seedRegistration();
    const { rows: [row] } = await check(id);
    expect(row).toMatchObject({ id, attendee_id: ME, event_request_id: event, status: 'registered' });
  });

  it('SCRUM27_AC1_accepts_the_API_role', async () => {
    const id = await seedRegistration();
    await db.exec('set local role service_role');
    await expect(check(id)).resolves.toBeDefined();
  });

  it.each(['anon', 'authenticated'])('SCRUM27_AC1_denies_direct_function_access_to_%s', async (role) => {
    const id = await seedRegistration();
    await db.exec(`set local role ${role}`);
    await expect(check(id)).rejects.toMatchObject({
      code: '42501', message: 'permission denied for function assert_registration_withdrawable',
    });
  });

  it.each([['registration', null, ME], ['attendee', MISSING, null]])
    ('SCRUM27_AC1_refuses_a_null_%s', async (_field, registration, attendee) => {
      await expect(check(registration, attendee)).rejects.toMatchObject({ code: '22023' });
    });

  it('SCRUM27_AC1_refuses_a_caller_who_is_not_an_attendee', async () => {
    const id = await seedRegistration();
    await db.query("update profiles set role = 'event_organiser' where id = $1", [ME]);
    await expect(check(id)).rejects.toMatchObject({ code: '42501', message: 'This action is restricted to Attendees' });
  });

  it('SCRUM27_AC1_refuses_a_missing_registration', async () => {
    await expect(check(MISSING)).rejects.toMatchObject({
      code: 'P0002', hint: 'REGISTRATION_NOT_FOUND', message: 'Registration not found',
    });
  });

  it('SCRUM27_AC1_refuses_another_attendees_registration_with_the_not_found_message', async () => {
    const id = await seedRegistration(OTHER);
    await expect(check(id)).rejects.toMatchObject({
      code: 'P0002', hint: 'REGISTRATION_NOT_OWNED', message: 'Registration not found',
    });
  });

  it('SCRUM27_AC1_refuses_a_registration_already_withdrawn', async () => {
    const id = await seedRegistration(ME, 'withdrawn');
    await expect(check(id)).rejects.toMatchObject({ code: '55000', hint: 'ALREADY_WITHDRAWN' });
  });

  it.each(['waitlisted', 'cancelled'])('SCRUM27_AC1_refuses_a_%s_registration', async (status) => {
    const id = await seedRegistration(ME, status);
    await expect(check(id)).rejects.toMatchObject({
      code: '55000', hint: 'REGISTRATION_NOT_CONFIRMED', message: 'Only a confirmed registration can be withdrawn',
    });
  });

  it('SCRUM27_AC2_accepts_a_request_immediately_before_the_deadline', async () => {
    const id = await seedRegistration();
    await at('2026-10-18T09:59:59.999999Z');
    await expect(check(id)).resolves.toBeDefined();
  });

  it.each([['exactly at', '2026-10-18T10:00:00Z'], ['immediately after', '2026-10-18T10:00:00.000001Z'],
    ['a day after', '2026-10-19T10:00:00Z']])
    ('SCRUM27_AC2_refuses_a_request_%s_the_deadline', async (_when, time) => {
      const id = await seedRegistration();
      await at(time);
      await expect(check(id)).rejects.toMatchObject({
        code: '55000', hint: 'WITHDRAWAL_DEADLINE_PASSED', message: 'The withdrawal deadline for this event has passed',
      });
    });

  // Organisers enter Singapore times; the comparison is between instants, whatever the offset.
  it.each([
    ['allows', '2026-10-18T09:59:59.999999Z', null],
    ['refuses', '2026-10-18T10:00:00Z', 'WITHDRAWAL_DEADLINE_PASSED'],
  ])('SCRUM27_AC2_%s_against_a_deadline_stored_in_Singapore_time', async (_verb, time, hint) => {
    const singapore = await withdrawableEvent({ registration_withdrawal_deadline: '2026-10-18T18:00:00+08:00' });
    const id = await seedRegistration(ME, 'registered', singapore);
    await db.exec("set local timezone = 'Asia/Singapore'");
    await at(time);
    if (hint) await expect(check(id)).rejects.toMatchObject({ code: '55000', hint });
    else await expect(check(id)).resolves.toBeDefined();
  });

  it('SCRUM27_AC2_refuses_when_the_event_has_no_withdrawal_deadline', async () => {
    const noDeadline = await withdrawableEvent({ registration_withdrawal_deadline: null });
    const id = await seedRegistration(ME, 'registered', noDeadline);
    await expect(check(id)).rejects.toMatchObject({ code: '55000', hint: 'WITHDRAWAL_DEADLINE_NOT_SET' });
  });

  it('SCRUM27_AC2_uses_the_database_clock_without_a_supplied_time', async () => {
    const day = 86_400_000;
    const live = await withdrawableEvent({
      registration_opens_at: new Date(Date.now() - day),
      registration_withdrawal_deadline: new Date(Date.now() + day),
      proposed_start: new Date(Date.now() + 2 * day),
    });
    const id = await seedRegistration(ME, 'registered', live);
    await db.exec('set local search_path = pg_catalog, public');
    await expect(check(id)).resolves.toBeDefined();
  });

  it('SCRUM27_AC7_an_eligible_check_changes_no_registration_or_event', async () => {
    const id = await seedRegistration();
    await seedRegistration(OTHER, 'waitlisted');
    const before = await eventState();
    await check(id);
    expect(await eventState()).toEqual(before);
  });

  // A refusal raises, which rolls back anything the transaction did, so a state
  // comparison after one proves nothing; what does is the check never writing.
  it('SCRUM27_AC7_the_check_never_writes_so_a_refusal_cannot_change_state', async () => {
    const source = (await functionSources(db)).assert_registration_withdrawable
      .replace(/--[^\n]*/g, '');
    expect(source).not.toMatch(/\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b/i);
  });
});
