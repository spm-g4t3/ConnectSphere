import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';
import { clientsCanExecute } from './helpers/grants.js';
import { createRequireAuth } from '../../src/middleware/requireAuth.js';
import { createOpenEventRouter } from '../../src/routes/openEvents.js';
import { createAttendeeEventRouter } from '../../src/routes/attendeeEvents.js';
import { createEventRegistrationRouter } from '../../src/routes/eventRegistration.js';

// The waiting list (027) against the final schema, on a stubbed clock. PGlite has
// one connection, so the two-session races are in eventWaitingListConcurrency.manual.sql.
const ORGANISER = '11111111-1111-4111-8111-111111111111';
const COORDINATOR = '22222222-2222-4222-8222-222222222222';
const OTHER_COORDINATOR = '33333333-3333-4333-8333-333333333333';
const A = '44444444-4444-4444-8444-444444444444';
const B = '55555555-5555-4555-8555-555555555555';
const C = '66666666-6666-4666-8666-666666666666';
const D = '77777777-7777-4777-8777-777777777777';
const START = '2026-10-20T10:00:00Z';
const OPENS = '2026-10-10T10:00:00Z';
const DEADLINE = '2026-10-18T10:00:00Z';
let db;
let event;

const at = (instant) => db.query("select set_config('test.now', $1, true)", [instant]);
const result = async (sql, params) => (await db.query(sql, params)).rows[0].result;
const register = (attendee) => result('select register_for_event($1::uuid, $2::uuid) as result', [event, attendee]);
const join = (attendee) => result('select join_event_waitlist($1::uuid, $2::uuid) as result', [event, attendee]);
const leave = (registration, attendee) => result(
  'select leave_event_waitlist($1::uuid, $2::uuid) as result', [registration, attendee],
);
const withdraw = (registration, attendee) => result(
  'select withdraw_registration($1::uuid, $2::uuid) as result', [registration, attendee],
);
const setup = ({ capacity = 1, closesAt = null, waitlist = true, enabled = true } = {}) => result(
  'select setup_event_registration($1, $2, $3, $4, $5, $6, $7, $8) as result',
  [event, ORGANISER, enabled, OPENS, closesAt, capacity, DEADLINE, waitlist],
);
const counts = (user) => result('select event_registration_counts($1::uuid, $2::uuid) as result', [event, user]);
const row = async (attendee) => (await db.query(
  'select * from event_registrations where event_request_id = $1 and attendee_id = $2', [event, attendee],
)).rows[0];
const statuses = async () => Object.fromEntries((await db.query(
  'select attendee_id, status from event_registrations where event_request_id = $1', [event],
)).rows.map((r) => [r.attendee_id, r.status]));
const registeredTotal = async () => Number((await db.query(
  "select count(*) as n from event_registrations where event_request_id = $1 and status = 'registered'", [event],
)).rows[0].n);
const promotions = async () => (await db.query(
  "select recipient_id, event_request_id, payload from notifications where type = 'registration_promoted' order by recipient_id",
)).rows;
const refused = async (act, expected) => {
  await db.exec('savepoint refusal');
  await expect(act()).rejects.toMatchObject(expected);
  await db.exec('rollback to savepoint refusal');
};
// A full event (capacity 1, A registered) with B then C waiting, a minute apart.
const fullWithQueue = async () => {
  await register(A);
  await at('2026-10-16T10:01:00Z');
  await join(B);
  await at('2026-10-16T10:02:00Z');
  await join(C);
};

beforeAll(async () => {
  db = await createSchemaDb();
  const users = [ORGANISER, COORDINATOR, OTHER_COORDINATOR, A, B, C, D];
  await db.query(`insert into auth.users (id) select unnest($1::uuid[])`, [users]);
  await db.query(`insert into profiles (id, role) values ($1, 'event_organiser'), ($2, 'event_coordinator'),
    ($3, 'event_coordinator'), ($4, 'attendee'), ($5, 'attendee'), ($6, 'attendee'), ($7, 'attendee')`, users);
  event = await seedEvent(db, {
    status: 'confirmed',
    organiser_id: ORGANISER,
    reviewing_coordinator_id: COORDINATOR,
    event_name: 'Waitlist event',
    proposed_start: START,
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
    -- Its own "set search_path = public" searches pg_catalog first, which would
    -- hide the stub clock from the promotion it runs.
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

describe('SCRUM460 joining the waiting list', () => {
  it('SCRUM460_AC1_a_full_event_with_a_waiting_list_queues_the_attendee_with_a_position', async () => {
    await register(A);
    const first = await join(B);
    await at('2026-10-16T10:01:00Z');
    const second = await join(C);

    expect(first).toMatchObject({ outcome: 'waitlisted', registration: { attendeeId: B, status: 'waitlisted', waitlistPosition: 1 } });
    expect(second.registration.waitlistPosition).toBe(2);
    expect(await statuses()).toEqual({ [A]: 'registered', [B]: 'waitlisted', [C]: 'waitlisted' });
    expect(await registeredTotal()).toBe(1);
  });

  it.each([
    ['the waiting list is off', async () => {
      await register(A);
      await db.query('update event_requests set registration_waitlist_enabled = false where id = $1', [event]);
    }, 'waitlist_disabled'],
    ['the attendee is registered', async () => { await register(A); }, 'already_registered', A],
    ['registration has closed', async () => { await register(A); await at(START); }, 'not_found'],
    ['the caller is not an attendee', async () => { await register(A); }, 'forbidden', ORGANISER],
  ])('SCRUM460_AC1_refuses_when_%s', async (_case, arrange, outcome, attendee = B) => {
    await arrange();
    const before = await statuses();
    expect(await join(attendee)).toEqual({ outcome });
    expect(await statuses()).toEqual(before);
  });

  it('SCRUM460_AC1_a_withdrawn_attendee_rejoins_on_the_same_row_at_the_back', async () => {
    await fullWithQueue();
    const previous = await row(B);
    await leave(previous.id, B);
    await at('2026-10-16T10:05:00Z');
    const rejoined = await join(B);
    expect(rejoined.registration).toMatchObject({ id: previous.id, waitlistPosition: 2 });
    expect((await row(B)).waitlisted_at.toISOString()).toBe('2026-10-16T10:05:00.000Z');
  });
});

describe('SCRUM460 seeing and leaving the waiting list', () => {
  it('SCRUM460_AC2_my_registrations_and_browse_show_the_attendees_own_position', async () => {
    await fullWithQueue();
    const { rows } = await db.query('select * from list_attendee_waitlist($1::uuid)', [C]);
    expect(rows).toEqual([expect.objectContaining({
      registration_id: (await row(C)).id, event_request_id: event, event_name: 'Waitlist event',
    })]);
    expect(Number(rows[0].waitlist_position)).toBe(2);

    const state = (await db.query(
      'select registration_status, waitlist_position from open_event_registration_state(array[$1::uuid], $2::uuid)', [event, C],
    )).rows[0];
    expect({ ...state, waitlist_position: Number(state.waitlist_position) })
      .toEqual({ registration_status: 'waitlisted', waitlist_position: 2 });
    expect((await db.query('select * from list_attendee_waitlist($1::uuid)', [A])).rows).toEqual([]);
  });

  it('SCRUM460_AC2_leaving_withdraws_the_row_and_moves_the_queue_up', async () => {
    await fullWithQueue();
    const left = await leave((await row(B)).id, B);
    expect(left).toMatchObject({ outcome: 'left_waitlist', registration: { attendeeId: B, status: 'withdrawn' } });
    const { rows } = await db.query('select waitlist_position from list_attendee_waitlist($1::uuid)', [C]);
    expect(Number(rows[0].waitlist_position)).toBe(1);
    expect(await registeredTotal()).toBe(1);
  });

  it.each([
    ["someone else's place", async () => [(await row(B)).id, C], { code: 'P0002' }],
    ['a registered row', async () => [(await row(A)).id, A], { code: '55000', hint: 'ALREADY_REGISTERED' }],
    ['a caller who is not an attendee', async () => [(await row(B)).id, ORGANISER], { code: '42501' }],
  ])('SCRUM460_AC2_leaving_refuses_%s_and_changes_nothing', async (_case, arrange, expected) => {
    await fullWithQueue();
    const [id, attendee] = await arrange();
    const before = await statuses();
    await refused(() => leave(id, attendee), expected);
    expect(await statuses()).toEqual(before);
  });
});

describe('SCRUM460 promotion', () => {
  it('SCRUM460_AC3_a_withdrawal_promotes_the_first_waiting_attendee', async () => {
    await fullWithQueue();
    const withdrawn = await withdraw((await row(A)).id, A);
    expect(await statuses()).toEqual({ [A]: 'withdrawn', [B]: 'registered', [C]: 'waitlisted' });
    expect((await row(B)).registered_at.toISOString()).toBe('2026-10-16T10:02:00.000Z');
    // The reply counts after the promotion: the place went straight back out.
    expect(withdrawn).toMatchObject({ registeredCount: 1, capacity: 1 });
  });

  it('SCRUM460_AC3_a_capacity_increase_promotes_one_per_new_place', async () => {
    await fullWithQueue();
    await at('2026-10-16T10:03:00Z');
    await join(D);
    const saved = await setup({ capacity: 3 });
    expect(await statuses()).toEqual({ [A]: 'registered', [B]: 'registered', [C]: 'registered', [D]: 'waitlisted' });
    expect(saved).toMatchObject({ outcome: 'saved', registeredCount: 3, waitlistCount: 1, settings: { waitlistEnabled: true } });
  });

  it('SCRUM460_AC3_removing_the_limit_promotes_everyone_waiting', async () => {
    await fullWithQueue();
    await setup({ capacity: null });
    expect(await statuses()).toEqual({ [A]: 'registered', [B]: 'registered', [C]: 'registered' });
  });

  it('SCRUM460_AC3_a_place_released_after_registration_closes_waits_until_it_reopens', async () => {
    await fullWithQueue();
    await db.query("update event_requests set registration_closes_at = '2026-10-17T10:00:00Z' where id = $1", [event]);
    await at('2026-10-17T12:00:00Z');
    await withdraw((await row(A)).id, A);
    expect(await statuses()).toEqual({ [A]: 'withdrawn', [B]: 'waitlisted', [C]: 'waitlisted' });
    expect(await promotions()).toEqual([]);

    await setup({ closesAt: '2026-10-19T10:00:00Z' });
    expect(await statuses()).toEqual({ [A]: 'withdrawn', [B]: 'registered', [C]: 'waitlisted' });
  });

  it('SCRUM460_AC3_switching_the_list_off_stops_joins_but_keeps_the_queue', async () => {
    await fullWithQueue();
    expect((await setup({ waitlist: false })).settings.waitlistEnabled).toBe(false);
    expect(await join(D)).toEqual({ outcome: 'waitlist_disabled' });
    await withdraw((await row(A)).id, A);
    expect(await statuses()).toMatchObject({ [B]: 'registered', [C]: 'waitlisted' });
  });

  it('SCRUM460_AC3_saving_without_the_switch_keeps_the_saved_value', async () => {
    const saved = await result(
      'select setup_event_registration($1, $2, true, $3, null, 1, $4) as result', [event, ORGANISER, OPENS, DEADLINE],
    );
    expect(saved.settings.waitlistEnabled).toBe(true);
  });

  it('SCRUM460_AC4_one_released_place_produces_exactly_one_promotion', async () => {
    await fullWithQueue();
    await withdraw((await row(A)).id, A);
    // Running promotion again, as any later writer does, finds no free place.
    expect((await db.query('select promote_waitlisted_registrations($1) as n', [event])).rows[0].n).toBe(0);
    expect(await registeredTotal()).toBe(1);
    expect(await promotions()).toHaveLength(1);
  });

  it('SCRUM460_AC4_a_rolled_back_withdrawal_promotes_nobody', async () => {
    await fullWithQueue();
    const id = (await row(A)).id;
    await db.exec('savepoint undo');
    await withdraw(id, A);
    await db.exec('rollback to savepoint undo');
    expect(await statuses()).toEqual({ [A]: 'registered', [B]: 'waitlisted', [C]: 'waitlisted' });
    expect(await promotions()).toEqual([]);
  });

  it('SCRUM460_AC4_a_joiner_after_the_release_queues_behind_those_already_waiting', async () => {
    await fullWithQueue();
    await withdraw((await row(A)).id, A);
    await at('2026-10-16T10:03:00Z');
    expect(await join(D)).toMatchObject({ outcome: 'waitlisted', registration: { waitlistPosition: 2 } });
  });

  it('SCRUM460_AC5_only_the_promoted_attendee_is_notified', async () => {
    await fullWithQueue();
    await withdraw((await row(A)).id, A);
    expect(await promotions()).toEqual([{
      recipient_id: B,
      event_request_id: event,
      payload: { eventRequestId: event, eventName: 'Waitlist event', registrationId: (await row(B)).id },
    }]);
  });
});

describe('SCRUM460 waiting-list count for staff', () => {
  it.each([['the organiser', ORGANISER], ['the assigned coordinator', COORDINATOR]])(
    'SCRUM460_AC6_%s_sees_the_waiting_list_count', async (_case, user) => {
      await fullWithQueue();
      expect(await counts(user)).toEqual({
        eventRequestId: event, capacity: 1, waitlistEnabled: true, registeredCount: 1, waitlistCount: 2,
      });
    },
  );

  it.each([['another coordinator', OTHER_COORDINATOR], ['an attendee', A], ['no caller', null]])(
    'SCRUM460_AC6_refuses_%s', async (_case, user) => {
      await refused(() => counts(user), { code: '42501' });
    },
  );

  it('SCRUM460_AC6_the_new_functions_are_for_the_backend_only', async () => {
    for (const fn of [
      'join_event_waitlist(uuid, uuid)', 'leave_event_waitlist(uuid, uuid)',
      'promote_waitlisted_registrations(uuid)', 'list_attendee_waitlist(uuid)',
      'event_registration_counts(uuid, uuid)', 'waitlist_position(event_registrations)',
      'registration_closed_reason(event_requests, timestamptz)',
    ]) {
      expect(await clientsCanExecute(db, fn)).toEqual([]);
    }
  });
});

describe('SCRUM460 through the API', () => {
  const ROLES = {
    [ORGANISER]: 'event_organiser', [COORDINATOR]: 'event_coordinator', [OTHER_COORDINATOR]: 'event_coordinator',
    [A]: 'attendee', [B]: 'attendee', [C]: 'attendee', [D]: 'attendee',
  };
  // Each RPC runs as a statement in the test's transaction, with named arguments.
  const client = {
    rpc: async (name, args) => {
      const keys = Object.keys(args);
      const call = `${name}(${keys.map((key, i) => `${key} => $${i + 1}`).join(', ')})`;
      await db.exec('savepoint rpc');
      try {
        const { rows } = await db.query(`select * from ${call}`, Object.values(args));
        await db.exec('release savepoint rpc');
        return { data: name === 'list_attendee_waitlist' ? rows : rows[0][name], error: null };
      } catch (error) {
        await db.exec('rollback to savepoint rpc');
        return { data: null, error };
      }
    },
  };
  // The bearer token is the user's id.
  const requireAuth = createRequireAuth({
    verifyToken: async (token) => (ROLES[token] ? { id: token, email: 'user@example.com' } : null),
    loadRole: async (user) => ROLES[user.id ?? user],
  });
  const api = express().use(express.json())
    .use('/api/open-events', createOpenEventRouter({ client, requireAuth }))
    .use('/api/attendee-events', createAttendeeEventRouter({ client, requireAuth }))
    .use('/api/registration', createEventRegistrationRouter({ client, requireAuth }));
  const as = (user) => ({ Authorization: `Bearer ${user}` });

  it('SCRUM460_AC1_POST_waitlist_queues_a_full_event_and_explains_refusals', async () => {
    await register(A);
    const joined = await request(api).post(`/api/open-events/${event}/waitlist`).set(as(B));
    expect(joined.status).toBe(201);
    expect(joined.body).toMatchObject({ attendeeId: B, status: 'waitlisted', waitlistPosition: 1 });

    const again = await request(api).post(`/api/open-events/${event}/waitlist`).set(as(B));
    expect(again.status).toBe(200);
    expect(again.body).toEqual(joined.body);
    const staff = await request(api).post(`/api/open-events/${event}/waitlist`).set(as(ORGANISER));
    expect(staff.status).toBe(403);
  });

  it('SCRUM460_AC2_GET_waitlist_lists_positions_and_leave_waitlist_removes_the_place', async () => {
    await fullWithQueue();
    const list = await request(api).get('/api/attendee-events/waitlist').set(as(C));
    expect(list.status).toBe(200);
    expect(list.body).toEqual([expect.objectContaining({
      registrationId: (await row(C)).id, eventRequestId: event, eventName: 'Waitlist event', waitlistPosition: 2,
    })]);

    const left = await request(api).post(`/api/attendee-events/registrations/${(await row(C)).id}/leave-waitlist`).set(as(C));
    expect(left.status).toBe(200);
    expect(left.body).toMatchObject({ status: 'withdrawn' });
    expect((await request(api).get('/api/attendee-events/waitlist').set(as(C))).body).toEqual([]);

    const notMine = await request(api).post(`/api/attendee-events/registrations/${(await row(B)).id}/leave-waitlist`).set(as(C));
    expect(notMine.status).toBe(404);
  });

  it('SCRUM460_AC3_a_withdrawal_through_the_API_reports_the_place_already_refilled', async () => {
    await fullWithQueue();
    const res = await request(api).post(`/api/attendee-events/registrations/${(await row(A)).id}/withdrawal`).set(as(A));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'withdrawn', placesLeft: 0, isFull: true });
    expect((await row(B)).status).toBe('registered');
  });

  it('SCRUM460_AC3_saving_a_higher_capacity_promotes_and_reports_the_waiting_list', async () => {
    await fullWithQueue();
    const res = await request(api).put(`/api/registration/events/${event}/settings`).set(as(ORGANISER)).send({
      enabled: true, opensAt: OPENS, closesAt: null, capacity: 2, withdrawalDeadline: DEADLINE, waitlistEnabled: true,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ capacity: 2, waitlistEnabled: true, registeredCount: 2, waitlistCount: 1 });
    const invalid = await request(api).put(`/api/registration/events/${event}/settings`).set(as(ORGANISER)).send({
      enabled: true, opensAt: OPENS, capacity: 2, waitlistEnabled: 'yes',
    });
    expect(invalid.status).toBe(400);
  });

  it.each([['the organiser', ORGANISER], ['the assigned coordinator', COORDINATOR]])(
    'SCRUM460_AC6_GET_counts_answers_%s', async (_case, user) => {
      await fullWithQueue();
      const res = await request(api).get(`/api/registration/events/${event}/counts`).set(as(user));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ eventRequestId: event, capacity: 1, waitlistEnabled: true, registeredCount: 1, waitlistCount: 2 });
    },
  );

  it.each([['another coordinator', OTHER_COORDINATOR], ['an attendee', A]])(
    'SCRUM460_AC6_GET_counts_refuses_%s', async (_case, user) => {
      const res = await request(api).get(`/api/registration/events/${event}/counts`).set(as(user));
      expect(res.status).toBe(403);
    },
  );
});
