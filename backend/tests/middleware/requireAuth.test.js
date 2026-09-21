/**
 * Tests for the authentication middleware.
 *
 * SCRUM-42, a subtask of SCRUM-14 (Track Event Request Status).
 *
 * AC1 says the Event Organiser can view the status of *their* request. There
 * is no id in the path of GET /api/event-requests, so the only thing that can
 * answer "whose?" is the token. That makes this middleware part of the
 * acceptance criterion rather than infrastructure sitting beside it, which is
 * why its tests are named after AC1.
 *
 * Why this file runs without a .env: the same reason the service tests do.
 * src/config/supabaseClient.js throws at import time when its environment is
 * missing, so requireAuth resolves it with a dynamic import reached only when
 * no verifier was injected. Every test below injects one. The static import a
 * few lines down is itself the assertion -- if the middleware reached for
 * supabaseClient.js eagerly, this suite would not even collect.
 */

import { describe, it, expect, vi } from 'vitest';

import { createRequireAuth } from '../../src/middleware/requireAuth.js';


// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------
/** A request with whatever headers a test cares about, and nothing else. */
const req = (headers = {}, rest = {}) => ({ headers, ...rest });

/**
 * A response that records rather than sends.
 *
 * status() returns `this` because Express chains it into json(), and a double
 * that broke the chain would fail for a reason that has nothing to do with the
 * middleware under test.
 */
function createFakeResponse() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

/** A verifier that answers with one user, and records what it was asked. */
function createFakeVerifier(user) {
  const tokens = [];
  const verifyToken = async (token) => {
    tokens.push(token);
    return user;
  };
  return { verifyToken, tokens };
}


describe('AC1: only a signed-in caller reaches the data', () => {
  it('SCRUM14_AC1_refuses_a_request_with_no_authorization_header', async () => {
    const { verifyToken, tokens } = createFakeVerifier({ id: 'u1' });
    const res = createFakeResponse();
    const next = vi.fn();

    await createRequireAuth({ verifyToken })(req(), res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
    expect(next).not.toHaveBeenCalled();

    // Not merely rejected -- rejected without asking Supabase. A missing header
    // is answerable locally, and a round trip per anonymous request would be a
    // free amplifier for anyone pointing traffic at this endpoint.
    expect(tokens).toEqual([]);
  });

  it('SCRUM14_AC1_refuses_a_header_that_is_not_a_bearer_token', async () => {
    const { verifyToken, tokens } = createFakeVerifier({ id: 'u1' });
    const res = createFakeResponse();
    const next = vi.fn();

    await createRequireAuth({ verifyToken })(
      req({ authorization: 'Basic dXNlcjpwYXNz' }),
      res,
      next,
    );

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(tokens).toEqual([]);
  });

  it('SCRUM14_AC1_refuses_an_empty_bearer_token', async () => {
    const { verifyToken, tokens } = createFakeVerifier({ id: 'u1' });
    const res = createFakeResponse();
    const next = vi.fn();

    await createRequireAuth({ verifyToken })(
      req({ authorization: 'Bearer    ' }),
      res,
      next,
    );

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(tokens).toEqual([]);
  });

  it('SCRUM14_AC1_refuses_a_token_supabase_does_not_recognise', async () => {
    const res = createFakeResponse();
    const next = vi.fn();

    // The verifier answering null is how "Supabase looked and said no" arrives:
    // an expired session, a signed-out token, or a forgery.
    await createRequireAuth({ verifyToken: async () => null })(
      req({ authorization: 'Bearer expired.token.here' }),
      res,
      next,
    );

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Your session is no longer valid' });
    expect(next).not.toHaveBeenCalled();
  });

  it('SCRUM14_AC1_tells_a_missing_session_apart_from_a_rejected_one', async () => {
    const absent = createFakeResponse();
    const rejected = createFakeResponse();

    await createRequireAuth({ verifyToken: async () => null })(req(), absent, vi.fn());
    await createRequireAuth({ verifyToken: async () => null })(
      req({ authorization: 'Bearer expired.token.here' }),
      rejected,
      vi.fn(),
    );

    // Both are 401, but they mean different things to whoever is reading the
    // network tab: one says sign in, the other says sign in *again*.
    expect(absent.statusCode).toBe(401);
    expect(rejected.statusCode).toBe(401);
    expect(absent.body.error).not.toBe(rejected.body.error);
  });

  it('SCRUM14_AC1_puts_the_verified_user_on_the_request', async () => {
    const { verifyToken, tokens } = createFakeVerifier({
      id: 'organiser-1',
      email: 'organiser@example.com',
    });
    const request = req({ authorization: 'Bearer good.token.here' });
    const res = createFakeResponse();
    const next = vi.fn();

    await createRequireAuth({ verifyToken })(request, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(res.statusCode).toBeNull();
    expect(request.user).toEqual({ id: 'organiser-1', email: 'organiser@example.com' });

    // The scheme is stripped, so the verifier receives a token and not a header.
    expect(tokens).toEqual(['good.token.here']);
  });

  it('SCRUM14_AC1_copies_only_the_identity_it_needs_off_the_verified_user', async () => {
    const { verifyToken } = createFakeVerifier({
      id: 'organiser-1',
      email: 'organiser@example.com',
      app_metadata: { provider: 'email' },
      user_metadata: { nickname: 'Tez' },
    });
    const request = req({ authorization: 'Bearer good.token.here' });

    await createRequireAuth({ verifyToken })(request, createFakeResponse(), vi.fn());

    // Not the whole Supabase user object. Routes should not be able to reach
    // for a field this middleware never promised, and metadata is the caller's
    // to change -- putting it on req.user invites someone to authorise on it.
    expect(Object.keys(request.user).sort()).toEqual(['email', 'id']);
  });

  it('SCRUM14_AC1_never_trusts_a_user_id_sent_in_the_body_or_query', async () => {
    const { verifyToken } = createFakeVerifier({ id: 'organiser-1', email: 'a@b.c' });
    const request = req(
      { authorization: 'Bearer good.token.here' },
      {
        body: { organiserId: 'someone-else', userId: 'someone-else' },
        query: { organiserId: 'someone-else' },
      },
    );

    await createRequireAuth({ verifyToken })(request, createFakeResponse(), vi.fn());

    // The whole point of the middleware. A client may say whatever it likes;
    // identity comes from the token and nowhere else.
    expect(request.user.id).toBe('organiser-1');
  });

  it('SCRUM14_AC1_answers_500_rather_than_401_when_verification_itself_fails', async () => {
    const res = createFakeResponse();
    const next = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Supabase being unreachable is not the caller being unauthenticated.
    // Answering 401 would tell a signed-in Organiser to log in again, and
    // apiClient.js clears their session on a 401 -- so this distinction is the
    // difference between a blip and being thrown out of the application.
    await createRequireAuth({
      verifyToken: async () => {
        throw new Error('network is unreachable');
      },
    })(req({ authorization: 'Bearer good.token.here' }), res, next);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Unexpected server error' });
    expect(next).not.toHaveBeenCalled();

    // The driver message is logged for whoever is on call, never returned.
    expect(JSON.stringify(res.body)).not.toMatch(/unreachable/);
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });
});


describe('the middleware is loadable without credentials', () => {
  it('SCRUM14_AC1_imports_without_a_configured_supabase_client', async () => {
    // The regression guard. A static `import { supabaseAdmin }` in the
    // middleware would make this module -- and every route that mounts it --
    // throw at import time in CI, where there is no .env by design. If this
    // file collected at all, the import at the top already proved it; asserting
    // it explicitly is what stops someone "tidying" the dynamic import away.
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;

    const module = await import('../../src/middleware/requireAuth.js');

    expect(typeof module.createRequireAuth).toBe('function');
    expect(typeof module.default).toBe('function');
  });
});
