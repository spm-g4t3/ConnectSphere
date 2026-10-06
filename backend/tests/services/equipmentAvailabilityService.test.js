/**
 * Tests for the equipment availability service wrapper. SCRUM-23.
 *
 * The Supabase client is mocked with a factory, as in equipmentService.test.js.
 * What these cannot show is whether the SQL function counts reservations
 * correctly: that is pinned by tests/db/equipmentAvailabilityMigration.test.js
 * (the text) and proved against the real database by
 * npm run equipment-availability:check.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('../../src/config/supabaseClient.js', () => {
  const client = { rpc };
  return { supabase: client, default: client };
});

const { checkEquipmentAvailability, toAvailabilityResult } = await import('../../src/services/equipmentAvailabilityService.js');
const { supabase } = await import('../../src/config/supabaseClient.js');
const { ValidationError } = await import('../../src/errors.js');

const TYPE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const EVENT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const input = (overrides = {}) => ({
  equipmentTypeId: TYPE_ID,
  quantity: 4,
  startAt: '2026-12-01T10:00:00Z',
  endAt: '2026-12-01T12:00:00Z',
  ...overrides,
});

const answer = (overrides = {}) => ({
  found: true,
  retired: false,
  total: 10,
  damaged: 1,
  under_maintenance: 1,
  reserved: 2,
  available: 6,
  reservations: [],
  ...overrides,
});

const ok = (data) => ({ data, error: null });

beforeEach(() => {
  rpc.mockReset();
});

describe('the test double', () => {
  it('SCRUM23_the_supabase_client_is_mocked_and_never_the_real_one', () => {
    expect(vi.isMockFunction(supabase.rpc)).toBe(true);
  });
});

describe('calling the function', () => {
  it('SCRUM23_AC3_asks_the_one_database_function_with_the_period', async () => {
    rpc.mockResolvedValue(ok(answer()));

    await checkEquipmentAvailability(input());

    expect(rpc).toHaveBeenCalledWith('equipment_availability', {
      p_equipment_type_id: TYPE_ID,
      p_start_at: '2026-12-01T10:00:00Z',
      p_end_at: '2026-12-01T12:00:00Z',
      p_event_request_id: null,
    });
  });

  it('SCRUM23_AC7_passes_the_event_so_its_own_reservations_are_left_out', async () => {
    rpc.mockResolvedValue(ok(answer()));

    await checkEquipmentAvailability(input({ eventRequestId: EVENT_ID }));

    expect(rpc.mock.calls[0][1].p_event_request_id).toBe(EVENT_ID);
  });

  it('SCRUM23_AC2_refuses_an_invalid_request_before_any_query', async () => {
    await expect(checkEquipmentAvailability(input({ quantity: 0 }))).rejects.toBeInstanceOf(ValidationError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM23_AC2_translates_the_function_refusing_a_period', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'The period must end after it starts' } });

    await expect(checkEquipmentAvailability(input())).rejects.toBeInstanceOf(ValidationError);
  });

  it('SCRUM23_surfaces_any_other_database_error_untyped', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'timeout' } });

    const attempt = checkEquipmentAvailability(input());

    await expect(attempt).rejects.toThrow('timeout');
    await expect(attempt).rejects.not.toBeInstanceOf(ValidationError);
  });
});

describe('AC8: the three results', () => {
  it.each([
    ['more than enough', 6, 4, 'Fully available', 6],
    ['exactly enough', 4, 4, 'Fully available', 4],
    ['some but not enough', 3, 4, 'Partially available', 3],
    ['none', 0, 4, 'Unavailable', 0],
  ])('SCRUM23_AC8_%s', async (_label, available, quantity, result, shown) => {
    rpc.mockResolvedValue(ok(answer({ available })));

    const checked = await checkEquipmentAvailability(input({ quantity }));

    expect(checked).toMatchObject({ result, quantityRequested: quantity, quantityAvailable: shown });
  });

  it('SCRUM23_AC8_never_shows_a_quantity_below_zero_and_says_Unavailable', async () => {
    rpc.mockResolvedValue(ok(answer({ available: -3 })));

    const checked = await checkEquipmentAvailability(input());

    expect(checked.result).toBe('Unavailable');
    expect(checked.quantityAvailable).toBe(0);
    expect(checked.breakdown.available).toBe(0);
  });

  it('SCRUM23_AC8_a_partial_result_shows_the_quantity_available', async () => {
    rpc.mockResolvedValue(ok(answer({ available: 2 })));

    const checked = await checkEquipmentAvailability(input({ quantity: 5 }));

    expect(checked.result).toBe('Partially available');
    expect(checked.quantityAvailable).toBe(2);
  });
});

describe('AC9: how the figure was reached', () => {
  it('SCRUM23_AC9_returns_total_damaged_or_maintenance_reserved_and_available', async () => {
    rpc.mockResolvedValue(ok(answer({ total: 10, damaged: 1, under_maintenance: 1, reserved: 3, available: 5 })));

    const { breakdown } = await checkEquipmentAvailability(input());

    expect(breakdown).toEqual({
      total: 10,
      damaged: 1,
      underMaintenance: 1,
      damagedOrUnderMaintenance: 2,
      reserved: 3,
      available: 5,
    });
  });
});

describe('AC10: the overlapping reservations', () => {
  it('SCRUM23_AC10_lists_each_with_event_name_period_and_quantity', async () => {
    rpc.mockResolvedValue(
      ok(answer({
        reservations: [
          { id: 'r1', event_request_id: 'e1', event_name: 'Graduation', quantity: 2, start_at: '2026-12-01T09:00:00+00:00', end_at: '2026-12-01T11:00:00+00:00', flagged: false },
          { id: 'r2', event_request_id: 'e2', event_name: 'AGM', quantity: 1, start_at: '2026-12-01T11:00:00+00:00', end_at: '2026-12-01T13:00:00+00:00', flagged: true },
        ],
      })),
    );

    const { reservations } = await checkEquipmentAvailability(input());

    expect(reservations).toEqual([
      { id: 'r1', eventRequestId: 'e1', eventName: 'Graduation', quantity: 2, startAt: '2026-12-01T09:00:00+00:00', endAt: '2026-12-01T11:00:00+00:00', flagged: false },
      { id: 'r2', eventRequestId: 'e2', eventName: 'AGM', quantity: 1, startAt: '2026-12-01T11:00:00+00:00', endAt: '2026-12-01T13:00:00+00:00', flagged: true },
    ]);
  });

  it('SCRUM23_AC10_answers_an_empty_list_when_nothing_overlaps', async () => {
    rpc.mockResolvedValue(ok(answer({ reservations: undefined })));

    expect((await checkEquipmentAvailability(input())).reservations).toEqual([]);
  });
});

describe('AC11: an unknown or retired type', () => {
  it('SCRUM23_AC11_an_unknown_type_is_Unavailable_with_a_message_and_no_error', async () => {
    rpc.mockResolvedValue(ok({ found: false, retired: false }));

    const checked = await checkEquipmentAvailability(input());

    expect(checked).toEqual({
      result: 'Unavailable',
      quantityRequested: 4,
      quantityAvailable: 0,
      message: 'The equipment type was not found.',
      breakdown: null,
      reservations: [],
    });
  });

  it('SCRUM23_AC11_a_retired_type_is_Unavailable_and_says_it_is_retired', async () => {
    rpc.mockResolvedValue(ok({ found: true, retired: true }));

    const checked = await checkEquipmentAvailability(input());

    expect(checked.result).toBe('Unavailable');
    expect(checked.message).toBe('The equipment type is retired.');
    expect(checked.breakdown).toBeNull();
  });

  it('SCRUM23_AC11_treats_an_empty_answer_as_not_found', () => {
    expect(toAvailabilityResult(null, { quantity: 2 }).message).toBe('The equipment type was not found.');
  });
});

describe('AC12: a check changes nothing', () => {
  it('SCRUM23_AC12_only_ever_calls_the_read_only_function', async () => {
    rpc.mockResolvedValue(ok(answer()));

    await checkEquipmentAvailability(input());

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe('equipment_availability');
    expect(supabase.from).toBeUndefined();
  });
});
