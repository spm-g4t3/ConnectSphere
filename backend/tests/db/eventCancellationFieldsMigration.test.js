import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedEvent, seedUser } from './helpers/schemaDb.js';
import { queriesFor } from './helpers/queries.js';

// SCRUM-371's cancellation fields, against the final schema.
describe('SCRUM-371: cancellation fields', () => {
  let db;
  let organiser;
  let coordinator;

  const { one } = queriesFor(() => db);

  beforeAll(async () => {
    db = await createSchemaDb();
    // Roles as they act: 050 checks the decider's role inside process_change_request's gate.
    organiser = await seedUser(db, { email: 'organiser@test', role: 'event_organiser' });
    coordinator = await seedUser(db, { email: 'coordinator@test', role: 'event_coordinator' });
  });

  afterAll(async () => {
    await db?.close();
  });

  async function makeEvent() {
    return (
      await one(
        `insert into event_requests (organiser_id, event_name, status)
         values ($1, 'Test event', 'submitted')
         returning id`,
        [organiser],
      )
    ).id;
  }

  it('adds cancellation fields without changing event status', async () => {
    const eventId = await makeEvent();
    const cancelledAt = '2026-10-10T07:00:00Z';
    const result = await one(
      `update event_requests
       set cancellation_reason = 'Venue unavailable',
           cancellation_initiator = 'organiser_request',
           cancelled_by = $2,
           cancelled_at = $3,
           attendee_message = 'The event will not go ahead.'
       where id = $1
       returning status, cancellation_reason, cancellation_initiator,
                 cancelled_by, cancelled_at, attendee_message`,
      [eventId, coordinator, cancelledAt],
    );

    expect(result).toMatchObject({
      status: 'submitted',
      cancellation_reason: 'Venue unavailable',
      cancellation_initiator: 'organiser_request',
      cancelled_by: coordinator,
      attendee_message: 'The event will not go ahead.',
    });
    expect(new Date(result.cancelled_at).toISOString()).toBe(new Date(cancelledAt).toISOString());
  });

  it('rejects a blank cancellation reason', async () => {
    const eventId = await makeEvent();

    await expect(
      db.query(
        `update event_requests
         set cancellation_reason = '   '
         where id = $1`,
        [eventId],
      ),
    ).rejects.toThrow(/event_requests_cancellation_reason_nonblank/);
  });

  it('allows change requests to be closed with the event-cancelled outcome', async () => {
    // Only the assigned coordinator may decide a confirmed event's change requests.
    const eventId = await seedEvent(db, {
      status: 'confirmed', organiser_id: organiser, assigned_coordinator_id: coordinator,
    });
    const requestId = (
      await one(
        `insert into event_change_requests
           (event_request_id, requested_by, change_field, requested_change)
         values ($1, $2, 'other', 'Change the event format')
         returning id`,
        [eventId, organiser],
      )
    ).id;

    const { result: processed } = await one(
      `select to_jsonb(process_change_request($1, 'event_cancelled', null, $2)) as result`,
      [requestId, coordinator],
    );

    expect(processed.status).toBe('processed');
    expect(processed.decision).toBe('event_cancelled');
    expect(processed.processed_by).toBe(coordinator);
    expect(processed.processed_at).not.toBeNull();
  });
});
