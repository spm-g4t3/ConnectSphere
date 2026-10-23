// scrum355ReviseAndResubmit.test.jsx
//
// SCRUM-355: the Organiser reopens a rejected request and revises it with the
// rejection beside the form; the coordinator sees a resubmission's past decisions.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import MyEventRequests from "../../src/components/MyEventRequests.jsx";
import DecisionHistory from "../../src/components/DecisionHistory.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import {
  getAssignmentHistory,
  getEventDecisionHistory,
  getMyEventRequests,
  reopenEventRequest,
  updateEventRequest,
} from "../../src/services/eventRequestService";

vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: vi.fn(),
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
  cancelEventRequest: vi.fn(),
  reopenEventRequest: vi.fn(),
  respondToEventClarification: vi.fn(),
  submitEventRequest: vi.fn(),
  updateEventRequest: vi.fn(),
}));

const ORGANISER = "11111111-1111-4111-8111-111111111111";
const COORDINATOR = "44444444-4444-4444-8444-444444444444";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

function eventRequest(overrides = {}) {
  return {
    id: REQUEST_ID,
    organiserId: ORGANISER,
    eventName: "IS212 Industry Night",
    purpose: "Connect students with industry.",
    status: "rejected",
    assignedCoordinatorId: COORDINATOR,
    decision: "rejected",
    decisionNote: "The venue is too small.",
    decidedBy: COORDINATOR,
    decidedAt: "2026-10-15T03:00:00Z",
    statusDisplay: { label: "Rejected", group: "REJECTED", description: "This request was not accepted." },
    ...overrides,
  };
}

const pastRejection = (overrides = {}) => ({
  id: "d1",
  decision: "rejected",
  decisionNote: "The venue is too small.",
  decidedByName: "Priya Nair",
  decidedAt: "2026-10-15T03:00:00Z",
  supersededReason: "reopened_for_revision",
  supersededAt: "2026-10-20T03:00:00Z",
  ...overrides,
});

function renderList(requests) {
  vi.mocked(getMyEventRequests).mockResolvedValue(requests);
  return render(
    <MemoryRouter>
      <MyEventRequests />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(useAuth).mockReturnValue({ user: { id: ORGANISER, role: "event_organiser" } });
  vi.mocked(getAssignmentHistory).mockResolvedValue([]);
  vi.mocked(getEventDecisionHistory).mockResolvedValue([]);
});


describe("SCRUM355 revise and resubmit on the organiser's list", () => {
  it.each(["draft", "submitted", "under_review", "approved", "cancelled"])(
    "SCRUM355_AC1_a_%s_request_offers_no_revise_button", async (status) => {
      renderList([eventRequest({ status, decision: null })]);

      await screen.findByText("IS212 Industry Night");

      expect(screen.queryByRole("button", { name: "Revise and resubmit" })).not.toBeInTheDocument();
    },
  );

  it("SCRUM355_AC2_AC3_reopening_opens_the_draft_with_the_rejection_beside_the_form", async () => {
    const reopened = eventRequest({ status: "draft", decision: null, decisionNote: null });
    vi.mocked(reopenEventRequest).mockResolvedValue(reopened);
    vi.mocked(getEventDecisionHistory).mockResolvedValue([pastRejection()]);
    renderList([eventRequest()]);

    await userEvent.click(await screen.findByRole("button", { name: "Revise and resubmit" }));

    expect(reopenEventRequest).toHaveBeenCalledWith(REQUEST_ID);
    expect(await screen.findByText("Why it was rejected")).toBeInTheDocument();
    const history = screen.getByRole("region", { name: "Previous decisions" });
    expect(within(history).getAllByText("The venue is too small.")).toHaveLength(2);
    expect(within(history).getByText(/by Priya Nair/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("IS212 Industry Night")).toBeInTheDocument();
    expect(getMyEventRequests).toHaveBeenCalledTimes(2);
  });

  it("SCRUM355_AC3_saving_partway_through_keeps_the_rejection_beside_the_form", async () => {
    const reopened = eventRequest({ status: "draft", decision: null, decisionNote: null });
    vi.mocked(reopenEventRequest).mockResolvedValue(reopened);
    vi.mocked(updateEventRequest).mockResolvedValue(reopened);
    vi.mocked(getEventDecisionHistory).mockResolvedValue([pastRejection()]);
    renderList([eventRequest()]);

    await userEvent.click(await screen.findByRole("button", { name: "Revise and resubmit" }));
    await screen.findByText("Why it was rejected");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));

    expect(await screen.findByText("Draft saved. You can submit it when you're ready.")).toBeInTheDocument();
    expect(screen.getByText("Why it was rejected")).toBeInTheDocument();
    expect(screen.getByDisplayValue("IS212 Industry Night")).toBeInTheDocument();
  });

  it("SCRUM355_AC1_a_refusal_shows_the_servers_message_on_the_row", async () => {
    const message = "This request is Under review, and only a Rejected request can be reopened for revision";
    vi.mocked(reopenEventRequest).mockRejectedValue({ response: { status: 409, data: { error: message } } });
    renderList([eventRequest()]);

    await userEvent.click(await screen.findByRole("button", { name: "Revise and resubmit" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText("Why it was rejected")).not.toBeInTheDocument();
  });

  it("SCRUM355_AC1_a_refusal_with_no_message_says_it_could_not_reopen", async () => {
    vi.mocked(reopenEventRequest).mockRejectedValue(new Error("Network Error"));
    renderList([eventRequest()]);

    await userEvent.click(await screen.findByRole("button", { name: "Revise and resubmit" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reopen this request for revision.");
  });

  it("SCRUM355_AC1_the_button_is_disabled_while_reopening", async () => {
    vi.mocked(reopenEventRequest).mockReturnValue(new Promise(() => {}));
    renderList([eventRequest()]);

    await userEvent.click(await screen.findByRole("button", { name: "Revise and resubmit" }));

    expect(screen.getByRole("button", { name: "Reopening..." })).toBeDisabled();
  });
});


describe("SCRUM355 DecisionHistory", () => {
  it("SCRUM355_AC5_the_coordinator_is_told_it_is_a_resubmission_with_every_past_decision", async () => {
    vi.mocked(getEventDecisionHistory).mockResolvedValue([
      pastRejection(),
      pastRejection({ id: "d2", decisionNote: "Still too few marshals.", decidedByName: null }),
    ]);

    render(<DecisionHistory eventRequestId={REQUEST_ID} view="coordinator" />);

    expect(await screen.findByRole("status")).toHaveTextContent("This request is a resubmission. It has been decided 2 times before.");
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[1]).toHaveTextContent("Still too few marshals.");
    expect(items[1]).toHaveTextContent("a coordinator with no name on record");
    expect(screen.queryByText("Why it was rejected")).not.toBeInTheDocument();
  });

  it("SCRUM355_AC5_one_past_decision_says_once", async () => {
    vi.mocked(getEventDecisionHistory).mockResolvedValue([pastRejection()]);

    render(<DecisionHistory eventRequestId={REQUEST_ID} view="coordinator" />);

    expect(await screen.findByRole("status")).toHaveTextContent("decided once before");
  });

  it("SCRUM355_AC5_a_request_never_decided_before_shows_nothing", async () => {
    const { container } = render(<DecisionHistory eventRequestId={REQUEST_ID} view="coordinator" />);

    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(getEventDecisionHistory).toHaveBeenCalledWith(REQUEST_ID);
    expect(container).toBeEmptyDOMElement();
  });

  it("SCRUM355_AC3_entries_with_no_note_or_date_still_read_sensibly", async () => {
    vi.mocked(getEventDecisionHistory).mockResolvedValue([
      pastRejection({ decision: "approved", decisionNote: null, decidedAt: null }),
    ]);

    render(<DecisionHistory eventRequestId={REQUEST_ID} />);

    expect(await screen.findByText("No reason was recorded.")).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveTextContent("Approved on an unrecorded date by Priya Nair");
    expect(screen.getByRole("listitem")).toHaveTextContent("No note was left.");
  });

  it("SCRUM355_AC5_switching_requests_never_shows_the_previous_requests_decisions", async () => {
    const OTHER_ID = "33333333-3333-4333-8333-333333333333";
    let resolveOther;
    vi.mocked(getEventDecisionHistory).mockImplementation((id) => (id === REQUEST_ID
      ? Promise.resolve([pastRejection()])
      : new Promise((resolve) => { resolveOther = resolve; })));
    const { rerender } = render(<DecisionHistory eventRequestId={REQUEST_ID} view="coordinator" />);
    expect(await screen.findByText("The venue is too small.")).toBeInTheDocument();

    rerender(<DecisionHistory eventRequestId={OTHER_ID} view="coordinator" />);
    expect(screen.queryByText("The venue is too small.")).not.toBeInTheDocument();

    await act(async () => resolveOther([pastRejection({ id: "d9", decisionNote: "Other reason." })]));
    expect(screen.getByText("Other reason.")).toBeInTheDocument();
  });

  it("SCRUM355_AC5_an_error_from_the_previous_request_does_not_stay", async () => {
    const OTHER_ID = "33333333-3333-4333-8333-333333333333";
    vi.mocked(getEventDecisionHistory).mockImplementation((id) => (id === REQUEST_ID
      ? Promise.reject(new Error("boom"))
      : Promise.resolve([pastRejection()])));
    const { rerender } = render(<DecisionHistory eventRequestId={REQUEST_ID} view="coordinator" />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    rerender(<DecisionHistory eventRequestId={OTHER_ID} view="coordinator" />);

    expect(await screen.findByText("The venue is too small.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM355_AC3_a_failed_read_says_so", async () => {
    vi.mocked(getEventDecisionHistory).mockRejectedValue(new Error("boom"));

    render(<DecisionHistory eventRequestId={REQUEST_ID} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Previous decisions could not be loaded.");
  });

  it("SCRUM355_AC3_a_decision_value_with_no_label_is_shown_as_sent", async () => {
    vi.mocked(getEventDecisionHistory).mockResolvedValue([pastRejection({ decision: "withdrawn" })]);

    render(<DecisionHistory eventRequestId={REQUEST_ID} />);

    expect(await screen.findByRole("listitem")).toHaveTextContent("withdrawn on");
  });

  it.each([
    ["resolves", (settle) => settle.resolve([pastRejection()])],
    ["fails", (settle) => settle.reject(new Error("boom"))],
  ])("SCRUM355_AC3_a_read_that_%s_after_unmount_does_not_update", async (_label, finish) => {
    const settle = {};
    vi.mocked(getEventDecisionHistory).mockReturnValue(new Promise((resolve, reject) => {
      Object.assign(settle, { resolve, reject });
    }));
    const { unmount } = render(<DecisionHistory eventRequestId={REQUEST_ID} />);

    unmount();
    finish(settle);

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("Previous decisions")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
