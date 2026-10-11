/**
 * Tests for the venue suitability route.
 *
 * SCRUM-190, a subtask of SCRUM-188 (Check Venue Suitability for an Event).
 * Named SCRUM188_ACn_<what>. These are about transport and authorisation: the
 * route exists where app.js mounts it, only Event Coordinators reach it, the
 * query string is parsed into what the check takes, the caller is the token's
 * and never the query's, and each failure answers its status.
 *
 * Most tests inject a fake checker, so what is proved is the route alone. The
 * last block runs the real check over a fake client, end to end, so the
 * statuses the service raises are proved to reach the client as documented.
 * What the check decides is tests/services/venueSuitabilityService.test.js's.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// The real check loads venueService.js, which imports the Supabase client
// statically and throws without a .env. Every query goes to the injected
// fake; this only lets the module load.
vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: {}, supabaseAdmin: {}, default: {} }));

const { createVenueSuitabilityRouter } = await import('../../src/routes/venueSuitability.js');
const { ROLE } = await import('../../src/domain/userRole.js');
const { ForbiddenError, NotFoundError, ConflictError, ValidationError } = await import(
  '../../src/errors.js'
);

const COORDINATOR = '55555555-5555-4555-8555-555555555555';
const SOMEONE_ELSE = '66666666-6666-4666-8666-666666666666';
const EVENT = '22222222-2222-4222-8222-222222222222';
const VENUE = '33333333-3333-4333-8333-333333333333';

const BASE = `/api/event-requests/${EVENT}/venue-suitability`;

const SUITABLE = {
  suitable: true,
  criteria: [{ criterion: 'Capacity', met: true, detail: 'Capacity 150 ≥ expected attendance 120' }],
  checked: { startsAt: 'a', endsAt: 'b', expectedAttendance: 120, layout: null, accessibility: [], facilities: [] },
};
const NOT_SUITABLE = {
  suitable: false,
  criteria: [{ criterion: 'Capacity', met: false, detail: 'Capacity 80 < expected attendance 120' }],
  checked: SUITABLE.checked,
};

const signedInAs = (role, id = COORDINATOR) => (req, _res, next) => {
  req.user = { id, email: 'someone@example.com', role };
  next();
};
const signedOut = (_req, res) => res.status(401).json({ error: 'Authentication required' });

/** An app with the router mounted where app.js mounts it. */
function appWith({
  requireAuth = signedInAs(ROLE.EVENT_COORDINATOR),
  checkSuitability = vi.fn(async () => SUITABLE),
  client = { marker: 'fake client' },
} = {}) {
  return express()
    .use(express.json())
    .use(
      '/api/event-requests/:id/venue-suitability',
      createVenueSuitabilityRouter({ requireAuth, client, checkSuitability }),
    );
}

const get = (query, options) => request(appWith(options)).get(BASE).query(query);

const OTHER_ROLES = [
  ROLE.EVENT_ORGANISER,
  ROLE.VENUE_STAFF,
  ROLE.TECHNICAL_SUPPORT_STAFF,
  ROLE.ATTENDEE,
  ROLE.EVENT_COORDINATOR_LEAD,
  ROLE.SAFETY_OFFICER,
];


describe('SCRUM188_AC1 only Event Coordinators reach the check', () => {
  it.each(OTHER_ROLES)('SCRUM188_AC1_refuses_%s_with_403_and_runs_no_check', async (role) => {
    const checkSuitability = vi.fn(async () => SUITABLE);
    const res = await get({ venueId: VENUE }, { requireAuth: signedInAs(role), checkSuitability });
    expect(res.status).toBe(403);
    expect(checkSuitability).not.toHaveBeenCalled();
  });

  it('SCRUM188_AC1_signed_out_is_401_and_runs_no_check', async () => {
    const checkSuitability = vi.fn(async () => SUITABLE);
    const res = await get({ venueId: VENUE }, { requireAuth: signedOut, checkSuitability });
    expect(res.status).toBe(401);
    expect(checkSuitability).not.toHaveBeenCalled();
  });

  it('SCRUM188_AC1_a_coordinator_not_assigned_to_the_event_gets_the_services_403', async () => {
    const res = await get(
      { venueId: VENUE },
      { checkSuitability: vi.fn(async () => { throw new ForbiddenError('Not your event'); }) },
    );
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Not your event' });
  });
});


describe('SCRUM188_AC2 the query string becomes the check', () => {
  it('SCRUM188_AC2_answers_200_with_the_result', async () => {
    const res = await get({ venueId: VENUE });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(SUITABLE);
  });

  it('SCRUM188_AC2_not_suitable_is_still_200_because_it_is_an_answer', async () => {
    const res = await get({ venueId: VENUE }, { checkSuitability: vi.fn(async () => NOT_SUITABLE) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(NOT_SUITABLE);
  });

  it('SCRUM188_AC2_passes_the_event_venue_codes_caller_and_client', async () => {
    const checkSuitability = vi.fn(async () => SUITABLE);
    const client = { marker: 'this one' };
    await request(appWith({ checkSuitability, client }))
      .get(`/api/event-requests/${EVENT.toUpperCase()}/venue-suitability`)
      .query({
        venueId: ` ${VENUE.toUpperCase()} `,
        layout: ' theatre ',
        accessibility: 'wheelchair_access, hearing_loop',
        facilities: 'projector,,wifi,',
      });
    expect(checkSuitability).toHaveBeenCalledWith({
      eventRequestId: EVENT,
      venueId: VENUE,
      roomLayoutCode: 'theatre',
      accessibility: ['wheelchair_access', 'hearing_loop'],
      facilities: ['projector', 'wifi'],
      userId: COORDINATOR,
      client,
    });
  });

  it('SCRUM188_AC2_a_repeated_code_key_is_read_like_a_comma_list', async () => {
    const checkSuitability = vi.fn(async () => SUITABLE);
    await request(appWith({ checkSuitability })).get(
      `${BASE}?venueId=${VENUE}&facilities=projector&facilities=wifi,stage`,
    );
    expect(checkSuitability.mock.calls[0][0].facilities).toEqual(['projector', 'wifi', 'stage']);
  });

  it('SCRUM188_AC2_no_codes_and_a_blank_layout_are_none_asked_for', async () => {
    const checkSuitability = vi.fn(async () => SUITABLE);
    await get({ venueId: VENUE, layout: '', accessibility: '', facilities: ' , ' }, { checkSuitability });
    expect(checkSuitability.mock.calls[0][0]).toMatchObject({
      roomLayoutCode: null,
      accessibility: [],
      facilities: [],
    });
  });

  it('SCRUM188_AC2_the_period_attendance_and_caller_cannot_be_chosen_in_the_query', async () => {
    const checkSuitability = vi.fn(async () => SUITABLE);
    await get(
      {
        venueId: VENUE,
        startsAt: '2030-01-01T00:00:00Z',
        endsAt: '2030-01-02T00:00:00Z',
        expectedAttendance: '5',
        userId: SOMEONE_ELSE,
      },
      { checkSuitability },
    );
    const input = checkSuitability.mock.calls[0][0];
    expect(input.userId).toBe(COORDINATOR);
    expect(Object.keys(input).sort()).toEqual(
      ['accessibility', 'client', 'eventRequestId', 'facilities', 'roomLayoutCode', 'userId', 'venueId'],
    );
  });
});


describe('SCRUM188_AC1 bad input is 400 before any check', () => {
  it.each([
    ['no venue', {}, [{ field: 'venueId', message: 'is required' }]],
    ['a malformed venue', { venueId: 'nope' }, [{ field: 'venueId', message: 'must be a valid venue id' }]],
    [
      'a malformed layout',
      { venueId: VENUE, layout: 'Theatre Style' },
      [{ field: 'layout', message: 'must be a room layout code, such as theatre or u_shape' }],
    ],
  ])('SCRUM188_AC1_%s_is_400', async (_label, query, details) => {
    const checkSuitability = vi.fn(async () => SUITABLE);
    const res = await get(query, { checkSuitability });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(details);
    expect(checkSuitability).not.toHaveBeenCalled();
  });

  it('SCRUM188_AC1_a_malformed_event_id_in_the_path_is_400', async () => {
    const checkSuitability = vi.fn(async () => SUITABLE);
    const res = await request(appWith({ checkSuitability }))
      .get('/api/event-requests/not-an-id/venue-suitability')
      .query({ venueId: VENUE });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'eventRequestId', message: 'must be a valid event id' }]);
    expect(checkSuitability).not.toHaveBeenCalled();
  });

  it('SCRUM188_AC1_two_layouts_are_refused_since_an_event_has_one', async () => {
    const res = await request(appWith()).get(`${BASE}?venueId=${VENUE}&layout=theatre&layout=banquet`);
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'layout', message: 'must be a single layout code' }]);
  });
});


describe('SCRUM188_AC1 what the check raises reaches the client', () => {
  it.each([
    ['an unknown code', new ValidationError('Invalid suitability check -- facilities: unknown code "x"', [
      { field: 'facilities', message: 'unknown code "x"' },
    ]), 400, { details: [{ field: 'facilities', message: 'unknown code "x"' }] }],
    ['an unknown event or venue', new NotFoundError('Venue not found'), 404, { error: 'Venue not found' }],
    ['an event with no dates', new ConflictError('No dates', { code: 'EVENT_DATES_MISSING' }), 409, {
      code: 'EVENT_DATES_MISSING',
      conflicts: [],
    }],
    ['a retired venue', new ConflictError('Retired', { code: 'VENUE_RETIRED' }), 409, {
      code: 'VENUE_RETIRED',
      conflicts: [],
    }],
  ])('SCRUM188_AC1_%s_answers_its_status', async (_label, error, status, body) => {
    const res = await get({ venueId: VENUE }, { checkSuitability: vi.fn(async () => { throw error; }) });
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject(body);
  });

  it('SCRUM188_AC1_anything_untyped_is_500_without_its_message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await get({ venueId: VENUE }, {
      checkSuitability: vi.fn(async () => { throw new Error('driver detail'); }),
    });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Unexpected server error' });
  });
});


describe('SCRUM188_AC1 end to end over the real check', () => {
  // Wednesday 11 November 2026, 10:00-12:00 in Singapore.
  const eventRow = (overrides = {}) => ({
    id: EVENT,
    organiser_id: '11111111-1111-4111-8111-111111111111',
    event_name: 'Orientation',
    proposed_start: '2026-11-11T10:00:00+08:00',
    proposed_end: '2026-11-11T12:00:00+08:00',
    expected_attendance: 120,
    status: 'approved',
    assigned_coordinator_id: COORDINATOR,
    ...overrides,
  });
  const venueRow = (overrides = {}) => ({
    id: VENUE,
    name: 'Hall A',
    location: 'Level 1',
    max_capacity: 100,
    setup_minutes: 30,
    turnaround_minutes: 45,
    retired_at: null,
    venue_room_layouts: [{ room_layout_code: 'theatre' }],
    venue_accessibility_features: [],
    venue_facilities: [{ facility_code: 'projector' }],
    venue_operating_hours: [{ day_of_week: 3, opens_at: '08:00:00', closes_at: '22:00:00' }],
    ...overrides,
  });

  /** Answers the event, the venue, the code lookups and the occupancy function. */
  function fakeClient({ event = eventRow(), venue = venueRow(), occupancy = [] } = {}) {
    return {
      from(table) {
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: (_column, codes) =>
            Promise.resolve({
              data: codes.filter((code) => code !== 'teleporter').map((code) => ({ code })),
              error: null,
            }),
          maybeSingle: () => Promise.resolve({ data: table === 'event_requests' ? event : venue, error: null }),
        };
        return chain;
      },
      rpc: () => Promise.resolve({ data: occupancy, error: null }),
    };
  }

  const realGet = (query, { client = fakeClient(), requireAuth } = {}) =>
    request(
      express()
        .use(express.json())
        .use(
          '/api/event-requests/:id/venue-suitability',
          createVenueSuitabilityRouter({
            requireAuth: requireAuth ?? signedInAs(ROLE.EVENT_COORDINATOR),
            client,
          }),
        ),
    )
      .get(BASE)
      .query(query);

  it('SCRUM188_AC2_a_venue_too_small_and_booked_is_200_not_suitable_with_six_criteria', async () => {
    const booking = {
      kind: 'booking',
      id: '44444444-4444-4444-8444-444444444444',
      event_request_id: '77777777-7777-4777-8777-777777777777',
      event_name: 'Gala Night',
      reason: null,
      starts_at: '2026-11-11T10:00:00+08:00',
      ends_at: '2026-11-11T12:00:00+08:00',
      occupied_starts_at: '2026-11-11T09:30:00+08:00',
      occupied_ends_at: '2026-11-11T12:45:00+08:00',
      setup_minutes: 30,
      turnaround_minutes: 45,
    };
    const res = await realGet(
      { venueId: VENUE, layout: 'theatre', facilities: 'projector' },
      { client: fakeClient({ occupancy: [booking] }) },
    );
    expect(res.status).toBe(200);
    expect(res.body.suitable).toBe(false);
    expect(res.body.criteria.map((c) => [c.criterion, c.met])).toEqual([
      ['Capacity', false],
      ['Operating hours', true],
      ['Layout', true],
      ['Accessibility', true],
      ['Facilities', true],
      ['Availability', false],
    ]);
    expect(res.body.criteria[5].detail).toBe(
      'Booked for Gala Night 09:30–12:45 on Wed 11 Nov (setup 09:30–10:00, turnaround 12:00–12:45)',
    );
    expect(res.body.checked).toEqual({
      startsAt: '2026-11-11T10:00:00+08:00',
      endsAt: '2026-11-11T12:00:00+08:00',
      expectedAttendance: 120,
      layout: 'theatre',
      accessibility: [],
      facilities: ['projector'],
    });
  });

  it('SCRUM188_AC1_the_assigned_coordinator_rule_is_403', async () => {
    const res = await realGet({ venueId: VENUE }, { requireAuth: signedInAs(ROLE.EVENT_COORDINATOR, SOMEONE_ELSE) });
    expect(res.status).toBe(403);
  });

  it('SCRUM188_AC1_an_unknown_code_is_400', async () => {
    const res = await realGet({ venueId: VENUE, facilities: 'projector,teleporter' });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'facilities', message: 'unknown code "teleporter"' }]);
  });

  it.each([
    ['event', { event: null }],
    ['venue', { venue: null }],
  ])('SCRUM188_AC1_an_unknown_%s_is_404', async (_label, options) => {
    const res = await realGet({ venueId: VENUE }, { client: fakeClient(options) });
    expect(res.status).toBe(404);
  });

  it.each([
    ['EVENT_DATES_MISSING', { event: eventRow({ proposed_end: null }) }],
    ['VENUE_RETIRED', { venue: venueRow({ retired_at: '2026-09-01T00:00:00+00:00' }) }],
  ])('SCRUM188_AC1_%s_is_409', async (code, options) => {
    const res = await realGet({ venueId: VENUE }, { client: fakeClient(options) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(code);
  });
});
