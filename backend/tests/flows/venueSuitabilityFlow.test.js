/**
 * SCRUM-188 end to end, through the HTTP layer: a coordinator checks an
 * undersized venue, requests it anyway by naming the unmet criterion, Venue
 * Staff see the override on the venue's bookings while a coordinator does
 * not, and the event's recheck reports what has changed since -- attendance
 * raised again, then a new block over the event.
 *
 * SCRUM-193/194. The harness is venueBlockFlow.test.js's, and so is what it
 * proves: WIRING AND CONTRACTS across the subtasks (SCRUM-190's check,
 * SCRUM-252's request, SCRUM-524's Venue Staff read, SCRUM-192's recheck). The
 * real routers, role gates, validators, services and error handler run on
 * every request; every Supabase call they make is checked against a scripted
 * queue, in order, with its arguments; and what one step returns is threaded
 * into the next -- the result the check computed is what the request stores,
 * and what the bookings list and the recheck then read. What the RPCs answer
 * is scripted, not Postgres: tests/db/venueSuitabilityDatabase.test.js and
 * bookingRequestOccupancyDatabase.test.js prove that half.
 *
 * The tests share one journey and run in order; afterEach asserts the queue
 * is empty, so an unexpected or missing call fails the step that caused it.
 *
 * Venue "Seminar Room", capacity 80, 30 min setup and 45 turnaround, open
 * 08:00-22:00; event "Orientation Week", 150 expected, 10:00-12:00 on next
 * year's 1 March (Singapore) -- in the future, so the block in step 5 passes
 * the real "must end in the future" rule without faking the clock.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import { ok, scriptedQueryStub } from '../fixtures/supabaseStubs.js';
import { actingAs, headerAuth } from '../fixtures/auth.js';

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));

vi.mock('../../src/config/supabaseClient.js', () => {
  const client = { rpc, from };
  return { supabase: client, default: client };
});

const { createVenueSuitabilityRouter } = await import('../../src/routes/venueSuitability.js');
const { createBookingRequestRouter } = await import('../../src/routes/bookingRequests.js');
const { createVenueRouter } = await import('../../src/routes/venues.js');
const { createEventRequestRouter } = await import('../../src/routes/eventRequests.js');
const { supabase } = await import('../../src/config/supabaseClient.js');
const { ROLE } = await import('../../src/domain/userRole.js');


// ---------------------------------------------------------------- fixtures

const VENUE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const EVENT_ID = '22222222-2222-4222-8222-222222222221';
const BOOKING_ID = 'a1b2c3d4-0000-4000-8000-00000000000b';
const BLOCK_ID = '6ba7b810-9dad-41d1-80b4-00c04fd430c1';
const CHANGE_REQUEST_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const STAFF_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const COORDINATOR_ID = '11111111-1111-4111-8111-111111111111';
const ORGANISER_ID = '55555555-5555-4555-8555-555555555555';

const USERS = {
  staff: { id: STAFF_ID, role: ROLE.VENUE_STAFF },
  coordinator: { id: COORDINATOR_ID, role: ROLE.EVENT_COORDINATOR },
};

const Y = new Date().getUTCFullYear() + 1;
const at = (hhmm) => `${Y}-03-01T${hhmm}:00+08:00`;
/** Next year's 1 March as the server's detail text names it, e.g. 'Mon 1 Mar'. */
const DAY = `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(Y, 2, 1)).getUTCDay()]} 1 Mar`;

function eventRow(overrides = {}) {
  return {
    id: EVENT_ID,
    organiser_id: ORGANISER_ID,
    event_name: 'Orientation Week',
    proposed_start: at('10:00'),
    proposed_end: at('12:00'),
    expected_attendance: 150,
    status: 'approved',
    assigned_coordinator_id: COORDINATOR_ID,
    ...overrides,
  };
}

function venueRow() {
  return {
    id: VENUE_ID,
    name: 'Seminar Room',
    location: 'Level 2',
    max_capacity: 80,
    setup_minutes: 30,
    turnaround_minutes: 45,
    emergency_access: null,
    known_restrictions: null,
    retired_at: null,
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: '2026-01-01T00:00:00+00:00',
    last_modified_by: null,
    venue_room_layouts: [{ room_layout_code: 'theatre' }],
    venue_accessibility_features: [],
    venue_facilities: [{ facility_code: 'projector' }],
    venue_operating_hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
      day_of_week: day,
      opens_at: '08:00:00',
      closes_at: '22:00:00',
    })),
  };
}


// ------------------------------------------------------ scripted call queue

const queue = [];
const failures = [];

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

const script = (...steps) => queue.push(...steps);
const rpcStep = (name, respond, assert) => ({ kind: 'rpc', name, respond, assert });
const fromStep = (name, respond, assert) => ({ kind: 'from', name, respond, assert });

/** The codes the coordinator chose, looked up as the check does. */
const codeLookups = () => [
  fromStep('room_layouts', ok([{ code: 'theatre' }])),
  fromStep('facilities', ok([{ code: 'projector' }])),
];

/** One judgeVenue: the code lookups, the venue, then the occupancy function. */
const judgeSteps = (occupancy = [], assertOccupancy) => [
  ...codeLookups(),
  fromStep('venues', ok(venueRow())),
  rpcStep('venue_occupancy_conflicts', ok(occupancy), assertOccupancy),
];


// ------------------------------------------------------------------ the app

/** Signs in whoever the x-test-as header names; no header is no session. */
const fakeRequireAuth = headerAuth(USERS);

const app = express()
  .use(express.json())
  .use(
    '/api/event-requests/:id/venue-suitability',
    createVenueSuitabilityRouter({ requireAuth: fakeRequireAuth }),
  )
  .use('/api/event-requests', createEventRequestRouter({ requireAuth: fakeRequireAuth }))
  .use('/api/booking-requests', createBookingRequestRouter({ requireAuth: fakeRequireAuth }))
  .use('/api/venues', createVenueRouter({ requireAuth: fakeRequireAuth }));

/** A request as one user; any assertion failure inside the mock fails here first. */
const as = actingAs(app, failures);

afterEach(() => {
  const leftover = queue.splice(0).map((s) => `${s.kind}('${s.name}')`);
  const caught = failures.splice(0);
  expect(caught).toEqual([]);
  expect(leftover, 'scripted calls never made').toEqual([]);
});

const journey = {};
const criterion = (result, name) => result.criteria.find((c) => c.criterion === name);


describe('the test double', () => {
  it('SCRUM188_the_supabase_client_is_mocked_and_never_the_real_one', () => {
    expect(vi.isMockFunction(supabase.rpc)).toBe(true);
    expect(vi.isMockFunction(supabase.from)).toBe(true);
  });
});


describe('SCRUM188 venue suitability journey: check, request, Venue Staff, recheck', () => {
  it('SCRUM188_AC2_flow_coordinator_checks_an_undersized_venue', async () => {
    script(
      fromStep('event_requests', ok(eventRow())),
      ...judgeSteps([], (args) => {
        expect(args).toEqual({
          p_venue_id: VENUE_ID,
          p_starts_at: at('10:00'),
          p_ends_at: at('12:00'),
          p_pad_requested: true,
          p_exclude_hold_event_id: EVENT_ID,
        });
      }),
    );

    const res = await as('coordinator', (r) => r
      .get(`/api/event-requests/${EVENT_ID}/venue-suitability`)
      .query({ venueId: VENUE_ID, layout: 'theatre', facilities: 'projector', expectedAttendance: 10 }));

    expect(res.status).toBe(200);
    expect(res.body.suitable).toBe(false);
    expect(res.body.criteria.map((c) => [c.criterion, c.met])).toEqual([
      ['Capacity', false],
      ['Operating hours', true],
      ['Layout', true],
      ['Accessibility', true],
      ['Facilities', true],
      ['Availability', true],
    ]);
    // The Jira example, from the stored attendance, not the query's 10.
    expect(criterion(res.body, 'Capacity').detail).toBe('Capacity 80 < expected attendance 150');
    expect(res.body.checked).toMatchObject({ expectedAttendance: 150, layout: 'theatre', facilities: ['projector'] });
  });

  it('SCRUM188_AC7_flow_request_with_confirmation_stores_capacity_unmet_and_overridden', async () => {
    const body = {
      eventRequestId: EVENT_ID,
      venueId: VENUE_ID,
      roomLayoutCode: 'theatre',
      facilities: ['projector'],
    };
    const checkSteps = () => [
      fromStep('event_requests', ok(eventRow())),
      fromStep('event_requests', ok(eventRow())),
      ...judgeSteps(),
    ];

    // Not confirmed, then confirmed without naming Capacity (SCRUM-193/194):
    // both asked again, and create_booking_request is never called.
    for (const extra of [{}, { confirmUnsuitable: true }]) {
      script(...checkSteps());
      const refused = await as('coordinator', (r) => r.post('/api/booking-requests').send({ ...body, ...extra }));
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('SUITABILITY_CONFIRMATION_REQUIRED');
      expect(refused.body.conflicts.map((c) => c.criterion)).toEqual(['Capacity']);
    }

    // Confirmed, naming the unmet criterion.
    script(
      ...checkSteps(),
      rpcStep('create_booking_request', undefined, (args) => {
        journey.stored = args.p_suitability;
        // SCRUM-525: kept, so the stored booking holds what the function was sent.
        journey.attendance = args.p_expected_attendance;
        expect(args).toMatchObject({
          p_event_request_id: EVENT_ID,
          p_venue_id: VENUE_ID,
          p_requested_by: COORDINATOR_ID,
          p_room_layout_code: 'theatre',
          p_confirm_unsuitable: true,
          // No attendance in the body, so the event's.
          p_expected_attendance: 150,
        });
        expect(args.p_suitability.suitable).toBe(false);
        expect(args.p_suitability.criteria.filter((c) => !c.met).map((c) => c.criterion)).toEqual(['Capacity']);
        expect(args.p_suitability.checked).toEqual({
          startsAt: at('10:00'),
          endsAt: at('12:00'),
          expectedAttendance: 150,
          layout: 'theatre',
          accessibility: [],
          facilities: ['projector'],
        });
      }),
    );
    // The function answers with what it stored, built from what it was sent.
    queue.at(-1).respond = {
      get data() {
        return {
          outcome: 'created',
          booking: journey.bookingRow = {
            id: BOOKING_ID,
            venue_id: VENUE_ID,
            event_request_id: EVENT_ID,
            starts_at: at('10:00'),
            ends_at: at('12:00'),
            status: 'pending',
            requested_by: COORDINATOR_ID,
            room_layout_code: 'theatre',
            // SCRUM-525 (051): the attendance as create_booking_request stored it.
            expected_attendance: journey.attendance,
            setup_notes: null,
            suitability_result: journey.stored,
            suitability_overridden: true,
            created_at: '2026-10-11T03:00:00+00:00',
          },
        };
      },
      error: null,
    };

    const res = await as('coordinator', (r) => r
      .post('/api/booking-requests')
      .send({ ...body, confirmUnsuitable: true, acknowledgedCriteria: ['Capacity'] }));

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: BOOKING_ID, status: 'pending', suitabilityOverridden: true });
    expect(res.body.suitability).toEqual(journey.stored);
  });

  it('SCRUM188_AC7_flow_venue_staff_see_the_override_and_a_coordinator_does_not', async () => {
    const listed = { ...journey.bookingRow, event_requests: { event_name: 'Orientation Week' } };

    script(fromStep('bookings', ok([listed]), (q) => {
      expect(q.args('select')[0]).toMatch(/suitability_result/);
      expect(q.args('eq')).toEqual(['venue_id', VENUE_ID]);
    }));
    const staff = await as('staff', (r) => r.get(`/api/venues/${VENUE_ID}/bookings`));

    expect(staff.status).toBe(200);
    expect(staff.body).toHaveLength(1);
    expect(staff.body[0]).toMatchObject({
      id: BOOKING_ID,
      eventName: 'Orientation Week',
      roomLayoutCode: 'theatre',
      suitabilityOverridden: true,
      overriddenCriteria: ['Capacity'],
    });
    expect(staff.body[0].suitability).toEqual(journey.stored);
    expect(staff.body[0].suitability.suitable).toBe(false);

    script(fromStep('bookings', ok([journey.bookingRow]), (q) => {
      expect(q.args('select')[0]).not.toMatch(/suitability/);
    }));
    const coordinator = await as('coordinator', (r) => r.get(`/api/venues/${VENUE_ID}/bookings`));

    expect(coordinator.status).toBe(200);
    expect(coordinator.body[0]).not.toHaveProperty('suitability');
    expect(coordinator.body[0]).not.toHaveProperty('overriddenCriteria');
  });

  /** The recheck: the event, its live bookings, then one judgeVenue per booking. */
  const recheckSteps = (event, occupancy) => [
    fromStep('event_requests', ok(event)),
    fromStep('bookings', ok([{ ...journey.bookingRow, venues: { name: 'Seminar Room', location: 'Level 2' } }]), (q) => {
      expect(q.allArgs('eq')).toEqual([['event_request_id', EVENT_ID]]);
      expect(q.args('in')).toEqual(['status', ['pending', 'conflicting', 'approved', 'flagged_for_review']]);
    }),
    ...judgeSteps(occupancy),
  ];

  // SCRUM-525 rewrote SCRUM188_AC6_flow_attendance_raised_again_still_shows_
  // capacity_unmet_not_newly. R15 (Terence, 2026-10-12): a booking's own
  // attendance wins, so raising the event's to 180 does not re-judge a
  // booking requested for 150 (SCRUM-188 AC6 narrowed; SCRUM-395 owns
  // changing a booking's number).
  it('SCRUM525_AC3_flow_the_event_raised_to_180_does_not_change_a_booking_requested_for_150', async () => {
    script(rpcStep(
      'process_change_request',
      ok({
        id: CHANGE_REQUEST_ID,
        event_request_id: EVENT_ID,
        requested_by: ORGANISER_ID,
        change_field: 'expected_attendance',
        requested_change: '180',
        status: 'processed',
        decision: 'approved',
        decision_notes: null,
        processed_by: COORDINATOR_ID,
        processed_at: '2026-10-11T04:00:00+00:00',
        created_at: '2026-10-11T03:30:00+00:00',
        updated_at: '2026-10-11T04:00:00+00:00',
      }),
      (args) => {
        expect(args).toMatchObject({
          p_change_request_id: CHANGE_REQUEST_ID,
          p_decision: 'approved',
          p_processed_by: COORDINATOR_ID,
        });
      },
    ));
    const decided = await as('coordinator', (r) => r
      .post(`/api/event-requests/change-requests/${CHANGE_REQUEST_ID}/decision`)
      .send({ decision: 'approved' }));
    expect(decided.status).toBe(200);

    // The event row now carries what process_change_request applied.
    script(...recheckSteps(eventRow({ expected_attendance: 180 }), []));
    const res = await as('coordinator', (r) => r.get(`/api/event-requests/${EVENT_ID}/venue-suitability/bookings`));

    expect(res.status).toBe(200);
    const [item] = res.body;
    expect(item).toMatchObject({
      bookingId: BOOKING_ID,
      suitabilityOverridden: true,
      error: null,
      expectedAttendance: 150,
      attendanceSource: 'booking',
    });
    // Judged on the booking's own 150, read back from what was stored, not
    // on the event's new 180.
    expect(criterion(item.current, 'Capacity')).toMatchObject({
      met: false,
      detail: 'Capacity 80 < expected attendance 150',
    });
    expect(item.atRequest).toEqual({ suitable: false, unmet: ['Capacity'] });
    // Already overridden by name, so not raised again (open point 6).
    expect(item.newlyUnmet).toEqual([]);
  });

  it('SCRUM188_AC6_flow_a_new_block_makes_availability_newly_unmet', async () => {
    const block = {
      id: BLOCK_ID,
      venue_id: VENUE_ID,
      starts_at: at('09:00'),
      ends_at: at('11:00'),
      reason: 'maintenance',
      notes: null,
      created_by: STAFF_ID,
      last_modified_by: STAFF_ID,
      created_at: '2026-10-11T05:00:00+00:00',
      updated_at: '2026-10-11T05:00:00+00:00',
      removed_at: null,
      removed_by: null,
    };
    script(rpcStep(
      'create_venue_block',
      ok({ outcome: 'created', block, affected_bookings: [], flagged_bookings: [] }),
      (args) => {
        expect(args).toMatchObject({ p_venue_id: VENUE_ID, p_starts_at: at('09:00'), p_ends_at: at('11:00') });
      },
    ));
    const blocked = await as('staff', (r) => r
      .post(`/api/venues/${VENUE_ID}/blocks`)
      .send({ startsAt: at('09:00'), endsAt: at('11:00'), reason: 'maintenance' }));
    expect(blocked.status).toBe(201);

    script(...recheckSteps(eventRow({ expected_attendance: 180 }), [{
      kind: 'block',
      id: BLOCK_ID,
      status: null,
      event_request_id: null,
      event_name: null,
      reason: 'maintenance',
      starts_at: at('09:00'),
      ends_at: at('11:00'),
      occupied_starts_at: at('09:00'),
      occupied_ends_at: at('11:00'),
      setup_minutes: 30,
      turnaround_minutes: 45,
    }]));
    const res = await as('coordinator', (r) => r.get(`/api/event-requests/${EVENT_ID}/venue-suitability/bookings`));

    expect(res.status).toBe(200);
    const [item] = res.body;
    expect(criterion(item.current, 'Availability')).toMatchObject({
      met: false,
      detail:
        `Needs 09:30–12:45 on ${DAY} (setup 09:30–10:00, turnaround 12:00–12:45). ` +
        `Blocked (maintenance) 09:00–11:00 on ${DAY}`,
    });
    expect(item.newlyUnmet).toEqual(['Availability']);
  });
});
