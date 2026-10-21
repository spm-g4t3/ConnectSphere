// The notification row and its camelCase contract shape, shared by the
// notification route and service tests. The route tests drive the real
// service, so both suites stub the same Supabase chain.

export { queryStub, ok, fail, counted } from './supabaseStubs.js';

export const COORDINATOR_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
export const NOTIFICATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const BOOKING_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const BLOCK_ID = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
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
