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
import venueRoutes from './routes/venues.js';
import notificationRoutes from './routes/notifications.js';

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/event-requests', eventRequestRoutes);

// Mounted by SCRUM-15. It was withheld until it stopped taking the acting user
// from req.body.userId -- a client asserting its own identity against a table
// whose row level security is deny-all on the understanding that the API
// authorises instead. It now runs behind requireAuth, and its writes behind
// requireRole(VENUE_STAFF).
app.use('/api/venues', venueRoutes);

// SCRUM-128: the signed-in user's own notifications. Behind requireAuth and
// scoped to the caller; see the route file for why there is no role gate.
app.use('/api/notifications', notificationRoutes);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
