import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';
import { createRequireAuth } from '../../src/middleware/requireAuth.js';
import { createOpenEventRouter } from '../../src/routes/openEvents.js';
import { createAttendeeEventRouter } from '../../src/routes/attendeeEvents.js';
import { createEventRegistrationRouter } from '../../src/routes/eventRegistration.js';

// SCRUM-476: the SCRUM-460 cases the story-level suites left open, through the
// real routes, services and SQL on PGlite (same harness as the SCRUM-473 suite).
// The lock-based races are in waitingListConcurrency.realdb.test.js.
const ORGANISER = '11111111-1111-4111-8111-111111111111';
const COORDINATOR = '22222222-2222-4222-8222-222222222222';
const A = '44444444-4444-4444-8444-444444444444';
const B = '55555555-5555-4555-8555-555555555555';
const C = '66666666-6666-4666-8666-666666666666';
const ROLES = {
  [ORGANISER]: 'event_organiser', [COORDINATOR]: 'event_coordinator',
  [A]: 'attendee', [B]: 'attendee', [C]: 'attendee',
};
const OPENS = '2026-10-10T10:00:00Z';
const DEADLINE = '2026-10-18T10:00:00Z';
const EVENT_FIELDS = {
  status: 'confirmed',
  organiser_id: ORGANISER,
  reviewing_coordinator_id: COORDINATOR,
  event_name: 'Coverage event',
  proposed_start: '2026-10-20T10:00:00Z',
  registration_enabled: true,
  registration_opens_at: OPENS,
  registration_capacity: 1,
  registration_withdrawal_deadline: DEADLINE,
  registration_waitlist_enabled: true,
};
let db;
let event;

const at = (instant) => db.query("select set_config('test.now', $1, true)", [instant]);
const row = async (attendee, id = event) => (await db.query(
  'select * from event_registrations where event_request_id = $1 and attendee_id = $2', [id, attendee],
)).rows[0];
const promotions = async () => (await db.query(
  "select recipient_id from notifications where type = 'registration_promoted' and event_request_id = $1", [event],
)).rows.map((r) => r.recipient_id);

const client = {
  rpc: async (name, args) => {
    const keys = Object.keys(args);
    await db.exec('savepoint rpc');
    try {
      const { rows } = await db.query(
        `select * from ${name}(${keys.map((key, i) => `${key} => $${i + 1}`).join(', ')})`, Object.values(args),
      );
      await db.exec('release savepoint rpc');
      // The one table-returning function here; the rest return a single jsonb.
      return { data: name === 'list_attendee_waitlist' ? rows : rows[0][name], error: null };
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
  .use('/api/attendee-events', createAttendeeEventRouter({ client, requireAuth }))
  .use('/api/registration', createEventRegistrationRouter({ client, requireAuth }));
const as = (user) => ({ Authorization: `Bearer ${user}` });
const join = (user, id = event) => request(api).post(`/api/open-events/${id}/waitlist`).set(as(user));
const register = (user) => request(api).post(`/api/open-events/${event}/registrations`).set(as(user));
const withdraw = async (user) => request(api)
  .post(`/api/attendee-events/registrations/${(await row(user)).id}/withdrawal`).set(as(user));
const leave = async (user) => request(api)
  .post(`/api/attendee-events/registrations/${(await row(user)).id}/leave-waitlist`).set(as(user));
const counts = (user) => request(api).get(`/api/registration/events/${event}/counts`).set(as(user));
const saveCapacity = (capacity) => request(api).put(`/api/registration/events/${event}/settings`).set(as(ORGANISER))
  .send({ enabled: true, opensAt: OPENS, closesAt: null, capacity, withdrawalDeadline: DEADLINE, waitlistEnabled: true });

beforeAll(async () => {
  db = await createSchemaDb();
  const users = Object.keys(ROLES);
  await db.query('insert into auth.users (id) select unnest($1::uuid[])', [users]);
  await db.query('insert into profiles (id, role) select unnest($1::uuid[]), unnest($2::text[])::user_role',
    [users, users.map((id) => ROLES[id])]);
  event = await seedEvent(db, EVENT_FIELDS);
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

describe('SCRUM476 acting only for yourself', () => {
  it('SCRUM476_AC1_a_join_ignores_any_attendee_named_in_the_request', async () => {
    await register(A);
    const res = await request(api).post(`/api/open-events/${event}/waitlist?attendeeId=${C}`)
      .set(as(B)).send({ attendeeId: C, p_attendee_id: C });
    expect(res.status).toBe(201);
    expect(res.body.attendeeId).toBe(B);
    expect(await row(C)).toBeUndefined();
  });

  it('SCRUM476_AC1_staff_cannot_join_for_anyone', async () => {
    await register(A);
    for (const user of [ORGANISER, COORDINATOR]) expect((await join(user)).status).toBe(403);
  });
});

describe('SCRUM476 invalid event states', () => {
  it('SCRUM476_AC1_a_cancelled_event_refuses_joining_as_not_open', async () => {
    const cancelled = await seedEvent(db, { ...EVENT_FIELDS, status: 'cancelled', decision: 'approved' });
    const res = await join(B, cancelled);
    expect(res.status).toBe(404);
    expect(await row(B, cancelled)).toBeUndefined();
  });
});

describe('SCRUM476 an empty or exhausted queue', () => {
  it('SCRUM476_AC4_a_withdrawal_with_nobody_waiting_leaves_the_place_free_for_registration', async () => {
    await register(A);
    const res = await withdraw(A);
    expect(res.body).toMatchObject({ placesLeft: 1, isFull: false });
    expect(await promotions()).toEqual([]);
    expect((await register(B)).status).toBe(201);
  });

  it('SCRUM476_AC4_more_new_places_than_people_waiting_promotes_everyone_and_leaves_the_rest_free', async () => {
    await register(A);
    await at('2026-10-16T10:01:00Z');
    await join(B);
    await at('2026-10-16T10:02:00Z');
    await join(C);
    const res = await saveCapacity(5);
    expect(res.body).toMatchObject({ registeredCount: 3, waitlistCount: 0 });
    expect((await promotions()).sort()).toEqual([B, C].sort());
    expect((await counts(ORGANISER)).body).toMatchObject({ registeredCount: 3, waitlistCount: 0, capacity: 5 });
  });

  it('SCRUM476_AC4_once_the_queue_is_exhausted_a_later_release_promotes_nobody', async () => {
    await register(A);
    await join(B);
    await withdraw(A);
    expect((await row(B)).status).toBe('registered');
    await withdraw(B);
    expect(await promotions()).toEqual([B]);
    expect((await counts(ORGANISER)).body).toMatchObject({ registeredCount: 0, waitlistCount: 0 });
  });

  it('SCRUM476_AC3_leaving_the_last_entry_empties_the_queue_without_touching_registrations', async () => {
    await register(A);
    await join(B);
    await leave(B);
    expect((await counts(COORDINATOR)).body).toMatchObject({ registeredCount: 1, waitlistCount: 0 });
    expect((await request(api).get('/api/attendee-events/waitlist').set(as(B))).body).toEqual([]);
  });
});

describe('SCRUM477 a queue that cannot move says so', () => {
  const myWaitlist = async (user) => (await request(api).get('/api/attendee-events/waitlist').set(as(user))).body;

  it.each([
    ['registration has closed', () => db.query(
      "update event_requests set registration_closes_at = '2026-10-16T10:30:00Z' where id = $1", [event],
    ).then(() => at('2026-10-16T11:00:00Z'))],
    ['the event has started', () => at('2026-10-20T10:00:00Z')],
    ['the event is cancelled', () => db.query(
      "update event_requests set status = 'cancelled' where id = $1", [event],
    )],
  ])('SCRUM477_AC2_my_registrations_keeps_the_place_but_says_no_places_are_offered_when_%s', async (_case, arrange) => {
    await register(A);
    await join(B);
    expect(await myWaitlist(B)).toEqual([expect.objectContaining({ waitlistPosition: 1, placesOffered: true })]);
    await arrange();
    expect(await myWaitlist(B)).toEqual([expect.objectContaining({ waitlistPosition: 1, placesOffered: false })]);
  });
});

describe('SCRUM476 waiting-list counts through each change', () => {
  it('SCRUM476_AC6_counts_follow_joins_departures_and_promotions', async () => {
    const seen = [];
    const snapshot = async () => {
      const { registeredCount, waitlistCount } = (await counts(ORGANISER)).body;
      seen.push([registeredCount, waitlistCount]);
    };
    await register(A); await snapshot();
    await at('2026-10-16T10:01:00Z'); await join(B); await snapshot();
    await at('2026-10-16T10:02:00Z'); await join(C); await snapshot();
    await leave(C); await snapshot();
    await withdraw(A); await snapshot();
    expect(seen).toEqual([[1, 0], [1, 1], [1, 2], [1, 1], [1, 0]]);
  });
});
