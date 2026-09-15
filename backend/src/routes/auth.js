/**
 * Authentication routes.
 *
 * SCRUM-96: log a user in and resolve the role their dashboard is chosen from.
 * SCRUM-105: log a user out.
 *
 * Two Supabase clients are used here, not one: supabaseAuth for sign-in,
 * supabaseAdmin for the profile lookup. Calling signInWithPassword() on a
 * client sets that client's in-memory auth state to the signed-in user for
 * the rest of the request, overriding its API key. If the same client were
 * then used for the profiles query, that query would run as the logged-in
 * user (subject to row level security) instead of the privileged key RLS is
 * meant to bypass, and would silently return zero rows. Keeping the two
 * clients separate avoids this.
 */

import express from 'express';

import { supabaseAuth, supabaseAdmin } from '../config/supabaseClient.js';

const router = express.Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const { data, error } = await supabaseAuth.auth.signInWithPassword({
    email,
    password,
  });

  // Deliberately vague: distinguishing "no such account" from "wrong password"
  // would confirm to a stranger which addresses are registered.
  if (error) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', data.user.id)
    .single();

  // A user can authenticate but have no profile row -- the account exists in
  // Supabase Auth while the profiles insert failed or has not run yet. There is
  // no role to route on, so this is a server fault rather than a bad login.
  if (profileError || !profile) {
    return res.status(500).json({ error: 'Unable to retrieve user role' });
  }

  res.status(200).json({
    user: {
      id: data.user.id,
      email: data.user.email,
      role: profile.role,
    },
    session: data.session,
  });
});

router.post('/logout', async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No active session' });
  }

  const token = authHeader.split(' ')[1];
  const { error } = await supabaseAuth.auth.admin.signOut(token);

  console.log('Logout error:', error);
  if (error) {
    return res.status(500).json({ error: 'Failed to log out' });
  }

  res.status(200).json({ message: 'Logged out successfully' });
});

export default router;