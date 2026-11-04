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
  countUnreadNotifications,
  markNotificationRead,
  toNotification,
} from '../../src/services/notificationService.js';
import { ValidationError, NotFoundError } from '../../src/errors.js';
import {
  COORDINATOR_ID,
  NOTIFICATION_ID,
  FIRST_READ,
  PAYLOAD,
  notificationRow,
  CAMEL_NOTIFICATION,
  queryStub,
  ok,
  fail,
  counted,
} from '../fixtures/notifications.js';

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));

vi.mock('../../src/config/supabaseClient.js', () => {
  const client = { rpc, from };
  return { supabase: client, default: client };
});


const OTHER_NOTIFICATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae8';
const EVENT_ID = 'c0ffee00-1234-4abc-8def-000000000001';
const PAYLOAD_EVENT_ID = 'c0ffee00-1234-4abc-8def-000000000002';
const BOOKING_EVENT_ID = 'c0ffee00-1234-4abc-8def-000000000003';
const FROZEN_NOW = new Date('2026-09-28T06:30:00.000Z');

// SCRUM-491 added venue_hold_id, the hold a 'venue_hold_expired' notice is about.
// SCRUM-172 added the booking embed, the event fallback for booking-only types.
const COLUMNS = 'id, recipient_id, type, booking_id, block_id, venue_hold_id, event_request_id, payload, read_at, created_at, booking:bookings(event_request_id)';

async function errorFromAsync(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

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
    // The row carries the booking embed, as the real select returns it, so a
    // leaked `booking` key would break the exact key list below.
    const mapped = toNotification(notificationRow({ booking: { event_request_id: null } }));
    expect(mapped).toEqual(CAMEL_NOTIFICATION);
    expect(mapped).not.toHaveProperty('booking');
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


describe('toNotification: the related event (SCRUM-172)', () => {
  it('SCRUM172_AC7_event_id_comes_from_the_column_first', () => {
    const mapped = toNotification(
      notificationRow({
        event_request_id: EVENT_ID,
        payload: { ...PAYLOAD, eventRequestId: PAYLOAD_EVENT_ID },
        booking: { event_request_id: BOOKING_EVENT_ID },
      }),
    );
    expect(mapped.eventRequestId).toBe(EVENT_ID);
  });

  it('SCRUM172_AC7_falls_back_to_the_payload_event_id', () => {
    const mapped = toNotification(
      notificationRow({
        type: 'venue_hold_expired',
        payload: { eventRequestId: PAYLOAD_EVENT_ID },
        booking: { event_request_id: BOOKING_EVENT_ID },
      }),
    );
    expect(mapped.eventRequestId).toBe(PAYLOAD_EVENT_ID);
  });

  it('SCRUM172_AC7_falls_back_to_the_booking_event_for_booking_only_types', () => {
    const mapped = toNotification(
      notificationRow({ booking: { event_request_id: BOOKING_EVENT_ID } }),
    );
    expect(mapped.type).toBe('booking_flagged');
    expect(mapped.eventRequestId).toBe(BOOKING_EVENT_ID);
  });

  it.each([
    ['a payload without it', PAYLOAD],
    ['a null payload', null],
  ])('SCRUM172_AC7_is_null_when_no_event_is_known (%s)', (_label, payload) => {
    const mapped = toNotification(notificationRow({ booking_id: null, payload, booking: null }));
    expect(mapped.eventRequestId).toBeNull();
  });

  it.each([
    ['registration_opened', { audience: 'waitlisted', cause: 'opening_time', occurrenceKey: 'opened:1' }],
    ['registration_closed', { audience: 'organiser', cause: 'switched_off', occurrenceKey: 'closed:2' }],
    ['registration_capacity_reached', { audience: 'coordinator', capacity: 2, registeredCount: 2, occurrenceKey: 'full:1' }],
    ['registration_place_released', { audience: 'organiser', cause: 'withdrawal', capacity: 2, registeredCount: 1, occurrenceKey: 'released:2' }],
    ['registration_promoted', { registrationId: 'r1', waitlistedAt: '2026-11-05T10:00:00.000000Z' }],
  ])('SCRUM177_AC5_a_%s_notice_reaches_the_inbox_with_its_event_and_payload', (type, fields) => {
    // Registration notices carry no booking: the event comes from their own column.
    const payload = { eventRequestId: EVENT_ID, eventName: 'Tech Talk', ...fields };
    const mapped = toNotification(notificationRow({ type, booking_id: null, block_id: null, event_request_id: EVENT_ID, payload, booking: null }));

    expect(mapped).toMatchObject({ type, eventRequestId: EVENT_ID, bookingId: null });
    expect(mapped.payload).toBe(payload);
  });

  it('SCRUM172_AC7_does_not_return_the_embedded_booking', () => {
    const mapped = toNotification(
      notificationRow({ booking: { event_request_id: BOOKING_EVENT_ID } }),
    );
    expect(mapped).not.toHaveProperty('booking');
    expect(Object.values(mapped)).not.toContainEqual({ event_request_id: BOOKING_EVENT_ID });
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

  it.each([
    ['no limit given defaults to 50', {}, 50],
    ['a custom limit of 5', { limit: 5 }, 5],
  ])('SCRUM17_AC3_limits_the_list (%s)', async (_label, options, limit) => {
    const stub = queryStub(ok([]));
    from.mockReturnValue(stub);

    await listNotifications(COORDINATOR_ID, options);

    expect(stub.args('limit')).toEqual([limit]);
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

  it('SCRUM172_AC7_list_resolves_the_event_for_each_row', async () => {
    const rows = [
      notificationRow({ booking: { event_request_id: BOOKING_EVENT_ID } }),
      notificationRow({ id: OTHER_NOTIFICATION_ID, booking_id: null, booking: null }),
    ];
    from.mockReturnValue(queryStub(ok(rows)));

    const list = await listNotifications(COORDINATOR_ID);

    expect(list.map((n) => n.eventRequestId)).toEqual([BOOKING_EVENT_ID, null]);
    expect(list[0]).not.toHaveProperty('booking');
  });

  it.each([
    ['[]', []],
    ['null', null],
  ])('SCRUM17_AC3_returns_an_empty_list_when_there_are_none (data %s)', async (_label, data) => {
    from.mockReturnValue(queryStub(ok(data)));
    await expect(listNotifications(COORDINATOR_ID)).resolves.toEqual([]);
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


describe('countUnreadNotifications', () => {
  it('SCRUM172_AC4_counts_only_the_callers_unread', async () => {
    const stub = queryStub(counted(3));
    from.mockReturnValue(stub);

    await expect(countUnreadNotifications(COORDINATOR_ID)).resolves.toBe(3);

    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('notifications');
    expect(stub.calls).toEqual([
      ['select', 'id', { count: 'exact', head: true }],
      ['eq', 'recipient_id', COORDINATOR_ID],
      ['is', 'read_at', null],
    ]);
  });

  it('SCRUM172_AC4_counts_beyond_the_list_limit', async () => {
    const stub = queryStub(counted(73));
    from.mockReturnValue(stub);

    await expect(countUnreadNotifications(COORDINATOR_ID)).resolves.toBe(73);
    expect(stub.called('limit')).toBe(false);
  });

  it.each([
    ['0', 0],
    ['null', null],
  ])('SCRUM172_AC4_zero_when_none (count %s)', async (_label, count) => {
    from.mockReturnValue(queryStub(counted(count)));
    await expect(countUnreadNotifications(COORDINATOR_ID)).resolves.toBe(0);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
  ])('SCRUM172_AC1_refuses_a_missing_user_before_any_query (%s)', async (_label, userId) => {
    const err = await errorFromAsync(() => countUnreadNotifications(userId));

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

    expect(missing).toBeInstanceOf(NotFoundError);
    expect(missing.status).toBe(404);
    expect(missing.message).toBe(`Notification ${NOTIFICATION_ID} not found`);
    expect(missing.message).toBe(notYours.message);
    expect(missing.status).toBe(notYours.status);
  });
});


describe('database errors', () => {
  // Each call site fails on its own query; the fallback read only runs after
  // the guarded update matched nothing.
  const CALL_SITES = {
    listNotifications: {
      failWith: (error) => from.mockReturnValue(queryStub(fail(error))),
      call: () => listNotifications(COORDINATOR_ID),
      queries: 1,
    },
    countUnreadNotifications: {
      failWith: (error) => from.mockReturnValue(queryStub(fail(error))),
      call: () => countUnreadNotifications(COORDINATOR_ID),
      queries: 1,
    },
    'the markNotificationRead update': {
      failWith: (error) => from.mockReturnValue(queryStub(fail(error))),
      call: () => markNotificationRead(NOTIFICATION_ID, COORDINATOR_ID),
      queries: 1,
    },
    'the markNotificationRead fallback read': {
      failWith: (error) =>
        from.mockReturnValueOnce(queryStub(ok(null))).mockReturnValueOnce(queryStub(fail(error))),
      call: () => markNotificationRead(NOTIFICATION_ID, COORDINATOR_ID),
      queries: 2,
    },
  };

  // A plain Error (not an AppError) is what makes the route answer 500.
  it.each([
    ['listNotifications', 'an untyped error keeps its message',
      { code: '08006', message: 'connection failure' }, Error, undefined, 'connection failure'],
    ['listNotifications', 'an untyped error with no message gets a generic one',
      { code: 'XX000' }, Error, undefined, 'Unexpected database error'],
    ['listNotifications', '22P02 is a ValidationError',
      { code: '22P02', message: 'invalid input syntax for type uuid' }, ValidationError, 400,
      'A value was rejected by the database: invalid input syntax for type uuid'],
    ['countUnreadNotifications', 'an untyped error keeps its message',
      { code: '08006', message: 'connection failure' }, Error, undefined, 'connection failure'],
    ['countUnreadNotifications', '22P02 is a ValidationError',
      { code: '22P02', message: 'bad uuid' }, ValidationError, 400,
      'A value was rejected by the database: bad uuid'],
    ['the markNotificationRead update', 'an untyped error keeps its message',
      { code: '57014', message: 'statement timeout' }, Error, undefined, 'statement timeout'],
    ['the markNotificationRead update', '22P02 is a ValidationError',
      { code: '22P02', message: 'bad uuid' }, ValidationError, 400,
      'A value was rejected by the database: bad uuid'],
    ['the markNotificationRead update', '22P02 with no message is a ValidationError',
      { code: '22P02' }, ValidationError, 400, 'A value was rejected by the database: '],
    ['the markNotificationRead fallback read', 'an untyped error keeps its message',
      { code: '08006', message: 'connection lost' }, Error, undefined, 'connection lost'],
    ['the markNotificationRead fallback read', '22P02 is a ValidationError',
      { code: '22P02', message: 'bad uuid' }, ValidationError, 400,
      'A value was rejected by the database: bad uuid'],
  ])('from %s: %s', async (site, _shape, error, ErrorClass, status, message) => {
    const { failWith, call, queries } = CALL_SITES[site];
    failWith(error);

    const err = await errorFromAsync(call);

    expect(err.constructor).toBe(ErrorClass);
    expect(err.status).toBe(status);
    expect(err.message).toBe(message);
    expect(from).toHaveBeenCalledTimes(queries);
  });
});


describe('markNotificationRead: input', () => {
  // tests/validation/notificationValidation.test.js owns the table of bad ids;
  // this proves the service validates before it queries.
  it('SCRUM17_AC3_bad_id_is_refused_without_a_network_call', async () => {
    const err = await errorFromAsync(() => markNotificationRead('nope', COORDINATOR_ID));

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
