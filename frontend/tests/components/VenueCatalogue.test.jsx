// VenueCatalogue.test.jsx
//
// SCRUM-127 (part of SCRUM-17). The catalogue's "Manage blocks" button, which
// opens VenueBlocksPanel for one venue. The venue service is mocked, and the
// panel is a stub that shows which venue it was opened for, so these tests
// cover only the catalogue's wiring.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom";

import VenueCatalogue from "../../src/components/VenueCatalogue.jsx";
import { getVenueCatalogue } from "../../src/services/venueService";

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
