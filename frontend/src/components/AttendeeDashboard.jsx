// AttendeeDashboard.jsx
//
// The Attendee landing page. Only the greeting for now: the dashboard shell
// (SCRUM-456) builds on this.

export default function AttendeeDashboard({ user }) {
  return (
    <div className="dashboard dashboard--attendee">
      <h1>Welcome, {user.name ?? user.email}</h1>
    </div>
  );
}
