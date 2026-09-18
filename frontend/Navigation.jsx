// Navigation.jsx
// Renders only the nav links relevant to the logged-in user's role.

import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

const NAV_LINKS_BY_ROLE = {
  event_organiser: [
    { to: "/dashboard", label: "Dashboard" },
    { to: "/events", label: "My Events" },
    { to: "/venue-search", label: "Find a Venue" },
  ],
  event_coordinator: [
    { to: "/dashboard", label: "Dashboard" },
    { to: "/events", label: "Events" },
    { to: "/venue-search", label: "Venue Bookings" },
  ],
  venue_staff: [
    { to: "/dashboard", label: "Dashboard" },
    { to: "/venue-catalogue", label: "Venue Catalogue" },
    { to: "/booking-requests", label: "Booking Requests" },
  ],
  technical_support: [
    { to: "/dashboard", label: "Dashboard" },
    { to: "/tickets", label: "Support Tickets" },
    { to: "/equipment", label: "Equipment Requests" },
  ],
};

export default function Navigation() {
  const { user, logout } = useAuth();

  if (!user) return null;

  const links = NAV_LINKS_BY_ROLE[user.role] || [];

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
