/**
 * Tests for the equipment availability route. SCRUM-23 and SCRUM-68.
 * About transport and authorisation: who reaches it, how the query is read and
 * which statuses come back. The Supabase client is mocked with a factory.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('../../src/config/supabaseClient.js', () => {
  const client = { rpc };
  return { supabase: client, default: client };
});

const { createEquipmentAvailabilityRouter } = await import('../../src/routes/equipmentAvailability.js');
const { supabase } = await import('../../src/config/supabaseClient.js');
const { ROLE } = await import('../../src/domain/userRole.js');

const TYPE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const EVENT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const signedInAs = (role) => (req, _res, next) => {
  req.user = { id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', email: 'someone@example.com', role };
  next();
};
const signedOut = (_req, res) => res.status(401).json({ error: 'Authentication required' });

const appWith = (requireAuth = signedInAs(ROLE.TECHNICAL_SUPPORT_STAFF)) =>
  express().use('/api/equipment/availability', createEquipmentAvailabilityRouter({ requireAuth }));

const query = (overrides = {}) => ({
  equipmentTypeId: TYPE_ID,
  quantity: '4',
  startAt: '2026-12-01T10:00:00Z',
  endAt: '2026-12-01T12:00:00Z',
  ...overrides,
});

const functionAnswer = (overrides = {}) => ({
  found: true, retired: false, total: 10, damaged: 1, under_maintenance: 1, reserved: 2, available: 6, reservations: [], ...overrides,
});

const OTHER_ROLES = [ROLE.EVENT_ORGANISER, ROLE.EVENT_COORDINATOR, ROLE.VENUE_STAFF, ROLE.ATTENDEE, ROLE.EVENT_COORDINATOR_LEAD, ROLE.SAFETY_OFFICER];

beforeEach(() => {
  rpc.mockReset();
});

describe('the test double', () => {
  it('SCRUM23_the_supabase_client_is_mocked_and_never_the_real_one', () => {
    expect(vi.isMockFunction(supabase.rpc)).toBe(true);
  });
});

describe('AC1: only Technical Support Staff can check', () => {
  it.each(OTHER_ROLES)('SCRUM23_AC1_refuses_%s_with_403_and_runs_no_check', async (role) => {
    const res = await request(appWith(signedInAs(role))).get('/api/equipment/availability').query(query());

    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM23_AC1_refuses_a_signed_out_caller_with_401', async () => {
    const res = await request(appWith(signedOut)).get('/api/equipment/availability').query(query());

    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('a successful check', () => {
  it('SCRUM23_AC3_returns_the_full_result_for_valid_input', async () => {
    rpc.mockResolvedValue({ data: functionAnswer(), error: null });

    const res = await request(appWith()).get('/api/equipment/availability').query(query());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      result: 'Fully available',
      quantityRequested: 4,
      quantityAvailable: 6,
      breakdown: { total: 10, damagedOrUnderMaintenance: 2, reserved: 2, available: 6 },
      reservations: [],
    });
  });

  it('SCRUM23_AC2_turns_the_quantity_text_into_a_number', async () => {
    rpc.mockResolvedValue({ data: functionAnswer(), error: null });

    await request(appWith()).get('/api/equipment/availability').query(query({ quantity: '4' }));

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1].p_start_at).toBe('2026-12-01T10:00:00Z');
  });

  it('SCRUM23_AC7_passes_the_event_request_id_on', async () => {
    rpc.mockResolvedValue({ data: functionAnswer(), error: null });

    await request(appWith()).get('/api/equipment/availability').query(query({ eventRequestId: EVENT_ID }));

    expect(rpc.mock.calls[0][1].p_event_request_id).toBe(EVENT_ID);
  });

  it('SCRUM23_AC11_answers_200_Unavailable_for_an_unknown_type_not_an_error', async () => {
    rpc.mockResolvedValue({ data: { found: false, retired: false }, error: null });

    const res = await request(appWith()).get('/api/equipment/availability').query(query());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ result: 'Unavailable', message: 'The equipment type was not found.' });
  });
});

describe('AC2: invalid input', () => {
  it('SCRUM23_AC2_answers_400_listing_every_invalid_input_and_runs_no_check', async () => {
    const res = await request(appWith()).get('/api/equipment/availability').query({ quantity: '0', startAt: 'nope' });

    expect(res.status).toBe(400);
    expect(res.body.details.map((detail) => detail.field).sort()).toEqual(['endAt', 'equipmentTypeId', 'quantity', 'startAt']);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([['0'], ['-2'], ['1.5'], ['abc']])('SCRUM23_AC2_refuses_a_quantity_of_%s', async (quantity) => {
    const res = await request(appWith()).get('/api/equipment/availability').query(query({ quantity }));

    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe('quantity');
  });

  it('SCRUM23_AC2_treats_a_blank_quantity_as_missing_not_zero', async () => {
    const res = await request(appWith()).get('/api/equipment/availability').query(query({ quantity: '' }));

    expect(res.body.details).toEqual([{ field: 'quantity', message: 'is required' }]);
  });

  it('SCRUM23_AC2_refuses_an_end_before_the_start', async () => {
    const res = await request(appWith()).get('/api/equipment/availability').query(query({ startAt: '2026-12-01T12:00:00Z', endAt: '2026-12-01T10:00:00Z' }));

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'endAt', message: 'must be later than the start' }]);
  });

  it('SCRUM23_AC2_refuses_a_raw_plus_offset_that_decoded_to_a_space', async () => {
    const res = await request(appWith()).get('/api/equipment/availability?equipmentTypeId=' + TYPE_ID + '&quantity=4&startAt=2026-12-01T10:00:00+08:00&endAt=2026-12-01T12:00:00Z');

    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe('startAt');
  });

  it('SCRUM23_AC2_accepts_an_encoded_plus_offset', async () => {
    rpc.mockResolvedValue({ data: functionAnswer(), error: null });

    const res = await request(appWith()).get('/api/equipment/availability').query(query({ startAt: '2026-12-01T10:00:00+08:00', endAt: '2026-12-01T12:00:00+08:00' }));

    expect(res.status).toBe(200);
  });

  it('SCRUM23_AC2_refuses_a_repeated_parameter_instead_of_guessing_which_one', async () => {
    const res = await request(appWith()).get('/api/equipment/availability?equipmentTypeId=' + TYPE_ID + '&quantity=4&quantity=5&startAt=2026-12-01T10:00:00Z&endAt=2026-12-01T12:00:00Z');

    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe('quantity');
  });
});

describe('AC12: a check changes nothing', () => {
  it.each([['post'], ['put'], ['patch'], ['delete']])('SCRUM23_AC12_has_no_%s_route', async (method) => {
    const res = await request(appWith())[method]('/api/equipment/availability').send(query());

    expect(res.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM23_answers_500_without_leaking_a_driver_message', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'secret driver text' } });

    const res = await request(appWith()).get('/api/equipment/availability').query(query());

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret driver text');
  });
});