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
// SCRUM-127: a separate import so the existing one is left as it was.
import { updateVenueBlock, removeVenueBlock } from '../../src/services/venueBlockService.js';

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

  for (const method of ['select', 'eq', 'is', 'ilike', 'gte', 'order', 'limit', 'delete', 'lt', 'gt', 'lte', 'not']) {
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
      data: {
        outcome: 'created',
        block: blockRow(),
        affected_bookings: conflictRows,
        flagged_bookings: conflictRows,
      },
      error: null,
    });

    await expect(
      createVenueBlock(VENUE_ID, override(), STAFF_ID, { now: NOW }),
    ).resolves.toEqual({ block: CAMEL_BLOCK, flaggedBookings: camelConflicts });
  });

  it('SCRUM17_AC3_flagged_bookings_come_from_flagged_bookings_not_affected_bookings', async () => {
    // affected_bookings is what was acknowledged; flagged_bookings is what the
    // database changed. Only the second is reported.
    rpc.mockResolvedValue({
      data: {
        outcome: 'created',
        block: blockRow(),
        affected_bookings: conflictRows,
        flagged_bookings: [conflictRows[1]],
      },
      error: null,
    });

    await expect(
      createVenueBlock(VENUE_ID, override(), STAFF_ID, { now: NOW }),
    ).resolves.toEqual({ block: CAMEL_BLOCK, flaggedBookings: [camelConflicts[1]] });
  });

  it('SCRUM17_AC3_created_with_affected_but_no_flagged_bookings_does_not_fall_back', async () => {
    // A database without 014 answers with affected_bookings only. Nothing was
    // flagged there, so the honest answer is an empty list.
    rpc.mockResolvedValue({
      data: { outcome: 'created', block: blockRow(), affected_bookings: conflictRows },
      error: null,
    });

    await expect(
      createVenueBlock(VENUE_ID, override(), STAFF_ID, { now: NOW }),
    ).resolves.toEqual({ block: CAMEL_BLOCK, flaggedBookings: [] });
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', []],
  ])(
    'SCRUM17_AC3_created_without_flagged_bookings_returns_empty_list (%s)',
    async (_label, flagged) => {
      const data = { outcome: 'created', block: blockRow() };
      if (flagged !== undefined) data.flagged_bookings = flagged;
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


describe('SCRUM17_AC4 updateVenueBlock', () => {
  const BOOKING_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const EVENT_ID = '8d0e6679-7425-40de-944b-e07fc1f90ae7';

  const bookingRow = {
    booking_id: BOOKING_ID,
    event_request_id: EVENT_ID,
    event_name: 'Orientation',
    starts_at: '2026-10-01T02:00:00+00:00',
    ends_at: '2026-10-01T04:00:00+00:00',
  };
  const camelBooking = {
    bookingId: BOOKING_ID,
    eventRequestId: EVENT_ID,
    eventName: 'Orientation',
    startsAt: '2026-10-01T02:00:00+00:00',
    endsAt: '2026-10-01T04:00:00+00:00',
  };

  const updated = (extra = {}) => ({
    data: { outcome: 'updated', block: blockRow(), affected_bookings: [], flagged_bookings: [], ...extra },
    error: null,
  });

  const run = (input, userId = STAFF_ID) =>
    updateVenueBlock(VENUE_ID, BLOCK_ID, input, userId, { now: NOW });

  describe('the rpc call', () => {
    it('SCRUM17_AC4_calls_update_venue_block_with_all_ten_named_params', async () => {
      rpc.mockResolvedValueOnce(updated());

      await run({ endsAt: ' 2026-10-02T17:00:00+08:00 ' });

      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith('update_venue_block', {
        p_venue_id: VENUE_ID,
        p_block_id: BLOCK_ID,
        p_starts_at: null,
        p_ends_at: '2026-10-02T17:00:00+08:00',
        p_reason: null,
        p_notes: null,
        p_notes_supplied: false,
        p_user_id: STAFF_ID,
        p_confirm_override: false,
        p_acknowledged_booking_ids: [],
      });
      expect(Object.keys(rpc.mock.calls[0][1])).toHaveLength(10);
    });

    it('SCRUM17_AC4_notes_null_is_sent_as_supplied', async () => {
      rpc.mockResolvedValueOnce(updated());
      await run({ notes: null });
      const params = rpc.mock.calls[0][1];
      expect(params.p_notes).toBeNull();
      expect(params.p_notes_supplied).toBe(true);
    });

    it('sends trimmed notes as supplied', async () => {
      rpc.mockResolvedValueOnce(updated());
      await run({ notes: '  Rewired  ' });
      const params = rpc.mock.calls[0][1];
      expect(params.p_notes).toBe('Rewired');
      expect(params.p_notes_supplied).toBe(true);
    });

    it('SCRUM17_AC4_p_user_id_is_the_acting_user_not_the_body', async () => {
      rpc.mockResolvedValueOnce(updated());
      await run({ reason: 'safety', userId: '00000000-0000-4000-8000-000000000000' });
      expect(rpc.mock.calls[0][1].p_user_id).toBe(STAFF_ID);
    });

    it('SCRUM17_AC3_sends_the_override_and_normalised_ids', async () => {
      rpc.mockResolvedValueOnce(updated());
      await run({
        endsAt: '2026-10-02T17:00:00+08:00',
        confirmOverride: true,
        acknowledgedBookingIds: [BOOKING_ID.toUpperCase(), BOOKING_ID],
      });
      const params = rpc.mock.calls[0][1];
      expect(params.p_confirm_override).toBe(true);
      expect(params.p_acknowledged_booking_ids).toEqual([BOOKING_ID]);
    });

    it('defaults the user to null', async () => {
      rpc.mockResolvedValueOnce(updated());
      await updateVenueBlock(VENUE_ID, BLOCK_ID, { reason: 'safety' }, undefined, { now: NOW });
      expect(rpc.mock.calls[0][1].p_user_id).toBeNull();
    });
  });

  describe('validation runs before any rpc', () => {
    it.each([
      ['a bad venue id', () => updateVenueBlock('nope', BLOCK_ID, { reason: 'safety' }, STAFF_ID, { now: NOW })],
      ['a bad block id', () => updateVenueBlock(VENUE_ID, 'nope', { reason: 'safety' }, STAFF_ID, { now: NOW })],
      ['an empty patch', () => run({})],
      ['an override-only patch', () => run({ confirmOverride: true, acknowledgedBookingIds: [BOOKING_ID] })],
      ['a null start', () => run({ startsAt: null })],
      ['a past end', () => run({ endsAt: '2026-01-01T00:00:00Z' })],
    ])('SCRUM17_AC4_refuses_%s_without_calling_the_rpc', async (_label, call) => {
      const err = await errorFromAsync(call);
      expect(err).toBeInstanceOf(ValidationError);
      expect(rpc).not.toHaveBeenCalled();
      expect(from).not.toHaveBeenCalled();
    });
  });

  describe('outcomes', () => {
    it('SCRUM17_AC4_updated_returns_the_camelcase_block_and_flagged_bookings', async () => {
      rpc.mockResolvedValueOnce(
        updated({ affected_bookings: [bookingRow], flagged_bookings: [bookingRow] }),
      );
      await expect(run({ reason: 'safety' })).resolves.toEqual({
        block: CAMEL_BLOCK,
        flaggedBookings: [camelBooking],
      });
    });

    it('SCRUM17_AC3_flagged_bookings_come_only_from_flagged_bookings', async () => {
      rpc.mockResolvedValueOnce(updated({ affected_bookings: [bookingRow], flagged_bookings: undefined }));
      const result = await run({ reason: 'safety' });
      expect(result.flaggedBookings).toEqual([]);
    });

    it('SCRUM17_AC3_conflict_throws_block_booking_conflict_with_camelcase_conflicts', async () => {
      rpc.mockResolvedValueOnce({ data: { outcome: 'conflict', conflicts: [bookingRow] }, error: null });
      const err = await errorFromAsync(() => run({ endsAt: '2026-10-02T17:00:00+08:00' }));
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.status).toBe(409);
      expect(err.code).toBe('BLOCK_BOOKING_CONFLICT');
      expect(err.conflicts).toEqual([camelBooking]);
      expect(err.message).toBe('This period overlaps approved bookings');
    });

    it('SCRUM17_AC3_conflict_after_confirming_says_the_list_is_stale', async () => {
      rpc.mockResolvedValueOnce({ data: { outcome: 'conflict', conflicts: [bookingRow] }, error: null });
      const err = await errorFromAsync(() =>
        run({
          endsAt: '2026-10-02T17:00:00+08:00',
          confirmOverride: true,
          acknowledgedBookingIds: [BOOKING_ID],
        }),
      );
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.code).toBe('BLOCK_BOOKING_CONFLICT');
      expect(err.message).toBe(
        'The overlapping bookings have changed since you confirmed; review them again',
      );
    });

    it.each([
      ['an unknown outcome', { data: { outcome: 'created', block: blockRow() }, error: null }],
      ['null data', { data: null, error: null }],
    ])('SCRUM17_AC4_%s_throws_a_plain_error', async (_label, result) => {
      rpc.mockResolvedValueOnce(result);
      const err = await errorFromAsync(() => run({ reason: 'safety' }));
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ValidationError);
      expect(err).not.toBeInstanceOf(NotFoundError);
      expect(err).not.toBeInstanceOf(ConflictError);
      expect(err.message).toMatch(/Unexpected outcome from update_venue_block/);
    });
  });

  describe('database errors', () => {
    const fail = (error) => rpc.mockResolvedValueOnce({ data: null, error });

    it('SCRUM17_AC4_P0002_becomes_not_found', async () => {
      fail({ code: 'P0002', message: 'venue block x not found on venue y' });
      const err = await errorFromAsync(() => run({ reason: 'safety' }));
      expect(err).toBeInstanceOf(NotFoundError);
      expect(err.status).toBe(404);
    });

    it.each(['BLOCK_REMOVED', 'BLOCK_ENDED', 'VENUE_RETIRED'])(
      'SCRUM17_AC4_PT409_%s_becomes_a_conflict_with_that_code',
      async (hint) => {
        fail({ code: 'PT409', message: 'refused', hint, details: null });
        const err = await errorFromAsync(() => run({ reason: 'safety' }));
        expect(err).toBeInstanceOf(ConflictError);
        expect(err.code).toBe(hint);
        expect(err.conflicts).toEqual([]);
      },
    );

    it('SCRUM17_AC4_PT409_BLOCK_OVERLAPS_BLOCK_names_the_clashing_block', async () => {
      fail({
        code: 'PT409',
        message: 'this period overlaps another block',
        hint: 'BLOCK_OVERLAPS_BLOCK',
        details: OTHER_BLOCK_ID,
      });
      const err = await errorFromAsync(() => run({ endsAt: '2026-10-02T17:00:00+08:00' }));
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.code).toBe('BLOCK_OVERLAPS_BLOCK');
      expect(err.conflicts).toEqual([{ blockId: OTHER_BLOCK_ID }]);
    });

    it('SCRUM17_AC4_22023_becomes_a_validation_error', async () => {
      fail({ code: '22023', message: 'a block with reason other needs notes' });
      const err = await errorFromAsync(() => run({ reason: 'other' }));
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.status).toBe(400);
    });

    it('SCRUM17_AC4_23P01_becomes_block_overlaps_block', async () => {
      fail({ code: '23P01', message: 'conflicting key value violates exclusion constraint' });
      const err = await errorFromAsync(() => run({ endsAt: '2026-10-02T17:00:00+08:00' }));
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.code).toBe('BLOCK_OVERLAPS_BLOCK');
      expect(err.conflicts).toEqual([]);
    });
  });
});


describe('SCRUM17_AC4 removeVenueBlock', () => {
  const removed = { data: { outcome: 'removed', block: blockRow({ removed_at: NOW.toISOString(), removed_by: STAFF_ID }) }, error: null };

  it('SCRUM17_AC4_calls_remove_venue_block_with_three_params', async () => {
    rpc.mockResolvedValueOnce(removed);
    await removeVenueBlock(VENUE_ID, BLOCK_ID, STAFF_ID);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('remove_venue_block', {
      p_venue_id: VENUE_ID,
      p_block_id: BLOCK_ID,
      p_user_id: STAFF_ID,
    });
    expect(Object.keys(rpc.mock.calls[0][1])).toHaveLength(3);
  });

  it('SCRUM17_AC4_resolves_to_undefined', async () => {
    rpc.mockResolvedValueOnce(removed);
    await expect(removeVenueBlock(VENUE_ID, BLOCK_ID, STAFF_ID)).resolves.toBeUndefined();
  });

  it.each([
    ['venue', () => removeVenueBlock('nope', BLOCK_ID, STAFF_ID)],
    ['block', () => removeVenueBlock(VENUE_ID, 'nope', STAFF_ID)],
  ])('SCRUM17_AC4_validates_the_%s_id_before_any_rpc', async (_label, call) => {
    const err = await errorFromAsync(call);
    expect(err).toBeInstanceOf(ValidationError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM17_AC4_P0002_becomes_not_found', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'P0002', message: 'not found' } });
    const err = await errorFromAsync(() => removeVenueBlock(VENUE_ID, BLOCK_ID, STAFF_ID));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
  });

  it.each(['BLOCK_REMOVED', 'BLOCK_ENDED'])(
    'SCRUM17_AC4_PT409_%s_becomes_a_409_conflict',
    async (hint) => {
      rpc.mockResolvedValueOnce({ data: null, error: { code: 'PT409', message: 'refused', hint } });
      const err = await errorFromAsync(() => removeVenueBlock(VENUE_ID, BLOCK_ID, STAFF_ID));
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.status).toBe(409);
      expect(err.code).toBe(hint);
      expect(err.conflicts).toEqual([]);
    },
  );

  it.each([
    ['an unknown outcome', { data: { outcome: 'updated' }, error: null }],
    ['null data', { data: null, error: null }],
  ])('SCRUM17_AC4_%s_throws', async (_label, result) => {
    rpc.mockResolvedValueOnce(result);
    const err = await errorFromAsync(() => removeVenueBlock(VENUE_ID, BLOCK_ID, STAFF_ID));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConflictError);
    expect(err.message).toMatch(/Unexpected outcome from remove_venue_block/);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-130 (SCRUM-17 AC2): the calendar's block window, and the blocked
// venues a search leaves out.
// ---------------------------------------------------------------------------
describe('SCRUM17_AC2 listVenueBlocks through a window', () => {
  const FROM = '2026-10-01T00:00:00+08:00';
  const TO = '2026-11-01T00:00:00+08:00';
  const DAY_MS = 86_400_000;

  function givenList(result = { data: [blockRow()], error: null }) {
    const stub = queryStub(result);
    from.mockReturnValue(stub);
    return stub;
  }

  it('SCRUM17_AC2_window_is_strict_overlap_lt_starts_at_to_and_gt_ends_at_from', async () => {
    const stub = givenList();

    await expect(listVenueBlocks(VENUE_ID, { from: FROM, to: TO })).resolves.toEqual([CAMEL_BLOCK]);

    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('venue_blocks');
    expect(stub.args('select')).toEqual([COLUMNS]);
    expect(stub.args('eq')).toEqual(['venue_id', VENUE_ID]);
    expect(stub.args('is')).toEqual(['removed_at', null]);
    expect(stub.allArgs('lt')).toEqual([['starts_at', TO]]);
    expect(stub.allArgs('gt')).toEqual([['ends_at', FROM]]);
    expect(stub.allArgs('order').map(([column]) => column)).toEqual(['starts_at', 'id']);
  });

  it('SCRUM17_AC2_window_never_uses_lte_or_gte', async () => {
    const stub = givenList();
    await listVenueBlocks(VENUE_ID, { from: FROM, to: TO });
    expect(stub.called('lte')).toBe(false);
    expect(stub.called('gte')).toBe(false);
  });

  it('SCRUM17_AC2_gt_is_called_once_so_ended_blocks_are_not_hidden_by_a_now_filter', async () => {
    const stub = givenList();
    await listVenueBlocks(VENUE_ID, { from: '2001-01-01T00:00:00Z', to: '2001-02-01T00:00:00Z' });
    expect(stub.allArgs('gt')).toEqual([['ends_at', '2001-01-01T00:00:00Z']]);
    expect(stub.allArgs('lt')).toEqual([['starts_at', '2001-02-01T00:00:00Z']]);
  });

  it('SCRUM17_AC2_filters_come_before_the_order', async () => {
    const stub = givenList();
    await listVenueBlocks(VENUE_ID, { from: FROM, to: TO });
    const names = stub.calls.map(([name]) => name);
    expect(names.indexOf('lt')).toBeLessThan(names.indexOf('order'));
    expect(names.indexOf('gt')).toBeLessThan(names.indexOf('order'));
  });

  it('SCRUM17_AC2_window_values_are_passed_trimmed', async () => {
    const stub = givenList();
    await listVenueBlocks(VENUE_ID, { from: ` ${FROM} `, to: ` ${TO}` });
    expect(stub.args('lt')).toEqual(['starts_at', TO]);
    expect(stub.args('gt')).toEqual(['ends_at', FROM]);
  });

  it.each([
    ['no options', []],
    ['an empty options object', [{}]],
    ['both blank', [{ from: '', to: '' }]],
    ['both undefined', [{ from: undefined, to: undefined }]],
  ])('SCRUM17_AC2_with_%s_there_is_no_lt_or_gt', async (_label, extra) => {
    const stub = givenList();
    await listVenueBlocks(VENUE_ID, ...extra);
    expect(stub.called('lt')).toBe(false);
    expect(stub.called('gt')).toBe(false);
    expect(stub.args('is')).toEqual(['removed_at', null]);
  });

  it.each([
    ['one-sided (no to)', { from: FROM }, 'to'],
    ['one-sided (no from)', { to: TO }, 'from'],
    ['reversed', { from: TO, to: FROM }, 'to'],
    ['malformed', { from: '2026-10-01', to: TO }, 'from'],
    [
      'over 400 days',
      { from: '2026-01-01T00:00:00.000Z', to: new Date(Date.parse('2026-01-01T00:00:00Z') + 400 * DAY_MS + 1).toISOString() },
      'to',
    ],
  ])('SCRUM17_AC2_a_%s_window_throws_before_any_query', async (_label, window, field) => {
    const err = await errorFromAsync(() => listVenueBlocks(VENUE_ID, window));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details.map((d) => d.field)).toContain(field);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM17_AC2_exactly_400_days_is_queried', async () => {
    const stub = givenList({ data: [], error: null });
    const to = new Date(Date.parse('2026-01-01T00:00:00Z') + 400 * DAY_MS).toISOString();
    await expect(
      listVenueBlocks(VENUE_ID, { from: '2026-01-01T00:00:00.000Z', to }),
    ).resolves.toEqual([]);
    expect(stub.args('lt')).toEqual(['starts_at', to]);
  });

  it('SCRUM17_AC2_a_windowed_query_error_is_translated', async () => {
    givenList({ data: null, error: { code: '22007', message: 'bad datetime' } });
    await expect(listVenueBlocks(VENUE_ID, { from: FROM, to: TO })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('SCRUM17_AC2_a_windowed_unknown_error_is_a_plain_error', async () => {
    givenList({ data: null, error: { code: '42P01', message: 'relation missing' } });
    const err = await errorFromAsync(() => listVenueBlocks(VENUE_ID, { from: FROM, to: TO }));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err.message).toBe('relation missing');
  });
});


// SCRUM-484: the SCRUM17_AC2 findBlockedVenueIds tests that stood here are
// deleted with the function. Its raw "which venues are blocked" read was a
// second copy of the overlap rule; venue search now asks
// available_venue_ids() (033). What they pinned -- a block excludes its venue,
// a removed block excludes nothing, touching the period's edge is clear --
// is covered against real Postgres in tests/db/venueSearchOccupancyDatabase.test.js.


// SCRUM-131: a separate import so the existing ones are left as they were.
import { getVenueBlockHistory } from '../../src/services/venueBlockService.js';

describe('SCRUM17_AC4 getVenueBlockHistory', () => {
  const HISTORY_COLUMNS = 'id, block_id, action, changed_by, changed_at, old_values, new_values';
  const H1 = 'aaaaaaaa-0000-4000-8000-000000000001';
  const H2 = 'aaaaaaaa-0000-4000-8000-000000000002';
  const H3 = 'aaaaaaaa-0000-4000-8000-000000000003';

  /** Newest first, as the database would return them. */
  const HISTORY_ROWS = [
    {
      id: H3,
      block_id: BLOCK_ID,
      action: 'removed',
      changed_by: STAFF_ID,
      changed_at: '2026-09-25T00:00:00+00:00',
      old_values: { removed_at: null, removed_by: null },
      new_values: { removed_at: '2026-09-25T00:00:00+00:00', removed_by: STAFF_ID },
    },
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
      new_values: { id: BLOCK_ID, venue_id: VENUE_ID, starts_at: '2026-10-01T01:00:00+00:00' },
    },
  ];

  const CAMEL_HISTORY = [
    {
      id: H3,
      blockId: BLOCK_ID,
      action: 'removed',
      changedBy: STAFF_ID,
      changedAt: '2026-09-25T00:00:00+00:00',
      oldValues: { removed_at: null, removed_by: null },
      newValues: { removed_at: '2026-09-25T00:00:00+00:00', removed_by: STAFF_ID },
    },
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
      newValues: { id: BLOCK_ID, venue_id: VENUE_ID, starts_at: '2026-10-01T01:00:00+00:00' },
    },
  ];

  /** Routes from() by table name and records the order tables were asked for. */
  function given({ block = { data: blockRow(), error: null }, history = { data: HISTORY_ROWS, error: null } } = {}) {
    const blockStub = queryStub(block);
    const historyStub = queryStub(history);
    const tables = [];
    from.mockImplementation((table) => {
      tables.push(table);
      if (table === 'venue_blocks') return blockStub;
      if (table === 'venue_block_history') return historyStub;
      throw new Error(`unexpected table ${table}`);
    });
    return { blockStub, historyStub, tables };
  }

  it('SCRUM17_AC4_looks_the_block_up_before_reading_history', async () => {
    const { tables } = given();
    await getVenueBlockHistory(VENUE_ID, BLOCK_ID);
    expect(tables).toEqual(['venue_blocks', 'venue_block_history']);
  });

  it('SCRUM17_AC4_scopes_the_block_lookup_to_the_venue', async () => {
    const { blockStub } = given();
    await getVenueBlockHistory(VENUE_ID, BLOCK_ID);
    expect(blockStub.args('select')).toEqual([COLUMNS]);
    expect(blockStub.allArgs('eq')).toEqual([['venue_id', VENUE_ID], ['id', BLOCK_ID]]);
    expect(blockStub.called('maybeSingle')).toBe(true);
  });

  it('SCRUM17_AC4_reads_history_by_block_id_newest_first_with_id_tiebreak', async () => {
    const { historyStub } = given();
    await getVenueBlockHistory(VENUE_ID, BLOCK_ID);
    expect(historyStub.args('select')).toEqual([HISTORY_COLUMNS]);
    expect(historyStub.allArgs('eq')).toEqual([['block_id', BLOCK_ID]]);
    expect(historyStub.allArgs('order')).toEqual([
      ['changed_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
  });

  it('SCRUM17_AC4_maps_rows_to_camelCase_keeping_jsonb_as_stored', async () => {
    given();
    expect(await getVenueBlockHistory(VENUE_ID, BLOCK_ID)).toEqual(CAMEL_HISTORY);
  });

  it('SCRUM17_AC4_keeps_a_null_changedBy', async () => {
    given();
    const [, amended] = await getVenueBlockHistory(VENUE_ID, BLOCK_ID);
    expect(amended).toHaveProperty('changedBy', null);
  });

  it('SCRUM17_AC4_a_created_row_has_empty_oldValues', async () => {
    given();
    const entries = await getVenueBlockHistory(VENUE_ID, BLOCK_ID);
    const created = entries.find((e) => e.action === 'created');
    expect(created.oldValues).toEqual({});
    expect(Object.keys(created.newValues)).toEqual(['id', 'venue_id', 'starts_at']);
  });

  it('SCRUM17_AC4_a_removed_row_carries_removed_at_and_removed_by', async () => {
    given();
    const [removed] = await getVenueBlockHistory(VENUE_ID, BLOCK_ID);
    expect(removed.action).toBe('removed');
    expect(removed.oldValues).toEqual({ removed_at: null, removed_by: null });
    expect(removed.newValues).toEqual({ removed_at: '2026-09-25T00:00:00+00:00', removed_by: STAFF_ID });
  });

  it('SCRUM17_AC4_returns_entries_with_exactly_the_seven_keys', async () => {
    given();
    const [first] = await getVenueBlockHistory(VENUE_ID, BLOCK_ID);
    expect(Object.keys(first).sort()).toEqual(
      ['action', 'blockId', 'changedAt', 'changedBy', 'id', 'newValues', 'oldValues'],
    );
  });

  it('SCRUM17_AC4_a_removed_block_still_returns_its_history', async () => {
    given({
      block: {
        data: blockRow({ removed_at: '2026-09-25T00:00:00+00:00', removed_by: STAFF_ID }),
        error: null,
      },
    });
    expect(await getVenueBlockHistory(VENUE_ID, BLOCK_ID)).toEqual(CAMEL_HISTORY);
  });

  it('SCRUM17_AC4_a_missing_or_other_venues_block_is_404_and_history_is_never_read', async () => {
    // the lookup is scoped by venue_id, so another venue's block reads as no row
    const { tables } = given({ block: { data: null, error: null } });
    const err = await errorFromAsync(() => getVenueBlockHistory(VENUE_ID, OTHER_BLOCK_ID));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
    expect(tables).toEqual(['venue_blocks']);
  });

  it.each([
    ['an empty array', []],
    ['null', null],
  ])('SCRUM17_AC4_returns_[]_when_data_is_%s', async (_label, data) => {
    given({ history: { data, error: null } });
    expect(await getVenueBlockHistory(VENUE_ID, BLOCK_ID)).toEqual([]);
  });

  it.each([
    ['a malformed venue id', 'not-a-uuid', BLOCK_ID],
    ['a malformed block id', VENUE_ID, 'not-a-uuid'],
    ['a missing block id', VENUE_ID, undefined],
  ])('SCRUM17_AC4_%s_is_a_ValidationError_with_no_query', async (_label, venueId, blockId) => {
    const err = await errorFromAsync(() => getVenueBlockHistory(venueId, blockId));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM17_AC4_a_history_22P02_becomes_a_ValidationError', async () => {
    given({ history: { data: null, error: { code: '22P02', message: 'invalid input syntax' } } });
    await expect(getVenueBlockHistory(VENUE_ID, BLOCK_ID)).rejects.toBeInstanceOf(ValidationError);
  });

  it('SCRUM17_AC4_an_unknown_history_error_becomes_a_plain_Error', async () => {
    given({ history: { data: null, error: { code: '42P01', message: 'relation does not exist' } } });
    const err = await errorFromAsync(() => getVenueBlockHistory(VENUE_ID, BLOCK_ID));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err).not.toBeInstanceOf(NotFoundError);
    expect(err).not.toBeInstanceOf(ConflictError);
    expect(err.message).toBe('relation does not exist');
  });

  it('SCRUM17_AC4_a_block_lookup_error_stops_before_history', async () => {
    const { tables } = given({ block: { data: null, error: { code: '08006', message: 'connection failure' } } });
    const err = await errorFromAsync(() => getVenueBlockHistory(VENUE_ID, BLOCK_ID));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NotFoundError);
    expect(tables).toEqual(['venue_blocks']);
  });
});


describe('translateError fallbacks for sparse database errors (SCRUM-132)', () => {
  // PostgREST does not promise message, details or hint on every error, so
  // each fallback is reached with the field missing altogether.
  async function createFailingWith(error) {
    rpc.mockResolvedValue({ data: null, error });
    return errorFromAsync(() => createVenueBlock(VENUE_ID, validInput(), STAFF_ID, { now: NOW }));
  }

  it('a validation code with no message still becomes a 400 with the fixed prefix', async () => {
    const err = await createFailingWith({ code: '22P02' });

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe('A value was rejected by the database: ');
  });

  it('23503 with no details is judged on the message alone', async () => {
    const err = await createFailingWith({
      code: '23503',
      message: 'violates foreign key constraint "venue_blocks_created_by_fkey"',
    });

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/^The editing user does not exist: /);
  });

  it('23503 with neither message nor details is a referenced-record validation error', async () => {
    const err = await createFailingWith({ code: '23503' });

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe('A referenced record does not exist: ');
  });

  it('P0002 with no message falls back to "Venue not found"', async () => {
    const err = await createFailingWith({ code: 'P0002' });

    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toBe('Venue not found');
  });

  it('PT409 with no hint is a conflict with code null and no conflicts', async () => {
    const err = await createFailingWith({ code: 'PT409', message: 'conflict' });

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBeNull();
    expect(err.conflicts).toEqual([]);
  });

  it('an unknown code with no message is a plain "Unexpected database error"', async () => {
    const err = await createFailingWith({ code: '42P01' });

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err.message).toBe('Unexpected database error');
  });

  it('the same fallbacks hold through removeVenueBlock', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'P0002' } });
    const err = await errorFromAsync(() => removeVenueBlock(VENUE_ID, BLOCK_ID, STAFF_ID));

    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toBe('Venue not found');
  });
});


describe('SCRUM484 block conflicts carry the occupied period', () => {
  // D = 2026-11-11. Booking 10:00-12:00 at a 30/45 venue occupies 09:30-12:45.
  const BOOKING_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const EVENT_ID = '8d0e6679-7425-40de-944b-e07fc1f90ae7';

  // A conflict row as create_ / update_venue_block (033) build it.
  const conflictRow = {
    booking_id: BOOKING_ID,
    event_request_id: EVENT_ID,
    event_name: 'Orientation',
    starts_at: '2026-11-11T10:00:00+08:00',
    ends_at: '2026-11-11T12:00:00+08:00',
    occupied_starts_at: '2026-11-11T09:30:00+08:00',
    occupied_ends_at: '2026-11-11T12:45:00+08:00',
    setup_minutes: 30,
    turnaround_minutes: 45,
  };
  const camelConflict = {
    bookingId: BOOKING_ID,
    eventRequestId: EVENT_ID,
    eventName: 'Orientation',
    startsAt: '2026-11-11T10:00:00+08:00',
    endsAt: '2026-11-11T12:00:00+08:00',
    occupiedStartsAt: '2026-11-11T09:30:00+08:00',
    occupiedEndsAt: '2026-11-11T12:45:00+08:00',
    setupMinutes: 30,
    turnaroundMinutes: 45,
  };
  const blockInput = {
    startsAt: '2026-11-11T12:00:00+08:00',
    endsAt: '2026-11-11T12:30:00+08:00',
    reason: 'maintenance',
  };

  it('SCRUM484_AC7_block_conflicts_carry_occupied_periods', async () => {
    // B-AC7-04: both writers' conflict lists, mapped by toBookingConflict.
    rpc.mockResolvedValueOnce({ data: { outcome: 'conflict', conflicts: [conflictRow] }, error: null });
    const created = await errorFromAsync(() =>
      createVenueBlock(VENUE_ID, blockInput, STAFF_ID, { now: NOW }),
    );
    expect(created).toBeInstanceOf(ConflictError);
    expect(created.code).toBe('BLOCK_BOOKING_CONFLICT');
    expect(created.conflicts).toStrictEqual([camelConflict]);

    rpc.mockResolvedValueOnce({ data: { outcome: 'conflict', conflicts: [conflictRow] }, error: null });
    const updated = await errorFromAsync(() =>
      updateVenueBlock(VENUE_ID, BLOCK_ID, { endsAt: blockInput.endsAt }, STAFF_ID, { now: NOW }),
    );
    expect(updated).toBeInstanceOf(ConflictError);
    expect(updated.code).toBe('BLOCK_BOOKING_CONFLICT');
    expect(updated.conflicts).toStrictEqual([camelConflict]);
  });

  it('SCRUM484_AC7_toBookingConflict_maps_the_four_occupied_fields', () => {
    expect(toBookingConflict(conflictRow)).toStrictEqual(camelConflict);
  });

  it('SCRUM484_AC7_flagged_rows_without_occupied_fields_leave_them_undefined', () => {
    // flag_bookings_for_block keeps 014's five columns (033), so a flagged
    // row has no occupied fields; they map to undefined and JSON drops them.
    const { occupied_starts_at, occupied_ends_at, setup_minutes, turnaround_minutes, ...flagRow } = conflictRow;
    const mapped = toBookingConflict(flagRow);
    expect(mapped.occupiedStartsAt).toBeUndefined();
    expect(mapped.occupiedEndsAt).toBeUndefined();
    expect(mapped.setupMinutes).toBeUndefined();
    expect(mapped.turnaroundMinutes).toBeUndefined();
    expect(JSON.parse(JSON.stringify(mapped))).toEqual({
      bookingId: BOOKING_ID,
      eventRequestId: EVENT_ID,
      eventName: 'Orientation',
      startsAt: '2026-11-11T10:00:00+08:00',
      endsAt: '2026-11-11T12:00:00+08:00',
    });
  });
});
