import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';

// The waiting-list data model (027): status, queue order, derived positions,
// one row per attendee and event, and the Organiser's switch. Behaviour through
// the join, leave and promote functions is in eventWaitingListDatabase.test.js.
const ORGANISER = '11111111-1111-4111-8111-111111111111';
const COORDINATOR = '22222222-2222-4222-8222-222222222222';
const A = '44444444-4444-4444-8444-444444444444';
const B = '55555555-5555-4555-8555-555555555555';
const C = '66666666-6666-4666-8666-666666666666';
const D = '77777777-7777-4777-8777-777777777777';
const OPENS = '2026-10-10T10:00:00Z';
const DEADLINE = '2026-10-18T10:00:00Z';
const EVENT_FIELDS = {
  status: 'confirmed',
  organiser_id: ORGANISER,
  reviewing_coordinator_id: COORDINATOR,
  event_name: 'Queue event',
  proposed_start: '2026-10-20T10:00:00Z',
  registration_enabled: true,
  registration_opens_at: OPENS,
  registration_capacity: 1,
  registration_withdrawal_deadline: DEADLINE,
};
let db;
let event;

const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const at = (instant) => db.query("select set_config('test.now', $1, true)", [instant]);
const result = async (sql, params) => (await one(sql, params)).result;
const join = (attendee, id = event) => result('select join_event_waitlist($1::uuid, $2::uuid) as result', [id, attendee]);
const register = (attendee) => result('select register_for_event($1::uuid, $2::uuid) as result', [event, attendee]);
const seed = async (attendee, status, waitlistedAt = null) => (await one(
  `insert into event_registrations (event_request_id, attendee_id, status, waitlisted_at)
   values ($1, $2, $3, $4) returning id`, [event, attendee, status, waitlistedAt],
)).id;
// Position as every reader computes it: waitlist_position over the row.
const positions = async () => Object.fromEntries((await db.query(
  `select attendee_id, waitlist_position(r)::int as position
     from event_registrations r where event_request_id = $1 and status = 'waitlisted'`, [event],
)).rows.map((r) => [r.attendee_id, r.position]));
const refused = async (act, expected) => {
  await db.exec('savepoint refusal');
  await expect(act()).rejects.toMatchObject(expected);
  await db.exec('rollback to savepoint refusal');
};

beforeAll(async () => {
  db = await createSchemaDb();
  const users = [ORGANISER, COORDINATOR, A, B, C, D];
  await db.query('insert into auth.users (id) select unnest($1::uuid[])', [users]);
  await db.query(`insert into profiles (id, role) values ($1, 'event_organiser'), ($2, 'event_coordinator'),
    ($3, 'attendee'), ($4, 'attendee'), ($5, 'attendee'), ($6, 'attendee')`, users);
  event = await seedEvent(db, { ...EVENT_FIELDS, registration_waitlist_enabled: true });
  await db.exec(`
    create function public.clock_timestamp() returns timestamptz language sql
      as $$ select current_setting('test.now')::timestamptz $$;
    set search_path = public, pg_catalog;
    alter function setup_event_registration(uuid, uuid, boolean, timestamptz, timestamptz, integer, timestamptz, boolean)
      set search_path = public, pg_catalog;
  `);
});
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec('begin');
  await at('2026-10-16T10:00:00Z');
});
afterEach(async () => { await db.exec('rollback'); });

describe('SCRUM472 waitlisted status in persistence', () => {
  it('SCRUM472_AC1_a_waitlisted_row_always_has_its_queue_time', async () => {
    const id = await seed(A, 'waitlisted');
    expect((await one('select waitlisted_at from event_registrations where id = $1', [id])).waitlisted_at.toISOString())
      .toBe('2026-10-16T10:00:00.000Z');
    await refused(
      () => db.query('update event_registrations set waitlisted_at = null where id = $1', [id]),
      { code: '23514' },
    );
  });

  it('SCRUM472_AC1_an_unknown_status_is_refused_by_the_database', async () => {
    await refused(() => seed(A, 'pending'), { code: '23514' });
  });
});

describe('SCRUM472 first in, first out', () => {
  it('SCRUM472_AC2_the_queue_follows_join_time', async () => {
    await seed(A, 'waitlisted', '2026-10-16T10:02:00Z');
    await seed(B, 'waitlisted', '2026-10-16T10:01:00Z');
    await seed(C, 'waitlisted', '2026-10-16T10:03:00Z');
    expect(await positions()).toEqual({ [B]: 1, [A]: 2, [C]: 3 });
  });

  it('SCRUM472_AC2_an_exact_tie_is_broken_by_id_the_same_way_every_time', async () => {
    const ids = [];
    for (const attendee of [A, B, C]) ids.push([attendee, await seed(attendee, 'waitlisted', '2026-10-16T10:00:00Z')]);
    const expected = Object.fromEntries(
      [...ids].sort(([, x], [, y]) => (x < y ? -1 : 1)).map(([attendee], index) => [attendee, index + 1]),
    );
    expect(await positions()).toEqual(expected);
    expect(await positions()).toEqual(expected);
  });

  it('SCRUM472_AC2_coming_back_after_leaving_goes_to_the_back', async () => {
    const id = await seed(A, 'waitlisted', '2026-10-16T09:00:00Z');
    await seed(B, 'waitlisted', '2026-10-16T09:30:00Z');
    await db.query("update event_registrations set status = 'withdrawn' where id = $1", [id]);
    await db.query("update event_registrations set status = 'waitlisted' where id = $1", [id]);
    expect(await positions()).toEqual({ [B]: 1, [A]: 2 });
  });
});

describe('SCRUM472 positions are calculated, not stored', () => {
  it('SCRUM472_AC3_there_is_no_position_column_to_go_stale', async () => {
    const { rows } = await db.query(
      "select column_name from information_schema.columns where table_name = 'event_registrations' and column_name like '%position%'",
    );
    expect(rows).toEqual([]);
  });

  it('SCRUM472_AC3_positions_close_up_after_a_departure_and_a_promotion', async () => {
    const registered = await seed(A, 'registered');
    const b = await seed(B, 'waitlisted', '2026-10-16T09:01:00Z');
    await seed(C, 'waitlisted', '2026-10-16T09:02:00Z');
    await seed(D, 'waitlisted', '2026-10-16T09:03:00Z');

    await result('select leave_event_waitlist($1::uuid, $2::uuid) as result', [b, B]);
    expect(await positions()).toEqual({ [C]: 1, [D]: 2 });

    await result('select withdraw_registration($1::uuid, $2::uuid) as result', [registered, A]);
    expect(await positions()).toEqual({ [D]: 1 });
  });

  it('SCRUM472_AC3_a_non_waitlisted_row_has_no_position', async () => {
    const id = await seed(A, 'registered');
    expect(await one('select waitlist_position(r) as position from event_registrations r where id = $1', [id]))
      .toEqual({ position: null });
  });
});

describe('SCRUM472 one entry per attendee and event', () => {
  it('SCRUM472_AC4_the_database_refuses_a_second_row_whatever_its_status', async () => {
    await seed(A, 'waitlisted');
    await refused(() => seed(A, 'registered'), { code: '23505' });
    await refused(() => seed(A, 'waitlisted'), { code: '23505' });
  });

  it('SCRUM472_AC4_registering_and_joining_refuse_an_existing_entry_without_a_second_row', async () => {
    await register(A);
    await join(B);
    expect(await join(A)).toEqual({ outcome: 'already_registered' });
    expect(await join(B)).toMatchObject({ outcome: 'waitlisted', created: false });
    expect(await register(B)).toEqual({ outcome: 'already_waitlisted' });
    expect((await one('select count(*)::int as n from event_registrations where event_request_id = $1', [event])).n).toBe(2);
  });
});

describe('SCRUM472 waitlisted attendees hold no place', () => {
  it('SCRUM472_AC5_capacity_counts_registered_rows_only', async () => {
    await seed(A, 'registered');
    await seed(B, 'waitlisted');
    await seed(C, 'waitlisted');
    const state = await one(
      'select active_count::int from open_event_registration_state(array[$1::uuid], $2::uuid)', [event, D],
    );
    expect(state.active_count).toBe(1);
    // Keeping capacity at 1 is allowed: two people waiting are not two places taken.
    const saved = await result(
      'select setup_event_registration($1, $2, true, $3, null, 1, $4, true) as result', [event, ORGANISER, OPENS, DEADLINE],
    );
    expect(saved).toMatchObject({ outcome: 'saved', registeredCount: 1, waitlistCount: 2 });
  });
});

describe('SCRUM472 existing statuses keep their behaviour', () => {
  it('SCRUM472_AC6_a_cancelled_registration_can_neither_register_nor_join', async () => {
    await seed(A, 'registered');
    await seed(B, 'cancelled');
    expect(await join(B)).toEqual({ outcome: 'registration_cancelled' });
    expect(await register(B)).toEqual({ outcome: 'registration_cancelled' });
  });

  it('SCRUM472_AC6_a_withdrawn_registration_registers_again_on_the_same_row', async () => {
    const id = await seed(A, 'withdrawn');
    expect((await register(A)).registration).toMatchObject({ id, status: 'registered' });
  });

  it('SCRUM472_AC6_withdraw_registration_still_refuses_a_waitlisted_row', async () => {
    const id = await seed(A, 'waitlisted');
    await refused(
      () => db.query('select withdraw_registration($1::uuid, $2::uuid)', [id, A]),
      { code: '55000', hint: 'REGISTRATION_NOT_CONFIRMED' },
    );
  });
});

describe('SCRUM472 queue indexes', () => {
  it.each([
    ['idx_event_registrations_waitlist', '(event_request_id, waitlisted_at, id)'],
    ['idx_event_registrations_attendee_waitlist', '(attendee_id, waitlisted_at DESC)'],
  ])('SCRUM472_AC7_%s_covers_only_waitlisted_rows_in_queue_order', async (name, columns) => {
    const { indexdef } = await one('select indexdef from pg_indexes where indexname = $1', [name]);
    expect(indexdef).toContain(columns);
    expect(indexdef).toContain("WHERE (status = 'waitlisted'::text)");
  });
});

describe('SCRUM472 the waiting-list switch', () => {
  it('SCRUM472_AC8_an_event_has_no_waiting_list_until_its_organiser_switches_one_on', async () => {
    const plain = await seedEvent(db, EVENT_FIELDS);
    expect(await one('select registration_waitlist_enabled from event_requests where id = $1', [plain]))
      .toEqual({ registration_waitlist_enabled: false });
    await db.query("insert into event_registrations (event_request_id, attendee_id) values ($1, $2)", [plain, A]);
    expect(await join(B, plain)).toEqual({ outcome: 'waitlist_disabled' });
  });

  it('SCRUM472_AC8_only_the_organiser_changes_it_and_the_change_is_audited', async () => {
    const setup = (user, waitlist) => result(
      'select setup_event_registration($1, $2, true, $3, null, 1, $4, $5) as result',
      [event, user, OPENS, DEADLINE, waitlist],
    );
    expect(await setup(COORDINATOR, false)).toEqual({ outcome: 'forbidden' });
    expect((await setup(ORGANISER, false)).settings.waitlistEnabled).toBe(false);
    const history = await one(
      `select changed_by, old_values->'waitlistEnabled' as before, new_values->'waitlistEnabled' as after
         from event_registration_settings_history where event_request_id = $1 order by changed_at desc limit 1`, [event],
    );
    expect(history).toEqual({ changed_by: ORGANISER, before: true, after: false });
  });
});
