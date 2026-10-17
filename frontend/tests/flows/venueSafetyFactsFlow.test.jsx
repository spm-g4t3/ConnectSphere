// venueSafetyFactsFlow.test.jsx
//
// SCRUM-493 (G-01, case F-AC4-08). One flow through the real components:
// VenueCatalogue -> "+ Add new venue" -> VenueForm (create) -> "Edit details"
// -> VenueForm (edit) -> "View bookings & history" -> VenueDetail, with the
// real VenueSafetyFacts underneath.
//
// Only venueService is mocked, the way venueBlockFlow.test.jsx does it, and it
// is backed by a small stateful in-memory fake (createFakeVenueBackend) built
// fresh for the test. It keeps the server's rules for the two safety facts: a
// create without a key stores null, a PATCH without a key keeps the value, and
// null clears it. Each write appends a history row the way 003/008's triggers
// do: an empty oldValues on create, and only the changed columns (snake_case)
// on update. Reads hand back copies, newest history first, so each step reads
// back what the previous one wrote. Every venueService export the tree
// imports but this flow should never reach rejects with "unexpected call".

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import VenueCatalogue from "../../src/components/VenueCatalogue.jsx";
import * as venueService from "../../src/services/venueService";

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
}));

const MINUTE = 60 * 1000;
const STAFF_ID = "d1000000-0000-4000-8000-000000000001";
const VENUE_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const EMERGENCY_ACCESS = "Exit A to the car park; assemble at Lot 3";
const KNOWN_RESTRICTIONS = "No open flames or confetti";

// camelCase field -> the venues column the history triggers name.
const CAMEL_TO_SNAKE = {
  name: "name",
  location: "location",
  maxCapacity: "max_capacity",
  turnaroundMinutes: "turnaround_minutes",
  setupMinutes: "setup_minutes",
  emergencyAccess: "emergency_access",
  knownRestrictions: "known_restrictions",
};

function snakeColumns(venue) {
  return Object.fromEntries(
    Object.entries(CAMEL_TO_SNAKE).map(([camel, snake]) => [snake, venue[camel] ?? null]),
  );
}

/**
 * A stateful in-memory stand-in for the venue endpoints this flow reaches.
 *
 * @param {object} options
 * @param {string} options.actorId  who every write is recorded against
 */
function createFakeVenueBackend({ actorId }) {
  const venues = [];
  const history = [];
  let clock = Math.floor(Date.now() / MINUTE) * MINUTE;
  let nextEntry = 1;

  function tick() {
    clock += MINUTE;
    return new Date(clock).toISOString();
  }

  function find(venueId) {
    const venue = venues.find((v) => v.id === venueId);
    if (!venue) throw new Error(`fake backend: no venue ${venueId}`);
    return venue;
  }

  function record(venueId, oldValues, newValues, at) {
    history.push({
      id: `c${String(nextEntry++).padStart(7, "0")}-0000-4000-8000-000000000000`,
      venueId,
      changedBy: actorId,
      changedAt: at,
      oldValues,
      newValues,
    });
  }

  return {
    venues,
    history,

    async getVenueCatalogue() {
      return structuredClone(
        venues.map(({ id, name, location, maxCapacity, retiredAt }) => ({
          id,
          name,
          location,
          maxCapacity,
          retiredAt,
        })),
      );
    },

    async createVenue(payload) {
      const at = tick();
      const venue = {
        id: VENUE_ID,
        name: payload.name,
        location: payload.location,
        maxCapacity: payload.maxCapacity,
        layouts: payload.layouts ?? [],
        accessibility: payload.accessibility ?? [],
        facilities: payload.facilities ?? [],
        hours: payload.hours ?? [],
        turnaroundMinutes: payload.turnaroundMinutes ?? 0,
        setupMinutes: payload.setupMinutes ?? 0,
        // A missing key is stored as not recorded.
        emergencyAccess: payload.emergencyAccess ?? null,
        knownRestrictions: payload.knownRestrictions ?? null,
        retiredAt: null,
        createdAt: at,
        lastModifiedBy: actorId,
      };
      venues.push(venue);
      record(venue.id, {}, snakeColumns(venue), at);
      return structuredClone(venue);
    },

    async getVenueDetails(venueId) {
      return structuredClone(find(venueId));
    },

    async updateVenue(venueId, changes) {
      const venue = find(venueId);
      const at = tick();
      const oldValues = {};
      const newValues = {};
      for (const [key, value] of Object.entries(changes)) {
        // A missing key keeps the value; null clears it.
        if (value === undefined) continue;
        const column = CAMEL_TO_SNAKE[key];
        if (!column) throw new Error(`fake backend: unexpected change key ${key}`);
        if (venue[key] === value) continue;
        oldValues[column] = venue[key] ?? null;
        newValues[column] = value;
        venue[key] = value;
      }
      if (Object.keys(newValues).length > 0) record(venueId, oldValues, newValues, at);
      venue.lastModifiedBy = actorId;
      return { ...structuredClone(venue), flaggedBookings: [] };
    },

    async getVenueBookings() {
      return [];
    },

    async getVenueHistory(venueId) {
      return structuredClone(
        history
          .filter((entry) => entry.venueId === venueId)
          .sort((a, b) => new Date(b.changedAt).getTime() - new Date(a.changedAt).getTime()),
      );
    },
  };
}

let backend;

beforeEach(() => {
  backend = createFakeVenueBackend({ actorId: STAFF_ID });
  const wired = [
    "getVenueCatalogue",
    "createVenue",
    "getVenueDetails",
    "updateVenue",
    "getVenueBookings",
    "getVenueHistory",
  ];
  for (const [name, fn] of Object.entries(venueService)) {
    vi.mocked(fn).mockReset();
    if (wired.includes(name)) {
      vi.mocked(fn).mockImplementation((...args) => backend[name](...args));
    } else {
      vi.mocked(fn).mockRejectedValue(new Error(`unexpected call: ${name}`));
    }
  }
});

function rowFor(name) {
  return screen.getByText(name).closest("li");
}

/** The <dd> after a <dt> in the safety facts list. */
function factValue(region, label) {
  return within(region).getByText(label, { selector: "dt" }).nextElementSibling;
}

describe("SCRUM493 venue safety facts flow", () => {
  it("SCRUM493_AC4_create_with_one_field_then_edit_only_the_other_then_details_and_history", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <VenueCatalogue currentUserId={STAFF_ID} />
      </MemoryRouter>,
    );
    expect(await screen.findByText("No venues in the catalogue yet.")).toBeInTheDocument();

    // ---- 1. Create with emergency access only --------------------------------
    await user.click(screen.getByRole("button", { name: "+ Add new venue" }));
    expect(screen.getByRole("heading", { name: "Add a new venue" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Name"), "Hall A");
    await user.type(screen.getByLabelText("Location"), "Level 2");
    await user.type(screen.getByLabelText("Maximum capacity"), "200");
    await user.type(
      screen.getByRole("textbox", { name: "Emergency access" }),
      `  ${EMERGENCY_ACCESS} `,
    );
    await user.click(screen.getByRole("button", { name: "Create venue" }));

    await waitFor(() => expect(venueService.createVenue).toHaveBeenCalledTimes(1));
    const [created] = vi.mocked(venueService.createVenue).mock.calls[0];
    expect(created.emergencyAccess).toBe(EMERGENCY_ACCESS);
    expect(created.knownRestrictions).toBeUndefined();
    // Gone from the wire, not sent as "" or null.
    const wire = JSON.parse(JSON.stringify(created));
    expect(wire).toHaveProperty("emergencyAccess", EMERGENCY_ACCESS);
    expect(wire).not.toHaveProperty("knownRestrictions");
    expect(backend.venues[0].knownRestrictions).toBeNull();

    // Back on the catalogue, which refetched and lists the new venue.
    expect(await screen.findByText("Hall A")).toBeInTheDocument();

    // ---- 2. Edit and add only restrictions ------------------------------------
    await user.click(within(rowFor("Hall A")).getByRole("button", { name: "Edit details" }));
    await screen.findByRole("heading", { name: "Edit venue" });
    // The form reads back what the create wrote.
    expect(screen.getByRole("textbox", { name: "Emergency access" })).toHaveValue(
      EMERGENCY_ACCESS,
    );
    const restrictions = screen.getByRole("textbox", { name: "Known restrictions" });
    expect(restrictions).toHaveValue("");
    await user.type(restrictions, KNOWN_RESTRICTIONS);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(venueService.updateVenue).toHaveBeenCalledTimes(1));
    const [updatedId, changes] = vi.mocked(venueService.updateVenue).mock.calls[0];
    expect(updatedId).toBe(VENUE_ID);
    expect(changes).toEqual({ knownRestrictions: KNOWN_RESTRICTIONS });
    expect(Object.keys(changes)).toEqual(["knownRestrictions"]);

    // Back on the catalogue. A text-only edit flags nothing (AC6).
    expect(await screen.findByText("Hall A")).toBeInTheDocument();
    expect(document.querySelector(".venue-catalogue__flagged")).toBeNull();

    // ---- 3. The details show both values --------------------------------------
    await user.click(
      within(rowFor("Hall A")).getByRole("button", { name: "View bookings & history" }),
    );
    const facts = await screen.findByRole("region", { name: "Safety information" });
    expect(factValue(facts, "Emergency access")).toHaveTextContent(EMERGENCY_ACCESS);
    expect(factValue(facts, "Known restrictions")).toHaveTextContent(KNOWN_RESTRICTIONS);
    expect(facts).not.toHaveTextContent("Not recorded");
    expect(venueService.getVenueDetails).toHaveBeenLastCalledWith(VENUE_ID);

    // ---- 4. The history shows both changes ------------------------------------
    const historySection = screen
      .getByRole("heading", { name: "Change history" })
      .closest("section");
    await within(historySection).findByText(`Not recorded → ${KNOWN_RESTRICTIONS}`);
    expect(venueService.getVenueHistory).toHaveBeenCalledWith(VENUE_ID);

    const entries = within(historySection)
      .getAllByRole("listitem")
      .filter((li) => li.querySelector(".venue-history__meta"));
    expect(entries).toHaveLength(2);

    // Newest first: the edit, naming only known restrictions.
    const [editEntry, createEntry] = entries;
    expect(within(editEntry).getByText("Known restrictions")).toBeInTheDocument();
    expect(within(editEntry).queryByText("Emergency access")).not.toBeInTheDocument();
    expect(
      within(editEntry).getByText(`Not recorded → ${KNOWN_RESTRICTIONS}`),
    ).toBeInTheDocument();
    expect(editEntry).not.toHaveTextContent("not set");

    // Then the create, which recorded emergency access and no restrictions.
    expect(within(createEntry).getByText("Venue created")).toBeInTheDocument();
    expect(backend.history.map((entry) => Object.keys(entry.oldValues).length)).toEqual([0, 1]);
    expect(backend.history[0].newValues).toMatchObject({
      emergency_access: EMERGENCY_ACCESS,
      known_restrictions: null,
    });
    expect(backend.history[1]).toMatchObject({
      changedBy: STAFF_ID,
      oldValues: { known_restrictions: null },
      newValues: { known_restrictions: KNOWN_RESTRICTIONS },
    });

    // Nothing outside the flow was reached.
    expect(venueService.retireVenue).not.toHaveBeenCalled();
    expect(venueService.createVenueBlock).not.toHaveBeenCalled();
  });
});
