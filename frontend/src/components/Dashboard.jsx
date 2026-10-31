// Dashboard.jsx
// Renders a different dashboard view depending on the logged-in user's role.

import { useAuth } from "../auth/AuthContext";
import { normaliseRole } from "../auth/normaliseRole";
import EventOrganiserDashboard from "./EventOrganiserDashboard";
import EventCoordinatorDashboard from "./EventCoordinatorDashboard";
import VenueStaffDashboard from "./VenueStaffDashboard";
import TechnicalSupportDashboard from "./TechnicalSupportDashboard";
import AttendeeDashboard from "./AttendeeDashboard";
import EventCoordinatorLeadDashboard from "./EventCoordinatorLeadDashboard";
import SafetyOfficerDashboard from "./SafetyOfficerDashboard";
import EmptyState from "./ui/EmptyState";
import LoadingText from "./ui/LoadingText";

const DASHBOARD_BY_ROLE = {
  EVENT_ORGANISER: EventOrganiserDashboard,
  EVENT_COORDINATOR: EventCoordinatorDashboard,
  VENUE_STAFF: VenueStaffDashboard,
  // TECHNICAL_SUPPORT_STAFF, not TECHNICAL_SUPPORT. The key has to be what
  // normaliseRole produces from the token's role, and the short form matched
  // nothing — Technical Support saw the "No dashboard" message.
  TECHNICAL_SUPPORT_STAFF: TechnicalSupportDashboard,
  ATTENDEE: AttendeeDashboard,
  // SCRUM-485 (SCRUM-509). The same rule: normaliseRole turns
  // event_coordinator_lead into EVENT_COORDINATOR_LEAD, the whole value, so
  // that is the key. EVENT_COORDINATOR, the key above, is a different role,
  // and a Lead must not land on the Coordinator's page. A misspelt key here
  // throws nothing; it shows the "No dashboard" message below, which is why
  // tests/components/Dashboard.test.jsx asserts each role's own page.
  EVENT_COORDINATOR_LEAD: EventCoordinatorLeadDashboard,
  SAFETY_OFFICER: SafetyOfficerDashboard,
};

export default function Dashboard() {
  const { user } = useAuth();

  if (!user) {
    return <LoadingText />;
  }

  const RoleDashboard = DASHBOARD_BY_ROLE[normaliseRole(user.role)];

  if (!RoleDashboard) {
    return (
      <EmptyState
        message="No dashboard is available for your role."
        nextStep="Ask your Event Coordinator Lead to check your role."
      />
    );
  }

  return <RoleDashboard user={user} />;
}
