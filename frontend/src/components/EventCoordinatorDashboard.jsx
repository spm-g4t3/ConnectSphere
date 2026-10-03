// EventCoordinatorDashboard.jsx
//
// The Event Coordinator's landing page: a greeting, the review queue, and the
// pending-bookings stub.
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
import MyAssignedEvents from "./MyAssignedEvents";
import CoordinatorNotifications from "./CoordinatorNotifications";
import ReviewQueue from "./ReviewQueue";

export default function EventCoordinatorDashboard({ user }) {
  return (
    <div className="dashboard dashboard--coordinator">
      {/* user.name does not exist: auth.js returns { id, email, role } and
          never selects profiles.full_name, so this rendered "Welcome, " with
          nothing after it. Same honest fallback VenueStaffDashboard uses; the
          real fix is server-side and has its own ticket. */}
      <h1>Welcome, {user.name ?? user.email}</h1>

      {/* SCRUM-333. Both lists, mine first. They answer different questions:
          My events is the work this coordinator holds, every status, soonest
          first; the review queue is every event awaiting a decision across the
          whole team, whoever holds it. Since SCRUM-330 every event is assigned
          the moment it is submitted, so the queue is no longer "work nobody
          holds". It stays because it is the only view of what colleagues have
          waiting, which is what a coordinator covering for someone, or
          picking who to hand an event to, needs to see. Mine comes first
          because it is the work this person is accountable for.

          Both are direct children of .dashboard so each <section> root picks
          up the `.dashboard > section` card styling, exactly as VenueCatalogue
          does on the Venue Staff dashboard. Each keeps its own detail panel,
          so opening an event in one leaves the other as it was. */}
      <MyAssignedEvents />
      <ReviewQueue />

      {/* Also a direct child of .dashboard, for the same card styling. */}
      <CoordinatorNotifications />
    </div>
  );
}
