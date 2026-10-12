// EventCoordinatorLeadDashboard.test.jsx
//
// SCRUM-486 (SCRUM-519): what the Lead's dashboard holds now that the queue
// is built, and the notices 052 sends the Lead.
//
// Dashboard.test.jsx pins which dashboard each role gets. This file pins what
// is on the Lead's: the live queue, the overview placeholder SCRUM-487 will
// replace, and the notifications card.
//
// The notices. 052 writes three new types (AC10): event_request_awaiting_
// assignment to every Lead, event_request_assigned to the coordinator,
// event_request_coordinator_assigned to the Organiser. This build's
// describeNotification knows none of them; SCRUM-172 words them. Until then
// each must degrade, not disappear: shown as "New notification / This
// notification type cannot be displayed yet", counted as unread, and
// markable as read. A notice that rendered as nothing would sit in the unread
// count with no way to find or clear it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import EventCoordinatorLeadDashboard from "../../src/components/EventCoordinatorLeadDashboard.jsx";
import { listUnassignedEventRequests } from "../../src/services/eventRequestService";
import { listNotifications, markNotificationRead } from "../../src/services/notificationService";

vi.mock("../../src/services/eventRequestService", () => ({
  listUnassignedEventRequests: vi.fn(),
  listCoordinatorWorkload: vi.fn(),
  assignEventRequest: vi.fn(),
}));

vi.mock("../../src/services/notificationService", () => ({
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
}));

const LEAD = { id: "77777777-7777-4777-8777-777777777777", email: "lead@example.com", role: "event_coordinator_lead" };
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

/** One notice of each type 052 adds, as GET /notifications returns them. */
const NEW_TYPES = [
  {
    id: "n1",
    type: "event_request_awaiting_assignment",
    payload: { eventRequestId: REQUEST_ID, eventName: "IS212 Industry Night", submittedAt: "2026-10-10T03:00:00+00:00" },
  },
  {
    id: "n2",
    type: "event_request_assigned",
    payload: { eventRequestId: REQUEST_ID, assignedByName: "Lena Lead", note: "Over to you" },
  },
  {
    id: "n3",
    type: "event_request_coordinator_assigned",
    payload: { eventRequestId: REQUEST_ID, coordinatorName: "Priya Nair" },
  },
].map((notice) => ({ ...notice, readAt: null, createdAt: "2026-10-10T03:00:00+00:00" }));

const renderDashboard = () => render(<EventCoordinatorLeadDashboard user={LEAD} />);

beforeEach(() => {
  vi.mocked(listUnassignedEventRequests).mockReset();
  vi.mocked(listUnassignedEventRequests).mockResolvedValue([]);
  vi.mocked(listNotifications).mockReset();
  vi.mocked(listNotifications).mockResolvedValue([]);
  vi.mocked(markNotificationRead).mockReset();
});


describe("SCRUM486_AC2 the Lead's dashboard", () => {
  it("SCRUM486_AC2_holds_the_live_queue_the_overview_placeholder_and_the_notifications", async () => {
    renderDashboard();

    expect(screen.getByRole("heading", { level: 1, name: "Event Coordinator Lead" })).toBeInTheDocument();
    expect(screen.getByText("Signed in as lead@example.com.")).toBeInTheDocument();
    // The queue, read for real, here empty, and said so.
    expect(await screen.findByText("No event requests are waiting for a coordinator.")).toBeInTheDocument();
    expect(listUnassignedEventRequests).toHaveBeenCalledTimes(1);
    // SCRUM-487's section is still a placeholder.
    expect(screen.getByRole("heading", { level: 2, name: "Coordinator overview" })).toBeInTheDocument();
    expect(screen.getByText(/built by SCRUM-487/)).toBeInTheDocument();
    // The notifications card.
    expect(await screen.findByText("You have no notifications.")).toBeInTheDocument();
    expect(listNotifications).toHaveBeenCalledTimes(1);
  });

  it("SCRUM486_AC2_uses_a_name_when_one_is_sent", async () => {
    render(<EventCoordinatorLeadDashboard user={{ ...LEAD, name: "Lena Lead" }} />);

    expect(screen.getByText("Signed in as Lena Lead.")).toBeInTheDocument();
    await screen.findByText("You have no notifications.");
  });
});


describe("SCRUM486_AC10 the new notification types degrade until SCRUM-172 words them", () => {
  it("SCRUM486_AC10_each_new_type_is_shown_as_a_notification_that_cannot_be_displayed_yet", async () => {
    vi.mocked(listNotifications).mockResolvedValue(NEW_TYPES);
    renderDashboard();

    // Three rows, not none: every notice is shown, with the fallback text.
    const card = (await screen.findByRole("heading", { name: "Notifications (3 unread)" })).closest("section");
    const items = within(card).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(within(item).getByText("New notification")).toBeInTheDocument();
      expect(within(item).getByText("This notification type cannot be displayed yet.")).toBeInTheDocument();
      expect(within(item).getByRole("button", { name: "Mark as read" })).toBeInTheDocument();
    }
    // Nothing from the payload leaks through as half-rendered wording.
    expect(card).not.toHaveTextContent("Over to you");
  });

  it("SCRUM486_AC10_a_new_type_can_be_marked_read_and_leaves_the_unread_count", async () => {
    vi.mocked(listNotifications).mockResolvedValue([NEW_TYPES[0]]);
    vi.mocked(markNotificationRead).mockResolvedValue({ ...NEW_TYPES[0], readAt: "2026-10-11T03:00:00+00:00" });
    const user = userEvent.setup();
    renderDashboard();

    await user.click(await screen.findByRole("button", { name: "Mark as read" }));

    expect(markNotificationRead).toHaveBeenCalledWith("n1");
    expect(await screen.findByRole("heading", { name: "Notifications" })).toBeInTheDocument();
    expect(screen.getByText("New notification")).toBeInTheDocument();
  });
});
