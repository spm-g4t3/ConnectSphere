/**
 * Tests for the booking request route.
 *
 * SCRUM-252, a subtask of SCRUM-243 (Submit a Venue Booking Request).
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
const UNSUITABLE = {
  suitable: false,
  criteria: [
    { criterion: 'capacity', met: false, detail: 'Capacity 80 < expected attendance 150' },
    { criterion: 'facilities', met: true },
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
    venue_requirements: 'Tiered seating',
    accessibility_requirements: 'Step-free entrance',
    setup_notes: 'Extra tables',
    suitability_result: SUITABLE,
    suitability_overridden: false,
    created_at: '2026-10-06T10:00:00+00:00',
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
        maybeSingle: () => settle(call),
        single: () => settle(call),
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
      venueRequirements: 'Tiered seating',
      accessibilityRequirements: 'Step-free entrance',
      setupNotes: 'Extra tables',
      suitability: SUITABLE,
      suitabilityOverridden: false,
      requestedBy: COORDINATOR_ID,
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
    });
    expect(checkSuitability).toHaveBeenCalledWith({
      eventRequestId: EVENT_ID,
      venueId: VENUE_ID,
      roomLayoutCode: 'theatre',
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

  it.each([ROLE.EVENT_ORGANISER, ROLE.VENUE_STAFF, ROLE.TECHNICAL_SUPPORT_STAFF, ROLE.ATTENDEE])(
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


describe('SCRUM-252: one live request per event', () => {
  it.each([
    ['a pending or approved request', 'BOOKING_REQUEST_EXISTS'],
    ['a booking flagged for review', 'BOOKING_FLAGGED_FOR_REVIEW'],
  ])('SCRUM252_refuses_an_event_with_%s_and_names_it', async (_label, hint) => {
    const res = await post(
      clientFor(dbFailure('PT409', 'the event already has one', { hint, details: OTHER_BOOKING_ID })),
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


describe('SCRUM-252: the suitability check (N10)', () => {
  it('SCRUM252_warns_and_requires_confirmation_when_the_venue_is_not_suitable', async () => {
    const client = clientFor(ok({ outcome: 'suitability_confirmation_required', suitability: UNSUITABLE }));

    const res = await post(client, BODY, { checkSuitability: vi.fn(async () => UNSUITABLE) });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SUITABILITY_CONFIRMATION_REQUIRED');
    // Only the criteria that were not met.
    expect(res.body.conflicts).toEqual([UNSUITABLE.criteria[0]]);
    expect(rpcCall(client).args).toMatchObject({ p_suitability: UNSUITABLE, p_confirm_unsuitable: false });
  });

  it('SCRUM252_submits_once_the_coordinator_confirms', async () => {
    const client = clientFor(created({ suitability_result: UNSUITABLE, suitability_overridden: true }));

    const res = await post(client, { ...BODY, confirmUnsuitable: true }, {
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
    const client = clientFor(ok({ outcome: 'suitability_confirmation_required', suitability: UNSUITABLE }));

    await post(client, { ...BODY, suitable: true, suitability: SUITABLE }, { checkSuitability });

    expect(rpcCall(client).args.p_suitability).toEqual(UNSUITABLE);
  });

  it('SCRUM252_fails_closed_with_503_until_N10_exists', async () => {
    const client = createFakeClient([ok(eventRow())]);

    // No checkSuitability supplied: the router falls back to the real default.
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

    expect(res.status).toBe(503);
    expect(client.calls.map((c) => c.operation)).toEqual(['select']);
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
