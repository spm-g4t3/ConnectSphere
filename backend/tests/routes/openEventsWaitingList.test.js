import express from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { createOpenEventRouter } from '../../src/routes/openEvents.js';
import { createRequireAuth } from '../../src/middleware/requireAuth.js';
import { ROLE } from '../../src/domain/userRole.js';

const ME = '44444444-4444-4444-8444-444444444444';
const EVENT = 'a1111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-16T10:00:00Z');

const eventRow = (overrides = {}) => ({
  id: EVENT,
  event_name: 'Open Day',
  description: 'Come along.',
  proposed_start: '2026-10-25T09:00:00+00:00',
  proposed_end: '2026-10-25T17:00:00+00:00',
  status: 'confirmed',
  registration_enabled: true,
  registration_opens_at: '2026-10-01T00:00:00+00:00',
  registration_closes_at: null,
  registration_capacity: 1,
  registration_waitlist_enabled: true,
  ...overrides,
});

// The rows the event query would return, and the caller's state as
// open_event_registration_state returns it; the filters are tested elsewhere.
function client(row, state) {
  const chain = new Proxy({}, {
    get: (_target, key) => (key === 'then'
      ? (resolve) => resolve({ data: [row], error: null })
      : () => chain),
  });
  return {
    from: () => chain,
    rpc: async () => ({ data: state ? [{ event_request_id: EVENT, ...state }] : [], error: null }),
  };
}

function browse(row, state) {
  const requireAuth = createRequireAuth({
    verifyToken: async () => ({ id: ME, email: 'a@example.com' }),
    loadRole: async () => ROLE.ATTENDEE,
  });
  const app = express().use('/api/open-events', createOpenEventRouter({
    client: client(row, state), requireAuth, now: () => NOW,
  }));
  return request(app).get(`/api/open-events/${EVENT}`).set('Authorization', 'Bearer t');
}

const full = { active_count: 1, is_registered: false };

describe('SCRUM460 waiting list on the browse pages', () => {
  it('SCRUM460_AC1_offers_the_waiting_list_on_a_full_event_that_has_one', async () => {
    const res = await browse(eventRow(), full);
    expect(res.body).toMatchObject({ isFull: true, canRegister: false, canJoinWaitlist: true, waitlistPosition: null });
  });

  it.each([
    ['the event has places', eventRow({ registration_capacity: 2 }), full],
    ['the waiting list is off', eventRow({ registration_waitlist_enabled: false }), full],
    ['the caller is registered', eventRow(), { active_count: 1, is_registered: true, registration_status: 'registered' }],
    ['the caller is already waiting', eventRow(), { ...full, registration_status: 'waitlisted', waitlist_position: 1 }],
    ['the registration was cancelled', eventRow(), { ...full, registration_status: 'cancelled' }],
  ])('SCRUM460_AC1_does_not_offer_it_when_%s', async (_case, row, state) => {
    expect((await browse(row, state)).body.canJoinWaitlist).toBe(false);
  });

  it('SCRUM460_AC1_a_withdrawn_attendee_may_join_again', async () => {
    const res = await browse(eventRow(), { ...full, registration_status: 'withdrawn' });
    expect(res.body.canJoinWaitlist).toBe(true);
  });

  it('SCRUM460_AC2_shows_the_callers_own_position_but_not_the_queue_length', async () => {
    const res = await browse(eventRow(), { ...full, registration_status: 'waitlisted', waitlist_position: '3' });
    expect(res.body).toMatchObject({ waitlistPosition: 3, waitlistCount: null });
  });
});
