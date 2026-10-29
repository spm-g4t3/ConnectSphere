/**
 * Auth routes: login (SCRUM-96), logout (SCRUM-105) and session renewal
 * (SCRUM-583).
 *
 * Uses two Supabase clients (supabaseAuth, supabaseAdmin) instead of one.
 * signInWithPassword() overrides a client's API key with the user's session
 * for the rest of the request, so the same client can't be reused for the
 * privileged profiles query afterward, it would run as the user, not the
 * secret key, and RLS would silently block it.
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
 
  if (error) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
 
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', data.user.id)
    .single();
 
  if (profileError || !profile) {
    console.error('Profile lookup failed:', profileError?.message);
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
 
  if (!token) {
    return res.status(401).json({ error: 'No active session' });
  }
 
  const { error } = await supabaseAuth.auth.admin.signOut(token);
 
  if (error) {
    console.error('Logout failed:', error.message);
    return res.status(500).json({ error: 'Failed to log out' });
  }
 
  res.status(200).json({ message: 'Logged out successfully' });
});
 
// Swaps a refresh token for a new session. The token is in the body because
// the access token may already be dead. 401 means the session is over; 503
// means Supabase could not be asked, so the client keeps the session and
// retries. Merging the two would sign people out over a network blip.
router.post('/refresh', async (req, res) => {
  const refreshToken = req.body?.refresh_token;

  if (typeof refreshToken !== 'string' || !refreshToken.trim()) {
    return res.status(400).json({ error: 'A refresh token is required' });
  }

  let result;
  try {
    result = await supabaseAuth.auth.refreshSession({ refresh_token: refreshToken });
  } catch (err) {
    console.error('Session renewal failed:', err.message);
    return res.status(503).json({ error: 'Unable to renew the session right now' });
  }

  const { data, error } = result;

  if (error) {
    // Only a 4xx (not 429) is a verdict on the token; a network failure, 5xx,
    // 429 or statusless error says nothing about it.
    const refused = error.status >= 400 && error.status < 500 && error.status !== 429;
    if (error.name === 'AuthRetryableFetchError' || !refused) {
      console.error('Session renewal failed:', error.message);
      return res.status(503).json({ error: 'Unable to renew the session right now' });
    }
    return res.status(401).json({ error: 'Your session is no longer valid' });
  }

  if (!data?.session) {
    return res.status(401).json({ error: 'Your session is no longer valid' });
  }

  res.status(200).json({ session: data.session });
});

export default router;