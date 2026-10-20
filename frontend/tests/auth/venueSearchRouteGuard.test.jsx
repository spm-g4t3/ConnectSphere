// venueSearchRouteGuard.test.jsx
//
// The /venue-search route is limited to Event Coordinators and Venue Staff.
// This renders the REAL App, so the test pins App.jsx's actual route table
// rather than a copy of it: if someone drops or widens the allowedRoles on
// /venue-search, this fails. Only the auth context and VenueSearch itself are
// mocked; the real ProtectedRoute, Navigation and /unauthorized page run.
//
// App owns a BrowserRouter, so the starting URL is set through the History
// API before rendering, and the redirect is read back off window.location.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";

import { useAuth } from "../../src/auth/AuthContext";
import { renderAppAt as renderApp } from "../helpers/renderApp.js";

vi.mock("../../src/auth/AuthContext", async () => (await import("../helpers/authMock.js")).authContextMock());

vi.mock("../../src/components/VenueSearch", () => ({
  default: () => <p data-testid="venue-search-stub">Venue search page</p>,
}));

// These cases sign in a user without an id.
const renderAppAt = (path, role) => renderApp(path, role, { name: "Test User" });

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
});

describe("/venue-search route guard", () => {
  it("sends an Event Organiser to /unauthorized", () => {
    renderAppAt("/venue-search", "event_organiser");

    expect(screen.queryByTestId("venue-search-stub")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Not available to your role" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/unauthorized");
  });

  it.each(["event_coordinator_lead", "safety_officer"])(
    "SCRUM485_AC5_sends_%s_to_unauthorized_from_venue_search",
    (role) => {
      // AC5-14. ProtectedRoute normalises both sides, and EVENT_COORDINATOR_LEAD
      // is not EVENT_COORDINATOR: the Lead inherits no coordinator page.
      renderAppAt("/venue-search", role);

      expect(screen.queryByTestId("venue-search-stub")).not.toBeInTheDocument();
      expect(window.location.pathname).toBe("/unauthorized");
    },
  );

  it.each(["event_coordinator", "venue_staff"])("lets %s see the venue search page", (role) => {
    renderAppAt("/venue-search", role);

    expect(screen.getByTestId("venue-search-stub")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Not available to your role" })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/venue-search");
  });

  it("sends a signed-out visitor to /login rather than /unauthorized", () => {
    renderAppAt("/venue-search", null);

    expect(screen.queryByTestId("venue-search-stub")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/login");
  });
});
