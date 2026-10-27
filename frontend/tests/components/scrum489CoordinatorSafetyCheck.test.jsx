// scrum489CoordinatorSafetyCheck.test.jsx
//
// SCRUM-489 (SCRUM-557) on the coordinator's event page: who is offered the
// submission panel (AC1), and what the page shows once it succeeds (AC6).
// The page's other sections are stubbed; their own suites cover them. The
// panel itself renders for real.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import CoordinatorRequestDetail from "../../src/components/CoordinatorRequestDetail.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import {
  getCoordinatorChangeRequests,
  getEventReadiness,
  submitForSafetyReview,
  confirmEventRequest,
  getMyAssignedEvents,
  previewSignificantEventChange,
  applySignificantEventChange,
} from "../../src/services/eventRequestService";
import MyAssignedEvents from "../../src/components/MyAssignedEvents";

vi.mock("../../src/auth/AuthContext", () => ({ useAuth: vi.fn() }));

vi.mock("../../src/services/eventRequestService", () => ({
  closeEventClarification: vi.fn(),
  getEventDecisionHistory: vi.fn(() => Promise.resolve([])),
  getEventChangeHistory: vi.fn(() => Promise.resolve([])),
  decideEventRequest: vi.fn(),
  getCoordinatorChangeRequests: vi.fn(),
  getEventReadiness: vi.fn(),
  processCoordinatorChangeRequest: vi.fn(),
  requestEventClarification: vi.fn(),
  startEventReview: vi.fn(),
  submitForSafetyReview: vi.fn(),
  confirmEventRequest: vi.fn(),
  getMyAssignedEvents: vi.fn(),
  previewSignificantEventChange: vi.fn(),
  applySignificantEventChange: vi.fn(),
}));

// vi.mock is hoisted above every const, so the stub maker is hoisted with it.
const stub = vi.hoisted(() => (name) => ({ default: () => <div data-testid={name} /> }));
vi.mock("../../src/components/AssignmentHistory", () => stub("assignment-history"));
vi.mock("../../src/components/EventVenueFinder", () => stub("venue-finder"));
vi.mock("../../src/components/EventVenueSuitability", () => stub("venue-suitability"));
vi.mock("../../src/components/EventFlaggedBookings", () => stub("flagged-bookings"));
vi.mock("../../src/components/EventVenueBookings", () => stub("venue-bookings"));
vi.mock("../../src/components/DecisionOutcome", () => stub("decision-outcome"));
vi.mock("../../src/components/ReassignEventPanel", () => stub("reassign"));
vi.mock("../../src/components/ClarificationHistoryDialog", () => stub("clarification-history"));
vi.mock("../../src/components/EventEquipmentSection", () => stub("equipment"));
vi.mock("../../src/components/EventCancellationPanel", () => stub("cancellation"));
vi.mock("../../src/components/RegistrationCounts", () => stub("registration-counts"));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const ASSIGNED = "44444444-4444-4444-8444-444444444444";
const OTHER = "66666666-6666-4666-8666-666666666666";
const LEAD = "77777777-7777-4777-8777-777777777777";

// Every status but approved: the panel is offered in none of them.
const NOT_APPROVED = [
  "draft", "submitted", "under_review", "pending_clarification", "safety_review",
  "safety_approved", "confirmed", "completed", "rejected", "cancelled",
];

const READY = {
  eventRequestId: EVENT_ID,
  ready: true,
  items: [
    { key: "venue", met: true, detail: "Approved", bookingId: "b1", venueName: "Room 2" },
    { key: "equipment", met: true, detail: "No equipment requested" },
    { key: "date", met: true, detail: "Starts in the future" },
  ],
};

function eventRequest(overrides = {}) {
  return {
    id: EVENT_ID,
    eventName: "IS212 Industry Night",
    status: "approved",
    proposedStart: "2026-11-11T10:00:00+08:00",
    proposedEnd: "2026-11-11T12:00:00+08:00",
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
  const view = render(
    <MemoryRouter>
      <CoordinatorRequestDetail request={request} {...props} />
    </MemoryRouter>,
  );
  return { user, ...view };
}

const panel = () => screen.queryByRole("region", { name: "Submit for the safety check" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEventReadiness).mockResolvedValue(READY);
  vi.mocked(confirmEventRequest).mockReset();
  vi.mocked(getMyAssignedEvents).mockReset();
  // The change-request list the page reads on mount; empty here.
  vi.mocked(getCoordinatorChangeRequests).mockResolvedValue([]);
});

const safetyApproved = (overrides = {}) => eventRequest({
  status: "safety_approved",
  statusDisplay: { status: "safety_approved", label: "Safety approved", group: "APPROVED", description: "The safety check is complete." },
  ...overrides,
});
const confirmedEvent = () => safetyApproved({
  status: "confirmed",
  statusDisplay: { status: "confirmed", label: "Confirmed", group: "CONFIRMED", description: "The event is going ahead." },
});
const confirmPanel = () => screen.queryByRole("region", { name: "Confirm event" });

describe("SCRUM363 coordinator confirmation", () => {
  it("SCRUM363_AC8_confirmation_and_significant_change_actions_remain_reachable_without_stale_success", async () => {
    signIn(ASSIGNED, "event_coordinator");
    vi.mocked(confirmEventRequest).mockResolvedValue(confirmedEvent());
    const impact = { venueBookings: [], equipmentReservations: [], registeredAttendeesToNotify: 0,
      statusBefore: "confirmed", statusAfter: "approved", equipmentChangeRecorded: false };
    vi.mocked(previewSignificantEventChange).mockResolvedValue(impact);
    vi.mocked(applySignificantEventChange).mockResolvedValue(eventRequest({ expectedAttendance: 130 }));
    const refresh = vi.fn();
    const { user } = renderPage(safetyApproved(), { onChangeRequestProcessed: refresh });
    const confirm = await screen.findByRole("button", { name: "Confirm Event" });
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(screen.getByRole("button", { name: "Revise event details" })).toBeInTheDocument();
    await user.click(confirm);
    await screen.findByText("Event confirmed successfully.");
    await user.click(screen.getByRole("button", { name: "Revise event details" }));
    fireEvent.change(screen.getByLabelText("Expected attendance"), { target: { value: "130" } });
    await user.type(screen.getByLabelText("Reason for this change"), "Attendance revised");
    await user.click(screen.getByRole("button", { name: "Preview significant change" }));
    await user.click(await screen.findByLabelText("I have reviewed this impact and confirm applying the significant change."));
    await user.click(screen.getByRole("button", { name: "Confirm significant change" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Planning"));
    expect(screen.queryByText("Event confirmed successfully.")).not.toBeInTheDocument();
    expect(confirmPanel()).not.toBeInTheDocument();
    expect(applySignificantEventChange).toHaveBeenCalledExactlyOnceWith(EVENT_ID, {
      changes: { expectedAttendance: 130 }, reason: "Attendance revised", expectedImpact: impact,
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it.each([
    [ASSIGNED, "event_coordinator_lead"], [OTHER, "event_coordinator"],
    [ASSIGNED, "event_organiser"], [ASSIGNED, "attendee"], [ASSIGNED, "venue_staff"],
    [ASSIGNED, "technical_support_staff"], [ASSIGNED, "safety_officer"], [null, null],
  ])("SCRUM363_AC1_user_%s_with_role_%s_has_no_confirmation_action", (id, role) => {
    signIn(id, role);
    renderPage(safetyApproved());
    expect(confirmPanel()).not.toBeInTheDocument();
    expect(getEventReadiness).not.toHaveBeenCalled();
    expect(confirmEventRequest).not.toHaveBeenCalled();
  });

  it("SCRUM363_AC1_an_unassigned_event_has_no_confirmation_action", () => {
    signIn(ASSIGNED, "event_coordinator");
    renderPage(safetyApproved({ assignedCoordinatorId: null }));
    expect(confirmPanel()).not.toBeInTheDocument();
    expect(getEventReadiness).not.toHaveBeenCalled();
  });

  it.each(["approved", ...NOT_APPROVED.filter((status) => status !== "safety_approved")])(
    "SCRUM363_AC1_status_%s_has_no_confirmation_action", (status) => {
      signIn(ASSIGNED, "event_coordinator");
      renderPage(safetyApproved({ status }));
      expect(confirmPanel()).not.toBeInTheDocument();
      expect(confirmEventRequest).not.toHaveBeenCalled();
    },
  );

  it("SCRUM363_AC6_success_updates_the_parent_status_and_announces_confirmation_once", async () => {
    signIn(ASSIGNED, "event_coordinator");
    vi.mocked(confirmEventRequest).mockResolvedValue(confirmedEvent());
    const refresh = vi.fn();
    const { user } = renderPage(safetyApproved(), { onChangeRequestProcessed: refresh });
    expect(screen.getByText("Safety approval complete")).toBeInTheDocument();
    const confirm = await screen.findByRole("button", { name: "Confirm Event" });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);

    expect(await screen.findByRole("status")).toHaveTextContent("Event confirmed successfully.");
    expect(screen.getAllByText("Event confirmed successfully.")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Confirmed");
    expect(confirmPanel()).not.toBeInTheDocument();
    expect(screen.queryByText("Safety approval complete")).not.toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("SCRUM363_AC4_a_fresh_safety_approval_replaces_the_local_safety_submission_state", async () => {
    signIn(ASSIGNED, 'event_coordinator');
    vi.mocked(submitForSafetyReview).mockResolvedValue(eventRequest({ status: 'safety_review' }));
    const { user, rerender } = renderPage(eventRequest());
    const submit = await screen.findByRole('button', { name: 'Submit for safety check' });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    rerender(<MemoryRouter><CoordinatorRequestDetail request={safetyApproved()} /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: 'Confirm Event' })).toBeInTheDocument();
  });

  it("SCRUM363_AC6_fresh_planning_data_replaces_local_confirmation_and_clears_stale_success_feedback", async () => {
    signIn(ASSIGNED, 'event_coordinator');
    vi.mocked(confirmEventRequest).mockResolvedValue(confirmedEvent());
    const { user, rerender } = renderPage(safetyApproved());
    const confirm = await screen.findByRole('button', { name: 'Confirm Event' });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);
    await screen.findByText('Event confirmed successfully.');
    rerender(<MemoryRouter><CoordinatorRequestDetail request={eventRequest()} /></MemoryRouter>);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Planning');
    expect(screen.queryByText('Event confirmed successfully.')).not.toBeInTheDocument();
    rerender(<MemoryRouter><CoordinatorRequestDetail request={safetyApproved()} /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: 'Confirm Event' })).toBeInTheDocument();
  });

  it.each([403, 409])("SCRUM363_AC3_refusal_%s_refreshes_parent_data_and_preserves_feedback_after_the_action_disappears", async (status) => {
    signIn(ASSIGNED, "event_coordinator");
    vi.mocked(confirmEventRequest).mockRejectedValue({ response: { status, data: { error: "Its current status is confirmed." } } });
    const refresh = vi.fn();
    const { user, rerender } = renderPage(safetyApproved(), { onChangeRequestProcessed: refresh });
    const confirm = await screen.findByRole("button", { name: "Confirm Event" });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    const fresh = status === 403 ? safetyApproved({ assignedCoordinatorId: OTHER }) : confirmedEvent();
    rerender(<MemoryRouter><CoordinatorRequestDetail request={fresh} onChangeRequestProcessed={refresh} /></MemoryRouter>);
    expect(confirmPanel()).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(status === 403 ? "assigned Event Coordinator" : "current status is confirmed");
    expect(screen.queryByText("Event confirmed successfully.")).not.toBeInTheDocument();
  });

  it("SCRUM363_AC3_a_stale_refusal_stays_visible_after_the_refetch_loads_a_newer_revision", async () => {
    signIn(ASSIGNED, "event_coordinator");
    const stale = "This event has changed. Refresh its checklist before confirming.";
    vi.mocked(confirmEventRequest).mockRejectedValue({ response: { status: 409, data: { error: stale } } });
    const refresh = vi.fn();
    const { user, rerender } = renderPage(safetyApproved({ updatedAt: "2026-10-01T00:00:00Z" }), { onChangeRequestProcessed: refresh });
    const confirm = await screen.findByRole("button", { name: "Confirm Event" });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    // Still Safety approved, so the panel stays and reloads for the new revision.
    rerender(<MemoryRouter><CoordinatorRequestDetail request={safetyApproved({ updatedAt: "2026-10-02T00:00:00Z" })} onChangeRequestProcessed={refresh} /></MemoryRouter>);
    expect(confirmPanel()).toBeInTheDocument();
    expect(screen.getAllByRole("alert").filter((el) => el.textContent === stale)).toHaveLength(1);
  });

  it("SCRUM363_AC6_my_events_open_confirmation_and_back_navigation_show_the_server_updated_status", async () => {
    signIn(ASSIGNED, "event_coordinator");
    vi.mocked(getMyAssignedEvents).mockResolvedValueOnce([safetyApproved()]).mockResolvedValue([confirmedEvent()]);
    vi.mocked(confirmEventRequest).mockResolvedValue(confirmedEvent());
    render(<MemoryRouter><MyAssignedEvents /></MemoryRouter>);
    await userEvent.click(await screen.findByRole("button", { name: "Open" }));
    const confirm = await screen.findByRole("button", { name: "Confirm Event" });
    await waitFor(() => expect(confirm).toBeEnabled());
    await userEvent.click(confirm);
    expect(await screen.findByText("Event confirmed successfully.")).toBeInTheDocument();
    await waitFor(() => expect(getMyAssignedEvents).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole("button", { name: /Back to my events/ }));
    expect(screen.getByRole("heading", { name: /Confirmed/ })).toBeInTheDocument();
    expect(screen.getByText("IS212 Industry Night")).toBeInTheDocument();
    expect(confirmEventRequest).toHaveBeenCalledTimes(1);
  });

  it("SCRUM363_AC4_returning_to_my_events_refreshes_the_open_detail_and_reveals_fresh_safety_approval", async () => {
    signIn(ASSIGNED, "event_coordinator");
    vi.mocked(getMyAssignedEvents).mockResolvedValueOnce([eventRequest({ status: "safety_review" })])
      .mockResolvedValue([safetyApproved()]);
    render(<MemoryRouter><MyAssignedEvents /></MemoryRouter>);
    await userEvent.click(await screen.findByRole("button", { name: "Open" }));
    expect(confirmPanel()).not.toBeInTheDocument();
    fireEvent.focus(window);
    const confirm = await screen.findByRole("button", { name: "Confirm Event" });
    await waitFor(() => expect(confirm).toBeEnabled());
  });
});


describe("SCRUM489_AC1 who is offered the submission", () => {
  it("SCRUM489_AC1_the_assigned_coordinator_of_an_approved_event_is_offered_it", async () => {
    signIn(ASSIGNED, "event_coordinator");
    renderPage(eventRequest());

    expect(panel()).toBeInTheDocument();
    await waitFor(() => expect(getEventReadiness).toHaveBeenCalledWith(EVENT_ID, { noEquipmentConfirmed: false }));
  });

  it.each([
    ["a_Lead", LEAD, "event_coordinator_lead"],
    ["a_coordinator_who_does_not_hold_the_event", OTHER, "event_coordinator"],
  ])("SCRUM489_AC1_%s_is_not_offered_it", (_label, id, role) => {
    signIn(id, role);
    renderPage(eventRequest());

    expect(panel()).not.toBeInTheDocument();
    expect(getEventReadiness).not.toHaveBeenCalled();
  });

  it.each(NOT_APPROVED)("SCRUM489_AC1_an_event_that_is_%s_offers_no_submission", (status) => {
    signIn(ASSIGNED, "event_coordinator");
    renderPage(eventRequest({ status }));

    expect(panel()).not.toBeInTheDocument();
    if (status !== "safety_approved") expect(getEventReadiness).not.toHaveBeenCalled();
  });
});


describe("SCRUM489_AC6 the page after a submission", () => {
  it("SCRUM489_AC6_the_page_shows_safety_check_at_once_with_no_submission_panel", async () => {
    // The label the coordinator reads is statusDisplay's, the shared "Safety check".
    signIn(ASSIGNED, "event_coordinator");
    const onChangeRequestProcessed = vi.fn();
    vi.mocked(submitForSafetyReview).mockResolvedValue(eventRequest({
      status: "safety_review",
      statusDisplay: { status: "safety_review", label: "Safety check", group: "UNDER_REVIEW", description: "A Safety Officer is checking." },
    }));
    const { user } = renderPage(eventRequest(), { onChangeRequestProcessed });
    const submit = await screen.findByRole("button", { name: "Submit for safety check" });
    await waitFor(() => expect(submit).toBeEnabled());

    await user.click(submit);

    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Safety check");
    expect(screen.queryByText("Planning")).not.toBeInTheDocument();
    expect(onChangeRequestProcessed).toHaveBeenCalledTimes(1);
  });

  it("SCRUM489_AC6_a_status_that_moved_under_the_coordinator_refreshes_the_page", async () => {
    signIn(ASSIGNED, "event_coordinator");
    const onChangeRequestProcessed = vi.fn();
    vi.mocked(submitForSafetyReview).mockRejectedValue(
      Object.assign(new Error("HTTP 409"), { response: { status: 409, data: {} } }),
    );
    const { user } = renderPage(eventRequest(), { onChangeRequestProcessed });
    const submit = await screen.findByRole("button", { name: "Submit for safety check" });
    await waitFor(() => expect(submit).toBeEnabled());

    await user.click(submit);

    await waitFor(() => expect(onChangeRequestProcessed).toHaveBeenCalledTimes(1));
  });
});
