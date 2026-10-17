// MyAssignedEvents.test.jsx
//
// SCRUM-488 AC6 (SCRUM-552): a coordinator's "My events" keeps and correctly
// renders events in the two safety statuses.
//
// The list groups by the server's statusDisplay.group and writes each row's
// badge from its label, so a status the screen has never heard of lands in an
// existing group with no edit (see MyAssignedEvents.jsx). Seeded events stand
// in for the safety actions, which belong to SCRUM-489 and SCRUM-490. The
// statusDisplay values are what the backend sends for each status
// (domain/eventRequestStatus.js), written out here; the labels are provisional
// until SCRUM-549's decision is confirmed.
//
// The service is mocked, so nothing touches the network. The factory is strict,
// and the detail panel's tree reads its history functions when it loads, so
// every function it reaches is on the mock, as in EventCoordinatorDashboard.test.jsx.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import MyAssignedEvents from "../../src/components/MyAssignedEvents.jsx";
import { getMyAssignedEvents } from "../../src/services/eventRequestService";

vi.mock("../../src/services/eventRequestService", () => ({
  getMyAssignedEvents: vi.fn(),
  getCoordinatorChangeRequests: vi.fn(),
  processCoordinatorChangeRequest: vi.fn(),
  requestEventClarification: vi.fn(),
  getAssignmentHistory: vi.fn(),
  getAssignmentHistoryForReview: vi.fn(),
  listCoordinators: vi.fn(),
  reassignEventRequest: vi.fn(),
}));

const DISPLAY = {
  submitted: { status: "submitted", label: "Requested", group: "AWAITING_REVIEW", description: "Waiting." },
  under_review: { status: "under_review", label: "Under review", group: "UNDER_REVIEW", description: "Assessing." },
  approved: { status: "approved", label: "Planning", group: "APPROVED", description: "Accepted." },
  safety_review: { status: "safety_review", label: "Safety check", group: "UNDER_REVIEW", description: "A Safety Officer is checking the arrangements for your event before it can be confirmed." },
  safety_approved: { status: "safety_approved", label: "Safety approved", group: "APPROVED", description: "The safety check is complete. Your Coordinator can now confirm your event." },
  confirmed: { status: "confirmed", label: "Confirmed", group: "CONFIRMED", description: "Going ahead." },
  cancelled: { status: "cancelled", label: "Cancelled", group: "CANCELLED", description: "Called off." },
};

const event = (id, status, eventName, proposedStart = null) => ({
  id,
  eventName,
  status,
  statusDisplay: DISPLAY[status],
  proposedStart,
  organiserId: "11111111-1111-4111-8111-111111111111",
  organiserName: "Aisha Rahman",
});

function renderList(events) {
  vi.mocked(getMyAssignedEvents).mockResolvedValue(events);
  return render(
    <MemoryRouter>
      <MyAssignedEvents />
    </MemoryRouter>,
  );
}

const group = (heading) => screen.getByRole("heading", { name: new RegExp(`^${heading}`) }).closest("div");

beforeEach(() => {
  vi.mocked(getMyAssignedEvents).mockReset();
});

describe("SCRUM-488 AC6: My events with events in the safety statuses", () => {
  const EVENTS = [
    event("e1", "submitted", "New request"),
    event("e2", "under_review", "In review"),
    event("e3", "safety_review", "At the safety check", "2026-11-01T10:00:00+08:00"),
    event("e4", "approved", "Being planned"),
    event("e5", "safety_approved", "Cleared by safety", "2026-11-02T10:00:00+08:00"),
    event("e6", "confirmed", "Going ahead"),
  ];

  it("SCRUM488_AC6_keeps_an_event_in_each_safety_status_and_shows_it_with_its_label", async () => {
    renderList(EVENTS);

    for (const [name, label] of [["At the safety check", "Safety check"], ["Cleared by safety", "Safety approved"]]) {
      const row = (await screen.findByText(name)).closest("li");
      expect(within(row).getByText(label)).toHaveClass("status-badge");
    }
    expect(screen.getAllByRole("listitem")).toHaveLength(EVENTS.length);
  });

  it("SCRUM488_AC6_puts_each_safety_status_in_the_existing_group_the_server_names_and_styles_it_the_same", async () => {
    renderList(EVENTS);
    await screen.findByText("At the safety check");

    // Under review holds the review and the safety check; Approved holds the
    // planning and the safety approval. Each badge keeps its own label.
    expect(within(group("Under review")).getAllByText(/^(Under review|Safety check)$/, { selector: ".status-badge" }).map((node) => node.textContent))
      .toEqual(["Under review", "Safety check"]);
    expect(within(group("Approved")).getAllByText(/^(Planning|Safety approved)$/, { selector: ".status-badge" }).map((node) => node.textContent))
      .toEqual(["Planning", "Safety approved"]);
    expect(within(screen.getByText("At the safety check").closest("li")).getByText("Safety check"))
      .toHaveClass("status--under-review");
    expect(within(screen.getByText("Cleared by safety").closest("li")).getByText("Safety approved"))
      .toHaveClass("status--approved");
    expect(within(screen.getByText("Cleared by safety").closest("li")).getByRole("status"))
      .toHaveTextContent("Safety approval complete");
  });

  it("SCRUM488_AC6_never_shows_an_internal_status_name_or_an_unknown_group", async () => {
    const { container } = renderList(EVENTS);
    await screen.findByText("At the safety check");

    expect(container.textContent).not.toMatch(/safety_review|safety_approved/);
    expect(container.textContent).not.toMatch(/Unknown Status|Status Unavailable/);
    expect(screen.queryByRole("heading", { name: /^Unknown/ })).not.toBeInTheDocument();
  });

  it("SCRUM488_AC6_keeps_the_servers_order_within_a_group_and_leaves_the_other_groups_alone", async () => {
    renderList([
      event("a", "safety_approved", "Cleared first", "2026-11-01T10:00:00+08:00"),
      event("b", "approved", "Planning second", "2026-11-02T10:00:00+08:00"),
      event("c", "confirmed", "Confirmed", "2026-11-03T10:00:00+08:00"),
      event("d", "cancelled", "Cancelled"),
    ]);
    await screen.findByText("Cleared first");

    expect(within(group("Approved")).getAllByRole("listitem").map((row) => within(row).getByRole("button").closest("li").querySelector("strong").textContent))
      .toEqual(["Cleared first", "Planning second"]);
    expect(within(group("Confirmed")).getByText("Confirmed", { selector: ".status-badge" })).toHaveClass("status--confirmed");
    // Finished events stay collapsed, one click away, as before.
    expect(screen.getByText(/^Cancelled/, { selector: "summary" }).closest("details")).not.toHaveAttribute("open");
  });
});

// SCRUM-266: a confirmed event with a flagged booking is marked on its row.
describe("SCRUM-266 AC4: Needs attention on My events", () => {
  it("SCRUM266_AC4_marks_only_the_rows_the_server_says_need_attention", async () => {
    renderList([
      { ...event("e1", "confirmed", "Flagged event"), needsAttention: true },
      { ...event("e2", "confirmed", "Fine event"), needsAttention: false },
      event("e3", "confirmed", "Older payload"),
    ]);

    const row = (name) => screen.getByText(name).closest("li");
    await screen.findByText("Flagged event");
    expect(within(row("Flagged event")).getByText("Needs attention", { selector: ".status-badge" })).toHaveClass(
      "status--action-required",
    );
    expect(within(row("Fine event")).queryByText("Needs attention")).not.toBeInTheDocument();
    expect(within(row("Older payload")).queryByText("Needs attention")).not.toBeInTheDocument();
  });
});
