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
 */
function fakeClient({ event = eventRow(), venue = venueRow(), occupancy = [], rpcError = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, filters: [] };
      calls.push(call);
      const chain = {
        select: () => chain,
        eq: (column, value) => {
          call.filters.push([column, value]);
          return chain;
        },
        in: (column, values) => {
          call.filters.push([column, values]);
          const known = KNOWN_CODES[table] ?? [];
          return Promise.resolve({
            data: values.filter((code) => known.includes(code)).map((code) => ({ code })),
            error: null,
          });
        },
        maybeSingle: () =>
          Promise.resolve({ data: table === 'event_requests' ? event : venue, error: null }),
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
      { criterion: 'Layout', met: true, detail: 'Layout theatre offered' },
      { criterion: 'Accessibility', met: true, detail: 'All 1 requested provided' },
      { criterion: 'Facilities', met: true, detail: 'All 1 requested provided' },
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
    expect(result.criteria[4]).toEqual({ criterion: 'Facilities', met: false, detail: 'Missing: stage' });
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
      'Held for Gala Night 09:30–12:45 on Wed 11 Nov (setup 09:30–10:00, turnaround 12:00–12:45)',
    );
    expect(availability.conflicts[0]).toMatchObject({ kind: 'hold', id: HOLD, eventName: 'Gala Night' });
  });

  it('SCRUM188_WK7_a_block_is_described_by_its_own_unpadded_period', async () => {
    const availability = availabilityOf(await check(fakeClient({ occupancy: [blockRow()] })));
    expect(availability.met).toBe(false);
    expect(availability.detail).toBe('Blocked (maintenance) 10:00–14:00 on Wed 11 Nov');
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
    expect(result.criteria[2]).toEqual({ criterion: 'Layout', met: true, detail: 'None requested' });
  });
});
