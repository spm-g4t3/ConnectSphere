// venueCalendarRoute.test.jsx
//
// SCRUM-180 (part of SCRUM-178). The /venues/:venueId/calendar route renders
// the REAL App, so this pins App.jsx's actual route table: the calendar is
// signed-in only, takes its venue from the URL, and (SCRUM-182, AC6) is
// limited on the client to Event Coordinators and Venue Staff -- a second
// layer on top of the backend's 403, so an Organiser, Attendee or Technical
// Support user lands on /unauthorized and the calendar never mounts. Only the
// auth context and VenueCalendar itself are mocked; the real ProtectedRoute
// and /unauthorized page run.
//
// App owns a BrowserRouter, so the starting URL is set through the History
// API before rendering, and the redirect is read back off window.location.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useEffect } from "react";

import App from "../../src/App.jsx";
import { useAuth } from "../../src/auth/AuthContext";

vi.mock("../../src/auth/AuthContext", () => ({
  AuthProvider: ({ children }) => children,
  useAuth: vi.fn(),
}));

// mounts counts how many times the stub has MOUNTED (not rendered), so a key
// change is visible as a new mount; lastInitialDate keeps the prop itself, so
// the Date can be checked rather than its string form.
const calendarStub = vi.hoisted(() => ({ mounts: 0, lastInitialDate: undefined }));

vi.mock("../../src/components/VenueCalendar", () => ({
  default: function VenueCalendarStub({ venueId, initialDate }) {
    calendarStub.lastInitialDate = initialDate;
    useEffect(() => {
      calendarStub.mounts += 1;
    }, []);
    return (
      <p data-testid="venue-calendar-stub" data-initial-date={String(initialDate)}>
        Calendar for {venueId}
      </p>
    );
  },
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
  calendarStub.mounts = 0;
  calendarStub.lastInitialDate = undefined;
});

/** Client-side navigation inside App's BrowserRouter, as a Link click does it. */
function navigateTo(path) {
  act(() => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

describe("SCRUM178_AC1 /venues/:venueId/calendar route opens the calendar", () => {
  it.each(["venue_staff", "event_coordinator"])(
    "SCRUM178_AC1_renders_the_calendar_for_the_url_venue_for_%s",
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

  it("SCRUM178_AC1_passes_whichever_venue_id_the_url_names", () => {
    renderAppAt(`/venues/${OTHER_VENUE_ID}/calendar`, "venue_staff");

    expect(screen.getByTestId("venue-calendar-stub")).toHaveTextContent(`Calendar for ${OTHER_VENUE_ID}`);
  });
});

describe("SCRUM178_AC6 /venues/:venueId/calendar route is limited to internal roles", () => {
  it.each([
    ["event_coordinator"],
    ["venue_staff"],
    // ProtectedRoute compares through normaliseRole, so case and separators
    // in the token's role do not matter.
    ["VENUE_STAFF"],
    ["Event_Coordinator"],
    ["venue-staff"],
  ])("SCRUM178_AC6_%s_can_open_the_calendar", (role) => {
    renderAppAt(`/venues/${VENUE_ID}/calendar`, role);

    expect(screen.getByTestId("venue-calendar-stub")).toHaveTextContent(`Calendar for ${VENUE_ID}`);
    expect(screen.queryByRole("heading", { name: "Not available to your role" })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe(`/venues/${VENUE_ID}/calendar`);
    expect(calendarStub.mounts).toBe(1);
  });

  it.each([
    ["event_organiser"],
    ["attendee"],
    ["technical_support_staff"],
  ])("SCRUM178_AC6_%s_is_sent_to_unauthorized_and_never_mounts_the_calendar", (role) => {
    renderAppAt(`/venues/${VENUE_ID}/calendar?date=2026-11-03`, role);

    expect(window.location.pathname).toBe("/unauthorized");
    expect(screen.getByRole("heading", { name: "Not available to your role" })).toBeInTheDocument();
    expect(screen.queryByTestId("venue-calendar-stub")).not.toBeInTheDocument();
    expect(calendarStub.mounts).toBe(0);
    expect(calendarStub.lastInitialDate).toBeUndefined();
  });

  it("SCRUM178_AC6_sends_a_signed_out_visitor_to_login", () => {
    renderAppAt(`/venues/${VENUE_ID}/calendar`, null);

    expect(screen.queryByTestId("venue-calendar-stub")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/login");
  });
});

describe("SCRUM178_AC1 /venues/:venueId/calendar ?date= (SCRUM-181)", () => {
  it("SCRUM178_AC1_a_valid_date_opens_the_calendar_on_that_local_day", () => {
    renderAppAt(`/venues/${VENUE_ID}/calendar?date=2026-11-03`, "venue_staff");

    expect(screen.getByTestId("venue-calendar-stub")).toHaveTextContent(`Calendar for ${VENUE_ID}`);
    const initialDate = calendarStub.lastInitialDate;
    expect(initialDate).toBeInstanceOf(Date);
    expect(initialDate).toEqual(new Date(2026, 10, 3));
    expect([initialDate.getFullYear(), initialDate.getMonth(), initialDate.getDate()]).toEqual([2026, 10, 3]);
    expect([initialDate.getHours(), initialDate.getMinutes(), initialDate.getSeconds()]).toEqual([0, 0, 0]);
  });

  it.each([
    ["garbage", "?date=garbage"],
    ["an impossible date", "?date=2026-02-30"],
    ["an empty date", "?date="],
    ["no date", ""],
  ])("SCRUM178_AC1_%s_leaves_initialDate_undefined_so_today_applies", (_label, query) => {
    renderAppAt(`/venues/${VENUE_ID}/calendar${query}`, "venue_staff");

    expect(screen.getByTestId("venue-calendar-stub")).toHaveAttribute("data-initial-date", "undefined");
    expect(calendarStub.lastInitialDate).toBeUndefined();
  });

  it("SCRUM178_AC1_a_new_date_remounts_the_calendar", () => {
    renderAppAt(`/venues/${VENUE_ID}/calendar?date=2026-11-03`, "venue_staff");
    expect(calendarStub.mounts).toBe(1);

    navigateTo(`/venues/${VENUE_ID}/calendar?date=2026-12-01`);

    expect(calendarStub.mounts).toBe(2);
    expect(calendarStub.lastInitialDate).toEqual(new Date(2026, 11, 1));
  });

  it("SCRUM178_AC1_dropping_the_date_remounts_the_calendar_on_today", () => {
    renderAppAt(`/venues/${VENUE_ID}/calendar?date=2026-11-03`, "venue_staff");
    expect(calendarStub.mounts).toBe(1);

    navigateTo(`/venues/${VENUE_ID}/calendar`);

    expect(calendarStub.mounts).toBe(2);
    expect(calendarStub.lastInitialDate).toBeUndefined();
  });

  it("SCRUM178_AC1_a_new_venue_with_the_same_date_remounts_the_calendar", () => {
    renderAppAt(`/venues/${VENUE_ID}/calendar?date=2026-11-03`, "venue_staff");

    navigateTo(`/venues/${OTHER_VENUE_ID}/calendar?date=2026-11-03`);

    expect(calendarStub.mounts).toBe(2);
    expect(screen.getByTestId("venue-calendar-stub")).toHaveTextContent(`Calendar for ${OTHER_VENUE_ID}`);
  });

  it("SCRUM178_AC1_the_same_url_again_does_not_remount_the_calendar", () => {
    // The control for the remount tests: navigation alone is not a remount.
    renderAppAt(`/venues/${VENUE_ID}/calendar?date=2026-11-03`, "venue_staff");

    navigateTo(`/venues/${VENUE_ID}/calendar?date=2026-11-03`);

    expect(calendarStub.mounts).toBe(1);
    expect(calendarStub.lastInitialDate).toEqual(new Date(2026, 10, 3));
  });
});
