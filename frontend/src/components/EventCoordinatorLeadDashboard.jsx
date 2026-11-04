// EventCoordinatorLeadDashboard.jsx
//
// SCRUM-485 (SCRUM-509), AC3: where an Event Coordinator Lead lands after
// login. AC3 sends the Lead "to the unassigned queue and coordinator overview",
// and says that until the stories building those exist, the dashboard "is a
// screen that says what the role will do there".
//
// SCRUM-486 (SCRUM-519) built the first of those. The page now holds:
//
//   * The unassigned queue (UnassignedQueue), live: every submitted request
//     waiting for a coordinator, each with an Assign action.
//   * The coordinator overview's card. SCRUM-487 (SCRUM-544) built the
//     overview at /assigned-events: every coordinator's counts, every held
//     event, the filters. The card points there and shows none of it itself,
//     so the dashboard reads nothing more (SCRUM486_AC2_the_lead_dashboard_
//     reads_only_the_unassigned_queue_and_its_notifications pins what it
//     reads). Before SCRUM-486 AC6 the card said "there is nothing to show";
//     from then until SCRUM-487 it pointed to the unfiltered list and named
//     SCRUM-487 as still to build. Rejected: the counts on the dashboard too,
//     a second copy of the overview and a third read on every login.
//   * The Lead's notifications (NotificationInbox, the Coordinator's
//     card, reused as it is). Submission now tells every Lead a request is
//     waiting (052, event_request_awaiting_assignment), and without this card
//     those notices would be written and never seen. This build does not yet
//     describe 052's three new types; describeNotification shows each as "New
//     notification / This notification type cannot be displayed yet", so they
//     are counted and can be marked read, until SCRUM-172 words them.
//
// Still not the Coordinator's dashboard. The Lead inherits nothing from Event
// Coordinator (SCRUM-485's design decision); the notifications card is shared
// because the notifications route serves every account its own.
//
// The same page shape as the other dashboards: a .dashboard root, an h1, and
// each section a direct child so it picks up the `.dashboard > section` card
// styling. The h1 names the role exactly, as AC1 asks.

import { Link } from "react-router-dom";
import UnassignedQueue from "./UnassignedQueue";
import NotificationInbox from "./NotificationInbox";

export default function EventCoordinatorLeadDashboard({ user }) {
  return (
    <div className="dashboard dashboard--coordinator-lead">
      <h1>Event Coordinator Lead</h1>
      {/* user.name does not exist: login returns { id, email, role }. The same
          fallback EventCoordinatorDashboard and VenueStaffDashboard use. */}
      <p>Signed in as {user.name ?? user.email}.</p>

      <UnassignedQueue />

      <section>
        <h2>Coordinator overview</h2>
        <p>
          See every coordinator&apos;s events and workload, and filter them, in{" "}
          <Link to="/assigned-events">Assigned Events</Link>.
        </p>
      </section>

      <NotificationInbox />
    </div>
  );
}
