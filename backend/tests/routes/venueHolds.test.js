/**
 * Tests for the venue hold routes.
 *
 * SCRUM-491 "Place a Tentative Venue Hold with Expiry - Venue Staff".
 *
 *   GET  /api/venues/:id/holds   a venue's active holds
 *   POST /api/venues/:id/holds   place a hold
 *
 * Transport tests: the right roles reach the routes, the placer is the
 * signed-in user, and each refusal arrives with its status, code and
 * conflicts. The real router and the real service run over a mocked supabase
 * client, as routes/venues.test.js does, so what is proved is the whole trip
 * from HTTP to the rpc and back. The rules are proved in Postgres by
 * tests/db/venueHoldsDatabase.test.js.
 *
 * Acceptance criteria carried in the test names:
 *   AC1 -- only Venue Staff, others refused with a message stating why
 *   AC2 -- one Approved event, one venue, a future expiry
 *   AC3 -- one active hold per event at each venue
 *   AC4 -- refused over a booking, block or hold, showing the period
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));

vi.mock('../../src/config/supabaseClient.js', () => {
  const client = { rpc, from };
  return { supabase: client, default: client };
});

const { createVenueRouter } = await import('../../src/routes/venues.js');
const { supabase } = await import('../../src/config/supabaseClient.js');
const { ROLE } = await import('../../src/domain/userRole.js');


const VENUE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const STAFF_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const HOLD_ID = '55555555-5555-4555-8555-555555555555';
const EXPIRES = '2999-01-01T12:00:00+08:00';

const holdRow = (overrides = {}) => ({
  id: HOLD_ID,
  event_request_id: EVENT_ID,
  venue_id: VENUE_ID,
  placed_by: STAFF_ID,
  placed_at: '2026-10-10T02:00:00+00:00',
  expires_at: '2999-01-01T04:00:00+00:00',
  status: 'active',
  expired_at: null,
  ...overrides,
});

/** The same thenable query stub the other route tests use. */
function queryStub(result) {
  const stub = {
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
    maybeSingle: () => Promise.resolve(result),
  };
  for (const method of ['select', 'eq', 'in', 'gt', 'order']) {
    stub[method] = () => stub;
  }
  return stub;
}

const ok = (data) => ({ data, error: null });
const fail = (error) => ({ data: null, error });

const signedInAs = (role, id = STAFF_ID) => (req, _res, next) => {
  req.user = { id, email: 'someone@example.com', role };
  next();
};

const signedOut = (_req, res) => res.status(401).json({ error: 'Authentication required' });

function appWith(requireAuth = signedInAs(ROLE.VENUE_STAFF)) {
  return express()
    .use(express.json())
    .use('/api/venues', createVenueRouter({ requireAuth }));
}

const placeBody = { eventRequestId: EVENT_ID, expiresAt: EXPIRES };

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
});


describe('the test double', () => {
  it('the supabase client is mocked and never the real one', () => {
    expect(vi.isMockFunction(supabase.rpc)).toBe(true);
  });
});


describe('POST /api/venues/:id/holds', () => {
  it('SCRUM491_AC2_201_places_a_hold_for_the_signed_in_venue_staff', async () => {
    rpc.mockResolvedValue(ok({ outcome: 'placed', hold: holdRow() }));

    const res = await request(appWith())
      .post(`/api/venues/${VENUE_ID}/holds`)
      .send({ ...placeBody, placedBy: 'someone-else' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      hold: {
        id: HOLD_ID,
        eventRequestId: EVENT_ID,
        venueId: VENUE_ID,
        placedBy: STAFF_ID,
        placedAt: '2026-10-10T02:00:00+00:00',
        expiresAt: '2999-01-01T04:00:00+00:00',
        status: 'active',
        expiredAt: null,
      },
    });
    expect(rpc).toHaveBeenCalledWith('place_venue_hold', {
      p_event_request_id: EVENT_ID,
      p_venue_id: VENUE_ID,
      p_expires_at: EXPIRES,
      p_placed_by: STAFF_ID,
    });
  });

  it.each([
    ROLE.EVENT_COORDINATOR,
    ROLE.EVENT_ORGANISER,
    ROLE.TECHNICAL_SUPPORT_STAFF,
    ROLE.ATTENDEE,
  ])('SCRUM491_AC1_403_for_%s_with_the_reason', async (role) => {
    const res = await request(appWith(signedInAs(role))).post(`/api/venues/${VENUE_ID}/holds`).send(placeBody);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'This action is restricted to Venue Staff' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('401 when signed out', async () => {
    const res = await request(appWith(signedOut)).post(`/api/venues/${VENUE_ID}/holds`).send(placeBody);
    expect(res.status).toBe(401);
  });

  it.each([
    ['a malformed venue id', 'nope', placeBody],
    ['no event', VENUE_ID, { expiresAt: EXPIRES }],
    ['no expiry', VENUE_ID, { eventRequestId: EVENT_ID }],
    ['a past expiry', VENUE_ID, { eventRequestId: EVENT_ID, expiresAt: '2000-01-01T00:00:00Z' }],
    ['an expiry with no offset', VENUE_ID, { eventRequestId: EVENT_ID, expiresAt: '2999-01-01T09:00:00' }],
  ])('SCRUM491_AC2_400_for_%s', async (_label, venueId, body) => {
    const res = await request(appWith()).post(`/api/venues/${venueId}/holds`).send(body);

    expect(res.status).toBe(400);
    expect(res.body.details.length).toBeGreaterThan(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('404 for an unknown event or venue', async () => {
    rpc.mockResolvedValue(fail({ code: 'P0002', message: 'venue x not found' }));

    const res = await request(appWith()).post(`/api/venues/${VENUE_ID}/holds`).send(placeBody);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('venue x not found');
  });

  it('SCRUM491_AC1_403_when_the_function_refuses_the_placer', async () => {
    rpc.mockResolvedValue(fail({ code: '42501', message: 'only Venue Staff can place a hold on a venue' }));

    const res = await request(appWith()).post(`/api/venues/${VENUE_ID}/holds`).send(placeBody);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('only Venue Staff can place a hold on a venue');
  });

  it.each(['EVENT_NOT_APPROVED', 'EVENT_DATES_MISSING', 'VENUE_RETIRED'])(
    'SCRUM491_AC2_409_%s',
    async (hint) => {
      rpc.mockResolvedValue(fail({ code: 'PT409', hint, message: 'refused' }));

      const res = await request(appWith()).post(`/api/venues/${VENUE_ID}/holds`).send(placeBody);

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'refused', code: hint, conflicts: [] });
    },
  );

  it('SCRUM491_AC3_409_HOLD_EXISTS_names_the_existing_hold', async () => {
    rpc.mockResolvedValue(fail({ code: 'PT409', hint: 'HOLD_EXISTS', details: HOLD_ID, message: 'already held' }));

    const res = await request(appWith()).post(`/api/venues/${VENUE_ID}/holds`).send(placeBody);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HOLD_EXISTS');
    expect(res.body.conflicts).toEqual([{ kind: 'hold', holdId: HOLD_ID }]);
  });

  it('SCRUM491_AC4_409_HOLD_PERIOD_CONFLICT_shows_the_conflicting_period', async () => {
    rpc.mockResolvedValue(ok({
      outcome: 'conflict',
      conflicts: [{
        kind: 'hold',
        hold_id: 'h1',
        event_request_id: 'e2',
        event_name: 'Expo',
        starts_at: '2026-10-20T02:00:00+00:00',
        ends_at: '2026-10-20T04:00:00+00:00',
        occupied_starts_at: '2026-10-20T01:30:00+00:00',
        occupied_ends_at: '2026-10-20T04:45:00+00:00',
        setup_minutes: 30,
        turnaround_minutes: 45,
      }],
    }));

    const res = await request(appWith()).post(`/api/venues/${VENUE_ID}/holds`).send(placeBody);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HOLD_PERIOD_CONFLICT');
    expect(res.body.conflicts).toEqual([{
      kind: 'hold',
      holdId: 'h1',
      eventRequestId: 'e2',
      eventName: 'Expo',
      startsAt: '2026-10-20T02:00:00+00:00',
      endsAt: '2026-10-20T04:00:00+00:00',
      occupiedStartsAt: '2026-10-20T01:30:00+00:00',
      occupiedEndsAt: '2026-10-20T04:45:00+00:00',
      setupMinutes: 30,
      turnaroundMinutes: 45,
    }]);
  });

  it('500 for anything untyped, without the driver message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    rpc.mockResolvedValue(fail({ code: 'XX000', message: 'secret detail' }));

    const res = await request(appWith()).post(`/api/venues/${VENUE_ID}/holds`).send(placeBody);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Unexpected server error' });
    spy.mockRestore();
  });
});


describe('GET /api/venues/:id/holds', () => {
  it('200 lists the active holds with event and placer names', async () => {
    from.mockImplementation((table) => {
      if (table === 'venues') return queryStub(ok({ id: VENUE_ID }));
      if (table === 'venue_holds') {
        return queryStub(ok([{ ...holdRow(), event_requests: { event_name: 'Tech Talk', proposed_start: 'ps', proposed_end: 'pe' } }]));
      }
      if (table === 'profiles') return queryStub(ok([{ id: STAFF_ID, full_name: 'Sam Staff' }]));
      throw new Error(`unexpected table ${table}`);
    });

    const res = await request(appWith()).get(`/api/venues/${VENUE_ID}/holds`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: HOLD_ID, eventName: 'Tech Talk', placedByName: 'Sam Staff' });
  });

  it('200 [] when the venue holds nothing', async () => {
    from.mockImplementation((table) =>
      queryStub(table === 'venues' ? ok({ id: VENUE_ID }) : ok([])),
    );

    const res = await request(appWith()).get(`/api/venues/${VENUE_ID}/holds`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('404 for an unknown venue', async () => {
    from.mockImplementation(() => queryStub(ok(null)));

    const res = await request(appWith()).get(`/api/venues/${VENUE_ID}/holds`);

    expect(res.status).toBe(404);
  });

  it('400 for a malformed id', async () => {
    const res = await request(appWith()).get('/api/venues/nope/holds');
    expect(res.status).toBe(400);
  });

  it('SCRUM491_AC1_403_for_an_event_coordinator', async () => {
    const res = await request(appWith(signedInAs(ROLE.EVENT_COORDINATOR))).get(`/api/venues/${VENUE_ID}/holds`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('This action is restricted to Venue Staff');
  });
});
