/**
 * SCRUM-183: SCRUM-178 (the venue availability calendar) and SCRUM-17 (venue
 * blocks) end to end, through the HTTP layer. A Venue Staff member blocks a
 * venue, overrides a block over an approved booking and removes it again, and
 * an Event Coordinator reads GET /api/venues/:id/calendar after each step to
 * see what the calendar makes of it. An Event Organiser is refused the
 * calendar but still searches, and an Attendee is refused it too.
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
 * SCRUM-484: the calendar's bookings read is now
 * rpc('venue_occupancy_conflicts', {..., p_pad_requested: false}) (032), and a
 * dated search asks rpc('available_venue_ids') (033) after reading the venues,
 * instead of a raw venue_blocks read before it. The scripted answers stand in
 * for those functions; the real rule (padding, statuses, touching is clear)
 * is Postgres's and is tested against PGlite in tests/db/. The honesty checks
 * below apply the plain half-open overlap to what this fake returns, so a
 * scripted answer still cannot contradict the window it was asked about.
 *
 * Time-zone safe: every timestamp is written with an explicit +08:00 offset
 * and compared as an instant (toISOString / getTime), never as a local string.
 *
 * Acceptance criteria carried in the test names:
 *   SCRUM178 AC2 -- bookings and blocks both appear on the calendar
 *   SCRUM178 AC5 -- a removed block leaves the calendar
 *   SCRUM178 AC6 -- only internal roles read the calendar
 *
 * Steps that only set the journey up -- creating, overriding and removing a
 * block -- check SCRUM-17 behaviour, not the calendar, so they carry only
 * their SCRUM17 tag.
 *   SCRUM17  AC1 -- a block is created with a venue, a period and a reason
 *   SCRUM17  AC2 -- blocked venues leave search and show on the calendar
 *   SCRUM17  AC3 -- an override flags the approved booking for review
 *   SCRUM17  AC4 -- a block can be removed
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ok, scriptedQueryStub } from '../fixtures/supabaseStubs.js';
import { actingAs, headerAuth } from '../fixtures/auth.js';

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
const ATTENDEE_ID = '44444444-4444-4444-8444-444444444444';
const BOOKING_1 = 'a1b2c3d4-0000-4000-8000-00000000000b';
const EVENT_1 = '22222222-2222-4222-8222-222222222221';
const BLOCK_A_ID = '6ba7b810-9dad-41d1-80b4-00c04fd430a1';
const BLOCK_M_ID = '6ba7b810-9dad-41d1-80b4-00c04fd430c2';

const USERS = {
  staff: { id: STAFF_ID, role: ROLE.VENUE_STAFF },
  coordinator: { id: COORDINATOR_ID, role: ROLE.EVENT_COORDINATOR },
  organiser: { id: ORGANISER_ID, role: ROLE.EVENT_ORGANISER },
  attendee: { id: ATTENDEE_ID, role: ROLE.ATTENDEE },
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

/**
 * B1 as venue_occupancy_conflicts() (032) returns it: flat, with its occupied
 * period. The venue has no setup and 30 minutes of turnaround (VENUE_ROW), so
 * B1 occupies [10:00, 12:30).
 */
function bookingRow(status) {
  return {
    kind: 'booking',
    id: BOOKING_1,
    status,
    event_request_id: EVENT_1,
    event_name: 'Tech Talk',
    reason: null,
    starts_at: utc('10:00'),
    ends_at: utc('12:00'),
    occupied_starts_at: utc('10:00'),
    occupied_ends_at: utc('12:30'),
    setup_minutes: 0,
    turnaround_minutes: 30,
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
  return scriptedQueryStub(step ?? { respond: { data: null, error: { message: 'unscripted' } } }, failures);
});

/** Script the calls the next request(s) must make, in order. */
function script(...steps) {
  queue.push(...steps);
}

const rpcStep = (name, respond, assert) => ({ kind: 'rpc', name, respond, assert });
const fromStep = (name, respond, assert) => ({ kind: 'from', name, respond, assert });

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
 * Would a strict half-open overlap of the row's OCCUPIED period with the
 * window hold? What venue_occupancy_conflicts(..., false) is specified to
 * return; the fake's rows are checked against it, not decided by it.
 */
function occupiesWindow(row, windowFrom, windowTo) {
  return Date.parse(row.occupied_starts_at) < Date.parse(windowTo)
    && Date.parse(row.occupied_ends_at) > Date.parse(windowFrom);
}

/**
 * The three reads one GET /:id/calendar makes, in the order it makes them:
 * the venue (so an unknown venue is 404, not an empty calendar), then the
 * bookings and the blocks, both started before either is awaited.
 * SCRUM-484: the bookings read is the shared occupancy rpc, window unpadded.
 */
function calendarSteps({ windowFrom, windowTo, bookings, blocks, onBlocksQuery }) {
  return [
    fromStep('venues', ok(VENUE_ROW), (q) => {
      expect(q.allArgs('eq')).toEqual([['id', VENUE_ID]]);
      expect(q.called('maybeSingle')).toBe(true);
    }),
    rpcStep('venue_occupancy_conflicts', ok(bookings), (args) => {
      expect(args).toEqual({
        p_venue_id: VENUE_ID,
        p_starts_at: windowFrom,
        p_ends_at: windowTo,
        p_pad_requested: false,
      });
      for (const row of bookings) expect(occupiesWindow(row, windowFrom, windowTo), row.id).toBe(true);
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
const fakeRequireAuth = headerAuth(USERS);

const app = express()
  .use(express.json())
  .use('/api/venues', createVenueRouter({ requireAuth: fakeRequireAuth }));

/** A request as one user; any assertion failure inside the mock fails here first. */
const as = actingAs(app, failures);

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


describe('SCRUM178_AC2_AC5_AC6 calendar journey through venue blocks: block, override, remove', () => {
  describe('SCRUM178_AC2 blocks and bookings both show on the calendar', () => {
    it('SCRUM17_AC1_staff_creates_a_maintenance_block_with_201', async () => {
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

    it('SCRUM17_AC3_override_block_is_409_then_201_with_flaggedBookings', async () => {
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
        // SCRUM-484 (AC7): the occupied period, as the database computed it.
        occupiedStartsAt: utc('10:00'),
        occupiedEndsAt: utc('12:30'),
        setupMinutes: 0,
        turnaroundMinutes: 30,
      });
      expect(res.body[0]).toMatchObject({ kind: 'block', reason: 'maintenance' });
    });
  });

  describe('SCRUM178_AC5 a removed block leaves the calendar', () => {
    it('SCRUM17_AC4_staff_removes_the_override_block_with_204', async () => {
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

      // SCRUM-484: the dated search reads the venues, then asks
      // available_venue_ids() (033) about them. The scripted answer frees both:
      // A only touches the window, and touching is clear in the shared rule
      // (PGlite: SCRUM20_AC5_block_touching_the_padded_end_is_free and
      // SCRUM484_AC5_request_setup_touching_block_end_is_clear). This venue
      // has no setup, so the request's own padding moves only its end, away
      // from A.
      script(
        fromStep(
          'venues',
          ok([
            { id: OTHER_VENUE_ID, name: 'Lecture Hall', location: 'SOE', max_capacity: 200 },
            { id: VENUE_ID, name: 'Seminar Room 2-1', location: 'SCIS', max_capacity: 40 },
          ]),
          (q) => {
            // Availability is not a PostgREST filter any more.
            expect(q.called('not')).toBe(false);
          },
        ),
        rpcStep(
          'available_venue_ids',
          ok([{ venue_id: OTHER_VENUE_ID }, { venue_id: VENUE_ID }]),
          (args) => {
            expect(args).toEqual({
              p_venue_ids: [OTHER_VENUE_ID, VENUE_ID],
              p_starts_at: windowFrom,
              p_ends_at: windowTo,
            });
            recorded.search = { from: args.p_starts_at, to: args.p_ends_at };
          },
        ),
      );

      const search = await as('coordinator', (r) => r.get(searchUrl(windowFrom, windowTo)));

      expect(search.status).toBe(200);
      expect(search.body.map((v) => v.id)).toContain(VENUE_ID);

      // The same window, on the same values, reaches both reads.
      expect(recorded.calendar).toEqual({ lt: [['starts_at', windowTo]], gt: [['ends_at', windowFrom]] });
      expect(recorded.search).toEqual({ from: windowFrom, to: windowTo });
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
      // SCRUM-484: through available_venue_ids() (033). Block A [14:00,
      // 15:00) overlaps the period, so the scripted answer leaves VENUE_ID out.
      script(
        fromStep(
          'venues',
          ok([
            { id: OTHER_VENUE_ID, name: 'Lecture Hall', location: 'SOE', max_capacity: 200 },
            { id: VENUE_ID, name: 'Seminar Room 2-1', location: 'SCIS', max_capacity: 40 },
          ]),
          (q) => {
            expect(q.args('is')).toEqual(['retired_at', null]);
            expect(q.called('not')).toBe(false);
          },
        ),
        rpcStep('available_venue_ids', ok([{ venue_id: OTHER_VENUE_ID }]), (args) => {
          expect(args).toEqual({
            p_venue_ids: [OTHER_VENUE_ID, VENUE_ID],
            p_starts_at: at('14:00'),
            p_ends_at: at('15:00'),
          });
          // The fake's answer agrees with the overlap: A meets [14:00, 15:00).
          const a = blockRow();
          expect(Date.parse(a.starts_at) < Date.parse(args.p_ends_at)
            && Date.parse(a.ends_at) > Date.parse(args.p_starts_at)).toBe(true);
        }),
      );

      const search = await as('organiser', (r) => r.get(searchUrl(at('14:00'), at('15:00'))));

      expect(search.status).toBe(200);
      expect(search.body.map((v) => v.id)).toEqual([OTHER_VENUE_ID]);
    });

    it('SCRUM178_AC6_attendee_gets_403_on_calendar_with_no_supabase_call', async () => {
      // Nothing is scripted, so any read the gate let through would fail as
      // an unscripted call; the counts below say the same thing directly.
      rpc.mockClear();
      from.mockClear();

      const refused = await as('attendee', (r) => r.get(calendarUrl(DAY_FROM, DAY_TO)));

      expect(refused.status).toBe(403);
      expect(refused.body.error).toMatch(/Venue Staff/);
      expect(refused.body.error).toMatch(/Event Coordinators/);
      expect(Array.isArray(refused.body)).toBe(false);
      expect(from).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    });
  });
});
