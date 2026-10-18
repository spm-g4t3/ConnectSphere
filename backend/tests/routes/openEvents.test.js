/**
 * GET /api/open-events over an in-memory Supabase stand-in that applies eq, lte,
 * gt and order, so a filter the service forgets shows up as a wrong result. It
 * returns every column whatever select() asked for, so the "excluded fields"
 * tests prove the response is an allowlist.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createOpenEventRouter } from '../../src/routes/openEvents.js';
import { listOpenEvents, getOpenEvent } from '../../src/services/openEventService.js';
import { ROLE } from '../../src/domain/userRole.js';

const NOW = new Date('2026-10-12T10:00:00.000Z');
const ATTENDEE_ID = '44444444-4444-4444-8444-444444444444';

let nextId = 1;
const id = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;

/** A row that is listed, carrying columns no Attendee may ever see. */
function eventRow(overrides = {}) {
  return {
    id: id(),
    event_name: 'Open Day',
    description: 'Come along.',
    proposed_start: '2026-10-25T09:00:00+00:00',
    proposed_end: '2026-10-25T17:00:00+00:00',
    status: 'confirmed',
    registration_enabled: true,
    registration_opens_at: '2026-10-01T00:00:00+00:00',
    registration_closes_at: '2026-10-20T00:00:00+00:00',
    registration_capacity: 50,
    // Internal columns of event_requests.
    organiser_id: '11111111-1111-4111-8111-111111111111',
    assigned_coordinator_id: '55555555-5555-4555-8555-555555555555',
    reviewing_coordinator_id: '55555555-5555-4555-8555-555555555555',
    purpose: 'Internal purpose',
    venue_requirements: 'Main hall',
    accessibility_requirements: 'Step-free',
    equipment_requirements: 'Two projectors, supplied by AV Co',
    clarification_note: 'Please confirm the headcount',
    decision_note: 'Approved with conditions',
    decided_by: '55555555-5555-4555-8555-555555555555',
    expected_attendance: 40,
    venue_name: 'Grand Hall',
    venue_id: '33333333-3333-4333-8333-333333333333',
    created_at: '2026-09-01T00:00:00+00:00',
    ...overrides,
  };
}

const at = (value) => new Date(value).getTime();

/** One `.or()` condition: `column.is.null` or `column.gt.value`, joined by commas. */
function matchesOr(row, expression) {
  return expression.split(',').some((condition) => {
    const [column, op, value] = condition.split('.');
    if (op === 'is') return row[column] === null || row[column] === undefined;
    const cell = row[column];
    return cell !== null && cell !== undefined && at(cell) > at(condition.slice(column.length + op.length + 2));
  });
}

/**
 * In-memory event_requests that applies what the service asks of it, and the
 * open_event_registration_state function as the database computes it.
 */
function createFakeClient(
  rows,
  { error = null, ignoreFilters = false, registrations = [], registrationError = null } = {},
) {
  const calls = [];

  return {
    calls,
    rpc(name, args) {
      calls.push({ table: `rpc:${name}`, args });
      if (registrationError) return Promise.resolve({ data: null, error: registrationError });

      const byEvent = new Map();
      for (const r of registrations) {
        if (!args.p_event_ids.includes(r.event_request_id) || r.status !== 'registered') continue;
        const state = byEvent.get(r.event_request_id) ?? { event_request_id: r.event_request_id, active_count: 0, is_registered: false };
        state.active_count += 1;
        state.is_registered ||= r.attendee_id === args.p_attendee_id;
        byEvent.set(r.event_request_id, state);
      }
      return Promise.resolve({ data: [...byEvent.values()].slice(0, 1000), error: null });
    },
    from(table) {
      const call = { table, selected: null, filters: [], orders: [] };
      calls.push(call);
      const source = rows;
      const failure = error;

      const chain = {
        or: (expression) => {
          call.filters.push(['or', expression]);
          return chain;
        },
        select: (columns) => {
          call.selected = columns;
          return chain;
        },
        eq: (column, value) => {
          call.filters.push(['eq', column, value]);
          return chain;
        },
        in: (column, value) => {
          call.filters.push(['in', column, value]);
          return chain;
        },
        lte: (column, value) => {
          call.filters.push(['lte', column, value]);
          return chain;
        },
        gt: (column, value) => {
          call.filters.push(['gt', column, value]);
          return chain;
        },
        order: (column, options) => {
          call.orders.push([column, options]);
          return chain;
        },
        range: (first, last) => {
          call.range = [first, last];
          return chain;
        },
        then: (resolve, reject) => {
          if (failure) return Promise.resolve({ data: null, error: failure }).then(resolve, reject);

          let result = ignoreFilters
            ? [...source]
            : source.filter((row) =>
                call.filters.every(([op, column, value]) => {
                  if (op === 'or') return matchesOr(row, column);
                  const cell = row[column];
                  if (op === 'eq') return cell === value;
                  if (op === 'in') return value.includes(cell);
                  if (cell === null || cell === undefined) return false;
                  return op === 'lte' ? at(cell) <= at(value) : at(cell) > at(value);
                }),
              );

          for (const [column, options] of [...call.orders].reverse()) {
            const direction = options?.ascending === false ? -1 : 1;
            result = [...result].sort((a, b) => {
              const [x, y] = column === 'proposed_start' ? [at(a[column]), at(b[column])] : [a[column], b[column]];
              return x < y ? -direction : x > y ? direction : 0;
            });
          }
          // Like PostgREST, a response never holds more than 1,000 rows.
          const [first, last] = call.range ?? [0, 999];
          result = result.slice(first, Math.min(last, first + 999) + 1);
          return Promise.resolve({ data: result, error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
}

const signedInWithRole = (role) => (req, _res, next) => {
  req.user = { id: ATTENDEE_ID, email: 'a@example.com', role };
  next();
};
const signedOut = (_req, res) => res.status(401).json({ error: 'Authentication required' });

function get(client, { requireAuth = signedInWithRole(ROLE.ATTENDEE), now = () => NOW } = {}) {
  const app = express().use('/api/open-events', createOpenEventRouter({ client, requireAuth, now }));
  return request(app).get('/api/open-events');
}

const ALLOWED_KEYS = [
  'canJoinWaitlist', 'canRegister', 'capacity', 'description', 'endsAt', 'eventName', 'id',
  'isFull', 'isRegistered', 'placesLeft', 'startsAt', 'waitlistCount',
];

describe('SCRUM495 waiting-list placeholders', () => {
  it('SCRUM495_AC3_offers_no_waiting_list_yet_even_on_a_full_event_so_scrum_22_adds_one_without_reshaping_the_response', async () => {
    const row = eventRow({ registration_capacity: 1 });
    const client = createFakeClient([row], { registrations: [registration(row.id, OTHER_ATTENDEE_ID)] });

    const res = await get(client);

    expect(res.body[0]).toMatchObject({ isFull: true, canRegister: false, canJoinWaitlist: false, waitlistCount: null });
  });
});

describe('SCRUM495_AC1 only Attendees can open the list', () => {
  it('SCRUM495_AC1_lets_an_attendee_in', async () => {
    const client = createFakeClient([eventRow()]);

    const res = await get(client);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it.each([
    ROLE.EVENT_ORGANISER,
    ROLE.EVENT_COORDINATOR,
    ROLE.VENUE_STAFF,
    ROLE.TECHNICAL_SUPPORT_STAFF,
    ROLE.EVENT_COORDINATOR_LEAD,
    ROLE.SAFETY_OFFICER,
    'something_unknown',
    null,
  ])('SCRUM495_AC1_refuses_role_%s_with_403_before_reading_anything', async (role) => {
    const client = createFakeClient([eventRow()]);

    const res = await get(client, { requireAuth: signedInWithRole(role) });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/restricted to Attendees/);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM495_AC1_refuses_an_unauthenticated_caller_with_401_before_reading_anything', async () => {
    const client = createFakeClient([eventRow()]);

    const res = await get(client, { requireAuth: signedOut });

    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM495_AC1_refuses_a_request_with_no_bearer_token_through_the_real_authentication_middleware', async () => {
    const client = createFakeClient([eventRow()]);
    const app = express().use('/api/open-events', createOpenEventRouter({ client }));

    const res = await request(app).get('/api/open-events');

    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });
});

describe('SCRUM495_AC2 only open Confirmed events are listed', () => {
  it('SCRUM495_AC2_judges_by_the_real_clock_when_none_is_injected', async () => {
    const days = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
    const row = eventRow({
      proposed_start: days(10),
      proposed_end: days(11),
      registration_opens_at: days(-1),
      registration_closes_at: days(5),
    });
    const client = createFakeClient([row]);
    const app = express().use(
      '/api/open-events',
      createOpenEventRouter({ client, requireAuth: signedInWithRole(ROLE.ATTENDEE) }),
    );

    const res = await request(app).get('/api/open-events');

    expect(res.status).toBe(200);
    expect(res.body.map((event) => event.id)).toEqual([row.id]);
  });

  it('SCRUM495_AC2_lists_an_eligible_event_with_its_attendee_facing_fields', async () => {
    const row = eventRow({ id: 'a1111111-1111-4111-8111-111111111111' });

    const res = await get(createFakeClient([row]));

    expect(res.body).toEqual([
      {
        id: 'a1111111-1111-4111-8111-111111111111',
        eventName: 'Open Day',
        description: 'Come along.',
        startsAt: '2026-10-25T09:00:00+00:00',
        endsAt: '2026-10-25T17:00:00+00:00',
        capacity: 50,
        placesLeft: 50,
        isFull: false,
        isRegistered: false,
        canRegister: true,
        canJoinWaitlist: false,
        waitlistCount: null,
      },
    ]);
  });

  it.each([
    'draft', 'submitted', 'under_review', 'pending_clarification',
    'approved', 'completed', 'rejected', 'cancelled',
  ])('SCRUM495_AC2_leaves_out_an_event_whose_status_is_%s', async (status) => {
    const res = await get(createFakeClient([eventRow({ status })]));

    expect(res.body).toEqual([]);
  });

  it('SCRUM495_AC2_leaves_out_an_event_with_registration_off', async () => {
    const res = await get(createFakeClient([eventRow({ registration_enabled: false })]));

    expect(res.body).toEqual([]);
  });

  it('SCRUM495_AC2_leaves_out_an_event_whose_registration_has_not_opened_yet', async () => {
    const res = await get(createFakeClient([eventRow({ registration_opens_at: '2026-10-13T00:00:00+00:00' })]));

    expect(res.body).toEqual([]);
  });

  it('SCRUM495_AC2_leaves_out_an_event_whose_registration_has_closed', async () => {
    const res = await get(createFakeClient([eventRow({ registration_closes_at: '2026-10-11T00:00:00+00:00' })]));

    expect(res.body).toEqual([]);
  });

  it('SCRUM495_AC2_leaves_out_an_event_that_has_already_started', async () => {
    const res = await get(
      createFakeClient([
        eventRow({
          proposed_start: '2026-10-12T09:00:00+00:00',
          proposed_end: '2026-10-12T17:00:00+00:00',
          registration_closes_at: '2026-10-12T23:00:00+00:00',
        }),
      ]),
    );

    expect(res.body).toEqual([]);
  });

  it('SCRUM495_AC2_leaves_out_an_event_with_registration_on_but_no_window_set', async () => {
    const res = await get(
      createFakeClient([eventRow({ registration_opens_at: null, registration_closes_at: null })]),
    );

    expect(res.body).toEqual([]);
  });

  it('SCRUM495_AC2_lists_an_event_with_no_closing_time_open_until_the_organiser_closes_it_by_hand', async () => {
    const res = await get(createFakeClient([eventRow({ registration_closes_at: null })]));

    expect(res.body).toHaveLength(1);
    expect(res.body[0].eventName).toBe('Open Day');
  });

  it('SCRUM495_AC2_opens_an_event_with_no_closing_time_by_direct_url_too', async () => {
    const row = eventRow({ registration_closes_at: null });

    const res = await getOne(createFakeClient([row]), row.id);

    expect(res.status).toBe(200);
  });

  it('SCRUM495_AC2_still_leaves_out_an_event_with_no_closing_time_once_it_has_started', async () => {
    const row = eventRow({ registration_closes_at: null, proposed_start: '2026-10-12T09:00:00+00:00', proposed_end: '2026-10-12T17:00:00+00:00' });

    const res = await get(createFakeClient([row]));

    expect(res.body).toEqual([]);
  });

  it('SCRUM495_AC2_applies_the_half_open_window_open_at_the_opening_instant_closed_at_the_closing_instant', async () => {
    const opensNow = eventRow({ event_name: 'Opens now', registration_opens_at: NOW.toISOString() });
    const closesNow = eventRow({ event_name: 'Closes now', registration_closes_at: NOW.toISOString() });

    const res = await get(createFakeClient([opensNow, closesNow]));

    expect(res.body.map((e) => e.eventName)).toEqual(['Opens now']);
  });

  it('SCRUM495_AC2_keeps_only_the_eligible_events_out_of_a_mixed_set', async () => {
    const rows = [
      eventRow({ event_name: 'Listed' }),
      eventRow({ event_name: 'Approved again', status: 'approved' }),
      eventRow({ event_name: 'Switched off', registration_enabled: false }),
      eventRow({ event_name: 'Closed', registration_closes_at: '2026-10-12T09:00:00+00:00' }),
    ];

    const res = await get(createFakeClient(rows));

    expect(res.body.map((e) => e.eventName)).toEqual(['Listed']);
  });

  it('SCRUM495_AC2_says_nothing_is_open_with_200_and_an_empty_list_never_a_404', async () => {
    const res = await get(createFakeClient([]));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('SCRUM495_AC2_still_drops_an_ineligible_row_even_if_the_query_returned_it', async () => {
    const rows = [eventRow({ event_name: 'Listed' }), eventRow({ event_name: 'Approved again', status: 'approved' })];

    const res = await get(createFakeClient(rows, { ignoreFilters: true }));

    expect(res.body.map((e) => e.eventName)).toEqual(['Listed']);
  });

  it('SCRUM495_AC2_asks_the_database_for_exactly_those_conditions_at_the_instant_given_by_the_clock', async () => {
    const client = createFakeClient([]);

    await get(client);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].table).toBe('event_requests');
    expect(client.calls[0].filters).toEqual([
      ['eq', 'status', 'confirmed'],
      ['eq', 'registration_enabled', true],
      ['lte', 'registration_opens_at', '2026-10-12T10:00:00.000Z'],
      ['gt', 'proposed_start', '2026-10-12T10:00:00.000Z'],
      ['or', 'registration_closes_at.is.null,registration_closes_at.gt.2026-10-12T10:00:00.000Z'],
    ]);
  });
});

describe('SCRUM495_AC3 full events stay in the list', () => {
  it('SCRUM495_AC3_lists_an_event_at_capacity_as_full_it_is_not_removed', async () => {
    const row = eventRow({ registration_capacity: 1 });
    const client = createFakeClient([row], { registrations: [registration(row.id, OTHER_ATTENDEE_ID)] });

    const res = await get(client);

    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ capacity: 1, placesLeft: 0, isFull: true, canRegister: false });
  });

  it('SCRUM495_AC3_returns_a_null_capacity_for_an_event_with_no_limit', async () => {
    const res = await get(createFakeClient([eventRow({ registration_capacity: null })]));

    expect(res.body[0].capacity).toBeNull();
  });
});

const OTHER_ATTENDEE_ID = '99999999-9999-4999-8999-999999999999';
const THIRD_ATTENDEE_ID = '88888888-8888-4888-8888-888888888888';

function registration(eventId, attendeeId, status = 'registered') {
  return { id: id(), event_request_id: eventId, attendee_id: attendeeId, status, registered_at: '2026-10-05T00:00:00+00:00' };
}

describe('SCRUM495_AC3 places left', () => {
  it('SCRUM495_AC3_counts_only_the_registrations_that_hold_a_place', async () => {
    const row = eventRow({ registration_capacity: 10 });
    const registrations = [
      registration(row.id, OTHER_ATTENDEE_ID),
      registration(row.id, THIRD_ATTENDEE_ID),
      registration(row.id, ATTENDEE_ID, 'withdrawn'),
      registration(row.id, '77777777-7777-4777-8777-777777777777', 'cancelled'),
    ];

    const res = await get(createFakeClient([row], { registrations }));

    expect(res.body[0]).toMatchObject({ capacity: 10, placesLeft: 8, isFull: false, canRegister: true });
  });

  it('SCRUM495_AC3_frees_the_place_when_a_registration_is_withdrawn_or_cancelled_so_a_full_event_is_no_longer_full', async () => {
    const row = eventRow({ registration_capacity: 2 });
    const registrations = [registration(row.id, OTHER_ATTENDEE_ID), registration(row.id, THIRD_ATTENDEE_ID, 'withdrawn')];

    const res = await get(createFakeClient([row], { registrations }));

    expect(res.body[0]).toMatchObject({ placesLeft: 1, isFull: false, canRegister: true });
  });

  it('SCRUM495_AC3_is_full_when_every_place_is_taken_and_offers_no_registration', async () => {
    const row = eventRow({ registration_capacity: 2 });
    const registrations = [registration(row.id, OTHER_ATTENDEE_ID), registration(row.id, THIRD_ATTENDEE_ID)];

    const res = await get(createFakeClient([row], { registrations }));

    expect(res.body[0]).toMatchObject({ placesLeft: 0, isFull: true, canRegister: false });
  });

  it('SCRUM495_AC3_never_reports_negative_places_when_the_capacity_was_lowered_below_the_number_registered', async () => {
    const row = eventRow({ registration_capacity: 1 });
    const registrations = [
      registration(row.id, OTHER_ATTENDEE_ID),
      registration(row.id, THIRD_ATTENDEE_ID),
      registration(row.id, '77777777-7777-4777-8777-777777777777'),
    ];

    const res = await get(createFakeClient([row], { registrations }));

    expect(res.body[0].placesLeft).toBe(0);
    expect(res.body[0].isFull).toBe(true);
  });

  it('SCRUM495_AC3_has_no_limit_and_is_never_full_when_no_capacity_is_set_however_many_are_registered', async () => {
    const row = eventRow({ registration_capacity: null });
    const registrations = Array.from({ length: 500 }, (_, n) => registration(row.id, `attendee-${n}`));

    const res = await get(createFakeClient([row], { registrations }));

    expect(res.body[0]).toMatchObject({ capacity: null, placesLeft: null, isFull: false, canRegister: true });
  });

  it('SCRUM495_AC3_counts_each_event_on_its_own', async () => {
    const small = eventRow({ event_name: 'Small', registration_capacity: 1, proposed_start: '2026-10-20T09:00:00+00:00', proposed_end: '2026-10-20T10:00:00+00:00' });
    const large = eventRow({ event_name: 'Large', registration_capacity: 5, proposed_start: '2026-10-21T09:00:00+00:00', proposed_end: '2026-10-21T10:00:00+00:00' });
    const registrations = [registration(small.id, OTHER_ATTENDEE_ID), registration(large.id, OTHER_ATTENDEE_ID), registration(large.id, THIRD_ATTENDEE_ID)];

    const res = await get(createFakeClient([small, large], { registrations }));

    expect(res.body.map((e) => [e.eventName, e.placesLeft, e.isFull])).toEqual([
      ['Small', 0, true],
      ['Large', 3, false],
    ]);
  });

  it('SCRUM495_AC3_ignores_registrations_for_events_that_are_not_listed', async () => {
    const listed = eventRow({ registration_capacity: 3 });
    const unlisted = eventRow({ status: 'approved' });
    const registrations = [registration(unlisted.id, OTHER_ATTENDEE_ID), registration(unlisted.id, THIRD_ATTENDEE_ID)];

    const res = await get(createFakeClient([listed, unlisted], { registrations }));

    expect(res.body).toHaveLength(1);
    expect(res.body[0].placesLeft).toBe(3);
  });

  it('SCRUM495_AC3_counts_in_the_database_in_one_call_for_the_listed_events_not_one_per_event', async () => {
    const rows = [eventRow(), eventRow(), eventRow()];
    const client = createFakeClient(rows);

    await get(client);

    const reads = client.calls.filter((call) => call.table === 'rpc:open_event_registration_state');
    expect(reads).toHaveLength(1);
    expect(reads[0].args).toEqual({ p_event_ids: rows.map((r) => r.id), p_attendee_id: ATTENDEE_ID });
    expect(client.calls.some((call) => call.table === 'registrations')).toBe(false);
  });

  it('SCRUM495_AC3_counts_past_1_000_registrations_because_the_database_returns_one_row_per_event', async () => {
    const row = eventRow({ registration_capacity: 1200 });
    const registrations = Array.from({ length: 1100 }, (_, n) => registration(row.id, `attendee-${n}`));
    registrations.push(registration(row.id, ATTENDEE_ID));

    const res = await get(createFakeClient([row], { registrations }));

    expect(res.body[0]).toMatchObject({ placesLeft: 99, isFull: false, isRegistered: true });
  });

  it('SCRUM495_AC3_keeps_the_event_ids_out_of_the_url_so_hundreds_of_open_events_still_list', async () => {
    const rows = Array.from({ length: 400 }, () => eventRow());
    const client = createFakeClient(rows);

    const res = await get(client);

    expect(res.body).toHaveLength(400);
    expect(client.calls.filter((call) => call.table === 'event_requests').every((call) => !call.filters.some(([op]) => op === 'in'))).toBe(true);
  });

  it('SCRUM495_AC3_does_not_read_registrations_at_all_when_no_event_is_listed', async () => {
    const client = createFakeClient([eventRow({ status: 'approved' })]);

    await get(client);

    expect(client.calls.map((call) => call.table)).toEqual(['event_requests']);
  });

  it('SCRUM495_AC3_treats_an_event_the_database_returns_no_row_for_as_empty_and_not_registered', async () => {
    const row = eventRow({ registration_capacity: 2 });

    const res = await get(createFakeClient([row]));

    expect(res.body[0]).toMatchObject({ placesLeft: 2, isRegistered: false });
  });
});

describe('SCRUM495_AC6 the signed-in attendee\'s own registration', () => {
  it('SCRUM495_AC6_marks_an_event_the_caller_holds_a_place_on_as_registered_and_offers_no_registration', async () => {
    const row = eventRow({ registration_capacity: 5 });
    const registrations = [registration(row.id, ATTENDEE_ID)];

    const res = await get(createFakeClient([row], { registrations }));

    expect(res.body[0]).toMatchObject({ isRegistered: true, canRegister: false, placesLeft: 4 });
  });

  it('SCRUM495_AC6_marks_a_full_event_the_caller_is_registered_on_as_both_full_and_registered', async () => {
    const row = eventRow({ registration_capacity: 1 });
    const registrations = [registration(row.id, ATTENDEE_ID)];

    const res = await get(createFakeClient([row], { registrations }));

    expect(res.body[0]).toMatchObject({ isRegistered: true, isFull: true, canRegister: false });
  });

  it('SCRUM495_AC6_marks_an_unlimited_event_the_caller_is_registered_on_as_registered', async () => {
    const row = eventRow({ registration_capacity: null });

    const res = await get(createFakeClient([row], { registrations: [registration(row.id, ATTENDEE_ID)] }));

    expect(res.body[0]).toMatchObject({ isRegistered: true, placesLeft: null, canRegister: false });
  });

  it.each(['withdrawn', 'cancelled'])('SCRUM495_AC6_does_not_call_a_%s_registration_registered_so_the_caller_may_register_again', async (status) => {
    const row = eventRow({ registration_capacity: 5 });

    const res = await get(createFakeClient([row], { registrations: [registration(row.id, ATTENDEE_ID, status)] }));

    expect(res.body[0]).toMatchObject({ isRegistered: false, canRegister: true, placesLeft: 5 });
  });

  it('SCRUM495_AC6_does_not_mark_an_event_registered_because_someone_else_is', async () => {
    const row = eventRow();

    const res = await get(createFakeClient([row], { registrations: [registration(row.id, OTHER_ATTENDEE_ID)] }));

    expect(res.body[0].isRegistered).toBe(false);
  });

  it('SCRUM495_AC6_marks_only_the_events_the_caller_is_registered_on', async () => {
    const a = eventRow({ event_name: 'A', proposed_start: '2026-10-20T09:00:00+00:00', proposed_end: '2026-10-20T10:00:00+00:00' });
    const b = eventRow({ event_name: 'B', proposed_start: '2026-10-21T09:00:00+00:00', proposed_end: '2026-10-21T10:00:00+00:00' });

    const res = await get(createFakeClient([a, b], { registrations: [registration(b.id, ATTENDEE_ID)] }));

    expect(res.body.map((e) => [e.eventName, e.isRegistered])).toEqual([['A', false], ['B', true]]);
  });

  it('SCRUM495_AC6_takes_the_caller_from_the_verified_token_never_from_the_request', async () => {
    const row = eventRow();
    const client = createFakeClient([row], { registrations: [registration(row.id, OTHER_ATTENDEE_ID)] });
    const app = express().use('/api/open-events', createOpenEventRouter({ client, requireAuth: signedInWithRole(ROLE.ATTENDEE), now: () => NOW }));

    const res = await request(app)
      .get('/api/open-events')
      .query({ attendeeId: OTHER_ATTENDEE_ID, userId: OTHER_ATTENDEE_ID })
      .set('X-User-Id', OTHER_ATTENDEE_ID);

    expect(res.body[0].isRegistered).toBe(false);
  });

  it('SCRUM495_AC6_never_returns_another_attendee_s_identity_or_any_registration_record', async () => {
    const row = eventRow({ registration_capacity: 5 });
    const registrations = [registration(row.id, OTHER_ATTENDEE_ID), registration(row.id, THIRD_ATTENDEE_ID), registration(row.id, ATTENDEE_ID)];

    const res = await get(createFakeClient([row], { registrations }));
    const text = JSON.stringify(res.body);

    expect(text).not.toContain(OTHER_ATTENDEE_ID);
    expect(text).not.toContain(THIRD_ATTENDEE_ID);
    expect(text).not.toContain('registered_at');
    expect(Object.keys(res.body[0]).sort()).toEqual(ALLOWED_KEYS);
  });

  it('SCRUM495_AC6_never_reads_a_registration_row_the_database_returns_counts_and_the_caller_s_own_flag_only', async () => {
    const client = createFakeClient([eventRow()]);

    await get(client);

    expect(client.calls.some((call) => call.table === 'registrations')).toBe(false);
    expect(client.calls.some((call) => call.table === 'rpc:open_event_registration_state')).toBe(true);
  });

  it('SCRUM495_AC6_never_writes_the_stand_in_client_has_no_write_methods_and_a_clean_run_proves_none_was_called', async () => {
    const client = createFakeClient([eventRow()]);
    const chainMethods = Object.keys(client.from('event_requests'));

    expect(chainMethods).not.toEqual(expect.arrayContaining(['insert', 'update', 'delete', 'upsert']));
    expect((await get(client)).status).toBe(200);
  });
});

describe('SCRUM495_AC4 sorted by start, earliest first', () => {
  it('SCRUM495_AC4_orders_by_start_whatever_order_the_rows_arrive_in', async () => {
    const rows = [
      eventRow({ event_name: 'Third', proposed_start: '2026-11-03T09:00:00+00:00', proposed_end: '2026-11-03T10:00:00+00:00' }),
      eventRow({ event_name: 'First', proposed_start: '2026-10-20T09:00:00+00:00', proposed_end: '2026-10-20T10:00:00+00:00' }),
      eventRow({ event_name: 'Second', proposed_start: '2026-10-30T09:00:00+00:00', proposed_end: '2026-10-30T10:00:00+00:00' }),
    ];

    const res = await get(createFakeClient(rows));

    expect(res.body.map((e) => e.eventName)).toEqual(['First', 'Second', 'Third']);
  });

  it('SCRUM495_AC4_compares_instants_so_a_08_00_start_sorts_by_when_it_happens_not_by_its_text', async () => {
    const rows = [
      // 2026-10-25T09:00+08:00 is 01:00Z, earlier than 02:00Z although the text sorts after.
      eventRow({ event_name: 'Later', proposed_start: '2026-10-25T02:00:00+00:00', proposed_end: '2026-10-25T03:00:00+00:00' }),
      eventRow({ event_name: 'Earlier', proposed_start: '2026-10-25T09:00:00+08:00', proposed_end: '2026-10-25T10:00:00+08:00' }),
    ];

    const res = await get(createFakeClient(rows));

    expect(res.body.map((e) => e.eventName)).toEqual(['Earlier', 'Later']);
  });

  it('SCRUM495_AC4_breaks_a_tie_on_start_by_id_so_the_order_is_stable', async () => {
    const b = eventRow({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', event_name: 'B' });
    const a = eventRow({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', event_name: 'A' });

    const res = await get(createFakeClient([b, a]));

    expect(res.body.map((e) => e.eventName)).toEqual(['A', 'B']);
  });

  it('SCRUM495_AC4_asks_the_database_to_sort_by_start_then_id_ascending', async () => {
    const client = createFakeClient([]);

    await get(client);

    expect(client.calls[0].orders).toEqual([
      ['proposed_start', { ascending: true }],
      ['id', { ascending: true }],
    ]);
  });

  it('SCRUM495_AC4_lists_every_open_event_when_more_than_one_page_is_open', async () => {
    const rows = Array.from({ length: 1001 }, () => eventRow());
    const client = createFakeClient(rows);

    const res = await get(client);

    expect(res.body).toHaveLength(1001);
    expect(client.calls.filter((c) => c.table === 'event_requests').map((c) => c.range)).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });
});

describe('SCRUM495_AC8 no internal planning information is returned', () => {
  it('SCRUM495_AC8_returns_exactly_the_allowlisted_fields_and_no_others', async () => {
    const res = await get(createFakeClient([eventRow()]));

    expect(Object.keys(res.body[0]).sort()).toEqual(ALLOWED_KEYS);
  });

  it('SCRUM495_AC8_never_leaks_a_venue_coordinator_requirement_note_decision_or_organiser_value', async () => {
    const res = await get(createFakeClient([eventRow()]));
    const text = JSON.stringify(res.body);

    for (const secret of [
      'Grand Hall',
      '33333333-3333-4333-8333-333333333333',
      '55555555-5555-4555-8555-555555555555',
      '11111111-1111-4111-8111-111111111111',
      'Main hall',
      'Step-free',
      'AV Co',
      'Internal purpose',
      'confirm the headcount',
      'Approved with conditions',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('SCRUM495_AC8_does_not_leak_a_column_added_to_the_table_later', async () => {
    const res = await get(createFakeClient([eventRow({ supplier_contact: 'secret@supplier.example', staff_notes: 'internal' })]));

    expect(JSON.stringify(res.body)).not.toMatch(/supplier|staff_notes|internal/i);
  });

  it('SCRUM495_AC8_does_not_even_select_the_internal_columns_from_the_database', async () => {
    const client = createFakeClient([]);

    await get(client);

    const selected = client.calls[0].selected;
    for (const column of [
      'organiser_id', 'assigned_coordinator_id', 'reviewing_coordinator_id', 'purpose',
      'venue_requirements', 'accessibility_requirements', 'equipment_requirements',
      'clarification_note', 'decision', 'decision_note', 'decided_by', 'expected_attendance',
    ]) {
      expect(selected).not.toContain(column);
    }
  });
});

describe('SCRUM495 freshness and failures', () => {
  it('SCRUM495_AC2_reads_the_table_on_every_call_so_a_change_is_seen_on_the_next_request', async () => {
    const rows = [eventRow({ event_name: 'Now listed' })];
    const client = createFakeClient(rows);

    expect((await get(client)).body).toHaveLength(1);

    rows[0].status = 'approved';
    expect((await get(client)).body).toEqual([]);
    expect(client.calls.filter((call) => call.table === 'event_requests')).toHaveLength(2);
  });

  it('SCRUM495_AC2_uses_the_clock_on_each_request_so_an_event_drops_out_when_its_window_closes', async () => {
    const client = createFakeClient([eventRow()]);
    let clock = new Date('2026-10-19T23:59:59.999Z');

    const before = await get(client, { now: () => clock });
    clock = new Date('2026-10-20T00:00:00.000Z');
    const after = await get(client, { now: () => clock });

    expect(before.body).toHaveLength(1);
    expect(after.body).toEqual([]);
  });

  it('SCRUM495_AC2_tells_the_browser_not_to_store_the_list', async () => {
    const res = await get(createFakeClient([eventRow()]));

    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('SCRUM495_AC2_refuses_to_run_without_an_attendee_before_any_read', async () => {
    const client = createFakeClient([eventRow()]);

    await expect(listOpenEvents({ client, now: NOW })).rejects.toThrow(/attendeeId/);
    await expect(listOpenEvents({ attendeeId: '  ', client, now: NOW })).rejects.toThrow(/attendeeId/);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM495_AC1_answers_403_with_no_database_message_when_the_function_refuses_the_role', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = createFakeClient([eventRow()], {
      registrationError: { code: '42501', message: 'Only an attendee may read registration state' },
    });

    const res = await get(client);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Only an Attendee can browse open events' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('SCRUM495_AC1_answers_400_when_the_function_refuses_a_missing_attendee', async () => {
    const client = createFakeClient([eventRow()], {
      registrationError: { code: '22023', message: 'An attendee is required' },
    });

    const res = await get(client);

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'attendeeId', message: 'is required' }]);
  });

  it('SCRUM495_AC3_counts_registrations_for_every_event_when_more_than_one_batch_is_open', async () => {
    const rows = Array.from({ length: 1001 }, () => eventRow({ registration_capacity: 1 }));
    const last = rows[rows.length - 1];
    // Every event has a registration, so the database returns a row for each.
    const client = createFakeClient(rows, {
      registrations: [
        ...rows.map((row) => registration(row.id, OTHER_ATTENDEE_ID)),
        registration(last.id, ATTENDEE_ID),
      ],
    });

    const res = await get(client);
    const body = res.body.find((e) => e.id === last.id);

    expect(body).toMatchObject({ isFull: true, isRegistered: true });
    expect(client.calls.filter((c) => c.table === 'rpc:open_event_registration_state')).toHaveLength(3);
  });

  it('SCRUM495_AC2_answers_a_safe_503_when_the_registrations_read_fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = createFakeClient([eventRow()], { registrationError: { code: '42P01', message: 'relation "registrations" does not exist' } });

    const res = await get(client);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Event registration is temporarily unavailable. Please try again later.' });
    spy.mockRestore();
  });

  it.each(['42P01', '42703', 'PGRST202', 'PGRST204', 'PGRST205'])('SCRUM22_AC8_list_maps_missing_schema_%s_to_a_safe_503', async (code) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = createFakeClient([], { error: { code, message: 'column registration_enabled does not exist' } });

    const res = await get(client);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Event registration is temporarily unavailable. Please try again later.' });
    expect(JSON.stringify(res.body)).not.toContain('registration_enabled');
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// GET /api/open-events/:id, the details page's read
// ---------------------------------------------------------------------------

function getOne(client, eventId, { requireAuth = signedInWithRole(ROLE.ATTENDEE), now = () => NOW } = {}) {
  const app = express().use('/api/open-events', createOpenEventRouter({ client, requireAuth, now }));
  return request(app).get(`/api/open-events/${eventId}`);
}

const NOT_OPEN = { error: 'This event is not open for registration' };

describe('SCRUM495_AC1 only Attendees can open one event', () => {
  it('SCRUM495_AC1_lets_an_attendee_in', async () => {
    const row = eventRow();

    const res = await getOne(createFakeClient([row]), row.id);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(row.id);
  });

  it.each([
    ROLE.EVENT_ORGANISER,
    ROLE.EVENT_COORDINATOR,
    ROLE.VENUE_STAFF,
    ROLE.TECHNICAL_SUPPORT_STAFF,
    ROLE.EVENT_COORDINATOR_LEAD,
    ROLE.SAFETY_OFFICER,
    'something_unknown',
    null,
  ])('SCRUM495_AC1_refuses_role_%s_with_403_before_reading_anything', async (role) => {
    const row = eventRow();
    const client = createFakeClient([row]);

    const res = await getOne(client, row.id, { requireAuth: signedInWithRole(role) });

    expect(res.status).toBe(403);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM495_AC1_refuses_an_unauthenticated_caller_with_401_before_reading_anything', async () => {
    const row = eventRow();
    const client = createFakeClient([row]);

    const res = await getOne(client, row.id, { requireAuth: signedOut });

    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });
});

describe('SCRUM495_AC2 one event follows the same eligibility as the list', () => {
  it('SCRUM495_AC2_returns_the_same_entry_the_list_gives_for_that_event', async () => {
    const row = eventRow({ registration_capacity: 4 });
    const registrations = [registration(row.id, OTHER_ATTENDEE_ID), registration(row.id, ATTENDEE_ID)];

    const listed = (await get(createFakeClient([row], { registrations }))).body[0];
    const opened = (await getOne(createFakeClient([row], { registrations }), row.id)).body;

    expect(opened).toEqual(listed);
    expect(opened).toMatchObject({ placesLeft: 2, isRegistered: true, canRegister: false });
  });

  it.each([
    ['not Confirmed', { status: 'approved' }],
    ['registration off', { registration_enabled: false }],
    ['not yet open', { registration_opens_at: '2026-10-13T00:00:00+00:00' }],
    ['closed', { registration_closes_at: '2026-10-12T10:00:00+00:00' }],
    ['already started', { proposed_start: '2026-10-12T09:00:00+00:00', proposed_end: '2026-10-12T17:00:00+00:00', registration_closes_at: '2026-10-12T23:00:00+00:00' }],
    ['no window set', { registration_opens_at: null, registration_closes_at: null }],
  ])('SCRUM495_AC2_answers_404_for_an_event_that_is_%s_by_direct_url', async (_label, overrides) => {
    const row = eventRow(overrides);

    const res = await getOne(createFakeClient([row]), row.id);

    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_OPEN);
  });

  it('SCRUM495_AC2_answers_the_same_404_for_an_event_that_does_not_exist', async () => {
    const res = await getOne(createFakeClient([eventRow()]), 'ffffffff-ffff-4fff-8fff-ffffffffffff');

    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_OPEN);
  });

  it('SCRUM495_AC2_answers_the_same_404_for_a_malformed_id_without_reading_anything', async () => {
    const client = createFakeClient([eventRow()]);

    const res = await getOne(client, 'not-an-id');

    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_OPEN);
    expect(client.calls).toHaveLength(0);
  });

  it('SCRUM495_AC2_still_drops_an_ineligible_or_different_row_even_if_the_query_returned_it', async () => {
    const wanted = eventRow({ status: 'approved' });
    const other = eventRow();

    const res = await getOne(createFakeClient([other, wanted], { ignoreFilters: true }), wanted.id);

    expect(res.status).toBe(404);
  });

  it('SCRUM495_AC2_asks_the_database_for_exactly_the_list_conditions_plus_the_id_at_the_clock_instant', async () => {
    const row = eventRow();
    const client = createFakeClient([row]);

    await getOne(client, row.id);

    expect(client.calls[0].filters).toEqual([
      ['eq', 'status', 'confirmed'],
      ['eq', 'registration_enabled', true],
      ['lte', 'registration_opens_at', '2026-10-12T10:00:00.000Z'],
      ['gt', 'proposed_start', '2026-10-12T10:00:00.000Z'],
      ['or', 'registration_closes_at.is.null,registration_closes_at.gt.2026-10-12T10:00:00.000Z'],
      ['eq', 'id', row.id],
    ]);
  });

  it('SCRUM495_AC2_judges_eligibility_afresh_on_every_request_so_an_event_drops_out_when_its_window_closes', async () => {
    const row = eventRow();
    const client = createFakeClient([row]);
    let clock = new Date('2026-10-19T23:59:59.999Z');

    const before = await getOne(client, row.id, { now: () => clock });
    clock = new Date('2026-10-20T00:00:00.000Z');
    const after = await getOne(client, row.id, { now: () => clock });

    expect(before.status).toBe(200);
    expect(after.status).toBe(404);
  });

  it('SCRUM495_AC2_tells_the_browser_not_to_store_it', async () => {
    const row = eventRow();

    const res = await getOne(createFakeClient([row]), row.id);

    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('SCRUM495_AC3_AC6 availability and registration state on one event', () => {
  it('SCRUM495_AC3_AC6_shows_full_for_an_event_at_capacity_and_it_is_still_reachable', async () => {
    const row = eventRow({ registration_capacity: 1 });

    const res = await getOne(createFakeClient([row], { registrations: [registration(row.id, OTHER_ATTENDEE_ID)] }), row.id);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ placesLeft: 0, isFull: true, canRegister: false });
  });

  it('SCRUM495_AC3_AC6_shows_no_limit_for_an_event_with_no_capacity', async () => {
    const row = eventRow({ registration_capacity: null });

    const res = await getOne(createFakeClient([row]), row.id);

    expect(res.body).toMatchObject({ capacity: null, placesLeft: null, isFull: false, canRegister: true });
  });

  it('SCRUM495_AC3_AC6_shows_registered_for_the_caller_s_own_registration_only', async () => {
    const row = eventRow();

    const mine = await getOne(createFakeClient([row], { registrations: [registration(row.id, ATTENDEE_ID)] }), row.id);
    const theirs = await getOne(createFakeClient([row], { registrations: [registration(row.id, OTHER_ATTENDEE_ID)] }), row.id);

    expect(mine.body).toMatchObject({ isRegistered: true, canRegister: false });
    expect(theirs.body).toMatchObject({ isRegistered: false, canRegister: true });
  });

  it.each(['withdrawn', 'cancelled'])('SCRUM495_AC3_AC6_does_not_count_a_%s_registration', async (status) => {
    const row = eventRow({ registration_capacity: 1 });

    const res = await getOne(createFakeClient([row], { registrations: [registration(row.id, ATTENDEE_ID, status)] }), row.id);

    expect(res.body).toMatchObject({ placesLeft: 1, isFull: false, isRegistered: false, canRegister: true });
  });

  it('SCRUM495_AC3_AC6_reads_the_registration_state_of_this_one_event_in_one_call', async () => {
    const row = eventRow();
    const client = createFakeClient([row]);

    await getOne(client, row.id);

    const reads = client.calls.filter((call) => call.table === 'rpc:open_event_registration_state');
    expect(reads).toHaveLength(1);
    expect(reads[0].args).toEqual({ p_event_ids: [row.id], p_attendee_id: ATTENDEE_ID });
  });
});

describe('SCRUM495_AC8 one event carries no internal planning information', () => {
  it('SCRUM495_AC8_returns_exactly_the_allowlisted_fields_and_no_venue_coordinator_or_other_attendee', async () => {
    const row = eventRow();
    const registrations = [registration(row.id, OTHER_ATTENDEE_ID), registration(row.id, ATTENDEE_ID)];

    const res = await getOne(createFakeClient([row], { registrations }), row.id);
    const text = JSON.stringify(res.body);

    expect(Object.keys(res.body).sort()).toEqual(ALLOWED_KEYS);
    for (const secret of ['Grand Hall', '33333333-3333-4333-8333-333333333333', '55555555-5555-4555-8555-555555555555', 'Main hall', 'AV Co', 'Internal purpose', OTHER_ATTENDEE_ID]) {
      expect(text).not.toContain(secret);
    }
  });

  it.each(['42P01', '42703', 'PGRST202', 'PGRST204', 'PGRST205'])('SCRUM22_AC8_details_map_missing_schema_%s_to_a_safe_503', async (code) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const row = eventRow();

    const res = await getOne(createFakeClient([row], { error: { code, message: 'column registration_enabled does not exist' } }), row.id);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Event registration is temporarily unavailable. Please try again later.' });
    spy.mockRestore();
  });
});
describe.each([
  ['list', (client) => get(client), (client) => listOpenEvents({ attendeeId: ATTENDEE_ID, client, now: NOW })],
  ['details', (client, row) => getOne(client, row.id), (client, row) => getOpenEvent({ attendeeId: ATTENDEE_ID, eventId: row.id, client, now: NOW })],
])('SCRUM22 %s table read failures', (_name, readRoute, readService) => {
  it.each([
    ['42501'], ['22023'], ['55000'], ['55000', 'EVENT_NOT_CONFIRMED'],
    ['40001'], ['40P01'], ['P0002'], ['XX000'],
  ])('SCRUM22_AC8_preserves_table_error_%s_%s_and_returns_a_logged_generic_500', async (code, hint) => {
    const row = eventRow();
    const error = { code, hint, message: 'Private event_requests database failure' };
    const client = createFakeClient([row], { error });

    await expect(readService(client, row)).rejects.toBe(error);

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await readRoute(client, row);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Unexpected server error' });
      expect(spy).toHaveBeenCalledWith('Unexpected error in open events route:', error);
      expect(client.calls.some((call) => call.table.startsWith('rpc:'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Refresh: the same event read at successive moments
// ---------------------------------------------------------------------------

describe('SCRUM495_AC9 Confirmed to Approved and back, registrations kept', () => {
  it('SCRUM495_AC9_drops_the_event_from_the_list_and_the_details_while_it_is_approved_and_brings_it_back_when_reconfirmed_with_its_registrations', async () => {
    const row = eventRow({ registration_capacity: 5 });
    const registrations = [registration(row.id, ATTENDEE_ID), registration(row.id, OTHER_ATTENDEE_ID)];
    const before = JSON.stringify(registrations);
    const client = createFakeClient([row], { registrations });

    const first = await get(client);
    expect(first.body).toHaveLength(1);
    expect(first.body[0]).toMatchObject({ placesLeft: 3, isRegistered: true });

    row.status = 'approved'; // a significant change returns it to Approved (SCRUM-395)
    const whileApproved = await get(client);
    const detailsWhileApproved = await getOne(client, row.id);
    expect(whileApproved.body).toEqual([]);
    expect(detailsWhileApproved.status).toBe(404);
    expect(detailsWhileApproved.body).toEqual(NOT_OPEN);
    expect(JSON.stringify(registrations)).toBe(before);

    row.status = 'confirmed'; // reconfirmed
    const again = await get(client);
    const detailsAgain = await getOne(client, row.id);
    expect(again.body).toEqual(first.body);
    expect(detailsAgain.status).toBe(200);
    expect(detailsAgain.body).toMatchObject({ placesLeft: 3, isRegistered: true });
    expect(JSON.stringify(registrations)).toBe(before);
  });

  it('SCRUM495_AC9_does_not_read_count_or_touch_the_registrations_of_an_event_while_it_is_approved', async () => {
    const row = eventRow({ status: 'approved' });
    const client = createFakeClient([row], { registrations: [registration(row.id, ATTENDEE_ID)] });

    await get(client);
    await getOne(client, row.id);

    expect(client.calls.map((call) => call.table)).toEqual(['event_requests', 'event_requests']);
  });

  it.each([
    ['registration is off', { registration_enabled: false }],
    ['its window has closed', { registration_closes_at: '2026-10-12T09:59:59+00:00' }],
    ['its window has not opened', { registration_opens_at: '2026-10-12T10:00:01+00:00' }],
    ['it has started', { proposed_start: '2026-10-12T09:00:00+00:00', proposed_end: '2026-10-12T17:00:00+00:00', registration_closes_at: '2026-10-12T23:00:00+00:00' }],
  ])('SCRUM495_AC9_after_reconfirmation_the_event_is_still_left_out_if_%s', async (_label, overrides) => {
    const row = eventRow({ status: 'approved', ...overrides });
    const client = createFakeClient([row]);

    row.status = 'confirmed';

    expect((await get(client)).body).toEqual([]);
    expect((await getOne(client, row.id)).status).toBe(404);
  });

  it('SCRUM495_AC9_lists_the_event_after_reconfirmation_only_once_every_other_condition_holds', async () => {
    const row = eventRow({ status: 'approved', registration_enabled: false });
    const client = createFakeClient([row]);

    row.status = 'confirmed';
    expect((await get(client)).body).toEqual([]);

    row.registration_enabled = true;
    expect((await get(client)).body).toHaveLength(1);
  });
});

describe('SCRUM495_AC4 availability is current on every read', () => {
  it('SCRUM495_AC4_shows_a_place_taken_by_another_attendee_then_freed_by_a_withdrawal_on_the_next_read', async () => {
    const row = eventRow({ registration_capacity: 1 });
    const registrations = [];
    const client = createFakeClient([row], { registrations });

    expect((await getOne(client, row.id)).body).toMatchObject({ placesLeft: 1, isFull: false, canRegister: true });

    const taken = registration(row.id, OTHER_ATTENDEE_ID);
    registrations.push(taken);
    expect((await getOne(client, row.id)).body).toMatchObject({ placesLeft: 0, isFull: true, canRegister: false });
    expect((await get(client)).body[0]).toMatchObject({ placesLeft: 0, isFull: true });

    taken.status = 'withdrawn';
    expect((await getOne(client, row.id)).body).toMatchObject({ placesLeft: 1, isFull: false, canRegister: true });
  });

  it('SCRUM495_AC4_shows_the_caller_as_registered_as_soon_as_their_registration_exists_in_the_list_and_the_details', async () => {
    const row = eventRow({ registration_capacity: 3 });
    const registrations = [];
    const client = createFakeClient([row], { registrations });

    expect((await get(client)).body[0].isRegistered).toBe(false);

    registrations.push(registration(row.id, ATTENDEE_ID));

    expect((await get(client)).body[0]).toMatchObject({ isRegistered: true, placesLeft: 2 });
    expect((await getOne(client, row.id)).body).toMatchObject({ isRegistered: true, placesLeft: 2 });
  });
});

// ---------------------------------------------------------------------------
// Boundaries and time zones, on both endpoints
// ---------------------------------------------------------------------------
// NOW is 2026-10-12T10:00:00.000Z, which is 18:00 in Singapore. The window is
// [opens, closes) and an event is listed only while start > now. The same
// instant written with a +08:00 offset must give the same answer, whatever
// zone the server runs in, because every comparison is between instants.

describe('SCRUM495_AC2_AC3 registration window and start boundaries', () => {
  const afterNow = '2026-10-12T10:00:00.001Z';
  const beforeNow = '2026-10-12T09:59:59.999Z';
  const nowZ = '2026-10-12T10:00:00.000Z';
  const nowSg = '2026-10-12T18:00:00+08:00';
  const startLater = { proposed_end: '2026-10-30T17:00:00+00:00' };

  const cases = [
    ['opens exactly now', { registration_opens_at: nowZ }, true],
    ['opens exactly now, written at +08:00', { registration_opens_at: nowSg }, true],
    ['opens one millisecond ago', { registration_opens_at: beforeNow }, true],
    ['opens one millisecond from now', { registration_opens_at: afterNow }, false],
    ['opens one second from now, written at +08:00', { registration_opens_at: '2026-10-12T18:00:01+08:00' }, false],
    ['closes exactly now', { registration_closes_at: nowZ }, false],
    ['closes exactly now, written at +08:00', { registration_closes_at: nowSg }, false],
    ['closes one millisecond ago', { registration_closes_at: beforeNow }, false],
    ['closes one millisecond from now', { registration_closes_at: afterNow }, true],
    ['closes one second from now, written at +08:00', { registration_closes_at: '2026-10-12T18:00:01+08:00' }, true],
    ['starts exactly now', { proposed_start: nowZ, registration_closes_at: '2026-10-12T23:00:00+00:00', ...startLater }, false],
    ['starts exactly now, written at +08:00', { proposed_start: nowSg, registration_closes_at: '2026-10-12T23:00:00+00:00', ...startLater }, false],
    ['started one millisecond ago', { proposed_start: beforeNow, registration_closes_at: '2026-10-12T23:00:00+00:00', ...startLater }, false],
    ['starts one millisecond from now', { proposed_start: afterNow, registration_closes_at: '2026-10-12T23:00:00+00:00', ...startLater }, true],
    ['starts one second from now, written at +08:00', { proposed_start: '2026-10-12T18:00:01+08:00', registration_closes_at: '2026-10-12T23:00:00+00:00', ...startLater }, true],
  ];

  it.each(cases)('SCRUM495_AC2_AC3_the_list_an_event_that_%s_is_listed_%s', async (_label, overrides, listed) => {
    const res = await get(createFakeClient([eventRow(overrides)]));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(listed ? 1 : 0);
  });

  it.each(cases)('SCRUM495_AC2_AC3_the_details_url_an_event_that_%s_is_opened_%s', async (_label, overrides, opened) => {
    const row = eventRow(overrides);

    const res = await getOne(createFakeClient([row]), row.id);

    expect(res.status).toBe(opened ? 200 : 404);
  });

  it('SCRUM495_AC2_AC3_gives_the_same_answers_whatever_zone_the_server_process_runs_in', async () => {
    const original = process.env.TZ;
    try {
      for (const zone of ['UTC', 'Asia/Singapore', 'America/New_York', 'Pacific/Auckland']) {
        process.env.TZ = zone;
        const open = eventRow({ registration_closes_at: '2026-10-12T18:00:01+08:00' });
        const closed = eventRow({ registration_closes_at: '2026-10-12T18:00:00+08:00' });

        expect((await get(createFakeClient([open, closed]))).body.map((e) => e.id)).toEqual([open.id]);
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('SCRUM495_AC2_AC3_finds_an_event_by_an_upper_case_id_as_postgres_would', async () => {
    const row = eventRow({ id: 'abcdef12-3456-4789-8abc-def123456789' });

    const res = await getOne(createFakeClient([row]), row.id.toUpperCase());

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(row.id);
  });
});
