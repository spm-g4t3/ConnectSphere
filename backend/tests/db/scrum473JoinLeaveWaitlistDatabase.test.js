import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';
import { createRequireAuth } from '../../src/middleware/requireAuth.js';
import { createOpenEventRouter } from '../../src/routes/openEvents.js';
import { createAttendeeEventRouter } from '../../src/routes/attendeeEvents.js';

// Joining and leaving through the real routes, services and SQL, on a stubbed
// clock. PGlite has one connection, so the two-session races are in
// eventWaitingListConcurrency.manual.sql.
const ORGANISER = '11111111-1111-4111-8111-111111111111';
const COORDINATOR = '22222222-2222-4222-8222-222222222222';
const A = '44444444-4444-4444-8444-444444444444';
const B = '55555555-5555-4555-8555-555555555555';
const C = '66666666-6666-4666-8666-666666666666';
const D = '77777777-7777-4777-8777-777777777777';
const MISSING = '99999999-9999-4999-8999-999999999999';
const ROLES = {
  [ORGANISER]: 'event_organiser', [COORDINATOR]: 'event_coordinator',
  [A]: 'attendee', [B]: 'attendee', [C]: 'attendee', [D]: 'attendee',
};
const START = '2026-10-20T10:00:00Z';
const DEADLINE = '2026-10-18T10:00:00Z';
let db;
let event;

const at = (instant) => db.query("select set_config('test.now', $1, true)", [instant]);
const setEvent = (fields) => db.query(
  `update event_requests set ${Object.keys(fields).map((key, i) => `${key} = $${i + 2}`).join(', ')} where id = $1`,
  [event, ...Object.values(fields)],
);
const row = async (attendee) => (await db.query(
  'select * from event_registrations where event_request_id = $1 and attendee_id = $2', [event, attendee],
)).rows[0];
const rowCount = async () => Number((await db.query(
  'select count(*) as n from event_registrations where event_request_id = $1', [event],
)).rows[0].n);
const registeredCount = async () => Number((await db.query(
  "select count(*) as n from event_registrations where event_request_id = $1 and status = 'registered'", [event],
)).rows[0].n);

// Each RPC runs in the test's transaction, behind a savepoint as PostgREST's own would be.
const client = {
  rpc: async (name, args) => {
    const keys = Object.keys(args);
    await db.exec('savepoint rpc');
    try {
      const { rows } = await db.query(
        `select * from ${name}(${keys.map((key, i) => `${key} => $${i + 1}`).join(', ')})`, Object.values(args),
      );
      await db.exec('release savepoint rpc');
      return { data: rows[0][name], error: null };
    } catch (error) {
      await db.exec('rollback to savepoint rpc');
      return { data: null, error };
    }
  },
};
const requireAuth = createRequireAuth({
  verifyToken: async (token) => (ROLES[token] ? { id: token, email: 'user@example.com' } : null),
  loadRole: async (id) => ROLES[id],
});
const api = express().use(express.json())
  .use('/api/open-events', createOpenEventRouter({ client, requireAuth }))
  .use('/api/attendee-events', createAttendeeEventRouter({ client, requireAuth }));
const as = (user) => ({ Authorization: `Bearer ${user}` });
const join = (user, id = event) => request(api).post(`/api/open-events/${id}/waitlist`).set(as(user));
const register = (user) => request(api).post(`/api/open-events/${event}/registrations`).set(as(user));
const leave = (user, registrationId) => request(api)
  .post(`/api/attendee-events/registrations/${registrationId}/leave-waitlist`).set(as(user));
const withdraw = (user, registrationId) => request(api)
  .post(`/api/attendee-events/registrations/${registrationId}/withdrawal`).set(as(user));

// Capacity 1 held by A, then B and C waiting a minute apart.
async function fullWithQueue() {
  await register(A);
  await at('2026-10-16T10:01:00Z');
  await join(B);
  await at('2026-10-16T10:02:00Z');
  await join(C);
}

beforeAll(async () => {
  db = await createSchemaDb();
  const users = Object.keys(ROLES);
  await db.query('insert into auth.users (id) select unnest($1::uuid[])', [users]);
  await db.query(
    'insert into profiles (id, role) select unnest($1::uuid[]), unnest($2::text[])::user_role',
    [users, users.map((id) => ROLES[id])],
  );
  event = await seedEvent(db, {
    status: 'confirmed',
    organiser_id: ORGANISER,
    reviewing_coordinator_id: COORDINATOR,
    event_name: 'Join event',
    proposed_start: START,
    registration_enabled: true,
    registration_opens_at: '2026-10-10T10:00:00Z',
    registration_capacity: 1,
    registration_withdrawal_deadline: DEADLINE,
    registration_waitlist_enabled: true,
  });
  await db.exec(`
    create function public.clock_timestamp() returns timestamptz language sql
      as $$ select current_setting('test.now')::timestamptz $$;
    set search_path = public, pg_catalog;
  `);
});
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec('begin');
  await at('2026-10-16T10:00:00Z');
});
afterEach(async () => { await db.exec('rollback'); });

describe('SCRUM473 joining a full event', () => {
  it('SCRUM473_AC1_an_attendee_joins_and_gets_the_authoritative_status_and_position', async () => {
    await register(A);
    const res = await join(B);
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      id: (await row(B)).id, eventRequestId: event, attendeeId: B, status: 'waitlisted',
      waitlistPosition: 1, waitlistedAt: expect.any(String),
      createdAt: expect.any(String), updatedAt: expect.any(String),
    });
    expect(await registeredCount()).toBe(1);
  });

  it.each([
    ['the event is not confirmed', () => setEvent({ status: 'approved' })],
    ['registration is switched off', () => setEvent({ registration_enabled: false })],
    ['registration has not opened', () => at('2026-10-09T10:00:00Z')],
    ['registration has closed', () => setEvent({ registration_closes_at: '2026-10-15T10:00:00Z' })],
    ['the event has started', () => at(START)],
  ])('SCRUM473_AC2_refuses_as_registration_does_when_%s', async (_case, arrange) => {
    await register(A);
    await arrange();
    const res = await join(B);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('This event is not open for registration');
    expect(await row(B)).toBeUndefined();
  });

  it('SCRUM473_AC3_a_full_event_without_a_waiting_list_still_says_it_is_full', async () => {
    await register(A);
    await setEvent({ registration_waitlist_enabled: false });
    const joined = await join(B);
    expect(joined.status).toBe(409);
    expect(joined.body).toMatchObject({ code: 'WAITLIST_DISABLED', error: 'Event is full and has no waiting list' });
    const registered = await register(B);
    expect(registered.body.code).toBe('EVENT_FULL');
    expect(await row(B)).toBeUndefined();
  });

  it.each([[true], [false]])('SCRUM473_AC4_a_free_place_is_taken_by_normal_registration_with_the_list_%s', async (enabled) => {
    await setEvent({ registration_waitlist_enabled: enabled });
    const res = await join(B);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ attendeeId: B, status: 'registered', waitlistPosition: null });
    expect((await row(B)).status).toBe('registered');
    expect(await registeredCount()).toBe(1);
  });
});

describe('SCRUM473 one entry, one place in the queue', () => {
  it('SCRUM473_AC5_a_repeat_join_returns_the_same_entry_without_moving_it', async () => {
    await fullWithQueue();
    const before = await row(B);
    await at('2026-10-16T11:00:00Z');
    const again = await join(B);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: before.id, status: 'waitlisted', waitlistPosition: 1 });
    expect(await row(B)).toEqual(before);
    expect(await rowCount()).toBe(3);
  });

  it.each([
    ['already registered', A, 'ALREADY_REGISTERED', async () => {}],
    ['cancelled', D, 'REGISTRATION_CANCELLED', () => db.query(
      "insert into event_registrations (event_request_id, attendee_id, status) values ($1, $2, 'cancelled')", [event, D],
    )],
  ])('SCRUM473_AC5_an_attendee_who_is_%s_is_refused_without_a_new_entry', async (_case, attendee, code, arrange) => {
    await fullWithQueue();
    await arrange();
    const count = await rowCount();
    const res = await join(attendee);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(code);
    expect(await rowCount()).toBe(count);
  });

  it('SCRUM473_AC6_the_position_returned_is_current_after_people_ahead_leave', async () => {
    await fullWithQueue();
    await leave(B, (await row(B)).id);
    expect((await join(C)).body.waitlistPosition).toBe(1);
  });
});

describe('SCRUM473 leaving the waiting list', () => {
  it('SCRUM473_AC8_leaving_frees_the_queue_place_and_leaves_registered_capacity_alone', async () => {
    await fullWithQueue();
    const res = await leave(B, (await row(B)).id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: (await row(B)).id, attendeeId: B, status: 'withdrawn' });
    expect((await join(C)).body.waitlistPosition).toBe(1);
    expect(await registeredCount()).toBe(1);
    expect((await row(A)).status).toBe('registered');
  });

  it('SCRUM473_AC7_someone_elses_entry_reads_exactly_like_a_missing_one', async () => {
    await fullWithQueue();
    const theirs = await leave(C, (await row(B)).id);
    const missing = await leave(C, MISSING);
    expect(theirs.status).toBe(404);
    expect(theirs.body).toEqual(missing.body);
    expect(theirs.body.error).toBe('Waiting-list entry not found');
    expect((await row(B)).status).toBe('waitlisted');
  });

  it.each([
    ['a staff member', ORGANISER, 403],
    ['no valid token', 'not-a-user', 401],
  ])('SCRUM473_AC7_%s_cannot_leave_for_an_attendee', async (_case, user, status) => {
    await fullWithQueue();
    expect((await leave(user, (await row(B)).id)).status).toBe(status);
    expect((await row(B)).status).toBe('waitlisted');
  });

  it('SCRUM473_AC10_a_malformed_id_is_a_400_before_any_database_call', async () => {
    const res = await leave(B, 'not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid waiting-list request');
  });

  it.each([
    ['after the withdrawal deadline', () => at('2026-10-19T10:00:00Z')],
    ['after registration closes', () => setEvent({ registration_closes_at: '2026-10-16T10:30:00Z' }).then(() => at('2026-10-16T11:00:00Z'))],
    ['after the event starts', () => at('2026-10-21T10:00:00Z')],
    ['when the event has no withdrawal deadline', () => setEvent({ registration_withdrawal_deadline: null })],
  ])('SCRUM473_AC9_leaving_is_not_a_withdrawal_and_works_%s', async (_case, arrange) => {
    await fullWithQueue();
    await arrange();
    const res = await leave(B, (await row(B)).id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('withdrawn');
  });

  it('SCRUM473_AC9_the_two_endpoints_refuse_each_others_entries', async () => {
    await fullWithQueue();
    const waitlisted = await withdraw(B, (await row(B)).id);
    expect(waitlisted.status).toBe(409);
    expect(waitlisted.body.code).toBe('REGISTRATION_NOT_CONFIRMED');
    const registered = await leave(A, (await row(A)).id);
    expect(registered.status).toBe(409);
    expect(registered.body.code).toBe('ALREADY_REGISTERED');
    expect(await registeredCount()).toBe(1);
  });

  it('SCRUM473_AC10_leaving_twice_explains_the_entry_is_already_gone', async () => {
    await fullWithQueue();
    const id = (await row(B)).id;
    await leave(B, id);
    const again = await leave(B, id);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'NOT_WAITLISTED', error: 'This registration is not on the waiting list' });
  });

  it('SCRUM473_AC10_a_promotion_that_wins_the_race_is_reported_not_undone', async () => {
    await fullWithQueue();
    const id = (await row(B)).id;
    await withdraw(A, (await row(A)).id);
    const res = await leave(B, id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_REGISTERED');
    expect((await row(B)).status).toBe('registered');
  });
});
