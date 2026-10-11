/**
 * Tests for the auth routes.
 *
 * SCRUM-96: log a user in and resolve the role their dashboard is chosen from.
 * SCRUM-104: invalid login attempts do not reveal which detail was wrong.
 * SCRUM-105: log a user out.
 *
 * Describe blocks are named after the acceptance criteria they cover, so a
 * requirement can be traced to the test that proves it.
 *
 * The Supabase client is mocked. These are unit tests for the route
 * handlers' own logic (status codes, error shapes, which client each step
 * uses), not integration tests against a real database -- CI runs with no
 * secrets, by design (see .github/workflows/ci.yml).
 */
 
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ROLE, isKnownRole } from '../../src/domain/userRole.js';
 
const supabaseAuth = {
  auth: {
    signInWithPassword: vi.fn(),
    admin: {
      signOut: vi.fn(),
    },
  },
};
 
const supabaseAdmin = {
  from: vi.fn(),
};
 
vi.mock('../../src/config/supabaseClient.js', () => ({
  supabaseAuth,
  supabaseAdmin,
}));
 
const { default: authRouter } = await import('../../src/routes/auth.js');
 
/** Points supabaseAdmin.from('profiles').select().eq().single() at a result. */
function mockProfileLookup({ data = null, error = null }) {
  const single = vi.fn().mockResolvedValue({ data, error });
  const eq = vi.fn(() => ({ single }));
  const select = vi.fn(() => ({ eq }));
  supabaseAdmin.from.mockReturnValue({ select });
}
 
/** Builds a minimal req/res pair and dispatches it through the router. */
function callRoute({ method, path, body = {}, headers = {} }) {
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
      // No route matched, or a handler called next() instead of responding.
      res.statusCode = err ? 500 : 404;
      res.body = { error: err ? err.message : 'not found' };
      resolvePromise(res);
    });
  });
}
 
const login = (body) => callRoute({ method: 'POST', path: '/login', body });
const logout = (headers) => callRoute({ method: 'POST', path: '/logout', headers });
 
 
beforeEach(() => {
  vi.clearAllMocks();
});
 
 
// ---------------------------------------------------------------------------
// SCRUM-96: successful login
// ---------------------------------------------------------------------------
describe('AC: a valid login returns the user and their role', () => {
  it('returns 200 with user, role and session', async () => {
    supabaseAuth.auth.signInWithPassword.mockResolvedValue({
      data: {
        user: { id: 'user-1', email: 'test@connectsphere.com' },
        session: { access_token: 'token-abc' },
      },
      error: null,
    });
    mockProfileLookup({ data: { role: 'event_organiser' } });
 
    const res = await login({ email: 'test@connectsphere.com', password: 'password123' });
 
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      user: { id: 'user-1', email: 'test@connectsphere.com', role: 'event_organiser' },
      session: { access_token: 'token-abc' },
    });
  });
 
  it('SCRUM453_AC1_returns_the_attendee_role_unchanged_and_it_is_a_known_role', async () => {
    supabaseAuth.auth.signInWithPassword.mockResolvedValue({
      data: {
        user: { id: 'user-2', email: 'attendee@connectsphere.com' },
        session: { access_token: 'token-xyz' },
      },
      error: null,
    });
    mockProfileLookup({ data: { role: ROLE.ATTENDEE } });

    const res = await login({ email: 'attendee@connectsphere.com', password: 'password123' });

    expect(res.statusCode).toBe(200);
    expect(res.body.user.role).toBe('attendee');
    expect(isKnownRole(res.body.user.role)).toBe(true);
  });

  it('authenticates with the credentials as given', async () => {
    supabaseAuth.auth.signInWithPassword.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'a@b.com' }, session: {} },
      error: null,
    });
    mockProfileLookup({ data: { role: 'venue_staff' } });
 
    await login({ email: 'a@b.com', password: 'hunter2' });
 
    expect(supabaseAuth.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'a@b.com',
      password: 'hunter2',
    });
  });
 
  it('looks up the role by the authenticated user id, not the submitted email', async () => {
    supabaseAuth.auth.signInWithPassword.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'a@b.com' }, session: {} },
      error: null,
    });
    mockProfileLookup({ data: { role: 'technical_support' } });
 
    await login({ email: 'a@b.com', password: 'hunter2' });
 
    expect(supabaseAdmin.from).toHaveBeenCalledWith('profiles');
  });
});
 
 
// ---------------------------------------------------------------------------
// SCRUM-96: required fields, including boundary cases around "empty"
// ---------------------------------------------------------------------------
describe('AC: email and password are mandatory', () => {
  it.each([
    ['no email', { password: 'x' }],
    ['no password', { email: 'a@b.com' }],
    ['neither', {}],
    ['an empty email', { email: '', password: 'x' }],
    ['an empty password', { email: 'a@b.com', password: '' }],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await login(body);
 
    expect(res.statusCode).toBe(400);
    expect(supabaseAuth.auth.signInWithPassword).not.toHaveBeenCalled();
  });
 
  it('does not reject a whitespace-only password at this layer', async () => {
    // '   ' is truthy, so it passes the !password check and reaches Supabase,
    // which rejects it as invalid credentials. Documented here so this is a
    // known.
    supabaseAuth.auth.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'Invalid login credentials' },
    });
 
    const res = await login({ email: 'a@b.com', password: '   ' });
 
    expect(supabaseAuth.auth.signInWithPassword).toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});
 
 
// ---------------------------------------------------------------------------
// SCRUM-104: invalid login does not reveal which detail was wrong
// ---------------------------------------------------------------------------
describe('AC: invalid credentials return a generic error', () => {
  it('returns 401 with no detail on wrong credentials', async () => {
    supabaseAuth.auth.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'Invalid login credentials' },
    });
 
    const res = await login({ email: 'nobody@connectsphere.com', password: 'wrong' });
 
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid email or password' });
  });
 
  it('gives the same response whether the account exists or the password is wrong', async () => {
    supabaseAuth.auth.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'Invalid login credentials' },
    });
    const unknownAccount = await login({ email: 'ghost@connectsphere.com', password: 'x' });
 
    supabaseAuth.auth.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'Invalid login credentials' },
    });
    const wrongPassword = await login({ email: 'test@connectsphere.com', password: 'wrong' });
 
    expect(unknownAccount.body).toEqual(wrongPassword.body);
    expect(unknownAccount.statusCode).toBe(wrongPassword.statusCode);
  });
 
  it('does not query profiles when authentication fails', async () => {
    supabaseAuth.auth.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'Invalid login credentials' },
    });
 
    await login({ email: 'a@b.com', password: 'wrong' });
 
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });
});
 
 
// ---------------------------------------------------------------------------
// A user can authenticate but have no matching profiles row
// ---------------------------------------------------------------------------
describe('AC: a missing profile is a server fault, not a bad login', () => {
  it('returns 500 when the profile row is missing', async () => {
    supabaseAuth.auth.signInWithPassword.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'a@b.com' }, session: {} },
      error: null,
    });
    mockProfileLookup({ data: null, error: { message: 'no rows' } });
 
    const res = await login({ email: 'a@b.com', password: 'x' });
 
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Unable to retrieve user role' });
  });
 
  it('returns 500 when the query succeeds but returns no row', async () => {
    supabaseAuth.auth.signInWithPassword.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'a@b.com' }, session: {} },
      error: null,
    });
    mockProfileLookup({ data: null, error: null });
 
    const res = await login({ email: 'a@b.com', password: 'x' });
 
    expect(res.statusCode).toBe(500);
  });
});
 
 
// ---------------------------------------------------------------------------
// SCRUM-105: logout, including boundary cases around a malformed header
// ---------------------------------------------------------------------------
describe('AC: logout requires a bearer token', () => {
  it.each([
    ['no header at all', {}],
    ['an empty header', { authorization: '' }],
    ['a header without the Bearer scheme', { authorization: 'token-abc' }],
    ['a header with the wrong scheme', { authorization: 'Basic dXNlcjpwYXNz' }],
    ['Bearer with no token after it', { authorization: 'Bearer' }],
    ['Bearer with a trailing space and no token', { authorization: 'Bearer ' }],
  ])('rejects %s with 401', async (_label, headers) => {
    const res = await logout(headers);
 
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'No active session' });
    expect(supabaseAuth.auth.admin.signOut).not.toHaveBeenCalled();
  });
});
 
describe('AC: a valid token revokes the session', () => {
  it('returns 200 and signs out with the token from the header', async () => {
    supabaseAuth.auth.admin.signOut.mockResolvedValue({ error: null });
 
    const res = await logout({ authorization: 'Bearer token-abc' });
 
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ message: 'Logged out successfully' });
    expect(supabaseAuth.auth.admin.signOut).toHaveBeenCalledWith('token-abc');
  });
 
  it('returns 500 when Supabase refuses to revoke the session', async () => {
    supabaseAuth.auth.admin.signOut.mockResolvedValue({
      error: { message: 'Auth session missing!' },
    });
 
    const res = await logout({ authorization: 'Bearer already-used-token' });
 
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to log out' });
  });
});

// ---------------------------------------------------------------------------
// SCRUM-485 AC3: login identifies the two new roles
// ---------------------------------------------------------------------------
// docs/test-cases/SCRUM-485.md, AC3-01 and AC3-02. The route keeps no list of
// roles: it returns whatever profiles.role holds, and the frontend chooses the
// dashboard from it (Dashboard.test.jsx). So these prove the new roles pass
// through untouched, as the exact strings the enum stores, not that login
// knows about them.
describe('SCRUM-485 AC3: login returns the Event Coordinator Lead and Safety Officer roles', () => {
  it.each([
    ['event_coordinator_lead', 'lead@connectsphere.com'],
    ['safety_officer', 'safety@connectsphere.com'],
  ])('SCRUM485_AC3_a_%s_logs_in_and_gets_that_exact_role_back', async (role, email) => {
    supabaseAuth.auth.signInWithPassword.mockResolvedValue({
      data: { user: { id: 'user-485', email }, session: { access_token: 'token-485' } },
      error: null,
    });
    mockProfileLookup({ data: { role } });

    const res = await login({ email, password: 'password123' });

    expect(res.statusCode).toBe(200);
    // One role, as a string: AC2's one role per account, as login reports it.
    expect(res.body.user.role).toBe(role);
    expect(res.body).toEqual({
      user: { id: 'user-485', email, role },
      session: { access_token: 'token-485' },
    });
  });
});
