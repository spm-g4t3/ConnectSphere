// Navigation.jsx
// Renders only the nav links relevant to the logged-in user's role.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { normaliseRole } from "../auth/normaliseRole";

const NAV_LINKS_BY_ROLE = {
  EVENT_ORGANISER: [
    { to: "/dashboard", label: "Dashboard" },
    { to: "/events", label: "My Events" },
    { to: "/venue-search", label: "Find a Venue" },
  ],
  EVENT_COORDINATOR: [
    { to: "/dashboard", label: "Dashboard" },
    { to: "/events", label: "Events" },
    // "Find a Venue", not "Venue Bookings". The route resolves to VenueSearch,
    // which searches active venues — there is no venue-booking feature behind
    // it, so the old label promised something that does not exist. Same target
    // and same label as the Organiser's link, because it is the same page.
    { to: "/venue-search", label: "Find a Venue" },
  ],
  VENUE_STAFF: [
    { to: "/dashboard", label: "Dashboard" },
    { to: "/venue-catalogue", label: "Venue Catalogue" },
    { to: "/booking-requests", label: "Booking Requests" },
  ],
  // TECHNICAL_SUPPORT_STAFF, not TECHNICAL_SUPPORT. normaliseRole yields the
  // full role name from the token, so the short key matched nothing and this
  // whole block never rendered — a Technical Support user saw no nav at all.
  TECHNICAL_SUPPORT_STAFF: [
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

  const links = NAV_LINKS_BY_ROLE[normaliseRole(user.role)] || [];

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
