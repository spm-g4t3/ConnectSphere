/**
 * Tests for the venue catalogue service.
 *
 * SCRUM-106: Create and update venue records.
 * SCRUM-110: Implement venue retirement handling.
 * SCRUM-111: Update venue search to use current active venue details.
 * SCRUM-138: Search venues against an event's requirements (SCRUM-20).
 *
 * Describe blocks are named after the acceptance criteria they cover, so a
 * requirement can be traced to the test that proves it.
 *
 * The Supabase client is replaced wholesale. src/config/supabaseClient.js
 * builds its client at import time and throws when the environment is not
 * configured, so vi.mock's factory -- hoisted above the imports, which stops
 * the real module ever evaluating -- is what lets these run in CI with no
 * credentials. It is equally what keeps them off the live database on a
 * machine that does have a .env. Nothing here touches the network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { supabase } from '../../src/config/supabaseClient.js';
import {
  createVenue,
  updateVenue,
  getVenueById,
  listVenues,
  retireVenue,
  searchVenues,
  getVenueHistory,
  getBookingsForVenue,
  findVenuesForEvent,
} from '../../src/services/venueService.js';
import { ValidationError, NotFoundError, ConflictError } from '../../src/errors.js';

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));

// A factory, not automocking: without one Vitest loads the real module first
// and replaces its exports afterwards, which is the import-time side effect
// this is here to prevent.
vi.mock('../../src/config/supabaseClient.js', () => {
  const client = { rpc, from };
  return { supabase: client, default: client };
});


const VENUE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const STAFF_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const RETIRED_AT = '2026-09-15T10:00:00+00:00';

/** Await an async call and return the thrown error, or null if it resolved. */
async function errorFromAsync(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

/** The row shape getVenueById selects, for a venue that has been retired. */
function retiredVenueRow(overrides = {}) {
  return {
    id: VENUE_ID,
    name: 'Seminar Room 2-1',
    location: 'Level 2, SCIS',
    max_capacity: 40,
    turnaround_minutes: 0,
    retired_at: RETIRED_AT,
    created_at: '2026-09-12T09:00:00+00:00',
    updated_at: RETIRED_AT,
    last_modified_by: STAFF_ID,
    venue_room_layouts: [],
    venue_accessibility_features: [],
    venue_facilities: [],
    venue_operating_hours: [],
    ...overrides,
  };
}

/**
 * A stand-in for a supabase-js query builder.
 *
 * Every builder method records its arguments and returns the same object, so a
 * chain of any length works and a test can ask what the service requested. The
 * builder is thenable because supabase-js resolves the chain itself --
 * searchVenues awaits .order(...) rather than a terminal method.
 *
 * `result` must stay a plain object: resolving a promise with another thenable
 * re-enters unwrapping, and resolving one with itself is a chaining cycle.
 */
function queryStub(result) {
  const calls = [];

  const stub = {
    /** Was this builder method used at all? */
    called: (method) => calls.some(([name]) => name === method),
    /** The arguments the service passed to it. */
    args: (method) => calls.find(([name]) => name === method)?.slice(1),
    then: (onFulfilled, onRejected) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  };

  for (const method of ['select', 'eq', 'is', 'in', 'ilike', 'gte', 'order', 'limit', 'delete', 'lt', 'gt', 'lte', 'not']) {
    stub[method] = (...args) => {
      calls.push([method, ...args]);
      return stub;
    };
  }

  stub.maybeSingle = (...args) => {
    calls.push(['maybeSingle', ...args]);
    return Promise.resolve(result);
  };

  return stub;
}

/**
 * A venue row with its join tables populated, in deliberately wrong order.
 *
 * retiredVenueRow leaves these empty, which means the flattening and sorting
 * in getVenueById never runs over anything. This fixture is what proves it.
 */
function populatedVenueRow(overrides = {}) {
  return retiredVenueRow({
    retired_at: null,
    turnaround_minutes: 45,
    venue_room_layouts: [
      { room_layout_code: 'theatre' },
      { room_layout_code: 'classroom' },
    ],
    venue_accessibility_features: [
      { accessibility_feature_code: 'lift_access' },
      { accessibility_feature_code: 'hearing_loop' },
    ],
    venue_facilities: [{ facility_code: 'wifi' }, { facility_code: 'projector' }],
    venue_operating_hours: [
      { day_of_week: 3, opens_at: '09:00:00', closes_at: '18:00:00' },
      { day_of_week: 1, opens_at: '08:00:00', closes_at: '17:00:00' },
    ],
    ...overrides,
  });
}

/** A create or update that succeeds, reading back as `row`. */
function givenWriteSucceeds(row, newId = null) {
  rpc.mockResolvedValue({ data: newId, error: null });
  const read = queryStub({ data: row, error: null });
  from.mockReturnValue(read);
  return read;
}

/** The whole rpc payload the service sent. */
function rpcArgs() {
  return rpc.mock.calls[0][1];
}

/** Wire the client up for a retirement that succeeds, and hand back the read. */
function givenRetirementSucceeds(row = retiredVenueRow()) {
  rpc.mockResolvedValue({ data: null, error: null });
  const read = queryStub({ data: row, error: null });
  from.mockReturnValue(read);
  return read;
}

/** Wire the client up for a search returning these rows. */
function givenSearchReturns(rows) {
  const query = queryStub({ data: rows, error: null });
  from.mockReturnValue(query);
  return query;
}

/**
 * Wire the client up for a catalogue listing returning these rows.
 *
 * Identical in body to givenSearchReturns and deliberately not shared with it:
 * the two reads are the pair this story is about, and a single helper named
 * after neither would make the tests below look like search tests. Named
 * separately, the diff between the two blocks is the diff between the two
 * queries, which is the whole point.
 */
function givenCatalogueReturns(rows) {
  const query = queryStub({ data: rows, error: null });
  from.mockReturnValue(query);
  return query;
}

// resetAllMocks, not clearAllMocks: clearing keeps implementations, so a
// mockReturnValue left over from one test would quietly serve the next. Every
// test therefore states its own setup, and one that forgets fails loudly.
beforeEach(() => {
  vi.resetAllMocks();
});


// ---------------------------------------------------------------------------
// The harness has to be trustworthy before anything it proves is worth having
// ---------------------------------------------------------------------------
describe('the test double', () => {
  it('has replaced the real Supabase client', () => {
    // backend/.env exists on a developer machine, so a mock that failed to
    // apply would not throw -- it would run these tests against live data and
    // pass. Fail here instead.
    expect(vi.isMockFunction(supabase.rpc)).toBe(true);
    expect(vi.isMockFunction(supabase.from)).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-110
// AC3: "A venue can be retired so it no longer appears in searches, while its
//       past bookings remain viewable."
// ---------------------------------------------------------------------------
describe('AC3: a venue can be retired', () => {
  it('asks the database to retire that venue', async () => {
    givenRetirementSucceeds();

    await retireVenue(VENUE_ID, STAFF_ID);

    expect(rpc).toHaveBeenCalledWith('retire_venue', {
      p_id: VENUE_ID,
      p_user_id: STAFF_ID,
    });
  });

  it('records who retired it, so the audit trigger names the right person', async () => {
    // AC4. retire_venue writes last_modified_by in the same statement as
    // retired_at precisely so the history does not credit the previous editor.
    givenRetirementSucceeds();

    await retireVenue(VENUE_ID, STAFF_ID);

    expect(rpc.mock.calls[0][1].p_user_id).toBe(STAFF_ID);
  });

  it('passes a null user when none is supplied', async () => {
    givenRetirementSucceeds();

    await retireVenue(VENUE_ID);

    expect(rpc.mock.calls[0][1].p_user_id).toBeNull();
  });

  it('returns the venue with retiredAt set', async () => {
    givenRetirementSucceeds();

    const venue = await retireVenue(VENUE_ID, STAFF_ID);

    expect(venue).toMatchObject({ id: VENUE_ID, retiredAt: RETIRED_AT });
  });

  it('reads the venue back instead of trusting the write', async () => {
    // retired_at comes from the database clock, so the real timestamp can only
    // be reported by reading the row.
    const read = givenRetirementSucceeds();

    await retireVenue(VENUE_ID, STAFF_ID);

    expect(from).toHaveBeenCalledWith('venues');
    expect(read.args('eq')).toEqual(['id', VENUE_ID]);
  });

  it('never deletes the row, so past bookings stay viewable', async () => {
    const read = givenRetirementSucceeds();

    await retireVenue(VENUE_ID, STAFF_ID);

    expect(read.called('delete')).toBe(false);
  });

  it('leaves a retired venue readable by id', async () => {
    givenRetirementSucceeds();

    const venue = await retireVenue(VENUE_ID, STAFF_ID);

    expect(venue.name).toBe('Seminar Room 2-1');
  });
});


// ---------------------------------------------------------------------------
// SCRUM-110: what retirement refuses, and how it says so
// ---------------------------------------------------------------------------
describe('retirement refuses what it cannot do', () => {
  it('reports a venue that does not exist as not found', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0002', message: `venue ${VENUE_ID} not found` },
    });

    const err = await errorFromAsync(() => retireVenue(VENUE_ID, STAFF_ID));

    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
  });

  it('reports a venue that is already retired as a conflict', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: 'PT409', message: `venue ${VENUE_ID} is already retired` },
    });

    const err = await errorFromAsync(() => retireVenue(VENUE_ID, STAFF_ID));

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toMatch(/already retired/i);
  });

  it('reports a 409 status for Express to use', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: 'PT409', message: `venue ${VENUE_ID} is already retired` },
    });

    const err = await errorFromAsync(() => retireVenue(VENUE_ID, STAFF_ID));

    expect(err.status).toBe(409);
  });

  it('does not read the venue back when the retirement failed', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: 'PT409', message: `venue ${VENUE_ID} is already retired` },
    });

    await errorFromAsync(() => retireVenue(VENUE_ID, STAFF_ID));

    expect(from).not.toHaveBeenCalled();
  });

  it('blames the editing user, not the lookup tables, for an unknown user', async () => {
    // last_modified_by is the only column retire_venue writes, and it is a
    // foreign key -- so the generic "unknown code" message would be wrong.
    rpc.mockResolvedValue({
      data: null,
      error: {
        code: '23503',
        message:
          'insert or update on table "venues" violates foreign key ' +
          'constraint "venues_last_modified_by_fkey"',
      },
    });

    const err = await errorFromAsync(() => retireVenue(VENUE_ID, STAFF_ID));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/editing user/i);
    expect(err.message).not.toMatch(/room_layouts/);
  });

  it('surfaces an unrecognised database error rather than mislabelling it', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: '08006', message: 'connection failure' },
    });

    const err = await errorFromAsync(() => retireVenue(VENUE_ID, STAFF_ID));

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err.status).toBeUndefined();
  });

  it.each(['', '   ', 'not-a-uuid', '42', null, undefined, 42, {}, []])(
    'refuses %o as a venue id before any network call',
    async (value) => {
      const err = await errorFromAsync(() => retireVenue(value, STAFF_ID));

      expect(err).toBeInstanceOf(ValidationError);
      expect(rpc).not.toHaveBeenCalled();
    },
  );
});


// ---------------------------------------------------------------------------
// SCRUM-111
// AC3, from the other side: a retired venue must drop out of searches.
// ---------------------------------------------------------------------------
describe('AC3: searches return only active venues', () => {
  it('asks the database for active venues only', async () => {
    const query = givenSearchReturns([]);

    await searchVenues();

    expect(from).toHaveBeenCalledWith('venues');
    expect(query.args('is')).toEqual(['retired_at', null]);
  });

  it('applies that filter even when nothing else is filtered', async () => {
    // AC3 is the rule for every search, not an option the caller can drop.
    const query = givenSearchReturns([]);

    await searchVenues({});

    expect(query.args('is')).toEqual(['retired_at', null]);
  });

  it('orders results by name', async () => {
    const query = givenSearchReturns([]);

    await searchVenues();

    expect(query.args('order')).toEqual(['name']);
  });

  it('returns an empty list when nothing matches, rather than throwing', async () => {
    givenSearchReturns([]);

    await expect(searchVenues()).resolves.toEqual([]);
  });

  it('filters by location, case-insensitively and as a substring', async () => {
    const query = givenSearchReturns([]);

    await searchVenues({ location: 'SCIS' });

    expect(query.args('ilike')).toEqual(['location', '%SCIS%']);
  });

  it('filters by minimum capacity', async () => {
    const query = givenSearchReturns([]);

    await searchVenues({ minCapacity: 40 });

    expect(query.args('gte')).toEqual(['max_capacity', 40]);
  });

  it.each([
    ['location', { location: 'SCIS' }, 'gte'],
    ['capacity', { minCapacity: 40 }, 'ilike'],
  ])('leaves the other filter off when only %s is given', async (_label, filters, absent) => {
    const query = givenSearchReturns([]);

    await searchVenues(filters);

    expect(query.called(absent)).toBe(false);
  });

  it('treats an unfilled search box as no filter at all', async () => {
    const query = givenSearchReturns([]);

    await searchVenues({ location: '   ', minCapacity: '' });

    expect(query.called('ilike')).toBe(false);
    expect(query.called('gte')).toBe(false);
    expect(query.args('is')).toEqual(['retired_at', null]);
  });

  it('returns the shape the API sends to React', async () => {
    givenSearchReturns([
      {
        id: VENUE_ID,
        name: 'Seminar Room 2-1',
        location: 'Level 2, SCIS',
        max_capacity: 40,
      },
    ]);

    await expect(searchVenues()).resolves.toEqual([
      {
        id: VENUE_ID,
        name: 'Seminar Room 2-1',
        location: 'Level 2, SCIS',
        maxCapacity: 40,
      },
    ]);
  });

  it.each([
    ['zero', 0],
    ['negative', -10],
    ['fractional', 12.5],
    ['text', '40'],
  ])('refuses a minimum capacity that is %s, before any network call', async (_label, value) => {
    const err = await errorFromAsync(() => searchVenues({ minCapacity: value }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(from).not.toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// SCRUM-110
// AC3: "A venue can be retired so it no longer appears in searches, while its
//       past bookings remain viewable."
//
// The other half of that sentence. Retirement hides a venue from searches, so
// the people who retire them need one list that still shows them -- otherwise
// a venue vanishes from the only view its owners have the moment they retire
// it, and they can never tell a retirement from a deletion.
// ---------------------------------------------------------------------------
describe('AC3: the staff catalogue lists retired venues too', () => {
  /** A second venue, so the shape test can carry one of each. */
  const RETIRED_VENUE_ID = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';

  it('asks the database for every venue, retired or not', async () => {
    const query = givenCatalogueReturns([]);

    await listVenues();

    // Same table as the search above, so a typo here would read an empty or
    // nonexistent relation and every other assertion in this block would be
    // about nothing.
    expect(from).toHaveBeenCalledWith('venues');

    // The assertion this whole story turns on, and the exact inverse of the
    // search block's `expect(query.args('is')).toEqual(['retired_at', null])`.
    // Without it, nothing stops someone reimplementing this on top of
    // searchVenues or copying its filter across "for consistency": the call
    // would still return rows, the shape test below would still pass, and the
    // catalogue would silently lose exactly the venues it exists to show.
    expect(query.called('is')).toBe(false);
  });

  it('selects retired_at, so a caller can tell which are retired', async () => {
    const query = givenCatalogueReturns([]);

    await listVenues();

    // searchVenues' select omits retired_at entirely. Without this column the
    // rows come back indistinguishable from one another, and the dashboard
    // could not badge one Active and the next Retired however faithfully it
    // renders what it is given -- so listing retired venues would be pointless.
    expect(query.args('select')[0]).toMatch(/retired_at/);
  });

  it('orders results by name', async () => {
    const query = givenCatalogueReturns([]);

    await listVenues();

    // Ordering is the server's rule, matching searchVenues. Drop it and rows
    // arrive in whatever order Postgres finds them, so the catalogue reshuffles
    // between loads and the row a staff member is about to click moves.
    expect(query.args('order')).toEqual(['name']);
  });

  it('returns the shape the dashboard renders', async () => {
    givenCatalogueReturns([
      {
        id: VENUE_ID,
        name: 'Seminar Room 2-1',
        location: 'Level 2, SCIS',
        max_capacity: 40,
        retired_at: null,
      },
      {
        id: RETIRED_VENUE_ID,
        name: 'Seminar Room 3-1',
        location: 'Level 3, SCIS',
        max_capacity: 30,
        retired_at: RETIRED_AT,
      },
    ]);

    // Both cases in one assertion on purpose: an active venue must carry
    // retiredAt: null rather than omitting the key, because the badge turns on
    // the value and `undefined` would render every venue as active. And the
    // snake_case max_capacity must not leak through -- every other read in
    // this service hands React camelCase, and one that did not would be a
    // silent `undefined` in the UI rather than an error anyone would see.
    await expect(listVenues()).resolves.toEqual([
      {
        id: VENUE_ID,
        name: 'Seminar Room 2-1',
        location: 'Level 2, SCIS',
        maxCapacity: 40,
        retiredAt: null,
      },
      {
        id: RETIRED_VENUE_ID,
        name: 'Seminar Room 3-1',
        location: 'Level 3, SCIS',
        maxCapacity: 30,
        retiredAt: RETIRED_AT,
      },
    ]);
  });

  it('returns an empty list for an empty catalogue, rather than throwing', async () => {
    givenCatalogueReturns([]);

    await expect(listVenues()).resolves.toEqual([]);

    // And the same for a null body. The `data ?? []` guard is the only thing
    // between a driver that answers null and `null.map(...)`, which the route
    // would turn into a 500 for what is simply a deployment with no venues in
    // it yet -- the state every new environment starts in.
    givenCatalogueReturns(null);

    await expect(listVenues()).resolves.toEqual([]);
  });

  it('translates a database error rather than leaking the driver message', async () => {
    const query = queryStub({
      data: null,
      error: { code: '42P01', message: 'relation "venues" does not exist' },
    });
    from.mockReturnValue(query);

    const err = await errorFromAsync(() => listVenues());

    // 42P01 is nobody's bad input, so mislabelling it a ValidationError would
    // answer 400 and tell a staff member to correct a form they never filled
    // in. Untyped means status undefined, which handleError turns into a 500 --
    // the honest answer for a broken deployment.
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err.status).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// SCRUM-106
// AC1: "A venue record can be created with name, location, maximum capacity,
//       supported room layouts, accessibility features, available facilities,
//       and operating hours."
// ---------------------------------------------------------------------------
describe('AC1: a venue is created with its details and attributes', () => {
  const NEW_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

  /** The least a venue can be created with. */
  const MINIMAL = Object.freeze({
    name: 'Seminar Room 2-1',
    location: 'Level 2, SCIS',
    maxCapacity: 40,
  });

  it('calls create_venue with the venue details', async () => {
    givenWriteSucceeds(populatedVenueRow(), NEW_ID);

    await createVenue(MINIMAL, STAFF_ID);

    expect(rpc).toHaveBeenCalledWith('create_venue', expect.objectContaining({
      p_name: 'Seminar Room 2-1',
      p_location: 'Level 2, SCIS',
      p_max_capacity: 40,
    }));
  });

  it('sends each attribute set through as an array of codes', async () => {
    givenWriteSucceeds(populatedVenueRow(), NEW_ID);

    await createVenue({
      ...MINIMAL,
      layouts: ['classroom'],
      accessibility: ['lift_access'],
      facilities: ['projector', 'wifi'],
    }, STAFF_ID);

    expect(rpcArgs()).toMatchObject({
      p_layouts: ['classroom'],
      p_accessibility: ['lift_access'],
      p_facilities: ['projector', 'wifi'],
    });
  });

  it.each(['p_layouts', 'p_accessibility', 'p_facilities', 'p_hours'])(
    'sends an empty %s when that attribute set was omitted',
    async (param) => {
      // Not null. create_venue coalesces, but an omitted set must mean "none"
      // here, the way an omitted set on update means "leave alone".
      givenWriteSucceeds(populatedVenueRow(), NEW_ID);

      await createVenue(MINIMAL, STAFF_ID);

      expect(rpcArgs()[param]).toEqual([]);
    },
  );

  it('records the creating user', async () => {
    // AC4: every change records the editing user.
    givenWriteSucceeds(populatedVenueRow(), NEW_ID);

    await createVenue(MINIMAL, STAFF_ID);

    expect(rpcArgs().p_user_id).toBe(STAFF_ID);
  });

  it('passes a null user when none is supplied', async () => {
    givenWriteSucceeds(populatedVenueRow(), NEW_ID);

    await createVenue(MINIMAL);

    expect(rpcArgs().p_user_id).toBeNull();
  });

  it('returns the new venue by reading back the id the function produced', async () => {
    const read = givenWriteSucceeds(populatedVenueRow({ id: NEW_ID }), NEW_ID);

    const venue = await createVenue(MINIMAL, STAFF_ID);

    expect(read.args('eq')).toEqual(['id', NEW_ID]);
    expect(venue.id).toBe(NEW_ID);
  });

  it.each([
    ['a missing name', { location: 'Level 2, SCIS', maxCapacity: 40 }],
    ['a blank location', { name: 'Room', location: '  ', maxCapacity: 40 }],
    ['a fractional capacity', { ...MINIMAL, maxCapacity: 12.5 }],
  ])('refuses %s before any network call', async (_label, input) => {
    // Validation is SCRUM-94's job; this asserts the service defers to it
    // rather than letting the database be the first line of defence.
    const err = await errorFromAsync(() => createVenue(input, STAFF_ID));

    expect(err).toBeInstanceOf(ValidationError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reports an unknown facility code as a validation error', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: {
        code: '23503',
        message:
          'insert or update on table "venue_facilities" violates foreign key ' +
          'constraint "venue_facilities_facility_code_fkey"',
      },
    });

    const err = await errorFromAsync(() => createVenue(MINIMAL, STAFF_ID));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/room_layouts|facilities/);
  });

  it('reports a capacity the database refuses as a validation error', async () => {
    // The check constraint in 002 is the backstop for writes that bypass
    // validation -- direct SQL, or a rule validation deliberately omits.
    rpc.mockResolvedValue({
      data: null,
      error: {
        code: '23514',
        message: 'new row violates check constraint "venues_max_capacity_check"',
      },
    });

    const err = await errorFromAsync(() => createVenue(MINIMAL, STAFF_ID));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
  });

  it('reports two sets of opening hours for one day as a conflict', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "venue_operating_hours_pkey"',
      },
    });

    const err = await errorFromAsync(() => createVenue(MINIMAL, STAFF_ID));

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-106
// AC2: "An authorised change to a venue's details is saved and reflected in
//       subsequent venue searches."
// ---------------------------------------------------------------------------
describe('AC2: an authorised change is saved', () => {
  it('calls update_venue for that venue', async () => {
    givenWriteSucceeds(populatedVenueRow());

    await updateVenue(VENUE_ID, { maxCapacity: 80 }, STAFF_ID);

    expect(rpc).toHaveBeenCalledWith('update_venue', expect.objectContaining({
      p_id: VENUE_ID,
      p_max_capacity: 80,
    }));
  });

  it.each(['p_name', 'p_location', 'p_layouts', 'p_accessibility', 'p_facilities', 'p_hours', 'p_turnaround_minutes'])(
    'sends null for %s when it was not supplied, so the function leaves it alone',
    async (param) => {
      // 004_venue_functions.sql: NULL means "leave unchanged". Sending
      // anything else here would silently overwrite a field nobody edited.
      givenWriteSucceeds(populatedVenueRow());

      await updateVenue(VENUE_ID, { maxCapacity: 80 }, STAFF_ID);

      expect(rpcArgs()[param]).toBeNull();
    },
  );

  it('sends an array to replace an attribute set entirely', async () => {
    givenWriteSucceeds(populatedVenueRow());

    await updateVenue(VENUE_ID, { facilities: ['projector'] }, STAFF_ID);

    expect(rpcArgs().p_facilities).toEqual(['projector']);
  });

  it('sends an empty array to clear one', async () => {
    // The distinction that makes the API safe: omitting facilities cannot
    // wipe them, but passing [] deliberately does.
    givenWriteSucceeds(populatedVenueRow());

    await updateVenue(VENUE_ID, { facilities: [] }, STAFF_ID);

    expect(rpcArgs().p_facilities).toEqual([]);
  });

  it('never sends undefined for any parameter', async () => {
    // undefined is dropped in transit, so the function would fall back to its
    // own default rather than the null the service meant.
    givenWriteSucceeds(populatedVenueRow());

    await updateVenue(VENUE_ID, { maxCapacity: 80 }, STAFF_ID);

    expect(Object.values(rpcArgs()).every((value) => value !== undefined)).toBe(true);
  });

  it('records the editing user', async () => {
    givenWriteSucceeds(populatedVenueRow());

    await updateVenue(VENUE_ID, { maxCapacity: 80 }, STAFF_ID);

    expect(rpcArgs().p_user_id).toBe(STAFF_ID);
  });

  it('returns the updated venue by reading it back', async () => {
    const read = givenWriteSucceeds(populatedVenueRow({ max_capacity: 80 }));

    const venue = await updateVenue(VENUE_ID, { maxCapacity: 80 }, STAFF_ID);

    expect(read.args('eq')).toEqual(['id', VENUE_ID]);
    expect(venue.maxCapacity).toBe(80);
  });

  it('reports a venue that does not exist as not found', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0002', message: `venue ${VENUE_ID} not found` },
    });

    const err = await errorFromAsync(() => updateVenue(VENUE_ID, { maxCapacity: 80 }, STAFF_ID));

    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
  });

  it('recognises a not-found message even without the error code', async () => {
    // The code branches are the reliable path; this message fallback is the
    // safety net for a driver that does not pass one through.
    rpc.mockResolvedValue({
      data: null,
      error: { code: undefined, message: 'venue not found' },
    });

    const err = await errorFromAsync(() => updateVenue(VENUE_ID, { maxCapacity: 80 }, STAFF_ID));

    expect(err).toBeInstanceOf(NotFoundError);
  });

  it('refuses a change set that changes nothing, before any network call', async () => {
    const err = await errorFromAsync(() => updateVenue(VENUE_ID, {}, STAFF_ID));

    expect(err).toBeInstanceOf(ValidationError);
    expect(rpc).not.toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// SCRUM-106: the read both writes depend on
// ---------------------------------------------------------------------------
describe('reading one venue', () => {
  it('selects the venue by id', async () => {
    const read = queryStub({ data: populatedVenueRow(), error: null });
    from.mockReturnValue(read);

    await getVenueById(VENUE_ID);

    expect(from).toHaveBeenCalledWith('venues');
    expect(read.args('eq')).toEqual(['id', VENUE_ID]);
  });

  it('flattens join rows into plain arrays of codes', async () => {
    // Callers want ['projector','wifi'], not [{facility_code:'projector'}].
    from.mockReturnValue(queryStub({ data: populatedVenueRow(), error: null }));

    const venue = await getVenueById(VENUE_ID);

    expect(venue.facilities).toEqual(['projector', 'wifi']);
    expect(venue.layouts).toEqual(['classroom', 'theatre']);
    expect(venue.accessibility).toEqual(['hearing_loop', 'lift_access']);
  });

  it('sorts codes, so the same venue always reads back the same way', async () => {
    // The fixture supplies them in the wrong order deliberately.
    from.mockReturnValue(queryStub({ data: populatedVenueRow(), error: null }));

    const venue = await getVenueById(VENUE_ID);

    expect(venue.layouts).toEqual([...venue.layouts].sort());
    expect(venue.facilities).toEqual([...venue.facilities].sort());
  });

  it('orders opening hours by day of week', async () => {
    from.mockReturnValue(queryStub({ data: populatedVenueRow(), error: null }));

    const venue = await getVenueById(VENUE_ID);

    expect(venue.hours.map((h) => h.day_of_week)).toEqual([1, 3]);
  });

  it('maps every column to the camelCase shape the API returns', async () => {
    from.mockReturnValue(queryStub({ data: populatedVenueRow(), error: null }));

    const venue = await getVenueById(VENUE_ID);

    expect(venue).toMatchObject({
      id: VENUE_ID,
      name: 'Seminar Room 2-1',
      location: 'Level 2, SCIS',
      maxCapacity: 40,
      retiredAt: null,
      lastModifiedBy: STAFF_ID,
    });
    expect(venue.createdAt).toBeDefined();
    expect(venue.updatedAt).toBeDefined();
  });

  it('returns a retired venue rather than hiding it', async () => {
    // AC3 keeps a retired venue viewable. Dropping it from searches is
    // searchVenues' job, and deliberately not this one's.
    from.mockReturnValue(queryStub({ data: retiredVenueRow(), error: null }));

    const venue = await getVenueById(VENUE_ID);

    expect(venue.retiredAt).toBe(RETIRED_AT);
  });

  it('raises not found when there is no such venue', async () => {
    from.mockReturnValue(queryStub({ data: null, error: null }));

    const err = await errorFromAsync(() => getVenueById(VENUE_ID));

    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
  });

  it('translates a database error rather than leaking the driver message', async () => {
    from.mockReturnValue(queryStub({
      data: null,
      error: { code: '23514', message: 'new row violates check constraint "x"' },
    }));

    const err = await errorFromAsync(() => getVenueById(VENUE_ID));

    expect(err).toBeInstanceOf(ValidationError);
  });
});


// ---------------------------------------------------------------------------
// AC4: "Every change records the editing user, a timestamp, and the previous
//       values." The timestamp and previous values are the trigger's job; the
//       user is the service's, and every write has to carry it the same way.
// ---------------------------------------------------------------------------
describe('AC4: every write records who made it', () => {
  it.each([
    ['create_venue', () => createVenue({ name: 'R', location: 'L', maxCapacity: 1 }, STAFF_ID)],
    ['update_venue', () => updateVenue(VENUE_ID, { maxCapacity: 80 }, STAFF_ID)],
    ['retire_venue', () => retireVenue(VENUE_ID, STAFF_ID)],
  ])('%s is told who is making the change', async (_fn, call) => {
    givenWriteSucceeds(populatedVenueRow(), VENUE_ID);

    await call();

    expect(rpcArgs().p_user_id).toBe(STAFF_ID);
  });
});


// ---------------------------------------------------------------------------
// AC4 -- reading the audit trail back
// ---------------------------------------------------------------------------
describe('AC4: the previous values can be read back', () => {
  it('SCRUM15_AC4_reads_one_venues_history_newest_first', async () => {
    const stub = queryStub({ data: [], error: null });
    from.mockReturnValueOnce(stub);

    await getVenueHistory(VENUE_ID);

    expect(from).toHaveBeenCalledWith('venue_change_history');
    expect(stub.args('eq')).toEqual(['venue_id', VENUE_ID]);
    expect(stub.args('order')).toEqual(['changed_at', { ascending: false }]);
  });

  it('SCRUM15_AC4_maps_the_row_into_camelCase_but_leaves_the_values_alone', async () => {
    from.mockReturnValueOnce(queryStub({ data: [{
      id: 'h1',
      venue_id: VENUE_ID,
      changed_by: STAFF_ID,
      changed_at: '2026-09-15T10:00:00+00:00',
      old_values: { max_capacity: 40 },
      new_values: { max_capacity: 60 },
    }], error: null }));

    const [entry] = await getVenueHistory(VENUE_ID);

    expect(entry).toEqual({
      id: 'h1',
      venueId: VENUE_ID,
      changedBy: STAFF_ID,
      changedAt: '2026-09-15T10:00:00+00:00',
      oldValues: { max_capacity: 40 },
      newValues: { max_capacity: 60 },
    });

    // The jsonb payloads keep the column names the database recorded. They are
    // a record of what changed, not an API shape to be rewritten -- and an
    // attribute change, a scalar change and a creation all carry different
    // keys by design.
    expect(Object.keys(entry.oldValues)).toEqual(['max_capacity']);
  });

  it('SCRUM15_AC4_returns_an_empty_list_for_a_venue_with_no_history', async () => {
    from.mockReturnValueOnce(queryStub({ data: [], error: null }));

    await expect(getVenueHistory(VENUE_ID)).resolves.toEqual([]);
  });

  it('SCRUM15_AC4_rejects_a_malformed_id_before_any_network_call', async () => {
    const err = await errorFromAsync(() => getVenueHistory('not-a-uuid'));

    expect(err).toBeInstanceOf(ValidationError);
    expect(from).not.toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// AC3 -- "while its past bookings remain viewable"
// ---------------------------------------------------------------------------
describe('AC3: a retired venue keeps its bookings', () => {
  it('SCRUM15_AC3_reads_one_venues_bookings_most_recent_first', async () => {
    const stub = queryStub({ data: [], error: null });
    from.mockReturnValueOnce(stub);

    await getBookingsForVenue(VENUE_ID);

    expect(from).toHaveBeenCalledWith('bookings');
    expect(stub.args('eq')).toEqual(['venue_id', VENUE_ID]);
    expect(stub.args('order')).toEqual(['starts_at', { ascending: false }]);
  });

  it('SCRUM15_AC3_does_not_filter_on_the_venue_being_active', async () => {
    const stub = queryStub({ data: [], error: null });
    from.mockReturnValueOnce(stub);

    await getBookingsForVenue(VENUE_ID);

    // The whole point of AC3's second clause. Applying .is('retired_at', null)
    // here -- as searchVenues correctly does -- would hide exactly the rows
    // retirement is supposed to preserve.
    expect(stub.called('is')).toBe(false);
  });

  it('SCRUM15_AC3_maps_a_booking_into_camelCase', async () => {
    from.mockReturnValueOnce(queryStub({ data: [{
      id: 'b1',
      venue_id: VENUE_ID,
      event_request_id: '22222222-2222-4222-8222-222222222222',
      starts_at: '2026-06-01T09:00:00+00:00',
      ends_at: '2026-06-01T17:00:00+00:00',
      created_at: '2026-05-01T09:00:00+00:00',
    }], error: null }));

    const [booking] = await getBookingsForVenue(VENUE_ID);

    expect(booking).toEqual({
      id: 'b1',
      venueId: VENUE_ID,
      eventRequestId: '22222222-2222-4222-8222-222222222222',
      startsAt: '2026-06-01T09:00:00+00:00',
      endsAt: '2026-06-01T17:00:00+00:00',
      createdAt: '2026-05-01T09:00:00+00:00',
    });
  });

  it('SCRUM15_AC3_returns_an_empty_list_rather_than_an_error', async () => {
    from.mockReturnValueOnce(queryStub({ data: [], error: null }));

    await expect(getBookingsForVenue(VENUE_ID)).resolves.toEqual([]);
  });

  it('SCRUM15_AC3_rejects_a_malformed_id_before_any_network_call', async () => {
    const err = await errorFromAsync(() => getBookingsForVenue('not-a-uuid'));

    expect(err).toBeInstanceOf(ValidationError);
    expect(from).not.toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// SCRUM-130 (SCRUM-17 AC2): "The blocked period is excluded from venue search
// results." from() is routed by table name, so the blocks read and the venues
// read each get their own stub.
// ---------------------------------------------------------------------------
describe('SCRUM17_AC2 a dated search leaves out venues blocked in the window', () => {
  const STARTS = '2026-10-01T10:00:00+08:00';
  const ENDS = '2026-10-01T12:00:00+08:00';
  const BLOCKED_A = 'a1b2c3d4-0000-4000-8000-00000000000a';
  const BLOCKED_B = 'a1b2c3d4-0000-4000-8000-00000000000b';
  const VENUE_ROW = { id: VENUE_ID, name: 'Seminar Room 2-1', location: 'Level 2, SCIS', max_capacity: 40 };

  /** Route from() by table; anything else is a test failure. */
  function givenTables({ blocks = { data: [], error: null }, venues = { data: [VENUE_ROW], error: null } } = {}) {
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

  it.each([
    ['no filters', undefined],
    ['an empty object', {}],
    ['blank dates', { startsAt: '', endsAt: '  ' }],
    ['location and capacity only', { location: 'SCIS', minCapacity: 40 }],
  ])('SCRUM17_AC2_with_%s_venue_blocks_is_never_queried_and_there_is_no_not', async (_label, filters) => {
    const { venuesStub } = givenTables();

    await searchVenues(filters);

    expect(tablesQueried()).toEqual(['venues']);
    expect(venuesStub.called('not')).toBe(false);
  });

  it('SCRUM17_AC2_with_a_window_blocks_are_read_first_then_not_in_is_applied', async () => {
    const { blocksStub, venuesStub } = givenTables({
      blocks: { data: [{ venue_id: BLOCKED_A }, { venue_id: BLOCKED_B }], error: null },
    });

    await searchVenues({ startsAt: STARTS, endsAt: ENDS });

    expect(tablesQueried()).toEqual(['venue_blocks', 'venues']);
    expect(blocksStub.args('lt')).toEqual(['starts_at', ENDS]);
    expect(blocksStub.args('gt')).toEqual(['ends_at', STARTS]);
    expect(venuesStub.args('not')).toEqual(['id', 'in', `(${BLOCKED_A},${BLOCKED_B})`]);
  });

  it('SCRUM17_AC2_a_venue_with_several_blocks_is_listed_once_in_the_not_in', async () => {
    const { venuesStub } = givenTables({
      blocks: {
        data: [{ venue_id: BLOCKED_A }, { venue_id: BLOCKED_A }, { venue_id: BLOCKED_B }],
        error: null,
      },
    });

    await searchVenues({ startsAt: STARTS, endsAt: ENDS });

    expect(venuesStub.args('not')).toEqual(['id', 'in', `(${BLOCKED_A},${BLOCKED_B})`]);
  });

  it.each([
    ['an empty list', []],
    ['null', null],
  ])('SCRUM17_AC2_when_nothing_is_blocked_(%s)_there_is_no_not', async (_label, data) => {
    const { venuesStub } = givenTables({ blocks: { data, error: null } });

    await searchVenues({ startsAt: STARTS, endsAt: ENDS });

    expect(tablesQueried()).toEqual(['venue_blocks', 'venues']);
    expect(venuesStub.called('not')).toBe(false);
  });

  it('SCRUM17_AC2_a_dated_search_keeps_the_retired_filter_and_name_order', async () => {
    const { venuesStub } = givenTables({
      blocks: { data: [{ venue_id: BLOCKED_A }], error: null },
    });

    await searchVenues({ startsAt: STARTS, endsAt: ENDS });

    expect(venuesStub.args('select')).toEqual(['id, name, location, max_capacity']);
    expect(venuesStub.args('is')).toEqual(['retired_at', null]);
    expect(venuesStub.args('order')).toEqual(['name']);
  });

  it('SCRUM17_AC2_a_dated_search_combines_with_location_and_capacity', async () => {
    const { venuesStub } = givenTables({
      blocks: { data: [{ venue_id: BLOCKED_A }], error: null },
    });

    await searchVenues({ location: 'SCIS', minCapacity: 40, startsAt: STARTS, endsAt: ENDS });

    expect(venuesStub.args('ilike')).toEqual(['location', '%SCIS%']);
    expect(venuesStub.args('gte')).toEqual(['max_capacity', 40]);
    expect(venuesStub.args('not')).toEqual(['id', 'in', `(${BLOCKED_A})`]);
    expect(venuesStub.args('is')).toEqual(['retired_at', null]);
  });

  it('SCRUM17_AC2_a_blocks_query_error_rejects_and_venues_is_never_queried', async () => {
    givenTables({ blocks: { data: null, error: { code: '22P02', message: 'bad' } } });

    await expect(searchVenues({ startsAt: STARTS, endsAt: ENDS })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(tablesQueried()).toEqual(['venue_blocks']);
  });

  it('SCRUM17_AC2_an_unknown_blocks_error_rejects_too', async () => {
    givenTables({ blocks: { data: null, error: { code: '08006', message: 'connection failure' } } });

    await expect(searchVenues({ startsAt: STARTS, endsAt: ENDS })).rejects.toThrow('connection failure');
    expect(tablesQueried()).toEqual(['venue_blocks']);
  });

  it.each([
    ['one-sided', { startsAt: STARTS }],
    ['reversed', { startsAt: ENDS, endsAt: STARTS }],
    ['malformed', { startsAt: '2026-10-01', endsAt: ENDS }],
  ])('SCRUM17_AC2_a_%s_window_is_refused_before_any_query', async (_label, filters) => {
    const err = await errorFromAsync(() => searchVenues(filters));
    expect(err).toBeInstanceOf(ValidationError);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM17_AC2_the_output_shape_is_unchanged_by_a_window', async () => {
    givenTables({ blocks: { data: [{ venue_id: BLOCKED_A }], error: null } });

    await expect(searchVenues({ startsAt: STARTS, endsAt: ENDS })).resolves.toEqual([
      { id: VENUE_ID, name: 'Seminar Room 2-1', location: 'Level 2, SCIS', maxCapacity: 40 },
    ]);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-185 (SCRUM-178 AC1): includeRetired drops the active-only filter and
// adds retiredAt, so a retired venue's calendar is reachable from search.
// Without the flag the query and the row keys must be exactly as before.
// ---------------------------------------------------------------------------
describe('SCRUM178_AC1 a search can include retired venues when asked', () => {
  const ACTIVE_ID = 'c0ffee00-0000-4000-8000-000000000001';
  const ACTIVE_ROW = { id: ACTIVE_ID, name: 'Active Room', location: 'Level 1, SCIS', max_capacity: 30 };
  const RETIRED_ROW = {
    id: VENUE_ID,
    name: 'Seminar Room 2-1',
    location: 'Level 2, SCIS',
    max_capacity: 40,
    retired_at: RETIRED_AT,
  };

  it.each([
    ['boolean', true],
    ['query string', 'true'],
  ])('SCRUM178_AC1_with_the_%s_flag_there_is_no_retired_at_filter', async (_label, flag) => {
    const query = givenSearchReturns([]);

    await searchVenues({ includeRetired: flag });

    expect(from).toHaveBeenCalledWith('venues');
    expect(query.called('is')).toBe(false);
    expect(query.args('select')).toEqual(['id, name, location, max_capacity, retired_at']);
    expect(query.args('order')).toEqual(['name']);
  });

  it('SCRUM178_AC1_with_the_flag_rows_carry_retiredAt_null_for_active_and_the_timestamp_for_retired', async () => {
    givenSearchReturns([{ ...ACTIVE_ROW, retired_at: null }, RETIRED_ROW]);

    await expect(searchVenues({ includeRetired: true })).resolves.toEqual([
      { id: ACTIVE_ID, name: 'Active Room', location: 'Level 1, SCIS', maxCapacity: 30, retiredAt: null },
      {
        id: VENUE_ID,
        name: 'Seminar Room 2-1',
        location: 'Level 2, SCIS',
        maxCapacity: 40,
        retiredAt: RETIRED_AT,
      },
    ]);
  });

  it('SCRUM178_AC1_with_the_flag_location_and_minCapacity_still_apply', async () => {
    const query = givenSearchReturns([]);

    await searchVenues({ includeRetired: 'true', location: 'SCIS', minCapacity: 40 });

    expect(query.args('ilike')).toEqual(['location', '%SCIS%']);
    expect(query.args('gte')).toEqual(['max_capacity', 40]);
    expect(query.called('is')).toBe(false);
  });

  it.each([
    ['no filters', undefined],
    ['includeRetired false', { includeRetired: false }],
    ["includeRetired 'false'", { includeRetired: 'false' }],
    ['a blank includeRetired', { includeRetired: '' }],
  ])('SCRUM178_AC1_with_%s_the_query_is_exactly_as_before', async (_label, filters) => {
    const query = givenSearchReturns([]);

    await searchVenues(filters);

    expect(query.args('select')).toEqual(['id, name, location, max_capacity']);
    expect(query.args('is')).toEqual(['retired_at', null]);
  });

  it('SCRUM178_AC1_without_the_flag_rows_keep_exactly_their_keys', async () => {
    // Even a row that somehow carried retired_at must not grow a retiredAt.
    givenSearchReturns([{ ...ACTIVE_ROW, retired_at: null }]);

    const [row] = await searchVenues();

    expect(Object.keys(row)).toEqual(['id', 'name', 'location', 'maxCapacity']);
  });

  it('SCRUM178_AC1_with_the_flag_rows_add_only_retiredAt', async () => {
    givenSearchReturns([RETIRED_ROW]);

    const [row] = await searchVenues({ includeRetired: true });

    expect(Object.keys(row)).toEqual(['id', 'name', 'location', 'maxCapacity', 'retiredAt']);
  });

  it('SCRUM178_AC1_the_flag_with_a_window_is_refused_before_any_network_call', async () => {
    const err = await errorFromAsync(() =>
      searchVenues({
        includeRetired: true,
        startsAt: '2026-10-01T10:00:00+08:00',
        endsAt: '2026-10-01T12:00:00+08:00',
      }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([
      {
        field: 'includeRetired',
        message: 'cannot be combined with a date window: a retired venue cannot be booked',
      },
    ]);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM178_AC1_a_junk_flag_is_refused_before_any_network_call', async () => {
    const err = await errorFromAsync(() => searchVenues({ includeRetired: 'yes' }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(from).not.toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// SCRUM-186: the turnaround between events
// ---------------------------------------------------------------------------
describe('SCRUM186 turnaround is written by create and update and read by id', () => {
  const NEW_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const MINIMAL = Object.freeze({
    name: 'Seminar Room 2-1',
    location: 'Level 2, SCIS',
    maxCapacity: 40,
  });

  it('SCRUM186_getVenueById_selects_turnaround_minutes', async () => {
    const read = queryStub({ data: populatedVenueRow(), error: null });
    from.mockReturnValue(read);

    await getVenueById(VENUE_ID);

    expect(read.args('select')[0]).toMatch(/\bturnaround_minutes\b/);
  });

  it('SCRUM186_getVenueById_maps_turnaround_minutes_to_turnaroundMinutes', async () => {
    from.mockReturnValue(queryStub({ data: populatedVenueRow(), error: null }));

    const venue = await getVenueById(VENUE_ID);

    expect(venue.turnaroundMinutes).toBe(45);
    expect(venue).not.toHaveProperty('turnaround_minutes');
  });

  it('SCRUM186_getVenueById_maps_a_zero_turnaround_as_0_not_missing', async () => {
    from.mockReturnValue(queryStub({ data: retiredVenueRow(), error: null }));

    const venue = await getVenueById(VENUE_ID);

    expect(venue.turnaroundMinutes).toBe(0);
  });

  it('SCRUM186_create_sends_the_default_0_when_turnaround_is_omitted', async () => {
    givenWriteSucceeds(populatedVenueRow(), NEW_ID);

    await createVenue(MINIMAL, STAFF_ID);

    expect(rpcArgs().p_turnaround_minutes).toBe(0);
  });

  it.each([0, 15, 30, 45, 60, 90, 120])(
    'SCRUM186_create_sends_the_given_turnaround_%s',
    async (minutes) => {
      givenWriteSucceeds(populatedVenueRow(), NEW_ID);

      await createVenue({ ...MINIMAL, turnaroundMinutes: minutes }, STAFF_ID);

      expect(rpcArgs().p_turnaround_minutes).toBe(minutes);
    },
  );

  it('SCRUM186_create_returns_the_turnaround_read_back', async () => {
    givenWriteSucceeds(populatedVenueRow({ id: NEW_ID, turnaround_minutes: 120 }), NEW_ID);

    const venue = await createVenue({ ...MINIMAL, turnaroundMinutes: 120 }, STAFF_ID);

    expect(venue.turnaroundMinutes).toBe(120);
  });

  it('SCRUM186_update_sends_null_when_only_the_name_changes', async () => {
    givenWriteSucceeds(populatedVenueRow());

    await updateVenue(VENUE_ID, { name: 'x' }, STAFF_ID);

    expect(rpcArgs().p_turnaround_minutes).toBeNull();
  });

  it('SCRUM186_update_sends_0_when_turnaround_is_set_back_to_none', async () => {
    // Catches a `|| null` regression: update_venue reads NULL as "keep", so
    // turning 0 into null would leave the old turnaround in place.
    givenWriteSucceeds(populatedVenueRow({ turnaround_minutes: 0 }));

    await updateVenue(VENUE_ID, { turnaroundMinutes: 0 }, STAFF_ID);

    expect(rpcArgs().p_turnaround_minutes).toBe(0);
    expect(rpcArgs().p_turnaround_minutes).not.toBeNull();
  });

  it('SCRUM186_update_turnaround_alone_leaves_every_other_field_null', async () => {
    givenWriteSucceeds(populatedVenueRow({ turnaround_minutes: 90 }));

    await updateVenue(VENUE_ID, { turnaroundMinutes: 90 }, STAFF_ID);

    expect(rpcArgs()).toEqual({
      p_id: VENUE_ID,
      p_name: null,
      p_location: null,
      p_max_capacity: null,
      p_layouts: null,
      p_accessibility: null,
      p_facilities: null,
      p_hours: null,
      p_turnaround_minutes: 90,
      p_setup_minutes: null,
      p_user_id: STAFF_ID,
    });
  });

  it('SCRUM186_update_returns_the_turnaround_read_back', async () => {
    givenWriteSucceeds(populatedVenueRow({ turnaround_minutes: 30 }));

    const venue = await updateVenue(VENUE_ID, { turnaroundMinutes: 30 }, STAFF_ID);

    expect(venue.turnaroundMinutes).toBe(30);
  });

  it('SCRUM186_create_rejects_turnaround_25_before_any_rpc', async () => {
    const err = await errorFromAsync(() =>
      createVenue({ ...MINIMAL, turnaroundMinutes: 25 }, STAFF_ID),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details.map((d) => d.field)).toEqual(['turnaroundMinutes']);
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM186_update_rejects_turnaround_25_before_any_rpc', async () => {
    const err = await errorFromAsync(() =>
      updateVenue(VENUE_ID, { turnaroundMinutes: 25 }, STAFF_ID),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details.map((d) => d.field)).toEqual(['turnaroundMinutes']);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['createVenue', () => createVenue(MINIMAL, STAFF_ID)],
    ['updateVenue', () => updateVenue(VENUE_ID, { turnaroundMinutes: 30 }, STAFF_ID)],
  ])('SCRUM186_%s_reports_23514_on_venues_turnaround_minutes_allowed_as_a_validation_error', async (_name, call) => {
    // The database CHECK is the backstop for writes that bypass validation.
    rpc.mockResolvedValue({
      data: null,
      error: {
        code: '23514',
        message:
          'new row for relation "venues" violates check constraint ' +
          '"venues_turnaround_minutes_allowed"',
      },
    });

    const err = await errorFromAsync(call);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(err.message).toContain('venues_turnaround_minutes_allowed');
    expect(from).not.toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// SCRUM-137 (SCRUM-20): the setup time before an event follows turnaround's
// path exactly -- written by create and update, read back by getVenueById.
// ---------------------------------------------------------------------------
describe('SCRUM20_SCRUM137 setup time is written by create and update and read by id', () => {
  const NEW_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const MINIMAL = Object.freeze({
    name: 'Seminar Room 2-1',
    location: 'Level 2, SCIS',
    maxCapacity: 40,
  });

  it('SCRUM20_SCRUM137_getVenueById_selects_setup_minutes', async () => {
    const read = queryStub({ data: populatedVenueRow({ setup_minutes: 30 }), error: null });
    from.mockReturnValue(read);

    await getVenueById(VENUE_ID);

    expect(read.args('select')[0]).toMatch(/\bsetup_minutes\b/);
  });

  it('SCRUM20_SCRUM137_getVenueById_maps_setup_minutes_to_setupMinutes', async () => {
    from.mockReturnValue(
      queryStub({ data: populatedVenueRow({ setup_minutes: 30 }), error: null }),
    );

    const venue = await getVenueById(VENUE_ID);

    expect(venue.setupMinutes).toBe(30);
    expect(venue).not.toHaveProperty('setup_minutes');
  });

  it('SCRUM20_SCRUM137_getVenueById_maps_a_zero_setup_as_0_not_missing', async () => {
    from.mockReturnValue(queryStub({ data: retiredVenueRow({ setup_minutes: 0 }), error: null }));

    const venue = await getVenueById(VENUE_ID);

    expect(venue.setupMinutes).toBe(0);
  });

  it('SCRUM20_SCRUM137_getVenueById_keeps_setup_and_turnaround_apart', async () => {
    from.mockReturnValue(
      queryStub({
        data: populatedVenueRow({ setup_minutes: 15, turnaround_minutes: 90 }),
        error: null,
      }),
    );

    const venue = await getVenueById(VENUE_ID);

    expect(venue.setupMinutes).toBe(15);
    expect(venue.turnaroundMinutes).toBe(90);
  });

  it('SCRUM20_SCRUM137_create_sends_the_default_0_when_setup_is_omitted', async () => {
    givenWriteSucceeds(populatedVenueRow(), NEW_ID);

    await createVenue(MINIMAL, STAFF_ID);

    expect(rpcArgs().p_setup_minutes).toBe(0);
  });

  it.each([0, 15, 30, 45, 60, 90, 120])(
    'SCRUM20_SCRUM137_create_sends_the_given_setup_%s',
    async (minutes) => {
      givenWriteSucceeds(populatedVenueRow(), NEW_ID);

      await createVenue({ ...MINIMAL, setupMinutes: minutes }, STAFF_ID);

      expect(rpcArgs().p_setup_minutes).toBe(minutes);
    },
  );

  it('SCRUM20_SCRUM137_create_sends_setup_and_turnaround_as_separate_params', async () => {
    givenWriteSucceeds(populatedVenueRow(), NEW_ID);

    await createVenue({ ...MINIMAL, setupMinutes: 30, turnaroundMinutes: 45 }, STAFF_ID);

    expect(rpcArgs().p_setup_minutes).toBe(30);
    expect(rpcArgs().p_turnaround_minutes).toBe(45);
  });

  it('SCRUM20_SCRUM137_create_returns_the_setup_read_back', async () => {
    givenWriteSucceeds(populatedVenueRow({ id: NEW_ID, setup_minutes: 120 }), NEW_ID);

    const venue = await createVenue({ ...MINIMAL, setupMinutes: 120 }, STAFF_ID);

    expect(venue.setupMinutes).toBe(120);
  });

  it('SCRUM20_SCRUM137_update_sends_null_when_setup_is_omitted', async () => {
    givenWriteSucceeds(populatedVenueRow());

    await updateVenue(VENUE_ID, { name: 'x' }, STAFF_ID);

    expect(rpcArgs()).toHaveProperty('p_setup_minutes', null);
  });

  it('SCRUM20_SCRUM137_update_sends_0_when_setup_is_set_back_to_none', async () => {
    // Catches a `|| null` regression: update_venue reads NULL as "keep", so
    // turning 0 into null would leave the old setup time in place.
    givenWriteSucceeds(populatedVenueRow({ setup_minutes: 0 }));

    await updateVenue(VENUE_ID, { setupMinutes: 0 }, STAFF_ID);

    expect(rpcArgs().p_setup_minutes).toBe(0);
    expect(rpcArgs().p_setup_minutes).not.toBeNull();
  });

  it('SCRUM20_SCRUM137_update_setup_alone_leaves_every_other_field_null', async () => {
    givenWriteSucceeds(populatedVenueRow({ setup_minutes: 60 }));

    await updateVenue(VENUE_ID, { setupMinutes: 60 }, STAFF_ID);

    expect(rpcArgs()).toEqual({
      p_id: VENUE_ID,
      p_name: null,
      p_location: null,
      p_max_capacity: null,
      p_layouts: null,
      p_accessibility: null,
      p_facilities: null,
      p_hours: null,
      p_turnaround_minutes: null,
      p_setup_minutes: 60,
      p_user_id: STAFF_ID,
    });
  });

  it('SCRUM20_SCRUM137_update_returns_the_setup_read_back', async () => {
    givenWriteSucceeds(populatedVenueRow({ setup_minutes: 30 }));

    const venue = await updateVenue(VENUE_ID, { setupMinutes: 30 }, STAFF_ID);

    expect(venue.setupMinutes).toBe(30);
  });

  it('SCRUM20_SCRUM137_create_rejects_setup_25_before_any_rpc', async () => {
    const err = await errorFromAsync(() =>
      createVenue({ ...MINIMAL, setupMinutes: 25 }, STAFF_ID),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details.map((d) => d.field)).toEqual(['setupMinutes']);
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM20_SCRUM137_update_rejects_setup_25_before_any_rpc', async () => {
    const err = await errorFromAsync(() =>
      updateVenue(VENUE_ID, { setupMinutes: 25 }, STAFF_ID),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details.map((d) => d.field)).toEqual(['setupMinutes']);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['createVenue', () => createVenue(MINIMAL, STAFF_ID)],
    ['updateVenue', () => updateVenue(VENUE_ID, { setupMinutes: 30 }, STAFF_ID)],
  ])('SCRUM20_SCRUM137_%s_reports_23514_on_venues_setup_minutes_allowed_as_a_validation_error', async (_name, call) => {
    // The database CHECK (023) is the backstop for writes that bypass validation.
    rpc.mockResolvedValue({
      data: null,
      error: {
        code: '23514',
        message:
          'new row for relation "venues" violates check constraint ' +
          '"venues_setup_minutes_allowed"',
      },
    });

    const err = await errorFromAsync(call);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(err.message).toContain('venues_setup_minutes_allowed');
    expect(from).not.toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// SCRUM-138, for SCRUM-20 (Search Venues Against Event Requirements):
//  AC1 required period and attendance, optional layout/accessibility/facilities;
//      an unknown code is a 400 naming it (B-AC1-11..13, B-AC1-16)
//  AC3/AC4 only venues meeting EVERY supplied criterion are returned (the rule
//      itself is unit-tested in tests/domain/venueMatching.test.js)
//  AC7 each result carries the display fields (B-AC7-01/02)
// Fixtures follow SCRUM-20-test-cases.md: Harbour Room and the base request.
// ---------------------------------------------------------------------------
describe('SCRUM20 findVenuesForEvent', () => {
  const HARBOUR_ID = '6c1a2d3e-0000-4000-8000-000000000001';

  /** Base request: Wednesday 2026-11-11, 10:00-12:00 Singapore. */
  const REQUIRED = Object.freeze({
    startsAt: '2026-11-11T10:00:00+08:00',
    endsAt: '2026-11-11T12:00:00+08:00',
    expectedAttendance: 80,
  });
  const BASE = Object.freeze({
    ...REQUIRED,
    layout: 'theatre',
    accessibility: ['step_free_entrance'],
    facilities: ['projector', 'wifi'],
  });

  /** Every code the lookup tables hold in these tests. */
  const KNOWN = {
    room_layouts: ['banquet', 'classroom', 'theatre'],
    accessibility_features: ['hearing_loop', 'lift_access', 'step_free_entrance'],
    facilities: ['catering', 'pa_system', 'projector', 'wifi'],
  };

  /** A venues row (as VENUE_WITH_ATTRIBUTES_SELECT returns it) for Harbour Room. */
  function harbourRow(overrides = {}) {
    return {
      id: HARBOUR_ID,
      name: 'Harbour Room',
      location: 'Level 1, Harbour Wing',
      max_capacity: 100,
      turnaround_minutes: 0,
      setup_minutes: 0,
      retired_at: null,
      created_at: '2026-09-12T09:00:00+00:00',
      updated_at: '2026-09-12T09:00:00+00:00',
      last_modified_by: STAFF_ID,
      venue_room_layouts: [{ room_layout_code: 'theatre' }, { room_layout_code: 'classroom' }],
      venue_accessibility_features: [
        { accessibility_feature_code: 'step_free_entrance' },
        { accessibility_feature_code: 'lift_access' },
      ],
      venue_facilities: [
        { facility_code: 'wifi' },
        { facility_code: 'projector' },
        { facility_code: 'pa_system' },
      ],
      venue_operating_hours: [{ day_of_week: 3, opens_at: '09:00:00', closes_at: '18:00:00' }],
      ...overrides,
    };
  }

  /**
   * Wire `from` per table: each lookup table answers with the KNOWN codes
   * that were asked for (as .in('code', ...) would), and `venues` with
   * `rows`. Any table can be given an error instead.
   */
  function givenEventSearch({ rows = [], errors = {}, known = KNOWN, bookings = [], blocks = [] } = {}) {
    const stubs = {};
    from.mockImplementation((table) => {
      if (table === 'venues') {
        stubs.venues = queryStub(
          errors.venues ? { data: null, error: errors.venues } : { data: rows, error: null },
        );
        return stubs.venues;
      }
      // SCRUM-139: the occupancy reads. Empty by default, so a venue that
      // passes the attributes is still returned; a test passes `bookings` /
      // `blocks` rows (or errors.bookings / errors.venue_blocks) to change
      // that. The stub returns every row it is given: it does not apply the
      // filters, it records them (all of them -- .in is called twice).
      if (table === 'bookings' || table === 'venue_blocks') {
        const occupied = table === 'bookings' ? bookings : blocks;
        const stub = queryStub(
          errors[table] ? { data: null, error: errors[table] } : { data: occupied, error: null },
        );
        stub.calls = [];
        for (const method of ['select', 'in', 'is', 'lt', 'gt']) {
          const inner = stub[method];
          stub[method] = (...args) => {
            stub.calls.push([method, ...args]);
            return inner(...args);
          };
        }
        stubs[table] = stub;
        return stub;
      }
      if (!(table in known)) throw new Error(`unexpected table ${table}`);
      // The stub resolves to a fixed result, so filter lazily on .in's argument.
      const stub = queryStub(null);
      const inner = stub.in;
      stub.in = (column, codes) => {
        inner(column, codes);
        const result = errors[table]
          ? { data: null, error: errors[table] }
          : { data: known[table].filter((c) => codes.includes(c)).map((code) => ({ code })), error: null };
        stub.then = (ok, ko) => Promise.resolve(result).then(ok, ko);
        return stub;
      };
      stubs[table] = stub;
      return stub;
    });
    return stubs;
  }

  // The venue and lookup-table reads (AC1/AC3). SCRUM-139's occupancy reads
  // (bookings, venue_blocks) are left out here and checked by occupancyTablesRead,
  // so the AC1 "which lookup tables were read" assertions keep their meaning.
  const OCCUPANCY_TABLES = ['bookings', 'venue_blocks'];
  const tablesRead = () =>
    from.mock.calls.map(([table]) => table).filter((table) => !OCCUPANCY_TABLES.includes(table));
  const occupancyTablesRead = () =>
    from.mock.calls.map(([table]) => table).filter((table) => OCCUPANCY_TABLES.includes(table));

  // --- AC1: inputs ---------------------------------------------------------

  it('SCRUM20_AC1_invalid_criteria_are_refused_before_any_database_call', async () => {
    givenEventSearch();

    const err = await errorFromAsync(() =>
      findVenuesForEvent({ startsAt: REQUIRED.startsAt, expectedAttendance: 0 }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(err.details.map((d) => d.field)).toEqual(['endsAt', 'expectedAttendance']);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM20_AC1_non_object_criteria_are_refused_before_any_database_call', async () => {
    const err = await errorFromAsync(() => findVenuesForEvent(undefined));

    expect(err).toBeInstanceOf(ValidationError);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM20_AC1_omitted_optional_criteria_do_not_filter', async () => {
    // B-AC1-16: no lookup table is read, and Harbour Room comes back.
    givenEventSearch({ rows: [harbourRow({ venue_room_layouts: [], venue_facilities: [] })] });

    const result = await findVenuesForEvent({ ...REQUIRED });

    expect(tablesRead()).toEqual(['venues']);
    expect(result.map((v) => v.name)).toEqual(['Harbour Room']);
  });

  it('SCRUM20_AC1_blank_optional_criteria_read_no_lookup_table', async () => {
    // B-AC1-15 at the service: blank / empty is "not supplied".
    givenEventSearch({ rows: [harbourRow()] });

    const result = await findVenuesForEvent({ ...REQUIRED, layout: ' ', accessibility: [], facilities: [] });

    expect(tablesRead()).toEqual(['venues']);
    expect(result).toHaveLength(1);
  });

  it('SCRUM20_AC1_only_the_supplied_kinds_are_looked_up', async () => {
    const stubs = givenEventSearch({ rows: [] });

    await findVenuesForEvent({ ...REQUIRED, facilities: ['wifi'] });

    expect(tablesRead()).toEqual(['facilities', 'venues']);
    expect(stubs.facilities.args('select')).toEqual(['code']);
    expect(stubs.facilities.args('in')).toEqual(['code', ['wifi']]);
  });

  it('SCRUM20_AC1_known_codes_are_checked_against_each_lookup_table', async () => {
    const stubs = givenEventSearch({ rows: [] });

    await findVenuesForEvent({ ...BASE });

    expect(tablesRead()).toEqual(['room_layouts', 'accessibility_features', 'facilities', 'venues']);
    expect(stubs.room_layouts.args('in')).toEqual(['code', ['theatre']]);
    expect(stubs.accessibility_features.args('in')).toEqual(['code', ['step_free_entrance']]);
    expect(stubs.facilities.args('in')).toEqual(['code', ['projector', 'wifi']]);
  });

  it('SCRUM20_AC1_unknown_layout_code_is_an_error', async () => {
    // B-AC1-11
    givenEventSearch({ rows: [harbourRow()] });

    const err = await errorFromAsync(() => findVenuesForEvent({ ...REQUIRED, layout: 'x' }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(err.details).toEqual([{ field: 'layout', message: 'unknown code "x"' }]);
    expect(tablesRead()).not.toContain('venues');
  });

  it('SCRUM20_AC1_unknown_accessibility_code_is_an_error', async () => {
    // B-AC1-12
    givenEventSearch({ rows: [harbourRow()] });

    const err = await errorFromAsync(() =>
      findVenuesForEvent({ ...REQUIRED, accessibility: ['ramp'] }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'accessibility', message: 'unknown code "ramp"' }]);
    expect(tablesRead()).not.toContain('venues');
  });

  it('SCRUM20_AC1_unknown_facility_code_is_an_error', async () => {
    // B-AC1-13: only the unknown one is named.
    givenEventSearch({ rows: [harbourRow()] });

    const err = await errorFromAsync(() =>
      findVenuesForEvent({ ...REQUIRED, facilities: ['projector', 'jacuzzi'] }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'facilities', message: 'unknown code "jacuzzi"' }]);
    expect(err.message).toContain('facilities: unknown code "jacuzzi"');
    expect(tablesRead()).not.toContain('venues');
  });

  it('SCRUM20_AC1_unknown_codes_across_kinds_are_reported_together', async () => {
    givenEventSearch({ rows: [harbourRow()] });

    const err = await errorFromAsync(() =>
      findVenuesForEvent({ ...REQUIRED, layout: 'ballroom', facilities: ['jacuzzi', 'wifi', 'sauna'] }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([
      { field: 'layout', message: 'unknown code "ballroom"' },
      { field: 'facilities', message: 'unknown code "jacuzzi"' },
      { field: 'facilities', message: 'unknown code "sauna"' },
    ]);
    expect(tablesRead()).not.toContain('venues');
  });

  it('SCRUM20_AC1_a_repeated_unknown_code_is_reported_once', async () => {
    const stubs = givenEventSearch({ rows: [] });

    const err = await errorFromAsync(() =>
      findVenuesForEvent({ ...REQUIRED, facilities: ['jacuzzi', ' jacuzzi'] }),
    );

    expect(stubs.facilities.args('in')).toEqual(['code', ['jacuzzi']]);
    expect(err.details).toEqual([{ field: 'facilities', message: 'unknown code "jacuzzi"' }]);
  });

  it('SCRUM20_AC1_every_fault_is_reported_at_once (shape faults stop before the code lookup)', async () => {
    // B-AC1-14, adjusted: shape errors and unknown-code errors cannot arrive
    // together, because validation throws before any code is looked up.
    givenEventSearch({ rows: [] });

    const shape = await errorFromAsync(() =>
      findVenuesForEvent({ startsAt: REQUIRED.startsAt, expectedAttendance: 0, facilities: ['jacuzzi'] }),
    );
    expect(shape).toBeInstanceOf(ValidationError);
    expect(shape.details.map((d) => d.field)).toEqual(['endsAt', 'expectedAttendance']);
    expect(from).not.toHaveBeenCalled();

    // Once the shape is fixed, the unknown code is the remaining fault.
    const codes = await errorFromAsync(() =>
      findVenuesForEvent({ ...REQUIRED, facilities: ['jacuzzi'] }),
    );
    expect(codes.details).toEqual([{ field: 'facilities', message: 'unknown code "jacuzzi"' }]);
  });

  it('SCRUM20_AC1_a_lookup_without_data_treats_every_code_as_unknown', async () => {
    // data: null with no error must not crash the check.
    from.mockImplementation(() => queryStub({ data: null, error: null }));

    const err = await errorFromAsync(() => findVenuesForEvent({ ...REQUIRED, layout: 'theatre' }));

    expect(err.details).toEqual([{ field: 'layout', message: 'unknown code "theatre"' }]);
  });

  it('SCRUM20_AC1_a_lookup_database_error_is_translated', async () => {
    givenEventSearch({
      errors: { accessibility_features: { code: 'XX000', message: 'lookup failed' } },
    });

    const err = await errorFromAsync(() => findVenuesForEvent({ ...BASE }));

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err.message).toBe('lookup failed');
    expect(tablesRead()).not.toContain('venues');
    expect(tablesRead()).not.toContain('facilities');
  });

  it('SCRUM20_AC1_a_lookup_not_found_error_is_translated_to_a_typed_error', async () => {
    givenEventSearch({
      errors: { room_layouts: { code: 'P0002', message: 'relation not found' } },
    });

    const err = await errorFromAsync(() => findVenuesForEvent({ ...REQUIRED, layout: 'theatre' }));

    expect(err).toBeInstanceOf(NotFoundError);
  });

  // --- AC3/AC4: every supplied criterion -----------------------------------

  it('SCRUM20_AC3_search_reads_active_venues_in_name_order', async () => {
    // Retired venues never come back: the query itself excludes them.
    const stubs = givenEventSearch({ rows: [] });

    await findVenuesForEvent({ ...BASE });

    expect(stubs.venues.args('is')).toEqual(['retired_at', null]);
    expect(stubs.venues.args('order')).toEqual(['name']);
  });

  it('SCRUM20_AC3_search_selects_the_same_columns_as_getVenueById', async () => {
    const stubs = givenEventSearch({ rows: [] });
    await findVenuesForEvent({ ...REQUIRED });
    const searchSelect = stubs.venues.args('select')[0];

    vi.resetAllMocks();
    const read = queryStub({ data: harbourRow(), error: null });
    from.mockReturnValue(read);
    await getVenueById(HARBOUR_ID);

    expect(searchSelect).toBe(read.args('select')[0]);
    for (const column of ['max_capacity', 'setup_minutes', 'turnaround_minutes', 'venue_operating_hours']) {
      expect(searchSelect).toContain(column);
    }
  });

  it('SCRUM20_AC3_venue_meeting_every_criterion_is_returned', async () => {
    // B-AC3-19
    givenEventSearch({ rows: [harbourRow()] });

    const result = await findVenuesForEvent({ ...BASE });

    expect(result.map((v) => v.id)).toEqual([HARBOUR_ID]);
  });

  it('SCRUM20_AC3_utc_timestamp_is_read_as_singapore_time', async () => {
    // B-AC3-08 through the service.
    givenEventSearch({ rows: [harbourRow()] });

    const result = await findVenuesForEvent({
      ...BASE,
      startsAt: '2026-11-11T02:00:00Z',
      endsAt: '2026-11-11T04:00:00Z',
    });

    expect(result).toHaveLength(1);
  });

  it('SCRUM20_AC3_filtering_keeps_only_full_matches_in_name_order', async () => {
    // The database returns rows already ordered by name; the service keeps
    // that order and drops each venue failing any one criterion.
    givenEventSearch({
      rows: [
        harbourRow({ id: 'a', name: 'Atrium' }),
        harbourRow({ id: 'b', name: 'Boardroom', max_capacity: 79 }),
        harbourRow({ id: 'c', name: 'Cove', venue_facilities: [{ facility_code: 'projector' }] }),
        harbourRow({ id: 'd', name: 'Dockside' }),
        harbourRow({
          id: 'e',
          name: 'Esplanade',
          venue_operating_hours: [{ day_of_week: 3, opens_at: '11:00:00', closes_at: '18:00:00' }],
        }),
        harbourRow({ id: 'f', name: 'Foyer' }),
      ],
    });

    const result = await findVenuesForEvent({ ...BASE });

    expect(result.map((v) => v.name)).toEqual(['Atrium', 'Dockside', 'Foyer']);
  });

  it.each([
    ['SCRUM20_AC4_venue_failing_only_capacity_is_excluded', { max_capacity: 79 }],
    [
      'SCRUM20_AC4_venue_failing_only_operating_hours_is_excluded',
      { venue_operating_hours: [{ day_of_week: 3, opens_at: '11:00:00', closes_at: '18:00:00' }] },
    ],
    ['SCRUM20_AC4_venue_failing_only_layout_is_excluded', { venue_room_layouts: [{ room_layout_code: 'classroom' }] }],
    [
      'SCRUM20_AC4_venue_failing_only_accessibility_is_excluded',
      { venue_accessibility_features: [{ accessibility_feature_code: 'lift_access' }] },
    ],
    [
      'SCRUM20_AC4_venue_failing_only_facilities_is_excluded',
      { venue_facilities: [{ facility_code: 'projector' }, { facility_code: 'pa_system' }] },
    ],
  ])('%s (service)', async (_name, change) => {
    // Control meets the base request; Candidate differs by exactly one thing.
    givenEventSearch({
      rows: [
        harbourRow({ id: 'candidate', name: 'Candidate', ...change }),
        harbourRow({ id: 'control', name: 'Control' }),
      ],
    });

    const result = await findVenuesForEvent({ ...BASE });

    expect(result.map((v) => v.name)).toEqual(['Control']);
  });

  it('SCRUM20_AC8_no_match_returns_an_empty_list', async () => {
    givenEventSearch({ rows: [harbourRow({ max_capacity: 10 })] });

    await expect(findVenuesForEvent({ ...BASE })).resolves.toEqual([]);
  });

  it('SCRUM20_AC8_no_venues_at_all_returns_an_empty_list', async () => {
    givenEventSearch({ rows: null });

    await expect(findVenuesForEvent({ ...REQUIRED })).resolves.toEqual([]);
  });

  it('SCRUM20_AC3_a_venues_database_error_is_translated', async () => {
    givenEventSearch({ errors: { venues: { code: 'XX000', message: 'venues read failed' } } });

    const err = await errorFromAsync(() => findVenuesForEvent({ ...BASE }));

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err.message).toBe('venues read failed');
  });

  it('SCRUM20_AC3_a_venues_check_violation_is_translated_to_a_validation_error', async () => {
    givenEventSearch({ errors: { venues: { code: '23514', message: 'check "x"' } } });

    const err = await errorFromAsync(() => findVenuesForEvent({ ...REQUIRED }));

    expect(err).toBeInstanceOf(ValidationError);
  });

  // --- AC7: result shape ---------------------------------------------------

  it('SCRUM20_AC7_each_result_has_the_six_display_fields', async () => {
    // B-AC7-01. Plus the id to book by; codes come back sorted.
    givenEventSearch({ rows: [harbourRow()] });

    const [venue] = await findVenuesForEvent({ ...BASE });

    expect(venue).toMatchObject({
      id: HARBOUR_ID,
      name: 'Harbour Room',
      location: 'Level 1, Harbour Wing',
      maxCapacity: 100,
      layouts: ['classroom', 'theatre'],
      accessibility: ['lift_access', 'step_free_entrance'],
      facilities: ['pa_system', 'projector', 'wifi'],
    });
  });

  it('SCRUM20_AC7_result_keys_are_exactly_the_projected_set', async () => {
    // Pins the projection so audit columns (retiredAt, createdAt, updatedAt,
    // lastModifiedBy) cannot leak into search results by accident.
    givenEventSearch({ rows: [harbourRow({ setup_minutes: 30, turnaround_minutes: 45 })] });

    const [venue] = await findVenuesForEvent({ ...BASE });

    expect(Object.keys(venue).sort()).toEqual([
      'accessibility',
      'facilities',
      'hours',
      'id',
      'layouts',
      'location',
      'maxCapacity',
      'name',
      'setupMinutes',
      'turnaroundMinutes',
    ]);
    expect(venue.hours).toEqual([{ day_of_week: 3, opens_at: '09:00:00', closes_at: '18:00:00' }]);
    expect(venue.setupMinutes).toBe(30);
    expect(venue.turnaroundMinutes).toBe(45);
  });

  it('SCRUM20_AC7_empty_attribute_set_is_an_empty_array', async () => {
    // B-AC7-02
    givenEventSearch({
      rows: [harbourRow({ venue_facilities: [], venue_room_layouts: [], venue_accessibility_features: [] })],
    });

    const [venue] = await findVenuesForEvent({ ...REQUIRED });

    expect(venue.facilities).toEqual([]);
    expect(venue.layouts).toEqual([]);
    expect(venue.accessibility).toEqual([]);
  });

  // --- SCRUM-139 AC5/AC6: bookings and blocks ------------------------------
  // The overlap rule itself is unit-tested in tests/domain/venueOccupancy.test.js
  // and the read in tests/services/venueOccupancyService.test.js; these prove
  // findVenuesForEvent wires them together. Stub rows are returned as given:
  // the stub records the filters, it does not apply them.

  const RIVERSIDE_ID = '6c1a2d3e-0000-4000-8000-000000000002';
  /** Harbour Room and Riverside Hall, both meeting the base request. */
  const twoMatchingRows = () => [
    harbourRow(),
    harbourRow({ id: RIVERSIDE_ID, name: 'Riverside Hall' }),
  ];
  const occupancy = (venueId, from, to, extra = {}) => ({
    venue_id: venueId,
    starts_at: `2026-11-11T${from}:00+08:00`,
    ends_at: `2026-11-11T${to}:00+08:00`,
    ...extra,
  });

  it('SCRUM20_AC6_overlapping_approved_booking_excludes_the_venue', async () => {
    // B-AC6-01
    givenEventSearch({
      rows: twoMatchingRows(),
      bookings: [occupancy(HARBOUR_ID, '10:30', '11:30', { status: 'approved' })],
    });

    const result = await findVenuesForEvent({ ...BASE });

    expect(result.map((v) => v.name)).toEqual(['Riverside Hall']);
  });

  it('SCRUM20_AC6_booking_at_another_venue_does_not_exclude', async () => {
    // B-AC6-08
    givenEventSearch({
      rows: twoMatchingRows(),
      bookings: [occupancy(RIVERSIDE_ID, '10:30', '11:30', { status: 'approved' })],
    });

    const result = await findVenuesForEvent({ ...BASE });

    expect(result.map((v) => v.name)).toEqual(['Harbour Room']);
  });

  it('SCRUM20_AC6_flagged_booking_without_block_still_excludes_the_venue', async () => {
    // B-AC6-03, inverted by decision: a flagged_for_review booking still holds
    // its venue even when no block covers it any more.
    const stubs = givenEventSearch({
      rows: [harbourRow()],
      bookings: [occupancy(HARBOUR_ID, '10:30', '11:30', { status: 'flagged_for_review' })],
      blocks: [],
    });

    const result = await findVenuesForEvent({ ...BASE });

    expect(result).toEqual([]);
    expect(stubs.bookings.calls).toContainEqual(['in', 'status', ['approved', 'flagged_for_review']]);
  });

  it('SCRUM20_AC6_flagged_bookings_block_still_excludes_the_venue', async () => {
    // B-AC6-04: flagged booking under its active block.
    givenEventSearch({
      rows: [harbourRow()],
      bookings: [occupancy(HARBOUR_ID, '10:30', '11:30', { status: 'flagged_for_review' })],
      blocks: [occupancy(HARBOUR_ID, '10:00', '12:00')],
    });

    await expect(findVenuesForEvent({ ...BASE })).resolves.toEqual([]);
  });

  it('SCRUM20_AC6_cancelled_booking_does_not_exclude', async () => {
    // B-AC6-02. The status filter keeps a cancelled booking out of the read,
    // so the stub answers nothing for it -- and the filter sent is checked.
    const stubs = givenEventSearch({ rows: [harbourRow()], bookings: [] });

    const result = await findVenuesForEvent({ ...BASE });

    expect(result.map((v) => v.id)).toEqual([HARBOUR_ID]);
    const statusFilter = stubs.bookings.calls.find(([m, col]) => m === 'in' && col === 'status');
    expect(statusFilter).toEqual(['in', 'status', ['approved', 'flagged_for_review']]);
    expect(statusFilter[2]).not.toContain('cancelled');
  });

  it('SCRUM20_AC6_overlapping_active_block_excludes_the_venue', async () => {
    // B-AC6-05
    givenEventSearch({ rows: twoMatchingRows(), blocks: [occupancy(HARBOUR_ID, '10:00', '12:00')] });

    const result = await findVenuesForEvent({ ...BASE });

    expect(result.map((v) => v.name)).toEqual(['Riverside Hall']);
  });

  it('SCRUM20_AC6_removed_block_does_not_exclude', async () => {
    // B-AC6-06. .is('removed_at', null) keeps a removed block out of the read.
    const stubs = givenEventSearch({ rows: [harbourRow()], blocks: [] });

    const result = await findVenuesForEvent({ ...BASE });

    expect(result.map((v) => v.id)).toEqual([HARBOUR_ID]);
    expect(stubs.venue_blocks.calls).toContainEqual(['is', 'removed_at', null]);
  });

  it('SCRUM20_AC5_touching_booking_and_block_do_not_exclude (service)', async () => {
    // B-AC5-01/02 and 08/09 through the service, zero buffers.
    givenEventSearch({
      rows: [harbourRow()],
      bookings: [occupancy(HARBOUR_ID, '08:00', '10:00')],
      blocks: [occupancy(HARBOUR_ID, '12:00', '14:00')],
    });

    const result = await findVenuesForEvent({ ...BASE });

    expect(result.map((v) => v.id)).toEqual([HARBOUR_ID]);
  });

  it('SCRUM20_AC5_the_venues_own_setup_and_turnaround_pad_the_check (service)', async () => {
    // Worked example: setup 30, turnaround 45, booking 10:00-12:00. Request
    // 13:15 is kept (edge), 13:14 is excluded.
    const row = harbourRow({ setup_minutes: 30, turnaround_minutes: 45 });
    const bookings = [occupancy(HARBOUR_ID, '10:00', '12:00')];

    givenEventSearch({ rows: [row], bookings });
    const kept = await findVenuesForEvent({
      ...BASE,
      startsAt: '2026-11-11T13:15:00+08:00',
      endsAt: '2026-11-11T14:00:00+08:00',
    });

    givenEventSearch({ rows: [row], bookings });
    const excluded = await findVenuesForEvent({
      ...BASE,
      startsAt: '2026-11-11T13:14:00+08:00',
      endsAt: '2026-11-11T14:00:00+08:00',
    });

    expect(kept.map((v) => v.id)).toEqual([HARBOUR_ID]);
    expect(excluded).toEqual([]);
  });

  it('SCRUM20_AC5_operating_hours_ignore_setup_and_turnaround', async () => {
    // B-AC5-26: hours 09:00-18:00, setup 30, turnaround 45, no bookings.
    // Request 09:00-18:00 (padded 08:30-18:45) is still returned.
    givenEventSearch({ rows: [harbourRow({ setup_minutes: 30, turnaround_minutes: 45 })] });

    const result = await findVenuesForEvent({
      ...BASE,
      startsAt: '2026-11-11T09:00:00+08:00',
      endsAt: '2026-11-11T18:00:00+08:00',
    });

    expect(result.map((v) => v.id)).toEqual([HARBOUR_ID]);
  });

  it('SCRUM20_AC5_occupancy_reads_are_widened_by_240_minutes', async () => {
    const stubs = givenEventSearch({ rows: [harbourRow()] });

    await findVenuesForEvent({ ...BASE });

    for (const table of ['bookings', 'venue_blocks']) {
      expect(stubs[table].calls).toContainEqual(['lt', 'starts_at', '2026-11-11T08:00:00.000Z']);
      expect(stubs[table].calls).toContainEqual(['gt', 'ends_at', '2026-11-10T22:00:00.000Z']);
    }
  });

  it('SCRUM20_AC6_no_candidates_reads_no_bookings_or_blocks', async () => {
    // No venues at all, and venues failing the attributes: neither reads.
    givenEventSearch({ rows: [] });
    await findVenuesForEvent({ ...BASE });
    expect(occupancyTablesRead()).toEqual([]);

    vi.resetAllMocks();
    givenEventSearch({ rows: [harbourRow({ max_capacity: 10 })] });
    await expect(findVenuesForEvent({ ...BASE })).resolves.toEqual([]);
    expect(occupancyTablesRead()).toEqual([]);
  });

  it('SCRUM20_AC6_occupancy_is_read_only_for_attribute_matching_venues', async () => {
    const stubs = givenEventSearch({
      rows: [
        harbourRow({ id: 'a', name: 'Atrium' }),
        harbourRow({ id: 'b', name: 'Boardroom', max_capacity: 79 }),
        harbourRow({ id: 'c', name: 'Cove' }),
      ],
    });

    await findVenuesForEvent({ ...BASE });

    expect(occupancyTablesRead().sort()).toEqual(['bookings', 'venue_blocks']);
    expect(stubs.bookings.calls).toContainEqual(['in', 'venue_id', ['a', 'c']]);
    expect(stubs.venue_blocks.calls).toContainEqual(['in', 'venue_id', ['a', 'c']]);
  });

  it.each([
    ['bookings', 'bookings read failed'],
    ['venue_blocks', 'blocks read failed'],
  ])('SCRUM20_AC6_a_%s_read_error_propagates', async (table, message) => {
    givenEventSearch({ rows: [harbourRow()], errors: { [table]: { code: 'XX000', message } } });

    const err = await errorFromAsync(() => findVenuesForEvent({ ...BASE }));

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err.message).toBe(message);
  });

  it('SCRUM20_AC6_an_occupancy_22P02_propagates_as_a_validation_error', async () => {
    givenEventSearch({ rows: [harbourRow()], errors: { bookings: { code: '22P02', message: 'bad uuid' } } });

    const err = await errorFromAsync(() => findVenuesForEvent({ ...BASE }));

    expect(err).toBeInstanceOf(ValidationError);
  });

  it('SCRUM20_AC6_exclusion_keeps_name_order_and_the_projection', async () => {
    givenEventSearch({
      rows: [
        harbourRow({ id: 'a', name: 'Atrium' }),
        harbourRow({ id: 'b', name: 'Boardroom' }),
        harbourRow({ id: 'c', name: 'Cove' }),
        harbourRow({ id: 'd', name: 'Dockside' }),
      ],
      bookings: [occupancy('b', '11:00', '13:00')],
      blocks: [occupancy('d', '09:00', '10:01')],
    });

    const result = await findVenuesForEvent({ ...BASE });

    expect(result.map((v) => v.name)).toEqual(['Atrium', 'Cove']);
    for (const venue of result) {
      expect(Object.keys(venue).sort()).toEqual([
        'accessibility',
        'facilities',
        'hours',
        'id',
        'layouts',
        'location',
        'maxCapacity',
        'name',
        'setupMinutes',
        'turnaroundMinutes',
      ]);
    }
  });
});


// ---------------------------------------------------------------------------
// SCRUM-138 lifted getVenueById's row mapping into toVenueWithAttributes.
// No existing test pinned the WHOLE object (they use toMatchObject or single
// fields), so this does, with the exact keys the pre-refactor code returned.
// ---------------------------------------------------------------------------
describe('SCRUM20 SCRUM138 getVenueById is unchanged by the refactor', () => {
  it('SCRUM20_SCRUM138_getVenueById_returns_exactly_the_pre_refactor_shape', async () => {
    from.mockReturnValue(queryStub({
      data: populatedVenueRow({ setup_minutes: 15 }),
      error: null,
    }));

    const venue = await getVenueById(VENUE_ID);

    expect(venue).toStrictEqual({
      id: VENUE_ID,
      name: 'Seminar Room 2-1',
      location: 'Level 2, SCIS',
      maxCapacity: 40,
      turnaroundMinutes: 45,
      setupMinutes: 15,
      retiredAt: null,
      createdAt: '2026-09-12T09:00:00+00:00',
      updatedAt: RETIRED_AT,
      lastModifiedBy: STAFF_ID,
      layouts: ['classroom', 'theatre'],
      accessibility: ['hearing_loop', 'lift_access'],
      facilities: ['projector', 'wifi'],
      hours: [
        { day_of_week: 1, opens_at: '08:00:00', closes_at: '17:00:00' },
        { day_of_week: 3, opens_at: '09:00:00', closes_at: '18:00:00' },
      ],
    });
    // Same key order as before, too.
    expect(Object.keys(venue)).toEqual([
      'id', 'name', 'location', 'maxCapacity', 'turnaroundMinutes', 'setupMinutes',
      'retiredAt', 'createdAt', 'updatedAt', 'lastModifiedBy',
      'layouts', 'accessibility', 'facilities', 'hours',
    ]);
  });

  it('SCRUM20_SCRUM138_getVenueById_still_selects_every_attribute_join', async () => {
    const read = queryStub({ data: populatedVenueRow(), error: null });
    from.mockReturnValue(read);

    await getVenueById(VENUE_ID);

    const select = read.args('select')[0].replace(/\s+/g, ' ').trim();
    expect(select).toBe(
      'id, name, location, max_capacity, turnaround_minutes, setup_minutes, ' +
      'retired_at, created_at, updated_at, last_modified_by, ' +
      'venue_room_layouts ( room_layout_code ), ' +
      'venue_accessibility_features ( accessibility_feature_code ), ' +
      'venue_facilities ( facility_code ), ' +
      'venue_operating_hours ( day_of_week, opens_at, closes_at )',
    );
  });
});
