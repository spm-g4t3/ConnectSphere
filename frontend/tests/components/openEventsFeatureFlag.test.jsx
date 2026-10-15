// SCRUM-495: Browse Open Events ships dark. With VITE_OPEN_EVENTS_ENABLED unset
// nothing offers it, and its routes do not exist, so no Attendee reaches a
// page whose tables are not in the database yet.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import AttendeeDashboard from "../../src/components/AttendeeDashboard.jsx";
import Navigation from "../../src/components/Navigation.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import { isOpenEventsEnabled } from "../../src/services/openEventRoutes";

vi.mock("../../src/auth/AuthContext", () => ({ useAuth: vi.fn() }));

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(useAuth).mockReturnValue({
    user: { name: "Ada", email: "ada@example.com", role: "attendee" },
    logout: vi.fn(),
  });
});

describe("SCRUM495 the open events feature flag", () => {
  it.each([undefined, "", "false", "TRUE", "1"])("SCRUM495_AC2_is_off_for_%j", (value) => {
    if (value !== undefined) vi.stubEnv("VITE_OPEN_EVENTS_ENABLED", value);

    expect(isOpenEventsEnabled()).toBe(false);
  });

  it("SCRUM495_AC2_is_on_only_for_true", () => {
    vi.stubEnv("VITE_OPEN_EVENTS_ENABLED", "true");

    expect(isOpenEventsEnabled()).toBe(true);
  });

  it("SCRUM495_AC2_the_nav_has_no_browse_open_events_link_while_off", () => {
    render(<MemoryRouter><Navigation /></MemoryRouter>);

    expect(screen.queryByRole("link", { name: "Browse Open Events" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
  });

  it("SCRUM495_AC2_the_dashboard_has_no_browse_open_events_entry_while_off", () => {
    render(<MemoryRouter><AttendeeDashboard user={{ name: "Ada" }} /></MemoryRouter>);

    expect(screen.getByRole("heading", { name: "Welcome, Ada" })).toBeInTheDocument();
    expect(screen.queryByText("Browse Open Events")).not.toBeInTheDocument();
  });
});
