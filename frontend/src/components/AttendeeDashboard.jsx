// The Attendee landing page: a greeting, the way into Browse Open Events and
// the attendee's notifications. Each section is a direct child of .dashboard
// to get its card styling.

import { Link } from "react-router-dom";
import { BROWSE_OPEN_EVENTS_PATH, isOpenEventsEnabled } from "../services/openEventRoutes";
import { REGISTERED_EVENTS_PATH } from "../services/attendeeEventRoutes";
import NotificationInbox from "./NotificationInbox";

export default function AttendeeDashboard({ user }) {
  return (
    <div className="dashboard dashboard--attendee">
      <h1>Welcome, {user.name ?? user.email}</h1>

      <section aria-labelledby="attendee-registered-heading">
        <h2 id="attendee-registered-heading">Registered events</h2>
        <p>View the information for events you are registered for.</p>
        <Link className="dashboard--attendee__browse-link" to={REGISTERED_EVENTS_PATH}>View registered events</Link>
      </section>

      {isOpenEventsEnabled() && (
        <section aria-labelledby="attendee-browse-heading">
          <h2 id="attendee-browse-heading">Browse Open Events</h2>
          <p>Find events that are open for registration.</p>
          <Link className="dashboard--attendee__browse-link" to={BROWSE_OPEN_EVENTS_PATH}>
            Browse Open Events
          </Link>
        </section>
      )}

      <NotificationInbox />
    </div>
  );
}
