// The notification row, its camelCase contract shape and the query-builder
// stub shared by the notification route and service tests. The route tests
// drive the real service, so both suites stub the same Supabase chain.

export const COORDINATOR_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
export const NOTIFICATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
export const BOOKING_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
export const BLOCK_ID = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
export const FIRST_READ = '2026-09-27T01:00:00+00:00';

export const PAYLOAD = Object.freeze({
  venueName: 'Seminar Room 2-1',
  eventName: 'Tech Talk',
  startsAt: '2026-10-01T02:00:00+00:00',
  endsAt: '2026-10-01T04:00:00+00:00',
  reason: 'maintenance',
  blockStartsAt: '2026-10-01T01:00:00+00:00',
  blockEndsAt: '2026-10-01T09:00:00+00:00',
});

/** A notifications row as PostgREST returns it, snake_case. */
export function notificationRow(overrides = {}) {
  return {
    id: NOTIFICATION_ID,
    recipient_id: COORDINATOR_ID,
    type: 'booking_flagged',
    booking_id: BOOKING_ID,
    block_id: BLOCK_ID,
    venue_hold_id: null,
    event_request_id: null,
    payload: PAYLOAD,
    read_at: null,
    created_at: '2026-09-26T03:00:00+00:00',
    ...overrides,
  };
}

/** notificationRow() as the service and the API return it. */
export const CAMEL_NOTIFICATION = Object.freeze({
  id: NOTIFICATION_ID,
  type: 'booking_flagged',
  bookingId: BOOKING_ID,
  blockId: BLOCK_ID,
  venueHoldId: null,
  eventRequestId: null,
  payload: PAYLOAD,
  readAt: null,
  createdAt: '2026-09-26T03:00:00+00:00',
});

/**
 * A stand-in for a supabase-js query builder, extended from the one in
 * venueBlockService.test.js with `update`. `calls` is exposed too, so a test
 * can assert the order of a chain.
 */
export function queryStub(result) {
  const calls = [];

  const stub = {
    calls,
    called: (method) => calls.some(([name]) => name === method),
    args: (method) => calls.find(([name]) => name === method)?.slice(1),
    allArgs: (method) => calls.filter(([name]) => name === method).map((c) => c.slice(1)),
    then: (onFulfilled, onRejected) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  };

  for (const method of ['select', 'update', 'eq', 'is', 'order', 'limit']) {
    stub[method] = (...args) => {
      calls.push([method, ...args]);
      return stub;
    };
  }

  stub.maybeSingle = (...args) => {
    calls.push(['maybeSingle', ...args]);
    return Promise.resolve(result);
  };

  return stub;
}

export const ok = (data) => ({ data, error: null });
export const fail = (error) => ({ data: null, error });
// A head: true count query answers with no rows, only a count.
export const counted = (count) => ({ data: null, count, error: null });
