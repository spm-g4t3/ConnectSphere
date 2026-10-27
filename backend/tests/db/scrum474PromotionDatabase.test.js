import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createSchemaDb, seedEvent, functionSources } from './helpers/schemaDb.js';
import { withSafetyReviewTransitionGuardDisabled } from '../fixtures/safetyReviewTestHelpers.js';

// Promotion from the waiting list (037) on a stubbed clock: the one shared
// operation, its triggers, its atomicity and its notification. PGlite has one
// connection, so true two-session races are in eventWaitingListConcurrency.manual.sql;
// the lock-order checks below are what makes those races safe.
const ORGANISER = '11111111-1111-4111-8111-111111111111';
const COORDINATOR = '22222222-2222-4222-8222-222222222222';
const A = '44444444-4444-4444-8444-444444444444';
const B = '55555555-5555-4555-8555-555555555555';
const C = '66666666-6666-4666-8666-666666666666';
const D = '77777777-7777-4777-8777-777777777777';
const E = '88888888-8888-4888-8888-888888888888';
const OPENS = '2026-10-10T10:00:00Z';
const DEADLINE = '2026-10-18T10:00:00Z';
let db;
let event;

const at = (instant) => db.query("select set_config('test.now', $1, true)", [instant]);
const result = async (sql, params) => (await db.query(sql, params)).rows[0].result;
const register = (attendee) => result('select register_for_event($1::uuid, $2::uuid) as result', [event, attendee]);
const join = (attendee) => result('select join_event_waitlist($1::uuid, $2::uuid) as result', [event, attendee]);
const withdraw = async (attendee) => result(
  'select withdraw_registration($1::uuid, $2::uuid) as result', [(await row(attendee)).id, attendee],
);
const promote = async () => (await db.query('select promote_waitlisted_registrations($1) as n', [event])).rows[0].n;
const setup = (capacity, extra = {}) => result(
  'select setup_event_registration($1, $2, true, $3, $4, $5, $6, true) as result',
  [event, ORGANISER, OPENS, extra.closesAt ?? null, capacity, DEADLINE],
);
const setEvent = (fields) => db.query(
  `update event_requests set ${Object.keys(fields).map((key, i) => `${key} = $${i + 2}`).join(', ')} where id = $1`,
  [event, ...Object.values(fields)],
);
const row = async (attendee) => (await db.query(
  'select * from event_registrations where event_request_id = $1 and attendee_id = $2', [event, attendee],
)).rows[0];
const statuses = async () => Object.fromEntries((await db.query(
  'select attendee_id, status from event_registrations where event_request_id = $1', [event],
)).rows.map((r) => [r.attendee_id, r.status]));
const registeredCount = async () => Number((await db.query(
  "select count(*) as n from event_registrations where event_request_id = $1 and status = 'registered'", [event],
)).rows[0].n);
const notices = async () => (await db.query(
  `select recipient_id, event_request_id from notifications
    where type = 'registration_promoted' order by created_at, recipient_id`,
)).rows;
// A registered, then B, C and D queued a minute apart: the queue is B, C, D.
async function fullWithQueue() {
  await register(A);
  for (const [attendee, minute] of [[B, 1], [C, 2], [D, 3]]) {
    await at(`2026-10-16T10:0${minute}:00Z`);
    await join(attendee);
  }
  await at('2026-10-16T10:10:00Z');
}

beforeAll(async () => {
  db = await createSchemaDb();
  const attendees = [A, B, C, D, E];
  await db.query('insert into auth.users (id) select unnest($1::uuid[])', [[ORGANISER, COORDINATOR, ...attendees]]);
  await db.query("insert into profiles (id, role) values ($1, 'event_organiser'), ($2, 'event_coordinator')", [ORGANISER, COORDINATOR]);
  await db.query("insert into profiles (id, role) select unnest($1::uuid[]), 'attendee'", [attendees]);
  event = await seedEvent(db, {
    status: 'confirmed',
    organiser_id: ORGANISER,
    reviewing_coordinator_id: COORDINATOR,
    event_name: 'Promotion event',
    proposed_start: '2026-10-20T10:00:00Z',
    registration_enabled: true,
    registration_opens_at: OPENS,
    registration_capacity: 1,
    registration_withdrawal_deadline: DEADLINE,
    registration_waitlist_enabled: true,
  });
  await db.exec(`
    create function public.clock_timestamp() returns timestamptz language sql
      as $$ select current_setting('test.now')::timestamptz $$;
    set search_path = public, pg_catalog;
    alter function setup_event_registration(uuid, uuid, boolean, timestamptz, timestamptz, integer, timestamptz, boolean)
      set search_path = public, pg_catalog;
    -- Fails a notification insert on demand, to prove a promotion rolls back whole.
    create function fail_test_notification() returns trigger language plpgsql as $$
    begin
      if current_setting('test.fail_notification', true) = 'on' then
        raise exception 'Injected notification failure';
      end if;
      return new;
    end;
    $$;
    create trigger fail_test_notification before insert on notifications
      for each row execute function fail_test_notification();
  `);
});
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec('begin');
  await at('2026-10-16T10:00:00Z');
});
afterEach(async () => { await db.exec('rollback'); });

describe('SCRUM474 one shared promotion operation', () => {
  it('SCRUM474_AC1_every_path_that_frees_a_place_calls_the_same_function_and_nothing_else_promotes', async () => {
    const sources = await functionSources(db);
    const callers = Object.keys(sources).filter((name) => sources[name].includes('promote_waitlisted_registrations('));
    expect(callers.sort()).toEqual([
      'join_event_waitlist', 'promote_waitlist_on_confirmation', 'register_for_event',
      'setup_event_registration', 'withdraw_registration',
    ]);
    // Only the shared operation turns a waitlisted row into a registered one.
    const promoters = Object.keys(sources)
      .filter((name) => /set status = 'registered'[^;]*status = 'waitlisted'/.test(sources[name]));
    expect(promoters).toEqual(['promote_waitlisted_registrations']);
  });
});

describe('SCRUM474 who is promoted, and when', () => {
  it('SCRUM474_AC2_AC3_one_released_place_promotes_exactly_the_earliest_entry', async () => {
    await fullWithQueue();
    const withdrawn = await withdraw(A);
    expect(await statuses()).toEqual({ [A]: 'withdrawn', [B]: 'registered', [C]: 'waitlisted', [D]: 'waitlisted' });
    expect(withdrawn).toMatchObject({ registeredCount: 1, capacity: 1 });
    expect((await row(B)).registered_at.toISOString()).toBe('2026-10-16T10:10:00.000Z');
  });

  it.each([
    ['the event is no longer Confirmed', () => withSafetyReviewTransitionGuardDisabled(db, () => setEvent({ status: 'approved' }))],
    ['registration is switched off', () => setEvent({ registration_enabled: false })],
    ['registration has closed', () => setEvent({ registration_closes_at: '2026-10-16T10:05:00Z' })],
  ])('SCRUM474_AC2_nobody_is_promoted_while_%s', async (_case, arrange) => {
    await fullWithQueue();
    await arrange();
    await withdraw(A);
    expect(await statuses()).toMatchObject({ [B]: 'waitlisted', [C]: 'waitlisted', [D]: 'waitlisted' });
    expect(await notices()).toEqual([]);
  });

  it('SCRUM474_AC4_several_places_promote_that_many_in_queue_order', async () => {
    await fullWithQueue();
    expect(await setup(3)).toMatchObject({ registeredCount: 3, waitlistCount: 1 });
    expect(await statuses()).toEqual({ [A]: 'registered', [B]: 'registered', [C]: 'registered', [D]: 'waitlisted' });
  });

  it('SCRUM474_AC4_more_places_than_people_promotes_everyone_and_no_more', async () => {
    await fullWithQueue();
    await setup(10);
    expect(await registeredCount()).toBe(4);
    expect(await promote()).toBe(0);
  });
});

describe('SCRUM474 atomic and repeatable', () => {
  it('SCRUM474_AC5_AC11_a_failure_after_promotion_undoes_the_withdrawal_promotion_and_notice_together', async () => {
    await fullWithQueue();
    await db.query("select set_config('test.fail_notification', 'on', true)");
    await db.exec('savepoint attempt');
    await expect(withdraw(A)).rejects.toThrow('Injected notification failure');
    await db.exec('rollback to savepoint attempt');
    await db.query("select set_config('test.fail_notification', 'off', true)");
    expect(await statuses()).toEqual({ [A]: 'registered', [B]: 'waitlisted', [C]: 'waitlisted', [D]: 'waitlisted' });
    expect(await notices()).toEqual([]);
  });

  it('SCRUM474_AC7_processing_the_same_release_again_allocates_nothing', async () => {
    await fullWithQueue();
    await withdraw(A);
    expect(await promote()).toBe(0);
    await db.exec('savepoint retry');
    await expect(withdraw(A)).rejects.toMatchObject({ code: '55000', hint: 'ALREADY_WITHDRAWN' });
    await db.exec('rollback to savepoint retry');
    await setup(1);
    expect(await registeredCount()).toBe(1);
    expect(await notices()).toHaveLength(1);
  });
});

describe('SCRUM474 registration cannot jump the queue', () => {
  // A place released while registration was closed is still free when it reopens.
  async function freePlaceWhileClosed() {
    await fullWithQueue();
    await setEvent({ registration_closes_at: '2026-10-16T10:05:00Z' });
    await withdraw(A);
    await setEvent({ registration_closes_at: null });
    expect(await registeredCount()).toBe(0);
  }

  it('SCRUM474_AC9_a_newcomer_registering_finds_the_place_already_given_to_the_queue', async () => {
    await freePlaceWhileClosed();
    expect(await register(E)).toEqual({ outcome: 'capacity_reached' });
    expect(await statuses()).toMatchObject({ [B]: 'registered', [C]: 'waitlisted' });
    expect(await row(E)).toBeUndefined();
  });

  it('SCRUM474_AC9_a_newcomer_joining_queues_behind_those_already_waiting', async () => {
    await freePlaceWhileClosed();
    expect(await join(E)).toMatchObject({ outcome: 'waitlisted', registration: { waitlistPosition: 3 } });
    expect((await row(B)).status).toBe('registered');
  });

  it('SCRUM474_AC9_a_return_to_confirmed_promotes_into_places_freed_meanwhile', async () => {
    await fullWithQueue();
    await withSafetyReviewTransitionGuardDisabled(db, () => setEvent({ status: 'approved' }));
    await withdraw(A);
    expect((await row(B)).status).toBe('waitlisted');
    await withSafetyReviewTransitionGuardDisabled(db, () => setEvent({ status: 'confirmed' }));
    expect(await statuses()).toMatchObject({ [B]: 'registered', [C]: 'waitlisted' });
  });
});

describe('SCRUM474 lock order, the basis of the concurrency guarantees', () => {
  // Every function that writes registrations, or promotes, must hold the event
  // row before it touches a registration row. With one lock taken first by all
  // of them, competing transactions queue on the event and cannot deadlock.
  const EVENT_LOCK = {
    register_for_event: 'assert_event_registration_eligible(',
    join_event_waitlist: 'assert_event_registration_eligible(',
    withdraw_registration: 'assert_registration_withdrawable(',
    leave_event_waitlist: 'from event_requests where id = v_event_id for update',
    assert_registration_withdrawable: /from event_requests\s+where id = v_event_id\s+for update/,
    promote_waitlisted_registrations: /from event_requests\s+where id = p_event_request_id\s+for update/,
    setup_event_registration: /from event_requests\s+where id = p_event_request_id\s+for update/,
  };
  const indexOf = (source, marker) => (typeof marker === 'string' ? source.indexOf(marker) : source.search(marker));
  const REGISTRATION_TOUCH = /update event_registrations|insert into event_registrations|from event_registrations[^;]*for update|promote_waitlisted_registrations\(/;

  it('SCRUM474_AC6_AC8_every_registration_writer_is_known_and_locks_the_event_first', async () => {
    const sources = await functionSources(db);
    const writers = Object.keys(sources).filter((name) => REGISTRATION_TOUCH.test(sources[name])
      && name !== 'promote_waitlist_on_confirmation');
    expect(writers.sort()).toEqual(Object.keys(EVENT_LOCK).sort());
    for (const [name, marker] of Object.entries(EVENT_LOCK)) {
      const lock = indexOf(sources[name], marker);
      const touch = name === 'promote_waitlisted_registrations'
        ? sources[name].search(/from event_registrations/)
        : sources[name].search(REGISTRATION_TOUCH);
      expect({ name, locksFirst: lock >= 0 && lock < touch }).toEqual({ name, locksFirst: true });
    }
  });

  it.each([
    ['assert_event_registration_eligible', /from event_requests e\s+where e\.id = p_event_request_id\s+for update/],
    ['assert_registration_withdrawable', /from event_requests\s+where id = v_event_id\s+for update/],
  ])('SCRUM474_AC8_%s_takes_the_event_row_before_any_registration_row', async (name, eventLock) => {
    const source = (await functionSources(db))[name];
    const lock = source.search(eventLock);
    const registrationLock = source.search(/from event_registrations[^;]*for update/);
    expect(lock).toBeGreaterThanOrEqual(0);
    if (registrationLock >= 0) expect(lock).toBeLessThan(registrationLock);
  });

  it('SCRUM474_AC6_the_confirmation_trigger_runs_inside_the_status_change_that_holds_the_event_row', async () => {
    const { rows } = await db.query(
      `select tgname, pg_get_triggerdef(oid) as def from pg_trigger
        where tgrelid = 'event_requests'::regclass and tgname = 'event_requests_promote_waitlist_on_confirmation'`,
    );
    expect(rows[0].def).toMatch(/AFTER UPDATE OF status ON public\.event_requests FOR EACH ROW/);
  });
});

describe('SCRUM474 the promoted attendee is notified', () => {
  it('SCRUM474_AC10_one_durable_in_app_notice_names_the_attendee_and_event', async () => {
    await fullWithQueue();
    await withdraw(A);
    const { rows } = await db.query("select * from notifications where type = 'registration_promoted'");
    expect(rows).toEqual([expect.objectContaining({
      recipient_id: B,
      event_request_id: event,
      read_at: null,
      payload: {
        eventRequestId: event, eventName: 'Promotion event', registrationId: (await row(B)).id,
        waitlistedAt: '2026-10-16T10:01:00.000000Z',
      },
    })]);
  });

  it('SCRUM474_AC12_a_retried_promotion_of_the_same_entry_cannot_notify_twice', async () => {
    await fullWithQueue();
    await withdraw(A);
    const entry = await row(B);
    // Replay the same queue entry, as a retry would: same registration, same join
    // time. The stamping trigger would give it a new time, so it is held off here.
    await db.query('alter table event_registrations disable trigger event_registrations_stamp_waitlisted_at');
    await db.query("update event_registrations set status = 'waitlisted' where id = $1", [entry.id]);
    await db.query('alter table event_registrations enable trigger event_registrations_stamp_waitlisted_at');
    await db.query("update event_registrations set status = 'withdrawn' where attendee_id = $1 and event_request_id = $2",
      [C, event]);
    await db.query('set local timezone = \'Asia/Singapore\'');
    await setup(1);
    expect((await row(B)).status).toBe('registered');
    expect(await notices()).toEqual([{ recipient_id: B, event_request_id: event }]);
  });

  it('SCRUM474_AC12_rejoining_later_is_a_new_entry_and_is_notified_again', async () => {
    await fullWithQueue();
    await withdraw(A);
    await at('2026-10-16T11:00:00Z');
    await withdraw(B);
    await at('2026-10-16T11:30:00Z');
    await join(B);
    await withdraw(C);
    await withdraw(D);
    // One transaction here, so created_at ties; compare the set of notices.
    expect((await notices()).map((n) => n.recipient_id).sort()).toEqual([B, B, C, D]);
  });
});
