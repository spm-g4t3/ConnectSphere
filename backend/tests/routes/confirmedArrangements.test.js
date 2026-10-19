import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createEventRequestRouter } from '../../src/routes/eventRequests.js';
import { getConfirmedArrangementsForOrganiser } from '../../src/services/eventRequestService.js';
import { ROLE } from '../../src/domain/userRole.js';

const ID = '22222222-2222-4222-8222-222222222222';
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const stored = (changes = {}) => ({
  id: ID, organiser_id: OWNER, status: 'confirmed', proposed_start: '2026-11-01T16:00:00Z', proposed_end: '2026-11-01T18:00:00Z',
  bookings: [
    { id: 'b1', status: 'approved', venues: { name: 'Hall A', location: 'Level 1' } },
    { id: 'b2', status: 'approved', venues: { name: 'Room 2', location: 'Level 2' } },
    ...['pending', 'conflicting', 'flagged_for_review', 'cancelled', 'rejected', 'withdrawn'].map((status) => ({ id: status, status, venues: { name: 'Unconfirmed venue', location: 'Elsewhere' } })),
  ],
  equipment_requests: [
    { id: 'r1', status: 'arranged', equipment_lines: [
      { id: 'l1', quantity: 3, removed_at: null, equipment_types: { name: 'Microphone' } },
      { id: 'removed', quantity: 99, removed_at: '2026-01-01T00:00:00Z', equipment_types: { name: 'Removed type' } },
    ] },
    { id: 'r2', status: 'arranged', equipment_lines: [{ id: 'l2', quantity: 2, removed_at: null, equipment_types: { name: 'Projector' } }] },
    ...['pending_review', 'under_review', 'cannot_be_fully_arranged', 'cancelled'].map((status) => ({ id: status, status, equipment_lines: [{ id: status, quantity: 100, removed_at: null, equipment_types: { name: 'Unarranged type' } }] })),
  ],
  ...changes,
});

function clientFor(row, error = null) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, filters: [] };
      calls.push(call);
      const query = {
        select(columns) { call.columns = columns; return query; },
        eq(column, value) { call.filters.push([column, value]); return query; },
        maybeSingle() {
          const matches = row && call.filters.every(([key, value]) => row[key] === value);
          return Promise.resolve({ data: matches ? row : null, error });
        },
      };
      return query;
    },
  };
}
function app(client, { id = OWNER, role = ROLE.EVENT_ORGANISER, signedIn = true } = {}) {
  return express().use('/api/event-requests', createEventRequestRouter({
    client,
    requireAuth: (req, res, next) => {
      if (!signedIn) return res.status(401).json({ error: 'Authentication required' });
      req.user = { id, role };
      next();
    },
  }));
}
const read = (client, auth) => request(app(client, auth)).get(`/api/event-requests/${ID}/confirmed-arrangements`);

describe('SCRUM-363: organiser confirmed arrangements', () => {
  it('SCRUM363_AC7_owner_reads_all_confirmed_venues_and_arranged_equipment_in_one_scoped_query', async () => {
    const client = clientFor(stored());
    const res = await read(client);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      eventRequestId: ID, status: 'confirmed', statusDisplay: { label: 'Confirmed' },
      startsAt: '2026-11-01T16:00:00Z', endsAt: '2026-11-01T18:00:00Z',
      venues: [{ bookingId: 'b1', name: 'Hall A', location: 'Level 1' }, { bookingId: 'b2', name: 'Room 2', location: 'Level 2' }],
      equipment: [{ lineId: 'l1', name: 'Microphone', quantity: 3 }, { lineId: 'l2', name: 'Projector', quantity: 2 }],
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].filters).toEqual([['id', ID], ['organiser_id', OWNER]]);
    expect(client.calls[0].columns).toContain('bookings(id, status, venues(name, location))');
    expect(client.calls[0].columns).toContain('equipment_lines(id, quantity, removed_at, equipment_types(name))');
    expect(res.text).not.toContain('Unconfirmed venue');
    expect(res.text).not.toContain('Unarranged type');
    expect(res.text).not.toContain('Removed type');
    expect(res.text).not.toContain('organiser_id');
  });

  it('SCRUM363_AC7_other_organisers_cannot_gain_access_by_supplying_an_event_id_or_owner_query', async () => {
    const client = clientFor(stored());
    const res = await request(app(client, { id: OTHER })).get(`/api/event-requests/${ID}/confirmed-arrangements?organiserId=${OWNER}`);
    expect(res.status).toBe(404);
    expect(client.calls[0].filters).toContainEqual(['organiser_id', OTHER]);
    expect(res.text).not.toContain('Hall A');
  });

  it.each(Object.values(ROLE).filter((role) => role !== ROLE.EVENT_ORGANISER))(
    'SCRUM363_AC7_role_%s_cannot_read_arrangements_even_using_the_owner_id', async (role) => {
      const client = clientFor(stored());
      expect((await read(client, { role })).status).toBe(403);
      expect(client.calls).toHaveLength(0);
    },
  );

  it('SCRUM363_AC7_signed_out_users_cannot_read_arrangements', async () => {
    const client = clientFor(stored());
    expect((await read(client, { signedIn: false })).status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });

  it.each([null, 'bad-id'])('SCRUM363_AC7_missing_or_invalid_event_%s_is_safe', async (id) => {
    const client = clientFor(null);
    const res = await request(app(client)).get(`/api/event-requests/${id ?? ID}/confirmed-arrangements`);
    expect(res.status).toBe(id === null ? 404 : 400);
  });

  it.each(['approved', 'safety_review', 'safety_approved', 'cancelled', 'completed'])(
    'SCRUM363_AC7_status_%s_does_not_expose_previous_arrangements_as_confirmed', async (status) => {
      const res = await read(clientFor(stored({ status })));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status, startsAt: null, endsAt: null, venues: [], equipment: [] });
      expect(res.text).not.toContain('Hall A');
    },
  );

  it('SCRUM363_AC7_no_equipment_is_an_empty_arranged_list_and_never_free_text_requirements', async () => {
    const res = await read(clientFor(stored({ equipment_requests: null, equipment_requirements: 'Original unarranged projectors' })));
    expect(res.body.equipment).toEqual([]);
    expect(res.text).not.toContain('Original unarranged projectors');
  });

  it('SCRUM363_AC7_reconfirmation_reads_new_dates_venues_and_quantities_without_a_cache', async () => {
    const row = stored();
    const client = clientFor(row);
    expect((await read(client)).body.equipment[0].quantity).toBe(3);
    row.status = 'approved';
    expect((await read(client)).body.venues).toEqual([]);
    row.status = 'confirmed';
    row.proposed_start = '2026-12-01T00:00:00Z';
    row.bookings[0].venues.location = 'New location';
    row.equipment_requests[0].equipment_lines[0].quantity = 5;
    const res = await read(client);
    expect(res.body.startsAt).toBe('2026-12-01T00:00:00Z');
    expect(res.body.venues[0].location).toBe('New location');
    expect(res.body.equipment[0].quantity).toBe(5);
  });

  it('SCRUM363_AC7_missing_embedded_data_is_explicit_and_does_not_crash', async () => {
    const row = stored({ bookings: [{ id: 'b1', status: 'approved', venues: null }], equipment_requests: [
      { status: 'arranged', equipment_lines: [{ id: 'l1', quantity: 1, removed_at: null, equipment_types: null }] },
      { status: 'arranged', equipment_lines: null },
    ] });
    const res = await read(clientFor(row));
    expect(res.body.venues).toEqual([{ bookingId: 'b1', name: null, location: null }]);
    expect(res.body.equipment).toEqual([{ lineId: 'l1', name: null, quantity: 1 }]);
    expect((await read(clientFor(stored({ bookings: null })))).body.venues).toEqual([]);
  });

  it('SCRUM363_AC7_service_also_refuses_a_missing_owner_and_a_mismatched_returned_owner', async () => {
    await expect(getConfirmedArrangementsForOrganiser(ID, null, { client: clientFor(stored()) })).rejects.toMatchObject({ status: 400 });
    const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: stored({ organiser_id: OTHER }), error: null }) };
    await expect(getConfirmedArrangementsForOrganiser(ID, OWNER, { client: { from: () => query } })).rejects.toMatchObject({ status: 404 });
  });

  it('SCRUM363_AC7_database_errors_do_not_leak_details_or_return_empty_success', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await read(clientFor(null, { code: 'XX000', message: 'Private database detail' }));
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Unexpected server error' });
    } finally { log.mockRestore(); }
  });
});
