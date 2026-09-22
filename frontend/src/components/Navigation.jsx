// Navigation.jsx
// Renders only the nav links relevant to the logged-in user's role.

import { useState } from "react";
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
  const [logoutError, setLogoutError] = useState(null);
  const [loggingOut, setLoggingOut] = useState(false);

  if (!user) return null;

  const role = String(user.role || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_")
    .replace("ORGANIZER", "ORGANISER");
  const links = NAV_LINKS_BY_ROLE[role] || [];

  async function handleLogout() {
    setLoggingOut(true);
    setLogoutError(null);
    const result = await logout();
    setLoggingOut(false);
    if (!result.success) setLogoutError(result.error);
  }

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
        <button onClick={handleLogout} disabled={loggingOut}>
          {loggingOut ? "Logging out..." : "Log out"}
        </button>
      </div>
      {logoutError && <p className="app-nav__error" role="alert">{logoutError}</p>}
    </nav>
  );
}
