/**
 * ConnectSphere API server.
 *
 * The Express tier sits between React and Supabase. It is the only tier that
 * holds the secret key, which is why it lives under backend/src/ alongside the
 * Supabase client rather than at the package root.
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import authRoutes from './routes/auth.js';
import eventRequestRoutes from './routes/eventRequests.js';

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/event-requests', eventRequestRoutes);

// routes/venues.js is deliberately not mounted. It takes the acting user from
// req.body.userId, which is a client asserting its own identity against a table
// whose row level security is deny-all on the understanding that the API
// authorises instead. It belongs to the venue story, and to whoever puts
// requireAuth in front of it.

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
