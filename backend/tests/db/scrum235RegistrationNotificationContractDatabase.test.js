import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSchemaDb, seedEvent, rerunMigrationsFrom } from './helpers/schemaDb.js';
import { checkListValues } from '../domain/helpers/schemaVocabulary.js';
import {
  REGISTRATION_NOTIFICATION_TYPE,
  AUDIENCES_BY_TYPE,
  CAUSES_BY_TYPE,
} from '../../src/domain/registrationNotification.js';

// The registration notification contract (039): the types, the row-level
// shape check and notify_registration_change, which no flow calls yet.
const MIGRATIONS = join(import.meta.dirname, '../../db/migrations');
const ORGANISER = '11111111-1111-4111-8111-111111111111';
const COORDINATOR = '22222222-2222-4222-8222-222222222222';
const A = '44444444-4444-4444-8444-444444444444';
const B = '55555555-5555-4555-8555-555555555555';
const C = '66666666-6666-4666-8666-666666666666';
const NEW_TYPES = ['registration_opened', 'registration_closed',
  'registration_capacity_reached', 'registration_place_released'];
let db;
let event;

const notify = async (type, audiences, key, details = {}, eventId = event) => (await db.query(
  'select notify_registration_change($1, $2, $3, $4, $5) as n',
  [eventId, type, audiences, key, details],
)).rows[0].n;
const sent = async (type) => (await db.query(
  `select recipient_id, event_request_id, payload from notifications
    where type = $1 order by payload->>'audience', recipient_id`, [type],
)).rows;
// A refusal aborts the statement, not the test's transaction.
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
const refusedNotify = (type, audiences, key, details = {}, eventId = event) => refusal(
  'select notify_registration_change($1, $2, $3, $4, $5)', [eventId, type, audiences, key, details],
);
const insertRow = (type, eventId, payload) => refusal(
  'insert into notifications (recipient_id, type, event_request_id, payload) values ($1, $2, $3, $4)',
  [ORGANISER, type, eventId, payload],
);

beforeAll(async () => {
  db = await createSchemaDb();
  await db.query('insert into auth.users (id) select unnest($1::uuid[])', [[ORGANISER, COORDINATOR, A, B, C]]);
  await db.query("insert into profiles (id, role) values ($1, 'event_organiser'), ($2, 'event_coordinator')", [ORGANISER, COORDINATOR]);
  await db.query("insert into profiles (id, role) select unnest($1::uuid[]), 'attendee'", [[A, B, C]]);
  event = await seedEvent(db, {
    status: 'confirmed',
    organiser_id: ORGANISER,
    reviewing_coordinator_id: COORDINATOR,
    event_name: 'Contract event',
    proposed_start: '2026-12-01T10:00:00Z',
    registration_enabled: true,
    registration_opens_at: '2026-11-01T10:00:00Z',
    registration_capacity: 1,
    registration_waitlist_enabled: true,
  });
  // A holds the place, B and C queue; C then leaves, so only B is waiting.
  await db.query(
    `insert into event_registrations (event_request_id, attendee_id, status)
     values ($1, $2, 'registered'), ($1, $3, 'waitlisted'), ($1, $4, 'waitlisted')`,
    [event, A, B, C],
  );
  await db.query("update event_registrations set status = 'withdrawn' where attendee_id = $1", [C]);
}, 60_000);
afterAll(async () => { await db.close(); });
beforeEach(async () => { await db.exec('begin'); });
afterEach(async () => { await db.exec('rollback'); });

describe('notification types (039)', () => {
  it('SCRUM177_AC5_keeps_every_type_037_allowed_and_adds_the_four_registration_types', async () => {
    const before = [...readFileSync(join(MIGRATIONS, '037_event_waiting_list.sql'), 'utf8')
      .split('add constraint notifications_type_known')[1]
      .split(']')[0]
      .matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(before).toHaveLength(43);
    expect(await checkListValues(db, 'notifications_type_known')).toEqual([...before, ...NEW_TYPES]);
  });

  it('SCRUM177_AC5_the_domain_types_are_all_known_to_the_database', async () => {
    const known = await checkListValues(db, 'notifications_type_known');
    expect(known).toEqual(expect.arrayContaining(Object.values(REGISTRATION_NOTIFICATION_TYPE)));
  });

  it('SCRUM177_AC5_rerunning_the_migration_over_stored_notifications_keeps_them', async () => {
    await db.query(
      `insert into notifications (recipient_id, type, event_request_id, payload)
       values ($1, 'registration_promoted', $2, '{"registrationId": "r1", "waitlistedAt": "t"}'),
              ($1, 'registration_schedule_conflict', $2, '{"fields": []}')`,
      [A, event],
    );
    await notify('registration_opened', ['organiser'], 'k1', { cause: 'opening_time' });
    const count = async () => Number((await db.query('select count(*) as n from notifications')).rows[0].n);
    const before = await count();

    await rerunMigrationsFrom(db, '039_registration_notification_contract.sql');

    expect(await count()).toBe(before);
  });
});

describe('notify_registration_change recipients and payload', () => {
  it('SCRUM177_AC6_sends_staff_notices_to_the_organiser_and_assigned_coordinator_only', async () => {
    const n = await notify('registration_capacity_reached', ['organiser', 'coordinator'], 'full-1',
      { capacity: 1, registeredCount: 1 });

    expect(n).toBe(2);
    expect(await sent('registration_capacity_reached')).toEqual([
      { recipient_id: COORDINATOR, event_request_id: event, payload: expect.objectContaining({ audience: 'coordinator' }) },
      { recipient_id: ORGANISER, event_request_id: event, payload: expect.objectContaining({ audience: 'organiser' }) },
    ]);
  });

  it('SCRUM177_AC6_a_coordinator_who_is_also_the_organiser_is_told_once', async () => {
    await db.query('update event_requests set assigned_coordinator_id = organiser_id where id = $1', [event]);

    expect(await notify('registration_closed', ['organiser', 'coordinator'], 'c1', { cause: 'switched_off' })).toBe(1);
  });

  it('SCRUM177_AC6_waitlisted_reaches_only_attendees_queued_now', async () => {
    await notify('registration_closed', ['waitlisted'], 'c1', { cause: 'closing_time', closedAt: '2026-11-20T10:00:00Z' });

    expect((await sent('registration_closed')).map((r) => r.recipient_id)).toEqual([B]);
  });

  it('SCRUM177_AC5_every_payload_names_its_event_and_carries_only_counts', async () => {
    await notify('registration_place_released', ['organiser'], 'w1',
      { cause: 'withdrawal', capacity: 1, registeredCount: 0 });

    const [{ payload, event_request_id }] = await sent('registration_place_released');
    expect(event_request_id).toBe(event);
    expect(payload).toEqual({
      audience: 'organiser',
      eventRequestId: event,
      eventName: 'Contract event',
      occurrenceKey: 'w1',
      cause: 'withdrawal',
      capacity: 1,
      registeredCount: 0,
    });
  });

  it('SCRUM177_AC5_shared_fields_win_over_details', async () => {
    await notify('registration_opened', ['organiser'], 'o1',
      { cause: 'settings_changed', audience: 'waitlisted', eventName: 'Spoofed', eventRequestId: 'x' });

    const [{ payload }] = await sent('registration_opened');
    expect(payload).toMatchObject({ audience: 'organiser', eventName: 'Contract event', eventRequestId: event, occurrenceKey: 'o1' });
  });

  it('SCRUM177_AC1_a_repeated_occurrence_sends_nothing_and_a_new_one_sends_again', async () => {
    const open = (key) => notify('registration_opened', ['organiser', 'waitlisted'], key, { cause: 'opening_time' });

    expect(await open('o1')).toBe(2);
    expect(await open('o1')).toBe(0);
    expect(await open('o2')).toBe(2);
  });
});

describe('notify_registration_change refusals', () => {
  it.each(['registration_capacity_reached', 'registration_place_released'])(
    'SCRUM177_AC6_%s_is_never_sent_to_attendees',
    async (type) => {
      expect(await refusedNotify(type, ['waitlisted'], 'k', { cause: 'withdrawal' })).toBe('22023');
    },
  );

  it('SCRUM177_AC6_refuses_an_unknown_audience_or_none', async () => {
    expect(await refusedNotify('registration_opened', ['attendees'], 'k', { cause: 'opening_time' })).toBe('22023');
    expect(await refusedNotify('registration_opened', [], 'k', { cause: 'opening_time' })).toBe('22023');
  });

  it('SCRUM177_AC5_refuses_other_types_including_promotion_which_keeps_its_own_writer', async () => {
    expect(await refusedNotify('registration_promoted', ['organiser'], 'k')).toBe('22023');
    expect(await refusedNotify('event_cancelled', ['organiser'], 'k')).toBe('22023');
  });

  it('SCRUM177_AC1_refuses_a_missing_occurrence_key_or_cause', async () => {
    expect(await refusedNotify('registration_closed', ['organiser'], '', { cause: 'switched_off' })).toBe('22023');
    expect(await refusedNotify('registration_closed', ['organiser'], 'k', {})).toBe('22023');
    expect(await refusedNotify('registration_closed', ['organiser'], 'k', { cause: 'opening_time' })).toBe('22023');
  });

  it('SCRUM177_AC5_refuses_an_unknown_event', async () => {
    expect(await refusedNotify('registration_closed', ['organiser'], 'k', { cause: 'switched_off' },
      '99999999-9999-4999-8999-999999999999')).toBe('P0002');
  });

  it('SCRUM177_AC5_the_domain_audiences_and_causes_are_the_ones_the_writer_accepts', async () => {
    for (const [type, audiences] of Object.entries(AUDIENCES_BY_TYPE)) {
      const causes = CAUSES_BY_TYPE[type] ?? [undefined];
      for (const cause of causes) {
        expect(await refusedNotify(type, [...audiences], `${type}-${cause}`, cause ? { cause } : {})).toBeNull();
      }
    }
  });
});

describe('notifications_registration_change_shape', () => {
  const payload = { audience: 'organiser', occurrenceKey: 'k' };

  it('SCRUM177_AC5_accepts_a_well_formed_row', async () => {
    expect(await insertRow('registration_capacity_reached', event, payload)).toBeNull();
  });

  it('SCRUM177_AC5_refuses_a_row_without_its_event', async () => {
    expect(await insertRow('registration_capacity_reached', null, payload)).toBe('23514');
  });

  it('SCRUM177_AC1_refuses_a_row_without_an_occurrence_key', async () => {
    expect(await insertRow('registration_opened', event, { audience: 'organiser' })).toBe('23514');
  });

  it('SCRUM177_AC6_refuses_a_staff_only_row_for_attendees_or_with_no_audience', async () => {
    expect(await insertRow('registration_capacity_reached', event, { ...payload, audience: 'waitlisted' })).toBe('23514');
    expect(await insertRow('registration_place_released', event, { occurrenceKey: 'k' })).toBe('23514');
  });

  it('SCRUM177_AC5_leaves_other_types_alone', async () => {
    expect(await insertRow('registration_schedule_conflict', event, {})).toBeNull();
  });
});
