// SCRUM-434 AC5 / SCRUM-439: what an attendee is shown of an event they are registered for, against the
// real schema. Every private column of the event holds canary text, and none of it may reach the
// attendee, in any status. The SCRUM-24 tests pin the query; these pin the answer.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAttendeeEvent, listAttendeeEvents } from '../../src/services/attendeeEventService.js';
import { STATUS } from '../../src/domain/eventRequestStatus.js';
import { createAttendeeEventSqlClient } from '../fixtures/attendeeEventSqlClient.js';
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';

const ATTENDEE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORGANISER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COORDINATOR = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const user = { id: ATTENDEE, role: 'attendee' };
const start = '2030-05-06T09:00:00+08:00';
const end = '2030-05-06T11:00:00+08:00';

// Text in every column an attendee has no business seeing.
const CANARY = {
  purpose: 'CANARY-PURPOSE-internal-reason',
  venue_requirements: 'CANARY-VENUE-REQUIREMENTS',
  accessibility_requirements: 'CANARY-ACCESSIBILITY-REQUIREMENTS',
  equipment_requirements: 'CANARY-EQUIPMENT-REQUIREMENTS',
  description: 'CANARY-DESCRIPTION-written-for-staff',
};
const ORGANISER_NAME = 'CANARY-Organiser-Name';
const COORDINATOR_NAME = 'CANARY-Coordinator-Name';
const NOTE = 'CANARY-DECISION-NOTE';

describe('SCRUM-434 AC5 / SCRUM-439: the attendee answer carries attendee-facing fields only', () => {
  let db;
  let eventId;
  const client = createAttendeeEventSqlClient({ query: (...args) => db.query(...args) });
  const read = () => getAttendeeEvent({ user, eventRequestId: eventId, client });

  const registeredEvent = async (overrides = {}) => {
    eventId = await seedEvent(db, {
      status: 'confirmed', organiser_id: ORGANISER, event_name: 'Canary event', reviewing_coordinator_id: COORDINATOR,
      proposed_start: start, proposed_end: end, decision_note: NOTE, ...CANARY, ...overrides,
    });
    await db.query('insert into event_registrations (event_request_id, attendee_id) values ($1, $2)', [eventId, ATTENDEE]);
  };
  const book = async (name, status = 'approved') => {
    const venue = (await db.query('insert into venues (name, location, max_capacity) values ($1, $2, 100) returning id',
      [name, `${name} location`])).rows[0];
    await db.query('insert into bookings (venue_id, event_request_id, starts_at, ends_at, status) values ($1, $2, $3, $4, $5)',
      [venue.id, eventId, start, end, status]);
  };
  // Not one canary string, nor the people behind the event, appears anywhere in the answer.
  const expectNoPrivateData = (answer) => {
    const text = JSON.stringify(answer);
    for (const value of [...Object.values(CANARY), ORGANISER_NAME, COORDINATOR_NAME, NOTE, ORGANISER, COORDINATOR]) {
      expect(text).not.toContain(value);
    }
  };

  beforeAll(async () => {
    db = await createSchemaDb();
    await db.query('insert into auth.users (id) values ($1), ($2), ($3)', [ATTENDEE, ORGANISER, COORDINATOR]);
    await db.query("insert into profiles (id, role, full_name) values ($1, 'attendee', 'An Attendee'), ($2, 'event_organiser', $4), ($3, 'event_coordinator', $5)",
      [ATTENDEE, ORGANISER, COORDINATOR, ORGANISER_NAME, COORDINATOR_NAME]);
  });
  afterAll(async () => { if (db) await db.close(); });
  beforeEach(async () => { await db.exec('begin'); });
  afterEach(async () => { await db.exec('rollback'); });

  it('SCRUM434_AC5_a_confirmed_event_has_exactly_the_attendee_facing_keys', async () => {
    await registeredEvent();
    await book('Hall A');

    const result = await read();

    expect(Object.keys(result).sort()).toEqual(['endsAt', 'eventName', 'eventRequestId', 'registrationId', 'startsAt', 'state', 'venues']);
    expect(Object.keys(result.venues[0]).sort()).toEqual(['bookingId', 'location', 'name', 'underReview']);
    expectNoPrivateData(result);
  });

  it('SCRUM434_AC5_a_confirmed_event_with_no_booking_still_has_no_private_data', async () => {
    await registeredEvent();

    const result = await read();

    expect(result.venues).toEqual([]);
    expectNoPrivateData(result);
  });

  it('SCRUM434_AC5_a_flagged_booking_shows_only_that_it_is_under_review', async () => {
    await registeredEvent();
    await book('Hall B', 'flagged_for_review');

    const result = await read();

    expect(result.venues).toHaveLength(1);
    expect(result.venues[0].underReview).toBe(true);
    expect(Object.keys(result.venues[0]).sort()).toEqual(['bookingId', 'location', 'name', 'underReview']);
    expectNoPrivateData(result);
  });

  it.each(Object.values(STATUS).filter((status) => ![STATUS.CONFIRMED, STATUS.CANCELLED].includes(status)))(
    'SCRUM434_AC5_an_event_that_is_%s_shows_the_name_and_nothing_else',
    async (status) => {
      await registeredEvent({ status });
      await book('Private hall');

      const result = await read();

      expect(Object.keys(result).sort()).toEqual(['eventName', 'eventRequestId', 'registrationId', 'state']);
      expectNoPrivateData(result);
    },
  );

  it('SCRUM434_AC5_a_cancelled_event_shows_the_name_and_the_coordinators_message_only', async () => {
    await registeredEvent({
      status: 'cancelled', cancellation_reason: 'CANARY-INTERNAL-REASON', cancellation_initiator: 'organiser_request',
      cancelled_by: COORDINATOR, cancelled_at: '2030-01-01T00:00:00Z', attendee_message: 'We are sorry.',
    });
    await book('Private hall');

    const result = await read();

    expect(Object.keys(result).sort()).toEqual(['eventName', 'eventRequestId', 'message', 'registrationId', 'state']);
    expect(result.message).toBe('We are sorry.');
    expect(JSON.stringify(result)).not.toContain('CANARY-INTERNAL-REASON');
    expectNoPrivateData(result);
  });

  it('SCRUM434_AC5_the_registered_events_list_has_only_the_id_and_the_name', async () => {
    await registeredEvent();

    const list = await listAttendeeEvents({ user, client });

    expect(list).toEqual([{ eventRequestId: eventId, eventName: 'Canary event' }]);
    expectNoPrivateData(list);
  });

  it('SCRUM434_AC5_reading_the_event_changes_nothing', async () => {
    await registeredEvent();
    await book('Hall A');
    const snapshot = async () => ({
      events: (await db.query('select * from event_requests order by id')).rows,
      registrations: (await db.query('select * from event_registrations order by id')).rows,
      bookings: (await db.query('select * from bookings order by id')).rows,
    });
    const before = await snapshot();

    await read();
    await listAttendeeEvents({ user, client });

    expect(await snapshot()).toEqual(before);
  });
});
