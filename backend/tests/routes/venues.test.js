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

// SCRUM-140: three service functions are wrapped in vi.fn so the event-search
// tests at the bottom can see what the route called. Each wrapper calls the
// real function unless a test scripts otherwise, so every other test in this
// file still runs the real service against the mocked supabase client.
vi.mock('../../src/services/venueService.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    findVenuesForEvent: vi.fn(real.findVenuesForEvent),
    getVenueById: vi.fn(real.getVenueById),
    searchVenues: vi.fn(real.searchVenues),
  };
});

const { createVenueRouter } = await import('../../src/routes/venues.js');
const { supabase } = await import('../../src/config/supabaseClient.js');
const { ROLE } = await import('../../src/domain/userRole.js');
const { ValidationError } = await import('../../src/errors.js');
const serviceSpies = await import('../../src/services/venueService.js');
const realService = await vi.importActual('../../src/services/venueService.js');


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

/**
 * The row shape listVenues selects: flat, no join tables, plus retired_at.
 *
 * Deliberately not venueRow with the joins deleted. listVenues reads a
 * narrower select than getVenueById on purpose (four join tables per venue
 * across the whole catalogue is a far heavier query for data no listing row
 * renders), so a fixture that carried them would let a listing accidentally
 * built on getVenueById's select pass these tests.
 */
function catalogueRow(overrides = {}) {
  return {
    id: VENUE_ID,
    name: 'Seminar Room 2-1',
    location: 'Level 2, SCIS',
    max_capacity: 40,
    retired_at: null,
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
  // SCRUM-179: 'in' added for the calendar's bookings status filter.
  for (const method of ['select', 'eq', 'is', 'in', 'ilike', 'gte', 'order', 'limit', 'delete', 'lt', 'gt', 'lte', 'not']) {
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

  // SCRUM-110. The last clause of AC3 read from the staff side: retirement
  // takes a venue out of search, so the people who retire them need one list
  // that still holds it. GET /api/venues is that list, and it is the only
  // read in this API that returns a retired venue -- which is why every test
  // below is as much about the role gate as about the rows.

  it('SCRUM15_AC3_the_staff_catalogue_lists_retired_and_active_venues_together', async () => {
    const ARCHIVED_ID = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
    from.mockReturnValueOnce(queryStub(ok([
      catalogueRow(),
      catalogueRow({
        id: ARCHIVED_ID,
        name: 'Seminar Room 3-1',
        location: 'Level 3, SCIS',
        max_capacity: 30,
        retired_at: RETIRED_AT,
      }),
    ])));

    const res = await request(appWith()).get('/api/venues');

    expect(res.status).toBe(200);

    // Both rows, over the wire, in camelCase. The retired one being present
    // is the feature; the active one carrying `retiredAt: null` rather than
    // omitting the key is what lets the dashboard badge it Active instead of
    // reading undefined and guessing.
    expect(res.body).toEqual([
      {
        id: VENUE_ID,
        name: 'Seminar Room 2-1',
        location: 'Level 2, SCIS',
        maxCapacity: 40,
        retiredAt: null,
      },
      {
        id: ARCHIVED_ID,
        name: 'Seminar Room 3-1',
        location: 'Level 3, SCIS',
        maxCapacity: 30,
        retiredAt: RETIRED_AT,
      },
    ]);
  });

  it('SCRUM15_AC3_the_catalogue_never_filters_on_retired_at', async () => {
    const stub = queryStub(ok([catalogueRow({ retired_at: RETIRED_AT })]));
    from.mockReturnValueOnce(stub);

    const res = await request(appWith()).get('/api/venues');

    expect(res.status).toBe(200);

    // The assertion the story turns on, asserted again here at the transport
    // layer rather than trusted from the service tests: this route is the one
    // place a later change could quietly swap listVenues for searchVenues --
    // both return an array of venues and the status would stay 200 -- and the
    // catalogue would lose exactly the rows it exists to show. `is` is what
    // searchVenues uses for .is('retired_at', null), so its absence is the
    // proof no such filter was applied.
    expect(stub.called('is')).toBe(false);
  });

  it('SCRUM15_AC3_the_staff_catalogue_is_restricted_to_venue_staff', async () => {
    const res = await request(appWith(signedInAs(ROLE.EVENT_ORGANISER, ORGANISER_ID)))
      .get('/api/venues');

    // SCRUM-111's invariant is that a retired venue never reaches a list a
    // non-staff caller can obtain. This route returns retired venues, so
    // without the gate it is a back door straight around that invariant and
    // /search stops being the only venue list an Organiser can get.
    expect(res.status).toBe(403);

    // And the gate must bite before the query, not after it: a 403 served
    // from a response that was fetched anyway still ran the read, and the
    // rows would be one logging or error-handling change away from leaking.
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM15_AC3_an_empty_catalogue_answers_an_empty_list', async () => {
    from.mockReturnValueOnce(queryStub(ok([])));

    const res = await request(appWith()).get('/api/venues');

    // A deployment with no venues is a normal state, not an error, and the
    // dashboard renders its own empty message from [] -- a 404 or a null body
    // here would turn a fresh environment into a broken-looking one.
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('SCRUM15_AC3_listing_is_a_collection_read_not_a_read_by_id', async () => {
    const stub = queryStub(ok([catalogueRow()]));
    from.mockReturnValueOnce(stub);

    const res = await request(appWith()).get('/api/venues');

    expect(res.status).toBe(200);

    // GET / is declared above GET /:id, and this proves the request did not
    // fall through to it: /:id ends in .maybeSingle(), which would have made
    // this a single-venue read with id === '' -- a uuid cast error and a 500,
    // or worse a 200 carrying one object where the client expects an array.
    expect(stub.called('maybeSingle')).toBe(false);
    expect(Array.isArray(res.body)).toBe(true);
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
      ['get', '/api/venues'],
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


describe('SCRUM-17 venue block routes', () => {
  const BLOCK_ID = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
  const OTHER_BLOCK_ID = '6ba7b811-9dad-41d1-80b4-00c04fd430c8';
  const BOOKING_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const FORGED_ID = '00000000-0000-4000-8000-000000000000';
  const BASE = `/api/venues/${VENUE_ID}/blocks`;
  const ONE = `${BASE}/${BLOCK_ID}`;

  /** Far enough ahead that the real clock never makes it "past". */
  const FUTURE_START = '2099-10-01T09:00:00+08:00';
  const FUTURE_END = '2099-10-01T17:00:00+08:00';

  function blockRow(overrides = {}) {
    return {
      id: BLOCK_ID,
      venue_id: VENUE_ID,
      starts_at: '2099-10-01T01:00:00+00:00',
      ends_at: '2099-10-01T09:00:00+00:00',
      reason: 'maintenance',
      notes: null,
      created_by: STAFF_ID,
      last_modified_by: STAFF_ID,
      created_at: '2026-09-23T00:00:00+00:00',
      updated_at: '2026-09-23T00:00:00+00:00',
      removed_at: null,
      removed_by: null,
      ...overrides,
    };
  }

  const CAMEL_BLOCK = {
    id: BLOCK_ID,
    venueId: VENUE_ID,
    startsAt: '2099-10-01T01:00:00+00:00',
    endsAt: '2099-10-01T09:00:00+00:00',
    reason: 'maintenance',
    notes: null,
    createdBy: STAFF_ID,
    lastModifiedBy: STAFF_ID,
    createdAt: '2026-09-23T00:00:00+00:00',
    updatedAt: '2026-09-23T00:00:00+00:00',
    removedAt: null,
    removedBy: null,
  };

  const bookingRow = {
    booking_id: BOOKING_ID,
    event_request_id: EVENT_ID,
    event_name: 'Orientation',
    starts_at: '2099-10-01T02:00:00+00:00',
    ends_at: '2099-10-01T04:00:00+00:00',
  };
  const camelBooking = {
    bookingId: BOOKING_ID,
    eventRequestId: EVENT_ID,
    eventName: 'Orientation',
    startsAt: '2099-10-01T02:00:00+00:00',
    endsAt: '2099-10-01T04:00:00+00:00',
  };

  const createBody = { startsAt: FUTURE_START, endsAt: FUTURE_END, reason: 'maintenance' };
  const pgError = (error) => ({ data: null, error });
  const pt409 = (hint, details = null) =>
    pgError({ code: 'PT409', message: `refused: ${hint}`, hint, details });

  const ROUTES = [
    ['GET', 'get', BASE, undefined],
    ['POST', 'post', BASE, createBody],
    ['PATCH', 'patch', ONE, { reason: 'safety' }],
    ['DELETE', 'delete', ONE, undefined],
  ];

  function send(app, method, path, body) {
    const req = request(app)[method](path);
    return body === undefined ? req : req.send(body);
  }

  describe('authorisation', () => {
    it.each(ROUTES)('SCRUM17_%s_blocks_answers_401_signed_out', async (_label, method, path, body) => {
      const res = await send(appWith(signedOut), method, path, body);
      expect(res.status).toBe(401);
      expect(rpc).not.toHaveBeenCalled();
      expect(from).not.toHaveBeenCalled();
    });

    it.each(ROUTES.filter(([label]) => label !== 'GET'))('SCRUM17_%s_blocks_answers_403_for_an_event_coordinator', async (_label, method, path, body) => {
      const res = await send(appWith(signedInAs(ROLE.EVENT_COORDINATOR)), method, path, body);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Venue Staff/);
      expect(rpc).not.toHaveBeenCalled();
      expect(from).not.toHaveBeenCalled();
    });

    it.each(ROUTES)('SCRUM17_%s_blocks_answers_403_for_an_event_organiser', async (_label, method, path, body) => {
      const res = await send(appWith(signedInAs(ROLE.EVENT_ORGANISER, ORGANISER_ID)), method, path, body);
      expect(res.status).toBe(403);
      expect(rpc).not.toHaveBeenCalled();
      expect(from).not.toHaveBeenCalled();
    });
  });

  describe('GET /:id/blocks', () => {
    it('SCRUM17_AC1_lists_active_blocks_as_a_camelcase_array', async () => {
      const stub = queryStub(ok([blockRow()]));
      from.mockReturnValueOnce(stub);

      const res = await request(appWith()).get(BASE);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([CAMEL_BLOCK]);
      expect(from).toHaveBeenCalledWith('venue_blocks');
      expect(stub.args('eq')).toEqual(['venue_id', VENUE_ID]);
      expect(stub.args('is')).toEqual(['removed_at', null]);
    });

    it('answers 200 [] when there are none', async () => {
      from.mockReturnValueOnce(queryStub(ok([])));
      const res = await request(appWith()).get(BASE);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('answers 400 for a malformed venue id without a query', async () => {
      const res = await request(appWith()).get('/api/venues/not-a-uuid/blocks');
      expect(res.status).toBe(400);
      expect(from).not.toHaveBeenCalled();
    });
  });

  describe('POST /:id/blocks', () => {
    it('SCRUM17_AC1_creates_a_block_and_answers_201_with_block_and_flagged_bookings', async () => {
      rpc.mockResolvedValueOnce(
        ok({ outcome: 'created', block: blockRow(), affected_bookings: [], flagged_bookings: [] }),
      );

      const res = await request(appWith()).post(BASE).send(createBody);

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ block: CAMEL_BLOCK, flaggedBookings: [] });
      expect(rpc.mock.calls[0][0]).toBe('create_venue_block');
    });

    it('SCRUM17_AC1_acting_user_is_the_session_and_venue_is_the_path', async () => {
      rpc.mockResolvedValueOnce(
        ok({ outcome: 'created', block: blockRow(), affected_bookings: [], flagged_bookings: [] }),
      );

      await request(appWith()).post(BASE).send({ ...createBody, userId: FORGED_ID, venueId: FORGED_ID });

      const params = rpc.mock.calls[0][1];
      expect(params.p_user_id).toBe(STAFF_ID);
      expect(params.p_venue_id).toBe(VENUE_ID);
      expect(JSON.stringify(params)).not.toContain(FORGED_ID);
    });

    it('SCRUM17_AC3_returns_the_flagged_bookings_after_an_override', async () => {
      rpc.mockResolvedValueOnce(
        ok({ outcome: 'created', block: blockRow(), affected_bookings: [bookingRow], flagged_bookings: [bookingRow] }),
      );

      const res = await request(appWith()).post(BASE).send({
        ...createBody,
        confirmOverride: true,
        acknowledgedBookingIds: [BOOKING_ID],
      });

      expect(res.status).toBe(201);
      expect(res.body.flaggedBookings).toEqual([camelBooking]);
    });

    it('SCRUM17_AC1_answers_400_with_details_and_no_rpc', async () => {
      const res = await request(appWith()).post(BASE).send({ startsAt: FUTURE_START, reason: 'party' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid venue block details/);
      expect(res.body.details).toEqual(
        expect.arrayContaining([
          { field: 'endsAt', message: 'is required' },
          expect.objectContaining({ field: 'reason' }),
        ]),
      );
      expect(rpc).not.toHaveBeenCalled();
    });

    it('SCRUM17_AC3_answers_409_BLOCK_BOOKING_CONFLICT_with_the_bookings', async () => {
      rpc.mockResolvedValueOnce(ok({ outcome: 'conflict', conflicts: [bookingRow] }));

      const res = await request(appWith()).post(BASE).send(createBody);

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: 'This period overlaps approved bookings',
        code: 'BLOCK_BOOKING_CONFLICT',
        conflicts: [camelBooking],
      });
    });

    it('SCRUM17_AC1_answers_409_BLOCK_OVERLAPS_BLOCK_naming_the_block', async () => {
      rpc.mockResolvedValueOnce(pt409('BLOCK_OVERLAPS_BLOCK', OTHER_BLOCK_ID));

      const res = await request(appWith()).post(BASE).send(createBody);

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: 'refused: BLOCK_OVERLAPS_BLOCK',
        code: 'BLOCK_OVERLAPS_BLOCK',
        conflicts: [{ blockId: OTHER_BLOCK_ID }],
      });
    });

    it('SCRUM17_AC1_answers_409_VENUE_RETIRED', async () => {
      rpc.mockResolvedValueOnce(pt409('VENUE_RETIRED'));

      const res = await request(appWith()).post(BASE).send(createBody);

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'refused: VENUE_RETIRED', code: 'VENUE_RETIRED', conflicts: [] });
    });

    it('SCRUM17_AC1_answers_404_for_a_missing_venue', async () => {
      rpc.mockResolvedValueOnce(pgError({ code: 'P0002', message: `venue ${VENUE_ID} not found` }));

      const res = await request(appWith()).post(BASE).send(createBody);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: `venue ${VENUE_ID} not found` });
    });
  });

  describe('PATCH /:id/blocks/:blockId', () => {
    const updated = (extra = {}) =>
      ok({ outcome: 'updated', block: blockRow(), affected_bookings: [], flagged_bookings: [], ...extra });

    it('SCRUM17_AC4_amends_and_answers_200_with_block_and_flagged_bookings', async () => {
      rpc.mockResolvedValueOnce(updated());

      const res = await request(appWith()).patch(ONE).send({ endsAt: FUTURE_END });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ block: CAMEL_BLOCK, flaggedBookings: [] });
      expect(rpc.mock.calls[0][0]).toBe('update_venue_block');
    });

    it('SCRUM17_AC4_acting_user_is_the_session_and_ids_are_the_path', async () => {
      rpc.mockResolvedValueOnce(updated());

      await request(appWith()).patch(ONE).send({ reason: 'safety', userId: FORGED_ID });

      const params = rpc.mock.calls[0][1];
      expect(params.p_user_id).toBe(STAFF_ID);
      expect(params.p_venue_id).toBe(VENUE_ID);
      expect(params.p_block_id).toBe(BLOCK_ID);
      expect(params.p_reason).toBe('safety');
    });

    it.each([
      ['an empty body', {}],
      ['an override-only body', { confirmOverride: true, acknowledgedBookingIds: [BOOKING_ID] }],
      ['a userId-only body', { userId: FORGED_ID }],
    ])('SCRUM17_AC4_answers_400_for_%s_without_an_rpc', async (_label, body) => {
      const res = await request(appWith()).patch(ONE).send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid venue block details -- no changes supplied');
      expect(rpc).not.toHaveBeenCalled();
    });

    it('SCRUM17_AC4_answers_400_for_a_malformed_block_id', async () => {
      const res = await request(appWith()).patch(`${BASE}/not-a-uuid`).send({ reason: 'safety' });

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([{ field: 'blockId', message: 'must be a block id' }]);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('SCRUM17_AC4_answers_400_with_details_for_a_bad_field', async () => {
      const res = await request(appWith()).patch(ONE).send({ startsAt: null });

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([{ field: 'startsAt', message: 'cannot be cleared' }]);
    });

    it('SCRUM17_AC4_answers_404_for_a_block_not_on_the_venue', async () => {
      rpc.mockResolvedValueOnce(pgError({ code: 'P0002', message: 'venue block not found on venue' }));

      const res = await request(appWith()).patch(ONE).send({ reason: 'safety' });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'venue block not found on venue' });
    });

    it.each(['BLOCK_REMOVED', 'BLOCK_ENDED', 'VENUE_RETIRED'])(
      'SCRUM17_AC4_answers_409_%s_with_the_code',
      async (hint) => {
        rpc.mockResolvedValueOnce(pt409(hint));

        const res = await request(appWith()).patch(ONE).send({ reason: 'safety' });

        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: `refused: ${hint}`, code: hint, conflicts: [] });
      },
    );

    it('SCRUM17_AC3_answers_409_BLOCK_BOOKING_CONFLICT_when_an_extension_hits_bookings', async () => {
      rpc.mockResolvedValueOnce(ok({ outcome: 'conflict', conflicts: [bookingRow] }));

      const res = await request(appWith()).patch(ONE).send({ endsAt: FUTURE_END });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: 'This period overlaps approved bookings',
        code: 'BLOCK_BOOKING_CONFLICT',
        conflicts: [camelBooking],
      });
    });

    it('SCRUM17_AC3_returns_the_flagged_bookings_after_an_override', async () => {
      rpc.mockResolvedValueOnce(updated({ affected_bookings: [bookingRow], flagged_bookings: [bookingRow] }));

      const res = await request(appWith()).patch(ONE).send({
        endsAt: FUTURE_END,
        confirmOverride: true,
        acknowledgedBookingIds: [BOOKING_ID],
      });

      expect(res.status).toBe(200);
      expect(res.body.flaggedBookings).toEqual([camelBooking]);
    });

    it('answers 409 BLOCK_OVERLAPS_BLOCK naming the other block', async () => {
      rpc.mockResolvedValueOnce(pt409('BLOCK_OVERLAPS_BLOCK', OTHER_BLOCK_ID));

      const res = await request(appWith()).patch(ONE).send({ endsAt: FUTURE_END });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('BLOCK_OVERLAPS_BLOCK');
      expect(res.body.conflicts).toEqual([{ blockId: OTHER_BLOCK_ID }]);
    });
  });

  describe('DELETE /:id/blocks/:blockId', () => {
    const removed = ok({ outcome: 'removed', block: blockRow({ removed_at: RETIRED_AT, removed_by: STAFF_ID }) });

    it('SCRUM17_AC4_removes_and_answers_204_with_an_empty_body', async () => {
      rpc.mockResolvedValueOnce(removed);

      const res = await request(appWith()).delete(ONE);

      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expect(res.body).toEqual({});
      expect(rpc).toHaveBeenCalledWith('remove_venue_block', {
        p_venue_id: VENUE_ID,
        p_block_id: BLOCK_ID,
        p_user_id: STAFF_ID,
      });
    });

    it('SCRUM17_AC4_p_user_id_is_the_session_even_with_a_forged_body', async () => {
      rpc.mockResolvedValueOnce(removed);

      await request(appWith()).delete(ONE).send({ userId: FORGED_ID });

      expect(rpc.mock.calls[0][1].p_user_id).toBe(STAFF_ID);
    });

    it('answers 400 for a malformed block id without an rpc', async () => {
      const res = await request(appWith()).delete(`${BASE}/not-a-uuid`);
      expect(res.status).toBe(400);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('SCRUM17_AC4_answers_404_for_a_missing_block', async () => {
      rpc.mockResolvedValueOnce(pgError({ code: 'P0002', message: 'venue block not found on venue' }));

      const res = await request(appWith()).delete(ONE);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'venue block not found on venue' });
    });

    it.each(['BLOCK_REMOVED', 'BLOCK_ENDED'])('SCRUM17_AC4_answers_409_%s_with_the_code', async (hint) => {
      rpc.mockResolvedValueOnce(pt409(hint));

      const res = await request(appWith()).delete(ONE);

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: `refused: ${hint}`, code: hint, conflicts: [] });
    });

    it('SCRUM17_AC4_answers_500_without_leaking_the_cause', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      rpc.mockResolvedValueOnce(pgError({ code: '42883', message: 'function remove_venue_block does not exist' }));

      const res = await request(appWith()).delete(ONE);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Unexpected server error' });
      expect(JSON.stringify(res.body)).not.toMatch(/remove_venue_block|42883/);
      expect(consoleError).toHaveBeenCalledWith('Unexpected error in venues route:', expect.any(Error));

      consoleError.mockRestore();
    });
  });
});


// ---------------------------------------------------------------------------
// SCRUM-130 (SCRUM-17 AC2): the search's date window, and the block window the
// venue calendar reads through -- now readable by Event Coordinators too.
// ---------------------------------------------------------------------------
describe('SCRUM17_AC2 search window and block reads', () => {
  const BLOCK_ID = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
  const BLOCKED_ID = 'a1b2c3d4-0000-4000-8000-00000000000a';
  const BLOCKS = `/api/venues/${VENUE_ID}/blocks`;
  const DAY_MS = 86_400_000;

  const blockRow = {
    id: BLOCK_ID,
    venue_id: VENUE_ID,
    starts_at: '2026-10-01T01:00:00+00:00',
    ends_at: '2026-10-01T09:00:00+00:00',
    reason: 'maintenance',
    notes: null,
    created_by: STAFF_ID,
    last_modified_by: STAFF_ID,
    created_at: '2026-09-23T00:00:00+00:00',
    updated_at: '2026-09-23T00:00:00+00:00',
    removed_at: null,
    removed_by: null,
  };
  const camelBlock = {
    id: BLOCK_ID,
    venueId: VENUE_ID,
    startsAt: '2026-10-01T01:00:00+00:00',
    endsAt: '2026-10-01T09:00:00+00:00',
    reason: 'maintenance',
    notes: null,
    createdBy: STAFF_ID,
    lastModifiedBy: STAFF_ID,
    createdAt: '2026-09-23T00:00:00+00:00',
    updatedAt: '2026-09-23T00:00:00+00:00',
    removedAt: null,
    removedBy: null,
  };
  const searchRow = { id: VENUE_ID, name: 'Seminar Room 2-1', location: 'Level 2, SCIS', max_capacity: 40 };

  /** Route from() by table name, so a dated search's two reads are told apart. */
  function givenTables({ blocks = ok([]), venues = ok([searchRow]) } = {}) {
    const blocksStub = queryStub(blocks);
    const venuesStub = queryStub(venues);
    from.mockImplementation((table) => {
      if (table === 'venue_blocks') return blocksStub;
      if (table === 'venues') return venuesStub;
      throw new Error(`unexpected table ${table}`);
    });
    return { blocksStub, venuesStub };
  }

  const tablesQueried = () => from.mock.calls.map(([table]) => table);

  describe('GET /search with startsAt and endsAt', () => {
    it('SCRUM17_AC2_search_with_url_encoded_plus_offsets_reaches_the_filter', async () => {
      const { blocksStub, venuesStub } = givenTables({ blocks: ok([{ venue_id: BLOCKED_ID }]) });

      const res = await request(appWith(signedInAs(ROLE.EVENT_ORGANISER, ORGANISER_ID))).get(
        '/api/venues/search?startsAt=2026-10-01T10:00:00%2B08:00&endsAt=2026-10-01T12:00:00%2B08:00',
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        { id: VENUE_ID, name: 'Seminar Room 2-1', location: 'Level 2, SCIS', maxCapacity: 40 },
      ]);
      expect(tablesQueried()).toEqual(['venue_blocks', 'venues']);
      expect(blocksStub.args('lt')).toEqual(['starts_at', '2026-10-01T12:00:00+08:00']);
      expect(blocksStub.args('gt')).toEqual(['ends_at', '2026-10-01T10:00:00+08:00']);
      expect(venuesStub.args('not')).toEqual(['id', 'in', `(${BLOCKED_ID})`]);
    });

    it('SCRUM17_AC2_search_with_Z_offsets_reaches_the_filter', async () => {
      const { blocksStub } = givenTables();

      const res = await request(appWith()).get(
        '/api/venues/search?startsAt=2026-10-01T02:00:00Z&endsAt=2026-10-01T04:00:00Z',
      );

      expect(res.status).toBe(200);
      expect(blocksStub.args('lt')).toEqual(['starts_at', '2026-10-01T04:00:00Z']);
      expect(blocksStub.args('gt')).toEqual(['ends_at', '2026-10-01T02:00:00Z']);
    });

    it('SCRUM17_AC2_a_raw_plus_arrives_as_a_space_and_answers_400_on_startsAt', async () => {
      const res = await request(appWith()).get(
        '/api/venues/search?startsAt=2026-10-01T10:00:00+08:00&endsAt=2026-10-01T12:00:00Z',
      );

      expect(res.status).toBe(400);
      expect(res.body.details.map((d) => d.field)).toEqual(['startsAt']);
      expect(from).not.toHaveBeenCalled();
    });

    it('SCRUM17_AC2_a_repeated_startsAt_param_answers_400', async () => {
      const res = await request(appWith()).get(
        '/api/venues/search?startsAt=2026-10-01T02:00:00Z&startsAt=2026-10-01T03:00:00Z&endsAt=2026-10-01T04:00:00Z',
      );

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([
        { field: 'startsAt', message: 'must be an ISO 8601 date and time, given as text' },
      ]);
      expect(from).not.toHaveBeenCalled();
    });

    it.each([
      ['only startsAt', '?startsAt=2026-10-01T02:00:00Z', [{ field: 'endsAt', message: 'is required when a start is given' }]],
      ['only endsAt', '?endsAt=2026-10-01T02:00:00Z', [{ field: 'startsAt', message: 'is required when an end is given' }]],
      ['a blank endsAt', '?startsAt=2026-10-01T02:00:00Z&endsAt=', [{ field: 'endsAt', message: 'is required when a start is given' }]],
      ['a reversed window', '?startsAt=2026-10-01T04:00:00Z&endsAt=2026-10-01T02:00:00Z', [{ field: 'endsAt', message: 'must be later than the start' }]],
    ])('SCRUM17_AC2_%s_answers_400_with_details', async (_label, qs, details) => {
      const res = await request(appWith()).get(`/api/venues/search${qs}`);

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual(details);
      expect(from).not.toHaveBeenCalled();
    });

    it('SCRUM17_AC2_blank_dates_search_exactly_as_before', async () => {
      const { venuesStub } = givenTables();

      const res = await request(appWith()).get('/api/venues/search?startsAt=&endsAt=');

      expect(res.status).toBe(200);
      expect(tablesQueried()).toEqual(['venues']);
      expect(venuesStub.called('not')).toBe(false);
    });

    it.each([
      ['an Event Coordinator', ROLE.EVENT_COORDINATOR],
      ['an Event Organiser', ROLE.EVENT_ORGANISER],
    ])('SCRUM17_AC2_%s_can_search_with_a_window', async (_label, role) => {
      givenTables();

      const res = await request(appWith(signedInAs(role, ORGANISER_ID))).get(
        '/api/venues/search?startsAt=2026-10-01T02:00:00Z&endsAt=2026-10-01T04:00:00Z',
      );

      expect(res.status).toBe(200);
      expect(tablesQueried()).toEqual(['venue_blocks', 'venues']);
    });
  });

  describe('GET /:id/blocks readers and window', () => {
    it('SCRUM17_AC2_an_event_coordinator_gets_200_with_the_full_block_shape', async () => {
      const stub = queryStub(ok([blockRow]));
      from.mockReturnValueOnce(stub);

      const res = await request(appWith(signedInAs(ROLE.EVENT_COORDINATOR))).get(BLOCKS);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([camelBlock]);
      expect(from).toHaveBeenCalledWith('venue_blocks');
      expect(stub.args('is')).toEqual(['removed_at', null]);
    });

    it('SCRUM17_AC2_an_event_coordinator_can_read_through_a_window', async () => {
      const stub = queryStub(ok([blockRow]));
      from.mockReturnValueOnce(stub);

      const res = await request(appWith(signedInAs(ROLE.EVENT_COORDINATOR))).get(
        `${BLOCKS}?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z`,
      );

      expect(res.status).toBe(200);
      expect(stub.args('lt')).toEqual(['starts_at', '2026-11-01T00:00:00Z']);
      expect(stub.args('gt')).toEqual(['ends_at', '2026-10-01T00:00:00Z']);
    });

    it.each([
      ['an attendee', ROLE.ATTENDEE],
      ['Technical Support', ROLE.TECHNICAL_SUPPORT_STAFF],
      ['an Event Organiser', ROLE.EVENT_ORGANISER],
    ])('SCRUM17_AC2_%s_gets_403_with_no_query', async (_label, role) => {
      const res = await request(appWith(signedInAs(role, ORGANISER_ID))).get(BLOCKS);

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Venue Staff/);
      expect(res.body.error).toMatch(/Event Coordinators/);
      expect(from).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    });

    it('SCRUM17_AC2_venue_staff_window_is_forwarded_as_lt_and_gt', async () => {
      const stub = queryStub(ok([]));
      from.mockReturnValueOnce(stub);

      const res = await request(appWith()).get(
        `${BLOCKS}?from=2026-10-01T00:00:00%2B08:00&to=2026-11-01T00:00:00%2B08:00`,
      );

      expect(res.status).toBe(200);
      expect(stub.args('lt')).toEqual(['starts_at', '2026-11-01T00:00:00+08:00']);
      expect(stub.args('gt')).toEqual(['ends_at', '2026-10-01T00:00:00+08:00']);
      expect(stub.called('lte')).toBe(false);
      expect(stub.called('gte')).toBe(false);
    });

    it('SCRUM17_AC2_no_window_means_no_lt_or_gt', async () => {
      const stub = queryStub(ok([]));
      from.mockReturnValueOnce(stub);

      const res = await request(appWith()).get(BLOCKS);

      expect(res.status).toBe(200);
      expect(stub.called('lt')).toBe(false);
      expect(stub.called('gt')).toBe(false);
    });

    it.each([
      ['only from', '?from=2026-10-01T00:00:00Z', [{ field: 'to', message: 'is required when a start is given' }]],
      ['only to', '?to=2026-10-01T00:00:00Z', [{ field: 'from', message: 'is required when an end is given' }]],
      ['a reversed window', '?from=2026-11-01T00:00:00Z&to=2026-10-01T00:00:00Z', [{ field: 'to', message: 'must be later than the start' }]],
    ])('SCRUM17_AC2_%s_answers_400_with_no_query', async (_label, qs, details) => {
      const res = await request(appWith()).get(`${BLOCKS}${qs}`);

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual(details);
      expect(from).not.toHaveBeenCalled();
    });

    it('SCRUM17_AC2_a_raw_plus_in_from_answers_400', async () => {
      const res = await request(appWith()).get(
        `${BLOCKS}?from=2026-10-01T00:00:00+08:00&to=2026-11-01T00:00:00Z`,
      );

      expect(res.status).toBe(400);
      expect(res.body.details.map((d) => d.field)).toEqual(['from']);
      expect(from).not.toHaveBeenCalled();
    });

    it('SCRUM17_AC2_exactly_400_days_answers_200', async () => {
      const stub = queryStub(ok([]));
      from.mockReturnValueOnce(stub);
      const to = new Date(Date.parse('2026-01-01T00:00:00Z') + 400 * DAY_MS).toISOString();

      const res = await request(appWith()).get(`${BLOCKS}?from=2026-01-01T00:00:00Z&to=${to}`);

      expect(res.status).toBe(200);
      expect(stub.args('lt')).toEqual(['starts_at', to]);
    });

    it('SCRUM17_AC2_401_days_answers_400_on_to', async () => {
      const to = new Date(Date.parse('2026-01-01T00:00:00Z') + 401 * DAY_MS).toISOString();

      const res = await request(appWith()).get(`${BLOCKS}?from=2026-01-01T00:00:00Z&to=${to}`);

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([{ field: 'to', message: 'must be within 400 days of the start' }]);
      expect(from).not.toHaveBeenCalled();
    });

    it.each([
      ['POST', 'post', BLOCKS, { startsAt: '2099-10-01T09:00:00Z', endsAt: '2099-10-01T17:00:00Z', reason: 'maintenance' }],
      ['PATCH', 'patch', `${BLOCKS}/${BLOCK_ID}`, { reason: 'safety' }],
      ['DELETE', 'delete', `${BLOCKS}/${BLOCK_ID}`, undefined],
    ])('SCRUM17_AC2_%s_blocks_still_answers_403_for_an_event_coordinator', async (_label, method, path, body) => {
      const req = request(appWith(signedInAs(ROLE.EVENT_COORDINATOR)))[method](path);
      const res = await (body === undefined ? req : req.send(body));

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('This action is restricted to Venue Staff');
      expect(rpc).not.toHaveBeenCalled();
      expect(from).not.toHaveBeenCalled();
    });
  });
});


describe('SCRUM17_AC4 GET /api/venues/:id/blocks/:blockId/history', () => {
  const BLOCK_ID = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
  const OTHER_BLOCK_ID = '6ba7b811-9dad-41d1-80b4-00c04fd430c8';
  const HISTORY = `/api/venues/${VENUE_ID}/blocks/${BLOCK_ID}/history`;
  const H1 = 'aaaaaaaa-0000-4000-8000-000000000001';
  const H2 = 'aaaaaaaa-0000-4000-8000-000000000002';

  const blockRow = (overrides = {}) => ({
    id: BLOCK_ID,
    venue_id: VENUE_ID,
    starts_at: '2026-10-01T01:00:00+00:00',
    ends_at: '2026-10-01T09:00:00+00:00',
    reason: 'maintenance',
    notes: null,
    created_by: STAFF_ID,
    last_modified_by: STAFF_ID,
    created_at: '2026-09-23T00:00:00+00:00',
    updated_at: '2026-09-23T00:00:00+00:00',
    removed_at: null,
    removed_by: null,
    ...overrides,
  });

  /** In the order the stub returns them (the database's newest first). */
  const HISTORY_ROWS = [
    {
      id: H2,
      block_id: BLOCK_ID,
      action: 'amended',
      changed_by: null,
      changed_at: '2026-09-24T00:00:00+00:00',
      old_values: { ends_at: '2026-10-01T09:00:00+00:00' },
      new_values: { ends_at: '2026-10-01T07:00:00+00:00' },
    },
    {
      id: H1,
      block_id: BLOCK_ID,
      action: 'created',
      changed_by: STAFF_ID,
      changed_at: '2026-09-23T00:00:00+00:00',
      old_values: {},
      new_values: { reason: 'maintenance', starts_at: '2026-10-01T01:00:00+00:00' },
    },
  ];

  /** Routes from() by table name. */
  function given({ block = ok(blockRow()), history = ok(HISTORY_ROWS) } = {}) {
    const tables = [];
    from.mockImplementation((table) => {
      tables.push(table);
      if (table === 'venue_blocks') return queryStub(block);
      if (table === 'venue_block_history') return queryStub(history);
      throw new Error(`unexpected table ${table}`);
    });
    return tables;
  }

  it('SCRUM17_AC4_venue_staff_get_200_with_the_exact_camelCase_array', async () => {
    const tables = given();

    const res = await request(appWith()).get(HISTORY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: H2,
        blockId: BLOCK_ID,
        action: 'amended',
        changedBy: null,
        changedAt: '2026-09-24T00:00:00+00:00',
        oldValues: { ends_at: '2026-10-01T09:00:00+00:00' },
        newValues: { ends_at: '2026-10-01T07:00:00+00:00' },
      },
      {
        id: H1,
        blockId: BLOCK_ID,
        action: 'created',
        changedBy: STAFF_ID,
        changedAt: '2026-09-23T00:00:00+00:00',
        oldValues: {},
        newValues: { reason: 'maintenance', starts_at: '2026-10-01T01:00:00+00:00' },
      },
    ]);
    expect(tables).toEqual(['venue_blocks', 'venue_block_history']);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM17_AC4_a_removed_block_still_answers_200', async () => {
    given({ block: ok(blockRow({ removed_at: '2026-09-25T00:00:00+00:00', removed_by: STAFF_ID })) });

    const res = await request(appWith()).get(HISTORY);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('SCRUM17_AC4_no_history_answers_200_with_an_empty_array', async () => {
    given({ history: ok([]) });

    const res = await request(appWith()).get(HISTORY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('SCRUM17_AC4_signed_out_answers_401_with_no_query', async () => {
    const res = await request(appWith(signedOut)).get(HISTORY);

    expect(res.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM17_AC4_an_event_coordinator_answers_403_naming_venue_staff', async () => {
    const res = await request(appWith(signedInAs(ROLE.EVENT_COORDINATOR))).get(HISTORY);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Venue Staff/);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['an Event Organiser', ROLE.EVENT_ORGANISER],
    ['an attendee', ROLE.ATTENDEE],
    ['Technical Support', ROLE.TECHNICAL_SUPPORT_STAFF],
  ])('SCRUM17_AC4_%s_answers_403_with_no_query', async (_label, role) => {
    const res = await request(appWith(signedInAs(role, ORGANISER_ID))).get(HISTORY);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Venue Staff/);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM17_AC4_a_block_not_on_the_venue_answers_404_and_reads_no_history', async () => {
    const tables = given({ block: ok(null) });

    const res = await request(appWith()).get(
      `/api/venues/${VENUE_ID}/blocks/${OTHER_BLOCK_ID}/history`,
    );

    expect(res.status).toBe(404);
    expect(typeof res.body.error).toBe('string');
    expect(tables).toEqual(['venue_blocks']);
  });

  it.each([
    ['block id', `/api/venues/${VENUE_ID}/blocks/not-a-uuid/history`],
    ['venue id', `/api/venues/not-a-uuid/blocks/${BLOCK_ID}/history`],
  ])('SCRUM17_AC4_a_malformed_%s_answers_400_with_no_query', async (_label, path) => {
    const res = await request(appWith()).get(path);

    expect(res.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM17_AC4_a_database_error_answers_500_without_leaking_it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    given({ history: { data: null, error: { code: '42P01', message: 'relation venue_block_history does not exist' } } });

    const res = await request(appWith()).get(HISTORY);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Unexpected server error' });
    expect(JSON.stringify(res.body)).not.toMatch(/venue_block_history|42P01/);
    expect(consoleError).toHaveBeenCalledWith('Unexpected error in venues route:', expect.any(Error));

    consoleError.mockRestore();
  });
});


// ---------------------------------------------------------------------------
// SCRUM-186: the turnaround between events reaches the API
// ---------------------------------------------------------------------------
describe('SCRUM186 turnaround through the venue routes', () => {
  it('SCRUM186_POST_with_turnaround_25_answers_400_on_turnaroundMinutes_with_no_rpc', async () => {
    const res = await request(appWith()).post('/api/venues').send({
      name: 'Hall A',
      location: 'SCIS',
      maxCapacity: 40,
      turnaroundMinutes: 25,
    });

    expect(res.status).toBe(400);
    expect(res.body.details.map((d) => d.field)).toEqual(['turnaroundMinutes']);
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM186_POST_with_turnaround_60_sends_60_and_answers_201', async () => {
    rpc.mockResolvedValueOnce(ok(VENUE_ID));
    from.mockReturnValueOnce(queryStub(ok(venueRow({ turnaround_minutes: 60 }))));

    const res = await request(appWith()).post('/api/venues').send({
      name: 'Hall A',
      location: 'SCIS',
      maxCapacity: 40,
      turnaroundMinutes: 60,
    });

    expect(res.status).toBe(201);
    expect(rpc.mock.calls[0][1].p_turnaround_minutes).toBe(60);
    expect(res.body.turnaroundMinutes).toBe(60);
  });

  it('SCRUM186_PATCH_turnaround_0_answers_200_and_the_rpc_gets_0', async () => {
    rpc.mockResolvedValueOnce(ok(null));
    from.mockReturnValueOnce(queryStub(ok(venueRow({ turnaround_minutes: 0 }))));

    const res = await request(appWith())
      .patch(`/api/venues/${VENUE_ID}`)
      .send({ turnaroundMinutes: 0 });

    expect(res.status).toBe(200);
    const [fn, payload] = rpc.mock.calls[0];
    expect(fn).toBe('update_venue');
    expect(payload.p_turnaround_minutes).toBe(0);
    expect(res.body.turnaroundMinutes).toBe(0);
  });

  it('SCRUM186_PATCH_with_a_string_turnaround_answers_400_with_no_rpc', async () => {
    const res = await request(appWith())
      .patch(`/api/venues/${VENUE_ID}`)
      .send({ turnaroundMinutes: '30' });

    expect(res.status).toBe(400);
    expect(res.body.details.map((d) => d.field)).toEqual(['turnaroundMinutes']);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM186_PATCH_turnaround_from_a_non_venue_staff_role_is_refused', async () => {
    const res = await request(appWith(signedInAs(ROLE.EVENT_ORGANISER, ORGANISER_ID)))
      .patch(`/api/venues/${VENUE_ID}`)
      .send({ turnaroundMinutes: 30 });

    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM186_GET_by_id_includes_turnaroundMinutes', async () => {
    from.mockReturnValueOnce(queryStub(ok(venueRow({ turnaround_minutes: 45 }))));

    const res = await request(appWith()).get(`/api/venues/${VENUE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.turnaroundMinutes).toBe(45);
    expect(res.body).not.toHaveProperty('turnaround_minutes');
  });
});


// ---------------------------------------------------------------------------
// SCRUM-178 (SCRUM-179): a venue's availability calendar
//
// The fixtures and the table router are shared by every SCRUM178 describe
// below, so each describe can be named after the one criterion it covers.
// ---------------------------------------------------------------------------
const CALENDAR_BOOKING_ID = 'b0000000-0000-4000-8000-00000000000a';
const CALENDAR_REQUEST_ID = 'e0000000-0000-4000-8000-00000000000a';
const CALENDAR_BLOCK_ID = 'c0000000-0000-4000-8000-00000000000a';
const CALENDAR = `/api/venues/${VENUE_ID}/calendar`;
const CALENDAR_WINDOW_QS = '?from=2026-10-01T00:00:00%2B08:00&to=2026-11-01T00:00:00%2B08:00';
const CALENDAR_DAY_MS = 86_400_000;

const calendarBookingRow = {
  id: CALENDAR_BOOKING_ID,
  event_request_id: CALENDAR_REQUEST_ID,
  starts_at: '2026-10-05T01:00:00+00:00',
  ends_at: '2026-10-05T04:00:00+00:00',
  status: 'approved',
  event_requests: { event_name: 'Freshmen Orientation' },
};
const calendarBlockRow = {
  id: CALENDAR_BLOCK_ID,
  venue_id: VENUE_ID,
  starts_at: '2026-10-03T01:00:00+00:00',
  ends_at: '2026-10-03T09:00:00+00:00',
  reason: 'maintenance',
  notes: null,
  created_by: STAFF_ID,
  last_modified_by: STAFF_ID,
  created_at: '2026-09-23T00:00:00+00:00',
  updated_at: '2026-09-23T00:00:00+00:00',
  removed_at: null,
  removed_by: null,
};

/** Route from() by table name; returns the stubs so a test can inspect them. */
function givenCalendarTables({
  venue = ok(venueRow()),
  bookings = ok([calendarBookingRow]),
  blocks = ok([calendarBlockRow]),
} = {}) {
  const stubs = {
    venues: queryStub(venue),
    bookings: queryStub(bookings),
    venue_blocks: queryStub(blocks),
  };
  from.mockImplementation((table) => {
    if (!(table in stubs)) throw new Error(`unexpected table ${table}`);
    return stubs[table];
  });
  return stubs;
}

const calendarTablesQueried = () => from.mock.calls.map(([table]) => table);


describe('SCRUM178_AC1 Coordinators and Venue Staff can open the calendar of an active or retired venue', () => {
  it.each([
    ['Venue Staff', ROLE.VENUE_STAFF],
    ['an Event Coordinator', ROLE.EVENT_COORDINATOR],
  ])('SCRUM178_AC1_%s_gets_200_with_the_merged_entries', async (_label, role) => {
    const { bookings } = givenCalendarTables();

    const res = await request(appWith(signedInAs(role))).get(`${CALENDAR}${CALENDAR_WINDOW_QS}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        kind: 'block',
        id: CALENDAR_BLOCK_ID,
        startsAt: '2026-10-03T01:00:00+00:00',
        endsAt: '2026-10-03T09:00:00+00:00',
        reason: 'maintenance',
        notes: null,
      },
      {
        kind: 'booking',
        id: CALENDAR_BOOKING_ID,
        startsAt: '2026-10-05T01:00:00+00:00',
        endsAt: '2026-10-05T04:00:00+00:00',
        status: 'approved',
        eventRequestId: CALENDAR_REQUEST_ID,
        eventName: 'Freshmen Orientation',
      },
    ]);
    // %2B decodes to '+', so the offset reaches the query intact.
    expect(bookings.args('lt')).toEqual(['starts_at', '2026-11-01T00:00:00+08:00']);
    expect(bookings.args('gt')).toEqual(['ends_at', '2026-10-01T00:00:00+08:00']);
    expect(bookings.args('in')).toEqual(['status', ['approved', 'flagged_for_review']]);
  });

  it('SCRUM178_AC1_a_retired_venue_answers_200_with_its_entries', async () => {
    givenCalendarTables({ venue: ok(venueRow({ retired_at: RETIRED_AT })) });

    const res = await request(appWith()).get(`${CALENDAR}${CALENDAR_WINDOW_QS}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('SCRUM178_AC1_nothing_in_the_window_answers_200_with_an_empty_array', async () => {
    givenCalendarTables({ bookings: ok([]), blocks: ok([]) });

    const res = await request(appWith()).get(`${CALENDAR}${CALENDAR_WINDOW_QS}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('SCRUM178_AC1_an_unknown_venue_answers_404_and_reads_no_bookings_or_blocks', async () => {
    givenCalendarTables({ venue: ok(null) });

    const res = await request(appWith()).get(`${CALENDAR}${CALENDAR_WINDOW_QS}`);

    expect(res.status).toBe(404);
    expect(typeof res.body.error).toBe('string');
    expect(calendarTablesQueried()).toEqual(['venues']);
  });
});


describe('SCRUM178_AC1 an invalid id or window stops the calendar opening, before any query', () => {
  it('SCRUM178_AC1_a_missing_window_answers_400_naming_both_ends', async () => {
    const res = await request(appWith()).get(CALENDAR);

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([
      { field: 'from', message: 'is required' },
      { field: 'to', message: 'is required' },
    ]);
    expect(from).not.toHaveBeenCalled();
  });

  it.each([
    ['only from', '?from=2026-10-01T00:00:00Z', [{ field: 'to', message: 'is required' }]],
    ['only to', '?to=2026-10-01T00:00:00Z', [{ field: 'from', message: 'is required' }]],
    ['a reversed window', '?from=2026-11-01T00:00:00Z&to=2026-10-01T00:00:00Z', [{ field: 'to', message: 'must be later than the start' }]],
  ])('SCRUM178_AC1_%s_answers_400_with_no_query', async (_label, qs, details) => {
    const res = await request(appWith()).get(`${CALENDAR}${qs}`);

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(details);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM178_AC1_a_raw_plus_offset_arrives_as_a_space_and_answers_400', async () => {
    const res = await request(appWith()).get(
      `${CALENDAR}?from=2026-10-01T00:00:00+08:00&to=2026-11-01T00:00:00Z`,
    );

    expect(res.status).toBe(400);
    expect(res.body.details.map((d) => d.field)).toEqual(['from']);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM178_AC1_a_malformed_venue_id_answers_400_with_no_query', async () => {
    const res = await request(appWith()).get(`/api/venues/not-a-uuid/calendar${CALENDAR_WINDOW_QS}`);

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'id', message: 'must be a venue id' }]);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM178_AC1_exactly_400_days_answers_200', async () => {
    const { bookings, venue_blocks: blocks } = givenCalendarTables({ bookings: ok([]), blocks: ok([]) });
    const to = new Date(Date.parse('2026-01-01T00:00:00Z') + 400 * CALENDAR_DAY_MS).toISOString();

    const res = await request(appWith()).get(`${CALENDAR}?from=2026-01-01T00:00:00Z&to=${to}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(bookings.args('lt')).toEqual(['starts_at', to]);
    expect(blocks.args('lt')).toEqual(['starts_at', to]);
  });

  it('SCRUM178_AC1_400_days_and_1_ms_answers_400_on_to', async () => {
    const to = new Date(Date.parse('2026-01-01T00:00:00Z') + 400 * CALENDAR_DAY_MS + 1).toISOString();

    const res = await request(appWith()).get(`${CALENDAR}?from=2026-01-01T00:00:00Z&to=${to}`);

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'to', message: 'must be within 400 days of the start' }]);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM178_AC1_from_equal_to_to_answers_400_on_to', async () => {
    const res = await request(appWith()).get(
      `${CALENDAR}?from=2026-10-01T00:00:00Z&to=2026-10-01T00:00:00Z`,
    );

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'to', message: 'must be later than the start' }]);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM178_AC1_an_offset_less_timestamp_answers_400_on_that_end', async () => {
    const res = await request(appWith()).get(
      `${CALENDAR}?from=2026-10-01T00:00:00&to=2026-11-01T00:00:00Z`,
    );

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([
      { field: 'from', message: 'must include a UTC offset, such as Z or +08:00' },
    ]);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM178_AC1_a_bad_id_and_a_bad_window_report_only_the_id', async () => {
    // The id is checked first and throws on its own, so the window is never read.
    const res = await request(appWith()).get('/api/venues/not-a-uuid/calendar?from=2026-11-01T00:00:00Z');

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'id', message: 'must be a venue id' }]);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM178_AC1_an_unknown_venue_with_a_bad_window_answers_400_not_404_with_no_query', async () => {
    // Would be 404 if the venue were looked up; the window is refused first.
    givenCalendarTables({ venue: ok(null) });

    const res = await request(appWith()).get(
      `${CALENDAR}?from=2026-11-01T00:00:00Z&to=2026-10-01T00:00:00Z`,
    );

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'to', message: 'must be later than the start' }]);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});


describe('SCRUM178_AC1 a database error stops the calendar opening', () => {
  it('SCRUM178_AC1_a_22P02_from_the_database_answers_400_not_500', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    givenCalendarTables({
      bookings: { data: null, error: { code: '22P02', message: 'invalid input syntax for type uuid' } },
    });

    const res = await request(appWith()).get(`${CALENDAR}${CALENDAR_WINDOW_QS}`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'A value was rejected by the database: invalid input syntax for type uuid',
      details: [],
    });
    // Typed, so it is answered rather than logged as an unexpected fault.
    expect(consoleError).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('SCRUM178_AC1_a_database_error_answers_500_without_leaking_it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    givenCalendarTables({ bookings: { data: null, error: { code: '42P01', message: 'relation bookings does not exist' } } });

    const res = await request(appWith()).get(`${CALENDAR}${CALENDAR_WINDOW_QS}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Unexpected server error' });
    expect(JSON.stringify(res.body)).not.toMatch(/relation|42P01/);
    expect(consoleError).toHaveBeenCalledWith('Unexpected error in venues route:', expect.any(Error));

    consoleError.mockRestore();
  });
});


describe('SCRUM178_AC2 entries carry what the Booked, Under review and Blocked labels need', () => {
  it('SCRUM178_AC2_a_flagged_booking_answers_with_status_flagged_for_review', async () => {
    givenCalendarTables({
      bookings: ok([{ ...calendarBookingRow, status: 'flagged_for_review', event_requests: { event_name: 'Career Fair' } }]),
      blocks: ok([]),
    });

    const res = await request(appWith()).get(`${CALENDAR}${CALENDAR_WINDOW_QS}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        kind: 'booking',
        id: CALENDAR_BOOKING_ID,
        startsAt: '2026-10-05T01:00:00+00:00',
        endsAt: '2026-10-05T04:00:00+00:00',
        status: 'flagged_for_review',
        eventRequestId: CALENDAR_REQUEST_ID,
        eventName: 'Career Fair',
      },
    ]);
  });

  it('SCRUM178_AC2_a_booking_whose_event_request_is_missing_answers_eventName_null', async () => {
    givenCalendarTables({
      bookings: ok([{ ...calendarBookingRow, event_requests: null }]),
      blocks: ok([]),
    });

    const res = await request(appWith()).get(`${CALENDAR}${CALENDAR_WINDOW_QS}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ kind: 'booking', id: CALENDAR_BOOKING_ID, status: 'approved' });
    // null, not left out: JSON drops undefined, and the frontend reads null.
    expect(res.body[0]).toHaveProperty('eventName', null);
  });
});


describe('SCRUM178_AC6 Organisers and Attendees are refused the calendar', () => {
  it.each([
    ['an Event Organiser', ROLE.EVENT_ORGANISER],
    ['an attendee', ROLE.ATTENDEE],
    ['Technical Support', ROLE.TECHNICAL_SUPPORT_STAFF],
  ])('SCRUM178_AC6_%s_gets_403_with_no_query', async (_label, role) => {
    const res = await request(appWith(signedInAs(role, ORGANISER_ID))).get(`${CALENDAR}${CALENDAR_WINDOW_QS}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Venue Staff/);
    expect(res.body.error).toMatch(/Event Coordinators/);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM178_AC6_signed_out_answers_401_with_no_query', async () => {
    const res = await request(appWith(signedOut)).get(`${CALENDAR}${CALENDAR_WINDOW_QS}`);

    expect(res.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SCRUM-182: the SCRUM-15 bookings read is gated like the calendar, so it is
// no side door into the bookings half of the calendar.
// ---------------------------------------------------------------------------
describe('SCRUM178_AC6 the bookings read is refused to Organisers and Attendees, as the calendar is', () => {
  const BOOKINGS = `/api/venues/${VENUE_ID}/bookings`;

  const bookingRow = {
    id: 'b1', venue_id: VENUE_ID, event_request_id: EVENT_ID,
    starts_at: '2026-06-01T09:00:00+00:00', ends_at: '2026-06-01T17:00:00+00:00',
    created_at: '2026-05-01T09:00:00+00:00',
  };
  const bookingBody = {
    id: 'b1', venueId: VENUE_ID, eventRequestId: EVENT_ID,
    startsAt: '2026-06-01T09:00:00+00:00', endsAt: '2026-06-01T17:00:00+00:00',
    createdAt: '2026-05-01T09:00:00+00:00',
  };

  it.each([
    ['Venue Staff', ROLE.VENUE_STAFF],
    ['an Event Coordinator', ROLE.EVENT_COORDINATOR],
  ])('SCRUM178_AC6_%s_gets_200_with_the_bookings', async (_label, role) => {
    from.mockReturnValueOnce(queryStub(ok([bookingRow])));

    const res = await request(appWith(signedInAs(role))).get(BOOKINGS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([bookingBody]);
    expect(from).toHaveBeenCalledWith('bookings');
  });

  it.each([
    ['an Event Organiser', ROLE.EVENT_ORGANISER],
    ['an attendee', ROLE.ATTENDEE],
    ['Technical Support', ROLE.TECHNICAL_SUPPORT_STAFF],
  ])('SCRUM178_AC6_%s_gets_403_with_no_query', async (_label, role) => {
    const res = await request(appWith(signedInAs(role, ORGANISER_ID))).get(BOOKINGS);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Venue Staff/);
    expect(res.body.error).toMatch(/Event Coordinators/);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM15_AC3_a_coordinator_can_still_read_a_retired_venues_bookings', async () => {
    // getBookingsForVenue never looks at the venue's retired_at, so a retired
    // venue's bookings come back the same as an active one's.
    from.mockReturnValueOnce(queryStub(ok([bookingRow])));

    const res = await request(appWith(signedInAs(ROLE.EVENT_COORDINATOR))).get(BOOKINGS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([bookingBody]);
    expect(from.mock.calls.map(([table]) => table)).toEqual(['bookings']);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-185 (SCRUM-178 AC1): GET /search?includeRetired=true lists retired
// venues too, so a retired venue's calendar can be reached from search. It is
// Venue Staff and Event Coordinators only (AC6); the flag is validated before
// the role check, and both before any database call.
// ---------------------------------------------------------------------------
describe('SCRUM178_AC1 Coordinators and Venue Staff can search retired venues', () => {
  const SEARCH = '/api/venues/search';
  const ACTIVE_ID = 'c0ffee00-0000-4000-8000-000000000001';
  const ACTIVE_ROW = { id: ACTIVE_ID, name: 'Active Room', location: 'Level 1, SCIS', max_capacity: 30 };
  const RETIRED_ROW = catalogueRow({ retired_at: RETIRED_AT });
  const WINDOW_QS = 'startsAt=2026-10-01T02:00:00Z&endsAt=2026-10-01T04:00:00Z';

  it.each([
    ['Venue Staff', ROLE.VENUE_STAFF],
    ['an Event Coordinator', ROLE.EVENT_COORDINATOR],
  ])('SCRUM178_AC1_%s_gets_200_with_retiredAt_on_every_row', async (_label, role) => {
    const query = queryStub(ok([{ ...ACTIVE_ROW, retired_at: null }, RETIRED_ROW]));
    from.mockReturnValueOnce(query);

    const res = await request(appWith(signedInAs(role))).get(`${SEARCH}?includeRetired=true`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: ACTIVE_ID, name: 'Active Room', location: 'Level 1, SCIS', maxCapacity: 30, retiredAt: null },
      { id: VENUE_ID, name: 'Seminar Room 2-1', location: 'Level 2, SCIS', maxCapacity: 40, retiredAt: RETIRED_AT },
    ]);
    expect(from.mock.calls.map(([table]) => table)).toEqual(['venues']);
    expect(query.called('is')).toBe(false);
    expect(query.args('select')).toEqual(['id, name, location, max_capacity, retired_at']);
  });

  it('SCRUM178_AC1_the_flag_still_passes_location_and_minCapacity_through', async () => {
    const query = queryStub(ok([]));
    from.mockReturnValueOnce(query);

    const res = await request(appWith(signedInAs(ROLE.EVENT_COORDINATOR)))
      .get(`${SEARCH}?includeRetired=true&location=SCIS&minCapacity=40`);

    expect(res.status).toBe(200);
    expect(query.args('ilike')).toEqual(['location', '%SCIS%']);
    expect(query.args('gte')).toEqual(['max_capacity', 40]);
  });

  it('SCRUM178_AC1_an_organiser_without_the_flag_searches_exactly_as_before', async () => {
    const query = queryStub(ok([{ ...ACTIVE_ROW }]));
    from.mockReturnValueOnce(query);

    const res = await request(appWith(signedInAs(ROLE.EVENT_ORGANISER, ORGANISER_ID))).get(SEARCH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: ACTIVE_ID, name: 'Active Room', location: 'Level 1, SCIS', maxCapacity: 30 }]);
    expect(Object.keys(res.body[0])).toEqual(['id', 'name', 'location', 'maxCapacity']);
    expect(query.args('select')).toEqual(['id, name, location, max_capacity']);
    expect(query.args('is')).toEqual(['retired_at', null]);
  });

  it.each([
    ['false', '?includeRetired=false'],
    ['blank', '?includeRetired='],
  ])('SCRUM178_AC1_an_organiser_with_includeRetired_%s_gets_the_ordinary_search', async (_label, qs) => {
    const query = queryStub(ok([{ ...ACTIVE_ROW }]));
    from.mockReturnValueOnce(query);

    const res = await request(appWith(signedInAs(ROLE.EVENT_ORGANISER, ORGANISER_ID))).get(`${SEARCH}${qs}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: ACTIVE_ID, name: 'Active Room', location: 'Level 1, SCIS', maxCapacity: 30 }]);
    expect(query.args('is')).toEqual(['retired_at', null]);
  });

  it.each([
    ['junk', '?includeRetired=junk'],
    ['upper case', '?includeRetired=TRUE'],
    ['one', '?includeRetired=1'],
    ['repeated', '?includeRetired=true&includeRetired=true'],
  ])('SCRUM178_AC1_a_%s_flag_answers_400_even_for_an_organiser', async (_label, qs) => {
    // Validation comes before the role check, so a junk value is a 400 for
    // everyone, never a 403 that hides the real fault.
    const res = await request(appWith(signedInAs(ROLE.EVENT_ORGANISER, ORGANISER_ID))).get(`${SEARCH}${qs}`);

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'includeRetired', message: 'must be true or false' }]);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['Venue Staff', ROLE.VENUE_STAFF],
    ['an Event Coordinator', ROLE.EVENT_COORDINATOR],
    ['an Event Organiser', ROLE.EVENT_ORGANISER],
  ])('SCRUM178_AC1_%s_with_the_flag_and_a_window_answers_400_on_includeRetired', async (_label, role) => {
    const res = await request(appWith(signedInAs(role, ORGANISER_ID)))
      .get(`${SEARCH}?includeRetired=true&${WINDOW_QS}`);

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([
      {
        field: 'includeRetired',
        message: 'cannot be combined with a date window: a retired venue cannot be booked',
      },
    ]);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});


describe('SCRUM178_AC6 Organisers and Attendees cannot search retired venues', () => {
  const SEARCH = '/api/venues/search';
  const ROLE_403 = { error: 'This action is restricted to Venue Staff or Event Coordinators' };

  it.each([
    ['an Event Organiser', ROLE.EVENT_ORGANISER],
    ['an attendee', ROLE.ATTENDEE],
    ['Technical Support', ROLE.TECHNICAL_SUPPORT_STAFF],
  ])('SCRUM178_AC6_%s_with_includeRetired_gets_403_with_no_query', async (_label, role) => {
    const res = await request(appWith(signedInAs(role, ORGANISER_ID))).get(`${SEARCH}?includeRetired=true`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual(ROLE_403);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM178_AC6_signed_out_with_includeRetired_answers_401_with_no_query', async () => {
    const res = await request(appWith(signedOut)).get(`${SEARCH}?includeRetired=true`);

    expect(res.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// SCRUM-137 (SCRUM-20): the setup time before an event reaches the API
// ---------------------------------------------------------------------------
describe('SCRUM20_SCRUM137 setup time through the venue routes', () => {
  it('SCRUM20_SCRUM137_POST_with_setup_25_answers_400_on_setupMinutes_with_no_rpc', async () => {
    const res = await request(appWith()).post('/api/venues').send({
      name: 'Hall A',
      location: 'SCIS',
      maxCapacity: 40,
      setupMinutes: 25,
    });

    expect(res.status).toBe(400);
    expect(res.body.details.map((d) => d.field)).toEqual(['setupMinutes']);
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM20_SCRUM137_POST_with_setup_30_sends_30_and_answers_201', async () => {
    rpc.mockResolvedValueOnce(ok(VENUE_ID));
    from.mockReturnValueOnce(queryStub(ok(venueRow({ setup_minutes: 30 }))));

    const res = await request(appWith()).post('/api/venues').send({
      name: 'Hall A',
      location: 'SCIS',
      maxCapacity: 40,
      setupMinutes: 30,
    });

    expect(res.status).toBe(201);
    const [fn, payload] = rpc.mock.calls[0];
    expect(fn).toBe('create_venue');
    expect(payload.p_setup_minutes).toBe(30);
    expect(res.body.setupMinutes).toBe(30);
  });

  it('SCRUM20_SCRUM137_POST_without_setup_sends_the_default_0', async () => {
    rpc.mockResolvedValueOnce(ok(VENUE_ID));
    from.mockReturnValueOnce(queryStub(ok(venueRow({ setup_minutes: 0 }))));

    const res = await request(appWith()).post('/api/venues').send({
      name: 'Hall A',
      location: 'SCIS',
      maxCapacity: 40,
    });

    expect(res.status).toBe(201);
    expect(rpc.mock.calls[0][1].p_setup_minutes).toBe(0);
  });

  it('SCRUM20_SCRUM137_PATCH_setup_0_answers_200_and_the_rpc_gets_0', async () => {
    rpc.mockResolvedValueOnce(ok(null));
    from.mockReturnValueOnce(queryStub(ok(venueRow({ setup_minutes: 0 }))));

    const res = await request(appWith())
      .patch(`/api/venues/${VENUE_ID}`)
      .send({ setupMinutes: 0 });

    expect(res.status).toBe(200);
    const [fn, payload] = rpc.mock.calls[0];
    expect(fn).toBe('update_venue');
    expect(payload.p_setup_minutes).toBe(0);
    expect(res.body.setupMinutes).toBe(0);
  });

  it('SCRUM20_SCRUM137_PATCH_with_a_string_setup_answers_400_with_no_rpc', async () => {
    const res = await request(appWith())
      .patch(`/api/venues/${VENUE_ID}`)
      .send({ setupMinutes: '30' });

    expect(res.status).toBe(400);
    expect(res.body.details.map((d) => d.field)).toEqual(['setupMinutes']);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM20_SCRUM137_PATCH_with_null_setup_answers_400_with_no_rpc', async () => {
    const res = await request(appWith())
      .patch(`/api/venues/${VENUE_ID}`)
      .send({ setupMinutes: null });

    expect(res.status).toBe(400);
    expect(res.body.details.map((d) => d.field)).toEqual(['setupMinutes']);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM20_SCRUM137_PATCH_setup_from_a_non_venue_staff_role_is_refused', async () => {
    const res = await request(appWith(signedInAs(ROLE.EVENT_ORGANISER, ORGANISER_ID)))
      .patch(`/api/venues/${VENUE_ID}`)
      .send({ setupMinutes: 30 });

    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM20_SCRUM137_GET_by_id_includes_setupMinutes', async () => {
    from.mockReturnValueOnce(queryStub(ok(venueRow({ setup_minutes: 45 }))));

    const res = await request(appWith()).get(`/api/venues/${VENUE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.setupMinutes).toBe(45);
    expect(res.body).not.toHaveProperty('setup_minutes');
  });
});


/**
 * SCRUM-140 (for SCRUM-20): GET /api/venues/event-search.
 *
 * The service functions this block watches are vi.fn wrappers around the real
 * ones (the vi.mock of venueService.js near the top), so every other test in
 * this file still runs the real service. Here, a test either scripts
 * findVenuesForEvent's answer to check transport alone, or leaves it real to
 * check that a bad query reaches the real validator.
 *
 * Cases: B-AC1-17 to 19 (route), B-AC8-02/03, against the new route rather
 * than /search -- SCRUM-140 gave the event search its own path.
 */
describe('SCRUM20 GET /api/venues/event-search', () => {
  const COORDINATOR_ID = '33333333-3333-4333-8333-333333333333';
  const asCoordinator = () => appWith(signedInAs(ROLE.EVENT_COORDINATOR, COORDINATOR_ID));

  // Wednesday 11 November 2026, 10:00-12:00 Singapore. Encoded, because an
  // unencoded '+' arrives as a space.
  const STARTS_AT = '2026-11-11T10:00:00+08:00';
  const ENDS_AT = '2026-11-11T12:00:00+08:00';
  const PERIOD = `startsAt=${encodeURIComponent(STARTS_AT)}&endsAt=${encodeURIComponent(ENDS_AT)}`;
  const URL = '/api/venues/event-search';

  const RESULT = [{
    id: VENUE_ID,
    name: 'Seminar Room 2-1',
    location: 'Level 2, SCIS',
    maxCapacity: 40,
    layouts: ['theatre'],
    accessibility: [],
    facilities: ['wifi'],
    hours: [{ day_of_week: 3, opens_at: '08:00:00', closes_at: '22:00:00' }],
    setupMinutes: 0,
    turnaroundMinutes: 30,
  }];

  const find = vi.mocked(serviceSpies.findVenuesForEvent);
  const byId = vi.mocked(serviceSpies.getVenueById);
  const search = vi.mocked(serviceSpies.searchVenues);

  beforeEach(() => {
    for (const [spy, real] of [
      [find, realService.findVenuesForEvent],
      [byId, realService.getVenueById],
      [search, realService.searchVenues],
    ]) {
      spy.mockReset();
      spy.mockImplementation(real);
    }
  });

  /** The criteria the route handed the service on its only call. */
  const criteriaSent = () => {
    expect(find).toHaveBeenCalledTimes(1);
    return find.mock.calls[0][0];
  };

  describe('access', () => {
    it('SCRUM20_AC1_coordinator_gets_200_with_the_service_result_passed_through', async () => {
      find.mockResolvedValueOnce(RESULT);

      const res = await request(asCoordinator()).get(`${URL}?${PERIOD}&expectedAttendance=40`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(RESULT);
    });

    it('SCRUM20_AC1_unauthenticated_search_is_401', async () => {
      const res = await request(appWith(signedOut)).get(`${URL}?${PERIOD}&expectedAttendance=40`);

      expect(res.status).toBe(401);
      expect(find).not.toHaveBeenCalled();
    });

    it.each([
      ['Venue Staff', ROLE.VENUE_STAFF],
      ['an Event Organiser', ROLE.EVENT_ORGANISER],
      ['an Attendee', ROLE.ATTENDEE],
      ['Technical Support Staff', ROLE.TECHNICAL_SUPPORT_STAFF],
    ])('SCRUM20_AC1_%s_is_refused_with_403_before_the_service', async (_label, role) => {
      const res = await request(appWith(signedInAs(role)))
        .get(`${URL}?${PERIOD}&expectedAttendance=40`);

      expect(res.status).toBe(403);
      expect(find).not.toHaveBeenCalled();
      expect(from).not.toHaveBeenCalled();
    });
  });

  describe('parsing the query string', () => {
    beforeEach(() => find.mockResolvedValue([]));

    it('SCRUM20_AC1_query_string_is_parsed_into_typed_filters', async () => {
      // B-AC1-19, against the new route.
      await request(asCoordinator())
        .get(`${URL}?${PERIOD}&expectedAttendance=80&layout=theatre&facilities=projector&facilities=wifi`);

      expect(criteriaSent()).toEqual({
        startsAt: STARTS_AT,
        endsAt: ENDS_AT,
        expectedAttendance: 80,
        layout: 'theatre',
        facilities: ['projector', 'wifi'],
      });
    });

    it('SCRUM20_AC1_comma_list_is_split_and_blank_pieces_dropped', async () => {
      await request(asCoordinator())
        .get(`${URL}?${PERIOD}&expectedAttendance=80&accessibility=${encodeURIComponent('a, b,,c')}`);

      expect(criteriaSent().accessibility).toEqual(['a', 'b', 'c']);
    });

    it('SCRUM20_AC1_repeated_and_comma_lists_combine_into_one_array', async () => {
      await request(asCoordinator())
        .get(`${URL}?${PERIOD}&expectedAttendance=80&facilities=a&facilities=b,c`);

      expect(criteriaSent().facilities).toEqual(['a', 'b', 'c']);
    });

    it('SCRUM20_AC1_an_all_blank_list_leaves_the_key_out', async () => {
      await request(asCoordinator())
        .get(`${URL}?${PERIOD}&expectedAttendance=80&facilities=${encodeURIComponent(' , ,')}&accessibility=`);

      const criteria = criteriaSent();
      expect(criteria).not.toHaveProperty('facilities');
      expect(criteria).not.toHaveProperty('accessibility');
    });

    it('SCRUM20_AC1_a_blank_attendance_leaves_the_key_out', async () => {
      await request(asCoordinator()).get(`${URL}?${PERIOD}&expectedAttendance=%20`);

      expect(criteriaSent()).not.toHaveProperty('expectedAttendance');
    });

    it('SCRUM20_AC1_an_absent_optional_criterion_is_not_sent', async () => {
      await request(asCoordinator()).get(`${URL}?${PERIOD}&expectedAttendance=80`);

      expect(criteriaSent()).toEqual({ startsAt: STARTS_AT, endsAt: ENDS_AT, expectedAttendance: 80 });
    });

    it('SCRUM20_AC1_SCRUM141_location_is_passed_through_as_sent', async () => {
      await request(asCoordinator())
        .get(`${URL}?${PERIOD}&expectedAttendance=80&location=${encodeURIComponent('  Level 2, SCIS ')}`);

      // Trimmed by the real validator inside the real service, not by the route.
      expect(criteriaSent()).toEqual({
        startsAt: STARTS_AT,
        endsAt: ENDS_AT,
        expectedAttendance: 80,
        location: '  Level 2, SCIS ',
      });
    });

    it('SCRUM20_AC1_SCRUM141_percent_and_underscore_in_location_arrive_unchanged', async () => {
      await request(asCoordinator())
        .get(`${URL}?${PERIOD}&expectedAttendance=80&location=${encodeURIComponent('100%_Hall')}`);

      expect(criteriaSent().location).toBe('100%_Hall');
    });

    it('SCRUM20_AC1_SCRUM141_no_location_leaves_the_key_out', async () => {
      await request(asCoordinator()).get(`${URL}?${PERIOD}&expectedAttendance=80&layout=theatre`);

      expect(criteriaSent()).not.toHaveProperty('location');
    });

    it('SCRUM20_AC1_SCRUM141_an_empty_location_reaches_the_service_as_sent', async () => {
      // The route converts nothing; the validator turns blank into absent.
      await request(asCoordinator()).get(`${URL}?${PERIOD}&expectedAttendance=80&location=`);

      expect(criteriaSent().location).toBe('');
    });
  });

  describe('bad input reaches the real validator and is 400 with details', () => {
    const fieldsOf = (res) => res.body.details.map((d) => d.field);

    it('SCRUM20_AC1_a_blank_attendance_is_reported_as_required', async () => {
      const res = await request(asCoordinator()).get(`${URL}?${PERIOD}&expectedAttendance=`);

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([{ field: 'expectedAttendance', message: 'is required' }]);
      expect(res.body.error).toMatch(/^Invalid venue search -- /);
      expect(from).not.toHaveBeenCalled();
    });

    it('SCRUM20_AC1_missing_fields_are_400_naming_each', async () => {
      const res = await request(asCoordinator()).get(URL);

      expect(res.status).toBe(400);
      expect(fieldsOf(res).sort()).toEqual(['endsAt', 'expectedAttendance', 'startsAt']);
      expect(from).not.toHaveBeenCalled();
    });

    it('SCRUM20_AC1_bad_query_is_400_with_details', async () => {
      // B-AC1-17, against the new route.
      const res = await request(asCoordinator()).get(`${URL}?${PERIOD}&expectedAttendance=abc`);

      expect(res.status).toBe(400);
      expect(fieldsOf(res)).toEqual(['expectedAttendance']);
    });

    it('SCRUM20_AC1_SCRUM141_a_repeated_location_is_400_must_be_text', async () => {
      // ?location=a&location=b arrives as an array, which is not text.
      const res = await request(asCoordinator())
        .get(`${URL}?${PERIOD}&expectedAttendance=80&location=a&location=b`);

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([{ field: 'location', message: 'must be text' }]);
      expect(from).not.toHaveBeenCalled();
    });

    it('SCRUM20_AC1_fractional_attendance_is_400', async () => {
      const res = await request(asCoordinator()).get(`${URL}?${PERIOD}&expectedAttendance=12.5`);

      expect(res.status).toBe(400);
      expect(fieldsOf(res)).toEqual(['expectedAttendance']);
    });

    it('SCRUM20_AC1_an_unencoded_plus_in_an_offset_is_400', async () => {
      // '+08:00' unencoded arrives as ' 08:00', which is not a valid offset.
      const res = await request(asCoordinator())
        .get(`${URL}?startsAt=${STARTS_AT}&endsAt=${ENDS_AT}&expectedAttendance=40`);

      expect(res.status).toBe(400);
      expect(fieldsOf(res)).toEqual(expect.arrayContaining(['startsAt']));
      expect(from).not.toHaveBeenCalled();
    });

    it('SCRUM20_AC1_an_unknown_code_is_400_naming_it', async () => {
      from.mockReturnValueOnce(queryStub(ok([{ code: 'projector' }])));

      const res = await request(asCoordinator())
        .get(`${URL}?${PERIOD}&expectedAttendance=40&facilities=projector,jacuzzi`);

      expect(res.status).toBe(400);
      expect(res.body.details).toEqual([{ field: 'facilities', message: 'unknown code "jacuzzi"' }]);
      expect(from).toHaveBeenCalledTimes(1);
      expect(from).toHaveBeenCalledWith('facilities');
    });
  });

  describe('service outcomes', () => {
    it('SCRUM20_AC1_a_service_ValidationError_is_400_with_error_and_details', async () => {
      const details = [{ field: 'layout', message: 'unknown code "ballroom"' }];
      find.mockRejectedValueOnce(
        new ValidationError('Invalid venue search -- layout: unknown code "ballroom"', details),
      );

      const res = await request(asCoordinator()).get(`${URL}?${PERIOD}&expectedAttendance=40&layout=ballroom`);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'Invalid venue search -- layout: unknown code "ballroom"',
        details,
      });
    });

    it('SCRUM20_AC8_no_match_is_200_with_an_empty_array', async () => {
      find.mockResolvedValueOnce([]);

      const res = await request(asCoordinator()).get(`${URL}?${PERIOD}&expectedAttendance=40`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('SCRUM20_AC8_no_match_does_not_name_a_criterion', async () => {
      find.mockResolvedValueOnce([]);

      const res = await request(asCoordinator()).get(`${URL}?${PERIOD}&expectedAttendance=40`);

      // Exactly [], so no reason / excludedBy field can be hiding in it.
      expect(res.text).toBe('[]');
    });

    it('SCRUM20_AC1_an_untyped_error_is_500_without_leaking_it', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      find.mockRejectedValueOnce(new Error('relation "bookings" does not exist'));

      const res = await request(asCoordinator()).get(`${URL}?${PERIOD}&expectedAttendance=40`);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Unexpected server error' });
      expect(JSON.stringify(res.body)).not.toMatch(/relation|bookings/);
      consoleError.mockRestore();
    });
  });

  describe('routing', () => {
    it('SCRUM20_AC1_event_search_is_not_mistaken_for_an_id', async () => {
      find.mockResolvedValueOnce([]);

      const res = await request(asCoordinator()).get(`${URL}?${PERIOD}&expectedAttendance=40`);

      expect(res.status).toBe(200);
      expect(find).toHaveBeenCalledTimes(1);
      expect(byId).not.toHaveBeenCalled();
    });

    it('SCRUM20_AC1_the_old_search_still_reaches_searchVenues', async () => {
      from.mockReturnValueOnce(queryStub(ok([])));

      const res = await request(appWith()).get('/api/venues/search?location=SCIS');

      expect(res.status).toBe(200);
      expect(search).toHaveBeenCalledTimes(1);
      expect(search.mock.calls[0][0]).toEqual({ location: 'SCIS' });
      expect(find).not.toHaveBeenCalled();
    });
  });
});
