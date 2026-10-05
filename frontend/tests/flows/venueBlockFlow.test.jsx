// venueBlockFlow.test.jsx
//
// SCRUM-132 (part of SCRUM-17). One end-to-end flow through the real
// components: VenueCatalogue -> "Manage blocks" -> VenueBlocksPanel, with the
// real VenueBlockForm, BlockConflictList and BlockHistory underneath.
//
// Only venueService is mocked, and it is backed by a small stateful
// in-memory fake (createFakeVenueBackend) built fresh for every test: writes
// change its blocks and history, reads hand back copies, and a counter clock
// moves one minute per write so "Last amended" is strictly later than
// "Created". It answers the first create with one scripted booking conflict.
// Every venueService export the tree imports but this flow should never
// reach rejects with "unexpected call".
//
// Timezone-safe: instants are compared with getTime(), expected strings come
// from formatRange / formatTimestamp, datetime-local inputs are set with
// fireEvent.change through toDatetimeLocalValue, and there are no fake
// timers. Passes under TZ=UTC, Asia/Singapore and America/New_York.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import VenueCatalogue from "../../src/components/VenueCatalogue.jsx";
import * as venueService from "../../src/services/venueService";
import { formatRange, formatTimestamp } from "../../src/services/displayFormat";
import { toDatetimeLocalValue } from "../../src/services/datetimeFormat";
import { reasonLabel } from "../../src/services/venueBlockReasons";

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
}));

const OFFSET_SUFFIX = /[+-]\d{2}:\d{2}$|Z$/;
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

function conflictError(conflicts) {
  return Object.assign(new Error("Request failed with status code 409"), {
    response: {
      status: 409,
      data: { error: "block overlaps approved bookings", code: "BLOCK_BOOKING_CONFLICT", conflicts },
    },
  });
}

/** The snake_case jsonb a history entry carries for a block row. */
function snake(block) {
  return {
    id: block.id,
    venue_id: block.venueId,
    starts_at: block.startsAt,
    ends_at: block.endsAt,
    reason: block.reason,
    notes: block.notes,
    created_at: block.createdAt,
    created_by: block.createdBy,
    updated_at: block.updatedAt,
    last_modified_by: block.lastModifiedBy,
    removed_at: block.removedAt,
    removed_by: block.removedBy,
  };
}

const CAMEL_TO_SNAKE = { startsAt: "starts_at", endsAt: "ends_at", reason: "reason", notes: "notes" };

/**
 * A stateful in-memory stand-in for the block endpoints.
 *
 * @param {object} options
 * @param {object} options.venue        the one venue in the catalogue
 * @param {string} options.actorId      who every write is recorded against
 * @param {Array}  options.conflicts    bookings the first create overlaps
 */
function createFakeVenueBackend({ venue, actorId, conflicts }) {
  const blocks = [];
  const history = [];
  let pendingConflicts = [...conflicts];
  let clock = minuteNow();
  let nextBlock = 1;
  let nextEntry = 1;

  function tick() {
    clock += MINUTE;
    return iso(clock);
  }

  function find(venueId, blockId) {
    const block = blocks.find((b) => b.venueId === venueId && b.id === blockId && !b.removedAt);
    if (!block) throw new Error(`fake backend: no live block ${blockId}`);
    return block;
  }

  function record(block, action, oldValues, newValues, at) {
    history.push({
      id: `c${String(nextEntry++).padStart(7, "0")}-0000-4000-8000-000000000000`,
      blockId: block.id,
      action,
      changedBy: actorId,
      changedAt: at,
      oldValues,
      newValues,
    });
  }

  return {
    blocks,
    history,

    async getVenueCatalogue() {
      return [structuredClone(venue)];
    },

    async listVenueBlocks(venueId) {
      return structuredClone(
        blocks
          .filter((b) => b.venueId === venueId && !b.removedAt)
          .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()),
      );
    },

    async createVenueBlock(venueId, input) {
      let flaggedBookings = [];
      if (pendingConflicts.length > 0) {
        const acknowledged = Array.isArray(input.acknowledgedBookingIds)
          ? input.acknowledgedBookingIds
          : [];
        const allAcknowledged = pendingConflicts.every((c) => acknowledged.includes(c.bookingId));
        if (input.confirmOverride !== true || !allAcknowledged) {
          throw conflictError(structuredClone(pendingConflicts));
        }
        flaggedBookings = structuredClone(pendingConflicts);
        pendingConflicts = [];
      }

      const at = tick();
      const block = {
        id: `b${String(nextBlock++).padStart(7, "0")}-0000-4000-8000-000000000000`,
        venueId,
        startsAt: iso(new Date(input.startsAt).getTime()),
        endsAt: iso(new Date(input.endsAt).getTime()),
        reason: input.reason,
        notes: input.notes ?? null,
        createdAt: at,
        createdBy: actorId,
        updatedAt: at,
        lastModifiedBy: actorId,
        removedAt: null,
        removedBy: null,
      };
      blocks.push(block);
      record(block, "created", {}, snake(block), at);
      return { block: structuredClone(block), flaggedBookings };
    },

    async updateVenueBlock(venueId, blockId, changes) {
      const block = find(venueId, blockId);
      const at = tick();
      const oldValues = {};
      const newValues = {};

      for (const [key, value] of Object.entries(changes)) {
        const next =
          (key === "startsAt" || key === "endsAt") && value !== null
            ? iso(new Date(value).getTime())
            : value;
        if (block[key] === next) continue;
        oldValues[CAMEL_TO_SNAKE[key]] = block[key];
        newValues[CAMEL_TO_SNAKE[key]] = next;
        block[key] = next;
      }

      oldValues.updated_at = block.updatedAt;
      oldValues.last_modified_by = block.lastModifiedBy;
      block.updatedAt = at;
      block.lastModifiedBy = actorId;
      newValues.updated_at = at;
      newValues.last_modified_by = actorId;

      record(block, "amended", oldValues, newValues, at);
      return { block: structuredClone(block), flaggedBookings: [] };
    },

    async removeVenueBlock(venueId, blockId) {
      const block = find(venueId, blockId);
      const at = tick();
      block.removedAt = at;
      block.removedBy = actorId;
      record(
        block,
        "removed",
        { removed_at: null, removed_by: null },
        { removed_at: at, removed_by: actorId },
        at,
      );
      return undefined;
    },

    async getVenueBlockHistory(venueId, blockId) {
      return structuredClone(
        history
          .filter((entry) => entry.blockId === blockId)
          .slice()
          .reverse(),
      );
    },
  };
}

const FAKE_BACKED = [
  "getVenueCatalogue",
  "listVenueBlocks",
  "createVenueBlock",
  "updateVenueBlock",
  "removeVenueBlock",
  "getVenueBlockHistory",
];

let backend;
let BOOKING;
let confirmSpy;

beforeEach(() => {
  const base = minuteNow();
  // An approved booking inside the block the flow creates (base + 10 days to
  // base + 11 days), and clear of its shortened end.
  BOOKING = {
    bookingId: "a1b2c3d4-0000-4000-8000-000000000001",
    eventRequestId: "e1b2c3d4-0000-4000-8000-000000000001",
    eventName: "Tech Talk",
    startsAt: iso(base + 10 * DAY + 3 * HOUR),
    endsAt: iso(base + 10 * DAY + 5 * HOUR),
  };
  backend = createFakeVenueBackend({ venue: VENUE, actorId: STAFF_ID, conflicts: [BOOKING] });

  for (const [name, fn] of Object.entries(venueService)) {
    vi.mocked(fn).mockReset();
    if (FAKE_BACKED.includes(name)) {
      vi.mocked(fn).mockImplementation((...args) => backend[name](...args));
    } else {
      vi.mocked(fn).mockImplementation(() => Promise.reject(new Error(`unexpected call: ${name}`)));
    }
  }

  confirmSpy = vi.spyOn(window, "confirm").mockImplementation(() => true);
});

afterEach(() => {
  expect(confirmSpy).not.toHaveBeenCalled();
  confirmSpy.mockRestore();
});

function setDate(label, instant) {
  fireEvent.change(screen.getByLabelText(label), {
    target: { value: toDatetimeLocalValue(instant) },
  });
}

function noticeEl() {
  return document.querySelector(".venue-blocks__notice");
}

describe("SCRUM-17 venue block flow (SCRUM-132)", () => {
  it("SCRUM17_AC1_AC3_AC4_staff_block_override_amend_and_remove_flow", async () => {
    const user = userEvent.setup();
    const base = minuteNow();
    const START = iso(base + 10 * DAY);
    const END = iso(base + 11 * DAY);
    const NEW_END = iso(base + 11 * DAY - 2 * HOUR);

    render(
      <MemoryRouter>
        <VenueCatalogue currentUserId={STAFF_ID} />
      </MemoryRouter>,
    );

    // ---- 1. Open the panel from the catalogue --------------------------------
    await user.click(await screen.findByRole("button", { name: "Manage blocks" }));
    expect(
      screen.getByRole("heading", { level: 2, name: "Blocks for Hall A — Level 2" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("This venue has no blocks.")).toBeInTheDocument();
    expect(venueService.listVenueBlocks).toHaveBeenCalledWith(VENUE.id);

    // ---- 2. AC1: create, sent with an explicit offset -------------------------
    await user.click(screen.getByRole("button", { name: "+ Add a block" }));
    setDate("Start", START);
    setDate("End", END);
    await user.selectOptions(screen.getByLabelText("Reason"), "renovation");
    await user.type(screen.getByRole("textbox"), "Lift works");
    await user.click(screen.getByRole("button", { name: "Block venue" }));

    // ---- 3. AC3: the conflict is listed, and nothing was created --------------
    expect(await screen.findByText("This period overlaps 1 approved booking")).toBeInTheDocument();
    const conflictList = document.querySelector(".block-conflicts__list");
    expect(within(conflictList).getByText("Tech Talk")).toBeInTheDocument();
    expect(
      within(conflictList).getByText(formatRange(BOOKING.startsAt, BOOKING.endsAt)),
    ).toBeInTheDocument();
    expect(screen.getByText("This venue has no blocks.")).toBeInTheDocument();
    expect(backend.blocks).toHaveLength(0);

    expect(venueService.createVenueBlock).toHaveBeenCalledTimes(1);
    const [firstVenueId, firstPayload] = vi.mocked(venueService.createVenueBlock).mock.calls[0];
    expect(firstVenueId).toBe(VENUE.id);
    expect(Object.keys(firstPayload).sort()).toEqual(["endsAt", "notes", "reason", "startsAt"]);
    expect(firstPayload.startsAt).toMatch(OFFSET_SUFFIX);
    expect(firstPayload.endsAt).toMatch(OFFSET_SUFFIX);
    expect(new Date(firstPayload.startsAt).getTime()).toBe(new Date(START).getTime());
    expect(new Date(firstPayload.endsAt).getTime()).toBe(new Date(END).getTime());
    expect(firstPayload.reason).toBe("renovation");
    expect(firstPayload.notes).toBe("Lift works");
    expect(firstPayload).not.toHaveProperty("confirmOverride");
    expect(firstPayload).not.toHaveProperty("acknowledgedBookingIds");

    // ---- 4. AC3: two-step override resends the same payload plus the acks ----
    await user.click(screen.getByRole("button", { name: "Override and flag 1 booking" }));
    expect(venueService.createVenueBlock).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("Flag these bookings for review and notify Event Coordinators?"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Yes, override" }));

    // ---- 5. The flagged notice, and the new row's audit line -----------------
    await waitFor(() => expect(noticeEl()).not.toBeNull());
    expect(venueService.createVenueBlock).toHaveBeenCalledTimes(2);
    const [secondVenueId, secondPayload] = vi.mocked(venueService.createVenueBlock).mock.calls[1];
    expect(secondVenueId).toBe(VENUE.id);
    expect(secondPayload).toEqual({
      ...firstPayload,
      confirmOverride: true,
      acknowledgedBookingIds: [BOOKING.bookingId],
    });

    const notice = noticeEl();
    expect(within(notice).getByText("Block saved.")).toBeInTheDocument();
    expect(
      within(notice).getByText(
        "1 booking was flagged for review and Event Coordinators were notified:",
      ),
    ).toBeInTheDocument();
    expect(within(notice).getByText("Tech Talk")).toBeInTheDocument();
    expect(
      within(notice).getByText(formatRange(BOOKING.startsAt, BOOKING.endsAt)),
    ).toBeInTheDocument();
    expect(screen.queryByText("This period overlaps 1 approved booking")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Block venue" })).not.toBeInTheDocument();

    const [created] = backend.blocks;
    const rowRange = await screen.findByText(formatRange(START, END));
    let row = rowRange.closest("li");
    expect(within(row).getByText(reasonLabel("renovation"))).toBeInTheDocument();
    expect(within(row).getByText("Lift works")).toBeInTheDocument();
    const audit = row.querySelector(".venue-blocks__audit");
    expect(audit.textContent).toBe(`Created ${formatTimestamp(created.createdAt)} by you`);
    expect(audit.textContent).not.toContain("Last amended");
    expect(screen.queryByText("This venue has no blocks.")).not.toBeInTheDocument();

    // ---- 6. AC4: History shows the one Created entry -------------------------
    await user.click(within(row).getByRole("button", { name: "History" }));
    let historyRegion = await screen.findByRole("region", { name: "Change history" });
    await within(historyRegion).findByText("Created");
    expect(venueService.getVenueBlockHistory).toHaveBeenCalledWith(VENUE.id, created.id);
    let entries = within(historyRegion).getAllByText(/^(Created|Amended|Removed)$/);
    expect(entries.map((el) => el.textContent)).toEqual(["Created"]);
    expect(within(historyRegion).getByText(`End: ${formatTimestamp(END)}`)).toBeInTheDocument();
    expect(within(historyRegion).getByText("by you")).toBeInTheDocument();
    const historyCallsBeforeEdit = vi.mocked(venueService.getVenueBlockHistory).mock.calls.length;

    // ---- 7. AC4: shorten -- only endsAt is sent --------------------------------
    await user.click(within(row).getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("heading", { name: "Change this block" })).toBeInTheDocument();
    setDate("End", NEW_END);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(venueService.updateVenueBlock).toHaveBeenCalledTimes(1));
    const [updVenueId, updBlockId, changes] = vi.mocked(venueService.updateVenueBlock).mock.calls[0];
    expect(updVenueId).toBe(VENUE.id);
    expect(updBlockId).toBe(created.id);
    expect(Object.keys(changes)).toEqual(["endsAt"]);
    expect(changes.endsAt).toMatch(OFFSET_SUFFIX);
    expect(new Date(changes.endsAt).getTime()).toBe(new Date(NEW_END).getTime());

    row = (await screen.findByText(formatRange(START, NEW_END))).closest("li");
    expect(within(noticeEl()).getByText("Block saved.")).toBeInTheDocument();
    expect(noticeEl().textContent).not.toContain("flagged for review");
    const amendedAt = backend.blocks[0].updatedAt;
    expect(new Date(amendedAt).getTime()).toBeGreaterThan(new Date(created.createdAt).getTime());
    expect(row.querySelector(".venue-blocks__audit").textContent).toBe(
      `Created ${formatTimestamp(created.createdAt)} by you · Last amended ${formatTimestamp(amendedAt)} by you`,
    );

    // The open history refetched by itself: Amended now sits above Created.
    historyRegion = screen.getByRole("region", { name: "Change history" });
    await within(historyRegion).findByText("Amended");
    expect(vi.mocked(venueService.getVenueBlockHistory).mock.calls.length).toBeGreaterThan(
      historyCallsBeforeEdit,
    );
    entries = within(historyRegion).getAllByText(/^(Created|Amended|Removed)$/);
    expect(entries.map((el) => el.textContent)).toEqual(["Amended", "Created"]);
    expect(
      within(historyRegion).getByText(`End: ${formatTimestamp(END)} → ${formatTimestamp(NEW_END)}`),
    ).toBeInTheDocument();
    // Hidden audit keys are not listed as changes.
    expect(historyRegion.textContent).not.toContain("updated_at");
    expect(historyRegion.textContent).not.toContain("last_modified_by");

    // ---- 8. AC4: two-step remove ---------------------------------------------
    await user.click(within(row).getByRole("button", { name: "Remove" }));
    expect(venueService.removeVenueBlock).not.toHaveBeenCalled();
    expect(
      within(row).getByText("Remove this block? Bookings it flagged stay flagged for review."),
    ).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "Yes, remove" }));

    expect(await screen.findByText("Block removed.")).toBeInTheDocument();
    expect(venueService.removeVenueBlock).toHaveBeenCalledTimes(1);
    expect(venueService.removeVenueBlock).toHaveBeenCalledWith(VENUE.id, created.id);
    expect(await screen.findByText("This venue has no blocks.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Change history" })).not.toBeInTheDocument();
    expect(backend.blocks[0].removedAt).not.toBeNull();
    expect(backend.history.map((entry) => entry.action)).toEqual(["created", "amended", "removed"]);
  });
});
