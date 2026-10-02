// EventCoordinatorDashboard.jsx
//
// The Event Coordinator's landing page: a greeting, the review queue, and the
// notifications.
//
// SCRUM-45 replaced the first section wholesale. It used to call
// getEventsNeedingAttention — a stub that console.warn'd and returned [], and
// did not even accept the user.id it was handed — which was the visible half
// of the reported bug: an Organiser submitted a request and nobody on the
// Coordinator side ever saw it. The queue now reads a real endpoint, and
// lives in ReviewQueue.jsx rather than inline here because it is the only
// part of this screen with a route of its own (/review-queue). Same move, and
// the same reason, as VenueCatalogue leaving VenueStaffDashboard.
//
// SCRUM-128 replaced the pending-bookings stub that sat below the queue. It
// called a venueService stub that console.warn'd and returned [] with no
// endpoint behind it, and that stub is now deleted. Its seat now holds CoordinatorNotifications: when a
// Venue Staff member blocks a venue over an approved booking, the booking is
// flagged for review and every Coordinator is notified there (SCRUM-17 AC3).
// Both sections are components of their own, so this file is only the page
// around them.

import ReviewQueue from "./ReviewQueue";
import CoordinatorNotifications from "./CoordinatorNotifications";

export default function EventCoordinatorDashboard({ user }) {
  return (
    <div className="dashboard dashboard--coordinator">
      {/* user.name does not exist: auth.js returns { id, email, role } and
          never selects profiles.full_name, so this rendered "Welcome, " with
          nothing after it. Same honest fallback VenueStaffDashboard uses; the
          real fix is server-side and has its own ticket. */}
      <h1>Welcome, {user.name ?? user.email}</h1>

      {/* A direct child of .dashboard so its <section> root picks up the
          `.dashboard > section` card styling, exactly as VenueCatalogue does
          on the Venue Staff dashboard. */}
      <ReviewQueue />

      {/* Also a direct child of .dashboard, for the same card styling. */}
      <CoordinatorNotifications />
    </div>
  );
}
