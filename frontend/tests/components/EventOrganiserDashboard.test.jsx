// EventOrganiserDashboard.test.jsx
//
// SCRUM-488 AC5 (SCRUM-552), for SCRUM-14: the Organiser's dashboard shows an
// event in either safety status under its Organiser-facing label, with the
// status description, and never the internal name.
//
// The statusDisplay values are what the backend sends for each status, written
// out; the labels are provisional until SCRUM-549's decision is confirmed.
// Both service modules the page reaches are mocked, so nothing touches the
// network.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import EventOrganiserDashboard from "../../src/components/EventOrganiserDashboard.jsx";
import { getMyEventRequests } from "../../src/services/eventRequestService";
import { listNotifications } from "../../src/services/notificationService";

vi.mock("../../src/services/eventRequestService", () => ({
  getMyEventRequests: vi.fn(),
}));

vi.mock("../../src/services/notificationService", () => ({
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
}));

const USER = { id: "11111111-1111-4111-8111-111111111111", name: "Aisha", role: "event_organiser" };

const DISPLAY = {
  approved: { status: "approved", label: "Planning", group: "APPROVED", description: "Your request has been accepted. Arrangements will now begin." },
  safety_review: { status: "safety_review", label: "Safety check", group: "UNDER_REVIEW", description: "A Safety Officer is checking the arrangements for your event before it can be confirmed." },
  safety_approved: { status: "safety_approved", label: "Safety approved", group: "APPROVED", description: "The safety check is complete. Your Coordinator can now confirm your event." },
  confirmed: { status: "confirmed", label: "Confirmed", group: "CONFIRMED", description: "All arrangements are complete. Your event is going ahead." },
};

const event = (id, status, eventName) => ({
  id,
  eventName,
  status,
  statusDisplay: DISPLAY[status],
  proposedStart: "2026-11-01T10:00:00+08:00",
});

function renderDashboard(events) {
  vi.mocked(getMyEventRequests).mockResolvedValue(events);
  return render(
    <MemoryRouter>
      <EventOrganiserDashboard user={USER} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(getMyEventRequests).mockReset();
  vi.mocked(listNotifications).mockReset();
  vi.mocked(listNotifications).mockResolvedValue([]);
});

describe("SCRUM-488 AC5: the Organiser's dashboard with events in the safety statuses", () => {
  it.each([
    ["safety_review", "Safety check", "status--under-review"],
    ["safety_approved", "Safety approved", "status--approved"],
  ])("SCRUM488_AC5_shows_an_event_in_%s_as_%s_with_the_groups_style", async (status, label, cssClass) => {
    renderDashboard([event("e1", status, "Industry Night")]);

    const row = (await screen.findByText("Industry Night")).closest("li");
    expect(within(row).getByText(label)).toHaveClass("status-badge", cssClass);
    expect(within(row).getByText(DISPLAY[status].description)).toBeInTheDocument();
    if (status === "safety_approved") {
      expect(within(row).getByRole("status")).toHaveTextContent("Safety approval complete");
      expect(within(row).getByRole("status")).toHaveTextContent("A Safety Officer has approved the event arrangements.");
    } else {
      expect(within(row).queryByText("Safety approval complete")).not.toBeInTheDocument();
    }
  });

  it("SCRUM488_AC5_never_shows_an_internal_status_name_or_an_unknown_status", async () => {
    const { container } = renderDashboard([
      event("e1", "safety_review", "Industry Night"),
      event("e2", "safety_approved", "Careers Fair"),
    ]);

    await screen.findByText("Industry Night");
    expect(container.textContent).not.toMatch(/safety_review|safety_approved/);
    expect(container.textContent).not.toMatch(/Unknown Status|Status Unavailable/);
  });

  it("SCRUM488_AC5_still_labels_the_other_statuses_beside_them_and_asks_for_no_reply", async () => {
    renderDashboard([
      event("e1", "approved", "Planned"),
      event("e2", "safety_review", "At the check"),
      event("e3", "confirmed", "Going ahead"),
    ]);

    await screen.findByText("Planned");
    expect(["Planned", "At the check", "Going ahead"].map((name) =>
      within(screen.getByText(name).closest("li")).getByText(/^(Planning|Safety check|Confirmed)$/).textContent))
      .toEqual(["Planning", "Safety check", "Confirmed"]);
    // Only a pending clarification puts an event under the deadlines.
    expect(screen.getByText("No outstanding amendments before your event dates.")).toBeInTheDocument();
  });
});
