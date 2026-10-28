// scrum402CoordinatorScreens.test.jsx
//
// SCRUM-402 on the coordinator's screens that host it: the review panel in
// place of the old inline list on the event screen, the equipment hand-off
// (AC8), and My events' count of waiting submissions (SCRUM-404). The panel
// itself has its own suite.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import CoordinatorRequestDetail from "../../src/components/CoordinatorRequestDetail.jsx";
import MyAssignedEvents from "../../src/components/MyAssignedEvents.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import {
  getAssignmentHistoryForReview,
  getCoordinatorChangeRequests,
  getEventChangeHistory,
  getEventClarificationHistory,
  getMyAssignedEvents,
  previewCoordinatorChangeRequest,
  processCoordinatorChangeRequest,
} from "../../src/services/eventRequestService";

vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../../src/services/eventRequestService", () => ({
  closeEventClarification: vi.fn(),
  getEventDecisionHistory: vi.fn(() => Promise.resolve([])),
  getEventChangeHistory: vi.fn(),
  cancelEventRequest: vi.fn(),
  decideEventRequest: vi.fn(),
  getAssignmentHistory: vi.fn(),
  getAssignmentHistoryForReview: vi.fn(),
  getCoordinatorChangeRequests: vi.fn(),
  getEventCancellationImpact: vi.fn(),
  getEventClarificationHistory: vi.fn(),
  getMyAssignedEvents: vi.fn(),
  listCoordinators: vi.fn(),
  listCoordinatorWorkload: vi.fn(),
  previewCoordinatorChangeRequest: vi.fn(),
  processCoordinatorChangeRequest: vi.fn(),
  previewSignificantEventChange: vi.fn(),
  applySignificantEventChange: vi.fn(),
  reassignEventRequest: vi.fn(),
  requestEventClarification: vi.fn(),
  startEventReview: vi.fn(),
  updateEventRequestDetails: vi.fn(),
}));

vi.mock("../../src/services/venueService", () => ({ findVenuesForEvent: vi.fn() }));
vi.mock("../../src/services/bookingRequestService", () => ({ createBookingRequest: vi.fn() }));
vi.mock("../../src/services/venueSuitabilityService", () => ({
  checkVenueSuitability: vi.fn(),
  getEventVenueSuitability: vi.fn(() => Promise.resolve([])),
}));
vi.mock("../../src/services/flaggedBookingService", () => ({
  getEventFlaggedBookings: vi.fn(() => Promise.resolve([])),
  cancelFlaggedBooking: vi.fn(),
}));

const ASSIGNED = "44444444-4444-4444-8444-444444444444";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

const eventRequest = (overrides = {}) => ({
  id: REQUEST_ID,
  organiserId: "11111111-1111-4111-8111-111111111111",
  eventName: "IS212 Industry Night",
  purpose: "Connect students with industry.",
  proposedStart: "2026-12-01T09:00:00.000Z",
  proposedEnd: "2026-12-01T11:00:00.000Z",
  expectedAttendance: 80,
  status: "approved",
  assignedCoordinatorId: ASSIGNED,
  updatedAt: "2026-10-20T03:00:00Z",
  statusDisplay: { status: "approved", label: "Planning", group: "APPROVED", description: "Accepted." },
  ...overrides,
});

const EQUIPMENT_ROW = {
  id: "r1", requestGroupId: "g1", changeField: "equipment", requestedChange: "Two more microphones", details: "Two more microphones",
  currentValue: null, organiserNote: null, status: "outstanding", decision: null, createdAt: "2026-10-20T03:00:00Z",
};

beforeEach(() => {
  vi.mocked(useAuth).mockReturnValue({ user: { id: ASSIGNED, role: "event_coordinator" } });
  vi.mocked(getCoordinatorChangeRequests).mockReset();
  vi.mocked(getCoordinatorChangeRequests).mockResolvedValue([EQUIPMENT_ROW]);
  vi.mocked(getAssignmentHistoryForReview).mockResolvedValue([]);
  vi.mocked(getEventClarificationHistory).mockResolvedValue([]);
  vi.mocked(getEventChangeHistory).mockResolvedValue([]);
  vi.mocked(previewCoordinatorChangeRequest).mockResolvedValue({
    changeRequestId: "g1", rows: [{ id: "r1", class: "equipment" }], invalid: [], revertsEvent: false, impact: null,
  });
  vi.mocked(processCoordinatorChangeRequest).mockResolvedValue({ id: "r1", status: "processed" });
});


describe("SCRUM-402 on the coordinator's event screen", () => {
  it("SCRUM402_AC8_an_accepted_equipment_change_moves_to_the_equipment_section_with_the_organisers_text", async () => {
    const onChangeRequestProcessed = vi.fn();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CoordinatorRequestDetail request={eventRequest()} onChangeRequestProcessed={onChangeRequestProcessed} onReviewDecisionProcessed={vi.fn()} />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole("button", { name: "Review" }));
    await user.click(await screen.findByRole("button", { name: "Accept" }));

    expect(await screen.findByText("The organiser asked for this equipment change: Two more microphones")).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Equipment")));
    expect(onChangeRequestProcessed).toHaveBeenCalledTimes(1);
  });

  it("SCRUM402_AC1_the_panel_sits_where_the_old_list_was_with_no_approve_or_reject", async () => {
    render(
      <MemoryRouter>
        <CoordinatorRequestDetail request={eventRequest()} onChangeRequestProcessed={vi.fn()} onReviewDecisionProcessed={vi.fn()} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("region", { name: "Organiser change requests" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
    expect(getCoordinatorChangeRequests).toHaveBeenCalledWith(REQUEST_ID);
  });
});


describe("SCRUM-402 My events", () => {
  const listed = (id, count) => ({
    ...eventRequest({ id, eventName: `Event ${id}` }), organiserName: "Aisha Rahman", openChangeRequestCount: count,
  });

  it("SCRUM402_AC1_each_event_says_how_many_change_requests_wait", async () => {
    vi.mocked(getMyAssignedEvents).mockResolvedValue([listed("a", 2), listed("b", 1), listed("c", 0), { ...listed("d", 0), openChangeRequestCount: undefined }]);

    render(<MemoryRouter><MyAssignedEvents /></MemoryRouter>);

    expect(await screen.findByText("2 change requests")).toBeInTheDocument();
    expect(screen.getByText("1 change request")).toBeInTheDocument();
    expect(screen.getAllByText(/change requests?$/)).toHaveLength(2);
  });
});
