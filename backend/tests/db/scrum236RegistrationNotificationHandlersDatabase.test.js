import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createSchemaDb, seedEvent, rerunMigrationsFrom } from './helpers/schemaDb.js';
import { withSafetyReviewTransitionGuardDisabled } from '../fixtures/safetyReviewTestHelpers.js';

// The transition rules (040): announce_registration_window and
// announce_registration_capacity, and the recipient resolution under them.
// Times are relative to the real clock: a handler reads clock_timestamp().
const ORGANISER = '11111111-1111-4111-8111-111111111111';
const COORDINATOR = '22222222-2222-4222-8222-222222222222';
const A = '44444444-4444-4444-8444-444444444444';
const B = '55555555-5555-4555-8555-555555555555';
const C = '66666666-6666-4666-8666-666666666666';
let db;
let event;

const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
const ahead = (days) => ago(-days);
const scalar = async (sql, params) => (await db.query(sql, params)).rows[0].v;
const window_ = (cause = null, id = event) =>
  scalar('select announce_registration_window($1, $2) as v', [id, cause]);
const capacity = (cause, id = event) =>
  scalar('select announce_registration_capacity($1, $2) as v', [id, cause]);
const setEvent = (fields) => db.query(
  `update event_requests set ${Object.keys(fields).map((key, i) => `${key} = $${i + 2}`).join(', ')} where id = $1`,
  [event, ...Object.values(fields)],
);
const enrol = (attendee, status) => db.query(
  `insert into event_registrations (event_request_id, attendee_id, status) values ($1, $2, $3)
   on conflict (event_request_id, attendee_id) do update set status = excluded.status`,
  [event, attendee, status],
);
const notices = async (type) => (await db.query(
  `select recipient_id, payload from notifications where type = $1 and event_request_id = $2
    order by created_at, payload->>'audience', recipient_id`, [type, event],
)).rows;
const recipients = async (type) => (await notices(type)).map((n) => [n.payload.audience, n.recipient_id]);
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
  await db.query('insert into auth.users (id) select unnest($1::uuid[])', [[ORGANISER, COORDINATOR, A, B, C]]);
  await db.query("insert into profiles (id, role) values ($1, 'event_organiser'), ($2, 'event_coordinator')", [ORGANISER, COORDINATOR]);
  await db.query("insert into profiles (id, role) select unnest($1::uuid[]), 'attendee'", [[A, B, C]]);
}, 60_000);
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec('begin');
  // Open now, capacity 1: A holds the place, B is queued, C left the queue.
  event = await seedEvent(db, {
    status: 'confirmed',
    organiser_id: ORGANISER,
    reviewing_coordinator_id: COORDINATOR,
    event_name: 'Handler event',
    proposed_start: ahead(10),
    registration_enabled: true,
    registration_opens_at: ago(1),
    registration_closes_at: ahead(5),
    registration_capacity: 1,
    registration_waitlist_enabled: true,
  });
  await enrol(A, 'registered');
  await enrol(B, 'waitlisted');
  await enrol(C, 'withdrawn');
});
afterEach(async () => { await db.exec('rollback'); });

describe('announce_registration_window: opening', () => {
  it('SCRUM177_AC1_time_opening_the_window_tells_staff_and_the_waiting_list', async () => {
    await setEvent({ registration_opens_at: ahead(1) });
    expect(await window_()).toBe(0);

    const opens = ago(1);
    await setEvent({ registration_opens_at: opens });
    expect(await window_()).toBe(3);

    expect(await recipients('registration_opened')).toEqual([
      ['coordinator', COORDINATOR], ['organiser', ORGANISER], ['waitlisted', B],
    ]);
    const [{ payload }] = await notices('registration_opened');
    expect(payload).toMatchObject({ cause: 'opening_time', eventName: 'Handler event', eventRequestId: event });
    expect(Date.parse(payload.opensAt)).toBe(Date.parse(opens));
    expect(payload.closesAt).toMatch(/Z$/);
    expect(payload.occurrenceKey).toMatch(/^opened:/);
  });

  it('SCRUM177_AC1_repeated_calls_on_an_open_window_send_nothing_more', async () => {
    expect(await window_()).toBe(3);
    expect(await window_()).toBe(0);
    expect(await window_('settings_changed')).toBe(0);
    expect(await notices('registration_opened')).toHaveLength(3);
  });

  it('SCRUM177_AC1_a_window_with_no_closing_time_reports_null', async () => {
    await setEvent({ registration_closes_at: null });
    await window_();
    expect((await notices('registration_opened'))[0].payload.closesAt).toBeNull();
  });

  it('SCRUM177_AC1_a_return_to_confirmed_names_its_cause_and_tells_the_organiser', async () => {
    expect(await window_('event_confirmed')).toBe(3);
    expect((await notices('registration_opened'))[0].payload.cause).toBe('event_confirmed');
  });

  it('SCRUM177_AC6_the_organiser_is_not_told_of_their_own_settings_save', async () => {
    expect(await window_('settings_changed')).toBe(2);
    expect(await recipients('registration_opened')).toEqual([['coordinator', COORDINATOR], ['waitlisted', B]]);
  });

  it('SCRUM177_AC1_a_window_that_never_opened_sends_nothing', async () => {
    await setEvent({ registration_enabled: false });
    expect(await window_()).toBe(0);
    expect(await window_('settings_changed')).toBe(0);
  });
});

describe('announce_registration_window: closing', () => {
  beforeEach(async () => { await window_(); });

  it('SCRUM177_AC1_the_closing_time_passing_tells_staff_and_the_waiting_list', async () => {
    const closes = ago(0.01);
    await setEvent({ registration_closes_at: closes, registration_opens_at: ago(2) });

    expect(await window_()).toBe(3);
    const [{ payload }] = await notices('registration_closed');
    expect(payload).toMatchObject({ cause: 'closing_time', audience: 'coordinator' });
    expect(Date.parse(payload.closedAt)).toBe(Date.parse(closes));
    expect(await window_()).toBe(0);
  });

  it('SCRUM177_AC1_switching_off_tells_the_coordinator_and_queue_not_the_organiser', async () => {
    await setEvent({ registration_enabled: false });

    expect(await window_('settings_changed')).toBe(2);
    expect(await recipients('registration_closed')).toEqual([['coordinator', COORDINATOR], ['waitlisted', B]]);
    expect((await notices('registration_closed'))[0].payload.cause).toBe('switched_off');
  });

  it('SCRUM177_AC1_moving_the_opening_time_later_closes_with_settings_changed', async () => {
    await setEvent({ registration_opens_at: ahead(1) });

    await window_('settings_changed');
    expect((await notices('registration_closed'))[0].payload.cause).toBe('settings_changed');
  });

  it('SCRUM177_AC3_an_event_that_started_does_not_tell_its_queue_it_is_paused', async () => {
    // A confirmed start is locked, so this is an event announced open whose start has since passed.
    const started = ago(0.01);
    event = await seedEvent(db, {
      status: 'confirmed', organiser_id: ORGANISER, reviewing_coordinator_id: COORDINATOR,
      event_name: 'Started event', proposed_start: started,
      registration_enabled: true, registration_opens_at: ago(2), registration_waitlist_enabled: true,
    });
    await enrol(B, 'waitlisted');
    await db.query('insert into registration_notice_state (event_request_id, open_announced) values ($1, true)', [event]);

    expect(await window_()).toBe(2);
    expect(await recipients('registration_closed')).toEqual([['coordinator', COORDINATOR], ['organiser', ORGANISER]]);
    expect((await notices('registration_closed'))[0].payload.cause).toBe('event_started');
  });

  it('SCRUM177_AC1_leaving_confirmed_closes_with_event_not_confirmed', async () => {
    await withSafetyReviewTransitionGuardDisabled(db, () => setEvent({ status: 'approved' }));

    expect(await window_()).toBe(3);
    expect((await notices('registration_closed'))[0].payload.cause).toBe('event_not_confirmed');
  });

  it('SCRUM177_AC1_a_cancelled_event_sends_no_closing_notice_and_does_not_announce_it_later', async () => {
    await withSafetyReviewTransitionGuardDisabled(db, () => setEvent({ status: 'cancelled' }));

    expect(await window_()).toBe(0);
    expect(await window_()).toBe(0);
    expect(await notices('registration_closed')).toEqual([]);
  });

  it('SCRUM177_AC1_reopening_after_a_close_is_a_new_occurrence', async () => {
    await setEvent({ registration_enabled: false });
    await window_('settings_changed');
    await setEvent({ registration_enabled: true });

    expect(await window_('settings_changed')).toBe(2);
    expect(await notices('registration_opened')).toHaveLength(5);
  });
});

describe('announce_registration_window: refusals and rollback', () => {
  it('SCRUM177_AC1_a_rolled_back_operation_leaves_no_notice_and_no_state', async () => {
    await db.exec('savepoint op');
    await window_();
    await db.exec('rollback to savepoint op');

    expect(await notices('registration_opened')).toEqual([]);
    expect(await window_()).toBe(3);
  });

  it('SCRUM177_AC1_refuses_an_unknown_cause_or_event', async () => {
    expect(await refusal('select announce_registration_window($1, $2)', [event, 'opening_time'])).toBe('22023');
    expect(await refusal('select announce_registration_window($1, null)', ['99999999-9999-4999-8999-999999999999'])).toBe('P0002');
  });
});

describe('announce_registration_capacity', () => {
  it('SCRUM177_AC2_reaching_capacity_tells_the_organiser_and_coordinator_once', async () => {
    expect(await capacity('registration')).toBe(2);
    expect(await capacity('registration')).toBe(0);

    expect(await recipients('registration_capacity_reached')).toEqual([['coordinator', COORDINATOR], ['organiser', ORGANISER]]);
    expect((await notices('registration_capacity_reached'))[0].payload).toMatchObject({ capacity: 1, registeredCount: 1 });
  });

  it('SCRUM177_AC2_an_event_with_room_or_no_limit_is_never_full', async () => {
    await setEvent({ registration_capacity: 2 });
    expect(await capacity('registration')).toBe(0);
    await setEvent({ registration_capacity: null });
    expect(await capacity('promotion')).toBe(0);
  });

  it('SCRUM177_AC4_a_withdrawal_that_frees_a_place_tells_staff_with_counts_only', async () => {
    await capacity('registration');
    await enrol(A, 'withdrawn');

    expect(await capacity('withdrawal')).toBe(2);
    const [{ payload }] = await notices('registration_place_released');
    expect(payload).toEqual({
      audience: 'coordinator', eventRequestId: event, eventName: 'Handler event',
      occurrenceKey: payload.occurrenceKey, cause: 'withdrawal', capacity: 1, registeredCount: 0,
    });
    expect(await capacity('withdrawal')).toBe(0);
  });

  it('SCRUM177_AC4_a_place_the_queue_took_straight_away_is_not_reported_free', async () => {
    await capacity('registration');
    await enrol(A, 'withdrawn');
    await enrol(B, 'registered');

    expect(await capacity('withdrawal')).toBe(0);
    expect(await notices('registration_place_released')).toEqual([]);
  });

  it('SCRUM177_AC4_a_withdrawal_from_an_event_that_was_not_full_sends_nothing', async () => {
    await setEvent({ registration_capacity: 3 });
    await capacity('registration');
    await enrol(A, 'withdrawn');

    expect(await capacity('withdrawal')).toBe(0);
  });

  it('SCRUM177_AC2_the_organisers_own_capacity_changes_tell_only_the_coordinator', async () => {
    await setEvent({ registration_capacity: 5 });
    await capacity('registration');
    await setEvent({ registration_capacity: 1 });

    expect(await capacity('settings_changed')).toBe(1);
    expect(await recipients('registration_capacity_reached')).toEqual([['coordinator', COORDINATOR]]);

    await setEvent({ registration_capacity: 5 });
    expect(await capacity('settings_changed')).toBe(0);
    expect(await notices('registration_place_released')).toEqual([]);
  });

  it('SCRUM177_AC2_filling_again_after_a_place_was_freed_is_a_new_occurrence', async () => {
    await capacity('registration');
    await enrol(A, 'withdrawn');
    await capacity('withdrawal');
    await enrol(A, 'registered');

    expect(await capacity('registration')).toBe(2);
    expect(await notices('registration_capacity_reached')).toHaveLength(4);
  });

  it('SCRUM177_AC2_refuses_a_missing_or_unknown_cause', async () => {
    expect(await refusal('select announce_registration_capacity($1, null)', [event])).toBe('22023');
    expect(await refusal('select announce_registration_capacity($1, $2)', [event, 'leave'])).toBe('22023');
  });
});

describe('registration_notification_recipients (the SCRUM-238 interface)', () => {
  const resolve = async (audiences, id = event) => (await db.query(
    'select recipient_id, audience from registration_notification_recipients($1, $2) order by audience',
    [id, audiences],
  )).rows.map((r) => [r.audience, r.recipient_id]);

  it('SCRUM177_AC6_resolves_only_the_named_audiences_of_this_event', async () => {
    expect(await resolve(['waitlisted'])).toEqual([['waitlisted', B]]);
    expect(await resolve(['organiser', 'coordinator', 'waitlisted'])).toEqual([
      ['coordinator', COORDINATOR], ['organiser', ORGANISER], ['waitlisted', B],
    ]);
  });

  it('SCRUM177_AC6_no_queue_and_no_coordinator_resolve_to_nobody_not_to_everyone', async () => {
    // Only an event in the Lead's queue has no coordinator.
    const unassigned = await seedEvent(db, { status: 'submitted', organiser_id: ORGANISER, event_name: 'Unassigned' });

    expect(await resolve(['coordinator', 'waitlisted'], unassigned)).toEqual([]);
  });

  it('SCRUM177_AC6_another_events_queue_is_not_included', async () => {
    const other = await seedEvent(db, { status: 'draft', organiser_id: ORGANISER, event_name: 'Other' });
    await db.query("insert into event_registrations (event_request_id, attendee_id, status) values ($1, $2, 'waitlisted')", [other, C]);

    expect(await resolve(['waitlisted'])).toEqual([['waitlisted', B]]);
  });

  it('SCRUM177_AC6_refuses_an_unknown_or_missing_audience', async () => {
    const sql = 'select * from registration_notification_recipients($1, $2)';
    expect(await refusal(sql, [event, ['attendees']])).toBe('22023');
    expect(await refusal(sql, [event, null])).toBe('22023');
  });
});

describe('migration 040', () => {
  it('SCRUM177_AC1_a_rerun_keeps_what_was_already_announced', async () => {
    await window_();
    await rerunMigrationsFrom(db, '040_registration_notification_handlers.sql');

    expect(await window_()).toBe(0);
  });
});
