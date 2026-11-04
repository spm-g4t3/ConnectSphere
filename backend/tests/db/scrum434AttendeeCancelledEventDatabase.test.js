// SCRUM-434 AC5 (database): a cancelled event, read as a registered attendee, against the real schema.
// The attendee gets the coordinator's optional message and never the internal reason.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAttendeeEvent } from '../../src/services/attendeeEventService.js';
import { createAttendeeEventSqlClient } from '../fixtures/attendeeEventSqlClient.js';
import { createSchemaDb, seedEvent } from './helpers/schemaDb.js';

const ATTENDEE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ATTENDEE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORGANISER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COORDINATOR = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const REASON = 'INTERNAL_REASON_SENTINEL: venue double booked';
const user = { id: ATTENDEE, role: 'attendee' };

describe('SCRUM-434 AC5: the attendee read of a cancelled event, against the final schema', () => {
  let db;
  let eventId;
  let registrationId;
  let queries;
  const client = createAttendeeEventSqlClient({ query: (...args) => db.query(...args) }, { onQuery: () => { queries += 1; } });
  const read = (asUser = user, id = eventId) => getAttendeeEvent({ user: asUser, eventRequestId: id, client });

  // A cancelled event with a registered attendee. The reason is required by the schema; the message is optional.
  const cancelledEvent = async ({ message = null } = {}) => {
    eventId = await seedEvent(db, {
      status: 'cancelled', organiser_id: ORGANISER, event_name: 'Cancelled event', reviewing_coordinator_id: COORDINATOR,
      cancellation_reason: REASON, cancellation_initiator: 'organiser_request', cancelled_by: COORDINATOR,
      cancelled_at: '2030-01-01T00:00:00Z', attendee_message: message,
    });
    ({ rows: [{ id: registrationId }] } = await db.query(
      'insert into event_registrations (event_request_id, attendee_id) values ($1, $2) returning id', [eventId, ATTENDEE]));
  };

  beforeAll(async () => {
    db = await createSchemaDb();
    await db.query('insert into auth.users (id) values ($1), ($2), ($3), ($4)', [ATTENDEE, OTHER_ATTENDEE, ORGANISER, COORDINATOR]);
    await db.query("insert into profiles (id, role) values ($1, 'attendee'), ($2, 'attendee'), ($3, 'event_organiser'), ($4, 'event_coordinator')",
      [ATTENDEE, OTHER_ATTENDEE, ORGANISER, COORDINATOR]);
  });
  afterAll(async () => { if (db) await db.close(); });
  beforeEach(async () => { await db.exec('begin'); queries = 0; });
  afterEach(async () => { await db.exec('rollback'); });

  it('SCRUM434_AC5_SQL_a_cancelled_event_returns_the_coordinators_message', async () => {
    await cancelledEvent({ message: 'We are sorry. A refund is on its way.' });

    expect(await read()).toEqual({
      eventRequestId: eventId, registrationId, state: 'cancelled', eventName: 'Cancelled event',
      message: 'We are sorry. A refund is on its way.',
    });
    expect(queries).toBe(2);
  });

  it('SCRUM434_AC5_SQL_a_cancelled_event_with_no_message_returns_null_and_still_hides_the_reason', async () => {
    await cancelledEvent();

    const result = await read();

    expect(result.message).toBeNull();
    expect(JSON.stringify(result)).not.toContain('INTERNAL_REASON_SENTINEL');
  });

  it('SCRUM434_AC5_SQL_the_internal_reason_is_stored_but_never_returned', async () => {
    await cancelledEvent({ message: 'Sorry.' });
    const stored = await db.query('select cancellation_reason from event_requests where id = $1', [eventId]);
    expect(stored.rows[0].cancellation_reason).toBe(REASON);

    expect(JSON.stringify(await read())).not.toContain('INTERNAL_REASON_SENTINEL');
  });

  it('SCRUM434_AC5_SQL_a_message_that_looks_like_the_reason_is_still_just_the_message', async () => {
    // The two columns are independent: whatever the coordinator wrote as the message is what is shown.
    await cancelledEvent({ message: 'Venue unavailable.' });

    expect((await read()).message).toBe('Venue unavailable.');
  });

  it('SCRUM434_AC5_SQL_an_attendee_who_is_not_registered_gets_a_404_and_no_message', async () => {
    await cancelledEvent({ message: 'Sorry.' });

    await expect(read({ id: OTHER_ATTENDEE, role: 'attendee' })).rejects.toMatchObject({ name: 'NotFoundError', status: 404 });
    expect(queries).toBe(1);
  });

  it('SCRUM434_AC5_SQL_a_withdrawn_attendee_gets_a_404_for_the_cancelled_event', async () => {
    await cancelledEvent({ message: 'Sorry.' });
    await db.query("update event_registrations set status = 'withdrawn' where id = $1", [registrationId]);

    await expect(read()).rejects.toMatchObject({ name: 'NotFoundError', status: 404 });
  });

  it('SCRUM434_AC5_SQL_reading_a_cancelled_event_changes_nothing', async () => {
    await cancelledEvent({ message: 'Sorry.' });
    const before = await db.query('select * from event_requests where id = $1', [eventId]);

    await read();
    await read();

    expect((await db.query('select * from event_requests where id = $1', [eventId])).rows).toEqual(before.rows);
  });
});
