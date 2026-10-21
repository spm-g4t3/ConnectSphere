import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { isOpenForRegistration } from '../../src/domain/registrationWindow.js';
import { STATUS } from '../../src/domain/eventRequestStatus.js';
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';

// assert_event_registration_eligible against the final schema, on a stubbed clock.
const ME = '44444444-4444-4444-8444-444444444444';
const EVENT = '00000000-0000-4000-8000-00000000000a';
const COORDINATOR = '66666666-6666-4666-8666-666666666666';
const MISSING = '99999999-9999-4999-8999-999999999999';
const NOW = '2026-10-16T10:00:00Z';
let db;
// An event open for registration from 15 to 17 October, starting on the 20th.
const registrationEvent = (overrides = {}) => seedEvent(db, {
  status: 'confirmed',
  organiser_id: ME,
  reviewing_coordinator_id: COORDINATOR,
  event_name: 'Event',
  proposed_start: '2026-10-20T10:00:00Z',
  registration_enabled: true,
  registration_opens_at: '2026-10-15T10:00:00Z',
  registration_closes_at: '2026-10-17T10:00:00Z',
  ...overrides,
});
const check = (event = EVENT, attendee = ME) => db.query(
  'select assert_event_registration_eligible($1::uuid, $2::uuid)', [event, attendee],
);

beforeAll(async () => {
  db = await createSchemaDb();
  await db.query('insert into auth.users (id) values ($1), ($2)', [ME, COORDINATOR]);
  await db.query("insert into profiles (id, role) values ($1, 'attendee'), ($2, 'event_coordinator')", [ME, COORDINATOR]);
  await registrationEvent({ id: EVENT });
  // Override the clock only in this test database to exercise exact boundaries
  // without adding a caller-controlled time argument to the production function.
  await db.exec(`
    create function public.clock_timestamp() returns timestamptz language sql
      as $$ select current_setting('test.registration_time')::timestamptz $$;
    set search_path = public, pg_catalog;
  `);
});
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec('begin');
  await db.query("select set_config('test.registration_time', $1, true)", [NOW]);
});
afterEach(async () => { await db.exec('rollback'); });

describe('SCRUM38 registration eligibility in PostgreSQL', () => {
  it('SCRUM38_AC1_accepts_an_attendee_using_the_API_role', async () => {
    await db.exec('set local role service_role');
    await expect(check()).resolves.toBeDefined();
  });

  it('SCRUM38_AC1_refuses_a_null_caller', async () => {
    await expect(check(EVENT, null)).rejects.toMatchObject({ code: '22023' });
  });

  it.each(['event_organiser', 'event_coordinator', 'venue_staff', 'technical_support_staff'])
    ('SCRUM38_AC1_refuses_the_stored_role_%s', async (role) => {
      await db.query('update profiles set role = $1 where id = $2', [role, ME]);
      await expect(check()).rejects.toMatchObject({ code: '42501', message: 'This action is restricted to Attendees' });
    });

  it('SCRUM38_AC1_refuses_an_account_without_an_attendee_profile', async () => {
    await expect(check(EVENT, MISSING)).rejects.toMatchObject({ code: '42501' });
  });

  it.each(['anon', 'authenticated'])('SCRUM38_AC1_denies_direct_function_access_to_%s', async (role) => {
    await db.exec(`set local role ${role}`);
    await expect(check()).rejects.toMatchObject({ code: '42501', message: 'permission denied for function assert_event_registration_eligible' });
  });

  it('SCRUM38_AC2_refuses_an_unknown_event', async () => {
    await expect(check(MISSING)).rejects.toMatchObject({ code: 'P0002', message: 'Event not found' });
  });

  it.each(Object.values(STATUS).filter((status) => status !== STATUS.CONFIRMED))
    ('SCRUM38_AC2_refuses_event_status_%s', async (status) => {
      const event = await registrationEvent({ status });
      await expect(check(event)).rejects.toMatchObject({ code: '55000', hint: 'EVENT_NOT_CONFIRMED' });
    });

  it.each([false])('SCRUM38_AC3_refuses_registration_enabled_%s', async (enabled) => {
    await db.query('update event_requests set registration_enabled = $1 where id = $2', [enabled, EVENT]);
    await expect(check()).rejects.toMatchObject({ code: '55000', hint: 'REGISTRATION_DISABLED' });
  });

  it.each([
    ['before opening', '2026-10-15T09:59:59.999Z', 'REGISTRATION_NOT_OPEN'],
    ['exactly at opening', '2026-10-15T10:00:00Z', null],
    ['one millisecond before closing', '2026-10-17T09:59:59.999Z', null],
    ['exactly at closing', '2026-10-17T10:00:00Z', 'REGISTRATION_CLOSED'],
    ['after closing', '2026-10-17T10:00:00.001Z', 'REGISTRATION_CLOSED'],
    ['opening in Singapore time', '2026-10-15T18:00:00+08:00', null],
    ['closing in Singapore time', '2026-10-17T18:00:00+08:00', 'REGISTRATION_CLOSED'],
  ])('SCRUM38_AC4_checks_%s_and_agrees_with_browse', async (_label, instant, reason) => {
    await db.query("select set_config('test.registration_time', $1, true)", [instant]);
    expect(isOpenForRegistration({
      status: STATUS.CONFIRMED, registrationEnabled: true,
      registrationOpensAt: '2026-10-15T10:00:00Z',
      registrationClosesAt: '2026-10-17T10:00:00Z', startsAt: '2026-10-20T10:00:00Z',
    }, new Date(instant))).toBe(reason === null);
    if (reason) await expect(check()).rejects.toMatchObject({ code: '55000', hint: reason });
    else await expect(check()).resolves.toBeDefined();
  });

  it('SCRUM22_AC2_open_ended_registration_closes_at_event_start_and_matches_browse', async () => {
    await db.query('update event_requests set registration_closes_at = null where id = $1', [EVENT]);
    await expect(check()).resolves.toBeDefined();
    const settings = { status: 'confirmed', registrationEnabled: true, registrationOpensAt: '2026-10-15T10:00:00Z', registrationClosesAt: null, startsAt: '2026-10-20T10:00:00Z' };
    expect(isOpenForRegistration(settings, new Date(NOW))).toBe(true);
    await db.query("select set_config('test.registration_time', '2026-10-20T10:00:00Z', true)");
    await expect(check()).rejects.toMatchObject({ code: '55000', hint: 'EVENT_STARTED' });
    expect(isOpenForRegistration(settings, new Date(settings.startsAt))).toBe(false);
  });

  it('SCRUM38_AC4_shared_schema_refuses_a_missing_registration_opening', async () => {
    await expect(db.query('update event_requests set registration_opens_at = null where id = $1', [EVENT]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('SCRUM22_AC2_refuses_registration_for_an_event_with_no_start', async () => {
    const event = await registrationEvent({ proposed_start: null });
    await expect(check(event)).rejects.toMatchObject({ code: '55000', hint: 'REGISTRATION_DATES_MISSING' });
  });

  it('SCRUM38_AC5_requires_no_additional_eligibility_information', async () => {
    // This account has only its id and Attendee role; even full_name is absent.
    await expect(check()).resolves.toBeDefined();
  });

  it('SCRUM38_AC6_rechecks_current_settings_after_a_successful_preflight', async () => {
    await check();
    await db.query('update event_requests set registration_enabled = false where id = $1', [EVENT]);
    await expect(check()).rejects.toMatchObject({ code: '55000', hint: 'REGISTRATION_DISABLED' });
  });

  it('SCRUM38_AC4_uses_the_database_clock_without_a_supplied_time', async () => {
    const day = 86_400_000;
    // A confirmed event's start is locked, so this one is seeded around the real clock.
    const event = await registrationEvent({
      registration_opens_at: new Date(Date.now() - day),
      registration_closes_at: new Date(Date.now() + day),
      proposed_start: new Date(Date.now() + 2 * day),
    });
    await db.exec('set local search_path = pg_catalog, public');
    await expect(check(event)).resolves.toBeDefined();
  });
});
