// venueHoldFlow.test.jsx
//
// SCRUM-491. One end-to-end flow through the real components: VenueCatalogue
// -> "Place hold" -> VenueHoldsPanel, with the real VenueHoldForm underneath.
//
// Only venueService is mocked, and the three hold calls are backed by a small
// stateful in-memory fake (createFakeHoldBackend) built fresh for every test.
// It keeps the rules the backend keeps: one active hold per event at a venue
// (AC3), and a hold refused when another event's active hold overlaps its
// period (AC4). Every venueService export the tree imports but this flow
// should never reach rejects with "unexpected call".
//
// Timezone-safe: instants are compared with getTime(), expected strings come
// from formatTimestamp / formatOccupiedPeriod, and datetime-local inputs are
// set with fireEvent.change through toDatetimeLocalValue. No fake timers.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import VenueCatalogue from "../../src/components/VenueCatalogue.jsx";
import * as venueService from "../../src/services/venueService";
import { formatTimestamp } from "../../src/services/displayFormat";
import { formatOccupiedPeriod } from "../../src/services/occupiedPeriodDisplay";
import { toDatetimeLocalValue } from "../../src/services/datetimeFormat";

vi.mock("../../src/services/venueService", () => ({
  searchActiveVenues: vi.fn(),
  getVenueDetails: vi.fn(),
  getVenueCatalogue: vi.fn(),
  retireVenue: vi.fn(),
  createVenue: vi.fn(),
  updateVenue: vi.fn(),
  getVenueBookings: vi.fn(),
  getVenueHistory: vi.fn(),
  listVenueBlocks: vi.fn(),
  createVenueBlock: vi.fn(),
  updateVenueBlock: vi.fn(),
  removeVenueBlock: vi.fn(),
  getVenueBlockHistory: vi.fn(),
  getPendingBookingRequests: vi.fn(),
  listVenueHolds: vi.fn(),
  placeVenueHold: vi.fn(),
  getHoldCandidates: vi.fn(),
}));

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const STAFF_ID = "d1000000-0000-4000-8000-000000000001";

const VENUE = {
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  name: "Hall A",
  location: "Level 2",
  maxCapacity: 200,
  retiredAt: null,
};

/** Minute-aligned now, so every derived instant survives datetime-local. */
function minuteNow() {
  return Math.floor(Date.now() / MINUTE) * MINUTE;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

// Two Approved events ten days out whose periods overlap.
const LAUNCH = {
  id: "e1000000-0000-4000-8000-000000000001",
  eventName: "Product Launch",
  proposedStart: iso(minuteNow() + 10 * DAY),
  proposedEnd: iso(minuteNow() + 10 * DAY + 3 * HOUR),
  expectedAttendance: 120,
  assignedCoordinatorId: "c1",
  assignedCoordinatorName: "Casey Coordinator",
};
const FAIR = {
  id: "e2000000-0000-4000-8000-000000000002",
  eventName: "Career Fair",
  proposedStart: iso(minuteNow() + 10 * DAY + 2 * HOUR),
  proposedEnd: iso(minuteNow() + 10 * DAY + 5 * HOUR),
  expectedAttendance: 80,
  assignedCoordinatorId: "c2",
  assignedCoordinatorName: "Robin Coordinator",
};
const EVENTS = [LAUNCH, FAIR];

function httpError(status, data) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { error: "database prose with a uuid", ...data } },
  });
}

/**
 * A stateful in-memory stand-in for the hold endpoints.
 *
 * Holds are unpadded here (no setup or turnaround), so the occupied period is
 * the event's own; the padding is the backend's, tested there.
 */
function createFakeHoldBackend({ actorId }) {
  const holds = [];
  let nextHold = 1;

  const eventOf = (id) => EVENTS.find((e) => e.id === id);
  const active = () => holds.filter((h) => new Date(h.expiresAt).getTime() > Date.now());

  return {
    holds,

    async getVenueCatalogue() {
      return [structuredClone(VENUE)];
    },

    async getHoldCandidates() {
      return structuredClone(EVENTS);
    },

    async listVenueHolds(venueId) {
      return structuredClone(
        active()
          .filter((h) => h.venueId === venueId)
          .sort((a, b) => new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime()),
      );
    },

    async placeVenueHold(venueId, input) {
      const event = eventOf(input.eventRequestId);
      const mine = active().filter((h) => h.venueId === venueId);

      if (mine.some((h) => h.eventRequestId === event.id)) {
        throw httpError(409, { code: "HOLD_EXISTS", conflicts: [{ kind: "hold" }] });
      }

      const start = new Date(event.proposedStart).getTime();
      const end = new Date(event.proposedEnd).getTime();
      const conflicts = mine
        .filter((h) => new Date(h.eventStartsAt).getTime() < end && new Date(h.eventEndsAt).getTime() > start)
        .map((h) => ({
          kind: "hold",
          holdId: h.id,
          eventRequestId: h.eventRequestId,
          eventName: h.eventName,
          startsAt: h.eventStartsAt,
          endsAt: h.eventEndsAt,
          occupiedStartsAt: h.eventStartsAt,
          occupiedEndsAt: h.eventEndsAt,
          setupMinutes: 0,
          turnaroundMinutes: 0,
        }));
      if (conflicts.length > 0) {
        throw httpError(409, { code: "HOLD_PERIOD_CONFLICT", conflicts });
      }

      const hold = {
        id: `h${String(nextHold++).padStart(7, "0")}-0000-4000-8000-000000000000`,
        eventRequestId: event.id,
        venueId,
        placedBy: actorId,
        placedAt: iso(minuteNow()),
        expiresAt: iso(new Date(input.expiresAt).getTime()),
        status: "active",
        expiredAt: null,
        eventName: event.eventName,
        eventStartsAt: event.proposedStart,
        eventEndsAt: event.proposedEnd,
        placedByName: "Sam Staff",
      };
      holds.push(hold);
      return { hold: structuredClone(hold) };
    },
  };
}

beforeEach(() => {
  for (const fn of Object.values(venueService)) {
    vi.mocked(fn).mockReset();
    vi.mocked(fn).mockRejectedValue(new Error("unexpected call"));
  }
  const fake = createFakeHoldBackend({ actorId: STAFF_ID });
  for (const name of ["getVenueCatalogue", "getHoldCandidates", "listVenueHolds", "placeVenueHold"]) {
    vi.mocked(venueService[name]).mockImplementation(fake[name]);
  }
});

async function openHoldsPanel() {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <VenueCatalogue currentUserId={STAFF_ID} />
    </MemoryRouter>,
  );
  await screen.findByText("Hall A");
  await user.click(screen.getByRole("button", { name: "Place hold" }));
  await screen.findByText("This venue has no active holds.");
  return { user };
}

async function placeHold(user, event, expiresMs) {
  await user.click(screen.getByRole("button", { name: "+ Place a hold" }));
  await screen.findByRole("option", { name: new RegExp(event.eventName) });
  await user.selectOptions(screen.getByLabelText("Approved event"), event.id);
  fireEvent.change(screen.getByLabelText("Hold expires"), {
    target: { value: toDatetimeLocalValue(iso(expiresMs)) },
  });
  await user.click(screen.getByRole("button", { name: "Place hold" }));
}

describe("SCRUM491 venue hold flow", () => {
  it("SCRUM491_AC2_AC4_places_a_hold_then_refuses_an_overlapping_one_showing_the_conflicting_period", async () => {
    const { user } = await openHoldsPanel();
    const expires = minuteNow() + 3 * DAY;

    // AC2: the hold is placed and listed with its event, expiry and placer.
    await placeHold(user, LAUNCH, expires);
    expect(await screen.findByRole("status")).toHaveTextContent(
      `Hold placed. Hall A is tentatively held for Product Launch until ${formatTimestamp(iso(expires))}.`,
    );
    const row = (await screen.findByText("by you")).closest("li");
    expect(row).toHaveTextContent("Product Launch");
    expect(row).toHaveTextContent(`Expires ${formatTimestamp(iso(expires))}`);

    // AC4: another event over the same period is refused, naming the hold.
    await placeHold(user, FAIR, expires);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This venue is not free for the whole of the event.",
    );
    const conflictRow = document.querySelector(".venue-holds__conflict-list li");
    expect(within(conflictRow).getByText("Tentatively held")).toBeInTheDocument();
    expect(within(conflictRow).getByText("Product Launch")).toBeInTheDocument();
    expect(
      within(conflictRow).getByText(
        formatOccupiedPeriod({ startsAt: LAUNCH.proposedStart, endsAt: LAUNCH.proposedEnd }),
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText("by you")).toHaveLength(1);
  });

  it("SCRUM491_AC3_an_event_cannot_hold_the_same_venue_twice", async () => {
    const { user } = await openHoldsPanel();

    await placeHold(user, LAUNCH, minuteNow() + 2 * DAY);
    await screen.findByText("by you");
    await placeHold(user, LAUNCH, minuteNow() + 4 * DAY);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This event already holds this venue. An event can have only one active hold at each venue.",
    );
    await waitFor(() => expect(screen.getAllByText("Tentatively held")).toHaveLength(1));
  });

  it("SCRUM491_AC1_a_refusal_for_not_being_Venue_Staff_says_why", async () => {
    vi.mocked(venueService.placeVenueHold).mockRejectedValue(
      httpError(403, { error: "This action is restricted to Venue Staff" }),
    );
    const { user } = await openHoldsPanel();
    await placeHold(user, LAUNCH, minuteNow() + 2 * DAY);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only Venue Staff can place a tentative hold on a venue.",
    );
    expect(screen.getByText("This venue has no active holds.")).toBeInTheDocument();
  });

  it("SCRUM491_Back_returns_to_the_catalogue", async () => {
    const { user } = await openHoldsPanel();
    await user.click(screen.getByRole("button", { name: "← Back to the venue catalogue" }));

    expect(await screen.findByRole("heading", { name: "Venue catalogue" })).toBeInTheDocument();
  });
});
