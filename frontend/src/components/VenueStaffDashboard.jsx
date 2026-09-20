// VenueStaffDashboard.jsx

import { useEffect, useState } from "react";
import { getPendingBookingRequests, getVenueCatalogue } from "../services/venueService";

export default function VenueStaffDashboard({ user }) {
  const [pendingRequests, setPendingRequests] = useState([]);
  const [venues, setVenues] = useState([]);

  useEffect(() => {
    getPendingBookingRequests().then(setPendingRequests);
    getVenueCatalogue().then(setVenues);
  }, []);

  return (
    <div className="dashboard dashboard--venue-staff">
      <h1>Welcome, {user.name}</h1>

      <section>
        <h2>Pending booking requests</h2>
        <ul>
          {pendingRequests.map((req) => (
            <li key={req.id}>
              {req.venueName} — requested by {req.requesterName}
              <button>Approve</button>
              <button>Reject</button>
            </li>
          ))}
          {pendingRequests.length === 0 && <p>No pending requests.</p>}
        </ul>
      </section>

      <section>
        <h2>Venue catalogue</h2>
        <ul>
          {venues.map((venue) => (
            <li key={venue.id}>
              {venue.name} — {venue.status}
              <button>Edit details</button>
              {venue.status === "active" && <button>Mark unavailable</button>}
            </li>
          ))}
        </ul>
        <button>+ Add new venue</button>
      </section>
    </div>
  );
}
