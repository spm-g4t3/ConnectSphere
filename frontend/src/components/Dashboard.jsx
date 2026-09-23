// Dashboard.jsx
// Renders a different dashboard view depending on the logged-in user's role.
// Adapt useAuth()/user shape to match your actual auth context.

import { useAuth } from "../auth/AuthContext";
import { normaliseRole } from "../auth/normaliseRole";
import EventOrganiserDashboard from "./EventOrganiserDashboard";
import EventCoordinatorDashboard from "./EventCoordinatorDashboard";
import VenueStaffDashboard from "./VenueStaffDashboard";
import TechnicalSupportDashboard from "./TechnicalSupportDashboard";

const DASHBOARD_BY_ROLE = {
  EVENT_ORGANISER: EventOrganiserDashboard,
  EVENT_COORDINATOR: EventCoordinatorDashboard,
  VENUE_STAFF: VenueStaffDashboard,
  // TECHNICAL_SUPPORT_STAFF, not TECHNICAL_SUPPORT. The key has to be what
  // normaliseRole produces from the token's role, and the short form matched
  // nothing — Technical Support saw "No dashboard available for your role".
  TECHNICAL_SUPPORT_STAFF: TechnicalSupportDashboard,
};

export default function Dashboard() {
  const { user } = useAuth();

  if (!user) {
    return <p>Loading...</p>;
  }

  const RoleDashboard = DASHBOARD_BY_ROLE[normaliseRole(user.role)];

  if (!RoleDashboard) {
    return <p>No dashboard available for your role. Please contact support.</p>;
  }

  return <RoleDashboard user={user} />;
}
