// The Event Coordinator Lead's screens on the shared UI standard: one h1 per
// page, shared Buttons and StatusBadges. Services are mocked; the panels are
// real, so the queue is checked with the panels it actually opens.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import EventCoordinatorLeadDashboard from "../../src/components/EventCoordinatorLeadDashboard.jsx";
import UnassignedQueue from "../../src/components/UnassignedQueue.jsx";
import AssignedEvents from "../../src/components/AssignedEvents.jsx";
import {
  getEventCancellationImpact,
  listAssignedEventsForLead,
  listCoordinatorOverview,
  listCoordinatorWorkload,
  listUnassignedEventRequests,
} from "../../src/services/eventRequestService";
import { statusTone } from "../../src/services/eventRequestStatusDisplay";
import { deferred, httpError } from "../helpers/async.js";

vi.mock("../../src/services/eventRequestService", () => ({
  assignEventRequest: vi.fn(),
  cancelEventRequest: vi.fn(),
  getEventCancellationImpact: vi.fn(),
  listAssignedEventsForLead: vi.fn(),
  listCoordinatorOverview: vi.fn(),
  listCoordinatorWorkload: vi.fn(),
  listUnassignedEventRequests: vi.fn(),
}));
vi.mock("../../src/components/NotificationInbox", () => ({
  default: () => <section><h2>Notifications</h2></section>,
}));

const WAITING = [
  { id: "r1", eventName: "IS212 Industry Night", organiserName: "Aisha Rahman", submittedAt: "2026-10-01T00:00:00Z" },
  { id: "r2", eventName: "Freshers Welcome", organiserName: "Ben Lim", submittedAt: "2026-10-02T00:00:00Z" },
];
const HELD = [
  { id: "e1", eventName: "Planning Night", statusDisplay: { label: "Planning", group: "APPROVED" } },
  { id: "e2", eventName: "Review Night", statusDisplay: { label: "Under review", group: "UNDER_REVIEW" } },
];
const NO_IMPACT = {
  venueBookings: { count: 0, details: [] },
  bookingRequests: { count: 0, details: [] },
  venueHolds: { count: 0, details: [] },
  equipmentRequests: { count: 0, details: [] },
  equipmentReservations: { count: 0, details: [] },
};
const OLD_CLASSES = ".unassigned-queue__back, .unassigned-queue__cancel, .review-queue__back, .status-badge";
const NOW = () => new Date("2026-10-11T12:00:00Z");

beforeEach(() => {
  vi.mocked(listUnassignedEventRequests).mockReset().mockResolvedValue(WAITING);
  vi.mocked(listCoordinatorWorkload).mockReset().mockResolvedValue([
    { id: "c1", fullName: "Priya Nair", activeEvents: 0 },
  ]);
  vi.mocked(getEventCancellationImpact).mockReset().mockResolvedValue(NO_IMPACT);
  vi.mocked(listAssignedEventsForLead).mockReset().mockResolvedValue(HELD);
  vi.mocked(listCoordinatorOverview).mockReset().mockResolvedValue({
    statuses: [{ status: "approved", label: "Planning", finished: false }],
    coordinators: [{ id: "c1", fullName: "Priya Nair", activeEvents: 1, byStatus: { approved: 1 } }],
  });
});

function headingNames(level) {
  return screen.queryAllByRole("heading", { level }).map((heading) => heading.textContent);
}

async function renderQueuePage() {
  const user = userEvent.setup();
  const view = render(<UnassignedQueue asPage now={NOW} />);
  await screen.findByText("IS212 Industry Night");
  return { user, ...view };
}

async function openPanel(user, kind) {
  const label = kind === "assign" ? "Assign IS212 Industry Night" : "Cancel IS212 Industry Night";
  await user.click(screen.getByRole("button", { name: label }));
}

async function showCancelImpact(user) {
  await user.type(screen.getByLabelText("Cancellation reason"), "Organiser no longer needs it");
  await user.click(screen.getByLabelText("The organiser’s request"));
  await user.click(screen.getByRole("button", { name: "Preview cancellation" }));
  await screen.findByLabelText("Cancellation impact preview");
}

async function renderAssignedEvents() {
  const view = render(
    <MemoryRouter>
      <AssignedEvents />
    </MemoryRouter>,
  );
  await screen.findByText("Planning Night");
  await screen.findByRole("table");
  return view;
}

describe("SCRUM590_AC2 one page title per screen", () => {
  it("SCRUM590_AC2_the_dashboard_has_one_h1_and_the_queue_is_a_section", async () => {
    render(
      <MemoryRouter>
        <EventCoordinatorLeadDashboard user={{ email: "lead@example.com" }} />
      </MemoryRouter>,
    );
    await screen.findByText("IS212 Industry Night");

    expect(headingNames(1)).toEqual(["Event Coordinator Lead"]);
    expect(headingNames(2)).toEqual(["Unassigned queue (2)", "Coordinator overview", "Notifications"]);
  });

  it("SCRUM590_AC2_the_unassigned_queue_page_titles_itself_with_one_h1", async () => {
    await renderQueuePage();

    expect(headingNames(1)).toEqual(["Unassigned queue (2)"]);
  });

  it.each([
    ["assign", "Assign IS212 Industry Night"],
    ["cancel", "Cancel IS212 Industry Night"],
  ])("SCRUM590_AC2_the_%s_panel_keeps_the_page_h1_and_is_a_section_under_it", async (kind, panelTitle) => {
    const { user } = await renderQueuePage();

    await openPanel(user, kind);

    expect(headingNames(1)).toEqual(["Unassigned queue"]);
    expect(headingNames(2)).toEqual([panelTitle]);
  });

  it("SCRUM590_AC2_assigned_events_has_one_h1_and_its_sections_are_h2", async () => {
    await renderAssignedEvents();

    expect(headingNames(1)).toEqual(["Assigned events"]);
    expect(headingNames(2)).toEqual(["Coordinators", "Events"]);
    expect(headingNames(3)).toEqual([]);
  });

  it("SCRUM590_AC2_queue_title_shows_how_many_are_waiting", async () => {
    const pending = deferred();
    vi.mocked(listUnassignedEventRequests).mockReturnValueOnce(pending.promise);
    render(<UnassignedQueue asPage now={NOW} />);

    // Never a count while the list is still loading.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^Unassigned queue$/);
    pending.resolve(WAITING);
    expect(await screen.findByRole("heading", { level: 1, name: "Unassigned queue (2)" })).toBeInTheDocument();
  });

  it("SCRUM590_AC2_queue_title_has_no_count_when_the_list_failed", async () => {
    vi.mocked(listUnassignedEventRequests).mockRejectedValue(httpError(500));
    render(<UnassignedQueue asPage now={NOW} />);

    await screen.findByRole("alert");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^Unassigned queue$/);
  });
});

describe("SCRUM590_AC3 shared buttons", () => {
  function expectStandardButtons(container) {
    expect(container.querySelector(OLD_CLASSES)).toBeNull();
    for (const button of container.querySelectorAll("button")) {
      expect(button).toHaveClass("ui-button");
    }
  }

  it("SCRUM590_AC3_queue_rows_use_shared_buttons_and_cancel_is_danger", async () => {
    const { container } = await renderQueuePage();

    expectStandardButtons(container);
    const row = screen.getByText("IS212 Industry Night").closest("li");
    expect(within(row).getByRole("button", { name: "Assign IS212 Industry Night" })).toHaveClass("ui-button--primary");
    expect(within(row).getByRole("button", { name: "Cancel IS212 Industry Night" })).toHaveClass("ui-button--danger");
  });

  it("SCRUM590_AC3_assign_panel_has_one_back_link_and_shared_buttons", async () => {
    const { user, container } = await renderQueuePage();
    await openPanel(user, "assign");
    await screen.findByRole("radio", { name: "Priya Nair, 0 active events" });

    expectStandardButtons(container);
    const back = screen.getAllByRole("button", { name: /Back to the unassigned queue/ });
    expect(back).toHaveLength(1);
    expect(back[0]).toHaveClass("ui-button--link");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass("ui-button--secondary");
  });

  it("SCRUM590_AC3_cancel_panel_has_one_back_link_and_its_final_cancel_is_danger", async () => {
    const { user, container } = await renderQueuePage();
    await openPanel(user, "cancel");
    await showCancelImpact(user);

    expectStandardButtons(container);
    const back = screen.getAllByRole("button", { name: /Back to the unassigned queue/ });
    expect(back).toHaveLength(1);
    expect(back[0]).toHaveClass("ui-button--link");
    expect(screen.getByRole("button", { name: "Cancel request" })).toHaveClass("ui-button--danger");
  });

  it("SCRUM590_AC3_assigned_events_uses_no_per_screen_badge_or_button_classes", async () => {
    const { container } = await renderAssignedEvents();

    expectStandardButtons(container);
  });
});

describe("SCRUM590_AC5 status badges keep their meaning", () => {
  it.each([
    ["DRAFT", "neutral"],
    ["AWAITING_REVIEW", "warning"],
    ["UNDER_REVIEW", "info"],
    ["ACTION_REQUIRED", "danger"],
    ["APPROVED", "success"],
    ["CONFIRMED", "accent"],
    ["COMPLETED", "neutral"],
    ["REJECTED", "danger"],
    ["CANCELLED", "neutral"],
    ["UNAVAILABLE", "neutral"],
    ["UNKNOWN", "neutral"],
    ["A_GROUP_THIS_BUILD_DOES_NOT_KNOW", "neutral"],
    [undefined, "neutral"],
  ])("SCRUM590_AC5_status_group_%s_is_the_%s_tone", (group, tone) => {
    expect(statusTone(group)).toBe(tone);
  });

  it("SCRUM590_AC5_assigned_events_badges_take_the_tone_of_their_group", async () => {
    await renderAssignedEvents();

    for (const event of HELD) {
      const row = screen.getByText(event.eventName).closest("li");
      expect(within(row).getByText(event.statusDisplay.label)).toHaveClass(
        "ui-status-badge",
        `ui-status-badge--${statusTone(event.statusDisplay.group)}`,
      );
    }
  });
});
