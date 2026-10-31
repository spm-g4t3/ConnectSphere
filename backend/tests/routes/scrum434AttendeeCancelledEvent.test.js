// SCRUM-434 AC5 (route): on a cancelled event an attendee sees only the coordinator's optional
// message, never the internal reason, and never any other event data.
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createRequireAuth } from '../../src/middleware/requireAuth.js';
import { createAttendeeEventRouter } from '../../src/routes/attendeeEvents.js';
import { ROLE } from '../../src/domain/userRole.js';
import { STATUS } from '../../src/domain/eventRequestStatus.js';

vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: { from: vi.fn() } }));

const ATTENDEE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EVENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REGISTRATION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const REASON = 'INTERNAL_CANCELLATION_REASON_SENTINEL';

// event_registrations answers the first read, event_requests the message read.
function client({ status = STATUS.CANCELLED, message = 'We are sorry, the event will not go ahead.', registrationError = null, messageError = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, columns: null, filters: [] };
      calls.push(call);
      const query = {
        select(columns) { call.columns = columns; return query; },
        eq(field, value) { call.filters.push([field, value]); return query; },
        async maybeSingle() {
          if (table === 'event_registrations') {
            return {
              data: registrationError ? null : {
                id: REGISTRATION, attendee_id: ATTENDEE, event_request_id: EVENT, status: 'registered',
                event_requests: {
                  id: EVENT, event_name: 'Registered event', status, proposed_start: SECRET_DATE, proposed_end: SECRET_DATE,
                  bookings: [{ id: 'b', status: 'approved', venues: { name: 'PRIVATE_VENUE', location: 'PRIVATE_LOCATION' } }],
                  cancellation_reason: REASON,
                },
                cancellation_reason: REASON,
              },
              error: registrationError,
            };
          }
          return {
            data: messageError ? null : { attendee_message: message, cancellation_reason: REASON },
            error: messageError,
          };
        },
      };
      return query;
    },
  };
}
const SECRET_DATE = '2030-01-01T01:00:00+00:00';

const app = (db, { role = ROLE.ATTENDEE } = {}) => express().use(express.json()).use('/api/attendee-events',
  createAttendeeEventRouter({
    client: db,
    requireAuth: createRequireAuth({
      verifyToken: async token => (token === 'valid' ? { id: ATTENDEE, user_metadata: { role: ROLE.ATTENDEE } } : null),
      loadRole: async () => role,
    }),
  }));
const read = (application, id = EVENT) => request(application).get(`/api/attendee-events/${id}`).set('Authorization', 'Bearer valid');

describe('SCRUM-434 AC5: an attendee reading a cancelled event', () => {
  it('SCRUM434_AC5_a_cancelled_event_shows_its_name_and_the_coordinators_message_only', async () => {
    const response = await read(app(client()));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      eventRequestId: EVENT, registrationId: REGISTRATION, state: 'cancelled', eventName: 'Registered event',
      message: 'We are sorry, the event will not go ahead.',
    });
  });

  it('SCRUM434_AC5_a_cancelled_event_with_no_message_has_a_null_message', async () => {
    const response = await read(app(client({ message: null })));

    expect(response.status).toBe(200);
    expect(response.body.message).toBeNull();
    expect(response.body.state).toBe('cancelled');
  });

  it.each(['', '   ', '\n\t'])('SCRUM434_AC5_a_blank_message_%j_is_treated_as_no_message', async (blank) => {
    const response = await read(app(client({ message: blank })));

    expect(response.body.message).toBeNull();
  });

  it('SCRUM434_AC5_the_message_is_trimmed', async () => {
    const response = await read(app(client({ message: '  See you at the next one.  ' })));

    expect(response.body.message).toBe('See you at the next one.');
  });

  it('SCRUM434_AC5_the_internal_reason_never_appears_in_the_response', async () => {
    const response = await read(app(client()));

    expect(JSON.stringify(response.body)).not.toContain(REASON);
    expect(Object.keys(response.body).sort()).toEqual(['eventName', 'eventRequestId', 'message', 'registrationId', 'state']);
  });

  it('SCRUM434_AC5_no_dates_venues_or_bookings_come_back_for_a_cancelled_event', async () => {
    const response = await read(app(client()));

    const text = JSON.stringify(response.body);
    for (const leaked of ['PRIVATE_VENUE', 'PRIVATE_LOCATION', SECRET_DATE]) expect(text).not.toContain(leaked);
    expect(response.body).not.toHaveProperty('venues');
    expect(response.body).not.toHaveProperty('startsAt');
  });

  it('SCRUM434_AC5_only_the_message_column_is_read_for_a_cancelled_event', async () => {
    const db = client();
    await read(app(db));

    const messageRead = db.calls.find(call => call.table === 'event_requests');
    expect(messageRead.columns).toBe('attendee_message');
    expect(messageRead.filters).toEqual([['id', EVENT]]);
  });

  it('SCRUM434_AC5_the_message_is_not_read_for_an_event_that_is_not_cancelled', async () => {
    const db = client({ status: STATUS.APPROVED });
    const response = await read(app(db));

    expect(response.body).toEqual({ eventRequestId: EVENT, registrationId: REGISTRATION, state: 'unavailable', eventName: 'Registered event' });
    expect(db.calls.map(call => call.table)).toEqual(['event_registrations']);
  });

  it('SCRUM434_AC5_a_failed_message_read_does_not_return_a_partial_answer', async () => {
    const response = await read(app(client({ messageError: { code: 'XX000', message: REASON } })));

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain(REASON);
  });

  it.each(['42P01', '42703'])('SCRUM434_AC5_a_missing_message_column_%s_fails_closed_with_a_503', async (code) => {
    const response = await read(app(client({ messageError: { code, message: REASON } })));

    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain(REASON);
  });

  it.each([ROLE.EVENT_ORGANISER, ROLE.EVENT_COORDINATOR, ROLE.VENUE_STAFF, ROLE.TECHNICAL_SUPPORT_STAFF])(
    'SCRUM434_AC5_%s_cannot_use_the_attendee_read',
    async (role) => {
      const db = client();
      const response = await read(app(db, { role }));

      expect(response.status).toBe(403);
      expect(db.calls).toEqual([]);
    },
  );

  it('SCRUM434_AC5_an_attendee_with_no_registration_gets_a_404_and_no_message_read', async () => {
    const db = client({ registrationError: null });
    // A different event id: the registration filter finds nothing.
    const missing = { ...db, from: (table) => (table === 'event_registrations'
      ? { select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: null, error: null }; } }
      : db.from(table)) };
    const response = await read(app(missing));

    expect(response.status).toBe(404);
    expect(db.calls.map(call => call.table)).not.toContain('event_requests');
  });
});
