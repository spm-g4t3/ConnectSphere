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
import bookingRequestRoutes from './routes/bookingRequests.js';
import equipmentAvailabilityRoutes from './routes/equipmentAvailability.js';
import equipmentRoutes from './routes/equipment.js';
import eventEquipmentRoutes from './routes/eventEquipment.js';
import venueSuitabilityRoutes from './routes/venueSuitability.js';
import equipmentReviewRoutes from './routes/equipmentReview.js';
import { startVenueHoldExpiryScheduler } from './jobs/venueHoldExpiryScheduler.js';

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);

app.use('/api/event-requests/:id/equipment', eventEquipmentRoutes)
app.use('/api/event-requests/:id/equipment-review', equipmentReviewRoutes);

// SCRUM-190 (SCRUM-188): one venue judged against one event, criterion by
// criterion. Before the /api/event-requests router, like the equipment routes.
app.use('/api/event-requests/:id/venue-suitability', venueSuitabilityRoutes);

app.use('/api/event-requests', eventRequestRoutes);

// Mounted by SCRUM-15. It was withheld until it stopped taking the acting user
// from req.body.userId -- a client asserting its own identity against a table
// whose row level security is deny-all on the understanding that the API
// authorises instead. It now runs behind requireAuth, and its writes behind
// requireRole(VENUE_STAFF).
app.use('/api/venues', venueRoutes);

// SCRUM-276: the equipment catalogue. Writes are Technical Support Staff only;
// the active-types read is also open to Event Coordinators (SCRUM-21's picker).
app.use('/api/equipment', equipmentRoutes);

// SCRUM-128: the signed-in user's own notifications. Behind requireAuth and
// scoped to the caller; see the route file for why there is no role gate.
app.use('/api/notifications', notificationRoutes);

// SCRUM-23: the equipment availability check. Mounted BEFORE /api/equipment so a
// later GET /api/equipment/:id can never answer "availability" as an id.
app.use('/api/equipment/availability', equipmentAvailabilityRoutes);

// SCRUM-252: an Event Coordinator requests a venue for an approved event.
app.use('/api/booking-requests', bookingRequestRoutes);

// SCRUM-491 (AC7, AC8): mark lapsed venue holds expired and notify their
// coordinators, once a minute. A lapsed hold already occupies nothing without
// this; set VENUE_HOLD_EXPIRY_JOB=off to show that. Never under test.
if (process.env.NODE_ENV !== 'test' && process.env.VENUE_HOLD_EXPIRY_JOB !== 'off') {
  startVenueHoldExpiryScheduler();
}

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
