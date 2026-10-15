// AttendeeDashboard.jsx
//
// The Attendee landing page: a greeting, the way into Browse Open Events and
// the attendee's notifications. No event data or registration state: those
// belong to SCRUM-495 (browsing) and SCRUM-22 (registering). The inbox is the
// attendee's own data, scoped to them by the API.
//
// Each section is a direct child of .dashboard so it picks up the
// `.dashboard > section` card styling, as on the other dashboards.

import { Link } from "react-router-dom";
import NotificationInbox from "./NotificationInbox";

// SCRUM-495 has no route yet, and /events is the Organiser's page, so there is
// nothing honest to link to. Set this to the path SCRUM-495 registers (and add
// the same link to Navigation.jsx's ATTENDEE list) and the entry becomes a link.
const BROWSE_OPEN_EVENTS_PATH = null;

export default function AttendeeDashboard({ user }) {
  return (
    <div className="dashboard dashboard--attendee">
      <h1>Welcome, {user.name ?? user.email}</h1>

      <section aria-labelledby="attendee-browse-heading">
        <h2 id="attendee-browse-heading">Browse Open Events</h2>
        <p>Find events that are open for registration.</p>
        {BROWSE_OPEN_EVENTS_PATH ? (
          <Link to={BROWSE_OPEN_EVENTS_PATH}>Browse Open Events</Link>
        ) : (
          <p role="status">Browsing open events is not available yet.</p>
        )}
      </section>

      <NotificationInbox />
    </div>
  );
}
