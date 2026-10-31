// The venue screens on the shared UI standard: one h1 per page, the shared
// Button for every button, and StatusBadge with one tone per meaning. The
// venue service is mocked; the components are real.

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
      await waitFor(() => expect(screen.queryByText("Loading calendar...")).not.toBeInTheDocument());
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
