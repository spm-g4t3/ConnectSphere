// The venue screens on the shared UI standard: one h1 per page, the shared
// Button for every button, StatusBadge with one tone per meaning, and the
// shared loading, empty, error and date formats. The venue service is
// mocked; the components are real.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import VenueCatalogue from "../../src/components/VenueCatalogue.jsx";
import VenueForm from "../../src/components/VenueForm.jsx";
import VenueDetail from "../../src/components/VenueDetail.jsx";
import VenueBlocksPanel from "../../src/components/VenueBlocksPanel.jsx";
import VenueBlockForm from "../../src/components/VenueBlockForm.jsx";
import BlockConflictList from "../../src/components/BlockConflictList.jsx";
import VenueHoldsPanel from "../../src/components/VenueHoldsPanel.jsx";
import VenueHoldForm from "../../src/components/VenueHoldForm.jsx";
import VenueCalendar from "../../src/components/VenueCalendar.jsx";
import BlockHistory from "../../src/components/BlockHistory.jsx";
import {
  getHoldCandidates,
  getVenueBlockHistory,
  getVenueBookings,
  getVenueCalendar,
  getVenueCatalogue,
  getVenueDetails,
  getVenueHistory,
  listVenueBlocks,
  listVenueHolds,
  removeVenueBlock,
  retireVenue,
} from "../../src/services/venueService";

vi.mock("../../src/services/venueService", () => ({
  getVenueCatalogue: vi.fn(),
  retireVenue: vi.fn(),
  createVenue: vi.fn(),
  updateVenue: vi.fn(),
  getVenueDetails: vi.fn(),
  getVenueBookings: vi.fn(),
  getVenueHistory: vi.fn(),
  listVenueBlocks: vi.fn(),
  createVenueBlock: vi.fn(),
  updateVenueBlock: vi.fn(),
  removeVenueBlock: vi.fn(),
  getVenueBlockHistory: vi.fn(),
  listVenueHolds: vi.fn(),
  placeVenueHold: vi.fn(),
  getHoldCandidates: vi.fn(),
  getVenueCalendar: vi.fn(),
}));

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function fromNow(ms) {
  return new Date(Math.floor((Date.now() + ms) / 60_000) * 60_000).toISOString();
}

const VENUE = {
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
  retiredAt: "2026-01-01T00:00:00Z",
};

const BLOCKS = [
  { id: "b1000000-0000-4000-8000-000000000001", venueId: VENUE.id, startsAt: fromNow(5 * DAY), endsAt: fromNow(6 * DAY), reason: "maintenance", notes: null },
  { id: "b2000000-0000-4000-8000-000000000002", venueId: VENUE.id, startsAt: fromNow(-2 * DAY), endsAt: fromNow(2 * DAY), reason: "safety", notes: null },
  { id: "b3000000-0000-4000-8000-000000000003", venueId: VENUE.id, startsAt: fromNow(-10 * DAY), endsAt: fromNow(-9 * DAY), reason: "other", notes: null },
];

const EVENT = {
  id: "e1000000-0000-4000-8000-000000000001",
  eventName: "Product Launch",
  proposedStart: fromNow(10 * DAY),
  proposedEnd: fromNow(10 * DAY + 3 * HOUR),
  expectedAttendance: 120,
};

const HOLD = {
  id: "h1000000-0000-4000-8000-000000000001",
  eventRequestId: EVENT.id,
  venueId: VENUE.id,
  placedBy: "d1",
  placedAt: fromNow(-DAY),
  expiresAt: fromNow(DAY),
  status: "active",
  eventName: EVENT.eventName,
  eventStartsAt: EVENT.proposedStart,
  eventEndsAt: EVENT.proposedEnd,
  placedByName: "Sam Staff",
};

function booking(n, status, label, group) {
  return {
    id: `a${n}000000-0000-4000-8000-00000000000${n}`,
    eventRequestId: `e${n}000000-0000-4000-8000-00000000000${n}`,
    startsAt: fromNow(n * DAY),
    endsAt: fromNow(n * DAY + 2 * HOUR),
    statusDisplay: { status, label, group },
  };
}
const BOOKINGS = [
  booking(1, "approved", "Approved", "APPROVED"),
  booking(2, "pending", "Pending", "PENDING"),
  booking(3, "flagged_for_review", "Flagged for review", "FLAGGED"),
  booking(4, "cancelled", "Cancelled", "CANCELLED"),
];

const CONFLICTS = [
  { bookingId: "c1", eventRequestId: EVENT.id, eventName: "Tech Talk", startsAt: fromNow(5 * DAY), endsAt: fromNow(5 * DAY + HOUR) },
];

const WED_7_OCT = new Date(2026, 9, 7, 10);

beforeEach(() => {
  vi.mocked(getVenueCatalogue).mockReset().mockResolvedValue([VENUE, RETIRED]);
  vi.mocked(getVenueDetails).mockReset().mockResolvedValue({
    ...RETIRED,
    emergencyAccess: null,
    knownRestrictions: null,
  });
  vi.mocked(getVenueBookings).mockReset().mockResolvedValue(BOOKINGS);
  vi.mocked(getVenueHistory).mockReset().mockResolvedValue([]);
  vi.mocked(listVenueBlocks).mockReset().mockResolvedValue(BLOCKS);
  vi.mocked(getVenueBlockHistory).mockReset().mockResolvedValue([]);
  vi.mocked(listVenueHolds).mockReset().mockResolvedValue([HOLD]);
  vi.mocked(getHoldCandidates).mockReset().mockResolvedValue([EVENT]);
  vi.mocked(getVenueCalendar).mockReset().mockResolvedValue([]);
});

async function renderCatalogue(props = {}) {
  const user = userEvent.setup();
  const utils = render(
    <MemoryRouter>
      <VenueCatalogue {...props} />
    </MemoryRouter>,
  );
  await screen.findByText("Hall A");
  return { user, ...utils };
}

function headingLevels(container) {
  return [...container.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => ({
    level: Number(h.tagName[1]),
    text: h.textContent,
  }));
}

/** Each screen rendered to the state that shows all its buttons and statuses. */
const SCREENS = [
  [
    "venue catalogue list",
    async () => {
      const utils = await renderCatalogue();
      await utils.user.click(screen.getAllByRole("button", { name: "Retire venue" })[0]);
      return utils.container;
    },
  ],
  [
    "venue form",
    async () => {
      const { container } = render(<VenueForm onSaved={() => {}} />);
      return container;
    },
  ],
  [
    // Its only button is the safety retry, so the safety load fails here.
    "venue detail with bookings and a failed safety load",
    async () => {
      vi.mocked(getVenueDetails).mockRejectedValue(new Error("boom"));
      const { container } = render(<VenueDetail venue={VENUE} />);
      await screen.findByRole("button", { name: "Try again" });
      await screen.findByText("Approved");
      return container;
    },
  ],
  [
    "blocks panel with the block form and a history open",
    async () => {
      const user = userEvent.setup();
      const { container } = render(<VenueBlocksPanel venue={VENUE} currentUserId="d1" />);
      await screen.findByText("Upcoming");
      await user.click(screen.getAllByRole("button", { name: "Remove" })[0]);
      await user.click(screen.getAllByRole("button", { name: "History" })[0]);
      await user.click(screen.getByRole("button", { name: "+ Add a block" }));
      return container;
    },
  ],
  [
    "holds panel with the hold form open",
    async () => {
      const user = userEvent.setup();
      const { container } = render(<VenueHoldsPanel venue={VENUE} currentUserId="d1" />);
      await screen.findByText("Tentatively held");
      await user.click(screen.getByRole("button", { name: "+ Place a hold" }));
      return container;
    },
  ],
  [
    "block form",
    async () => {
      const { container } = render(<VenueBlockForm onSubmit={() => {}} onCancel={() => {}} />);
      return container;
    },
  ],
  [
    "block conflict list mid-override",
    async () => {
      const user = userEvent.setup();
      const { container } = render(
        <BlockConflictList conflicts={CONFLICTS} onChangePeriod={() => {}} onConfirmOverride={() => {}} />,
      );
      await user.click(screen.getByRole("button", { name: /Override and flag/ }));
      return container;
    },
  ],
  [
    "hold form",
    async () => {
      const { container } = render(
        <VenueHoldForm candidates={[EVENT]} onSubmit={() => {}} onCancel={() => {}} />,
      );
      return container;
    },
  ],
  [
    "venue calendar in month view",
    async () => {
      vi.mocked(getVenueDetails).mockResolvedValue(RETIRED);
      const user = userEvent.setup();
      const { container } = render(<VenueCalendar venueId={RETIRED.id} initialDate={WED_7_OCT} />);
      await screen.findByText("Retired");
      await user.click(screen.getByRole("button", { name: "Month" }));
      await waitFor(() => expect(screen.queryByText("Loading...")).not.toBeInTheDocument());
      return container;
    },
  ],
];

describe("SCRUM587 venue screens on the UI standard", () => {
  it("SCRUM587_AC2_venue_catalogue_page_has_one_h1_and_its_panels_below_it", async () => {
    const { user, container } = await renderCatalogue({ asPage: true });
    const onlyH1IsTheCatalogue = () => {
      const levels = headingLevels(container);
      expect(levels.filter((h) => h.level === 1)).toEqual([{ level: 1, text: "Venue catalogue" }]);
      expect(levels.filter((h) => h.level !== 1).every((h) => h.level >= 2)).toBe(true);
    };
    onlyH1IsTheCatalogue();

    await user.click(screen.getByRole("button", { name: "+ Add new venue" }));
    expect(screen.getByRole("heading", { name: "Add a new venue" }).tagName).toBe("H2");
    onlyH1IsTheCatalogue();

    await user.click(screen.getByRole("button", { name: /Back to the venue catalogue/ }));
    await user.click((await screen.findAllByRole("button", { name: "View bookings & history" }))[0]);
    await screen.findByText("Approved");
    onlyH1IsTheCatalogue();
  });

  it("SCRUM587_AC2_venue_catalogue_on_the_dashboard_is_a_section_at_h2", async () => {
    const { user, container } = await renderCatalogue();
    expect(screen.getByRole("heading", { name: "Venue catalogue" }).tagName).toBe("H2");
    expect(container.querySelector("h1")).toBeNull();

    // The dashboard's greeting is its h1, so an open panel adds none.
    await user.click(screen.getByRole("button", { name: "+ Add new venue" }));
    expect(container.querySelector("h1")).toBeNull();
  });

  it("SCRUM587_AC2_venue_calendar_has_one_h1_and_its_sections_at_h2", async () => {
    vi.mocked(getVenueDetails).mockResolvedValue(VENUE);
    const { container } = render(<VenueCalendar venueId={VENUE.id} initialDate={WED_7_OCT} />);
    await screen.findByRole("heading", { level: 1, name: "Hall A" });
    const levels = headingLevels(container);
    expect(levels.filter((h) => h.level === 1)).toHaveLength(1);
    expect(levels.filter((h) => h.level !== 1).every((h) => h.level === 2)).toBe(true);
  });

  it.each(SCREENS)("SCRUM587_AC3_venue_screens_use_the_shared_button (%s)", async (_name, renderScreen) => {
    const container = await renderScreen();
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.filter((b) => !b.classList.contains("ui-button")).map((b) => b.textContent)).toEqual([]);
  });

  it.each(SCREENS)("SCRUM587_AC3_no_venue_screen_keeps_its_own_badge_class (%s)", async (_name, renderScreen) => {
    const container = await renderScreen();
    expect(
      container.querySelectorAll(
        '.status-badge, [class*="status--"], .venue-calendar__badge, .venue-detail__booking-status',
      ),
    ).toHaveLength(0);
  });

  describe("SCRUM587_AC5_venue_and_block_and_hold_statuses_use_one_tone_per_meaning", () => {
    async function catalogue() {
      await renderCatalogue();
      return screen.getByRole("list");
    }
    async function blocks() {
      render(<VenueBlocksPanel venue={VENUE} currentUserId="d1" />);
      await screen.findByText("Upcoming");
      return document.body;
    }
    async function holds() {
      render(<VenueHoldsPanel venue={VENUE} currentUserId="d1" />);
      await screen.findByText("Tentatively held");
      return document.body;
    }
    async function venueBookings() {
      render(<VenueDetail venue={VENUE} />);
      await screen.findByText("Approved");
      return screen.getByRole("heading", { name: "Bookings" }).closest("section");
    }

    it.each([
      ["Active", "success", catalogue],
      ["Retired", "neutral", catalogue],
      ["Upcoming", "danger", blocks],
      ["In effect", "danger", blocks],
      ["Ended", "neutral", blocks],
      ["Tentatively held", "info", holds],
      ["Approved", "success", venueBookings],
      ["Pending", "warning", venueBookings],
      ["Flagged for review", "danger", venueBookings],
      ["Cancelled", "neutral", venueBookings],
    ])("SCRUM587_AC5_venue_and_block_and_hold_statuses_use_one_tone_per_meaning (%s is %s)", async (label, tone, renderScreen) => {
      const scope = await renderScreen();
      expect(within(scope).getByText(label, { selector: `.ui-status-badge--${tone}` })).toBeInTheDocument();
    });
  });
});

describe("SCRUM587_AC4 venue screens use the shared loading, empty, error and date formats", () => {
  const never = () => new Promise(() => {});
  const serverError = { response: { status: 500 } };
  const sessionExpired = { response: { status: 401 } };

  function renderCatalogueNow() {
    return render(
      <MemoryRouter>
        <VenueCatalogue />
      </MemoryRouter>,
    );
  }

  function renderBlockHistory() {
    return render(<BlockHistory venueId={VENUE.id} blockId={BLOCKS[0].id} refreshKey="r1" currentUserId="d1" />);
  }

  async function openHoldForm() {
    const user = userEvent.setup();
    render(<VenueHoldsPanel venue={VENUE} currentUserId="d1" />);
    await user.click(await screen.findByRole("button", { name: "+ Place a hold" }));
  }

  it.each([
    ["catalogue", () => vi.mocked(getVenueCatalogue).mockImplementation(never), renderCatalogueNow],
    ["venue form", () => vi.mocked(getVenueDetails).mockImplementation(never), () => render(<VenueForm venueId={VENUE.id} onSaved={() => {}} />)],
    [
      "venue detail",
      () => {
        vi.mocked(getVenueDetails).mockImplementation(never);
        vi.mocked(getVenueBookings).mockImplementation(never);
        vi.mocked(getVenueHistory).mockImplementation(never);
      },
      () => render(<VenueDetail venue={VENUE} />),
    ],
    ["blocks", () => vi.mocked(listVenueBlocks).mockImplementation(never), () => render(<VenueBlocksPanel venue={VENUE} currentUserId="d1" />)],
    ["block history", () => vi.mocked(getVenueBlockHistory).mockImplementation(never), renderBlockHistory],
    ["holds", () => vi.mocked(listVenueHolds).mockImplementation(never), () => render(<VenueHoldsPanel venue={VENUE} currentUserId="d1" />)],
    ["calendar", () => vi.mocked(getVenueCalendar).mockImplementation(never), () => render(<VenueCalendar venueId={VENUE.id} initialDate={WED_7_OCT} />)],
  ])("SCRUM587_AC4_venue_screens_show_the_standard_loading_text (%s)", (_name, pend, renderScreen) => {
    pend();
    renderScreen();
    const loading = screen.getAllByText("Loading...");
    expect(loading.length).toBeGreaterThan(0);
    loading.forEach((el) => expect(el).toHaveAttribute("role", "status"));
  });

  it.each([
    [
      "catalogue",
      () => vi.mocked(getVenueCatalogue).mockResolvedValue([]),
      renderCatalogueNow,
      "No venues in the catalogue yet.",
      "Add a venue with + Add new venue.",
    ],
    [
      "venue bookings",
      () => vi.mocked(getVenueBookings).mockResolvedValue([]),
      () => render(<VenueDetail venue={VENUE} />),
      "No bookings have been made against this venue.",
      "A booking appears here when an Event Coordinator requests this venue.",
    ],
    [
      "venue change history",
      () => vi.mocked(getVenueHistory).mockResolvedValue([]),
      () => render(<VenueDetail venue={VENUE} />),
      "No changes have been recorded for this venue.",
      "A change appears here when this venue's details are edited.",
    ],
    [
      "blocks",
      () => vi.mocked(listVenueBlocks).mockResolvedValue([]),
      () => render(<VenueBlocksPanel venue={VENUE} currentUserId="d1" />),
      "This venue has no blocks.",
      "Add a block with + Add a block when the venue cannot be booked.",
    ],
    [
      "blocks on a retired venue",
      () => vi.mocked(listVenueBlocks).mockResolvedValue([]),
      () => render(<VenueBlocksPanel venue={RETIRED} currentUserId="d1" />),
      "This venue has no blocks.",
      "A retired venue cannot be blocked.",
    ],
    [
      "block history",
      () => vi.mocked(getVenueBlockHistory).mockResolvedValue([]),
      renderBlockHistory,
      "No changes have been recorded for this block.",
      "A change appears here when this block is edited.",
    ],
    [
      "holds",
      () => vi.mocked(listVenueHolds).mockResolvedValue([]),
      () => render(<VenueHoldsPanel venue={VENUE} currentUserId="d1" />),
      "This venue has no active holds.",
      "Place a hold with + Place a hold to keep this venue for an Approved event.",
    ],
    [
      "holds on a retired venue",
      () => vi.mocked(listVenueHolds).mockResolvedValue([]),
      () => render(<VenueHoldsPanel venue={RETIRED} currentUserId="d1" />),
      "This venue has no active holds.",
      "A retired venue cannot be held.",
    ],
    [
      "calendar",
      () => vi.mocked(getVenueCalendar).mockResolvedValue([]),
      () => render(<VenueCalendar venueId={VENUE.id} initialDate={WED_7_OCT} />),
      "Nothing booked or blocked in this period.",
      "Use Previous or Next to look at another period.",
    ],
  ])(
    "SCRUM587_AC4_empty_venue_lists_say_what_is_missing_and_what_to_do (%s)",
    async (_name, empty, renderScreen, message, nextStep) => {
      empty();
      renderScreen();
      const emptyState = (await screen.findByText(message)).closest(".ui-empty-state");
      expect(emptyState).not.toBeNull();
      expect(within(emptyState).getByText(nextStep)).toBeInTheDocument();
    },
  );

  // Each load fails once, then answers; `shown` is what only the answer renders.
  it.each([
    ["catalogue", getVenueCatalogue, [VENUE], renderCatalogueNow, () => screen.findByText("Hall A")],
    [
      "venue form",
      getVenueDetails,
      VENUE,
      () => render(<VenueForm venueId={VENUE.id} onSaved={() => {}} />),
      () => screen.findByDisplayValue("Hall A"),
    ],
    [
      "venue safety information",
      getVenueDetails,
      { ...VENUE, emergencyAccess: "Exit by the east stairs", knownRestrictions: null },
      () => render(<VenueDetail venue={VENUE} />),
      () => screen.findByText("Exit by the east stairs"),
    ],
    ["venue bookings", getVenueBookings, BOOKINGS, () => render(<VenueDetail venue={VENUE} />), () => screen.findByText("Approved")],
    [
      "venue change history",
      getVenueHistory,
      [{ id: "h1", changedAt: "2026-01-15T01:00:00Z", changedBy: null, oldValues: {}, newValues: { name: "Hall A" } }],
      () => render(<VenueDetail venue={VENUE} />),
      () => screen.findByText("Venue created"),
    ],
    [
      "blocks",
      listVenueBlocks,
      BLOCKS,
      () => render(<VenueBlocksPanel venue={VENUE} currentUserId="d1" />),
      () => screen.findByText("Upcoming"),
    ],
    [
      "block history",
      getVenueBlockHistory,
      [{ id: "bh1", action: "created", changedAt: "2026-01-15T01:00:00Z", changedBy: "d1", oldValues: null, newValues: { reason: "maintenance" } }],
      renderBlockHistory,
      () => screen.findByText("Created"),
    ],
    [
      "holds",
      listVenueHolds,
      [HOLD],
      () => render(<VenueHoldsPanel venue={VENUE} currentUserId="d1" />),
      () => screen.findByText("Tentatively held"),
    ],
    ["hold event picker", getHoldCandidates, [EVENT], openHoldForm, () => screen.findByRole("option", { name: /Product Launch/ })],
    [
      "calendar",
      getVenueCalendar,
      [],
      () => render(<VenueCalendar venueId={VENUE.id} initialDate={WED_7_OCT} />),
      () => screen.findByText("Nothing booked or blocked in this period."),
    ],
  ])(
    "SCRUM587_AC4_a_venue_load_that_fails_offers_try_again_and_reloads (%s)",
    async (_name, load, answer, renderScreen, shown) => {
      const user = userEvent.setup();
      vi.mocked(load).mockReset().mockRejectedValueOnce(serverError).mockResolvedValue(answer);
      await renderScreen();

      const alert = await screen.findByRole("alert");
      await user.click(within(alert).getByRole("button", { name: "Try again" }));

      expect(await shown()).toBeInTheDocument();
      expect(load).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it.each([
    ["venue detail", getVenueBookings, () => render(<VenueDetail venue={VENUE} />)],
    ["blocks", listVenueBlocks, () => render(<VenueBlocksPanel venue={VENUE} currentUserId="d1" />)],
    ["block history", getVenueBlockHistory, renderBlockHistory],
    ["holds", listVenueHolds, () => render(<VenueHoldsPanel venue={VENUE} currentUserId="d1" />)],
    ["hold event picker", getHoldCandidates, openHoldForm],
    ["calendar", getVenueCalendar, () => render(<VenueCalendar venueId={VENUE.id} initialDate={WED_7_OCT} />)],
  ])("SCRUM587_AC4_an_expired_session_offers_no_try_again (%s)", async (_name, load, renderScreen) => {
    vi.mocked(load).mockReset().mockRejectedValue(sessionExpired);
    await renderScreen();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your session has expired. Please sign in again.");
    expect(within(alert).queryByRole("button")).not.toBeInTheDocument();
  });

  it.each([
    [
      "retiring a venue",
      async () => {
        vi.mocked(retireVenue).mockRejectedValue(serverError);
        const { user } = await renderCatalogue();
        await user.click(screen.getAllByRole("button", { name: "Retire venue" })[0]);
        await user.click(screen.getByRole("button", { name: "Yes, retire" }));
      },
      "Could not retire this venue. Please try again.",
    ],
    [
      "saving a venue with no changes",
      async () => {
        vi.mocked(getVenueDetails).mockResolvedValue(VENUE);
        const user = userEvent.setup();
        render(<VenueForm venueId={VENUE.id} onSaved={() => {}} />);
        await screen.findByDisplayValue("Hall A");
        await user.click(screen.getByRole("button", { name: "Save changes" }));
      },
      "Nothing has changed, so there is nothing to save.",
    ],
    [
      "removing a block",
      async () => {
        vi.mocked(removeVenueBlock).mockRejectedValue(serverError);
        const user = userEvent.setup();
        render(<VenueBlocksPanel venue={VENUE} currentUserId="d1" />);
        await screen.findByText("Upcoming");
        await user.click(screen.getAllByRole("button", { name: "Remove" })[0]);
        await user.click(screen.getByRole("button", { name: "Yes, remove" }));
      },
      "Could not remove this block. Please try again.",
    ],
    [
      "the block form",
      () => render(<VenueBlockForm onSubmit={() => {}} formError="The block could not be saved." />),
      "The block could not be saved.",
    ],
    [
      "the hold form",
      () => render(<VenueHoldForm candidates={[EVENT]} onSubmit={() => {}} formError="The hold could not be placed." />),
      "The hold could not be placed.",
    ],
  ])("SCRUM587_AC4_a_failed_venue_action_shows_the_error_without_try_again (%s)", async (_name, fail, message) => {
    await fail();

    const alert = (await screen.findByText(message)).closest('[role="alert"]');
    expect(alert).toHaveClass("ui-error-notice");
    expect(within(alert).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  describe("SCRUM587_AC4_venue_dates_use_the_standard_format", () => {
    const MORNING = "2026-01-15T01:00:00Z"; // 9:00 am in Singapore
    const LATE_MORNING = "2026-01-15T03:00:00Z";
    const LATE_EVENING = "2026-01-15T14:00:00Z"; // 10:00 pm, the night before 16 Jan
    const PAST_MIDNIGHT = "2026-01-15T17:00:00Z";

    it("SCRUM587_AC4_venue_dates_use_the_standard_format (venue bookings and history)", async () => {
      vi.mocked(getVenueBookings).mockResolvedValue([{ ...BOOKINGS[0], startsAt: MORNING, endsAt: LATE_MORNING }]);
      vi.mocked(getVenueHistory).mockResolvedValue([
        { id: "h1", changedAt: PAST_MIDNIGHT, changedBy: null, oldValues: {}, newValues: { name: "Hall A" } },
      ]);
      render(<VenueDetail venue={VENUE} />);

      expect(await screen.findByText("15 Jan 2026, 9:00 am – 11:00 am")).toBeInTheDocument();
      expect(await screen.findByText("16 Jan 2026, 1:00 am")).toBeInTheDocument();
    });

    it("SCRUM587_AC4_venue_dates_use_the_standard_format (block rows, audit and history)", async () => {
      const user = userEvent.setup();
      vi.mocked(listVenueBlocks).mockResolvedValue([
        { ...BLOCKS[2], startsAt: LATE_EVENING, endsAt: PAST_MIDNIGHT, createdAt: MORNING, createdBy: "d1" },
      ]);
      vi.mocked(getVenueBlockHistory).mockResolvedValue([
        { id: "bh1", action: "created", changedAt: LATE_MORNING, changedBy: "d1", oldValues: null, newValues: { reason: "other" } },
      ]);
      render(<VenueBlocksPanel venue={VENUE} currentUserId="d1" />);

      expect(await screen.findByText("15 Jan 2026, 10:00 pm – 16 Jan 2026, 1:00 am")).toBeInTheDocument();
      expect(document.querySelector(".venue-blocks__audit").textContent).toBe("Created 15 Jan 2026, 9:00 am by you");
      await user.click(screen.getByRole("button", { name: "History" }));
      expect(await screen.findByText("15 Jan 2026, 11:00 am")).toBeInTheDocument();
    });

    it("SCRUM587_AC4_venue_dates_use_the_standard_format (holds and the hold picker)", async () => {
      const user = userEvent.setup();
      const later = { eventStartsAt: "2099-01-15T01:00:00Z", eventEndsAt: "2099-01-15T03:00:00Z" };
      vi.mocked(listVenueHolds).mockResolvedValue([
        { ...HOLD, ...later, placedAt: MORNING, expiresAt: "2099-01-14T01:00:00Z" },
      ]);
      vi.mocked(getHoldCandidates).mockResolvedValue([
        { ...EVENT, proposedStart: later.eventStartsAt, proposedEnd: later.eventEndsAt },
      ]);
      render(<VenueHoldsPanel venue={VENUE} currentUserId="d1" />);

      expect(await screen.findByText("15 Jan 2099, 9:00 am – 11:00 am")).toBeInTheDocument();
      expect(document.querySelector(".venue-holds__audit")).toHaveTextContent(
        "Expires 14 Jan 2099, 9:00 am · Placed 15 Jan 2026, 9:00 am by you",
      );
      await user.click(screen.getByRole("button", { name: "+ Place a hold" }));
      expect(
        await screen.findByRole("option", { name: /^Product Launch · 15 Jan 2099, 9:00 am – 11:00 am · / }),
      ).toBeInTheDocument();
    });

    it("SCRUM587_AC4_venue_dates_use_the_standard_format (block conflicts)", () => {
      render(
        <BlockConflictList
          conflicts={[{ ...CONFLICTS[0], startsAt: LATE_EVENING, endsAt: PAST_MIDNIGHT }]}
          onChangePeriod={() => {}}
          onConfirmOverride={() => {}}
        />,
      );
      expect(screen.getByText("15 Jan 2026, 10:00 pm – 16 Jan 2026, 1:00 am")).toBeInTheDocument();
    });

    it("SCRUM587_AC4_venue_dates_use_the_standard_format (calendar day labels and entries)", async () => {
      const user = userEvent.setup();
      // Noon in Singapore: inside the week of 5 Oct on every device's clock.
      vi.mocked(getVenueCalendar).mockResolvedValue([
        { kind: "block", id: "k1", startsAt: "2026-10-07T04:00:00Z", endsAt: "2026-10-07T06:00:00Z", reason: "maintenance" },
      ]);
      render(<VenueCalendar venueId={VENUE.id} initialDate={WED_7_OCT} />);

      const headers = within(await screen.findByRole("table")).getAllByRole("columnheader");
      expect(headers.map((th) => th.textContent)).toEqual([
        "Mon 5 Oct", "Tue 6 Oct", "Wed 7 Oct", "Thu 8 Oct", "Fri 9 Oct", "Sat 10 Oct", "Sun 11 Oct",
      ]);
      expect(screen.getByText("7 Oct 2026, 12:00 pm – 2:00 pm")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Month" }));
      expect(await screen.findByRole("button", { name: "Show Wednesday, 7 October 2026" })).toBeInTheDocument();
      expect(within(screen.getByRole("table")).getAllByRole("columnheader")[0]).toHaveTextContent("Mon");
    });
  });

  it.each([
    [
      "a hold",
      () => {
        vi.mocked(listVenueHolds).mockResolvedValue([{ ...HOLD, eventStartsAt: null, eventEndsAt: null }]);
        render(<VenueHoldsPanel venue={VENUE} currentUserId="d1" />);
        return screen.findByText("Tentatively held");
      },
      () => document.querySelector(".venue-holds__item-main > span"),
    ],
    [
      "a hold picker event",
      async () => {
        render(<VenueHoldForm candidates={[{ ...EVENT, proposedStart: null, proposedEnd: null }]} onSubmit={() => {}} />);
      },
      () => screen.getByRole("option", { name: /Product Launch/ }),
    ],
  ])("SCRUM587_AC4_a_venue_record_without_dates_says_not_recorded_once (%s)", async (_name, renderScreen, dates) => {
    await renderScreen();
    expect(dates().textContent).toMatch(/(^| · )no date( · |$)/);
    expect(dates().textContent).not.toContain("no date – no date");
  });
});
