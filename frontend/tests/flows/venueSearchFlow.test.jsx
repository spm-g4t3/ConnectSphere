// venueSearchFlow.test.jsx
//
// SCRUM-144 (SCRUM-20 AC2, AC7, AC8). The coordinator's venue search end to
// end inside the REAL event view: CoordinatorRequestDetail with the real
// EventVenueFinder, its form maths and its results underneath. Opening the
// event pre-fills the search; a search that matches nothing says so; lowering
// the attendance and searching again shows the venue with its six fields.
//
// Only three modules are mocked, as in CoordinatorRequestDetail.test.jsx and
// venueCalendarFlow.test.jsx:
//   - venueService, backed by a small in-memory fake whose findVenuesForEvent
//     answers like GET /venues/event-search on capacity. Every other export
//     rejects with "unexpected call".
//   - eventRequestService, whose two reads the event view makes on open
//     answer with empty lists. Every other export rejects the same way.
//   - the auth context, so the signed-in coordinator is known without
//     Supabase.
//
// Timezone-safe: the event's instants are fixed ISO strings and every expected
// input value comes from toDatetimeLocalValue; the sent period is compared
// with getTime(). Passes under TZ=UTC, Asia/Singapore and America/New_York.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import CoordinatorRequestDetail from "../../src/components/CoordinatorRequestDetail.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import * as eventRequestService from "../../src/services/eventRequestService";
import * as venueService from "../../src/services/venueService";
import { toDatetimeLocalValue } from "../../src/services/datetimeFormat.js";

vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../../src/services/eventRequestService", () => ({
  createEventRequest: vi.fn(),
  updateEventRequest: vi.fn(),
  submitEventRequest: vi.fn(),
  requestEventClarification: vi.fn(),
  respondToEventClarification: vi.fn(),
  getCoordinatorChangeRequests: vi.fn(),
  processCoordinatorChangeRequest: vi.fn(),
  getEventRequestById: vi.fn(),
  getMyEventRequests: vi.fn(),
  getEventRequestStatus: vi.fn(),
  getEventRequestQueue: vi.fn(),
  getMyAssignedEvents: vi.fn(),
  getEventRequestForReview: vi.fn(),
  listCoordinators: vi.fn(),
  getAssignmentHistory: vi.fn(),
  getAssignmentHistoryForReview: vi.fn(),
  reassignEventRequest: vi.fn(),
}));

vi.mock("../../src/services/venueService", () => ({
  searchActiveVenues: vi.fn(),
  findVenuesForEvent: vi.fn(),
  getVenueDetails: vi.fn(),
  getVenueCatalogue: vi.fn(),
  retireVenue: vi.fn(),
  createVenue: vi.fn(),
  updateVenue: vi.fn(),
  getVenueBookings: vi.fn(),
  getVenueHistory: vi.fn(),
  listVenueBlocks: vi.fn(),
  getVenueCalendar: vi.fn(),
  createVenueBlock: vi.fn(),
  updateVenueBlock: vi.fn(),
  removeVenueBlock: vi.fn(),
  getVenueBlockHistory: vi.fn(),
  getPendingBookingRequests: vi.fn(),
}));

const OFFSET_SUFFIX = /[+-]\d{2}:\d{2}$/;
const NO_MATCH = "No venue matched your criteria.";

const COORDINATOR = { id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", role: "event_coordinator" };

// Wednesday 11 November 2026, 10:00-12:00 Singapore: one date in every zone
// the suite runs in, and clear of DST changes.
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

// Seats 60: too small for the event's 80, big enough once lowered to 50.
const HARBOUR_ROOM = Object.freeze({
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3311",
  name: "Harbour Room",
  location: "Level 3",
  maxCapacity: 60,
  layouts: ["theatre", "classroom"],
  accessibility: ["step_free_entrance"],
  facilities: ["projector", "wifi"],
});

/**
 * A stand-in for the venue endpoints. findVenuesForEvent answers like
 * GET /venues/event-search on capacity: the venues seating the attendance.
 * The other rules have their own backend tests.
 */
function createFakeVenueBackend({ venues }) {
  return {
    async findVenuesForEvent(criteria) {
      return venues
        .filter((venue) => venue.maxCapacity >= criteria.expectedAttendance)
        .map((venue) => ({ ...venue }));
    },
  };
}

/** The reads the event view makes on open, with nothing to show. */
const fakeEventBackend = {
  async getCoordinatorChangeRequests() {
    return [];
  },
  async getAssignmentHistoryForReview() {
    return [];
  },
};

let backend;

/** Route each mocked export to its fake, or reject it as unexpected. */
function routeThrough(service, fake) {
  for (const [name, fn] of Object.entries(service)) {
    vi.mocked(fn).mockReset();
    if (name in fake) {
      vi.mocked(fn).mockImplementation((...args) => fake[name](...args));
    } else {
      vi.mocked(fn).mockImplementation(() => Promise.reject(new Error(`unexpected call: ${name}`)));
    }
  }
}

function renderEventView(request = EVENT) {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={["/coordinator"]}>
      <CoordinatorRequestDetail request={request} />
    </MemoryRouter>,
  );
  return { user };
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
  search: () => within(finderSection()).getByRole("button", { name: "Search venues" }),
};

/** Term -> definition text for one result. */
function detailsOf(article) {
  const terms = within(article).getAllByRole("term").map((dt) => dt.textContent);
  const values = within(article).getAllByRole("definition").map((dd) => dd.textContent);
  return Object.fromEntries(terms.map((term, i) => [term, values[i]]));
}

beforeEach(() => {
  backend = createFakeVenueBackend({ venues: [HARBOUR_ROOM] });

  vi.mocked(useAuth).mockReset();
  vi.mocked(useAuth).mockReturnValue({ user: COORDINATOR });
  routeThrough(venueService, backend);
  routeThrough(eventRequestService, fakeEventBackend);
});

describe("SCRUM20_AC2_AC7_AC8 venue search flow from the event view (SCRUM-144)", () => {
  it("SCRUM20_AC2_AC7_AC8_find_venue_prefill_no_match_adjust_results_flow", async () => {
    const { user } = renderEventView();
    const start = localParts(START_ISO);
    const end = localParts(END_ISO);

    // ---- 1. AC2: the event view opens with the search pre-filled -----------
    expect(screen.getByRole("heading", { name: "Find a venue" })).toBeInTheDocument();
    expect(inFinder.date()).toHaveValue(start.date);
    expect(inFinder.start()).toHaveValue(start.time);
    expect(inFinder.end()).toHaveValue(end.time);
    expect(inFinder.attendance()).toHaveValue(80);
    expect(venueService.findVenuesForEvent).not.toHaveBeenCalled();

    // ---- 2. AC8: 80 seats is more than any venue has -----------------------
    await user.click(inFinder.search());

    const status = await within(finderSection()).findByRole("status");
    expect(status).toHaveTextContent(NO_MATCH);
    expect(within(finderSection()).queryByRole("list", { name: "Matching venues" }))
      .not.toBeInTheDocument();

    const first = vi.mocked(venueService.findVenuesForEvent).mock.calls[0][0];
    expect(first.startsAt).toMatch(OFFSET_SUFFIX);
    expect(first.endsAt).toMatch(OFFSET_SUFFIX);
    expect(new Date(first.startsAt).getTime()).toBe(new Date(START_ISO).getTime());
    expect(new Date(first.endsAt).getTime()).toBe(new Date(END_ISO).getTime());
    expect(first.expectedAttendance).toBe(80);

    // ---- 3. AC8: lower the attendance and search again ---------------------
    // The form kept the event's values, so only the attendance changes.
    expect(inFinder.date()).toHaveValue(start.date);
    await user.clear(inFinder.attendance());
    await user.type(inFinder.attendance(), "50");
    await user.click(inFinder.search());

    // ---- 4. AC7: Harbour Room with its six fields; the message is gone -----
    const list = await within(finderSection()).findByRole("list", { name: "Matching venues" });
    expect(within(finderSection()).queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText(NO_MATCH)).not.toBeInTheDocument();

    const article = within(list).getByRole("article", { name: "Harbour Room" });
    expect(within(article).getByRole("heading", { name: "Harbour Room" })).toBeInTheDocument();
    expect(detailsOf(article)).toEqual({
      Location: "Level 3",
      "Maximum capacity": "60",
      "Room layouts": "Theatre, Classroom",
      "Accessibility features": "Step-free entrance",
      Facilities: "Projector, Wi-Fi",
    });

    expect(venueService.findVenuesForEvent).toHaveBeenCalledTimes(2);
    const second = vi.mocked(venueService.findVenuesForEvent).mock.calls[1][0];
    expect(second.expectedAttendance).toBe(50);
    expect(new Date(second.startsAt).getTime()).toBe(new Date(START_ISO).getTime());
    expect(new Date(second.endsAt).getTime()).toBe(new Date(END_ISO).getTime());
  });
});
