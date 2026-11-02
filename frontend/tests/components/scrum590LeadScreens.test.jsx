// The Event Coordinator Lead's screens on the shared UI standard: one h1 per
// page, shared Buttons and StatusBadges, and the shared loading, empty and
// error states and dates. Services are mocked; the panels are real, so the
// queue is checked with the panels it actually opens.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import EventCoordinatorLeadDashboard from "../../src/components/EventCoordinatorLeadDashboard.jsx";
import UnassignedQueue from "../../src/components/UnassignedQueue.jsx";
import AssignedEvents from "../../src/components/AssignedEvents.jsx";
import AssignmentHistory from "../../src/components/AssignmentHistory.jsx";
import ReassignEventPanel from "../../src/components/ReassignEventPanel.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import {
  assignEventRequest,
  getAssignmentHistory,
  getAssignmentHistoryForReview,
  getEventCancellationImpact,
  listAssignedEventsForLead,
  listCoordinatorOverview,
  listCoordinatorWorkload,
  listUnassignedEventRequests,
} from "../../src/services/eventRequestService";
import { statusTone } from "../../src/services/eventRequestStatusDisplay";
import { deferred, httpError } from "../helpers/async.js";

vi.mock("../../src/auth/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../../src/services/eventRequestService", () => ({
  assignEventRequest: vi.fn(),
  cancelEventRequest: vi.fn(),
  getAssignmentHistory: vi.fn(),
  getAssignmentHistoryForReview: vi.fn(),
  getEventCancellationImpact: vi.fn(),
  listAssignedEventsForLead: vi.fn(),
  listCoordinatorOverview: vi.fn(),
  listCoordinatorWorkload: vi.fn(),
  listCoordinators: vi.fn(),
  listUnassignedEventRequests: vi.fn(),
  reassignEventRequest: vi.fn(),
}));
vi.mock("../../src/components/NotificationInbox", () => ({
  default: () => <section><h2>Notifications</h2></section>,
}));

// 9:00 am to 11:00 am on 15 Jan 2026, Singapore time.
const MORNING = "2026-01-15T01:00:00Z";
const LATE_MORNING = "2026-01-15T03:00:00Z";
const WAITING = [
  {
    id: "r1",
    eventName: "IS212 Industry Night",
    organiserName: "Aisha Rahman",
    submittedAt: "2026-10-01T00:00:00Z",
    proposedStart: MORNING,
    proposedEnd: LATE_MORNING,
  },
  { id: "r2", eventName: "Freshers Welcome", organiserName: "Ben Lim", submittedAt: "2026-10-02T00:00:00Z" },
];
const HELD = [
  { id: "e1", eventName: "Planning Night", proposedStart: MORNING, statusDisplay: { label: "Planning", group: "APPROVED" } },
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
  vi.mocked(getAssignmentHistory).mockReset().mockResolvedValue([]);
  vi.mocked(getAssignmentHistoryForReview).mockReset().mockResolvedValue([]);
  vi.mocked(assignEventRequest).mockReset();
  vi.mocked(useAuth).mockReturnValue({ user: { id: "lead-1", role: "event_coordinator_lead" } });
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

describe("SCRUM590_AC4 loading, empty and error states and dates", () => {
  const HANDOVER = {
    id: "h1",
    previousCoordinatorId: null,
    previousCoordinatorName: null,
    newCoordinatorId: "c1",
    newCoordinatorName: "Priya Nair",
    assignedById: "lead-1",
    assignedByName: "Lena Lead",
    automatic: false,
    createdAt: MORNING,
  };

  const renderHistory = (view = "coordinator") =>
    render(<AssignmentHistory eventRequestId="r1" view={view} currentCoordinatorId={null} />);

  function renderAssignedEventsLoading() {
    render(
      <MemoryRouter>
        <AssignedEvents />
      </MemoryRouter>,
    );
  }

  /** Each read on these screens, with the call that makes it and how to show it. */
  const READS = [
    ["the queue", listUnassignedEventRequests, () => render(<UnassignedQueue now={NOW} />), "The unassigned queue could not be loaded."],
    ["assigned events", listAssignedEventsForLead, renderAssignedEventsLoading, "The assigned events could not be loaded."],
    ["the assignment history", getAssignmentHistoryForReview, () => renderHistory(), "The coordinator history could not be loaded."],
  ];

  it.each([
    ["the queue", listUnassignedEventRequests, () => render(<UnassignedQueue now={NOW} />)],
    ["the assignment history", getAssignmentHistoryForReview, () => renderHistory()],
  ])("SCRUM590_AC4_%s_says_exactly_Loading_while_it_reads", (_name, service, show) => {
    vi.mocked(service).mockReturnValue(new Promise(() => {}));
    show();

    expect(screen.getByRole("status")).toHaveTextContent(/^Loading\.\.\.$/);
  });

  it("SCRUM590_AC4_assigned_events_says_exactly_Loading_for_each_read", () => {
    for (const service of [listUnassignedEventRequests, listCoordinatorOverview, listAssignedEventsForLead]) {
      vi.mocked(service).mockReturnValue(new Promise(() => {}));
    }
    renderAssignedEventsLoading();

    // The count, the coordinators table and the events list.
    const loading = screen.getAllByRole("status");
    expect(loading).toHaveLength(3);
    for (const status of loading) expect(status).toHaveTextContent(/^Loading\.\.\.$/);
  });

  it("SCRUM590_AC4_the_assign_panel_says_exactly_Loading_while_it_reads_the_coordinators", async () => {
    const { user } = await renderQueuePage();
    vi.mocked(listCoordinatorWorkload).mockReturnValue(new Promise(() => {}));

    await openPanel(user, "assign");

    expect(screen.getByRole("status")).toHaveTextContent(/^Loading\.\.\.$/);
  });

  it.each(READS)("SCRUM590_AC4_a_500_on_%s_offers_Try_again_which_reads_again_and_recovers", async (_name, service, show, message) => {
    const user = userEvent.setup();
    vi.mocked(service).mockRejectedValueOnce(httpError(500));
    show();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    const calls = vi.mocked(service).mock.calls.length;

    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(vi.mocked(service).mock.calls.length).toBe(calls + 1);
  });

  it("SCRUM590_AC4_a_500_on_the_assign_panels_coordinators_offers_Try_again_which_recovers", async () => {
    const { user } = await renderQueuePage();
    vi.mocked(listCoordinatorWorkload).mockRejectedValueOnce(httpError(500));
    await openPanel(user, "assign");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The list of coordinators could not be loaded.");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("radio", { name: "Priya Nair, 0 active events" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM590_AC4_a_500_on_the_handover_list_offers_Try_again_which_recovers", async () => {
    const user = userEvent.setup();
    vi.mocked(listCoordinatorWorkload)
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValueOnce([{ id: "c2", fullName: "Omar Okafor", activeEvents: 2 }]);
    render(
      <ReassignEventPanel
        request={{ id: "e1", eventName: "Planning Night", assignedCoordinatorId: "c1" }}
        onCancel={vi.fn()}
        onReassigned={vi.fn()}
      />,
    );

    await user.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("option", { name: /Omar Okafor/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(READS)("SCRUM590_AC4_a_403_on_%s_offers_no_Try_again", async (_name, service, show) => {
    vi.mocked(service).mockRejectedValue(httpError(403));
    show();

    const alert = await screen.findByRole("alert");
    expect(within(alert).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("SCRUM590_AC4_a_refused_filter_offers_no_Try_again", async () => {
    const user = userEvent.setup();
    await renderAssignedEvents();
    vi.mocked(listAssignedEventsForLead).mockRejectedValue(httpError(400));

    await user.click(screen.getByLabelText("Include completed, rejected and cancelled"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Those filters could not be applied.");
    expect(within(alert).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("SCRUM590_AC4_a_refused_assignment_offers_no_Try_again", async () => {
    const { user } = await renderQueuePage();
    vi.mocked(assignEventRequest).mockRejectedValue(httpError(400));
    await openPanel(user, "assign");
    await user.click(await screen.findByRole("radio", { name: "Priya Nair, 0 active events" }));

    await user.click(screen.getByRole("button", { name: "Confirm assignment" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That person cannot be assigned this request.");
    expect(within(alert).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it.each([
    ["the coordinators' workload", listCoordinatorOverview, "The coordinators' workload could not be loaded."],
    ["the waiting count", listUnassignedEventRequests, "The number of waiting requests could not be loaded."],
  ])("SCRUM590_AC4_a_failed_read_of_%s_offers_Try_again_and_leaves_the_list_the_only_alert", async (_name, service, message) => {
    const user = userEvent.setup();
    vi.mocked(service).mockRejectedValueOnce(httpError(500));
    await renderAssignedEventsList();

    const failure = await screen.findByText(message);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(within(failure.parentElement).getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(screen.queryByText(message)).not.toBeInTheDocument());
    expect(vi.mocked(service)).toHaveBeenCalledTimes(2);
  });

  it("SCRUM590_AC4_a_refused_overview_offers_no_Try_again", async () => {
    vi.mocked(listCoordinatorOverview).mockRejectedValue(httpError(403));
    renderAssignedEventsLoading();

    await screen.findByText("The coordinators' workload could not be loaded.");
    await screen.findByText("Planning Night");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it.each([
    [
      "the queue",
      () => {
        vi.mocked(listUnassignedEventRequests).mockResolvedValue([]);
        render(<UnassignedQueue now={NOW} />);
      },
      "No event requests are waiting for a coordinator.",
      "New requests appear here when organisers submit them.",
    ],
    [
      "assigned events",
      () => {
        vi.mocked(listAssignedEventsForLead).mockResolvedValue([]);
        renderAssignedEventsLoading();
      },
      "No coordinator is holding an active event.",
      "Assign a request from the unassigned queue.",
    ],
    [
      "the coordinators table",
      () => {
        vi.mocked(listCoordinatorOverview).mockResolvedValue({ statuses: [], coordinators: [] });
        renderAssignedEventsLoading();
      },
      "There are no Event Coordinators.",
      "Event Coordinator accounts are set up outside ConnectSphere.",
    ],
    [
      "the assignment history",
      () => renderHistory("organiser"),
      "No coordinator has been assigned to this request.",
      "If the Event Coordinator Lead assigns one, they will appear here.",
    ],
    [
      "the handover panel",
      () => {
        vi.mocked(listCoordinatorWorkload).mockResolvedValue([{ id: "c1", fullName: "Priya Nair", activeEvents: 1 }]);
        render(
          <ReassignEventPanel
            request={{ id: "e1", eventName: "Planning Night", assignedCoordinatorId: "c1" }}
            onCancel={vi.fn()}
            onReassigned={vi.fn()}
          />,
        );
      },
      "There is no other Event Coordinator to hand this event to.",
      "Another Event Coordinator account must be set up outside ConnectSphere before this event can be handed over.",
    ],
  ])("SCRUM590_AC4_an_empty_%s_says_what_is_missing_and_what_happens_next", async (_name, show, message, nextStep) => {
    show();

    const shown = await screen.findByText(message);
    expect(shown.closest(".ui-empty-state")).toHaveTextContent(nextStep);
  });

  it("SCRUM590_AC4_an_empty_assign_panel_says_an_account_is_needed", async () => {
    const { user } = await renderQueuePage();
    vi.mocked(listCoordinatorWorkload).mockResolvedValue([]);
    await openPanel(user, "assign");

    const shown = await screen.findByText("There is no Event Coordinator to assign this request to.");
    expect(shown.closest(".ui-empty-state")).toHaveTextContent(
      "An Event Coordinator account must be set up outside ConnectSphere before this request can be assigned.",
    );
  });

  it("SCRUM590_AC4_filtered_assigned_events_say_to_change_the_filters", async () => {
    const user = userEvent.setup();
    await renderAssignedEvents();
    vi.mocked(listAssignedEventsForLead).mockResolvedValue([]);

    await user.click(screen.getByLabelText("Include completed, rejected and cancelled"));

    const shown = await screen.findByText("No events match these filters.");
    expect(shown.closest(".ui-empty-state")).toHaveTextContent("Change or clear the filters to see more.");
  });

  it("SCRUM590_AC4_the_queue_shows_the_period_in_the_standard_format", async () => {
    await renderQueuePage();

    const row = screen.getByText("IS212 Industry Night").closest("li");
    expect(within(row).getByText("15 Jan 2026, 9:00 am – 11:00 am")).toBeInTheDocument();
  });

  it("SCRUM590_AC4_assigned_events_show_the_start_in_the_standard_format", async () => {
    await renderAssignedEvents();

    const row = screen.getByText("Planning Night").closest("li");
    expect(within(row).getByText("15 Jan 2026, 9:00 am")).toBeInTheDocument();
  });

  it("SCRUM590_AC4_the_assignment_history_dates_each_entry_in_the_standard_format", async () => {
    vi.mocked(getAssignmentHistoryForReview).mockResolvedValue([HANDOVER]);
    renderHistory();

    expect(await screen.findByText(/^15 Jan 2026, 9:00 am · by/)).toBeInTheDocument();
  });
});

/** Assigned events once its list has loaded, whatever the other reads did. */
async function renderAssignedEventsList() {
  render(
    <MemoryRouter>
      <AssignedEvents />
    </MemoryRouter>,
  );
  await screen.findByText("Planning Night");
}

describe("SCRUM590_AC1 the assign panel shows the request it is assigning", () => {
  function queueWith(fields) {
    vi.mocked(listUnassignedEventRequests).mockResolvedValue([{ ...WAITING[0], ...fields }, WAITING[1]]);
  }

  it("SCRUM590_AC1_the_assign_panel_shows_the_request_it_is_assigning", async () => {
    queueWith({ expectedAttendance: 120 });
    const { user } = await renderQueuePage();

    await openPanel(user, "assign");

    // The queue row has gone, so these can only be the panel's.
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    expect(screen.getByText("Aisha Rahman")).toBeInTheDocument();
    expect(screen.getByText("15 Jan 2026, 9:00 am – 11:00 am")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    expect(screen.getByText("waiting 10 days")).toBeInTheDocument();
  });

  it("SCRUM590_AC1_the_assign_panel_shows_the_accessibility_needs_when_there_are_some", async () => {
    queueWith({ accessibilityRequirements: "Step-free access to the stage" });
    const { user } = await renderQueuePage();

    await openPanel(user, "assign");

    expect(screen.getByText("Accessibility needs")).toBeInTheDocument();
    expect(screen.getByText("Step-free access to the stage")).toBeInTheDocument();
  });

  it.each([
    ["blank", "   "],
    ["null", null],
  ])("SCRUM590_AC1_the_assign_panel_leaves_out_accessibility_needs_that_are_%s", async (_name, value) => {
    queueWith({ accessibilityRequirements: value });
    const { user } = await renderQueuePage();

    await openPanel(user, "assign");

    expect(screen.getByText("Aisha Rahman")).toBeInTheDocument();
    expect(screen.queryByText("Accessibility needs")).not.toBeInTheDocument();
  });
});

describe("SCRUM590_AC4 empty assigned events offer a way forward", () => {
  it("SCRUM590_AC4_the_empty_assigned_events_state_links_to_the_queue", async () => {
    vi.mocked(listAssignedEventsForLead).mockResolvedValue([]);
    render(
      <MemoryRouter>
        <AssignedEvents />
      </MemoryRouter>,
    );

    const empty = (await screen.findByText("No coordinator is holding an active event.")).closest(".ui-empty-state");
    expect(within(empty).getByRole("link", { name: "Open the unassigned queue" })).toHaveAttribute(
      "href",
      "/unassigned-queue",
    );
  });

  it("SCRUM590_AC4_the_filtered_empty_state_clears_the_filters", async () => {
    const user = userEvent.setup();
    const noFilters = { coordinatorId: "", status: "", includeFinished: false };
    vi.mocked(listAssignedEventsForLead).mockImplementation(async (filters) =>
      filters.coordinatorId || filters.status || filters.includeFinished ? [] : HELD,
    );
    await renderAssignedEvents();
    const coordinator = screen.getByLabelText("Coordinator");
    const status = screen.getByLabelText("Status");
    const finished = screen.getByLabelText("Include completed, rejected and cancelled");
    await user.selectOptions(coordinator, "c1");
    await user.selectOptions(status, "approved");
    await user.click(finished);
    await screen.findByText("No events match these filters.");

    await user.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(await screen.findByText("Planning Night")).toBeInTheDocument();
    expect(vi.mocked(listAssignedEventsForLead)).toHaveBeenLastCalledWith(noFilters);
    expect(coordinator).toHaveValue("");
    expect(status).toHaveValue("");
    expect(finished).not.toBeChecked();
    // The button has gone, so focus is on the list's heading, not the page body.
    expect(screen.getByRole("heading", { level: 2, name: "Events" })).toHaveFocus();
  });
});
