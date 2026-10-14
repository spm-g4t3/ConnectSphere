// venueCalendarFlow.test.jsx
//
// SCRUM-184 (part of SCRUM-178). The venue calendar end to end through the
// REAL App: its route table, ProtectedRoute, VenueSearch / VenueCatalogue,
// the "View calendar" link (SCRUM-181) and the real VenueCalendar with its
// date maths and labels underneath.
//
// Only two modules are mocked, as in venueBlockFlow.test.jsx and
// venueCalendarRoute.test.jsx:
//   - venueService, backed by a small in-memory fake whose getVenueCalendar
//     answers with the entries overlapping the requested window, as the
//     endpoint does. Every other export rejects with "unexpected call".
//   - the auth context, so a test can say who is signed in.
//
// The coordinator's journey starts on venue search rather than the
// catalogue: /venue-catalogue is Venue Staff only in App.jsx, so a
// Coordinator reaches a venue's calendar from search. The staff journey
// covers the catalogue's link.
//
// The calendar opens on today (no ?date=), so expected windows are worked out
// from the real clock at the start of each test with the local Date
// constructor, and compared as instants with toISOString. No fake timers.
// Passes under TZ=UTC, Asia/Singapore and America/New_York.
//
// SCRUM-185 (for SCRUM-178 AC1): the fake search honours includeRetired, and a
// coordinator reaches a retired venue's past bookings from search.
//
// SCRUM-484 (AC7): a booking at a venue with setup and turnaround shows the
// three parts in every view. Its expected text is built with formatRange from
// the same instants, so it holds in all three zones above.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import App from "../../src/App.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import * as venueService from "../../src/services/venueService";
import { formatRange } from "../../src/services/displayFormat";

vi.mock("../../src/auth/AuthContext", () => ({
  AuthProvider: ({ children }) => children,
  useAuth: vi.fn(),
}));

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
  getVenueCalendar: vi.fn(),
  createVenueBlock: vi.fn(),
  updateVenueBlock: vi.fn(),
  removeVenueBlock: vi.fn(),
  getVenueBlockHistory: vi.fn(),
}));

const OFFSET_SUFFIX = /[+-]\d{2}:\d{2}$/;

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
  retiredAt: "2026-09-01T10:00:00+08:00",
};

/** Local midnight `n` days after `date`'s day, via the local constructor. */
function dayAfter(date, n) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

/** The Monday on or before `date`, at local midnight. */
function mondayOf(date) {
  return dayAfter(date, -((date.getDay() + 6) % 7));
}

/** `day` at local hh:00 as the wire ISO string. */
function at(day, hour) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour).toISOString();
}

function dayButtonName(date) {
  return `Show ${date.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  })}`;
}

function dayTitle(date) {
  return date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * A stand-in for the venue endpoints. getVenueCalendar answers like
 * GET /venues/:id/calendar: the venue's entries overlapping [from, to).
 */
function createFakeVenueBackend({ venues, entriesByVenue }) {
  return {
    // Like GET /venues/search: retired venues only with includeRetired (SCRUM-185).
    async searchActiveVenues(filters = {}) {
      return venues
        .filter((venue) => filters.includeRetired === true || !venue.retiredAt)
        .map((venue) => ({ ...venue }));
    },
    async getVenueCatalogue() {
      return venues.map((venue) => ({ ...venue }));
    },
    async getVenueDetails(venueId) {
      const venue = venues.find((v) => v.id === venueId);
      if (!venue) throw new Error(`fake backend: no venue ${venueId}`);
      return { ...venue };
    },
    async getVenueCalendar(venueId, { from, to }) {
      const start = new Date(from).getTime();
      const end = new Date(to).getTime();
      // SCRUM-484: a booking overlaps the window by its occupied period
      // (setup through turnaround) when it has one, as the endpoint does.
      return (entriesByVenue[venueId] ?? [])
        .filter(
          (e) =>
            new Date(e.occupiedStartsAt ?? e.startsAt).getTime() < end &&
            new Date(e.occupiedEndsAt ?? e.endsAt).getTime() > start,
        )
        .map((e) => ({ ...e }));
    },
  };
}

const FAKE_BACKED = ["searchActiveVenues", "getVenueCatalogue", "getVenueDetails", "getVenueCalendar"];

let backend;
let monday;
let entries;
let retiredMonday;

function signIn(role) {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: "d1000000-0000-4000-8000-000000000001", name: "Test User", role },
    loading: false,
    logout: vi.fn().mockResolvedValue({ success: true }),
    logoutMessage: null,
    clearLogoutMessage: vi.fn(),
  });
}

function renderAppAt(path) {
  window.history.pushState({}, "", path);
  return render(<App />);
}

/** Every getVenueCalendar window so far, as ISO instants. */
function calendarWindows() {
  return vi.mocked(venueService.getVenueCalendar).mock.calls.map(([venueId, window]) => {
    expect(window.from).toMatch(OFFSET_SUFFIX);
    expect(window.to).toMatch(OFFSET_SUFFIX);
    return {
      venueId,
      from: new Date(window.from).toISOString(),
      to: new Date(window.to).toISOString(),
    };
  });
}

function lastWindow() {
  return calendarWindows().at(-1);
}

function windowOf(start, end) {
  return { venueId: VENUE.id, from: start.toISOString(), to: end.toISOString() };
}

/** Wait until the answer for the window on screen has landed. */
async function settled() {
  await waitFor(() => expect(screen.queryByText("Loading calendar...")).not.toBeInTheDocument());
}

function labelOf(item) {
  return item.querySelector(".venue-calendar__entry-label").textContent;
}

beforeEach(() => {
  monday = mondayOf(new Date());
  entries = {
    approved: {
      kind: "booking",
      id: "b1",
      startsAt: at(dayAfter(monday, 1), 10),
      endsAt: at(dayAfter(monday, 1), 12),
      status: "approved",
      eventRequestId: "e1",
      eventName: "Gala Dinner",
    },
    flagged: {
      kind: "booking",
      id: "b2",
      startsAt: at(dayAfter(monday, 2), 14),
      endsAt: at(dayAfter(monday, 2), 16),
      status: "flagged_for_review",
      eventRequestId: "e2",
      eventName: "Product Launch",
    },
    block: {
      kind: "block",
      id: "k1",
      startsAt: at(dayAfter(monday, 3), 9),
      endsAt: at(dayAfter(monday, 3), 17),
      reason: "maintenance",
      notes: "Secret staff note",
    },
    nextWeek: {
      kind: "booking",
      id: "b3",
      startsAt: at(dayAfter(monday, 8), 9),
      endsAt: at(dayAfter(monday, 8), 11),
      status: "approved",
      eventRequestId: "e3",
      eventName: "Next Week Talk",
    },
  };

  // The week the venue retired, and a booking the week before it.
  retiredMonday = mondayOf(new Date(RETIRED.retiredAt));
  const farewellDay = dayAfter(retiredMonday, -5);

  backend = createFakeVenueBackend({
    venues: [VENUE, RETIRED],
    entriesByVenue: {
      [VENUE.id]: Object.values(entries),
      [RETIRED.id]: [
        {
          kind: "block",
          id: "k-old",
          startsAt: at(dayAfter(monday, 4), 9),
          endsAt: at(dayAfter(monday, 4), 12),
          reason: "renovation",
          notes: null,
        },
        {
          kind: "booking",
          id: "b-old",
          startsAt: at(farewellDay, 10),
          endsAt: at(farewellDay, 12),
          status: "approved",
          eventRequestId: "e-old",
          eventName: "Farewell Gala",
        },
      ],
    },
  });

  vi.mocked(useAuth).mockReset();
  for (const [name, fn] of Object.entries(venueService)) {
    vi.mocked(fn).mockReset();
    if (FAKE_BACKED.includes(name)) {
      vi.mocked(fn).mockImplementation((...args) => backend[name](...args));
    } else {
      vi.mocked(fn).mockImplementation(() => Promise.reject(new Error(`unexpected call: ${name}`)));
    }
  }
});

describe("SCRUM178_AC1_AC2_AC4 venue calendar flow (SCRUM-184)", () => {
  it("SCRUM178_AC1_AC2_AC4_coordinator_opens_calendar_from_venue_search_and_navigates", async () => {
    const user = userEvent.setup();
    signIn("event_coordinator");
    renderAppAt("/venue-search?location=Level");

    // ---- 1. AC1: from a search result to the calendar -----------------------
    const result = (await screen.findByText("Hall A")).closest("li");
    await user.click(within(result).getByRole("link", { name: "View calendar" }));

    expect(window.location.pathname).toBe(`/venues/${VENUE.id}/calendar`);
    expect(await screen.findByRole("heading", { level: 1, name: "Hall A" })).toBeInTheDocument();
    expect(screen.queryByText("Retired")).not.toBeInTheDocument();
    await settled();

    // Opens on this week, Monday to Monday.
    expect(calendarWindows()).toEqual([windowOf(monday, dayAfter(monday, 7))]);
    expect(venueService.getVenueDetails).toHaveBeenCalledWith(VENUE.id);

    // ---- 2. AC2: the three labels, each on its own day ----------------------
    const cells = within(screen.getByRole("table")).getAllByRole("cell");
    expect(cells).toHaveLength(7);

    const booked = within(cells[1]).getByRole("listitem");
    expect(labelOf(booked)).toBe("Booked");
    expect(booked).toHaveTextContent("Gala Dinner");

    const review = within(cells[2]).getByRole("listitem");
    expect(labelOf(review)).toBe("Booked – under review");
    expect(review).toHaveTextContent("Product Launch");

    const blocked = within(cells[3]).getByRole("listitem");
    expect(labelOf(blocked)).toBe("Blocked — Maintenance");
    expect(screen.queryByText(/Secret staff note/)).not.toBeInTheDocument();
    expect(screen.queryByText("Next Week Talk")).not.toBeInTheDocument();

    // ---- 3. AC4: Next week, then Previous week ------------------------------
    await user.click(screen.getByRole("button", { name: "Next week" }));
    expect(await screen.findByText("Next Week Talk")).toBeInTheDocument();
    expect(lastWindow()).toEqual(windowOf(dayAfter(monday, 7), dayAfter(monday, 14)));
    expect(screen.queryByText("Gala Dinner")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Previous week" }));
    expect(await screen.findByText("Gala Dinner")).toBeInTheDocument();
    expect(lastWindow()).toEqual(windowOf(monday, dayAfter(monday, 7)));
    expect(screen.queryByText("Next Week Talk")).not.toBeInTheDocument();

    // ---- 4. AC4: Month, whole weeks around today's month --------------------
    const today = new Date();
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const monthStart = mondayOf(first);
    const monthEnd = dayAfter(mondayOf(last), 7);

    await user.click(screen.getByRole("button", { name: "Month" }));
    await settled();
    expect(lastWindow()).toEqual(windowOf(monthStart, monthEnd));
    const monthName = dayAfter(monthStart, 7).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    expect(screen.getByRole("table", { name: monthName })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next month" })).toBeInTheDocument();

    // ---- 5. AC4: a day in the month opens the day view ----------------------
    const tuesday = dayAfter(monday, 1);
    const tuesdayCell = screen.getByRole("button", { name: dayButtonName(tuesday) }).closest("td");
    expect(within(tuesdayCell).getByRole("listitem")).toHaveTextContent("Gala Dinner");

    await user.click(screen.getByRole("button", { name: dayButtonName(tuesday) }));
    expect(screen.getByRole("button", { name: "Day" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(dayTitle(tuesday));
    await settled();
    expect(lastWindow()).toEqual(windowOf(tuesday, dayAfter(tuesday, 1)));

    const dayItems = within(document.querySelector(".venue-calendar")).getAllByRole("listitem");
    expect(dayItems).toHaveLength(1);
    expect(labelOf(dayItems[0])).toBe("Booked");
    expect(dayItems[0]).toHaveTextContent("Gala Dinner");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    // The header was fetched once for the whole journey.
    expect(venueService.getVenueDetails).toHaveBeenCalledTimes(1);
    expect(calendarWindows().every((w) => w.venueId === VENUE.id)).toBe(true);
  });

  it("SCRUM178_AC1_staff_opens_a_retired_venues_calendar_from_the_catalogue", async () => {
    const user = userEvent.setup();
    signIn("venue_staff");
    renderAppAt("/venue-catalogue");

    const row = (await screen.findByText("Old Annex")).closest("li");
    await user.click(within(row).getByRole("link", { name: "View calendar" }));

    expect(window.location.pathname).toBe(`/venues/${RETIRED.id}/calendar`);
    expect(await screen.findByRole("heading", { level: 1, name: "Old Annex" })).toBeInTheDocument();
    expect(screen.getByText("Retired")).toHaveClass("venue-calendar__badge");
    await settled();

    expect(lastWindow()).toEqual({ ...windowOf(monday, dayAfter(monday, 7)), venueId: RETIRED.id });
    const friday = within(screen.getByRole("table")).getAllByRole("cell")[4];
    expect(labelOf(within(friday).getByRole("listitem"))).toBe("Blocked — Renovation");
  });
});

describe("SCRUM178_AC1 retired venue calendar from search (SCRUM-185)", () => {
  it("SCRUM178_AC1_coordinator_opens_a_retired_venues_calendar_from_search", async () => {
    const user = userEvent.setup();
    signIn("event_coordinator");
    renderAppAt("/venue-search");

    // ---- 1. A default search lists active venues only ----------------------
    await user.click(screen.getByRole("button", { name: "Search venues" }));
    expect(await screen.findByText("Hall A")).toBeInTheDocument();
    expect(screen.queryByText("Old Annex")).not.toBeInTheDocument();
    expect(venueService.searchActiveVenues.mock.calls[0][0]).not.toHaveProperty("includeRetired");

    // ---- 2. Tick Include retired, then Search ------------------------------
    await user.click(screen.getByRole("checkbox", { name: "Include retired venues" }));
    expect(venueService.searchActiveVenues).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Search venues" }));

    const row = (await screen.findByText("Old Annex")).closest("li");
    expect(venueService.searchActiveVenues).toHaveBeenCalledTimes(2);
    expect(venueService.searchActiveVenues.mock.calls[1][0]).toMatchObject({ includeRetired: true });
    expect(within(row).getByText("Retired")).toHaveClass("venue-search__badge");

    // ---- 3. View calendar opens on the week it retired ---------------------
    await user.click(within(row).getByRole("link", { name: "View calendar" }));

    expect(window.location.pathname).toBe(`/venues/${RETIRED.id}/calendar`);
    expect(await screen.findByRole("heading", { level: 1, name: "Old Annex" })).toBeInTheDocument();
    expect(screen.getByText("Retired")).toHaveClass("venue-calendar__badge");
    await settled();

    expect(calendarWindows()).toEqual([
      { venueId: RETIRED.id, from: retiredMonday.toISOString(), to: dayAfter(retiredMonday, 7).toISOString() },
    ]);
    expect(screen.queryByText("Farewell Gala")).not.toBeInTheDocument();

    // ---- 4. Previous week shows the past booking ---------------------------
    await user.click(screen.getByRole("button", { name: "Previous week" }));
    const gala = await screen.findByText("Farewell Gala");
    expect(lastWindow()).toEqual({
      venueId: RETIRED.id,
      from: dayAfter(retiredMonday, -7).toISOString(),
      to: retiredMonday.toISOString(),
    });
    expect(labelOf(gala.closest("li"))).toBe("Booked");
    const wednesday = within(screen.getByRole("table")).getAllByRole("cell")[2];
    expect(within(wednesday).getByRole("listitem")).toHaveTextContent("Farewell Gala");
  });
});

describe("SCRUM178_AC6 venue calendar flow is refused to external roles (SCRUM-184)", () => {
  it("SCRUM178_AC6_organiser_on_calendar_url_lands_on_unauthorized", async () => {
    signIn("event_organiser");
    renderAppAt(`/venues/${VENUE.id}/calendar`);

    expect(window.location.pathname).toBe("/unauthorized");
    expect(screen.getByRole("heading", { name: "Not available to your role" })).toBeInTheDocument();
    expect(screen.queryByText("Venue calendar")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    // Give any stray effect a chance to fire before asserting nothing was asked.
    await waitFor(() => expect(venueService.getVenueCalendar).not.toHaveBeenCalled());
    expect(venueService.getVenueDetails).not.toHaveBeenCalled();
  });
});

describe("SCRUM484_AC7 venue calendar flow shows setup and turnaround", () => {
  /** `day` at local hh:mm as the wire ISO string. */
  function atMinute(day, hour, minute) {
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute).toISOString();
  }

  it("SCRUM484_AC7_parts_are_timezone_safe", async () => {
    // Wednesday 10:00-12:00 at a venue with 30 minutes of setup and 45 of
    // turnaround, as GET /venues/:id/calendar sends it.
    const wednesday = dayAfter(monday, 2);
    const padded = {
      kind: "booking",
      id: "b-orientation",
      startsAt: atMinute(wednesday, 10, 0),
      endsAt: atMinute(wednesday, 12, 0),
      occupiedStartsAt: atMinute(wednesday, 9, 30),
      occupiedEndsAt: atMinute(wednesday, 12, 45),
      setupMinutes: 30,
      turnaroundMinutes: 45,
      status: "approved",
      eventRequestId: "e-orientation",
      eventName: "Orientation",
    };
    backend = createFakeVenueBackend({
      venues: [VENUE],
      entriesByVenue: { [VENUE.id]: [padded] },
    });
    const expected =
      `Setup ${formatRange(padded.occupiedStartsAt, padded.startsAt)} · ` +
      `Event ${formatRange(padded.startsAt, padded.endsAt)} · ` +
      `Turnaround ${formatRange(padded.endsAt, padded.occupiedEndsAt)}`;

    const user = userEvent.setup();
    signIn("event_coordinator");
    renderAppAt(`/venues/${VENUE.id}/calendar`);
    expect(await screen.findByRole("heading", { level: 1, name: "Hall A" })).toBeInTheDocument();
    await settled();

    // Week: the visible time and the title both carry the three parts.
    const cells = within(screen.getByRole("table")).getAllByRole("cell");
    const item = within(cells[2]).getByRole("listitem");
    expect(item).toHaveTextContent("Orientation");
    expect(item.querySelector(".venue-calendar__entry-time").textContent).toBe(expected);
    expect(item).toHaveAttribute("title", expected);
    expect(document.body).not.toHaveTextContent(/Invalid Date/);

    // Month: compact, so the parts are in the title only.
    await user.click(screen.getByRole("button", { name: "Month" }));
    await settled();
    const cell = screen.getByRole("button", { name: dayButtonName(wednesday) }).closest("td");
    const compact = within(cell).getByRole("listitem");
    expect(compact.querySelector(".venue-calendar__entry-time")).toBeNull();
    expect(compact).toHaveAttribute("title", expected);

    // Day: the same text again.
    await user.click(screen.getByRole("button", { name: dayButtonName(wednesday) }));
    await settled();
    const dayItem = within(document.querySelector(".venue-calendar")).getByRole("listitem");
    expect(dayItem.querySelector(".venue-calendar__entry-time").textContent).toBe(expected);
  });
});
