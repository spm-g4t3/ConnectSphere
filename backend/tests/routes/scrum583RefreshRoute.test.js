/**
 * Tests for POST /api/auth/refresh.
 *
 * SCRUM-583 AC2: a user who is still working has their session renewed before
 * it expires. This is the server half: swap a refresh token for a new session,
 * and tell "this session is over" (401) apart from "could not ask right now"
 * (503), because the frontend signs the user out on the first and keeps the
 * session on the second.
 *
 * The Supabase client is mocked, as in auth.test.js: these test the handler's
 * own decisions, not Supabase.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const supabaseAuth = {
  auth: {
    signInWithPassword: vi.fn(),
    refreshSession: vi.fn(),
    admin: { signOut: vi.fn() },
  },
};
const supabaseAdmin = { from: vi.fn() };

vi.mock('../../src/config/supabaseClient.js', () => ({ supabaseAuth, supabaseAdmin }));

const { default: authRouter } = await import('../../src/routes/auth.js');

function callRoute({ method = 'POST', path, body = {}, headers = {} }) {
  const req = { method, url: path, body, headers };

  return new Promise((resolvePromise) => {
    const res = {
      statusCode: 200,
      body: undefined,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        resolvePromise(this);
      },
    };

    authRouter(req, res, (err) => {
      res.statusCode = err ? 500 : 404;
      res.body = { error: err ? err.message : 'not found' };
      resolvePromise(res);
    });
  });
}

const refresh = (body) => callRoute({ path: '/refresh', body });

const NEW_SESSION = {
  access_token: 'new-access',
  refresh_token: 'new-refresh',
  expires_in: 3600,
  expires_at: 1_900_000_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('SCRUM583_AC2 a valid refresh token returns the new session', () => {
  it('SCRUM583_AC2_returns_200_with_the_new_session_and_nothing_else', async () => {
    supabaseAuth.auth.refreshSession.mockResolvedValue({
      data: { session: NEW_SESSION, user: { id: 'u1' } },
      error: null,
    });

    const res = await refresh({ refresh_token: 'old-refresh' });

    expect(res.statusCode).toBe(200);
    // The user is not echoed: the frontend keeps the one login gave it, and
    // that includes the role this route does not look up.
    expect(res.body).toEqual({ session: NEW_SESSION });
  });

  it('SCRUM583_AC2_asks_supabase_with_exactly_the_token_it_was_given', async () => {
    supabaseAuth.auth.refreshSession.mockResolvedValue({
      data: { session: NEW_SESSION },
      error: null,
    });

    await refresh({ refresh_token: 'old-refresh' });

    expect(supabaseAuth.auth.refreshSession).toHaveBeenCalledTimes(1);
    expect(supabaseAuth.auth.refreshSession).toHaveBeenCalledWith({ refresh_token: 'old-refresh' });
  });

  it('SCRUM583_AC2_needs_no_authorization_header_because_the_access_token_may_be_dead', async () => {
    supabaseAuth.auth.refreshSession.mockResolvedValue({
      data: { session: NEW_SESSION },
      error: null,
    });

    const res = await callRoute({ path: '/refresh', body: { refresh_token: 'r' }, headers: {} });

    expect(res.statusCode).toBe(200);
  });

  it('SCRUM583_AC2_does_not_touch_the_profiles_table', async () => {
    supabaseAuth.auth.refreshSession.mockResolvedValue({
      data: { session: NEW_SESSION },
      error: null,
    });

    await refresh({ refresh_token: 'r' });

    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });
});

describe('SCRUM583_AC2 a missing or malformed refresh token is a 400 and never reaches Supabase', () => {
  it.each([
    ['no body field', {}],
    ['null', { refresh_token: null }],
    ['an empty string', { refresh_token: '' }],
    ['whitespace only', { refresh_token: '   ' }],
    ['a number', { refresh_token: 123 }],
    ['an object', { refresh_token: { token: 'x' } }],
    ['an array', { refresh_token: ['x'] }],
    ['true', { refresh_token: true }],
  ])('SCRUM583_AC2_rejects_%s', async (_label, body) => {
    const res = await refresh(body);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'A refresh token is required' });
    expect(supabaseAuth.auth.refreshSession).not.toHaveBeenCalled();
  });

  it('SCRUM583_AC2_rejects_a_request_with_no_body_at_all', async () => {
    const res = await callRoute({ path: '/refresh', body: undefined });

    expect(res.statusCode).toBe(400);
    expect(supabaseAuth.auth.refreshSession).not.toHaveBeenCalled();
  });
});

describe('SCRUM583_AC2 a refused refresh token means the session is over (401)', () => {
  it.each([
    ['refresh_token_not_found', { name: 'AuthApiError', status: 400, message: 'Invalid Refresh Token: Refresh Token Not Found' }],
    ['refresh_token_already_used', { name: 'AuthApiError', status: 400, message: 'Invalid Refresh Token: Already Used' }],
    ['session_not_found', { name: 'AuthApiError', status: 401, message: 'Session not found' }],
    ['forbidden', { name: 'AuthApiError', status: 403, message: 'forbidden' }],
    ['the lowest 4xx', { name: 'AuthApiError', status: 400, message: 'x' }],
    ['the highest 4xx below 500', { name: 'AuthApiError', status: 499, message: 'x' }],
  ])('SCRUM583_AC2_answers_401_for_%s', async (_label, error) => {
    supabaseAuth.auth.refreshSession.mockResolvedValue({ data: { session: null }, error });

    const res = await refresh({ refresh_token: 'dead' });

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Your session is no longer valid' });
  });

  it('SCRUM583_AC2_answers_401_when_supabase_says_ok_but_returns_no_session', async () => {
    supabaseAuth.auth.refreshSession.mockResolvedValue({ data: { session: null }, error: null });

    const res = await refresh({ refresh_token: 'odd' });

    expect(res.statusCode).toBe(401);
  });

  it('SCRUM583_AC2_answers_401_when_supabase_returns_no_data_at_all', async () => {
    supabaseAuth.auth.refreshSession.mockResolvedValue({ data: null, error: null });

    const res = await refresh({ refresh_token: 'odd' });

    expect(res.statusCode).toBe(401);
  });
});

describe('SCRUM583_AC2 a failure to ask Supabase is a 503, not a verdict on the session', () => {
  it.each([
    ['a network failure (retryable, status 0)', { name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed' }],
    ['a retryable error that carries a 4xx', { name: 'AuthRetryableFetchError', status: 400, message: 'x' }],
    ['a 500', { name: 'AuthApiError', status: 500, message: 'boom' }],
    ['a 502', { name: 'AuthApiError', status: 502, message: 'bad gateway' }],
    ['a 429 rate limit', { name: 'AuthApiError', status: 429, message: 'slow down' }],
    ['an error with no status', { name: 'Error', message: 'who knows' }],
    ['status 399, below any 4xx', { name: 'AuthApiError', status: 399, message: 'x' }],
  ])('SCRUM583_AC2_answers_503_for_%s', async (_label, error) => {
    supabaseAuth.auth.refreshSession.mockResolvedValue({ data: { session: null }, error });

    const res = await refresh({ refresh_token: 'maybe-fine' });

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'Unable to renew the session right now' });
  });

  it('SCRUM583_AC2_answers_503_when_the_call_throws', async () => {
    supabaseAuth.auth.refreshSession.mockRejectedValue(new Error('socket hang up'));

    const res = await refresh({ refresh_token: 'maybe-fine' });

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'Unable to renew the session right now' });
  });

  it('SCRUM583_AC2_logs_the_reason_server_side_but_does_not_put_it_in_the_response', async () => {
    supabaseAuth.auth.refreshSession.mockResolvedValue({
      data: { session: null },
      error: { name: 'AuthApiError', status: 500, message: 'internal detail' },
    });

    const res = await refresh({ refresh_token: 'x' });

    expect(console.error).toHaveBeenCalledWith('Session renewal failed:', 'internal detail');
    expect(JSON.stringify(res.body)).not.toContain('internal detail');
  });

  it('SCRUM583_AC2_does_not_log_the_refresh_token', async () => {
    supabaseAuth.auth.refreshSession.mockRejectedValue(new Error('socket hang up'));

    await refresh({ refresh_token: 'super-secret-refresh' });

    expect(JSON.stringify(console.error.mock.calls)).not.toContain('super-secret-refresh');
  });
});

describe('SCRUM583_AC1 the existing routes are unchanged', () => {
  it('SCRUM583_AC1_a_wrong_password_is_still_a_401_with_the_login_message', async () => {
    supabaseAuth.auth.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'Invalid login credentials' },
    });

    const res = await callRoute({ path: '/login', body: { email: 'a@b.com', password: 'wrong' } });

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid email or password' });
  });

  it('SCRUM583_AC4_logout_still_revokes_the_session_with_the_bearer_token', async () => {
    supabaseAuth.auth.admin.signOut.mockResolvedValue({ error: null });

    const res = await callRoute({ path: '/logout', headers: { authorization: 'Bearer abc' } });

    expect(res.statusCode).toBe(200);
    expect(supabaseAuth.auth.admin.signOut).toHaveBeenCalledWith('abc');
  });

  it('SCRUM583_AC2_refresh_only_answers_POST', async () => {
    const res = await callRoute({ method: 'GET', path: '/refresh' });

    expect(res.statusCode).toBe(404);
  });
});
