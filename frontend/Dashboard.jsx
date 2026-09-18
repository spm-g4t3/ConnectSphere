// Dashboard.jsx
// Renders a different dashboard view depending on the logged-in user's role.
// Adapt useAuth()/user shape to match your actual auth context.

import { useAuth } from "../auth/AuthContext";
import EventOrganiserDashboard from "./EventOrganiserDashboard";
import EventCoordinatorDashboard from "./EventCoordinatorDashboard";
import VenueStaffDashboard from "./VenueStaffDashboard";
import TechnicalSupportDashboard from "./TechnicalSupportDashboard";

const DASHBOARD_BY_ROLE = {
  event_organiser: EventOrganiserDashboard,
  event_coordinator: EventCoordinatorDashboard,
  venue_staff: VenueStaffDashboard,
  technical_support: TechnicalSupportDashboard,
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
