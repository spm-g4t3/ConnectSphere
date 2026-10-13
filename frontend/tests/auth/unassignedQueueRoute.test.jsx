// unassignedQueueRoute.test.jsx
//
// SCRUM-486 (SCRUM-519). The /unassigned-queue route renders the REAL App, so
// this pins App.jsx's actual route table: the queue is the Event Coordinator
// Lead's only, a second layer on the backend's 403. Only the auth context and
// the queue component itself are mocked; the real ProtectedRoute,
// Navigation and /unauthorized page run. The same arrangement as
// myVenueRequestsRoute.test.jsx.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

import App from "../../src/App.jsx";
import { useAuth } from "../../src/auth/AuthContext";

vi.mock("../../src/auth/AuthContext", () => ({
  AuthProvider: ({ children }) => children,
  useAuth: vi.fn(),
}));

vi.mock("../../src/components/UnassignedQueue", () => ({
  default: function UnassignedQueueStub() {
    return <p data-testid="unassigned-queue-stub">Unassigned queue</p>;
  },
}));

function renderAppAt(path, role) {
  vi.mocked(useAuth).mockReturnValue({
    user: role ? { id: "u1", name: "Test User", role } : null,
    loading: false,
    logout: vi.fn().mockResolvedValue({ success: true }),
    logoutMessage: null,
    clearLogoutMessage: vi.fn(),
  });
  window.history.pushState({}, "", path);
  return render(<App />);
}

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
});

describe("SCRUM486 /unassigned-queue", () => {
  it.each(["event_coordinator_lead", "Event Coordinator Lead", " EVENT_COORDINATOR_LEAD "])(
    "SCRUM486_AC2_renders_the_queue_for_%j_inside_the_lead_wrapper",
    (role) => {
      renderAppAt("/unassigned-queue", role);

      const stub = screen.getByTestId("unassigned-queue-stub");
      expect(stub.closest(".dashboard--coordinator-lead")).not.toBeNull();
      expect(window.location.pathname).toBe("/unassigned-queue");
    },
  );

  it("SCRUM486_AC2_the_leads_nav_link_points_at_the_route", () => {
    // The link and the route are added together, so the link lands on the
    // page it names, not on the catch-all redirect.
    renderAppAt("/unassigned-queue", "event_coordinator_lead");

    const nav = screen.getByRole("navigation");
    expect(within(nav).getByRole("link", { name: "Unassigned Queue" })).toHaveAttribute("href", "/unassigned-queue");
  });

  it.each(["event_coordinator", "event_organiser", "venue_staff", "technical_support_staff", "attendee", "safety_officer"])(
    "SCRUM486_AC2_sends_%s_to_unauthorized_and_never_mounts_the_queue",
    (role) => {
      // A coordinator too: the queue is the Lead's worklist, and only a Lead
      // can assign (052).
      renderAppAt("/unassigned-queue", role);

      expect(screen.queryByTestId("unassigned-queue-stub")).not.toBeInTheDocument();
      expect(window.location.pathname).toBe("/unauthorized");
    },
  );

  it("SCRUM486_AC2_sends_a_signed_out_visitor_to_login", () => {
    renderAppAt("/unassigned-queue", null);

    expect(screen.queryByTestId("unassigned-queue-stub")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/login");
  });
});
