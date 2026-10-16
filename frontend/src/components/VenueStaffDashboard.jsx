// VenueStaffDashboard.jsx
//
// The Venue Staff landing page: a greeting, the pending booking requests
// queue (SCRUM-258), the flagged bookings list, notifications, and the venue
// catalogue.
//
// The catalogue used to live inline here. It moved to VenueCatalogue.jsx
// unchanged when SCRUM-15's create/edit/detail panels were wired up: the
// catalogue is the only part of this screen with a route of its own
// (/venue-catalogue), and leaving it here would have meant that route
// rendering a second copy of the greeting and the queue below. Nothing about
// the retire flow changed in the move.

import PendingBookingRequests from "./PendingBookingRequests";
import FlaggedBookings from "./FlaggedBookings";
import VenueCatalogue from "./VenueCatalogue";
import NotificationInbox from "./NotificationInbox";

export default function VenueStaffDashboard({ user }) {
  return (
    <div className="dashboard dashboard--venue-staff">
      {/* user.name does not exist: auth.js:44-51 returns { id, email, role }
          and never selects profiles.full_name, so this rendered "Welcome, "
          with nothing after it. The email is the honest fallback; the real
          fix is server-side and has its own ticket. */}
      <h1>Welcome, {user.name ?? user.email}</h1>

      {/* A direct child of .dashboard, like VenueCatalogue below, so its
          <section> root gets the `.dashboard > section` card styling. */}
      <PendingBookingRequests />

      <FlaggedBookings />

      <NotificationInbox />

      {/* Rendered as a direct child of .dashboard so its <section> root still
          picks up the `.dashboard > section` card styling it had inline.
          currentUserId (SCRUM-131) lets the blocks panel say "you" for the
          signed-in user's own block changes. A prop, not useAuth() inside the
          panel: useAuth throws without an AuthProvider, and the panel's tests
          render without one. */}
      <VenueCatalogue currentUserId={user.id} />
    </div>
  );
}
