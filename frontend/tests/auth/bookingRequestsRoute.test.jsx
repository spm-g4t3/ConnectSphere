// bookingRequestsRoute.test.jsx
//
// SCRUM-258. /booking-requests renders the REAL App, so this pins App.jsx's
// route table: Venue Staff's nav link opens the pending queue, not a
// placeholder, and other roles are turned away as on other gated routes. The
// queue component is real; only the auth context and its service are mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import App from "../../src/App.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import { getPendingBookingRequests } from "../../src/services/bookingRequestService";

vi.mock("../../src/auth/AuthContext", () => ({
  AuthProvider: ({ children }) => children,
  useAuth: vi.fn(),
}));

vi.mock("../../src/services/bookingRequestService", () => ({
  getPendingBookingRequests: vi.fn(),
  approveBookingRequest: vi.fn(),
  rejectBookingRequest: vi.fn(),
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
  vi.mocked(getPendingBookingRequests).mockReset().mockResolvedValue([]);
});

describe("SCRUM258 /booking-requests", () => {
  it("SCRUM258_AC1_venue_staff_see_the_pending_queue_not_a_placeholder", async () => {
    renderAppAt("/booking-requests", "venue_staff");

    const heading = screen.getByRole("heading", { name: "Pending booking requests" });
    // The wrapper is what styles the cards and colours the badges.
    expect(heading.closest(".dashboard--venue-staff")).not.toBeNull();
    expect(await screen.findByText("No pending booking requests.")).toBeInTheDocument();
    expect(getPendingBookingRequests).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/still being built/)).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/booking-requests");
  });

  it.each(["event_organiser", "event_coordinator", "technical_support_staff", "attendee", "event_coordinator_lead", "safety_officer"])(
    "SCRUM258_AC1_sends_%s_to_unauthorized_and_never_loads_the_queue",
    (role) => {
      renderAppAt("/booking-requests", role);

      expect(screen.queryByRole("heading", { name: "Pending booking requests" })).not.toBeInTheDocument();
      expect(getPendingBookingRequests).not.toHaveBeenCalled();
      expect(window.location.pathname).toBe("/unauthorized");
    },
  );
});
