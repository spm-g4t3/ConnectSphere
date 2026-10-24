// VenueCatalogue.test.jsx
//
// SCRUM-127 (part of SCRUM-17). The catalogue's "Manage blocks" button, which
// opens VenueBlocksPanel for one venue. The venue service is mocked, and the
// panel is a stub that shows which venue it was opened for, so these tests
// cover only the catalogue's wiring.
//
// SCRUM-491 adds "Place hold" beside it, which opens VenueHoldsPanel the same
// way; that panel is a stub here too.
//
// SCRUM-484 (AC8) adds the flagged-bookings notice shown after an edit save.
// VenueForm is a stub here too: its Save button hands the catalogue whatever
// the test put in formStub.saved, as the real form passes updateVenue's
// response to onSaved. Timezone-safe: expected times are built with
// formatOccupiedPeriod / formatRange from the same instants.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom";

import VenueCatalogue from "../../src/components/VenueCatalogue.jsx";
import { getVenueCatalogue } from "../../src/services/venueService";
import { formatOccupiedPeriod } from "../../src/services/occupiedPeriodDisplay.js";
import { formatRange } from "../../src/services/displayFormat.js";

const formStub = vi.hoisted(() => ({ saved: undefined, options: undefined }));

vi.mock("../../src/services/venueService", () => ({
  getVenueCatalogue: vi.fn(),
  retireVenue: vi.fn(),
  createVenue: vi.fn(),
  getVenueDetails: vi.fn(),
  updateVenue: vi.fn(),
  getVenueBookings: vi.fn(),
  getVenueHistory: vi.fn(),
  listVenueBlocks: vi.fn(),
  createVenueBlock: vi.fn(),
  updateVenueBlock: vi.fn(),
  removeVenueBlock: vi.fn(),
}));

vi.mock("../../src/components/VenueBlocksPanel", () => ({
  default: ({ venue, currentUserId }) => (
    <div data-testid="blocks-panel" data-current-user-id={currentUserId ?? ""}>
      Blocks panel for {venue.name}
    </div>
  ),
}));

vi.mock("../../src/components/VenueHoldsPanel", () => ({
  default: ({ venue, currentUserId }) => (
    <div data-testid="holds-panel" data-current-user-id={currentUserId ?? ""}>
      Holds panel for {venue.name}
    </div>
  ),
}));

vi.mock("../../src/components/VenueForm", () => ({
  default: ({ venueId, onSaved }) => (
    <div data-testid="venue-form" data-venue-id={venueId ?? ""}>
      <button type="button" onClick={() => onSaved?.(formStub.saved, formStub.options)}>
        Stub save
      </button>
    </div>
  ),
}));

const ACTIVE = {
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  name: "Hall A",
  location: "Level 2",
  maxCapacity: 200,
  retiredAt: null,
};
const RETIRED = {
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
  name: "Old Annex",
  location: "Block C",
  maxCapacity: 50,
  retiredAt: "2026-09-01T10:00:00+08:00",
};

let confirmSpy;

beforeEach(() => {
  formStub.saved = undefined;
  formStub.options = undefined;
  vi.mocked(getVenueCatalogue).mockReset();
  vi.mocked(getVenueCatalogue).mockResolvedValue([ACTIVE, RETIRED]);
  confirmSpy = vi.spyOn(window, "confirm").mockImplementation(() => true);
});

afterEach(() => {
  expect(confirmSpy).not.toHaveBeenCalled();
  confirmSpy.mockRestore();
});

function rowFor(name) {
  return screen.getByText(name).closest("li");
}

async function renderCatalogue() {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <VenueCatalogue />
    </MemoryRouter>,
  );
  await screen.findByText("Hall A");
  return { user };
}

describe("VenueCatalogue Manage blocks", () => {
  it("SCRUM17_AC1_Manage_blocks_is_enabled_on_an_active_venue", async () => {
    await renderCatalogue();
    const button = within(rowFor("Hall A")).getByRole("button", { name: "Manage blocks" });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("title");
  });

  it("SCRUM17_AC1_Manage_blocks_is_disabled_with_a_title_on_a_retired_venue", async () => {
    await renderCatalogue();
    const button = within(rowFor("Old Annex")).getByRole("button", { name: "Manage blocks" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "A retired venue cannot be blocked.");
  });

  it("SCRUM17_AC1_opens_the_blocks_panel_for_that_venue", async () => {
    const { user } = await renderCatalogue();
    await user.click(within(rowFor("Hall A")).getByRole("button", { name: "Manage blocks" }));

    expect(screen.getByTestId("blocks-panel")).toHaveTextContent("Blocks panel for Hall A");
    expect(screen.queryByRole("heading", { name: "Venue catalogue" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "← Back to the venue catalogue" }),
    ).toBeInTheDocument();
  });

  it("SCRUM17_Back_returns_to_the_catalogue_and_refetches_it", async () => {
    const { user } = await renderCatalogue();
    expect(getVenueCatalogue).toHaveBeenCalledTimes(1);

    await user.click(within(rowFor("Hall A")).getByRole("button", { name: "Manage blocks" }));
    // The venue was retired while the panel was open.
    vi.mocked(getVenueCatalogue).mockResolvedValue([{ ...ACTIVE, retiredAt: "2026-10-01T10:00:00+08:00" }, RETIRED]);
    await user.click(screen.getByRole("button", { name: "← Back to the venue catalogue" }));

    expect(screen.queryByTestId("blocks-panel")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Venue catalogue" })).toBeInTheDocument();
    await waitFor(() => expect(getVenueCatalogue).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(within(rowFor("Hall A")).getByRole("button", { name: "Manage blocks" })).toBeDisabled(),
    );
  });
});

describe("VenueCatalogue currentUserId (SCRUM-131)", () => {
  const ME = "d1000000-0000-4000-8000-000000000001";

  it("SCRUM17_AC4_passes_currentUserId_through_to_the_blocks_panel", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <VenueCatalogue currentUserId={ME} />
      </MemoryRouter>,
    );
    await screen.findByText("Hall A");

    await user.click(within(rowFor("Hall A")).getByRole("button", { name: "Manage blocks" }));
    expect(screen.getByTestId("blocks-panel")).toHaveAttribute("data-current-user-id", ME);
  });

  it("SCRUM17_AC4_without_a_currentUserId_the_panel_gets_none", async () => {
    // As on the standalone /venue-catalogue route, which passes no id.
    const { user } = await renderCatalogue();
    await user.click(within(rowFor("Hall A")).getByRole("button", { name: "Manage blocks" }));
    expect(screen.getByTestId("blocks-panel")).toHaveAttribute("data-current-user-id", "");
  });
});

describe("SCRUM178_AC1 VenueCatalogue View calendar (SCRUM-181)", () => {
  function CalendarProbe() {
    const { venueId } = useParams();
    const location = useLocation();
    return (
      <div data-testid="calendar-probe" data-search={location.search}>
        Calendar route for {venueId}
      </div>
    );
  }

  it.each([
    ["an active", "Hall A", ACTIVE],
    ["a retired", "Old Annex", RETIRED],
  ])("SCRUM178_AC1_%s_venue_links_to_its_calendar", async (_label, name, venue) => {
    await renderCatalogue();
    const link = within(rowFor(name)).getByRole("link", { name: "View calendar" });

    expect(link).toHaveAttribute("href", `/venues/${venue.id}/calendar`);
    expect(link).toHaveClass("venue-catalogue__calendar-link");
    // Never disabled: a retired venue's past bookings stay viewable.
    expect(link).not.toHaveAttribute("aria-disabled");
  });

  it("SCRUM178_AC1_every_row_has_exactly_one_calendar_link", async () => {
    await renderCatalogue();
    expect(screen.getAllByRole("link", { name: "View calendar" })).toHaveLength(2);
  });

  it.each([
    ["an active", "Hall A", ACTIVE],
    ["a retired", "Old Annex", RETIRED],
  ])("SCRUM178_AC1_clicking_it_on_%s_venue_lands_on_the_calendar_route", async (_label, name, venue) => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/venue-catalogue"]}>
        <Routes>
          <Route path="/venue-catalogue" element={<VenueCatalogue />} />
          <Route path="/venues/:venueId/calendar" element={<CalendarProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText("Hall A");

    await user.click(within(rowFor(name)).getByRole("link", { name: "View calendar" }));

    const probe = await screen.findByTestId("calendar-probe");
    expect(probe).toHaveTextContent(`Calendar route for ${venue.id}`);
    expect(probe).toHaveAttribute("data-search", "");
    expect(screen.queryByRole("heading", { name: "Venue catalogue" })).not.toBeInTheDocument();
  });
});

describe("SCRUM484_AC8 VenueCatalogue flagged-bookings notice", () => {
  // Hall A has 30 minutes of setup and 15 of turnaround after the edit.
  const ORIENTATION = {
    bookingId: "b0000000-0000-4000-8000-000000000001",
    eventRequestId: "e0000000-0000-4000-8000-000000000001",
    eventName: "Orientation",
    startsAt: "2026-11-02T10:00:00+08:00",
    endsAt: "2026-11-02T12:00:00+08:00",
    occupiedStartsAt: "2026-11-02T09:30:00+08:00",
    occupiedEndsAt: "2026-11-02T12:15:00+08:00",
  };
  const CAREER_FAIR = {
    bookingId: "b0000000-0000-4000-8000-000000000002",
    eventRequestId: "e0000000-0000-4000-8000-000000000002",
    eventName: "Career Fair",
    startsAt: "2026-11-03T14:00:00+08:00",
    endsAt: "2026-11-03T16:00:00+08:00",
    occupiedStartsAt: "2026-11-03T13:30:00+08:00",
    occupiedEndsAt: "2026-11-03T16:15:00+08:00",
  };
  const TECH_TALK = {
    bookingId: "b0000000-0000-4000-8000-000000000003",
    eventRequestId: "e0000000-0000-4000-8000-000000000003",
    eventName: "Tech Talk",
    startsAt: "2026-11-04T10:00:00+08:00",
    endsAt: "2026-11-04T11:00:00+08:00",
    occupiedStartsAt: "2026-11-04T09:00:00+08:00",
    occupiedEndsAt: "2026-11-04T11:00:00+08:00",
  };

  const notice = () => screen.queryByRole("status");

  /** Opens Hall A's edit form and saves it with this response. */
  async function editAndSave(user, saved) {
    formStub.saved = saved;
    await user.click(within(rowFor("Hall A")).getByRole("button", { name: "Edit details" }));
    expect(screen.getByTestId("venue-form")).toHaveAttribute("data-venue-id", ACTIVE.id);
    await user.click(screen.getByRole("button", { name: "Stub save" }));
    await screen.findByText("Hall A");
  }

  it("SCRUM484_AC8_save_with_flagged_bookings_shows_the_notice", async () => {
    const { user } = await renderCatalogue();
    await editAndSave(user, { ...ACTIVE, flaggedBookings: [ORIENTATION, CAREER_FAIR] });

    const region = notice();
    expect(region).toBeInTheDocument();
    expect(within(region).getByRole("heading", { level: 3 })).toHaveTextContent(
      "2 bookings at Hall A flagged for review: Setup or turnaround time changed",
    );

    const rows = within(region).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Orientation")).toBeInTheDocument();
    expect(within(rows[0]).getByText(formatOccupiedPeriod(ORIENTATION))).toBeInTheDocument();
    expect(within(rows[1]).getByText("Career Fair")).toBeInTheDocument();
    expect(within(rows[1]).getByText(formatOccupiedPeriod(CAREER_FAIR))).toBeInTheDocument();

    // The occupied parts, each built from the same instants.
    const orientationPeriod = within(rows[0]).getByText(/^Setup /).textContent;
    expect(orientationPeriod).toBe(
      `Setup ${formatRange(ORIENTATION.occupiedStartsAt, ORIENTATION.startsAt)} · ` +
        `Event ${formatRange(ORIENTATION.startsAt, ORIENTATION.endsAt)} · ` +
        `Turnaround ${formatRange(ORIENTATION.endsAt, ORIENTATION.occupiedEndsAt)}`,
    );

    expect(
      within(region).getByText(
        "Where an event has an assigned coordinator, they have been notified.",
      ),
    ).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("SCRUM575_AC7_bookings_flagged_by_confirmed_new_hours_read_operating_hours_changed", async () => {
    const { user } = await renderCatalogue();
    formStub.options = { confirmedHoursChange: [ORIENTATION.bookingId] };
    await editAndSave(user, { ...ACTIVE, flaggedBookings: [ORIENTATION] });

    expect(within(notice()).getByRole("heading", { level: 3 })).toHaveTextContent(
      "1 booking at Hall A flagged for review: Operating hours changed",
    );
  });

  it("SCRUM484_AC8_one_flagged_booking_uses_the_singular_heading", async () => {
    const { user } = await renderCatalogue();
    await editAndSave(user, { ...ACTIVE, flaggedBookings: [TECH_TALK] });

    expect(within(notice()).getByRole("heading", { level: 3 })).toHaveTextContent(
      "1 booking at Hall A flagged for review: Setup or turnaround time changed",
    );
    // Setup only: no Turnaround part is named.
    expect(within(notice()).getByText(formatOccupiedPeriod(TECH_TALK))).toHaveTextContent(
      `Setup ${formatRange(TECH_TALK.occupiedStartsAt, TECH_TALK.startsAt)} · ` +
        `Event ${formatRange(TECH_TALK.startsAt, TECH_TALK.endsAt)}`,
    );
  });

  it("SCRUM484_AC8_a_flagged_booking_without_a_name_reads_as_unnamed", async () => {
    const { user } = await renderCatalogue();
    await editAndSave(user, { ...ACTIVE, flaggedBookings: [{ ...ORIENTATION, eventName: null }] });

    expect(within(notice()).getByText("Unnamed event")).toBeInTheDocument();
    expect(notice()).not.toHaveTextContent("null");
  });

  it("SCRUM484_AC8_Dismiss_removes_the_notice", async () => {
    const { user } = await renderCatalogue();
    await editAndSave(user, { ...ACTIVE, flaggedBookings: [ORIENTATION] });
    expect(notice()).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(notice()).not.toBeInTheDocument();
    expect(screen.queryByText("Orientation")).not.toBeInTheDocument();
    // The catalogue itself is untouched.
    expect(screen.getByText("Hall A")).toBeInTheDocument();
  });

  it("SCRUM484_AC8_no_notice_before_any_save", async () => {
    await renderCatalogue();
    expect(notice()).not.toBeInTheDocument();
  });

  it.each([
    ["an empty flaggedBookings", { ...ACTIVE, flaggedBookings: [] }],
    ["no flaggedBookings key", { ...ACTIVE }],
    ["no response at all", undefined],
    ["a non-array flaggedBookings", { ...ACTIVE, flaggedBookings: { 0: ORIENTATION } }],
  ])("SCRUM484_AC8_no_notice_after_a_save_with_%s", async (_label, saved) => {
    const { user } = await renderCatalogue();
    await editAndSave(user, saved);
    expect(notice()).not.toBeInTheDocument();
  });

  it("SCRUM484_AC8_a_second_flagging_save_replaces_the_list", async () => {
    const { user } = await renderCatalogue();
    await editAndSave(user, { ...ACTIVE, flaggedBookings: [ORIENTATION, CAREER_FAIR] });
    await editAndSave(user, { ...ACTIVE, flaggedBookings: [TECH_TALK] });

    const region = notice();
    expect(within(region).getByRole("heading", { level: 3 })).toHaveTextContent(
      "1 booking at Hall A flagged for review: Setup or turnaround time changed",
    );
    expect(within(region).getAllByRole("listitem")).toHaveLength(1);
    expect(within(region).getByText("Tech Talk")).toBeInTheDocument();
    expect(within(region).queryByText("Orientation")).not.toBeInTheDocument();
    expect(within(region).queryByText("Career Fair")).not.toBeInTheDocument();
  });

  it("SCRUM484_AC8_the_heading_names_the_venue_from_the_saved_venue", async () => {
    const { user } = await renderCatalogue();
    // The name comes from the save's response, not the catalogue row.
    await editAndSave(user, { ...ACTIVE, name: "Harbour Room", flaggedBookings: [ORIENTATION] });

    expect(within(notice()).getByRole("heading", { level: 3 })).toHaveTextContent(
      "1 booking at Harbour Room flagged for review: Setup or turnaround time changed",
    );
  });

  it("SCRUM484_AC8_a_second_flagging_save_on_another_venue_updates_the_name", async () => {
    const SECOND = {
      id: "3f2504e0-4f89-41d3-9a0c-0305e82c3303",
      name: "Lecture Theatre 1",
      location: "Level 1",
      maxCapacity: 300,
      retiredAt: null,
    };
    vi.mocked(getVenueCatalogue).mockResolvedValue([ACTIVE, SECOND, RETIRED]);
    const { user } = await renderCatalogue();
    await editAndSave(user, { ...ACTIVE, flaggedBookings: [ORIENTATION, CAREER_FAIR] });
    expect(within(notice()).getByRole("heading", { level: 3 })).toHaveTextContent(
      "2 bookings at Hall A flagged for review: Setup or turnaround time changed",
    );

    formStub.saved = { ...SECOND, flaggedBookings: [TECH_TALK] };
    await user.click(within(rowFor("Lecture Theatre 1")).getByRole("button", { name: "Edit details" }));
    expect(screen.getByTestId("venue-form")).toHaveAttribute("data-venue-id", SECOND.id);
    await user.click(screen.getByRole("button", { name: "Stub save" }));
    await screen.findByText("Lecture Theatre 1");

    const heading = within(notice()).getByRole("heading", { level: 3 });
    expect(heading).toHaveTextContent(
      "1 booking at Lecture Theatre 1 flagged for review: Setup or turnaround time changed",
    );
    expect(heading).not.toHaveTextContent("Hall A");
  });

  it.each([
    ["an empty list", { ...ACTIVE, flaggedBookings: [] }],
    ["no flaggedBookings key", { ...ACTIVE }],
  ])("SCRUM484_AC8_a_save_with_%s_leaves_an_existing_notice", async (_label, saved) => {
    const { user } = await renderCatalogue();
    await editAndSave(user, { ...ACTIVE, flaggedBookings: [ORIENTATION] });
    await editAndSave(user, saved);

    const region = notice();
    expect(region).toBeInTheDocument();
    expect(within(region).getByRole("heading", { level: 3 })).toHaveTextContent(
      "1 booking at Hall A flagged for review: Setup or turnaround time changed",
    );
    expect(within(region).getByText("Orientation")).toBeInTheDocument();
  });

  it("SCRUM484_AC8_the_blocks_panel_Back_button_leaves_an_existing_notice", async () => {
    const { user } = await renderCatalogue();
    await editAndSave(user, { ...ACTIVE, flaggedBookings: [ORIENTATION] });

    await user.click(within(rowFor("Hall A")).getByRole("button", { name: "Manage blocks" }));
    await user.click(screen.getByRole("button", { name: "← Back to the venue catalogue" }));
    await screen.findByText("Hall A");

    expect(within(notice()).getByText("Orientation")).toBeInTheDocument();
  });

  it("SCRUM484_AC8_a_flagging_save_still_closes_the_form_and_refetches", async () => {
    const { user } = await renderCatalogue();
    expect(getVenueCatalogue).toHaveBeenCalledTimes(1);

    formStub.saved = { ...ACTIVE, flaggedBookings: [ORIENTATION] };
    await user.click(within(rowFor("Hall A")).getByRole("button", { name: "Edit details" }));
    vi.mocked(getVenueCatalogue).mockResolvedValue([{ ...ACTIVE, name: "Hall A (renamed)" }, RETIRED]);
    await user.click(screen.getByRole("button", { name: "Stub save" }));

    expect(screen.queryByTestId("venue-form")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Venue catalogue" })).toBeInTheDocument();
    await waitFor(() => expect(getVenueCatalogue).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Hall A (renamed)")).toBeInTheDocument();
    // The notice survives the refetch.
    expect(within(notice()).getByText("Orientation")).toBeInTheDocument();
  });
});

describe("SCRUM491 VenueCatalogue Place hold", () => {
  it("SCRUM491_AC1_Place_hold_sits_beside_Manage_blocks_on_an_active_venue", async () => {
    await renderCatalogue();
    const row = rowFor("Hall A");
    const button = within(row).getByRole("button", { name: "Place hold" });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("title");

    const buttons = within(row).getAllByRole("button").map((b) => b.textContent);
    expect(buttons.indexOf("Place hold")).toBe(buttons.indexOf("Manage blocks") + 1);
  });

  it("SCRUM491_AC4_Place_hold_is_disabled_with_a_title_on_a_retired_venue", async () => {
    await renderCatalogue();
    const button = within(rowFor("Old Annex")).getByRole("button", { name: "Place hold" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "A retired venue cannot be held.");
  });

  it("SCRUM491_AC2_opens_the_holds_panel_for_that_venue_with_the_current_user", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <VenueCatalogue currentUserId="staff-1" />
      </MemoryRouter>,
    );
    await screen.findByText("Hall A");
    await user.click(within(rowFor("Hall A")).getByRole("button", { name: "Place hold" }));

    const panel = screen.getByTestId("holds-panel");
    expect(panel).toHaveTextContent("Holds panel for Hall A");
    expect(panel).toHaveAttribute("data-current-user-id", "staff-1");
    expect(screen.queryByRole("heading", { name: "Venue catalogue" })).not.toBeInTheDocument();
  });

  it("SCRUM491_Back_from_the_holds_panel_returns_to_the_catalogue_and_refetches_it", async () => {
    const { user } = await renderCatalogue();
    await user.click(within(rowFor("Hall A")).getByRole("button", { name: "Place hold" }));
    await user.click(screen.getByRole("button", { name: "← Back to the venue catalogue" }));

    expect(screen.queryByTestId("holds-panel")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Venue catalogue" })).toBeInTheDocument();
    await waitFor(() => expect(getVenueCatalogue).toHaveBeenCalledTimes(2));
  });
});

