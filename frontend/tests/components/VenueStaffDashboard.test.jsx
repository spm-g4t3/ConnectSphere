// VenueStaffDashboard.test.jsx
//
// SCRUM-258 AC1. The Venue Staff landing page shows the pending booking
// requests queue, read from the real endpoint through the real service:
// only apiClient is mocked, so a wrong URL or a leftover stub would leave the
// queue empty and fail here. SCRUM-266 AC1 adds the flagged bookings list,
// read the same way.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import VenueStaffDashboard from "../../src/components/VenueStaffDashboard.jsx";
import { apiClient } from "../../src/services/apiClient";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

// The inbox reads the signed-in user to link its rows; no user, no links, so
// the dashboard renders as before.
vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: () => ({ user: null }),
}));

const PENDING = {
  id: "b1",
  eventName: "Tech Talk",
  venueName: "Hall A",
  status: "pending",
  statusDisplay: { status: "pending", label: "Pending", group: "PENDING", description: "x" },
  startsAt: "2026-12-01T09:00:00+08:00",
  endsAt: "2026-12-01T17:00:00+08:00",
  createdAt: "2026-10-06T10:00:00+08:00",
  overlapping: [],
};

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.get).mockImplementation(async (url) => ({
    data: url === "/booking-requests/pending" ? [PENDING] : [],
  }));
});

describe("SCRUM258 VenueStaffDashboard", () => {
  it("SCRUM258_AC1_the_dashboard_shows_the_pending_queue_from_the_endpoint", async () => {
    render(
      <MemoryRouter>
        <VenueStaffDashboard user={{ id: "u1", email: "staff@example.com", role: "venue_staff" }} />
      </MemoryRouter>,
    );

    const queue = screen.getByRole("heading", { name: "Pending booking requests" }).closest("section");
    expect(await within(queue).findByText("Tech Talk")).toBeInTheDocument();
    expect(within(queue).getByText("Hall A")).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledWith("/booking-requests/pending");
  });
});

const FLAGGED = {
  id: "f1",
  eventName: "Board Retreat",
  venueName: "Hall B",
  startsAt: "2026-12-03T09:00:00+08:00",
  endsAt: "2026-12-03T17:00:00+08:00",
  flaggedAt: "2026-11-20T10:00:00+08:00",
  reviewReason: "setup_or_turnaround_changed",
  block: null,
  reinstatable: true,
};

describe("SCRUM266 VenueStaffDashboard", () => {
  it("SCRUM266_AC1_the_dashboard_shows_the_flagged_bookings_from_the_endpoint_under_the_pending_queue", async () => {
    vi.mocked(apiClient.get).mockImplementation(async (url) => ({
      data: url === "/flagged-bookings" ? [FLAGGED] : [],
    }));
    render(
      <MemoryRouter>
        <VenueStaffDashboard user={{ id: "u1", email: "staff@example.com", role: "venue_staff" }} />
      </MemoryRouter>,
    );

    const flagged = screen.getByRole("heading", { name: "Flagged bookings" }).closest("section");
    expect(await within(flagged).findByText("Board Retreat")).toBeInTheDocument();
    expect(within(flagged).getByText("Hall B")).toBeInTheDocument();
    expect(within(flagged).getByText("Setup or turnaround time changed")).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledWith("/flagged-bookings");

    const pending = screen.getByRole("heading", { name: "Pending booking requests" }).closest("section");
    expect(pending.compareDocumentPosition(flagged) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(pending).queryByText("Board Retreat")).not.toBeInTheDocument();
  });
});

describe("SCRUM266 approving a replacement on the dashboard (W7)", () => {
  it("SCRUM266_W7_an_approval_in_the_queue_refreshes_the_flagged_bookings_list", async () => {
    const user = userEvent.setup();
    const replacement = {
      ...PENDING,
      eventStatus: "approved",
      replaces: { bookingId: "f1", venueName: "Hall B", startsAt: FLAGGED.startsAt, endsAt: FLAGGED.endsAt },
    };
    let flagged = [FLAGGED];
    let pending = [replacement];
    vi.mocked(apiClient.get).mockImplementation(async (url) => ({
      data: url === "/flagged-bookings" ? flagged : url === "/booking-requests/pending" ? pending : [],
    }));
    // The server closes the flagged booking as replaced when its replacement is approved.
    vi.mocked(apiClient.post).mockImplementation(async () => {
      flagged = [];
      pending = [];
      return { data: { markedConflicting: [] } };
    });
    render(
      <MemoryRouter>
        <VenueStaffDashboard user={{ id: "u1", email: "staff@example.com", role: "venue_staff" }} />
      </MemoryRouter>,
    );

    // Looked up each time, as the refresh may replace the section's element.
    const flaggedSection = () => screen.getByRole("heading", { name: "Flagged bookings" }).closest("section");
    expect(await within(flaggedSection()).findByText("Board Retreat")).toBeInTheDocument();

    const queue = screen.getByRole("heading", { name: "Pending booking requests" }).closest("section");
    await user.click(await within(queue).findByText("Tech Talk"));
    await user.click(within(queue).getByRole("button", { name: "Approve" }));

    expect(await screen.findByText("No bookings are flagged for review.")).toBeInTheDocument();
    expect(within(flaggedSection()).queryByText("Board Retreat")).not.toBeInTheDocument();
  });
});
