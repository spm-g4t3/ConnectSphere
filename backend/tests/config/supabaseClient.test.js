/**
 * Tests for the shared Supabase client.
 *
 * SCRUM-90: connect the API to Supabase.
 *
 * The module's value is its fail-fast guard: it refuses to build a client from
 * a half-configured environment, so a missing .env is reported as a missing
 * .env rather than as a network or auth error on the first query. Every other
 * test file in this repo mocks this module away, which is exactly why nothing
 * else exercises that guard.
 *
 * Each case re-imports the module from scratch -- it runs its checks once, at
 * import -- so vi.resetModules() and a dynamic import are unavoidable here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { createClient } = vi.hoisted(() => ({
  createClient: vi.fn(() => ({ isAStubClient: true })),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient }));

const MODULE = '../../src/config/supabaseClient.js';
const URL = 'https://example.supabase.co';
const SECRET = 'sb_secret_example';

/** Re-evaluate the module with the environment as it stands right now. */
async function importFresh() {
  vi.resetModules();
  return import(MODULE);
}

beforeEach(() => {
  createClient.mockClear();
  // dotenv does not overwrite a variable that is already set, so stubbing
  // these is enough to control the module without mocking dotenv itself.
  vi.stubEnv('SUPABASE_URL', URL);
  vi.stubEnv('SUPABASE_SECRET_KEY', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});


// ---------------------------------------------------------------------------
// SCRUM-90: a half-configured environment fails at import, not at first query
// ---------------------------------------------------------------------------
describe('the environment guard', () => {
  it.each([
    ['SUPABASE_URL', 'SUPABASE_URL'],
    ['SUPABASE_SECRET_KEY', 'SUPABASE_SECRET_KEY'],
  ])('refuses to load when %s is missing', async (_label, variable) => {
    vi.stubEnv(variable, '');

    await expect(importFresh()).rejects.toThrow(variable);
  });

  it.each(['SUPABASE_URL', 'SUPABASE_SECRET_KEY'])(
    'tells you how to fix a missing %s',
    async (variable) => {
      // The message exists so that the first thing a new teammate sees names
      // the file to copy, not a TypeError from deep inside the driver.
      vi.stubEnv(variable, '');

      await expect(importFresh()).rejects.toThrow(/\.env\.example/);
    },
  );

  it('never builds a client from an incomplete environment', async () => {
    vi.stubEnv('SUPABASE_SECRET_KEY', '');

    await expect(importFresh()).rejects.toThrow();
    expect(createClient).not.toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// SCRUM-90: what a correctly configured client looks like
// ---------------------------------------------------------------------------
describe('the configured client', () => {
  it('is built from the environment', async () => {
    await importFresh();

    expect(createClient).toHaveBeenCalledWith(URL, SECRET, expect.any(Object));
  });

  it('does not persist a session', async () => {
    // This is a server, not a browser. A persisted session would outlive the
    // request that created it and be reused for the next caller.
    await importFresh();

    expect(createClient.mock.calls[0][2].auth.persistSession).toBe(false);
  });

  it('does not refresh tokens', async () => {
    // There is no signed-in user to refresh; every request authenticates with
    // the secret key.
    await importFresh();

    expect(createClient.mock.calls[0][2].auth.autoRefreshToken).toBe(false);
  });

  it('creates one client per role, however it is imported', async () => {
    const module = await importFresh();

    // Two, not one: supabaseAuth for sign-in and sign-out, supabaseAdmin for
    // privileged queries (SCRUM-96/SCRUM-105). They must stay separate --
    // signInWithPassword sets a client's in-memory auth state to that user for
    // the rest of the process, so a shared client would run later privileged
    // queries as the logged-in user, subject to the row level security the
    // secret key exists to bypass, and silently return nothing.
    expect(createClient).toHaveBeenCalledTimes(2);

    // What "exactly once" was really guarding: importing the module twice does
    // not build a second pair, and the `supabase` alias is not a third client.
    expect(module.supabase).toBe(module.default);
    expect(module.supabase).toBe(module.supabaseAdmin);
    expect(module.supabaseAdmin).not.toBe(module.supabaseAuth);
  });
});
