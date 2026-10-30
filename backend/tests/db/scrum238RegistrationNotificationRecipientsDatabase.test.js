import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';

// Who receives registration notices (041): registration_notification_recipients
// and the handlers and promotion that use it. Recipients come from the event row
// and its registrations only, and each person is told once.
const ORGANISER = '11111111-1111-4111-8111-111111111111';
const COORDINATOR = '22222222-2222-4222-8222-222222222222';
const COORDINATOR_2 = '33333333-3333-4333-8333-333333333333';
const A = '44444444-4444-4444-8444-444444444444';
const B = '55555555-5555-4555-8555-555555555555';
const C = '66666666-6666-4666-8666-666666666666';
const D = '77777777-7777-4777-8777-777777777777';
const OTHER_ORGANISER = '88888888-8888-4888-8888-888888888888';
const EVERYONE = [ORGANISER, COORDINATOR, COORDINATOR_2, A, B, C, D, OTHER_ORGANISER];
let db;
let event;
let other;

const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
const ahead = (days) => ago(-days);
const enrol = async (attendee, status, eventId = event) => (await db.query(
  `insert into event_registrations (event_request_id, attendee_id, status) values ($1, $2, $3)
   on conflict (event_request_id, attendee_id) do update set status = excluded.status
   returning id`,
  [eventId, attendee, status],
)).rows[0].id;
const resolve = async (audiences, { eventId = event, registrations = null, exclude = null } = {}) => (await db.query(
  `select recipient_id, audience from registration_notification_recipients($1, $2, $3, $4)
    order by audience, recipient_id`,
  [eventId, audiences, registrations, exclude],
)).rows.map((r) => [r.audience, r.recipient_id]);
const setEvent = (fields, eventId = event) => db.query(
  `update event_requests set ${Object.keys(fields).map((key, i) => `${key} = $${i + 2}`).join(', ')} where id = $1`,
  [eventId, ...Object.values(fields)],
);
// Every notice sent, as [type, audience, recipient], so an extra recipient shows.
const sent = async () => (await db.query(
  `select type, payload->>'audience' as audience, recipient_id from notifications
    order by type, audience, recipient_id`,
)).rows.map((r) => [r.type, r.audience, r.recipient_id]);
async function refusal(sql, params) {
  await db.exec('savepoint refusal');
  try {
    await db.query(sql, params);
  } catch (error) {
    await db.exec('rollback to savepoint refusal');
    return error.code;
  }
  await db.exec('release savepoint refusal');
  return null;
}

beforeAll(async () => {
  db = await createSchemaDb();
  await db.query('insert into auth.users (id) select unnest($1::uuid[])', [EVERYONE]);
  await db.query(
    `insert into profiles (id, role) values ($1, 'event_organiser'), ($2, 'event_coordinator'),
       ($3, 'event_coordinator'), ($4, 'event_organiser')`,
    [ORGANISER, COORDINATOR, COORDINATOR_2, OTHER_ORGANISER],
  );
  await db.query("insert into profiles (id, role) select unnest($1::uuid[]), 'attendee'", [[A, B, C, D]]);
}, 60_000);
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec('begin');
  const open = {
    status: 'confirmed',
    proposed_start: ahead(10),
    registration_enabled: true,
    registration_opens_at: ago(1),
    registration_capacity: 1,
    registration_waitlist_enabled: true,
  };
  event = await seedEvent(db, { ...open, organiser_id: ORGANISER, reviewing_coordinator_id: COORDINATOR, event_name: 'Ours' });
  // Another event, with its own managers and queue, none of whom are ours.
  other = await seedEvent(db, { ...open, organiser_id: OTHER_ORGANISER, reviewing_coordinator_id: COORDINATOR_2, event_name: 'Theirs' });
  // Ours: A holds the place, B is queued, C left the queue. D is queued only for the other event.
  await enrol(A, 'registered');
  await enrol(B, 'waitlisted');
  await enrol(C, 'withdrawn');
  await enrol(A, 'registered', other);
  await enrol(D, 'waitlisted', other);
});
afterEach(async () => { await db.exec('rollback'); });

describe('managers', () => {
  it('SCRUM177_AC2_capacity_goes_to_the_organiser_and_assigned_coordinator', async () => {
    expect(await resolve(['organiser', 'coordinator'])).toEqual([['coordinator', COORDINATOR], ['organiser', ORGANISER]]);
  });

  it('SCRUM177_AC6_only_the_coordinator_assigned_now_is_told', async () => {
    await setEvent({ assigned_coordinator_id: COORDINATOR_2 });

    expect(await resolve(['coordinator'])).toEqual([['coordinator', COORDINATOR_2]]);
  });

  it('SCRUM177_AC6_an_event_with_no_coordinator_has_no_coordinator_recipient', async () => {
    const unassigned = await seedEvent(db, { status: 'submitted', organiser_id: ORGANISER, event_name: 'Queued' });

    expect(await resolve(['organiser', 'coordinator'], { eventId: unassigned })).toEqual([['organiser', ORGANISER]]);
  });

  it('SCRUM177_AC2_an_organiser_who_is_also_the_coordinator_is_told_once', async () => {
    await setEvent({ assigned_coordinator_id: ORGANISER });

    expect(await resolve(['organiser', 'coordinator'])).toEqual([['organiser', ORGANISER]]);
  });
});

describe('attendees', () => {
  it('SCRUM177_AC3_waitlisted_is_only_this_events_queue_now', async () => {
    expect(await resolve(['waitlisted'])).toEqual([['waitlisted', B]]);
  });

  it('SCRUM177_AC6_registered_withdrawn_and_cancelled_attendees_are_not_on_the_queue', async () => {
    await enrol(B, 'cancelled');

    expect(await resolve(['waitlisted'])).toEqual([]);
  });

  it('SCRUM177_AC3_registrant_is_the_attendee_of_that_registration_whatever_its_status_now', async () => {
    const promoted = await enrol(B, 'registered');
    const departed = await enrol(C, 'withdrawn');

    expect(await resolve(['registrant'], { registrations: [promoted, departed] }))
      .toEqual([['registrant', B], ['registrant', C]]);
  });

  it('SCRUM177_AC6_refuses_a_registration_from_another_event_or_none', async () => {
    const theirs = await enrol(D, 'waitlisted', other);
    const sql = 'select * from registration_notification_recipients($1, $2, $3)';

    expect(await refusal(sql, [event, ['registrant'], [theirs]])).toBe('22023');
    expect(await refusal(sql, [event, ['registrant'], null])).toBe('22023');
    expect(await refusal(sql, [event, ['registrant'], []])).toBe('22023');
  });

  it('SCRUM177_AC3_a_queued_registrant_is_told_once_as_the_registrant', async () => {
    const queued = await enrol(B, 'waitlisted');

    expect(await resolve(['registrant', 'waitlisted'], { registrations: [queued] })).toEqual([['registrant', B]]);
  });
});

describe('one person in several roles', () => {
  // The schema keeps one role per profile, but requirements §1 allows several;
  // a registration row for a manager stands in for that.
  it('SCRUM177_AC6_an_organiser_also_on_the_queue_is_told_once_as_organiser', async () => {
    await enrol(ORGANISER, 'waitlisted');

    expect(await resolve(['organiser', 'coordinator', 'waitlisted'])).toEqual([
      ['coordinator', COORDINATOR], ['organiser', ORGANISER], ['waitlisted', B],
    ]);
  });

  it('SCRUM177_AC6_a_coordinator_also_on_the_queue_is_told_once_as_coordinator', async () => {
    await enrol(COORDINATOR, 'waitlisted');

    expect(await resolve(['coordinator', 'waitlisted'])).toEqual([['coordinator', COORDINATOR], ['waitlisted', B]]);
  });

  it('SCRUM177_AC6_the_excluded_actor_is_left_out_in_every_role', async () => {
    await enrol(ORGANISER, 'waitlisted');

    expect(await resolve(['organiser', 'coordinator', 'waitlisted'], { exclude: ORGANISER }))
      .toEqual([['coordinator', COORDINATOR], ['waitlisted', B]]);
  });
});

describe('the handlers send to exactly the resolved people', () => {
  it('SCRUM177_AC6_opening_and_filling_reach_our_managers_and_queue_and_nobody_else', async () => {
    await db.query('select announce_registration_window($1, null)', [event]);
    await db.query("select announce_registration_capacity($1, 'registration')", [event]);

    expect(await sent()).toEqual([
      ['registration_capacity_reached', 'coordinator', COORDINATOR],
      ['registration_capacity_reached', 'organiser', ORGANISER],
      ['registration_opened', 'coordinator', COORDINATOR],
      ['registration_opened', 'organiser', ORGANISER],
      ['registration_opened', 'waitlisted', B],
    ]);
  });

  it('SCRUM177_AC2_capacity_reached_with_one_person_in_both_roles_is_one_notice', async () => {
    await setEvent({ assigned_coordinator_id: ORGANISER });
    await db.query("select announce_registration_capacity($1, 'registration')", [event]);

    expect(await sent()).toEqual([['registration_capacity_reached', 'organiser', ORGANISER]]);
  });

  it('SCRUM177_AC6_an_organiser_on_their_own_queue_is_not_told_of_their_own_save', async () => {
    await enrol(ORGANISER, 'waitlisted');
    await db.query("select announce_registration_window($1, 'settings_changed')", [event]);

    expect(await sent()).toEqual([
      ['registration_opened', 'coordinator', COORDINATOR],
      ['registration_opened', 'waitlisted', B],
    ]);
  });
});

describe('promotion', () => {
  it('SCRUM177_AC3_the_promoted_attendee_alone_is_told_although_they_left_the_queue', async () => {
    const queued = await enrol(B, 'waitlisted');
    await enrol(C, 'waitlisted');
    await enrol(A, 'withdrawn');

    expect((await db.query('select promote_waitlisted_registrations($1) as n', [event])).rows[0].n).toBe(1);

    expect(await sent()).toEqual([['registration_promoted', null, B]]);
    const { rows: [{ payload, expected }] } = await db.query(
      `select n.payload, to_char(r.waitlisted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as expected
         from notifications n join event_registrations r on r.id = (n.payload->>'registrationId')::uuid
        where n.type = 'registration_promoted'`,
    );
    expect(payload).toEqual({ eventRequestId: event, eventName: 'Ours', registrationId: queued, waitlistedAt: expected });
  });
});
