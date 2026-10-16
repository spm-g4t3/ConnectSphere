// The Attendee landing page: a greeting and the way into Browse Open Events.
// The section is a direct child of .dashboard to get its card styling.

import { Link } from "react-router-dom";
import { BROWSE_OPEN_EVENTS_PATH, isOpenEventsEnabled } from "../services/openEventRoutes";

export default function AttendeeDashboard({ user }) {
  return (
    <div className="dashboard dashboard--attendee">
      <h1>Welcome, {user.name ?? user.email}</h1>

      {isOpenEventsEnabled() && (
        <section aria-labelledby="attendee-browse-heading">
          <h2 id="attendee-browse-heading">Browse Open Events</h2>
          <p>Find events that are open for registration.</p>
          <Link className="dashboard--attendee__browse-link" to={BROWSE_OPEN_EVENTS_PATH}>
            Browse Open Events
          </Link>
        </section>
      )}
    </div>
  );
}