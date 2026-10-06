// CoordinatorRequestDetailVenueHandoff.test.jsx
//
// SCRUM-254 (part of SCRUM-243). The handoff from an event to venue search now
// carries what "Request this venue" needs: the event's id, status, assigned
// coordinator, period, attendance and requirements. The filters and banner
// copy it already carried (SCRUM-45) are pinned alongside, so the extension
// cannot have changed them.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import CoordinatorRequestDetail from "../../src/components/CoordinatorRequestDetail.jsx";
import { getAssignmentHistoryForReview, getCoordinatorChangeRequests } from "../../src/services/eventRequestService";

const USER_ID = "coordinator-1";

vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: "coordinator-1", role: "event_coordinator" } }),
}));
vi.mock("../../src/services/eventRequestService", () => ({
  getCoordinatorChangeRequests: vi.fn(),
  processCoordinatorChangeRequest: vi.fn(),
  requestEventClarification: vi.fn(),
  getAssignmentHistoryForReview: vi.fn(),
  getAssignmentHistory: vi.fn(),
  listCoordinators: vi.fn(),
  reassignEventRequest: vi.fn(),
}));

const REQUEST = {
  id: "e1",
  eventName: "Industry Night",
  status: "approved",
  assignedCoordinatorId: USER_ID,
  proposedStart: "2026-12-01T09:00:00Z",
  proposedEnd: "2026-12-01T17:00:00Z",
  expectedAttendance: 150,
  venueRequirements: "Tiered seating",
  accessibilityRequirements: "Step-free entrance",
  statusDisplay: { label: "Approved", group: "approved" },
};

function StateProbe() {
  const location = useLocation();
  return (
    <div data-testid="venue-search" data-search={location.search}>
      {JSON.stringify(location.state)}
    </div>
  );
}

async function findVenue(request) {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={["/queue"]}>
      <Routes>
        <Route path="/queue" element={<CoordinatorRequestDetail request={request} />} />
        <Route path="/venue-search" element={<StateProbe />} />
      </Routes>
    </MemoryRouter>,
  );
  await user.click(screen.getByRole("button", { name: "Find a venue for this event" }));
  const probe = await screen.findByTestId("venue-search");
  return { search: probe.dataset.search, state: JSON.parse(probe.textContent) };
}

beforeEach(() => {
  vi.mocked(getCoordinatorChangeRequests).mockReset().mockResolvedValue([]);
  vi.mocked(getAssignmentHistoryForReview).mockReset().mockResolvedValue([]);
});

describe("the handoff to venue search", () => {
  it("SCRUM254_carries_the_event_the_request_button_needs", async () => {
    const { state } = await findVenue(REQUEST);

    expect(state.eventRequestContext).toEqual({
      id: "e1",
      status: "approved",
      assignedCoordinatorId: USER_ID,
      proposedStart: "2026-12-01T09:00:00Z",
      proposedEnd: "2026-12-01T17:00:00Z",
      expectedAttendance: 150,
      accessibilityRequirements: "Step-free entrance",
      eventName: "Industry Night",
      venueRequirements: "Tiered seating",
    });
  });

  it("SCRUM254_still_seeds_the_capacity_filter_and_keeps_the_way_back", async () => {
    const { search, state } = await findVenue(REQUEST);
    expect(search).toBe("?minCapacity=150");
    expect(state.returnToReview.request.id).toBe("e1");
  });

  it("SCRUM254_sends_null_for_what_the_event_does_not_have", async () => {
    const { search, state } = await findVenue({
      id: "e2",
      eventName: "Draft talk",
      status: "approved",
      statusDisplay: REQUEST.statusDisplay,
    });

    expect(search).toBe("");
    expect(state.eventRequestContext).toMatchObject({
      id: "e2",
      assignedCoordinatorId: null,
      proposedStart: null,
      proposedEnd: null,
      expectedAttendance: null,
      accessibilityRequirements: null,
      venueRequirements: null,
    });
  });
});
