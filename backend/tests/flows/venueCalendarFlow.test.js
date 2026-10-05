/**
 * SCRUM-183: SCRUM-178 (the venue availability calendar) and SCRUM-17 (venue
 * blocks) end to end, through the HTTP layer. A Venue Staff member blocks a
 * venue, overrides a block over an approved booking and removes it again, and
 * an Event Coordinator reads GET /api/venues/:id/calendar after each step to
 * see what the calendar makes of it. An Event Organiser is refused the
 * calendar but still searches.
 *
 * The harness is venueBlockFlow.test.js's, and so is the honesty note: this
 * proves WIRING AND CONTRACTS. The real venues router, role gates, validators,
 * services and error handler run on every request, and every Supabase call
 * they make is checked against a scripted queue -- the exact RPC or table, in
 * order, with its arguments and filters. It does NOT prove database
 * behaviour: the rows below are what Postgres is specified to return. To keep
 * the scripted rows honest, every calendar step also checks that each row it
 * hands back actually satisfies the filters the service sent
 * (satisfiesFilters), so a response cannot contradict its own query.
 *
 * The tests share one journey and run in order; each `it` scripts only the
 * calls its own requests make, and afterEach asserts the queue is empty, so
 * an unexpected call -- an "unflag" on removal, say -- fails the step that
 * made it.
 *
 * Time-zone safe: every timestamp is written with an explicit +08:00 offset
 * and compared as an instant (toISOString / getTime), never as a local string.
 *
 * Acceptance criteria carried in the test names:
 *   SCRUM178 AC2 -- bookings and blocks both appear on the calendar
 *   SCRUM178 AC5 -- a removed block leaves the calendar
 *   SCRUM178 AC6 -- only internal roles read the calendar
 *   SCRUM17  AC1 -- a block is created with a venue, a period and a reason
 *   SCRUM17  AC2 -- blocked venues leave search and show on the calendar
 *   SCRUM17  AC3 -- an override flags the approved booking for review
 *   SCRUM17  AC4 -- a block can be removed
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
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


// ---------------------------------------------------------------- fixtures

const VENUE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OTHER_VENUE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';
const STAFF_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const COORDINATOR_ID = '11111111-1111-4111-8111-111111111111';
const ORGANISER_ID = '33333333-3333-4333-8333-333333333333';
const BOOKING_1 = 'a1b2c3d4-0000-4000-8000-00000000000b';
const EVENT_1 = '22222222-2222-4222-8222-222222222221';
const BLOCK_A_ID = '6ba7b810-9dad-41d1-80b4-00c04fd430a1';
const BLOCK_M_ID = '6ba7b810-9dad-41d1-80b4-00c04fd430c2';

const USERS = {
  staff: { id: STAFF_ID, role: ROLE.VENUE_STAFF },
  coordinator: { id: COORDINATOR_ID, role: ROLE.EVENT_COORDINATOR },
  organiser: { id: ORGANISER_ID, role: ROLE.EVENT_ORGANISER },
};

/**
 * Next year's 1 March, Singapore time: always in the future, so the real
 * "must end in the future" rule passes without faking the clock.
 */
const Y = new Date().getUTCFullYear() + 1;
const at = (hhmm) => `${Y}-03-01T${hhmm}:00+08:00`;
const utc = (hhmm) => new Date(at(hhmm)).toISOString().replace('.000Z', '+00:00');
const instant = (value) => new Date(value).toISOString();

/** The whole of 1 March, Singapore time. */
const DAY_FROM = at('00:00');
const DAY_TO = `${Y}-03-02T00:00:00+08:00`;

// B1 = [10:00, 12:00), approved. A = [14:00, 15:00) touches nothing.
// M = [09:00, 13:00) overlaps B1, so it needs an override.
const B1_CONFLICT_ROW = {
  booking_id: BOOKING_1, event_request_id: EVENT_1, event_name: 'Tech Talk',
  starts_at: utc('10:00'), ends_at: utc('12:00'),
};

function bookingRow(status) {
  return {
    id: BOOKING_1,
    event_request_id: EVENT_1,
    starts_at: utc('10:00'),
    ends_at: utc('12:00'),
    status,
    event_requests: { event_name: 'Tech Talk' },
  };
}

function blockRow(overrides = {}) {
  return {
    id: BLOCK_A_ID,
    venue_id: VENUE_ID,
    starts_at: utc('14:00'),
    ends_at: utc('15:00'),
    reason: 'maintenance',
    notes: null,
    created_by: STAFF_ID,
    last_modified_by: STAFF_ID,
    created_at: '2026-10-01T00:00:00+00:00',
    updated_at: '2026-10-01T00:00:00+00:00',
    removed_at: null,
    removed_by: null,
    ...overrides,
  };
}

const blockMRow = (overrides = {}) => blockRow({
  id: BLOCK_M_ID, starts_at: utc('09:00'), ends_at: utc('13:00'), ...overrides,
});

const VENUE_ROW = {
  id: VENUE_ID,
  name: 'Seminar Room 2-1',
  location: 'SCIS',
  max_capacity: 40,
  turnaround_minutes: 30,
  retired_at: null,
  created_at: '2026-01-01T00:00:00+00:00',
  updated_at: '2026-01-01T00:00:00+00:00',
  last_modified_by: null,
  venue_room_layouts: [],
  venue_accessibility_features: [],
  venue_facilities: [],
  venue_operating_hours: [],
};


// ------------------------------------------------------ scripted call queue

/** Steps still to be consumed, and assertion failures caught inside the mock. */
const queue = [];
const failures = [];

/** A recording query builder. Its asserts run when the chain is awaited. */
function queryStub(step) {
  const calls = [];
  const stub = {
    calls,
    called: (method) => calls.some(([name]) => name === method),
    args: (method) => calls.find(([name]) => name === method)?.slice(1),
    allArgs: (method) => calls.filter(([name]) => name === method).map((c) => c.slice(1)),
  };
  const settle = () => {
    try {
      step.assert?.(stub);
    } catch (err) {
      failures.push(err);
    }
    return Promise.resolve(step.respond);
  };
  // lte is recorded too, so a regression to an inclusive overlap fails an
  // assertion here instead of throwing a TypeError.
  for (const method of [
    'select', 'eq', 'is', 'ilike', 'gte', 'lte', 'lt', 'gt', 'not', 'in', 'order', 'limit', 'update',
  ]) {
    stub[method] = (...args) => { calls.push([method, ...args]); return stub; };
  }
  stub.maybeSingle = (...args) => { calls.push(['maybeSingle', ...args]); return settle(); };
  stub.then = (onFulfilled, onRejected) => settle().then(onFulfilled, onRejected);
  return stub;
}

/** Take the next step, recording a failure if it is not the call made. */
function next(kind, name) {
  const step = queue.shift();
  if (step === undefined) {
    failures.push(new Error(`unexpected ${kind}('${name}'): the queue is empty`));
    return null;
  }
  if (step.kind !== kind || step.name !== name) {
    failures.push(new Error(`expected ${step.kind}('${step.name}'), got ${kind}('${name}')`));
  }
  return step;
}

rpc.mockImplementation((name, args) => {
  const step = next('rpc', name);
  if (step === null) return Promise.resolve({ data: null, error: { message: 'unscripted' } });
  try {
    step.assert?.(args);
  } catch (err) {
    failures.push(err);
  }
  return Promise.resolve(step.respond);
});

from.mockImplementation((table) => {
  const step = next('from', table);
  return queryStub(step ?? { respond: { data: null, error: { message: 'unscripted' } } });
});

/** Script the calls the next request(s) must make, in order. */
function script(...steps) {
  queue.push(...steps);
}

const rpcStep = (name, respond, assert) => ({ kind: 'rpc', name, respond, assert });
const fromStep = (name, respond, assert) => ({ kind: 'from', name, respond, assert });
const ok = (data) => ({ data, error: null });

/**
 * Would Postgres return this row for the range filters the query recorded?
 * Applies every lt/gt/lte/gte on a timestamp column as an instant comparison.
 */
const RANGE_OPS = {
  lt: (a, b) => a < b,
  gt: (a, b) => a > b,
  lte: (a, b) => a <= b,
  gte: (a, b) => a >= b,
};
function satisfiesFilters(q, row) {
  return q.calls
    .filter(([method]) => method in RANGE_OPS)
    .every(([method, column, value]) => RANGE_OPS[method](Date.parse(row[column]), Date.parse(value)));
}

/** The strict half-open overlap test, exactly: starts_at < to and ends_at > from. */
function expectStrictOverlap(q, windowFrom, windowTo) {
  expect(q.allArgs('lt')).toEqual([['starts_at', windowTo]]);
  expect(q.allArgs('gt')).toEqual([['ends_at', windowFrom]]);
  expect(q.called('lte')).toBe(false);
  expect(q.called('gte')).toBe(false);
}

/**
 * The three reads one GET /:id/calendar makes, in the order it makes them:
 * the venue (so an unknown venue is 404, not an empty calendar), then the
 * bookings and the blocks, both started before either is awaited.
 */
function calendarSteps({ windowFrom, windowTo, bookings, blocks, onBlocksQuery }) {
  return [
    fromStep('venues', ok(VENUE_ROW), (q) => {
      expect(q.allArgs('eq')).toEqual([['id', VENUE_ID]]);
      expect(q.called('maybeSingle')).toBe(true);
    }),
    fromStep('bookings', ok(bookings), (q) => {
      expect(q.allArgs('eq')).toEqual([['venue_id', VENUE_ID]]);
      expect(q.args('in')).toEqual(['status', ['approved', 'flagged_for_review']]);
      expectStrictOverlap(q, windowFrom, windowTo);
      for (const row of bookings) expect(satisfiesFilters(q, row), row.id).toBe(true);
    }),
    fromStep('venue_blocks', ok(blocks), (q) => {
      expect(q.allArgs('eq')).toEqual([['venue_id', VENUE_ID]]);
      expect(q.args('is')).toEqual(['removed_at', null]);
      expectStrictOverlap(q, windowFrom, windowTo);
      for (const row of blocks) expect(satisfiesFilters(q, row), row.id).toBe(true);
      onBlocksQuery?.(q);
    }),
  ];
}

const calendarUrl = (windowFrom, windowTo) =>
  // '+' must be URL-encoded, or it arrives as a space.
  `/api/venues/${VENUE_ID}/calendar?from=${encodeURIComponent(windowFrom)}&to=${encodeURIComponent(windowTo)}`;

const searchUrl = (startsAt, endsAt) =>
  `/api/venues/search?startsAt=${encodeURIComponent(startsAt)}&endsAt=${encodeURIComponent(endsAt)}`;


// ------------------------------------------------------------------ the app

/** Signs in whoever the x-test-as header names; no header is no session. */
function fakeRequireAuth(req, res, next) {
  const user = USERS[req.get('x-test-as')];
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  req.user = { id: user.id, email: `${req.get('x-test-as')}@example.com`, role: user.role };
  return next();
}

const app = express()
  .use(express.json())
  .use('/api/venues', createVenueRouter({ requireAuth: fakeRequireAuth }));

/** A request as one user; any assertion failure inside the mock fails here first. */
async function as(who, build) {
  const res = await build(request(app)).set('x-test-as', who);
  expect(failures).toEqual([]);
  return res;
}

afterEach(() => {
  const leftover = queue.splice(0).map((s) => `${s.kind}('${s.name}')`);
  const caught = failures.splice(0);
  expect(caught).toEqual([]);
  expect(leftover, 'scripted calls never made').toEqual([]);
});

// Threaded through the journey from real responses.
const journey = {};


describe('the test double', () => {
  it('SCRUM178_the_supabase_client_is_mocked_and_never_the_real_one', () => {
    // Without this, a machine with a real .env would run the whole journey
    // against live data and report success.
    expect(vi.isMockFunction(supabase.rpc)).toBe(true);
    expect(vi.isMockFunction(supabase.from)).toBe(true);
  });
});


describe('SCRUM183 calendar and venue blocks journey: block, override, remove', () => {
  describe('SCRUM178_AC2 blocks and bookings both show on the calendar', () => {
    it('SCRUM178_AC2_SCRUM17_AC1_staff_creates_a_maintenance_block_with_201', async () => {
      script(rpcStep(
        'create_venue_block',
        ok({ outcome: 'created', block: blockRow(), affected_bookings: [], flagged_bookings: [] }),
        (args) => {
          expect(args).toEqual({
            p_venue_id: VENUE_ID,
            p_starts_at: at('14:00'),
            p_ends_at: at('15:00'),
            p_reason: 'maintenance',
            p_notes: null,
            p_user_id: STAFF_ID,
            p_confirm_override: false,
            p_acknowledged_booking_ids: [],
          });
        },
      ));

      const res = await as('staff', (r) => r
        .post(`/api/venues/${VENUE_ID}/blocks`)
        .send({ startsAt: at('14:00'), endsAt: at('15:00'), reason: 'maintenance' }));

      expect(res.status).toBe(201);
      expect(res.body.block).toMatchObject({ id: BLOCK_A_ID, venueId: VENUE_ID, reason: 'maintenance' });
      expect(res.body.flaggedBookings).toEqual([]);
      journey.blockA = res.body.block;
    });

    it('SCRUM178_AC2_SCRUM17_AC2_staff_block_shows_as_block_entry_on_calendar', async () => {
      script(...calendarSteps({
        windowFrom: DAY_FROM,
        windowTo: DAY_TO,
        bookings: [bookingRow('approved')],
        blocks: [blockRow()],
      }));

      const res = await as('coordinator', (r) => r.get(calendarUrl(DAY_FROM, DAY_TO)));

      expect(res.status).toBe(200);
      expect(res.body.map((e) => [e.kind, e.id])).toEqual([
        ['booking', BOOKING_1],
        ['block', journey.blockA.id],
      ]);

      const block = res.body[1];
      // Exactly toBlockEntry's fields: no venueId, no audit trail.
      expect(Object.keys(block).sort()).toEqual(['endsAt', 'id', 'kind', 'notes', 'reason', 'startsAt']);
      expect(block).toEqual({
        kind: 'block',
        id: journey.blockA.id,
        startsAt: journey.blockA.startsAt,
        endsAt: journey.blockA.endsAt,
        reason: 'maintenance',
        notes: null,
      });
      expect(instant(block.startsAt)).toBe(instant(at('14:00')));
      expect(instant(block.endsAt)).toBe(instant(at('15:00')));

      expect(res.body[0]).toMatchObject({ kind: 'booking', status: 'approved', eventName: 'Tech Talk' });
    });

    it('SCRUM178_AC2_SCRUM17_AC3_override_block_is_409_then_201_with_flaggedBookings', async () => {
      script(rpcStep(
        'create_venue_block',
        ok({ outcome: 'conflict', conflicts: [B1_CONFLICT_ROW] }),
        (args) => {
          expect(args.p_confirm_override).toBe(false);
          expect(args.p_user_id).toBe(STAFF_ID);
        },
      ));

      const conflict = await as('staff', (r) => r
        .post(`/api/venues/${VENUE_ID}/blocks`)
        .send({ startsAt: at('09:00'), endsAt: at('13:00'), reason: 'maintenance' }));

      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('BLOCK_BOOKING_CONFLICT');
      expect(conflict.body.conflicts.map((c) => c.bookingId)).toEqual([BOOKING_1]);

      script(rpcStep(
        'create_venue_block',
        ok({
          outcome: 'created',
          block: blockMRow(),
          affected_bookings: [B1_CONFLICT_ROW],
          flagged_bookings: [B1_CONFLICT_ROW],
        }),
        (args) => {
          expect(args.p_confirm_override).toBe(true);
          expect(args.p_acknowledged_booking_ids).toEqual([BOOKING_1]);
          expect(args.p_user_id).toBe(STAFF_ID);
        },
      ));

      const res = await as('staff', (r) => r
        .post(`/api/venues/${VENUE_ID}/blocks`)
        .send({
          startsAt: at('09:00'), endsAt: at('13:00'), reason: 'maintenance',
          confirmOverride: true,
          acknowledgedBookingIds: conflict.body.conflicts.map((c) => c.bookingId),
        }));

      expect(res.status).toBe(201);
      expect(res.body.block).toMatchObject({ id: BLOCK_M_ID });
      expect(res.body.flaggedBookings.map((b) => b.bookingId)).toEqual([BOOKING_1]);
      journey.blockM = res.body.block;
    });

    it('SCRUM178_AC2_SCRUM17_AC3_flagged_booking_shows_beside_the_block_soonest_first', async () => {
      script(...calendarSteps({
        windowFrom: DAY_FROM,
        windowTo: DAY_TO,
        bookings: [bookingRow('flagged_for_review')],
        // Postgres orders each list on its own; the merge must interleave them.
        blocks: [blockMRow(), blockRow()],
      }));

      const res = await as('coordinator', (r) => r.get(calendarUrl(DAY_FROM, DAY_TO)));

      expect(res.status).toBe(200);
      expect(res.body.map((e) => [e.kind, e.id])).toEqual([
        ['block', journey.blockM.id],
        ['booking', BOOKING_1],
        ['block', journey.blockA.id],
      ]);
      const starts = res.body.map((e) => new Date(e.startsAt).getTime());
      expect(starts).toEqual([...starts].sort((a, b) => a - b));
      expect(starts.map((t) => new Date(t).toISOString())).toEqual(
        [at('09:00'), at('10:00'), at('14:00')].map(instant),
      );

      expect(res.body[1]).toEqual({
        kind: 'booking',
        id: BOOKING_1,
        startsAt: utc('10:00'),
        endsAt: utc('12:00'),
        status: 'flagged_for_review',
        eventRequestId: EVENT_1,
        eventName: 'Tech Talk',
      });
      expect(res.body[0]).toMatchObject({ kind: 'block', reason: 'maintenance' });
    });
  });

  describe('SCRUM178_AC5 a removed block leaves the calendar', () => {
    it('SCRUM178_AC5_SCRUM17_AC4_staff_removes_the_override_block_with_204', async () => {
      script(rpcStep(
        'remove_venue_block',
        ok({ outcome: 'removed', block: blockMRow({ removed_at: '2026-10-01T00:05:00+00:00', removed_by: STAFF_ID }) }),
        (args) => {
          expect(args).toEqual({ p_venue_id: VENUE_ID, p_block_id: journey.blockM.id, p_user_id: STAFF_ID });
        },
      ));

      const res = await as('staff', (r) => r.delete(`/api/venues/${VENUE_ID}/blocks/${journey.blockM.id}`));

      expect(res.status).toBe(204);
      expect(res.text).toBe('');
    });

    it('SCRUM178_AC5_SCRUM17_AC4_removed_block_is_off_calendar_but_flagged_booking_stays', async () => {
      script(...calendarSteps({
        windowFrom: DAY_FROM,
        windowTo: DAY_TO,
        // Removal never unflags: the booking is still under review.
        bookings: [bookingRow('flagged_for_review')],
        blocks: [blockRow()],
      }));

      const res = await as('coordinator', (r) => r.get(calendarUrl(DAY_FROM, DAY_TO)));

      expect(res.status).toBe(200);
      expect(res.body.map((e) => e.id)).not.toContain(journey.blockM.id);
      expect(res.body.map((e) => [e.kind, e.id])).toEqual([
        ['booking', BOOKING_1],
        ['block', journey.blockA.id],
      ]);
      expect(res.body[0].status).toBe('flagged_for_review');
    });
  });

  describe('SCRUM178_AC2 the calendar and dated search agree on a window edge', () => {
    it('SCRUM178_AC2_SCRUM17_AC2_edge_touching_block_is_off_calendar_and_search_agrees', async () => {
      // A = [14:00, 15:00) only touches [15:00, 16:00) at its edge.
      const windowFrom = at('15:00');
      const windowTo = at('16:00');
      const recorded = {};

      script(...calendarSteps({
        windowFrom,
        windowTo,
        bookings: [],
        blocks: [],
        onBlocksQuery: (q) => {
          expect(satisfiesFilters(q, blockRow())).toBe(false);
          recorded.calendar = { lt: q.allArgs('lt'), gt: q.allArgs('gt') };
        },
      }));

      const calendar = await as('coordinator', (r) => r.get(calendarUrl(windowFrom, windowTo)));

      expect(calendar.status).toBe(200);
      expect(calendar.body).toEqual([]);

      script(
        fromStep('venue_blocks', ok([]), (q) => {
          expect(q.args('select')).toEqual(['venue_id']);
          expect(q.args('is')).toEqual(['removed_at', null]);
          expectStrictOverlap(q, windowFrom, windowTo);
          expect(satisfiesFilters(q, blockRow())).toBe(false);
          recorded.search = { lt: q.allArgs('lt'), gt: q.allArgs('gt') };
        }),
        fromStep(
          'venues',
          ok([
            { id: OTHER_VENUE_ID, name: 'Lecture Hall', location: 'SOE', max_capacity: 200 },
            { id: VENUE_ID, name: 'Seminar Room 2-1', location: 'SCIS', max_capacity: 40 },
          ]),
          (q) => {
            // Nothing blocked, so no venue is excluded.
            expect(q.called('not')).toBe(false);
          },
        ),
      );

      const search = await as('coordinator', (r) => r.get(searchUrl(windowFrom, windowTo)));

      expect(search.status).toBe(200);
      expect(search.body.map((v) => v.id)).toContain(VENUE_ID);

      // The same overlap test, on the same values, in both reads.
      expect(recorded.search).toEqual(recorded.calendar);
    });
  });

  describe('SCRUM178_AC6 only internal roles read the calendar', () => {
    it('SCRUM178_AC6_event_organiser_gets_403_on_calendar_but_can_still_search', async () => {
      // No Supabase call is scripted: the role gate answers before any read.
      const refused = await as('organiser', (r) => r.get(calendarUrl(DAY_FROM, DAY_TO)));

      expect(refused.status).toBe(403);
      expect(refused.body.error).toMatch(/Venue Staff/);
      expect(refused.body.error).toMatch(/Event Coordinators/);

      // The Organiser's dated search still leaves the blocked venue out.
      script(
        fromStep('venue_blocks', ok([{ venue_id: VENUE_ID }]), (q) => {
          expectStrictOverlap(q, at('14:00'), at('15:00'));
          expect(satisfiesFilters(q, blockRow())).toBe(true);
        }),
        fromStep(
          'venues',
          ok([{ id: OTHER_VENUE_ID, name: 'Lecture Hall', location: 'SOE', max_capacity: 200 }]),
          (q) => {
            expect(q.args('is')).toEqual(['retired_at', null]);
            expect(q.args('not')).toEqual(['id', 'in', `(${VENUE_ID})`]);
          },
        ),
      );

      const search = await as('organiser', (r) => r.get(searchUrl(at('14:00'), at('15:00'))));

      expect(search.status).toBe(200);
      expect(search.body.map((v) => v.id)).toEqual([OTHER_VENUE_ID]);
    });
  });
});
