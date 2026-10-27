// scrum487LeadReadOnly.test.jsx
//
// SCRUM-487 AC5 (SCRUM-545): the Lead opens any event read-only. Its details,
// its clarification history and its assignment history with the handover
// notes are shown; no review, decision, cancellation, clarification or
// change-request action is; the hand-over is the one action (AC6, SCRUM-486).
//
// CoordinatorRequestDetail is rendered as a Lead on an event someone else
// holds, in every status that offers the holder an action. The server refuses
// a Lead each of those writes whatever the screen shows (SCRUM487_AC5_a_lead_
// is_refused_%s_with_403_and_queries_nothing, backend); this proves the
// screen does not offer them, so the Lead is never shown a button that can
// only be refused.
//
// A file of its own. CoordinatorRequestDetail.test.jsx holds SCRUM-486's AC6
// cases and is under review in its PR; the mocks are that file's, copied.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import CoordinatorRequestDetail from "../../src/components/CoordinatorRequestDetail.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import {
  getAssignmentHistoryForReview,
  getCoordinatorChangeRequests,
  getEventClarificationHistory,
} from "../../src/services/eventRequestService";
import { findVenuesForEvent } from "../../src/services/venueService";
import { getEventVenueSuitability } from "../../src/services/venueSuitabilityService";

vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../../src/services/eventRequestService", () => ({
  closeEventClarification: vi.fn(),
  getEventDecisionHistory: vi.fn(() => Promise.resolve([])),
  getEventChangeHistory: vi.fn(() => Promise.resolve([])),
  cancelEventRequest: vi.fn(),
  decideEventRequest: vi.fn(),
  getAssignmentHistory: vi.fn(),
  getAssignmentHistoryForReview: vi.fn(),
  getCoordinatorChangeRequests: vi.fn(),
  getEventCancellationImpact: vi.fn(),
  getEventClarificationHistory: vi.fn(),
  listCoordinators: vi.fn(),
  listCoordinatorWorkload: vi.fn(),
  processCoordinatorChangeRequest: vi.fn(),
  reassignEventRequest: vi.fn(),
  requestEventClarification: vi.fn(),
  startEventReview: vi.fn(),
}));

vi.mock("../../src/services/venueService", () => ({
  findVenuesForEvent: vi.fn(),
}));

vi.mock("../../src/services/bookingRequestService", () => ({
  createBookingRequest: vi.fn(),
}));

vi.mock("../../src/services/venueSuitabilityService", () => ({
  checkVenueSuitability: vi.fn(),
  getEventVenueSuitability: vi.fn(),
}));

const LEAD = "77777777-7777-4777-8777-777777777777";
const HOLDER = "44444444-4444-4444-8444-444444444444";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const future = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

/** Every action this screen offers the event's holder, by its button's name. */
const HOLDERS_ACTIONS = [
  "Start review",
  "Approve request",
  "Reject request",
  "Return for amendment",
  "Cancel event",
  "Close clarification",
  // A pending change request's decision.
  "Approve",
  "Reject",
];

const HANDOVER_NOTE = "Priya is on leave until Friday.";

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
    assignedCoordinatorId: HOLDER,
    reviewingCoordinatorId: null,
    decision: null,
    decisionNote: null,
    decidedBy: null,
    decidedAt: null,
    statusDisplay: { status: "submitted", label: "Requested", group: "AWAITING_REVIEW", description: "" },
    ...overrides,
  };
}

const OPEN_CHANGE_REQUEST = {
  id: "cr1",
  fieldLabel: "Venue",
  details: "A larger room.",
  status: "outstanding",
  createdAt: "2026-10-10T03:00:00+00:00",
  decision: null,
  decisionNotes: null,
};

function renderAsLead(request) {
  vi.mocked(useAuth).mockReturnValue({ user: { id: LEAD, role: "event_coordinator_lead" } });
  return render(
    <MemoryRouter>
      <CoordinatorRequestDetail request={request} onChangeRequestProcessed={vi.fn()} onReviewDecisionProcessed={vi.fn()} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
  vi.mocked(getCoordinatorChangeRequests).mockReset();
  vi.mocked(getCoordinatorChangeRequests).mockResolvedValue([]);
  vi.mocked(getAssignmentHistoryForReview).mockReset();
  vi.mocked(getAssignmentHistoryForReview).mockResolvedValue([{
    id: "h1",
    previousCoordinatorId: null,
    previousCoordinatorName: null,
    newCoordinatorId: HOLDER,
    newCoordinatorName: "Priya Nair",
    assignedById: LEAD,
    assignedByName: "Lena Lead",
    automatic: false,
    handoverNote: HANDOVER_NOTE,
    createdAt: "2026-10-09T03:00:00+00:00",
  }]);
  vi.mocked(getEventClarificationHistory).mockReset();
  vi.mocked(getEventClarificationHistory).mockResolvedValue([]);
  vi.mocked(findVenuesForEvent).mockReset();
  vi.mocked(findVenuesForEvent).mockResolvedValue([]);
  vi.mocked(getEventVenueSuitability).mockReset();
  vi.mocked(getEventVenueSuitability).mockResolvedValue([]);
});


describe("SCRUM487_AC5 the Lead opens any event read-only", () => {
  it.each([
    ["submitted (Start review)", { status: "submitted" }, "View clarification history", []],
    ["under_review (Approve, Reject, Return for amendment)", { status: "under_review", reviewingCoordinatorId: HOLDER }, "View clarification history", []],
    ["pending_clarification (Close clarification)", { status: "pending_clarification", clarificationNote: "Numbers?" }, "View previous messages", []],
    ["approved (Cancel event)", { status: "approved", decision: "approved", decidedBy: HOLDER, decidedAt: "2026-10-10T03:00:00+00:00" }, "View clarification history", []],
    ["confirmed (Cancel event)", { status: "confirmed", decision: "approved", decidedBy: HOLDER, decidedAt: "2026-10-10T03:00:00+00:00" }, "View clarification history", []],
    ["approved_with_an_open_change_request (Approve, Reject)", { status: "approved", decision: "approved", decidedBy: HOLDER, decidedAt: "2026-10-10T03:00:00+00:00" }, "View clarification history", [OPEN_CHANGE_REQUEST]],
  ])("SCRUM487_AC5_a_lead_sees_%s_read_only_with_only_the_hand_over_action", async (_status, overrides, clarificationButton, changeRequests) => {
    // AC5-01 to AC5-03, AC5-10. Shown: the details, the clarification
    // history, the assignment history with the handover note (D6), and the
    // hand-over. Not shown: any action that is the holder's.
    vi.mocked(getCoordinatorChangeRequests).mockResolvedValue(changeRequests);

    renderAsLead(eventRequest(overrides));

    expect(await screen.findByRole("button", { name: "Hand over to another coordinator" })).toBeInTheDocument();
    expect(await screen.findByText(HANDOVER_NOTE)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Assignment history" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: clarificationButton })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: /IS212 Industry Night/ })).toBeInTheDocument();
    if (changeRequests.length > 0) expect(await screen.findByText("A larger room.")).toBeInTheDocument();

    for (const action of HOLDERS_ACTIONS) {
      expect(screen.queryByRole("button", { name: action })).not.toBeInTheDocument();
    }
  });
});
