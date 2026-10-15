// notificationInboxFlow.test.jsx
//
// SCRUM-172. One flow through the real components a signed-in user meets:
// UnreadCountProvider -> Navigation (the badge) and Dashboard (each role's
// dashboard mounts NotificationInbox), with notificationLink choosing where a
// row leads. The two pages a row can open are probes that echo the route
// param and router state, so what is tested is where the inbox sends the
// reader, not those pages.
//
// Only the services are mocked. notificationService is backed by a small
// stateful in-memory fake (createFakeInbox) built fresh for every test: list,
// count and mark-read share one array, so marking really lowers the count,
// and it keeps the backend's rules (newest first, list capped at 50, exact
// unread count, idempotent mark, 404 for an unknown id). The other services
// the role dashboards reach answer harmlessly with empty lists; every export
// this flow should never call rejects with "unexpected call". useAuth is
// mocked per role, returning one stable user object, because the provider
// ties each count reading to that object.
//
// Timezone-safe: expected times come from formatTimestamp, never a literal.
// No fake timers.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom";

import Dashboard from "../../src/components/Dashboard.jsx";
import Navigation from "../../src/components/Navigation.jsx";
import { UnreadCountProvider } from "../../src/notifications/UnreadCountContext.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import * as notificationService from "../../src/services/notificationService";
import * as eventRequestService from "../../src/services/eventRequestService";
import * as venueService from "../../src/services/venueService";
import * as bookingRequestService from "../../src/services/bookingRequestService";
import * as venueSuitabilityService from "../../src/services/venueSuitabilityService";
import * as eventEquipmentService from "../../src/services/eventEquipmentService";
import * as supportService from "../../src/services/supportService";
import { formatTimestamp } from "../../src/services/displayFormat";

vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../../src/services/notificationService", () => ({
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  getUnreadCount: vi.fn(),
}));

vi.mock("../../src/services/eventRequestService", () => ({
  createEventRequest: vi.fn(),
  updateEventRequest: vi.fn(),
  submitEventRequest: vi.fn(),
  requestEventClarification: vi.fn(),
  respondToEventClarification: vi.fn(),
  closeEventClarification: vi.fn(),
  getEventClarificationHistory: vi.fn(),
  getCoordinatorChangeRequests: vi.fn(),
  processCoordinatorChangeRequest: vi.fn(),
  getEventRequestById: vi.fn(),
  getMyEventRequests: vi.fn(),
  getEventRequestStatus: vi.fn(),
  getEventRequestQueue: vi.fn(),
  getEventCancellationImpact: vi.fn(),
  cancelEventRequest: vi.fn(),
  getEventReadiness: vi.fn(),
  submitForSafetyReview: vi.fn(),
  getMyAssignedEvents: vi.fn(),
  getEventRequestForReview: vi.fn(),
  listCoordinators: vi.fn(),
  getAssignmentHistory: vi.fn(),
  getAssignmentHistoryForReview: vi.fn(),
  reassignEventRequest: vi.fn(),
  listUnassignedEventRequests: vi.fn(),
  listCoordinatorWorkload: vi.fn(),
  listAssignedEventsForLead: vi.fn(),
  listCoordinatorOverview: vi.fn(),
  assignEventRequest: vi.fn(),
  startEventReview: vi.fn(),
  decideEventRequest: vi.fn(),
}));

vi.mock("../../src/services/venueService", () => ({
  searchActiveVenues: vi.fn(),
  findVenuesForEvent: vi.fn(),
  getVenueDetails: vi.fn(),
  getVenueCatalogue: vi.fn(),
  retireVenue: vi.fn(),
  createVenue: vi.fn(),
  updateVenue: vi.fn(),
  getVenueBookings: vi.fn(),
  getVenueHistory: vi.fn(),
  listVenueBlocks: vi.fn(),
  getVenueCalendar: vi.fn(),
  createVenueBlock: vi.fn(),
  updateVenueBlock: vi.fn(),
  removeVenueBlock: vi.fn(),
  getVenueBlockHistory: vi.fn(),
  listVenueHolds: vi.fn(),
  placeVenueHold: vi.fn(),
  getHoldCandidates: vi.fn(),
}));

vi.mock("../../src/services/bookingRequestService", () => ({
  createBookingRequest: vi.fn(),
  getMyBookingRequests: vi.fn(),
  withdrawBookingRequest: vi.fn(),
  getPendingBookingRequests: vi.fn(),
  approveBookingRequest: vi.fn(),
  rejectBookingRequest: vi.fn(),
}));

vi.mock("../../src/services/venueSuitabilityService", () => ({
  checkVenueSuitability: vi.fn(),
  getEventVenueSuitability: vi.fn(),
}));

vi.mock("../../src/services/eventEquipmentService", () => ({
  getEventEquipment: vi.fn(),
  addEquipmentLine: vi.fn(),
  amendEquipmentLine: vi.fn(),
  removeEquipmentLine: vi.fn(),
  getActiveEquipmentTypes: vi.fn(),
}));

vi.mock("../../src/services/supportService", () => ({
  getOpenTickets: vi.fn(),
  getEquipmentRequests: vi.fn(),
}));

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const USERS = {
  coordinator: {
    id: "c1000000-0000-4000-8000-000000000001",
    name: "Casey Coordinator",
    email: "casey@example.com",
    role: "event_coordinator",
  },
  organiser: {
    id: "a1000000-0000-4000-8000-000000000001",
    name: "Olive Organiser",
    email: "olive@example.com",
    role: "event_organiser",
  },
  venueStaff: {
    id: "d1000000-0000-4000-8000-000000000001",
    name: "Sam Staff",
    email: "sam@example.com",
    role: "venue_staff",
  },
};

const EVENT_ID = "e1000000-0000-4000-8000-000000000001";
const OTHER_EVENT_ID = "e2000000-0000-4000-8000-000000000002";
const VENUE_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function iso(ms) {
  return new Date(ms).toISOString();
}

/** A fixed hour ago, so the n-th notification is n minutes older. */
const BASE = Math.floor(Date.now() / MINUTE) * MINUTE - HOUR;

function notification(n, type, payload, { eventRequestId = EVENT_ID, readAt = null } = {}) {
  return {
    id: `n${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`,
    type,
    bookingId: null,
    blockId: null,
    venueHoldId: null,
    eventRequestId,
    payload: { eventRequestId, ...payload },
    readAt,
    createdAt: iso(BASE - n * MINUTE),
  };
}

function httpError(status) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { error: "Notification not found" } },
  });
}

/**
 * A stateful in-memory stand-in for /api/notifications, holding one user's
 * notifications (the API scopes by token, so there is no one else's to hold).
 */
function createFakeInbox(seed) {
  const rows = structuredClone(seed);

  return {
    rows,

    async listNotifications() {
      return structuredClone(
        [...rows]
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 50),
      );
    },

    async getUnreadCount() {
      return rows.filter((row) => !row.readAt).length;
    },

    async markNotificationRead(id) {
      const row = rows.find((r) => r.id === id);
      if (!row) throw httpError(404);
      if (!row.readAt) row.readAt = new Date().toISOString();
      return structuredClone(row);
    },
  };
}

const MOCKED_SERVICES = [
  notificationService,
  eventRequestService,
  venueService,
  bookingRequestService,
  venueSuitabilityService,
  eventEquipmentService,
  supportService,
];

let fake;

function useInbox(seed) {
  fake = createFakeInbox(seed);
  for (const name of ["listNotifications", "getUnreadCount", "markNotificationRead"]) {
    vi.mocked(notificationService[name]).mockImplementation(fake[name]);
  }
}

beforeEach(() => {
  for (const service of MOCKED_SERVICES) {
    for (const fn of Object.values(service)) {
      vi.mocked(fn).mockReset();
      vi.mocked(fn).mockRejectedValue(new Error("unexpected call"));
    }
  }
  // What each role's dashboard reads on mount, answered with nothing.
  vi.mocked(eventRequestService.getMyAssignedEvents).mockResolvedValue([]);
  vi.mocked(eventRequestService.getEventRequestQueue).mockResolvedValue([]);
  vi.mocked(eventRequestService.getMyEventRequests).mockResolvedValue([]);
  vi.mocked(bookingRequestService.getPendingBookingRequests).mockResolvedValue([]);
  vi.mocked(venueService.getVenueCatalogue).mockResolvedValue([]);
  vi.mocked(useAuth).mockReset();
  useInbox([]);
});

function EventRequestProbe() {
  const { eventRequestId } = useParams();
  const location = useLocation();
  return (
    <p data-testid="probe">
      event-request {eventRequestId} state {JSON.stringify(location.state ?? null)}
    </p>
  );
}

function EventsProbe() {
  const location = useLocation();
  return <p data-testid="probe">events state {JSON.stringify(location.state ?? null)}</p>;
}

function renderAs(user) {
  // One object for every call: the provider keys its reading on it.
  vi.mocked(useAuth).mockReturnValue({ user, logout: vi.fn().mockResolvedValue({ success: true }) });
  render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <UnreadCountProvider>
        <Navigation />
        <Routes>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/event-requests/:eventRequestId" element={<EventRequestProbe />} />
          <Route path="/events" element={<EventsProbe />} />
        </Routes>
      </UnreadCountProvider>
    </MemoryRouter>,
  );
  return userEvent.setup();
}

/** The inbox section, once its first row has loaded. */
async function openInbox(firstHeadline) {
  await screen.findAllByText(firstHeadline);
  return document.getElementById("notifications");
}

function inboxHeading(inbox) {
  return within(inbox).getByRole("heading", { level: 2 });
}

function badge() {
  return screen.getByRole("link", { name: /^Notifications/ });
}

function rowOf(headline) {
  return screen.getByText(headline).closest("li");
}

const assigned = (n, eventName) =>
  notification(n, "event_request_assigned", {
    eventName,
    assignedById: "l1",
    assignedByName: "Lee Lead",
    previousCoordinatorId: null,
    previousCoordinatorName: null,
    note: null,
  });

describe("SCRUM172 notification inbox flow", () => {
  it("SCRUM172_AC1_AC2_AC3_AC4_coordinator_sees_their_inbox_newest_first_with_the_count", async () => {
    // Stored oldest first, so the order on screen is the API's, not the seed's.
    const seed = Array.from({ length: 55 }, (_, i) => assigned(55 - i, `Event ${String(55 - i).padStart(2, "0")}`));
    useInbox(seed);
    renderAs(USERS.coordinator);

    const inbox = await openInbox("Event 01 was assigned to you");

    // AC4: the count is the exact 55, in the badge and the heading alike,
    // although only 50 rows are listed.
    await waitFor(() => expect(badge()).toHaveAccessibleName("Notifications, 55 unread"));
    expect(inboxHeading(inbox)).toHaveTextContent("Notifications (55 unread)");
    const rows = inbox.querySelectorAll("li");
    expect(rows).toHaveLength(50);

    // AC2: newest first.
    const headlines = [...rows].map((row) => row.querySelector(".notification-inbox__headline strong").textContent);
    expect(headlines).toEqual(
      Array.from({ length: 50 }, (_, i) => `Event ${String(i + 1).padStart(2, "0")} was assigned to you`),
    );

    // AC3: every unread row is marked as such.
    for (const row of rows) {
      expect(row).toHaveClass("notification-inbox__item--unread");
      expect(within(row).getByText("New")).toBeInTheDocument();
    }
  });

  it("SCRUM172_AC5_marking_read_lowers_the_badge_and_heading_together", async () => {
    useInbox([assigned(1, "Launch Night"), assigned(2, "Career Fair"), assigned(3, "Alumni Dinner")]);
    const user = renderAs(USERS.coordinator);

    const inbox = await openInbox("Launch Night was assigned to you");
    await waitFor(() => expect(badge()).toHaveAccessibleName("Notifications, 3 unread"));
    expect(inboxHeading(inbox)).toHaveTextContent("Notifications (3 unread)");

    await user.click(within(rowOf("Career Fair was assigned to you")).getByRole("button", { name: "Mark as read" }));

    await waitFor(() => expect(badge()).toHaveAccessibleName("Notifications, 2 unread"));
    expect(inboxHeading(inbox)).toHaveTextContent("Notifications (2 unread)");
    const row = rowOf("Career Fair was assigned to you");
    expect(row).toHaveClass("notification-inbox__item--read");
    expect(within(row).queryByText("New")).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Mark as read" })).not.toBeInTheDocument();
    expect(fake.rows.filter((r) => !r.readAt)).toHaveLength(2);
  });

  it("SCRUM172_AC6_every_row_reads_as_words_with_a_time", async () => {
    const startsAt = iso(BASE + 10 * DAY);
    const endsAt = iso(BASE + 10 * DAY + 3 * HOUR);
    const booking = { venueId: VENUE_ID, venueName: "Hall A", eventName: "Launch Night", startsAt, endsAt };
    // One of each type a coordinator receives, with the payload its migration writes.
    const seed = [
      notification(1, "booking_flagged", {
        ...booking,
        reason: "maintenance",
        blockStartsAt: startsAt,
        blockEndsAt: endsAt,
      }),
      notification(2, "booking_flagged_setup_change", {
        ...booking,
        occupiedStartsAt: iso(BASE + 10 * DAY - HOUR),
        occupiedEndsAt: iso(BASE + 10 * DAY + 4 * HOUR),
        setupMinutes: 60,
        turnaroundMinutes: 60,
        reason: "The venue's setup time changed.",
      }),
      notification(3, "venue_hold_expired", {
        eventName: "Launch Night",
        venueId: VENUE_ID,
        venueName: "Hall B",
        expiresAt: iso(BASE),
      }),
      notification(4, "booking_request_approved", {
        ...booking,
        decidedAt: iso(BASE),
        reason: null,
        suggestedAlternative: null,
      }),
      notification(5, "booking_request_rejected", {
        ...booking,
        venueName: "Hall C",
        decidedAt: iso(BASE),
        reason: "Under renovation",
        suggestedAlternative: "Hall A",
      }),
      notification(6, "booking_request_conflicting", {
        ...booking,
        venueName: "Hall D",
        approvedBookingId: "b1",
        approvedEventRequestId: OTHER_EVENT_ID,
        approvedEventName: "Career Fair",
        approvedStartsAt: startsAt,
        approvedEndsAt: endsAt,
      }),
      notification(7, "clarification_replied", { eventName: "Launch Night", message: "The budget is $500." }),
      notification(8, "event_request_assigned", {
        eventName: "Alumni Dinner",
        assignedById: "l1",
        assignedByName: "Lee Lead",
        previousCoordinatorId: "c2",
        previousCoordinatorName: "Robin Coordinator",
        note: "Caterer is booked.",
      }),
      notification(9, "safety_review_response", {
        eventName: "Launch Night",
        outcome: "changes_requested",
        note: "Add a second exit marshal.",
        responseId: "r1",
        respondedAt: iso(BASE),
      }),
    ];
    useInbox(seed);
    renderAs(USERS.coordinator);

    const inbox = await openInbox("Launch Night at Hall A needs review");
    const rows = [...inbox.querySelectorAll("li")];
    expect(rows).toHaveLength(seed.length);

    // Spot checks that each row is its own type's sentence, not a fallback.
    expect(within(inbox).getByText("The hold on Hall B for Launch Night has expired")).toBeInTheDocument();
    expect(within(inbox).getByText("Hall A was approved for Launch Night")).toBeInTheDocument();
    expect(within(inbox).getByText("The request for Hall C for Launch Night was rejected")).toBeInTheDocument();
    expect(
      within(inbox).getByText("Your request for Hall D for Launch Night now clashes with Career Fair"),
    ).toBeInTheDocument();
    expect(within(inbox).getByText("The Organiser replied about Launch Night")).toBeInTheDocument();
    expect(within(inbox).getByText("Alumni Dinner was handed over to you")).toBeInTheDocument();
    expect(within(inbox).getByText("The safety check asked for changes to Launch Night")).toBeInTheDocument();
    expect(within(inbox).getAllByText("Launch Night at Hall A needs review")).toHaveLength(2);

    expect(within(inbox).queryByText("New notification")).not.toBeInTheDocument();
    expect(within(inbox).queryByText(/cannot be displayed yet/)).not.toBeInTheDocument();
    expect(inbox).not.toHaveTextContent(/undefined|unknown/i);
    rows.forEach((row, i) => {
      expect(row).toHaveTextContent(`Received ${formatTimestamp(seed[i].createdAt)}`);
    });
  });

  it("SCRUM172_AC7_opening_a_notification_marks_it_read_and_lands_on_the_event", async () => {
    const other = { ...assigned(1, "Career Fair"), eventRequestId: OTHER_EVENT_ID };
    other.payload.eventRequestId = OTHER_EVENT_ID;
    useInbox([other, assigned(2, "Launch Night")]);
    const user = renderAs(USERS.coordinator);

    await openInbox("Launch Night was assigned to you");
    await waitFor(() => expect(badge()).toHaveAccessibleName("Notifications, 2 unread"));

    await user.click(screen.getByRole("link", { name: "Launch Night was assigned to you" }));

    expect(await screen.findByTestId("probe")).toHaveTextContent(`event-request ${EVENT_ID}`);
    await waitFor(() => expect(fake.rows.find((r) => r.payload.eventName === "Launch Night").readAt).not.toBeNull());
    expect(fake.rows.find((r) => r.payload.eventName === "Career Fair").readAt).toBeNull();

    // Back through the nav: the badge and the row both say it was read.
    await user.click(badge());
    const inbox = await openInbox("Launch Night was assigned to you");
    await waitFor(() => expect(badge()).toHaveAccessibleName("Notifications, 1 unread"));
    expect(inboxHeading(inbox)).toHaveTextContent("Notifications (1 unread)");
    expect(rowOf("Launch Night was assigned to you")).toHaveClass("notification-inbox__item--read");
  });

  it("SCRUM172_AC7_organiser_lands_on_their_events_list_focused", async () => {
    useInbox([
      notification(1, "event_request_coordinator_assigned", {
        eventName: "Launch Night",
        coordinatorId: USERS.coordinator.id,
        coordinatorName: "Casey Coordinator",
        previousCoordinatorId: null,
        previousCoordinatorName: null,
      }),
    ]);
    const user = renderAs(USERS.organiser);

    await openInbox("Casey Coordinator is now coordinating Launch Night");
    await user.click(screen.getByRole("link", { name: "Casey Coordinator is now coordinating Launch Night" }));

    expect(await screen.findByTestId("probe")).toHaveTextContent(
      `events state ${JSON.stringify({ focusEventRequestId: EVENT_ID })}`,
    );
    await waitFor(() => expect(fake.rows[0].readAt).not.toBeNull());
  });

  it("SCRUM172_AC7_venue_staff_rows_have_no_link", async () => {
    const startsAt = iso(BASE + 10 * DAY);
    const endsAt = iso(BASE + 10 * DAY + 3 * HOUR);
    // Each carries an event id, so no link is the role's rule, not a missing id.
    useInbox([
      notification(1, "booking_request_withdrawn", {
        eventName: "Launch Night",
        venueId: VENUE_ID,
        venueName: "Hall A",
        startsAt,
        endsAt,
      }),
      notification(2, "event_cancelled", {
        audience: "venue_staff",
        eventName: "Career Fair",
        reason: "Speaker unavailable",
        cancelledAt: iso(BASE),
      }),
    ]);
    renderAs(USERS.venueStaff);

    const inbox = await openInbox("The request for Launch Night at Hall A was withdrawn");
    expect(within(inbox).getByText("Bookings for Career Fair were released")).toBeInTheDocument();
    expect(inbox.querySelectorAll("li")).toHaveLength(2);
    expect(within(inbox).queryAllByRole("link")).toHaveLength(0);
  });

  it("SCRUM172_AC1_AC8_the_inbox_never_asks_for_another_users_notifications", async () => {
    useInbox([assigned(1, "Launch Night"), assigned(2, "Career Fair")]);
    const user = renderAs(USERS.coordinator);

    await openInbox("Launch Night was assigned to you");
    await user.click(within(rowOf("Career Fair was assigned to you")).getByRole("button", { name: "Mark as read" }));
    await waitFor(() => expect(badge()).toHaveAccessibleName("Notifications, 1 unread"));
    await user.click(screen.getByRole("link", { name: "Launch Night was assigned to you" }));
    await screen.findByTestId("probe");
    await waitFor(() => expect(fake.rows.every((r) => r.readAt)).toBe(true));

    // The API scopes by token: no call names a user, and a mark names only
    // one of this user's own notifications.
    const { listNotifications, getUnreadCount, markNotificationRead } = notificationService;
    expect(vi.mocked(listNotifications).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(getUnreadCount).mock.calls.length).toBeGreaterThan(0);
    for (const call of vi.mocked(listNotifications).mock.calls) expect(call).toEqual([]);
    for (const call of vi.mocked(getUnreadCount).mock.calls) expect(call).toEqual([]);
    const ownIds = fake.rows.map((r) => r.id);
    expect(vi.mocked(markNotificationRead).mock.calls).toHaveLength(2);
    for (const call of vi.mocked(markNotificationRead).mock.calls) {
      expect(call).toHaveLength(1);
      expect(ownIds).toContain(call[0]);
    }
    const everyArgument = MOCKED_SERVICES.flatMap((service) =>
      Object.values(service).flatMap((fn) => vi.mocked(fn).mock.calls.flat()),
    );
    expect(JSON.stringify(everyArgument)).not.toContain(USERS.coordinator.id);
  });
});
