/**
 * Authentication routes.
 *
 * SCRUM-96: log a user in and resolve the role their dashboard is chosen from.
 *
 * Both the sign-in and the profile lookup go through the shared client in
 * config/supabaseClient.js. That client sets persistSession: false, which
 * matters here: this is a single long-lived server process shared by every
 * caller, so a client that cached the session from a sign-in would carry one
 * user's session into the next user's request.
 */

import express from 'express';

import { supabase } from '../config/supabaseClient.js';

const router = express.Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  // Deliberately vague: distinguishing "no such account" from "wrong password"
  // would confirm to a stranger which addresses are registered.
  if (error) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const { data: profile, error: profileError } = await supabase
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

export default router;
