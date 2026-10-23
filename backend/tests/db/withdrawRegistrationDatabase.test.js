import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { withdrawRegistration } from '../../src/services/registrationWithdrawalService.js';
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';

// withdraw_registration against the final schema, on a stubbed clock. PGlite has
// one connection, so the two-session races are in registrationWithdrawalConcurrency.manual.sql.
const ME = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const ORGANISER = '66666666-6666-4666-8666-666666666666';
const DEADLINE = '2026-10-18T10:00:00Z';
let db;
let event;

const seedRegistration = async (attendee = ME, status = 'registered') => (await db.query(
  `insert into event_registrations (event_request_id, attendee_id, status, registered_at, created_at, updated_at)
   values ($1, $2, $3, '2026-10-12T10:00:00Z', '2026-10-12T10:00:00Z', '2026-10-12T10:00:00Z')
   returning id`, [event, attendee, status],
)).rows[0].id;
const withdraw = (registration, attendee = ME) => db.query(
  'select withdraw_registration($1::uuid, $2::uuid) as result', [registration, attendee],
);
const stored = async (id) => (await db.query('select * from event_registrations where id = $1', [id])).rows[0];
const eventRegistrations = async () => (await db.query(
  'select * from event_registrations where event_request_id = $1 order by id', [event],
)).rows;
// A refusal aborts the transaction; the savepoint lets the test read afterwards.
const refused = async (act, expected) => {
  await db.exec('savepoint refusal');
  await expect(act()).rejects.toMatchObject(expected);
  await db.exec('rollback to savepoint refusal');
};
const client = {
  rpc: async (name, args) => {
    expect(name).toBe('withdraw_registration');
    try {
      const { rows } = await withdraw(args.p_registration_id, args.p_attendee_id);
      return { data: rows[0].result, error: null };
    } catch (error) { return { data: null, error }; }
  },
};

beforeAll(async () => {
  db = await createSchemaDb();
  await db.query('insert into auth.users (id) values ($1), ($2), ($3)', [ME, OTHER, ORGANISER]);
  await db.query(`insert into profiles (id, role) values ($1, 'attendee'), ($2, 'attendee'),
    ($3, 'event_coordinator')`, [ME, OTHER, ORGANISER]);
  event = await seedEvent(db, {
    status: 'confirmed',
    organiser_id: ORGANISER,
    reviewing_coordinator_id: ORGANISER,
    event_name: 'Event',
    proposed_start: '2026-10-20T10:00:00Z',
    registration_enabled: true,
    registration_opens_at: '2026-10-10T10:00:00Z',
    registration_withdrawal_deadline: DEADLINE,
  });
  // Fails the status write after it is made, to prove the withdrawal rolls back whole.
  await db.exec(`
    create function public.clock_timestamp() returns timestamptz language sql
      as $$ select current_setting('test.withdrawal_time')::timestamptz $$;
    set search_path = public, pg_catalog;
    create function fail_test_withdrawal() returns trigger language plpgsql as $$
    begin
      if new.id::text = current_setting('test.fail_registration', true) then
        raise exception 'Injected post-update failure';
      end if;
      return new;
    end;
    $$;
    create trigger fail_test_withdrawal after update on event_registrations
      for each row execute function fail_test_withdrawal();
  `);
});
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec('begin');
  await db.query("select set_config('test.withdrawal_time', '2026-10-16T10:00:00Z', true)");
});
afterEach(async () => { await db.exec('rollback'); });

describe('SCRUM27 withdrawing a registration in PostgreSQL', () => {
  it('SCRUM27_AC3_persists_withdrawn_on_the_same_record', async () => {
    const id = await seedRegistration();
    const before = await stored(id);
    const { rows: [{ result }] } = await withdraw(id);

    const after = await stored(id);
    expect(after).toEqual({ ...before, status: 'withdrawn', updated_at: after.updated_at });
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    expect(result).toMatchObject({
      outcome: 'withdrawn',
      registration: { id, eventRequestId: event, attendeeId: ME, status: 'withdrawn' },
    });
  });

  it('SCRUM27_AC3_changes_only_the_withdrawing_attendees_registration', async () => {
    const mine = await seedRegistration();
    await seedRegistration(OTHER);
    const others = (await eventRegistrations()).filter((row) => row.id !== mine);
    await withdraw(mine);
    expect((await eventRegistrations()).filter((row) => row.id !== mine)).toEqual(others);
  });

  it.each([
    ['a passed deadline', async () => {
      const id = await seedRegistration();
      await db.query("select set_config('test.withdrawal_time', $1, true)", [DEADLINE]);
      return [id, ME, { code: '55000', hint: 'WITHDRAWAL_DEADLINE_PASSED' }];
    }],
    ['another attendee', async () => [await seedRegistration(OTHER), ME, { code: 'P0002', hint: 'REGISTRATION_NOT_OWNED' }]],
    ['a waitlisted registration', async () => [await seedRegistration(ME, 'waitlisted'), ME,
      { code: '55000', hint: 'REGISTRATION_NOT_CONFIRMED' }]],
  ])('SCRUM27_AC7_refuses_%s_and_leaves_the_registration_unchanged', async (_case, arrange) => {
    const [id, attendee, expected] = await arrange();
    const before = await eventRegistrations();
    await refused(() => withdraw(id, attendee), expected);
    expect(await eventRegistrations()).toEqual(before);
    expect((await stored(id)).status).not.toBe('withdrawn');
  });

  it('SCRUM27_AC3_a_repeated_request_is_refused_and_changes_nothing_more', async () => {
    const id = await seedRegistration();
    await withdraw(id);
    const once = await stored(id);
    await refused(() => withdraw(id), { code: '55000', hint: 'ALREADY_WITHDRAWN' });
    expect(await stored(id)).toEqual(once);
    expect(await eventRegistrations()).toHaveLength(1);
  });

  // Outside the test transaction, with nothing to roll back to: only the call's
  // own atomicity can undo the write, so a swallowed failure would leave it saved.
  it('SCRUM27_AC3_a_failure_after_the_write_rolls_the_withdrawal_back', async () => {
    await db.exec('rollback');
    const id = await seedRegistration();
    try {
      const before = await stored(id);
      await db.query(`select set_config('test.withdrawal_time', '2026-10-16T10:00:00Z', false),
        set_config('test.fail_registration', $1, false)`, [id]);
      await expect(withdraw(id)).rejects.toMatchObject({ message: 'Injected post-update failure' });
      expect(await stored(id)).toEqual(before);
    } finally {
      await db.query("select set_config('test.fail_registration', '', false)");
      await db.query('delete from event_registrations where id = $1', [id]);
      await db.exec('begin');
    }
  });

  it('SCRUM27_AC3_a_withdrawn_attendee_can_register_again_on_the_same_record', async () => {
    const id = await seedRegistration();
    await withdraw(id);
    const { rows: [{ result }] } = await db.query(
      'select register_for_event($1::uuid, $2::uuid) as result', [event, ME],
    );
    expect(result).toMatchObject({ outcome: 'registered', registration: { id, status: 'registered' } });
  });

  it.each(['anon', 'authenticated'])('SCRUM27_AC3_denies_direct_function_access_to_%s', async (role) => {
    const id = await seedRegistration();
    await db.exec(`set local role ${role}`);
    await refused(() => withdraw(id), { code: '42501', message: 'permission denied for function withdraw_registration' });
  });

  it('SCRUM27_AC3_runs_the_service_with_the_API_role_against_real_SQL', async () => {
    const id = await seedRegistration();
    await db.exec('set local role service_role');
    await expect(withdrawRegistration({ attendeeId: ME, registrationId: id, client }))
      .resolves.toMatchObject({ id, eventRequestId: event, attendeeId: ME, status: 'withdrawn' });
    await db.exec('savepoint repeat');
    await expect(withdrawRegistration({ attendeeId: ME, registrationId: id, client }))
      .rejects.toMatchObject({ status: 409, code: 'ALREADY_WITHDRAWN' });
    await db.exec('rollback to savepoint repeat');
  });
});
