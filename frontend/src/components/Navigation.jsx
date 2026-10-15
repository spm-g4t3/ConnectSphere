// Navigation.jsx
// Renders only the nav links relevant to the logged-in user's role.

import { useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useUnreadCount } from "../notifications/UnreadCountContext";
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
    { to: "/equipment-catalogue", label: "Equipment Catalogue" },
    { to: "/equipment-availability", label: "Check Availability" },
  ],
  ATTENDEE: [
    { to: "/dashboard", label: "Dashboard" },
    // "Browse Open Events" (SCRUM-495) is not linked yet: that story has no
    // route, page or branch, and /events is the Organiser's page. Add it here
    // with the path SCRUM-495 registers.
  ],
  // SCRUM-485 (SCRUM-510). One link each, deliberately: Dashboard, where
  // SCRUM-509 put each role's own screen. The pages that dashboard describes,
  // the unassigned queue and coordinator overview for the Lead and the safety
  // review list for the Safety Officer, have no route in App.jsx yet. A link
  // to a route that does not exist still renders and is clickable, and lands
  // on the catch-all redirect, so it promises a page and delivers another.
  // SCRUM-486 and 487 (the Lead) and SCRUM-490 (the Safety Officer) each add
  // their link here when they add the route.
  //
  // SCRUM-486 (SCRUM-519) added the Lead's unassigned queue, with its route
  // /unassigned-queue, and SCRUM-486 AC6 the list of assigned events at
  // /assigned-events, the Lead's way to an event to hand over. SCRUM-487
  // extended that page into the coordinator overview rather than adding
  // another page, so the link and its label stayed as they were.
  //
  // The keys are the whole normalised role, as TECHNICAL_SUPPORT_STAFF above
  // learned the hard way. EVENT_COORDINATOR would be the Coordinator's block,
  // and any other spelling matches nothing: the `|| []` below would give this
  // role an empty nav and throw nothing. Navigation.test.jsx pins each block
  // by its exact count so that cannot pass unnoticed.
  EVENT_COORDINATOR_LEAD: [
    { to: "/dashboard", label: "Dashboard" },
    { to: "/unassigned-queue", label: "Unassigned Queue" },
    { to: "/assigned-events", label: "Assigned Events" },
  ],
  SAFETY_OFFICER: [
    { to: "/dashboard", label: "Dashboard" },
  ],
};

export default function Navigation() {
  const { user, logout } = useAuth();
  const { unreadCount } = useUnreadCount();
  const [logoutError, setLogoutError] = useState(null);
  const [loggingOut, setLoggingOut] = useState(false);

  if (!user) return null;

  const links = NAV_LINKS_BY_ROLE[normaliseRole(user.role)] || [];
  const hasUnread = unreadCount > 0;

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
        {/* Every role's dashboard mounts the inbox, so one link serves all;
            the hash scrolls it into view. Not for a role with no links: it
            has no dashboard, so the link would promise an inbox it lacks. */}
        {links.length > 0 && (
          <Link
            to="/dashboard#notifications"
            className="app-nav__notifications"
            aria-label={hasUnread ? `Notifications, ${unreadCount} unread` : "Notifications"}
          >
            Notifications
            {hasUnread && <span className="app-nav__badge">{unreadCount}</span>}
          </Link>
        )}
        <span>{user.name} ({user.role})</span>
        <button onClick={handleLogout} disabled={loggingOut}>
          {loggingOut ? "Logging out..." : "Log out"}
        </button>
      </div>
      {logoutError && <p className="app-nav__error" role="alert">{logoutError}</p>}
    </nav>
  );
}
