// venueCatalogueRouteGuard.test.jsx
//
// SCRUM-493 (G-02, case F-AC1-01). /venue-catalogue is the only screen with
// the venue create and edit form, so it is where emergency access and known
// restrictions are recorded. This renders the REAL App, so it pins App.jsx's
// actual route table: if someone drops or widens allowedRoles={["venue_staff"]}
// on /venue-catalogue, this fails. Only the auth context and VenueCatalogue
// itself are mocked; the real ProtectedRoute, Navigation and /unauthorized
// page run.
//
// The frontend has no role-constants module, so the role list below is the
// five values of the backend's ROLE (backend/src/domain/userRole.js), spelled
// as the token carries them.
//
// App owns a BrowserRouter, so the starting URL is set through the History
// API before rendering, and the redirect is read back off window.location.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import App from "../../src/App.jsx";
import { useAuth } from "../../src/auth/AuthContext";

vi.mock("../../src/auth/AuthContext", () => ({
  AuthProvider: ({ children }) => children,
  useAuth: vi.fn(),
}));

vi.mock("../../src/components/VenueCatalogue", () => ({
  default: () => <p data-testid="venue-catalogue-stub">Venue catalogue page</p>,
}));

const OTHER_ROLES = ["event_organiser", "event_coordinator", "technical_support_staff", "attendee"];

function renderAppAt(path, role) {
  vi.mocked(useAuth).mockReturnValue({
    user: role ? { name: "Test User", role } : null,
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

describe("SCRUM493 /venue-catalogue route guard", () => {
  describe("SCRUM493_AC1_only_venue_staff_reach_the_venue_catalogue", () => {
    it("lets venue_staff see the venue catalogue", () => {
      renderAppAt("/venue-catalogue", "venue_staff");

      expect(screen.getByTestId("venue-catalogue-stub")).toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "Not available to your role" }),
      ).not.toBeInTheDocument();
      expect(window.location.pathname).toBe("/venue-catalogue");
    });

    it.each(OTHER_ROLES)("sends %s to /unauthorized", (role) => {
      renderAppAt("/venue-catalogue", role);

      expect(screen.queryByTestId("venue-catalogue-stub")).not.toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Not available to your role" }),
      ).toBeInTheDocument();
      expect(window.location.pathname).toBe("/unauthorized");
    });
  });

  it("SCRUM493_AC1_a_signed_out_visitor_is_sent_to_login", () => {
    renderAppAt("/venue-catalogue", null);

    expect(screen.queryByTestId("venue-catalogue-stub")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/login");
  });
});
