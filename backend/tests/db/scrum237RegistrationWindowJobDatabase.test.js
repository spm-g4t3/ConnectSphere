import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';
import { withSafetyReviewTransitionGuardDisabled } from '../fixtures/safetyReviewTestHelpers.js';

// The opening/closing job (042), process_registration_window_notices, on an
// injected clock: clock_timestamp() reads test.now, as in the promotion tests.
const ORGANISER = '11111111-1111-4111-8111-111111111111';
const COORDINATOR = '22222222-2222-4222-8222-222222222222';
const A = '44444444-4444-4444-8444-444444444444';
const B = '55555555-5555-4555-8555-555555555555';
const OPENS = '2026-11-01T10:00:00.000Z';
const CLOSES = '2026-11-10T10:00:00.000Z';
const START = '2026-11-20T10:00:00.000Z';
const JUST_BEFORE = (instant) => new Date(Date.parse(instant) - 1).toISOString();
const LATER = (instant, hours) => new Date(Date.parse(instant) + hours * 3_600_000).toISOString();
let db;
let event;

const at = (instant) => db.query("select set_config('test.now', $1, true)", [instant]);
const run = async () => (await db.query('select process_registration_window_notices() as r')).rows[0].r;
const seedOpenable = (overrides = {}) => seedEvent(db, {
  status: 'confirmed',
  organiser_id: ORGANISER,
  reviewing_coordinator_id: COORDINATOR,
  event_name: 'Window event',
  proposed_start: START,
  registration_enabled: true,
  registration_opens_at: OPENS,
  registration_closes_at: CLOSES,
  registration_capacity: 1,
  registration_waitlist_enabled: true,
  ...overrides,
});
const setEvent = (fields, id = event) => db.query(
  `update event_requests set ${Object.keys(fields).map((key, i) => `${key} = $${i + 2}`).join(', ')} where id = $1`,
  [id, ...Object.values(fields)],
);
const enrol = (attendee, status, id = event) => db.query(
  'insert into event_registrations (event_request_id, attendee_id, status) values ($1, $2, $3)',
  [id, attendee, status],
);
const notices = async (type, id = event) => (await db.query(
  `select recipient_id, payload from notifications where type = $1 and event_request_id = $2
    order by payload->>'audience', recipient_id`, [type, id],
)).rows;
const audiences = async (type, id) => (await notices(type, id)).map((n) => n.payload.audience);

beforeAll(async () => {
  db = await createSchemaDb();
  await db.query('insert into auth.users (id) select unnest($1::uuid[])', [[ORGANISER, COORDINATOR, A, B]]);
  await db.query("insert into profiles (id, role) values ($1, 'event_organiser'), ($2, 'event_coordinator')", [ORGANISER, COORDINATOR]);
  await db.query("insert into profiles (id, role) select unnest($1::uuid[]), 'attendee'", [[A, B]]);
  await db.exec(`
    create function public.clock_timestamp() returns timestamptz language sql
      as $$ select current_setting('test.now')::timestamptz $$;
    set search_path = public, pg_catalog;
    -- Fails notices for one event on demand, to prove the others still go.
    create function fail_test_window_notice() returns trigger language plpgsql as $$
    begin
      if new.event_request_id::text = current_setting('test.fail_event', true) then
        raise exception 'Injected notice failure';
      end if;
      return new;
    end;
    $$;
    create trigger fail_test_window_notice before insert on notifications
      for each row execute function fail_test_window_notice();
  `);
}, 60_000);
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec('begin');
  await at(JUST_BEFORE(OPENS));
  event = await seedOpenable();
  // A holds the one place and B queues: seeded directly, as registration is not open yet.
  await enrol(A, 'registered');
  await enrol(B, 'waitlisted');
});
afterEach(async () => { await db.exec('rollback'); });

describe('the opening boundary', () => {
  it('SCRUM177_AC1_nothing_is_sent_just_before_the_opening_time', async () => {
    expect(await run()).toEqual({ notified: 0, events: 0, failures: [] });
  });

  it('SCRUM177_AC1_the_opening_time_itself_is_open_and_announced', async () => {
    await at(OPENS);

    expect(await run()).toEqual({ notified: 3, events: 1, failures: [] });
    expect(await audiences('registration_opened')).toEqual(['coordinator', 'organiser', 'waitlisted']);
    const [{ payload }] = await notices('registration_opened');
    expect(payload).toMatchObject({
      cause: 'opening_time', opensAt: OPENS.replace('.000Z', '.000000Z'),
      closesAt: CLOSES.replace('.000Z', '.000000Z'), occurrenceKey: 'opened:1',
    });
  });

  it('SCRUM177_AC1_a_run_after_the_boundary_still_announces_it_once', async () => {
    await at(LATER(OPENS, 5));
    expect((await run()).notified).toBe(3);

    await at(LATER(OPENS, 6));
    expect(await run()).toEqual({ notified: 0, events: 0, failures: [] });
  });
});

describe('the closing boundary', () => {
  beforeEach(async () => {
    await at(OPENS);
    await run();
  });

  it('SCRUM177_AC1_closes_at_the_closing_time_not_before', async () => {
    await at(JUST_BEFORE(CLOSES));
    expect((await run()).notified).toBe(0);

    await at(CLOSES);
    expect((await run()).notified).toBe(3);
    const [{ payload }] = await notices('registration_closed');
    expect(payload).toMatchObject({
      cause: 'closing_time', closedAt: CLOSES.replace('.000Z', '.000000Z'), occurrenceKey: 'closed:2',
    });
  });

  it('SCRUM177_AC1_with_no_closing_time_it_closes_when_the_event_starts_and_spares_the_queue', async () => {
    await setEvent({ registration_closes_at: null });
    await at(JUST_BEFORE(START));
    expect((await run()).notified).toBe(0);

    await at(START);
    expect((await run()).notified).toBe(2);
    expect(await audiences('registration_closed')).toEqual(['coordinator', 'organiser']);
    expect((await notices('registration_closed'))[0].payload.cause).toBe('event_started');
  });

  it('SCRUM177_AC1_after_downtime_past_close_and_start_one_closing_is_sent', async () => {
    await at(LATER(START, 48));

    expect((await run()).notified).toBe(3);
    expect((await notices('registration_closed'))[0].payload.cause).toBe('closing_time');
    expect((await run()).notified).toBe(0);
  });
});

describe('downtime recovery', () => {
  it('SCRUM177_AC1_a_window_that_opened_and_closed_while_down_is_not_announced_late', async () => {
    await at(LATER(CLOSES, 1));

    expect(await run()).toEqual({ notified: 0, events: 0, failures: [] });
  });

  it('SCRUM177_AC1_an_opening_missed_while_down_is_announced_on_the_first_run', async () => {
    await at(LATER(OPENS, 72));

    expect((await run()).notified).toBe(3);
  });
});

describe('settings changed before the boundary', () => {
  it('SCRUM177_AC1_a_closing_time_moved_later_does_not_close_at_the_old_time', async () => {
    await at(OPENS);
    await run();
    const extended = LATER(CLOSES, 24);
    await setEvent({ registration_closes_at: extended });

    await at(CLOSES);
    expect((await run()).notified).toBe(0);
    await at(extended);
    expect((await run()).notified).toBe(3);
  });

  it('SCRUM177_AC1_an_opening_time_moved_later_does_not_open_at_the_old_time', async () => {
    await setEvent({ registration_opens_at: LATER(OPENS, 24) });

    await at(OPENS);
    expect((await run()).notified).toBe(0);
  });

  it('SCRUM177_AC1_registration_switched_off_before_opening_sends_nothing', async () => {
    await setEvent({ registration_enabled: false });

    await at(OPENS);
    expect((await run()).notified).toBe(0);
  });

  it('SCRUM177_AC1_a_change_a_flow_already_announced_is_not_announced_again_by_the_job', async () => {
    await at(OPENS);
    await db.query("select announce_registration_window($1, 'settings_changed')", [event]);

    expect((await run()).notified).toBe(0);
    expect(await notices('registration_opened')).toHaveLength(2);
  });
});

describe('ineligible events', () => {
  it.each([
    ['not confirmed', { status: 'approved' }],
    ['missing a start', { proposed_start: null, registration_closes_at: null }],
  ])('SCRUM177_AC1_an_event_%s_never_opens', async (_name, overrides) => {
    await db.query('delete from event_registrations');
    await db.query('delete from event_requests where id = $1', [event]);
    const ineligible = await withSafetyReviewTransitionGuardDisabled(db, () => seedOpenable(overrides));

    await at(OPENS);
    expect((await run()).notified).toBe(0);
    expect(await notices('registration_opened', ineligible)).toEqual([]);
  });

  it('SCRUM177_AC1_the_schema_refuses_enabled_registration_with_no_opening_time', async () => {
    await db.exec('savepoint refusal');
    await expect(setEvent({ registration_opens_at: null, registration_closes_at: null }))
      .rejects.toMatchObject({ code: '23514' });
    await db.exec('rollback to savepoint refusal');
  });

  it('SCRUM177_AC1_a_cancelled_event_is_settled_without_a_closing_notice', async () => {
    await at(OPENS);
    await run();
    await withSafetyReviewTransitionGuardDisabled(db, () => setEvent({ status: 'cancelled' }));

    // Since 043 the cancellation itself settles it, so the job finds nothing due.
    await at(LATER(OPENS, 1));
    expect(await run()).toEqual({ notified: 0, events: 0, failures: [] });
    expect(await notices('registration_closed')).toEqual([]);
  });
});

describe('ordering, keys and failures', () => {
  it('SCRUM177_AC3_a_queued_attendee_given_a_freed_place_is_told_that_not_that_it_opened', async () => {
    await setEvent({ registration_capacity: 2 });

    await at(OPENS);
    await run();

    expect((await notices('registration_promoted')).map((n) => n.recipient_id)).toEqual([B]);
    expect(await audiences('registration_opened')).toEqual(['coordinator', 'organiser']);
    expect(await audiences('registration_capacity_reached')).toEqual(['coordinator', 'organiser']);
  });

  it('SCRUM177_AC1_a_rolled_back_run_is_retried_with_the_same_occurrence_key', async () => {
    await at(OPENS);
    await db.exec('savepoint run');
    await run();
    await db.exec('rollback to savepoint run');

    await run();
    expect((await notices('registration_opened')).map((n) => n.payload.occurrenceKey))
      .toEqual(['opened:1', 'opened:1', 'opened:1']);
  });

  it('SCRUM177_AC1_reopening_is_a_new_occurrence_with_a_new_key', async () => {
    await at(OPENS);
    await run();
    await setEvent({ registration_enabled: false });
    await at(LATER(OPENS, 1));
    await run();
    await setEvent({ registration_enabled: true });
    await at(LATER(OPENS, 2));
    await run();

    expect((await notices('registration_opened')).map((n) => n.payload.occurrenceKey).sort())
      .toEqual(['opened:1', 'opened:1', 'opened:1', 'opened:3', 'opened:3', 'opened:3']);
  });

  it('SCRUM177_AC1_one_failing_event_is_reported_and_retried_without_stopping_the_others', async () => {
    const second = await seedOpenable({ event_name: 'Second event' });
    await db.query("select set_config('test.fail_event', $1, true)", [event]);

    await at(OPENS);
    const result = await run();
    expect(result.notified).toBe(2);
    expect(result.failures).toEqual([{ eventRequestId: event, message: 'Injected notice failure' }]);
    expect(await notices('registration_opened', second)).toHaveLength(2);
    expect(await notices('registration_opened')).toEqual([]);

    await db.query("select set_config('test.fail_event', '', true)");
    expect((await run()).notified).toBe(3);
  });
});
