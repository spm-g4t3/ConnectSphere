// scrum379CoordinatorDashboardAttention.test.jsx
//
// SCRUM-384 (SCRUM-379 AC7): Needs attention on the coordinator's dashboard, beside My events.
// It sits ahead of My events, links each item to its event, and reads again when something in
// My events changes an event, so a row that has been dealt with does not stay on the list.
//
// The event screen is stubbed with two buttons that stand in for what it reports to its parent;
// its own behaviour is covered in scrum379CoordinatorCompletion.test.jsx. The services are mocked,
// so nothing touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import EventCoordinatorDashboard from "../../src/components/EventCoordinatorDashboard.jsx";
import {
  getEventRequestQueue,
  getMyAssignedEvents,
  getNeedsAttention,
} from "../../src/services/eventRequestService";
import { listNotifications } from "../../src/services/notificationService";

vi.mock("../../src/components/CoordinatorRequestDetail", () => ({
  default: ({ request, onChangeRequestProcessed, onReviewDecisionProcessed }) => (
    <div>
      <h2>Detail of {request.eventName}</h2>
      <button type="button" onClick={() => onChangeRequestProcessed?.()}>Report a change</button>
      <button type="button" onClick={() => onReviewDecisionProcessed?.()}>Report a decision</button>
    </div>
  ),
}));

vi.mock("../../src/services/eventRequestService", () => ({
  getEventRequestQueue: vi.fn(),
  getMyAssignedEvents: vi.fn(),
  getNeedsAttention: vi.fn(),
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

vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: () => ({ user: null }),
}));

const USER = { id: "44444444-4444-4444-8444-444444444444", email: "coord@example.com", role: "event_coordinator" };
const EVENT_ID = "22222222-2222-4222-8222-222222222222";

const ITEM = {
  id: `${EVENT_ID}:MARK_COMPLETED:0`,
  code: "MARK_COMPLETED",
  reason: "Mark as completed",
  eventRequestId: EVENT_ID,
  eventName: "IS212 Industry Night",
  status: "confirmed",
  proposedStart: "2030-06-15T01:00:00Z",
  proposedEnd: "2030-06-15T03:00:00Z",
  organiserName: "Olivia Organiser",
  link: `/event-requests/${EVENT_ID}`,
};

const MY_EVENT = {
  id: EVENT_ID,
  eventName: "IS212 Industry Night",
  status: "confirmed",
  statusDisplay: { status: "confirmed", label: "Confirmed", group: "CONFIRMED", description: "Going ahead." },
  proposedStart: "2030-06-15T01:00:00Z",
  organiserId: "11111111-1111-4111-8111-111111111111",
  organiserName: "Olivia Organiser",
};

const attentionSection = () => screen.getByRole("heading", { level: 2, name: /^Needs attention/ }).closest("section");

function renderDashboard() {
  return render(
    <MemoryRouter>
      <EventCoordinatorDashboard user={USER} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(getEventRequestQueue).mockReset().mockResolvedValue([]);
  vi.mocked(getMyAssignedEvents).mockReset().mockResolvedValue([MY_EVENT]);
  vi.mocked(getNeedsAttention).mockReset().mockResolvedValue([ITEM]);
  vi.mocked(listNotifications).mockReset().mockResolvedValue([]);
});

describe("SCRUM379 Needs attention on the coordinator dashboard", () => {
  it("SCRUM379_AC7_the_dashboard_lists_what_needs_attention_with_its_reason_and_a_link_to_the_event", async () => {
    renderDashboard();

    const link = await within(attentionSection()).findByRole("link", { name: "IS212 Industry Night" });
    expect(link).toHaveAttribute("href", `/event-requests/${EVENT_ID}`);
    expect(within(attentionSection()).getByText("Mark as completed")).toBeInTheDocument();
    expect(getNeedsAttention).toHaveBeenCalledTimes(1);
  });

  it("SCRUM379_AC7_it_sits_ahead_of_my_events_and_the_review_queue", async () => {
    renderDashboard();

    const attention = await screen.findByRole("heading", { level: 2, name: /^Needs attention/ });
    const mine = await screen.findByRole("heading", { name: "My events" });
    const queue = await screen.findByRole("heading", { name: "Review queue" });
    expect(attention.compareDocumentPosition(mine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mine.compareDocumentPosition(queue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("SCRUM379_AC7_it_is_a_direct_child_of_the_dashboard_for_the_card_styling", async () => {
    const { container } = renderDashboard();
    await screen.findByRole("link", { name: "IS212 Industry Night" });

    expect(container.querySelector(".dashboard.dashboard--coordinator > section.coordinator-attention")).not.toBeNull();
  });

  it("SCRUM379_AC7_an_empty_list_does_not_hide_my_events", async () => {
    vi.mocked(getNeedsAttention).mockResolvedValue([]);
    renderDashboard();

    expect(await screen.findByText("Nothing needs your attention right now.")).toBeInTheDocument();
    expect(await screen.findByText("IS212 Industry Night", { selector: "strong" })).toBeInTheDocument();
  });

  it("SCRUM379_AC7_a_failed_list_does_not_break_my_events", async () => {
    vi.mocked(getNeedsAttention).mockRejectedValue(new Error("Network Error"));
    renderDashboard();

    expect(await within(attentionSection()).findByRole("alert")).toHaveTextContent("could not be loaded");
    expect(await screen.findByText("IS212 Industry Night", { selector: "strong" })).toBeInTheDocument();
  });
});

describe("SCRUM379 Needs attention reads again after a change in My events", () => {
  async function openEvent(user) {
    await user.click(await screen.findByRole("button", { name: "Open" }));
    await screen.findByRole("heading", { name: "Detail of IS212 Industry Night" });
  }

  it("SCRUM379_AC7_a_change_reported_by_the_event_screen_reads_the_list_again", async () => {
    const user = userEvent.setup();
    renderDashboard();
    await openEvent(user);
    expect(getNeedsAttention).toHaveBeenCalledTimes(1);
    vi.mocked(getNeedsAttention).mockResolvedValue([]);

    await user.click(screen.getByRole("button", { name: "Report a change" }));

    await waitFor(() => expect(getNeedsAttention).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Nothing needs your attention right now.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "IS212 Industry Night" })).not.toBeInTheDocument();
  });

  it("SCRUM379_AC7_a_decision_reported_by_the_event_screen_reads_the_list_again", async () => {
    const user = userEvent.setup();
    renderDashboard();
    await openEvent(user);

    await user.click(screen.getByRole("button", { name: "Report a decision" }));

    await waitFor(() => expect(getNeedsAttention).toHaveBeenCalledTimes(2));
  });

  it("SCRUM379_AC7_my_events_is_still_read_again_after_a_change", async () => {
    const user = userEvent.setup();
    renderDashboard();
    await openEvent(user);
    expect(getMyAssignedEvents).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Report a change" }));

    await waitFor(() => expect(getMyAssignedEvents).toHaveBeenCalledTimes(2));
  });

  it("SCRUM379_AC7_opening_an_event_without_changing_anything_does_not_read_the_list_again", async () => {
    const user = userEvent.setup();
    renderDashboard();

    await openEvent(user);

    expect(getNeedsAttention).toHaveBeenCalledTimes(1);
  });
});
