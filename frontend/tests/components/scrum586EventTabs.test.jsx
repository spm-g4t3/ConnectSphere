// scrum586EventTabs.test.jsx
//
// The event screen's main column: what needs action (the Next step card, the
// Organiser's change requests, the registration numbers) stays above a set of
// tabs, Venues, Equipment, Details and Activity, which hold every other
// section. A tab with nothing in it for this viewer is left out. The tab that
// opens first follows the status, survives a re-read and resets for another
// event. The dates this screen formats itself are the standard ones. Every
// service is mocked, so nothing touches the network.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import CoordinatorRequestDetail from "../../src/components/CoordinatorRequestDetail.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import * as bookingRequestService from "../../src/services/bookingRequestService";
import * as eventEquipmentService from "../../src/services/eventEquipmentService";
import * as eventRegistrationService from "../../src/services/eventRegistrationService";
import * as eventRequestService from "../../src/services/eventRequestService";
import * as flaggedBookingService from "../../src/services/flaggedBookingService";
import * as venueService from "../../src/services/venueService";
import * as venueSuitabilityService from "../../src/services/venueSuitabilityService";
import { decide } from "../helpers/coordinatorDecision.js";
import { openTab } from "../helpers/eventTabs.js";

vi.mock("../../src/auth/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../../src/services/bookingRequestService");
vi.mock("../../src/services/eventEquipmentService");
vi.mock("../../src/services/eventRegistrationService");
vi.mock("../../src/services/eventRequestService");
vi.mock("../../src/services/flaggedBookingService");
vi.mock("../../src/services/venueService");
vi.mock("../../src/services/venueSuitabilityService");

const MOCKED_SERVICES = [
  bookingRequestService,
  eventEquipmentService,
  eventRegistrationService,
  eventRequestService,
  flaggedBookingService,
  venueService,
  venueSuitabilityService,
];

const ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";
const HOLDER = { id: "44444444-4444-4444-8444-444444444444", role: "event_coordinator" };
const LEAD = { id: "77777777-7777-4777-8777-777777777777", role: "event_coordinator_lead" };
const NOT_HOLDER = { id: "66666666-6666-4666-8666-666666666666", role: "event_coordinator" };
const TABS = ["Venues", "Equipment", "Details", "Activity"];

// 01:00Z is 9:00 am in Singapore, so a device-zone helper would show otherwise.
function eventRequest(status = "approved", overrides = {}) {
  return {
    id: ID,
    organiserId: "11111111-1111-4111-8111-111111111111",
    organiserName: "Olive Organiser",
    eventName: "IS212 Industry Night",
    purpose: "Connect students with industry.",
    proposedStart: "2026-01-15T01:00:00Z",
    proposedEnd: "2026-01-15T03:00:00Z",
    expectedAttendance: 120,
    status,
    assignedCoordinatorId: HOLDER.id,
    reviewingCoordinatorId: HOLDER.id,
    submittedAt: "2026-01-02T01:00:00Z",
    decision: ["submitted", "under_review", "pending_clarification"].includes(status) ? null : "approved",
    statusDisplay: { status, label: status, group: "APPROVED", description: "" },
    ...overrides,
  };
}

const FLAGGED = {
  id: "f1",
  eventRequestId: ID,
  venueId: "v5",
  venueName: "Old Hall",
  venueLocation: "Level 5",
  startsAt: "2026-01-15T01:00:00Z",
  endsAt: "2026-01-15T03:00:00Z",
  flaggedAt: "2026-01-10T02:00:00Z",
  reviewReason: "safety_review",
  block: null,
  replacementRequests: [],
};

const BOOKING = {
  id: "b1",
  eventRequestId: ID,
  venueName: "Hall B",
  status: "approved",
  statusDisplay: { label: "Approved" },
  startsAt: "2026-01-15T01:00:00Z",
  endsAt: "2026-01-15T03:00:00Z",
};

function signIn(user) {
  vi.mocked(useAuth).mockReturnValue({ user });
}

function ui(request, props = {}) {
  return (
    <MemoryRouter>
      <CoordinatorRequestDetail request={request} onChangeRequestProcessed={vi.fn()} onReviewDecisionProcessed={vi.fn()} {...props} />
    </MemoryRouter>
  );
}

function renderDetail(user, request = eventRequest(), props = {}) {
  signIn(user);
  const utils = render(ui(request, props));
  return { user: userEvent.setup(), ...utils, rerenderWith: (next) => utils.rerender(ui(next, props)) };
}

const tabNames = () => screen.getAllByRole("tab").map((tab) => tab.textContent);
const selectedTab = () => screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;
// Through the tab, as a closed panel has no accessible name of its own.
const panel = (name) => document.getElementById(screen.getByRole("tab", { name }).getAttribute("aria-controls"));
/** The headings directly in a panel, in order, whether or not it is the open one. */
const panelHeadings = (name, level) =>
  within(panel(name)).getAllByRole("heading", { level, hidden: true }).map((heading) => heading.textContent);
const precedes = (first, second) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(() => {
  vi.resetAllMocks();
  for (const service of MOCKED_SERVICES) {
    for (const fn of Object.values(service)) if (vi.isMockFunction(fn)) fn.mockResolvedValue([]);
  }
  vi.mocked(eventRequestService.getEventReadiness).mockResolvedValue({ ready: false, items: [] });
});

describe("SCRUM586_AC2 the event's sections in tabs", () => {
  it("SCRUM586_AC2_the_tabs_are_venues_equipment_details_activity_under_one_name", () => {
    renderDetail(HOLDER);

    expect(screen.getByRole("tablist", { name: "Event sections" })).toBeInTheDocument();
    expect(tabNames()).toEqual(TABS);
  });

  it("SCRUM586_AC2_venues_holds_flagged_bookings_venue_bookings_suitability_and_find_a_venue_in_that_order", async () => {
    vi.mocked(flaggedBookingService.getEventFlaggedBookings).mockResolvedValue([FLAGGED]);
    vi.mocked(bookingRequestService.getMyBookingRequests).mockResolvedValue([BOOKING]);
    renderDetail(HOLDER);
    await screen.findByRole("heading", { name: "Flagged bookings" });
    await screen.findByRole("heading", { name: "Venue bookings" });

    expect(panelHeadings("Venues", 3)).toEqual(["Flagged bookings", "Venue bookings", "Venue suitability", "Find a venue"]);
    expect(within(panel("Venues")).getByRole("link", { name: "Browse all venues" })).toBeInTheDocument();
  });

  it("SCRUM586_AC2_equipment_holds_the_equipment_section", () => {
    renderDetail(HOLDER);

    expect(panel("Equipment")).toContainElement(screen.getByLabelText("Equipment", { selector: ".change-request-review__equipment" }));
  });

  it("SCRUM586_AC2_details_holds_the_request_requirements_and_closing_notes_in_that_order", () => {
    renderDetail(HOLDER, eventRequest("completed", { closingNotes: "Attendance 180." }));

    expect(panelHeadings("Details", 3)).toEqual(["The request", "Requirements", "Closing notes"]);
  });

  it("SCRUM586_AC2_activity_holds_the_decision_change_history_and_clarification_history_in_that_order", async () => {
    vi.mocked(eventRequestService.getEventDecisionHistory).mockResolvedValue([{
      id: "d1", decision: "rejected", decisionNote: "Too few marshals.", decidedByName: "Priya Nair",
      decidedAt: "2026-01-05T03:00:00Z", supersededReason: "reopened_for_revision", supersededAt: "2026-01-06T03:00:00Z",
    }]);
    renderDetail(HOLDER);
    await within(panel("Activity")).findByRole("region", { name: "Previous decisions", hidden: true });

    const headings = panelHeadings("Activity", 3);
    const order = ["Decision", "Previous decisions", "Change history", "Clarification history"]
      .map((name) => headings.indexOf(name));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("SCRUM586_AC2_what_needs_action_stays_above_the_tabs", async () => {
    vi.mocked(eventRegistrationService.getRegistrationCounts).mockResolvedValue({
      registeredCount: 3, capacity: 120, waitlistEnabled: false, waitlistCount: 0,
    });
    renderDetail(HOLDER, eventRequest("approved", { statusDisplay: { status: "approved", label: "Approved", group: "APPROVED", description: "Approved." } }));
    const counts = await screen.findByRole("heading", { name: "Registrations" });

    const tablist = screen.getByRole("tablist");
    const above = [
      screen.getByRole("region", { name: "Next step" }),
      screen.getByRole("region", { name: "Organiser change requests" }),
      counts,
      screen.getByRole("link", { name: "View registrations" }),
    ];
    for (const element of above) {
      expect(precedes(element, tablist)).toBe(true);
      expect(element.closest("[role=tabpanel]")).toBeNull();
    }
    // In that order, too.
    above.slice(1).forEach((element, i) => expect(precedes(above[i], element)).toBe(true));
  });

  it("SCRUM586_AC2_a_tab_with_nothing_for_this_viewer_is_left_out", () => {
    // Waiting on the organiser: no decision yet, no histories for a coordinator
    // who does not hold it, and the clarification thread is in the Next step card.
    renderDetail(NOT_HOLDER, eventRequest("pending_clarification", { clarificationNote: "Numbers?" }));

    expect(tabNames()).toEqual(["Venues", "Equipment", "Details"]);
    expect(screen.getAllByRole("tabpanel", { hidden: true })).toHaveLength(3);
  });

  it("SCRUM586_AC2_the_holder_of_the_same_event_still_gets_activity", () => {
    renderDetail(HOLDER, eventRequest("pending_clarification", { clarificationNote: "Numbers?" }));

    expect(tabNames()).toEqual(TABS);
  });

  it("SCRUM586_AC2_the_lead_sees_the_same_tabs_and_the_same_first_tab", () => {
    renderDetail(LEAD);

    expect(tabNames()).toEqual(TABS);
    expect(selectedTab()).toBe("Venues");
    expect(panelHeadings("Activity", 3)).toEqual(expect.arrayContaining(["Decision", "Change history"]));
  });
});

describe("SCRUM586_AC2 which tab opens first", () => {
  it.each(["submitted", "under_review", "pending_clarification"])(
    "SCRUM586_AC2_a_%s_event_opens_on_details",
    (status) => {
      renderDetail(HOLDER, eventRequest(status));

      expect(selectedTab()).toBe("Details");
      expect(screen.getByRole("heading", { name: "The request" })).toBeVisible();
    },
  );

  it.each(["approved", "safety_review", "safety_approved", "confirmed", "completed", "rejected", "cancelled"])(
    "SCRUM586_AC2_a_%s_event_opens_on_venues",
    (status) => {
      renderDetail(HOLDER, eventRequest(status));

      expect(selectedTab()).toBe("Venues");
      expect(screen.getByRole("heading", { name: "Find a venue" })).toBeVisible();
    },
  );

  it("SCRUM586_AC2_the_chosen_tab_is_kept_when_the_event_is_read_again", async () => {
    const { user, rerenderWith } = renderDetail(HOLDER, eventRequest("approved"));
    await openTab(user, "Equipment");

    rerenderWith(eventRequest("approved", { purpose: "Changed elsewhere", updatedAt: "2026-01-09T00:00:00Z" }));

    expect(selectedTab()).toBe("Equipment");
  });

  it("SCRUM586_AC2_a_decision_made_here_keeps_the_tab_the_review_opened_on", async () => {
    // The status moves from under review to approved, whose own first tab is Venues.
    vi.mocked(eventRequestService.decideEventRequest).mockResolvedValue(eventRequest("approved"));
    const { user } = renderDetail(HOLDER, eventRequest("under_review"));

    await decide(user, "Approve request");
    await screen.findByRole("heading", { name: "Decision", hidden: true });

    expect(selectedTab()).toBe("Details");
  });

  it("SCRUM586_AC2_another_event_opens_on_its_own_first_tab", async () => {
    const { user, rerenderWith } = renderDetail(HOLDER, eventRequest("approved"));
    await openTab(user, "Activity");

    rerenderWith(eventRequest("approved", { id: OTHER_ID, eventName: "Gala" }));
    expect(selectedTab()).toBe("Venues");

    await openTab(user, "Equipment");
    rerenderWith(eventRequest("submitted", { eventName: "IS212 Industry Night" }));
    expect(selectedTab()).toBe("Details");
  });

  it("SCRUM586_AC2_a_venue_search_in_progress_survives_a_visit_to_another_tab", async () => {
    const { user } = renderDetail(HOLDER, eventRequest("approved"));
    const finder = () => screen.getByRole("heading", { name: "Find a venue" }).closest("section");
    await user.type(within(finder()).getByLabelText("Location"), "Level 2");

    await openTab(user, "Details");
    await openTab(user, "Venues");

    expect(within(finder()).getByLabelText("Location")).toHaveValue("Level 2");
  });
});

describe("SCRUM586_AC4 the dates this screen formats", () => {
  it("SCRUM586_AC4_provenance_shows_when_it_was_submitted_in_the_standard_format", () => {
    renderDetail(HOLDER);

    const provenance = screen.getByRole("heading", { name: "Provenance" }).closest("section");
    expect(within(provenance).getByText("2 Jan 2026, 9:00 am")).toBeInTheDocument();
  });

  it("SCRUM586_AC4_an_unrecorded_submission_still_says_so", () => {
    renderDetail(HOLDER, eventRequest("approved", { submittedAt: null }));

    const provenance = screen.getByRole("heading", { name: "Provenance" }).closest("section");
    expect(within(provenance).getByText("Not recorded")).toBeInTheDocument();
  });

  it("SCRUM586_AC4_the_proposed_period_is_one_standard_range", () => {
    renderDetail(HOLDER, eventRequest("submitted"));

    const request = screen.getByRole("heading", { name: "The request" }).closest("section");
    expect(within(request).getByText("15 Jan 2026, 9:00 am – 11:00 am")).toBeInTheDocument();
  });

  it("SCRUM586_AC4_a_period_with_no_dates_says_not_recorded_once", () => {
    renderDetail(HOLDER, eventRequest("submitted", { proposedStart: null, proposedEnd: null }));

    const request = screen.getByRole("heading", { name: "The request" }).closest("section");
    const period = within(request).getByText("Proposed period").nextElementSibling;
    expect(period).toHaveTextContent(/^Not recorded$/);
  });

  it("SCRUM586_AC4_the_wait_to_complete_names_the_end_in_the_standard_format", () => {
    // 10:00Z is 6:00 pm in Singapore.
    renderDetail(HOLDER, eventRequest("confirmed", { proposedStart: "2030-06-15T08:00:00Z", proposedEnd: "2030-06-15T10:00:00Z" }));

    expect(screen.getByText("You can mark this event as completed once it has ended (15 Jun 2030, 6:00 pm).")).toBeInTheDocument();
  });

  it("SCRUM586_AC4_the_reply_by_date_is_a_day_not_a_time", () => {
    renderDetail(HOLDER, eventRequest("pending_clarification", {
      clarificationNote: "Numbers?",
      clarificationReplyByDate: "2030-01-20",
    }));

    expect(screen.getByText("Reply by 20 Jan 2030")).toBeInTheDocument();
  });
});
