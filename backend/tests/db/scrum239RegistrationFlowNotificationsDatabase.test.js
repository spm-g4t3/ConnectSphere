import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createSchemaDb, seedEvent, functionSources } from './helpers/schemaDb.js';
import { withSafetyReviewTransitionGuardDisabled } from '../fixtures/safetyReviewTestHelpers.js';

// The registration flows sending their notices (048), driven through the real
// functions the API calls, on an injected clock (test.now). PGlite has one
// connection, so concurrent releases are run back to back here and the lock
// order that makes them safe is checked from the sources; the two-session
// races are in eventWaitingListConcurrency.manual.sql.
const ORGANISER = '11111111-1111-4111-8111-111111111111';
const COORDINATOR = '22222222-2222-4222-8222-222222222222';
const A = '44444444-4444-4444-8444-444444444444';
const B = '55555555-5555-4555-8555-555555555555';
const C = '66666666-6666-4666-8666-666666666666';
const D = '77777777-7777-4777-8777-777777777777';
const OPENS = '2026-11-01T10:00:00Z';
const CLOSES = '2026-11-10T10:00:00Z';
const DEADLINE = '2026-11-15T10:00:00Z';
const START = '2026-11-20T10:00:00Z';
let db;
let event;

const at = (instant) => db.query("select set_config('test.now', $1, true)", [instant]);
const result = async (sql, params) => (await db.query(sql, params)).rows[0].result;
const register = (attendee) => result('select register_for_event($1::uuid, $2::uuid) as result', [event, attendee]);
const join = (attendee) => result('select join_event_waitlist($1::uuid, $2::uuid) as result', [event, attendee]);
const registrationId = async (attendee) => (await db.query(
  'select id from event_registrations where event_request_id = $1 and attendee_id = $2', [event, attendee],
)).rows[0].id;
const withdraw = async (attendee) => result(
  'select withdraw_registration($1::uuid, $2::uuid) as result', [await registrationId(attendee), attendee],
);
const setup = (settings = {}) => result(
  'select setup_event_registration($1, $2, $3, $4, $5, $6, $7, true) as result',
  [event, settings.user ?? ORGANISER, settings.enabled ?? true, OPENS, settings.closesAt ?? CLOSES,
    'capacity' in settings ? settings.capacity : 1, DEADLINE],
);
const setEvent = (fields) => db.query(
  `update event_requests set ${Object.keys(fields).map((key, i) => `${key} = $${i + 2}`).join(', ')} where id = $1`,
  [event, ...Object.values(fields)],
);
const statuses = async () => Object.fromEntries((await db.query(
  'select attendee_id, status from event_registrations where event_request_id = $1', [event],
)).rows.map((r) => [r.attendee_id, r.status]));
// Every notice sent, as [type, audience or null, recipient]. created_at is the
// transaction's start, the same for every row here, so the order is by content.
const sent = async () => (await db.query(
  `select type, payload->>'audience' as audience, recipient_id from notifications
    order by type, payload->>'audience', recipient_id`,
)).rows.map((r) => [r.type, r.audience, r.recipient_id]);
const sentExcept = async (type) => (await sent()).filter(([t]) => t !== type);
const STAFF = (type) => [[type, 'coordinator', COORDINATOR], [type, 'organiser', ORGANISER]];
async function refusalCode(sql, params) {
  await db.exec('savepoint refusal');
  try {
    await db.query(sql, params);
  } catch (error) {
    await db.exec('rollback to savepoint refusal');
    return error.code;
  }
  await db.exec('release savepoint refusal');
  return null;
}

beforeAll(async () => {
  db = await createSchemaDb();
  const attendees = [A, B, C, D];
  await db.query('insert into auth.users (id) select unnest($1::uuid[])', [[ORGANISER, COORDINATOR, ...attendees]]);
  await db.query("insert into profiles (id, role) values ($1, 'event_organiser'), ($2, 'event_coordinator')", [ORGANISER, COORDINATOR]);
  await db.query("insert into profiles (id, role) select unnest($1::uuid[]), 'attendee'", [attendees]);
  await db.exec(`
    create function public.clock_timestamp() returns timestamptz language sql
      as $$ select current_setting('test.now')::timestamptz $$;
    set search_path = public, pg_catalog;
    alter function setup_event_registration(uuid, uuid, boolean, timestamptz, timestamptz, integer, timestamptz, boolean)
      set search_path = public, pg_catalog;
    create function fail_test_flow_notice() returns trigger language plpgsql as $$
    begin
      if current_setting('test.fail_notification', true) = 'on' then
        raise exception 'Injected notification failure';
      end if;
      return new;
    end;
    $$;
    create trigger fail_test_flow_notice before insert on notifications
      for each row execute function fail_test_flow_notice();
  `);
}, 60_000);
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec('begin');
  await at('2026-11-05T10:00:00Z');
  event = await seedEvent(db, {
    status: 'confirmed',
    organiser_id: ORGANISER,
    reviewing_coordinator_id: COORDINATOR,
    event_name: 'Flow event',
    proposed_start: START,
    registration_enabled: true,
    registration_opens_at: OPENS,
    registration_closes_at: CLOSES,
    registration_capacity: 1,
    registration_withdrawal_deadline: DEADLINE,
    registration_waitlist_enabled: true,
  });
  // Registration opened before these tests begin, and that was announced.
  await db.query('insert into registration_notice_state (event_request_id, open_announced, window_generation) values ($1, true, 1)', [event]);
});
afterEach(async () => { await db.exec('rollback'); });

describe('reaching capacity', () => {
  it('SCRUM177_AC2_the_registration_that_fills_the_event_tells_the_managers_once', async () => {
    await setEvent({ registration_capacity: 2 });
    await register(A);
    expect(await sent()).toEqual([]);

    await register(B);
    expect(await sent()).toEqual(STAFF('registration_capacity_reached'));
    const { rows: [{ payload }] } = await db.query("select payload from notifications where type = 'registration_capacity_reached' limit 1");
    expect(payload).toMatchObject({ capacity: 2, registeredCount: 2, eventName: 'Flow event' });

    expect(await register(C)).toEqual({ outcome: 'capacity_reached' });
    expect(await sent()).toHaveLength(2);
  });

  it('SCRUM177_AC2_a_join_that_finds_room_registers_and_fills_the_event', async () => {
    expect(await join(A)).toMatchObject({ outcome: 'registered' });
    expect(await sent()).toEqual(STAFF('registration_capacity_reached'));
  });

  it('SCRUM177_AC3_joining_the_queue_is_the_attendees_own_act_and_sends_nothing_new', async () => {
    await register(A);
    expect(await join(B)).toMatchObject({ outcome: 'waitlisted', created: true });
    expect(await sent()).toEqual(STAFF('registration_capacity_reached'));
  });
});

describe('withdrawal', () => {
  it('SCRUM177_AC4_with_no_queue_the_managers_are_told_a_place_is_free_and_the_counts_hold', async () => {
    await register(A);

    expect(await withdraw(A)).toMatchObject({ outcome: 'withdrawn', registeredCount: 0, capacity: 1 });
    expect(await sentExcept('registration_capacity_reached')).toEqual(STAFF('registration_place_released'));
    const { rows: [{ payload }] } = await db.query("select payload from notifications where type = 'registration_place_released' limit 1");
    expect(payload).toMatchObject({ cause: 'withdrawal', capacity: 1, registeredCount: 0 });
  });

  it('SCRUM177_AC3_AC4_with_a_queue_the_first_waiting_is_promoted_and_told_and_nothing_is_reported_free', async () => {
    await register(A);
    await join(B);
    await at('2026-11-05T10:01:00Z');
    await join(C);

    expect(await withdraw(A)).toMatchObject({ registeredCount: 1 });
    expect(await statuses()).toMatchObject({ [A]: 'withdrawn', [B]: 'registered', [C]: 'waitlisted' });
    expect(await sentExcept('registration_capacity_reached')).toEqual([['registration_promoted', null, B]]);
  });

  it('SCRUM177_AC4_while_registration_is_closed_the_queue_waits_and_the_managers_are_told', async () => {
    await register(A);
    await join(B);
    await at('2026-11-12T10:00:00Z');

    await withdraw(A);
    expect(await statuses()).toMatchObject({ [B]: 'waitlisted' });
    expect(await sentExcept('registration_capacity_reached')).toEqual(STAFF('registration_place_released'));
  });

  it('SCRUM177_AC4_withdrawing_from_an_event_that_was_not_full_sends_nothing', async () => {
    await setEvent({ registration_capacity: 3 });
    await register(A);

    await withdraw(A);
    expect(await sent()).toEqual([]);
  });

  it('SCRUM177_AC4_two_releases_back_to_back_promote_once_then_report_one_free_place', async () => {
    await setEvent({ registration_capacity: 2 });
    await register(A);
    await register(B);
    await join(C);

    await withdraw(A);
    await withdraw(B);

    expect(await statuses()).toMatchObject({ [A]: 'withdrawn', [B]: 'withdrawn', [C]: 'registered' });
    expect(await sentExcept('registration_capacity_reached')).toEqual([
      ...STAFF('registration_place_released'),
      ['registration_promoted', null, C],
    ]);
  });
});

describe('settings changes', () => {
  it('SCRUM177_AC3_a_higher_capacity_promotes_in_queue_order_and_tells_each_attendee_promoted', async () => {
    await register(A);
    for (const [attendee, minute] of [[B, 1], [C, 2], [D, 3]]) {
      await at(`2026-11-05T10:0${minute}:00Z`);
      await join(attendee);
    }

    expect(await setup({ capacity: 3 })).toMatchObject({ outcome: 'saved', registeredCount: 3, waitlistCount: 1 });
    expect(await statuses()).toMatchObject({ [B]: 'registered', [C]: 'registered', [D]: 'waitlisted' });
    expect(await sentExcept('registration_capacity_reached')).toEqual([
      ['registration_promoted', null, B], ['registration_promoted', null, C],
    ]);
    expect(await sent()).toHaveLength(4);
  });

  it('SCRUM177_AC2_a_capacity_lowered_to_the_registered_count_tells_only_the_coordinator', async () => {
    await setEvent({ registration_capacity: 3 });
    await register(A);

    await setup({ capacity: 1 });
    expect(await sent()).toEqual([['registration_capacity_reached', 'coordinator', COORDINATOR]]);
  });

  it('SCRUM177_AC2_raising_capacity_with_nobody_waiting_sends_nothing', async () => {
    await register(A);
    await setup({ capacity: 5 });
    expect(await sent()).toEqual(STAFF('registration_capacity_reached'));
  });

  it('SCRUM177_AC1_switching_registration_off_tells_the_coordinator_and_queue_not_the_organiser', async () => {
    await register(A);
    await join(B);

    await setup({ enabled: false, closesAt: null });
    expect(await sentExcept('registration_capacity_reached')).toEqual([
      ['registration_closed', 'coordinator', COORDINATOR],
      ['registration_closed', 'waitlisted', B],
    ]);
  });

  it('SCRUM177_AC1_an_unchanged_save_sends_nothing', async () => {
    await setup();
    await setup();
    expect(await sent()).toEqual([]);
  });
});

describe('event status', () => {
  it('SCRUM177_AC1_leaving_and_returning_to_confirmed_close_and_reopen_registration', async () => {
    await register(A);
    await join(B);

    await withSafetyReviewTransitionGuardDisabled(db, () => setEvent({ status: 'approved' }));
    await withdraw(A);
    await withSafetyReviewTransitionGuardDisabled(db, () => setEvent({ status: 'confirmed' }));

    expect(await statuses()).toMatchObject({ [B]: 'registered' });
    const after = await sent();
    expect(after.filter(([type]) => type === 'registration_closed')).toEqual([
      ['registration_closed', 'coordinator', COORDINATOR],
      ['registration_closed', 'organiser', ORGANISER],
      ['registration_closed', 'waitlisted', B],
    ]);
    // B was promoted on the return, so B is told of the place, not of the reopening.
    expect(after.filter(([type]) => type === 'registration_opened')).toEqual(STAFF('registration_opened'));
    expect(after.filter(([type]) => type === 'registration_promoted')).toEqual([['registration_promoted', null, B]]);
  });

  it('SCRUM177_AC2_the_promotion_job_announces_a_capacity_its_promotion_filled', async () => {
    await register(A);
    await join(B);
    // Freed while closed: nobody is promoted, so the managers hear a place is free.
    await at('2026-11-12T10:00:00Z');
    await withdraw(A);
    // Reopened with no registration write: only the job hands the place out.
    await setEvent({ registration_closes_at: '2026-11-14T10:00:00Z' });

    expect((await db.query('select process_waitlist_promotions() as n')).rows[0].n).toBe(1);
    expect((await db.query(
      "select count(*)::int as n from notifications where type = 'registration_capacity_reached'",
    )).rows[0].n).toBe(4);
    expect(await sentExcept('registration_capacity_reached')).toEqual([
      ...STAFF('registration_place_released'),
      ['registration_promoted', null, B],
    ]);
  });
});

describe('rejected and rolled back operations', () => {
  it.each([
    ['registering before registration opens', async () => { await at('2026-10-01T10:00:00Z'); return register(A); }, { outcome: 'not_found' }],
    ['registering twice', async () => { await setEvent({ registration_capacity: 5 }); await register(A); return register(A); }, { outcome: 'already_registered' }],
    ['saving invalid settings', () => setup({ capacity: 0 }), { outcome: 'invalid' }],
    ['saving as someone else', () => setup({ user: COORDINATOR }), { outcome: 'forbidden' }],
  ])('SCRUM177_AC6_%s_sends_nothing', async (_name, act, outcome) => {
    expect(await act()).toMatchObject(outcome);
    expect(await sent()).toEqual([]);
  });

  it('SCRUM177_AC4_a_refused_withdrawal_sends_nothing', async () => {
    await register(A);
    const sql = 'select withdraw_registration($1::uuid, $2::uuid)';

    expect(await refusalCode(sql, [await registrationId(A), B])).not.toBeNull();
    await withdraw(A);
    expect(await refusalCode(sql, [await registrationId(A), A])).not.toBeNull();
    expect((await sent()).filter(([type]) => type === 'registration_place_released')).toHaveLength(2);
  });

  it('SCRUM177_AC4_a_rolled_back_withdrawal_leaves_no_notice_and_is_announced_when_it_succeeds', async () => {
    await register(A);
    await join(B);
    await db.exec('savepoint op');
    await withdraw(A);
    await db.exec('rollback to savepoint op');

    expect(await statuses()).toMatchObject({ [A]: 'registered', [B]: 'waitlisted' });
    expect(await sent()).toEqual(STAFF('registration_capacity_reached'));

    await withdraw(A);
    expect(await sentExcept('registration_capacity_reached')).toEqual([['registration_promoted', null, B]]);
    expect(await sent()).toHaveLength(3);
  });

  it('SCRUM177_AC4_a_notice_that_cannot_be_stored_fails_the_withdrawal_rather_than_being_lost', async () => {
    await register(A);
    await db.query("select set_config('test.fail_notification', 'on', true)");

    expect(await refusalCode('select withdraw_registration($1::uuid, $2::uuid)', [await registrationId(A), A])).toBe('P0001');
    await db.query("select set_config('test.fail_notification', 'off', true)");
    expect(await statuses()).toMatchObject({ [A]: 'registered' });
    expect(await sent()).toEqual(STAFF('registration_capacity_reached'));
  });
});

describe('lock order', () => {
  it('SCRUM177_AC4_each_handler_takes_the_event_row_before_its_notice_state', async () => {
    const sources = await functionSources(db);
    for (const name of ['announce_registration_capacity', 'announce_registration_window']) {
      const eventLock = sources[name].search(/from event_requests where id = p_event_request_id for update/);
      const stateLock = sources[name].search(/from registration_notice_state[^;]*for update/);
      expect({ name, eventFirst: eventLock >= 0 && eventLock < stateLock }).toEqual({ name, eventFirst: true });
    }
  });

  it('SCRUM177_AC4_each_flow_announces_after_its_promotion', async () => {
    const sources = await functionSources(db);
    for (const name of ['withdraw_registration', 'setup_event_registration', 'promote_waitlist_on_confirmation']) {
      const promote = sources[name].indexOf('promote_waitlisted_registrations(');
      const announce = sources[name].indexOf('announce_registration_');
      expect({ name, promotesFirst: promote >= 0 && promote < announce }).toEqual({ name, promotesFirst: true });
    }
  });
});
