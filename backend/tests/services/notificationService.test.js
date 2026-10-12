/**
 * Tests for the notification service.
 *
 * SCRUM-128 (part of SCRUM-17, AC3): an Event Coordinator reads the
 * notifications written when a block overrides a booking, and marks them read.
 *
 * The Supabase client is replaced wholesale, exactly as venueBlockService.test.js
 * does it: vi.mock's factory is hoisted above the imports, so the real module
 * (which throws without credentials, and would reach the live database with
 * them) never evaluates. Nothing here touches the network.
 *
 * The recipient filter is the whole of this service's access control (RLS is
 * on with no policies and the client holds the secret key), so almost every
 * test asserts it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { supabase } from '../../src/config/supabaseClient.js';
import {
  listNotifications,
  markNotificationRead,
  toNotification,
} from '../../src/services/notificationService.js';
import { ValidationError, NotFoundError, AppError } from '../../src/errors.js';

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));

vi.mock('../../src/config/supabaseClient.js', () => {
  const client = { rpc, from };
  return { supabase: client, default: client };
});


const COORDINATOR_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const NOTIFICATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const OTHER_NOTIFICATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae8';
const BOOKING_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const BLOCK_ID = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const FROZEN_NOW = new Date('2026-09-28T06:30:00.000Z');
const FIRST_READ = '2026-09-27T01:00:00+00:00';

// SCRUM-491 added venue_hold_id, the hold a 'venue_hold_expired' notice is about.
const COLUMNS = 'id, recipient_id, type, booking_id, block_id, venue_hold_id, event_request_id, payload, read_at, created_at';

const PAYLOAD = {
  venueName: 'Seminar Room 2-1',
  eventName: 'Tech Talk',
  startsAt: '2026-10-01T02:00:00+00:00',
  endsAt: '2026-10-01T04:00:00+00:00',
  reason: 'maintenance',
  blockStartsAt: '2026-10-01T01:00:00+00:00',
  blockEndsAt: '2026-10-01T09:00:00+00:00',
};

async function errorFromAsync(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

function notificationRow(overrides = {}) {
  return {
    id: NOTIFICATION_ID,
    recipient_id: COORDINATOR_ID,
    type: 'booking_flagged',
    booking_id: BOOKING_ID,
    block_id: BLOCK_ID,
    venue_hold_id: null,
    event_request_id: null,
    payload: PAYLOAD,
    read_at: null,
    created_at: '2026-09-26T03:00:00+00:00',
    ...overrides,
  };
}

const CAMEL_NOTIFICATION = {
  id: NOTIFICATION_ID,
  type: 'booking_flagged',
  bookingId: BOOKING_ID,
  blockId: BLOCK_ID,
  venueHoldId: null,
  eventRequestId: null,
  payload: PAYLOAD,
  readAt: null,
  createdAt: '2026-09-26T03:00:00+00:00',
};

/**
 * A stand-in for a supabase-js query builder, extended from the one in
 * venueBlockService.test.js with `update`. `calls` is exposed too, so a test
 * can assert the order of a chain.
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

  for (const method of ['select', 'update', 'eq', 'is', 'order', 'limit']) {
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

const ok = (data) => ({ data, error: null });
const fail = (error) => ({ data: null, error });

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
});


describe('the test double', () => {
  it('the supabase client is mocked and never the real one', () => {
    expect(vi.isMockFunction(supabase.from)).toBe(true);
    expect(vi.isMockFunction(supabase.rpc)).toBe(true);
  });
});


describe('toNotification', () => {
  it('SCRUM17_AC3_maps_a_row_to_exactly_the_contract_shape', () => {
    const mapped = toNotification(notificationRow());
    expect(mapped).toEqual(CAMEL_NOTIFICATION);
    expect(Object.keys(mapped).sort()).toEqual(
      ['blockId', 'bookingId', 'createdAt', 'eventRequestId', 'id', 'payload', 'readAt', 'type', 'venueHoldId'],
    );
  });

  it('SCRUM491_AC8_maps_an_expired_hold_notice_with_its_hold_id', () => {
    const HOLD_ID = '7d3c1b2a-1111-4222-8333-444455556666';
    const payload = {
      eventRequestId: 'e1',
      eventName: 'Tech Talk',
      venueId: 'v1',
      venueName: 'Seminar Room 2-1',
      expiresAt: '2026-10-01T02:00:00+00:00',
    };
    const mapped = toNotification(
      notificationRow({ type: 'venue_hold_expired', booking_id: null, block_id: null, venue_hold_id: HOLD_ID, payload }),
    );
    expect(mapped).toMatchObject({
      type: 'venue_hold_expired',
      bookingId: null,
      blockId: null,
      venueHoldId: HOLD_ID,
      payload,
    });
  });

  it('SCRUM17_AC3_leaves_out_recipient_id', () => {
    const mapped = toNotification(notificationRow());
    expect(mapped).not.toHaveProperty('recipientId');
    expect(mapped).not.toHaveProperty('recipient_id');
  });

  it('passes the payload through untouched', () => {
    const payload = { anything: { nested: [1, 2] } };
    expect(toNotification(notificationRow({ payload })).payload).toBe(payload);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('turns a %s payload into an empty object', (_label, payload) => {
    expect(toNotification(notificationRow({ payload })).payload).toEqual({});
  });

  it('carries read_at through when set', () => {
    expect(toNotification(notificationRow({ read_at: FIRST_READ })).readAt).toBe(FIRST_READ);
  });
});


describe('listNotifications', () => {
  it('SCRUM17_AC3_reads_the_callers_notifications_newest_first', async () => {
    const stub = queryStub(ok([notificationRow()]));
    from.mockReturnValue(stub);

    await expect(listNotifications(COORDINATOR_ID)).resolves.toEqual([CAMEL_NOTIFICATION]);

    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('notifications');
    expect(stub.calls).toEqual([
      ['select', COLUMNS],
      ['eq', 'recipient_id', COORDINATOR_ID],
      ['order', 'created_at', { ascending: false }],
      ['order', 'id', { ascending: false }],
      ['limit', 50],
    ]);
  });

  it('SCRUM17_AC3_always_filters_by_recipient', async () => {
    const stub = queryStub(ok([]));
    from.mockReturnValue(stub);

    await listNotifications(COORDINATOR_ID);

    expect(stub.allArgs('eq')).toEqual([['recipient_id', COORDINATOR_ID]]);
  });

  it('writes nothing', async () => {
    const stub = queryStub(ok([]));
    from.mockReturnValue(stub);

    await listNotifications(COORDINATOR_ID);

    expect(stub.called('update')).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SCRUM17_AC3_defaults_the_limit_to_50', async () => {
    const stub = queryStub(ok([]));
    from.mockReturnValue(stub);

    await listNotifications(COORDINATOR_ID, {});

    expect(stub.args('limit')).toEqual([50]);
  });

  it('accepts a custom limit', async () => {
    const stub = queryStub(ok([]));
    from.mockReturnValue(stub);

    await listNotifications(COORDINATOR_ID, { limit: 5 });

    expect(stub.args('limit')).toEqual([5]);
  });

  it('keeps the database order', async () => {
    const rows = [
      notificationRow({ id: OTHER_NOTIFICATION_ID, created_at: '2026-09-27T00:00:00+00:00' }),
      notificationRow({ read_at: FIRST_READ }),
    ];
    from.mockReturnValue(queryStub(ok(rows)));

    const list = await listNotifications(COORDINATOR_ID);

    expect(list.map((n) => n.id)).toEqual([OTHER_NOTIFICATION_ID, NOTIFICATION_ID]);
    expect(list[1].readAt).toBe(FIRST_READ);
  });

  it('SCRUM17_AC3_returns_an_empty_list_when_there_are_none', async () => {
    from.mockReturnValue(queryStub(ok([])));
    await expect(listNotifications(COORDINATOR_ID)).resolves.toEqual([]);
  });

  it('returns an empty list when data is null', async () => {
    from.mockReturnValue(queryStub(ok(null)));
    await expect(listNotifications(COORDINATOR_ID)).resolves.toEqual([]);
  });

  it('SCRUM17_AC3_throws_an_untyped_error_on_a_database_failure', async () => {
    from.mockReturnValue(queryStub(fail({ code: '08006', message: 'connection failure' })));

    const err = await errorFromAsync(() => listNotifications(COORDINATOR_ID));

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AppError);
    expect(err.message).toBe('connection failure');
  });

  it('falls back to a generic message when the database error has none', async () => {
    from.mockReturnValue(queryStub(fail({ code: 'XX000' })));

    const err = await errorFromAsync(() => listNotifications(COORDINATOR_ID));

    expect(err).not.toBeInstanceOf(AppError);
    expect(err.message).toBe('Unexpected database error');
  });

  it('translates 22P02 into a ValidationError', async () => {
    from.mockReturnValue(
      queryStub(fail({ code: '22P02', message: 'invalid input syntax for type uuid' })),
    );

    const err = await errorFromAsync(() => listNotifications(COORDINATOR_ID));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(err.message).toBe(
      'A value was rejected by the database: invalid input syntax for type uuid',
    );
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['a number', 42],
    ['an object', { id: COORDINATOR_ID }],
  ])('SCRUM17_AC3_refuses_a_missing_user_before_any_query (%s)', async (_label, userId) => {
    const err = await errorFromAsync(() => listNotifications(userId));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe('A signed-in user is required to read notifications');
    expect(from).not.toHaveBeenCalled();
  });
});


describe('markNotificationRead: first read', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('SCRUM17_AC3_marks_an_unread_notification_read_with_a_guarded_update', async () => {
    const stub = queryStub(ok(notificationRow({ read_at: FROZEN_NOW.toISOString() })));
    from.mockReturnValue(stub);

    await expect(markNotificationRead(NOTIFICATION_ID, COORDINATOR_ID)).resolves.toEqual({
      ...CAMEL_NOTIFICATION,
      readAt: FROZEN_NOW.toISOString(),
    });

    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('notifications');
    expect(stub.calls).toEqual([
      ['update', { read_at: FROZEN_NOW.toISOString() }],
      ['eq', 'id', NOTIFICATION_ID],
      ['eq', 'recipient_id', COORDINATOR_ID],
      ['is', 'read_at', null],
      ['select', COLUMNS],
      ['maybeSingle'],
    ]);
  });

  it('sends read_at as an ISO string, never a Date', async () => {
    const stub = queryStub(ok(notificationRow({ read_at: FROZEN_NOW.toISOString() })));
    from.mockReturnValue(stub);

    await markNotificationRead(NOTIFICATION_ID, COORDINATOR_ID);

    const [patch] = stub.args('update');
    expect(typeof patch.read_at).toBe('string');
    expect(patch.read_at).toBe('2026-09-28T06:30:00.000Z');
    expect(Object.keys(patch)).toEqual(['read_at']);
  });

  it('SCRUM17_AC3_makes_no_second_read_when_the_update_matched', async () => {
    from.mockReturnValue(queryStub(ok(notificationRow({ read_at: FROZEN_NOW.toISOString() }))));

    await markNotificationRead(NOTIFICATION_ID, COORDINATOR_ID);

    expect(from).toHaveBeenCalledTimes(1);
  });

  it('throws an untyped error when the update fails, without a second read', async () => {
    from.mockReturnValue(queryStub(fail({ code: '57014', message: 'statement timeout' })));

    const err = await errorFromAsync(() => markNotificationRead(NOTIFICATION_ID, COORDINATOR_ID));

    expect(err).not.toBeInstanceOf(AppError);
    expect(err.message).toBe('statement timeout');
    expect(from).toHaveBeenCalledTimes(1);
  });

  it('translates a 22P02 from the update into a ValidationError', async () => {
    from.mockReturnValue(queryStub(fail({ code: '22P02', message: 'bad uuid' })));

    const err = await errorFromAsync(() => markNotificationRead(NOTIFICATION_ID, COORDINATOR_ID));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe('A value was rejected by the database: bad uuid');
  });

  it('translates a 22P02 with no message', async () => {
    from.mockReturnValue(queryStub(fail({ code: '22P02' })));

    const err = await errorFromAsync(() => markNotificationRead(NOTIFICATION_ID, COORDINATOR_ID));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe('A value was rejected by the database: ');
  });
});


describe('markNotificationRead: nothing unread matched', () => {
  it('SCRUM17_AC3_already_read_returns_the_original_read_at', async () => {
    const update = queryStub(ok(null));
    const read = queryStub(ok(notificationRow({ read_at: FIRST_READ })));
    from.mockReturnValueOnce(update).mockReturnValueOnce(read);

    await expect(markNotificationRead(NOTIFICATION_ID, COORDINATOR_ID)).resolves.toEqual({
      ...CAMEL_NOTIFICATION,
      readAt: FIRST_READ,
    });

    expect(from).toHaveBeenCalledTimes(2);
    expect(from).toHaveBeenNthCalledWith(2, 'notifications');
    expect(read.calls).toEqual([
      ['select', COLUMNS],
      ['eq', 'id', NOTIFICATION_ID],
      ['eq', 'recipient_id', COORDINATOR_ID],
      ['maybeSingle'],
    ]);
    expect(read.called('update')).toBe(false);
  });

  it('SCRUM17_AC3_someone_elses_notification_is_not_found', async () => {
    from.mockReturnValueOnce(queryStub(ok(null))).mockReturnValueOnce(queryStub(ok(null)));

    const err = await errorFromAsync(() => markNotificationRead(NOTIFICATION_ID, COORDINATOR_ID));

    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
    expect(err.message).toBe(`Notification ${NOTIFICATION_ID} not found`);
  });

  it('SCRUM17_AC3_missing_and_not_yours_answer_the_same_message', async () => {
    // Both come back as "no row" from a recipient-scoped query; the service
    // cannot, and must not, tell them apart.
    from.mockReturnValueOnce(queryStub(ok(null))).mockReturnValueOnce(queryStub(ok(null)));
    const missing = await errorFromAsync(() =>
      markNotificationRead(NOTIFICATION_ID, COORDINATOR_ID),
    );

    from.mockReturnValueOnce(queryStub(ok(null))).mockReturnValueOnce(queryStub(ok(null)));
    const notYours = await errorFromAsync(() =>
      markNotificationRead(NOTIFICATION_ID, '11111111-1111-4111-8111-111111111111'),
    );

    expect(missing.message).toBe(notYours.message);
    expect(missing.status).toBe(notYours.status);
  });

  it('scopes the fallback read to the caller', async () => {
    const read = queryStub(ok(null));
    from.mockReturnValueOnce(queryStub(ok(null))).mockReturnValueOnce(read);

    await errorFromAsync(() => markNotificationRead(NOTIFICATION_ID, COORDINATOR_ID));

    expect(read.allArgs('eq')).toContainEqual(['recipient_id', COORDINATOR_ID]);
  });

  it('throws an untyped error when the fallback read fails', async () => {
    from
      .mockReturnValueOnce(queryStub(ok(null)))
      .mockReturnValueOnce(queryStub(fail({ code: '08006', message: 'connection lost' })));

    const err = await errorFromAsync(() => markNotificationRead(NOTIFICATION_ID, COORDINATOR_ID));

    expect(err).not.toBeInstanceOf(AppError);
    expect(err.message).toBe('connection lost');
  });

  it('translates a 22P02 from the fallback read', async () => {
    from
      .mockReturnValueOnce(queryStub(ok(null)))
      .mockReturnValueOnce(queryStub(fail({ code: '22P02', message: 'bad uuid' })));

    const err = await errorFromAsync(() => markNotificationRead(NOTIFICATION_ID, COORDINATOR_ID));

    expect(err).toBeInstanceOf(ValidationError);
  });
});


describe('markNotificationRead: input', () => {
  it.each([
    ['not a uuid', 'nope'],
    ['empty', ''],
    ['undefined', undefined],
    ['a number', 7],
  ])('SCRUM17_AC3_bad_id_is_refused_without_a_network_call (%s)', async (_label, id) => {
    const err = await errorFromAsync(() => markNotificationRead(id, COORDINATOR_ID));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(err.details).toEqual([
      { field: 'notificationId', message: 'must be a notification id' },
    ]);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
  ])('SCRUM17_AC3_missing_user_is_refused_before_any_query (%s)', async (_label, userId) => {
    const err = await errorFromAsync(() => markNotificationRead(NOTIFICATION_ID, userId));

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe('A signed-in user is required to read notifications');
    expect(from).not.toHaveBeenCalled();
  });
});
