// Navigation.test.jsx
//
// Which links each role's nav renders. Pins the change that took "Find a
// Venue" away from Event Organisers: venue search is the Coordinator's
// planning tool, and an Organiser states venue needs on the request instead.
// Roles are written as the token sends them (lower snake case), so these tests
// also exercise normaliseRole's mapping onto the nav's keys.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import Navigation from "../../src/components/Navigation.jsx";
import { useAuth } from "../../src/auth/AuthContext";

vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: vi.fn(),
}));

function renderAs(role) {
  vi.mocked(useAuth).mockReturnValue({
    user: { name: "Test User", role },
    logout: vi.fn().mockResolvedValue({ success: true }),
  });
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <Navigation />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
});

describe("Navigation links by role", () => {
  it("gives an Event Organiser Dashboard and My Events but no Find a Venue", () => {
    renderAs("event_organiser");

    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/dashboard");
    expect(screen.getByRole("link", { name: "My Events" })).toHaveAttribute("href", "/events");
    expect(screen.queryByRole("link", { name: "Find a Venue" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /venue/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("treats the American spelling of organiser the same way", () => {
    renderAs("event_organizer");

    expect(screen.getByRole("link", { name: "My Events" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Find a Venue" })).not.toBeInTheDocument();
  });

  it("keeps Find a Venue for an Event Coordinator, pointing at /venue-search", () => {
    renderAs("event_coordinator");

    expect(screen.getByRole("link", { name: "Find a Venue" })).toHaveAttribute("href", "/venue-search");
    expect(screen.getByRole("link", { name: "Review Queue" })).toHaveAttribute("href", "/review-queue");
  });

  it("gives Venue Staff no Find a Venue link", () => {
    renderAs("venue_staff");

    expect(screen.getByRole("link", { name: "Venue Catalogue" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Find a Venue" })).not.toBeInTheDocument();
  });

  it("gives Technical Support Staff an Equipment Catalogue link", () => {
  renderAs("technical_support_staff");

  expect(screen.getByRole("link", { name: "Equipment Catalogue" })).toHaveAttribute("href", "/equipment-catalogue");
});
});
