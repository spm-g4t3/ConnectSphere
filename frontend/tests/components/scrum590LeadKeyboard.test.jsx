// scrum590LeadKeyboard.test.jsx
//
// The Event Coordinator Lead's screens by keyboard alone: opening and closing a
// queue panel, and every Try again, leave focus on something named rather than
// the page body; the assign panel works without a mouse; and the coordinators'
// table scrolls inside its own focusable box. Services are mocked. jsdom does
// not lay pages out, so the 360px rules are read from App.css as text.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import UnassignedQueue from "../../src/components/UnassignedQueue.jsx";
import AssignedEvents from "../../src/components/AssignedEvents.jsx";
import AssignmentHistory from "../../src/components/AssignmentHistory.jsx";
import ReassignEventPanel from "../../src/components/ReassignEventPanel.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import {
  assignEventRequest,
  cancelEventRequest,
  getAssignmentHistoryForReview,
  getEventCancellationImpact,
  listAssignedEventsForLead,
  listCoordinatorOverview,
  listCoordinatorWorkload,
  listUnassignedEventRequests,
} from "../../src/services/eventRequestService";
import { httpError } from "../helpers/async.js";

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

const WAITING = [
  { id: "r1", eventName: "IS212 Industry Night", organiserName: "Aisha Rahman", submittedAt: "2026-10-01T00:00:00Z" },
  { id: "r2", eventName: "Freshers Welcome", organiserName: "Ben Lim", submittedAt: "2026-10-02T00:00:00Z" },
];
const WITHOUT_FIRST = WAITING.slice(1);
const COORDINATORS = [
  { id: "c1", fullName: "Priya Nair", activeEvents: 0 },
  { id: "c2", fullName: "Omar Okafor", activeEvents: 2 },
];
const NO_IMPACT = {
  venueBookings: { count: 0, details: [] },
  bookingRequests: { count: 0, details: [] },
  venueHolds: { count: 0, details: [] },
  equipmentRequests: { count: 0, details: [] },
  equipmentReservations: { count: 0, details: [] },
};
const OVERVIEW = {
  statuses: [{ status: "approved", label: "Planning", finished: false }],
  coordinators: [{ id: "c1", fullName: "Priya Nair", activeEvents: 1, byStatus: { approved: 1 } }],
};
const NOW = () => new Date("2026-10-11T12:00:00Z");

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(useAuth).mockReturnValue({ user: { id: "lead-1", role: "event_coordinator_lead" } });
  vi.mocked(listUnassignedEventRequests).mockResolvedValue(WAITING);
  vi.mocked(listCoordinatorWorkload).mockResolvedValue(COORDINATORS);
  vi.mocked(getEventCancellationImpact).mockResolvedValue(NO_IMPACT);
  vi.mocked(listAssignedEventsForLead).mockResolvedValue([
    { id: "e1", eventName: "Planning Night", statusDisplay: { label: "Planning", group: "APPROVED" } },
  ]);
  vi.mocked(listCoordinatorOverview).mockResolvedValue(OVERVIEW);
  vi.mocked(getAssignmentHistoryForReview).mockResolvedValue([]);
});

const queueTitle = () => screen.getByRole("heading", { level: 1, name: /Unassigned queue/ });
const rowButton = (kind) =>
  screen.getByRole("button", { name: `${kind === "assign" ? "Assign" : "Cancel"} IS212 Industry Night` });

async function renderQueuePage() {
  const user = userEvent.setup();
  render(<UnassignedQueue asPage now={NOW} />);
  await screen.findByText("IS212 Industry Night");
  return user;
}

/** Opens a panel the way a keyboard user does: focus the row's button, press Enter. */
async function openByKeyboard(user, kind) {
  rowButton(kind).focus();
  await user.keyboard("{Enter}");
}

function renderAssignedEvents() {
  render(
    <MemoryRouter>
      <AssignedEvents />
    </MemoryRouter>,
  );
}

describe("SCRUM590 AC6 focus when a queue panel opens and closes", () => {
  it.each([
    ["assign", "Assign IS212 Industry Night"],
    ["cancel", "Cancel IS212 Industry Night"],
  ])("SCRUM590_AC6_opening_%s_moves_focus_to_the_panel_title", async (kind, title) => {
    const user = await renderQueuePage();
    await openByKeyboard(user, kind);

    expect(screen.getByRole("heading", { level: 2, name: title })).toHaveFocus();
  });

  it.each(["assign", "cancel"])("SCRUM590_AC6_back_from_%s_returns_focus_to_the_button_that_opened_it", async (kind) => {
    const user = await renderQueuePage();
    await openByKeyboard(user, kind);
    if (kind === "assign") await screen.findByRole("radio", { name: "Priya Nair, 0 active events" });

    await user.click(screen.getByRole("button", { name: /Back to the unassigned queue/ }));

    await vi.waitFor(() => expect(rowButton(kind)).toHaveFocus());
  });

  it("SCRUM590_AC6_the_assign_forms_cancel_returns_focus_to_assign", async () => {
    const user = await renderQueuePage();
    await openByKeyboard(user, "assign");

    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    await vi.waitFor(() => expect(rowButton("assign")).toHaveFocus());
  });

  it("SCRUM590_AC6_back_to_the_queue_with_nobody_to_assign_returns_focus_to_assign", async () => {
    vi.mocked(listCoordinatorWorkload).mockResolvedValue([]);
    const user = await renderQueuePage();
    await openByKeyboard(user, "assign");

    await user.click(await screen.findByRole("button", { name: "Back to the queue" }));

    await vi.waitFor(() => expect(rowButton("assign")).toHaveFocus());
  });

  it("SCRUM590_AC6_back_after_the_row_has_left_the_queue_focuses_the_title", async () => {
    vi.mocked(listUnassignedEventRequests).mockResolvedValueOnce(WAITING).mockResolvedValueOnce(WITHOUT_FIRST);
    const user = await renderQueuePage();
    await openByKeyboard(user, "cancel");

    await user.click(screen.getByRole("button", { name: /Back to the unassigned queue/ }));

    await vi.waitFor(() => expect(queueTitle()).toHaveFocus());
    expect(screen.queryByText("IS212 Industry Night")).not.toBeInTheDocument();
  });

  it("SCRUM590_AC6_after_an_assignment_focus_is_on_the_title_and_the_confirmation_is_announced", async () => {
    vi.mocked(listUnassignedEventRequests).mockResolvedValueOnce(WAITING).mockResolvedValueOnce(WITHOUT_FIRST);
    vi.mocked(assignEventRequest).mockResolvedValue({ id: "r1" });
    const user = await renderQueuePage();
    await openByKeyboard(user, "assign");

    await user.click(await screen.findByRole("radio", { name: "Priya Nair, 0 active events" }));
    await user.click(screen.getByRole("button", { name: "Confirm assignment" }));

    await vi.waitFor(() => expect(queueTitle()).toHaveFocus());
    expect(screen.getByRole("status")).toHaveTextContent("IS212 Industry Night was assigned to Priya Nair.");
  });

  it("SCRUM590_AC6_after_a_cancellation_focus_is_on_the_title_and_the_confirmation_is_announced", async () => {
    vi.mocked(listUnassignedEventRequests).mockResolvedValueOnce(WAITING).mockResolvedValueOnce(WITHOUT_FIRST);
    vi.mocked(cancelEventRequest).mockResolvedValue({ id: "r1" });
    const user = await renderQueuePage();
    await openByKeyboard(user, "cancel");

    await user.type(screen.getByLabelText("Cancellation reason"), "Organiser no longer needs it");
    await user.click(screen.getByLabelText("The organiser’s request"));
    await user.click(screen.getByRole("button", { name: "Preview cancellation" }));
    await user.click(await screen.findByLabelText(/I have reviewed the impact/));
    await user.click(screen.getByRole("button", { name: "Cancel request" }));

    await vi.waitFor(() => expect(queueTitle()).toHaveFocus());
    expect(screen.getByRole("status")).toHaveTextContent("IS212 Industry Night was cancelled. The organiser has been told.");
  });

  it("SCRUM590_AC6_the_assign_panel_can_be_completed_with_the_keyboard_only", async () => {
    vi.mocked(assignEventRequest).mockResolvedValue({ id: "r1" });
    const user = await renderQueuePage();
    await openByKeyboard(user, "assign");
    await screen.findByRole("radio", { name: "Priya Nair, 0 active events" });

    // Title, then into the radio group, the arrow key moves to the next name.
    await user.tab();
    expect(screen.getByRole("radio", { name: "Priya Nair, 0 active events" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: "Omar Okafor, 2 active events" })).toBeChecked();
    await user.tab();
    await user.keyboard("Please start with the venue");
    await user.tab();
    expect(screen.getByRole("button", { name: "Confirm assignment" })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(assignEventRequest).toHaveBeenCalledWith("r1", { coordinatorId: "c2", note: "Please start with the venue" });
  });
});

// [what, the read that fails once, how to show it, what should have focus after Try again]
const RETRY_SCREENS = [
  [
    "the_unassigned_queue",
    listUnassignedEventRequests,
    () => render(<UnassignedQueue asPage now={NOW} />),
    queueTitle,
  ],
  [
    "the_assign_panels_coordinators",
    listCoordinatorWorkload,
    async () => {
      const user = await renderQueuePage();
      await user.click(rowButton("assign"));
    },
    () => screen.getByRole("heading", { level: 2, name: "Assign IS212 Industry Night" }),
  ],
  [
    "the_handover_list",
    listCoordinatorWorkload,
    () =>
      render(
        <ReassignEventPanel
          request={{ id: "e1", eventName: "Planning Night" }}
          outgoingCoordinatorId="c1"
          onCancel={vi.fn()}
          onReassigned={vi.fn()}
        />,
      ),
    () => screen.getByRole("heading", { level: 2, name: "Hand over Planning Night" }),
  ],
  [
    "the_assigned_events_list",
    listAssignedEventsForLead,
    renderAssignedEvents,
    () => screen.getByRole("heading", { level: 2, name: "Events" }),
  ],
  [
    "the_coordinators_workload",
    listCoordinatorOverview,
    renderAssignedEvents,
    () => screen.getByRole("heading", { level: 2, name: "Coordinators" }),
  ],
  [
    "the_unassigned_count",
    listUnassignedEventRequests,
    renderAssignedEvents,
    () => screen.getByRole("link", { name: "Open the Unassigned Queue" }).closest(".assigned-events__unassigned"),
  ],
  [
    "the_assignment_history",
    getAssignmentHistoryForReview,
    () => render(<AssignmentHistory eventRequestId="e1" view="coordinator" currentCoordinatorId="c1" />),
    () => screen.getByText("Current coordinator").closest(".assignment-history"),
  ],
];

describe("SCRUM590 AC6 Try again keeps focus on its section", () => {
  it.each(RETRY_SCREENS)("SCRUM590_AC6_try_again_on_%s_moves_focus_to_its_section", async (_, read, show, target) => {
    const user = userEvent.setup();
    vi.mocked(read).mockRejectedValueOnce(httpError(500));
    await show();

    const retry = await screen.findByRole("button", { name: "Try again" });
    retry.focus();
    await user.keyboard("{Enter}");

    await vi.waitFor(() => expect(target()).toHaveFocus());
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("SCRUM590_AC6_a_first_load_leaves_focus_where_it_is", async () => {
    await renderQueuePage();
    renderAssignedEvents();
    await screen.findByText("Planning Night");
    await screen.findByRole("table");

    expect(document.body).toHaveFocus();
  });
});

describe("SCRUM590 AC6 AC7 the coordinators' workload table", () => {
  it("SCRUM590_AC6_tab_reaches_the_workload_tables_scroll_box", async () => {
    const user = userEvent.setup();
    renderAssignedEvents();
    await screen.findByRole("table");

    screen.getByRole("heading", { level: 2, name: "Coordinators" }).focus();
    await user.tab();

    expect(screen.getByRole("region", { name: "Coordinators' workload" })).toHaveFocus();
  });

  it("SCRUM590_AC7_the_table_sits_inside_its_scroll_box", async () => {
    renderAssignedEvents();
    const region = await screen.findByRole("region", { name: "Coordinators' workload" });

    expect(region).toHaveClass("coordinator-workload__scroll");
    expect(within(region).getByRole("table")).toBeInTheDocument();
  });
});

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
const APP_CSS = readFileSync(resolve(SRC, "App.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** The body of each rule for this selector, at any nesting, joined. */
const rulesFor = (selector, css = APP_CSS) =>
  [...css.matchAll(new RegExp(`(?:^|[},])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "gm"))]
    .map((match) => match[1])
    .join(";");
/** The rules inside every `@media (max-width: 720px)` block, joined. */
const narrowRules = [...APP_CSS.matchAll(/@media \(max-width: 720px\) \{([\s\S]*?)\n\}/g)].map((match) => match[1]).join("\n");

describe("SCRUM590 AC7 the 360px rules", () => {
  it("SCRUM590_AC7_the_workload_table_scrolls_inside_its_box_not_the_page", () => {
    expect(rulesFor(".coordinator-workload__scroll")).toMatch(/overflow-x:\s*auto/);
  });

  it("SCRUM590_AC7_queue_and_assigned_event_rows_stack_at_phone_width", () => {
    expect(rulesFor(".dashboard .unassigned-queue__item", narrowRules)).toMatch(/flex-direction:\s*column/);
    expect(rulesFor(".dashboard .assigned-events li", narrowRules)).toMatch(/flex-direction:\s*column/);
  });

  it("SCRUM590_AC7_the_filters_put_one_label_and_control_per_line_at_phone_width", () => {
    expect(rulesFor(".assigned-events__filters", narrowRules)).toMatch(/grid-template-columns:\s*auto minmax\(0, 1fr\)/);
  });
});
