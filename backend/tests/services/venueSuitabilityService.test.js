/**
 * Unit tests for the venue suitability check.
 *
 * SCRUM-190, a subtask of SCRUM-188 (Check Venue Suitability for an Event).
 * Named SCRUM188_ACn_<what> for the story's criteria, and SCRUM188_WK7_<what>
 * for the Week 7 rules on setup, turnaround and holds:
 *
 *   AC1  the check runs for one event and one active venue, as the event's
 *        assigned coordinator
 *   AC2  each criterion is reported met or not, with the values compared
 *   WK7  availability is judged on the occupied period and says which part is
 *        setup and which turnaround; another event's hold makes the venue
 *        unavailable; the event's own holds and bookings do not count
 *   AC6  (SCRUM-192) the event's requested and booked venues are rechecked
 *        against its current period and attendance, and failures named
 *
 * The client is a fake answering by table and function, so nothing here needs
 * credentials. What venue_occupancy_conflicts() returns is proved against a
 * real Postgres in tests/db; here its rows are given, and what is proved is
 * what the check makes of them.
 */

import { describe, it, expect, vi } from 'vitest';

// The check loads venueService.js, which imports the Supabase client
// statically and throws without a .env. Every query here goes to the injected
// fake, so the real client is never used; this only lets the module load.
vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: {}, supabaseAdmin: {}, default: {} }));

const {
  checkVenueSuitability,
  checkEventVenues,
  LIVE_BOOKING_STATUSES,
  describeAvailability,
  toOccupancyConflict,
  SUITABILITY_CHECK_CRITERIA,
  AVAILABILITY_CRITERION,
} = await import('../../src/services/venueSuitabilityService.js');
const { SUITABILITY_CRITERIA } = await import('../../src/domain/venueMatching.js');
const { ValidationError, NotFoundError, ForbiddenError, ConflictError } = await import(
  '../../src/errors.js'
);

const COORDINATOR = '55555555-5555-4555-8555-555555555555';
const SOMEONE_ELSE = '66666666-6666-4666-8666-666666666666';
const EVENT = '22222222-2222-4222-8222-222222222222';
const OTHER_EVENT = '77777777-7777-4777-8777-777777777777';
const VENUE = '33333333-3333-4333-8333-333333333333';
const BOOKING = '44444444-4444-4444-8444-444444444444';
const HOLD = '88888888-8888-4888-8888-888888888888';
const BLOCK = '99999999-9999-4999-8999-999999999999';

// Wednesday 11 November 2026, 10:00-12:00 in Singapore.
const START = '2026-11-11T10:00:00+08:00';
const END = '2026-11-11T12:00:00+08:00';

/** The event as getEventRequestById selects it. */
function eventRow(overrides = {}) {
  return {
    id: EVENT,
    organiser_id: '11111111-1111-4111-8111-111111111111',
    event_name: 'Orientation',
    proposed_start: START,
    proposed_end: END,
    expected_attendance: 120,
    venue_requirements: 'Theatre seating',
    accessibility_requirements: 'Step-free',
    status: 'approved',
    assigned_coordinator_id: COORDINATOR,
    ...overrides,
  };
}

/** The venue as getVenueById selects it: open 08:00-22:00 daily, 30/45 padding. */
function venueRow(overrides = {}) {
  return {
    id: VENUE,
    name: 'Hall A',
    location: 'Level 1',
    max_capacity: 150,
    setup_minutes: 30,
    turnaround_minutes: 45,
    emergency_access: null,
    known_restrictions: null,
    retired_at: null,
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: '2026-01-01T00:00:00+00:00',
    last_modified_by: null,
    venue_room_layouts: [{ room_layout_code: 'theatre' }, { room_layout_code: 'banquet' }],
    venue_accessibility_features: [{ accessibility_feature_code: 'wheelchair_access' }],
    venue_facilities: [{ facility_code: 'projector' }, { facility_code: 'wifi' }],
    venue_operating_hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
      day_of_week: day,
      opens_at: '08:00:00',
      closes_at: '22:00:00',
    })),
    ...overrides,
  };
}

const KNOWN_CODES = {
  room_layouts: ['theatre', 'banquet', 'u_shape'],
  accessibility_features: ['wheelchair_access', 'hearing_loop'],
  facilities: ['projector', 'wifi', 'stage'],
};

/**
 * A client answering by table (the event, the venue, the code lookups) and by
 * function (the occupancy rows), recording every call.
 *
 * SCRUM-192: also the event's bookings (select -> eq -> in -> order), and,
 * when venuesById is given, a venue per id, so each booking can be judged
 * against its own venue.
 */
function fakeClient({
  event = eventRow(),
  venue = venueRow(),
  occupancy = [],
  rpcError = null,
  bookings = [],
  bookingsError = null,
  venuesById = null,
} = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, filters: [] };
      calls.push(call);
      const chain = {
        select: (columns) => {
          call.columns = columns;
          return chain;
        },
        eq: (column, value) => {
          call.filters.push([column, value]);
          return chain;
        },
        in: (column, values) => {
          call.filters.push([column, values]);
          if (table === 'bookings') return chain;
          const known = KNOWN_CODES[table] ?? [];
          return Promise.resolve({
            data: values.filter((code) => known.includes(code)).map((code) => ({ code })),
            error: null,
          });
        },
        order: (column) => {
          call.order = column;
          return Promise.resolve(
            bookingsError ? { data: null, error: bookingsError } : { data: bookings, error: null },
          );
        },
        maybeSingle: () => {
          if (table === 'event_requests') return Promise.resolve({ data: event, error: null });
          if (venuesById) {
            const id = call.filters.find(([column]) => column === 'id')?.[1];
            return Promise.resolve({ data: venuesById[id] ?? null, error: null });
          }
          return Promise.resolve({ data: venue, error: null });
        },
      };
      return chain;
    },
    rpc(fn, args) {
      calls.push({ fn, args });
      return Promise.resolve(rpcError ? { data: null, error: rpcError } : { data: occupancy, error: null });
    },
  };
}

const check = (client, input = {}) =>
  checkVenueSuitability({ eventRequestId: EVENT, venueId: VENUE, userId: COORDINATOR, client, ...input });

const availabilityOf = (result) => result.criteria.find((c) => c.criterion === 'Availability');

/** A row of venue_occupancy_conflicts() for a booking of another event. */
const bookingRow = (overrides = {}) => ({
  kind: 'booking',
  id: BOOKING,
  status: 'approved',
  event_request_id: OTHER_EVENT,
  event_name: 'Gala Night',
  reason: null,
  starts_at: '2026-11-11T10:00:00+08:00',
  ends_at: '2026-11-11T12:00:00+08:00',
  occupied_starts_at: '2026-11-11T09:30:00+08:00',
  occupied_ends_at: '2026-11-11T12:45:00+08:00',
  setup_minutes: 30,
  turnaround_minutes: 45,
  ...overrides,
});

const holdRow = (overrides = {}) =>
  bookingRow({ kind: 'hold', id: HOLD, status: null, ...overrides });

/** A block: unpadded, so its occupied period is its own; 040 still gives the venue's minutes. */
const blockRow = (overrides = {}) => ({
  kind: 'block',
  id: BLOCK,
  status: null,
  event_request_id: null,
  event_name: null,
  reason: 'maintenance',
  starts_at: '2026-11-11T10:00:00+08:00',
  ends_at: '2026-11-11T14:00:00+08:00',
  occupied_starts_at: '2026-11-11T10:00:00+08:00',
  occupied_ends_at: '2026-11-11T14:00:00+08:00',
  setup_minutes: 30,
  turnaround_minutes: 45,
  ...overrides,
});


describe('SCRUM188_AC2 every criterion is reported, in order', () => {
  it('SCRUM188_AC2_returns_all_six_criteria_in_order', async () => {
    const result = await check(fakeClient());
    expect(result.criteria.map((c) => c.criterion)).toEqual([
      'Capacity',
      'Operating hours',
      'Layout',
      'Accessibility',
      'Facilities',
      'Availability',
    ]);
    expect(result.criteria.map((c) => c.criterion)).toEqual([...SUITABILITY_CHECK_CRITERIA]);
  });

  it('SCRUM188_AC2_availability_is_added_without_touching_the_five_shared_labels', () => {
    expect(SUITABILITY_CRITERIA).toHaveLength(5);
    expect(Object.isFrozen(SUITABILITY_CRITERIA)).toBe(true);
    expect(Object.isFrozen(SUITABILITY_CHECK_CRITERIA)).toBe(true);
    expect(SUITABILITY_CHECK_CRITERIA.at(-1)).toBe(AVAILABILITY_CRITERION);
  });

  it('SCRUM188_AC2_every_criterion_carries_met_and_the_values_compared', async () => {
    const result = await check(fakeClient(), {
      roomLayoutCode: 'theatre',
      accessibility: ['wheelchair_access'],
      facilities: ['projector'],
    });
    expect(result.criteria.slice(0, 5)).toEqual([
      { criterion: 'Capacity', met: true, detail: 'Capacity 150 ≥ expected attendance 120' },
      {
        criterion: 'Operating hours',
        met: true,
        detail: 'Event runs 10:00–12:00 on Wednesday; venue open 08:00–22:00',
      },
      {
        criterion: 'Layout',
        met: true,
        detail: 'Layout theatre offered',
        layout: 'theatre',
        offers: ['banquet', 'theatre'],
      },
      {
        criterion: 'Accessibility',
        met: true,
        detail: 'All 1 requested provided',
        missing: [],
        requested: ['wheelchair_access'],
      },
      {
        criterion: 'Facilities',
        met: true,
        detail: 'All 1 requested provided',
        missing: [],
        requested: ['projector'],
      },
    ]);
  });
});


describe('SCRUM188_AC2 suitable only when every criterion is met', () => {
  it('SCRUM188_AC2_suitable_when_all_six_are_met', async () => {
    const result = await check(fakeClient());
    expect(result.criteria.every((c) => c.met)).toBe(true);
    expect(result.suitable).toBe(true);
  });

  it('SCRUM188_AC2_one_attribute_not_met_makes_it_not_suitable', async () => {
    const result = await check(fakeClient({ event: eventRow({ expected_attendance: 151 }) }));
    expect(result.criteria[0]).toEqual({
      criterion: 'Capacity',
      met: false,
      detail: 'Capacity 150 < expected attendance 151',
    });
    expect(availabilityOf(result).met).toBe(true);
    expect(result.suitable).toBe(false);
  });

  it('SCRUM188_AC2_a_missing_facility_makes_it_not_suitable', async () => {
    const result = await check(fakeClient(), { facilities: ['stage', 'projector'] });
    expect(result.criteria[4]).toEqual({
      criterion: 'Facilities',
      met: false,
      detail: 'Missing: stage',
      missing: ['stage'],
      requested: ['stage', 'projector'],
    });
    expect(result.suitable).toBe(false);
  });

  it('SCRUM188_AC2_availability_alone_not_met_makes_it_not_suitable', async () => {
    const result = await check(fakeClient({ occupancy: [bookingRow()] }));
    expect(result.criteria.slice(0, 5).every((c) => c.met)).toBe(true);
    expect(availabilityOf(result).met).toBe(false);
    expect(result.suitable).toBe(false);
  });
});


describe('SCRUM188_WK7 availability on the occupied period', () => {
  it('SCRUM188_WK7_asks_the_shared_function_with_padding_and_the_events_own_holds_excluded', async () => {
    const client = fakeClient();
    await check(client);
    const rpcCalls = client.calls.filter((c) => c.fn);
    expect(rpcCalls).toEqual([
      {
        fn: 'venue_occupancy_conflicts',
        args: {
          p_venue_id: VENUE,
          p_starts_at: START,
          p_ends_at: END,
          p_pad_requested: true,
          p_exclude_hold_event_id: EVENT,
        },
      },
    ]);
  });

  it('SCRUM188_WK7_free_names_the_occupied_period_and_the_setup_and_turnaround_in_it', async () => {
    const availability = availabilityOf(await check(fakeClient()));
    expect(availability).toEqual({
      criterion: 'Availability',
      met: true,
      detail: 'Free 09:30–12:45 on Wed 11 Nov (incl. 30 min setup, 45 min turnaround)',
      conflicts: [],
    });
  });

  it('SCRUM188_WK7_free_with_no_setup_or_turnaround_is_just_the_event', async () => {
    const venue = venueRow({ setup_minutes: 0, turnaround_minutes: 0 });
    expect(availabilityOf(await check(fakeClient({ venue }))).detail).toBe('Free 10:00–12:00 on Wed 11 Nov');
  });

  it('SCRUM188_WK7_a_booking_names_its_event_and_which_part_is_setup_and_turnaround', async () => {
    const availability = availabilityOf(await check(fakeClient({ occupancy: [bookingRow()] })));
    expect(availability.met).toBe(false);
    expect(availability.detail).toBe(
      'Needs 09:30–12:45 on Wed 11 Nov (setup 09:30–10:00, turnaround 12:00–12:45). ' +
        'Booked for Gala Night 09:30–12:45 on Wed 11 Nov (setup 09:30–10:00, turnaround 12:00–12:45)',
    );
    expect(availability.conflicts).toEqual([
      {
        kind: 'booking',
        id: BOOKING,
        eventName: 'Gala Night',
        reason: null,
        startsAt: '2026-11-11T10:00:00+08:00',
        endsAt: '2026-11-11T12:00:00+08:00',
        occupiedStartsAt: '2026-11-11T09:30:00+08:00',
        occupiedEndsAt: '2026-11-11T12:45:00+08:00',
        setupMinutes: 30,
        turnaroundMinutes: 45,
      },
    ]);
  });

  it('SCRUM188_WK7_another_events_hold_makes_it_unavailable_with_the_held_period', async () => {
    const availability = availabilityOf(await check(fakeClient({ occupancy: [holdRow()] })));
    expect(availability.met).toBe(false);
    expect(availability.detail).toBe(
      'Needs 09:30–12:45 on Wed 11 Nov (setup 09:30–10:00, turnaround 12:00–12:45). ' +
        'Held for Gala Night 09:30–12:45 on Wed 11 Nov (setup 09:30–10:00, turnaround 12:00–12:45)',
    );
    expect(availability.conflicts[0]).toMatchObject({ kind: 'hold', id: HOLD, eventName: 'Gala Night' });
  });

  it('SCRUM188_WK7_a_block_is_described_by_its_own_unpadded_period', async () => {
    const availability = availabilityOf(await check(fakeClient({ occupancy: [blockRow()] })));
    expect(availability.met).toBe(false);
    expect(availability.detail).toBe(
      'Needs 09:30–12:45 on Wed 11 Nov (setup 09:30–10:00, turnaround 12:00–12:45). ' +
        'Blocked (maintenance) 10:00–14:00 on Wed 11 Nov',
    );
    expect(availability.conflicts[0]).toMatchObject({
      kind: 'block',
      id: BLOCK,
      eventName: null,
      reason: 'maintenance',
      occupiedStartsAt: '2026-11-11T10:00:00+08:00',
      occupiedEndsAt: '2026-11-11T14:00:00+08:00',
    });
  });

  it('SCRUM188_WK7_several_conflicts_are_joined_in_the_order_given', async () => {
    const availability = availabilityOf(
      await check(fakeClient({ occupancy: [bookingRow(), blockRow({ reason: 'internal_activity' })] })),
    );
    expect(availability.detail).toBe(
      'Needs 09:30–12:45 on Wed 11 Nov (setup 09:30–10:00, turnaround 12:00–12:45). ' +
        'Booked for Gala Night 09:30–12:45 on Wed 11 Nov (setup 09:30–10:00, turnaround 12:00–12:45); ' +
        'Blocked (internal activity) 10:00–14:00 on Wed 11 Nov',
    );
    expect(availability.conflicts.map((c) => c.kind)).toEqual(['booking', 'block']);
  });

  it('SCRUM188_WK7_the_events_own_booking_does_not_count_against_it', async () => {
    const own = bookingRow({ event_request_id: EVENT, event_name: 'Orientation' });
    const availability = availabilityOf(await check(fakeClient({ occupancy: [own] })));
    expect(availability.met).toBe(true);
    expect(availability.conflicts).toEqual([]);
    expect(availability.detail).toMatch(/^Free /);
  });

  it('SCRUM188_WK7_only_its_own_booking_is_dropped_not_another_events', async () => {
    const own = bookingRow({ event_request_id: EVENT });
    const other = bookingRow({ id: OTHER_EVENT });
    const availability = availabilityOf(await check(fakeClient({ occupancy: [own, other] })));
    expect(availability.met).toBe(false);
    expect(availability.conflicts.map((c) => c.id)).toEqual([OTHER_EVENT]);
  });

  it('SCRUM188_WK7_a_failed_availability_read_is_an_untyped_error', async () => {
    const err = await check(fakeClient({ rpcError: { code: 'XX000', message: 'boom' } })).catch((e) => e);
    expect(err.constructor).toBe(Error);
    expect(err.message).toBe('boom');
  });
});


describe('SCRUM188_WK7 describeAvailability', () => {
  const event = { proposedStart: START, proposedEnd: END };

  it('SCRUM188_WK7_leaves_out_a_zero_part_of_the_padding', () => {
    expect(describeAvailability([], event, { setupMinutes: 0, turnaroundMinutes: 15 })).toBe(
      'Free 10:00–12:15 on Wed 11 Nov (incl. 15 min turnaround)',
    );
    const conflict = toOccupancyConflict(
      bookingRow({ occupied_starts_at: '2026-11-11T10:00:00+08:00', setup_minutes: 0 }),
    );
    expect(describeAvailability([conflict], event, {})).toBe(
      'Needs 10:00–12:00 on Wed 11 Nov. Booked for Gala Night 10:00–12:45 on Wed 11 Nov (turnaround 12:00–12:45)',
    );
    // SCRUM-193/194 (B4): the event's own zero part is left out too.
    expect(describeAvailability([conflict], event, { setupMinutes: 15, turnaroundMinutes: 0 })).toBe(
      'Needs 09:45–12:00 on Wed 11 Nov (setup 09:45–10:00). ' +
        'Booked for Gala Night 10:00–12:45 on Wed 11 Nov (turnaround 12:00–12:45)',
    );
  });

  it('SCRUM188_WK7_a_period_crossing_midnight_names_both_days', () => {
    const late = { proposedStart: '2026-11-11T22:00:00+08:00', proposedEnd: '2026-11-11T23:30:00+08:00' };
    expect(describeAvailability([], late, { setupMinutes: 30, turnaroundMinutes: 45 })).toBe(
      'Free Wed 11 Nov 21:30 – Thu 12 Nov 00:15 (incl. 30 min setup, 45 min turnaround)',
    );
  });

  it('SCRUM188_WK7_times_are_on_the_singapore_clock_whatever_offset_they_arrive_in', () => {
    const utc = { proposedStart: '2026-11-11T02:00:00Z', proposedEnd: '2026-11-11T04:00:00Z' };
    expect(describeAvailability([], utc, { setupMinutes: 0, turnaroundMinutes: 0 })).toBe(
      'Free 10:00–12:00 on Wed 11 Nov',
    );
  });

  it('SCRUM188_WK7_an_unnamed_event_and_an_unspecified_block_still_read', () => {
    const booking = toOccupancyConflict(bookingRow({ event_name: null, setup_minutes: 0, turnaround_minutes: 0 }));
    const block = toOccupancyConflict(blockRow({ reason: null }));
    expect(describeAvailability([booking, block], event, {})).toBe(
      'Needs 10:00–12:00 on Wed 11 Nov. ' +
        'Booked for another event 09:30–12:45 on Wed 11 Nov; Blocked 10:00–14:00 on Wed 11 Nov',
    );
  });
});


describe('SCRUM188_AC1 who may check, and what', () => {
  it('SCRUM188_AC1_a_coordinator_not_assigned_to_the_event_is_refused_before_the_venue_is_read', async () => {
    const client = fakeClient();
    const err = await check(client, { userId: SOMEONE_ELSE }).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.status).toBe(403);
    expect(client.calls.map((c) => c.table ?? c.fn)).toEqual(['event_requests']);
  });

  it('SCRUM188_AC1_without_a_userId_the_caller_has_already_been_checked', async () => {
    const result = await check(fakeClient({ event: eventRow({ assigned_coordinator_id: SOMEONE_ELSE }) }), {
      userId: undefined,
    });
    expect(result.suitable).toBe(true);
  });

  it('SCRUM188_AC1_an_unknown_event_is_404', async () => {
    const err = await check(fakeClient({ event: null })).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it('SCRUM188_AC1_a_draft_event_is_404_like_an_unknown_one', async () => {
    const err = await check(fakeClient({ event: eventRow({ status: 'draft' }) })).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it('SCRUM188_AC1_an_unknown_venue_is_404', async () => {
    const client = fakeClient({ venue: null });
    const err = await check(client).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(client.calls.some((c) => c.fn)).toBe(false);
  });

  it.each([
    ['start', { proposed_start: null }],
    ['end', { proposed_end: null }],
  ])('SCRUM188_AC1_an_event_with_no_%s_is_409_EVENT_DATES_MISSING', async (_label, overrides) => {
    const client = fakeClient({ event: eventRow(overrides) });
    const err = await check(client).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('EVENT_DATES_MISSING');
    expect(client.calls.map((c) => c.table ?? c.fn)).toEqual(['event_requests']);
  });

  it('SCRUM188_AC1_a_retired_venue_is_409_VENUE_RETIRED', async () => {
    const client = fakeClient({ venue: venueRow({ retired_at: '2026-09-01T00:00:00+00:00' }) });
    const err = await check(client).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('VENUE_RETIRED');
    expect(client.calls.some((c) => c.fn)).toBe(false);
  });

  it('SCRUM188_AC1_unknown_requirement_codes_are_one_400_naming_each', async () => {
    const client = fakeClient();
    const err = await check(client, {
      roomLayoutCode: 'igloo',
      accessibility: ['wheelchair_access', 'ramp'],
      facilities: ['teleporter'],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/^Invalid suitability check -- /);
    expect(err.details).toEqual([
      { field: 'layout', message: 'unknown code "igloo"' },
      { field: 'accessibility', message: 'unknown code "ramp"' },
      { field: 'facilities', message: 'unknown code "teleporter"' },
    ]);
    expect(client.calls.some((c) => c.table === 'venues' || c.fn)).toBe(false);
  });

  it('SCRUM188_AC1_nothing_asked_for_needs_no_code_lookup', async () => {
    const client = fakeClient();
    await check(client);
    expect(client.calls.map((c) => c.table ?? c.fn)).toEqual([
      'event_requests',
      'venues',
      'venue_occupancy_conflicts',
    ]);
  });
});


describe('SCRUM188_AC2 checked echoes what was judged', () => {
  it('SCRUM188_AC2_checked_is_the_stored_period_and_attendance_and_the_codes_asked_for', async () => {
    const result = await check(fakeClient(), {
      roomLayoutCode: 'theatre',
      accessibility: ['wheelchair_access'],
      facilities: ['projector', 'wifi'],
    });
    expect(result.checked).toEqual({
      startsAt: START,
      endsAt: END,
      expectedAttendance: 120,
      layout: 'theatre',
      accessibility: ['wheelchair_access'],
      facilities: ['projector', 'wifi'],
    });
  });

  it('SCRUM188_AC2_a_period_or_attendance_sent_by_the_caller_is_never_used', async () => {
    const client = fakeClient();
    const result = await check(client, {
      startsAt: '2030-01-01T00:00:00Z',
      endsAt: '2030-01-02T00:00:00Z',
      proposedStart: '2030-01-01T00:00:00Z',
      expectedAttendance: 5,
    });
    expect(result.checked).toMatchObject({ startsAt: START, endsAt: END, expectedAttendance: 120 });
    expect(result.criteria[0].detail).toBe('Capacity 150 ≥ expected attendance 120');
    const rpc = client.calls.find((c) => c.fn);
    expect(rpc.args).toMatchObject({ p_starts_at: START, p_ends_at: END });
  });

  it('SCRUM188_AC2_no_codes_are_echoed_as_none', async () => {
    const result = await check(fakeClient(), { roomLayoutCode: null, accessibility: undefined });
    expect(result.checked).toMatchObject({ layout: null, accessibility: [], facilities: [] });
    expect(result.criteria[2]).toEqual({
      criterion: 'Layout',
      met: true,
      detail: 'None requested',
      layout: null,
      offers: ['banquet', 'theatre'],
    });
  });
});


// ---------------------------------------------------------------------------
// SCRUM-192: checkEventVenues, the recheck of the event's live bookings.
// ---------------------------------------------------------------------------

const VENUE_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOOKING_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** A stored request-time verdict: every criterion met, except those named. */
function storedResult({ unmet = [], checked } = {}) {
  const result = {
    suitable: unmet.length === 0,
    criteria: SUITABILITY_CHECK_CRITERIA.map((criterion) => ({
      criterion,
      met: !unmet.includes(criterion),
      detail: 'as stored',
    })),
  };
  if (checked !== undefined) result.checked = checked;
  return result;
}

/** A bookings row as checkEventVenues selects it. */
function eventBookingRow(overrides = {}) {
  return {
    id: BOOKING,
    venue_id: VENUE,
    status: 'approved',
    // The period create_booking_request copied from the event (SCRUM-193/194, B2).
    starts_at: START,
    ends_at: END,
    room_layout_code: 'theatre',
    suitability_result: storedResult({
      checked: {
        startsAt: START,
        endsAt: END,
        expectedAttendance: 120,
        layout: 'theatre',
        accessibility: ['wheelchair_access'],
        facilities: ['projector'],
      },
    }),
    suitability_overridden: false,
    created_at: '2026-10-01T00:00:00+00:00',
    venues: { name: 'Hall A', location: 'Level 1' },
    ...overrides,
  };
}

const recheck = (client, options = {}) => checkEventVenues(EVENT, { userId: COORDINATOR, client, ...options });


describe('SCRUM188_AC6 which bookings are rechecked', () => {
  it('SCRUM192_reads_only_the_events_pending_approved_and_flagged_bookings_oldest_first', async () => {
    const client = fakeClient();
    await recheck(client);
    const read = client.calls.find((c) => c.table === 'bookings');
    expect(read.filters).toEqual([
      ['event_request_id', EVENT],
      ['status', ['pending', 'approved', 'flagged_for_review']],
    ]);
    expect(LIVE_BOOKING_STATUSES).toEqual(['pending', 'approved', 'flagged_for_review']);
    expect(read.order).toBe('created_at');
    expect(read.columns).toMatch(/suitability_result/);
    expect(read.columns).toMatch(/venues\(name, location\)/);
  });

  it('SCRUM192_an_event_with_no_live_bookings_is_an_empty_list_not_an_error', async () => {
    const client = fakeClient({ bookings: [] });
    expect(await recheck(client)).toEqual([]);
    expect(client.calls.some((c) => c.fn)).toBe(false);
  });

  it('SCRUM192_a_failed_bookings_read_is_an_untyped_error', async () => {
    const err = await recheck(fakeClient({ bookingsError: { message: 'boom' } })).catch((e) => e);
    expect(err.constructor).toBe(Error);
    expect(err.message).toBe('boom');
  });

  it('SCRUM192_each_item_names_the_booking_its_venue_and_status', async () => {
    const [item] = await recheck(fakeClient({ bookings: [eventBookingRow({ suitability_overridden: true })] }));
    expect(item).toMatchObject({
      bookingId: BOOKING,
      venueId: VENUE,
      venueName: 'Hall A',
      venueLocation: 'Level 1',
      status: 'approved',
      statusDisplay: { status: 'approved', label: 'Approved', group: 'APPROVED' },
      suitabilityOverridden: true,
      error: null,
    });
    expect(item.current.criteria.map((c) => c.criterion)).toEqual([...SUITABILITY_CHECK_CRITERIA]);
  });

  it('SCRUM192_an_embedded_venue_read_as_an_array_still_names_it', async () => {
    const [item] = await recheck(
      fakeClient({ bookings: [eventBookingRow({ venues: [{ name: 'Hall A', location: 'Level 1' }] })] }),
    );
    expect(item).toMatchObject({ venueName: 'Hall A', venueLocation: 'Level 1' });
  });
});


describe('SCRUM188_AC6 each booking is judged by the same check', () => {
  it('SCRUM192_each_booking_is_rechecked_with_its_own_layout_and_stored_codes', async () => {
    const bookingA = eventBookingRow();
    const bookingB = eventBookingRow({
      id: BOOKING_B,
      venue_id: VENUE_B,
      status: 'pending',
      room_layout_code: 'banquet',
      suitability_result: storedResult({
        checked: { layout: 'banquet', accessibility: [], facilities: ['stage'] },
      }),
      venues: { name: 'Hall B', location: 'Level 2' },
    });
    const client = fakeClient({
      bookings: [bookingA, bookingB],
      venuesById: { [VENUE]: venueRow(), [VENUE_B]: venueRow({ id: VENUE_B, name: 'Hall B' }) },
    });
    const [a, b] = await recheck(client);

    expect(a.current.checked).toMatchObject({
      layout: 'theatre',
      accessibility: ['wheelchair_access'],
      facilities: ['projector'],
    });
    expect(a.current.suitable).toBe(true);
    expect(b.current.checked).toMatchObject({ layout: 'banquet', accessibility: [], facilities: ['stage'] });
    expect(b.current.criteria[4]).toEqual({
      criterion: 'Facilities',
      met: false,
      detail: 'Missing: stage',
      missing: ['stage'],
      requested: ['stage'],
    });

    const rpcVenues = client.calls.filter((c) => c.fn).map((c) => c.args.p_venue_id);
    expect(rpcVenues.sort()).toEqual([VENUE, VENUE_B].sort());
  });

  it.each([
    ['no stored result', { suitability_result: null }],
    ['a stored result without checked', { suitability_result: storedResult() }],
  ])('SCRUM192_%s_falls_back_to_no_codes_asked_for', async (_label, overrides) => {
    const [item] = await recheck(fakeClient({ bookings: [eventBookingRow(overrides)] }));
    expect(item.current.checked).toMatchObject({ layout: 'theatre', accessibility: [], facilities: [] });
    expect(item.current.criteria[3]).toEqual({
      criterion: 'Accessibility',
      met: true,
      detail: 'None requested',
      missing: [],
      requested: [],
    });
  });

  it('SCRUM192_no_layout_on_the_booking_is_none_asked_for', async () => {
    const [item] = await recheck(fakeClient({ bookings: [eventBookingRow({ room_layout_code: null })] }));
    expect(item.current.checked.layout).toBeNull();
    expect(item.current.criteria[2]).toEqual({
      criterion: 'Layout',
      met: true,
      detail: 'None requested',
      layout: null,
      offers: ['banquet', 'theatre'],
    });
  });

  it('SCRUM188_AC6_the_events_current_period_and_attendance_are_judged_not_the_bookings', async () => {
    // Booked for 10:00-12:00 with 120; the event has since moved to Thursday
    // 20:00-23:00 with 200 attending.
    const event = eventRow({
      proposed_start: '2026-11-12T20:00:00+08:00',
      proposed_end: '2026-11-12T23:00:00+08:00',
      expected_attendance: 200,
    });
    const client = fakeClient({ event, bookings: [eventBookingRow()] });
    const [item] = await recheck(client);

    expect(item.current.checked).toMatchObject({
      startsAt: '2026-11-12T20:00:00+08:00',
      endsAt: '2026-11-12T23:00:00+08:00',
      expectedAttendance: 200,
    });
    expect(item.current.criteria[0]).toEqual({
      criterion: 'Capacity',
      met: false,
      detail: 'Capacity 150 < expected attendance 200',
    });
    expect(item.current.criteria[1].met).toBe(false);
    expect(client.calls.find((c) => c.fn).args).toMatchObject({
      p_starts_at: '2026-11-12T20:00:00+08:00',
      p_ends_at: '2026-11-12T23:00:00+08:00',
    });
  });

  it('SCRUM188_WK7_a_venues_new_setup_and_turnaround_are_judged_live', async () => {
    const venue = venueRow({ setup_minutes: 60, turnaround_minutes: 90 });
    const [item] = await recheck(fakeClient({ venue, bookings: [eventBookingRow()] }));
    expect(availabilityOf(item.current).detail).toBe(
      'Free 09:00–13:30 on Wed 11 Nov (incl. 60 min setup, 90 min turnaround)',
    );
  });

  it('SCRUM188_WK7_the_booking_never_conflicts_with_itself_but_another_events_does', async () => {
    const own = bookingRow({ id: BOOKING, event_request_id: EVENT });
    const occupancy = [own, bookingRow({ id: BOOKING_B })];
    const [item] = await recheck(fakeClient({ occupancy, bookings: [eventBookingRow()] }));
    expect(availabilityOf(item.current).met).toBe(false);
    expect(availabilityOf(item.current).conflicts.map((c) => c.id)).toEqual([BOOKING_B]);
  });

  it('SCRUM192_the_event_is_read_once_for_every_booking', async () => {
    const client = fakeClient({
      bookings: [eventBookingRow(), eventBookingRow({ id: BOOKING_B })],
    });
    await recheck(client);
    expect(client.calls.filter((c) => c.table === 'event_requests')).toHaveLength(1);
  });
});


describe('SCRUM188_AC6 newlyUnmet and atRequest', () => {
  it('SCRUM192_a_criterion_met_at_request_and_unmet_now_is_newly_unmet', async () => {
    const event = eventRow({ expected_attendance: 151 });
    const [item] = await recheck(fakeClient({ event, bookings: [eventBookingRow()] }));
    expect(item.atRequest).toEqual({ suitable: true, unmet: [] });
    expect(item.current.suitable).toBe(false);
    expect(item.newlyUnmet).toEqual(['Capacity']);
  });

  it('SCRUM192_a_criterion_already_overridden_at_request_is_not_newly_unmet', async () => {
    const booking = eventBookingRow({
      suitability_overridden: true,
      suitability_result: storedResult({ unmet: ['Capacity'], checked: { accessibility: [], facilities: [] } }),
    });
    const event = eventRow({ expected_attendance: 151 });
    const occupancy = [bookingRow({ id: BOOKING_B })];
    const [item] = await recheck(fakeClient({ event, occupancy, bookings: [booking] }));
    expect(item.atRequest).toEqual({ suitable: false, unmet: ['Capacity'] });
    const unmetNow = item.current.criteria.filter((c) => !c.met).map((c) => c.criterion);
    expect(unmetNow).toEqual(['Capacity', 'Availability']);
    expect(item.newlyUnmet).toEqual(['Availability']);
  });

  it('SCRUM192_a_criterion_unmet_at_request_and_met_now_is_not_reported', async () => {
    const booking = eventBookingRow({
      suitability_result: storedResult({ unmet: ['Capacity'], checked: { accessibility: [], facilities: [] } }),
    });
    const [item] = await recheck(fakeClient({ bookings: [booking] }));
    expect(item.atRequest.unmet).toEqual(['Capacity']);
    expect(item.current.suitable).toBe(true);
    expect(item.newlyUnmet).toEqual([]);
  });

  it('SCRUM192_with_no_stored_result_every_unmet_criterion_is_new', async () => {
    const event = eventRow({ expected_attendance: 151 });
    const booking = eventBookingRow({ suitability_result: null });
    const [item] = await recheck(fakeClient({ event, occupancy: [blockRow()], bookings: [booking] }));
    expect(item.atRequest).toBeNull();
    expect(item.newlyUnmet).toEqual(['Capacity', 'Availability']);
  });
});


describe('SCRUM188_AC6 errors', () => {
  it('SCRUM192_a_retired_venue_is_that_items_error_and_the_others_still_return', async () => {
    const retired = eventBookingRow({
      id: BOOKING_B,
      venue_id: VENUE_B,
      venues: { name: 'Old Hall', location: null },
    });
    const client = fakeClient({
      bookings: [eventBookingRow(), retired],
      venuesById: {
        [VENUE]: venueRow(),
        [VENUE_B]: venueRow({ id: VENUE_B, retired_at: '2026-09-01T00:00:00+00:00' }),
      },
    });
    const [ok, gone] = await recheck(client);
    expect(ok.current.suitable).toBe(true);
    expect(ok.error).toBeNull();
    expect(gone).toMatchObject({
      bookingId: BOOKING_B,
      venueName: 'Old Hall',
      current: null,
      newlyUnmet: [],
      error: { code: 'VENUE_RETIRED', message: `Venue ${VENUE_B} is retired, so it cannot host an event` },
    });
    expect(gone.atRequest).toEqual({ suitable: true, unmet: [] });
  });

  // SCRUM-193/194 (B3/B7) replaced SCRUM192_any_other_failure_of_one_booking_
  // fails_the_whole_recheck: one booking's failure is now that item's error.
  it('SCRUM188_AC6_a_failed_availability_read_is_that_items_RECHECK_FAILED_not_the_whole_recheck', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const items = await recheck(fakeClient({ rpcError: { message: 'boom' }, bookings: [eventBookingRow()] }));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      bookingId: BOOKING,
      current: null,
      newlyUnmet: [],
      error: { code: 'RECHECK_FAILED', message: 'This venue could not be rechecked just now; try again later' },
    });
    expect(items[0].error.message).not.toMatch(/boom/);
  });

  it('SCRUM188_AC6_a_coordinator_not_assigned_to_the_event_is_refused_before_bookings_are_read', async () => {
    const client = fakeClient({ bookings: [eventBookingRow()] });
    const err = await recheck(client, { userId: SOMEONE_ELSE }).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(client.calls.map((c) => c.table ?? c.fn)).toEqual(['event_requests']);
  });

  it('SCRUM188_AC6_an_event_with_no_dates_is_409_EVENT_DATES_MISSING_for_the_whole_request', async () => {
    const client = fakeClient({ event: eventRow({ proposed_start: null }), bookings: [eventBookingRow()] });
    const err = await recheck(client).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('EVENT_DATES_MISSING');
    expect(client.calls.map((c) => c.table ?? c.fn)).toEqual(['event_requests']);
  });

  it.each([
    ['an unknown event', { event: null }],
    ['a draft', { event: eventRow({ status: 'draft' }) }],
  ])('SCRUM188_AC6_%s_is_404', async (_label, options) => {
    const err = await recheck(fakeClient(options)).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-193/194: review fixes (regressions) and the test-case document's
// service-layer gap cases.
// ---------------------------------------------------------------------------

describe('SCRUM188_AC3 an event needs an expected attendance (B1)', () => {
  it.each([null, undefined])(
    'SCRUM188_AC3_an_event_with_%s_attendance_is_409_EVENT_ATTENDANCE_MISSING_not_a_pass',
    async (attendance) => {
      const client = fakeClient({ event: eventRow({ expected_attendance: attendance }) });
      const err = await check(client).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.status).toBe(409);
      expect(err.code).toBe('EVENT_ATTENDANCE_MISSING');
      expect(client.calls.map((c) => c.table ?? c.fn)).toEqual(['event_requests']);
    },
  );

  it('SCRUM188_AC3_an_attendance_of_zero_is_still_judged', async () => {
    const result = await check(fakeClient({ event: eventRow({ expected_attendance: 0 }) }));
    expect(result.criteria[0]).toMatchObject({ met: true, detail: 'Capacity 150 ≥ expected attendance 0' });
  });

  it('SCRUM188_AC6_no_attendance_refuses_the_whole_recheck_before_bookings_are_read', async () => {
    const client = fakeClient({ event: eventRow({ expected_attendance: null }), bookings: [eventBookingRow()] });
    const err = await recheck(client).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('EVENT_ATTENDANCE_MISSING');
    expect(client.calls.map((c) => c.table ?? c.fn)).toEqual(['event_requests']);
  });
});


describe('SCRUM188_AC6 a booking left on its old period (B2)', () => {
  // The booking was made for Wed 11 Nov 10:00-12:00; the event has moved.
  const movedTo = (start, end) => eventRow({ proposed_start: start, proposed_end: end });

  it('SCRUM188_AC6_a_booking_on_the_old_date_makes_availability_unmet_and_newly_unmet', async () => {
    const event = movedTo('2026-11-12T10:00:00+08:00', '2026-11-12T12:00:00+08:00');
    const [item] = await recheck(fakeClient({ event, bookings: [eventBookingRow()] }));

    expect(item).toMatchObject({ bookingStartsAt: START, bookingEndsAt: END, error: null });
    expect(availabilityOf(item.current)).toEqual({
      criterion: 'Availability',
      met: false,
      detail: 'Booking covers Wed 11 Nov 10:00–12:00; the event is now Thu 12 Nov 10:00–12:00',
      conflicts: [],
    });
    expect(item.current.suitable).toBe(false);
    expect(item.newlyUnmet).toEqual(['Availability']);
  });

  it('SCRUM188_AC6_a_moved_booking_with_real_conflicts_names_both', async () => {
    const event = movedTo('2026-11-11T14:15:00+08:00', '2026-11-11T16:00:00+08:00');
    const [item] = await recheck(fakeClient({ event, occupancy: [blockRow()], bookings: [eventBookingRow()] }));

    expect(availabilityOf(item.current).detail).toBe(
      'Booking covers Wed 11 Nov 10:00–12:00; the event is now Wed 11 Nov 14:15–16:00. ' +
        'Needs 13:45–16:45 on Wed 11 Nov (setup 13:45–14:15, turnaround 16:00–16:45). ' +
        'Blocked (maintenance) 10:00–14:00 on Wed 11 Nov',
    );
    expect(item.newlyUnmet).toEqual(['Availability']);
  });

  it('SCRUM188_AC6_the_same_instants_in_another_offset_are_not_a_move', async () => {
    const booking = eventBookingRow({ starts_at: '2026-11-11T02:00:00+00:00', ends_at: '2026-11-11T04:00:00Z' });
    const [item] = await recheck(fakeClient({ bookings: [booking] }));
    expect(availabilityOf(item.current).met).toBe(true);
    expect(availabilityOf(item.current).detail).toMatch(/^Free /);
    expect(item.newlyUnmet).toEqual([]);
  });

  it('SCRUM188_AC6_only_the_end_moving_is_a_move_too', async () => {
    const event = movedTo(START, '2026-11-11T13:00:00+08:00');
    const [item] = await recheck(fakeClient({ event, bookings: [eventBookingRow()] }));
    expect(availabilityOf(item.current).detail).toBe(
      'Booking covers Wed 11 Nov 10:00–12:00; the event is now Wed 11 Nov 10:00–13:00',
    );
  });

  it('SCRUM188_AC6_a_period_crossing_midnight_names_both_days', async () => {
    const event = movedTo('2026-11-11T23:00:00+08:00', '2026-11-12T01:00:00+08:00');
    const [item] = await recheck(fakeClient({ event, bookings: [eventBookingRow()] }));
    expect(availabilityOf(item.current).detail).toBe(
      'Booking covers Wed 11 Nov 10:00–12:00; the event is now Wed 11 Nov 23:00 – Thu 12 Nov 01:00',
    );
  });

  it('SCRUM188_AC6_a_booking_whose_period_was_not_read_is_not_compared', async () => {
    const booking = eventBookingRow({ starts_at: undefined, ends_at: undefined });
    const [item] = await recheck(fakeClient({ bookings: [booking] }));
    expect(item).toMatchObject({ bookingStartsAt: null, bookingEndsAt: null });
    expect(availabilityOf(item.current).met).toBe(true);
  });
});


describe('SCRUM188_AC6 one booking cannot fail the others (B3/B7)', () => {
  const twoBookings = (badOverrides, clientOptions = {}) =>
    fakeClient({
      bookings: [
        eventBookingRow(),
        eventBookingRow({ id: BOOKING_B, venue_id: VENUE_B, venues: { name: 'Hall B', location: null }, ...badOverrides }),
      ],
      venuesById: { [VENUE]: venueRow(), [VENUE_B]: venueRow({ id: VENUE_B, name: 'Hall B' }) },
      ...clientOptions,
    });

  it.each([
    ['accessibility as a string', { accessibility: 'wheelchair_access', facilities: [] }],
    ['facilities with a number in it', { accessibility: [], facilities: ['projector', 7] }],
    ['a blank code', { accessibility: ['  '], facilities: [] }],
  ])('SCRUM188_AC6_stored_%s_is_STORED_REQUIREMENTS_INVALID_and_never_judged', async (_label, checked) => {
    const client = twoBookings({ suitability_result: storedResult({ checked }) });
    const [ok, bad] = await recheck(client);

    expect(ok.current.suitable).toBe(true);
    expect(bad).toMatchObject({
      bookingId: BOOKING_B,
      venueName: 'Hall B',
      current: null,
      newlyUnmet: [],
      error: { code: 'STORED_REQUIREMENTS_INVALID' },
    });
    // Not judged with the codes dropped: Hall B was never read.
    expect(client.calls.filter((c) => c.fn).map((c) => c.args.p_venue_id)).toEqual([VENUE]);
  });

  it('SCRUM188_AC6_a_stored_checked_that_is_not_an_object_is_STORED_REQUIREMENTS_INVALID', async () => {
    const result = { ...storedResult(), checked: ['wheelchair_access'] };
    const [, bad] = await recheck(twoBookings({ suitability_result: result }));
    expect(bad.error.code).toBe('STORED_REQUIREMENTS_INVALID');
  });

  it('SCRUM188_AC6_a_stored_code_no_longer_known_is_STORED_REQUIREMENTS_INVALID_naming_it', async () => {
    const checked = { accessibility: ['ramp'], facilities: ['projector'] };
    const [ok, bad] = await recheck(twoBookings({ suitability_result: storedResult({ checked }) }));
    expect(ok.error).toBeNull();
    expect(bad.current).toBeNull();
    expect(bad.error).toEqual({
      code: 'STORED_REQUIREMENTS_INVALID',
      message: 'The requirement codes stored with this request cannot be checked (accessibility: unknown code "ramp")',
    });
  });

  it('SCRUM188_AC6_a_venue_that_cannot_be_found_is_that_items_RECHECK_FAILED', async () => {
    const client = fakeClient({
      bookings: [eventBookingRow(), eventBookingRow({ id: BOOKING_B, venue_id: VENUE_B })],
      venuesById: { [VENUE]: venueRow() },
    });
    const [ok, bad] = await recheck(client);
    expect(ok.current.suitable).toBe(true);
    expect(bad).toMatchObject({
      current: null,
      newlyUnmet: [],
      error: { code: 'RECHECK_FAILED', message: `Venue ${VENUE_B} not found` },
    });
  });

  it('SCRUM188_AC6_absent_or_null_stored_lists_are_still_none_asked_for', async () => {
    const checked = { accessibility: null };
    const [item] = await recheck(fakeClient({ bookings: [eventBookingRow({ suitability_result: storedResult({ checked }) })] }));
    expect(item.error).toBeNull();
    expect(item.current.checked).toMatchObject({ accessibility: [], facilities: [] });
  });
});


describe('SCRUM188_WK7_1 an unavailable venue names the event\'s own occupied period (B4)', () => {
  it('SCRUM188_WK7_1_unavailable_names_the_events_occupied_period_and_its_parts_first', async () => {
    const event = eventRow({ proposed_start: '2026-11-11T14:15:00+08:00', proposed_end: '2026-11-11T16:00:00+08:00' });
    const availability = availabilityOf(await check(fakeClient({ event, occupancy: [blockRow()] })));
    expect(availability.met).toBe(false);
    expect(availability.detail).toBe(
      'Needs 13:45–16:45 on Wed 11 Nov (setup 13:45–14:15, turnaround 16:00–16:45). ' +
        'Blocked (maintenance) 10:00–14:00 on Wed 11 Nov',
    );
  });

  it('SCRUM188_WK7_1_with_no_setup_or_turnaround_the_need_is_just_the_event', async () => {
    const venue = venueRow({ setup_minutes: 0, turnaround_minutes: 0 });
    const availability = availabilityOf(await check(fakeClient({ venue, occupancy: [blockRow()] })));
    expect(availability.detail).toBe(
      'Needs 10:00–12:00 on Wed 11 Nov. Blocked (maintenance) 10:00–14:00 on Wed 11 Nov',
    );
  });
});


// --- the test-case document's service cases --------------------------------

describe('SCRUM188_AC2 the Jira example (B-AC2-01)', () => {
  it('SCRUM188_AC2_the_jira_example_capacity_80_below_150_reads_verbatim', async () => {
    const result = await check(
      fakeClient({ venue: venueRow({ max_capacity: 80 }), event: eventRow({ expected_attendance: 150 }) }),
    );
    expect(result.criteria[0]).toEqual({
      criterion: 'Capacity',
      met: false,
      detail: 'Capacity 80 < expected attendance 150',
    });
  });
});


describe('SCRUM188_AC5 one unmet criterion is enough (B-AC5-01)', () => {
  const ALL_MET = { roomLayoutCode: 'theatre', accessibility: ['wheelchair_access'], facilities: ['projector'] };
  const notWednesday = [0, 1, 2, 4, 5, 6].map((day) => ({ day_of_week: day, opens_at: '08:00:00', closes_at: '22:00:00' }));

  it('SCRUM188_AC5_the_base_fixture_meets_all_six', async () => {
    const result = await check(fakeClient(), ALL_MET);
    expect(result.criteria.every((c) => c.met)).toBe(true);
    expect(result.suitable).toBe(true);
  });

  it.each([
    ['Capacity', { venue: venueRow({ max_capacity: 1 }) }, {}],
    ['Operating hours', { venue: venueRow({ venue_operating_hours: notWednesday }) }, {}],
    ['Layout', {}, { roomLayoutCode: 'u_shape' }],
    ['Accessibility', {}, { accessibility: ['hearing_loop'] }],
    ['Facilities', {}, { facilities: ['stage'] }],
    ['Availability', { occupancy: [bookingRow()] }, {}],
  ])('SCRUM188_AC5_each_single_unmet_criterion_makes_it_not_suitable (%s)', async (label, clientOptions, input) => {
    const result = await check(fakeClient(clientOptions), { ...ALL_MET, ...input });
    expect(result.criteria.filter((c) => !c.met).map((c) => c.criterion)).toEqual([label]);
    expect(result.suitable).toBe(false);
  });
});


describe('SCRUM188_AC6 rechecks (B-AC6-01, B-AC6-03)', () => {
  it('SCRUM188_AC6_a_venue_details_change_is_judged_live_and_named_newly_unmet', async () => {
    const venue = venueRow({
      max_capacity: 100,
      venue_room_layouts: [{ room_layout_code: 'banquet' }],
      venue_operating_hours: [{ day_of_week: 3, opens_at: '13:00:00', closes_at: '22:00:00' }],
    });
    const [item] = await recheck(fakeClient({ venue, bookings: [eventBookingRow()] }));
    expect(item.atRequest).toEqual({ suitable: true, unmet: [] });
    expect(item.current.criteria.slice(0, 3).map((c) => [c.criterion, c.met])).toEqual([
      ['Capacity', false],
      ['Operating hours', false],
      ['Layout', false],
    ]);
    expect(item.newlyUnmet).toEqual(['Capacity', 'Operating hours', 'Layout']);
  });

  it('SCRUM188_AC6_an_overridden_criterion_failing_again_is_not_newly_unmet', async () => {
    // Pins today's name-level rule (test-case document, open point 6).
    const stored = storedResult({ unmet: ['Capacity'], checked: { accessibility: [], facilities: [] } });
    stored.criteria[0].detail = 'Capacity 80 < expected attendance 120';
    const booking = eventBookingRow({ suitability_overridden: true, suitability_result: stored });
    const [item] = await recheck(
      fakeClient({ venue: venueRow({ max_capacity: 80 }), event: eventRow({ expected_attendance: 150 }), bookings: [booking] }),
    );
    expect(item.current.criteria[0]).toMatchObject({ met: false, detail: 'Capacity 80 < expected attendance 150' });
    expect(item.atRequest.unmet).toEqual(['Capacity']);
    expect(item.newlyUnmet).toEqual([]);
  });
});


describe('SCRUM188_WK7_3 checked per booking (B-WK7-3-01/02)', () => {
  const V1 = VENUE;
  const V2 = VENUE_B;
  const twoVenueBookings = () => [
    eventBookingRow({ room_layout_code: 'theatre' }),
    eventBookingRow({ id: BOOKING_B, venue_id: V2, room_layout_code: 'theatre', venues: { name: 'Hall B', location: null } }),
  ];

  it('SCRUM188_WK7_3_layout_is_judged_per_booking', async () => {
    const client = fakeClient({
      bookings: twoVenueBookings(),
      venuesById: {
        [V1]: venueRow({ venue_room_layouts: [{ room_layout_code: 'theatre' }] }),
        [V2]: venueRow({ id: V2, venue_room_layouts: [{ room_layout_code: 'banquet' }] }),
      },
    });
    const [one, two] = await recheck(client);
    expect(one.current.criteria[2]).toMatchObject({ met: true, detail: 'Layout theatre offered' });
    expect(two.current.criteria[2]).toMatchObject({
      met: false,
      detail: 'Layout theatre not offered (offers: banquet)',
      layout: 'theatre',
      offers: ['banquet'],
    });
  });

  it('SCRUM188_WK7_3_capacity_uses_the_events_attendance_until_bookings_have_their_own', async () => {
    // Accepted as partial (open point 1): bookings have no attendance column.
    const client = fakeClient({
      event: eventRow({ expected_attendance: 150 }),
      bookings: twoVenueBookings(),
      venuesById: { [V1]: venueRow({ max_capacity: 200 }), [V2]: venueRow({ id: V2, max_capacity: 100 }) },
    });
    const [one, two] = await recheck(client);
    expect(one.current.criteria[0]).toMatchObject({ met: true, detail: 'Capacity 200 ≥ expected attendance 150' });
    expect(two.current.criteria[0]).toMatchObject({ met: false, detail: 'Capacity 100 < expected attendance 150' });
    expect(one.current.checked.expectedAttendance).toBe(150);
    expect(two.current.checked.expectedAttendance).toBe(150);
  });
});
