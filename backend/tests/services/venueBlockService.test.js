/**
 * Tests for the venue block service.
 *
 * SCRUM-126 (part of SCRUM-17). AC1: "a block is created with venue,
 * start/end datetime, reason category".
 *
 * The Supabase client is replaced wholesale, exactly as venueService.test.js
 * does it: vi.mock's factory is hoisted above the imports, so the real module
 * (which throws without credentials, and would reach the live database with
 * them) never evaluates. Nothing here touches the network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { supabase } from '../../src/config/supabaseClient.js';
import {
  createVenueBlock,
  listVenueBlocks,
  getVenueBlock,
  toBlock,
  toBookingConflict,
} from '../../src/services/venueBlockService.js';
import { ValidationError, NotFoundError, ConflictError } from '../../src/errors.js';

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));

vi.mock('../../src/config/supabaseClient.js', () => {
  const client = { rpc, from };
  return { supabase: client, default: client };
});


const VENUE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const BLOCK_ID = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const OTHER_BLOCK_ID = '6ba7b811-9dad-41d1-80b4-00c04fd430c8';
const STAFF_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const NOW = new Date('2026-09-23T00:00:00Z');

const COLUMNS =
  'id, venue_id, starts_at, ends_at, reason, notes, created_by, last_modified_by, ' +
  'created_at, updated_at, removed_at, removed_by';

async function errorFromAsync(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

function validInput(overrides = {}) {
  return {
    startsAt: '2026-10-01T09:00:00+08:00',
    endsAt: '2026-10-01T17:00:00+08:00',
    reason: 'maintenance',
    ...overrides,
  };
}

function blockRow(overrides = {}) {
  return {
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
  };
}

const CAMEL_BLOCK = {
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

/**
 * A stand-in for a supabase-js query builder, copied from venueService.test.js.
 * `calls` is exposed too, so a test can assert the order of a chain.
 */
function queryStub(result) {
  const calls = [];

  const stub = {
    calls,
    called: (method) => calls.some(([name]) => name === method),
    args: (method) => calls.find(([name]) => name === method)?.slice(1),
    allArgs: (method) => calls.filter(([name]) => name === method).map((c) => c.slice(1)),
    then: (onFulfilled, onRejected) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  };

  for (const method of ['select', 'eq', 'is', 'ilike', 'gte', 'order', 'limit', 'delete']) {
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

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
});


describe('the test double', () => {
  it('has replaced the real Supabase client', () => {
    expect(vi.isMockFunction(supabase.rpc)).toBe(true);
    expect(vi.isMockFunction(supabase.from)).toBe(true);
  });
});


describe('SCRUM17_AC1 createVenueBlock', () => {
  it('SCRUM17_AC1_create_calls_the_rpc_with_normalised_params_and_the_acting_user', async () => {
    rpc.mockResolvedValue({ data: { outcome: 'created', block: blockRow() }, error: null });

    await createVenueBlock(
      VENUE_ID,
      validInput({ startsAt: ' 2026-10-01T09:00:00+08:00 ', notes: '  Deep clean  ' }),
      STAFF_ID,
      { now: NOW },
    );

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('create_venue_block', {
      p_venue_id: VENUE_ID,
      p_starts_at: '2026-10-01T09:00:00+08:00',
      p_ends_at: '2026-10-01T17:00:00+08:00',
      p_reason: 'maintenance',
      p_notes: 'Deep clean',
      p_user_id: STAFF_ID,
      p_confirm_override: false,
      p_acknowledged_booking_ids: [],
    });
  });

  it('sends null notes and a null user when neither is given', async () => {
    rpc.mockResolvedValue({ data: { outcome: 'created', block: blockRow() }, error: null });

    await createVenueBlock(VENUE_ID, validInput(), undefined, { now: NOW });

    expect(rpc.mock.calls[0][1]).toMatchObject({ p_notes: null, p_user_id: null });
  });

  it('SCRUM17_AC1_create_returns_a_camelCase_block', async () => {
    rpc.mockResolvedValue({ data: { outcome: 'created', block: blockRow() }, error: null });

    await expect(createVenueBlock(VENUE_ID, validInput(), STAFF_ID, { now: NOW })).resolves.toEqual({
      block: CAMEL_BLOCK,
      flaggedBookings: [],
    });
  });

  it('SCRUM17_AC1_invalid_input_makes_no_rpc_call', async () => {
    const err = await errorFromAsync(() =>
      createVenueBlock(VENUE_ID, validInput({ reason: 'holiday' }), STAFF_ID, { now: NOW }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([
      {
        field: 'reason',
        message: 'must be one of: maintenance, renovation, safety, internal_activity, other',
      },
    ]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('uses the injected now for the future-end rule', async () => {
    const err = await errorFromAsync(() =>
      createVenueBlock(VENUE_ID, validInput(), STAFF_ID, { now: new Date('2026-12-01T00:00:00Z') }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'endsAt', message: 'must be in the future' }]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a malformed venue id makes no rpc call', async () => {
    const err = await errorFromAsync(() =>
      createVenueBlock('not-a-venue', validInput(), STAFF_ID, { now: NOW }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'id', message: 'must be a venue id' }]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown outcome', { outcome: 'needs_confirmation', block: null }],
    ['no outcome', { block: blockRow() }],
    ['no data at all', null],
  ])('an unexpected result (%s) throws a plain Error', async (_label, data) => {
    rpc.mockResolvedValue({ data, error: null });

    const err = await errorFromAsync(() =>
      createVenueBlock(VENUE_ID, validInput(), STAFF_ID, { now: NOW }),
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err).not.toBeInstanceOf(NotFoundError);
    expect(err).not.toBeInstanceOf(ConflictError);
    expect(err.message).toMatch(/Unexpected outcome from create_venue_block/);
  });
});


describe('database errors become typed errors', () => {
  async function createFailingWith(error) {
    rpc.mockResolvedValue({ data: null, error });
    return errorFromAsync(() => createVenueBlock(VENUE_ID, validInput(), STAFF_ID, { now: NOW }));
  }

  it('P0002 (no such venue) becomes a 404', async () => {
    const err = await createFailingWith({
      code: 'P0002',
      message: `venue ${VENUE_ID} not found`,
    });

    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
    expect(err.message).toBe(`venue ${VENUE_ID} not found`);
  });

  it('SCRUM17_AC1_PT409_VENUE_RETIRED_becomes_a_conflict_with_that_code', async () => {
    const err = await createFailingWith({
      code: 'PT409',
      message: `venue ${VENUE_ID} is retired and cannot be blocked`,
      hint: 'VENUE_RETIRED',
      details: null,
    });

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('VENUE_RETIRED');
    expect(err.message).toBe(`venue ${VENUE_ID} is retired and cannot be blocked`);
  });

  it('SCRUM17_AC1_PT409_BLOCK_OVERLAPS_BLOCK_becomes_a_conflict_with_that_code', async () => {
    const err = await createFailingWith({
      code: 'PT409',
      message: `this period overlaps another block on venue ${VENUE_ID}`,
      hint: 'BLOCK_OVERLAPS_BLOCK',
      details: OTHER_BLOCK_ID,
    });

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('BLOCK_OVERLAPS_BLOCK');
  });

  it('23P01 (the exclusion constraint) becomes a conflict with BLOCK_OVERLAPS_BLOCK', async () => {
    const err = await createFailingWith({
      code: '23P01',
      message: 'conflicting key value violates exclusion constraint "venue_blocks_no_overlap"',
    });

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('BLOCK_OVERLAPS_BLOCK');
  });

  it.each(['22023', '23514', '23502', '22P02', '22007', '22008'])(
    '%s becomes a validation error',
    async (code) => {
      const err = await createFailingWith({ code, message: 'a block must end after it starts' });

      expect(err).toBeInstanceOf(ValidationError);
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/a block must end after it starts/);
    },
  );

  it('23503 on a *_by column says the editing user does not exist', async () => {
    const err = await createFailingWith({
      code: '23503',
      message:
        'insert or update on table "venue_blocks" violates foreign key constraint "venue_blocks_created_by_fkey"',
      details: `Key (created_by)=(${STAFF_ID}) is not present in table "users".`,
    });

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/^The editing user does not exist: /);
  });

  it('23503 on another column is still a validation error', async () => {
    const err = await createFailingWith({
      code: '23503',
      message: 'violates foreign key constraint "venue_blocks_venue_id_fkey"',
      details: 'Key (venue_id) is not present in table "venues".',
    });

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).not.toMatch(/editing user/);
  });

  it('an unknown code becomes a plain Error, even when the message says "not found"', async () => {
    const err = await createFailingWith({ code: '42P01', message: 'relation not found' });

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err).not.toBeInstanceOf(NotFoundError);
    expect(err).not.toBeInstanceOf(ConflictError);
    expect(err.message).toBe('relation not found');
  });
});


describe('SCRUM17_AC3 booking conflicts and the override', () => {
  const BOOKING_A = 'a1b2c3d4-0000-4000-8000-000000000001';
  const BOOKING_B = 'a1b2c3d4-0000-4000-8000-000000000002';
  const EVENT_A = 'e1b2c3d4-0000-4000-8000-000000000001';
  const EVENT_B = 'e1b2c3d4-0000-4000-8000-000000000002';

  const conflictRows = [
    {
      booking_id: BOOKING_A,
      event_request_id: EVENT_A,
      event_name: 'Tech Talk',
      starts_at: '2026-10-01T02:00:00+00:00',
      ends_at: '2026-10-01T04:00:00+00:00',
    },
    {
      booking_id: BOOKING_B,
      event_request_id: EVENT_B,
      event_name: 'Career Fair',
      starts_at: '2026-10-01T05:00:00+00:00',
      ends_at: '2026-10-01T08:00:00+00:00',
    },
  ];

  const camelConflicts = [
    {
      bookingId: BOOKING_A,
      eventRequestId: EVENT_A,
      eventName: 'Tech Talk',
      startsAt: '2026-10-01T02:00:00+00:00',
      endsAt: '2026-10-01T04:00:00+00:00',
    },
    {
      bookingId: BOOKING_B,
      eventRequestId: EVENT_B,
      eventName: 'Career Fair',
      startsAt: '2026-10-01T05:00:00+00:00',
      endsAt: '2026-10-01T08:00:00+00:00',
    },
  ];

  const override = (ids = [BOOKING_A, BOOKING_B]) =>
    validInput({ confirmOverride: true, acknowledgedBookingIds: ids });

  it('SCRUM17_AC3_create_passes_override_and_acknowledged_ids_to_rpc', async () => {
    rpc.mockResolvedValue({ data: { outcome: 'created', block: blockRow() }, error: null });

    await createVenueBlock(
      VENUE_ID,
      override([BOOKING_A.toUpperCase(), BOOKING_B, BOOKING_A]),
      STAFF_ID,
      { now: NOW },
    );

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('create_venue_block', {
      p_venue_id: VENUE_ID,
      p_starts_at: '2026-10-01T09:00:00+08:00',
      p_ends_at: '2026-10-01T17:00:00+08:00',
      p_reason: 'maintenance',
      p_notes: null,
      p_user_id: STAFF_ID,
      p_confirm_override: true,
      p_acknowledged_booking_ids: [BOOKING_A, BOOKING_B],
    });
  });

  it('SCRUM17_AC3_conflict_outcome_throws_BLOCK_BOOKING_CONFLICT_with_camelCase_conflicts', async () => {
    rpc.mockResolvedValue({
      data: { outcome: 'conflict', conflicts: conflictRows },
      error: null,
    });

    const err = await errorFromAsync(() =>
      createVenueBlock(VENUE_ID, validInput(), STAFF_ID, { now: NOW }),
    );

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('BLOCK_BOOKING_CONFLICT');
    expect(err.message).toBe('This period overlaps approved bookings');
    expect(err.conflicts).toEqual(camelConflicts);
  });

  it('a conflict outcome with no list gives an empty conflicts list', async () => {
    rpc.mockResolvedValue({ data: { outcome: 'conflict' }, error: null });

    const err = await errorFromAsync(() =>
      createVenueBlock(VENUE_ID, validInput(), STAFF_ID, { now: NOW }),
    );

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('BLOCK_BOOKING_CONFLICT');
    expect(err.conflicts).toEqual([]);
  });

  it('SCRUM17_AC3_stale_override_conflict_says_bookings_changed', async () => {
    rpc.mockResolvedValue({
      data: { outcome: 'conflict', conflicts: conflictRows },
      error: null,
    });

    const err = await errorFromAsync(() =>
      createVenueBlock(VENUE_ID, override([BOOKING_A]), STAFF_ID, { now: NOW }),
    );

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('BLOCK_BOOKING_CONFLICT');
    expect(err.message).toBe(
      'The overlapping bookings have changed since you confirmed; review them again',
    );
    expect(err.conflicts).toEqual(camelConflicts);
  });

  it('SCRUM17_AC3_created_returns_block_and_flagged_bookings', async () => {
    rpc.mockResolvedValue({
      data: { outcome: 'created', block: blockRow(), affected_bookings: conflictRows },
      error: null,
    });

    await expect(
      createVenueBlock(VENUE_ID, override(), STAFF_ID, { now: NOW }),
    ).resolves.toEqual({ block: CAMEL_BLOCK, flaggedBookings: camelConflicts });
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', []],
  ])(
    'SCRUM17_AC3_created_without_affected_bookings_returns_empty_list (%s)',
    async (_label, affected) => {
      const data = { outcome: 'created', block: blockRow() };
      if (affected !== undefined) data.affected_bookings = affected;
      rpc.mockResolvedValue({ data, error: null });

      await expect(
        createVenueBlock(VENUE_ID, validInput(), STAFF_ID, { now: NOW }),
      ).resolves.toEqual({ block: CAMEL_BLOCK, flaggedBookings: [] });
    },
  );

  it.each([
    [
      'a non-boolean confirmOverride',
      { confirmOverride: 'true' },
      [{ field: 'confirmOverride', message: 'must be true or false' }],
    ],
    [
      'an override with no ids',
      { confirmOverride: true },
      [{ field: 'acknowledgedBookingIds', message: 'must list the bookings being overridden' }],
    ],
    [
      'ids with no override',
      { acknowledgedBookingIds: [BOOKING_A] },
      [{ field: 'acknowledgedBookingIds', message: 'can only be sent with confirmOverride' }],
    ],
    [
      'a non-uuid id',
      { confirmOverride: true, acknowledgedBookingIds: ['nope'] },
      [{ field: 'acknowledgedBookingIds', message: 'must contain only booking ids' }],
    ],
  ])('SCRUM17_AC3_invalid_override_input_makes_no_rpc_call (%s)', async (_label, extra, details) => {
    const err = await errorFromAsync(() =>
      createVenueBlock(VENUE_ID, validInput(extra), STAFF_ID, { now: NOW }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(err.details).toEqual(details);
    expect(rpc).not.toHaveBeenCalled();
  });
});


describe('SCRUM17_AC1 BLOCK_OVERLAPS_BLOCK names the clashing block', () => {
  async function overlapWithDetails(details) {
    rpc.mockResolvedValue({
      data: null,
      error: {
        code: 'PT409',
        message: `this period overlaps another block on venue ${VENUE_ID}`,
        hint: 'BLOCK_OVERLAPS_BLOCK',
        details,
      },
    });
    return errorFromAsync(() => createVenueBlock(VENUE_ID, validInput(), STAFF_ID, { now: NOW }));
  }

  it('SCRUM17_AC1_BLOCK_OVERLAPS_BLOCK_conflicts_carry_the_block_id', async () => {
    const err = await overlapWithDetails(OTHER_BLOCK_ID);

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('BLOCK_OVERLAPS_BLOCK');
    expect(err.message).toBe(`this period overlaps another block on venue ${VENUE_ID}`);
    expect(err.conflicts).toEqual([{ blockId: OTHER_BLOCK_ID }]);
  });

  it('trims the id and accepts it in upper case', async () => {
    const upper = OTHER_BLOCK_ID.toUpperCase();
    const err = await overlapWithDetails(`  ${upper}\n`);
    expect(err.conflicts).toEqual([{ blockId: upper }]);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['not a uuid', 'Key (venue_id) overlaps'],
    ['a uuid inside prose', `block ${OTHER_BLOCK_ID} overlaps`],
    ['not a string', 42],
  ])('gives [] when details are %s', async (_label, details) => {
    const err = await overlapWithDetails(details);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('BLOCK_OVERLAPS_BLOCK');
    expect(err.conflicts).toEqual([]);
  });

  it('VENUE_RETIRED carries no conflicts even when details hold a uuid', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: {
        code: 'PT409',
        message: 'venue is retired',
        hint: 'VENUE_RETIRED',
        details: OTHER_BLOCK_ID,
      },
    });
    const err = await errorFromAsync(() =>
      createVenueBlock(VENUE_ID, validInput(), STAFF_ID, { now: NOW }),
    );
    expect(err.code).toBe('VENUE_RETIRED');
    expect(err.conflicts).toEqual([]);
  });
});


describe('toBookingConflict', () => {
  it('maps every column to camelCase', () => {
    expect(
      toBookingConflict({
        booking_id: 'b',
        event_request_id: 'e',
        event_name: 'Name',
        starts_at: '2026-10-01T02:00:00+00:00',
        ends_at: '2026-10-01T04:00:00+00:00',
      }),
    ).toEqual({
      bookingId: 'b',
      eventRequestId: 'e',
      eventName: 'Name',
      startsAt: '2026-10-01T02:00:00+00:00',
      endsAt: '2026-10-01T04:00:00+00:00',
    });
  });
});


describe('listVenueBlocks', () => {
  it('SCRUM17_AC1_list_filters_active_blocks_ordered_by_start_then_id', async () => {
    const stub = queryStub({ data: [blockRow()], error: null });
    from.mockReturnValue(stub);

    await expect(listVenueBlocks(VENUE_ID)).resolves.toEqual([CAMEL_BLOCK]);

    expect(from).toHaveBeenCalledWith('venue_blocks');
    expect(stub.args('select')).toEqual([COLUMNS]);
    expect(stub.args('eq')).toEqual(['venue_id', VENUE_ID]);
    expect(stub.args('is')).toEqual(['removed_at', null]);
    expect(stub.allArgs('order').map(([column]) => column)).toEqual(['starts_at', 'id']);
    // starts_at is ordered before the id tie-break.
    const orderCalls = stub.calls.filter(([name]) => name === 'order');
    expect(orderCalls[0][1]).toBe('starts_at');
  });

  it('keeps a starts_at order that is ascending', async () => {
    const stub = queryStub({ data: [], error: null });
    from.mockReturnValue(stub);

    await listVenueBlocks(VENUE_ID);

    for (const [, options] of stub.allArgs('order')) {
      expect(options?.ascending ?? true).toBe(true);
    }
  });

  it.each([
    ['an empty list', []],
    ['a null body', null],
  ])('answers [] for %s', async (_label, data) => {
    from.mockReturnValue(queryStub({ data, error: null }));
    await expect(listVenueBlocks(VENUE_ID)).resolves.toEqual([]);
  });

  it('refuses a malformed venue id before any query', async () => {
    const err = await errorFromAsync(() => listVenueBlocks('nope'));
    expect(err).toBeInstanceOf(ValidationError);
    expect(from).not.toHaveBeenCalled();
  });

  it('translates a query error', async () => {
    from.mockReturnValue(queryStub({ data: null, error: { code: '22P02', message: 'bad uuid' } }));
    await expect(listVenueBlocks(VENUE_ID)).rejects.toBeInstanceOf(ValidationError);
  });
});


describe('getVenueBlock', () => {
  it('SCRUM17_AC1_get_is_scoped_by_venue_and_block', async () => {
    const stub = queryStub({ data: blockRow(), error: null });
    from.mockReturnValue(stub);

    await expect(getVenueBlock(VENUE_ID, BLOCK_ID)).resolves.toEqual(CAMEL_BLOCK);

    expect(from).toHaveBeenCalledWith('venue_blocks');
    expect(stub.args('select')).toEqual([COLUMNS]);
    expect(stub.allArgs('eq')).toEqual([
      ['venue_id', VENUE_ID],
      ['id', BLOCK_ID],
    ]);
    expect(stub.called('maybeSingle')).toBe(true);
  });

  it('a missing block is a 404', async () => {
    from.mockReturnValue(queryStub({ data: null, error: null }));

    const err = await errorFromAsync(() => getVenueBlock(VENUE_ID, BLOCK_ID));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
  });

  it('refuses a malformed block id before any query', async () => {
    const err = await errorFromAsync(() => getVenueBlock(VENUE_ID, 'nope'));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual([{ field: 'blockId', message: 'must be a block id' }]);
    expect(from).not.toHaveBeenCalled();
  });

  it('refuses a malformed venue id before any query', async () => {
    const err = await errorFromAsync(() => getVenueBlock('nope', BLOCK_ID));
    expect(err).toBeInstanceOf(ValidationError);
    expect(from).not.toHaveBeenCalled();
  });
});


describe('toBlock', () => {
  it('maps every column to camelCase', () => {
    expect(
      toBlock(blockRow({ notes: 'n', removed_at: '2026-10-02T00:00:00+00:00', removed_by: STAFF_ID })),
    ).toEqual({
      ...CAMEL_BLOCK,
      notes: 'n',
      removedAt: '2026-10-02T00:00:00+00:00',
      removedBy: STAFF_ID,
    });
  });
});
