// Navigation.jsx
// Renders only the nav links relevant to the logged-in user's role.

import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

const NAV_LINKS_BY_ROLE = {
  EVENT_ORGANISER: [
    { to: "/dashboard", label: "Dashboard" },
    { to: "/events", label: "My Events" },
    { to: "/venue-search", label: "Find a Venue" },
  ],
  EVENT_COORDINATOR: [
    { to: "/dashboard", label: "Dashboard" },
    { to: "/events", label: "Events" },
    { to: "/venue-search", label: "Venue Bookings" },
  ],
  VENUE_STAFF: [
    { to: "/dashboard", label: "Dashboard" },
    { to: "/venue-catalogue", label: "Venue Catalogue" },
    { to: "/booking-requests", label: "Booking Requests" },
  ],
  TECHNICAL_SUPPORT: [
    { to: "/dashboard", label: "Dashboard" },
    { to: "/tickets", label: "Support Tickets" },
    { to: "/equipment", label: "Equipment Requests" },
  ],
};

export default function Navigation() {
  const { user, logout } = useAuth();

  if (!user) return null;

  const role = String(user.role || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_")
    .replace("ORGANIZER", "ORGANISER");
  const links = NAV_LINKS_BY_ROLE[role] || [];

  return (
    <nav className="app-nav">
      <ul className="app-nav__links">
        {links.map((link) => (
          <li key={link.to}>
            <Link to={link.to}>{link.label}</Link>
          </li>
        ))}
      </ul>
      <div className="app-nav__user">
        <span>{user.name} ({user.role})</span>
        <button onClick={logout}>Log out</button>
      </div>
    </nav>
  );
}
