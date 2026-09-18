// Dashboard.jsx
// Renders a different dashboard view depending on the logged-in user's role.
// Adapt useAuth()/user shape to match your actual auth context.

import { useAuth } from "../auth/AuthContext";
import EventOrganiserDashboard from "./EventOrganiserDashboard";
import EventCoordinatorDashboard from "./EventCoordinatorDashboard";
import VenueStaffDashboard from "./VenueStaffDashboard";
import TechnicalSupportDashboard from "./TechnicalSupportDashboard";

const DASHBOARD_BY_ROLE = {
  EVENT_ORGANISER: EventOrganiserDashboard,
  EVENT_COORDINATOR: EventCoordinatorDashboard,
  VENUE_STAFF: VenueStaffDashboard,
  TECHNICAL_SUPPORT: TechnicalSupportDashboard,
};

export default function Dashboard() {
  const { user } = useAuth();

  if (!user) {
    return <p>Loading...</p>;
  }

  const RoleDashboard = DASHBOARD_BY_ROLE[user.role];

  if (!RoleDashboard) {
    return <p>No dashboard available for your role. Please contact support.</p>;
  }

  return <RoleDashboard user={user} />;
}
