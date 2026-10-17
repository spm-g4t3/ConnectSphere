// EventCoordinatorDashboard.test.jsx
//
// SCRUM-128 (part of SCRUM-17, AC3). The notifications card took the seat of
// the "Pending venue bookings" stub. Both service modules the page reaches are
// mocked, so nothing touches the network. bookingRequestService's Venue Staff
// queue call is spied on: it is not the coordinator's (SCRUM-258), and would
// only answer 403 here.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import EventCoordinatorDashboard from "../../src/components/EventCoordinatorDashboard.jsx";
import { getEventRequestQueue, getMyAssignedEvents } from "../../src/services/eventRequestService";
import { listNotifications } from "../../src/services/notificationService";
import { getPendingBookingRequests } from "../../src/services/bookingRequestService";

// Every export the dashboard's component tree reaches, not only the queue's.
// A vi.mock factory is strict: reading an export it did not return throws,
// and since SCRUM-333 and SCRUM-334 the page renders My events
// (getMyAssignedEvents) and, through ReviewQueue's detail panel, imports
// CoordinatorRequestDetail, AssignmentHistory and ReassignEventPanel.
// AssignmentHistory reads its two history functions when the module loads,
// so a missing one fails the whole file before any test runs. Only
// getMyAssignedEvents is called on render; the rest are here so the modules
// load, and are never called, because nothing in these tests opens an event.
vi.mock("../../src/services/eventRequestService", () => ({
  getEventRequestQueue: vi.fn(),
  getMyAssignedEvents: vi.fn(),
  getCoordinatorChangeRequests: vi.fn(),
  processCoordinatorChangeRequest: vi.fn(),
  requestEventClarification: vi.fn(),
  getAssignmentHistory: vi.fn(),
  getAssignmentHistoryForReview: vi.fn(),
  listCoordinators: vi.fn(),
  reassignEventRequest: vi.fn(),
}));

vi.mock("../../src/services/notificationService", () => ({
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
}));

vi.mock("../../src/services/bookingRequestService", async (importOriginal) => ({
  ...(await importOriginal()),
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
  vi.mocked(getMyAssignedEvents).mockReset();
  vi.mocked(getMyAssignedEvents).mockResolvedValue([]);
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

  it("SCRUM333_AC11_renders_my_events_above_the_review_queue", async () => {
    // The dashboard's own share of SCRUM-333: My events is on the page, read
    // from GET /mine, and comes before the shared queue. This is also the test
    // that fails if the MyAssignedEvents import is ever dropped from the page
    // again, which renders as a crash rather than a missing section.
    renderDashboard();

    const mine = await screen.findByRole("heading", { name: "My events" });
    const queue = await screen.findByRole("heading", { name: "Review queue" });
    expect(getMyAssignedEvents).toHaveBeenCalledTimes(1);
    expect(mine.compareDocumentPosition(queue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("SCRUM17_AC3_pending_venue_bookings_section_is_gone", async () => {
    renderDashboard();

    await screen.findByText("You have no notifications.");
    expect(screen.queryByText(/Pending venue bookings/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No pending bookings/i)).not.toBeInTheDocument();
  });

  it("the removed venueService stub is not exported", async () => {
    const actual = await vi.importActual("../../src/services/venueService");
    expect(Object.keys(actual)).not.toContain("getPendingVenueBookings");
  });

  it("SCRUM258_AC1_the_coordinator_dashboard_does_not_load_the_venue_staff_queue", async () => {
    renderDashboard();
    await screen.findByText("You have no notifications.");

    expect(getPendingBookingRequests).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Pending booking requests" })).not.toBeInTheDocument();
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
