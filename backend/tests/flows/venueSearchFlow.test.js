/**
 * SCRUM-140 (for SCRUM-20): the event search end to end, through the HTTP
 * layer. An Event Coordinator calls GET /api/venues/event-search with an
 * event's requirements and gets back exactly the venues that meet every one
 * of them and are free.
 *
 * The harness is venueCalendarFlow.test.js's, and so is the honesty note:
 * this proves WIRING AND CONTRACTS. The real venues router, role gate, query
 * parsing, validator, service, matching and occupancy rules and error handler
 * run on every request, and every Supabase call they make is checked against
 * a scripted queue -- the exact table or rpc, in order, with its filters or
 * arguments. It does NOT prove database behaviour: the answers below are what
 * Postgres is specified to return.
 *
 * SCRUM-484 (AC4): availability is no longer two reads (bookings,
 * venue_blocks) and a JavaScript rule. It is one rpc, available_venue_ids()
 * (033), which calls the shared venue_occupancy_conflicts() (032). The queue
 * therefore scripts that rpc's answer -- which venues are free -- and checks
 * the ids and period the service asked about. Whether a touching booking or
 * block leaves a venue free is decided by Postgres, and is proved against a
 * real one in tests/db/venueSearchOccupancyDatabase.test.js under the same
 * SCRUM20_AC5_/SCRUM20_AC6_ names.
 *
 * Cases: B-E2E-01 (one search over several criteria returns exactly the
 * venues meeting all of them), B-E2E-02 (the same search with no match is
 * 200 []), B-E2E-03 (SCRUM-144: a booking or block touching the padded period
 * leaves the venue in, one minute over takes it out) and B-AC6-07 (SCRUM-144:
 * the venues read filters out retired venues).
 *
 * Time-zone safe: every timestamp carries an explicit +08:00 offset and is
 * compared as an instant.
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

const COORDINATOR_ID = '11111111-1111-4111-8111-111111111111';

const ATRIUM = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const BOARDROOM = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';
const CONCOURSE = '3f2504e0-4f89-41d3-9a0c-0305e82c3303';
const HARBOUR = '3f2504e0-4f89-41d3-9a0c-0305e82c3304';
const LAKESIDE = '3f2504e0-4f89-41d3-9a0c-0305e82c3305';

/** Wednesday 11 November 2026, Singapore time. */
const at = (hhmm) => `2026-11-11T${hhmm}:00+08:00`;

const WEDNESDAY = 3;

/**
 * A venue row as VENUE_WITH_ATTRIBUTES_SELECT returns it. By default it meets
 * every criterion of the base request: theatre, step-free entrance, projector
 * and wifi, 120 seats, open 08:00-22:00 on Wednesdays.
 */
function venueRow(id, name, overrides = {}) {
  return {
    id,
    name,
    location: `${name}, SCIS`,
    max_capacity: 120,
    turnaround_minutes: 30,
    setup_minutes: 15,
    retired_at: null,
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: '2026-01-01T00:00:00+00:00',
    last_modified_by: null,
    venue_room_layouts: [{ room_layout_code: 'theatre' }, { room_layout_code: 'classroom' }],
    venue_accessibility_features: [{ accessibility_feature_code: 'step_free_entrance' }],
    venue_facilities: [{ facility_code: 'wifi' }, { facility_code: 'projector' }],
    venue_operating_hours: [
      { day_of_week: 1, opens_at: '08:00:00', closes_at: '22:00:00' },
      { day_of_week: WEDNESDAY, opens_at: '08:00:00', closes_at: '22:00:00' },
    ],
    ...overrides,
  };
}

/** Ordered by name, as .order('name') makes Postgres return them. */
const VENUE_ROWS = [
  venueRow(ATRIUM, 'Atrium Hall'),
  // Free on attributes, but a block sits inside the event.
  venueRow(BOARDROOM, 'Boardroom 3'),
  // Free on attributes, but an approved booking overlaps the event.
  venueRow(CONCOURSE, 'Concourse Room'),
  // Has a booking, but well clear of the event even with setup and turnaround.
  venueRow(HARBOUR, 'Harbour Room', { max_capacity: 90 }),
  // Meets everything except one facility: no wifi.
  venueRow(LAKESIDE, 'Lakeside Studio', {
    venue_facilities: [{ facility_code: 'projector' }],
  }),
];

/** Venues still in the running after the attribute check. */
const ATTRIBUTE_MATCHES = [ATRIUM, BOARDROOM, CONCOURSE, HARBOUR];

/**
 * What available_venue_ids answers for ATTRIBUTE_MATCHES: Boardroom 3 (a block
 * 11:00-11:30 inside the event) and Concourse Room (an approved booking
 * 11:00-13:00) are occupied; Atrium Hall and Harbour Room (a booking
 * 15:00-16:00, clear even with setup and turnaround) are free.
 */
const FREE_MATCHES = [ATRIUM, HARBOUR];

/** The base request: every criterion supplied. */
const BASE = {
  startsAt: at('10:00'),
  endsAt: at('12:00'),
  expectedAttendance: '80',
  layout: 'theatre',
  accessibility: 'step_free_entrance',
  facilities: 'projector,wifi',
};

/** Builds the URL with every value encoded, so '+' arrives as '+'. */
function searchUrl(params) {
  const query = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return `/api/venues/event-search?${query}`;
}

const AC7_FIELDS = [
  'id', 'name', 'location', 'maxCapacity', 'layouts', 'accessibility', 'facilities',
  'hours', 'setupMinutes', 'turnaroundMinutes',
];


// ------------------------------------------------------ scripted call queue

const queue = [];
const failures = [];

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
  for (const method of [
    'select', 'eq', 'is', 'ilike', 'gte', 'lte', 'lt', 'gt', 'not', 'in', 'order', 'limit',
  ]) {
    stub[method] = (...args) => { calls.push([method, ...args]); return stub; };
  }
  stub.maybeSingle = (...args) => { calls.push(['maybeSingle', ...args]); return settle(); };
  stub.then = (onFulfilled, onRejected) => settle().then(onFulfilled, onRejected);
  return stub;
}

const describeStep = (s) => (s.kind === 'rpc' ? `rpc('${s.name}')` : `from('${s.name}')`);

// SCRUM-484: rpc calls are scripted in the same queue as from() calls, so
// their order is checked too. A search still writes nothing; the only rpc it
// may make is the scripted available_venue_ids read.
rpc.mockImplementation((name, args) => {
  const step = queue.shift();
  if (step === undefined) {
    failures.push(new Error(`unexpected rpc('${name}'): the queue is empty`));
  } else if (step.kind !== 'rpc' || step.name !== name) {
    failures.push(new Error(`expected ${describeStep(step)}, got rpc('${name}')`));
  } else {
    try {
      step.assert?.(args);
    } catch (err) {
      failures.push(err);
    }
  }
  return Promise.resolve(step?.respond ?? { data: null, error: { message: 'unscripted' } });
});

from.mockImplementation((table) => {
  const step = queue.shift();
  if (step === undefined) {
    failures.push(new Error(`unexpected from('${table}'): the queue is empty`));
  } else if (step.kind !== 'from' || step.name !== table) {
    failures.push(new Error(`expected ${describeStep(step)}, got from('${table}')`));
  }
  return queryStub(step ?? { respond: { data: null, error: { message: 'unscripted' } } });
});

const fromStep = (name, respond, assert) => ({ kind: 'from', name, respond, assert });
const rpcStep = (name, respond, assert) => ({ kind: 'rpc', name, respond, assert });
const ok = (data) => ({ data, error: null });

/** A lookup-table read answering that every requested code exists. */
function lookupStep(table, codes) {
  return fromStep(table, ok(codes.map((code) => ({ code }))), (q) => {
    expect(q.args('in')).toEqual(['code', codes]);
  });
}

/** The venues read: active only, ordered by name, with every join. */
function venuesStep(rows) {
  return fromStep('venues', ok(rows), (q) => {
    expect(q.args('is')).toEqual(['retired_at', null]);
    expect(q.args('order')).toEqual(['name']);
    const select = q.args('select')[0];
    for (const join of [
      'venue_room_layouts', 'venue_accessibility_features', 'venue_facilities', 'venue_operating_hours',
    ]) {
      expect(select).toContain(join);
    }
  });
}

/**
 * SCRUM-484: the one availability call, for the venues still in the running.
 * Asserts the ids and the event's own period (unpadded: the database pads)
 * reach it, and answers `freeIds` as PostgREST returns a table result.
 */
function availabilityStep(venueIds, freeIds, period = { startsAt: BASE.startsAt, endsAt: BASE.endsAt }) {
  return rpcStep('available_venue_ids', ok(freeIds.map((id) => ({ venue_id: id }))), (args) => {
    expect(args).toEqual({
      p_venue_ids: venueIds,
      p_starts_at: period.startsAt,
      p_ends_at: period.endsAt,
    });
  });
}

function script(...steps) {
  queue.push(...steps.flat());
}


// ------------------------------------------------------------------ the app

function fakeRequireAuth(req, res, next) {
  if (req.get('x-test-as') !== 'coordinator') {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.user = { id: COORDINATOR_ID, email: 'coordinator@example.com', role: ROLE.EVENT_COORDINATOR };
  return next();
}

const app = express()
  .use(express.json())
  .use('/api/venues', createVenueRouter({ requireAuth: fakeRequireAuth }));

async function asCoordinator(url) {
  const res = await request(app).get(url).set('x-test-as', 'coordinator');
  expect(failures).toEqual([]);
  return res;
}

afterEach(() => {
  const leftover = queue.splice(0).map(describeStep);
  const caught = failures.splice(0);
  expect(caught).toEqual([]);
  expect(leftover, 'scripted calls never made').toEqual([]);
});


describe('the test double', () => {
  it('SCRUM20_the_supabase_client_is_mocked_and_never_the_real_one', () => {
    expect(vi.isMockFunction(supabase.rpc)).toBe(true);
    expect(vi.isMockFunction(supabase.from)).toBe(true);
  });
});


describe('SCRUM20 event search through the HTTP layer', () => {
  it('SCRUM20_E2E_AC3_AC6_AC7_search_returns_only_the_venues_meeting_every_criterion', async () => {
    // B-E2E-01.
    script(
      lookupStep('room_layouts', ['theatre']),
      lookupStep('accessibility_features', ['step_free_entrance']),
      lookupStep('facilities', ['projector', 'wifi']),
      venuesStep(VENUE_ROWS),
      availabilityStep(ATTRIBUTE_MATCHES, FREE_MATCHES),
    );

    const res = await asCoordinator(searchUrl(BASE));

    expect(res.status).toBe(200);
    expect(res.body.map((v) => v.name)).toEqual(['Atrium Hall', 'Harbour Room']);

    // AC7: each result carries what the results list shows, and nothing else.
    for (const venue of res.body) {
      expect(Object.keys(venue).sort()).toEqual([...AC7_FIELDS].sort());
    }
    expect(res.body[1]).toEqual({
      id: HARBOUR,
      name: 'Harbour Room',
      location: 'Harbour Room, SCIS',
      maxCapacity: 90,
      layouts: ['classroom', 'theatre'],
      accessibility: ['step_free_entrance'],
      facilities: ['projector', 'wifi'],
      hours: [
        { day_of_week: 1, opens_at: '08:00:00', closes_at: '22:00:00' },
        { day_of_week: WEDNESDAY, opens_at: '08:00:00', closes_at: '22:00:00' },
      ],
      setupMinutes: 15,
      turnaroundMinutes: 30,
    });
  });

  it('SCRUM20_E2E_AC4_AC8_search_with_no_match_returns_empty', async () => {
    // B-E2E-02: no venue seats 150, so nothing passes the attribute check and
    // availability is never asked.
    script(
      lookupStep('room_layouts', ['theatre']),
      lookupStep('accessibility_features', ['step_free_entrance']),
      lookupStep('facilities', ['projector', 'wifi']),
      venuesStep(VENUE_ROWS),
    );

    const res = await asCoordinator(searchUrl({ ...BASE, expectedAttendance: '150' }));

    expect(res.status).toBe(200);
    expect(res.text).toBe('[]');
  });

  it('SCRUM20_E2E_AC4_SCRUM141_location_narrows_the_search_case_insensitively', async () => {
    // Only Harbour Room's location ("Harbour Room, SCIS") contains "HARBOUR".
    // The match is made in matchesAllCriteria, not by an ilike on the venues
    // read, so only Harbour Room's availability is asked afterwards.
    script(
      lookupStep('room_layouts', ['theatre']),
      lookupStep('accessibility_features', ['step_free_entrance']),
      lookupStep('facilities', ['projector', 'wifi']),
      fromStep('venues', ok(VENUE_ROWS), (q) => {
        expect(q.called('ilike')).toBe(false);
      }),
      availabilityStep([HARBOUR], [HARBOUR]),
    );

    const res = await asCoordinator(searchUrl({ ...BASE, location: '  HARBOUR ' }));

    expect(res.status).toBe(200);
    expect(res.body.map((v) => v.name)).toEqual(['Harbour Room']);
  });

  it('SCRUM20_E2E_AC1_an_unencoded_plus_in_an_offset_is_400_before_any_query', async () => {
    // No steps scripted: the request must be refused before Supabase is asked.
    const url = `/api/venues/event-search?startsAt=${at('10:00')}&endsAt=${at('12:00')}` +
      '&expectedAttendance=80';

    const res = await asCoordinator(url);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^Invalid venue search -- /);
    expect(res.body.details.map((d) => d.field)).toEqual(
      expect.arrayContaining(['startsAt', 'endsAt']),
    );
  });
});


/**
 * SCRUM-144: AC5's touching edges and AC6's retired rule, end to end.
 *
 * Every venue here has setup 15 and turnaround 30, and the request is
 * 10:00-12:00, so it occupies [09:45, 12:30) at each venue. Before SCRUM-484
 * the flow fed booking and block rows to the JavaScript rule; since then the
 * rule is Postgres's (available_venue_ids, 033), so the flow scripts the
 * answer that rule gives for the rows described in each test and checks the
 * service asks about the right venues and period, and keeps exactly the ones
 * answered free. The arithmetic of each edge -- a booking padded to touch at
 * 09:45 or 12:30 is clear, one minute further in is not; a block is compared
 * raw -- is proved against real Postgres in
 * tests/db/venueSearchOccupancyDatabase.test.js.
 */
describe('SCRUM20 availability edges and retired venues through the HTTP layer', () => {
  /** Just the period and attendance: no codes, so no lookup reads. */
  const PERIOD_ONLY = { startsAt: BASE.startsAt, endsAt: BASE.endsAt, expectedAttendance: '80' };

  // Named so .order('name') returns them in this order.
  const TOUCHING = venueRow(ATRIUM, 'Atrium Hall');
  const OVER_AT_START = venueRow(BOARDROOM, 'Boardroom 3');
  const OVER_AT_END = venueRow(CONCOURSE, 'Concourse Room');
  const ROWS = [TOUCHING, OVER_AT_START, OVER_AT_END];
  const IDS = [ATRIUM, BOARDROOM, CONCOURSE];

  it('SCRUM20_AC5_touching_booking_venue_appears_in_the_flow', async () => {
    // B-E2E-03, bookings. In the database: Atrium Hall has bookings
    // 08:00-09:15 and 12:45-14:00 (padded 07:45-09:45 and 12:30-14:30, both
    // touching [09:45, 12:30)); Boardroom 3 one ending 09:16 (padded to
    // 09:46); Concourse Room one starting 12:44 (padded from 12:29). Only
    // Atrium Hall is answered free.
    script(
      venuesStep(ROWS),
      availabilityStep(IDS, [ATRIUM]),
    );

    const res = await asCoordinator(searchUrl(PERIOD_ONLY));

    expect(res.status).toBe(200);
    expect(res.body.map((v) => v.name)).toEqual(['Atrium Hall']);
  });

  it('SCRUM20_AC5_touching_block_venue_appears_in_the_flow', async () => {
    // B-E2E-03, blocks, compared raw. In the database: Atrium Hall has
    // blocks 08:00-09:45 and 12:30-14:00 (touching the padded request);
    // Boardroom 3 one ending 09:46; Concourse Room one starting 12:29. Only
    // Atrium Hall is answered free.
    script(
      venuesStep(ROWS),
      availabilityStep(IDS, [ATRIUM]),
    );

    const res = await asCoordinator(searchUrl(PERIOD_ONLY));

    expect(res.status).toBe(200);
    expect(res.body.map((v) => v.name)).toEqual(['Atrium Hall']);
  });

  it('SCRUM20_AC6_retired_venue_is_never_returned', async () => {
    // B-AC6-07. The venues read is the only place a retired venue could get
    // in, so it must filter retired_at is null and nothing else -- no
    // includeRetired switch, no second read without the filter.
    script(
      fromStep('venues', ok([TOUCHING]), (q) => {
        expect(q.allArgs('is')).toEqual([['retired_at', null]]);
      }),
      availabilityStep([ATRIUM], [ATRIUM]),
    );

    const res = await asCoordinator(searchUrl(PERIOD_ONLY));

    expect(res.status).toBe(200);
    expect(res.body.map((v) => v.name)).toEqual(['Atrium Hall']);
  });
});
