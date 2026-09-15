const express = require('express');
const router = express.Router();
const { supabaseAuth, supabaseAdmin } = require('../config/supabaseClient');

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const { data, error } = await supabaseAuth.auth.signInWithPassword({ 
    email,
    password
  });

  if (error) {
    console.log('Auth error:', error.message);
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  console.log('Authenticated user id:', data.user.id);

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', data.user.id)
    .single();

  console.log('Profile query result:', profile);
  console.log('Profile query error:', profileError);

  if (profileError || !profile) {
    return res.status(500).json({ error: 'Unable to retrieve user role' });
  }

  res.status(200).json({
    user: {
      id: data.user.id,
      email: data.user.email,
      role: profile.role
    },
    session: data.session
  });
});

router.post('/logout', async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No active session' });
  }

  const token = authHeader.split(' ')[1];
  const { error } = await supabaseAuth.auth.admin.signOut(token);

  if (error) {
    return res.status(500).json({ error: 'Failed to log out' });
  }

  res.status(200).json({ message: 'Logged out successfully' });
});

module.exports = router;