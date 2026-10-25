import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getAttendeeEvent, listAttendeeEvents } from '../../src/services/attendeeEventService.js';
import { STATUS } from '../../src/domain/eventRequestStatus.js';
import { BOOKING_STATUS } from '../../src/domain/bookingStatus.js';
import { createAttendeeEventSqlClient } from '../fixtures/attendeeEventSqlClient.js';
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';
import { queriesFor } from './helpers/queries.js';
import { withSafetyReviewTransitionGuardDisabled } from '../fixtures/safetyReviewTestHelpers.js';

const ATTENDEE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORGANISER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const COORDINATOR = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const user = { id: ATTENDEE, role: 'attendee' };
const start = '2030-05-06T09:00:00+08:00';
const end = '2030-05-06T11:00:00+08:00';

// The attendee read path against the final schema.
describe('SCRUM-52 SQL read against the final schema', () => {
  let db;
  let eventId;
  let queries;
  let registrationId;
  const { one } = queriesFor(() => db);

  const client = createAttendeeEventSqlClient({ query: (...args) => db.query(...args) }, {
    onQuery: () => { queries += 1; },
  });
  const read = () => getAttendeeEvent({ user, eventRequestId: eventId, client });
  const book = async (name, status = 'approved') => {
    const venue = await one(`insert into venues (name, location, max_capacity)
      values ($1, $2, 100) returning id`, [name, `${name} location`]);
    // A released booking must record who released it and why.
    const released = status === BOOKING_STATUS.RELEASED;
    return one(`insert into bookings (venue_id, event_request_id, starts_at, ends_at, status,
        released_by, released_at, release_reason)
      values ($1, $2, $3, $4, $5, $6, case when $7 then now() end, $8) returning id`,
    [venue.id, eventId, start, end, status, released ? COORDINATOR : null, released, released ? 'Fixture release' : null]);
  };
  // A registered attendee on an event seeded straight into `status`.
  const registeredEvent = async (overrides = {}) => {
    eventId = await seedEvent(db, {
      status: 'confirmed', organiser_id: ORGANISER, event_name: 'Registered event',
      proposed_start: start, proposed_end: end, reviewing_coordinator_id: COORDINATOR, ...overrides,
    });
    ({ rows: [{ id: registrationId }] } = await db.query(
      'insert into event_registrations (event_request_id, attendee_id) values ($1, $2) returning id', [eventId, ATTENDEE],
    ));
  };

  beforeAll(async () => {
    db = await createSchemaDb();
    await db.query('insert into auth.users (id) values ($1), ($2), ($3), ($4)', [ATTENDEE, ORGANISER, OTHER, COORDINATOR]);
    await db.query("insert into profiles (id, role) values ($1, 'attendee'), ($2, 'event_organiser'), ($3, 'attendee'), ($4, 'event_coordinator')",
      [ATTENDEE, ORGANISER, OTHER, COORDINATOR]);
  });
  afterAll(async () => { if (db) await db.close(); });
  beforeEach(async () => {
    await db.exec('begin');
    queries = 0;
    await registeredEvent();
  });
  // Each fixture is rolled back, including deliberate database failures.
  afterEach(async () => { await db.exec('rollback'); });

  it('SCRUM24_AC4_AC5_AC6_SQL_reads_current_times_and_multiple_confirmed_venues', async () => {
    const a = await book('Hall A');
    const b = await book('Hall B');
    const result = await read();
    expect(result).toMatchObject({ eventRequestId: eventId, registrationId, state: 'confirmed' });
    expect(new Date(result.startsAt).toISOString()).toBe('2030-05-06T01:00:00.000Z');
    expect(new Date(result.endsAt).toISOString()).toBe('2030-05-06T03:00:00.000Z');
    expect(result.venues).toHaveLength(2);
    expect(result.venues).toEqual(expect.arrayContaining([
      { bookingId: a.id, name: 'Hall A', location: 'Hall A location', underReview: false },
      { bookingId: b.id, name: 'Hall B', location: 'Hall B location', underReview: false },
    ]));
    expect(queries).toBe(1);
  });

  it.each(Object.values(STATUS).filter(status => status !== STATUS.CONFIRMED))(
    'SCRUM24_AC2_AC3_SQL_non_confirmed_event_has_no_arrangements_%s', async status => {
      await registeredEvent({ status });
      await book('Private hall');
      expect(await read()).toEqual({ eventRequestId: eventId, registrationId, state: 'unavailable', eventName: 'Registered event' });
      expect(queries).toBe(1);
    },
  );

  it('SCRUM24_AC6_SQL_holds_and_every_unconfirmed_booking_are_excluded', async () => {
    for (const status of Object.values(BOOKING_STATUS)
      .filter(status => ![BOOKING_STATUS.APPROVED, BOOKING_STATUS.FLAGGED_FOR_REVIEW].includes(status))) {
      await book(status, status);
    }
    const heldVenue = await one(`insert into venues (name, location, max_capacity)
      values ('Held only', 'Private', 100) returning id`);
    await db.query(`insert into venue_holds (event_request_id, venue_id, placed_by, expires_at)
      values ($1, $2, $3, now() + interval '1 day')`, [eventId, heldVenue.id, ORGANISER]);
    expect((await read()).venues).toEqual([]);
  });

  it('SCRUM24_AC6_SQL_a_flagged_booking_on_a_confirmed_event_is_listed_as_under_review', async () => {
    const approved = await book('Hall A');
    const flagged = await book('Hall B', BOOKING_STATUS.FLAGGED_FOR_REVIEW);
    const result = await read();
    expect(result.eventName).toBe('Registered event');
    expect(result.venues).toEqual(expect.arrayContaining([
      { bookingId: approved.id, name: 'Hall A', location: 'Hall A location', underReview: false },
      { bookingId: flagged.id, name: 'Hall B', location: 'Hall B location', underReview: true },
    ]));
    expect(result.venues).toHaveLength(2);
  });

  it('SCRUM24_AC1_SQL_closed_disabled_full_and_past_events_remain_readable', async () => {
    // A confirmed event's dates are locked, so the past event is seeded past.
    await registeredEvent({ proposed_start: '2000-02-01', proposed_end: '2000-02-02' });
    await book('Hall');
    await db.query(`update event_requests set registration_enabled = false,
      registration_opens_at = '2000-01-01', registration_closes_at = '2000-01-02',
      registration_capacity = 1 where id = $1`, [eventId]);
    const result = await read();
    expect(result.state).toBe('confirmed');
    expect(result.venues).toHaveLength(1);
    expect(new Date(result.startsAt).getUTCFullYear()).toBe(2000);
  });

  it('SCRUM24_AC7_SQL_change_hides_old_arrangements_and_reconfirmation_reads_latest', async () => {
    const old = await book('Old hall');
    expect((await read()).venues[0].bookingId).toBe(old.id);
    await db.query("update event_requests set status = 'approved' where id = $1", [eventId]);
    expect(await read()).toEqual({ eventRequestId: eventId, registrationId, state: 'unavailable', eventName: 'Registered event' });
    await db.query("update bookings set status = 'cancelled' where id = $1", [old.id]);
    const latest = await book('Latest hall');
    await db.query(`update event_requests set proposed_start = $1, proposed_end = $2
      where id = $3`, ['2031-05-06T09:00:00+08:00', '2031-05-06T11:00:00+08:00', eventId]);
    // Reconfirming takes the safety review workflow, which this read test skips.
    await withSafetyReviewTransitionGuardDisabled(db, () => db.query(
      "update event_requests set status = 'confirmed' where id = $1", [eventId]));
    const result = await read();
    expect(result.venues).toEqual([{ bookingId: latest.id, name: 'Latest hall', location: 'Latest hall location', underReview: false }]);
    expect(new Date(result.startsAt).getUTCFullYear()).toBe(2031);
  });

  it.each(['withdrawn', 'cancelled', 'waitlisted'])(
    'SCRUM24_AC1_SQL_inactive_registration_never_grants_access_%s', async status => {
      await db.query('update event_registrations set status = $1 where event_request_id = $2', [status, eventId]);
      await expect(read()).rejects.toMatchObject({ status: 404, message: 'Event information not found' });
    },
  );

  it('SCRUM24_AC1_SQL_unknown_and_other_attendees_event_have_identical_refusals', async () => {
    await db.query('update event_registrations set attendee_id = $1 where event_request_id = $2', [OTHER, eventId]);
    await expect(read()).rejects.toMatchObject({ status: 404, message: 'Event information not found' });
    eventId = randomUUID();
    await expect(read()).rejects.toMatchObject({ status: 404, message: 'Event information not found' });
  });

  it('SCRUM24_AC8_SQL_response_never_exposes_planning_or_staffing', async () => {
    await db.query("update event_requests set description = 'private planning', purpose = 'private' where id = $1", [eventId]);
    await book('Hall');
    const result = await read();
    expect(Object.keys(result).sort()).toEqual(['endsAt', 'eventName', 'eventRequestId', 'registrationId', 'startsAt', 'state', 'venues']);
    expect(Object.keys(result.venues[0]).sort()).toEqual(['bookingId', 'location', 'name', 'underReview']);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('SCRUM24_AC1_SQL_registered_entry_points_survive_registration_closure_and_unconfirmed_state', async () => {
    await db.query(`update event_requests set status = 'approved', registration_enabled = false,
      registration_capacity = 1, registration_opens_at = '2000-01-01', registration_closes_at = '2000-01-02'
      where id = $1`, [eventId]);
    await db.query("update event_requests set description = 'PRIVATE_PLANNING' where id = $1", [eventId]);
    expect(await listAttendeeEvents({ user, client })).toEqual([{ eventRequestId: eventId, eventName: 'Registered event' }]);
    expect(queries).toBe(1);
    await db.query("update event_registrations set status = 'withdrawn' where event_request_id = $1", [eventId]);
    expect(await listAttendeeEvents({ user, client })).toEqual([]);
  });

  it('SCRUM24_AC1_SQL_missing_schema_fails_without_returning_event_data', async () => {
    await db.exec('alter table bookings rename column status to unavailable_status');
    await expect(read()).rejects.toMatchObject({ status: 503 });
  });
});
