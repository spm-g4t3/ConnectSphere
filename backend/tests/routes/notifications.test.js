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

import {
  COORDINATOR_ID,
  NOTIFICATION_ID,
  FIRST_READ,
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

const { createNotificationRouter, default: defaultRouter } = await import(
  '../../src/routes/notifications.js'
);
const { supabase } = await import('../../src/config/supabaseClient.js');
const { ROLE } = await import('../../src/domain/userRole.js');


const OTHER_USER_ID = '11111111-1111-4111-8111-111111111111';

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
      `/api/notifications?recipientId=${COORDINATOR_ID}`,
    );

    expect(stub.allArgs('eq')).toEqual([['recipient_id', OTHER_USER_ID]]);
  });

  it('SCRUM17_AC3_answers_200_with_an_empty_array_when_there_are_none', async () => {
    from.mockReturnValue(queryStub(ok([])));

    const res = await request(appWith()).get('/api/notifications');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
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


describe('untyped database errors', () => {
  it.each([
    ['SCRUM17_AC3', 'GET /api/notifications', (agent) => agent.get('/api/notifications'),
      { code: '08006', message: 'secret internals' }],
    ['SCRUM172_AC4', 'GET /api/notifications/unread-count',
      (agent) => agent.get('/api/notifications/unread-count'),
      { code: '08006', message: 'secret internals' }],
    ['SCRUM17_AC3', 'PATCH /api/notifications/:id/read',
      (agent) => agent.patch(`/api/notifications/${NOTIFICATION_ID}/read`),
      { code: '57014', message: 'statement timeout' }],
  ])('%s_an_untyped_error_is_a_generic_500 (%s)', async (_story, _label, send, error) => {
    from.mockReturnValue(queryStub(fail(error)));

    const res = await send(request(appWith()));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Unexpected server error' });
    expect(JSON.stringify(res.body)).not.toContain(error.message);
    expect(consoleError).toHaveBeenCalled();
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
