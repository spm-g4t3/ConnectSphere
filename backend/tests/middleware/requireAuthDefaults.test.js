/**
 * The default verifier and role loader behind the mounted requireAuth.
 *
 * requireAuth.test.js injects both, so the code that actually talks to Supabase
 * is exercised here instead, over a mocked supabaseClient.js. The mock lives in
 * its own file so it cannot leak into the suite that proves the middleware
 * loads without credentials.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fake = vi.hoisted(() => ({
  getUser: null,
  profile: null,
  calls: [],
}));

vi.mock('../../src/config/supabaseClient.js', () => ({
  supabaseAdmin: {
    auth: {
      getUser: async (token) => {
        fake.calls.push(['getUser', token]);
        return fake.getUser;
      },
    },
    from(table) {
      fake.calls.push(['from', table]);
      const chain = {
        select(cols) { fake.calls.push(['select', cols]); return chain; },
        eq(col, val) { fake.calls.push(['eq', col, val]); return chain; },
        async maybeSingle() { fake.calls.push(['maybeSingle']); return fake.profile; },
      };
      return chain;
    },
  },
}));

import { requireAuth } from '../../src/middleware/requireAuth.js';

const USER = { id: 'user-1', email: 'organiser@example.com', user_metadata: { role: 'lead' } };

function createFakeResponse() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; return res; },
  };
  return res;
}

async function run(token = 'jwt-abc') {
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = createFakeResponse();
  const next = vi.fn();
  await requireAuth(req, res, next);
  return { req, res, next };
}

beforeEach(() => {
  fake.calls = [];
  fake.getUser = { data: { user: USER }, error: null };
  fake.profile = { data: { role: 'event_organiser' }, error: null };
});

describe('SCRUM-14 AC1: the default verifier asks Supabase about the token', () => {
  it('SCRUM14_AC1_default_verifier_refuses_a_token_supabase_rejects', async () => {
    fake.getUser = { data: { user: null }, error: { code: 'bad_jwt', message: 'invalid JWT' } };

    const { res, next } = await run();

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Your session is no longer valid' });
    expect(next).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([['getUser', 'jwt-abc']]);
  });

  it('SCRUM14_AC1_default_verifier_refuses_when_supabase_returns_no_user', async () => {
    fake.getUser = { data: null, error: null };

    const { res, next } = await run();

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Your session is no longer valid' });
    expect(next).not.toHaveBeenCalled();
  });

  it('SCRUM14_AC1_default_verifier_passes_the_verified_user_on', async () => {
    const { req, next } = await run('  jwt-xyz  ');

    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toEqual({ id: 'user-1', email: 'organiser@example.com', role: 'event_organiser' });
    expect(fake.calls[0]).toEqual(['getUser', 'jwt-xyz']);
  });
});

describe('SCRUM-15 AC2: the default role loader reads profiles', () => {
  it('SCRUM15_AC2_default_role_loader_reads_the_role_by_user_id_from_profiles', async () => {
    const { req } = await run();

    expect(fake.calls.slice(1)).toEqual([
      ['from', 'profiles'],
      ['select', 'role'],
      ['eq', 'id', 'user-1'],
      ['maybeSingle'],
    ]);
    expect(req.user.role).toBe('event_organiser');
  });

  it('SCRUM15_AC2_default_role_loader_error_answers_500', async () => {
    fake.profile = { data: null, error: { code: '08006', message: 'connection failure' } };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { res, next } = await run();

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Unexpected server error' });
    expect(next).not.toHaveBeenCalled();
    expect(spy.mock.calls[0][1]).toEqual({ code: '08006', message: 'connection failure' });
    spy.mockRestore();
  });

  it('SCRUM15_AC2_default_role_loader_missing_profile_answers_403', async () => {
    fake.profile = { data: null, error: null };

    const { res, next } = await run();

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Your account has no role assigned' });
    expect(next).not.toHaveBeenCalled();
  });

  it('SCRUM15_AC2_default_role_loader_profile_without_a_role_answers_403', async () => {
    // A null role column; the profiles table should not allow it, but the guard holds.
    fake.profile = { data: { role: null }, error: null };

    const { res } = await run();

    expect(res.statusCode).toBe(403);
  });
});
