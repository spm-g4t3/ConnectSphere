// VenueStaffDashboard.test.jsx
//
// SCRUM-258 AC1. The Venue Staff landing page shows the pending booking
// requests queue, read from the real endpoint through the real service:
// only apiClient is mocked, so a wrong URL or a leftover stub would leave the
// queue empty and fail here.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import VenueStaffDashboard from "../../src/components/VenueStaffDashboard.jsx";
import { apiClient } from "../../src/services/apiClient";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
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
