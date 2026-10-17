/**
 * Tests for the booking request route.
 *
 * SCRUM-252 and SCRUM-253, subtasks of SCRUM-243 (Submit a Venue Booking Request).
 *
 * Transport and service tests together: real Express routing and the real
 * service, over a fake Supabase client and a fake suitability checker. What the
 * database function decides is proved against a real Postgres in
 * tests/db/createBookingRequestMigration.test.js; here the function's answers
 * are queued, and what is proved is what the endpoint does with them -- the
 * status code, the error code and the conflict list the UI reads, and that
 * nothing the caller sends can choose the status, the period or the requester.
 *
 * Why the router is built here rather than imported from src/app.js: app.js
 * calls app.listen() and pulls in the Supabase client, which throws without a
 * .env.
 *
 * Concurrency between simultaneous requests is SCRUM-256's.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// SCRUM-190: the default checker loads venueService.js lazily, and that module
// imports the Supabase client statically, which throws without a .env. Every
// query in these tests goes to the injected fake, so the real client is never
// wanted; this only lets the module load.
vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: {}, supabaseAdmin: {}, default: {} }));

import { createBookingRequestRouter } from '../../src/routes/bookingRequests.js';
import { STATUS } from '../../src/domain/eventRequestStatus.js';
import { ROLE } from '../../src/domain/userRole.js';

const COORDINATOR_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_COORDINATOR_ID = '66666666-6666-4666-8666-666666666666';
const ORGANISER_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const VENUE_ID = '33333333-3333-4333-8333-333333333333';
const BOOKING_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_BOOKING_ID = '77777777-7777-4777-8777-777777777777';
const BLOCK_ID = '88888888-8888-4888-8888-888888888888';

const START = '2026-12-01T09:00:00+00:00';
const END = '2026-12-01T17:00:00+00:00';

const SUITABLE = { suitable: true, criteria: [{ criterion: 'capacity', met: true }] };
// Criterion labels as the real check reports them, since SCRUM-193/194's
// acknowledgedCriteria names the unmet ones by label.
const UNSUITABLE = {
  suitable: false,
  criteria: [
    { criterion: 'Capacity', met: false, detail: 'Capacity 80 < expected attendance 150' },
    { criterion: 'Facilities', met: true },
  ],
};

/** The event, as PostgREST returns it. */
function eventRow(overrides = {}) {
  return {
    id: EVENT_ID,
    organiser_id: ORGANISER_ID,
    event_name: 'IS212 Industry Night',
    purpose: null,
    description: null,
    proposed_start: START,
    proposed_end: END,
    expected_attendance: 150,
    venue_requirements: 'Tiered seating',
    accessibility_requirements: 'Step-free entrance',
    equipment_requirements: null,
    status: STATUS.APPROVED,
    assigned_coordinator_id: COORDINATOR_ID,
    created_at: '2026-01-10T03:00:00+00:00',
    updated_at: '2026-01-12T03:00:00+00:00',
    submitted_at: '2026-01-11T03:00:00+00:00',
    ...overrides,
  };
}

/** The booking create_booking_request returns as jsonb. */
function bookingRow(overrides = {}) {
  return {
    id: BOOKING_ID,
    venue_id: VENUE_ID,
    event_request_id: EVENT_ID,
    starts_at: START,
    ends_at: END,
    status: 'pending',
    requested_by: COORDINATOR_ID,
    room_layout_code: 'theatre',
    // SCRUM-525 (051): the attendance stored with the request; 150 is the
    // event's, which a body without one defaults to.
    expected_attendance: 150,
    venue_requirements: 'Tiered seating',
    accessibility_requirements: 'Step-free entrance',
    setup_notes: 'Extra tables',
    suitability_result: SUITABLE,
    suitability_overridden: false,
    created_at: '2026-10-06T10:00:00+00:00',
    ...overrides,
  };
}

/**
 * SCRUM-190: the venue as getVenueById selects it, open 08:00-22:00 every day
 * (Singapore), large enough for the event and with nothing set up around it.
 */
function venueRow(overrides = {}) {
  return {
    id: VENUE_ID,
    name: 'Hall A',
    location: 'Level 1',
    max_capacity: 200,
    turnaround_minutes: 0,
    setup_minutes: 0,
    emergency_access: null,
    known_restrictions: null,
    retired_at: null,
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: '2026-01-01T00:00:00+00:00',
    last_modified_by: null,
    venue_room_layouts: [{ room_layout_code: 'theatre' }],
    venue_accessibility_features: [],
    venue_facilities: [],
    venue_operating_hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
      day_of_week: day,
      opens_at: '08:00:00',
      closes_at: '22:00:00',
    })),
    ...overrides,
  };
}

const ok = (data) => ({ data, error: null });
const created = (overrides) => ok({ outcome: 'created', booking: bookingRow(overrides) });
const dbFailure = (code, message, extra = {}) => ({ data: null, error: { code, message, ...extra } });

/** A queue-fed stand-in for the Supabase client, recording every call. */
function createFakeClient(results = []) {
  const queue = [...results];
  const calls = [];

  const settle = (call) => {
    if (queue.length === 0) {
      throw new Error(`fake client: no result queued for ${call.operation} on ${call.table ?? call.fn}`);
    }
    return Promise.resolve(queue.shift());
  };

  return {
    calls,
    from(table) {
      const call = { table, operation: 'select', filters: [] };
      calls.push(call);
      const chain = {
        select: () => chain,
        eq: (column, value) => {
          call.filters.push([column, value]);
          return chain;
        },
        order: (column, options) => {
          (call.order ??= []).push([column, options]);
          return chain;
        },
        in: (column, values) => {
          call.filters.push([column, values]);
          return chain;
        },
        maybeSingle: () => settle(call),
        single: () => settle(call),
        then: (resolve, reject) => settle(call).then(resolve, reject),
      };
      return chain;
    },
    rpc(fn, args) {
      const call = { table: null, operation: 'rpc', fn, args };
      calls.push(call);
      return settle(call);
    },
  };
}

const signedInWithRole = (role, id = COORDINATOR_ID) => (req, _res, next) => {
  req.user = { id, email: 'user@example.com', role };
  next();
};
const signedOut = (_req, res) => res.status(401).json({ error: 'Authentication required' });

const suitableChecker = () => vi.fn(async () => SUITABLE);

function appWith({
  client,
  requireAuth = signedInWithRole(ROLE.EVENT_COORDINATOR),
  checkSuitability = suitableChecker(),
}) {
  return express()
    .use(express.json())
    .use('/api/booking-requests', createBookingRequestRouter({ client, requireAuth, checkSuitability }));
}

const BODY = { eventRequestId: EVENT_ID, venueId: VENUE_ID };

const post = (client, body = BODY, options = {}) =>
  request(appWith({ client, ...options })).post('/api/booking-requests').send(body);

/** A client that reads the event and then calls the function. */
const clientFor = (rpcResult = created(), event = eventRow()) =>
  createFakeClient([ok(event), rpcResult]);

const rpcCall = (client) => client.calls.find((call) => call.operation === 'rpc');


describe('SCRUM-252: a coordinator requests a venue', () => {
  it('SCRUM252_creates_a_pending_request_and_returns_201', async () => {
    const client = clientFor();

    const res = await post(client, {
      ...BODY,
      roomLayoutCode: 'theatre',
      setupNotes: '  Extra tables  ',
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: BOOKING_ID,
      eventRequestId: EVENT_ID,
      venueId: VENUE_ID,
      status: 'pending',
      startsAt: START,
      endsAt: END,
      roomLayoutCode: 'theatre',
      expectedAttendance: 150,
      venueRequirements: 'Tiered seating',
      accessibilityRequirements: 'Step-free entrance',
      setupNotes: 'Extra tables',
      suitability: SUITABLE,
      suitabilityOverridden: false,
      requestedBy: COORDINATOR_ID,
      replacesBookingId: null,
      createdAt: '2026-10-06T10:00:00+00:00',
    });
    expect(client.calls.map((c) => c.operation)).toEqual(['select', 'rpc']);
    expect(rpcCall(client).fn).toBe('create_booking_request');
  });

  it('SCRUM252_passes_the_coordinators_choices_and_the_server_computed_suitability', async () => {
    const client = clientFor();
    const checkSuitability = suitableChecker();

    await post(client, { ...BODY, roomLayoutCode: 'theatre', setupNotes: 'Extra tables' }, { checkSuitability });

    expect(rpcCall(client).args).toEqual({
      p_event_request_id: EVENT_ID,
      p_venue_id: VENUE_ID,
      p_requested_by: COORDINATOR_ID,
      p_room_layout_code: 'theatre',
      p_setup_notes: 'Extra tables',
      p_suitability: SUITABLE,
      p_confirm_unsuitable: false,
      p_expected_attendance: 150,
      p_replaces_booking_id: null,
    });
    expect(checkSuitability).toHaveBeenCalledWith({
      eventRequestId: EVENT_ID,
      venueId: VENUE_ID,
      roomLayoutCode: 'theatre',
      accessibility: [],
      facilities: [],
      expectedAttendance: 150,
      userId: COORDINATOR_ID,
      client,
    });
  });

  it('SCRUM252_the_status_period_requester_and_suitability_cannot_be_chosen_by_the_caller', async () => {
    const client = clientFor();

    await post(client, {
      ...BODY,
      status: 'approved',
      startsAt: '2030-01-01T00:00:00Z',
      endsAt: '2030-01-02T00:00:00Z',
      requestedBy: OTHER_COORDINATOR_ID,
      suitability: { suitable: true, criteria: [] },
      suitable: true,
    });

    const args = rpcCall(client).args;
    expect(Object.keys(args).sort()).toEqual([
      'p_confirm_unsuitable',
      'p_event_request_id',
      'p_expected_attendance',
      'p_replaces_booking_id',
      'p_requested_by',
      'p_room_layout_code',
      'p_setup_notes',
      'p_suitability',
      'p_venue_id',
    ]);
    expect(args.p_requested_by).toBe(COORDINATOR_ID);
    expect(args.p_suitability).toEqual(SUITABLE);
  });

  it('SCRUM252_layout_and_notes_are_optional', async () => {
    const client = clientFor(created({ room_layout_code: null, setup_notes: null }));

    const res = await post(client);

    expect(res.status).toBe(201);
    expect(rpcCall(client).args).toMatchObject({ p_room_layout_code: null, p_setup_notes: null });
  });

  it('SCRUM252_refuses_a_response_that_is_not_pending', async () => {
    const res = await post(clientFor(created({ status: 'approved' })));
    expect(res.status).toBe(500);
  });

  it('SCRUM252_refuses_an_outcome_it_does_not_know', async () => {
    const res = await post(clientFor(ok({ outcome: 'created_somehow' })));
    expect(res.status).toBe(500);
  });
});


describe('SCRUM-252: who may request', () => {
  it('SCRUM252_returns_401_without_a_token_and_never_queries', async () => {
    const client = clientFor();
    const res = await post(client, BODY, { requireAuth: signedOut });
    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });

  it.each([ROLE.EVENT_ORGANISER, ROLE.VENUE_STAFF, ROLE.TECHNICAL_SUPPORT_STAFF, ROLE.ATTENDEE, ROLE.EVENT_COORDINATOR_LEAD, ROLE.SAFETY_OFFICER])(
    'SCRUM252_refuses_%s_with_403_and_never_queries',
    async (role) => {
      const client = clientFor();
      const checkSuitability = suitableChecker();

      const res = await post(client, BODY, { requireAuth: signedInWithRole(role), checkSuitability });

      expect(res.status).toBe(403);
      expect(client.calls).toHaveLength(0);
      expect(checkSuitability).not.toHaveBeenCalled();
    },
  );

  it('SCRUM252_refuses_a_coordinator_who_is_not_assigned_before_checking_suitability', async () => {
    const client = createFakeClient([ok(eventRow({ assigned_coordinator_id: OTHER_COORDINATOR_ID }))]);
    const checkSuitability = suitableChecker();

    const res = await post(client, BODY, { checkSuitability });

    expect(res.status).toBe(403);
    expect(client.calls.map((c) => c.operation)).toEqual(['select']);
    expect(checkSuitability).not.toHaveBeenCalled();
  });

  it('SCRUM252_refuses_when_the_function_finds_the_event_changed_hands_under_its_lock', async () => {
    const client = clientFor(dbFailure('42501', `only the coordinator assigned to event request ${EVENT_ID} can request a venue for it`));

    const res = await post(client);

    expect(res.status).toBe(403);
  });

  it('SCRUM252_answers_404_for_an_event_that_does_not_exist', async () => {
    const res = await post(createFakeClient([ok(null)]));
    expect(res.status).toBe(404);
  });

  it('SCRUM252_answers_404_for_a_draft_exactly_as_for_a_missing_event', async () => {
    const draft = await post(createFakeClient([ok(eventRow({ status: STATUS.DRAFT, assigned_coordinator_id: null }))]));
    const missing = await post(createFakeClient([ok(null)]));
    expect(draft.status).toBe(404);
    expect(draft.body).toEqual(missing.body);
  });

  it('SCRUM252_answers_404_for_a_venue_that_does_not_exist', async () => {
    const res = await post(clientFor(dbFailure('P0002', `venue ${VENUE_ID} not found`)));
    expect(res.status).toBe(404);
  });
});


describe('SCRUM-252: the event must be approved or confirmed', () => {
  it.each([STATUS.APPROVED, STATUS.CONFIRMED])('SCRUM252_accepts_a_%s_event', async (status) => {
    const res = await post(clientFor(created(), eventRow({ status })));
    expect(res.status).toBe(201);
  });

  it.each([
    STATUS.SUBMITTED,
    STATUS.UNDER_REVIEW,
    STATUS.PENDING_CLARIFICATION,
    STATUS.PLANNING,
    STATUS.COMPLETED,
    STATUS.REJECTED,
    STATUS.CANCELLED,
  ])('SCRUM252_refuses_a_%s_event_with_409_before_the_suitability_check', async (status) => {
    const client = createFakeClient([ok(eventRow({ status }))]);
    const checkSuitability = suitableChecker();

    const res = await post(client, BODY, { checkSuitability });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EVENT_NOT_BOOKABLE');
    expect(client.calls.map((c) => c.operation)).toEqual(['select']);
    expect(checkSuitability).not.toHaveBeenCalled();
  });

  it('SCRUM252_the_function_refuses_a_status_that_changed_after_the_read', async () => {
    const res = await post(
      clientFor(dbFailure('PT409', 'event request has status cancelled', { hint: 'EVENT_NOT_BOOKABLE' })),
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EVENT_NOT_BOOKABLE');
  });

  it('SCRUM252_refuses_an_event_with_no_proposed_dates', async () => {
    const res = await post(
      clientFor(dbFailure('PT409', 'no proposed start and end', { hint: 'EVENT_DATES_MISSING' })),
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EVENT_DATES_MISSING');
  });
});


describe('SCRUM-252: input is validated before the database', () => {
  it.each([
    ['no event', { venueId: VENUE_ID }, 'eventRequestId'],
    ['no venue', { eventRequestId: EVENT_ID }, 'venueId'],
    ['a malformed event id', { ...BODY, eventRequestId: 'nope' }, 'eventRequestId'],
    ['a malformed venue id', { ...BODY, venueId: 42 }, 'venueId'],
    ['a layout that is not a code', { ...BODY, roomLayoutCode: 'Theatre Style!' }, 'roomLayoutCode'],
    ['setup notes that are not text', { ...BODY, setupNotes: 7 }, 'setupNotes'],
    ['setup notes over 1000 characters', { ...BODY, setupNotes: 'x'.repeat(1001) }, 'setupNotes'],
    ['a confirmation that is not a boolean', { ...BODY, confirmUnsuitable: 'true' }, 'confirmUnsuitable'],
  ])('SCRUM252_refuses_%s_with_400', async (_label, body, field) => {
    const client = clientFor();

    const res = await post(client, body);

    expect(res.status).toBe(400);
    expect(res.body.details.map((d) => d.field)).toContain(field);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM252_reports_every_fault_at_once', async () => {
    const res = await post(clientFor(), { eventRequestId: 'x', venueId: 'y' });
    expect(res.body.details.map((d) => d.field)).toEqual(['eventRequestId', 'venueId']);
  });

  it('SCRUM252_a_layout_the_database_does_not_know_is_a_400', async () => {
    const res = await post(clientFor(dbFailure('23503', 'violates foreign key "bookings_room_layout_code_fkey"')), {
      ...BODY,
      roomLayoutCode: 'no_such_layout',
    });
    expect(res.status).toBe(400);
  });
});


describe('SCRUM-252: a retired venue and an unavailable period are refused with the conflict', () => {
  it('SCRUM252_refuses_a_retired_venue_with_409', async () => {
    const res = await post(
      clientFor(dbFailure('PT409', `venue ${VENUE_ID} is retired and cannot be requested`, { hint: 'VENUE_RETIRED' })),
    );

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'VENUE_RETIRED', conflicts: [] });
  });

  it('SCRUM252_shows_the_blocks_and_approved_bookings_in_the_way', async () => {
    const client = clientFor(
      ok({
        outcome: 'conflict',
        conflicts: [
          { kind: 'block', block_id: BLOCK_ID, starts_at: '2026-12-01T08:00:00+00:00', ends_at: '2026-12-01T10:00:00+00:00', reason: 'maintenance' },
          {
            kind: 'booking',
            booking_id: OTHER_BOOKING_ID,
            event_request_id: OTHER_COORDINATOR_ID,
            event_name: 'Careers Fair',
            starts_at: '2026-12-01T15:00:00+00:00',
            ends_at: '2026-12-01T18:00:00+00:00',
          },
        ],
      }),
    );

    const res = await post(client);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BOOKING_PERIOD_CONFLICT');
    expect(res.body.conflicts).toEqual([
      { kind: 'block', blockId: BLOCK_ID, startsAt: '2026-12-01T08:00:00+00:00', endsAt: '2026-12-01T10:00:00+00:00', reason: 'maintenance' },
      {
        kind: 'booking',
        bookingId: OTHER_BOOKING_ID,
        eventRequestId: OTHER_COORDINATOR_ID,
        eventName: 'Careers Fair',
        startsAt: '2026-12-01T15:00:00+00:00',
        endsAt: '2026-12-01T18:00:00+00:00',
      },
    ]);
  });

  it('SCRUM252_an_empty_conflict_list_still_refuses', async () => {
    const res = await post(clientFor(ok({ outcome: 'conflict' })));
    expect(res.status).toBe(409);
    expect(res.body.conflicts).toEqual([]);
  });
});


describe('SCRUM-252/SCRUM-525: one live request per event per venue', () => {
  it.each([
    ['a pending or approved request', 'BOOKING_REQUEST_EXISTS'],
    ['a booking flagged for review', 'BOOKING_FLAGGED_FOR_REVIEW'],
  ])('SCRUM252_refuses_an_event_with_%s_and_names_it', async (_label, hint) => {
    const res = await post(
      clientFor(
        dbFailure('PT409', 'the event already has a live request for this venue', {
          hint,
          details: OTHER_BOOKING_ID,
        }),
      ),
    );

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(hint);
    expect(res.body.conflicts).toEqual([{ kind: 'booking_request', bookingId: OTHER_BOOKING_ID }]);
  });

  it('SCRUM252_does_not_echo_a_detail_that_is_not_an_id', async () => {
    const res = await post(
      clientFor(dbFailure('PT409', 'exists', { hint: 'BOOKING_REQUEST_EXISTS', details: 'DROP TABLE bookings' })),
    );
    expect(res.body.conflicts).toEqual([]);
  });
});


describe('SCRUM-266: a request can replace a flagged booking', () => {
  it('SCRUM266_W7_sends_replaces_booking_id_and_echoes_it_on_the_new_request', async () => {
    const client = clientFor(created({ replaces_booking_id: OTHER_BOOKING_ID }));

    const res = await post(client, { ...BODY, replacesBookingId: OTHER_BOOKING_ID.toUpperCase() });

    expect(res.status).toBe(201);
    expect(res.body.replacesBookingId).toBe(OTHER_BOOKING_ID);
    expect(rpcCall(client).args.p_replaces_booking_id).toBe(OTHER_BOOKING_ID);
  });

  it('SCRUM266_W7_a_malformed_replaces_booking_id_is_400_and_never_queries', async () => {
    const client = clientFor();

    const res = await post(client, { ...BODY, replacesBookingId: 'not-an-id' });

    expect(res.status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });

  it.each(['REPLACED_BOOKING_NOT_ON_EVENT', 'REPLACED_BOOKING_NOT_FLAGGED'])(
    'SCRUM266_W7_%s_is_409_with_that_code',
    async (hint) => {
      const res = await post(
        clientFor(dbFailure('PT409', 'cannot replace that booking', { hint })),
        { ...BODY, replacesBookingId: OTHER_BOOKING_ID },
      );

      expect(res.status).toBe(409);
      expect(res.body.code).toBe(hint);
      expect(res.body.conflicts).toEqual([]);
    },
  );
});


describe('SCRUM-252: the suitability check (N10)', () => {
  it('SCRUM252_warns_and_requires_confirmation_when_the_venue_is_not_suitable', async () => {
    const client = clientFor(ok({ outcome: 'suitability_confirmation_required', suitability: UNSUITABLE }));

    const res = await post(client, BODY, { checkSuitability: vi.fn(async () => UNSUITABLE) });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SUITABILITY_CONFIRMATION_REQUIRED');
    // Only the criteria that were not met.
    expect(res.body.conflicts).toEqual([UNSUITABLE.criteria[0]]);
    // SCRUM-193/194: refused by the service before the function is called.
    expect(rpcCall(client)).toBeUndefined();
  });

  it('SCRUM252_submits_once_the_coordinator_confirms', async () => {
    const client = clientFor(created({ suitability_result: UNSUITABLE, suitability_overridden: true }));

    const res = await post(client, { ...BODY, confirmUnsuitable: true, acknowledgedCriteria: ['Capacity'] }, {
      checkSuitability: vi.fn(async () => UNSUITABLE),
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'pending', suitabilityOverridden: true, suitability: UNSUITABLE });
    expect(rpcCall(client).args.p_confirm_unsuitable).toBe(true);
  });

  it('SCRUM252_a_suitable_result_never_needs_confirmation', async () => {
    const client = clientFor();
    await post(client);
    expect(rpcCall(client).args.p_confirm_unsuitable).toBe(false);
  });

  it('SCRUM252_the_result_is_computed_by_the_server_whatever_the_body_says', async () => {
    const checkSuitability = vi.fn(async () => UNSUITABLE);
    const client = clientFor(created({ suitability_result: UNSUITABLE, suitability_overridden: true }));

    await post(
      client,
      { ...BODY, suitable: true, suitability: SUITABLE, confirmUnsuitable: true, acknowledgedCriteria: ['Capacity'] },
      { checkSuitability },
    );

    expect(rpcCall(client).args.p_suitability).toEqual(UNSUITABLE);
  });

  // SCRUM-193/194 (F2, SCRUM-188 AC7): an unsuitable venue is confirmed only
  // for the criteria the coordinator names.
  const TWO_UNMET = {
    suitable: false,
    criteria: [
      { criterion: 'Capacity', met: false, detail: 'Capacity 80 < expected attendance 150' },
      { criterion: 'Facilities', met: true, detail: 'None requested' },
      { criterion: 'Availability', met: false, detail: 'Needs … Blocked …' },
    ],
  };

  it.each([
    ['confirmUnsuitable alone', { confirmUnsuitable: true }],
    ['only some of the unmet criteria', { confirmUnsuitable: true, acknowledgedCriteria: ['Capacity'] }],
    ['the criteria without confirmUnsuitable', { acknowledgedCriteria: ['Capacity', 'Availability'] }],
    ['other criteria than the unmet ones', { confirmUnsuitable: true, acknowledgedCriteria: ['Layout', 'Capacity'] }],
  ])('SCRUM188_AC7_%s_is_asked_again_and_nothing_is_written', async (_label, extra) => {
    const client = clientFor();

    const res = await post(client, { ...BODY, ...extra }, { checkSuitability: vi.fn(async () => TWO_UNMET) });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SUITABILITY_CONFIRMATION_REQUIRED');
    expect(res.body.conflicts).toEqual([TWO_UNMET.criteria[0], TWO_UNMET.criteria[2]]);
    expect(rpcCall(client)).toBeUndefined();
  });

  it('SCRUM188_AC7_every_unmet_criterion_named_is_requested_as_overridden', async () => {
    const client = clientFor(created({ suitability_result: TWO_UNMET, suitability_overridden: true }));

    const res = await post(
      client,
      { ...BODY, confirmUnsuitable: true, acknowledgedCriteria: ['Availability', 'Capacity'] },
      { checkSuitability: vi.fn(async () => TWO_UNMET) },
    );

    expect(res.status).toBe(201);
    expect(rpcCall(client).args).toMatchObject({ p_suitability: TWO_UNMET, p_confirm_unsuitable: true });
  });

  it('SCRUM188_AC7_naming_more_than_the_unmet_criteria_is_still_confirmed', async () => {
    const client = clientFor(created({ suitability_result: UNSUITABLE, suitability_overridden: true }));

    const res = await post(
      client,
      { ...BODY, confirmUnsuitable: true, acknowledgedCriteria: ['Capacity', 'Availability'] },
      { checkSuitability: vi.fn(async () => UNSUITABLE) },
    );

    expect(res.status).toBe(201);
    expect(rpcCall(client).args.p_confirm_unsuitable).toBe(true);
  });

  it('SCRUM188_AC7_an_unknown_acknowledged_criterion_is_400_before_any_read', async () => {
    const client = clientFor();
    const checkSuitability = vi.fn(async () => UNSUITABLE);

    const res = await post(
      client,
      { ...BODY, confirmUnsuitable: true, acknowledgedCriteria: ['capacity'] },
      { checkSuitability },
    );

    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe('acknowledgedCriteria');
    expect(client.calls).toEqual([]);
    expect(checkSuitability).not.toHaveBeenCalled();
  });

  it('SCRUM188_AC7_acknowledging_criteria_for_a_suitable_venue_changes_nothing', async () => {
    const client = clientFor();

    const res = await post(client, { ...BODY, acknowledgedCriteria: ['Capacity'] });

    expect(res.status).toBe(201);
    expect(rpcCall(client).args.p_confirm_unsuitable).toBe(false);
  });

  it('SCRUM190_the_default_checker_judges_the_stored_event_and_venue_and_its_result_is_stored', async () => {
    // No checkSuitability supplied: the router falls back to the real check.
    // Reads: the event (booking service), the event again (the check), the
    // venue, then the occupancy function, then create_booking_request.
    // 09:00-17:00 in Singapore, inside the venue's hours. START and END are
    // 17:00-01:00 there, which would fail operating hours for crossing midnight.
    const daytime = { proposed_start: '2026-12-01T01:00:00+00:00', proposed_end: '2026-12-01T09:00:00+00:00' };
    const client = createFakeClient([
      ok(eventRow(daytime)),
      ok(eventRow(daytime)),
      ok(venueRow()),
      ok([]),
      created(),
    ]);

    const res = await request(
      express()
        .use(express.json())
        .use(
          '/api/booking-requests',
          createBookingRequestRouter({ client, requireAuth: signedInWithRole(ROLE.EVENT_COORDINATOR) }),
        ),
    )
      .post('/api/booking-requests')
      .send(BODY);

    expect(res.status).toBe(201);
    expect(client.calls.map((c) => c.fn ?? c.table)).toEqual([
      'event_requests',
      'event_requests',
      'venues',
      'venue_occupancy_conflicts',
      'create_booking_request',
    ]);
    const stored = client.calls.at(-1).args.p_suitability;
    expect(stored.suitable).toBe(true);
    expect(stored.criteria.map((c) => c.criterion)).toEqual([
      'Capacity', 'Operating hours', 'Layout', 'Accessibility', 'Facilities', 'Availability',
    ]);
    expect(stored.checked).toEqual({
      startsAt: daytime.proposed_start,
      endsAt: daytime.proposed_end,
      expectedAttendance: 150,
      layout: null,
      accessibility: [],
      facilities: [],
    });
  });

  it('SCRUM190_an_unknown_requirement_code_is_400_and_nothing_is_written', async () => {
    const client = createFakeClient([ok(eventRow()), ok(eventRow()), ok([])]);

    const res = await request(
      express()
        .use(express.json())
        .use(
          '/api/booking-requests',
          createBookingRequestRouter({ client, requireAuth: signedInWithRole(ROLE.EVENT_COORDINATOR) }),
        ),
    )
      .post('/api/booking-requests')
      .send({ ...BODY, facilities: ['teleporter'] });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'facilities', message: 'unknown code "teleporter"' }]);
    expect(client.calls.some((c) => c.operation === 'rpc')).toBe(false);
  });

  it.each([
    ['nothing', undefined],
    ['no suitable flag', { criteria: [] }],
    ['no criteria list', { suitable: true }],
    ['a suitable flag that is not a boolean', { suitable: 'yes', criteria: [] }],
  ])('SCRUM252_refuses_a_checker_that_returns_%s_rather_than_assuming_suitable', async (_label, result) => {
    const client = createFakeClient([ok(eventRow())]);

    const res = await post(client, BODY, { checkSuitability: vi.fn(async () => result) });

    expect(res.status).toBe(500);
    expect(client.calls.map((c) => c.operation)).toEqual(['select']);
  });
});


describe('SCRUM-253: a coordinator withdraws a pending request', () => {
  const withdrawn = (overrides) => ok({ outcome: 'withdrawn', booking: bookingRow({ status: 'withdrawn', ...overrides }) });

  const withdraw = (client, id = BOOKING_ID, options = {}) =>
    request(appWith({ client, ...options })).post(`/api/booking-requests/${id}/withdraw`);

  it('SCRUM253_withdraws_the_request_and_returns_200', async () => {
    const client = createFakeClient([withdrawn()]);

    const res = await withdraw(client);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: BOOKING_ID, eventRequestId: EVENT_ID, venueId: VENUE_ID, status: 'withdrawn' });
    // One call, to the function, and nothing else: the checks are its.
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({ operation: 'rpc', fn: 'withdraw_booking_request' });
  });

  it('SCRUM253_takes_the_caller_from_the_token_never_the_body', async () => {
    const client = createFakeClient([withdrawn()]);

    await request(appWith({ client }))
      .post(`/api/booking-requests/${BOOKING_ID}/withdraw`)
      .send({ requestedBy: OTHER_COORDINATOR_ID, status: 'approved', p_requested_by: OTHER_COORDINATOR_ID });

    expect(client.calls[0].args).toEqual({ p_booking_id: BOOKING_ID, p_requested_by: COORDINATOR_ID });
  });

  it('SCRUM253_lower_cases_the_id_it_sends', async () => {
    const client = createFakeClient([withdrawn()]);
    await withdraw(client, BOOKING_ID.toUpperCase());
    expect(client.calls[0].args.p_booking_id).toBe(BOOKING_ID);
  });

  it('SCRUM253_returns_401_without_a_token_and_never_queries', async () => {
    const client = createFakeClient([withdrawn()]);
    const res = await withdraw(client, BOOKING_ID, { requireAuth: signedOut });
    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });

  it.each([ROLE.EVENT_ORGANISER, ROLE.VENUE_STAFF, ROLE.TECHNICAL_SUPPORT_STAFF, ROLE.ATTENDEE, ROLE.EVENT_COORDINATOR_LEAD, ROLE.SAFETY_OFFICER])(
    'SCRUM253_refuses_%s_with_403_and_never_queries',
    async (role) => {
      const client = createFakeClient([withdrawn()]);
      const res = await withdraw(client, BOOKING_ID, { requireAuth: signedInWithRole(role) });
      expect(res.status).toBe(403);
      expect(client.calls).toHaveLength(0);
    },
  );

  it('SCRUM253_refuses_a_coordinator_who_is_not_assigned_with_403', async () => {
    const message = `only the coordinator assigned to event request ${EVENT_ID} can withdraw its booking requests`;
    const res = await withdraw(createFakeClient([dbFailure('42501', message)]), BOOKING_ID, {
      requireAuth: signedInWithRole(ROLE.EVENT_COORDINATOR, OTHER_COORDINATOR_ID),
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(message);
  });

  it('SCRUM253_answers_404_for_a_request_that_does_not_exist', async () => {
    const res = await withdraw(createFakeClient([dbFailure('P0002', `booking request ${BOOKING_ID} not found`)]));
    expect(res.status).toBe(404);
  });

  it.each(['nope', '123', 'null'])('SCRUM253_refuses_the_malformed_id_%s_with_400_before_the_database', async (id) => {
    const client = createFakeClient([withdrawn()]);
    const res = await withdraw(client, id);
    expect(res.status).toBe(400);
    expect(res.body.details.map((d) => d.field)).toEqual(['id']);
    expect(client.calls).toHaveLength(0);
  });

  it.each(['approved', 'rejected', 'withdrawn', 'cancelled', 'flagged_for_review'])(
    'SCRUM253_refuses_a_%s_request_with_409_BOOKING_NOT_PENDING',
    async (status) => {
      const res = await withdraw(
        createFakeClient([
          dbFailure('PT409', `booking request ${BOOKING_ID} is ${status}, and only a pending request can be withdrawn`, {
            hint: 'BOOKING_NOT_PENDING',
          }),
        ]),
      );
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'BOOKING_NOT_PENDING', conflicts: [] });
      expect(res.body.error).toContain(status);
    },
  );

  it('SCRUM253_a_repeated_withdrawal_is_a_409_the_second_time_not_a_repeat_of_the_200', async () => {
    const client = createFakeClient([
      withdrawn(),
      dbFailure('PT409', `booking request ${BOOKING_ID} is withdrawn, and only a pending request can be withdrawn`, {
        hint: 'BOOKING_NOT_PENDING',
      }),
    ]);

    const first = await withdraw(client);
    const second = await withdraw(client);

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('BOOKING_NOT_PENDING');
  });

  it('SCRUM253_a_request_that_changed_under_the_call_is_a_409', async () => {
    const res = await withdraw(createFakeClient([dbFailure('40001', 'booking request changed while it was being withdrawn')]));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BOOKING_CHANGED');
  });

  it.each([
    ['an outcome it does not know', ok({ outcome: 'something' })],
    ['a booking that is not withdrawn', ok({ outcome: 'withdrawn', booking: bookingRow({ status: 'pending' }) })],
  ])('SCRUM253_refuses_%s_rather_than_reporting_a_withdrawal', async (_label, result) => {
    const res = await withdraw(createFakeClient([result]));
    expect(res.status).toBe(500);
  });
});


describe('SCRUM-255: the coordinator lists their booking requests', () => {
  const OTHER_EVENT_ID = '99999999-9999-4999-8999-999999999999';

  /** A bookings row as PostgREST returns it with the event and venue embedded. */
  function listRow(overrides = {}, embeds = {}) {
    return {
      id: BOOKING_ID,
      event_request_id: EVENT_ID,
      venue_id: VENUE_ID,
      starts_at: START,
      ends_at: END,
      status: 'pending',
      room_layout_code: 'theatre',
      setup_notes: 'Extra tables',
      suitability_overridden: false,
      created_at: '2026-10-06T10:00:00+00:00',
      flagged_at: null,
      venues: { name: 'Hall A', location: 'Level 2' },
      event_requests: {
        event_name: 'IS212 Industry Night',
        status: 'approved',
        assigned_coordinator_id: COORDINATOR_ID,
      },
      ...overrides,
      ...embeds,
    };
  }

  const list = (client, options = {}) =>
    request(appWith({ client, ...options })).get('/api/booking-requests/mine');

  it('SCRUM255_returns_the_requests_with_event_venue_and_period', async () => {
    const client = createFakeClient([ok([listRow()])]);

    const res = await list(client);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: BOOKING_ID,
        eventRequestId: EVENT_ID,
        eventName: 'IS212 Industry Night',
        eventStatus: 'approved',
        venueId: VENUE_ID,
        venueName: 'Hall A',
        venueLocation: 'Level 2',
        status: 'pending',
        statusDisplay: {
          status: 'pending',
          label: 'Pending',
          group: 'PENDING',
          description: 'Waiting for Venue Staff to decide. It can still be withdrawn.',
        },
        startsAt: START,
        endsAt: END,
        roomLayoutCode: 'theatre',
        setupNotes: 'Extra tables',
        suitabilityOverridden: false,
        flaggedAt: null,
        reviewReason: null,
        decidedAt: null,
        decisionReason: null,
        suggestedAlternative: null,
        createdAt: '2026-10-06T10:00:00+00:00',
      },
    ]);
  });

  it('SCRUM258_AC6_a_rejected_request_returns_the_reason_and_suggested_alternative', async () => {
    const res = await list(
      createFakeClient([
        ok([
          listRow({
            status: 'rejected',
            decided_at: '2026-10-08T10:00:00+00:00',
            decision_reason: 'Hall closed for repairs',
            suggested_alternative: 'Annex, same time',
          }),
        ]),
      ]),
    );

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      status: 'rejected',
      decidedAt: '2026-10-08T10:00:00+00:00',
      decisionReason: 'Hall closed for repairs',
      suggestedAlternative: 'Annex, same time',
    });
  });

  it.each([
    ['pending', 'Pending'],
    ['approved', 'Approved'],
    ['rejected', 'Rejected'],
    ['withdrawn', 'Withdrawn'],
    ['cancelled', 'Cancelled'],
    ['flagged_for_review', 'Flagged for review'],
  ])('SCRUM255_labels_a_%s_request_%s', async (status, label) => {
    const res = await list(createFakeClient([ok([listRow({ status })])]));
    expect(res.body[0].status).toBe(status);
    expect(res.body[0].statusDisplay.label).toBe(label);
  });

  it('SCRUM255_keeps_the_review_indicator_of_a_flagged_booking', async () => {
    const flaggedAt = '2026-10-05T09:00:00+00:00';
    const res = await list(createFakeClient([ok([listRow({ status: 'flagged_for_review', flagged_at: flaggedAt })])]));
    expect(res.body[0]).toMatchObject({ status: 'flagged_for_review', flaggedAt });
  });

  it('SCRUM255_a_status_this_build_does_not_know_is_shown_as_unknown_not_dropped', async () => {
    const res = await list(createFakeClient([ok([listRow({ status: 'on_hold' })])]));
    expect(res.body[0].statusDisplay).toMatchObject({ status: 'on_hold', group: 'UNKNOWN' });
  });

  it('SCRUM255_reads_a_booking_that_predates_requests_with_null_details', async () => {
    const res = await list(
      createFakeClient([
        ok([
          listRow({
            status: 'approved',
            room_layout_code: null,
            setup_notes: null,
            suitability_overridden: null,
            flagged_at: undefined,
          }),
        ]),
      ]),
    );
    expect(res.body[0]).toMatchObject({
      roomLayoutCode: null,
      setupNotes: null,
      suitabilityOverridden: false,
      flaggedAt: null,
    });
  });

  it('SCRUM255_reads_an_embed_that_arrives_as_an_array_or_is_missing', async () => {
    const res = await list(
      createFakeClient([
        ok([
          listRow({}, {
            venues: [{ name: 'Annex', location: 'Block C' }],
            event_requests: [{ event_name: 'Gala', status: 'confirmed', assigned_coordinator_id: COORDINATOR_ID }],
          }),
          listRow({ id: OTHER_BOOKING_ID }, { venues: null }),
        ]),
      ]),
    );
    expect(res.body[0]).toMatchObject({ venueName: 'Annex', eventName: 'Gala', eventStatus: 'confirmed' });
    expect(res.body[1]).toMatchObject({ venueName: null, venueLocation: null });
  });

  it('SCRUM255_an_empty_list_is_200_not_404', async () => {
    const res = await list(createFakeClient([ok([])]));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('SCRUM255_a_null_result_is_an_empty_list', async () => {
    const res = await list(createFakeClient([ok(null)]));
    expect(res.body).toEqual([]);
  });
});

describe('SCRUM-255: a coordinator sees only requests on their own events', () => {
  const OTHER_EVENT_ID = '99999999-9999-4999-8999-999999999999';
  const list = (client, options = {}) =>
    request(appWith({ client, ...options })).get('/api/booking-requests/mine');
  const row = (id, assignedTo) => ({
    id,
    event_request_id: EVENT_ID,
    venue_id: VENUE_ID,
    starts_at: START,
    ends_at: END,
    status: 'pending',
    created_at: '2026-10-06T10:00:00+00:00',
    venues: { name: 'Hall A', location: 'Level 2' },
    event_requests: { event_name: 'Event', status: 'approved', assigned_coordinator_id: assignedTo },
  });

  it('SCRUM255_narrows_the_query_to_the_token_user_through_the_events_assignment', async () => {
    const client = createFakeClient([ok([])]);

    await request(appWith({ client }))
      .get('/api/booking-requests/mine')
      .query({ coordinatorId: OTHER_COORDINATOR_ID, assignedCoordinatorId: OTHER_COORDINATOR_ID });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({ table: 'bookings' });
    // The only filter, and it is the caller from the token, never the query string.
    expect(client.calls[0].filters).toEqual([['event_requests.assigned_coordinator_id', COORDINATOR_ID]]);
    // An inner join, so a booking on an unassigned event is not read at all.
    expect(client.calls[0].select).toBeUndefined();
  });

  it('SCRUM255_uses_whoever_is_signed_in_so_each_coordinator_gets_their_own_scope', async () => {
    const mine = createFakeClient([ok([])]);
    const theirs = createFakeClient([ok([])]);

    await list(mine);
    await list(theirs, { requireAuth: signedInWithRole(ROLE.EVENT_COORDINATOR, OTHER_COORDINATOR_ID) });

    expect(mine.calls[0].filters[0][1]).toBe(COORDINATOR_ID);
    expect(theirs.calls[0].filters[0][1]).toBe(OTHER_COORDINATOR_ID);
  });

  it('SCRUM255_drops_a_row_for_another_coordinator_even_if_the_query_filter_failed_open', async () => {
    const client = createFakeClient([
      ok([row(BOOKING_ID, COORDINATOR_ID), row(OTHER_BOOKING_ID, OTHER_COORDINATOR_ID), row(BLOCK_ID, null)]),
    ]);

    const res = await list(client);

    expect(res.body.map((r) => r.id)).toEqual([BOOKING_ID]);
  });

  it('SCRUM255_returns_nothing_when_every_row_belongs_to_someone_else', async () => {
    const res = await list(createFakeClient([ok([row(OTHER_BOOKING_ID, OTHER_COORDINATOR_ID)])]));
    expect(res.body).toEqual([]);
  });

  it('SCRUM255_a_row_with_no_event_embed_is_not_trusted', async () => {
    const res = await list(createFakeClient([ok([{ ...row(BOOKING_ID, COORDINATOR_ID), event_requests: null }])]));
    expect(res.body).toEqual([]);
  });

  it('SCRUM255_orders_newest_first_with_an_id_tiebreak', async () => {
    const client = createFakeClient([ok([])]);
    await list(client);
    expect(client.calls[0].order).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: true }],
    ]);
  });

  it('SCRUM255_returns_401_without_a_token_and_never_queries', async () => {
    const client = createFakeClient([ok([])]);
    const res = await list(client, { requireAuth: signedOut });
    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });

  it.each([ROLE.EVENT_ORGANISER, ROLE.VENUE_STAFF, ROLE.TECHNICAL_SUPPORT_STAFF, ROLE.ATTENDEE, ROLE.EVENT_COORDINATOR_LEAD, ROLE.SAFETY_OFFICER, null])(
    'SCRUM255_refuses_%s_with_403_and_never_queries',
    async (role) => {
      const client = createFakeClient([ok([])]);
      const res = await list(client, { requireAuth: signedInWithRole(role) });
      expect(res.status).toBe(403);
      expect(client.calls).toHaveLength(0);
    },
  );

  it('SCRUM255_a_database_failure_is_a_500_without_the_driver_message', async () => {
    const res = await list(createFakeClient([dbFailure('XX000', 'relation secret_table exploded')]));
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret_table');
  });

  it('SCRUM255_refuses_a_missing_caller_before_the_database', async () => {
    const client = createFakeClient([ok([])]);
    const res = await list(client, {
      requireAuth: (req, _res, next) => {
        req.user = { id: '', role: ROLE.EVENT_COORDINATOR };
        next();
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.details.map((d) => d.field)).toEqual(['coordinatorId']);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM255_the_list_route_does_not_swallow_the_withdraw_route', async () => {
    const client = createFakeClient([ok({ outcome: 'withdrawn', booking: bookingRow({ status: 'withdrawn' }) })]);
    const res = await request(appWith({ client })).post(`/api/booking-requests/${OTHER_EVENT_ID}/withdraw`);
    expect(res.status).toBe(200);
  });
});
describe('SCRUM-258 AC1: Venue Staff see the pending requests', () => {
  const STAFF_ID = '99999999-9999-4999-8999-999999999999';
  const asStaff = signedInWithRole(ROLE.VENUE_STAFF, STAFF_ID);

  /** One element of list_pending_booking_requests (066). */
  const pendingRow = (overrides = {}) => ({
    ...bookingRow(),
    event_name: 'IS212 Industry Night',
    event_status: STATUS.APPROVED,
    venue_name: 'Hall A',
    venue_location: 'Level 1',
    occupied_starts_at: START,
    occupied_ends_at: END,
    overlapping: [],
    ...overrides,
  });

  const listPending = (client, { requireAuth = asStaff, query = '' } = {}) =>
    request(appWith({ client, requireAuth })).get(`/api/booking-requests/pending${query}`);

  it('SCRUM258_AC1_venue_staff_get_200_and_the_queue_in_the_functions_order', async () => {
    const client = createFakeClient([ok([pendingRow(), pendingRow({ id: OTHER_BOOKING_ID })])]);

    const res = await listPending(client);

    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.id)).toEqual([BOOKING_ID, OTHER_BOOKING_ID]);
    expect(res.body[0]).toMatchObject({ eventName: 'IS212 Industry Night', venueName: 'Hall A', status: 'pending', overlapping: [] });
  });

  it('SCRUM258_AC1_an_empty_queue_is_200_not_404', async () => {
    const res = await listPending(createFakeClient([ok([])]));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('SCRUM258_AC1_the_caller_is_the_token_user_never_the_query', async () => {
    const client = createFakeClient([ok([])]);

    await listPending(client, { query: `?p_caller=${COORDINATOR_ID}&callerId=${COORDINATOR_ID}` });

    expect(client.calls).toEqual([
      expect.objectContaining({ operation: 'rpc', fn: 'list_pending_booking_requests', args: { p_caller: STAFF_ID } }),
    ]);
  });

  it('SCRUM258_AC1_returns_401_without_a_token_and_never_queries', async () => {
    const client = createFakeClient([ok([])]);
    const res = await listPending(client, { requireAuth: signedOut });
    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });

  it.each([ROLE.EVENT_COORDINATOR, ROLE.EVENT_ORGANISER, ROLE.EVENT_COORDINATOR_LEAD, ROLE.TECHNICAL_SUPPORT_STAFF, ROLE.SAFETY_OFFICER, ROLE.ATTENDEE, null])(
    'SCRUM258_AC1_refuses_%s_with_403_and_never_queries',
    async (role) => {
      const client = createFakeClient([ok([])]);
      const res = await listPending(client, { requireAuth: signedInWithRole(role) });
      expect(res.status).toBe(403);
      expect(client.calls).toHaveLength(0);
    },
  );

  it('SCRUM258_AC1_a_refusal_from_the_function_is_403', async () => {
    const res = await listPending(createFakeClient([dbFailure('42501', 'only Venue Staff can view pending booking requests')]));
    expect(res.status).toBe(403);
  });
});

describe('SCRUM-258 AC2-AC6: Venue Staff approve or reject a request', () => {
  const STAFF_ID = '99999999-9999-4999-8999-999999999999';
  const asStaff = signedInWithRole(ROLE.VENUE_STAFF, STAFF_ID);

  /** decide_booking_request's answer (066) for a decided request. */
  const decided = (status, overrides = {}) =>
    ok({
      outcome: status,
      booking: bookingRow({ status, decided_by: STAFF_ID, decided_at: '2026-10-14T02:00:00+00:00', ...overrides }),
    });

  const decide = (client, action, { body, requireAuth = asStaff, id = BOOKING_ID } = {}) => {
    const req = request(appWith({ client, requireAuth })).post(`/api/booking-requests/${id}/${action}`);
    return body === undefined ? req : req.send(body);
  };

  it('SCRUM258_AC6_approve_is_200_with_who_decided_and_the_caller_from_the_token', async () => {
    const client = createFakeClient([decided('approved')]);

    const res = await decide(client, 'approve', { body: { p_caller: COORDINATOR_ID, reason: 'ok' } });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: BOOKING_ID, status: 'approved', decidedBy: STAFF_ID, decidedAt: '2026-10-14T02:00:00+00:00' });
    expect(client.calls).toEqual([
      expect.objectContaining({
        fn: 'decide_booking_request',
        args: { p_booking_id: BOOKING_ID, p_caller: STAFF_ID, p_decision: 'approve', p_reason: null, p_suggested_alternative: null },
      }),
    ]);
  });

  it('SCRUM258_AC3_approve_is_200_with_the_requests_it_marked_conflicting', async () => {
    const client = createFakeClient([
      ok({
        outcome: 'approved',
        booking: bookingRow({ status: 'approved', decided_by: STAFF_ID, decided_at: '2026-10-14T02:00:00+00:00' }),
        marked_conflicting: [OTHER_BOOKING_ID],
      }),
    ]);

    const res = await decide(client, 'approve');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'approved', markedConflicting: [OTHER_BOOKING_ID] });
  });

  it('SCRUM258_Week7_approve_is_200_with_the_hold_it_converted', async () => {
    const HOLD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const client = createFakeClient([
      ok({
        outcome: 'approved',
        booking: bookingRow({ status: 'approved', decided_by: STAFF_ID, decided_at: '2026-10-14T02:00:00+00:00' }),
        marked_conflicting: [],
        converted_hold_id: HOLD_ID,
      }),
    ]);

    const res = await decide(client, 'approve');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'approved', convertedHoldId: HOLD_ID });
  });

  it('SCRUM258_AC4_reject_is_200_with_the_reason_and_alternative_and_the_caller_from_the_token', async () => {
    const client = createFakeClient([
      decided('rejected', { decision_reason: 'Double-booked', suggested_alternative: 'Hall B' }),
    ]);

    const res = await decide(client, 'reject', {
      body: { reason: 'Double-booked', suggestedAlternative: 'Hall B', callerId: COORDINATOR_ID },
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'rejected', decisionReason: 'Double-booked', suggestedAlternative: 'Hall B' });
    expect(client.calls[0].args).toMatchObject({ p_caller: STAFF_ID, p_decision: 'reject', p_reason: 'Double-booked' });
  });

  it.each([{}, { reason: '   ' }, undefined])('SCRUM258_AC4_reject_with_body_%j_is_400_and_never_queries', async (body) => {
    const client = createFakeClient([decided('rejected')]);

    const res = await decide(client, 'reject', { body });

    expect(res.status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });

  it.each(['approve', 'reject'])('SCRUM258_AC6_%s_returns_401_without_a_token_and_never_queries', async (action) => {
    const client = createFakeClient([decided('approved')]);
    const res = await decide(client, action, { body: { reason: 'No' }, requireAuth: signedOut });
    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });

  it.each([ROLE.EVENT_COORDINATOR, ROLE.EVENT_ORGANISER, ROLE.EVENT_COORDINATOR_LEAD, ROLE.TECHNICAL_SUPPORT_STAFF, ROLE.SAFETY_OFFICER, ROLE.ATTENDEE, null])(
    'SCRUM258_AC6_refuses_%s_with_403_on_both_and_never_queries',
    async (role) => {
      const client = createFakeClient([decided('approved'), decided('rejected')]);
      const requireAuth = signedInWithRole(role);
      expect((await decide(client, 'approve', { requireAuth })).status).toBe(403);
      expect((await decide(client, 'reject', { body: { reason: 'No' }, requireAuth })).status).toBe(403);
      expect(client.calls).toHaveLength(0);
    },
  );

  it('SCRUM258_AC6_a_refusal_from_the_function_is_403', async () => {
    const res = await decide(createFakeClient([dbFailure('42501', 'only Venue Staff can decide a booking request')]), 'approve');
    expect(res.status).toBe(403);
  });

  it.each(['BOOKING_NOT_PENDING', 'EVENT_NOT_BOOKABLE', 'BOOKING_PERIOD_STALE', 'VENUE_RETIRED'])(
    'SCRUM258_AC5_a_%s_refusal_is_409_with_its_code',
    async (hint) => {
      const res = await decide(createFakeClient([dbFailure('PT409', 'refused', { hint })]), 'approve');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe(hint);
    },
  );

  it('SCRUM258_AC2_an_occupied_period_is_409_BOOKING_PERIOD_CONFLICT_with_what_occupies_it', async () => {
    const conflict = {
      kind: 'booking',
      booking_id: OTHER_BOOKING_ID,
      event_request_id: '12121212-1212-4212-8212-121212121212',
      event_name: 'Careers Fair',
      starts_at: START,
      ends_at: END,
      occupied_starts_at: START,
      occupied_ends_at: END,
      setup_minutes: 0,
      turnaround_minutes: 0,
    };
    const res = await decide(createFakeClient([ok({ outcome: 'conflict', conflicts: [conflict] })]), 'approve');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BOOKING_PERIOD_CONFLICT');
    expect(res.body.conflicts).toEqual([expect.objectContaining({ kind: 'booking', bookingId: OTHER_BOOKING_ID, eventName: 'Careers Fair' })]);
  });
});
