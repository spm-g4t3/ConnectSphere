// MyEventRequests.test.jsx
//
// SCRUM-133, for SCRUM-19 AC10: once a request is decided, the Organiser sees
// the outcome, the reason or note, and the coordinator who decided, on the
// request's own row.
//
// Only the decision block is covered here. The rest of this screen (create,
// edit, respond, request a change) predates the frontend test setup and is
// out of this ticket's scope.
//
// The services and the signed-in user are mocked, so nothing touches the
// network. As in CoordinatorRequestDetail.test.jsx, every eventRequestService
// function the screen's component tree reaches when modules load is on the
// mock, because a vi.mock factory is strict.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import MyEventRequests from "../../src/components/MyEventRequests.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import {
  getAssignmentHistory,
  getMyEventRequests,
} from "../../src/services/eventRequestService";

vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../../src/services/eventRequestService", () => ({
  createEventRequest: vi.fn(),
  getAssignmentHistory: vi.fn(),
  getAssignmentHistoryForReview: vi.fn(),
  getMyEventRequests: vi.fn(),
  getEventClarificationHistory: vi.fn(),
  getEventCancellationImpact: vi.fn(),
  cancelEventRequest: vi.fn(),
  respondToEventClarification: vi.fn(),
  submitEventRequest: vi.fn(),
  updateEventRequest: vi.fn(),
}));

const ORGANISER = "11111111-1111-4111-8111-111111111111";
const COORDINATOR = "44444444-4444-4444-8444-444444444444";

function eventRequest(overrides = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    organiserId: ORGANISER,
    eventName: "IS212 Industry Night",
    purpose: "Connect students with industry.",
    status: "submitted",
    clarificationNote: null,
    assignedCoordinatorId: COORDINATOR,
    decision: null,
    decisionNote: null,
    decidedBy: null,
    decidedAt: null,
    statusDisplay: { status: "submitted", label: "Submitted", group: "AWAITING_REVIEW", description: "Waiting." },
    ...overrides,
  };
}

function renderList(requests) {
  vi.mocked(getMyEventRequests).mockResolvedValue(requests);
  return render(
    <MemoryRouter>
      <MyEventRequests />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
  vi.mocked(useAuth).mockReturnValue({ user: { id: ORGANISER, role: "event_organiser" } });
  vi.mocked(getMyEventRequests).mockReset();
  vi.mocked(getAssignmentHistory).mockReset();
  vi.mocked(getAssignmentHistory).mockResolvedValue([
    { id: "h1", previousCoordinatorId: null, newCoordinatorId: COORDINATOR, newCoordinatorName: "Priya Nair", automatic: true },
  ]);
});


describe("SCRUM19_AC10 the Organiser's view of a decision", () => {
  it("shows the cancellation reason and recorded date without offering further changes", async () => {
    renderList([
      eventRequest({
        status: "cancelled",
        cancellationReason: "Organiser withdrew",
        cancelledAt: "2026-06-01T09:00:00Z",
        statusDisplay: { status: "cancelled", label: "Cancelled", group: "CANCELLED", description: "This event will not go ahead." },
      }),
    ]);

    const row = await screen.findByText("IS212 Industry Night");
    const item = row.closest("li");
    expect(within(item).getByText("Event cancelled")).toBeInTheDocument();
    expect(within(item).getByText("Organiser withdrew")).toBeInTheDocument();
    expect(within(item).getByText(
      new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
        .format(new Date("2026-06-01T09:00:00Z")),
    )).toBeInTheDocument();
    expect(within(item).queryByRole("button", { name: "Request a change" })).not.toBeInTheDocument();
  });

  it("SCRUM19_AC10_the_organiser_sees_the_outcome_the_reason_and_who_decided", async () => {
    renderList([
      eventRequest({
        status: "rejected",
        decision: "rejected",
        decisionNote: "The venue is unavailable that week.",
        decidedBy: COORDINATOR,
        decidedAt: "2026-01-15T09:00:00+08:00",
        statusDisplay: { status: "rejected", label: "Rejected", group: "REJECTED", description: "See the Coordinator notes for the reason." },
      }),
    ]);

    const record = (await screen.findByText("Outcome")).closest("dl");
    expect(within(record).getByText("Rejected")).toBeInTheDocument();
    expect(within(record).getByText("Reason")).toBeInTheDocument();
    expect(within(record).getByText("The venue is unavailable that week.")).toBeInTheDocument();
    // The name comes from the Organiser's assignment history, matched on
    // decidedBy; the event itself carries only the id.
    expect(await within(record).findByText("Priya Nair")).toBeInTheDocument();
    expect(getAssignmentHistory).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
    expect(within(record).getByText(new Date("2026-01-15T09:00:00+08:00").toLocaleString())).toBeInTheDocument();
  });

  it("SCRUM19_AC10_an_approval_shows_its_note_and_who_decided", async () => {
    renderList([
      eventRequest({
        status: "approved",
        decision: "approved",
        decisionNote: "Approved as submitted.",
        decidedBy: COORDINATOR,
        decidedAt: "2026-01-15T09:00:00+08:00",
        statusDisplay: { status: "approved", label: "Approved", group: "APPROVED", description: "Accepted." },
      }),
    ]);

    const record = (await screen.findByText("Outcome")).closest("dl");
    expect(within(record).getByText("Note")).toBeInTheDocument();
    expect(within(record).getByText("Approved as submitted.")).toBeInTheDocument();
    expect(await within(record).findByText("Priya Nair")).toBeInTheDocument();
  });

  it("SCRUM19_AC10_an_undecided_request_shows_no_outcome_and_reads_no_history", async () => {
    // Nothing decided, nothing to show, and no request made for a name: the
    // history is read only for decided rows.
    renderList([eventRequest()]);

    expect(await screen.findByText("IS212 Industry Night")).toBeInTheDocument();
    expect(screen.queryByText("Outcome")).not.toBeInTheDocument();
    expect(getAssignmentHistory).not.toHaveBeenCalled();
  });

  it("SCRUM19_AC10_a_decider_missing_from_the_history_is_named_honestly", async () => {
    // Should not happen (the decider must have held the event), but if the
    // history does not name them the line says so rather than showing an id.
    vi.mocked(getAssignmentHistory).mockResolvedValue([]);
    renderList([
      eventRequest({
        status: "rejected",
        decision: "rejected",
        decisionNote: "No.",
        decidedBy: COORDINATOR,
        decidedAt: "2026-01-15T09:00:00+08:00",
      }),
    ]);

    const record = (await screen.findByText("Outcome")).closest("dl");
    expect(await within(record).findByText("A coordinator with no name on record")).toBeInTheDocument();
    expect(within(record).queryByText(COORDINATOR)).not.toBeInTheDocument();
  });
});


// ---------------------------------------------------------------------------
// SCRUM-486 (SCRUM-520), AC1-05: the Organiser can tell "waiting to be
// assigned" from "assigned, waiting for review", on the row itself.
// ---------------------------------------------------------------------------
describe("SCRUM486_AC1 where a submitted request stands with its coordinator", () => {
  const WAITING_FOR_LEAD = "Waiting for the Event Coordinator Lead to assign a coordinator to your request.";
  // The unnamed form, for a row whose coordinator has no name on record (these
  // fixtures carry no assignedCoordinatorName). Was "A coordinator has been
  // assigned. Your request is ..." until the line gained the coordinator's
  // name (AC1-06), when the sentence became "<who> has been assigned; your
  // request is ...". Right when written: the list carried no name then.
  const WAITING_FOR_REVIEW = "A coordinator has been assigned; your request is waiting for them to start the review.";

  /** The request's own list item, found by its name. */
  const rowOf = async (name) => (await screen.findByText(name)).closest("li");

  it("SCRUM486_AC1_a_submitted_request_with_no_coordinator_says_it_is_waiting_for_the_lead", async () => {
    // AC1-05. On the row, not inside a collapsed section: nothing is opened.
    renderList([eventRequest({ assignedCoordinatorId: null })]);

    const line = await screen.findByText(WAITING_FOR_LEAD);
    expect(line.closest("details")).toBeNull();
    expect(screen.queryByText(WAITING_FOR_REVIEW)).not.toBeInTheDocument();
  });

  it("SCRUM486_AC1_a_submitted_request_with_a_coordinator_says_it_is_waiting_for_review", async () => {
    renderList([eventRequest({ assignedCoordinatorId: COORDINATOR })]);

    const line = await screen.findByText(WAITING_FOR_REVIEW);
    expect(line.closest("details")).toBeNull();
    expect(screen.queryByText(WAITING_FOR_LEAD)).not.toBeInTheDocument();
  });

  it("SCRUM486_AC1_a_submitted_request_names_the_coordinator_it_was_assigned_to", async () => {
    // AC1-06. The name comes with the list (listEventRequestsForOrganiser
    // reads it in one profiles read), so the row says who without a click.
    renderList([eventRequest({ assignedCoordinatorId: COORDINATOR, assignedCoordinatorName: "Priya Nair" })]);

    const line = await screen.findByText(
      "Priya Nair has been assigned; your request is waiting for them to start the review.",
    );
    expect(line.closest("details")).toBeNull();
    expect(screen.queryByText(WAITING_FOR_REVIEW)).not.toBeInTheDocument();
    expect(screen.queryByText(WAITING_FOR_LEAD)).not.toBeInTheDocument();
  });

  it("SCRUM486_AC1_the_two_are_visibly_different_on_rows_that_share_a_status", async () => {
    // Same status, same badge, same shared description from the API: the
    // line is the only difference, and it is there on both rows.
    renderList([
      eventRequest({ id: "a", eventName: "Unassigned Night", assignedCoordinatorId: null }),
      eventRequest({ id: "b", eventName: "Assigned Night", assignedCoordinatorId: COORDINATOR }),
    ]);

    const unassigned = await rowOf("Unassigned Night");
    const assigned = await rowOf("Assigned Night");
    expect(within(unassigned).getByText("Submitted")).toBeInTheDocument();
    expect(within(assigned).getByText("Submitted")).toBeInTheDocument();
    expect(within(unassigned).getByText(WAITING_FOR_LEAD)).toBeInTheDocument();
    expect(within(assigned).getByText(WAITING_FOR_REVIEW)).toBeInTheDocument();
    expect(within(unassigned).queryByText(WAITING_FOR_REVIEW)).not.toBeInTheDocument();
    expect(within(assigned).queryByText(WAITING_FOR_LEAD)).not.toBeInTheDocument();
  });

  it("SCRUM486_AC1_a_draft_is_unchanged", async () => {
    // No line, and the status description from the API as it was.
    renderList([
      eventRequest({
        status: "draft",
        assignedCoordinatorId: null,
        statusDisplay: { status: "draft", label: "Draft", group: "DRAFT", description: "Not yet submitted to ConnectSphere. You can keep editing it." },
      }),
    ]);

    const row = await rowOf("IS212 Industry Night");
    expect(within(row).getByText("Not yet submitted to ConnectSphere. You can keep editing it.")).toBeInTheDocument();
    expect(within(row).queryByText(WAITING_FOR_LEAD)).not.toBeInTheDocument();
    expect(within(row).queryByText(WAITING_FOR_REVIEW)).not.toBeInTheDocument();
  });

  it("SCRUM486_AC1_past_submission_the_status_speaks_for_itself", async () => {
    renderList([
      eventRequest({
        status: "under_review",
        statusDisplay: { status: "under_review", label: "Under review", group: "UNDER_REVIEW", description: "A Coordinator is assessing your request." },
      }),
    ]);

    const row = await rowOf("IS212 Industry Night");
    expect(within(row).getByText("A Coordinator is assessing your request.")).toBeInTheDocument();
    expect(within(row).queryByText(WAITING_FOR_LEAD)).not.toBeInTheDocument();
    expect(within(row).queryByText(WAITING_FOR_REVIEW)).not.toBeInTheDocument();
  });
});


describe("SCRUM488_AC5 the Organiser's list shows the safety statuses", () => {
  // The words come from the server's statusDisplay (SCRUM-42). These are what
  // it sends for each status, written out; the labels are provisional until
  // SCRUM-549's decision is confirmed.
  const SAFETY = [
    ["safety_review", "Safety check", "UNDER_REVIEW", "status--under-review", "A Safety Officer is checking the arrangements for your event before it can be confirmed."],
    ["safety_approved", "Safety approved", "APPROVED", "status--approved", "The safety check is complete. Your Coordinator can now confirm your event."],
  ];

  const safetyEvent = (status, label, group, description, overrides = {}) =>
    eventRequest({
      status,
      eventName: `Event in ${status}`,
      decision: "approved",
      decisionNote: null,
      decidedBy: COORDINATOR,
      decidedAt: "2026-01-15T09:00:00+08:00",
      statusDisplay: { status, label, group, description },
      ...overrides,
    });

  it.each(SAFETY)("SCRUM488_AC5_shows_%s_as_%s_with_its_badge_and_description", async (status, label, group, cssClass, description) => {
    renderList([safetyEvent(status, label, group, description)]);

    const item = (await screen.findByText(`Event in ${status}`)).closest("li");
    expect(within(item).getByText(label)).toHaveClass("status-badge", cssClass);
    expect(within(item).getByText(description)).toBeInTheDocument();
  });

  it.each(SAFETY)("SCRUM488_AC5_never_shows_the_internal_name_or_an_unknown_status_for_%s", async (status, label, group, _cssClass, description) => {
    const { container } = renderList([safetyEvent(status, label, group, description)]);

    await screen.findByText(`Event in ${status}`);
    const shown = container.textContent.replace(`Event in ${status}`, "");
    expect(shown).not.toContain(status);
    expect(shown).not.toMatch(/Unknown Status|Status Unavailable/);
  });

  it.each(SAFETY)("SCRUM488_AC5_keeps_the_approval_and_the_request_a_change_action_for_%s", async (status, label, group, _cssClass, description) => {
    renderList([safetyEvent(status, label, group, description)]);

    const item = (await screen.findByText(`Event in ${status}`)).closest("li");
    expect(within(item).getByText("Decision")).toBeInTheDocument();
    expect(await within(item).findByText("Approved")).toBeInTheDocument();
    expect(within(item).getByRole("button", { name: "Request a change" })).toBeInTheDocument();
    expect(within(item).queryByRole("button", { name: "Respond to clarification" })).not.toBeInTheDocument();
    expect(within(item).queryByRole("button", { name: "Continue editing" })).not.toBeInTheDocument();
  });

  it("SCRUM488_AC5_labels_each_status_in_a_mixed_list_by_its_own_words", async () => {
    renderList([
      eventRequest({ id: "a", eventName: "A", statusDisplay: { status: "submitted", label: "Requested", group: "AWAITING_REVIEW", description: "Waiting." } }),
      safetyEvent("safety_review", "Safety check", "UNDER_REVIEW", "Checking.", { id: "b", eventName: "B" }),
      safetyEvent("safety_approved", "Safety approved", "APPROVED", "Done.", { id: "c", eventName: "C" }),
      eventRequest({ id: "d", eventName: "D", status: "confirmed", statusDisplay: { status: "confirmed", label: "Confirmed", group: "CONFIRMED", description: "Going ahead." } }),
    ]);

    await screen.findByText("A");
    const badge = (name) => within(screen.getByText(name).closest("li")).getByText(/^(Requested|Safety check|Safety approved|Confirmed)$/);
    expect(["A", "B", "C", "D"].map((name) => badge(name).textContent))
      .toEqual(["Requested", "Safety check", "Safety approved", "Confirmed"]);
    expect(within(screen.getByText("C").closest("li")).getByRole("status"))
      .toHaveTextContent("Safety approval complete");
    expect(within(screen.getByText("B").closest("li")).queryByText("Safety approval complete"))
      .not.toBeInTheDocument();
    expect(badge("A")).toHaveClass("status--awaiting-review");
    expect(badge("D")).toHaveClass("status--confirmed");
  });
});
