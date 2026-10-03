// EventCoordinatorDashboard.jsx
//
// The Event Coordinator's landing page: a greeting, their own events
// (SCRUM-333), the review queue, and the pending-bookings stub.
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
// The pending-bookings section below stays a stub deliberately. Steps 4 and 5
// of the workflow — asking for a specific venue, and Venue Staff approving it
// — are out of this story's scope because 009_bookings.sql has no status,
// approval or requester columns to drive them. The section is the seat that
// work lands in; deleting it now just means re-adding it then.

import { useEffect, useState } from "react";
import { getPendingVenueBookings } from "../services/venueService";
import ReviewQueue from "./ReviewQueue";
import MyAssignedEvents from "./MyAssignedEvents";

export default function EventCoordinatorDashboard({ user }) {
  const [pendingBookings, setPendingBookings] = useState([]);

  // Still a stub with no endpoint behind it, so it resolves to [] rather than
  // rejecting. The .catch is here for the same reason VenueStaffDashboard's
  // is: the day that stops being true should show up as an empty section
  // rather than as an unhandled rejection in the console.
  useEffect(() => {
    getPendingVenueBookings()
      .then(setPendingBookings)
      .catch(() => setPendingBookings([]));
  }, []);

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

      <section>
        <h2>Pending venue bookings</h2>
        <ul>
          {pendingBookings.map((booking) => (
            <li key={booking.id}>
              {booking.venueName} — {booking.eventName}
            </li>
          ))}
          {pendingBookings.length === 0 && <p>No pending bookings.</p>}
        </ul>
      </section>
    </div>
  );
}
