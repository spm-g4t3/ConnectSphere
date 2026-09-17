/**
 * Shared Supabase clients. supabaseAuth handles sign-in/sign-out,
 * supabaseAdmin handles privileged queries. Kept separate because
 * signInWithPassword()/signOut() override a client's API key with the
 * affected user's session, which would break RLS-bypassing queries if
 * run on the same client afterward.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

// Fail at import rather than passing undefined into createClient(). Without
// these checks the first query fails instead, with a network or auth error
// that gives no hint the real problem is a missing .env file.
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