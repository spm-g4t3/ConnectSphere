import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { signedOut } from '../fixtures/auth.js';

vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: {}, supabaseAdmin: {} }));

const { createSafetyReviewRouter } = await import('../../src/routes/safetyReviews.js');
const { ROLE } = await import('../../src/domain/userRole.js');

const EVENT_ID = '11111111-1111-4111-8111-111111111111';

const signedInAs = (role, id = '22222222-2222-4222-8222-222222222222') => (req, _res, next) => {
  req.user = { id, role };
  next();
};

function appWith(client, auth = signedInAs(ROLE.SAFETY_OFFICER)) {
  return express()
    .use(express.json())
    .use('/api/safety-reviews', createSafetyReviewRouter({ client, requireAuth: auth }));
}

function fakeClient() {
  return {
    rpc: vi.fn(async (name) => {
      if (name === 'safety_review_queue' || name === 'safety_review_history') return { data: [], error: null };
      if (name === 'safety_review_detail') return { data: { event: { id: EVENT_ID }, history: [] }, error: null };
      return { data: { outcome: 'approved' }, error: null };
    }),
  };
}

const routes = [
  ['lists', (app) => request(app).get('/api/safety-reviews')],
  ['reads history', (app) => request(app).get('/api/safety-reviews/history')],
  ['reads details', (app) => request(app).get(`/api/safety-reviews/${EVENT_ID}`)],
  ['responds', (app) => request(app).post(`/api/safety-reviews/${EVENT_ID}/responses`).send({ outcome: 'approved' })],
];

describe('Safety Officer route authorization', () => {
  it.each(
    [
      ROLE.EVENT_ORGANISER,
      ROLE.EVENT_COORDINATOR,
      ROLE.VENUE_STAFF,
      ROLE.TECHNICAL_SUPPORT_STAFF,
      ROLE.ATTENDEE,
      ROLE.EVENT_COORDINATOR_LEAD,
    ].flatMap((role) => routes.map(([action, call]) => [role, action, call])),
  )('refuses %s who %s before database access', async (role, _action, call) => {
    const db = fakeClient();

    const response = await call(appWith(db, signedInAs(role)));

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/Safety Officers/);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it.each(routes)('refuses a signed-out caller who %s', async (_action, call) => {
    const db = fakeClient();

    const response = await call(appWith(db, signedOut));

    expect(response.status).toBe(401);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('serves the history list ahead of the event id route', async () => {
    const db = fakeClient();

    const response = await request(appWith(db)).get('/api/safety-reviews/history');

    expect(response.status).toBe(200);
    expect(db.rpc.mock.calls).toEqual([['safety_review_history', { p_caller: '22222222-2222-4222-8222-222222222222' }]]);
  });

  it('lets a Safety Officer read the queue and focused detail', async () => {
    const db = fakeClient();
    const app = appWith(db);

    expect((await request(app).get('/api/safety-reviews')).status).toBe(200);
    expect((await request(app).get(`/api/safety-reviews/${EVENT_ID}`)).status).toBe(200);
    // The functions check the caller too (011), so each read names the session's officer.
    expect(db.rpc.mock.calls).toEqual([
      ['safety_review_queue', { p_caller: '22222222-2222-4222-8222-222222222222' }],
      ['safety_review_detail', { p_event_request_id: EVENT_ID, p_caller: '22222222-2222-4222-8222-222222222222' }],
    ]);
  });

  it('never accepts the acting officer id from the response body', async () => {
    const db = fakeClient();

    const response = await request(appWith(db))
      .post(`/api/safety-reviews/${EVENT_ID}/responses`)
      .send({ outcome: 'approved', safetyOfficerId: '99999999-9999-4999-8999-999999999999' });

    expect(response.status).toBe(200);
    expect(db.rpc).toHaveBeenCalledWith('respond_to_safety_review', expect.objectContaining({
      p_safety_officer_id: '22222222-2222-4222-8222-222222222222',
    }));
  });
});
