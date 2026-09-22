/**
 * Tests for the venue catalogue routes.
 *
 * SCRUM-15 "Maintain Venue Catalogue Details - Venue Staff".
 *
 * These are the tests that decide whether the story's acceptance criteria are
 * actually met, rather than merely implemented. The service layer has been
 * correct and thoroughly tested since Sprint 1 -- what was missing was any way
 * for a person to reach it, so everything here is about transport and
 * authorisation: the right routes exist, the right roles reach them, and the
 * acting user is the signed-in one rather than whoever the body claims.
 *
 * Acceptance criteria carried in the test names:
 *   AC1 -- a venue can be created with every field, by Venue Staff
 *   AC2 -- an authorised change is saved and reflected in subsequent searches
 *   AC3 -- a venue can be retired, leaves search, and keeps its bookings
 *   AC4 -- every change records the editing user, a timestamp, previous values
 *
 * The mock is a factory rather than automocking, copied from
 * tests/services/venueService.test.js: venueService.js imports
 * config/supabaseClient.js statically and that module throws at import time
 * without credentials, so automocking -- which loads the real module first --
 * would trip exactly the side effect this prevents. The guard test below
 * exists because on a machine with a real .env a failed mock would silently
 * run against live data and still pass.
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
const STAFF_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const ORGANISER_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const RETIRED_AT = '2026-09-15T10:00:00+00:00';


/** The row shape getVenueById selects. */
function venueRow(overrides = {}) {
  return {
    id: VENUE_ID,
    name: 'Seminar Room 2-1',
    location: 'Level 2, SCIS',
    max_capacity: 40,
    retired_at: null,
    created_at: '2026-09-12T09:00:00+00:00',
    updated_at: '2026-09-12T09:00:00+00:00',
    last_modified_by: STAFF_ID,
    venue_room_layouts: [],
    venue_accessibility_features: [],
    venue_facilities: [],
    venue_operating_hours: [],
    ...overrides,
  };
}

/** The same thenable query stub the service tests use. */
function queryStub(result) {
  const calls = [];
  const stub = {
    called: (method) => calls.some(([name]) => name === method),
    args: (method) => calls.find(([name]) => name === method)?.slice(1),
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  for (const method of ['select', 'eq', 'is', 'ilike', 'gte', 'order', 'limit', 'delete']) {
    stub[method] = (...args) => { calls.push([method, ...args]); return stub; };
  }
  stub.maybeSingle = (...args) => { calls.push(['maybeSingle', ...args]); return Promise.resolve(result); };
  return stub;
}

const ok = (data) => ({ data, error: null });

/** Stands in for a signed-in user of a given role. */
const signedInAs = (role, id = STAFF_ID) => (req, _res, next) => {
  req.user = { id, email: 'someone@example.com', role };
  next();
};

/** Stands in for no session, answering as the real middleware does. */
const signedOut = (_req, res) => res.status(401).json({ error: 'Authentication required' });

/** An app with the router mounted where app.js mounts it. */
function appWith(requireAuth = signedInAs(ROLE.VENUE_STAFF)) {
  return express()
    .use(express.json())
    .use('/api/venues', createVenueRouter({ requireAuth }));
}

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
});


describe('the test double', () => {
  it('SCRUM15_the_supabase_client_is_mocked_and_never_the_real_one', () => {
    // Without this, a machine with a real .env would run the whole file
    // against live data and report success.
    expect(vi.isMockFunction(supabase.rpc)).toBe(true);
    expect(vi.isMockFunction(supabase.from)).toBe(true);
  });
});


describe('AC1: a Venue Staff member can create a venue with every field', () => {
  it('SCRUM15_AC1_creates_a_venue_and_answers_201', async () => {
    rpc.mockResolvedValueOnce(ok(VENUE_ID));
    from.mockReturnValueOnce(queryStub(ok(venueRow())));

    const res = await request(appWith()).post('/api/venues').send({
      name: 'Seminar Room 2-1',
      location: 'Level 2, SCIS',
      maxCapacity: 40,
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: VENUE_ID, name: 'Seminar Room 2-1' });
  });

  it('SCRUM15_AC1_forwards_every_field_the_criterion_names', async () => {
    rpc.mockResolvedValueOnce(ok(VENUE_ID));
    from.mockReturnValueOnce(queryStub(ok(venueRow())));

    await request(appWith()).post('/api/venues').send({
      name: 'Hall A',
      location: 'SMU SIS',
      maxCapacity: 200,
      layouts: ['theatre', 'classroom'],
      accessibility: ['step_free_access'],
      facilities: ['projector', 'wifi'],
      hours: [{ day_of_week: 1, opens_at: '09:00', closes_at: '18:00' }],
    });

    const [fn, payload] = rpc.mock.calls[0];
    expect(fn).toBe('create_venue');

    // AC1 names seven things a venue can be created with. All seven reach the
    // database, or the criterion is only half met.
    expect(payload.p_name).toBe('Hall A');
    expect(payload.p_location).toBe('SMU SIS');
    expect(payload.p_max_capacity).toBe(200);
    expect(payload.p_layouts).toEqual(['theatre', 'classroom']);
    expect(payload.p_accessibility).toEqual(['step_free_access']);
    expect(payload.p_facilities).toEqual(['projector', 'wifi']);
    expect(payload.p_hours).toHaveLength(1);
  });

  it('SCRUM15_AC1_reports_a_missing_mandatory_field_as_400_with_details', async () => {
    const res = await request(appWith()).post('/api/venues').send({ location: 'SCIS' });

    expect(res.status).toBe(400);

    // Every gap at once, so a form is fixed in one pass rather than one
    // resubmission per fault.
    expect(res.body.details.map((d) => d.field).sort()).toEqual(['maxCapacity', 'name']);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM15_AC1_rejects_a_capacity_that_is_not_a_positive_whole_number', async () => {
    const res = await request(appWith()).post('/api/venues')
      .send({ name: 'Hall A', location: 'SCIS', maxCapacity: -5 });

    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});


describe('AC2: only an authorised change is accepted, and it reaches the search', () => {
  it('SCRUM15_AC2_saves_an_authorised_change', async () => {
    rpc.mockResolvedValueOnce(ok(null));
    from.mockReturnValueOnce(queryStub(ok(venueRow({ location: 'Level 3, SCIS' }))));

    const res = await request(appWith())
      .patch(`/api/venues/${VENUE_ID}`)
      .send({ location: 'Level 3, SCIS' });

    expect(res.status).toBe(200);
    expect(rpc.mock.calls[0][1].p_location).toBe('Level 3, SCIS');
  });

  it('SCRUM15_AC2_refuses_a_change_from_a_role_that_is_not_venue_staff', async () => {
    const res = await request(appWith(signedInAs(ROLE.EVENT_ORGANISER, ORGANISER_ID)))
      .patch(`/api/venues/${VENUE_ID}`)
      .send({ location: 'Level 3, SCIS' });

    // This is the word "authorised" in AC2, and it must bite before anything
    // is written rather than after.
    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM15_AC2_refuses_an_unauthenticated_change', async () => {
    const res = await request(appWith(signedOut))
      .patch(`/api/venues/${VENUE_ID}`)
      .send({ location: 'Level 3, SCIS' });

    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM15_AC2_a_search_returns_what_the_service_gives_it', async () => {
    from.mockReturnValueOnce(queryStub(ok([
      { id: VENUE_ID, name: 'Seminar Room 2-1', location: 'Level 3, SCIS', max_capacity: 40 },
    ])));

    const res = await request(appWith()).get('/api/venues/search');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: VENUE_ID, name: 'Seminar Room 2-1', location: 'Level 3, SCIS', maxCapacity: 40 },
    ]);
  });

  it('SCRUM15_AC2_lets_a_coordinator_search_even_though_they_may_not_edit', async () => {
    from.mockReturnValueOnce(queryStub(ok([])));

    const res = await request(appWith(signedInAs(ROLE.EVENT_COORDINATOR)))
      .get('/api/venues/search');

    // The briefing has Coordinators searching for venues, so gating reads on
    // Venue Staff would break the feature search exists to serve.
    expect(res.status).toBe(200);
  });
});


describe('AC3: a venue can be retired, leaves search, and keeps its bookings', () => {
  it('SCRUM15_AC3_retires_a_venue_and_returns_it_with_retiredAt_set', async () => {
    rpc.mockResolvedValueOnce(ok(null));
    from.mockReturnValueOnce(queryStub(ok(venueRow({ retired_at: RETIRED_AT }))));

    const res = await request(appWith()).post(`/api/venues/${VENUE_ID}/retire`);

    expect(res.status).toBe(200);
    expect(res.body.retiredAt).toBe(RETIRED_AT);
    expect(rpc.mock.calls[0][0]).toBe('retire_venue');
  });

  it('SCRUM15_AC3_retiring_is_restricted_to_venue_staff', async () => {
    const res = await request(appWith(signedInAs(ROLE.EVENT_ORGANISER, ORGANISER_ID)))
      .post(`/api/venues/${VENUE_ID}/retire`);

    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM15_AC3_answers_409_when_it_was_already_retired', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'PT409', message: 'already retired' } });

    const res = await request(appWith()).post(`/api/venues/${VENUE_ID}/retire`);

    expect(res.status).toBe(409);
  });

  it('SCRUM15_AC3_answers_404_for_a_venue_that_does_not_exist', async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'P0002', message: 'venue not found' },
    });

    const res = await request(appWith()).post(`/api/venues/${VENUE_ID}/retire`);

    expect(res.status).toBe(404);
  });

  it('SCRUM15_AC3_rejects_a_malformed_id_before_any_database_call', async () => {
    const res = await request(appWith()).post('/api/venues/not-a-uuid/retire');

    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM15_AC3_a_retired_venue_is_still_readable_by_id', async () => {
    from.mockReturnValueOnce(queryStub(ok(venueRow({ retired_at: RETIRED_AT }))));

    const res = await request(appWith()).get(`/api/venues/${VENUE_ID}`);

    // Retirement is a soft delete. If this 404'd, it would be a delete under
    // another name and the rest of AC3 could not hold.
    expect(res.status).toBe(200);
    expect(res.body.retiredAt).toBe(RETIRED_AT);
  });

  it('SCRUM15_AC3_a_retired_venues_bookings_remain_viewable', async () => {
    from.mockReturnValueOnce(queryStub(ok([
      {
        id: 'b1', venue_id: VENUE_ID, event_request_id: EVENT_ID,
        starts_at: '2026-06-01T09:00:00+00:00', ends_at: '2026-06-01T17:00:00+00:00',
        created_at: '2026-05-01T09:00:00+00:00',
      },
    ])));

    const res = await request(appWith()).get(`/api/venues/${VENUE_ID}/bookings`);

    // The clause retirement exists to protect. Nothing here filters on the
    // venue's retired_at, and that is deliberate.
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{
      id: 'b1', venueId: VENUE_ID, eventRequestId: EVENT_ID,
      startsAt: '2026-06-01T09:00:00+00:00', endsAt: '2026-06-01T17:00:00+00:00',
      createdAt: '2026-05-01T09:00:00+00:00',
    }]);
  });

  it('SCRUM15_AC3_a_venue_with_no_bookings_answers_an_empty_list', async () => {
    from.mockReturnValueOnce(queryStub(ok([])));

    const res = await request(appWith()).get(`/api/venues/${VENUE_ID}/bookings`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});


describe('AC4: the editing user, the timestamp and the previous values are readable', () => {
  it('SCRUM15_AC4_records_the_signed_in_user_as_the_editor', async () => {
    rpc.mockResolvedValueOnce(ok(VENUE_ID));
    from.mockReturnValueOnce(queryStub(ok(venueRow())));

    await request(appWith()).post('/api/venues')
      .send({ name: 'Hall A', location: 'SCIS', maxCapacity: 10 });

    // The change that finally makes changed_by real. It had been NULL on every
    // audit row ever written, so "records the editing user" was never met.
    expect(rpc.mock.calls[0][1].p_user_id).toBe(STAFF_ID);
  });

  it('SCRUM15_AC4_never_lets_the_body_name_a_different_editor', async () => {
    rpc.mockResolvedValueOnce(ok(VENUE_ID));
    from.mockReturnValueOnce(queryStub(ok(venueRow())));

    await request(appWith()).post('/api/venues').send({
      name: 'Hall A', location: 'SCIS', maxCapacity: 10,
      userId: '00000000-0000-4000-8000-000000000000',
    });

    expect(rpc.mock.calls[0][1].p_user_id).toBe(STAFF_ID);
  });

  it('SCRUM15_AC4_a_body_of_only_userId_is_not_treated_as_a_change', async () => {
    const res = await request(appWith())
      .patch(`/api/venues/${VENUE_ID}`)
      .send({ userId: STAFF_ID });

    // Without stripping it, this passes validateUpdateVenue's "no changes
    // supplied" guard and sends all-nulls into update_venue.
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM15_AC4_serves_the_history_newest_first_with_previous_values', async () => {
    from.mockReturnValueOnce(queryStub(ok([
      {
        id: 'h2', venue_id: VENUE_ID, changed_by: STAFF_ID,
        changed_at: '2026-09-15T10:00:00+00:00',
        old_values: { max_capacity: 40 }, new_values: { max_capacity: 60 },
      },
      {
        id: 'h1', venue_id: VENUE_ID, changed_by: null,
        changed_at: '2026-09-12T09:00:00+00:00',
        old_values: {}, new_values: { name: 'Seminar Room 2-1' },
      },
    ])));

    const res = await request(appWith()).get(`/api/venues/${VENUE_ID}/history`);

    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual({
      id: 'h2', venueId: VENUE_ID, changedBy: STAFF_ID,
      changedAt: '2026-09-15T10:00:00+00:00',
      oldValues: { max_capacity: 40 }, newValues: { max_capacity: 60 },
    });

    // An empty oldValues is how a creation is recorded -- the row did not
    // exist before, so there is no previous value to name.
    expect(res.body[1].oldValues).toEqual({});
  });

  it('SCRUM15_AC4_the_audit_trail_is_restricted_to_venue_staff', async () => {
    const res = await request(appWith(signedInAs(ROLE.EVENT_ORGANISER, ORGANISER_ID)))
      .get(`/api/venues/${VENUE_ID}/history`);

    // It names who changed what, so it is not something every signed-in user
    // should be able to read.
    expect(res.status).toBe(403);
  });
});


describe('routing and query handling', () => {
  it('SCRUM15_AC2_search_is_not_swallowed_by_the_id_route', async () => {
    const stub = queryStub(ok([]));
    from.mockReturnValueOnce(stub);

    const res = await request(appWith()).get('/api/venues/search');

    expect(res.status).toBe(200);

    // If /:id matched first, this would be a single-venue read filtered on
    // id = 'search', which is a uuid cast error and a 500.
    expect(stub.called('is')).toBe(true);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('SCRUM15_AC2_converts_minCapacity_from_the_query_string_to_a_number', async () => {
    const stub = queryStub(ok([]));
    from.mockReturnValueOnce(stub);

    await request(appWith()).get('/api/venues/search?minCapacity=100');

    // Query parameters are strings and checkCapacity requires a real number,
    // so without the conversion this whole filter is unusable over HTTP.
    expect(stub.args('gte')).toEqual(['max_capacity', 100]);
  });

  it('SCRUM15_AC2_rejects_a_minCapacity_that_is_not_a_number', async () => {
    const res = await request(appWith()).get('/api/venues/search?minCapacity=abc');

    expect(res.status).toBe(400);
  });

  it('SCRUM15_AC2_rejects_a_fractional_minCapacity', async () => {
    const res = await request(appWith()).get('/api/venues/search?minCapacity=12.5');

    expect(res.status).toBe(400);
  });

  it('SCRUM15_AC2_treats_a_blank_minCapacity_as_no_filter_rather_than_zero', async () => {
    const stub = queryStub(ok([]));
    from.mockReturnValueOnce(stub);

    const res = await request(appWith()).get('/api/venues/search?minCapacity=');

    // An empty search box must not become "at least 0 people", which is a
    // filter the user never asked for.
    expect(res.status).toBe(200);
    expect(stub.called('gte')).toBe(false);
  });

  it('SCRUM15_AC2_passes_a_location_filter_through', async () => {
    const stub = queryStub(ok([]));
    from.mockReturnValueOnce(stub);

    await request(appWith()).get('/api/venues/search?location=SCIS');

    expect(stub.args('ilike')).toEqual(['location', '%SCIS%']);
  });

  it('SCRUM15_AC1_answers_400_rather_than_500_for_a_malformed_id', async () => {
    const res = await request(appWith()).get('/api/venues/not-a-uuid');

    // getVenueById is the one service function that does not validate its own
    // id, so without the route doing it a bad uuid reaches Postgres as a cast
    // error and surfaces as an untyped 500.
    expect(res.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM15_AC1_requires_authentication_on_every_route', async () => {
    const app = appWith(signedOut);

    for (const [method, path] of [
      ['get', '/api/venues/search'],
      ['get', `/api/venues/${VENUE_ID}`],
      ['get', `/api/venues/${VENUE_ID}/bookings`],
      ['get', `/api/venues/${VENUE_ID}/history`],
      ['post', '/api/venues'],
      ['patch', `/api/venues/${VENUE_ID}`],
      ['post', `/api/venues/${VENUE_ID}/retire`],
    ]) {
      const res = await request(app)[method](path);
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(401);
    }
  });
});


describe('service errors are translated into HTTP status codes', () => {
  it('SCRUM15_AC1_maps_an_unknown_lookup_code_to_400', async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '23503', message: 'violates foreign key constraint' },
    });

    const res = await request(appWith()).post('/api/venues')
      .send({ name: 'Hall A', location: 'SCIS', maxCapacity: 10, facilities: ['teleporter'] });

    expect(res.status).toBe(400);
  });

  it('SCRUM15_AC1_maps_an_untyped_error_to_500_without_leaking_it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42P01', message: 'relation "venues" does not exist' },
    });

    const res = await request(appWith()).post('/api/venues')
      .send({ name: 'Hall A', location: 'SCIS', maxCapacity: 10 });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Unexpected server error' });
    expect(JSON.stringify(res.body)).not.toMatch(/relation/);

    consoleError.mockRestore();
  });
});
