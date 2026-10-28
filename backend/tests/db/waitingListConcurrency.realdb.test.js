import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { REAL_DB_URL, createRealSchemaDb, waitUntilBlocked } from './helpers/realDb.js';
import { seedEvent } from './helpers/schemaDb.js';

// SCRUM-476: the waiting list's concurrency guarantees on a real PostgreSQL
// server, with independent connections. Each race opens worker A's
// transaction, starts worker B, waits until the server reports B blocked on a
// lock, and only then lets A commit or roll back: no sleeps decide the order.
// Workers run as service_role, as the API does. Skipped unless
// CONCURRENCY_DATABASE_URL names a disposable server (see helpers/realDb.js).

const ORGANISER = '11111111-1111-4111-8111-111111111111';
const COORDINATOR = '22222222-2222-4222-8222-222222222222';
const X = 'a0000000-0000-4000-8000-00000000000a';
const Y = 'a0000000-0000-4000-8000-00000000000b';
const W1 = 'b0000000-0000-4000-8000-000000000001';
const W2 = 'b0000000-0000-4000-8000-000000000002';
const W3 = 'b0000000-0000-4000-8000-000000000003';
const N = 'c0000000-0000-4000-8000-00000000000c';
const N2 = 'c0000000-0000-4000-8000-00000000000d';
const ATTENDEES = [X, Y, W1, W2, W3, N, N2];
const DAY = 24 * 60 * 60 * 1000;
const OPENS = new Date(Date.now() - DAY).toISOString();
const DEADLINE = new Date(Date.now() + 5 * DAY).toISOString();
const START = new Date(Date.now() + 10 * DAY).toISOString();

let owner;
let A;
let B;

const result = async (client, sql, params) => (await client.query(sql, params)).rows[0].result;
const register = (client, event, attendee) => result(client, 'select register_for_event($1, $2) as result', [event, attendee]);
const join = (client, event, attendee) => result(client, 'select join_event_waitlist($1, $2) as result', [event, attendee]);
const promote = async (client, event) => (await client.query('select promote_waitlisted_registrations($1) as n', [event])).rows[0].n;
const registrationId = async (event, attendee) => (await owner.query(
  'select id from event_registrations where event_request_id = $1 and attendee_id = $2', [event, attendee],
)).rows[0].id;
const withdraw = async (client, event, attendee) => result(
  client, 'select withdraw_registration($1, $2) as result', [await registrationId(event, attendee), attendee],
);
const leave = async (client, event, attendee) => result(
  client, 'select leave_event_waitlist($1, $2) as result', [await registrationId(event, attendee), attendee],
);
const saveCapacity = (client, event, capacity) => result(
  client, 'select setup_event_registration($1, $2, true, $3, null, $4, $5, true) as result',
  [event, ORGANISER, OPENS, capacity, DEADLINE],
);

/**
 * Runs `first` in worker A's open transaction, starts `second` on worker B,
 * waits until B is blocked on A's lock, then ends A with `finish`.
 * B's outcome is { value } or { error }.
 */
async function race(first, second, { finish = 'commit' } = {}) {
  await A.query('begin');
  let firstValue;
  try {
    firstValue = await first(A);
  } catch (error) {
    await A.query('rollback');
    throw error;
  }
  const pending = second(B).then((value) => ({ value }), (error) => ({ error }));
  await waitUntilBlocked(owner, B.pid);
  await A.query(finish);
  return { first: firstValue, second: await pending };
}

/** A fresh Confirmed event, its registrations made in order, then its queue joined in order. */
async function scenario({ capacity, registered = [], waiting = [] }) {
  const event = await seedEvent(owner, {
    status: 'confirmed',
    organiser_id: ORGANISER,
    reviewing_coordinator_id: COORDINATOR,
    event_name: 'Race event',
    proposed_start: START,
    registration_enabled: true,
    registration_opens_at: OPENS,
    registration_capacity: capacity,
    registration_withdrawal_deadline: DEADLINE,
    registration_waitlist_enabled: true,
  });
  for (const attendee of registered) expect((await register(owner, event, attendee)).outcome).toBe('registered');
  for (const attendee of waiting) expect((await join(owner, event, attendee)).outcome).toBe('waitlisted');
  return event;
}

/** The persisted outcome: every status, the capacity, and notices per recipient. */
async function finalState(event) {
  const statuses = Object.fromEntries((await owner.query(
    'select attendee_id, status from event_registrations where event_request_id = $1', [event],
  )).rows.map((r) => [r.attendee_id, r.status]));
  const { capacity } = (await owner.query(
    'select registration_capacity as capacity from event_requests where id = $1', [event],
  )).rows[0];
  const notices = Object.fromEntries((await owner.query(
    `select recipient_id, count(*)::int as n from notifications
      where type = 'registration_promoted' and event_request_id = $1 group by recipient_id`, [event],
  )).rows.map((r) => [r.recipient_id, r.n]));
  const registered = Object.values(statuses).filter((status) => status === 'registered').length;
  return { statuses, capacity, registered, notices };
}

describe.skipIf(!REAL_DB_URL)('SCRUM476 waiting-list races on a real PostgreSQL server', () => {
  beforeAll(async () => {
    const db = await createRealSchemaDb();
    owner = await db.connect();
    await db.owner.end();
    await owner.query('insert into auth.users (id) select unnest($1::uuid[])', [[ORGANISER, COORDINATOR, ...ATTENDEES]]);
    await owner.query("insert into profiles (id, role) values ($1, 'event_organiser'), ($2, 'event_coordinator')", [ORGANISER, COORDINATOR]);
    await owner.query("insert into profiles (id, role) select unnest($1::uuid[]), 'attendee'", [ATTENDEES]);
    A = await db.connect({ role: 'service_role' });
    B = await db.connect({ role: 'service_role' });
  }, 120_000);

  afterAll(async () => {
    await Promise.all([A, B, owner].filter(Boolean).map((client) => client.end()));
  });

  describe('1. two workers process the same released place', () => {
    // The place is released without being processed, as if the worker that
    // released it had not yet promoted; then two workers promote at once.
    async function releasedPlace() {
      const event = await scenario({ capacity: 1, registered: [X], waiting: [W1, W2] });
      await owner.query(
        "update event_registrations set status = 'withdrawn' where event_request_id = $1 and attendee_id = $2", [event, X],
      );
      return event;
    }

    it('SCRUM476_AC4_the_second_worker_waits_then_finds_no_place_left', async () => {
      const event = await releasedPlace();
      const outcome = await race((c) => promote(c, event), (c) => promote(c, event));
      expect(outcome).toEqual({ first: 1, second: { value: 0 } });
      expect(await finalState(event)).toEqual({
        statuses: { [X]: 'withdrawn', [W1]: 'registered', [W2]: 'waitlisted' },
        capacity: 1, registered: 1, notices: { [W1]: 1 },
      });
    });

    it('SCRUM476_AC4_if_the_first_worker_rolls_back_the_second_promotes_once_instead', async () => {
      const event = await releasedPlace();
      const outcome = await race((c) => promote(c, event), (c) => promote(c, event), { finish: 'rollback' });
      expect(outcome).toEqual({ first: 1, second: { value: 1 } });
      expect(await finalState(event)).toEqual({
        statuses: { [X]: 'withdrawn', [W1]: 'registered', [W2]: 'waitlisted' },
        capacity: 1, registered: 1, notices: { [W1]: 1 },
      });
    });
  });

  describe('2. two genuine withdrawals release two places', () => {
    it('SCRUM476_AC4_each_withdrawal_promotes_a_different_attendee_in_queue_order', async () => {
      const event = await scenario({ capacity: 2, registered: [X, Y], waiting: [W1, W2, W3] });
      const outcome = await race((c) => withdraw(c, event, X), (c) => withdraw(c, event, Y));
      expect(outcome.first).toMatchObject({ outcome: 'withdrawn', registeredCount: 2 });
      expect(outcome.second.value).toMatchObject({ outcome: 'withdrawn', registeredCount: 2 });
      expect(await finalState(event)).toEqual({
        statuses: { [X]: 'withdrawn', [Y]: 'withdrawn', [W1]: 'registered', [W2]: 'registered', [W3]: 'waitlisted' },
        capacity: 2, registered: 2, notices: { [W1]: 1, [W2]: 1 },
      });
    });
  });

  describe('3. a withdrawal races a capacity increase', () => {
    const expected = {
      statuses: { [X]: 'withdrawn', [W1]: 'registered', [W2]: 'registered', [W3]: 'waitlisted' },
      capacity: 2, registered: 2, notices: { [W1]: 1, [W2]: 1 },
    };

    it('SCRUM476_AC3_withdrawal_first_then_the_increase_fills_exactly_the_new_capacity', async () => {
      const event = await scenario({ capacity: 1, registered: [X], waiting: [W1, W2, W3] });
      const outcome = await race((c) => withdraw(c, event, X), (c) => saveCapacity(c, event, 2));
      expect(outcome.second.value).toMatchObject({ outcome: 'saved', registeredCount: 2, waitlistCount: 1 });
      expect(await finalState(event)).toEqual(expected);
    });

    it('SCRUM476_AC3_increase_first_then_the_withdrawal_promotes_the_next_in_line', async () => {
      const event = await scenario({ capacity: 1, registered: [X], waiting: [W1, W2, W3] });
      const outcome = await race((c) => saveCapacity(c, event, 2), (c) => withdraw(c, event, X));
      expect(outcome.first).toMatchObject({ outcome: 'saved', registeredCount: 2 });
      expect(outcome.second.value).toMatchObject({ outcome: 'withdrawn', registeredCount: 2 });
      expect(await finalState(event)).toEqual(expected);
    });
  });

  describe('4. joining or leaving races a promotion', () => {
    it('SCRUM476_AC2_leaving_while_being_promoted_keeps_the_place_and_says_so', async () => {
      const event = await scenario({ capacity: 1, registered: [X], waiting: [W1, W2] });
      const outcome = await race((c) => withdraw(c, event, X), (c) => leave(c, event, W1));
      expect(outcome.second.error).toMatchObject({ code: '55000', hint: 'ALREADY_REGISTERED' });
      expect(await finalState(event)).toEqual({
        statuses: { [X]: 'withdrawn', [W1]: 'registered', [W2]: 'waitlisted' },
        capacity: 1, registered: 1, notices: { [W1]: 1 },
      });
    });

    it('SCRUM476_AC2_if_the_promotion_rolls_back_the_departure_goes_through', async () => {
      const event = await scenario({ capacity: 1, registered: [X], waiting: [W1, W2] });
      const outcome = await race((c) => withdraw(c, event, X), (c) => leave(c, event, W1), { finish: 'rollback' });
      expect(outcome.second.value).toMatchObject({ outcome: 'left_waitlist' });
      expect(await finalState(event)).toEqual({
        statuses: { [X]: 'registered', [W1]: 'withdrawn', [W2]: 'waitlisted' },
        capacity: 1, registered: 1, notices: {},
      });
    });

    it('SCRUM476_AC1_a_join_during_a_promotion_queues_behind_it_with_the_right_position', async () => {
      const event = await scenario({ capacity: 1, registered: [X], waiting: [W1, W2] });
      const outcome = await race((c) => withdraw(c, event, X), (c) => join(c, event, N));
      expect(outcome.second.value).toMatchObject({
        outcome: 'waitlisted', created: true, registration: { status: 'waitlisted', waitlistPosition: 2 },
      });
      expect(await finalState(event)).toEqual({
        statuses: { [X]: 'withdrawn', [W1]: 'registered', [W2]: 'waitlisted', [N]: 'waitlisted' },
        capacity: 1, registered: 1, notices: { [W1]: 1 },
      });
    });

    it('SCRUM476_AC1_the_same_attendee_joining_twice_at_once_gets_one_entry', async () => {
      const event = await scenario({ capacity: 1, registered: [X], waiting: [W1] });
      const outcome = await race((c) => join(c, event, N), (c) => join(c, event, N));
      expect(outcome.first).toMatchObject({ created: true, registration: { waitlistPosition: 2 } });
      expect(outcome.second.value).toMatchObject({
        created: false, registration: { id: outcome.first.registration.id, waitlistPosition: 2 },
      });
      const { rows } = await owner.query(
        'select count(*)::int as n from event_registrations where event_request_id = $1 and attendee_id = $2', [event, N],
      );
      expect(rows[0].n).toBe(1);
    });
  });

  describe('5. a direct registration races a promotion for the last place', () => {
    it('SCRUM476_AC5_the_newcomer_waits_and_finds_the_place_given_to_the_queue', async () => {
      const event = await scenario({ capacity: 1, registered: [X], waiting: [W1] });
      const outcome = await race((c) => withdraw(c, event, X), (c) => register(c, event, N));
      expect(outcome.second.value).toEqual({ outcome: 'capacity_reached' });
      expect(await finalState(event)).toEqual({
        statuses: { [X]: 'withdrawn', [W1]: 'registered' },
        capacity: 1, registered: 1, notices: { [W1]: 1 },
      });
    });

    it('SCRUM476_AC5_if_the_withdrawal_rolls_back_the_event_is_still_full', async () => {
      const event = await scenario({ capacity: 1, registered: [X], waiting: [W1] });
      const outcome = await race((c) => withdraw(c, event, X), (c) => register(c, event, N), { finish: 'rollback' });
      expect(outcome.second.value).toEqual({ outcome: 'capacity_reached' });
      expect(await finalState(event)).toEqual({
        statuses: { [X]: 'registered', [W1]: 'waitlisted' },
        capacity: 1, registered: 1, notices: {},
      });
    });

    it('SCRUM476_AC5_two_newcomers_after_a_reopening_cannot_take_a_place_the_queue_is_owed', async () => {
      // The place is released while registration is closed, so nobody is promoted then.
      const event = await scenario({ capacity: 1, registered: [X], waiting: [W1] });
      await owner.query('update event_requests set registration_closes_at = now() where id = $1', [event]);
      await withdraw(owner, event, X);
      expect((await finalState(event)).statuses[W1]).toBe('waitlisted');
      await owner.query('update event_requests set registration_closes_at = null where id = $1', [event]);

      const outcome = await race((c) => register(c, event, N), (c) => register(c, event, N2));
      expect(outcome).toEqual({ first: { outcome: 'capacity_reached' }, second: { value: { outcome: 'capacity_reached' } } });
      expect(await finalState(event)).toEqual({
        statuses: { [X]: 'withdrawn', [W1]: 'registered' },
        capacity: 1, registered: 1, notices: { [W1]: 1 },
      });
    });
  });
});
