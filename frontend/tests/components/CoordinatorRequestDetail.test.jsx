// CoordinatorRequestDetail.test.jsx
//
// SCRUM-141 (SCRUM-20 AC2): the coordinator's event view now carries the venue
// search itself. "Find a venue" is EventVenueFinder pre-filled from this
// event, replacing SCRUM-45's button that navigated to
// /venue-search?minCapacity=. A plain "Browse all venues" link remains.
//
// Only this panel's share is tested here; EventVenueFinder.test.jsx covers
// the form itself. Every service the panel's tree reaches is mocked, and
// useAuth is mocked so no AuthProvider (and no Supabase) is needed.
//
// Timezone-proof: the finder shows Singapore (venue) time on every device, so
// expected input values are the Singapore wall clock as literals, and the
// suite passes unchanged under TZ=UTC, Asia/Singapore and America/New_York.
// Date inputs are set with fireEvent.change.
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
// SCRUM-192 (SCRUM-188 AC6): the "Venue suitability" section, its place in
// the view, and when it rechecks. EventVenueSuitability.test.jsx covers what
// it shows.
//
// SCRUM-266: the "Flagged bookings" section above Venue suitability, the
// Needs attention badge, and requesting a replacement through Find a venue.
// EventFlaggedBookings.test.jsx covers what the section shows.
//
// What these tests do not prove: that the server refuses the wrong person or
// the wrong status. The screen's checks are a convenience; the backend tests
// and the live checks against migration 029 prove the gate.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { formatVenuePeriod } from "../../src/services/datetimeFormat.js";

import CoordinatorRequestDetail from "../../src/components/CoordinatorRequestDetail.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import {
  decideEventRequest,
  getAssignmentHistoryForReview,
  getCoordinatorChangeRequests,
  getEventCancellationImpact,
  getEventClarificationHistory,
  listCoordinatorWorkload,
  listCoordinators,
  reassignEventRequest,
  requestEventClarification,
  startEventReview,
} from "../../src/services/eventRequestService";
import { findVenuesForEvent } from "../../src/services/venueService";
import { createBookingRequest } from "../../src/services/bookingRequestService";
import { getEventVenueSuitability } from "../../src/services/venueSuitabilityService";
import { cancelFlaggedBooking, getEventFlaggedBookings } from "../../src/services/flaggedBookingService";

vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../../src/services/eventRequestService", () => ({
  closeEventClarification: vi.fn(),
  cancelEventRequest: vi.fn(),
  decideEventRequest: vi.fn(),
  getAssignmentHistory: vi.fn(),
  getAssignmentHistoryForReview: vi.fn(),
  getCoordinatorChangeRequests: vi.fn(),
  getEventCancellationImpact: vi.fn(),
  getEventClarificationHistory: vi.fn(),
  listCoordinators: vi.fn(),
  // SCRUM-521: the handover panel reads this one when the caller is a Lead.
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

// SCRUM-192: "Venue suitability" rechecks the event's venues when it mounts,
// for the assigned coordinator. EventVenueFinder's panel imports the other
// function, so both are on the strict mock.
vi.mock("../../src/services/venueSuitabilityService", () => ({
  checkVenueSuitability: vi.fn(),
  getEventVenueSuitability: vi.fn(),
}));

// SCRUM-266: "Flagged bookings" loads when the assigned coordinator opens it.
vi.mock("../../src/services/flaggedBookingService", () => ({
  getEventFlaggedBookings: vi.fn(),
  cancelFlaggedBooking: vi.fn(),
}));

const COORDINATOR = { id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", role: "event_coordinator" };

// Wednesday 11 November 2026, 10:00-12:00 Singapore.
const START_ISO = "2026-11-11T10:00:00+08:00";
const END_ISO = "2026-11-11T12:00:00+08:00";

const EVENT = Object.freeze({
  id: "e1",
  eventName: "Tech Talk",
  status: "submitted",
  purpose: "Talk",
  proposedStart: START_ISO,
  proposedEnd: END_ISO,
  expectedAttendance: 80,
  venueRequirements: "A large room",
  organiserName: "Olive Organiser",
  assignedCoordinatorId: COORDINATOR.id,
  submittedAt: "2026-10-01T09:00:00+08:00",
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function VenueSearchProbe() {
  const location = useLocation();
  return <div data-testid="venue-search">{`${location.pathname}${location.search}`}</div>;
}

function ui(request) {
  return (
    <MemoryRouter initialEntries={["/coordinator"]}>
      <Routes>
        <Route
          path="/coordinator"
          element={
            <>
              <CoordinatorRequestDetail request={request} />
              <LocationProbe />
            </>
          }
        />
        <Route path="/venue-search" element={<VenueSearchProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

function renderDetail(request = EVENT) {
  const user = userEvent.setup();
  const utils = render(ui(request));
  return { user, ...utils, rerenderWith: (next) => utils.rerender(ui(next)) };
}

/** The "Find a venue" section, so the panel's other inputs never match. */
function finderSection() {
  return screen.getByRole("heading", { name: "Find a venue" }).closest("section");
}

const inFinder = {
  date: () => within(finderSection()).getByLabelText("Date"),
  start: () => within(finderSection()).getByLabelText("Start"),
  end: () => within(finderSection()).getByLabelText("End"),
  attendance: () => within(finderSection()).getByLabelText("Expected attendance"),
  location: () => within(finderSection()).getByLabelText("Location"),
};

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
  vi.mocked(useAuth).mockReturnValue({ user: COORDINATOR });
  vi.mocked(startEventReview).mockReset();
  vi.mocked(decideEventRequest).mockReset();
  vi.mocked(requestEventClarification).mockReset();
  vi.mocked(getCoordinatorChangeRequests).mockReset();
  vi.mocked(getCoordinatorChangeRequests).mockResolvedValue([]);
  vi.mocked(getEventCancellationImpact).mockReset();
  vi.mocked(getAssignmentHistoryForReview).mockReset();
  vi.mocked(getAssignmentHistoryForReview).mockResolvedValue([]);
  vi.mocked(findVenuesForEvent).mockReset();
  vi.mocked(findVenuesForEvent).mockResolvedValue([]);
  vi.mocked(createBookingRequest).mockReset();
  vi.mocked(getEventVenueSuitability).mockReset();
  vi.mocked(getEventVenueSuitability).mockResolvedValue([]);
  vi.mocked(getEventFlaggedBookings).mockReset();
  vi.mocked(getEventFlaggedBookings).mockResolvedValue([]);
  vi.mocked(cancelFlaggedBooking).mockReset();
  // ClarificationHistory calls .then() on this the moment it mounts, so it
  // has to hand back a promise, not undefined.
  vi.mocked(getEventClarificationHistory).mockReset();
  vi.mocked(getEventClarificationHistory).mockResolvedValue([]);
});

describe("SCRUM-375 coordinator cancellation page", () => {
  it("replaces the event detail with a full cancellation page", async () => {
    const user = userEvent.setup();
    renderAs(ASSIGNED, eventRequest({ status: "approved" }));

    await user.click(screen.getByRole("button", { name: "Cancel event" }));

    expect(screen.getByRole("heading", { name: "Cancel IS212 Industry Night" })).toBeInTheDocument();
    expect(screen.getByText(/Review the arrangements this will affect before confirming/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "The request" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Find a venue" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to event" })).toBeInTheDocument();
  });
});

describe("SCRUM-561 cancel an event in a safety status", () => {
  it.each(["safety_review", "safety_approved"])(
    "SCRUM561_AC3_the_assigned_coordinator_sees_Cancel_event_for_%s",
    (status) => {
      renderAs(ASSIGNED, eventRequest({ status, decision: "approved" }));

      expect(screen.getByRole("button", { name: "Cancel event" })).toBeInTheDocument();
    },
  );

  it.each(["safety_review", "safety_approved"])(
    "SCRUM561_AC3_another_coordinator_does_not_see_Cancel_event_for_%s",
    (status) => {
      renderAs(OTHER, eventRequest({ status, decision: "approved" }));

      expect(screen.queryByRole("button", { name: "Cancel event" })).not.toBeInTheDocument();
    },
  );

  it("SCRUM561_AC3_opening_Cancel_event_from_safety_review_shows_the_cancellation_page", async () => {
    const user = userEvent.setup();
    renderAs(ASSIGNED, eventRequest({ status: "safety_review", decision: "approved" }));

    await user.click(screen.getByRole("button", { name: "Cancel event" }));

    expect(screen.getByRole("heading", { name: "Cancel IS212 Industry Night" })).toBeInTheDocument();
  });
});

describe("SCRUM20_AC2 the event view holds the venue search", () => {
  it("SCRUM20_AC2_find_a_venue_renders_the_form_prefilled_from_the_event", async () => {
    renderDetail();

    expect(screen.getByRole("heading", { name: "Find a venue" })).toBeInTheDocument();
    expect(inFinder.date()).toHaveValue("2026-11-11");
    expect(inFinder.start()).toHaveValue("10:00");
    expect(inFinder.end()).toHaveValue("12:00");
    expect(inFinder.attendance()).toHaveValue(80);
    expect(within(finderSection()).getByRole("button", { name: "Search venues" })).toBeInTheDocument();
    await waitFor(() => expect(getCoordinatorChangeRequests).toHaveBeenCalledWith("e1"));
  });

  it("SCRUM20_AC2_opening_the_event_sends_no_search", async () => {
    renderDetail();

    await waitFor(() => expect(getCoordinatorChangeRequests).toHaveBeenCalled());
    expect(findVenuesForEvent).not.toHaveBeenCalled();
  });

  it("SCRUM20_AC2_the_old_navigate_button_is_gone", () => {
    renderDetail();

    expect(screen.queryByRole("button", { name: /Find a venue for this event/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Venue search will open filtered/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/venue search opens unfiltered/i)).not.toBeInTheDocument();
  });

  it("SCRUM20_AC2_browse_all_venues_links_to_venue_search_without_filters", async () => {
    const { user } = renderDetail();

    const link = within(finderSection()).getByRole("link", { name: "Browse all venues" });
    expect(link).toHaveAttribute("href", "/venue-search");

    await user.click(link);
    expect(screen.getByTestId("venue-search")).toHaveTextContent(/^\/venue-search$/);
  });

  it("SCRUM20_AC2_searching_stays_on_the_event_view", async () => {
    vi.mocked(findVenuesForEvent).mockResolvedValue([{ id: "v1", name: "Hall A" }]);
    const { user } = renderDetail();

    await user.click(within(finderSection()).getByRole("button", { name: "Search venues" }));

    expect(await within(finderSection()).findByRole("list", { name: "Matching venues" }))
      .toHaveTextContent("Hall A");
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/coordinator$/);
    expect(screen.queryByTestId("venue-search")).not.toBeInTheDocument();
    expect(findVenuesForEvent).toHaveBeenCalledTimes(1);
    expect(findVenuesForEvent.mock.calls[0][0].expectedAttendance).toBe(80);
  });

  it("SCRUM20_AC2_an_event_with_no_attendance_leaves_the_field_empty", () => {
    renderDetail({ ...EVENT, expectedAttendance: null });

    expect(inFinder.attendance()).toHaveValue(null);
    // The Requirements list still says so in words.
    expect(screen.queryByText(/null people/)).not.toBeInTheDocument();
  });
});

describe("SCRUM20_AC2 re-seeding when the event changes", () => {
  it("SCRUM20_AC2_a_different_event_reseeds_the_form", () => {
    const { rerenderWith } = renderDetail();
    fireEvent.change(inFinder.attendance(), { target: { value: "150" } });

    rerenderWith({ ...EVENT, id: "e2", eventName: "Gala", expectedAttendance: 30 });

    expect(inFinder.attendance()).toHaveValue(30);
  });

  it("SCRUM20_AC2_a_changed_attendance_reseeds_the_form", () => {
    // An approved change request moved the attendance: the edit is dropped
    // rather than shown as if it were the event's figure.
    const { rerenderWith } = renderDetail();
    fireEvent.change(inFinder.attendance(), { target: { value: "150" } });
    fireEvent.change(inFinder.location(), { target: { value: "Level 2" } });

    rerenderWith({ ...EVENT, expectedAttendance: 200 });

    expect(inFinder.attendance()).toHaveValue(200);
    expect(inFinder.location()).toHaveValue("");
  });

  it("SCRUM20_AC2_a_changed_start_reseeds_the_form", () => {
    const { rerenderWith } = renderDetail();
    fireEvent.change(inFinder.attendance(), { target: { value: "150" } });

    const movedStart = "2026-11-11T11:00:00+08:00";
    rerenderWith({ ...EVENT, proposedStart: movedStart });

    expect(inFinder.start()).toHaveValue("11:00");
    expect(inFinder.attendance()).toHaveValue(80);
  });

  it("SCRUM20_AC2_a_changed_end_reseeds_the_form", () => {
    const { rerenderWith } = renderDetail();
    fireEvent.change(inFinder.attendance(), { target: { value: "150" } });

    const movedEnd = "2026-11-11T11:30:00+08:00";
    rerenderWith({ ...EVENT, proposedEnd: movedEnd });

    expect(inFinder.end()).toHaveValue("11:30");
    expect(inFinder.attendance()).toHaveValue(80);
  });

  it("SCRUM20_AC2_a_refresh_with_the_same_values_keeps_the_edits", () => {
    // The parent refetches after a change request is processed; if the event's
    // period and attendance did not move, the coordinator's edits stay.
    const { rerenderWith } = renderDetail();
    fireEvent.change(inFinder.attendance(), { target: { value: "150" } });
    fireEvent.change(inFinder.location(), { target: { value: "Level 2" } });
    fireEvent.change(inFinder.date(), { target: { value: "2026-11-12" } });

    rerenderWith({ ...EVENT, status: "under_review", purpose: "Updated purpose" });

    expect(inFinder.attendance()).toHaveValue(150);
    expect(inFinder.location()).toHaveValue("Level 2");
    expect(inFinder.date()).toHaveValue("2026-11-12");
  });
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

  it("SCRUM486_AC8_a_409_on_start_review_says_it_may_be_waiting_for_the_lead", async () => {
    // AC8-05. Since migration 052, starting the review of a request with no
    // coordinator is refused with 409 (55000), not 403. The 409 entry names
    // both of its causes, the Lead's assignment among them; the screen does
    // not read the server's message to choose between them.
    vi.mocked(startEventReview).mockRejectedValue(httpError(409));
    const user = userEvent.setup();
    renderAs(ASSIGNED, eventRequest());

    await user.click(await screen.findByRole("button", { name: "Start review" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/waiting for the Event Coordinator Lead to assign it a coordinator/);
    expect(alert).toHaveTextContent(/no longer be waiting to be reviewed/);
    expect(alert).not.toHaveTextContent(/no longer assigned to you/);
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

  it.each([
    ["the coordinator who used to hold it", ASSIGNED],
    ["any other coordinator", OTHER],
  ])("SCRUM486_AC8_an_unassigned_request_opened_by_%s_says_it_is_waiting_for_the_lead", async (_label, viewer) => {
    // AC8-04. Since 052 a submitted request can have no coordinator; any
    // coordinator can still open it by id (SCRUM-332). "Waiting for the
    // assigned coordinator" would name nobody, so it says who it is waiting
    // for, and nobody is offered Start review, which 052 would refuse.
    renderAs(viewer, eventRequest({ assignedCoordinatorId: null }));

    expect(
      await screen.findByText("Waiting for the Event Coordinator Lead to assign this request to a coordinator."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Waiting for the assigned coordinator to start the review.")).not.toBeInTheDocument();
    expect(actionButtonsShown()).toEqual([]);
    expect(screen.queryByRole("button", { name: /hand over|reassign/i })).not.toBeInTheDocument();
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

  it.each([
    ["safety_review", "Safety check", "UNDER_REVIEW", "A Safety Officer is checking the arrangements for your event before it can be confirmed."],
    ["safety_approved", "Safety approved", "APPROVED", "The safety check is complete. Your Coordinator can now confirm your event."],
  ])("SCRUM488_AC6_an_event_in_%s_opens_with_its_label_and_its_approval_and_no_decision_actions", async (status, label, group, description) => {
    // A seeded event: the safety actions belong to SCRUM-489 and SCRUM-490, so
    // this screen offers nothing to decide, as for every status past approval.
    renderAs(ASSIGNED, eventRequest({
      status,
      statusDisplay: { status, label, group, description },
      decision: "approved",
      decisionNote: null,
      decidedBy: ASSIGNED,
      decidedAt: "2026-01-15T09:00:00+08:00",
    }));

    const heading = screen.getByRole("heading", { name: new RegExp(`IS212 Industry Night\\s*${label}`) });
    expect(within(heading).getByText(label)).toHaveClass("status-badge");
    expect(screen.getByText(description)).toBeInTheDocument();
    if (status === "safety_approved") {
      expect(screen.getByText("Safety approval complete").closest(".safety-approval-notice"))
        .toHaveTextContent("A Safety Officer has approved the event arrangements.");
    } else {
      expect(screen.queryByText("Safety approval complete")).not.toBeInTheDocument();
    }
    expect(screen.queryByText(status)).not.toBeInTheDocument();
    expect(screen.queryByText("Waiting for organiser reply")).not.toBeInTheDocument();
    expect(actionButtonsShown()).toEqual([]);
    const record = (await screen.findByText("Outcome")).closest("dl");
    expect(within(record).getByText("Approved")).toBeInTheDocument();
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

// SCRUM-254: the finder's results offer "Request this venue", fed the request
// as this panel last saw it change, so approving here makes it available
// straight away.
describe("SCRUM254 requesting a venue from the event view", () => {
  const HALL = { id: "v1", name: "Hall A", location: "Level 2", maxCapacity: 200 };
  // eventRequest()'s future() start and end are the same instant, which the
  // finder refuses to search, so these carry a real two-hour period.
  const PERIOD = { proposedStart: START_ISO, proposedEnd: END_ISO };

  async function searchInFinder(user) {
    await user.click(within(finderSection()).getByRole("button", { name: "Search venues" }));
    return within(finderSection()).findByRole("button", { name: "Request this venue: Hall A" });
  }

  it("SCRUM254_approving_here_enables_request_this_venue", async () => {
    vi.mocked(decideEventRequest).mockResolvedValue(eventRequest({
      ...PERIOD,
      status: "approved",
      reviewingCoordinatorId: ASSIGNED,
      decision: "approved",
      decisionNote: "Approved.",
      decidedBy: ASSIGNED,
      decidedAt: "2026-01-15T09:00:00+08:00",
    }));
    vi.mocked(findVenuesForEvent).mockResolvedValue([HALL]);
    const user = userEvent.setup();
    renderAs(ASSIGNED, eventRequest({ ...PERIOD, status: "under_review", reviewingCoordinatorId: ASSIGNED }));

    await user.type(await screen.findByLabelText("Note for the Organiser"), "Approved.");
    await user.click(screen.getByRole("button", { name: "Approve request" }));
    await screen.findByText("Outcome");

    expect(await searchInFinder(user)).toBeEnabled();
  });

  it("SCRUM254_a_submitted_event_cannot_have_a_venue_requested", async () => {
    vi.mocked(findVenuesForEvent).mockResolvedValue([HALL]);
    const user = userEvent.setup();
    renderAs(ASSIGNED, eventRequest(PERIOD));

    expect(await searchInFinder(user)).toBeDisabled();
    expect(within(finderSection()).getByRole("status")).toHaveTextContent(
      "A venue can only be requested for an approved or confirmed event, including one under or past safety review. This event is submitted.",
    );
  });

  it("SCRUM254_a_coordinator_who_is_not_assigned_cannot_request", async () => {
    vi.mocked(findVenuesForEvent).mockResolvedValue([HALL]);
    const user = userEvent.setup();
    renderAs(OTHER, eventRequest({ ...PERIOD, status: "approved" }));

    expect(await searchInFinder(user)).toBeDisabled();
    expect(within(finderSection()).getByRole("status")).toHaveTextContent(
      "Only the coordinator assigned to this event can request a venue for it.",
    );
  });

  it("SCRUM254_a_sent_request_refreshes_the_parent", async () => {
    vi.mocked(findVenuesForEvent).mockResolvedValue([HALL]);
    vi.mocked(createBookingRequest).mockResolvedValue({ id: "b1", status: "pending" });
    vi.mocked(useAuth).mockReturnValue({ user: { id: ASSIGNED, role: "event_coordinator" } });
    const onChangeRequestProcessed = vi.fn();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CoordinatorRequestDetail
          request={eventRequest({ ...PERIOD, status: "approved" })}
          onChangeRequestProcessed={onChangeRequestProcessed}
        />
      </MemoryRouter>,
    );

    await user.click(await searchInFinder(user));
    const panel = screen.getByRole("region", { name: "Request Hall A" });
    await user.click(within(panel).getByRole("button", { name: "Request this venue" }));

    await waitFor(() => expect(onChangeRequestProcessed).toHaveBeenCalledTimes(1));
    expect(createBookingRequest).toHaveBeenCalledWith({
      eventRequestId: REQUEST_ID,
      venueId: "v1",
      // eventRequest()'s attendance, the panel's seed.
      expectedAttendance: 120,
    });
  });
});


// ---------------------------------------------------------------------------
// SCRUM-486 (SCRUM-521), AC6-05: who sees the hand-over action
// ---------------------------------------------------------------------------
describe("SCRUM486_AC6 the hand-over action on the event screen", () => {
  const LEAD = "77777777-7777-4777-8777-777777777777";
  const HAND_OVER = "Hand over to another coordinator";

  function renderAsRole(userId, role, request) {
    vi.mocked(useAuth).mockReturnValue({ user: { id: userId, role } });
    return render(
      <MemoryRouter>
        <CoordinatorRequestDetail request={request} onChangeRequestProcessed={vi.fn()} onReviewDecisionProcessed={vi.fn()} />
      </MemoryRouter>,
    );
  }

  beforeEach(() => {
    vi.mocked(listCoordinators).mockReset();
    vi.mocked(listCoordinatorWorkload).mockReset();
    vi.mocked(reassignEventRequest).mockReset();
  });

  it("SCRUM486_AC6_a_lead_sees_the_hand_over_action_on_an_event_they_do_not_hold", async () => {
    renderAsRole(LEAD, "event_coordinator_lead", eventRequest({ status: "under_review", reviewingCoordinatorId: ASSIGNED }));

    expect(await screen.findByRole("button", { name: HAND_OVER })).toBeInTheDocument();
    // And nothing else: reviewing and deciding stay the holder's.
    expect(actionButtonsShown()).toEqual([]);
  });

  it("SCRUM486_AC6_the_holder_still_sees_it", async () => {
    renderAsRole(ASSIGNED, "event_coordinator", eventRequest());

    expect(await screen.findByRole("button", { name: HAND_OVER })).toBeInTheDocument();
  });

  it("SCRUM486_AC6_a_coordinator_who_holds_nothing_does_not", async () => {
    renderAsRole(OTHER, "event_coordinator", eventRequest());

    await screen.findByText("IS212 Industry Night");
    expect(screen.queryByRole("button", { name: HAND_OVER })).not.toBeInTheDocument();
  });

  it("SCRUM486_AC6_not_even_a_lead_sees_it_on_a_cancelled_event", async () => {
    // The merge of dev (SCRUM-370) put "not cancelled" into the same gate as
    // SCRUM-521's "the holder or a Lead": a cancelled event cannot be handed
    // over (052's status list leaves it out), whoever is looking.
    renderAsRole(LEAD, "event_coordinator_lead", eventRequest({ status: "cancelled" }));

    await screen.findByText("IS212 Industry Night");
    expect(screen.queryByRole("button", { name: HAND_OVER })).not.toBeInTheDocument();
  });

  it("SCRUM486_AC6_not_even_a_lead_sees_it_on_a_request_nobody_holds", async () => {
    // Assigned from the Lead's queue, not handed over (052 refuses, AC5-05).
    renderAsRole(LEAD, "event_coordinator_lead", eventRequest({ assignedCoordinatorId: null }));

    await screen.findByText("IS212 Industry Night");
    expect(screen.queryByRole("button", { name: HAND_OVER })).not.toBeInTheDocument();
  });

  it("SCRUM486_AC6_a_lead_hands_it_over_from_the_screen_without_being_told_they_can_no_longer_change_it", async () => {
    // The Lead's panel reads the Lead's list, leaves out the holder, and after
    // the handover the notice does not say "you can no longer change it",
    // which was never true of the Lead. The Lead can hand it over again.
    vi.mocked(listCoordinatorWorkload).mockResolvedValue([
      { id: ASSIGNED, fullName: "Priya Nair", activeEvents: 2 },
      { id: OTHER, fullName: "Omar Okafor", activeEvents: 0 },
    ]);
    vi.mocked(reassignEventRequest).mockResolvedValue(eventRequest({ assignedCoordinatorId: OTHER }));
    const user = userEvent.setup();
    renderAsRole(LEAD, "event_coordinator_lead", eventRequest());

    await user.click(await screen.findByRole("button", { name: HAND_OVER }));
    const select = await screen.findByLabelText("Hand over to");
    expect(within(select).queryByRole("option", { name: /Priya Nair/ })).not.toBeInTheDocument();
    await user.selectOptions(select, OTHER);
    await user.click(screen.getByRole("button", { name: "Confirm handover" }));

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("Handed over to Omar Okafor.");
    expect(notice).not.toHaveTextContent(/not change it/);
    expect(listCoordinators).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: HAND_OVER })).toBeInTheDocument();
  });

  it("SCRUM486_AC6_a_second_handover_from_the_same_screen_leaves_out_the_new_holder", async () => {
    // The panel is told who holds the event now, not who held it when the
    // screen was loaded: after A -> B, the next list leaves out B, offers A.
    vi.mocked(listCoordinatorWorkload).mockResolvedValue([
      { id: ASSIGNED, fullName: "Priya Nair", activeEvents: 2 },
      { id: OTHER, fullName: "Omar Okafor", activeEvents: 0 },
    ]);
    vi.mocked(reassignEventRequest).mockResolvedValue(eventRequest({ assignedCoordinatorId: OTHER }));
    const user = userEvent.setup();
    renderAsRole(LEAD, "event_coordinator_lead", eventRequest());

    await user.click(await screen.findByRole("button", { name: HAND_OVER }));
    await user.selectOptions(await screen.findByLabelText("Hand over to"), OTHER);
    await user.click(screen.getByRole("button", { name: "Confirm handover" }));
    await screen.findByRole("status");
    await user.click(screen.getByRole("button", { name: HAND_OVER }));

    const select = await screen.findByLabelText("Hand over to");
    expect(within(select).queryByRole("option", { name: /Omar Okafor/ })).not.toBeInTheDocument();
    expect(within(select).getByRole("option", { name: /Priya Nair/ })).toBeInTheDocument();
  });

  it("SCRUM486_AC6_the_holder_is_still_told_they_can_view_but_not_change_it", async () => {
    vi.mocked(listCoordinators).mockResolvedValue([
      { id: ASSIGNED, fullName: "Priya Nair" },
      { id: OTHER, fullName: "Omar Okafor" },
    ]);
    vi.mocked(reassignEventRequest).mockResolvedValue(eventRequest({ assignedCoordinatorId: OTHER }));
    const user = userEvent.setup();
    renderAsRole(ASSIGNED, "event_coordinator", eventRequest());

    await user.click(await screen.findByRole("button", { name: HAND_OVER }));
    await user.selectOptions(await screen.findByLabelText("Hand over to"), OTHER);
    await user.click(screen.getByRole("button", { name: "Confirm handover" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Handed over to Omar Okafor. You can still view this event, but not change it.",
    );
    expect(screen.queryByRole("button", { name: HAND_OVER })).not.toBeInTheDocument();
  });
});

// SCRUM-192 (SCRUM-188 AC6, Week 7): the live recheck of the event's
// requested and booked venues sits just above "Find a venue", for the
// assigned coordinator, and rechecks whenever the event's period or
// attendance changes or a booking is requested here.
describe("SCRUM192 venue suitability on the event view", () => {
  const PERIOD = { proposedStart: START_ISO, proposedEnd: END_ISO };
  const suitabilitySection = () =>
    screen.queryByRole("heading", { name: "Venue suitability" })?.closest("section") ?? null;

  function renderWithRerender(request, onChangeRequestProcessed = vi.fn()) {
    vi.mocked(useAuth).mockReturnValue({ user: { id: ASSIGNED, role: "event_coordinator" } });
    const view = (next) => (
      <MemoryRouter>
        <CoordinatorRequestDetail request={next} onChangeRequestProcessed={onChangeRequestProcessed} />
      </MemoryRouter>
    );
    const utils = render(view(request));
    return { ...utils, rerenderWith: (next) => utils.rerender(view(next)) };
  }

  it("SCRUM188_AC6_the_assigned_coordinator_sees_it_just_before_find_a_venue", async () => {
    renderAs(ASSIGNED, eventRequest({ status: "approved" }));

    const section = suitabilitySection();
    expect(section).not.toBeNull();
    expect(await within(section).findByText("No venue has been requested for this event yet.")).toBeInTheDocument();
    expect(getEventVenueSuitability).toHaveBeenCalledWith(REQUEST_ID);

    const finder = screen.getByRole("heading", { name: "Find a venue" }).closest("section");
    expect(section.compareDocumentPosition(finder) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("SCRUM188_AC6_a_coordinator_who_is_not_assigned_does_not_see_it", async () => {
    renderAs(OTHER, eventRequest({ status: "approved" }));

    await waitFor(() => expect(getCoordinatorChangeRequests).toHaveBeenCalled());
    expect(suitabilitySection()).toBeNull();
    expect(getEventVenueSuitability).not.toHaveBeenCalled();
  });

  it.each([
    ["proposedStart", { proposedStart: "2026-11-11T11:00:00+08:00" }],
    ["proposedEnd", { proposedEnd: "2026-11-11T13:00:00+08:00" }],
    ["expectedAttendance", { expectedAttendance: 300 }],
  ])("SCRUM188_AC6_a_changed_%s_rechecks", async (_field, change) => {
    const request = eventRequest({ ...PERIOD, status: "approved" });
    const { rerenderWith } = renderWithRerender(request);
    await waitFor(() => expect(getEventVenueSuitability).toHaveBeenCalledTimes(1));

    rerenderWith({ ...request, ...change });

    await waitFor(() => expect(getEventVenueSuitability).toHaveBeenCalledTimes(2));
    expect(getEventVenueSuitability).toHaveBeenLastCalledWith(REQUEST_ID);
  });

  it("SCRUM188_AC6_a_refresh_that_moves_nothing_does_not_recheck", async () => {
    const request = eventRequest({ ...PERIOD, status: "approved" });
    const { rerenderWith } = renderWithRerender(request);
    await waitFor(() => expect(getEventVenueSuitability).toHaveBeenCalledTimes(1));

    rerenderWith({ ...request, purpose: "Updated purpose" });

    await waitFor(() => expect(getCoordinatorChangeRequests).toHaveBeenCalled());
    expect(getEventVenueSuitability).toHaveBeenCalledTimes(1);
  });

  it("SCRUM188_AC6_a_booking_requested_here_rechecks_and_refreshes_the_parent", async () => {
    const HALL = { id: "v1", name: "Hall A", location: "Level 2", maxCapacity: 200 };
    vi.mocked(findVenuesForEvent).mockResolvedValue([HALL]);
    vi.mocked(createBookingRequest).mockResolvedValue({ id: "b1", status: "pending" });
    const onChangeRequestProcessed = vi.fn();
    const user = userEvent.setup();
    renderWithRerender(eventRequest({ ...PERIOD, status: "approved" }), onChangeRequestProcessed);
    await waitFor(() => expect(getEventVenueSuitability).toHaveBeenCalledTimes(1));

    await user.click(within(finderSection()).getByRole("button", { name: "Search venues" }));
    await user.click(await within(finderSection()).findByRole("button", { name: "Request this venue: Hall A" }));
    const panel = screen.getByRole("region", { name: "Request Hall A" });
    await user.click(within(panel).getByRole("button", { name: "Request this venue" }));

    await waitFor(() => expect(onChangeRequestProcessed).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getEventVenueSuitability).toHaveBeenCalledTimes(2));
  });
});

// SCRUM-188 review fix F9, per venue since SCRUM-525 (AC1, R13): the Venue
// suitability section tells Find a venue which venues already have a live
// request, and only those are not offered again.
describe("SCRUM-188 a live request known on load", () => {
  const PERIOD = { proposedStart: START_ISO, proposedEnd: END_ISO };
  const HALL = { id: "v1", name: "Hall A", location: "Level 2", maxCapacity: 200 };
  const ROOM_B = { id: "v9", name: "Room B", location: "Level 1", maxCapacity: 60 };
  const ROOM_C = { id: "v8", name: "Room C", location: "Level 3", maxCapacity: 60 };
  // Errored on purpose: a booking whose recheck failed is still live.
  const LIVE_ITEM = {
    bookingId: "b1",
    venueId: "v9",
    venueName: "Room B",
    venueLocation: "Level 1",
    status: "pending",
    statusDisplay: { status: "pending", label: "Pending" },
    roomLayoutCode: null,
    expectedAttendance: 40,
    attendanceSource: "booking",
    suitabilityOverridden: false,
    current: null,
    atRequest: null,
    newlyUnmet: [],
    error: { code: "RECHECK_FAILED", message: "prose" },
  };
  const APPROVED_ITEM = {
    ...LIVE_ITEM,
    bookingId: "b2",
    venueId: "v8",
    venueName: "Room C",
    status: "approved",
    statusDisplay: { status: "approved", label: "Approved" },
    current: { suitable: true, criteria: [], checked: {} },
    error: null,
  };
  const finderSection = () => screen.getByRole("heading", { name: "Find a venue" }).closest("section");
  const requestButton = (name) =>
    within(finderSection()).getByRole("button", { name: `Request this venue: ${name}` });
  async function searchInFinder(user) {
    await user.click(within(finderSection()).getByRole("button", { name: "Search venues" }));
    return within(finderSection()).findByRole("button", { name: "Request this venue: Hall A" });
  }

  it("SCRUM525_AC1_a_live_request_on_load_disables_only_its_venue", async () => {
    vi.mocked(getEventVenueSuitability).mockResolvedValue([LIVE_ITEM, APPROVED_ITEM]);
    vi.mocked(findVenuesForEvent).mockResolvedValue([HALL, ROOM_B, ROOM_C]);
    const user = userEvent.setup();
    renderAs(ASSIGNED, eventRequest({ ...PERIOD, status: "approved" }));

    await screen.findByRole("heading", { name: "Room B" });
    expect(await searchInFinder(user)).toBeEnabled();
    expect(requestButton("Room B")).toBeDisabled();
    expect(requestButton("Room B")).toHaveAccessibleDescription(/Pending/);
    expect(requestButton("Room B")).toHaveAccessibleDescription(/Venue suitability/);
    // Each venue names its own request's status, from the server's label.
    expect(requestButton("Room C")).toBeDisabled();
    expect(requestButton("Room C")).toHaveAccessibleDescription(/\(Approved\)/);
    expect(createBookingRequest).not.toHaveBeenCalled();
  });

  // SCRUM-525 (R13): the request a refusal collided with is shown, so the
  // section reloads to list it, and Hall A's hint then names its status from
  // the server, which the refusal alone does not carry.
  it("SCRUM525_AC1_an_already_requested_refusal_reloads_venue_suitability", async () => {
    const COLLIDED_ITEM = {
      ...APPROVED_ITEM,
      bookingId: "b7",
      venueId: "v1",
      venueName: "Hall A",
      venueLocation: "Level 2",
    };
    vi.mocked(getEventVenueSuitability).mockResolvedValueOnce([]).mockResolvedValueOnce([COLLIDED_ITEM]);
    vi.mocked(findVenuesForEvent).mockResolvedValue([HALL]);
    vi.mocked(createBookingRequest).mockRejectedValue(
      Object.assign(httpError(409), {
        response: {
          status: 409,
          data: { code: "BOOKING_REQUEST_EXISTS", conflicts: [{ kind: "booking_request", bookingId: "b7" }] },
        },
      }),
    );
    const user = userEvent.setup();
    renderAs(ASSIGNED, eventRequest({ ...PERIOD, status: "approved" }));
    await waitFor(() => expect(getEventVenueSuitability).toHaveBeenCalledTimes(1));

    await user.click(await searchInFinder(user));
    const panel = screen.getByRole("region", { name: "Request Hall A" });
    await user.click(within(panel).getByRole("button", { name: "Request this venue" }));

    await waitFor(() => expect(getEventVenueSuitability).toHaveBeenCalledTimes(2));
    const suitabilitySection = screen.getByRole("heading", { name: "Venue suitability" }).closest("section");
    expect(await within(suitabilitySection).findByRole("heading", { name: "Hall A" })).toBeInTheDocument();
    expect(requestButton("Hall A")).toBeDisabled();
    await waitFor(() => expect(requestButton("Hall A")).toHaveAccessibleDescription(/\(Approved\)/));
  });

  // SCRUM-525 (R13): the lock hint points at Venue suitability, which only
  // the assigned coordinator sees. After a handover made in this view the
  // section is gone, so no hint may send the coordinator looking for it; the
  // buttons stay off for eligibility's reason, shown once above the results.
  it("SCRUM525_AC1_after_a_handover_no_hint_points_at_the_hidden_venue_suitability", async () => {
    vi.mocked(getEventVenueSuitability).mockResolvedValue([LIVE_ITEM]);
    vi.mocked(findVenuesForEvent).mockResolvedValue([HALL, ROOM_B]);
    vi.mocked(listCoordinators).mockResolvedValue([{ id: OTHER, fullName: "Olga Other" }]);
    vi.mocked(reassignEventRequest).mockResolvedValue({ id: REQUEST_ID, assignedCoordinatorId: OTHER });
    const user = userEvent.setup();
    renderAs(ASSIGNED, eventRequest({ ...PERIOD, status: "approved" }));
    await screen.findByRole("heading", { name: "Room B" });

    await user.click(screen.getByRole("button", { name: "Hand over to another coordinator" }));
    await user.selectOptions(await screen.findByLabelText("Hand over to"), OTHER);
    await user.click(screen.getByRole("button", { name: "Confirm handover" }));
    await screen.findByText(/Handed over to Olga Other/);
    expect(screen.queryByRole("heading", { name: "Venue suitability" })).not.toBeInTheDocument();

    await searchInFinder(user);
    expect(requestButton("Room B")).toBeDisabled();
    expect(requestButton("Room B")).not.toHaveAccessibleDescription(/Venue suitability/);
    expect(within(finderSection()).queryByText(/See it under Venue suitability/)).not.toBeInTheDocument();
    expect(
      within(finderSection()).getByText("Only the coordinator assigned to this event can request a venue for it."),
    ).toBeInTheDocument();
  });
});

// SCRUM-266: a confirmed event's flagged bookings on its coordinator screen.
describe("SCRUM266 flagged bookings on the event view", () => {
  const PERIOD = { proposedStart: START_ISO, proposedEnd: END_ISO };
  const HALL = { id: "v1", name: "Hall A", location: "Level 2", maxCapacity: 200 };
  const FLAGGED = {
    id: "f1",
    eventRequestId: REQUEST_ID,
    venueId: "v5",
    venueName: "Old Hall",
    venueLocation: "Level 5",
    startsAt: START_ISO,
    endsAt: END_ISO,
    flaggedAt: "2026-11-01T10:00:00+08:00",
    reviewReason: "safety_review",
    block: null,
    replacementRequests: [],
  };
  const confirmed = (overrides = {}) =>
    eventRequest({
      ...PERIOD,
      status: "confirmed",
      needsAttention: true,
      statusDisplay: { status: "confirmed", label: "Confirmed", group: "CONFIRMED", description: "" },
      ...overrides,
    });
  const flaggedSection = () => screen.queryByRole("heading", { name: "Flagged bookings" })?.closest("section") ?? null;
  const finder = () => screen.getByRole("heading", { name: "Find a venue" }).closest("section");
  const header = () => screen.getByRole("heading", { level: 2 });
  const replaceButton = async () =>
    within((await screen.findByRole("heading", { name: "Flagged bookings" })).closest("section")).getByRole("button", {
      name: "Find a replacement venue",
    });

  function renderAssigned(request, onChangeRequestProcessed = vi.fn()) {
    vi.mocked(useAuth).mockReturnValue({ user: { id: ASSIGNED, role: "event_coordinator" } });
    render(
      <MemoryRouter>
        <CoordinatorRequestDetail request={request} onChangeRequestProcessed={onChangeRequestProcessed} />
      </MemoryRouter>,
    );
    return userEvent.setup();
  }

  async function requestHallA(user) {
    await user.click(within(finder()).getByRole("button", { name: "Search venues" }));
    await user.click(await within(finder()).findByRole("button", { name: "Request this venue: Hall A" }));
    const panel = screen.getByRole("region", { name: "Request Hall A" });
    await user.click(within(panel).getByRole("button", { name: "Request this venue" }));
    return panel;
  }

  it("SCRUM266_AC1_the_assigned_coordinator_sees_flagged_bookings_just_above_venue_suitability", async () => {
    vi.mocked(getEventFlaggedBookings).mockResolvedValue([FLAGGED]);
    renderAssigned(confirmed());

    const section = await screen.findByRole("heading", { name: "Flagged bookings" });
    expect(getEventFlaggedBookings).toHaveBeenCalledWith(REQUEST_ID);
    expect(within(section.closest("section")).getByText("Safety review")).toBeInTheDocument();
    const suitability = screen.getByRole("heading", { name: "Venue suitability" });
    expect(section.compareDocumentPosition(suitability) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("SCRUM266_AC1_a_coordinator_not_assigned_sees_no_flagged_bookings_and_none_are_loaded", async () => {
    vi.mocked(getEventFlaggedBookings).mockResolvedValue([FLAGGED]);
    renderAs(OTHER, confirmed());

    await waitFor(() => expect(getCoordinatorChangeRequests).toHaveBeenCalled());
    expect(getEventFlaggedBookings).not.toHaveBeenCalled();
    expect(flaggedSection()).toBeNull();
  });

  it("SCRUM266_AC1_an_event_with_nothing_flagged_shows_no_section", async () => {
    renderAssigned(confirmed({ needsAttention: false }));

    await waitFor(() => expect(getEventFlaggedBookings).toHaveBeenCalledTimes(1));
    expect(flaggedSection()).toBeNull();
  });

  it.each([
    ["true", { needsAttention: true }, true],
    ["false", { needsAttention: false }, false],
    ["missing", { needsAttention: undefined }, false],
  ])("SCRUM266_AC4_the_header_shows_needs_attention_only_when_the_flag_is_%s", async (_label, overrides, shown) => {
    renderAssigned(confirmed(overrides));

    expect(within(header()).getByText("Confirmed")).toBeInTheDocument();
    expect(within(header()).queryByText("Needs attention") !== null).toBe(shown);
    await waitFor(() => expect(getEventFlaggedBookings).toHaveBeenCalled());
  });

  it("SCRUM266_AC3_cancelling_a_flagged_booking_reloads_venue_suitability_and_the_parent", async () => {
    vi.mocked(getEventFlaggedBookings).mockResolvedValueOnce([FLAGGED]).mockResolvedValueOnce([]);
    vi.mocked(cancelFlaggedBooking).mockResolvedValue({ id: "f1", status: "cancelled" });
    const onChangeRequestProcessed = vi.fn();
    const user = renderAssigned(confirmed(), onChangeRequestProcessed);
    await screen.findByRole("heading", { name: "Flagged bookings" });
    await waitFor(() => expect(getEventVenueSuitability).toHaveBeenCalledTimes(1));

    await user.type(within(flaggedSection()).getByLabelText("Reason for cancelling (required)"), "Venue closed");
    await user.click(within(flaggedSection()).getByRole("button", { name: "Cancel this booking" }));

    expect(cancelFlaggedBooking).toHaveBeenCalledWith("f1", "Venue closed");
    await waitFor(() => expect(getEventVenueSuitability).toHaveBeenCalledTimes(2));
    expect(onChangeRequestProcessed).toHaveBeenCalled();
  });

  it("SCRUM266_AC3_a_cancelled_flagged_booking_frees_its_venue_in_find_a_venue", async () => {
    const OLD_HALL = { id: "v5", name: "Old Hall", location: "Level 5", maxCapacity: 200 };
    const FLAGGED_ITEM = {
      bookingId: "f1",
      venueId: "v5",
      venueName: "Old Hall",
      venueLocation: "Level 5",
      status: "flagged_for_review",
      statusDisplay: { status: "flagged_for_review", label: "Flagged for review" },
      roomLayoutCode: null,
      expectedAttendance: 120,
      attendanceSource: "booking",
      suitabilityOverridden: false,
      current: { suitable: true, criteria: [], checked: {} },
      atRequest: null,
      newlyUnmet: [],
      error: null,
    };
    vi.mocked(getEventFlaggedBookings).mockResolvedValueOnce([FLAGGED]).mockResolvedValueOnce([]);
    vi.mocked(getEventVenueSuitability).mockResolvedValueOnce([FLAGGED_ITEM]).mockResolvedValueOnce([]);
    vi.mocked(cancelFlaggedBooking).mockResolvedValue({ id: "f1", status: "cancelled" });
    vi.mocked(findVenuesForEvent).mockResolvedValue([OLD_HALL]);
    const user = renderAssigned(confirmed());
    const suitability = (await screen.findByRole("heading", { name: "Venue suitability" })).closest("section");
    await within(suitability).findByRole("heading", { name: "Old Hall" });

    await user.click(within(finder()).getByRole("button", { name: "Search venues" }));
    const oldHall = () => within(finder()).getByRole("button", { name: "Request this venue: Old Hall" });
    await within(finder()).findByRole("button", { name: "Request this venue: Old Hall" });
    expect(oldHall()).toBeDisabled();
    expect(oldHall()).toHaveAccessibleDescription(/already has a request for this venue \(Flagged for review\)/);

    await user.type(within(flaggedSection()).getByLabelText("Reason for cancelling (required)"), "Venue closed");
    await user.click(within(flaggedSection()).getByRole("button", { name: "Cancel this booking" }));

    await waitFor(() => expect(getEventVenueSuitability).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(suitability).queryByRole("heading", { name: "Old Hall" })).toBeNull());
    expect(oldHall()).toBeEnabled();
    expect(oldHall()).not.toHaveAccessibleDescription(/already has a request/);
    expect(within(finder()).queryByText(/already has a request for this venue/)).not.toBeInTheDocument();
  });

  it("SCRUM266_W7_find_a_replacement_names_the_booking_in_find_a_venue_and_moves_focus_there", async () => {
    vi.mocked(getEventFlaggedBookings).mockResolvedValue([FLAGGED]);
    const user = renderAssigned(confirmed());

    await user.click(await replaceButton());

    const notice = within(finder()).getByRole("status");
    expect(notice).toHaveTextContent(`Requesting a replacement for Old Hall, ${formatVenuePeriod(START_ISO, END_ISO)}`);
    expect(notice).toHaveFocus();
  });

  it("SCRUM266_W7_a_request_sent_while_replacing_names_the_flagged_booking_then_stops_replacing", async () => {
    vi.mocked(getEventFlaggedBookings).mockResolvedValue([FLAGGED]);
    vi.mocked(findVenuesForEvent).mockResolvedValue([HALL]);
    vi.mocked(createBookingRequest).mockResolvedValue({ id: "b1", status: "pending" });
    const user = renderAssigned(confirmed());
    await user.click(await replaceButton());

    await requestHallA(user);

    await waitFor(() => expect(createBookingRequest).toHaveBeenCalledTimes(1));
    expect(createBookingRequest.mock.calls[0][0]).toMatchObject({ venueId: "v1", replacesBookingId: "f1" });
    await waitFor(() => expect(within(finder()).queryByText(/Requesting a replacement for/)).not.toBeInTheDocument());
    await waitFor(() => expect(getEventFlaggedBookings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(getEventVenueSuitability).toHaveBeenCalledTimes(2));
  });

  it("SCRUM266_W7_an_ordinary_request_names_no_flagged_booking", async () => {
    vi.mocked(getEventFlaggedBookings).mockResolvedValue([FLAGGED]);
    vi.mocked(findVenuesForEvent).mockResolvedValue([HALL]);
    vi.mocked(createBookingRequest).mockResolvedValue({ id: "b1", status: "pending" });
    const user = renderAssigned(confirmed());
    await screen.findByRole("heading", { name: "Flagged bookings" });

    await requestHallA(user);

    await waitFor(() => expect(createBookingRequest).toHaveBeenCalledTimes(1));
    expect(createBookingRequest.mock.calls[0][0]).not.toHaveProperty("replacesBookingId");
    // Not a replacement, so the flagged list is not reloaded for it.
    expect(getEventFlaggedBookings).toHaveBeenCalledTimes(1);
  });

  it("SCRUM266_W7_stop_replacing_clears_the_notice_and_the_request_names_no_flagged_booking", async () => {
    vi.mocked(getEventFlaggedBookings).mockResolvedValue([FLAGGED]);
    vi.mocked(findVenuesForEvent).mockResolvedValue([HALL]);
    vi.mocked(createBookingRequest).mockResolvedValue({ id: "b1", status: "pending" });
    const user = renderAssigned(confirmed());
    await user.click(await replaceButton());

    await user.click(within(finder()).getByRole("button", { name: "Stop replacing" }));
    expect(within(finder()).queryByText(/Requesting a replacement for/)).not.toBeInTheDocument();
    await requestHallA(user);

    await waitFor(() => expect(createBookingRequest).toHaveBeenCalledTimes(1));
    expect(createBookingRequest.mock.calls[0][0]).not.toHaveProperty("replacesBookingId");
  });

  it("SCRUM266_W7_a_replacement_refused_as_no_longer_flagged_says_so_stops_replacing_and_reloads", async () => {
    vi.mocked(getEventFlaggedBookings).mockResolvedValueOnce([FLAGGED]).mockResolvedValueOnce([]);
    vi.mocked(findVenuesForEvent).mockResolvedValue([HALL]);
    vi.mocked(createBookingRequest).mockRejectedValue(
      Object.assign(new Error("409"), { response: { status: 409, data: { code: "REPLACED_BOOKING_NOT_FLAGGED", error: "prose" } } }),
    );
    const user = renderAssigned(confirmed());
    await user.click(await replaceButton());

    const panel = await requestHallA(user);

    expect(await within(panel).findByText(/no longer flagged for review.*Nothing was requested/)).toBeInTheDocument();
    expect(within(finder()).queryByText(/Requesting a replacement for/)).not.toBeInTheDocument();
    await waitFor(() => expect(getEventFlaggedBookings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(flaggedSection()).toBeNull());
  });

  it("SCRUM266_W7_a_booking_resolved_elsewhere_is_no_longer_being_replaced_after_a_reload", async () => {
    vi.mocked(getEventFlaggedBookings).mockResolvedValueOnce([FLAGGED, { ...FLAGGED, id: "f2", venueName: "Annex" }]);
    vi.mocked(getEventFlaggedBookings).mockResolvedValueOnce([{ ...FLAGGED, id: "f2", venueName: "Annex" }]);
    vi.mocked(cancelFlaggedBooking).mockRejectedValue(
      Object.assign(new Error("409"), { response: { status: 409, data: { code: "BOOKING_NOT_FLAGGED" } } }),
    );
    const user = renderAssigned(confirmed());
    const oldHall = await screen.findByRole("listitem", { name: "Old Hall, Level 5" });
    await user.click(within(oldHall).getByRole("button", { name: "Find a replacement venue" }));
    expect(within(finder()).getByText(/Requesting a replacement for Old Hall/)).toBeInTheDocument();

    await user.type(within(oldHall).getByLabelText("Reason for cancelling (required)"), "Gone");
    await user.click(within(oldHall).getByRole("button", { name: "Cancel this booking" }));

    await waitFor(() => expect(within(finder()).queryByText(/Requesting a replacement for/)).not.toBeInTheDocument());
  });
});
