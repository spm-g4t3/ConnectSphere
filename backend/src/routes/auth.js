/**
 * Auth routes: login (SCRUM-96) and logout (SCRUM-105).
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
 
export default router;