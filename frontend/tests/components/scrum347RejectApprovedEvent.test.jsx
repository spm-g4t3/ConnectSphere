// scrum347RejectApprovedEvent.test.jsx
//
// SCRUM-347: the coordinator sees what is outstanding and rejects an Approved
// event with a reason; the Organiser sees the rejection and the approval before it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import EventRejectionPanel from "../../src/components/EventRejectionPanel.jsx";
import DecisionHistory from "../../src/components/DecisionHistory.jsx";
import MyEventRequests from "../../src/components/MyEventRequests.jsx";
import ChangeRequestStatusList from "../../src/components/ChangeRequestStatusList.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import { getChangeRequests } from "../../src/services/changeRequestService";
import {
  getAssignmentHistory,
  getEventDecisionHistory,
  getEventReadiness,
  getMyEventRequests,
  rejectApprovedEvent,
} from "../../src/services/eventRequestService";

vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../../src/services/changeRequestService", () => ({
  getChangeRequests: vi.fn(),
  submitChangeRequest: vi.fn(),
}));

vi.mock("../../src/services/eventRequestService", () => ({
  createEventRequest: vi.fn(),
  getAssignmentHistory: vi.fn(),
  getAssignmentHistoryForReview: vi.fn(),
  getMyEventRequests: vi.fn(),
  getConfirmedArrangements: vi.fn(),
  getEventClarificationHistory: vi.fn(),
  getEventDecisionHistory: vi.fn(),
  getEventCancellationImpact: vi.fn(),
  getEventReadiness: vi.fn(),
  cancelEventRequest: vi.fn(),
  rejectApprovedEvent: vi.fn(),
  reopenEventRequest: vi.fn(),
  respondToEventClarification: vi.fn(),
  submitEventRequest: vi.fn(),
  updateEventRequest: vi.fn(),
}));

const ORGANISER = "11111111-1111-4111-8111-111111111111";
const COORDINATOR = "44444444-4444-4444-8444-444444444444";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

const approvedEvent = (overrides = {}) => ({
  id: REQUEST_ID,
  organiserId: ORGANISER,
  eventName: "IS212 Industry Night",
  status: "approved",
  assignedCoordinatorId: COORDINATOR,
  decision: "approved",
  decisionNote: null,
  decidedBy: COORDINATOR,
  decidedAt: "2026-10-15T03:00:00Z",
  ...overrides,
});

const rejectedEvent = (overrides = {}) => approvedEvent({
  status: "rejected",
  decision: "rejected",
  decisionNote: "The only suitable hall is closed.",
  decidedAt: "2026-10-25T03:00:00Z",
  statusDisplay: { label: "Rejected", group: "REJECTED", description: "This request was not accepted." },
  ...overrides,
});

const READINESS = {
  eventRequestId: REQUEST_ID,
  ready: false,
  items: [
    { key: "venue", met: false, detail: "Awaiting approval", bookingId: "b1", venueName: "Hall A" },
    { key: "equipment", met: false, detail: "Under review", equipmentRequestId: "e1" },
    { key: "date", met: true, detail: "Starts in the future" },
  ],
};

const approvalEntry = {
  id: "d1",
  decision: "approved",
  decisionNote: "Enough to plan.",
  decidedByName: "Priya Nair",
  decidedAt: "2026-10-15T03:00:00Z",
  supersededReason: "rejected_after_approval",
  supersededAt: "2026-10-25T03:00:00Z",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(useAuth).mockReturnValue({ user: { id: COORDINATOR, role: "event_coordinator" } });
  vi.mocked(getEventReadiness).mockResolvedValue(READINESS);
  vi.mocked(getEventDecisionHistory).mockResolvedValue([]);
  vi.mocked(getAssignmentHistory).mockResolvedValue([]);
});

describe("SCRUM347 EventRejectionPanel", () => {
  it("SCRUM347_AC2_shows_only_the_outstanding_arrangements_from_the_readiness_check", async () => {
    render(<EventRejectionPanel eventRequest={approvedEvent()} />);

    const table = await screen.findByRole("table", { name: "Still outstanding" });
    expect(getEventReadiness).toHaveBeenCalledWith(REQUEST_ID);
    expect(within(table).getByText("Venue: Hall A")).toBeInTheDocument();
    expect(within(table).getByText("Under review")).toBeInTheDocument();
    expect(within(table).queryByText("Starts in the future")).not.toBeInTheDocument();
  });

  it("SCRUM347_AC2_says_so_when_nothing_is_outstanding", async () => {
    vi.mocked(getEventReadiness).mockResolvedValue({ ...READINESS, ready: true, items: [READINESS.items[2]] });

    render(<EventRejectionPanel eventRequest={approvedEvent()} />);

    expect(await screen.findByText("Every essential arrangement is currently met.")).toBeInTheDocument();
  });

  it("SCRUM347_AC2_a_failed_readiness_read_is_reported", async () => {
    vi.mocked(getEventReadiness).mockRejectedValue({ response: { status: 500 } });

    render(<EventRejectionPanel eventRequest={approvedEvent()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("The outstanding arrangements could not be loaded.");
  });

  it("SCRUM347_AC1_the_reject_button_waits_for_a_non_blank_reason", async () => {
    const user = userEvent.setup();
    render(<EventRejectionPanel eventRequest={approvedEvent()} />);
    const button = screen.getByRole("button", { name: "Reject event" });

    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText("Reason for rejection"), "   ");
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText("Reason for rejection"), "No hall");
    expect(button).toBeEnabled();
  });

  it("SCRUM347_AC3_rejects_with_the_trimmed_reason_and_hands_back_the_event", async () => {
    const user = userEvent.setup();
    const onRejected = vi.fn();
    const rejected = rejectedEvent();
    vi.mocked(rejectApprovedEvent).mockResolvedValue(rejected);
    render(<EventRejectionPanel eventRequest={approvedEvent()} onRejected={onRejected} />);

    await user.type(screen.getByLabelText("Reason for rejection"), "  The only suitable hall is closed.  ");
    await user.click(screen.getByRole("button", { name: "Reject event" }));

    expect(rejectApprovedEvent).toHaveBeenCalledWith(REQUEST_ID, { reason: "The only suitable hall is closed." });
    expect(onRejected).toHaveBeenCalledWith(rejected);
  });

  it("SCRUM347_AC3_a_rejected_event_shows_the_reason_and_what_was_released", () => {
    render(<EventRejectionPanel eventRequest={rejectedEvent()} />);

    expect(screen.getByRole("heading", { name: "Event rejected" })).toBeInTheDocument();
    expect(screen.getByText("The only suitable hall is closed.")).toBeInTheDocument();
    expect(screen.getByText(/bookings, holds and equipment have been released/)).toBeInTheDocument();
    expect(getEventReadiness).not.toHaveBeenCalled();
  });

  it("SCRUM347_AC1_a_wrong_status_refusal_shows_the_servers_sentence", async () => {
    const user = userEvent.setup();
    const message = "This event is in Safety review, and only an Approved event can be rejected.";
    vi.mocked(rejectApprovedEvent).mockRejectedValue({ response: { status: 409, data: { error: message, code: null } } });
    render(<EventRejectionPanel eventRequest={approvedEvent()} onCancelInstead={vi.fn()} />);

    await user.type(screen.getByLabelText("Reason for rejection"), "No hall");
    await user.click(screen.getByRole("button", { name: "Reject event" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByRole("button", { name: "Cancel event instead" })).not.toBeInTheDocument();
  });

  it("SCRUM347_AC1_a_confirmed_event_offers_cancellation_instead", async () => {
    const user = userEvent.setup();
    const onCancelInstead = vi.fn();
    const message = "This event is Confirmed, and only an Approved event can be rejected. Cancel it instead.";
    vi.mocked(rejectApprovedEvent).mockRejectedValue({
      response: { status: 409, data: { error: message, code: "CANCEL_INSTEAD" } },
    });
    render(<EventRejectionPanel eventRequest={approvedEvent()} onCancelInstead={onCancelInstead} />);

    await user.type(screen.getByLabelText("Reason for rejection"), "No hall");
    await user.click(screen.getByRole("button", { name: "Reject event" }));
    await user.click(await screen.findByRole("button", { name: "Cancel event instead" }));

    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(onCancelInstead).toHaveBeenCalled();
  });

  it.each([
    [403, "Only the coordinator assigned to this event can reject it."],
    [500, "The event could not be rejected. No changes have been made; try again."],
  ])("SCRUM347_AC1_a_%s_refusal_says_what_happened", async (status, message) => {
    const user = userEvent.setup();
    vi.mocked(rejectApprovedEvent).mockRejectedValue({ response: { status } });
    render(<EventRejectionPanel eventRequest={approvedEvent()} />);

    await user.type(screen.getByLabelText("Reason for rejection"), "No hall");
    await user.click(screen.getByRole("button", { name: "Reject event" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("SCRUM347_AC2_a_forbidden_readiness_read_says_who_may_reject", async () => {
    vi.mocked(getEventReadiness).mockRejectedValue({ response: { status: 403 } });

    render(<EventRejectionPanel eventRequest={approvedEvent()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Only the coordinator assigned to this event can reject it.");
  });

  it.each([
    ["resolves", (deferred) => deferred.resolve(READINESS)],
    ["fails", (deferred) => deferred.reject(new Error("gone"))],
  ])("SCRUM347_AC2_a_readiness_read_that_%s_after_leaving_the_page_changes_nothing", async (_how, settle) => {
    const deferred = {};
    vi.mocked(getEventReadiness).mockReturnValue(new Promise((resolve, reject) => Object.assign(deferred, { resolve, reject })));
    const { unmount } = render(<EventRejectionPanel eventRequest={approvedEvent()} />);

    unmount();
    await act(async () => settle(deferred));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM347_AC1_back_returns_to_the_event", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(<EventRejectionPanel eventRequest={approvedEvent()} onBack={onBack} />);

    await user.click(screen.getByRole("button", { name: "Back to event" }));

    expect(onBack).toHaveBeenCalled();
  });

  it("SCRUM347_AC3_a_rejection_with_no_reason_or_date_on_record_still_reads_sensibly", () => {
    render(<EventRejectionPanel eventRequest={rejectedEvent({ decisionNote: null, decidedAt: null })} />);

    expect(screen.getByText("No reason recorded.")).toBeInTheDocument();
    expect(screen.getByText("Not recorded")).toBeInTheDocument();
  });

  it("SCRUM347_AC1_submitting_a_blank_form_sends_nothing", () => {
    const { container } = render(<EventRejectionPanel eventRequest={approvedEvent()} />);

    fireEvent.submit(container.querySelector("form"));

    expect(rejectApprovedEvent).not.toHaveBeenCalled();
  });

  it("SCRUM347_AC1_a_second_submit_while_rejecting_sends_nothing_more", async () => {
    const user = userEvent.setup();
    vi.mocked(rejectApprovedEvent).mockReturnValue(new Promise(() => {}));
    const { container } = render(<EventRejectionPanel eventRequest={approvedEvent()} />);
    await user.type(screen.getByLabelText("Reason for rejection"), "No hall");

    await user.click(screen.getByRole("button", { name: "Reject event" }));
    fireEvent.submit(container.querySelector("form"));

    expect(screen.getByRole("button", { name: "Rejecting..." })).toBeDisabled();
    expect(rejectApprovedEvent).toHaveBeenCalledTimes(1);
  });

  it("SCRUM347_AC1_an_event_in_another_status_renders_nothing", () => {
    const { container } = render(<EventRejectionPanel eventRequest={approvedEvent({ status: "confirmed" })} />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe("SCRUM347 DecisionHistory after a rejection", () => {
  it("SCRUM347_AC5_an_approval_replaced_by_a_rejection_is_not_called_a_resubmission", async () => {
    vi.mocked(getEventDecisionHistory).mockResolvedValue([approvalEntry]);

    render(<DecisionHistory eventRequestId={REQUEST_ID} view="coordinator" />);

    expect(await screen.findByRole("listitem")).toHaveTextContent("Approved");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("SCRUM347_AC5_the_organiser_is_not_shown_the_approval_note_as_the_rejection_reason", async () => {
    vi.mocked(getEventDecisionHistory).mockResolvedValue([approvalEntry]);

    render(<DecisionHistory eventRequestId={REQUEST_ID} view="organiser" />);

    expect(await screen.findByRole("listitem")).toHaveTextContent("Enough to plan.");
    expect(screen.queryByText("Why it was rejected")).not.toBeInTheDocument();
  });

  it("SCRUM347_AC6_after_a_reopen_the_reason_is_the_rejections_not_the_newest_entrys", async () => {
    vi.mocked(getEventDecisionHistory).mockResolvedValue([
      approvalEntry,
      { ...approvalEntry, id: "d2", decision: "rejected", decisionNote: "No hall.", supersededReason: "reopened_for_revision" },
    ]);

    render(<DecisionHistory eventRequestId={REQUEST_ID} view="organiser" />);

    const reason = await screen.findByText("Why it was rejected");
    expect(reason.parentElement).toHaveTextContent("No hall.");
  });
});

describe("SCRUM347 change requests closed with the event", () => {
  it.each([
    // SCRUM-402 AC10 words the list's outcomes; changeRequestDisplay holds them.
    ["event_rejected", "Outcome: Closed: the event was rejected"],
    ["event_cancelled", "Outcome: Closed: the event was cancelled"],
    // SCRUM-379 AC4: the same list for a change request closed when the event was completed.
    ["event_completed", "Outcome: Closed: the event was completed"],
  ])("SCRUM402_AC10_a_change_request_closed_by_%s_says_why", async (decision, label) => {
    vi.mocked(getChangeRequests).mockResolvedValue([{
      id: "c1", fieldLabel: "Venue", details: "A larger room", status: "processed", decision, decisionNotes: null,
      createdAt: "2026-10-20T03:00:00Z",
    }]);

    render(<ChangeRequestStatusList eventRequestId={REQUEST_ID} />);

    expect(await screen.findByText(label)).toBeInTheDocument();
  });
});

describe("SCRUM379 AC4 change request outcome styling", () => {
  it.each([
    ["event_completed", "change-request-outcome--closed"],
    ["approved", "change-request-outcome--approved"],
    ["rejected", "change-request-outcome--rejected"],
    ["event_cancelled", "change-request-outcome--rejected"],
  ])("SCRUM379_AC4_%s_is_styled_%s", async (decision, cls) => {
    vi.mocked(getChangeRequests).mockResolvedValue([{
      id: "c1", fieldLabel: "Venue", details: "A larger room", status: "processed", decision, decisionNotes: null,
      createdAt: "2026-10-20T03:00:00Z",
    }]);

    render(<ChangeRequestStatusList eventRequestId={REQUEST_ID} />);

    const outcome = await screen.findByText(/^Outcome:/);
    expect(outcome).toHaveClass(cls);
  });

  it("SCRUM402_AC10_a_completed_events_change_request_is_never_called_rejected_or_declined", async () => {
    vi.mocked(getChangeRequests).mockResolvedValue([{
      id: "c1", fieldLabel: "Venue", details: "A larger room", status: "processed", decision: "event_completed", decisionNotes: null,
      createdAt: "2026-10-20T03:00:00Z",
    }]);

    render(<ChangeRequestStatusList eventRequestId={REQUEST_ID} />);

    // SCRUM-402 AC10's words: a coordinator's rejection reads "Declined", so neither may appear.
    await screen.findByText("Outcome: Closed: the event was completed");
    expect(screen.queryByText(/Rejected|Declined/)).not.toBeInTheDocument();
  });
});

describe("SCRUM347 the Organiser's rejected event", () => {
  it("SCRUM347_AC5_shows_the_outcome_reason_coordinator_and_the_approval_before_it", async () => {
    vi.mocked(useAuth).mockReturnValue({ user: { id: ORGANISER, role: "event_organiser" } });
    vi.mocked(getAssignmentHistory).mockResolvedValue([{ newCoordinatorId: COORDINATOR, newCoordinatorName: "Priya Nair" }]);
    vi.mocked(getEventDecisionHistory).mockResolvedValue([approvalEntry]);
    vi.mocked(getMyEventRequests).mockResolvedValue([rejectedEvent()]);

    render(<MemoryRouter><MyEventRequests /></MemoryRouter>);

    const decision = (await screen.findByText("Decision")).parentElement;
    expect(within(decision).getByText("Rejected")).toBeInTheDocument();
    expect(within(decision).getByText("The only suitable hall is closed.")).toBeInTheDocument();
    expect(await within(decision).findAllByText(/Priya Nair/)).toHaveLength(2);
    const history = await within(decision).findByRole("region", { name: "Previous decisions" });
    expect(within(history).getByRole("listitem")).toHaveTextContent("Approved");
    expect(getEventDecisionHistory).toHaveBeenCalledWith(REQUEST_ID);
  });

  it("SCRUM347_AC5_a_second_rejection_never_shows_the_first_reason_as_the_current_one", async () => {
    vi.mocked(useAuth).mockReturnValue({ user: { id: ORGANISER, role: "event_organiser" } });
    vi.mocked(getEventDecisionHistory).mockResolvedValue([
      { ...approvalEntry, id: "d0", decision: "rejected", decisionNote: "The first reason.", supersededReason: "reopened_for_revision" },
    ]);
    vi.mocked(getMyEventRequests).mockResolvedValue([rejectedEvent({ decisionNote: "The second reason." })]);

    render(<MemoryRouter><MyEventRequests /></MemoryRouter>);

    const history = await screen.findByRole("region", { name: "Previous decisions" });
    expect(within(history).getByRole("listitem")).toHaveTextContent("The first reason.");
    expect(screen.queryByText("Why it was rejected")).not.toBeInTheDocument();
    expect(screen.getByText("The second reason.")).toBeInTheDocument();
  });

  it("SCRUM347_AC6_a_rejected_event_offers_revise_and_resubmit_not_a_change_request", async () => {
    vi.mocked(useAuth).mockReturnValue({ user: { id: ORGANISER, role: "event_organiser" } });
    vi.mocked(getMyEventRequests).mockResolvedValue([rejectedEvent()]);

    render(<MemoryRouter><MyEventRequests /></MemoryRouter>);

    expect(await screen.findByRole("button", { name: "Revise and resubmit" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request a change" })).not.toBeInTheDocument();
  });

  it("SCRUM347_AC5_an_approved_event_reads_no_decision_history", async () => {
    vi.mocked(useAuth).mockReturnValue({ user: { id: ORGANISER, role: "event_organiser" } });
    vi.mocked(getMyEventRequests).mockResolvedValue([approvedEvent()]);

    render(<MemoryRouter><MyEventRequests /></MemoryRouter>);

    await screen.findByText("Decision");
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(getEventDecisionHistory).not.toHaveBeenCalled();
  });
});
