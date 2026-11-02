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
import eventRegistrationRoutes from './routes/eventRegistration.js';
import venueRoutes from './routes/venues.js';
import notificationRoutes from './routes/notifications.js';
import bookingRequestRoutes from './routes/bookingRequests.js';
import flaggedBookingRoutes from './routes/flaggedBookings.js';
import equipmentAvailabilityRoutes from './routes/equipmentAvailability.js';
import equipmentRoutes from './routes/equipment.js';
import eventEquipmentRoutes from './routes/eventEquipment.js';
import venueSuitabilityRoutes from './routes/venueSuitability.js';
import equipmentReviewRoutes from './routes/equipmentReview.js';
import equipmentQueueRoutes from './routes/equipmentQueue.js';
import safetyReviewRoutes from './routes/safetyReviews.js';
import openEventRoutes from './routes/openEvents.js';
import attendeeEventRoutes from './routes/attendeeEvents.js';
import { startBackgroundJobs } from './jobs/backgroundJobs.js';

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);

app.use('/api/event-requests/:id/equipment', eventEquipmentRoutes)
app.use('/api/event-requests/:id/equipment-review', equipmentReviewRoutes);
app.use('/api/safety-reviews', safetyReviewRoutes);

// SCRUM-190 (SCRUM-188): one venue judged against one event, criterion by
// criterion. Before the /api/event-requests router, like the equipment routes.
app.use('/api/event-requests/:id/venue-suitability', venueSuitabilityRoutes);

app.use('/api/event-requests', eventRequestRoutes);
app.use('/api/attendee-events', attendeeEventRoutes);
app.use('/api/registration', eventRegistrationRoutes);

// Mounted by SCRUM-15. It was withheld until it stopped taking the acting user
// from req.body.userId -- a client asserting its own identity against a table
// whose row level security is deny-all on the understanding that the API
// authorises instead. It now runs behind requireAuth, and its writes behind
// requireRole(VENUE_STAFF).
app.use('/api/venues', venueRoutes);

// SCRUM-23: the equipment availability check. Mounted before /api/equipment so a
// GET /api/equipment/:id can never answer "availability" as an id, and so the
// request does not run the catalogue router's requireAuth as well as its own.
app.use('/api/equipment/availability', equipmentAvailabilityRoutes);

// SCRUM-276: the equipment catalogue. Writes are Technical Support Staff only;
// the active-types read is also open to Event Coordinators (SCRUM-21's picker).
app.use('/api/equipment', equipmentRoutes);

// SCRUM-128: the signed-in user's own notifications. Behind requireAuth and
// scoped to the caller; see the route file for why there is no role gate.
app.use('/api/notifications', notificationRoutes);

// SCRUM-285 (SCRUM-284): the Technical Support dashboard's equipment request queue.
// Technical Support Staff only, behind requireAuth; see the route file.
app.use('/api/equipment-requests', equipmentQueueRoutes);

// SCRUM-252: an Event Coordinator requests a venue for an approved event.
app.use('/api/booking-requests', bookingRequestRoutes);

// SCRUM-266: Venue Staff resolve a booking flagged for review.
app.use('/api/flagged-bookings', flaggedBookingRoutes);

// SCRUM-495: the events an authenticated Attendee can register for.
app.use('/api/open-events', openEventRoutes);

// The venue hold expiry, waiting-list promotion and registration window jobs.
// Never under test; each has a *_JOB=off switch (jobs/backgroundJobs.js).
startBackgroundJobs();

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
