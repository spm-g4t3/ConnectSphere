import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';
import { withSafetyReviewTransitionGuardDisabled } from '../fixtures/safetyReviewTestHelpers.js';

const START = '2030-01-01T12:00:00Z';

// Registration settings and register_for_event against the final schema.
describe('SCRUM-363: event registration in Postgres', () => {
  let db;
  let organiser;
  let attendee;
  let secondAttendee;
  let coordinator;
  let eventId;

  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];

  const event = (name, status = 'confirmed', overrides = {}) => seedEvent(db, {
    status,
    organiser_id: organiser,
    reviewing_coordinator_id: coordinator,
    event_name: name,
    // What a significant change checks a real event has.
    purpose: 'Registration test',
    expected_attendance: 50,
    proposed_start: START,
    proposed_end: '2030-01-01T14:00:00Z',
    ...overrides,
  });
  // Confirming takes the safety review workflow, which these tests skip.
  const confirm = (id) => withSafetyReviewTransitionGuardDisabled(db, () => db.query(
    "update event_requests set status = 'confirmed' where id = $1", [id],
  ));
  // A confirmed event's start is locked: it moves through a significant change,
  // which returns the event to Approved for a fresh safety review.
  const moveStart = (id, start) => db.query(
    "select apply_significant_event_change($1, jsonb_build_object('proposedStart', $2::text), 'Start moved.', $3)",
    [id, start, coordinator],
  );

  beforeAll(async () => {
    db = await createSchemaDb();

    organiser = (await one("insert into auth.users (email) values ('organiser@test') returning id")).id;
    attendee = (await one("insert into auth.users (email) values ('attendee@test') returning id")).id;
    secondAttendee = (await one("insert into auth.users (email) values ('second-attendee@test') returning id")).id;
    coordinator = (await one("insert into auth.users (email) values ('coordinator@test') returning id")).id;
    await db.query(
      `insert into profiles (id, role) values
         ($1, 'event_organiser'), ($2, 'attendee'), ($3, 'attendee'), ($4, 'event_coordinator')`,
      [organiser, attendee, secondAttendee, coordinator],
    );
    eventId = await event('Registration test', 'approved');
  });

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM494_AC1_collects_all_related_date_and_capacity_faults', async () => {
    await db.query("update event_requests set status = 'approved' where id = $1", [eventId]);
    const result = await one(
      `select setup_event_registration($1, $2, true, $3, $4, 0, $5) as result`,
      [
        eventId,
        organiser,
        '2030-01-01T13:00:00Z',
        '2030-01-01T13:00:00Z',
        '2030-01-01T13:00:00Z',
      ],
    );
    expect(result.result.outcome).toBe('invalid');
    expect(result.result.details.map((item) => item.field)).toEqual([
      'registrationOpensAt',
      'registrationClosesAt',
      'registrationWithdrawalDeadline',
      'registrationCapacity',
    ]);
    const unchanged = await one('select registration_enabled from event_requests where id = $1', [eventId]);
    expect(unchanged.registration_enabled).toBe(false);
  });

  it('SCRUM494_AC2_persists_settings_and_allows_only_confirmed_active_registrations', async () => {
    const saved = await one(
      `select setup_event_registration($1, $2, true, $3, $4, 2, $5) as result`,
      [
        eventId,
        organiser,
        new Date(Date.now() - 60_000).toISOString(),
        '2030-01-01T12:00:00Z',
        '2030-01-01T11:00:00Z',
      ],
    );
    expect(saved.result.outcome).toBe('saved');
    expect(saved.result.registeredCount).toBe(0);

    const history = await one(
      'select changed_by, old_values, new_values from event_registration_settings_history where event_request_id = $1',
      [eventId],
    );
    expect(history.changed_by).toBe(organiser);
    expect(history.old_values.enabled).toBe(false);
    expect(history.new_values.enabled).toBe(true);

    const notConfirmed = await one(
      'select register_for_event($1, $2) as result',
      [eventId, attendee],
    );
    expect(notConfirmed.result.outcome).toBe('not_found');

    await confirm(eventId);
    const registered = await one(
      'select register_for_event($1, $2) as result',
      [eventId, attendee],
    );
    expect(registered.result.outcome).toBe('registered');
    expect(registered.result.registeredCount).toBe(1);

    await db.query("update event_requests set status = 'approved' where id = $1", [eventId]);
    const blockedDuringReview = await one(
      'select register_for_event($1, $2) as result',
      [eventId, secondAttendee],
    );
    expect(blockedDuringReview.result.outcome).toBe('not_found');
    const retained = await one(
      `select registration_enabled, registration_capacity,
              (select count(*) from event_registrations where event_request_id = $1) as registered_count
         from event_requests where id = $1`,
      [eventId],
    );
    expect(retained.registration_enabled).toBe(true);
    expect(retained.registration_capacity).toBe(2);
    expect(Number(retained.registered_count)).toBe(1);

    await confirm(eventId);
    const secondRegistration = await one(
      'select register_for_event($1, $2) as result',
      [eventId, secondAttendee],
    );
    expect(secondRegistration.result.outcome).toBe('registered');
    expect(secondRegistration.result.registeredCount).toBe(2);

    const belowCurrentCount = await one(
      `select setup_event_registration($1, $2, true, $3, $4, 1, $5) as result`,
      [
        eventId,
        organiser,
        new Date(Date.now() - 60_000).toISOString(),
        '2030-01-01T12:00:00Z',
        '2030-01-01T11:00:00Z',
      ],
    );
    expect(belowCurrentCount.result.outcome).toBe('invalid');
    expect(belowCurrentCount.result.details).toContainEqual(expect.objectContaining({
      field: 'registrationCapacity',
    }));

    const duplicate = await one(
      'select register_for_event($1, $2) as result',
      [eventId, attendee],
    );
    expect(duplicate.result.outcome).toBe('already_registered');

  });

  it('SCRUM494_AC3_requires_the_organiser_role_and_preserves_capacity_locks', async () => {
    const refused = await one(
      `select setup_event_registration($1, $2, false, $3, $4, 1, null) as result`,
      [
        eventId,
        attendee,
        '2029-12-01T00:00:00Z',
        '2030-01-01T12:00:00Z',
      ],
    );
    expect(refused.result.outcome).toBe('forbidden');

    const wrongRole = await one(
      'select setup_event_registration($1, $2, false, $3, $4, 1, null) as result',
      [
        eventId,
        secondAttendee,
        '2029-12-01T00:00:00Z',
        '2030-01-01T12:00:00Z',
      ],
    );
    expect(wrongRole.result.outcome).toBe('forbidden');

    const nullCaller = await one(
      'select setup_event_registration($1, null, false, $2, $3, 1, null) as result',
      [eventId, '2029-12-01T00:00:00Z', '2030-01-01T12:00:00Z'],
    );
    expect(nullCaller.result.outcome).toBe('forbidden');

    await expect(db.query('select register_for_event($1, null) as result', [eventId]))
      .rejects.toMatchObject({ code: '22023' });

    const wrongRoleRegistration = await one(
      'select register_for_event($1, $2) as result',
      [eventId, organiser],
    );
    expect(wrongRoleRegistration.result.outcome).toBe('forbidden');

    for (const functionName of ['setup_event_registration', 'register_for_event']) {
      const { prosrc } = await one('select prosrc from pg_proc where proname = $1', [functionName]);
      expect(prosrc.toLowerCase()).toMatch(/for update/);
    }
  });

  it('SCRUM494_AC4_refuses_registration_when_disabled_or_not_yet_open', async () => {
    const disabledEvent = await event('Disabled registration');
    const disabledResult = await one(
      'select register_for_event($1, $2) as result',
      [disabledEvent, secondAttendee],
    );
    expect(disabledResult.result.outcome).toBe('not_found');

    const futureEvent = await event('Future registration window');
    const futureSettings = await one(
      `select setup_event_registration($1, $2, true, $3, $4, null, null) as result`,
      [
        futureEvent,
        organiser,
        '2029-12-01T00:00:00Z',
        '2030-01-01T12:00:00Z',
      ],
    );
    expect(futureSettings.result.outcome).toBe('saved');

    const beforeOpening = await one(
      'select register_for_event($1, $2) as result',
      [futureEvent, secondAttendee],
    );
    expect(beforeOpening.result.outcome).toBe('not_found');
  });

  it('SCRUM494_AC5_does_not_count_withdrawn_registrations_toward_capacity', async () => {
    await db.query(
      `update event_registrations set status = 'withdrawn'
        where event_request_id = $1 and attendee_id = $2`,
      [eventId, attendee],
    );
    const settings = await one(
      `select setup_event_registration($1, $2, true, $3, $4, 1, $5) as result`,
      [
        eventId,
        organiser,
        new Date(Date.now() - 60_000).toISOString(),
        '2030-01-01T12:00:00Z',
        '2030-01-01T11:00:00Z',
      ],
    );
    expect(settings.result.outcome).toBe('saved');
    expect(settings.result.registeredCount).toBe(1);
  });

  const scheduleConflictNotes = async (event) => (await db.query(
    `select recipient_id, payload from notifications
      where event_request_id = $1 and type = 'registration_schedule_conflict'
      order by recipient_id`,
    [event],
  )).rows;

  it('SCRUM494_AC7_lets_an_earlier_start_through_and_tells_the_organiser_and_coordinator_which_dates_clash', async () => {
    const scheduleEvent = await event('Schedule conflict');
    const saved = await one(
      'select setup_event_registration($1, $2, true, $3, $4, null, $5) as result',
      [scheduleEvent, organiser, '2030-01-01T09:00:00Z', START, '2030-01-01T11:00:00Z'],
    );
    expect(saved.result.outcome).toBe('saved');

    await moveStart(scheduleEvent, '2030-01-01T09:00:00Z');

    const moved = await one('select proposed_start, registration_closes_at from event_requests where id = $1', [scheduleEvent]);
    expect(moved.proposed_start.toISOString()).toBe('2030-01-01T09:00:00.000Z');
    expect(moved.registration_closes_at.toISOString()).toBe('2030-01-01T12:00:00.000Z');

    const notes = await scheduleConflictNotes(scheduleEvent);
    expect(notes.map((note) => note.recipient_id).sort()).toEqual([organiser, coordinator].sort());
    for (const note of notes) {
      expect(note.payload).toMatchObject({
        eventName: 'Schedule conflict',
        fields: ['registrationOpensAt', 'registrationClosesAt', 'registrationWithdrawalDeadline'],
      });
      expect(new Date(note.payload.newStart).toISOString()).toBe('2030-01-01T09:00:00.000Z');
    }
  });

  it('SCRUM494_AC7_names_only_the_dates_the_new_start_clashes_with', async () => {
    const scheduleEvent = await event('Withdrawal clash');
    await one(
      'select setup_event_registration($1, $2, true, $3, $4, null, $5) as result',
      [scheduleEvent, organiser, '2029-12-01T00:00:00Z', '2030-01-01T10:00:00Z', '2030-01-01T11:30:00Z'],
    );

    await moveStart(scheduleEvent, '2030-01-01T11:00:00Z');

    const notes = await scheduleConflictNotes(scheduleEvent);
    // An event with registration settings is past review, so it always has a coordinator.
    expect(notes.map((note) => note.recipient_id).sort()).toEqual([organiser, coordinator].sort());
    for (const note of notes) expect(note.payload.fields).toEqual(['registrationWithdrawalDeadline']);
  });

  it('SCRUM494_AC7_writes_no_notification_when_the_new_start_leaves_the_dates_valid', async () => {
    const scheduleEvent = await event('No clash');
    await one(
      'select setup_event_registration($1, $2, true, $3, $4, null, $5) as result',
      [scheduleEvent, organiser, '2029-12-01T00:00:00Z', '2030-01-01T10:00:00Z', '2030-01-01T10:00:00Z'],
    );

    await moveStart(scheduleEvent, '2030-01-01T11:00:00Z');

    expect(await scheduleConflictNotes(scheduleEvent)).toEqual([]);
  });

  it('SCRUM494_AC8_refuses_an_opening_time_at_or_after_the_event_start_when_no_closing_time_is_set', async () => {
    const openEnded = await event('Opens too late');
    for (const opensAt of [START, '2030-01-01T13:00:00Z']) {
      const refused = await one(
        'select setup_event_registration($1, $2, true, $3, null, null, null) as result',
        [openEnded, organiser, opensAt],
      );
      expect(refused.result).toEqual({
        outcome: 'invalid',
        details: [{ field: 'registrationOpensAt', message: 'Must be before the event start.' }],
      });
    }

    const noStartEvent = await event('No start yet', 'approved', { proposed_start: null, proposed_end: null });
    const noStart = await one(
      'select setup_event_registration($1, $2, true, $3, null, null, null) as result',
      [noStartEvent, organiser, '2029-12-01T00:00:00Z'],
    );
    expect(noStart.result.details).toEqual([
      { field: 'proposedStart', message: 'Set the event start before setting the registration opening time.' },
    ]);
  });

  it('SCRUM494_AC8_allows_registration_with_no_closing_time_until_the_organiser_closes_it', async () => {
    const openEnded = await event('Open ended');
    const opened = new Date(Date.now() - 3_600_000).toISOString();
    const saved = await one(
      'select setup_event_registration($1, $2, true, $3, null, null, null) as result',
      [openEnded, organiser, opened],
    );
    expect(saved.result.outcome).toBe('saved');
    const registered = await one('select register_for_event($1, $2) as result', [openEnded, attendee]);
    expect(registered.result.outcome).toBe('registered');
    const closed = await one(
      'select setup_event_registration($1, $2, false, $3, null, null, null) as result',
      [openEnded, organiser, opened],
    );
    expect(closed.result.outcome).toBe('saved');
    const refused = await one('select register_for_event($1, $2) as result', [openEnded, secondAttendee]);
    expect(refused.result.outcome).toBe('not_found');
  });

  it('SCRUM494_AC9_allows_switching_registration_off_with_the_window_cleared', async () => {
    const offEvent = await event('Switch off', 'approved');
    const on = await one(
      `select setup_event_registration($1, $2, true, $3, $4, null, null) as result`,
      [offEvent, organiser, '2029-12-01T00:00:00Z', '2030-01-01T10:00:00Z'],
    );
    expect(on.result.outcome).toBe('saved');

    const off = await one(
      'select setup_event_registration($1, $2, false, null, null, null, null) as result',
      [offEvent, organiser],
    );
    expect(off.result.outcome).toBe('saved');

    const enabledWithoutDates = await one(
      'select setup_event_registration($1, $2, true, null, null, null, null) as result',
      [offEvent, organiser],
    );
    expect(enabledWithoutDates.result.outcome).toBe('invalid');

    const closingWithoutOpening = await one(
      'select setup_event_registration($1, $2, false, null, $3, null, null) as result',
      [offEvent, organiser, '2030-01-01T10:00:00Z'],
    );
    expect(closingWithoutOpening.result.outcome).toBe('invalid');
  });

  const CLASHING_DATES = ['2029-12-01T00:00:00Z', START, '2030-01-01T11:00:00Z'];

  // Registration saved against the original start, then the start moved earlier
  // than the closing time and withdrawal deadline.
  const eventWithClashingDates = async (name) => {
    const clashing = await event(name);
    const saved = await one(
      'select setup_event_registration($1, $2, true, $3, $4, null, $5) as result',
      [clashing, organiser, ...CLASHING_DATES],
    );
    expect(saved.result.outcome).toBe('saved');
    await moveStart(clashing, '2030-01-01T09:00:00Z');
    return clashing;
  };

  it('SCRUM494_AC9_switches_registration_off_after_a_start_change_left_the_dates_clashing', async () => {
    const clashing = await eventWithClashingDates('Off after clash');

    const off = await one(
      'select setup_event_registration($1, $2, false, $3, $4, null, $5) as result',
      [clashing, organiser, ...CLASHING_DATES],
    );
    expect(off.result.outcome).toBe('saved');
    const row = await one('select registration_enabled from event_requests where id = $1', [clashing]);
    expect(row.registration_enabled).toBe(false);
  });

  it('SCRUM494_AC7_refuses_switching_back_on_while_the_dates_still_clash', async () => {
    const clashing = await eventWithClashingDates('On after clash');

    const on = await one(
      'select setup_event_registration($1, $2, true, $3, $4, null, $5) as result',
      [clashing, organiser, ...CLASHING_DATES],
    );
    expect(on.result.outcome).toBe('invalid');
    expect(on.result.details).toContainEqual({
      field: 'registrationClosesAt', message: 'Must be no later than the event start.',
    });
  });
});
