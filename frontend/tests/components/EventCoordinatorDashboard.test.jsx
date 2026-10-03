// EventCoordinatorDashboard.test.jsx
//
// SCRUM-128 (part of SCRUM-17, AC3). The notifications card took the seat of
// the "Pending venue bookings" stub. Both service modules the page reaches are
// mocked, so nothing touches the network, and venueService is mocked too so a
// stray call to a removed stub would show up rather than console.warn.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import EventCoordinatorDashboard from "../../src/components/EventCoordinatorDashboard.jsx";
import { getEventRequestQueue } from "../../src/services/eventRequestService";
import { listNotifications } from "../../src/services/notificationService";
import * as venueService from "../../src/services/venueService";

vi.mock("../../src/services/eventRequestService", () => ({
  getEventRequestQueue: vi.fn(),
}));

vi.mock("../../src/services/notificationService", () => ({
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
}));

vi.mock("../../src/services/venueService", () => ({
  getPendingBookingRequests: vi.fn(),
}));

const USER = { id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", email: "coord@example.com", role: "event_coordinator" };

const NOTIFICATION = {
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  type: "booking_flagged",
  bookingId: "a1b2c3d4-0000-4000-8000-000000000001",
  blockId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
  payload: {
    venueName: "Hall A",
    eventName: "Tech Talk",
    startsAt: "2026-10-01T10:00:00+08:00",
    endsAt: "2026-10-01T12:00:00+08:00",
    reason: "maintenance",
    blockStartsAt: "2026-10-01T09:00:00+08:00",
    blockEndsAt: "2026-10-01T17:00:00+08:00",
  },
  readAt: null,
  createdAt: "2026-09-26T11:00:00+08:00",
};

function renderDashboard(user = USER) {
  return render(
    <MemoryRouter>
      <EventCoordinatorDashboard user={user} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(getEventRequestQueue).mockReset();
  vi.mocked(getEventRequestQueue).mockResolvedValue([]);
  vi.mocked(listNotifications).mockReset();
  vi.mocked(listNotifications).mockResolvedValue([]);
});

describe("SCRUM17_AC3 EventCoordinatorDashboard", () => {
  it("SCRUM17_AC3_renders_the_review_queue_and_the_notifications", async () => {
    renderDashboard();

    expect(await screen.findByRole("heading", { name: "Review queue" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Notifications/ })).toBeInTheDocument();
    expect(await screen.findByText("You have no notifications.")).toBeInTheDocument();
    expect(getEventRequestQueue).toHaveBeenCalled();
    expect(listNotifications).toHaveBeenCalledTimes(1);
  });

  it("SCRUM17_AC3_pending_venue_bookings_section_is_gone", async () => {
    renderDashboard();

    await screen.findByText("You have no notifications.");
    expect(screen.queryByText(/Pending venue bookings/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No pending bookings/i)).not.toBeInTheDocument();
  });

  it("the removed venueService stub is not exported and nothing else is called", async () => {
    const actual = await vi.importActual("../../src/services/venueService");
    expect(Object.keys(actual)).not.toContain("getPendingVenueBookings");

    renderDashboard();
    await screen.findByText("You have no notifications.");
    expect(venueService.getPendingBookingRequests).not.toHaveBeenCalled();
  });

  it("both sections are direct children of the dashboard wrapper, for the card styling", async () => {
    const { container } = renderDashboard();
    await screen.findByText("You have no notifications.");

    const dashboard = container.querySelector(".dashboard.dashboard--coordinator");
    expect(dashboard).not.toBeNull();
    const sections = [...dashboard.children].filter((el) => el.tagName === "SECTION");
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(dashboard.querySelector(":scope > section.coordinator-notifications")).not.toBeNull();
  });

  it("shows a notification from the service", async () => {
    vi.mocked(listNotifications).mockResolvedValue([NOTIFICATION]);

    renderDashboard();

    const card = (await screen.findByText("Tech Talk at Hall A needs review")).closest("section");
    expect(within(card).getByRole("heading")).toHaveTextContent("Notifications (1 unread)");
  });

  it("greets by email when the user has no name", async () => {
    renderDashboard();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Welcome, coord@example.com");
    await screen.findByText("You have no notifications.");
  });

  it("greets by name when there is one", async () => {
    renderDashboard({ ...USER, name: "Terence" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Welcome, Terence");
    await screen.findByText("You have no notifications.");
  });
});
