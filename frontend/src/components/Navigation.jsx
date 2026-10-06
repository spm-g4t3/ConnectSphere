// Navigation.jsx
// Renders only the nav links relevant to the logged-in user's role.

import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { normaliseRole } from "../auth/normaliseRole";

const NAV_LINKS_BY_ROLE = {
  EVENT_ORGANISER: [
    { to: "/dashboard", label: "Dashboard" },
    { to: "/events", label: "My Events" },
    // No "Find a Venue": an Organiser states venue needs on the request
    // (SCRUM-10); Coordinators search and book venues (SCRUM-20, SCRUM-243).
  ],
  EVENT_COORDINATOR: [
    { to: "/dashboard", label: "Dashboard" },
    // SCRUM-333. Above the queue because it is the coordinator's own work:
    // the events they are responsible for, every status. "My Events", the
    // same words as the Organiser's link, because it answers the same
    // question for this role, but a different target: /events is the
    // Organiser's page.
    { to: "/my-events", label: "My Events" },
    // SCRUM-255. The venue requests this coordinator has raised, and where each
    // stands. Beside "Find a Venue", where a request starts, and distinct from
    // Venue Staff's "Booking Requests", which is the other side of the same
    // requests.
    { to: "/my-venue-requests", label: "Venue Requests" },
    // "/review-queue", not "/events" (SCRUM-45). /events renders
    // MyEventRequests, which reads the organiser-scoped endpoint, so this
    // link used to promise a Coordinator "Events" and hand them "You haven't
    // created any event requests yet." forever — the second face of the
    // reported bug, and probably the screen that got reported. The label
    // changes with the target: a Coordinator's relationship to an event
    // request is that they review it, not that they own it.
    { to: "/review-queue", label: "Review Queue" },
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
            <NavLink
              to={link.to}
              end={link.to === "/dashboard"}
              className={({ isActive }) => isActive ? "app-nav__link app-nav__link--active" : "app-nav__link"}
            >
              {link.label}
            </NavLink>
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
