// scrum379CoordinatorCompletion.test.jsx
//
// SCRUM-384 (SCRUM-379 AC1, AC2, AC3): the coordinator's event screen. "Mark as completed" is
// offered to the assigned coordinator of a Confirmed event that has ended and nobody else; it opens
// the completion panel; and a completed event shows its closing notes to coordinators only. The
// Organiser's list is checked too: whatever it is given, it never renders closing notes.
//
// Time is pinned with a fake Date, so "has ended" does not depend on when the suite runs. Every
// function the detail's tree reaches is on the strict mock, as in CoordinatorRequestDetail.test.jsx.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import CoordinatorRequestDetail from "../../src/components/CoordinatorRequestDetail.jsx";
import MyEventRequests from "../../src/components/MyEventRequests.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import {
  completeEventRequest,
  getAssignmentHistory,
  getAssignmentHistoryForReview,
  getConfirmedArrangements,
  getCoordinatorChangeRequests,
  getEventClarificationHistory,
  getEventDecisionHistory,
  getMyEventRequests,
} from "../../src/services/eventRequestService";

vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../../src/services/eventRequestService", () => ({
  closeEventClarification: vi.fn(),
  completeEventRequest: vi.fn(),
  getEventDecisionHistory: vi.fn(() => Promise.resolve([])),
  getEventChangeHistory: vi.fn(() => Promise.resolve([])),
  updateEventRequestDetails: vi.fn(),
  cancelEventRequest: vi.fn(),
  createEventRequest: vi.fn(),
  decideEventRequest: vi.fn(),
  getAssignmentHistory: vi.fn(),
  getAssignmentHistoryForReview: vi.fn(),
  getConfirmedArrangements: vi.fn(),
  getCoordinatorChangeRequests: vi.fn(),
  getEventCancellationImpact: vi.fn(),
  getEventClarificationHistory: vi.fn(),
  getEventReadiness: vi.fn(),
  getMyEventRequests: vi.fn(),
  listCoordinators: vi.fn(),
  listCoordinatorWorkload: vi.fn(),
  processCoordinatorChangeRequest: vi.fn(),
  previewSignificantEventChange: vi.fn(),
  applySignificantEventChange: vi.fn(),
  reassignEventRequest: vi.fn(),
  requestEventClarification: vi.fn(),
  respondToEventClarification: vi.fn(),
  startEventReview: vi.fn(),
  submitEventRequest: vi.fn(),
  updateEventRequest: vi.fn(),
}));

vi.mock("../../src/services/venueService", () => ({
  findVenuesForEvent: vi.fn(),
}));

vi.mock("../../src/services/bookingRequestService", () => ({
  createBookingRequest: vi.fn(),
}));

vi.mock("../../src/services/venueSuitabilityService", () => ({
  checkVenueSuitability: vi.fn(),
  getEventVenueSuitability: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../../src/services/flaggedBookingService", () => ({
  getEventFlaggedBookings: vi.fn(() => Promise.resolve([])),
  cancelFlaggedBooking: vi.fn(),
}));

const NOW = new Date("2030-06-15T09:00:00Z");
const at = (seconds) => new Date(NOW.getTime() + seconds * 1000).toISOString();

const ASSIGNED = "44444444-4444-4444-8444-444444444444";
const OTHER = "66666666-6666-4666-8666-666666666666";
const ORGANISER = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

const COORDINATOR_USER = { id: ASSIGNED, role: "event_coordinator" };
const OTHER_COORDINATOR_USER = { id: OTHER, role: "event_coordinator" };
const LEAD_USER = { id: OTHER, role: "event_coordinator_lead" };

const DISPLAY = {
  confirmed: { label: "Confirmed", group: "CONFIRMED", description: "Going ahead." },
  completed: { label: "Completed", group: "COMPLETED", description: "This event took place." },
};

const SECRET = "Two attendees complained about the venue.";

function eventRequest(overrides = {}) {
  const status = overrides.status ?? "confirmed";
  return {
    id: REQUEST_ID,
    organiserId: ORGANISER,
    eventName: "IS212 Industry Night",
    purpose: "Connect students with industry.",
    description: "Talks, then networking.",
    // Ended an hour ago; 09:00 to 11:00 in Singapore would be 01:00 to 03:00 UTC.
    proposedStart: at(-3 * 3600),
    proposedEnd: at(-3600),
    expectedAttendance: 80,
    status,
    assignedCoordinatorId: ASSIGNED,
    updatedAt: "2026-10-20T03:00:00Z",
    statusDisplay: DISPLAY[status] ?? { label: status, group: "UNKNOWN", description: "" },
    ...overrides,
  };
}

function detailUi(request, props) {
  return (
    <MemoryRouter>
      <CoordinatorRequestDetail request={request} onReviewDecisionProcessed={vi.fn()} {...props} />
    </MemoryRouter>
  );
}

function renderDetail(user, request = eventRequest(), props = {}) {
  vi.mocked(useAuth).mockReturnValue({ user });
  const utils = render(detailUi(request, props));
  return { user: userEvent.setup(), ...utils, rerenderWith: (next) => utils.rerender(detailUi(next, props)) };
}

const markButton = () => screen.queryByRole("button", { name: "Mark as completed" });
const closingNotesSection = () => screen.queryByRole("heading", { name: "Closing notes" });
const refusal = (status, data = {}) => Object.assign(new Error("request failed"), { response: { status, data } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.mocked(completeEventRequest).mockReset();
  vi.mocked(getCoordinatorChangeRequests).mockResolvedValue([]);
  vi.mocked(getAssignmentHistory).mockResolvedValue([]);
  vi.mocked(getAssignmentHistoryForReview).mockResolvedValue([]);
  vi.mocked(getEventClarificationHistory).mockResolvedValue([]);
  vi.mocked(getEventDecisionHistory).mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SCRUM379 AC4: a change request closed by the completion", () => {
  const changeRequest = (decision, overrides = {}) => ({
    id: "c1", fieldLabel: "Something else", details: "ZZ change", status: "processed", decision, decisionNotes: null,
    createdAt: "2030-06-01T03:00:00Z", ...overrides,
  });

  it("SCRUM379_AC4_the_coordinators_panel_says_closed_event_completed_not_rejected", async () => {
    vi.mocked(getCoordinatorChangeRequests).mockResolvedValue([changeRequest("event_completed")]);
    renderDetail(COORDINATOR_USER, eventRequest({ status: "completed" }));

    expect(await screen.findByText("Outcome: Closed, event completed")).toBeInTheDocument();
    expect(screen.queryByText("Outcome: Rejected")).not.toBeInTheDocument();
  });

  it.each([
    ["approved", "Outcome: Approved"],
    ["rejected", "Outcome: Rejected"],
    ["event_cancelled", "Outcome: Closed, event cancelled"],
    ["event_rejected", "Outcome: Closed, event rejected"],
  ])("SCRUM379_AC4_the_coordinators_panel_still_words_%s_correctly", async (decision, label) => {
    vi.mocked(getCoordinatorChangeRequests).mockResolvedValue([changeRequest(decision)]);
    renderDetail(COORDINATOR_USER, eventRequest({ status: "completed" }));

    expect(await screen.findByText(label)).toBeInTheDocument();
  });
});

describe("SCRUM379 when Mark as completed is offered", () => {
  it("SCRUM379_AC1_the_assigned_coordinator_sees_it_on_a_confirmed_event_that_has_ended", () => {
    renderDetail(COORDINATOR_USER);

    expect(markButton()).toBeInTheDocument();
  });

  it("SCRUM379_AC1_it_is_offered_the_moment_the_end_time_arrives", () => {
    renderDetail(COORDINATOR_USER, eventRequest({ proposedEnd: at(0) }));

    expect(markButton()).toBeInTheDocument();
  });

  it("SCRUM379_AC1_it_is_not_offered_one_second_before_the_end_time", () => {
    renderDetail(COORDINATOR_USER, eventRequest({ proposedEnd: at(1) }));

    expect(markButton()).not.toBeInTheDocument();
  });

  it("SCRUM379_AC1_before_the_event_ends_the_coordinator_is_told_when_it_can_be_done_in_singapore_time", () => {
    // 2030-06-15T10:00:00Z is 18:00 in Singapore.
    renderDetail(COORDINATOR_USER, eventRequest({ proposedStart: at(-3600), proposedEnd: "2030-06-15T10:00:00Z" }));

    expect(markButton()).not.toBeInTheDocument();
    expect(screen.getByText(/You can mark this event as completed once it has ended \(2030-06-15 18:00 \(Singapore time\)\)\./)).toBeInTheDocument();
  });

  it("SCRUM379_AC1_an_event_with_no_end_time_is_not_offered_and_the_hint_names_no_time", () => {
    renderDetail(COORDINATOR_USER, eventRequest({ proposedStart: null, proposedEnd: null }));

    expect(markButton()).not.toBeInTheDocument();
    expect(screen.getByText("You can mark this event as completed once it has ended.")).toBeInTheDocument();
  });

  it("SCRUM379_AC1_another_coordinator_is_not_offered_it_and_gets_no_hint", () => {
    renderDetail(OTHER_COORDINATOR_USER);

    expect(markButton()).not.toBeInTheDocument();
    expect(screen.queryByText(/once it has ended/)).not.toBeInTheDocument();
  });

  it("SCRUM379_AC1_the_lead_is_not_offered_it", () => {
    renderDetail(LEAD_USER);

    expect(markButton()).not.toBeInTheDocument();
    expect(screen.queryByText(/once it has ended/)).not.toBeInTheDocument();
  });

  it("SCRUM379_AC1_the_lead_who_is_the_assigned_id_still_is_not_offered_it", () => {
    renderDetail({ id: ASSIGNED, role: "event_coordinator_lead" });

    expect(markButton()).not.toBeInTheDocument();
  });

  it.each(["venue_staff", "technical_support_staff", "attendee", "event_organiser", "safety_officer"])(
    "SCRUM379_AC1_%s_is_not_offered_it",
    (role) => {
      renderDetail({ id: ASSIGNED, role });

      expect(markButton()).not.toBeInTheDocument();
    },
  );

  it("SCRUM379_AC1_a_signed_out_viewer_is_not_offered_it", () => {
    renderDetail(null);

    expect(markButton()).not.toBeInTheDocument();
  });

  it.each([
    "submitted", "under_review", "pending_clarification", "approved", "safety_review",
    "safety_approved", "cancelled", "rejected",
  ])("SCRUM379_AC1_a_%s_event_that_has_ended_is_not_offered_it", (status) => {
    renderDetail(COORDINATOR_USER, eventRequest({ status }));

    expect(markButton()).not.toBeInTheDocument();
    expect(screen.queryByText(/once it has ended/)).not.toBeInTheDocument();
  });

  it("SCRUM379_AC3_a_completed_event_offers_no_actions_at_all", () => {
    renderDetail(COORDINATOR_USER, eventRequest({ status: "completed", closingNotes: null }));

    for (const name of ["Mark as completed", "Cancel event", "Revise event details", "Edit event information", "Reject event"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByText(/once it has ended/)).not.toBeInTheDocument();
  });
});

describe("SCRUM379 completing from the event screen", () => {
  async function openPanel(harness) {
    await harness.user.click(markButton());
  }

  it("SCRUM379_AC1_the_button_opens_the_completion_panel_in_place_of_the_event", async () => {
    const harness = renderDetail(COORDINATOR_USER);

    await openPanel(harness);

    expect(screen.getByRole("heading", { level: 1, name: "Mark IS212 Industry Night as completed" })).toBeInTheDocument();
    expect(screen.queryByText("The request")).not.toBeInTheDocument();
    expect(completeEventRequest).not.toHaveBeenCalled();
  });

  it("SCRUM379_AC1_back_returns_to_the_event_without_completing_it", async () => {
    const harness = renderDetail(COORDINATOR_USER);
    await openPanel(harness);

    await harness.user.click(screen.getByRole("button", { name: "Back to event" }));

    expect(screen.getByRole("heading", { level: 2, name: /IS212 Industry Night/ })).toBeInTheDocument();
    expect(markButton()).toBeInTheDocument();
    expect(completeEventRequest).not.toHaveBeenCalled();
  });

  it("SCRUM379_AC1_completing_with_notes_shows_a_completed_event_with_the_notes_and_tells_the_list", async () => {
    vi.mocked(completeEventRequest).mockResolvedValue(eventRequest({ status: "completed", closingNotes: "Attendance 180." }));
    const onChangeRequestProcessed = vi.fn();
    const harness = renderDetail(COORDINATOR_USER, eventRequest(), { onChangeRequestProcessed });
    await openPanel(harness);

    await harness.user.type(screen.getByLabelText("Closing notes (optional)"), "Attendance 180.");
    await harness.user.click(screen.getByRole("button", { name: "Continue" }));
    await harness.user.click(screen.getByRole("button", { name: "Yes, mark as completed" }));

    expect(await screen.findByText("Completed", { selector: ".status-badge" })).toBeInTheDocument();
    expect(completeEventRequest).toHaveBeenCalledExactlyOnceWith(REQUEST_ID, { closingNotes: "Attendance 180." });
    expect(screen.getByRole("status")).toHaveTextContent("Marked as completed.");
    expect(closingNotesSection()).toBeInTheDocument();
    expect(screen.getByText("Attendance 180.")).toBeInTheDocument();
    expect(markButton()).not.toBeInTheDocument();
    expect(onChangeRequestProcessed).toHaveBeenCalledTimes(1);
  });

  it("SCRUM379_AC2_completing_without_notes_says_none_were_recorded", async () => {
    vi.mocked(completeEventRequest).mockResolvedValue(eventRequest({ status: "completed", closingNotes: null }));
    const harness = renderDetail(COORDINATOR_USER);
    await openPanel(harness);

    await harness.user.click(screen.getByRole("button", { name: "Continue" }));
    await harness.user.click(screen.getByRole("button", { name: "Yes, mark as completed" }));

    expect(await screen.findByText("No closing notes were recorded.")).toBeInTheDocument();
    expect(completeEventRequest).toHaveBeenCalledExactlyOnceWith(REQUEST_ID, { closingNotes: "" });
  });

  it("SCRUM379_AC3_an_event_already_final_shows_the_servers_message_and_stays_on_the_panel", async () => {
    const message = "This event is cancelled and can no longer be changed";
    vi.mocked(completeEventRequest).mockRejectedValue(refusal(409, { error: message, code: "EVENT_FINAL" }));
    const onChangeRequestProcessed = vi.fn();
    const harness = renderDetail(COORDINATOR_USER, eventRequest(), { onChangeRequestProcessed });
    await openPanel(harness);

    await harness.user.click(screen.getByRole("button", { name: "Continue" }));
    await harness.user.click(screen.getByRole("button", { name: "Yes, mark as completed" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(onChangeRequestProcessed).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("SCRUM379_AC1_the_completed_notice_belongs_to_the_event_it_was_done_on", async () => {
    vi.mocked(completeEventRequest).mockResolvedValue(eventRequest({ status: "completed", closingNotes: null }));
    const harness = renderDetail(COORDINATOR_USER);
    await openPanel(harness);
    await harness.user.click(screen.getByRole("button", { name: "Continue" }));
    await harness.user.click(screen.getByRole("button", { name: "Yes, mark as completed" }));
    await screen.findByRole("status");

    harness.rerenderWith(eventRequest({
      id: "99999999-9999-4999-8999-999999999999", status: "completed", eventName: "Another event", closingNotes: null,
    }));

    expect(screen.queryByText("Marked as completed.")).not.toBeInTheDocument();
  });
});

describe("SCRUM379 closing notes on a completed event", () => {
  const completed = (overrides = {}) => eventRequest({ status: "completed", closingNotes: SECRET, ...overrides });

  it("SCRUM379_AC2_the_assigned_coordinator_sees_the_notes_and_who_can_see_them", () => {
    renderDetail(COORDINATOR_USER, completed());

    const section = closingNotesSection().closest("section");
    expect(within(section).getByText(SECRET)).toBeInTheDocument();
    expect(within(section).getByText("Only coordinators can see these notes. The organiser cannot.")).toBeInTheDocument();
  });

  it("SCRUM379_AC2_another_coordinator_sees_the_notes", () => {
    renderDetail(OTHER_COORDINATOR_USER, completed());

    expect(screen.getByText(SECRET)).toBeInTheDocument();
  });

  it("SCRUM379_AC2_the_lead_sees_the_notes", () => {
    renderDetail(LEAD_USER, completed());

    expect(screen.getByText(SECRET)).toBeInTheDocument();
  });

  it("SCRUM379_AC2_line_breaks_in_the_notes_are_kept", () => {
    renderDetail(COORDINATOR_USER, completed({ closingNotes: "Line one\n\nLine two" }));

    const paragraph = screen.getByText(/Line one/);
    expect(paragraph.textContent).toBe("Line one\n\nLine two");
    expect(paragraph.closest("section")).toHaveClass("coordinator-request-detail__closing-notes");
  });

  it("SCRUM379_AC2_a_completed_event_with_no_notes_says_none_were_recorded", () => {
    renderDetail(COORDINATOR_USER, completed({ closingNotes: null }));

    expect(screen.getByText("No closing notes were recorded.")).toBeInTheDocument();
  });

  it("SCRUM379_AC2_a_blank_note_reads_as_none_recorded", () => {
    renderDetail(COORDINATOR_USER, completed({ closingNotes: "   " }));

    expect(screen.getByText("No closing notes were recorded.")).toBeInTheDocument();
  });

  it("SCRUM379_AC2_a_completed_event_whose_row_has_no_notes_field_claims_nothing", () => {
    const row = completed();
    delete row.closingNotes;
    renderDetail(COORDINATOR_USER, row);

    expect(closingNotesSection()).not.toBeInTheDocument();
    expect(screen.queryByText("No closing notes were recorded.")).not.toBeInTheDocument();
  });

  it.each(["venue_staff", "technical_support_staff", "attendee", "event_organiser", "safety_officer"])(
    "SCRUM379_AC2_%s_never_sees_the_notes_even_if_the_row_carries_them",
    (role) => {
      renderDetail({ id: OTHER, role }, completed());

      expect(closingNotesSection()).not.toBeInTheDocument();
      expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    },
  );

  it("SCRUM379_AC2_a_signed_out_viewer_never_sees_the_notes", () => {
    renderDetail(null, completed());

    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });

  it.each(["confirmed", "approved", "cancelled", "rejected"])(
    "SCRUM379_AC2_a_%s_event_shows_no_notes_section_even_if_the_row_carries_notes",
    (status) => {
      renderDetail(COORDINATOR_USER, eventRequest({ status, closingNotes: SECRET }));

      expect(closingNotesSection()).not.toBeInTheDocument();
      expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    },
  );

  it("SCRUM379_AC2_a_refetched_row_replaces_the_completion_response_and_still_shows_the_notes", async () => {
    vi.mocked(completeEventRequest).mockResolvedValue(completed({ closingNotes: "From the response" }));
    const harness = renderDetail(COORDINATOR_USER);
    await harness.user.click(markButton());
    await harness.user.click(screen.getByRole("button", { name: "Continue" }));
    await harness.user.click(screen.getByRole("button", { name: "Yes, mark as completed" }));
    await screen.findByText("From the response");

    harness.rerenderWith(completed({ closingNotes: "From the list" }));

    expect(await screen.findByText("From the list")).toBeInTheDocument();
    expect(screen.queryByText("From the response")).not.toBeInTheDocument();
  });
});

describe("SCRUM379 the Organiser never sees closing notes", () => {
  const ORGANISER_USER = { id: ORGANISER, role: "event_organiser" };

  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({ user: ORGANISER_USER });
    vi.mocked(getConfirmedArrangements).mockResolvedValue({ venueBookings: [], equipment: [] });
  });

  it("SCRUM379_AC2_the_organisers_list_shows_the_completed_event_and_not_notes_it_was_wrongly_given", async () => {
    vi.mocked(getMyEventRequests).mockResolvedValue([
      eventRequest({ status: "completed", closingNotes: SECRET, closing_notes: SECRET }),
    ]);

    const { container } = render(<MemoryRouter><MyEventRequests /></MemoryRouter>);

    expect(await screen.findByText("IS212 Industry Night")).toBeInTheDocument();
    expect(screen.getByText("Completed", { selector: ".status-badge" })).toBeInTheDocument();
    expect(container.textContent).not.toContain(SECRET);
    expect(screen.queryByText(/Closing notes/i)).not.toBeInTheDocument();
  });

  it("SCRUM379_AC2_the_organisers_list_has_no_mark_as_completed_action", async () => {
    vi.mocked(getMyEventRequests).mockResolvedValue([eventRequest({ status: "confirmed" })]);

    render(<MemoryRouter><MyEventRequests /></MemoryRouter>);

    await screen.findByText("IS212 Industry Night");
    await waitFor(() => expect(screen.queryByText("Loading...")).not.toBeInTheDocument());
    expect(markButton()).not.toBeInTheDocument();
  });
});
