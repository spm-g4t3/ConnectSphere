// scrum586CoordinatorPageRoutes.test.jsx
//
// Pins App.jsx's `asPage` on the Coordinator's three list routes, and the
// event page's h1 and wide wrapper: the component tests pass asPage
// themselves, so only the real routes can show a page lost its h1. A page the
// event screen swaps in keeps that one h1: it is the h1 on the event's own
// route and an h2 under a list's title. Auth and
// the reads are mocked; App, Navigation, the lists and the event screen are real.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useAuth } from "../../src/auth/AuthContext";
import { getMyBookingRequests } from "../../src/services/bookingRequestService";
import { getEventEquipment } from "../../src/services/eventEquipmentService";
import {
  getAssignmentHistoryForReview,
  getCoordinatorChangeRequests,
  getEventChangeHistory,
  getEventClarificationHistory,
  getEventDecisionHistory,
  getEventRequestForReview,
  getEventRequestQueue,
  getMyAssignedEvents,
  listCoordinatorWorkload,
} from "../../src/services/eventRequestService";
import { getUnreadCount } from "../../src/services/notificationService";
import { renderAppAt } from "../helpers/renderApp.js";

vi.mock("../../src/auth/AuthContext", async () => (await import("../helpers/authMock.js")).authContextMock());

vi.mock("../../src/services/eventRequestService", async (importOriginal) => ({
  ...(await importOriginal()),
  getEventRequestQueue: vi.fn(),
  getMyAssignedEvents: vi.fn(),
  // The event screen's own reads.
  getAssignmentHistoryForReview: vi.fn(),
  getCoordinatorChangeRequests: vi.fn(),
  getEventChangeHistory: vi.fn(),
  getEventClarificationHistory: vi.fn(),
  getEventDecisionHistory: vi.fn(),
  getEventRequestForReview: vi.fn(),
  // The Lead's handover page.
  listCoordinatorWorkload: vi.fn(),
}));

vi.mock("../../src/services/eventEquipmentService", async (importOriginal) => ({
  ...(await importOriginal()),
  getEventEquipment: vi.fn(),
}));

vi.mock("../../src/services/bookingRequestService", async (importOriginal) => ({
  ...(await importOriginal()),
  getMyBookingRequests: vi.fn(),
}));

vi.mock("../../src/services/notificationService", async (importOriginal) => ({
  ...(await importOriginal()),
  getUnreadCount: vi.fn(),
}));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const HOLDER = { id: "44444444-4444-4444-8444-444444444444", name: "Hana Holder" };
const SUBMITTED = {
  id: EVENT_ID,
  eventName: "IS212 Industry Night",
  status: "submitted",
  assignedCoordinatorId: HOLDER.id,
  statusDisplay: { status: "submitted", label: "Requested", group: "AWAITING_REVIEW", description: "x" },
};

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
  vi.mocked(getEventRequestQueue).mockReset().mockResolvedValue([]);
  vi.mocked(getMyAssignedEvents).mockReset().mockResolvedValue([]);
  vi.mocked(getMyBookingRequests).mockReset().mockResolvedValue([]);
  vi.mocked(getUnreadCount).mockReset().mockResolvedValue(0);
  for (const read of [
    getAssignmentHistoryForReview,
    getCoordinatorChangeRequests,
    getEventChangeHistory,
    getEventClarificationHistory,
    getEventDecisionHistory,
    getEventEquipment,
    listCoordinatorWorkload,
  ]) {
    vi.mocked(read).mockReset().mockResolvedValue([]);
  }
  vi.mocked(getEventRequestForReview).mockReset().mockResolvedValue(SUBMITTED);
});

describe("SCRUM586_AC2 the Coordinator's page routes", () => {
  it.each([
    { path: "/review-queue", title: "Review queue", empty: "Nothing is waiting for review right now." },
    { path: "/my-events", title: "My events", empty: "No events are assigned to you right now." },
    { path: "/my-venue-requests", title: "Venue requests", empty: "You have not requested a venue yet." },
  ])("SCRUM586_AC2_the_route_renders_one_h1 ($path)", async ({ path, title, empty }) => {
    renderAppAt(path, "event_coordinator");

    await screen.findByText(empty);
    const titles = screen.getAllByRole("heading", { level: 1 });
    expect(titles).toHaveLength(1);
    expect(titles[0]).toHaveTextContent(title);
  });

  it("SCRUM586_AC2_the_event_route_renders_the_event_name_as_its_one_h1", async () => {
    renderAppAt(`/event-requests/${EVENT_ID}`, "event_coordinator_lead");

    const title = await screen.findByRole("heading", { level: 1, name: "IS212 Industry Night" });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    // The wider page is this route's alone.
    expect(title.closest(".dashboard")).toHaveClass("dashboard--event-page");
  });
});

// [opener, the page's title]. A submitted event offers its holder only Cancel;
// every page's level is checked in scrum586CoordinatorKeyboard.test.jsx.
const SWAP_IN_PAGES = [["Cancel event", "Cancel IS212 Industry Night"]];

describe("SCRUM586_AC2 a page swapped into the event screen keeps the route's one h1", () => {
  it.each([
    { path: "/review-queue", list: "Review queue", read: getEventRequestQueue, row: "Review" },
    { path: "/my-events", list: "My events", read: getMyAssignedEvents, row: "Open" },
  ].flatMap((route) => SWAP_IN_PAGES.map(([opener, title]) => ({ ...route, opener, title }))))(
    "SCRUM586_AC2_opened_from_a_list_the_page_title_is_an_h2_under_the_lists_h1 ($path, $opener)",
    async ({ path, list, read, row, opener, title }) => {
      vi.mocked(read).mockResolvedValue([SUBMITTED]);
      renderAppAt(path, "event_coordinator", HOLDER);
      const user = userEvent.setup();

      await user.click(await screen.findByRole("button", { name: row }));
      await user.click(screen.getByRole("button", { name: opener }));

      expect(screen.getByRole("heading", { level: 2, name: title })).toBeInTheDocument();
      const titles = screen.getAllByRole("heading", { level: 1 });
      expect(titles).toHaveLength(1);
      expect(titles[0]).toHaveTextContent(list);
    },
  );

  it.each(SWAP_IN_PAGES)("SCRUM586_AC2_on_the_event_route_the_page_title_is_the_one_h1 (%s)", async (opener, title) => {
    renderAppAt(`/event-requests/${EVENT_ID}`, "event_coordinator", HOLDER);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: opener }));

    const titles = screen.getAllByRole("heading", { level: 1 });
    expect(titles).toHaveLength(1);
    expect(titles[0]).toHaveTextContent(title);
  });

  it("SCRUM586_AC2_on_the_event_route_the_leads_handover_title_is_the_one_h1", async () => {
    renderAppAt(`/event-requests/${EVENT_ID}`, "event_coordinator_lead");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Hand over to another coordinator" }));

    const titles = screen.getAllByRole("heading", { level: 1 });
    expect(titles).toHaveLength(1);
    expect(titles[0]).toHaveTextContent("Hand over IS212 Industry Night");
  });
});
