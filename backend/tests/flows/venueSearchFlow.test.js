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
 * a scripted queue -- the exact table, in order, with its filters. It does
 * NOT prove database behaviour: the rows below are what Postgres is specified
 * to return, and each bookings/blocks row is checked against the range
 * filters the service sent (satisfiesFilters), so a response cannot
 * contradict its own query.
 *
 * Cases: B-E2E-01 (one search over several criteria returns exactly the
 * venues meeting all of them) and B-E2E-02 (the same search with no match is
 * 200 []).
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
const utc = (hhmm) => new Date(at(hhmm)).toISOString().replace('.000Z', '+00:00');

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

const BOOKING_ROWS = [
  { venue_id: CONCOURSE, starts_at: utc('11:00'), ends_at: utc('13:00') },
  { venue_id: HARBOUR, starts_at: utc('15:00'), ends_at: utc('16:00') },
];

const BLOCK_ROWS = [
  { venue_id: BOARDROOM, starts_at: utc('11:00'), ends_at: utc('11:30') },
];

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

rpc.mockImplementation((name) => {
  failures.push(new Error(`unexpected rpc('${name}'): a search writes nothing`));
  return Promise.resolve({ data: null, error: { message: 'unscripted' } });
});

from.mockImplementation((table) => {
  const step = queue.shift();
  if (step === undefined) {
    failures.push(new Error(`unexpected from('${table}'): the queue is empty`));
  } else if (step.name !== table) {
    failures.push(new Error(`expected from('${step.name}'), got from('${table}')`));
  }
  return queryStub(step ?? { respond: { data: null, error: { message: 'unscripted' } } });
});

const fromStep = (name, respond, assert) => ({ name, respond, assert });
const ok = (data) => ({ data, error: null });

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

/** The bookings and blocks reads, for the venues still in the running. */
function occupancySteps(venueIds, bookings, blocks) {
  return [
    fromStep('bookings', ok(bookings), (q) => {
      expect(q.allArgs('in')).toEqual([
        ['venue_id', venueIds],
        ['status', ['approved', 'flagged_for_review']],
      ]);
      for (const row of bookings) expect(satisfiesFilters(q, row), row.starts_at).toBe(true);
    }),
    fromStep('venue_blocks', ok(blocks), (q) => {
      expect(q.args('in')).toEqual(['venue_id', venueIds]);
      expect(q.args('is')).toEqual(['removed_at', null]);
      for (const row of blocks) expect(satisfiesFilters(q, row), row.starts_at).toBe(true);
    }),
  ];
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
  const leftover = queue.splice(0).map((s) => `from('${s.name}')`);
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
      occupancySteps(ATTRIBUTE_MATCHES, BOOKING_ROWS, BLOCK_ROWS),
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
    // bookings and blocks are never read.
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
