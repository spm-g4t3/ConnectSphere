/**
 * Tests for the notification routes.
 *
 * SCRUM-128 (part of SCRUM-17, AC3): the signed-in user reads their own
 * notifications and marks one read, over HTTP.
 *
 * The router is mounted on a fresh Express app with a fake authenticator,
 * exactly as tests/routes/venues.test.js does it; src/app.js is never
 * imported because it calls listen(). The Supabase client is mocked with a
 * factory (see venues.test.js for why not automocking), so these drive the
 * real service and validation underneath the real routing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));

vi.mock('../../src/config/supabaseClient.js', () => {
  const client = { rpc, from };
  return { supabase: client, default: client };
});

const { createNotificationRouter, default: defaultRouter } = await import(
  '../../src/routes/notifications.js'
);
const { supabase } = await import('../../src/config/supabaseClient.js');
const { ROLE } = await import('../../src/domain/userRole.js');


const COORDINATOR_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const OTHER_USER_ID = '11111111-1111-4111-8111-111111111111';
const NOTIFICATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const BOOKING_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const BLOCK_ID = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const FIRST_READ = '2026-09-27T01:00:00+00:00';

const PAYLOAD = {
  venueName: 'Seminar Room 2-1',
  eventName: 'Tech Talk',
  startsAt: '2026-10-01T02:00:00+00:00',
  endsAt: '2026-10-01T04:00:00+00:00',
  reason: 'maintenance',
  blockStartsAt: '2026-10-01T01:00:00+00:00',
  blockEndsAt: '2026-10-01T09:00:00+00:00',
};

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

/** The same thenable query stub the service tests use, with update. */
function queryStub(result) {
  const calls = [];
  const stub = {
    calls,
    called: (method) => calls.some(([name]) => name === method),
    allArgs: (method) => calls.filter(([name]) => name === method).map((c) => c.slice(1)),
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  for (const method of ['select', 'update', 'eq', 'is', 'order', 'limit']) {
    stub[method] = (...args) => { calls.push([method, ...args]); return stub; };
  }
  stub.maybeSingle = (...args) => { calls.push(['maybeSingle', ...args]); return Promise.resolve(result); };
  return stub;
}

const ok = (data) => ({ data, error: null });
const fail = (error) => ({ data: null, error });
const counted = (count) => ({ data: null, count, error: null });

/** Stands in for a signed-in user of a given role. */
const signedInAs = (role, id = COORDINATOR_ID) => (req, _res, next) => {
  req.user = { id, email: 'someone@example.com', role };
  next();
};

/** Stands in for no session, answering as the real middleware does. */
const signedOut = (_req, res) => res.status(401).json({ error: 'Authentication required' });

/** An app with the router mounted where app.js mounts it. */
function appWith(requireAuth = signedInAs(ROLE.EVENT_COORDINATOR)) {
  return express()
    .use(express.json())
    .use('/api/notifications', createNotificationRouter({ requireAuth }));
}

let consoleError;

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});


describe('the test double', () => {
  it('the supabase client is mocked and never the real one', () => {
    expect(vi.isMockFunction(supabase.from)).toBe(true);
  });

  it('exports a default router built with the real requireAuth', () => {
    expect(typeof defaultRouter).toBe('function');
    expect(typeof defaultRouter.use).toBe('function');
  });
});


describe('authentication', () => {
  it.each([
    ['GET', (agent) => agent.get('/api/notifications')],
    ['PATCH', (agent) => agent.patch(`/api/notifications/${NOTIFICATION_ID}/read`)],
  ])('SCRUM17_AC3_%s_without_a_session_is_401_and_reads_nothing', async (_label, send) => {
    const res = await send(request(appWith(signedOut)));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
    expect(from).not.toHaveBeenCalled();
  });

  it('the real requireAuth refuses a request with no bearer token', async () => {
    const app = express().use('/api/notifications', defaultRouter);

    const res = await request(app).get('/api/notifications');

    expect(res.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
  });
});


describe('GET /api/notifications', () => {
  it('SCRUM17_AC3_answers_200_with_the_callers_notifications', async () => {
    const stub = queryStub(ok([notificationRow()]));
    from.mockReturnValue(stub);

    const res = await request(appWith()).get('/api/notifications');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([CAMEL_NOTIFICATION]);
    expect(from).toHaveBeenCalledWith('notifications');
  });

  it('SCRUM17_AC3_is_scoped_to_req_user_id', async () => {
    const stub = queryStub(ok([]));
    from.mockReturnValue(stub);

    await request(appWith(signedInAs(ROLE.EVENT_COORDINATOR, OTHER_USER_ID))).get(
      '/api/notifications',
    );

    expect(stub.allArgs('eq')).toEqual([['recipient_id', OTHER_USER_ID]]);
  });

  it('ignores a recipient in the query string', async () => {
    const stub = queryStub(ok([]));
    from.mockReturnValue(stub);

    await request(appWith()).get(`/api/notifications?recipientId=${OTHER_USER_ID}`);

    expect(stub.allArgs('eq')).toEqual([['recipient_id', COORDINATOR_ID]]);
  });

  it('SCRUM17_AC3_answers_200_with_an_empty_array_when_there_are_none', async () => {
    from.mockReturnValue(queryStub(ok([])));

    const res = await request(appWith()).get('/api/notifications');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('never exposes recipient ids', async () => {
    from.mockReturnValue(queryStub(ok([notificationRow()])));

    const res = await request(appWith()).get('/api/notifications');

    expect(res.body[0]).not.toHaveProperty('recipientId');
    expect(res.body[0]).not.toHaveProperty('recipient_id');
  });

  it('SCRUM17_AC3_an_untyped_error_is_a_generic_500', async () => {
    from.mockReturnValue(queryStub(fail({ code: '08006', message: 'secret internals' })));

    const res = await request(appWith()).get('/api/notifications');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Unexpected server error' });
    expect(JSON.stringify(res.body)).not.toContain('secret internals');
    expect(consoleError).toHaveBeenCalled();
  });

  it('a 22P02 from the database is a 400', async () => {
    from.mockReturnValue(queryStub(fail({ code: '22P02', message: 'bad uuid' })));

    const res = await request(appWith()).get('/api/notifications');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('A value was rejected by the database: bad uuid');
    expect(res.body.details).toEqual([]);
  });

  it('a user with no id is a 400, not a leak of every inbox', async () => {
    const noId = (req, _res, next) => {
      req.user = { email: 'x@example.com', role: ROLE.EVENT_COORDINATOR };
      next();
    };

    const res = await request(appWith(noId)).get('/api/notifications');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('A signed-in user is required to read notifications');
    expect(from).not.toHaveBeenCalled();
  });
});


describe('GET /api/notifications/unread-count', () => {
  it('SCRUM172_AC4_returns_the_unread_count', async () => {
    from.mockReturnValue(queryStub(counted(73)));

    const res = await request(appWith()).get('/api/notifications/unread-count');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unreadCount: 73 });
  });

  it('SCRUM172_AC1_counts_for_the_signed_in_user_only', async () => {
    const stub = queryStub(counted(0));
    from.mockReturnValue(stub);

    const res = await request(appWith(signedInAs(ROLE.EVENT_COORDINATOR, OTHER_USER_ID))).get(
      `/api/notifications/unread-count?recipientId=${COORDINATOR_ID}`,
    );

    expect(res.body).toEqual({ unreadCount: 0 });
    expect(stub.allArgs('eq')).toEqual([['recipient_id', OTHER_USER_ID]]);
    expect(stub.allArgs('is')).toEqual([['read_at', null]]);
  });

  it('without a session is 401 and counts nothing', async () => {
    const res = await request(appWith(signedOut)).get('/api/notifications/unread-count');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
    expect(from).not.toHaveBeenCalled();
  });

  it('an untyped error is a generic 500', async () => {
    from.mockReturnValue(queryStub(fail({ code: '08006', message: 'secret internals' })));

    const res = await request(appWith()).get('/api/notifications/unread-count');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Unexpected server error' });
    expect(JSON.stringify(res.body)).not.toContain('secret internals');
    expect(consoleError).toHaveBeenCalled();
  });
});


describe('PATCH /api/notifications/:id/read', () => {
  it('SCRUM17_AC3_answers_200_with_the_notification_marked_read', async () => {
    const readAt = '2026-09-28T06:30:00.000Z';
    const stub = queryStub(ok(notificationRow({ read_at: readAt })));
    from.mockReturnValue(stub);

    const res = await request(appWith()).patch(`/api/notifications/${NOTIFICATION_ID}/read`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...CAMEL_NOTIFICATION, readAt });
    expect(stub.allArgs('eq')).toEqual([
      ['id', NOTIFICATION_ID],
      ['recipient_id', COORDINATOR_ID],
    ]);
  });

  it('SCRUM17_AC3_is_idempotent_and_returns_the_original_read_at', async () => {
    from
      .mockReturnValueOnce(queryStub(ok(null)))
      .mockReturnValueOnce(queryStub(ok(notificationRow({ read_at: FIRST_READ }))));

    const res = await request(appWith()).patch(`/api/notifications/${NOTIFICATION_ID}/read`);

    expect(res.status).toBe(200);
    expect(res.body.readAt).toBe(FIRST_READ);
  });

  it('ignores a readAt in the body', async () => {
    const stub = queryStub(ok(notificationRow({ read_at: '2026-09-28T06:30:00.000Z' })));
    from.mockReturnValue(stub);

    await request(appWith())
      .patch(`/api/notifications/${NOTIFICATION_ID}/read`)
      .send({ readAt: '1999-01-01T00:00:00Z', read_at: null });

    const [[patch]] = stub.allArgs('update');
    expect(patch.read_at).not.toBe('1999-01-01T00:00:00Z');
    expect(patch.read_at).not.toBeNull();
  });

  it('SCRUM17_AC3_a_malformed_id_is_400_without_a_database_call', async () => {
    const res = await request(appWith()).patch('/api/notifications/not-a-uuid/read');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Invalid notification details -- notificationId: must be a notification id',
      details: [{ field: 'notificationId', message: 'must be a notification id' }],
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM17_AC3_someone_elses_or_missing_is_404_with_one_message', async () => {
    from.mockReturnValueOnce(queryStub(ok(null))).mockReturnValueOnce(queryStub(ok(null)));

    const res = await request(appWith(signedInAs(ROLE.EVENT_COORDINATOR, OTHER_USER_ID))).patch(
      `/api/notifications/${NOTIFICATION_ID}/read`,
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: `Notification ${NOTIFICATION_ID} not found` });
  });

  it('SCRUM172_AC8_marking_another_users_notification_filters_on_the_caller', async () => {
    const guardedUpdate = queryStub(ok(null));
    const fallbackRead = queryStub(ok(null));
    from.mockReturnValueOnce(guardedUpdate).mockReturnValueOnce(fallbackRead);

    const res = await request(appWith(signedInAs(ROLE.EVENT_COORDINATOR, OTHER_USER_ID)))
      .patch(`/api/notifications/${NOTIFICATION_ID}/read?recipientId=${COORDINATOR_ID}`)
      .send({ recipientId: COORDINATOR_ID });

    expect(res.status).toBe(404);
    expect(guardedUpdate.called('update')).toBe(true);
    for (const stub of [guardedUpdate, fallbackRead]) {
      const recipientFilters = stub.allArgs('eq').filter(([column]) => column === 'recipient_id');
      expect(recipientFilters).toEqual([['recipient_id', OTHER_USER_ID]]);
    }
  });

  it('SCRUM17_AC3_an_untyped_error_is_a_generic_500', async () => {
    from.mockReturnValue(queryStub(fail({ code: '57014', message: 'statement timeout' })));

    const res = await request(appWith()).patch(`/api/notifications/${NOTIFICATION_ID}/read`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Unexpected server error' });
    expect(consoleError).toHaveBeenCalled();
  });

  it('a GET on the read path is not routed', async () => {
    const res = await request(appWith()).get(`/api/notifications/${NOTIFICATION_ID}/read`);
    expect(res.status).toBe(404);
    expect(from).not.toHaveBeenCalled();
  });

  it('there is no route to create or delete a notification', async () => {
    const post = await request(appWith()).post('/api/notifications').send({});
    const del = await request(appWith()).delete(`/api/notifications/${NOTIFICATION_ID}`);

    expect(post.status).toBe(404);
    expect(del.status).toBe(404);
    expect(from).not.toHaveBeenCalled();
  });
});


describe('no role gate', () => {
  it.each(Object.values(ROLE))('SCRUM17_AC3_a_%s_can_read_their_own_inbox', async (role) => {
    from.mockReturnValue(queryStub(ok([])));

    const res = await request(appWith(signedInAs(role))).get('/api/notifications');

    expect(res.status).toBe(200);
  });

  it.each(Object.values(ROLE))('a %s can mark their own notification read', async (role) => {
    from.mockReturnValue(queryStub(ok(notificationRow({ read_at: FIRST_READ }))));

    const res = await request(appWith(signedInAs(role))).patch(
      `/api/notifications/${NOTIFICATION_ID}/read`,
    );

    expect(res.status).toBe(200);
  });
});
