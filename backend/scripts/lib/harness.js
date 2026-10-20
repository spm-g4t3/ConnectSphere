/**
 * Helpers shared by the scripts/check-*.js live checks.
 *
 * Only what the scripts had copied word for word lives here. Each script still
 * owns its preflight, its cleanup order and its final verdict.
 */

import { supabase, supabaseAuth } from '../../src/config/supabaseClient.js';

/**
 * One run's pass/fail state. The object is returned rather than kept at module
 * level so each script's counter stays its own; scripts add to
 * harness.failures directly where a failure is not a check.
 */
export function createHarness() {
  const harness = {
    failures: 0,
    // For the cleanups that collect errors and report them as one check.
    cleanupErrors: [],

    check(label, passed, detail = '') {
      console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
      if (!passed) harness.failures += 1;
    },

    /** Prints what preflight found missing and fails, or records the schema as applied. */
    schemaApplied(missing) {
      if (missing.length > 0) {
        for (const line of missing) console.error(`  missing: ${line}`);
        console.error('\nThe database is missing part of the schema. Apply backend/db/baseline/01-09 (a fresh');
        console.error('project only), then each file in backend/db/migrations/ in order, in the Supabase SQL');
        console.error('Editor, then run this again.');
        harness.failures += 1;
        return false;
      }
      harness.check('the schema this check needs is applied', true);
      return true;
    },

    /** A cleanup step that fails the run on its own line and lets the rest go on. */
    async step(label, fn) {
      try {
        const result = await fn();
        if (result?.error) {
          console.error(`  cleanup: ${label} failed: ${result.error.message}`);
          harness.failures += 1;
        }
      } catch (err) {
        console.error(`  cleanup: ${label} failed: ${err.message}`);
        harness.failures += 1;
      }
    },

    /** A cleanup delete whose error is collected for checkCleanupErrors. */
    async remove(label, query) {
      const { error } = await query;
      if (error) harness.cleanupErrors.push(`${label}: ${error.message}`);
    },

    checkCleanupErrors() {
      harness.check('cleanup ran without errors', harness.cleanupErrors.length === 0, harness.cleanupErrors.join('; '));
    },

    /**
     * Profiles cascade from auth.users, but are deleted explicitly so a
     * failure surfaces as its own error.
     */
    async deleteTestUsers(users) {
      for (const [label, id] of Object.entries(users)) {
        if (!id) continue;
        await harness.step(`profile (${label})`, () => supabase.from('profiles').delete().eq('id', id));
        await harness.step(`auth user (${label})`, () => supabase.auth.admin.deleteUser(id));
      }
    },
  };
  return harness;
}

/**
 * Creates a throwaway auth user with a profile and returns the auth user.
 * requireAuth and the SQL caller checks read the role from profiles, so a
 * user without one would fail every check for the wrong reason.
 */
export async function createUserWithProfile({ email, password, label, role, users }) {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    ...(password ? { password } : {}),
    email_confirm: true,
  });
  if (error) throw new Error(`could not create test user (${label}): ${error.message}`);

  // Tracked before the profile insert, so cleanup removes the user even if
  // that insert fails.
  if (users) users[label] = data.user.id;

  const { error: profileError } = await supabase
    .from('profiles')
    .insert({ id: data.user.id, role, full_name: `Check ${label}` });
  if (profileError) throw new Error(`could not create profile (${label}): ${profileError.message}`);

  return data.user;
}

/** Signs in on supabaseAuth, never supabaseAdmin (see supabaseClient.js). */
export async function tokenFor(user, password) {
  const { data, error } = await supabaseAuth.auth.signInWithPassword({
    email: user.email,
    password,
  });
  if (error) throw new Error(`could not sign in as ${user.email}: ${error.message}`);
  return data.session.access_token;
}

/** How many of these auth users still exist; null ids are skipped. */
export async function countUsersLeft(ids) {
  let left = 0;
  for (const id of ids) {
    if (!id) continue;
    const { data } = await supabase.auth.admin.getUserById(id);
    if (data?.user) left += 1;
  }
  return left;
}

/** The error a promise rejects with, or null if it resolves. */
export async function failureOf(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

/** The error a call throws or rejects with, or null if it succeeds. */
export async function errorFrom(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

/** Two timestamps name the same instant, whatever offset each is written in. */
export function sameInstant(a, b) {
  return a != null && b != null && new Date(a).getTime() === new Date(b).getTime();
}
