// EventCoordinatorDashboard.jsx
//
// The Event Coordinator's landing page: a greeting, their own events
// (SCRUM-333), the review queue, and their notifications (SCRUM-128).
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
// endpoint behind it, and that stub is now deleted. Its seat now holds NotificationInbox: when a
// Venue Staff member blocks a venue over an approved booking, the booking is
// flagged for review and the event's coordinator (or, with none assigned,
// every Lead) is notified there.
// Both sections are components of their own, so this file is only the page
// around them.

import { useState } from "react";
import CoordinatorAttentionList from "./CoordinatorAttentionList";
import MyAssignedEvents from "./MyAssignedEvents";
import ReviewQueue from "./ReviewQueue";
import NotificationInbox from "./NotificationInbox";

export default function EventCoordinatorDashboard({ user }) {
  // SCRUM-384. Bumped when something in My events changes an event (it was completed, say), so
  // the Needs attention list reads again instead of showing a row that has been dealt with.
  const [attentionVersion, setAttentionVersion] = useState(0);

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
          whole team, held by any coordinator. Mine comes first because it is
          the work this person is accountable for.

          Why the shared queue stays (SCRUM-486, SCRUM-520). This used to rest
          on "since SCRUM-330 every event is assigned the moment it is
          submitted", which 052 made false: a submitted request now waits with
          no coordinator until the Event Coordinator Lead assigns one, and
          those requests are the Lead's alone, in the Lead's unassigned queue,
          so this queue leaves them out. The queue stays because the customer
          restricts what a coordinator may manage, not what they may see:
          only the assigned coordinator acts on an event (SCRUM-327 AC6, AC7),
          but any coordinator may view any event (SCRUM-444 AC1). This queue
          is that view, of what colleagues have waiting, which is what a
          coordinator covering for someone, or choosing who to hand an event
          to, needs. listEventRequestsForReview's docstring has the argument
          in full.

          Both are direct children of .dashboard so each <section> root picks
          up the `.dashboard > section` card styling, exactly as VenueCatalogue
          does on the Venue Staff dashboard. Each keeps its own detail panel,
          so opening an event in one leaves the other as it was. */}
      {/* SCRUM-384 (SCRUM-379 AC7): the to-do list, ahead of My events. */}
      <CoordinatorAttentionList refreshKey={attentionVersion} />
      <MyAssignedEvents onEventChanged={() => setAttentionVersion((version) => version + 1)} />
      <ReviewQueue />

      {/* Also a direct child of .dashboard, for the same card styling. */}
      <NotificationInbox />
    </div>
  );
}
