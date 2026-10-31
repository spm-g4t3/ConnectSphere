// scrum587BookingScreens.test.jsx
//
// The UI standard on Venue Staff's booking screens: one h1 per page, the
// shared Button for actions, and StatusBadge tones for booking statuses. Only
// apiClient is mocked, so the real services feed the real screens; the venue
// catalogue is stubbed on the dashboard as it has its own tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import PendingBookingRequests from "../../src/components/PendingBookingRequests.jsx";
import FlaggedBookings from "../../src/components/FlaggedBookings.jsx";
import VenueStaffDashboard from "../../src/components/VenueStaffDashboard.jsx";
import { apiClient } from "../../src/services/apiClient";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: () => ({ user: null }),
}));

vi.mock("../../src/components/VenueCatalogue", () => ({ default: () => null }));

const PERIOD = {
  startsAt: "2026-12-01T09:00:00+08:00",
  endsAt: "2026-12-01T17:00:00+08:00",
  occupiedStartsAt: "2026-12-01T09:00:00+08:00",
  occupiedEndsAt: "2026-12-01T17:00:00+08:00",
};

function pendingItem(id, status, label, group) {
  return {
    id,
    eventName: `Event ${id}`,
    eventStatus: "approved",
    venueName: `Hall ${id}`,
    status,
    statusDisplay: { status, label, group, description: "x" },
    ...PERIOD,
    createdAt: "2026-10-06T10:00:00+08:00",
    overlapping: [],
  };
}

const PENDING = [
  pendingItem("1", "pending", "Pending", "PENDING"),
  pendingItem("2", "conflicting", "Conflicting", "CONFLICTING"),
];

const FLAGGED = [
  {
    id: "f1",
    eventName: "Board Retreat",
    eventStatus: "approved",
    venueName: "Hall B",
    ...PERIOD,
    flaggedAt: "2026-11-20T10:00:00+08:00",
    reviewReason: "setup_or_turnaround_changed",
    block: null,
    reinstatable: true,
  },
];

function answer({ pending = PENDING, flagged = FLAGGED } = {}) {
  vi.mocked(apiClient.get).mockImplementation(async (url) => ({
    data: url === "/booking-requests/pending" ? pending : url === "/flagged-bookings" ? flagged : [],
  }));
}

function renderIn(ui) {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <div className="dashboard dashboard--venue-staff">{ui}</div>
    </MemoryRouter>,
  );
  return user;
}

const levelOf = (heading) => Number(heading.tagName.slice(1));
const toggleFor = (name) =>
  screen.getAllByRole("button").find((b) => b.hasAttribute("aria-expanded") && b.textContent.includes(name));

// The card's collapse row is a disclosure, not an action, so it stays a native
// button. Named here so no other native button can hide behind it.
function expectEveryActionIsTheSharedButton() {
  const buttons = screen.getAllByRole("button");
  const native = buttons.filter((b) => !b.classList.contains("ui-button"));
  for (const b of native) {
    expect(b).toHaveClass("pending-bookings__toggle");
    expect(b).toHaveAttribute("aria-expanded");
  }
  expect(buttons.length).toBeGreaterThan(native.length);
}

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  answer();
});

describe("SCRUM587 AC2 one h1 per Venue Staff booking screen", () => {
  it("SCRUM587_AC2_booking_requests_page_has_one_h1", async () => {
    const user = renderIn(<PendingBookingRequests asPage />);
    await screen.findByText("Event 1");
    await user.click(toggleFor("Event 1"));

    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s.map((h) => h.textContent)).toEqual(["Pending booking requests"]);
    const below = screen.getAllByRole("heading").filter((h) => h !== h1s[0]);
    expect(below.length).toBeGreaterThan(0);
    for (const h of below) expect(levelOf(h)).toBeGreaterThan(1);
  });

  it("SCRUM587_AC2_flagged_bookings_page_has_one_h1", async () => {
    const user = renderIn(<FlaggedBookings asPage />);
    await screen.findByText("Board Retreat");
    await user.click(toggleFor("Board Retreat"));

    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s.map((h) => h.textContent)).toEqual(["Flagged bookings"]);
    const below = screen.getAllByRole("heading").filter((h) => h !== h1s[0]);
    expect(below.map((h) => h.textContent)).toContain("Why it was flagged");
    for (const h of below) expect(levelOf(h)).toBeGreaterThan(1);
  });

  it("SCRUM587_AC2_venue_staff_dashboard_has_one_h1_with_its_sections_at_h2", async () => {
    render(
      <MemoryRouter>
        <VenueStaffDashboard user={{ id: "u1", email: "staff@example.com", role: "venue_staff" }} />
      </MemoryRouter>,
    );
    await screen.findByText("Event 1");
    await screen.findByText("Board Retreat");

    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s.map((h) => h.textContent)).toEqual(["Welcome, staff@example.com"]);
    expect(screen.getByRole("heading", { name: "Pending booking requests" }).tagName).toBe("H2");
    expect(screen.getByRole("heading", { name: "Flagged bookings" }).tagName).toBe("H2");
  });
});

describe("SCRUM587 AC3 shared components on the booking screens", () => {
  it("SCRUM587_AC3_booking_screens_use_the_shared_button", async () => {
    const user = renderIn(
      <>
        <PendingBookingRequests asPage />
        <FlaggedBookings />
      </>,
    );
    await screen.findByText("Event 1");
    await screen.findByText("Board Retreat");
    await user.click(toggleFor("Event 1"));
    await user.click(toggleFor("Board Retreat"));

    const pending = screen.getByRole("region", { name: "Event 1 at Hall 1" });
    expect(within(pending).getByRole("button", { name: "Approve" })).toHaveClass("ui-button--primary");
    expect(within(pending).getByRole("button", { name: "Reject" })).toHaveClass("ui-button--danger");
    const flagged = screen.getByRole("region", { name: "Board Retreat at Hall B" });
    expect(within(flagged).getByRole("button", { name: "Reinstate" })).toHaveClass("ui-button--primary");
    expect(within(flagged).getByRole("button", { name: "Cancel booking" })).toHaveClass("ui-button--danger");
    expectEveryActionIsTheSharedButton();
  });

  it("SCRUM587_AC3_no_booking_screen_keeps_its_own_badge_class", async () => {
    const user = renderIn(
      <>
        <PendingBookingRequests asPage />
        <FlaggedBookings />
      </>,
    );
    await screen.findByText("Event 1");
    await screen.findByText("Board Retreat");
    await user.click(toggleFor("Event 2"));
    await user.click(toggleFor("Board Retreat"));

    expect(document.querySelectorAll(".ui-status-badge")).toHaveLength(PENDING.length);
    expect(document.querySelector(".status-badge")).toBeNull();
    expect(document.querySelector('[class*="status--"]')).toBeNull();
  });
});

describe("SCRUM587 AC5 one tone per booking status meaning", () => {
  it.each([
    ["Pending", "warning"],
    ["Conflicting", "warning"],
  ])("SCRUM587_AC5_booking_statuses_use_one_tone_per_meaning (%s is %s)", async (label, tone) => {
    renderIn(<PendingBookingRequests asPage />);
    await screen.findByText("Event 1");

    const badge = screen.getByText(label, { selector: ".ui-status-badge" });
    expect(badge).toHaveClass(`ui-status-badge--${tone}`);
  });
});
