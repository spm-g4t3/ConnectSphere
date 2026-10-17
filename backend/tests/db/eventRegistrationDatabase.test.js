import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name) => readFileSync(resolve(here, '../../db/migrations', name), 'utf8');
const START = '2030-01-01T12:00:00Z';

describe('SCRUM-363: event registration in Postgres', () => {
  let db;
  let organiser;
  let attendee;
  let secondAttendee;
  let eventId;

  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create schema auth;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text);
      create role anon;
      create role authenticated;
      create role service_role;
    `);
    await db.exec(migration('001_event_requests.sql'));
    await db.exec(`
      create table profiles (
        id uuid primary key references auth.users(id),
        role text not null
      );
    `);
    await db.exec(migration('050_event_registration.sql'));
    await db.exec(migration('079_event_registration.sql'));
    await db.exec(migration('084_registration_schedule_guard.sql'));

    organiser = (await one("insert into auth.users (email) values ('organiser@test') returning id")).id;
    attendee = (await one("insert into auth.users (email) values ('attendee@test') returning id")).id;
    secondAttendee = (await one("insert into auth.users (email) values ('second-attendee@test') returning id")).id;
    await db.query(
      `insert into profiles (id, role) values
         ($1, 'event_organiser'), ($2, 'attendee'), ($3, 'attendee')`,
      [organiser, attendee, secondAttendee],
    );
    eventId = (await one(
      `insert into event_requests (organiser_id, event_name, status, proposed_start, proposed_end)
       values ($1, 'Registration test', 'approved', $2, '2030-01-01T14:00:00Z') returning id`,
      [organiser, START],
    )).id;
  });

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM494_AC1_collects_all_related_date_and_capacity_faults', async () => {
    await db.query("update event_requests set status = 'approved' where id = $1", [eventId]);
    const result = await one(
      `select setup_event_registration($1, $2, true, $3, $4, 0, $5) as result`,
      [
        eventId,
        organiser,
        '2030-01-01T13:00:00Z',
        '2030-01-01T13:00:00Z',
        '2030-01-01T13:00:00Z',
      ],
    );
    expect(result.result.outcome).toBe('invalid');
    expect(result.result.details.map((item) => item.field)).toEqual([
      'registrationOpensAt',
      'registrationClosesAt',
      'registrationWithdrawalDeadline',
      'registrationCapacity',
    ]);
    const unchanged = await one('select registration_enabled from event_requests where id = $1', [eventId]);
    expect(unchanged.registration_enabled).toBe(false);
  });

  it('SCRUM494_AC2_persists_settings_and_allows_only_confirmed_active_registrations', async () => {
    const saved = await one(
      `select setup_event_registration($1, $2, true, $3, $4, 2, $5) as result`,
      [
        eventId,
        organiser,
        new Date(Date.now() - 60_000).toISOString(),
        '2030-01-01T12:00:00Z',
        '2030-01-01T11:00:00Z',
      ],
    );
    expect(saved.result.outcome).toBe('saved');
    expect(saved.result.registeredCount).toBe(0);

    const history = await one(
      'select changed_by, old_values, new_values from event_registration_settings_history where event_request_id = $1',
      [eventId],
    );
    expect(history.changed_by).toBe(organiser);
    expect(history.old_values.enabled).toBe(false);
    expect(history.new_values.enabled).toBe(true);

    const notConfirmed = await one(
      'select register_for_event($1, $2) as result',
      [eventId, attendee],
    );
    expect(notConfirmed.result.outcome).toBe('event_not_confirmed');

    await db.query("update event_requests set status = 'confirmed' where id = $1", [eventId]);
    const registered = await one(
      'select register_for_event($1, $2) as result',
      [eventId, attendee],
    );
    expect(registered.result.outcome).toBe('registered');
    expect(registered.result.registeredCount).toBe(1);
    const openEvent = await one('select * from list_open_registration_events($1)', [attendee]);
    expect(openEvent.registered_count).toBe(1);
    expect(openEvent.is_registered).toBe(true);

    await db.query("update event_requests set status = 'approved' where id = $1", [eventId]);
    const blockedDuringReview = await one(
      'select register_for_event($1, $2) as result',
      [eventId, secondAttendee],
    );
    expect(blockedDuringReview.result.outcome).toBe('event_not_confirmed');
    const retained = await one(
      `select registration_enabled, registration_capacity,
              (select count(*) from event_registrations where event_request_id = $1) as registered_count
         from event_requests where id = $1`,
      [eventId],
    );
    expect(retained.registration_enabled).toBe(true);
    expect(retained.registration_capacity).toBe(2);
    expect(Number(retained.registered_count)).toBe(1);
    expect((await db.query('select * from list_open_registration_events($1)', [attendee])).rows).toHaveLength(0);

    await db.query("update event_requests set status = 'confirmed' where id = $1", [eventId]);
    const secondRegistration = await one(
      'select register_for_event($1, $2) as result',
      [eventId, secondAttendee],
    );
    expect(secondRegistration.result.outcome).toBe('registered');
    expect(secondRegistration.result.registeredCount).toBe(2);

    const belowCurrentCount = await one(
      `select setup_event_registration($1, $2, true, $3, $4, 1, $5) as result`,
      [
        eventId,
        organiser,
        new Date(Date.now() - 60_000).toISOString(),
        '2030-01-01T12:00:00Z',
        '2030-01-01T11:00:00Z',
      ],
    );
    expect(belowCurrentCount.result.outcome).toBe('invalid');
    expect(belowCurrentCount.result.details).toContainEqual(expect.objectContaining({
      field: 'registrationCapacity',
    }));

    const duplicate = await one(
      'select register_for_event($1, $2) as result',
      [eventId, attendee],
    );
    expect(duplicate.result.outcome).toBe('already_registered');

    expect((await db.query('select * from list_open_registration_events($1)', [attendee])).rows).toHaveLength(1);
  });

  it('SCRUM494_AC3_requires_the_organiser_role_and_preserves_capacity_locks', async () => {
    const refused = await one(
      `select setup_event_registration($1, $2, false, $3, $4, 1, null) as result`,
      [
        eventId,
        attendee,
        '2029-12-01T00:00:00Z',
        '2030-01-01T12:00:00Z',
      ],
    );
    expect(refused.result.outcome).toBe('forbidden');

    const wrongRole = await one(
      'select setup_event_registration($1, $2, false, $3, $4, 1, null) as result',
      [
        eventId,
        secondAttendee,
        '2029-12-01T00:00:00Z',
        '2030-01-01T12:00:00Z',
      ],
    );
    expect(wrongRole.result.outcome).toBe('forbidden');

    const nullCaller = await one(
      'select setup_event_registration($1, null, false, $2, $3, 1, null) as result',
      [eventId, '2029-12-01T00:00:00Z', '2030-01-01T12:00:00Z'],
    );
    expect(nullCaller.result.outcome).toBe('forbidden');

    const nullRegistration = await one(
      'select register_for_event($1, null) as result',
      [eventId],
    );
    expect(nullRegistration.result.outcome).toBe('forbidden');

    const wrongRoleRegistration = await one(
      'select register_for_event($1, $2) as result',
      [eventId, organiser],
    );
    expect(wrongRoleRegistration.result.outcome).toBe('forbidden');

    await expect(db.query(
      'select * from list_open_registration_events($1)',
      [organiser],
    )).rejects.toMatchObject({ code: '42501' });
    await expect(db.query(
      'select * from list_open_registration_events(null)',
    )).rejects.toMatchObject({ code: '22023' });

    const source = migration('079_event_registration.sql').toLowerCase();
    for (const functionName of ['setup_event_registration', 'register_for_event']) {
      const bodyStart = source.indexOf(`create or replace function ${functionName}`);
      const bodyEnd = source.indexOf('$$;', source.indexOf('$$', bodyStart) + 2);
      expect(source.slice(bodyStart, bodyEnd)).toMatch(/for update/);
    }
  });

  it('SCRUM494_AC4_lists_only_events_open_for_registration', async () => {
    const disabledEvent = (await one(
      `insert into event_requests (organiser_id, event_name, status, proposed_start, proposed_end)
       values ($1, 'Disabled registration', 'confirmed', $2, '2030-01-01T14:00:00Z')
       returning id`,
      [organiser, START],
    )).id;
    const disabledResult = await one(
      'select register_for_event($1, $2) as result',
      [disabledEvent, secondAttendee],
    );
    expect(disabledResult.result.outcome).toBe('registration_closed');

    const futureEvent = (await one(
      `insert into event_requests (organiser_id, event_name, status, proposed_start, proposed_end)
       values ($1, 'Future registration window', 'confirmed', $2, '2030-01-01T14:00:00Z')
       returning id`,
      [organiser, START],
    )).id;
    const futureSettings = await one(
      `select setup_event_registration($1, $2, true, $3, $4, null, null) as result`,
      [
        futureEvent,
        organiser,
        '2029-12-01T00:00:00Z',
        '2030-01-01T12:00:00Z',
      ],
    );
    expect(futureSettings.result.outcome).toBe('saved');

    const beforeOpening = await one(
      'select register_for_event($1, $2) as result',
      [futureEvent, secondAttendee],
    );
    expect(beforeOpening.result.outcome).toBe('registration_closed');
    const listed = await db.query(
      'select id from list_open_registration_events($1) where id = $2',
      [secondAttendee, futureEvent],
    );
    expect(listed.rows).toHaveLength(0);
  });

  it('SCRUM494_AC5_does_not_count_withdrawn_registrations_toward_capacity', async () => {
    await db.query(
      `update event_registrations set status = 'withdrawn'
        where event_request_id = $1 and attendee_id = $2`,
      [eventId, attendee],
    );
    const settings = await one(
      `select setup_event_registration($1, $2, true, $3, $4, 1, $5) as result`,
      [
        eventId,
        organiser,
        new Date(Date.now() - 60_000).toISOString(),
        '2030-01-01T12:00:00Z',
        '2030-01-01T11:00:00Z',
      ],
    );
    expect(settings.result.outcome).toBe('saved');
    expect(settings.result.registeredCount).toBe(1);
  });

  it('SCRUM494_AC1_keeps_registration_date_invariants_on_a_proposed_start_change', async () => {
    const scheduleEvent = (await one(
      `insert into event_requests (organiser_id, event_name, status, proposed_start, proposed_end)
       values ($1, 'Schedule conflict', 'confirmed', $2, '2030-01-01T14:00:00Z')
       returning id`,
      [organiser, START],
    )).id;

    const withClosingConflict = await one(
      `select setup_event_registration($1, $2, true, $3, $4, null, $5) as result`,
      [
        scheduleEvent,
        organiser,
        '2029-12-01T00:00:00Z',
        START,
        '2030-01-01T11:00:00Z',
      ],
    );
    expect(withClosingConflict.result.outcome).toBe('saved');
    await expect(db.query(
      "update event_requests set proposed_start = '2030-01-01T11:00:00Z' where id = $1",
      [scheduleEvent],
    )).rejects.toMatchObject({ code: '23514' });

    const withWithdrawalConflict = await one(
      `select setup_event_registration($1, $2, true, $3, $4, null, $5) as result`,
      [
        scheduleEvent,
        organiser,
        '2029-12-01T00:00:00Z',
        '2030-01-01T10:00:00Z',
        '2030-01-01T11:30:00Z',
      ],
    );
    expect(withWithdrawalConflict.result.outcome).toBe('saved');
    await expect(db.query(
      "update event_requests set proposed_start = '2030-01-01T11:00:00Z' where id = $1",
      [scheduleEvent],
    )).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining('registration withdrawal deadline'),
    });
  });

  it('SCRUM494_AC1_allows_switching_registration_off_with_the_window_cleared', async () => {
    const offEvent = (await one(
      `insert into event_requests (organiser_id, event_name, status, proposed_start, proposed_end)
       values ($1, 'Switch off', 'approved', $2, '2030-01-01T14:00:00Z')
       returning id`,
      [organiser, START],
    )).id;
    const on = await one(
      `select setup_event_registration($1, $2, true, $3, $4, null, null) as result`,
      [offEvent, organiser, '2029-12-01T00:00:00Z', '2030-01-01T10:00:00Z'],
    );
    expect(on.result.outcome).toBe('saved');

    const off = await one(
      'select setup_event_registration($1, $2, false, null, null, null, null) as result',
      [offEvent, organiser],
    );
    expect(off.result.outcome).toBe('saved');

    const enabledWithoutDates = await one(
      'select setup_event_registration($1, $2, true, null, null, null, null) as result',
      [offEvent, organiser],
    );
    expect(enabledWithoutDates.result.outcome).toBe('invalid');

    const halfSet = await one(
      'select setup_event_registration($1, $2, false, $3, null, null, null) as result',
      [offEvent, organiser, '2029-12-01T00:00:00Z'],
    );
    expect(halfSet.result.outcome).toBe('invalid');
  });
});
