// venueSuitabilityFlow.test.jsx
//
// SCRUM-188 (SCRUM-193/194). One end-to-end flow through the real components:
// the coordinator's CoordinatorRequestDetail, with the real
// EventVenueSuitability, EventVenueFinder, VenueSuitabilityPanel,
// VenueSuitabilityResult and BookingRequestPanel underneath, then Venue
// Staff's real VenueDetail with BookingSuitabilitySummary.
//
// Only the service boundary is mocked. The calls the flow makes are backed by
// one small stateful in-memory fake (createFakeSuitabilityBackend), built
// fresh for every test, that keeps the rules the backend keeps:
//   - the check judges the event's SAVED period and attendance, never the
//     search form's (AC3), and Seminar Room seats 80 against 150 (AC2/AC5);
//   - a request for an unsuitable venue is refused with 409
//     SUITABILITY_CONFIRMATION_REQUIRED unless confirmUnsuitable is sent and
//     acknowledgedCriteria covers every unmet criterion (AC7);
//   - the recheck reads the stored booking and recomputes it, raising only
//     criteria that were not overridden (AC6);
//   - Venue Staff's bookings list carries the stored result; a coordinator's
//     does not (AC7).
// Every other export the tree imports rejects with "unexpected call".
//
// Timezone-safe: the expected "When" text is built from the fixture instants
// with toVenueWallClock, never typed for one zone. Passes under TZ=UTC,
// Asia/Singapore and America/New_York:
//   TZ=America/New_York npx vitest run tests/flows/venueSuitabilityFlow.test.jsx

import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import CoordinatorRequestDetail from "../../src/components/CoordinatorRequestDetail.jsx";
import VenueDetail from "../../src/components/VenueDetail.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import * as eventRequestService from "../../src/services/eventRequestService";
import * as eventEquipmentService from "../../src/services/eventEquipmentService";
import * as venueService from "../../src/services/venueService";
import * as bookingRequestService from "../../src/services/bookingRequestService";
import * as venueSuitabilityService from "../../src/services/venueSuitabilityService";
import { toVenueWallClock } from "../../src/services/datetimeFormat";

vi.mock("../../src/auth/AuthContext", () => ({ useAuth: vi.fn() }));

vi.mock("../../src/services/eventRequestService", () => ({
  closeEventClarification: vi.fn(),
  decideEventRequest: vi.fn(),
  getAssignmentHistory: vi.fn(),
  getAssignmentHistoryForReview: vi.fn(),
  getCoordinatorChangeRequests: vi.fn(),
  getEventClarificationHistory: vi.fn(),
  listCoordinators: vi.fn(),
  processCoordinatorChangeRequest: vi.fn(),
  reassignEventRequest: vi.fn(),
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

vi.mock("../../src/services/venueService", () => ({
  findVenuesForEvent: vi.fn(),
  searchActiveVenues: vi.fn(),
  getVenueBookings: vi.fn(),
  getVenueDetails: vi.fn(),
  getVenueHistory: vi.fn(),
}));

vi.mock("../../src/services/bookingRequestService", () => ({
  createBookingRequest: vi.fn(),
  getMyBookingRequests: vi.fn(),
  withdrawBookingRequest: vi.fn(),
}));

vi.mock("../../src/services/venueSuitabilityService", () => ({
  checkVenueSuitability: vi.fn(),
  getEventVenueSuitability: vi.fn(),
}));

const COORDINATOR_ID = "44444444-4444-4444-8444-444444444444";

// Wednesday 11 November 2026, 10:00-12:00 Singapore (fixed date D).
const EVENT = Object.freeze({
  id: "22222222-2222-4222-8222-222222222222",
  organiserId: "11111111-1111-4111-8111-111111111111",
  eventName: "IS212 Industry Night",
  purpose: "Connect students with industry.",
  proposedStart: "2026-11-11T10:00:00+08:00",
  proposedEnd: "2026-11-11T12:00:00+08:00",
  expectedAttendance: 150,
  venueRequirements: null,
  accessibilityRequirements: null,
  status: "approved",
  assignedCoordinatorId: COORDINATOR_ID,
  statusDisplay: { status: "approved", label: "Approved", group: "APPROVED", description: "" },
});

const SEMINAR = Object.freeze({
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  name: "Seminar Room",
  location: "Level 3",
  maxCapacity: 80,
  layouts: ["theatre", "classroom"],
  accessibility: [],
  facilities: ["projector"],
  retiredAt: null,
});

const CRITERIA_ORDER = ["Capacity", "Operating hours", "Layout", "Accessibility", "Facilities", "Availability"];

function httpError(status, data) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { error: "database prose with a uuid", ...data } },
  });
}

/** The "When" text a venue period should read, built from the instants. */
function singaporeWhen(startsAt, endsAt) {
  const start = toVenueWallClock(startsAt);
  const end = toVenueWallClock(endsAt);
  const sameDay = start.slice(0, 10) === end.slice(0, 10);
  return `${start.replace("T", " ")} – ${sameDay ? end.slice(11) : end.replace("T", " ")} (Singapore time)`;
}

/**
 * A stateful stand-in for the suitability, request and bookings endpoints.
 * It judges like the server: the saved event, never the search form.
 */
function createFakeSuitabilityBackend() {
  const bookings = [];
  let viewer = "coordinator";

  function judge(venue, { layout = null, accessibility = [], facilities = [] } = {}) {
    const capacityMet = venue.maxCapacity >= EVENT.expectedAttendance;
    const criteria = [
      {
        criterion: "Capacity",
        met: capacityMet,
        detail: `Capacity ${venue.maxCapacity} ${capacityMet ? "≥" : "<"} expected attendance ${EVENT.expectedAttendance}`,
      },
      { criterion: "Operating hours", met: true, detail: "Open 08:00–22:00 on Wednesday" },
      {
        criterion: "Layout",
        met: !layout || venue.layouts.includes(layout),
        detail: layout ? `Layout ${layout} offered` : "No layout requested",
        layout,
        offers: [...venue.layouts],
      },
      { criterion: "Accessibility", met: true, detail: "None requested", missing: [], requested: accessibility },
      { criterion: "Facilities", met: true, detail: "All requested facilities are provided", missing: [], requested: facilities },
      { criterion: "Availability", met: true, detail: "No booking, hold or block overlaps the event" },
    ];
    return {
      suitable: criteria.every((c) => c.met),
      criteria,
      checked: {
        startsAt: EVENT.proposedStart,
        endsAt: EVENT.proposedEnd,
        expectedAttendance: EVENT.expectedAttendance,
        layout,
        accessibility,
        facilities,
      },
    };
  }

  const unmetNames = (result) => result.criteria.filter((c) => !c.met).map((c) => c.criterion);

  return {
    bookings,
    signInAs(role) {
      viewer = role;
    },

    async findVenuesForEvent(criteria) {
      return [SEMINAR].filter((v) => v.maxCapacity >= criteria.expectedAttendance).map((v) => structuredClone(v));
    },

    async checkVenueSuitability(eventRequestId, venueId, requirements) {
      expect(eventRequestId).toBe(EVENT.id);
      expect(venueId).toBe(SEMINAR.id);
      return judge(SEMINAR, requirements);
    },

    async createBookingRequest(input) {
      const requirements = {
        layout: input.roomLayoutCode ?? null,
        accessibility: input.accessibility ?? [],
        facilities: input.facilities ?? [],
      };
      const result = judge(SEMINAR, requirements);
      const unmet = unmetNames(result);
      const acknowledged = Array.isArray(input.acknowledgedCriteria) ? input.acknowledgedCriteria : [];
      const confirmed = input.confirmUnsuitable === true && unmet.every((name) => acknowledged.includes(name));
      if (!result.suitable && !confirmed) {
        throw httpError(409, {
          code: "SUITABILITY_CONFIRMATION_REQUIRED",
          conflicts: result.criteria.filter((c) => !c.met),
        });
      }
      const booking = {
        id: "b0000000-0000-4000-8000-000000000001",
        eventRequestId: input.eventRequestId,
        venueId: input.venueId,
        status: "pending",
        requirements,
        suitability: result,
        suitabilityOverridden: !result.suitable,
        createdAt: "2026-10-11T09:00:00+08:00",
      };
      bookings.push(booking);
      return { id: booking.id, status: "pending" };
    },

    async getEventVenueSuitability(eventRequestId) {
      return bookings
        .filter((b) => b.eventRequestId === eventRequestId)
        .map((b) => {
          const current = judge(SEMINAR, b.requirements);
          const atRequestUnmet = unmetNames(b.suitability);
          const accepted = b.suitabilityOverridden ? atRequestUnmet : [];
          return {
            bookingId: b.id,
            venueId: SEMINAR.id,
            venueName: SEMINAR.name,
            venueLocation: SEMINAR.location,
            status: b.status,
            statusDisplay: { status: "pending", label: "Pending", group: "PENDING", description: "" },
            suitabilityOverridden: b.suitabilityOverridden,
            bookingStartsAt: EVENT.proposedStart,
            bookingEndsAt: EVENT.proposedEnd,
            current,
            atRequest: { suitable: b.suitability.suitable, unmet: atRequestUnmet },
            newlyUnmet: unmetNames(current).filter((name) => !accepted.includes(name)),
          };
        });
    },

    async getVenueBookings(venueId) {
      return bookings
        .filter((b) => b.venueId === venueId)
        .map((b) => {
          const row = {
            id: b.id,
            eventRequestId: b.eventRequestId,
            venueId: b.venueId,
            startsAt: EVENT.proposedStart,
            endsAt: EVENT.proposedEnd,
            status: b.status,
            statusDisplay: { status: "pending", label: "Pending", group: "PENDING" },
            createdAt: b.createdAt,
          };
          if (viewer !== "venue_staff") return row;
          return {
            ...row,
            eventName: EVENT.eventName,
            roomLayoutCode: b.requirements.layout,
            suitability: b.suitability,
            suitabilityOverridden: b.suitabilityOverridden,
            overriddenCriteria: b.suitabilityOverridden ? unmetNames(b.suitability) : [],
          };
        });
    },

    async getVenueDetails() {
      return { ...structuredClone(SEMINAR), emergencyAccess: null, knownRestrictions: null };
    },
  };
}

let fake;

beforeEach(() => {
  for (const service of [
    eventRequestService,
    eventEquipmentService,
    venueService,
    bookingRequestService,
    venueSuitabilityService,
  ]) {
    for (const fn of Object.values(service)) {
      vi.mocked(fn).mockReset();
      vi.mocked(fn).mockRejectedValue(new Error("unexpected call"));
    }
  }
  // The reads the event view makes on mount that this flow is not about.
  for (const name of [
    "getCoordinatorChangeRequests",
    "getAssignmentHistory",
    "getAssignmentHistoryForReview",
    "getEventClarificationHistory",
  ]) {
    vi.mocked(eventRequestService[name]).mockResolvedValue([]);
  }
  vi.mocked(eventEquipmentService.getEventEquipment).mockResolvedValue([]);
  vi.mocked(eventEquipmentService.getActiveEquipmentTypes).mockResolvedValue([]);
  vi.mocked(venueService.getVenueHistory).mockResolvedValue([]);

  fake = createFakeSuitabilityBackend();
  for (const name of ["findVenuesForEvent", "getVenueBookings", "getVenueDetails"]) {
    vi.mocked(venueService[name]).mockImplementation(fake[name]);
  }
  vi.mocked(bookingRequestService.createBookingRequest).mockImplementation(fake.createBookingRequest);
  for (const name of ["checkVenueSuitability", "getEventVenueSuitability"]) {
    vi.mocked(venueSuitabilityService[name]).mockImplementation(fake[name]);
  }
  vi.mocked(useAuth).mockReturnValue({ user: { id: COORDINATOR_ID, role: "event_coordinator" } });
});

const finderSection = () => screen.getByRole("heading", { name: "Find a venue" }).closest("section");
const suitabilitySection = () => screen.getByRole("heading", { name: "Venue suitability" }).closest("section");
const checkPanel = () => screen.getByRole("region", { name: "Suitability of Seminar Room" });
const requestPanel = () => screen.getByRole("region", { name: "Request Seminar Room" });

/** The <dd> for a term, inside `scope`. */
function definition(scope, term) {
  return within(scope).getByText(term, { selector: "dt" }).nextElementSibling;
}

function renderEventView() {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <CoordinatorRequestDetail request={{ ...EVENT }} onChangeRequestProcessed={vi.fn()} />
    </MemoryRouter>,
  );
  return { user };
}

/**
 * Step 1: Find a venue -> search with the form's attendance lowered to 80, so
 * Seminar Room is found -> Check suitability.
 */
async function checkSeminarRoom() {
  const { user } = renderEventView();
  await within(suitabilitySection()).findByText("No venue has been requested for this event yet.");

  const finder = finderSection();
  fireEvent.change(within(finder).getByLabelText("Expected attendance"), { target: { value: "80" } });
  await user.selectOptions(within(finder).getByLabelText("Layout"), "theatre");
  await user.click(within(finder).getByRole("button", { name: "Search venues" }));
  await user.click(await within(finder).findByRole("button", { name: "Check suitability: Seminar Room" }));
  await within(checkPanel()).findByText("Not suitable");
  return { user };
}

/** Step 2: Request this venue -> tick the confirmation -> send. */
async function requestDespiteCapacity(user) {
  await user.click(within(checkPanel()).getByRole("button", { name: "Request this venue" }));
  const panel = requestPanel();
  const send = within(panel).getByRole("button", { name: "Request this venue" });
  expect(send).toBeDisabled();
  await user.click(within(panel).getByRole("checkbox", { name: /I understand this venue does not meet the requirements/ }));
  expect(send).toBeEnabled();
  await user.click(send);
  await within(requestPanel()).findByText(/Request sent to Venue Staff for Seminar Room/);
}

describe("SCRUM188 venue suitability flow", () => {
  it("SCRUM188_AC1_flow_check_suitability_from_find_a_venue_shows_not_suitable", async () => {
    await checkSeminarRoom();
    const panel = checkPanel();

    expect(within(panel).getByRole("status")).toHaveTextContent("Seminar Room: Not suitable");
    const items = within(within(panel).getByRole("list", { name: "Criteria" })).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector(".venue-suitability__criterion-name").textContent)).toEqual(
      CRITERIA_ORDER,
    );
    expect(within(items[0]).getByText("Not met")).toBeInTheDocument();
    expect(items[0]).toHaveTextContent("Capacity 80 < expected attendance 150");
    items.slice(1).forEach((li) => expect(within(li).getByText("Met")).toBeInTheDocument());
    // AC3: judged on the event's saved attendance, not the 80 in the form.
    expect(definition(panel, "Expected attendance")).toHaveTextContent("150");
    expect(items[2]).toHaveTextContent("Layout Theatre offered");
  });

  it("SCRUM188_AC7_flow_request_needs_the_confirm_box_then_is_submitted", async () => {
    const { user } = await checkSeminarRoom();
    await requestDespiteCapacity(user);

    expect(bookingRequestService.createBookingRequest).toHaveBeenCalledTimes(1);
    expect(bookingRequestService.createBookingRequest).toHaveBeenCalledWith({
      eventRequestId: EVENT.id,
      venueId: SEMINAR.id,
      roomLayoutCode: "theatre",
      confirmUnsuitable: true,
      acknowledgedCriteria: ["Capacity"],
    });
    expect(fake.bookings).toHaveLength(1);
    expect(fake.bookings[0].suitabilityOverridden).toBe(true);
  });

  it("SCRUM188_AC6_flow_the_section_refetches_and_shows_the_requested_venue", async () => {
    const { user } = await checkSeminarRoom();
    expect(venueSuitabilityService.getEventVenueSuitability).toHaveBeenCalledTimes(1);
    await requestDespiteCapacity(user);

    await waitFor(() => expect(venueSuitabilityService.getEventVenueSuitability).toHaveBeenCalledTimes(2));
    const section = suitabilitySection();
    const item = (await within(section).findByRole("heading", { name: "Seminar Room" })).closest("li");
    expect(within(item).getByText("Not suitable", { selector: ".event-venue-suitability__verdict" })).toBeInTheDocument();
    expect(within(item).getByText("Requested although it did not meet: Capacity")).toBeInTheDocument();
    // Capacity was accepted at request time, so it raises no new alert, and
    // the opened result marks it as overridden.
    expect(within(item).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(item).getByText("Not met — overridden by coordinator")).toBeInTheDocument();
  });

  it("SCRUM188_AC7_flow_a_reloaded_event_does_not_offer_a_second_request", async () => {
    const { user } = await checkSeminarRoom();
    await requestDespiteCapacity(user);
    cleanup();

    const { user: again } = renderEventView();
    await within(suitabilitySection()).findByRole("heading", { name: "Seminar Room" });
    const finder = finderSection();
    fireEvent.change(within(finder).getByLabelText("Expected attendance"), { target: { value: "80" } });
    await again.click(within(finder).getByRole("button", { name: "Search venues" }));

    expect(await within(finder).findByRole("button", { name: "Request this venue: Seminar Room" })).toBeDisabled();
    expect(within(finder).getByText("This event already has a venue request, so another cannot be started.")).toBeInTheDocument();
  });

  it("SCRUM188_AC7_flow_venue_staff_see_requested_despite_not_meeting_capacity", async () => {
    const { user } = await checkSeminarRoom();
    await requestDespiteCapacity(user);
    cleanup();

    fake.signInAs("venue_staff");
    render(<VenueDetail venue={{ id: SEMINAR.id, name: SEMINAR.name, location: SEMINAR.location }} />);

    const row = (await screen.findByText(EVENT.eventName)).closest("li");
    expect(within(row).getByText(/Suitability when requested:/)).toHaveTextContent(
      "Suitability when requested: Not suitable",
    );
    expect(within(row).getByText("Requested despite not meeting: Capacity")).toBeInTheDocument();
    const capacity = within(row)
      .getAllByRole("listitem")
      .find((li) => li.textContent.includes("Capacity 80 < expected attendance 150"));
    expect(within(capacity).getByText("Not met — overridden by coordinator")).toBeInTheDocument();
  });

  it("SCRUM188_AC2_flow_checked_period_reads_in_singapore_time_in_any_zone", async () => {
    const expected = singaporeWhen(EVENT.proposedStart, EVENT.proposedEnd);
    const { user } = await checkSeminarRoom();

    expect(definition(checkPanel(), "When")).toHaveTextContent(expected);

    await user.click(within(checkPanel()).getByRole("button", { name: "Request this venue" }));
    expect(definition(requestPanel(), "When")).toHaveTextContent(expected);
  });
});
