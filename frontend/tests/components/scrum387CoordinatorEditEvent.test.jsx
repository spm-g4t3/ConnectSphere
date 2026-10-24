// scrum387CoordinatorEditEvent.test.jsx
//
// SCRUM-387 on the screens that host it: the coordinator's detail (the Edit
// event information button, the page it opens, the success line, the change
// history beside the past decisions) and the Organiser's row (a Change history
// disclosure read only once opened). EventDetailsEditPanel and
// EventChangeHistory have suites of their own.
//
// Every function the detail's tree reaches is on the strict mocks, as in
// CoordinatorRequestDetail.test.jsx.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import CoordinatorRequestDetail from "../../src/components/CoordinatorRequestDetail.jsx";
import MyEventRequests from "../../src/components/MyEventRequests.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import {
  applySignificantEventChange,
  getAssignmentHistory,
  getAssignmentHistoryForReview,
  getCoordinatorChangeRequests,
  getEventChangeHistory,
  getEventClarificationHistory,
  getEventDecisionHistory,
  getMyEventRequests,
  previewSignificantEventChange,
  updateEventRequestDetails,
} from "../../src/services/eventRequestService";

vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../../src/services/eventRequestService", () => ({
  closeEventClarification: vi.fn(),
  getEventDecisionHistory: vi.fn(() => Promise.resolve([])),
  getEventChangeHistory: vi.fn(),
  updateEventRequestDetails: vi.fn(),
  cancelEventRequest: vi.fn(),
  createEventRequest: vi.fn(),
  decideEventRequest: vi.fn(),
  getAssignmentHistory: vi.fn(),
  getAssignmentHistoryForReview: vi.fn(),
  getConfirmedArrangements: vi.fn(),
  getCoordinatorChangeRequests: vi.fn(),
  getEventCancellationImpact: vi.fn(),
  getEventClarificationHistory: vi.fn(),
  getMyEventRequests: vi.fn(),
  listCoordinators: vi.fn(),
  listCoordinatorWorkload: vi.fn(),
  processCoordinatorChangeRequest: vi.fn(),
  previewSignificantEventChange: vi.fn(),
  applySignificantEventChange: vi.fn(),
  reassignEventRequest: vi.fn(),
  requestEventClarification: vi.fn(),
  respondToEventClarification: vi.fn(),
  startEventReview: vi.fn(),
  submitEventRequest: vi.fn(),
  updateEventRequest: vi.fn(),
}));

vi.mock("../../src/services/venueService", () => ({
  findVenuesForEvent: vi.fn(),
}));

vi.mock("../../src/services/bookingRequestService", () => ({
  createBookingRequest: vi.fn(),
}));

vi.mock("../../src/services/venueSuitabilityService", () => ({
  checkVenueSuitability: vi.fn(),
  getEventVenueSuitability: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../../src/services/flaggedBookingService", () => ({
  getEventFlaggedBookings: vi.fn(() => Promise.resolve([])),
  cancelFlaggedBooking: vi.fn(),
}));

const ASSIGNED = "44444444-4444-4444-8444-444444444444";
const OTHER = "66666666-6666-4666-8666-666666666666";
const ORGANISER = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

const COORDINATOR_USER = { id: ASSIGNED, role: "event_coordinator" };
const LEAD_USER = { id: OTHER, role: "event_coordinator_lead" };

function eventRequest(overrides = {}) {
  return {
    id: REQUEST_ID,
    organiserId: ORGANISER,
    eventName: "IS212 Industry Night",
    purpose: "Connect students with industry.",
    description: "Talks, then networking.",
    proposedStart: "2026-12-01T09:00:00.000Z",
    proposedEnd: "2026-12-01T11:00:00.000Z",
    expectedAttendance: 80,
    venueRequirements: "A large room",
    status: "under_review",
    assignedCoordinatorId: ASSIGNED,
    reviewedBy: ASSIGNED,
    updatedAt: "2026-10-20T03:00:00Z",
    statusDisplay: { label: "Under review", group: "UNDER_REVIEW", description: "Being reviewed." },
    ...overrides,
  };
}

const HISTORY_ROW = {
  id: "h1", field: "purpose", oldValue: "Old purpose", newValue: "Connect students with industry.",
  reason: "Organiser asked", source: "direct_edit", changedByName: "Priya Nair", changedAt: "2026-10-19T03:00:00Z",
};

function detailUi(request, props) {
  return (
    <MemoryRouter>
      <CoordinatorRequestDetail request={request} onReviewDecisionProcessed={vi.fn()} {...props} />
    </MemoryRouter>
  );
}

function renderDetail(user, request = eventRequest(), props = {}) {
  vi.mocked(useAuth).mockReturnValue({ user });
  const utils = render(detailUi(request, props));
  return { user: userEvent.setup(), ...utils, rerenderWith: (next) => utils.rerender(detailUi(next, props)) };
}

const editButton = () => screen.queryByRole("button", { name: "Edit event information" });
const historySection = () => screen.queryByRole("region", { name: "Change history" });

beforeEach(() => {
  vi.mocked(getEventChangeHistory).mockReset();
  vi.mocked(getEventChangeHistory).mockResolvedValue([HISTORY_ROW]);
  vi.mocked(updateEventRequestDetails).mockReset();
  vi.mocked(getCoordinatorChangeRequests).mockResolvedValue([]);
  vi.mocked(getAssignmentHistoryForReview).mockResolvedValue([]);
  vi.mocked(getEventClarificationHistory).mockResolvedValue([]);
});


describe("SCRUM-387 the Edit event information button", () => {
  it.each(["under_review", "pending_clarification", "approved", "safety_review", "safety_approved"])(
    "SCRUM387_AC1_the_assigned_coordinator_sees_it_while_%s",
    async (status) => {
      renderDetail(COORDINATOR_USER, eventRequest({ status }));

      expect(editButton()).toBeInTheDocument();
      await screen.findByText("Reason: Organiser asked");
    },
  );

  it.each(["confirmed", "submitted", "rejected", "cancelled", "completed"])(
    "SCRUM387_AC4_AC5_it_is_not_offered_while_%s",
    async (status) => {
      renderDetail(COORDINATOR_USER, eventRequest({ status }));

      expect(editButton()).not.toBeInTheDocument();
      await waitFor(() => expect(getEventChangeHistory).toHaveBeenCalled());
    },
  );

  it.each([
    ["the_lead", LEAD_USER],
    ["a_coordinator_it_is_not_assigned_to", { id: OTHER, role: "event_coordinator" }],
    ["a_lead_whose_id_is_the_holders", { id: ASSIGNED, role: "event_coordinator_lead" }],
  ])("SCRUM387_AC1_%s_never_sees_it", async (_label, user) => {
    renderDetail(user);

    expect(editButton()).not.toBeInTheDocument();
    await screen.findByText("IS212 Industry Night");
  });

  it("SCRUM387_AC4_it_goes_when_a_refetch_brings_the_event_to_confirmed", async () => {
    const { rerenderWith } = renderDetail(COORDINATOR_USER, eventRequest({ status: "safety_approved" }));
    expect(editButton()).toBeInTheDocument();

    rerenderWith(eventRequest({ status: "confirmed", updatedAt: "2026-10-22T03:00:00Z" }));

    expect(editButton()).not.toBeInTheDocument();
    await screen.findByText("Reason: Organiser asked");
  });
});


describe("SCRUM-387 the edit page", () => {
  it("SCRUM387_AC2_opens_as_a_page_with_all_nine_fields_under_review_and_back_returns", async () => {
    const { user } = renderDetail(COORDINATOR_USER);

    await user.click(editButton());

    expect(screen.getByRole("heading", { name: "Edit event information: IS212 Industry Night" })).toBeInTheDocument();
    expect(screen.getByLabelText("Proposed start")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Change history" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to event" }));
    expect(editButton()).toBeInTheDocument();
  });

  it("SCRUM387_AC3_in_approved_it_shows_the_ordinary_fields_and_points_to_revise_event_details", async () => {
    const { user } = renderDetail(COORDINATOR_USER, eventRequest({ status: "approved" }));

    await user.click(editButton());

    expect(screen.getByLabelText("Event name")).toBeInTheDocument();
    expect(screen.queryByLabelText("Proposed start")).not.toBeInTheDocument();
    expect(screen.getByText(/changed through Revise event details/)).toBeInTheDocument();
  });

  it("SCRUM387_AC2_a_save_returns_to_the_updated_event_names_the_fields_and_rereads_the_history", async () => {
    const onChangeRequestProcessed = vi.fn();
    vi.mocked(updateEventRequestDetails).mockImplementation(async (_id, { changes }) => ({
      ...eventRequest(), ...changes, updatedAt: "2026-10-23T03:00:00Z", changedFields: Object.keys(changes).sort(),
    }));
    const { user } = renderDetail(COORDINATOR_USER, eventRequest(), { onChangeRequestProcessed });
    await screen.findByText("Reason: Organiser asked");
    expect(getEventChangeHistory).toHaveBeenCalledTimes(1);

    await user.click(editButton());
    await user.clear(screen.getByLabelText("Purpose"));
    await user.type(screen.getByLabelText("Purpose"), "Meet alumni.");
    await user.clear(screen.getByLabelText("Event name"));
    await user.type(screen.getByLabelText("Event name"), "IS212 Alumni Night");
    await user.type(screen.getByLabelText("Reason for this change"), "Organiser asked by email");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Saved. Changed: Event name and Purpose.")).toHaveAttribute("role", "status");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("IS212 Alumni Night");
    expect(screen.getByText("Meet alumni.")).toBeInTheDocument();
    expect(onChangeRequestProcessed).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(getEventChangeHistory).toHaveBeenCalledTimes(2));
  });
});


describe("SCRUM-387 the change history on the coordinator's detail", () => {
  it.each([
    ["the_assigned_coordinator", COORDINATOR_USER],
    ["the_lead", LEAD_USER],
  ])("SCRUM387_AC7_%s_reads_it_beside_the_past_decisions", async (_label, user) => {
    renderDetail(user);

    const section = historySection();
    expect(within(section).getByRole("heading", { name: "Change history" })).toBeInTheDocument();
    expect(await within(section).findByText("Reason: Organiser asked")).toBeInTheDocument();
    expect(getEventChangeHistory).toHaveBeenCalledWith(REQUEST_ID);
  });

  it("SCRUM387_AC7_it_sits_after_the_past_decisions_and_before_the_clarification_history", async () => {
    vi.mocked(getEventDecisionHistory).mockResolvedValueOnce([{
      id: "d1", decision: "rejected", decisionNote: "Too few marshals.", decidedByName: "Priya Nair",
      decidedAt: "2026-10-15T03:00:00Z", supersededReason: "reopened_for_revision", supersededAt: "2026-10-16T03:00:00Z",
    }]);
    renderDetail(COORDINATOR_USER);

    const decisions = await screen.findByRole("region", { name: "Previous decisions" });
    const clarifications = screen.getByRole("heading", { name: "Clarification history" });
    const follows = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(decisions, historySection())).toBe(true);
    expect(follows(historySection(), clarifications)).toBe(true);
    await screen.findByText("Reason: Organiser asked");
  });

  it("SCRUM387_AC7_a_refetch_that_moves_updatedAt_rereads_it_and_one_that_does_not_leaves_it", async () => {
    // The detail stays open while the parent refetches, e.g. after another
    // coordinator action: only a changed event is read again.
    const { rerenderWith } = renderDetail(COORDINATOR_USER);
    await screen.findByText("Reason: Organiser asked");

    rerenderWith(eventRequest());
    await screen.findByText("Reason: Organiser asked");
    expect(getEventChangeHistory).toHaveBeenCalledTimes(1);

    rerenderWith(eventRequest({ purpose: "Changed elsewhere", updatedAt: "2026-10-25T03:00:00Z" }));
    await waitFor(() => expect(getEventChangeHistory).toHaveBeenCalledTimes(2));
  });

  it("SCRUM387_AC7_a_coordinator_it_is_not_assigned_to_does_not_read_it", async () => {
    renderDetail({ id: OTHER, role: "event_coordinator" });

    await screen.findByText("IS212 Industry Night");
    expect(historySection()).not.toBeInTheDocument();
    expect(getEventChangeHistory).not.toHaveBeenCalled();
  });

  it("SCRUM387_AC7_it_is_read_again_after_a_significant_change", async () => {
    const approved = eventRequest({ status: "approved" });
    vi.mocked(previewSignificantEventChange).mockResolvedValue({
      statusBefore: "approved", statusAfter: "approved", venueBookings: [], equipmentReservations: [],
      pendingBookingRequests: [], registeredAttendeesToNotify: 0,
    });
    vi.mocked(applySignificantEventChange).mockResolvedValue({
      ...approved, expectedAttendance: 120, updatedAt: "2026-10-24T03:00:00Z",
    });
    const { user } = renderDetail(COORDINATOR_USER, approved, { onChangeRequestProcessed: vi.fn() });
    await screen.findByText("Reason: Organiser asked");

    await user.click(screen.getByRole("button", { name: "Revise event details" }));
    await user.clear(screen.getByLabelText("Expected attendance"));
    await user.type(screen.getByLabelText("Expected attendance"), "120");
    await user.type(screen.getByLabelText("Reason for this change"), "More sign-ups");
    await user.click(screen.getByRole("button", { name: "Preview significant change" }));
    await user.click(await screen.findByRole("checkbox", { name: /I have reviewed this impact/ }));
    await user.click(screen.getByRole("button", { name: "Confirm significant change" }));

    await waitFor(() => expect(getEventChangeHistory).toHaveBeenCalledTimes(2));
  });
});


describe("SCRUM-387 the change history on the Organiser's row", () => {
  function renderList(requests) {
    vi.mocked(useAuth).mockReturnValue({ user: { id: ORGANISER, role: "event_organiser" } });
    vi.mocked(getAssignmentHistory).mockResolvedValue([]);
    vi.mocked(getMyEventRequests).mockResolvedValue(requests);
    return render(<MemoryRouter><MyEventRequests /></MemoryRouter>);
  }

  it("SCRUM387_AC7_each_non_draft_row_has_one_and_nothing_is_read_until_it_is_opened", async () => {
    renderList([
      eventRequest({ id: "r1", eventName: "First event" }),
      eventRequest({ id: "r2", eventName: "Second event", status: "approved" }),
      eventRequest({ id: "r3", eventName: "A draft", status: "draft", assignedCoordinatorId: null }),
    ]);

    await screen.findByText("Second event");
    expect(screen.getAllByText("Change history")).toHaveLength(2);
    expect(getEventChangeHistory).not.toHaveBeenCalled();

    const second = screen.getByText("Second event").closest("li");
    await userEvent.click(within(second).getByText("Change history"));

    expect(await within(second).findByText("Reason: Organiser asked")).toBeInTheDocument();
    expect(getEventChangeHistory).toHaveBeenCalledTimes(1);
    expect(getEventChangeHistory).toHaveBeenCalledWith("r2");
  });

  it("SCRUM387_AC7_closing_and_reopening_does_not_read_it_again", async () => {
    renderList([eventRequest({ id: "r1", eventName: "First event" })]);
    const summary = await screen.findByText("Change history");

    await userEvent.click(summary);
    await screen.findByText("Reason: Organiser asked");
    await userEvent.click(summary);
    await userEvent.click(summary);

    expect(getEventChangeHistory).toHaveBeenCalledTimes(1);
  });
});
