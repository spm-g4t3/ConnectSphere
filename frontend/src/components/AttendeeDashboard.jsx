// AttendeeDashboard.jsx
//
// The Attendee landing page: a greeting and the way into Browse Open Events
// (SCRUM-495). Deliberately no counts, event data or registration state: the
// browse page owns those, and this page shows nothing it cannot read from the
// signed-in user.
//
// The section is a direct child of .dashboard so it picks up the
// `.dashboard > section` card styling, as on the other dashboards.

import { Link } from "react-router-dom";
import { BROWSE_OPEN_EVENTS_PATH } from "../services/openEventRoutes";

export default function AttendeeDashboard({ user }) {
  return (
    <div className="dashboard dashboard--attendee">
      <h1>Welcome, {user.name ?? user.email}</h1>

      <section aria-labelledby="attendee-browse-heading">
        <h2 id="attendee-browse-heading">Browse Open Events</h2>
        <p>Find events that are open for registration.</p>
        <Link className="dashboard--attendee__browse-link" to={BROWSE_OPEN_EVENTS_PATH}>
          Browse Open Events
        </Link>
      </section>
    </div>
  );
}