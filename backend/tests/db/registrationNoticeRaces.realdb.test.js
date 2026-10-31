import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { REAL_DB_URL, createRealSchemaDb, waitUntilBlocked } from './helpers/realDb.js';
import { seedEvent } from './helpers/schemaDb.js';

// SCRUM-240: registration notices under truly simultaneous workers, on a real
// PostgreSQL server with independent connections, as in the SCRUM-476 races.
// Worker A's transaction is held open, worker B is started and confirmed
// blocked on A's lock, and only then does A commit or roll back.
// Skipped unless CONCURRENCY_DATABASE_URL names a disposable server.

const ORGANISER = '11111111-1111-4111-8111-111111111111';
const COORDINATOR = '22222222-2222-4222-8222-222222222222';
const X = 'a0000000-0000-4000-8000-00000000000a';
const Y = 'a0000000-0000-4000-8000-00000000000b';
const ATTENDEES = [X, Y];
const DAY = 24 * 60 * 60 * 1000;
const OPENS = new Date(Date.now() - DAY).toISOString();
const DEADLINE = new Date(Date.now() + 5 * DAY).toISOString();
const START = new Date(Date.now() + 10 * DAY).toISOString();

let owner;
let A;
let B;

const runJob = async (client) => (await client.query('select process_registration_window_notices() as r')).rows[0].r;
const saveOpen = async (client, event) => (await client.query(
  'select setup_event_registration($1, $2, true, $3, null, 1, $4, true) as r',
  [event, ORGANISER, OPENS, DEADLINE],
)).rows[0].r;
const registrationId = async (event, attendee) => (await owner.query(
  'select id from event_registrations where event_request_id = $1 and attendee_id = $2', [event, attendee],
)).rows[0].id;
const withdraw = async (client, event, attendee) => (await client.query(
  'select withdraw_registration($1, $2) as r', [await registrationId(event, attendee), attendee],
)).rows[0].r;
const capacity = (client, event) => client.query("select announce_registration_capacity($1, 'withdrawal')", [event]);

/** As in the SCRUM-476 races: A runs `first` in an open transaction, B runs `second` and is seen blocked, then A finishes. */
async function race(first, second, { finish = 'commit' } = {}) {
  await A.query('begin');
  await first(A);
  const pending = second(B).then((value) => ({ value }), (error) => ({ error }));
  await waitUntilBlocked(owner, B.pid);
  await A.query(finish);
  return pending;
}

/** A Confirmed event whose window is open now but not yet announced: the job finds it due. */
async function dueEvent({ registerX = false } = {}) {
  const event = await seedEvent(owner, {
    status: 'confirmed',
    organiser_id: ORGANISER,
    reviewing_coordinator_id: COORDINATOR,
    event_name: 'Notice race',
    proposed_start: START,
    registration_enabled: true,
    registration_opens_at: OPENS,
    registration_capacity: 1,
    registration_withdrawal_deadline: DEADLINE,
    registration_waitlist_enabled: true,
  });
  if (registerX) {
    await owner.query('select register_for_event($1, $2)', [event, X]);
  }
  return event;
}

/** Notices for one event, as { 'type key recipient': count }. */
async function notices(event) {
  const { rows } = await owner.query(
    `select type, payload->>'occurrenceKey' as key, recipient_id, count(*)::int as n
       from notifications where event_request_id = $1
      group by 1, 2, 3 order by 1, 2, 3`, [event],
  );
  return Object.fromEntries(rows.map((r) => [`${r.type} ${r.key} ${r.recipient_id}`, r.n]));
}

describe.skipIf(!REAL_DB_URL)('SCRUM240 registration notices under simultaneous workers', () => {
  beforeAll(async () => {
    const db = await createRealSchemaDb({ database: 'connectsphere_notice_races' });
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

  it('SCRUM240_two_job_runs_at_once_announce_an_opening_once', async () => {
    const event = await dueEvent();

    const second = await race((client) => runJob(client), (client) => runJob(client));

    expect(second.error).toBeUndefined();
    expect(await notices(event)).toEqual({
      [`registration_opened opened:1 ${COORDINATOR}`]: 1,
      [`registration_opened opened:1 ${ORGANISER}`]: 1,
    });
  });

  it('SCRUM240_if_the_first_run_rolls_back_the_second_announces_with_the_same_key', async () => {
    const event = await dueEvent();

    await race((client) => runJob(client), (client) => runJob(client), { finish: 'rollback' });

    expect(await notices(event)).toEqual({
      [`registration_opened opened:1 ${COORDINATOR}`]: 1,
      [`registration_opened opened:1 ${ORGANISER}`]: 1,
    });
  });

  it('SCRUM240_a_settings_save_and_the_job_at_once_announce_the_opening_once', async () => {
    const event = await dueEvent();

    const second = await race((client) => saveOpen(client, event), (client) => runJob(client));

    expect(second.error).toBeUndefined();
    // The save came first, so the Organiser who made it is not told; the job then finds it settled.
    expect(await notices(event)).toEqual({ [`registration_opened opened:1 ${COORDINATOR}`]: 1 });
  });

  it('SCRUM240_a_withdrawal_and_a_stale_capacity_call_at_once_release_the_place_once', async () => {
    const event = await dueEvent({ registerX: true });

    const second = await race((client) => withdraw(client, event, X), (client) => capacity(client, event));

    expect(second.error).toBeUndefined();
    const released = Object.entries(await notices(event)).filter(([key]) => key.startsWith('registration_place_released'));
    expect(released).toEqual([
      [`registration_place_released released:2 ${COORDINATOR}`, 1],
      [`registration_place_released released:2 ${ORGANISER}`, 1],
    ]);
  });
});
