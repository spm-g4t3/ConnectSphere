// venueCalendarRoute.test.jsx
//
// SCRUM-180 (part of SCRUM-178). The /venues/:venueId/calendar route renders
// the REAL App, so this pins App.jsx's actual route table: the calendar is
// signed-in only, takes its venue from the URL, and (until SCRUM-182 adds
// allowedRoles) is not role-gated on the client -- the backend's 403 keeps an
// Organiser out. Only the auth context and VenueCalendar itself are mocked.
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

vi.mock("../../src/components/VenueCalendar", () => ({
  default: ({ venueId, initialDate }) => (
    <p data-testid="venue-calendar-stub" data-initial-date={String(initialDate)}>
      Calendar for {venueId}
    </p>
  ),
}));

const VENUE_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const OTHER_VENUE_ID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";

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

describe("/venues/:venueId/calendar route", () => {
  it.each(["venue_staff", "event_coordinator"])(
    "SCRUM178_AC4_renders_the_calendar_for_the_url_venue_for_%s",
    (role) => {
      renderAppAt(`/venues/${VENUE_ID}/calendar`, role);

      const stub = screen.getByTestId("venue-calendar-stub");
      expect(stub).toHaveTextContent(`Calendar for ${VENUE_ID}`);
      // No initialDate is passed, so the calendar opens on today.
      expect(stub).toHaveAttribute("data-initial-date", "undefined");
      expect(stub.closest("main")).toHaveClass("venue-calendar-page");
      expect(window.location.pathname).toBe(`/venues/${VENUE_ID}/calendar`);
    },
  );

  it("SCRUM178_AC4_is_not_role_gated_on_the_client_yet", () => {
    // SCRUM-182 adds allowedRoles; until then an Organiser reaches the page
    // and sees the backend's 403 as a message.
    renderAppAt(`/venues/${VENUE_ID}/calendar`, "event_organiser");

    expect(screen.getByTestId("venue-calendar-stub")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Not available to your role" })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe(`/venues/${VENUE_ID}/calendar`);
  });

  it("SCRUM178_AC4_passes_whichever_venue_id_the_url_names", () => {
    renderAppAt(`/venues/${OTHER_VENUE_ID}/calendar`, "venue_staff");

    expect(screen.getByTestId("venue-calendar-stub")).toHaveTextContent(`Calendar for ${OTHER_VENUE_ID}`);
  });

  it("SCRUM178_AC4_sends_a_signed_out_visitor_to_login", () => {
    renderAppAt(`/venues/${VENUE_ID}/calendar`, null);

    expect(screen.queryByTestId("venue-calendar-stub")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/login");
  });
});
