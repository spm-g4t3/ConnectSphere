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
