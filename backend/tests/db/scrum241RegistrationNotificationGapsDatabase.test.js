import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';

// SCRUM-241: what the earlier SCRUM-177 suites left open. Events whose waiting
// list is off; every notice of a whole registration lifecycle naming its event
// and reaching only that event's people; and the database refusing client roles
// both the rows and the writers. Real flow functions on an injected clock.
const ORGANISER = '11111111-1111-4111-8111-111111111111';
const COORDINATOR = '22222222-2222-4222-8222-222222222222';
const OTHER_ORGANISER = '33333333-3333-4333-8333-333333333333';
const A = '44444444-4444-4444-8444-444444444444';
const B = '55555555-5555-4555-8555-555555555555';
const C = '66666666-6666-4666-8666-666666666666';
const STRANGER = '77777777-7777-4777-8777-777777777777';
const OPENS = '2026-11-01T10:00:00Z';
const CLOSES = '2026-11-10T10:00:00Z';
const DEADLINE = '2026-11-15T10:00:00Z';
const START = '2026-11-20T10:00:00Z';
let db;
let event;

const at = (instant) => db.query("select set_config('test.now', $1, true)", [instant]);
const result = async (sql, params) => (await db.query(sql, params)).rows[0].result;
const register = (attendee, id = event) => result('select register_for_event($1::uuid, $2::uuid) as result', [id, attendee]);
const join = (attendee, id = event) => result('select join_event_waitlist($1::uuid, $2::uuid) as result', [id, attendee]);
const registrationId = async (attendee) => (await db.query(
  'select id from event_registrations where event_request_id = $1 and attendee_id = $2', [event, attendee],
)).rows[0].id;
const withdraw = async (attendee) => result(
  'select withdraw_registration($1::uuid, $2::uuid) as result', [await registrationId(attendee), attendee],
);
const save = ({ capacity = 1, waitlist = false, enabled = true } = {}) => result(
  'select setup_event_registration($1, $2, $3, $4, $5, $6, $7, $8) as result',
  [event, ORGANISER, enabled, OPENS, enabled ? CLOSES : null, capacity, DEADLINE, waitlist],
);
const run = () => db.query('select process_registration_window_notices()');
const seed = (overrides = {}) => seedEvent(db, {
  status: 'confirmed',
  organiser_id: ORGANISER,
  reviewing_coordinator_id: COORDINATOR,
  event_name: 'Lifecycle event',
  proposed_start: START,
  registration_enabled: true,
  registration_opens_at: OPENS,
  registration_closes_at: CLOSES,
  registration_capacity: 1,
  registration_withdrawal_deadline: DEADLINE,
  registration_waitlist_enabled: false,
  ...overrides,
});
const rows = async () => (await db.query(
  `select type, recipient_id, event_request_id, payload from notifications
    order by type, payload->>'occurrenceKey', payload->>'audience', recipient_id`,
)).rows;
const sent = async () => (await rows()).map((r) => [r.type, r.payload.audience ?? null, r.recipient_id]);
const STAFF = (type) => [[type, 'coordinator', COORDINATOR], [type, 'organiser', ORGANISER]];
async function errorCode(sql, params = []) {
  await db.exec('savepoint attempt');
  try {
    await db.query(sql, params);
  } catch (error) {
    await db.exec('rollback to savepoint attempt');
    return error.code;
  }
  await db.exec('release savepoint attempt');
  return null;
}

beforeAll(async () => {
  db = await createSchemaDb();
  const attendees = [A, B, C, STRANGER];
  await db.query('insert into auth.users (id) select unnest($1::uuid[])', [[ORGANISER, COORDINATOR, OTHER_ORGANISER, ...attendees]]);
  await db.query(
    "insert into profiles (id, role) values ($1, 'event_organiser'), ($2, 'event_coordinator'), ($3, 'event_organiser')",
    [ORGANISER, COORDINATOR, OTHER_ORGANISER],
  );
  await db.query("insert into profiles (id, role) select unnest($1::uuid[]), 'attendee'", [attendees]);
  await db.exec(`
    create function public.clock_timestamp() returns timestamptz language sql
      as $$ select current_setting('test.now')::timestamptz $$;
    set search_path = public, pg_catalog;
    alter function setup_event_registration(uuid, uuid, boolean, timestamptz, timestamptz, integer, timestamptz, boolean)
      set search_path = public, pg_catalog;
  `);
}, 60_000);
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec('begin');
  await at('2026-10-31T10:00:00Z');
  event = await seed();
});
afterEach(async () => { await db.exec('rollback'); });

describe('an event with no waiting list', () => {
  it('SCRUM177_AC1_opening_and_closing_tell_only_the_managers_when_nobody_can_queue', async () => {
    await at(OPENS);
    await run();
    await at(CLOSES);
    await run();

    expect(await sent()).toEqual([...STAFF('registration_closed'), ...STAFF('registration_opened')]);
  });

  it('SCRUM177_AC2_filling_it_tells_the_managers_and_a_refused_join_sends_nothing_more', async () => {
    await at(OPENS);
    await run();
    await register(A);

    expect(await join(B)).toEqual({ outcome: 'waitlist_disabled' });
    expect(await register(B)).toEqual({ outcome: 'capacity_reached' });
    expect((await sent()).filter(([type]) => type !== 'registration_opened'))
      .toEqual(STAFF('registration_capacity_reached'));
  });

  it('SCRUM177_AC4_a_withdrawal_frees_a_place_for_anyone_and_the_managers_are_told', async () => {
    await at(OPENS);
    await run();
    await register(A);

    expect(await withdraw(A)).toMatchObject({ outcome: 'withdrawn', registeredCount: 0, capacity: 1 });
    expect((await sent()).filter(([type]) => type === 'registration_place_released'))
      .toEqual(STAFF('registration_place_released'));
    expect(await register(B)).toMatchObject({ outcome: 'registered' });
  });

  it('SCRUM177_AC3_switching_the_list_off_keeps_the_queue_and_still_promotes_and_tells_it', async () => {
    await at(OPENS);
    await save({ waitlist: true });
    await register(A);
    await join(B);
    await save({ waitlist: false });

    expect(await join(C)).toEqual({ outcome: 'waitlist_disabled' });
    await withdraw(A);
    expect((await sent()).filter(([type]) => type === 'registration_promoted')).toEqual([['registration_promoted', null, B]]);
    expect((await sent()).filter(([type]) => type === 'registration_place_released')).toEqual([]);
  });
});

describe('a whole registration lifecycle', () => {
  // Opens, fills, queues, frees a place to the queue, frees one to nobody,
  // closes; beside it another event with its own people.
  async function lifecycle() {
    const other = await seed({ organiser_id: OTHER_ORGANISER, event_name: 'Other event', registration_waitlist_enabled: true });
    await at(OPENS);
    await save({ capacity: 1, waitlist: true });
    await run();
    await register(A);
    await join(B);
    await register(STRANGER, other);
    await withdraw(A);
    await withdraw(B);
    await at(CLOSES);
    await run();
    return other;
  }

  it('SCRUM177_AC5_every_notice_names_its_event_by_id_and_name', async () => {
    const other = await lifecycle();

    const ours = (await rows()).filter((r) => r.event_request_id === event);
    expect(new Set(ours.map((r) => r.type))).toEqual(new Set([
      'registration_opened', 'registration_capacity_reached', 'registration_promoted',
      'registration_place_released', 'registration_closed',
    ]));
    for (const row of ours) {
      expect({ type: row.type, eventRequestId: row.payload.eventRequestId, eventName: row.payload.eventName })
        .toEqual({ type: row.type, eventRequestId: event, eventName: 'Lifecycle event' });
    }
    expect((await rows()).filter((r) => r.event_request_id === other).every((r) => r.payload.eventName === 'Other event')).toBe(true);
  });

  it('SCRUM177_AC6_only_this_events_managers_queue_and_promoted_attendee_receive_its_notices', async () => {
    await lifecycle();

    const recipients = new Set((await rows()).filter((r) => r.event_request_id === event).map((r) => r.recipient_id));
    expect(recipients).toEqual(new Set([ORGANISER, COORDINATOR, B]));
    expect((await rows()).some((r) => [A, C, STRANGER, OTHER_ORGANISER].includes(r.recipient_id) && r.event_request_id === event)).toBe(false);
  });

  it('SCRUM177_AC6_the_attendee_who_withdraws_or_registers_is_never_notified_of_their_own_act', async () => {
    await lifecycle();

    expect((await rows()).filter((r) => r.recipient_id === A)).toEqual([]);
  });
});

describe('client roles cannot reach registration notices', () => {
  it.each(['anon', 'authenticated'])('SCRUM177_AC6_%s_reads_no_notification_rows_directly', async (role) => {
    await at(OPENS);
    await run();
    expect((await rows()).length).toBeGreaterThan(0);

    await db.exec(`set local role ${role}`);
    const { rows: visible } = await db.query('select id from notifications');
    await db.exec('reset role');
    expect(visible).toEqual([]);
  });

  it.each([
    ['notify_registration_change', "select notify_registration_change($1, 'registration_opened', array['organiser'], 'k', '{\"cause\": \"opening_time\"}')"],
    ['registration_notification_recipients', "select * from registration_notification_recipients($1, array['waitlisted'])"],
    ['announce_registration_window', 'select announce_registration_window($1, null)'],
    ['announce_registration_capacity', "select announce_registration_capacity($1, 'registration')"],
    ['process_registration_window_notices', 'select process_registration_window_notices() where $1::uuid is not null'],
  ])('SCRUM177_AC6_authenticated_cannot_call_%s', async (_name, sql) => {
    await db.exec('set local role authenticated');
    const code = await errorCode(sql, [event]);
    await db.exec('reset role');
    expect(code).toBe('42501');
  });
});
