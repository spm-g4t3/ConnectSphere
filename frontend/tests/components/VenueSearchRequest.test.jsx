// VenueSearchRequest.test.jsx
//
// SCRUM-254 (part of SCRUM-243). "Request this venue" on venue search results:
// when it is offered, when it is disabled and why, and that it opens the same
// BookingRequestPanel flow for the selected venue. The search's own behaviour
// is pinned by VenueSearch.test.jsx and is deliberately not repeated here.
//
// venueService and bookingRequestService are mocked, so nothing touches the
// network. The event arrives the way CoordinatorRequestDetail sends it, as
// router state.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import VenueSearch from "../../src/components/VenueSearch.jsx";
import { searchActiveVenues } from "../../src/services/venueService";
import { createBookingRequest } from "../../src/services/bookingRequestService";
import { httpError } from "../helpers/async.js";

vi.mock("../../src/services/venueService", () => ({
  searchActiveVenues: vi.fn(),
}));
vi.mock("../../src/services/bookingRequestService", () => ({
  createBookingRequest: vi.fn(),
}));

const USER_ID = "coordinator-1";

const HALL = { id: "v1", name: "Hall A", location: "Level 2", maxCapacity: 200 };
const ANNEX = { id: "v2", name: "Annex", location: "Block C", maxCapacity: 40 };
const OLD_HALL = { id: "v3", name: "Old Hall", location: "Block D", maxCapacity: 90, retiredAt: "2026-01-05T00:00:00Z" };

const EVENT = {
  id: "e1",
  status: "approved",
  assignedCoordinatorId: USER_ID,
  proposedStart: "2026-12-01T09:00:00Z",
  proposedEnd: "2026-12-01T17:00:00Z",
  expectedAttendance: 150,
  accessibilityRequirements: "Step-free entrance",
  eventName: "Industry Night",
  venueRequirements: "Tiered seating",
};

function renderSearch({ eventContext, userId = USER_ID, role = "event_coordinator", onRequestSubmitted } = {}) {
  const user = userEvent.setup();
  const state = eventContext ? { eventRequestContext: eventContext } : undefined;
  render(
    <MemoryRouter initialEntries={[{ pathname: "/venue-search", search: "?minCapacity=1", state }]}>
      <Routes>
        <Route
          path="/venue-search"
          element={<VenueSearch role={role} userId={userId} onRequestSubmitted={onRequestSubmitted} />}
        />
      </Routes>
    </MemoryRouter>,
  );
  return { user };
}

const requestButtons = () => screen.queryAllByRole("button", { name: /^Request this venue:/ });
const requestButton = (name) => screen.getByRole("button", { name: `Request this venue: ${name}` });
const panel = () => screen.queryByRole("region", { name: /^Request / });

async function arrive(options) {
  const utils = renderSearch(options);
  await screen.findByText("Hall A");
  return utils;
}

beforeEach(() => {
  vi.mocked(searchActiveVenues).mockReset().mockResolvedValue([HALL, ANNEX]);
  vi.mocked(createBookingRequest).mockReset();
});

describe("when the button is offered", () => {
  it("SCRUM254_offers_it_on_every_active_row_when_the_search_came_from_an_event", async () => {
    await arrive({ eventContext: EVENT });
    expect(requestButtons()).toHaveLength(2);
    expect(requestButtons().every((b) => b.textContent === "Request this venue" && !b.disabled)).toBe(true);
  });

  it("SCRUM254_does_not_offer_it_on_an_ordinary_search", async () => {
    await arrive({});
    expect(requestButtons()).toHaveLength(0);
    expect(screen.getAllByRole("link", { name: "View calendar" })).toHaveLength(2);
  });

  it("SCRUM254_does_not_offer_it_when_the_context_has_no_event_id", async () => {
    await arrive({ eventContext: { eventName: "Industry Night", venueRequirements: null } });
    expect(requestButtons()).toHaveLength(0);
    // The banner this context always drove is untouched.
    expect(screen.getByText("Industry Night")).toBeInTheDocument();
  });

  it("SCRUM254_does_not_offer_it_on_a_retired_venue", async () => {
    vi.mocked(searchActiveVenues).mockResolvedValue([HALL, OLD_HALL]);
    await arrive({ eventContext: EVENT });
    expect(requestButtons()).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Old Hall/ })).not.toBeInTheDocument();
    expect(screen.getByText("Retired")).toBeInTheDocument();
  });
});

describe("when the coordinator cannot request", () => {
  it("SCRUM254_disables_it_for_a_coordinator_who_is_not_assigned_and_says_why", async () => {
    await arrive({ eventContext: EVENT, userId: "someone-else" });
    expect(requestButtons().every((b) => b.disabled)).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("Only the coordinator assigned to this event");
  });

  it.each(["submitted", "under_review", "planning", "cancelled"])(
    "SCRUM254_disables_it_for_a_%s_event",
    async (status) => {
      await arrive({ eventContext: { ...EVENT, status } });
      expect(requestButtons().every((b) => b.disabled)).toBe(true);
      expect(screen.getByRole("status")).toHaveTextContent("approved or confirmed");
    },
  );

  it("SCRUM254_a_confirmed_event_can_be_requested", async () => {
    await arrive({ eventContext: { ...EVENT, status: "confirmed" } });
    expect(requestButtons().every((b) => !b.disabled)).toBe(true);
  });

  it("SCRUM254_disables_it_when_nobody_is_known_to_be_signed_in", async () => {
    await arrive({ eventContext: EVENT, userId: null });
    expect(requestButtons().every((b) => b.disabled)).toBe(true);
  });

  it("SCRUM254_a_disabled_button_opens_nothing", async () => {
    const { user } = await arrive({ eventContext: EVENT, userId: "someone-else" });
    await user.click(requestButton("Hall A"));
    expect(panel()).not.toBeInTheDocument();
  });
});

describe("the request flow from a result", () => {
  it("SCRUM254_opens_the_panel_for_the_selected_venue_and_the_current_event", async () => {
    const { user } = await arrive({ eventContext: EVENT });

    await user.click(requestButton("Annex"));

    const open = panel();
    expect(within(open).getByRole("heading", { name: "Request Annex" })).toBeInTheDocument();
    expect(within(open).getByText("Industry Night")).toBeInTheDocument();
    expect(within(open).getByText("Step-free entrance")).toBeInTheDocument();
    expect(within(open).getByLabelText("Setup notes (optional)")).toBeInTheDocument();
  });

  it("SCRUM254_choosing_another_venue_replaces_the_panel_and_drops_its_unsent_notes", async () => {
    const { user } = await arrive({ eventContext: EVENT });

    await user.click(requestButton("Hall A"));
    await user.type(screen.getByLabelText("Setup notes (optional)"), "Hall notes");
    await user.click(requestButton("Annex"));

    expect(screen.getAllByRole("region", { name: /^Request / })).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Request Annex" })).toBeInTheDocument();
    expect(screen.getByLabelText("Setup notes (optional)")).toHaveValue("");
  });

  it("SCRUM254_cancel_closes_the_panel", async () => {
    const { user } = await arrive({ eventContext: EVENT });
    await user.click(requestButton("Hall A"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(panel()).not.toBeInTheDocument();
  });

  it("SCRUM254_sends_the_event_and_venue_with_the_notes", async () => {
    vi.mocked(createBookingRequest).mockResolvedValue({ id: "b1", status: "pending" });
    const { user } = await arrive({ eventContext: EVENT });

    await user.click(requestButton("Hall A"));
    await user.type(screen.getByLabelText("Setup notes (optional)"), "Extra tables");
    await user.click(within(panel()).getByRole("button", { name: "Request this venue" }));

    expect(createBookingRequest).toHaveBeenCalledWith({
      eventRequestId: "e1",
      venueId: "v1",
      expectedAttendance: 150,
      setupNotes: "Extra tables",
    });
  });

  it("SCRUM254_works_without_an_onRequestSubmitted_handler", async () => {
    vi.mocked(createBookingRequest).mockResolvedValue({ id: "b1", status: "pending" });
    const { user } = await arrive({ eventContext: EVENT });
    await user.click(requestButton("Hall A"));
    await user.click(within(panel()).getByRole("button", { name: "Request this venue" }));
    expect(await within(panel()).findByText(/Request sent/)).toBeInTheDocument();
  });

  // SCRUM-525 (AC1, R11): one live request per venue, so only the venue
  // requested from this page, or refused by the server, is locked, and its
  // row says why. This page has no Venue suitability list to point at.
  const LOCKED_HINT = "This event already has a request for this venue.";

  it("SCRUM525_AC1_venue_search_locks_only_the_requested_venue (after success and Close)", async () => {
    const created = { id: "b1", status: "pending" };
    vi.mocked(createBookingRequest).mockResolvedValue(created);
    const onRequestSubmitted = vi.fn();
    const { user } = await arrive({ eventContext: EVENT, onRequestSubmitted });

    await user.click(requestButton("Hall A"));
    await user.click(within(panel()).getByRole("button", { name: "Request this venue" }));
    expect(await within(panel()).findByText(/Request sent to Venue Staff for Hall A/)).toBeInTheDocument();
    expect(onRequestSubmitted).toHaveBeenCalledWith(created);
    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(panel()).not.toBeInTheDocument();
    expect(requestButton("Hall A")).toBeDisabled();
    expect(requestButton("Hall A")).toHaveAccessibleDescription(LOCKED_HINT);
    expect(requestButton("Annex")).toBeEnabled();
    expect(requestButton("Annex")).toHaveAccessibleDescription("");
  });

  it.each(["BOOKING_REQUEST_EXISTS", "BOOKING_FLAGGED_FOR_REVIEW"])(
    "SCRUM525_AC1_venue_search_locks_only_the_requested_venue (%s)",
    async (code) => {
      vi.mocked(createBookingRequest).mockRejectedValue(
        httpError(409, { code, conflicts: [{ kind: "booking_request", bookingId: "b9" }] }),
      );
      const { user } = await arrive({ eventContext: EVENT });

      await user.click(requestButton("Hall A"));
      await user.click(within(panel()).getByRole("button", { name: "Request this venue" }));

      expect(await within(panel()).findByRole("alert")).toHaveTextContent(/this venue/);
      expect(requestButton("Hall A")).toBeDisabled();
      expect(requestButton("Hall A")).toHaveAccessibleDescription(LOCKED_HINT);
      expect(requestButton("Annex")).toBeEnabled();
    },
  );

  it("SCRUM254_other_failures_leave_the_buttons_available", async () => {
    vi.mocked(createBookingRequest).mockRejectedValue(httpError(409, { code: "VENUE_RETIRED", conflicts: [] }));
    const { user } = await arrive({ eventContext: EVENT });

    await user.click(requestButton("Hall A"));
    await user.click(within(panel()).getByRole("button", { name: "Request this venue" }));

    expect(await within(panel()).findByRole("alert")).toHaveTextContent(/retired/);
    expect(requestButtons().every((b) => !b.disabled)).toBe(true);
  });

  it("SCRUM254_a_failed_suitability_check_asks_for_confirmation_from_a_search_result", async () => {
    vi.mocked(createBookingRequest)
      .mockRejectedValueOnce(
        httpError(409, {
          code: "SUITABILITY_CONFIRMATION_REQUIRED",
          conflicts: [{ criterion: "Capacity", met: false, detail: "Capacity 40 < expected attendance 150" }],
        }),
      )
      .mockResolvedValueOnce({ id: "b1", status: "pending" });
    const { user } = await arrive({ eventContext: EVENT });

    await user.click(requestButton("Annex"));
    await user.click(within(panel()).getByRole("button", { name: "Request this venue" }));

    expect(await screen.findByText("Capacity: Capacity 40 < expected attendance 150")).toBeInTheDocument();
    const send = within(panel()).getByRole("button", { name: "Request this venue" });
    expect(send).toBeDisabled();
    await user.click(within(panel()).getByRole("checkbox"));
    await user.click(send);

    expect(createBookingRequest).toHaveBeenLastCalledWith({
      eventRequestId: "e1",
      venueId: "v2",
      expectedAttendance: 150,
      confirmUnsuitable: true,
      acknowledgedCriteria: ["Capacity"],
    });
    expect(await within(panel()).findByText(/Request sent/)).toBeInTheDocument();
  });
});

describe("the search around it is unchanged", () => {
  it("SCRUM254_searching_again_keeps_the_open_panel_and_refreshes_the_results", async () => {
    const { user } = await arrive({ eventContext: EVENT });
    await user.click(requestButton("Hall A"));
    await user.type(screen.getByLabelText("Setup notes (optional)"), "Keep me");

    vi.mocked(searchActiveVenues).mockResolvedValue([ANNEX]);
    await user.click(screen.getByRole("button", { name: "Search venues" }));

    await screen.findByRole("button", { name: "Request this venue: Annex" });
    expect(screen.queryByRole("button", { name: "Request this venue: Hall A" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Setup notes (optional)")).toHaveValue("Keep me");
  });

  it("SCRUM254_keeps_the_calendar_link_beside_the_button", async () => {
    await arrive({ eventContext: EVENT });
    const row = screen.getByText("Hall A").closest("li");
    expect(within(row).getByRole("link", { name: "View calendar" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /Request this venue/ })).toBeInTheDocument();
  });
});
