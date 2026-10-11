/**
 * SCRUM-495: GET /api/open-events, the events an Attendee can register for.
 *
 * Real Express routing, the real route and the real service over an in-memory
 * stand-in for the Supabase client that genuinely applies eq, lte, gt and
 * order to its rows, so a filter the service forgets shows up as a wrong
 * result here rather than passing on a mock. Auth is injected, as in the other
 * route tests, so no credentials or network are involved.
 *
 * The stand-in returns every column of a row whatever select() asked for, which
 * is deliberate: the "excluded fields" tests rely on the response being built
 * from an allowlist rather than on the query happening to select little.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createOpenEventRouter } from '../../src/routes/openEvents.js';
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

/** In-memory event_requests that applies what the service asks of it. */
function createFakeClient(rows, { error = null, ignoreFilters = false } = {}) {
  const calls = [];

  return {
    calls,
    from(table) {
      const call = { table, selected: null, filters: [], orders: [] };
      calls.push(call);

      const chain = {
        select: (columns) => {
          call.selected = columns;
          return chain;
        },
        eq: (column, value) => {
          call.filters.push(['eq', column, value]);
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
        then: (resolve, reject) => {
          if (error) return Promise.resolve({ data: null, error }).then(resolve, reject);

          let result = ignoreFilters
            ? [...rows]
            : rows.filter((row) =>
                call.filters.every(([op, column, value]) => {
                  const cell = row[column];
                  if (op === 'eq') return cell === value;
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

const ALLOWED_KEYS = ['capacity', 'description', 'endsAt', 'eventName', 'id', 'startsAt'];

describe('SCRUM495_AC1 only Attendees can open the list', () => {
  it('lets an Attendee in', async () => {
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
  ])('refuses role %s with 403 before reading anything', async (role) => {
    const client = createFakeClient([eventRow()]);

    const res = await get(client, { requireAuth: signedInWithRole(role) });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/restricted to Attendees/);
    expect(client.calls).toHaveLength(0);
  });

  it('refuses an unauthenticated caller with 401 before reading anything', async () => {
    const client = createFakeClient([eventRow()]);

    const res = await get(client, { requireAuth: signedOut });

    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });

  it('refuses a request with no bearer token through the real authentication middleware', async () => {
    const client = createFakeClient([eventRow()]);
    const app = express().use('/api/open-events', createOpenEventRouter({ client }));

    const res = await request(app).get('/api/open-events');

    expect(res.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });
});

describe('SCRUM495_AC2 only open Confirmed events are listed', () => {
  it('lists an eligible event with its attendee-facing fields', async () => {
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
      },
    ]);
  });

  it.each([
    'draft', 'submitted', 'under_review', 'pending_clarification',
    'approved', 'completed', 'rejected', 'cancelled',
  ])('leaves out an event whose status is %s', async (status) => {
    const res = await get(createFakeClient([eventRow({ status })]));

    expect(res.body).toEqual([]);
  });

  it('leaves out an event with registration off', async () => {
    const res = await get(createFakeClient([eventRow({ registration_enabled: false })]));

    expect(res.body).toEqual([]);
  });

  it('leaves out an event whose registration has not opened yet', async () => {
    const res = await get(createFakeClient([eventRow({ registration_opens_at: '2026-10-13T00:00:00+00:00' })]));

    expect(res.body).toEqual([]);
  });

  it('leaves out an event whose registration has closed', async () => {
    const res = await get(createFakeClient([eventRow({ registration_closes_at: '2026-10-11T00:00:00+00:00' })]));

    expect(res.body).toEqual([]);
  });

  it('leaves out an event that has already started', async () => {
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

  it('leaves out an event with registration on but no window set', async () => {
    const res = await get(
      createFakeClient([eventRow({ registration_opens_at: null, registration_closes_at: null })]),
    );

    expect(res.body).toEqual([]);
  });

  it('applies the half-open window: open at the opening instant, closed at the closing instant', async () => {
    const opensNow = eventRow({ event_name: 'Opens now', registration_opens_at: NOW.toISOString() });
    const closesNow = eventRow({ event_name: 'Closes now', registration_closes_at: NOW.toISOString() });

    const res = await get(createFakeClient([opensNow, closesNow]));

    expect(res.body.map((e) => e.eventName)).toEqual(['Opens now']);
  });

  it('keeps only the eligible events out of a mixed set', async () => {
    const rows = [
      eventRow({ event_name: 'Listed' }),
      eventRow({ event_name: 'Approved again', status: 'approved' }),
      eventRow({ event_name: 'Switched off', registration_enabled: false }),
      eventRow({ event_name: 'Closed', registration_closes_at: '2026-10-12T09:00:00+00:00' }),
    ];

    const res = await get(createFakeClient(rows));

    expect(res.body.map((e) => e.eventName)).toEqual(['Listed']);
  });

  it('says nothing is open with 200 and an empty list, never a 404', async () => {
    const res = await get(createFakeClient([]));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('still drops an ineligible row even if the query returned it', async () => {
    const rows = [eventRow({ event_name: 'Listed' }), eventRow({ event_name: 'Approved again', status: 'approved' })];

    const res = await get(createFakeClient(rows, { ignoreFilters: true }));

    expect(res.body.map((e) => e.eventName)).toEqual(['Listed']);
  });

  it('asks the database for exactly those conditions, at the instant given by the clock', async () => {
    const client = createFakeClient([]);

    await get(client);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].table).toBe('event_requests');
    expect(client.calls[0].filters).toEqual([
      ['eq', 'status', 'confirmed'],
      ['eq', 'registration_enabled', true],
      ['lte', 'registration_opens_at', '2026-10-12T10:00:00.000Z'],
      ['gt', 'registration_closes_at', '2026-10-12T10:00:00.000Z'],
      ['gt', 'proposed_start', '2026-10-12T10:00:00.000Z'],
    ]);
  });
});

describe('SCRUM495_AC3 full events stay in the list', () => {
  it('lists an event at capacity; it is not removed, and no registration is read or written', async () => {
    const client = createFakeClient([eventRow({ registration_capacity: 1 })]);

    const res = await get(client);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].capacity).toBe(1);
    expect(client.calls.map((call) => call.table)).toEqual(['event_requests']);
  });

  it('returns a null capacity for an event with no limit', async () => {
    const res = await get(createFakeClient([eventRow({ registration_capacity: null })]));

    expect(res.body[0].capacity).toBeNull();
  });
});

describe('SCRUM495_AC4 sorted by start, earliest first', () => {
  it('orders by start whatever order the rows arrive in', async () => {
    const rows = [
      eventRow({ event_name: 'Third', proposed_start: '2026-11-03T09:00:00+00:00', proposed_end: '2026-11-03T10:00:00+00:00' }),
      eventRow({ event_name: 'First', proposed_start: '2026-10-20T09:00:00+00:00', proposed_end: '2026-10-20T10:00:00+00:00' }),
      eventRow({ event_name: 'Second', proposed_start: '2026-10-30T09:00:00+00:00', proposed_end: '2026-10-30T10:00:00+00:00' }),
    ];

    const res = await get(createFakeClient(rows));

    expect(res.body.map((e) => e.eventName)).toEqual(['First', 'Second', 'Third']);
  });

  it('compares instants, so a +08:00 start sorts by when it happens, not by its text', async () => {
    const rows = [
      // 2026-10-25T09:00+08:00 is 01:00Z, earlier than 02:00Z although the text sorts after.
      eventRow({ event_name: 'Later', proposed_start: '2026-10-25T02:00:00+00:00', proposed_end: '2026-10-25T03:00:00+00:00' }),
      eventRow({ event_name: 'Earlier', proposed_start: '2026-10-25T09:00:00+08:00', proposed_end: '2026-10-25T10:00:00+08:00' }),
    ];

    const res = await get(createFakeClient(rows));

    expect(res.body.map((e) => e.eventName)).toEqual(['Earlier', 'Later']);
  });

  it('breaks a tie on start by id, so the order is stable', async () => {
    const b = eventRow({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', event_name: 'B' });
    const a = eventRow({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', event_name: 'A' });

    const res = await get(createFakeClient([b, a]));

    expect(res.body.map((e) => e.eventName)).toEqual(['A', 'B']);
  });

  it('asks the database to sort by start, then id, ascending', async () => {
    const client = createFakeClient([]);

    await get(client);

    expect(client.calls[0].orders).toEqual([
      ['proposed_start', { ascending: true }],
      ['id', { ascending: true }],
    ]);
  });
});

describe('SCRUM495_AC8 no internal planning information is returned', () => {
  it('returns exactly the allowlisted fields and no others', async () => {
    const res = await get(createFakeClient([eventRow()]));

    expect(Object.keys(res.body[0]).sort()).toEqual(ALLOWED_KEYS);
  });

  it('never leaks a venue, coordinator, requirement, note, decision or organiser value', async () => {
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

  it('does not leak a column added to the table later', async () => {
    const res = await get(createFakeClient([eventRow({ supplier_contact: 'secret@supplier.example', staff_notes: 'internal' })]));

    expect(JSON.stringify(res.body)).not.toMatch(/supplier|staff_notes|internal/i);
  });

  it('does not even select the internal columns from the database', async () => {
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
  it('reads the table on every call, so a change is seen on the next request', async () => {
    const rows = [eventRow({ event_name: 'Now listed' })];
    const client = createFakeClient(rows);

    expect((await get(client)).body).toHaveLength(1);

    rows[0].status = 'approved';
    expect((await get(client)).body).toEqual([]);
    expect(client.calls).toHaveLength(2);
  });

  it('uses the clock on each request, so an event drops out when its window closes', async () => {
    const client = createFakeClient([eventRow()]);
    let clock = new Date('2026-10-19T23:59:59.999Z');

    const before = await get(client, { now: () => clock });
    clock = new Date('2026-10-20T00:00:00.000Z');
    const after = await get(client, { now: () => clock });

    expect(before.body).toHaveLength(1);
    expect(after.body).toEqual([]);
  });

  it('tells the browser not to store the list', async () => {
    const res = await get(createFakeClient([eventRow()]));

    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers a generic 500 without the driver message when the read fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = createFakeClient([], { error: { code: '42703', message: 'column registration_enabled does not exist' } });

    const res = await get(client);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Unexpected server error' });
    expect(JSON.stringify(res.body)).not.toContain('registration_enabled');
    spy.mockRestore();
  });
});
