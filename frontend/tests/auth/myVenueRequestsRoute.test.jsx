// myVenueRequestsRoute.test.jsx
//
// SCRUM-255. The /my-venue-requests route renders the REAL App, so this pins
// App.jsx's actual route table: the list is for Event Coordinators only, a
// second layer on the backend's 403. Only the auth context and the list
// component itself are mocked; the real ProtectedRoute and /unauthorized page
// run. The same arrangement as venueCalendarRoute.test.jsx.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";

import { useAuth } from "../../src/auth/AuthContext";
import { renderAppAt } from "../helpers/renderApp.js";

vi.mock("../../src/auth/AuthContext", async () => (await import("../helpers/authMock.js")).authContextMock());

vi.mock("../../src/components/MyBookingRequests", () => ({
  default: function MyBookingRequestsStub() {
    return <p data-testid="my-booking-requests-stub">Venue requests</p>;
  },
}));

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
});

describe("SCRUM255 /my-venue-requests", () => {
  it("SCRUM255_renders_the_list_for_an_event_coordinator_inside_the_coordinator_wrapper", () => {
    renderAppAt("/my-venue-requests", "event_coordinator");

    const stub = screen.getByTestId("my-booking-requests-stub");
    // The wrapper is what colours the status badges.
    expect(stub.closest(".dashboard--coordinator")).not.toBeNull();
    expect(window.location.pathname).toBe("/my-venue-requests");
  });

  it.each(["event_organiser", "venue_staff", "technical_support_staff", "attendee", "event_coordinator_lead", "safety_officer"])(
    "SCRUM255_sends_%s_to_unauthorized_and_never_mounts_the_list",
    (role) => {
      renderAppAt("/my-venue-requests", role);

      expect(screen.queryByTestId("my-booking-requests-stub")).not.toBeInTheDocument();
      expect(window.location.pathname).toBe("/unauthorized");
    },
  );

  it("SCRUM255_sends_a_signed_out_visitor_to_login", () => {
    renderAppAt("/my-venue-requests", null);

    expect(screen.queryByTestId("my-booking-requests-stub")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/login");
  });
});
