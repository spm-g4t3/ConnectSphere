// scrum492CoordinatorVenueBookings.test.jsx
//
// SCRUM-492 (SCRUM-567) on the coordinator's event page: who is offered the
// Venue bookings section (AC1-15) and what a release refreshes. The page's other
// sections are stubbed, as in scrum489CoordinatorSafetyCheck.test.jsx; the
// section itself renders for real.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import CoordinatorRequestDetail from "../../src/components/CoordinatorRequestDetail.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import { getCoordinatorChangeRequests } from "../../src/services/eventRequestService";
import { getMyBookingRequests, releaseVenueBooking } from "../../src/services/bookingRequestService";

vi.mock("../../src/auth/AuthContext", () => ({ useAuth: vi.fn() }));

vi.mock("../../src/services/eventRequestService", () => ({
  closeEventClarification: vi.fn(),
  getEventDecisionHistory: vi.fn(() => Promise.resolve([])),
  getEventChangeHistory: vi.fn(() => Promise.resolve([])),
  decideEventRequest: vi.fn(),
  getCoordinatorChangeRequests: vi.fn(),
  processCoordinatorChangeRequest: vi.fn(),
  requestEventClarification: vi.fn(),
  startEventReview: vi.fn(),
}));

vi.mock("../../src/services/bookingRequestService", () => ({
  getMyBookingRequests: vi.fn(),
  releaseVenueBooking: vi.fn(),
}));

// vi.mock is hoisted above every const, so the stub maker is hoisted with it.
const stub = vi.hoisted(() => (name) => ({ default: () => <div data-testid={name} /> }));
vi.mock("../../src/components/AssignmentHistory", () => stub("assignment-history"));
vi.mock("../../src/components/EventVenueFinder", () => stub("venue-finder"));
vi.mock("../../src/components/DecisionOutcome", () => stub("decision-outcome"));
vi.mock("../../src/components/ReassignEventPanel", () => stub("reassign"));
vi.mock("../../src/components/ClarificationHistoryDialog", () => stub("clarification-history"));
vi.mock("../../src/components/EventEquipmentSection", () => stub("equipment"));
vi.mock("../../src/components/EventCancellationPanel", () => stub("cancellation"));
vi.mock("../../src/components/EventFlaggedBookings", () => stub("flagged-bookings"));
vi.mock("../../src/components/SafetyCheckSubmissionPanel", () => stub("safety-check"));
// Counts its mounts, so a release can be seen to reload Venue suitability.
const suitabilityMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../src/components/EventVenueSuitability", async () => {
  const { useEffect } = await import("react");
  return {
    default: function Suitability() {
      useEffect(() => {
        suitabilityMounts.count += 1;
      }, []);
      return <div data-testid="venue-suitability" />;
    },
  };
});

const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const ASSIGNED = "44444444-4444-4444-8444-444444444444";
const OTHER = "66666666-6666-4666-8666-666666666666";
const LEAD = "77777777-7777-4777-8777-777777777777";

const NOT_APPROVED = [
  "draft", "submitted", "under_review", "pending_clarification", "safety_review",
  "safety_approved", "confirmed", "completed", "rejected", "cancelled",
];

const booking = {
  id: "b1",
  eventRequestId: EVENT_ID,
  venueName: "Hall A",
  status: "approved",
  statusDisplay: { label: "Approved" },
  startsAt: "2026-11-11T05:00:00+00:00",
  endsAt: "2026-11-11T06:00:00+00:00",
};

function eventRequest(overrides = {}) {
  return {
    id: EVENT_ID,
    eventName: "IS212 Industry Night",
    status: "approved",
    proposedStart: "2026-11-11T13:00:00+08:00",
    proposedEnd: "2026-11-11T14:00:00+08:00",
    expectedAttendance: 120,
    assignedCoordinatorId: ASSIGNED,
    statusDisplay: { status: "approved", label: "Planning", group: "APPROVED", description: "Accepted." },
    ...overrides,
  };
}

function signIn(id, role) {
  vi.mocked(useAuth).mockReturnValue({ user: { id, email: "someone@example.com", role } });
}

function renderPage(request, props = {}) {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <CoordinatorRequestDetail request={request} {...props} />
    </MemoryRouter>,
  );
  return { user };
}

const section = () => screen.queryByRole("heading", { name: "Venue bookings" });

beforeEach(() => {
  vi.clearAllMocks();
  suitabilityMounts.count = 0;
  vi.mocked(getCoordinatorChangeRequests).mockResolvedValue([]);
  vi.mocked(getMyBookingRequests).mockResolvedValue([booking]);
});

describe("SCRUM492_AC1 who is offered Release", () => {
  it("SCRUM492_AC1_the_assigned_coordinator_of_an_approved_event_is_offered_it", async () => {
    signIn(ASSIGNED, "event_coordinator");
    renderPage(eventRequest());

    expect(await screen.findByRole("heading", { name: "Venue bookings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Release this venue" })).toBeEnabled();
  });

  it.each([
    ["a_Lead", LEAD, "event_coordinator_lead"],
    ["a_coordinator_who_does_not_hold_the_event", OTHER, "event_coordinator"],
  ])("SCRUM492_AC1_%s_is_not_offered_it", async (_label, id, role) => {
    signIn(id, role);
    renderPage(eventRequest());
    await waitFor(() => expect(getCoordinatorChangeRequests).toHaveBeenCalled());

    expect(section()).not.toBeInTheDocument();
    expect(getMyBookingRequests).not.toHaveBeenCalled();
  });

  it.each(NOT_APPROVED)("SCRUM492_AC1_an_event_that_is_%s_offers_no_release", async (status) => {
    signIn(ASSIGNED, "event_coordinator");
    renderPage(eventRequest({ status }));
    await waitFor(() => expect(getCoordinatorChangeRequests).toHaveBeenCalled());

    expect(section()).not.toBeInTheDocument();
    expect(getMyBookingRequests).not.toHaveBeenCalled();
  });
});

describe("SCRUM492_AC1 a stale event refreshes the page", () => {
  it("SCRUM492_AC1_a_409_event_not_approved_from_release_refreshes_the_parent", async () => {
    signIn(ASSIGNED, "event_coordinator");
    const onChangeRequestProcessed = vi.fn();
    vi.mocked(releaseVenueBooking).mockRejectedValue(
      Object.assign(new Error("HTTP 409"), { response: { status: 409, data: { code: "EVENT_NOT_APPROVED" } } }),
    );
    const { user } = renderPage(eventRequest(), { onChangeRequestProcessed });
    const card = await screen.findByRole("listitem", { name: "Hall A" });

    await user.click(within(card).getByRole("button", { name: "Release this venue" }));
    await user.type(screen.getByLabelText("Reason for releasing this venue (required)"), "Moved");
    await user.click(screen.getByRole("button", { name: "Confirm release" }));

    await waitFor(() => expect(onChangeRequestProcessed).toHaveBeenCalledTimes(1));
    expect(suitabilityMounts.count).toBe(1);
  });
});

describe("SCRUM492_AC2 what a release refreshes", () => {
  it("SCRUM492_AC2_a_release_reloads_venue_suitability_and_the_parent_and_keeps_its_notice", async () => {
    signIn(ASSIGNED, "event_coordinator");
    const onChangeRequestProcessed = vi.fn();
    vi.mocked(releaseVenueBooking).mockResolvedValue({ booking: { ...booking, status: "released" }, returnedToPending: [] });
    const { user } = renderPage(eventRequest(), { onChangeRequestProcessed });
    const card = await screen.findByRole("listitem", { name: "Hall A" });
    expect(suitabilityMounts.count).toBe(1);

    await user.click(within(card).getByRole("button", { name: "Release this venue" }));
    await user.type(screen.getByLabelText("Reason for releasing this venue (required)"), "Moved");
    await user.click(screen.getByRole("button", { name: "Confirm release" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Hall A was released. Venue Staff have been told.");
    expect(suitabilityMounts.count).toBe(2);
    expect(onChangeRequestProcessed).toHaveBeenCalledTimes(1);
  });
});
