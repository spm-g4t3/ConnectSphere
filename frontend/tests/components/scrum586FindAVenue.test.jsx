// scrum586FindAVenue.test.jsx
//
// The Find a Venue screens on the UI standard: /venue-search, the finder on
// the event page's Venues tab, and the suitability and request panels both
// open. Headings nest under whatever section holds them, controls are the
// shared Button and StatusBadge, failed reads offer Try again only when it can
// help, and opening or closing a panel leaves focus on something named.
// Services are mocked.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import VenueSearch from "../../src/components/VenueSearch.jsx";
import EventVenueFinder from "../../src/components/EventVenueFinder.jsx";
import BookingRequestPanel from "../../src/components/BookingRequestPanel.jsx";
import VenueSuitabilityResult from "../../src/components/VenueSuitabilityResult.jsx";
import EventVenueSuitability from "../../src/components/EventVenueSuitability.jsx";
import { findVenuesForEvent, searchActiveVenues } from "../../src/services/venueService";
import { createBookingRequest } from "../../src/services/bookingRequestService";
import { checkVenueSuitability, getEventVenueSuitability } from "../../src/services/venueSuitabilityService";
import { formatVenuePeriod } from "../../src/services/datetimeFormat.js";
import { deferred, httpError } from "../helpers/async.js";

vi.mock("../../src/services/venueService", () => ({
  findVenuesForEvent: vi.fn(),
  searchActiveVenues: vi.fn(),
}));
vi.mock("../../src/services/bookingRequestService", () => ({
  createBookingRequest: vi.fn(),
}));
vi.mock("../../src/services/venueSuitabilityService", () => ({
  checkVenueSuitability: vi.fn(),
  getEventVenueSuitability: vi.fn(),
}));

const USER_ID = "coordinator-1";
const HALL = { id: "v1", name: "Hall A", location: "Level 2", maxCapacity: 200 };
const ANNEX = { id: "v2", name: "Annex", location: "Block C", maxCapacity: 40 };
const OLD_HALL = { id: "v3", name: "Old Hall", location: "Block D", maxCapacity: 90, retiredAt: "2026-01-05T00:00:00Z" };
const FINDER_HALL = { ...HALL, layouts: [], accessibility: [], facilities: [] };
const FINDER_ANNEX = { ...ANNEX, layouts: [], accessibility: [], facilities: [] };

const EVENT = {
  id: "e1",
  status: "approved",
  assignedCoordinatorId: USER_ID,
  eventName: "Industry Night",
  proposedStart: "2026-11-11T10:00:00+08:00",
  proposedEnd: "2026-11-11T12:00:00+08:00",
  expectedAttendance: 80,
};

const UNSUITABLE = {
  suitable: false,
  criteria: [
    { criterion: "Capacity", met: false, detail: "Capacity 40 < expected attendance 80" },
    { criterion: "Availability", met: true, detail: "Free" },
  ],
  checked: { startsAt: EVENT.proposedStart, endsAt: EVENT.proposedEnd, expectedAttendance: 80 },
};
const PENDING = { id: "b1", status: "pending" };

function renderSearch({ path = "/venue-search", eventContext, asPage = true, role = "event_coordinator" } = {}) {
  const user = userEvent.setup();
  const [pathname, search = ""] = path.split("?");
  const state = eventContext ? { eventRequestContext: eventContext, returnToReview: { request: { id: "e1" } } } : undefined;
  render(
    <MemoryRouter initialEntries={[{ pathname, search: search ? `?${search}` : "", state }]}>
      <Routes>
        <Route path="/venue-search" element={<VenueSearch asPage={asPage} role={role} userId={USER_ID} />} />
      </Routes>
    </MemoryRouter>,
  );
  return user;
}

async function arriveWithResults(options) {
  const user = renderSearch({ path: "/venue-search?minCapacity=1", eventContext: EVENT, ...options });
  await screen.findByText("Hall A");
  return user;
}

function renderFinder(props = {}) {
  const user = userEvent.setup();
  render(<EventVenueFinder request={EVENT} userId={USER_ID} {...props} />);
  return user;
}

async function searchFinder(user) {
  await user.click(screen.getByRole("button", { name: "Search venues" }));
  await screen.findByRole("heading", { name: "Hall A" });
}

/** Every button on screen is the shared Button. */
function expectOnlySharedButtons() {
  for (const button of screen.getAllByRole("button")) expect(button).toHaveClass("ui-button");
}

beforeEach(() => {
  vi.mocked(searchActiveVenues).mockReset().mockResolvedValue([HALL, ANNEX]);
  vi.mocked(findVenuesForEvent).mockReset().mockResolvedValue([FINDER_HALL, FINDER_ANNEX]);
  vi.mocked(createBookingRequest).mockReset().mockResolvedValue(PENDING);
  vi.mocked(checkVenueSuitability).mockReset().mockResolvedValue(UNSUITABLE);
});

describe("SCRUM586 AC2 headings on the Find a Venue screens", () => {
  it("SCRUM586_AC2_venue_search_has_one_h1_and_its_request_panel_nests_under_it", async () => {
    const user = await arriveWithResults();

    await user.click(screen.getByRole("button", { name: "Request this venue: Annex" }));

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Find a venue");
    expect(screen.getByRole("heading", { level: 2, name: "Request Annex" })).toBeInTheDocument();
  });

  it("SCRUM586_AC2_the_request_panels_warning_sits_one_level_under_its_title", () => {
    render(<BookingRequestPanel event={EVENT} venue={ANNEX} suitability={UNSUITABLE} headingLevel={2} />);

    expect(screen.getByRole("heading", { level: 2, name: "Request Annex" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: /does not meet this request's requirements/ })).toBeInTheDocument();
  });

  // 3 on the event's own page (section h2), 4 under a list's title (section h3).
  it.each([3, 4])("SCRUM586_AC2_in_the_finder_the_panels_sit_at_the_results_level (%i)", async (level) => {
    const user = renderFinder({ headingLevel: level });
    await searchFinder(user);
    expect(screen.getByRole("heading", { level, name: "Annex" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Check suitability: Annex" }));
    expect(screen.getByRole("heading", { level, name: "Suitability of Annex" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: level + 1, name: "Checked against" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Request this venue" }));
    expect(screen.getByRole("heading", { level, name: "Request Annex" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: level + 1, name: /does not meet/ })).toBeInTheDocument();
  });

  it("SCRUM586_AC2_checked_against_takes_the_level_given_and_stays_h4_for_venue_staff", () => {
    const { unmount } = render(<VenueSuitabilityResult result={UNSUITABLE} headingLevel={5} />);
    expect(screen.getByRole("heading", { level: 5, name: "Checked against" })).toBeInTheDocument();
    unmount();

    // Venue Staff's booking summary passes no level.
    render(<VenueSuitabilityResult result={UNSUITABLE} />);
    expect(screen.getByRole("heading", { level: 4, name: "Checked against" })).toBeInTheDocument();
  });

  it("SCRUM586_AC2_a_requested_venues_breakdown_sits_under_its_venue_heading", async () => {
    vi.mocked(getEventVenueSuitability).mockResolvedValue([{ bookingId: "b1", venueName: "Annex", current: UNSUITABLE }]);
    render(<EventVenueSuitability eventRequestId="e1" headingLevel={4} />);

    expect(await screen.findByRole("heading", { level: 4, name: "Annex" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 5, name: "Checked against" })).toBeInTheDocument();
  });
});

describe("SCRUM586 AC3 and AC5 shared controls and their variants", () => {
  it("SCRUM586_AC3_AC5_venue_search_uses_the_shared_button_and_badge", async () => {
    vi.mocked(searchActiveVenues).mockResolvedValue([HALL, OLD_HALL]);
    const user = await arriveWithResults();
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-11-11T10:00" } });

    expect(screen.getByRole("button", { name: "Search venues" })).toHaveClass("ui-button--primary");
    expect(screen.getByRole("button", { name: "Clear dates" })).toHaveClass("ui-button--secondary");
    expect(screen.getByRole("button", { name: "Back to event review" })).toHaveClass("ui-button--link");
    expect(screen.getByRole("button", { name: "Request this venue: Hall A" })).toHaveClass("ui-button--secondary");
    expect(within(screen.getByText("Old Hall").closest("li")).getByText("Retired")).toHaveClass("ui-status-badge--neutral");

    await user.click(screen.getByRole("button", { name: "Request this venue: Hall A" }));
    expect(screen.getByRole("button", { name: "Request this venue" })).toHaveClass("ui-button--primary");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass("ui-button--secondary");
    expectOnlySharedButtons();
  });

  it("SCRUM586_AC3_AC5_the_finder_and_its_panels_use_the_shared_button", async () => {
    vi.mocked(checkVenueSuitability).mockRejectedValue(httpError(500));
    const user = renderFinder();
    await searchFinder(user);

    expect(screen.getByRole("button", { name: "Search venues" })).toHaveClass("ui-button--primary");
    expect(screen.getByRole("button", { name: "Check suitability: Hall A" })).toHaveClass("ui-button--secondary");
    expect(screen.getByRole("button", { name: "Request this venue: Hall A" })).toHaveClass("ui-button--secondary");

    await user.click(screen.getByRole("button", { name: "Check another venue" }));
    await user.click(screen.getByRole("button", { name: "Check suitability: Hall A" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Close" })).toHaveClass("ui-button--secondary");
    expectOnlySharedButtons();
  });

  it("SCRUM586_AC3_a_sent_request_and_whats_in_the_way_read_as_status_badges", async () => {
    vi.mocked(createBookingRequest).mockRejectedValueOnce(
      httpError(409, {
        code: "BOOKING_PERIOD_CONFLICT",
        conflicts: [
          { kind: "block", blockId: "bl1", startsAt: "2026-11-11T08:00:00+08:00", endsAt: "2026-11-11T11:00:00+08:00" },
          { kind: "hold", holdId: "h1", eventName: "Launch", startsAt: "2026-11-11T11:00:00+08:00", endsAt: "2026-11-11T12:00:00+08:00" },
        ],
      }),
    );
    const user = userEvent.setup();
    render(<BookingRequestPanel event={EVENT} venue={HALL} onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Request this venue" }));
    const list = await screen.findByRole("list", { name: "What is in the way" });
    expect(within(list).getByText("Blocked")).toHaveClass("ui-status-badge--danger");
    expect(within(list).getByText("Tentatively held")).toHaveClass("ui-status-badge--info");

    await user.click(screen.getByRole("button", { name: "Request this venue" }));
    expect(await screen.findByText("Pending")).toHaveClass("ui-status-badge--warning");
    expect(screen.getByRole("button", { name: "Close" })).toHaveClass("ui-button--secondary");
  });
});

describe("SCRUM586 AC4 loading, empty, error and date states", () => {
  it("SCRUM586_AC4_venue_search_shows_Loading_while_it_searches", async () => {
    const pending = deferred();
    vi.mocked(searchActiveVenues).mockReturnValue(pending.promise);
    renderSearch({ path: "/venue-search?q=hall" });

    expect(await screen.findByText("Loading...")).toBeInTheDocument();
    pending.resolve([HALL]);
    await screen.findByText("Hall A");
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });

  it("SCRUM586_AC4_a_failed_venue_search_offers_try_again_which_searches_again", async () => {
    vi.mocked(searchActiveVenues).mockRejectedValueOnce(httpError(500)).mockResolvedValueOnce([HALL]);
    const user = renderSearch({ path: "/venue-search?q=hall" });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load venues.");
    expect(alert).not.toHaveTextContent("Please try again");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    await screen.findByText("Hall A");
    expect(searchActiveVenues).toHaveBeenCalledTimes(2);
    expect(searchActiveVenues.mock.calls[1][0]).toEqual(searchActiveVenues.mock.calls[0][0]);
    // Try again has gone, so focus is on the page title rather than the body.
    expect(screen.getByRole("heading", { level: 1, name: "Find a venue" })).toHaveFocus();
  });

  it.each([403, 400])("SCRUM586_AC4_a_venue_search_refused_with_%i_has_no_try_again", async (status) => {
    vi.mocked(searchActiveVenues).mockRejectedValue(httpError(status));
    renderSearch({ path: "/venue-search?q=hall" });

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load venues.");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("SCRUM586_AC4_no_matching_venue_says_what_to_try_next", async () => {
    vi.mocked(searchActiveVenues).mockResolvedValue([]);
    renderSearch({ path: "/venue-search?q=nothing" });

    // Announced, so the answer is heard while focus stays in the form.
    const status = (await screen.findByText("No active venues match your search.")).closest('[role="status"]');
    expect(status).toHaveTextContent("Try part of another name or location, a lower minimum capacity or other dates.");
  });

  it("SCRUM586_AC4_the_blocked_venues_note_is_in_singapore_time", async () => {
    vi.mocked(searchActiveVenues).mockResolvedValue([HALL]);
    const user = renderSearch();
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-11-11T10:00" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-11-11T12:00" } });
    await user.click(screen.getByRole("button", { name: "Search venues" }));

    await screen.findByText("Hall A");
    const { startsAt, endsAt } = searchActiveVenues.mock.calls[0][0];
    expect(document.querySelector(".venue-search__window-note")).toHaveTextContent(
      `between ${formatVenuePeriod(startsAt, endsAt)} are not shown`,
    );
    expect(document.querySelector(".venue-search__window-note")).toHaveTextContent("(Singapore time)");
  });

  it("SCRUM586_AC4_the_other_venue_list_offers_try_again_only_when_reading_again_can_help", async () => {
    vi.mocked(searchActiveVenues).mockRejectedValueOnce(httpError(500)).mockResolvedValueOnce([HALL]);
    const user = renderFinder();
    await user.click(screen.getByRole("button", { name: "Check another venue" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load the list of venues.");
    expect(alert).not.toHaveTextContent("Please try again");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByLabelText("Active venue")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check another venue" })).toHaveFocus();
  });

  it("SCRUM586_AC4_a_refused_other_venue_list_has_no_try_again", async () => {
    vi.mocked(searchActiveVenues).mockRejectedValue(httpError(403));
    const user = renderFinder();
    await user.click(screen.getByRole("button", { name: "Check another venue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the list of venues.");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("SCRUM586_AC4_an_empty_other_venue_list_says_what_happens_next", async () => {
    vi.mocked(searchActiveVenues).mockResolvedValue([]);
    const user = renderFinder();
    await user.click(screen.getByRole("button", { name: "Check another venue" }));

    expect(await screen.findByText("There are no active venues to check.")).toBeInTheDocument();
    expect(screen.getByText("Venues appear here once Venue Staff add them to the catalogue.")).toBeInTheDocument();
  });

  it("SCRUM586_AC4_a_failed_finder_search_has_no_try_again_because_search_is_the_retry", async () => {
    vi.mocked(findVenuesForEvent).mockRejectedValue(httpError(500));
    const user = renderFinder();
    await user.click(screen.getByRole("button", { name: "Search venues" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it.each([
    [500, true],
    [403, false],
  ])("SCRUM586_AC4_a_failed_suitability_check_with_%i_offers_try_again_%s", async (status, offered) => {
    vi.mocked(checkVenueSuitability).mockRejectedValueOnce(httpError(status)).mockResolvedValueOnce(UNSUITABLE);
    const user = renderFinder();
    await searchFinder(user);
    await user.click(screen.getByRole("button", { name: "Check suitability: Annex" }));

    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent("Please try again");
    if (!offered) {
      expect(within(alert).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
      return;
    }
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Checked against" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Suitability of Annex" })).toHaveFocus();
  });

  it("SCRUM586_AC4_a_failed_request_has_no_try_again_because_sending_is_the_retry", async () => {
    vi.mocked(createBookingRequest).mockRejectedValue(httpError(500));
    const user = userEvent.setup();
    render(<BookingRequestPanel event={EVENT} venue={HALL} onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Request this venue" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });
});

describe("SCRUM586 AC7 focus when a panel opens and closes", () => {
  it("SCRUM586_AC7_venue_search_request_panel_takes_focus_and_cancel_returns_it_to_the_row", async () => {
    const user = await arriveWithResults();

    await user.click(screen.getByRole("button", { name: "Request this venue: Annex" }));
    expect(screen.getByRole("heading", { name: "Request Annex" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Request this venue: Annex" })).toHaveFocus());
  });

  it("SCRUM586_AC7_venue_search_after_a_request_focus_is_on_the_confirmation_then_on_the_title", async () => {
    const user = await arriveWithResults();
    await user.click(screen.getByRole("button", { name: "Request this venue: Annex" }));

    await user.click(screen.getByRole("button", { name: "Request this venue" }));
    expect(await screen.findByText(/Request sent to Venue Staff for Annex/)).toHaveFocus();

    // The row's button is locked now, so focus goes to the page title.
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Find a venue" })).toHaveFocus());
  });

  it("SCRUM586_AC7_a_venue_search_leaves_focus_on_the_search_button", async () => {
    const user = renderSearch();
    await user.type(screen.getByLabelText("Venue name or location"), "hall");
    await user.click(screen.getByRole("button", { name: "Search venues" }));

    await screen.findByText("Hall A");
    expect(screen.getByRole("button", { name: "Search venues" })).toHaveFocus();
  });

  it("SCRUM586_AC7_finder_check_panel_close_returns_focus_to_the_rows_check_button", async () => {
    const user = renderFinder();
    await searchFinder(user);

    await user.click(screen.getByRole("button", { name: "Check suitability: Annex" }));
    expect(screen.getByRole("heading", { name: "Suitability of Annex" })).toHaveFocus();
    await screen.findByRole("heading", { name: "Checked against" });

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Check suitability: Annex" })).toHaveFocus());
  });

  it("SCRUM586_AC7_finder_request_from_a_check_cancel_returns_focus_to_the_rows_request_button", async () => {
    const user = renderFinder();
    await searchFinder(user);
    await user.click(screen.getByRole("button", { name: "Check suitability: Annex" }));
    await screen.findByRole("heading", { name: "Checked against" });

    await user.click(screen.getByRole("button", { name: "Request this venue" }));
    expect(screen.getByRole("heading", { name: "Request Annex" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Request this venue: Annex" })).toHaveFocus());
  });

  it("SCRUM586_AC7_finder_a_request_from_check_another_venue_returns_focus_to_its_check_button", async () => {
    const user = renderFinder();
    await user.click(screen.getByRole("button", { name: "Check another venue" }));
    await user.selectOptions(await screen.findByLabelText("Active venue"), "v2");
    await user.click(screen.getByRole("button", { name: "Check" }));
    await screen.findByRole("heading", { name: "Checked against" });

    await user.click(screen.getByRole("button", { name: "Request this venue" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    // There is no result row for this venue, so focus goes back to where the check began.
    await waitFor(() => expect(screen.getByRole("button", { name: "Check" })).toHaveFocus());
  });

  it("SCRUM586_AC7_finder_after_a_request_focus_is_on_the_confirmation_then_on_the_results", async () => {
    const user = renderFinder();
    await searchFinder(user);
    await user.click(screen.getByRole("button", { name: "Request this venue: Hall A" }));
    expect(screen.getByRole("heading", { name: "Request Hall A" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Request this venue" }));
    expect(await screen.findByText(/Request sent to Venue Staff for Hall A/)).toHaveFocus();

    // Hall A's button is locked now, so focus goes to the results.
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.getByRole("list", { name: "Matching venues" })).toHaveFocus());
  });
});
