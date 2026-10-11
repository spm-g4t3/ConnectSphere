// SafetyOfficerDashboard.jsx
//
// SCRUM-485 (SCRUM-509), AC3: where a Safety Officer lands after login. AC3
// sends the Safety Officer "to the safety review list", and says that until the
// story building it exists, the dashboard "is a screen that says what the role
// will do there". This is that screen.
//
// For the reasons EventCoordinatorLeadDashboard.jsx gives: it fetches nothing
// (there is no endpoint, and AC3-08 pins that no service is called), shows no
// invented rows, and links nowhere (App.jsx has no route for the list yet).
// What a Safety Officer may do is SCRUM-490's to grant.
//
// The same page shape as the other dashboards, and the h1 names the role
// exactly, as AC1 asks.

export default function SafetyOfficerDashboard({ user }) {
  return (
    <div className="dashboard dashboard--safety-officer">
      <h1>Safety Officer</h1>
      {/* login returns no name, so the email stands in, as on the other
          dashboards. */}
      <p>Signed in as {user.name ?? user.email}.</p>

      <section>
        <h2>Safety review list</h2>
        <p>
          Events waiting for a safety review will be listed here. This is built
          by SCRUM-490; until then there is nothing to show.
        </p>
      </section>
    </div>
  );
}
