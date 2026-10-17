// scrum172InboxOnEveryDashboard.test.jsx
//
// SCRUM-172 AC1: every user sees their own notifications. The inbox lives on
// each role's dashboard, which is where the nav's Notifications link points,
// so a dashboard that drops it leaves that role with no inbox at all.
//
// The inbox and each dashboard's other sections are stubs: what is under test
// is that the page each role lands on mounts the inbox. The inbox itself is
// tested in NotificationInbox.test.jsx.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import Dashboard from "../../src/components/Dashboard.jsx";
import { useAuth } from "../../src/auth/AuthContext";

vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../../src/components/NotificationInbox", () => ({
  default: () => <section id="notifications" data-testid="notification-inbox" />,
}));

// The dashboards' other sections, stubbed so none of them fetches.
vi.mock("../../src/components/MyAssignedEvents", () => ({ default: () => null }));
vi.mock("../../src/components/ReviewQueue", () => ({ default: () => null }));
vi.mock("../../src/components/UnassignedQueue", () => ({ default: () => null }));
vi.mock("../../src/components/PendingBookingRequests", () => ({ default: () => null }));
vi.mock("../../src/components/FlaggedBookings", () => ({ default: () => null }));
vi.mock("../../src/components/VenueCatalogue", () => ({ default: () => null }));

vi.mock("../../src/services/eventRequestService", () => ({
  getMyEventRequests: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/services/supportService", () => ({
  getOpenTickets: vi.fn().mockResolvedValue([]),
  getEquipmentRequests: vi.fn().mockResolvedValue([]),
}));

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
});

describe("SCRUM172_AC1 every role's dashboard has the inbox", () => {
  it.each([
    "event_organiser",
    "event_coordinator",
    "venue_staff",
    "technical_support_staff",
    "attendee",
    "event_coordinator_lead",
    "safety_officer",
  ])("SCRUM172_AC1_every_role_dashboard_has_the_inbox (%s)", async (role) => {
    vi.mocked(useAuth).mockReturnValue({ user: { id: "u1", email: "user@example.com", role } });

    const { container } = render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("notification-inbox")).toBeInTheDocument();
    // Exactly one: the nav link's #notifications must name a single target.
    expect(container.querySelectorAll("#notifications")).toHaveLength(1);
  });
});
