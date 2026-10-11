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
//   * The coordinator overview, still a placeholder saying SCRUM-487 builds
//     it. No invented rows: a placeholder that looked like data would be read
//     as data.
//   * The Lead's notifications (CoordinatorNotifications, the Coordinator's
//     card, reused as it is). Submission now tells every Lead a request is
//     waiting (041, event_request_awaiting_assignment), and without this card
//     those notices would be written and never seen. This build does not yet
//     describe 041's three new types; describeNotification shows each as "New
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

import UnassignedQueue from "./UnassignedQueue";
import CoordinatorNotifications from "./CoordinatorNotifications";

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
          Every coordinator&apos;s assigned and active events will be shown here.
          This is built by SCRUM-487; until then there is nothing to show.
        </p>
      </section>

      <CoordinatorNotifications />
    </div>
  );
}
