import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { registerForEvent } from '../../src/services/registrationService.js';
import { availability } from '../../src/domain/registrationAvailability.js';
import express from 'express';
import request from 'supertest';
import { createOpenEventRouter } from '../../src/routes/openEvents.js';
import { createRequireAuth } from '../../src/middleware/requireAuth.js';
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';
import { clientsCanExecute } from './helpers/grants.js';

// register_for_event and the availability it reads, against the final schema.
const ME = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const THIRD = '77777777-7777-4777-8777-777777777777';
const ORGANISER = '66666666-6666-4666-8666-666666666666';
const COORDINATOR = '88888888-8888-4888-8888-888888888888';
const DAY = 86_400_000;
let db;
let event;
const register = (attendee = ME, eventId = event) => db.query(
  'select register_for_event($1::uuid, $2::uuid) as result', [eventId, attendee],
);
const records = async () => (await db.query(
  'select * from event_registrations where event_request_id = $1 order by created_at, id', [event],
)).rows;
const seed = (attendee, status = 'registered') => db.query(
  'insert into event_registrations (event_request_id, attendee_id, status) values ($1, $2, $3)',
  [event, attendee, status],
);
const readAvailability = async (attendee = ME) => {
  const { rows: [row] } = await db.query(`
    select e.registration_capacity, coalesce(s.active_count, 0)::int as active_count,
           coalesce(s.is_registered, false) as is_registered
      from event_requests e
      left join lateral open_event_registration_state(array[e.id], $2::uuid) s on true
     where e.id = $1
  `, [event, attendee]);
  return {
    ...availability(row.registration_capacity, row.active_count),
    activeCount: row.active_count, isRegistered: row.is_registered,
  };
};

beforeAll(async () => {
  db = await createSchemaDb();
  // Fails an insert after it is written, to prove the whole registration rolls back.
  await db.exec(`
    create function fail_test_registration() returns trigger language plpgsql as $$
    begin
      if new.event_request_id::text = current_setting('test.fail_event', true) then
        raise exception 'Injected post-insert failure' using
          errcode = coalesce(nullif(current_setting('test.fail_code', true), ''), 'P0001');
      end if;
      return new;
    end;
    $$;
    create trigger fail_test_registration after insert on event_registrations
      for each row execute function fail_test_registration();
  `);
  await db.query('insert into auth.users (id) values ($1), ($2), ($3), ($4), ($5)', [ME, OTHER, ORGANISER, THIRD, COORDINATOR]);
  await db.query(`insert into profiles (id, role) values ($1, 'attendee'), ($2, 'attendee'), ($3, 'event_organiser'),
    ($4, 'attendee'), ($5, 'event_coordinator')`, [ME, OTHER, ORGANISER, THIRD, COORDINATOR]);
});

describe('SCRUM46 authoritative registration availability', () => {
  it('SCRUM46_AC1_AC2_decreases_places_from_the_persisted_count_and_preserves_existing_records', async () => {
    await db.query('update event_requests set registration_capacity = 3 where id = $1', [event]);
    await seed(OTHER);
    const existing = await records();
    expect(await readAvailability()).toMatchObject({ placesLeft: 2, activeCount: 1, isRegistered: false });
    await register();
    expect(await readAvailability()).toEqual({ placesLeft: 1, activeCount: 2, isFull: false, isRegistered: true });
    expect(await records()).toEqual(expect.arrayContaining(existing));
  });

  it('SCRUM46_AC3_the_last_place_becomes_full_for_every_attendee_and_rejects_further_registration', async () => {
    await register();
    expect(await readAvailability()).toEqual({ placesLeft: 0, activeCount: 1, isFull: true, isRegistered: true });
    expect(await readAvailability(OTHER)).toEqual({ placesLeft: 0, activeCount: 1, isFull: true, isRegistered: false });
    const before = await records();
    expect((await register(OTHER)).rows[0].result).toEqual({ outcome: 'capacity_reached' });
    expect(await readAvailability(OTHER)).toMatchObject({ placesLeft: 0, activeCount: 1, isFull: true });
    expect(await records()).toEqual(before);
  });

  it('SCRUM46_AC4_unlimited_events_keep_null_places_left_as_registrations_increase', async () => {
    await db.query('update event_requests set registration_capacity = null where id = $1', [event]);
    await register();
    await register(OTHER);
    await register(THIRD);
    expect(await readAvailability()).toEqual({ placesLeft: null, activeCount: 3, isFull: false, isRegistered: true });
  });

  it('SCRUM46_AC5_queued_last_place_requests_produce_one_winner_and_one_authoritative_full_count', async () => {
    // PGlite serialises calls; the existing two-session SQL check verifies real lock contention.
    await db.query('update event_requests set registration_capacity = 2 where id = $1', [event]);
    await seed(THIRD);
    const outcomes = await Promise.all([register(), register(OTHER)]);
    expect(outcomes.map((outcome) => outcome.rows[0].result.outcome)).toEqual(['registered', 'capacity_reached']);
    expect(await readAvailability(THIRD)).toEqual({ placesLeft: 0, activeCount: 2, isFull: true, isRegistered: true });
  });

  it('SCRUM46_AC7_duplicate_attempts_do_not_double_count_or_change_existing_registrations', async () => {
    await db.query('update event_requests set registration_capacity = 2 where id = $1', [event]);
    await register();
    const before = await records();
    const beforeAvailability = await readAvailability();
    expect((await register()).rows[0].result).toEqual({ outcome: 'already_registered' });
    expect(await readAvailability()).toEqual(beforeAvailability);
    expect(await records()).toEqual(before);
  });

  it('SCRUM46_AC7_a_failed_insert_does_not_consume_availability', async () => {
    const before = await readAvailability();
    await db.query("select set_config('test.fail_event', $1, false)", [event]);
    await expect(register()).rejects.toThrow('Injected post-insert failure');
    await db.query("select set_config('test.fail_event', '', false)");
    expect(await readAvailability()).toEqual(before);
    expect(await records()).toEqual([]);
  });

  it.each(['withdrawn', 'cancelled'])('SCRUM46_AC7_%s_rows_release_places_and_remain_as_history', async (status) => {
    await seed(OTHER);
    const before = await records();
    expect(await readAvailability()).toMatchObject({ placesLeft: 0, isFull: true });
    await db.query('update event_registrations set status = $1 where id = $2', [status, before[0].id]);
    expect(await readAvailability()).toMatchObject({ placesLeft: 1, activeCount: 0, isFull: false });
    await register();
    expect(await readAvailability()).toMatchObject({ placesLeft: 0, activeCount: 1, isFull: true });
    expect((await records()).find((row) => row.id === before[0].id)).toMatchObject({ status, attendee_id: OTHER });
  });
});
afterAll(async () => { await db.close(); });
// A confirmed event open for registration since yesterday, with one place.
const registrationEvent = (overrides = {}) => seedEvent(db, {
  id: randomUUID(),
  status: 'confirmed',
  organiser_id: ORGANISER,
  reviewing_coordinator_id: COORDINATOR,
  event_name: 'Registration test',
  proposed_start: new Date(Date.now() + 2 * DAY),
  registration_enabled: true,
  registration_opens_at: new Date(Date.now() - DAY),
  registration_closes_at: new Date(Date.now() + DAY),
  registration_capacity: 1,
  ...overrides,
});
beforeEach(async () => {
  event = await registrationEvent();
});

describe('SCRUM39 atomic event registration', () => {
  it('SCRUM39_AC1_takes_the_last_place_and_returns_the_persisted_registration', async () => {
    await db.query('update event_requests set registration_capacity = 2 where id = $1', [event]);
    await seed(OTHER);
    const { rows: [{ result }] } = await register();
    expect(result).toMatchObject({ outcome: 'registered', registration: {
      eventRequestId: event, attendeeId: ME, status: 'registered',
    } });
    const saved = await records();
    expect(saved).toHaveLength(2);
    expect(result.registration.id).toBe(saved.find((row) => row.attendee_id === ME).id);
  });

  it('SCRUM39_AC1_refuses_a_full_event_without_changing_records', async () => {
    await seed(OTHER);
    const before = await records();
    expect((await register()).rows[0].result).toEqual({ outcome: 'capacity_reached' });
    expect(await records()).toEqual(before);
  });

  it('SCRUM39_AC1_refuses_an_event_already_over_its_lowered_capacity', async () => {
    await seed(ME);
    await seed(OTHER);
    expect((await register(THIRD)).rows[0].result).toEqual({ outcome: 'capacity_reached' });
    expect(await records()).toHaveLength(2);
  });

  it('SCRUM39_AC1_rejects_zero_capacity_in_the_shared_settings_schema', async () => {
    await expect(db.query('update event_requests set registration_capacity = 0 where id = $1', [event])).rejects.toMatchObject({ code: '23514' });
    expect(await records()).toEqual([]);
  });

  it('SCRUM39_AC2_returns_already_registered_before_full_for_a_repeat_attempt', async () => {
    await register();
    const before = await records();
    expect((await register()).rows[0].result).toEqual({ outcome: 'already_registered' });
    expect(await records()).toEqual(before);
  });

  it.each(['withdrawn', 'cancelled'])('SCRUM39_AC2_does_not_count_%s_records_as_active', async (status) => {
    await seed(OTHER, status);
    await seed(THIRD, status);
    await register();
    const saved = await records();
    expect(saved).toHaveLength(3);
    expect(saved.filter((row) => row.status === 'registered')).toHaveLength(1);
  });

  it('SCRUM22_AC6_only_withdrawn_registrations_can_be_reactivated', async () => {
    await seed(ME, 'cancelled');
    const before = await records();
    expect((await register()).rows[0].result).toEqual({ outcome: 'registration_cancelled' });
    expect(await records()).toEqual(before);
    await db.query("update event_registrations set status = 'withdrawn' where attendee_id = $1", [ME]);
    const withdrawn = await records();
    expect((await register()).rows[0].result).toMatchObject({ outcome: 'registered', registration: { id: withdrawn[0].id } });
    expect(await records()).toHaveLength(1);
  });

  it('SCRUM22_AC6_registration_functions_are_invoker_security_and_backend_only', async () => {
    for (const fn of ['register_for_event(uuid,uuid)', 'open_event_registration_state(uuid[],uuid)']) {
      const { rows: [security] } = await db.query('select prosecdef from pg_proc where oid = $1::regprocedure', [fn]);
      expect(security.prosecdef).toBe(false);
      expect(await clientsCanExecute(db, fn, ['anon', 'authenticated', 'service_role']), fn).toEqual(['service_role']);
    }
  });

  it('SCRUM39_AC3_allows_null_capacity_without_a_venue_capacity_check', async () => {
    await db.query('update event_requests set registration_capacity = null where id = $1', [event]);
    await register();
    await register(OTHER);
    expect(await records()).toHaveLength(2);
    expect((await register()).rows[0].result).toEqual({ outcome: 'already_registered' });
  });

  it('SCRUM39_AC4_allows_only_one_queued_request_for_the_last_place', async () => {
    // PGlite queues these calls on one connection. Real overlapping transactions
    // and lock waiting must also be checked with registrationConcurrency.manual.sql.
    const outcomes = await Promise.all([register(), register(OTHER)]);
    expect(outcomes.map((result) => result.rows[0].result.outcome)).toEqual(['registered', 'capacity_reached']);
    expect(await records()).toHaveLength(1);
  });

  it('SCRUM39_AC4_allows_only_one_of_two_queued_requests_from_the_same_attendee', async () => {
    const outcomes = await Promise.all([register(), register()]);
    expect(outcomes.map((result) => result.rows[0].result.outcome)).toEqual(['registered', 'already_registered']);
    expect(await records()).toHaveLength(1);
  });

  it('SCRUM39_AC5_rolls_back_a_failure_after_the_insert_and_leaves_the_place_available', async () => {
    await db.query("select set_config('test.fail_event', $1, false)", [event]);
    await expect(register()).rejects.toThrow('Injected post-insert failure');
    expect(await records()).toEqual([]);
    await db.query("select set_config('test.fail_event', '', false)");
    await register(OTHER);
    expect((await records()).map((row) => row.attendee_id)).toEqual([OTHER]);
  });

  it('SCRUM39_AC5_can_roll_back_the_whole_registration_transaction', async () => {
    await db.exec('begin');
    await register();
    await db.exec('rollback');
    expect(await records()).toEqual([]);
    await register(OTHER);
    expect(await records()).toHaveLength(1);
  });

  it.each([
    ['status', 'approved', 'EVENT_NOT_CONFIRMED'],
    ['registration_enabled', false, 'REGISTRATION_DISABLED'],
    ['registration_opens_at', '9999-01-01T00:00:00Z', 'REGISTRATION_NOT_OPEN'],
    ['registration_closes_at', '2000-01-01T00:00:00Z', 'REGISTRATION_CLOSED'],
  ])('SCRUM39_AC5_revalidates_current_%s_in_the_write_transaction', async (column, value) => {
    await db.query('update event_requests set registration_closes_at = null where id = $1', [event]);
    if (column === 'registration_closes_at') await db.query("update event_requests set registration_opens_at = '1999-01-01' where id = $1", [event]);
    await db.query(`update event_requests set ${column} = $1 where id = $2`, [value, event]);
    expect((await register()).rows[0].result).toEqual({ outcome: 'not_found' });
    expect(await records()).toEqual([]);
  });

  it('SCRUM39_AC5_revalidates_the_event_start_in_the_write_transaction', async () => {
    // A confirmed event's start is locked, so the started event is seeded past.
    event = await registrationEvent({
      proposed_start: '2000-01-01T00:00:00Z', registration_opens_at: '1999-01-01', registration_closes_at: null,
    });
    expect((await register()).rows[0].result).toEqual({ outcome: 'not_found' });
    expect(await records()).toEqual([]);
  });

  it.each([
    ['null attendee', null, null, '22023'],
    ['wrong role', ORGANISER, null, '42501'],
    ['unknown attendee', '99999999-9999-4999-8999-999999999999', null, '42501'],
    ['unknown event', ME, '99999999-9999-4999-8999-999999999999', 'P0002'],
  ])('SCRUM39_AC5_refuses_%s_without_inserting', async (_label, attendee, target, code) => {
    if (code === 'P0002' || code === '42501') {
      expect((await register(attendee, target ?? event)).rows[0].result).toEqual({ outcome: code === 'P0002' ? 'not_found' : 'forbidden' });
    } else await expect(register(attendee, target ?? event)).rejects.toMatchObject({ code });
    expect(await records()).toEqual([]);
  });

  it.each(['anon', 'authenticated'])('SCRUM39_AC5_denies_direct_RPC_execution_by_%s', async (role) => {
    await db.exec(`set role ${role}`);
    try {
      await expect(register()).rejects.toMatchObject({ code: '42501', message: 'permission denied for function register_for_event' });
    } finally { await db.exec('reset role'); }
    expect(await records()).toEqual([]);
  });

  it('SCRUM39_AC5_runs_the_service_with_the_API_role_against_real_SQL', async () => {
    const client = { rpc: async (name, args) => {
      expect(name).toBe('register_for_event');
      try {
        const { rows } = await register(args.p_attendee_id, args.p_event_request_id);
        return { data: rows[0].result, error: null };
      } catch (error) { return { data: null, error }; }
    } };
    await db.exec('set role service_role');
    try {
      const saved = await registerForEvent({ attendeeId: ME, eventId: event, client });
      expect(saved).toMatchObject({ eventRequestId: event, attendeeId: ME, status: 'registered' });
      await expect(registerForEvent({ attendeeId: OTHER, eventId: event, client })).rejects.toMatchObject({ status: 409, code: 'EVENT_FULL' });
      await expect(registerForEvent({ attendeeId: ME, eventId: event, client })).rejects.toMatchObject({ status: 409, code: 'ALREADY_REGISTERED' });
    } finally { await db.exec('reset role'); }
    expect(await records()).toHaveLength(1);
  });

  it.each(['40001', '40P01'])('SCRUM22_AC4_database_%s_after_insert_rolls_back_and_returns_a_retryable_conflict', async (code) => {
    await db.query("select set_config('test.fail_event', $1, false), set_config('test.fail_code', $2, false)", [event, code]);
    const client = { rpc: async () => {
      try { return { data: (await register()).rows[0].result, error: null }; }
      catch (error) { return { data: null, error }; }
    } };
    try {
      await expect(registerForEvent({ attendeeId: ME, eventId: event, client }))
        .rejects.toMatchObject({ status: 409, code: 'REGISTRATION_CHANGED' });
      expect(await records()).toEqual([]);
      expect(await readAvailability()).toMatchObject({ placesLeft: 1, activeCount: 0 });
    } finally {
      await db.query("select set_config('test.fail_event', '', false), set_config('test.fail_code', '', false)");
    }
  });

  it.each([null, 'waitlisted', 'cancelled'])('SCRUM22_AC4_AC5_AC6_AC7_HTTP_registration_and_browsing_share_authoritative_SQL_state_%s', async (status) => {
    const client = {
      async rpc(name, args) {
        try {
          if (name === 'register_for_event') {
            const { rows } = await register(args.p_attendee_id, args.p_event_request_id);
            return { data: rows[0].result, error: null };
          }
          expect(name).toBe('open_event_registration_state');
          const { rows } = await db.query(
            'select * from open_event_registration_state($1::uuid[], $2::uuid)',
            [args.p_event_ids, args.p_attendee_id],
          );
          return { data: rows, error: null };
        } catch (error) { return { error }; }
      },
      from(table) {
        expect(table).toBe('event_requests');
        const clauses = [];
        const params = [];
        const filter = (column, operator, value) => {
          params.push(value);
          clauses.push(`${column} ${operator} $${params.length}`);
          return chain;
        };
        // Translate only this detail query's Supabase interface to real SQL.
        const chain = {
          select: () => chain,
          eq: (column, value) => filter(column, '=', value),
          lte: (column, value) => filter(column, '<=', value),
          gt: (column, value) => filter(column, '>', value),
          or: (expression) => {
            const prefix = 'registration_closes_at.is.null,registration_closes_at.gt.';
            expect(expression.startsWith(prefix)).toBe(true);
            params.push(expression.slice(prefix.length));
            clauses.push(`(registration_closes_at is null or registration_closes_at > $${params.length})`);
            return chain;
          },
          then: (resolve, reject) => db.query(
            `select * from event_requests where ${clauses.join(' and ')}`, params,
          ).then(({ rows }) => ({ data: rows, error: null })).then(resolve, reject),
        };
        return chain;
      },
    };
    const requireAuth = createRequireAuth({
      verifyToken: async (token) => {
        if (token === 'attendee-token') return { id: ME };
        if (token === 'other-token') return { id: OTHER };
        return null;
      },
      loadRole: async (id) => (await db.query('select role from profiles where id = $1', [id])).rows[0]?.role,
    });
    const app = express().use('/api/open-events', createOpenEventRouter({ client, requireAuth }));
    await db.exec('set role service_role');
    try {
      if (status) {
        await seed(ME, status);
        const before = await records();
        const preview = await request(app).get(`/api/open-events/${event}`)
          .set('Authorization', 'Bearer attendee-token');
        expect(preview.status).toBe(200);
        expect(preview.body).toMatchObject({ placesLeft: 1, isRegistered: false, isFull: false, canRegister: false });
        expect(preview.body).not.toHaveProperty('registration_status');
        const response = await request(app).post(`/api/open-events/${event}/registrations`)
          .set('Authorization', 'Bearer attendee-token');
        expect(response.status).toBe(409);
        expect(response.body.code).toBe(status === 'waitlisted' ? 'ALREADY_WAITLISTED' : 'REGISTRATION_CANCELLED');
        expect(await records()).toEqual(before);
        return;
      }
      const before = await request(app).get(`/api/open-events/${event}`)
        .set('Authorization', 'Bearer attendee-token');
      expect(before.status).toBe(200);
      expect(before.body).toMatchObject({ placesLeft: 1, isRegistered: false, isFull: false, canRegister: true });
      const success = await request(app).post(`/api/open-events/${event}/registrations`)
        .set('Authorization', 'Bearer attendee-token');
      expect(success.status).toBe(201);
      expect(success.body).toMatchObject({ attendeeId: ME, eventRequestId: event, status: 'registered' });
      expect((await records()).map((row) => row.id)).toEqual([success.body.id]);
      for (const token of ['attendee-token', 'other-token']) {
        const fresh = await request(app).get(`/api/open-events/${event}`)
          .set('Authorization', `Bearer ${token}`);
        expect(fresh.status).toBe(200);
        expect(fresh.headers['cache-control']).toBe('no-store');
        expect(fresh.body).toMatchObject({ placesLeft: 0, isFull: true, canRegister: false, isRegistered: token === 'attendee-token' });
      }
      const full = await request(app).post(`/api/open-events/${event}/registrations`)
        .set('Authorization', 'Bearer other-token');
      expect(full.status).toBe(409);
      expect(full.body).toMatchObject({ code: 'EVENT_FULL', error: 'Event is full' });
      const repeated = await request(app).post(`/api/open-events/${event}/registrations`)
        .set('Authorization', 'Bearer attendee-token');
      expect(repeated.status).toBe(409);
      expect(repeated.body).toMatchObject({ code: 'ALREADY_REGISTERED', error: 'Already registered' });
      expect(await records()).toHaveLength(1);
    } finally { await db.exec('reset role'); }
  });
});
