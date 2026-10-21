// flaggedBookingsRoute.test.jsx
//
// SCRUM-266. /flagged-bookings renders the REAL App, so this pins App.jsx's
// route table: Venue Staff's nav link opens the flagged bookings list, and
// every other role is turned away as on other gated routes. The list
// component is real; only the auth context and its service are mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";

import { useAuth } from "../../src/auth/AuthContext";
import { getFlaggedBookings } from "../../src/services/flaggedBookingService";
import { renderAppAt } from "../helpers/renderApp.js";

vi.mock("../../src/auth/AuthContext", async () => (await import("../helpers/authMock.js")).authContextMock());

vi.mock("../../src/services/flaggedBookingService", () => ({
  getFlaggedBookings: vi.fn(),
  reinstateFlaggedBooking: vi.fn(),
  cancelFlaggedBooking: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
  vi.mocked(getFlaggedBookings).mockReset().mockResolvedValue([]);
});

describe("SCRUM266 /flagged-bookings", () => {
  it("SCRUM266_AC1_venue_staff_see_the_flagged_bookings_list", async () => {
    renderAppAt("/flagged-bookings", "venue_staff");

    const heading = screen.getByRole("heading", { name: "Flagged bookings" });
    // The wrapper is what styles the cards.
    expect(heading.closest(".dashboard--venue-staff")).not.toBeNull();
    expect(await screen.findByText("No bookings are flagged for review.")).toBeInTheDocument();
    expect(getFlaggedBookings).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/still being built/)).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/flagged-bookings");
  });

  it("SCRUM266_AC1_the_venue_staff_nav_links_to_the_list", async () => {
    renderAppAt("/flagged-bookings", "venue_staff");

    expect(screen.getByRole("link", { name: "Flagged Bookings" })).toHaveAttribute("href", "/flagged-bookings");
    await screen.findByText("No bookings are flagged for review.");
  });

  it.each([
    "event_organiser",
    "event_coordinator",
    "technical_support_staff",
    "attendee",
    "event_coordinator_lead",
    "safety_officer",
  ])("SCRUM266_AC1_sends_%s_to_unauthorized_and_never_loads_the_list", (role) => {
    renderAppAt("/flagged-bookings", role);

    expect(screen.queryByRole("heading", { name: "Flagged bookings" })).not.toBeInTheDocument();
    expect(getFlaggedBookings).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/unauthorized");
  });

  it("SCRUM266_AC1_sends_a_signed_out_visitor_to_login", () => {
    renderAppAt("/flagged-bookings", null);

    expect(screen.queryByRole("heading", { name: "Flagged bookings" })).not.toBeInTheDocument();
    expect(getFlaggedBookings).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/login");
  });
});
