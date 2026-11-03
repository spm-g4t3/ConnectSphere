// scrum586EventWorkspace.test.jsx
//
// The event screen's frame follows the UI standard: its name is the page's h1
// on its own route and an h2 inside a list, with no heading level skipped; a
// header with the status badge and one facts line; the main column; then an
// "Event facts" rail holding Provenance and Coordinator. The Lead gets the
// same frame. The review page uses the standard loading and error states.
// Every service is mocked, so nothing touches the network.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import CoordinatorRequestDetail from "../../src/components/CoordinatorRequestDetail.jsx";
import EventRequestReviewPage from "../../src/components/EventRequestReviewPage.jsx";
import MyAssignedEvents from "../../src/components/MyAssignedEvents.jsx";
import ReviewQueue from "../../src/components/ReviewQueue.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import * as bookingRequestService from "../../src/services/bookingRequestService";
import * as eventEquipmentService from "../../src/services/eventEquipmentService";
import * as eventRegistrationService from "../../src/services/eventRegistrationService";
import * as eventRequestService from "../../src/services/eventRequestService";
import * as flaggedBookingService from "../../src/services/flaggedBookingService";
import * as venueService from "../../src/services/venueService";
import * as venueSuitabilityService from "../../src/services/venueSuitabilityService";
import { httpError } from "../helpers/async.js";

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
const HOLDER = { id: "44444444-4444-4444-8444-444444444444", role: "event_coordinator" };
const LEAD = { id: "77777777-7777-4777-8777-777777777777", role: "event_coordinator_lead" };

// 01:00Z is 9:00 am in Singapore, so a device-zone helper would show otherwise.
const APPROVED = Object.freeze({
  id: ID,
  organiserId: "11111111-1111-4111-8111-111111111111",
  organiserName: "Olive Organiser",
  eventName: "IS212 Industry Night",
  purpose: "Connect students with industry.",
  proposedStart: "2026-01-15T01:00:00Z",
  proposedEnd: "2026-01-15T03:00:00Z",
  expectedAttendance: 120,
  status: "approved",
  assignedCoordinatorId: HOLDER.id,
  submittedAt: "2026-01-02T01:00:00Z",
  decision: "approved",
  statusDisplay: { status: "approved", label: "Approved", group: "APPROVED", description: "Approved by the coordinator." },
});
const FACTS = "15 Jan 2026, 9:00 am – 11:00 am · 120 attendees · Olive Organiser";

function signIn(user) {
  vi.mocked(useAuth).mockReturnValue({ user });
}

function renderDetail(user, request = APPROVED, props = {}) {
  signIn(user);
  return render(
    <MemoryRouter>
      <CoordinatorRequestDetail request={request} onChangeRequestProcessed={vi.fn()} onReviewDecisionProcessed={vi.fn()} {...props} />
    </MemoryRouter>,
  );
}

function renderPage(user = HOLDER) {
  signIn(user);
  render(
    <MemoryRouter initialEntries={[`/event-requests/${ID}`]}>
      <Routes>
        <Route path="/event-requests/:eventRequestId" element={<EventRequestReviewPage />} />
      </Routes>
    </MemoryRouter>,
  );
  return { user: userEvent.setup() };
}

/** Each heading's level, in reading order, the closed tabs' panels included. */
function headingLevels() {
  return screen.getAllByRole("heading", { hidden: true }).map((heading) => Number(heading.tagName.slice(1)));
}

/** Waits for the reads that add headings (the venue under suitability, the assignment history). */
async function settled() {
  await screen.findByRole("heading", { name: "Assignment history" });
  await screen.findByRole("heading", { name: "Hall A" });
}

const title = (level) => screen.getByRole("heading", { level, name: "IS212 Industry Night" });
const rail = () => screen.getByRole("complementary", { name: "Event facts" });
const precedes = (first, second) =>
  Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(() => {
  vi.resetAllMocks();
  for (const service of MOCKED_SERVICES) {
    for (const fn of Object.values(service)) if (vi.isMockFunction(fn)) fn.mockResolvedValue([]);
  }
  vi.mocked(eventRequestService.getEventRequestForReview).mockResolvedValue(APPROVED);
  vi.mocked(eventRequestService.getMyAssignedEvents).mockResolvedValue([APPROVED]);
  vi.mocked(eventRequestService.getEventRequestQueue).mockResolvedValue([APPROVED]);
  // One requested venue, so Venue suitability renders a heading under its own.
  vi.mocked(venueSuitabilityService.getEventVenueSuitability).mockResolvedValue([
    { bookingId: "b1", venueId: "v1", venueName: "Hall A", status: "pending", current: null },
  ]);
});

describe("SCRUM586_AC2 the event screen's headings", () => {
  it("SCRUM586_AC2_as_a_page_the_event_name_is_the_one_h1_and_no_level_is_skipped", async () => {
    renderDetail(HOLDER, APPROVED, { asPage: true });
    await settled();

    expect(screen.getAllByRole("heading", { level: 1 })).toEqual([title(1)]);
    expect(screen.getByRole("heading", { level: 2, name: "The request", hidden: true })).toBeInTheDocument();
    // The safety check panel now sits inside the Next step card, one level down.
    expect(screen.getByRole("heading", { level: 2, name: "Next step" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Submit for the safety check" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Assignment history" })).toBeInTheDocument();
    const levels = headingLevels();
    levels.forEach((level, i) => {
      if (i > 0) expect(level - levels[i - 1]).toBeLessThanOrEqual(1);
    });
  });

  it("SCRUM586_AC2_inside_a_list_the_title_is_h2_and_no_level_is_skipped", async () => {
    renderDetail(HOLDER);
    await settled();

    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(title(2)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Provenance" })).toBeInTheDocument();
    const levels = headingLevels();
    expect(levels[0]).toBe(2);
    levels.forEach((level, i) => {
      if (i > 0) expect(level - levels[i - 1]).toBeLessThanOrEqual(1);
    });
  });

  it.each([
    { name: "Review queue", Component: ReviewQueue, open: "Review" },
    { name: "My events", Component: MyAssignedEvents, open: "Open" },
  ])("SCRUM586_AC2_opened_from_a_list_the_screen_adds_no_h1 ($name)", async ({ name, Component, open }) => {
    signIn(HOLDER);
    let user = userEvent.setup();
    render(<MemoryRouter><Component /></MemoryRouter>);
    await user.click((await screen.findAllByRole("button", { name: open }))[0]);

    expect(title(2)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    cleanup();

    // On the list's own page, its h1 stays the only one.
    user = userEvent.setup();
    render(<MemoryRouter><Component asPage /></MemoryRouter>);
    await user.click((await screen.findAllByRole("button", { name: open }))[0]);

    expect(title(2)).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(name);
  });
});

describe("SCRUM586_AC2 the event screen's frame", () => {
  it("SCRUM586_AC2_the_event_facts_rail_holds_provenance_and_coordinator", async () => {
    renderDetail(HOLDER, APPROVED, { asPage: true });

    const aside = rail();
    expect(within(aside).getByRole("heading", { name: "Provenance" })).toBeInTheDocument();
    expect(within(aside).getByText("Olive Organiser")).toBeInTheDocument();
    expect(within(aside).getByRole("heading", { name: "Coordinator" })).toBeInTheDocument();
    expect(await within(aside).findByRole("heading", { name: "Assignment history" })).toBeInTheDocument();
    // Nothing else moved there.
    expect(within(aside).queryByRole("heading", { name: "The request", hidden: true })).not.toBeInTheDocument();
    expect(within(aside).queryByRole("heading", { name: "Find a venue", hidden: true })).not.toBeInTheDocument();
  });

  it("SCRUM586_AC2_reads_header_then_main_column_then_rail", async () => {
    renderDetail(HOLDER, APPROVED, { asPage: true });
    await settled();

    const header = title(1).closest("header");
    const request = screen.getByRole("heading", { name: "The request", hidden: true });
    const finder = screen.getByRole("heading", { name: "Find a venue" });
    expect(header).toContainElement(screen.getByRole("button", { name: "Reject event" }));
    expect(precedes(header, finder)).toBe(true);
    expect(header).not.toContainElement(request);
    expect(precedes(finder, rail())).toBe(true);
    expect(precedes(request, rail())).toBe(true);
    expect(rail()).not.toContainElement(finder);
    expect(rail()).not.toContainElement(request);
  });

  it("SCRUM586_AC2_the_header_shows_the_status_badge_and_the_facts_line", async () => {
    renderDetail(HOLDER, APPROVED, { asPage: true });
    await settled();

    const header = within(title(1).closest("header"));
    expect(header.getByText("Approved")).toHaveClass("ui-status-badge", "ui-status-badge--success");
    expect(header.getByText(FACTS)).toBeInTheDocument();
  });

  it("SCRUM586_AC2_a_queue_row_without_an_organiser_name_leaves_it_out_of_the_facts_line", async () => {
    renderDetail(HOLDER, { ...APPROVED, organiserName: undefined, expectedAttendance: null });
    await settled();

    const header = within(title(2).closest("header"));
    expect(header.getByText("15 Jan 2026, 9:00 am – 11:00 am")).toBeInTheDocument();
    expect(header.queryByText(new RegExp(APPROVED.organiserId))).not.toBeInTheDocument();
  });

  it("SCRUM586_AC2_the_lead_sees_the_same_header_and_rail", async () => {
    renderDetail(LEAD, APPROVED, { asPage: true });
    await screen.findByRole("heading", { name: "Assignment history" });

    const header = within(title(1).closest("header"));
    expect(header.getByText("Approved")).toHaveClass("ui-status-badge");
    expect(header.getByText(FACTS)).toBeInTheDocument();
    // The holder's actions stay the holder's.
    expect(header.queryByRole("button", { name: "Reject event" })).not.toBeInTheDocument();
    const aside = within(rail());
    expect(aside.getByRole("heading", { name: "Provenance" })).toBeInTheDocument();
    expect(aside.getByRole("heading", { name: "Coordinator" })).toBeInTheDocument();
    expect(aside.getByRole("button", { name: "Hand over to another coordinator" })).toBeInTheDocument();
  });
});

describe("SCRUM586_AC4 the event page's loading and error states", () => {
  it("SCRUM586_AC4_shows_the_standard_loading_text", () => {
    vi.mocked(eventRequestService.getEventRequestForReview).mockReturnValue(new Promise(() => {}));
    renderPage();

    expect(screen.getByRole("status")).toHaveTextContent(/^Loading\.\.\.$/);
  });

  it("SCRUM586_AC4_a_failed_read_offers_try_again_and_reads_again", async () => {
    vi.mocked(eventRequestService.getEventRequestForReview)
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValueOnce(APPROVED);
    const { user } = renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveClass("ui-error-notice");
    expect(alert).toHaveTextContent("This event request could not be loaded. Please try again.");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { level: 1, name: "IS212 Industry Night" })).toBeInTheDocument();
    expect(eventRequestService.getEventRequestForReview).toHaveBeenCalledTimes(2);
    // The button has gone, so focus lands on the page rather than the body.
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement).toContainElement(title(1));
  });

  it.each([
    { role: "coordinator", who: HOLDER, status: 403, message: "Only Event Coordinators and the Event Coordinator Lead can open an event here." },
    { role: "coordinator", who: HOLDER, status: 404, message: "This event isn't available to you. It may have been handed over to another coordinator, or it may no longer exist." },
    { role: "lead", who: LEAD, status: 404, message: "This event request doesn't exist or hasn't been submitted yet." },
  ])("SCRUM586_AC4_a_refused_or_missing_read_offers_no_try_again_and_keeps_its_words ($role, $status)", async ({ who, status, message }) => {
    vi.mocked(eventRequestService.getEventRequestForReview).mockRejectedValue(httpError(status));
    renderPage(who);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveClass("ui-error-notice");
    expect(alert).toHaveTextContent(message);
    expect(within(alert).queryByRole("button")).not.toBeInTheDocument();
  });
});
