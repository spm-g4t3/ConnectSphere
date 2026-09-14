// EventCoordinatorDashboard.jsx
// Example role-specific view. Copy this structure for EventOrganiserDashboard,
// VenueStaffDashboard, and TechnicalSupportDashboard, swapping in the
// widgets/data relevant to each role.

import { useEffect, useState } from "react";
import { getEventsNeedingAttention } from "../services/eventService";
import { getPendingVenueBookings } from "../services/venueService";

export default function EventCoordinatorDashboard({ user }) {
  const [pendingEvents, setPendingEvents] = useState([]);
  const [pendingBookings, setPendingBookings] = useState([]);

  useEffect(() => {
    getEventsNeedingAttention(user.id).then(setPendingEvents);
    getPendingVenueBookings(user.id).then(setPendingBookings);
  }, [user.id]);

  return (
    <div className="dashboard dashboard--coordinator">
      <h1>Welcome, {user.name}</h1>

      <section>
        <h2>Events needing attention</h2>
        <ul>
          {pendingEvents.map((event) => (
            <li key={event.id}>
              {event.name} — {event.status}
            </li>
          ))}
          {pendingEvents.length === 0 && <p>Nothing outstanding right now.</p>}
        </ul>
      </section>

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
