// The venue screens on the shared UI standard: one h1 per page, the shared
// Button for every button, StatusBadge with one tone per meaning, the shared
// loading, empty, error and date formats, and ConfirmDialog for every
// confirmation. The venue service is mocked; the components are real.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  createVenueBlock,
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
  updateVenue,
} from "../../src/services/venueService";
import { toDatetimeLocalValue, toOffsetIsoString } from "../../src/services/datetimeFormat";
import { ACCESSIBILITY_FEATURES, FACILITIES, ROOM_LAYOUTS } from "../../src/services/venueLookups";
import { SAFETY_FACTS } from "../../src/services/venueSafetyFacts";
import { VENUE_TONES, toneFor } from "../../src/services/venueStatusTones";
import { httpError } from "../helpers/async.js";
import { pressEscape, stubDialogElement } from "../helpers/dialog.js";

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

stubDialogElement();

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

    it.each(["constructor", "toString"])(
      "SCRUM587_AC5_a_status_named_like_an_object_method_falls_back_to_neutral (%s)",
      (key) => {
        expect(toneFor(VENUE_TONES, key)).toBe("neutral");
      },
    );
  });
});

describe("SCRUM587_AC4 venue screens use the shared loading, empty, error and date formats", () => {
  const never = () => new Promise(() => {});
  const serverError = { response: { status: 500 } };

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
      "Use + Add a block to close the venue for a period.",
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
      "Use + Place a hold to keep this venue for an Approved event.",
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
    [
      "retiring a venue",
      async () => {
        vi.mocked(retireVenue).mockRejectedValue(serverError);
        const { user } = await renderCatalogue();
        await user.click(screen.getAllByRole("button", { name: "Retire venue" })[0]);
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Retire venue" }));
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
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove block" }));
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
        /^Expires 14 Jan 2099, 9:00 am \(in \d+ days\) · Placed 15 Jan 2026, 9:00 am by you$/,
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

describe("SCRUM587_AC6 and AC9 venue confirmations use the shared ConfirmDialog", () => {
  const OVERRIDE_TEXT = "Flag these bookings for review and notify each event's coordinator?";
  const HOURS_TEXT =
    "Save the new hours, flag these bookings for review and notify each event's coordinator?";
  const NEW_START = fromNow(20 * DAY);
  const NEW_END = fromNow(21 * DAY);
  const BLOCK_PAYLOAD = {
    startsAt: toOffsetIsoString(toDatetimeLocalValue(NEW_START)),
    endsAt: toOffsetIsoString(toDatetimeLocalValue(NEW_END)),
    reason: "renovation",
  };
  const SHORTER_HOURS = [{ day_of_week: 1, opens_at: "09:00", closes_at: "17:00" }];

  function dialogButton(name) {
    return within(screen.getByRole("dialog")).getByRole("button", { name });
  }

  // Each confirmation, driven up to its open dialog. `before` is how many
  // calls the service has had by then: an override follows a refused save.
  const RETIRE = {
    name: "retire a venue",
    title: "Retire Hall A?",
    confirm: "Retire venue",
    cancel: "Keep venue",
    service: retireVenue,
    before: 0,
    args: [VENUE.id],
    async open() {
      const { user } = await renderCatalogue();
      const opener = screen.getAllByRole("button", { name: "Retire venue" })[0];
      await user.click(opener);
      return { user, opener };
    },
  };
  const REMOVE = {
    name: "remove a block",
    title: "Remove this block?",
    confirm: "Remove block",
    cancel: "Keep block",
    service: removeVenueBlock,
    before: 0,
    args: [VENUE.id, BLOCKS[0].id],
    async open() {
      const user = userEvent.setup();
      render(<VenueBlocksPanel venue={VENUE} currentUserId="d1" />);
      await screen.findByText("Upcoming");
      const opener = screen.getAllByRole("button", { name: "Remove" })[0];
      await user.click(opener);
      return { user, opener };
    },
  };
  const BLOCK_OVERRIDE = {
    name: "override a block's conflicts",
    title: OVERRIDE_TEXT,
    confirm: "Override and flag",
    cancel: "Cancel",
    service: createVenueBlock,
    before: 1,
    args: [VENUE.id, { ...BLOCK_PAYLOAD, confirmOverride: true, acknowledgedBookingIds: ["c1"] }],
    async open() {
      vi.mocked(createVenueBlock).mockRejectedValueOnce(
        httpError(409, { code: "BLOCK_BOOKING_CONFLICT", conflicts: CONFLICTS }),
      );
      const user = userEvent.setup();
      render(<VenueBlocksPanel venue={VENUE} currentUserId="d1" />);
      await screen.findByText("Upcoming");
      await user.click(screen.getByRole("button", { name: "+ Add a block" }));
      fireEvent.change(screen.getByLabelText("Start"), { target: { value: toDatetimeLocalValue(NEW_START) } });
      fireEvent.change(screen.getByLabelText("End"), { target: { value: toDatetimeLocalValue(NEW_END) } });
      await user.selectOptions(screen.getByLabelText("Reason"), "renovation");
      await user.click(screen.getByRole("button", { name: "Block venue" }));
      const opener = await screen.findByRole("button", { name: "Override and flag 1 booking" });
      await user.click(opener);
      return { user, opener };
    },
  };
  const HOURS_OVERRIDE = {
    name: "save new hours over conflicts",
    title: HOURS_TEXT,
    confirm: "Save and flag",
    cancel: "Cancel",
    service: updateVenue,
    before: 1,
    args: [VENUE.id, { hours: SHORTER_HOURS, confirmHoursChange: ["c1"] }],
    async open() {
      vi.mocked(getVenueDetails).mockResolvedValue({
        ...VENUE,
        layouts: [],
        accessibility: [],
        facilities: [],
        hours: [{ day_of_week: 1, opens_at: "09:00:00", closes_at: "18:00:00" }],
      });
      vi.mocked(updateVenue).mockRejectedValueOnce(
        httpError(409, { code: "VENUE_HOURS_BOOKING_CONFLICT", conflicts: CONFLICTS }),
      );
      const user = userEvent.setup();
      render(<VenueForm venueId={VENUE.id} onSaved={() => {}} />);
      await screen.findByRole("heading", { name: "Edit venue" });
      fireEvent.change(screen.getByLabelText("Monday closes at"), { target: { value: "17:00" } });
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      const opener = await screen.findByRole("button", { name: "Confirm new hours" });
      await user.click(opener);
      return { user, opener };
    },
  };
  const ALL = [RETIRE, REMOVE, BLOCK_OVERRIDE, HOURS_OVERRIDE];

  let confirmSpy;

  beforeEach(() => {
    vi.mocked(retireVenue).mockReset().mockResolvedValue({});
    vi.mocked(removeVenueBlock).mockReset().mockResolvedValue(undefined);
    vi.mocked(createVenueBlock).mockReset().mockResolvedValue({ block: BLOCKS[0], flaggedBookings: [] });
    vi.mocked(updateVenue).mockReset().mockResolvedValue({ ...VENUE, flaggedBookings: [] });
    confirmSpy = vi.spyOn(window, "confirm").mockImplementation(() => true);
  });

  afterEach(() => {
    confirmSpy.mockRestore();
  });

  it("SCRUM587_AC6_retire_asks_in_the_shared_dialog_before_anything_is_sent", async () => {
    const { user } = await RETIRE.open();

    const dialog = screen.getByRole("dialog", { name: "Retire Hall A?" });
    expect(dialog).toHaveClass("ui-confirm-dialog");
    expect(dialog).toHaveTextContent("This cannot be undone.");
    expect(retireVenue).not.toHaveBeenCalled();

    vi.mocked(getVenueCatalogue).mockResolvedValue([{ ...VENUE, retiredAt: "2026-11-01T00:00:00Z" }, RETIRED]);
    await user.click(dialogButton("Retire venue"));

    expect(retireVenue).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // The Retire button has gone with the retirement, so the row takes focus.
    const row = screen.getByText("Hall A").closest(".venue-catalogue__item-main");
    expect(row).toHaveTextContent("Retired");
    expect(row).toHaveFocus();
  });

  it("SCRUM587_AC6_remove_block_asks_in_the_shared_dialog_before_anything_is_sent", async () => {
    const { user } = await REMOVE.open();

    const dialog = screen.getByRole("dialog", { name: "Remove this block?" });
    expect(dialog).toHaveClass("ui-confirm-dialog");
    expect(dialog).toHaveTextContent("Bookings it flagged stay flagged for review.");
    expect(removeVenueBlock).not.toHaveBeenCalled();

    vi.mocked(listVenueBlocks).mockResolvedValue(BLOCKS.slice(1));
    await user.click(dialogButton("Remove block"));

    expect(removeVenueBlock).toHaveBeenCalledTimes(1);
    await screen.findByText("Block removed.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The removed block's row has gone, so its list heading takes focus.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Current and upcoming blocks" })).toHaveFocus(),
    );
  });

  it.each([
    [BLOCK_OVERRIDE.name, BLOCK_OVERRIDE],
    [HOURS_OVERRIDE.name, HOURS_OVERRIDE],
  ])("SCRUM587_AC6_override_asks_in_the_shared_dialog_before_flagging (%s)", async (_name, flow) => {
    const { user } = await flow.open();

    const dialog = screen.getByRole("dialog", { name: flow.title });
    expect(dialog).toHaveClass("ui-confirm-dialog");
    expect(dialog).toHaveTextContent("1 booking will be flagged for review, not cancelled.");
    expect(flow.service).toHaveBeenCalledTimes(1);

    await user.click(dialogButton(flow.confirm));
    expect(flow.service).toHaveBeenCalledTimes(2);
  });

  it.each([
    [RETIRE.name, RETIRE, "button"],
    [REMOVE.name, REMOVE, "Escape"],
    [BLOCK_OVERRIDE.name, BLOCK_OVERRIDE, "button"],
  ])("SCRUM587_AC6_cancelling_a_confirmation_sends_nothing_and_returns_focus (%s by %s)", async (_name, flow, how) => {
    const { user, opener } = await flow.open();
    // Focus starts inside the dialog, on its cancel button.
    expect(dialogButton(flow.cancel)).toHaveFocus();

    if (how === "Escape") pressEscape(screen.getByRole("dialog"));
    else await user.click(dialogButton(flow.cancel));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(flow.service).toHaveBeenCalledTimes(flow.before);
    expect(opener).toHaveFocus();
  });

  it("SCRUM587_AC6_a_new_set_of_conflicts_closes_the_override_confirmation", async () => {
    const user = userEvent.setup();
    const second = { ...CONFLICTS[0], bookingId: "c2", eventName: "Career Fair" };
    const onConfirmOverride = vi.fn();
    const list = (conflicts) => (
      <BlockConflictList conflicts={conflicts} onChangePeriod={() => {}} onConfirmOverride={onConfirmOverride} />
    );
    const { rerender } = render(list([CONFLICTS[0], second]));
    await user.click(screen.getByRole("button", { name: "Override and flag 2 bookings" }));

    // The same bookings in another order are still the ones on screen.
    rerender(list([second, CONFLICTS[0]]));
    expect(screen.getByRole("dialog", { name: OVERRIDE_TEXT })).toBeInTheDocument();

    // A booking the user has not seen closes it.
    rerender(list([CONFLICTS[0], second, { ...second, bookingId: "c3", eventName: "Hackathon" }]));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onConfirmOverride).not.toHaveBeenCalled();
  });

  it("SCRUM587_AC6_no_venue_screen_uses_an_inline_confirm_or_the_browser_popup", async () => {
    const noYesButton = () =>
      expect(screen.queryAllByRole("button", { name: /^Yes,/ })).toEqual([]);

    for (const flow of ALL) {
      const { user } = await flow.open();
      noYesButton();
      await user.click(dialogButton(flow.confirm));
      noYesButton();
      cleanup();
    }
    expect(confirmSpy).not.toHaveBeenCalled();

    // The listed components never reach for window.confirm, on any path.
    const components = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/components");
    for (const file of ["VenueCatalogue.jsx", "VenueBlocksPanel.jsx", "VenueForm.jsx", "BlockConflictList.jsx"]) {
      const source = readFileSync(join(components, file), "utf8");
      expect(source, file).not.toMatch(/(?<![\w.])confirm\s*\(|\bwindow\.confirm\b/);
    }
  });

  it.each(ALL.map((flow) => [flow.name, flow]))(
    "SCRUM587_AC9_each_confirmation_sends_the_same_request_as_before (%s)",
    async (_name, flow) => {
      const { user } = await flow.open();
      await user.click(dialogButton(flow.confirm));

      expect(flow.service).toHaveBeenCalledTimes(flow.before + 1);
      expect(flow.service).toHaveBeenLastCalledWith(...flow.args);
    },
  );
});

describe("SCRUM587_AC7 keyboard focus on the venue screens", () => {
  // An active second row, so a bug that returns focus to the wrong row fails.
  const SECOND = {
    ...VENUE,
    id: "3f2504e0-4f89-41d3-9a0c-0305e82c3303",
    name: "Hall B",
    location: "Level 3",
  };

  const PANELS = [
    ["edit form", "Edit details", "Edit venue"],
    ["detail", "View bookings & history", "Hall B — Level 3"],
    ["blocks", "Manage blocks", "Blocks for Hall B — Level 3"],
    ["holds", "Place hold", "Tentative holds for Hall B — Level 3"],
  ];

  function secondRow() {
    return screen.getByText("Hall B").closest("li");
  }

  beforeEach(() => {
    vi.mocked(getVenueCatalogue).mockResolvedValue([VENUE, SECOND]);
    vi.mocked(getVenueDetails).mockResolvedValue({ ...SECOND, hours: [], layouts: [] });
  });

  it.each(PANELS)(
    "SCRUM587_AC7_opening_a_venue_panel_moves_focus_to_its_heading (%s)",
    async (_name, buttonName, heading) => {
      const { user } = await renderCatalogue();
      await user.click(within(secondRow()).getByRole("button", { name: buttonName }));

      const panelHeading = await screen.findByRole("heading", { name: heading });
      await waitFor(() => expect(panelHeading).toHaveFocus());
    },
  );

  it.each(PANELS)(
    "SCRUM587_AC7_back_returns_focus_to_the_button_that_opened_the_panel (%s)",
    async (_name, buttonName, heading) => {
      const { user } = await renderCatalogue();
      await user.click(within(secondRow()).getByRole("button", { name: buttonName }));
      await screen.findByRole("heading", { name: heading });

      await user.click(screen.getByRole("button", { name: /Back to the venue catalogue/ }));

      await waitFor(() =>
        expect(within(secondRow()).getByRole("button", { name: buttonName })).toHaveFocus(),
      );
    },
  );

  it("SCRUM587_AC7_every_control_on_the_venue_form_is_reachable_with_tab", async () => {
    const user = userEvent.setup();
    render(<VenueForm onSaved={() => {}} />);
    // An open day, so its opening and closing times are live controls too.
    await user.click(screen.getByRole("checkbox", { name: "Monday" }));

    const checkbox = (name) => screen.getByRole("checkbox", { name });
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const expected = [
      screen.getByRole("textbox", { name: "Name" }),
      screen.getByRole("textbox", { name: "Location" }),
      screen.getByRole("spinbutton", { name: "Maximum capacity" }),
      ...[...ROOM_LAYOUTS, ...ACCESSIBILITY_FEATURES, ...FACILITIES].map(({ label }) => checkbox(label)),
      ...days.flatMap((day) =>
        day === "Monday"
          ? [checkbox(day), screen.getByLabelText("Monday opens at"), screen.getByLabelText("Monday closes at")]
          : [checkbox(day)],
      ),
      screen.getByRole("combobox", { name: "Setup before events" }),
      screen.getByRole("combobox", { name: "Turnaround between events" }),
      ...SAFETY_FACTS.map(({ label }) => screen.getByRole("textbox", { name: label })),
      screen.getByRole("button", { name: "Create venue" }),
    ];

    document.activeElement.blur(); // start from the top of the page
    const reached = [];
    for (let i = 0; i < expected.length; i += 1) {
      await user.tab();
      reached.push(document.activeElement);
    }
    expect(reached).toEqual(expected);
  });
});

describe("SCRUM587_AC1 venue screen refinements", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("SCRUM587_AC1_catalogue_rows_lead_with_view_bookings_and_set_retire_apart", async () => {
    await renderCatalogue();
    const row = screen.getByText("Hall A").closest("li");
    const button = (name) => within(row).getByRole("button", { name });

    expect(
      within(row)
        .getAllByRole("button")
        .filter((b) => b.classList.contains("ui-button--primary")),
    ).toEqual([button("View bookings & history")]);
    for (const name of ["Edit details", "Manage blocks", "Place hold"]) {
      expect(button(name)).toHaveClass("ui-button--secondary");
    }
    const retire = button("Retire venue");
    expect(retire).toHaveClass("ui-button--danger");
    expect(retire.parentElement.lastElementChild).toBe(retire);
  });

  it("SCRUM587_AC1_a_hold_shows_when_it_expires_and_flags_one_expiring_soon", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date("2026-12-01T00:00:00Z");
    vi.setSystemTime(now);
    const at = (ms) => new Date(now.getTime() + ms).toISOString();
    vi.mocked(listVenueHolds).mockResolvedValue([
      { ...HOLD, placedAt: at(-DAY), expiresAt: at(2 * DAY) },
      { ...HOLD, id: "h2000000-0000-4000-8000-000000000002", eventName: "Board Meeting", placedAt: at(-DAY), expiresAt: at(5 * HOUR) },
    ]);
    render(<VenueHoldsPanel venue={VENUE} currentUserId="d1" />);

    const later = (await screen.findByText("Product Launch")).closest("li");
    expect(later.querySelector(".venue-holds__audit")).toHaveTextContent("Expires 3 Dec 2026, 8:00 am (in 2 days) ·");
    expect(within(later).queryByText("Expires soon")).not.toBeInTheDocument();

    const soon = screen.getByText("Board Meeting").closest("li");
    expect(soon.querySelector(".venue-holds__audit")).toHaveTextContent("Expires 1 Dec 2026, 1:00 pm (in 5 hours) ·");
    expect(within(soon).getByText("Expires soon", { selector: ".ui-status-badge--warning" })).toBeInTheDocument();
  });

  it("SCRUM587_AC1_hold_expiry_wording_updates_while_the_panel_is_open", async () => {
    // Fakes setInterval too, so the panel's minute tick runs on the fake clock.
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const now = new Date("2026-12-01T00:00:00Z");
    vi.setSystemTime(now);
    vi.mocked(listVenueHolds).mockResolvedValue([
      { ...HOLD, placedAt: now.toISOString(), expiresAt: new Date(now.getTime() + DAY + HOUR / 2).toISOString() },
    ]);
    render(<VenueHoldsPanel venue={VENUE} currentUserId="d1" />);

    const row = (await screen.findByText("Product Launch")).closest("li");
    expect(within(row).queryByText("Expires soon")).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTime(HOUR));
    expect(within(row).getByText("Expires soon", { selector: ".ui-status-badge--warning" })).toBeInTheDocument();
    expect(row.querySelector(".venue-holds__audit")).toHaveTextContent("(in 24 hours)");
  });

  it("SCRUM587_AC1_the_calendar_key_names_each_entry_colour", async () => {
    // Noon to 2 pm Singapore time on Wednesday 7 October, inside the week shown.
    const entry = (kind, extra) => ({
      kind,
      startsAt: "2026-10-07T04:00:00Z",
      endsAt: "2026-10-07T06:00:00Z",
      ...extra,
    });
    vi.mocked(getVenueCalendar).mockResolvedValue([
      entry("booking", { id: "k1", status: "approved", eventName: "Gala" }),
      entry("booking", { id: "k2", status: "flagged_for_review", eventName: "Talk" }),
      entry("block", { id: "k3", reason: null }),
      entry("hold", { id: "k4", eventName: "Launch" }),
    ]);
    render(<VenueCalendar venueId={VENUE.id} initialDate={WED_7_OCT} />);
    await screen.findByRole("table");

    const keyItems = within(screen.getByRole("list", { name: "Calendar key" })).getAllByRole("listitem");
    expect(keyItems.map((item) => item.textContent)).toEqual([
      "Booked",
      "Booked – under review",
      "Blocked",
      "Tentatively held",
    ]);
    // Each swatch's colour is an entry's colour, and that entry says the same words.
    for (const item of keyItems) {
      const tone = item.querySelector(".venue-calendar__swatch").className.match(/--(\w+)/)[1];
      const shown = document.querySelector(`.venue-calendar__entry--${tone} .venue-calendar__entry-label`);
      expect(shown).toHaveTextContent(item.textContent);
    }
  });
});
