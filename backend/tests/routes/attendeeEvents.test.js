import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequireAuth } from '../../src/middleware/requireAuth.js';
import { createAttendeeEventRouter } from '../../src/routes/attendeeEvents.js';
import { getAttendeeEvent } from '../../src/services/attendeeEventService.js';
import { ROLE } from '../../src/domain/userRole.js';
import { STATUS } from '../../src/domain/eventRequestStatus.js';
import { BOOKING_STATUS } from '../../src/domain/bookingStatus.js';

const defaultClient = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: defaultClient }));

const ATTENDEE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ATTENDEE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EVENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_EVENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const user = { id: ATTENDEE, role: ROLE.ATTENDEE };
const notFound = { error: 'Event information not found' };
const unavailable = { eventRequestId: EVENT, state: 'unavailable' };
const confirmed = {
  eventRequestId: EVENT, state: 'confirmed',
  startsAt: '2030-01-01T01:00:00+00:00', endsAt: '2030-01-01T03:00:00+00:00',
  venues: [{ bookingId: 'booking-a', name: 'Hall A', location: 'Building A' }],
};
const secrets = {
  notes: 'PRIVATE_STAFF_NOTES_SENTINEL',
  discussion: 'PRIVATE_DISCUSSION_SENTINEL',
  schedule: 'PRIVATE_DRAFT_SCHEDULE_SENTINEL',
  supplier: 'PRIVATE_SUPPLIER_SENTINEL',
  equipment: 'PRIVATE_EQUIPMENT_PLAN_SENTINEL',
  attendee: 'PRIVATE_OTHER_ATTENDEE_SENTINEL@example.com',
  venue: 'PRIVATE_UNCONFIRMED_VENUE_SENTINEL',
  hold: 'PRIVATE_HELD_VENUE_SENTINEL',
};

function confirmedEvent(overrides = {}) {
  return {
    id: EVENT, status: STATUS.CONFIRMED,
    proposed_start: confirmed.startsAt, proposed_end: confirmed.endsAt,
    bookings: [{ id: 'booking-a', status: BOOKING_STATUS.APPROVED, venues: { name: 'Hall A', location: 'Building A' } }],
    ...overrides,
  };
}

function registration(overrides = {}) {
  return {
    attendee_id: ATTENDEE,
    event_request_id: EVENT,
    status: 'registered',
    event_requests: { id: EVENT },
    ...overrides,
  };
}

function sensitiveRegistration(status = STATUS.CONFIRMED) {
  const privateFields = {
    staff_notes: secrets.notes, discussions: [{ body: secrets.discussion }],
    draft_schedule: secrets.schedule, supplier_information: { contact: secrets.supplier },
    equipment_requests: [{ planning_notes: secrets.equipment }],
    event_registrations: [{ attendee_id: OTHER_ATTENDEE, email: secrets.attendee }],
    venue_holds: [{ venues: { name: secrets.hold, location: secrets.hold } }],
  };
  const event = confirmedEvent({ ...privateFields, status });
  event.bookings[0] = {
    ...event.bookings[0], ...privateFields,
    venues: { ...event.bookings[0].venues, ...privateFields },
  };
  event.bookings.push(...Object.values(BOOKING_STATUS)
    .filter(bookingStatus => bookingStatus !== BOOKING_STATUS.APPROVED)
    .map(bookingStatus => ({
      id: `private-${bookingStatus}`, status: bookingStatus,
      venues: { name: secrets.venue, location: secrets.venue },
    })));
  return registration({ ...privateFields, event_requests: event });
}

function expectPrivateValuesExcluded(body) {
  const text = JSON.stringify(body);
  for (const secret of [...Object.values(secrets), ATTENDEE, OTHER_ATTENDEE]) {
    expect(text).not.toContain(secret);
  }
}

// Execute the actual query filters over records, so unrelated and inactive
// registrations cannot pass just because a mock always returns its first row.
// Retain unselected fields to catch accidental record spreads in the response.
function database(rows = [], { error = null, ignoreFilters = false } = {}) {
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
          const data = ignoreFilters ? rows[0] : rows.find(row => (
            call.filters.every(([field, value]) => row[field] === value)
            && row.event_requests?.id
          ));
          return { data: data ?? null, error };
        },
      };
      return query;
    },
  };
}

function application(client, { id = ATTENDEE, role = ROLE.ATTENDEE } = {}) {
  const requireAuth = createRequireAuth({
    verifyToken: async token => token === 'valid'
      ? { id, user_metadata: { role: ROLE.ATTENDEE } } : null,
    loadRole: async () => role,
  });
  return express().use(express.json()).use('/api/attendee-events',
    createAttendeeEventRouter({ client, requireAuth }));
}

const read = (app, id = EVENT) => request(app)
  .get(`/api/attendee-events/${id}`).set('Authorization', 'Bearer valid');

afterEach(() => vi.restoreAllMocks());

describe('SCRUM-24 protected attendee event read', () => {
  it.each([undefined, 'Basic valid', 'Bearer ', 'Bearer expired'])(
    'SCRUM24_AC1_rejects_unauthenticated_access_%s', async authorization => {
      const client = database([sensitiveRegistration()]);
      let req = request(application(client)).get(`/api/attendee-events/${EVENT}`);
      if (authorization !== undefined) req = req.set('Authorization', authorization);
      const response = await req;
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: authorization === 'Bearer expired'
        ? 'Your session is no longer valid' : 'Authentication required' });
      expectPrivateValuesExcluded(response.body);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(client.calls).toEqual([]);
    },
  );

  it.each(Object.values(ROLE).filter(role => role !== ROLE.ATTENDEE))(
    'SCRUM24_AC1_rejects_wrong_role_even_with_attendee_token_metadata_%s', async role => {
      const client = database([sensitiveRegistration()]);
      const response = await read(application(client, { role }));
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'This action is restricted to Attendees' });
      expectPrivateValuesExcluded(response.body);
      expect(client.calls).toEqual([]);
    },
  );

  it('SCRUM24_AC1_requires_a_current_profile_role', async () => {
    const client = database([registration()]);
    expect((await read(application(client, { role: null }))).status).toBe(403);
    expect(client.calls).toEqual([]);
  });

  it('SCRUM24_AC1_reads_only_the_verified_attendees_own_active_registration', async () => {
    const client = database([registration({ attendee_id: OTHER_ATTENDEE }), registration()]);
    const response = await read(application(client));
    expect(response.status).toBe(200);
    expect(response.body).toEqual(unavailable);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(client.calls).toEqual([{
      table: 'event_registrations',
      columns: expect.stringMatching(/event_requests!inner\(id, status, proposed_start, proposed_end,\s*bookings\(id, status, venues\(name, location\)\)\)/),
      filters: [['attendee_id', ATTENDEE], ['event_request_id', EVENT], ['status', 'registered']],
    }]);
  });

  it.each(['withdrawn', 'cancelled', 'waitlisted', 'unknown'])(
    'SCRUM24_AC1_refuses_inactive_registration_%s', async status => {
      const response = await read(application(database([registration({ status })])));
      expect(response.status).toBe(404);
      expect(response.body).toEqual(notFound);
    },
  );

  it('SCRUM24_AC1_unknown_and_inaccessible_events_have_the_same_safe_response', async () => {
    const client = database([{ ...sensitiveRegistration(), attendee_id: OTHER_ATTENDEE }]);
    const app = application(client);
    const inaccessible = await read(app);
    const unknown = await read(app, OTHER_EVENT);
    expect(inaccessible.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(inaccessible.body).toEqual(notFound);
    expect(unknown.body).toEqual(inaccessible.body);
    expectPrivateValuesExcluded(inaccessible.body);
    expectPrivateValuesExcluded(unknown.body);
  });

  it('SCRUM24_AC1_ignores_forged_attendee_identity_and_role_in_query_and_body', async () => {
    const client = database([registration()]);
    const response = await read(application(client, { id: OTHER_ATTENDEE }))
      .query({ attendeeId: ATTENDEE, userId: ATTENDEE, role: ROLE.ATTENDEE })
      .send({ user: { id: ATTENDEE, role: ROLE.ATTENDEE }, attendeeId: ATTENDEE });
    expect(response.status).toBe(404);
    expect(response.body).toEqual(notFound);
    expect(client.calls[0].filters[0]).toEqual(['attendee_id', OTHER_ATTENDEE]);
  });

  it('SCRUM24_AC1_path_event_cannot_be_overridden_by_query_or_body', async () => {
    const client = database([registration()]);
    const response = await read(application(client), OTHER_EVENT)
      .query({ eventRequestId: EVENT, eventId: EVENT }).send({ eventRequestId: EVENT });
    expect(response.status).toBe(404);
    expect(response.body).toEqual(notFound);
    expect(client.calls[0].filters[1]).toEqual(['event_request_id', OTHER_EVENT]);
  });

  it.each(['not-an-id', "' OR 1=1 --"])(
    'SCRUM24_AC1_rejects_invalid_event_identifier_before_querying_%s', async id => {
      const client = database();
      const response = await read(application(client), encodeURIComponent(id));
      expect(response.status).toBe(400);
      expect(response.body.details).toEqual([{ field: 'eventRequestId', message: 'must be a valid UUID' }]);
      expect(Object.keys(response.body).sort()).toEqual(['details', 'error']);
      expect(response.body.error).toBe('Invalid attendee event request');
      expectPrivateValuesExcluded(response.body);
      expect(client.calls).toEqual([]);
    },
  );

  it('SCRUM24_AC1_access_does_not_depend_on_registration_availability', async () => {
    const client = database([registration({ event_requests: {
      id: EVENT, status: 'approved', proposed_start: '2000-01-01T00:00:00Z',
      registration_enabled: false, registration_capacity: 0,
      registration_opens_at: '2100-01-01T00:00:00Z',
      registration_closes_at: '2000-01-01T00:00:00Z',
    } })]);
    const response = await read(application(client));
    expect(response.status).toBe(200);
    expect(response.body).toEqual(unavailable);
    expect(client.calls[0].filters.map(([field]) => field))
      .toEqual(['attendee_id', 'event_request_id', 'status']);
  });

  it('SCRUM24_AC1_withdrawal_revokes_access_on_the_next_read', async () => {
    const row = registration();
    const client = database([row]);
    const app = application(client);
    expect((await read(app)).status).toBe(200);
    row.status = 'withdrawn';
    const response = await read(app);
    expect(response.status).toBe(404);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(client.calls).toHaveLength(2);
  });

  it.each([STATUS.APPROVED, STATUS.SAFETY_REVIEW, STATUS.SAFETY_APPROVED, STATUS.CANCELLED])(
    'SCRUM24_AC8_unconfirmed_response_excludes_every_sensitive_category_%s', async status => {
      const row = sensitiveRegistration(status);
      row.event_requests.proposed_start = secrets.schedule;
      row.event_requests.proposed_end = secrets.schedule;
      const response = await read(application(database([row])));
      expect(response.status).toBe(200);
      expect(response.body).toEqual(unavailable);
      expect(Object.keys(response.body).sort()).toEqual(['eventRequestId', 'state']);
      expectPrivateValuesExcluded(response.body);
    },
  );

  it.each(['42P01', '42703', 'PGRST200', 'PGRST202', 'PGRST204', 'PGRST205'])(
    'SCRUM24_AC1_missing_dependency_schema_fails_closed_%s', async code => {
      const client = database([sensitiveRegistration()], {
        error: { code, message: secrets.notes, details: secrets.discussion, hint: secrets.supplier },
      });
      const response = await read(application(client));
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'Event information is temporarily unavailable. Please try again later.' });
      expectPrivateValuesExcluded(response.body);
    },
  );

  it.each(['42501', '22023', '55000', '40001', '40P01', 'XX000'])(
    'SCRUM24_AC1_unexpected_database_failure_is_logged_and_not_disclosed_%s', async code => {
      const error = { code, message: secrets.notes, details: secrets.attendee, hint: secrets.equipment };
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await read(application(database([sensitiveRegistration()], { error })));
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Unexpected server error' });
      expectPrivateValuesExcluded(response.body);
      expect(log).toHaveBeenCalledWith('Unexpected error in attendee events route:', error);
    },
  );

  it('SCRUM24_AC8_thrown_database_errors_never_expose_sensitive_properties', async () => {
    const error = Object.assign(new Error(secrets.notes), {
      details: secrets.attendee, hint: secrets.supplier, record: sensitiveRegistration(),
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = { from() { throw error; } };
    const response = await read(application(client));
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Unexpected server error' });
    expectPrivateValuesExcluded(response.body);
    expect(log).toHaveBeenCalledWith('Unexpected error in attendee events route:', error);
  });

  it.each([
    { attendee_id: OTHER_ATTENDEE }, { event_request_id: OTHER_EVENT },
    { status: 'withdrawn' }, { event_requests: { id: OTHER_EVENT } },
    { event_requests: undefined },
  ])('SCRUM24_AC1_reusable_policy_refuses_mismatched_query_results_%j', async overrides => {
    const client = database([registration(overrides)], { ignoreFilters: true });
    await expect(getAttendeeEvent({ user, eventRequestId: EVENT, client }))
      .rejects.toMatchObject({ status: 404, message: notFound.error });
  });

  it('SCRUM24_AC1_reusable_policy_requires_verified_identity_and_attendee_role', async () => {
    const client = database([registration()]);
    await expect(getAttendeeEvent()).rejects.toMatchObject({ status: 401 });
    await expect(getAttendeeEvent({ user: {}, eventRequestId: EVENT, client }))
      .rejects.toMatchObject({ status: 401 });
    await expect(getAttendeeEvent({ user: { ...user, role: ROLE.EVENT_ORGANISER }, eventRequestId: EVENT, client }))
      .rejects.toMatchObject({ status: 403 });
    await expect(getAttendeeEvent({ user: { ...user, id: 'forged' }, eventRequestId: EVENT, client }))
      .rejects.toMatchObject({ status: 400, details: [{ field: 'attendeeId', message: 'must be a valid UUID' }] });
    expect(client.calls).toEqual([]);
  });

  it('SCRUM24_AC1_normalises_UUIDs_and_resolves_the_default_server_client', async () => {
    const client = database([registration()]);
    defaultClient.from.mockImplementation(client.from);
    await expect(getAttendeeEvent({
      user: { ...user, id: ` ${ATTENDEE.toUpperCase()} ` }, eventRequestId: ` ${EVENT.toUpperCase()} `,
    })).resolves.toEqual(unavailable);
    expect(client.calls[0].filters.slice(0, 2))
      .toEqual([['attendee_id', ATTENDEE], ['event_request_id', EVENT]]);
  });

  it('SCRUM24_AC1_default_router_is_protected_without_injected_middleware', async () => {
    const app = express().use('/api/attendee-events', createAttendeeEventRouter());
    const response = await request(app).get(`/api/attendee-events/${EVENT}`);
    expect(response.status).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('SCRUM24_AC4_AC5_AC6_reads_confirmed_times_and_each_approved_venue_only', async () => {
    const event = confirmedEvent();
    event.bookings.push(
      { id: 'booking-b', status: BOOKING_STATUS.APPROVED, venues: { name: 'Hall B', location: 'Building B' } },
      ...Object.values(BOOKING_STATUS).filter(status => status !== BOOKING_STATUS.APPROVED)
        .map(status => ({ id: status, status, venues: { name: 'Hidden venue', location: 'Hidden' } })),
    );
    const client = database([registration({ event_requests: event })]);
    const response = await read(application(client));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ...confirmed, venues: [...confirmed.venues,
      { bookingId: 'booking-b', name: 'Hall B', location: 'Building B' },
    ] });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].columns).not.toContain('venue_holds');
  });

  it.each([...Object.values(STATUS).filter(status => status !== STATUS.CONFIRMED),
    'Confirmed', 'planning', null, undefined, 'future-status'])(
    'SCRUM24_AC2_AC3_non_confirmed_state_never_discloses_arrangements_%s', async status => {
      const response = await read(application(database([registration({
        event_requests: confirmedEvent({ status }),
      })])));
      expect(response.status).toBe(200);
      expect(response.body).toEqual(unavailable);
    },
  );

  it('SCRUM24_AC7_reads_current_arrangements_after_change_and_reconfirmation', async () => {
    const row = registration({ event_requests: confirmedEvent() });
    const client = database([row]);
    const app = application(client);
    expect((await read(app)).body).toEqual(confirmed);
    row.event_requests.status = STATUS.APPROVED;
    expect((await read(app)).body).toEqual(unavailable);
    row.event_requests = confirmedEvent({
      proposed_start: '2031-02-03T00:00:00+08:00', proposed_end: '2031-02-03T02:00:00+08:00',
      bookings: [{ id: 'new-booking', status: BOOKING_STATUS.APPROVED, venues: { name: 'New hall', location: 'New building' } }],
    });
    expect((await read(app)).body).toEqual({ ...confirmed,
      startsAt: row.event_requests.proposed_start, endsAt: row.event_requests.proposed_end,
      venues: [{ bookingId: 'new-booking', name: 'New hall', location: 'New building' }],
    });
    expect(client.calls).toHaveLength(3);
  });

  it('SCRUM24_AC8_confirmed_response_uses_an_allowlist_including_nested_venues', async () => {
    const response = await read(application(database([sensitiveRegistration()])));
    expect(response.status).toBe(200);
    expect(response.body).toEqual(confirmed);
    expect(Object.keys(response.body).sort()).toEqual(['endsAt', 'eventRequestId', 'startsAt', 'state', 'venues']);
    expect(Object.keys(response.body.venues[0]).sort()).toEqual(['bookingId', 'location', 'name']);
    expectPrivateValuesExcluded(response.body);
  });

  it('SCRUM24_AC8_query_selects_exactly_the_columns_required_by_the_protected_read', async () => {
    const client = database([sensitiveRegistration()]);
    await read(application(client));
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].table).toBe('event_registrations');
    expect(client.calls[0].columns.replace(/\s+/g, '')).toBe(
      'event_request_id,attendee_id,status,event_requests!inner(id,status,proposed_start,proposed_end,'
      + 'bookings(id,status,venues(name,location)))',
    );
  });

  it('SCRUM24_AC4_AC5_AC6_missing_arrangement_data_is_not_fabricated', async () => {
    const client = database([registration({ event_requests: confirmedEvent({
      proposed_start: null, proposed_end: undefined, bookings: undefined,
    }) })]);
    expect((await read(application(client))).body).toEqual({
      eventRequestId: EVENT, state: 'confirmed', startsAt: null, endsAt: null, venues: [],
    });
    const missingVenue = database([registration({ event_requests: confirmedEvent({
      bookings: [{ id: 'missing', status: BOOKING_STATUS.APPROVED, venues: null },
        { id: 'partial', status: BOOKING_STATUS.APPROVED, venues: { name: 'Hall' } }],
    }) })]);
    expect((await read(application(missingVenue))).body.venues).toEqual([
      { bookingId: 'missing', name: null, location: null },
      { bookingId: 'partial', name: 'Hall', location: null },
    ]);
  });
});
