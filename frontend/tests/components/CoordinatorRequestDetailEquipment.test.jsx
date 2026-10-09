// CoordinatorRequestDetailEquipment.test.jsx
//
// SCRUM-247, for SCRUM-21 (Record Equipment Requirements for an Event). The
// wiring only: that the coordinator's panel shows the equipment section, hands
// it the right event, the right status and the right "can this person edit",
// and keeps handing it the status as the panel changes it. What the section
// itself does is in EventEquipmentSection.test.jsx.
//
// The panel's other children are replaced with empty ones, so these tests do
// not depend on the venue finder, the histories or the decision record.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import CoordinatorRequestDetail from "../../src/components/CoordinatorRequestDetail.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import { decideEventRequest } from "../../src/services/eventRequestService";
import { getActiveEquipmentTypes, getEventEquipment } from "../../src/services/eventEquipmentService";

vi.mock("../../src/auth/AuthContext", () => ({ useAuth: vi.fn() }));

vi.mock("../../src/services/eventRequestService", () => ({
  closeEventClarification: vi.fn(),
  decideEventRequest: vi.fn(),
  getCoordinatorChangeRequests: vi.fn(() => Promise.resolve([])),
  processCoordinatorChangeRequest: vi.fn(),
  requestEventClarification: vi.fn(),
  startEventReview: vi.fn(),
}));

vi.mock("../../src/services/eventEquipmentService", () => ({
  addEquipmentLine: vi.fn(),
  amendEquipmentLine: vi.fn(),
  getActiveEquipmentTypes: vi.fn(),
  getEventEquipment: vi.fn(),
  removeEquipmentLine: vi.fn(),
}));

vi.mock("../../src/components/AssignmentHistory", () => ({ default: () => null }));
vi.mock("../../src/components/EventVenueFinder", () => ({ default: () => null }));
vi.mock("../../src/components/DecisionOutcome", () => ({ default: () => null }));
vi.mock("../../src/components/ReassignEventPanel", () => ({ default: () => null }));
vi.mock("../../src/components/ClarificationHistory", () => ({ default: () => null }));

const ASSIGNED = "44444444-4444-4444-8444-444444444444";
const OTHER = "66666666-6666-4666-8666-666666666666";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const future = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

function eventRequest(overrides = {}) {
  return {
    id: REQUEST_ID,
    eventName: "IS212 Industry Night",
    purpose: "Connect students with industry.",
    proposedStart: future(),
    proposedEnd: future(),
    expectedAttendance: 120,
    status: "approved",
    assignedCoordinatorId: ASSIGNED,
    reviewingCoordinatorId: ASSIGNED,
    statusDisplay: { status: "approved", label: "Approved", group: "APPROVED", description: "" },
    ...overrides,
  };
}

function renderAs(userId, request) {
  vi.mocked(useAuth).mockReturnValue({ user: { id: userId, role: "event_coordinator" } });
  return render(
    <MemoryRouter>
      <CoordinatorRequestDetail request={request} onChangeRequestProcessed={vi.fn()} onReviewDecisionProcessed={vi.fn()} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
  vi.mocked(decideEventRequest).mockReset();
  vi.mocked(getEventEquipment).mockReset();
  vi.mocked(getEventEquipment).mockResolvedValue({ request: null });
  vi.mocked(getActiveEquipmentTypes).mockReset();
  vi.mocked(getActiveEquipmentTypes).mockResolvedValue([]);
});

describe("SCRUM21 the equipment section in the coordinator panel", () => {
  it("SCRUM21_AC11_the_panel_shows_the_section_and_reads_this_events_equipment", async () => {
    renderAs(ASSIGNED, eventRequest());

    expect(await screen.findByRole("heading", { name: "Equipment needed" })).toBeInTheDocument();
    expect(getEventEquipment).toHaveBeenCalledWith(REQUEST_ID);
  });

  it("SCRUM21_AC1_the_assigned_coordinator_of_an_approved_event_is_offered_add", async () => {
    renderAs(ASSIGNED, eventRequest());

    expect(await screen.findByRole("button", { name: "Add equipment" })).toBeInTheDocument();
  });

  it("SCRUM21_AC1_another_coordinator_is_shown_the_reason_and_no_add", async () => {
    renderAs(OTHER, eventRequest());

    expect(await screen.findByText("Only the assigned coordinator can change this event's equipment.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add equipment" })).not.toBeInTheDocument();
  });

  it("SCRUM21_AC1_an_event_not_yet_approved_is_not_offered_add", async () => {
    renderAs(ASSIGNED, eventRequest({
      status: "submitted",
      statusDisplay: { status: "submitted", label: "Submitted", group: "AWAITING_REVIEW", description: "" },
    }));

    expect(await screen.findByText("Equipment can be recorded once the request is approved.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add equipment" })).not.toBeInTheDocument();
  });

  it("SCRUM21_AC1_approving_in_the_panel_makes_add_available_without_reopening", async () => {
    // The section is given the panel's current request, not the row the parent
    // loaded, so an approval made here is seen here.
    vi.mocked(decideEventRequest).mockResolvedValue(eventRequest());
    const user = userEvent.setup();
    renderAs(ASSIGNED, eventRequest({
      status: "under_review",
      statusDisplay: { status: "under_review", label: "Under review", group: "IN_REVIEW", description: "" },
    }));
    await screen.findByText("Equipment can be recorded once the request is approved.");

    await user.click(await screen.findByRole("button", { name: "Approve request" }));

    expect(await screen.findByRole("button", { name: "Add equipment" })).toBeInTheDocument();
  });
});
