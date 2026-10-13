// eventRequestReviewRoute.test.jsx
//
// SCRUM-486 (SCRUM-521). /event-requests/:eventRequestId renders the REAL
// App, so this pins App.jsx's route table: an event's coordinator screen by
// its address, for Event Coordinators and the Event Coordinator Lead, the two
// roles GET /event-requests/:id/review admits. Only the auth context and the
// page itself are mocked; the real ProtectedRoute and /unauthorized page run.
// The same arrangement as unassignedQueueRoute.test.jsx.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import App from "../../src/App.jsx";
import { useAuth } from "../../src/auth/AuthContext";

vi.mock("../../src/auth/AuthContext", () => ({
  AuthProvider: ({ children }) => children,
  useAuth: vi.fn(),
}));

vi.mock("../../src/components/EventRequestReviewPage", () => ({
  default: function EventRequestReviewPageStub() {
    return <p data-testid="event-review-stub">Event screen</p>;
  },
}));

const PATH = "/event-requests/22222222-2222-4222-8222-222222222222";

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

describe("SCRUM486 /event-requests/:eventRequestId", () => {
  it.each(["event_coordinator_lead", "event_coordinator"])(
    "SCRUM486_AC6_opens_the_event_screen_for_%s_inside_the_coordinator_wrapper",
    (role) => {
      renderAppAt(PATH, role);

      const stub = screen.getByTestId("event-review-stub");
      // The wrapper colours the status badge (App.css scopes it).
      expect(stub.closest(".dashboard--coordinator")).not.toBeNull();
      expect(window.location.pathname).toBe(PATH);
    },
  );

  it.each(["event_organiser", "venue_staff", "technical_support_staff", "attendee", "safety_officer"])(
    "SCRUM486_AC6_sends_%s_to_unauthorized_and_never_mounts_the_screen",
    (role) => {
      renderAppAt(PATH, role);

      expect(screen.queryByTestId("event-review-stub")).not.toBeInTheDocument();
      expect(window.location.pathname).toBe("/unauthorized");
    },
  );

  it("SCRUM486_AC6_sends_a_signed_out_visitor_to_login", () => {
    renderAppAt(PATH, null);

    expect(screen.queryByTestId("event-review-stub")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/login");
  });
});
