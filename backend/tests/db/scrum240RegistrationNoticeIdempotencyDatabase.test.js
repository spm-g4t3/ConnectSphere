import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';

// Registration notices are sent once per occurrence (049): repeated and
// retried runs, a stale writer, both paths for one transition, edited dates
// and later windows, on an injected clock (test.now). Simultaneous workers on
// separate connections are in registrationNoticeRaces.realdb.test.js.
const ORGANISER = '11111111-1111-4111-8111-111111111111';
const COORDINATOR = '22222222-2222-4222-8222-222222222222';
const A = '44444444-4444-4444-8444-444444444444';
const B = '55555555-5555-4555-8555-555555555555';
const OPENS = '2026-11-01T10:00:00Z';
const CLOSES = '2026-11-10T10:00:00Z';
const DEADLINE = '2026-11-15T10:00:00Z';
const START = '2026-11-20T10:00:00Z';
const HOUR = 3_600_000;
const after = (instant, hours) => new Date(Date.parse(instant) + hours * HOUR).toISOString();
let db;
let event;

const at = (instant) => db.query("select set_config('test.now', $1, true)", [instant]);
const run = async () => (await db.query('select process_registration_window_notices() as r')).rows[0].r;
const setEvent = (fields, id = event) => db.query(
  `update event_requests set ${Object.keys(fields).map((key, i) => `${key} = $${i + 2}`).join(', ')} where id = $1`,
  [id, ...Object.values(fields)],
);
const seed = (name = 'Idempotent event') => seedEvent(db, {
  status: 'confirmed',
  organiser_id: ORGANISER,
  reviewing_coordinator_id: COORDINATOR,
  event_name: name,
  proposed_start: START,
  registration_enabled: true,
  registration_opens_at: OPENS,
  registration_closes_at: CLOSES,
  registration_capacity: 1,
  registration_withdrawal_deadline: DEADLINE,
  registration_waitlist_enabled: true,
});
const state = async (id = event) => (await db.query(
  'select open_announced, window_generation, full_announced, capacity_generation from registration_notice_state where event_request_id = $1',
  [id],
)).rows[0] ?? null;
// Every notice for the event, as 'type key audience', sorted.
const sent = async (id = event) => (await db.query(
  `select type || ' ' || (payload->>'occurrenceKey') || ' ' || coalesce(payload->>'audience', recipient_id::text) as n
     from notifications where event_request_id = $1 and type <> 'registration_promoted' order by 1`, [id],
)).rows.map((r) => r.n);
const fail = (recipient) => db.query("select set_config('test.fail_recipient', $1, true)", [recipient ?? '']);
const registrationId = async (attendee) => (await db.query(
  'select id from event_registrations where event_request_id = $1 and attendee_id = $2', [event, attendee],
)).rows[0].id;
async function errorCode(sql, params) {
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
  await db.query('insert into auth.users (id) select unnest($1::uuid[])', [[ORGANISER, COORDINATOR, A, B]]);
  await db.query("insert into profiles (id, role) values ($1, 'event_organiser'), ($2, 'event_coordinator')", [ORGANISER, COORDINATOR]);
  await db.query("insert into profiles (id, role) select unnest($1::uuid[]), 'attendee'", [[A, B]]);
  await db.exec(`
    create function public.clock_timestamp() returns timestamptz language sql
      as $$ select current_setting('test.now')::timestamptz $$;
    set search_path = public, pg_catalog;
    alter function setup_event_registration(uuid, uuid, boolean, timestamptz, timestamptz, integer, timestamptz, boolean)
      set search_path = public, pg_catalog;
    -- Fails the notice to one recipient, after others in the same run were written.
    create function fail_test_recipient() returns trigger language plpgsql as $$
    begin
      if new.recipient_id::text = current_setting('test.fail_recipient', true) then
        raise exception 'Injected failure for one recipient';
      end if;
      return new;
    end;
    $$;
    create trigger fail_test_recipient before insert on notifications
      for each row execute function fail_test_recipient();
  `);
}, 60_000);
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec('begin');
  await at('2026-10-31T10:00:00Z');
  event = await seed();
  // A holds the one place and B queues for it, so an opening has a queue to tell.
  await db.query(
    "insert into event_registrations (event_request_id, attendee_id, status) values ($1, $2, 'registered'), ($1, $3, 'waitlisted')",
    [event, A, B],
  );
});
afterEach(async () => { await db.exec('rollback'); });

const OPENED_1 = ['registration_opened opened:1 coordinator', 'registration_opened opened:1 organiser', 'registration_opened opened:1 waitlisted'];

describe('repeated polling and restarts', () => {
  it('SCRUM177_AC1_any_number_of_runs_announce_an_opening_once', async () => {
    await at(OPENS);
    for (let i = 0; i < 5; i += 1) await run();

    expect(await sent()).toEqual(OPENED_1);
    expect(await state()).toMatchObject({ open_announced: true, window_generation: 1 });
  });

  it('SCRUM177_AC1_what_was_sent_is_known_from_the_database_alone', async () => {
    // A restarted API process has no memory of earlier runs; the stored state is what stops a repeat.
    await at(OPENS);
    await run();
    await at(after(OPENS, 12));

    expect(await run()).toEqual({ notified: 0, events: 0, failures: [] });
  });
});

describe('partial failure and retry', () => {
  it('SCRUM177_AC1_a_failure_after_some_notices_were_written_leaves_none_and_no_recorded_transition', async () => {
    await at(OPENS);
    await fail(COORDINATOR);

    const result = await run();
    expect(result.failures).toEqual([{ eventRequestId: event, message: 'Injected failure for one recipient' }]);
    expect(await sent()).toEqual([]);
    expect(await state()).toBeNull();
  });

  it('SCRUM177_AC1_the_retry_sends_every_notice_once_with_the_key_the_failed_attempt_would_have_used', async () => {
    await at(OPENS);
    await fail(COORDINATOR);
    await run();
    await fail(null);

    await run();
    await run();
    expect(await sent()).toEqual(OPENED_1);
  });

  it('SCRUM177_AC4_a_flow_whose_notice_fails_fails_whole_and_succeeds_whole_on_retry', async () => {
    await at(OPENS);
    await run();
    await db.query("update event_registrations set status = 'withdrawn' where attendee_id = $1", [B]);
    await db.query("select announce_registration_capacity($1, 'registration')", [event]);
    await fail(ORGANISER);
    const withdraw = 'select withdraw_registration($1::uuid, $2::uuid)';

    expect(await errorCode(withdraw, [await registrationId(A), A])).toBe('P0001');
    expect(await sent()).not.toContain('registration_place_released released:2 organiser');
    await fail(null);
    expect(await errorCode(withdraw, [await registrationId(A), A])).toBeNull();

    expect((await sent()).filter((n) => !n.startsWith('registration_opened'))).toEqual([
      'registration_capacity_reached full:1 coordinator',
      'registration_capacity_reached full:1 organiser',
      'registration_place_released released:2 coordinator',
      'registration_place_released released:2 organiser',
    ]);
  });
});

describe('the unique occurrence', () => {
  it('SCRUM177_AC6_a_stale_writer_repeating_an_occurrence_adds_nothing', async () => {
    await at(OPENS);
    await run();

    const again = await db.query(
      "select notify_registration_change($1, 'registration_opened', array['organiser', 'coordinator', 'waitlisted'], 'opened:1', '{\"cause\": \"opening_time\"}') as n",
      [event],
    );
    expect(again.rows[0].n).toBe(0);
    expect(await sent()).toEqual(OPENED_1);
  });

  it('SCRUM177_AC6_the_database_refuses_a_second_row_for_one_occurrence_and_recipient', async () => {
    await at(OPENS);
    await run();

    expect(await errorCode(
      `insert into notifications (recipient_id, type, event_request_id, payload)
       values ($1, 'registration_opened', $2, '{"audience": "organiser", "occurrenceKey": "opened:1"}')`,
      [ORGANISER, event],
    )).toBe('23505');
  });

  it('SCRUM177_AC5_the_same_key_on_another_event_is_another_occurrence', async () => {
    const other = await seed('Other event');
    await at(OPENS);
    await run();

    expect(await sent()).toEqual(OPENED_1);
    expect(await sent(other)).toEqual(['registration_opened opened:1 coordinator', 'registration_opened opened:1 organiser']);
  });
});

describe('one transition, two paths', () => {
  it('SCRUM177_AC1_an_opening_the_settings_save_announced_is_not_announced_again_by_the_job', async () => {
    await at(OPENS);
    await db.query('select setup_event_registration($1, $2, true, $3, $4, 1, $5, true)', [event, ORGANISER, OPENS, CLOSES, DEADLINE]);
    await run();

    expect((await sent()).filter((n) => n.startsWith('registration_opened')))
      .toEqual(['registration_opened opened:1 coordinator', 'registration_opened opened:1 waitlisted']);
  });

  it('SCRUM177_AC2_a_promotion_by_either_job_announces_the_filled_capacity_once', async () => {
    // A second place, freed while closed: when the window opens both jobs can promote B.
    await setEvent({ registration_capacity: 2 });
    await at(OPENS);
    await db.query('select process_waitlist_promotions()');
    await run();

    expect((await sent()).filter((n) => n.startsWith('registration_capacity'))).toEqual([
      'registration_capacity_reached full:1 coordinator',
      'registration_capacity_reached full:1 organiser',
    ]);
    expect((await db.query("select count(*)::int as n from notifications where type = 'registration_promoted'")).rows[0].n).toBe(1);
  });
});

describe('edited dates and later windows', () => {
  it('SCRUM177_AC1_a_closing_time_moved_after_the_run_that_would_have_closed_it_is_not_a_closure', async () => {
    await at(OPENS);
    await run();
    await setEvent({ registration_closes_at: after(CLOSES, 48) });

    await at(after(CLOSES, 1));
    await run();
    expect((await sent()).filter((n) => n.startsWith('registration_closed'))).toEqual([]);
  });

  it('SCRUM177_AC1_each_later_window_is_a_new_occurrence_and_none_is_suppressed', async () => {
    await at(OPENS);
    await run();
    await at(CLOSES);
    await run();
    // The Organiser extends the period after it closed: registration reopens.
    await setEvent({ registration_closes_at: after(CLOSES, 48) });
    await at(after(CLOSES, 1));
    await run();
    await at(after(CLOSES, 48));
    await run();

    const keys = [...new Set((await sent()).map((n) => n.split(' ').slice(0, 2).join(' ')))];
    expect(keys).toEqual([
      'registration_closed closed:2', 'registration_closed closed:4',
      'registration_opened opened:1', 'registration_opened opened:3',
    ]);
    expect(await sent()).toHaveLength(12);
  });

  it('SCRUM177_AC2_capacity_refills_are_new_occurrences_with_their_own_keys', async () => {
    await at(OPENS);
    await run();
    await db.query("update event_registrations set status = 'withdrawn' where attendee_id = $1", [B]);
    await db.query("select announce_registration_capacity($1, 'registration')", [event]);
    await db.query('select withdraw_registration($1::uuid, $2::uuid)', [await registrationId(A), A]);
    await db.query('select register_for_event($1, $2)', [event, A]);

    expect((await sent()).filter((n) => !n.startsWith('registration_opened'))).toEqual([
      'registration_capacity_reached full:1 coordinator',
      'registration_capacity_reached full:1 organiser',
      'registration_capacity_reached full:3 coordinator',
      'registration_capacity_reached full:3 organiser',
      'registration_place_released released:2 coordinator',
      'registration_place_released released:2 organiser',
    ]);
  });
});
