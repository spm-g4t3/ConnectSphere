require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// used for auth actions (login, signup) — session-aware
const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// used for privileged data queries only (never for login)
// stays locked to the secret key, doesn't remember any user's login
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

module.exports = { supabaseAuth, supabaseAdmin };