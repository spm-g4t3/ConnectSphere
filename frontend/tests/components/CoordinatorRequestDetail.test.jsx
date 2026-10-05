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
// Timezone-safe: expected input values come from toDatetimeLocalValue, never a
// hard-coded wall-clock string; date inputs are set with fireEvent.change.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import CoordinatorRequestDetail from "../../src/components/CoordinatorRequestDetail.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import {
  getAssignmentHistoryForReview,
  getCoordinatorChangeRequests,
} from "../../src/services/eventRequestService";
import { findVenuesForEvent } from "../../src/services/venueService";
import { toDatetimeLocalValue } from "../../src/services/datetimeFormat.js";

vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../../src/services/eventRequestService", () => ({
  getCoordinatorChangeRequests: vi.fn(),
  processCoordinatorChangeRequest: vi.fn(),
  requestEventClarification: vi.fn(),
  getAssignmentHistory: vi.fn(),
  getAssignmentHistoryForReview: vi.fn(),
  listCoordinators: vi.fn(),
  reassignEventRequest: vi.fn(),
}));

vi.mock("../../src/services/venueService", () => ({
  findVenuesForEvent: vi.fn(),
}));

const COORDINATOR = { id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", role: "event_coordinator" };

// One calendar date in every zone the suite runs in, clear of DST changes.
const START_ISO = "2026-11-11T10:00:00+08:00";
const END_ISO = "2026-11-11T12:00:00+08:00";

function localParts(iso) {
  const [date, time] = toDatetimeLocalValue(iso).split("T");
  return { date, time };
}

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

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
  vi.mocked(useAuth).mockReturnValue({ user: COORDINATOR });
  vi.mocked(getCoordinatorChangeRequests).mockReset();
  vi.mocked(getCoordinatorChangeRequests).mockResolvedValue([]);
  vi.mocked(getAssignmentHistoryForReview).mockReset();
  vi.mocked(getAssignmentHistoryForReview).mockResolvedValue([]);
  vi.mocked(findVenuesForEvent).mockReset();
  vi.mocked(findVenuesForEvent).mockResolvedValue([]);
});

describe("SCRUM20_AC2 the event view holds the venue search", () => {
  it("SCRUM20_AC2_find_a_venue_renders_the_form_prefilled_from_the_event", async () => {
    renderDetail();
    const start = localParts(START_ISO);
    const end = localParts(END_ISO);

    expect(screen.getByRole("heading", { name: "Find a venue" })).toBeInTheDocument();
    expect(inFinder.date()).toHaveValue(start.date);
    expect(inFinder.start()).toHaveValue(start.time);
    expect(inFinder.end()).toHaveValue(end.time);
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

    expect(inFinder.start()).toHaveValue(localParts(movedStart).time);
    expect(inFinder.attendance()).toHaveValue(80);
  });

  it("SCRUM20_AC2_a_changed_end_reseeds_the_form", () => {
    const { rerenderWith } = renderDetail();
    fireEvent.change(inFinder.attendance(), { target: { value: "150" } });

    const movedEnd = "2026-11-11T11:30:00+08:00";
    rerenderWith({ ...EVENT, proposedEnd: movedEnd });

    expect(inFinder.end()).toHaveValue(localParts(movedEnd).time);
    expect(inFinder.attendance()).toHaveValue(80);
  });

  it("SCRUM20_AC2_a_refresh_with_the_same_values_keeps_the_edits", () => {
    // The parent refetches after a change request is processed; if the event's
    // period and attendance did not move, the coordinator's edits stay.
    const { rerenderWith } = renderDetail();
    fireEvent.change(inFinder.attendance(), { target: { value: "150" } });
    fireEvent.change(inFinder.location(), { target: { value: "Level 2" } });
    const edited = localParts("2026-11-12T10:00:00+08:00");
    fireEvent.change(inFinder.date(), { target: { value: edited.date } });

    rerenderWith({ ...EVENT, status: "under_review", purpose: "Updated purpose" });

    expect(inFinder.attendance()).toHaveValue(150);
    expect(inFinder.location()).toHaveValue("Level 2");
    expect(inFinder.date()).toHaveValue(edited.date);
  });
});
