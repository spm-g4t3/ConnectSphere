// EventCoordinatorLeadDashboard.jsx
//
// SCRUM-485 (SCRUM-509), AC3: where an Event Coordinator Lead lands after
// login. AC3 sends the Lead "to the unassigned queue and coordinator overview",
// and says that until the stories building those exist, the dashboard "is a
// screen that says what the role will do there". This is that screen.
//
// What it deliberately does not do:
//
//   * Fetch anything. Neither section has an endpoint yet, and a call to one
//     that does not exist would fail at every demo. So the page imports no
//     service at all (docs/test-cases/SCRUM-485.md, AC3-08).
//   * Show invented rows, counts or names. Each section is empty, with one
//     line saying what will appear and which story builds it. A placeholder
//     that looked like data would be read as data.
//   * Link anywhere. App.jsx has no route for either section yet, and a link
//     to a page that does not exist is worse than none.
//   * Reuse the Coordinator's dashboard. The Lead inherits nothing from Event
//     Coordinator (SCRUM-485's design decision): what a Lead may do is granted
//     by SCRUM-486 and SCRUM-487, in the stories that need it.
//
// The same page shape as the other dashboards: a .dashboard root, an h1, and
// each section a direct child so it picks up the `.dashboard > section` card
// styling. The h1 names the role exactly, as AC1 asks.

export default function EventCoordinatorLeadDashboard({ user }) {
  return (
    <div className="dashboard dashboard--coordinator-lead">
      <h1>Event Coordinator Lead</h1>
      {/* user.name does not exist: login returns { id, email, role }. The same
          fallback EventCoordinatorDashboard and VenueStaffDashboard use. */}
      <p>Signed in as {user.name ?? user.email}.</p>

      <section>
        <h2>Unassigned queue</h2>
        <p>
          Event requests waiting for a coordinator will be listed here, for you
          to assign. This is built by SCRUM-486; until then there is nothing to
          show.
        </p>
      </section>

      <section>
        <h2>Coordinator overview</h2>
        <p>
          Every coordinator&apos;s assigned and active events will be shown here.
          This is built by SCRUM-487; until then there is nothing to show.
        </p>
      </section>
    </div>
  );
}
