// CoordinatorRequestDetail.test.jsx
//
// SCRUM-129, for SCRUM-19 (Approve or Reject a Submitted Event Request): the
// coordinator's decision section. Which action each status offers, to whom,
// what is sent, and what a refusal says.
//
// The event request service and the signed-in user are mocked, so nothing
// touches the network. Every function the panel's component tree can reach
// is on the mock: a vi.mock factory is strict, and AssignmentHistory and
// DecisionOutcome read their two history functions when their modules load.
// ClarificationHistory (SCRUM-162) reads the clarification history when it
// mounts, on every status, and the panel's Close clarification action calls
// closeEventClarification, so both are on the mock too.
//
// What these tests do not prove: that the server refuses the wrong person or
// the wrong status. The screen's checks are a convenience; the backend tests
// and the live checks against migration 029 prove the gate.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import CoordinatorRequestDetail from "../../src/components/CoordinatorRequestDetail.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import {
  decideEventRequest,
  getAssignmentHistoryForReview,
  getCoordinatorChangeRequests,
  getEventClarificationHistory,
  requestEventClarification,
  startEventReview,
} from "../../src/services/eventRequestService";

vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../../src/services/eventRequestService", () => ({
  closeEventClarification: vi.fn(),
  decideEventRequest: vi.fn(),
  getAssignmentHistory: vi.fn(),
  getAssignmentHistoryForReview: vi.fn(),
  getCoordinatorChangeRequests: vi.fn(),
  getEventClarificationHistory: vi.fn(),
  listCoordinators: vi.fn(),
  processCoordinatorChangeRequest: vi.fn(),
  reassignEventRequest: vi.fn(),
  requestEventClarification: vi.fn(),
  startEventReview: vi.fn(),
}));

const ASSIGNED = "44444444-4444-4444-8444-444444444444";
const OTHER = "66666666-6666-4666-8666-666666666666";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

const DAY = 24 * 60 * 60 * 1000;
const future = () => new Date(Date.now() + 30 * DAY).toISOString();
const past = () => new Date(Date.now() - DAY).toISOString();

/** An event request as the API returns it, assigned to ASSIGNED. */
function eventRequest(overrides = {}) {
  return {
    id: REQUEST_ID,
    organiserId: "11111111-1111-4111-8111-111111111111",
    eventName: "IS212 Industry Night",
    purpose: "Connect students with industry.",
    description: null,
    proposedStart: future(),
    proposedEnd: future(),
    expectedAttendance: 120,
    venueRequirements: null,
    accessibilityRequirements: null,
    equipmentRequirements: null,
    status: "submitted",
    clarificationNote: null,
    assignedCoordinatorId: ASSIGNED,
    reviewingCoordinatorId: null,
    decision: null,
    decisionNote: null,
    decidedBy: null,
    decidedAt: null,
    statusDisplay: { status: "submitted", label: "Submitted", group: "AWAITING_REVIEW", description: "" },
    ...overrides,
  };
}

function httpError(status) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status },
  });
}

function renderAs(userId, request) {
  vi.mocked(useAuth).mockReturnValue({ user: { id: userId, role: "event_coordinator" } });
  return render(
    <MemoryRouter>
      <CoordinatorRequestDetail request={request} onChangeRequestProcessed={vi.fn()} onReviewDecisionProcessed={vi.fn()} />
    </MemoryRouter>,
  );
}

/** The decision section: the one whose heading names what can happen next. */
const ACTION_BUTTONS = ["Start review", "Approve request", "Reject request", "Return for amendment"];

function actionButtonsShown() {
  return ACTION_BUTTONS.filter((name) => screen.queryByRole("button", { name }));
}

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
  vi.mocked(startEventReview).mockReset();
  vi.mocked(decideEventRequest).mockReset();
  vi.mocked(requestEventClarification).mockReset();
  vi.mocked(getCoordinatorChangeRequests).mockReset();
  vi.mocked(getCoordinatorChangeRequests).mockResolvedValue([]);
  vi.mocked(getAssignmentHistoryForReview).mockReset();
  vi.mocked(getAssignmentHistoryForReview).mockResolvedValue([]);
  // ClarificationHistory calls .then() on this the moment it mounts, so it
  // has to hand back a promise, not undefined.
  vi.mocked(getEventClarificationHistory).mockReset();
  vi.mocked(getEventClarificationHistory).mockResolvedValue([]);
});


describe("SCRUM19_AC1 starting the review", () => {
  it("SCRUM19_AC1_a_submitted_request_offers_the_assigned_coordinator_start_review_only", async () => {
    renderAs(ASSIGNED, eventRequest());

    expect(await screen.findByRole("button", { name: "Start review" })).toBeInTheDocument();
    // Not Approve or Reject: SCRUM-318 allows a decision only from
    // under_review, and starting the review is what makes the coordinator its
    // reviewer, the one person 025 allows to decide.
    expect(actionButtonsShown()).toEqual(["Start review"]);
  });

  it("SCRUM19_AC1_starting_the_review_moves_the_panel_on_to_the_decision", async () => {
    vi.mocked(startEventReview).mockResolvedValue(
      eventRequest({ status: "under_review", reviewingCoordinatorId: ASSIGNED }),
    );
    const user = userEvent.setup();
    renderAs(ASSIGNED, eventRequest());

    await user.click(await screen.findByRole("button", { name: "Start review" }));

    expect(startEventReview).toHaveBeenCalledWith(REQUEST_ID);
    // The panel stays open on the updated request, with the next step in place.
    expect(await screen.findByRole("button", { name: "Approve request" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start review" })).not.toBeInTheDocument();
  });

  it("SCRUM19_AC1_a_refused_start_says_why_in_words_not_ids", async () => {
    vi.mocked(startEventReview).mockRejectedValue(httpError(403));
    const user = userEvent.setup();
    renderAs(ASSIGNED, eventRequest());

    await user.click(await screen.findByRole("button", { name: "Start review" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer assigned to you/i);
  });
});


describe("SCRUM19_AC1 a coordinator who is not assigned sees no actions", () => {
  it.each([
    ["submitted", "Waiting for the assigned coordinator to start the review."],
    ["under_review", "Only the assigned coordinator can decide this request."],
  ])("SCRUM19_AC1_a_%s_request_offers_another_coordinator_nothing_to_press", async (status, text) => {
    // Every coordinator can open every event (SCRUM-332), so this coordinator
    // can see where it stands, but not act. The server would refuse them
    // anyway; showing no button saves them the refusal.
    renderAs(OTHER, eventRequest({ status }));

    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(actionButtonsShown()).toEqual([]);
  });
});


describe("SCRUM19 deciding a request under review", () => {
  const underReview = () => eventRequest({ status: "under_review", reviewingCoordinatorId: ASSIGNED });

  it("SCRUM19_AC7_under_review_offers_approve_reject_and_return", async () => {
    renderAs(ASSIGNED, underReview());

    await screen.findByRole("button", { name: "Approve request" });
    expect(actionButtonsShown()).toEqual(["Approve request", "Reject request", "Return for amendment"]);
  });

  it("SCRUM19_AC7_approving_sends_the_decision_and_shows_it_read_only", async () => {
    vi.mocked(decideEventRequest).mockResolvedValue(eventRequest({
      status: "approved",
      reviewingCoordinatorId: ASSIGNED,
      decision: "approved",
      decisionNote: "Approved as submitted.",
      decidedBy: ASSIGNED,
      decidedAt: "2026-01-15T09:00:00+08:00",
    }));
    const user = userEvent.setup();
    renderAs(ASSIGNED, underReview());

    await user.type(await screen.findByLabelText("Note for the Organiser"), "Approved as submitted.");
    await user.click(screen.getByRole("button", { name: "Approve request" }));

    expect(decideEventRequest).toHaveBeenCalledWith(REQUEST_ID, {
      decision: "approved",
      decisionNote: "Approved as submitted.",
    });
    // The recorded decision replaces the actions: the confirmation that it
    // was recorded, and AC9's "cannot be edited" made visible.
    const outcome = await screen.findByText("Outcome");
    const record = outcome.closest("dl");
    expect(within(record).getByText("Approved")).toBeInTheDocument();
    expect(within(record).getByText("Approved as submitted.")).toBeInTheDocument();
    expect(within(record).getByText("You")).toBeInTheDocument();
    expect(actionButtonsShown()).toEqual([]);
  });

  it("SCRUM19_AC5_a_rejection_with_no_reason_is_refused_before_the_call", async () => {
    const user = userEvent.setup();
    renderAs(ASSIGNED, underReview());

    await user.click(await screen.findByRole("button", { name: "Reject request" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Add a reason before rejecting this request.");
    expect(decideEventRequest).not.toHaveBeenCalled();
  });

  it("SCRUM19_AC5_a_rejection_sends_its_reason", async () => {
    vi.mocked(decideEventRequest).mockResolvedValue(eventRequest({
      status: "rejected",
      decision: "rejected",
      decisionNote: "Venue capacity cannot meet the expected attendance.",
      decidedBy: ASSIGNED,
      decidedAt: "2026-01-15T09:00:00+08:00",
    }));
    const user = userEvent.setup();
    renderAs(ASSIGNED, underReview());

    await user.type(await screen.findByLabelText("Note for the Organiser"), "Venue capacity cannot meet the expected attendance.");
    await user.click(screen.getByRole("button", { name: "Reject request" }));

    expect(decideEventRequest).toHaveBeenCalledWith(REQUEST_ID, {
      decision: "rejected",
      decisionNote: "Venue capacity cannot meet the expected attendance.",
    });
    expect(await screen.findByText("Reason")).toBeInTheDocument();
  });

  it("SCRUM19_AC6_a_409_on_an_approval_whose_start_date_has_passed_says_to_agree_a_new_date", async () => {
    // AC6. The server refuses with 409; the screen does not swallow that into
    // a generic failure. The event's own start date, on screen, tells this
    // 409 apart from a request that changed: the remedy differs.
    vi.mocked(decideEventRequest).mockRejectedValue(httpError(409));
    const user = userEvent.setup();
    renderAs(ASSIGNED, eventRequest({ status: "under_review", proposedStart: past() }));

    await user.click(await screen.findByRole("button", { name: "Approve request" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/start date has passed/i);
    expect(alert).toHaveTextContent(/Agree a new date with the organiser, or reject the request/);
  });

  it("SCRUM19_AC2_a_409_on_a_future_event_says_the_request_changed", async () => {
    // The other 409: the start date is fine, so the request must have moved
    // on, decided by someone or sent for clarification, since it was opened.
    vi.mocked(decideEventRequest).mockRejectedValue(httpError(409));
    const user = userEvent.setup();
    renderAs(ASSIGNED, underReview());

    await user.click(await screen.findByRole("button", { name: "Approve request" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/changed since you opened it/i);
    expect(alert).not.toHaveTextContent(/start date/i);
  });

  it("SCRUM19_AC1_a_403_on_a_decision_says_the_request_is_not_theirs", async () => {
    vi.mocked(decideEventRequest).mockRejectedValue(httpError(403));
    const user = userEvent.setup();
    renderAs(ASSIGNED, underReview());

    await user.click(await screen.findByRole("button", { name: "Approve request" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer assigned to you/i);
  });

  it("returning for amendment still sends the note as the clarification", async () => {
    vi.mocked(requestEventClarification).mockResolvedValue(eventRequest({ status: "pending_clarification" }));
    const user = userEvent.setup();
    renderAs(ASSIGNED, underReview());

    await user.type(await screen.findByLabelText("Note for the Organiser"), "Please confirm numbers.");
    await user.click(screen.getByRole("button", { name: "Return for amendment" }));

    // SCRUM-162 added the reply-by date and the fields to amend, which the
    // screen sends as the third and fourth arguments. Neither is chosen here,
    // so they go as the defaults: no date, no fields.
    await waitFor(() => expect(requestEventClarification).toHaveBeenCalledWith(REQUEST_ID, "Please confirm numbers.", null, []));
    expect(decideEventRequest).not.toHaveBeenCalled();
  });

  // The refusals carry the server's own message, which names the event's id,
  // so these prove the screen shows its table's sentence instead of that.
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  function serverRefusal(status, message) {
    return Object.assign(httpError(status), {
      response: { status, data: { error: message } },
    });
  }

  async function returnForAmendment() {
    const user = userEvent.setup();
    renderAs(ASSIGNED, underReview());
    await user.type(await screen.findByLabelText("Note for the Organiser"), "Please confirm numbers.");
    await user.click(screen.getByRole("button", { name: "Return for amendment" }));
    return screen.findByRole("alert");
  }

  it("SCRUM19_AC1_a_refused_return_for_amendment_says_why_in_words_not_ids", async () => {
    vi.mocked(requestEventClarification).mockRejectedValue(serverRefusal(
      403,
      `Only the coordinator assigned to event request ${REQUEST_ID} can request clarification on it.`,
    ));

    const alert = await returnForAmendment();

    expect(alert).toHaveTextContent(/no longer assigned to you, so you cannot return it for amendment/i);
    expect(alert.textContent).not.toMatch(UUID);
  });

  it("SCRUM19_AC3_a_conflicting_return_for_amendment_says_the_request_changed_in_words_not_ids", async () => {
    // One message for both causes of the 409: the status moved, or the event
    // was handed over between the read and the write.
    vi.mocked(requestEventClarification).mockRejectedValue(serverRefusal(
      409,
      `event request ${REQUEST_ID} is no longer assigned to this coordinator`,
    ));

    const alert = await returnForAmendment();

    expect(alert).toHaveTextContent(/changed since you opened it/i);
    expect(alert).toHaveTextContent(/handed to another coordinator/i);
    expect(alert.textContent).not.toMatch(UUID);
  });

  it("SCRUM19_AC1_a_return_for_amendment_refused_for_another_reason_still_names_no_id", async () => {
    // A status the table does not list falls back to a sentence of its own,
    // never to the server's message.
    vi.mocked(requestEventClarification).mockRejectedValue(serverRefusal(
      500,
      `event request ${REQUEST_ID} could not be changed`,
    ));

    const alert = await returnForAmendment();

    expect(alert).toHaveTextContent(/could not be returned for amendment/i);
    expect(alert.textContent).not.toMatch(UUID);
  });
});


describe("SCRUM19 statuses with nothing to decide", () => {
  it("SCRUM19_AC3_pending_clarification_shows_the_waiting_panel_and_no_decision_actions", async () => {
    renderAs(ASSIGNED, eventRequest({
      status: "pending_clarification",
      clarificationNote: "Please confirm whether the event is public.",
    }));

    // "reply", not "amendment": SCRUM-162 renamed it when the Organiser's
    // answer became a text reply with optional amendments.
    expect(await screen.findByText("Waiting for organiser reply")).toBeInTheDocument();
    expect(screen.getByText("Please confirm whether the event is public.")).toBeInTheDocument();
    expect(actionButtonsShown()).toEqual([]);
  });

  it.each([
    ["the assigned coordinator", ASSIGNED],
    ["another coordinator", OTHER],
  ])("SCRUM19_AC9_a_decided_request_shows_its_decision_read_only_to_%s", async (_label, userId) => {
    // The decider's name comes from the assignment history: decidedBy is a bare
    // id, and the history names everyone who has held the event.
    vi.mocked(getAssignmentHistoryForReview).mockResolvedValue([
      { id: "h1", previousCoordinatorId: null, newCoordinatorId: ASSIGNED, newCoordinatorName: "Priya Nair", automatic: true },
    ]);
    const decided = eventRequest({
      status: "rejected",
      reviewingCoordinatorId: ASSIGNED,
      decision: "rejected",
      decisionNote: "The venue is unavailable that week.",
      decidedBy: ASSIGNED,
      decidedAt: "2026-01-15T09:00:00+08:00",
    });

    renderAs(userId, decided);

    const record = (await screen.findByText("Outcome")).closest("dl");
    expect(within(record).getByText("Rejected")).toBeInTheDocument();
    expect(within(record).getByText("The venue is unavailable that week.")).toBeInTheDocument();
    expect(within(record).getByText(new Date("2026-01-15T09:00:00+08:00").toLocaleString())).toBeInTheDocument();
    if (userId === ASSIGNED) {
      expect(within(record).getByText("You")).toBeInTheDocument();
    } else {
      expect(await within(record).findByText("Priya Nair")).toBeInTheDocument();
    }
    expect(actionButtonsShown()).toEqual([]);
  });

  it("SCRUM19_AC9_a_decision_stays_on_show_after_the_status_moves_on", async () => {
    // Confirmed after approval: the status has moved, the decision has not.
    renderAs(ASSIGNED, eventRequest({
      status: "confirmed",
      decision: "approved",
      decisionNote: null,
      decidedBy: ASSIGNED,
      decidedAt: "2026-01-15T09:00:00+08:00",
    }));

    const record = (await screen.findByText("Outcome")).closest("dl");
    expect(within(record).getByText("Approved")).toBeInTheDocument();
    expect(within(record).getByText("No note was left.")).toBeInTheDocument();
    expect(actionButtonsShown()).toEqual([]);
  });
});
