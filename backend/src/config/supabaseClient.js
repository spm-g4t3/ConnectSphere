/**
 * Shared Supabase client for the ConnectSphere API.
 *
 * This is the only place the database connection is created. Everything that
 * touches Supabase imports this client rather than constructing its own, so
 * there is a single place to change configuration.
 *
 * SECURITY: this holds the secret key, which bypasses row level security
 * completely. It is server-only and must never be imported from frontend code.
 * That is why it lives under backend/src/ -- the boundary is structural rather
 * than a rule someone has to remember.
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

export const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: {
    // This is a server, not a browser. There is no storage to persist a session
    // into and no signed-in user whose token needs refreshing -- every request
    // authenticates with the secret key.
    persistSession: false,
    autoRefreshToken: false,
  },
});

export default supabase;
