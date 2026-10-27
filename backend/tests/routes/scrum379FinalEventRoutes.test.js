/**
 * SCRUM-382 (SCRUM-379 AC3): every endpoint that changes an event, or something
 * attached to it, refuses a Completed or Cancelled event.
 *
 * Each route is mounted as the app mounts it, with the real guard and a client
 * that knows three events (completed, cancelled, approved) and the booking,
 * registration and change request attached to each. The client refuses to
 * answer anything but the guard's own two lookups, so "the handler was never
 * reached" is a plain assertion: no other call was made.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createFinalEventGuard } from '../../src/middleware/finalEventGuard.js';
import { createEventRequestRouter } from '../../src/routes/eventRequests.js';
import { createEventEquipmentRouter } from '../../src/routes/eventEquipment.js';
import { createEquipmentReviewRouter } from '../../src/routes/equipmentReview.js';
import { createBookingRequestRouter } from '../../src/routes/bookingRequests.js';
import { createFlaggedBookingRouter } from '../../src/routes/flaggedBookings.js';
import { createOpenEventRouter } from '../../src/routes/openEvents.js';
import { createAttendeeEventRouter } from '../../src/routes/attendeeEvents.js';
import { createEventRegistrationRouter } from '../../src/routes/eventRegistration.js';
import { createSafetyReviewRouter } from '../../src/routes/safetyReviews.js';
import { createVenueRouter } from '../../src/routes/venues.js';
import { ROLE } from '../../src/domain/userRole.js';
import { signedInFor, signedOut } from '../fixtures/auth.js';

// venues.js imports the shared client when a router is built without one; no test here reaches it.
vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: {} }));

const USER_ID = '44444444-4444-4444-8444-444444444444';
const VENUE_ID = '77777777-7777-4777-8777-777777777777';
const LINE_ID = '88888888-8888-4888-8888-888888888888';

const ids = (n) => ({
  event: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${n}`,
  booking: `bbbbbbbb-bbbb-4bbb-8bbb-00000000000${n}`,
  registration: `cccccccc-cccc-4ccc-8ccc-00000000000${n}`,
  changeRequest: `dddddddd-dddd-4ddd-8ddd-00000000000${n}`,
});
const WORLD = {
  completed: ids(1),
  cancelled: ids(2),
  approved: ids(3),
};

const signedInAs = signedInFor(USER_ID);

// A client that answers only the guard's lookups and records every call.
function worldClient() {
  const statusOfEvent = Object.fromEntries(Object.entries(WORLD).map(([status, s]) => [s.event, status]));
  const eventOfRecord = { bookings: {}, event_registrations: {}, event_change_requests: {} };
  for (const s of Object.values(WORLD)) {
    eventOfRecord.bookings[s.booking] = s.event;
    eventOfRecord.event_registrations[s.registration] = s.event;
    eventOfRecord.event_change_requests[s.changeRequest] = s.event;
  }
  const calls = [];

  const settle = (query) => {
    calls.push(query);
    if (query.table === 'event_requests' && query.cols === 'status') {
      const status = statusOfEvent[query.id];
      return { data: status ? { status } : null, error: null };
    }
    if (query.cols === 'event_request_id' && eventOfRecord[query.table]) {
      const eventId = eventOfRecord[query.table][query.id];
      return { data: eventId ? { event_request_id: eventId } : null, error: null };
    }
    return { data: null, error: { code: 'XX000', message: 'stub: the handler reached the database' } };
  };

  return {
    calls,
    from(table) {
      const query = { table, cols: null, id: null };
      const chain = new Proxy({}, {
        get(_target, prop) {
          if (prop === 'select') return (cols) => { query.cols = cols; return chain; };
          if (prop === 'eq') return (column, value) => { if (column === 'id') query.id = String(value); return chain; };
          if (prop === 'maybeSingle' || prop === 'single') return async () => settle(query);
          if (prop === 'then') return (resolve, reject) => Promise.resolve(settle(query)).then(resolve, reject);
          return () => chain;
        },
      });
      return chain;
    },
    rpc(fn) {
      calls.push({ rpc: fn });
      return Promise.resolve({ data: null, error: { code: 'XX000', message: 'stub: the handler reached the database' } });
    },
    guardLookups: () => calls.filter((c) => c.cols === 'status' || c.cols === 'event_request_id'),
    reached: () => calls.filter((c) => c.rpc || (c.cols !== 'status' && c.cols !== 'event_request_id')),
  };
}

const ROUTERS = {
  eventRequests: { mount: '/api/event-requests', make: createEventRequestRouter },
  eventEquipment: { mount: '/api/event-requests/:id/equipment', make: createEventEquipmentRouter },
  equipmentReview: { mount: '/api/event-requests/:id/equipment-review', make: createEquipmentReviewRouter },
  bookingRequests: { mount: '/api/booking-requests', make: createBookingRequestRouter },
  flaggedBookings: { mount: '/api/flagged-bookings', make: createFlaggedBookingRouter },
  openEvents: { mount: '/api/open-events', make: createOpenEventRouter },
  attendeeEvents: { mount: '/api/attendee-events', make: createAttendeeEventRouter },
  eventRegistration: { mount: '/api/registration', make: createEventRegistrationRouter },
  safetyReviews: { mount: '/api/safety-reviews', make: createSafetyReviewRouter },
  venues: { mount: '/api/venues', make: createVenueRouter },
};

const C = ROLE.EVENT_COORDINATOR;
const O = ROLE.EVENT_ORGANISER;
const L = ROLE.EVENT_COORDINATOR_LEAD;
const V = ROLE.VENUE_STAFF;
const T = ROLE.TECHNICAL_SUPPORT_STAFF;
const A = ROLE.ATTENDEE;
const S = ROLE.SAFETY_OFFICER;

// [router, method, path as declared, role that may use it, whether the route has a role gate, how the event is found]
const ROUTES = [
  ['eventRequests', 'patch', '/:id', O, false, 'event'],
  ['eventRequests', 'post', '/:id/submit', O, false, 'event'],
  ['eventRequests', 'post', '/:id/reopen', O, true, 'event'],
  ['eventRequests', 'post', '/:id/safety-review', C, true, 'event'],
  ['eventRequests', 'post', '/:id/confirm', C, true, 'event'],
  ['eventRequests', 'post', '/:id/clarification', C, true, 'event'],
  ['eventRequests', 'post', '/:id/clarification/close', C, true, 'event'],
  ['eventRequests', 'post', '/:id/reassign', C, true, 'event'],
  ['eventRequests', 'post', '/:id/assign', L, true, 'event'],
  ['eventRequests', 'post', '/:id/start-review', C, true, 'event'],
  ['eventRequests', 'post', '/:id/decision', C, true, 'event'],
  ['eventRequests', 'post', '/:id/cancel', C, true, 'event'],
  ['eventRequests', 'patch', '/:id/details', C, true, 'event'],
  ['eventRequests', 'post', '/:id/complete', C, true, 'event'],
  ['eventRequests', 'post', '/:id/rejection', C, true, 'event'],
  ['eventRequests', 'post', '/:id/significant-change', C, true, 'event'],
  ['eventRequests', 'patch', '/:id/clarification-response', O, false, 'event'],
  ['eventRequests', 'post', '/:id/change-requests', O, false, 'event'],
  ['eventRequests', 'post', '/change-requests/:changeRequestId/decision', C, true, 'changeRequest'],
  ['eventEquipment', 'post', '/lines', C, true, 'event'],
  ['eventEquipment', 'patch', '/lines/:lineId', C, true, 'event'],
  ['eventEquipment', 'delete', '/lines/:lineId', C, true, 'event'],
  ['equipmentReview', 'post', '/start', T, true, 'event'],
  ['equipmentReview', 'post', '/take-over', T, true, 'event'],
  ['equipmentReview', 'put', '/lines/:lineId/outcome', T, true, 'event'],
  ['equipmentReview', 'delete', '/lines/:lineId/outcome', T, true, 'event'],
  ['equipmentReview', 'post', '/complete', T, true, 'event'],
  ['equipmentReview', 'post', '/lines/:lineId/reservations', T, true, 'event'],
  ['equipmentReview', 'patch', '/reservations/:reservationId', T, true, 'event'],
  ['equipmentReview', 'post', '/reservations/:reservationId/release', T, true, 'event'],
  ['equipmentReview', 'post', '/reservations/:reservationId/move', T, true, 'event'],
  ['equipmentReview', 'post', '/reservations/:reservationId/keep', T, true, 'event'],
  ['bookingRequests', 'post', '/', C, true, 'eventInBody'],
  ['bookingRequests', 'post', '/:id/withdraw', C, true, 'booking'],
  ['bookingRequests', 'post', '/:id/release', C, true, 'booking'],
  ['bookingRequests', 'post', '/:id/approve', V, true, 'booking'],
  ['bookingRequests', 'post', '/:id/reject', V, true, 'booking'],
  ['flaggedBookings', 'post', '/:id/reinstate', V, true, 'booking'],
  ['flaggedBookings', 'post', '/:id/cancel', C, true, 'booking'],
  ['openEvents', 'post', '/:id/registrations', A, true, 'event'],
  ['attendeeEvents', 'post', '/registrations/:registrationId/withdrawal', A, true, 'registration'],
  ['eventRegistration', 'put', '/events/:id/settings', O, true, 'event'],
  ['safetyReviews', 'post', '/:eventRequestId/responses', S, true, 'event'],
  ['venues', 'post', '/:id/holds', V, true, 'eventInBody'],
];

const wrongRoleFor = (role) => (role === A ? O : A);

// The concrete URL and body for one route and one scenario.
function target([routerKey, , path, , , kind], scenario) {
  const world = typeof scenario === 'string' ? WORLD[scenario] : scenario;
  const mount = ROUTERS[routerKey].mount.replace(':id', world.event);
  const recordId = { booking: world.booking, registration: world.registration, changeRequest: world.changeRequest };
  const filled = path
    .replace(':changeRequestId', world.changeRequest)
    .replace(':registrationId', world.registration)
    .replace(':eventRequestId', world.event)
    .replace(':lineId', LINE_ID)
    .replace(':reservationId', LINE_ID)
    .replace(':id', kind === 'event' ? world.event : (recordId[kind] ?? VENUE_ID));
  const body = kind === 'eventInBody' ? { eventRequestId: world.event } : {};
  return { url: `${mount}${filled === '/' ? '' : filled}`, body };
}

function appFor(routerKey, { client, requireAuth, withGuard = true }) {
  const options = { client, requireAuth };
  if (withGuard) options.finalEventGuard = createFinalEventGuard({ client });
  return express().use(express.json()).use(ROUTERS[routerKey].mount, ROUTERS[routerKey].make(options));
}

// The mount path is registered once on the app, so mount params must be in the pattern.
const send = (routerKey, method, url, body, options) => {
  const app = appFor(routerKey, options);
  const mount = ROUTERS[routerKey].mount;
  const relative = url.slice(mount.replace(':id', WORLD.completed.event).length);
  return request(app)[method](url).send(body).then((res) => ({ res, relative }));
};

describe('SCRUM-382: every listed endpoint refuses a final event', () => {
  it('SCRUM379_AC3_the_table_below_lists_44_endpoints', () => {
    expect(ROUTES).toHaveLength(44);
    expect(new Set(ROUTES.map(([r, m, p]) => `${r} ${m} ${p}`)).size).toBe(44);
  });

  describe.each(['completed', 'cancelled'])('a %s event', (status) => {
    it.each(ROUTES.map((route) => [`${route[0]} ${route[1].toUpperCase()} ${route[2]}`, route]))(
      'SCRUM379_AC3_%s_is_refused_with_409_and_never_reaches_the_service',
      async (_name, route) => {
        const [routerKey, method, , role] = route;
        const client = worldClient();
        const { url, body } = target(route, status);

        const { res } = await send(routerKey, method, url, body, { client, requireAuth: signedInAs(role) });

        expect(res.status).toBe(409);
        expect(res.body).toEqual({
          error: `This event is ${status} and can no longer be changed`,
          code: 'EVENT_FINAL',
          conflicts: [],
        });
        expect(client.reached()).toEqual([]);
        expect(client.guardLookups().length).toBeGreaterThan(0);
      },
    );
  });

  describe('a live (approved) event', () => {
    it.each(ROUTES.map((route) => [`${route[0]} ${route[1].toUpperCase()} ${route[2]}`, route]))(
      'SCRUM379_AC3_%s_is_not_stopped_by_the_guard',
      async (_name, route) => {
        const [routerKey, method, , role] = route;
        const client = worldClient();
        const { url, body } = target(route, 'approved');

        const { res } = await send(routerKey, method, url, body, { client, requireAuth: signedInAs(role) });

        expect(res.body.code).not.toBe('EVENT_FINAL');
        expect(client.guardLookups().length).toBeGreaterThan(0);
      },
    );
  });

  describe('the role check still comes first', () => {
    const gated = ROUTES.filter((route) => route[4]);

    it('SCRUM379_AC3_the_table_has_gated_and_ungated_routes', () => {
      expect(gated.length).toBeGreaterThan(30);
      expect(ROUTES.length - gated.length).toBe(4);
    });

    it.each(gated.map((route) => [`${route[0]} ${route[1].toUpperCase()} ${route[2]}`, route]))(
      'SCRUM379_AC3_%s_answers_403_to_the_wrong_role_and_learns_nothing_about_the_event',
      async (_name, route) => {
        const [routerKey, method, , role] = route;
        const client = worldClient();
        const { url, body } = target(route, 'completed');

        const { res } = await send(routerKey, method, url, body, { client, requireAuth: signedInAs(wrongRoleFor(role)) });

        expect(res.status).toBe(403);
        expect(res.body.code).not.toBe('EVENT_FINAL');
        expect(client.calls).toEqual([]);
      },
    );
  });

  describe('a caller who is not signed in', () => {
    it.each(ROUTES.map((route) => [`${route[0]} ${route[1].toUpperCase()} ${route[2]}`, route]))(
      'SCRUM379_AC3_%s_answers_401_before_anything_is_read',
      async (_name, route) => {
        const [routerKey, method] = route;
        const client = worldClient();
        const { url, body } = target(route, 'completed');

        const { res } = await send(routerKey, method, url, body, { client, requireAuth: signedOut });

        expect(res.status).toBe(401);
        expect(client.calls).toEqual([]);
      },
    );
  });

  describe('an event that does not exist', () => {
    it.each([
      ['eventRequests', 'post', '/:id/clarification', C, 'event'],
      ['eventEquipment', 'post', '/lines', C, 'event'],
      ['bookingRequests', 'post', '/:id/approve', V, 'booking'],
      ['attendeeEvents', 'post', '/registrations/:registrationId/withdrawal', A, 'registration'],
    ])('SCRUM379_AC3_%s_%s_%s_is_left_to_the_handler_to_answer', async (routerKey, method, path, role, kind) => {
      const client = worldClient();
      const route = [routerKey, method, path, role, true, kind];
      const unknown = {
        event: 'eeeeeeee-eeee-4eee-8eee-000000000009',
        booking: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000009',
        registration: 'cccccccc-cccc-4ccc-8ccc-000000000009',
        changeRequest: 'dddddddd-dddd-4ddd-8ddd-000000000009',
      };
      const { url, body } = target(route, unknown);

      const { res } = await send(routerKey, method, url, body, { client, requireAuth: signedInAs(role) });

      expect(res.body.code).not.toBe('EVENT_FINAL');
      expect(res.status).not.toBe(409);
    });
  });

  describe('a router built without a guard', () => {
    it('SCRUM379_AC3_checks_nothing_so_the_tests_that_stub_the_client_see_no_extra_call', async () => {
      const client = worldClient();
      const route = ROUTES.find((r) => r[1] === 'post' && r[2] === '/:id/clarification');
      const { url, body } = target(route, 'completed');

      const { res } = await send('eventRequests', 'post', url, body, {
        client, requireAuth: signedInAs(C), withGuard: false,
      });

      expect(res.body.code).not.toBe('EVENT_FINAL');
      expect(client.guardLookups()).toEqual([]);
    });
  });

  describe('reading stays allowed', () => {
    it.each([
      ['eventRequests', '/api/event-requests/:id', C],
      ['eventEquipment', '/api/event-requests/:id/equipment', C],
    ])('SCRUM379_AC5_a_GET_on_a_completed_event_through_%s_is_not_refused', async (routerKey, mount, role) => {
      const client = worldClient();
      const url = mount.replace(':id', WORLD.completed.event);
      const app = express().use(express.json()).use(
        ROUTERS[routerKey].mount,
        ROUTERS[routerKey].make({ client, requireAuth: signedInAs(role), finalEventGuard: createFinalEventGuard({ client }) }),
      );

      const res = await request(app).get(url);

      expect(res.body.code).not.toBe('EVENT_FINAL');
      expect(client.guardLookups()).toEqual([]);
    });
  });

});
