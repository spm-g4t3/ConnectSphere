/**
 * Shared Supabase clients for the ConnectSphere API.
 *
 * This is the only place database/auth connections are created. Everything
 * that touches Supabase imports from here rather than constructing its own
 * client, so there is a single place to change configuration.
 *
 * SECURITY: supabaseAdmin holds the secret key, which bypasses row level
 * security completely. It is server-only and must never be imported from
 * frontend code.
 *
 * Two clients, not one:
 * supabaseAuth handles sign-in and sign-out. supabaseAdmin handles privileged
 * data queries. They must stay separate: calling signInWithPassword() (or
 * signOut()) on a client sets that client's in-memory auth state to the
 * affected user for the rest of the request, overriding its API key. If the
 * same client were then used for a privileged query, that query would run as
 * the logged-in user, subject to row level security, instead of the secret
 * key RLS is meant to bypass, and would silently return zero rows.
 *
 * persistSession/autoRefreshToken are off on both: this is a single
 * long-lived server process shared by every caller, not a browser. There is
 * no storage to persist a session into, and no per-user session that should
 * carry over between unrelated requests.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL) {
  throw new Error(
    'SUPABASE_URL is not set. Copy backend/.env.example to backend/.env and fill in the real values.',
  );
}

if (!SUPABASE_SECRET_KEY) {
  throw new Error(
    'SUPABASE_SECRET_KEY is not set. Copy backend/.env.example to backend/.env and fill in the real values.',
  );
}

// Used for sign-in and sign-out — never used for privileged queries
export const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

// Used for privileged data queries only — always bypasses RLS, never used
// for sign-in/sign-out
export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

// Kept for backward compatibility with anything still importing the single
// `supabase` export (venueService.js, eventRequestService.js, the
// check-*.js scripts) — aliased to supabaseAdmin since those all do
// privileged queries, never sign-in/sign-out.
export const supabase = supabaseAdmin;
