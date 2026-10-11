/**
 * Tests for the venue hold service.
 *
 * SCRUM-491 "Place a Tentative Venue Hold with Expiry - Venue Staff".
 *
 * Acceptance criteria carried in the test names:
 *   AC1 -- only Venue Staff can place a hold (the function's own 42501)
 *   AC2 -- one Approved event and one venue, with a future expiry
 *   AC3 -- one active hold per event at each venue (HOLD_EXISTS)
 *   AC4 -- refused over a booking, block or hold, with the conflicting period
 *   AC7 -- a lapsed hold is not listed as active
 *
 * The rules themselves run in Postgres and are proved against a real one in
 * tests/db/venueHoldsDatabase.test.js. These tests prove the service around
 * them: validation before any call, the arguments sent, and how each answer
 * and error is turned into a typed one. The client is a hand-rolled fake
 * passed in, as bookingRequestService.test.js does, so no credentials are
 * read.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  placeVenueHold,
  listActiveVenueHolds,
  listHoldCandidates,
  toVenueHold,
} from '../../src/services/venueHoldService.js';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} from '../../src/errors.js';


const VENUE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const STAFF_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const COORD_ID = '44444444-4444-4444-8444-444444444444';
const HOLD_ID = '55555555-5555-4555-8555-555555555555';
const EXPIRES = '2999-01-01T12:00:00+08:00';
const NOW = new Date('2026-10-10T02:00:00.000Z');

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

/**
 * A fake supabase client. rpc answers from `rpcResult`; each from(table)
 * answers from the queue for that table, in order. Every call is recorded.
 */
function fakeClient({ rpcResult, tables = {} } = {}) {
  const calls = { rpc: [], from: [] };
  const queues = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, [...v]]));

  function builder(table) {
    const chain = [];
    calls.from.push({ table, chain });
    const settle = () => {
      const queue = queues[table] ?? [];
      if (queue.length === 0) throw new Error(`no result queued for ${table}`);
      return Promise.resolve(queue.shift());
    };
    const stub = {
      then: (onFulfilled, onRejected) => settle().then(onFulfilled, onRejected),
      maybeSingle: (...args) => {
        chain.push(['maybeSingle', ...args]);
        return settle();
      },
    };
    for (const method of ['select', 'eq', 'in', 'gt', 'order']) {
      stub[method] = (...args) => {
        chain.push([method, ...args]);
        return stub;
      };
    }
    return stub;
  }

  return {
    calls,
    rpc: (name, args) => {
      calls.rpc.push([name, args]);
      return Promise.resolve(rpcResult);
    },
    from: (table) => builder(table),
  };
}

const ok = (data) => ({ data, error: null });
const fail = (error) => ({ data: null, error });

async function errorFrom(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}


describe('toVenueHold', () => {
  it('maps a row to camelCase', () => {
    expect(toVenueHold(holdRow())).toEqual({
      id: HOLD_ID,
      eventRequestId: EVENT_ID,
      venueId: VENUE_ID,
      placedBy: STAFF_ID,
      placedAt: '2026-10-10T02:00:00+00:00',
      expiresAt: '2999-01-01T04:00:00+00:00',
      status: 'active',
      expiredAt: null,
    });
  });

  it('reads a missing expired_at as null', () => {
    const { expired_at: _omitted, ...row } = holdRow();
    expect(toVenueHold(row).expiredAt).toBeNull();
  });
});


describe('placeVenueHold', () => {
  const body = { eventRequestId: EVENT_ID, expiresAt: EXPIRES };

  it('SCRUM491_AC2_places_a_hold_with_the_signed_in_user_as_placer', async () => {
    const client = fakeClient({ rpcResult: ok({ outcome: 'placed', hold: holdRow() }) });

    const hold = await placeVenueHold(VENUE_ID, { ...body, placedBy: 'someone-else' }, STAFF_ID, { client });

    expect(hold).toEqual(toVenueHold(holdRow()));
    expect(client.calls.rpc).toEqual([
      ['place_venue_hold', {
        p_event_request_id: EVENT_ID,
        p_venue_id: VENUE_ID,
        p_expires_at: EXPIRES,
        p_placed_by: STAFF_ID,
      }],
    ]);
  });

  it.each([undefined, null, '', '  '])('refuses a missing user (%s) before any call', async (userId) => {
    const client = fakeClient();
    const err = await errorFrom(placeVenueHold(VENUE_ID, body, userId, { client }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(client.calls.rpc).toEqual([]);
  });

  it('refuses a malformed venue id before any call', async () => {
    const client = fakeClient();
    const err = await errorFrom(placeVenueHold('nope', body, STAFF_ID, { client }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(client.calls.rpc).toEqual([]);
  });

  it('SCRUM491_AC2_refuses_a_past_expiry_before_any_call', async () => {
    const client = fakeClient();
    const err = await errorFrom(
      placeVenueHold(VENUE_ID, { eventRequestId: EVENT_ID, expiresAt: '2000-01-01T00:00:00Z' }, STAFF_ID, { client }),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'expiresAt', message: 'must be in the future' }]);
    expect(client.calls.rpc).toEqual([]);
  });

  it('SCRUM491_AC4_a_conflict_outcome_is_hold_period_conflict_with_each_period', async () => {
    const conflicts = [
      {
        kind: 'block', block_id: 'b1', starts_at: 's1', ends_at: 'e1', reason: 'maintenance',
        occupied_starts_at: 's1', occupied_ends_at: 'e1', setup_minutes: 30, turnaround_minutes: 45,
      },
      {
        kind: 'booking', booking_id: 'k1', event_request_id: 'ev1', event_name: 'Gala', starts_at: 's2', ends_at: 'e2',
        occupied_starts_at: 'o2', occupied_ends_at: 'p2', setup_minutes: 30, turnaround_minutes: 45,
      },
      {
        kind: 'hold', hold_id: 'h1', event_request_id: 'ev2', event_name: 'Expo', starts_at: 's3', ends_at: 'e3',
        occupied_starts_at: 'o3', occupied_ends_at: 'p3', setup_minutes: 30, turnaround_minutes: 45,
      },
    ];
    const client = fakeClient({ rpcResult: ok({ outcome: 'conflict', conflicts }) });

    const err = await errorFrom(placeVenueHold(VENUE_ID, body, STAFF_ID, { client }));

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('HOLD_PERIOD_CONFLICT');
    expect(err.conflicts.map((c) => c.kind)).toEqual(['block', 'booking', 'hold']);
    expect(err.conflicts[2]).toEqual({
      kind: 'hold',
      holdId: 'h1',
      eventRequestId: 'ev2',
      eventName: 'Expo',
      startsAt: 's3',
      endsAt: 'e3',
      occupiedStartsAt: 'o3',
      occupiedEndsAt: 'p3',
      setupMinutes: 30,
      turnaroundMinutes: 45,
    });
  });

  it('a conflict outcome without a list carries an empty one', async () => {
    const client = fakeClient({ rpcResult: ok({ outcome: 'conflict' }) });
    const err = await errorFrom(placeVenueHold(VENUE_ID, body, STAFF_ID, { client }));
    expect(err.conflicts).toEqual([]);
  });

  it.each([
    ['an unknown outcome', ok({ outcome: 'maybe' })],
    ['no data', ok(null)],
  ])('fails loudly on %s', async (_label, result) => {
    const client = fakeClient({ rpcResult: result });
    const err = await errorFrom(placeVenueHold(VENUE_ID, body, STAFF_ID, { client }));
    expect(err).not.toBeInstanceOf(ConflictError);
    expect(err.message).toMatch(/Unexpected outcome from place_venue_hold/);
  });

  it('fails loudly if the hold is not active', async () => {
    const client = fakeClient({ rpcResult: ok({ outcome: 'placed', hold: holdRow({ status: 'expired' }) }) });
    const err = await errorFrom(placeVenueHold(VENUE_ID, body, STAFF_ID, { client }));
    expect(err.message).toBe('place_venue_hold returned a expired hold, not an active one');
  });

  it.each([
    ['42501', ForbiddenError, 'SCRUM491_AC1_a_non_staff_placer_is_forbidden'],
    ['P0002', NotFoundError, 'a missing event or venue is not found'],
    ['22023', ValidationError, 'a past expiry from the database is a validation error'],
    ['23514', ValidationError, 'a check violation is a validation error'],
    ['23503', ValidationError, 'a missing reference is a validation error'],
  ])('translates %s (%s)', async (code, Type, _label) => {
    const client = fakeClient({ rpcResult: fail({ code, message: 'refused' }) });
    const err = await errorFrom(placeVenueHold(VENUE_ID, body, STAFF_ID, { client }));
    expect(err).toBeInstanceOf(Type);
  });

  it('P0002 with no message still names what was missing', async () => {
    const client = fakeClient({ rpcResult: fail({ code: 'P0002' }) });
    const err = await errorFrom(placeVenueHold(VENUE_ID, body, STAFF_ID, { client }));
    expect(err.message).toBe('Event request or venue not found');
  });

  it.each(['EVENT_NOT_APPROVED', 'EVENT_DATES_MISSING', 'VENUE_RETIRED'])(
    'SCRUM491_AC2_PT409 %s is a conflict with that code and no list',
    async (hint) => {
      const client = fakeClient({ rpcResult: fail({ code: 'PT409', hint, message: 'no' }) });
      const err = await errorFrom(placeVenueHold(VENUE_ID, body, STAFF_ID, { client }));
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.code).toBe(hint);
      expect(err.conflicts).toEqual([]);
    },
  );

  it('SCRUM491_AC3_hold_exists_names_the_existing_hold', async () => {
    const client = fakeClient({
      rpcResult: fail({ code: 'PT409', hint: 'HOLD_EXISTS', details: ` ${HOLD_ID} `, message: 'already' }),
    });
    const err = await errorFrom(placeVenueHold(VENUE_ID, body, STAFF_ID, { client }));
    expect(err.code).toBe('HOLD_EXISTS');
    expect(err.conflicts).toEqual([{ kind: 'hold', holdId: HOLD_ID }]);
  });

  it('SCRUM491_AC3_hold_exists_trusts_only_a_uuid_in_detail', async () => {
    const client = fakeClient({ rpcResult: fail({ code: 'PT409', hint: 'HOLD_EXISTS', details: 'oops' }) });
    const err = await errorFrom(placeVenueHold(VENUE_ID, body, STAFF_ID, { client }));
    expect(err.conflicts).toEqual([]);
  });

  it('PT409 with no hint or detail is a conflict with a null code', async () => {
    const client = fakeClient({ rpcResult: fail({ code: 'PT409' }) });
    const err = await errorFrom(placeVenueHold(VENUE_ID, body, STAFF_ID, { client }));
    expect(err.code).toBeNull();
    expect(err.message).toBe('');
  });

  it('SCRUM491_AC3_the_unique_index_race_is_hold_exists', async () => {
    const client = fakeClient({ rpcResult: fail({ code: '23505', message: 'duplicate' }) });
    const err = await errorFrom(placeVenueHold(VENUE_ID, body, STAFF_ID, { client }));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('HOLD_EXISTS');
  });

  it('anything else stays untyped', async () => {
    const client = fakeClient({ rpcResult: fail({ code: 'XX000', message: 'boom' }) });
    const err = await errorFrom(placeVenueHold(VENUE_ID, body, STAFF_ID, { client }));
    expect(err.constructor).toBe(Error);
    expect(err.message).toBe('boom');
  });

  it('an untyped error with no message says so', async () => {
    const client = fakeClient({ rpcResult: fail({ code: 'XX000' }) });
    const err = await errorFrom(placeVenueHold(VENUE_ID, body, STAFF_ID, { client }));
    expect(err.message).toBe('Unexpected database error');
  });
});


describe('listActiveVenueHolds', () => {
  const listRow = (overrides = {}) => ({
    ...holdRow(),
    event_requests: { event_name: 'Tech Talk', proposed_start: 'ps', proposed_end: 'pe' },
    ...overrides,
  });

  it('SCRUM491_AC7_lists_active_unexpired_holds_with_event_and_placer_names', async () => {
    const client = fakeClient({
      tables: {
        venues: [ok({ id: VENUE_ID })],
        venue_holds: [ok([listRow(), listRow({ id: 'h2', placed_by: null, event_requests: [{ event_name: 'Expo' }] })])],
        profiles: [ok([{ id: STAFF_ID, full_name: 'Sam Staff' }])],
      },
    });

    const holds = await listActiveVenueHolds(VENUE_ID, { client, now: NOW });

    expect(holds[0]).toEqual({
      ...toVenueHold(holdRow()),
      eventName: 'Tech Talk',
      eventStartsAt: 'ps',
      eventEndsAt: 'pe',
      placedByName: 'Sam Staff',
    });
    expect(holds[1]).toMatchObject({ id: 'h2', eventName: 'Expo', eventStartsAt: null, eventEndsAt: null, placedByName: null });

    const read = client.calls.from.find((c) => c.table === 'venue_holds').chain;
    expect(read).toContainEqual(['eq', 'venue_id', VENUE_ID]);
    expect(read).toContainEqual(['eq', 'status', 'active']);
    expect(read).toContainEqual(['gt', 'expires_at', NOW.toISOString()]);
    expect(read).toContainEqual(['order', 'expires_at', { ascending: true }]);
  });

  it('defaults the clock and reads an empty list with no name lookup', async () => {
    const client = fakeClient({ tables: { venues: [ok({ id: VENUE_ID })], venue_holds: [ok(null)] } });
    expect(await listActiveVenueHolds(VENUE_ID, { client })).toEqual([]);
    expect(client.calls.from.map((c) => c.table)).toEqual(['venues', 'venue_holds']);
  });

  it('reads a missing embedded event and a nameless placer as nulls', async () => {
    const client = fakeClient({
      tables: {
        venues: [ok({ id: VENUE_ID })],
        venue_holds: [ok([listRow({ event_requests: null })])],
        profiles: [ok([{ id: STAFF_ID, full_name: null }])],
      },
    });
    const [hold] = await listActiveVenueHolds(VENUE_ID, { client, now: NOW });
    expect(hold).toMatchObject({ eventName: null, placedByName: null });
  });

  it('treats a profiles read with no data as no names', async () => {
    const client = fakeClient({
      tables: { venues: [ok({ id: VENUE_ID })], venue_holds: [ok([listRow()])], profiles: [ok(null)] },
    });
    const [hold] = await listActiveVenueHolds(VENUE_ID, { client, now: NOW });
    expect(hold.placedByName).toBeNull();
  });

  it('an unknown venue is not found, not an empty list', async () => {
    const client = fakeClient({ tables: { venues: [ok(null)] } });
    const err = await errorFrom(listActiveVenueHolds(VENUE_ID, { client }));
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it('refuses a malformed id before any call', async () => {
    const client = fakeClient();
    const err = await errorFrom(listActiveVenueHolds('x', { client }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(client.calls.from).toEqual([]);
  });

  it.each([
    ['the venue read', { venues: [fail({ code: 'XX000', message: 'v' })] }, 'v'],
    ['the holds read', { venues: [ok({ id: VENUE_ID })], venue_holds: [fail({ code: 'XX000', message: 'h' })] }, 'h'],
    [
      'the names read',
      { venues: [ok({ id: VENUE_ID })], venue_holds: [ok([listRow()])], profiles: [fail({ code: 'XX000', message: 'n' })] },
      'n',
    ],
  ])('passes a failure in %s on', async (_label, tables, message) => {
    const client = fakeClient({ tables });
    const err = await errorFrom(listActiveVenueHolds(VENUE_ID, { client, now: NOW }));
    expect(err.message).toBe(message);
  });
});


describe('listHoldCandidates', () => {
  it('SCRUM491_AC2_lists_approved_events_with_their_coordinator', async () => {
    const client = fakeClient({
      tables: {
        event_requests: [ok([
          {
            id: EVENT_ID, event_name: 'Tech Talk', proposed_start: 'ps', proposed_end: 'pe',
            expected_attendance: 120, assigned_coordinator_id: COORD_ID,
          },
          { id: 'e2', event_name: 'Expo' },
        ])],
        profiles: [ok([{ id: COORD_ID, full_name: 'Casey Coord' }])],
      },
    });

    const events = await listHoldCandidates({ client });

    expect(events).toEqual([
      {
        id: EVENT_ID,
        eventName: 'Tech Talk',
        proposedStart: 'ps',
        proposedEnd: 'pe',
        expectedAttendance: 120,
        assignedCoordinatorId: COORD_ID,
        assignedCoordinatorName: 'Casey Coord',
      },
      {
        id: 'e2',
        eventName: 'Expo',
        proposedStart: null,
        proposedEnd: null,
        expectedAttendance: null,
        assignedCoordinatorId: null,
        assignedCoordinatorName: null,
      },
    ]);
    const read = client.calls.from.find((c) => c.table === 'event_requests').chain;
    expect(read).toContainEqual(['eq', 'status', 'approved']);
  });

  it('answers [] when there are none', async () => {
    const client = fakeClient({ tables: { event_requests: [ok(null)] } });
    expect(await listHoldCandidates({ client })).toEqual([]);
  });

  it('passes a read failure on', async () => {
    const client = fakeClient({ tables: { event_requests: [fail({ code: '22P02', message: 'bad' })] } });
    const err = await errorFrom(listHoldCandidates({ client }));
    expect(err).toBeInstanceOf(ValidationError);
  });
});


describe('the default client', () => {
  it('is imported lazily only when none is passed', async () => {
    const client = fakeClient({ tables: { event_requests: [ok([])] } });
    vi.doMock('../../src/config/supabaseClient.js', () => ({ supabase: client, default: client }));
    try {
      expect(await listHoldCandidates()).toEqual([]);
      expect(client.calls.from.map((c) => c.table)).toEqual(['event_requests']);
    } finally {
      vi.doUnmock('../../src/config/supabaseClient.js');
    }
  });
});
