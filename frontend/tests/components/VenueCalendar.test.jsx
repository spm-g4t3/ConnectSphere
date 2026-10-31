// VenueCalendar.test.jsx
//
// SCRUM-180 (part of SCRUM-178). The venue calendar component:
//   - AC2: approved bookings read "Booked" with the event name, flagged ones
//     "Booked – under review", blocks "Blocked" with the reason
//   - AC4: day, week and month views, moved with Previous, Today and Next
//   - AC5: entries the display rules do not recognise are never shown
// plus the error messages, the header fallback, the empty state and the
// stale-response guard.
//
// venueService is mocked, so nothing touches the network. Every test opens on
// a fixed initialDate (Wednesday 7 October 2026) except the ones that pin the
// default, and "today" is fixed with fake timers that fake Date ONLY, so
// user-event and findBy*/waitFor keep their real timers.
//
// Time-zone safe: dates are built with the local Date constructor and entry
// timestamps come from local Dates via toISOString, so bucketing into days is
// the same in UTC (CI) and Asia/Singapore. Expected headings and time ranges
// are produced with the same display-format calls the component makes, so
// the tests survive ICU differences between Node versions.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import VenueCalendar from "../../src/components/VenueCalendar.jsx";
import { getVenueCalendar, getVenueDetails } from "../../src/services/venueService";
import { blockCalendarLabel } from "../../src/services/venueBlockDisplay";
import { VENUE_BLOCK_REASONS } from "../../src/services/venueBlockReasons";
import { formatDateTimeRange, formatLongDay, formatShortDay } from "../../src/services/displayFormat";
import { deferred } from "../helpers/async.js";

vi.mock("../../src/services/venueService", () => ({
  getVenueCalendar: vi.fn(),
  getVenueDetails: vi.fn(),
}));

const VENUE_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const VENUE = { id: VENUE_ID, name: "Hall A", location: "Level 2", retiredAt: null };

const OFFSET_SUFFIX = /[+-]\d{2}:\d{2}$/;

function local(y, m, d, h = 0, min = 0) {
  return new Date(y, m, d, h, min);
}

/** A local October 2026 moment as the wire ISO string. */
function oct(d, h = 0, min = 0) {
  return local(2026, 9, d, h, min).toISOString();
}

const WED_7_OCT = local(2026, 9, 7, 10);

const APPROVED = {
  kind: "booking",
  id: "b1",
  startsAt: oct(6, 9),
  endsAt: oct(6, 17),
  status: "approved",
  eventRequestId: "e1",
  eventName: "Gala Dinner",
};

const FLAGGED = {
  kind: "booking",
  id: "b2",
  startsAt: oct(8, 10),
  endsAt: oct(8, 12),
  status: "flagged_for_review",
  eventRequestId: "e2",
  eventName: "Product Launch",
};

const BLOCK = {
  kind: "block",
  id: "k1",
  startsAt: oct(9, 8),
  endsAt: oct(9, 18),
  reason: "maintenance",
  notes: "Secret staff note",
};


function expectedRange(entry) {
  return formatDateTimeRange(entry.startsAt, entry.endsAt);
}

function dayTitle(date) {
  return formatShortDay(date);
}

function dayButtonName(date) {
  return `Show ${formatLongDay(date)}`;
}

/** The window of the nth getVenueCalendar call (default: the last) as Dates. */
function requestedWindow(index = -1) {
  const calls = vi.mocked(getVenueCalendar).mock.calls;
  const [venueId, window] = calls.at(index);
  expect(window.from).toMatch(OFFSET_SUFFIX);
  expect(window.to).toMatch(OFFSET_SUFFIX);
  return { venueId, from: new Date(window.from), to: new Date(window.to) };
}

function httpError(status) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { error: "database prose with a uuid" } },
  });
}

async function renderCalendar(props = {}) {
  const user = userEvent.setup();
  const utils = render(<VenueCalendar venueId={VENUE_ID} initialDate={WED_7_OCT} {...props} />);
  await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  return { user, ...utils };
}

function weekCells(title = "5 – 11 Oct 2026") {
  const table = screen.getByRole("table", { name: title });
  return within(table).getAllByRole("cell");
}

/**
 * Answer every getVenueCalendar call with only the entries overlapping the
 * requested window, as the endpoint does, so each view gets its own slice.
 */
function serveByWindow(entries) {
  vi.mocked(getVenueCalendar).mockImplementation(async (_venueId, { from, to }) =>
    entries.filter(
      (entry) => new Date(entry.startsAt) < new Date(to) && new Date(entry.endsAt) > new Date(from),
    ),
  );
}

const VIEW_TITLES = {
  day: () => dayTitle(local(2026, 9, 7)),
  week: () => "5 – 11 Oct 2026",
  month: () => "October 2026",
};

/**
 * Switch from the opening week to `view` and wait until the answer for the
 * new window has landed: the heading names the new period and the loading
 * line is gone, which only happens once the result is keyed to that window.
 */
async function showView(user, view) {
  if (view !== "week") {
    await user.click(screen.getByRole("button", { name: view[0].toUpperCase() + view.slice(1) }));
  }
  await waitFor(() => {
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(VIEW_TITLES[view]());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
}

function cellOfDay(date) {
  return screen.getByRole("button", { name: dayButtonName(date) }).closest("td");
}

beforeEach(() => {
  vi.mocked(getVenueCalendar).mockReset();
  vi.mocked(getVenueDetails).mockReset();
  vi.mocked(getVenueCalendar).mockResolvedValue([]);
  vi.mocked(getVenueDetails).mockResolvedValue(VENUE);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SCRUM178_AC4 VenueCalendar views and the window requested", () => {
  it("SCRUM178_AC4_opens_on_the_week_view_and_requests_monday_to_monday", async () => {
    await renderCalendar();

    expect(getVenueCalendar).toHaveBeenCalledTimes(1);
    const { venueId, from, to } = requestedWindow();
    expect(venueId).toBe(VENUE_ID);
    expect(from).toEqual(local(2026, 9, 5));
    expect(to).toEqual(local(2026, 9, 12));

    const views = screen.getByRole("group", { name: "Calendar view" });
    expect(within(views).getByRole("button", { name: "Week" })).toHaveAttribute("aria-pressed", "true");
    expect(within(views).getByRole("button", { name: "Day" })).toHaveAttribute("aria-pressed", "false");
    expect(within(views).getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "false");

    const title = screen.getByRole("heading", { level: 2 });
    expect(title).toHaveTextContent("5 – 11 Oct 2026");
    expect(title).toHaveAttribute("aria-live", "polite");

    const table = screen.getByRole("table", { name: "5 – 11 Oct 2026" });
    const headers = within(table).getAllByRole("columnheader");
    expect(headers).toHaveLength(7);
    expect(headers[0]).toHaveTextContent("Mon 5 Oct");
    expect(headers[6]).toHaveTextContent("Sun 11 Oct");
    expect(weekCells()).toHaveLength(7);
  });

  it("SCRUM178_AC4_day_view_requests_one_day_and_shows_no_table", async () => {
    const { user } = await renderCalendar();

    await user.click(screen.getByRole("button", { name: "Day" }));
    await waitFor(() => expect(getVenueCalendar).toHaveBeenCalledTimes(2));

    const { from, to } = requestedWindow();
    expect(from).toEqual(local(2026, 9, 7));
    expect(to).toEqual(local(2026, 9, 8));

    expect(screen.getByRole("button", { name: "Day" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Week" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(dayTitle(local(2026, 9, 7)));
    expect(await screen.findByText("Nothing booked or blocked in this period.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("SCRUM178_AC4_month_view_requests_whole_weeks_and_mutes_days_outside_the_month", async () => {
    const { user } = await renderCalendar();

    await user.click(screen.getByRole("button", { name: "Month" }));
    await waitFor(() => expect(getVenueCalendar).toHaveBeenCalledTimes(2));

    const { from, to } = requestedWindow();
    expect(from).toEqual(local(2026, 8, 28));
    expect(to).toEqual(local(2026, 10, 2));

    expect(screen.getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "true");
    const table = await screen.findByRole("table", { name: "October 2026" });

    expect(within(table).getAllByRole("columnheader")).toHaveLength(7);
    // One header row and five weeks.
    expect(within(table).getAllByRole("row")).toHaveLength(6);
    expect(within(table).getAllByRole("cell")).toHaveLength(35);

    const cellOf = (date) => screen.getByRole("button", { name: dayButtonName(date) }).closest("td");
    expect(cellOf(local(2026, 8, 28))).toHaveClass("venue-calendar__cell--muted");
    expect(cellOf(local(2026, 10, 1))).toHaveClass("venue-calendar__cell--muted");
    expect(cellOf(local(2026, 9, 1))).not.toHaveClass("venue-calendar__cell--muted");
    expect(cellOf(local(2026, 9, 31))).not.toHaveClass("venue-calendar__cell--muted");
    expect(screen.getByRole("button", { name: dayButtonName(local(2026, 9, 7)) })).toHaveTextContent(/^7$/);
  });

  it("SCRUM178_AC4_switching_back_to_week_from_month_requests_the_week_again", async () => {
    const { user } = await renderCalendar();

    await user.click(screen.getByRole("button", { name: "Month" }));
    await screen.findByRole("table", { name: "October 2026" });
    await user.click(screen.getByRole("button", { name: "Week" }));

    expect(await screen.findByRole("table", { name: "5 – 11 Oct 2026" })).toBeInTheDocument();
    expect(getVenueCalendar).toHaveBeenCalledTimes(3);
    expect(requestedWindow().from).toEqual(local(2026, 9, 5));
  });

  it("SCRUM178_AC4_next_and_previous_move_the_week_and_refetch", async () => {
    const { user } = await renderCalendar();
    const nav = screen.getByRole("group", { name: "Move through the calendar" });

    await user.click(within(nav).getByRole("button", { name: "Next week" }));
    expect(await screen.findByRole("table", { name: "12 – 18 Oct 2026" })).toBeInTheDocument();
    expect(getVenueCalendar).toHaveBeenCalledTimes(2);
    expect(requestedWindow()).toMatchObject({ from: local(2026, 9, 12), to: local(2026, 9, 19) });

    await user.click(within(nav).getByRole("button", { name: "Previous week" }));
    await user.click(within(nav).getByRole("button", { name: "Previous week" }));

    expect(await screen.findByRole("table", { name: "28 Sept – 4 Oct 2026" })).toBeInTheDocument();
    expect(requestedWindow()).toMatchObject({ from: local(2026, 8, 28), to: local(2026, 9, 5) });
  });

  it("SCRUM178_AC4_next_and_previous_move_one_day_in_day_view", async () => {
    const { user } = await renderCalendar();
    await user.click(screen.getByRole("button", { name: "Day" }));

    await user.click(screen.getByRole("button", { name: "Next day" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(dayTitle(local(2026, 9, 8))),
    );
    expect(requestedWindow()).toMatchObject({ from: local(2026, 9, 8), to: local(2026, 9, 9) });

    await user.click(screen.getByRole("button", { name: "Previous day" }));
    await user.click(screen.getByRole("button", { name: "Previous day" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(dayTitle(local(2026, 9, 6))),
    );
    expect(requestedWindow()).toMatchObject({ from: local(2026, 9, 6), to: local(2026, 9, 7) });
  });

  it("SCRUM178_AC4_next_and_previous_move_one_month_across_a_year_boundary", async () => {
    const { user } = await renderCalendar({ initialDate: local(2026, 11, 31, 9) });
    await user.click(screen.getByRole("button", { name: "Month" }));
    expect(await screen.findByRole("table", { name: "December 2026" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next month" }));
    expect(await screen.findByRole("table", { name: "January 2027" })).toBeInTheDocument();
    // January 2027 starts on a Friday and ends on a Sunday.
    expect(requestedWindow()).toMatchObject({ from: local(2026, 11, 28), to: local(2027, 1, 1) });

    await user.click(screen.getByRole("button", { name: "Previous month" }));
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    expect(await screen.findByRole("table", { name: "November 2026" })).toBeInTheDocument();
  });

  it("SCRUM178_AC4_next_month_from_31_january_lands_on_february", async () => {
    const { user } = await renderCalendar({ initialDate: local(2027, 0, 31, 9) });
    await user.click(screen.getByRole("button", { name: "Month" }));
    await screen.findByRole("table", { name: "January 2027" });

    await user.click(screen.getByRole("button", { name: "Next month" }));
    expect(await screen.findByRole("table", { name: "February 2027" })).toBeInTheDocument();
    // February 2027 is exactly four weeks, Monday 1st to Sunday 28th.
    expect(requestedWindow()).toMatchObject({ from: local(2027, 1, 1), to: local(2027, 2, 1) });
  });

  it("SCRUM178_AC4_today_moves_back_to_the_current_week_and_refetches", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(local(2026, 9, 21, 15));

    const { user } = await renderCalendar();
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await screen.findByRole("table", { name: "12 – 18 Oct 2026" });
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await screen.findByRole("table", { name: "26 Oct – 1 Nov 2026" });

    await user.click(screen.getByRole("button", { name: "Go to today" }));

    expect(await screen.findByRole("table", { name: "19 – 25 Oct 2026" })).toBeInTheDocument();
    expect(requestedWindow()).toMatchObject({ from: local(2026, 9, 19), to: local(2026, 9, 26) });
  });

  it("SCRUM178_AC4_today_in_day_view_goes_to_today", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(local(2026, 9, 21, 15));

    const { user } = await renderCalendar();
    await user.click(screen.getByRole("button", { name: "Day" }));
    await user.click(screen.getByRole("button", { name: "Go to today" }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(dayTitle(local(2026, 9, 21))),
    );
    expect(requestedWindow()).toMatchObject({ from: local(2026, 9, 21), to: local(2026, 9, 22) });
  });

  it("SCRUM178_AC4_opens_on_today_by_default_and_today_on_today_does_not_refetch", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(local(2026, 9, 7, 15));

    const user = userEvent.setup();
    render(<VenueCalendar venueId={VENUE_ID} />);
    expect(await screen.findByRole("table", { name: "5 – 11 Oct 2026" })).toBeInTheDocument();
    expect(getVenueCalendar).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Go to today" }));
    // Give any effect a chance to run before asserting nothing happened.
    await act(async () => {});

    expect(getVenueCalendar).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: "5 – 11 Oct 2026" })).toBeInTheDocument();
  });

  it("SCRUM178_AC4_marks_today_in_the_week_view_and_only_today", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(local(2026, 9, 8, 15));

    await renderCalendar();
    const cells = weekCells();

    // Thursday 8 October is the fourth column.
    expect(cells[3]).toHaveClass("venue-calendar__cell", "venue-calendar__cell--today");
    expect(cells[3]).toHaveAttribute("aria-current", "date");
    for (const index of [0, 1, 2, 4, 5, 6]) {
      expect(cells[index]).not.toHaveClass("venue-calendar__cell--today");
      expect(cells[index]).not.toHaveAttribute("aria-current");
    }
  });

  it("SCRUM178_AC4_marks_today_in_the_month_view", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(local(2026, 9, 20, 15));

    const { user } = await renderCalendar();
    await user.click(screen.getByRole("button", { name: "Month" }));
    await screen.findByRole("table", { name: "October 2026" });

    const todayCell = screen.getByRole("button", { name: dayButtonName(local(2026, 9, 20)) }).closest("td");
    expect(todayCell).toHaveClass("venue-calendar__cell--today");
    expect(todayCell).toHaveAttribute("aria-current", "date");
    expect(todayCell).not.toHaveClass("venue-calendar__cell--muted");

    const otherCell = screen.getByRole("button", { name: dayButtonName(local(2026, 9, 7)) }).closest("td");
    expect(otherCell).not.toHaveClass("venue-calendar__cell--today");
    expect(otherCell).not.toHaveAttribute("aria-current");
  });

  it("SCRUM178_AC4_marks_no_cell_when_today_is_outside_the_view", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(local(2027, 2, 1, 15));

    await renderCalendar();
    for (const cell of weekCells()) {
      expect(cell).not.toHaveClass("venue-calendar__cell--today");
    }
  });

  it("SCRUM178_AC4_clicking_a_day_in_the_month_opens_that_day", async () => {
    const { user } = await renderCalendar();
    await user.click(screen.getByRole("button", { name: "Month" }));
    await screen.findByRole("table", { name: "October 2026" });

    await user.click(screen.getByRole("button", { name: dayButtonName(local(2026, 9, 14)) }));

    expect(screen.getByRole("button", { name: "Day" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(dayTitle(local(2026, 9, 14)));
    await waitFor(() =>
      expect(requestedWindow()).toMatchObject({ from: local(2026, 9, 14), to: local(2026, 9, 15) }),
    );
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("SCRUM178_AC4_clicking_a_muted_day_opens_that_day_in_the_other_month", async () => {
    const { user } = await renderCalendar();
    await user.click(screen.getByRole("button", { name: "Month" }));
    await screen.findByRole("table", { name: "October 2026" });

    await user.click(screen.getByRole("button", { name: dayButtonName(local(2026, 8, 29)) }));

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(dayTitle(local(2026, 8, 29)));
    await waitFor(() => expect(requestedWindow().from).toEqual(local(2026, 8, 29)));
  });

  it("SCRUM178_AC4_shows_a_loading_status_while_the_calendar_is_pending", async () => {
    const pending = deferred();
    vi.mocked(getVenueCalendar).mockReturnValue(pending.promise);

    render(<VenueCalendar venueId={VENUE_ID} initialDate={WED_7_OCT} />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading...");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing booked or blocked in this period.")).not.toBeInTheDocument();

    await act(async () => pending.resolve([]));

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: "5 – 11 Oct 2026" })).toBeInTheDocument();
  });

  it("SCRUM178_AC4_an_overnight_entry_shows_on_both_days_in_the_month_view", async () => {
    // Tuesday 22:00 to Wednesday 02:00.
    const overnight = { ...APPROVED, id: "b-night", startsAt: oct(6, 22), endsAt: oct(7, 2), eventName: "Night Shoot" };
    serveByWindow([overnight]);
    const { user } = await renderCalendar();
    await showView(user, "month");

    expect(within(cellOfDay(local(2026, 9, 6))).getAllByRole("listitem")).toHaveLength(1);
    expect(within(cellOfDay(local(2026, 9, 7))).getAllByRole("listitem")).toHaveLength(1);
    expect(within(cellOfDay(local(2026, 9, 5))).queryByRole("list")).not.toBeInTheDocument();
    expect(within(cellOfDay(local(2026, 9, 8))).queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getAllByText("Night Shoot")).toHaveLength(2);
  });

  it("SCRUM178_AC4_an_entry_starting_before_the_window_shows_on_the_first_day", async () => {
    // Sunday 4 October 20:00 to Monday 5 October 03:00: it starts in the
    // previous week, but overlaps this one, so the endpoint returns it.
    const acrossWeeks = { ...BLOCK, id: "k-sun", startsAt: oct(4, 20), endsAt: oct(5, 3) };
    serveByWindow([acrossWeeks]);
    await renderCalendar();

    expect(getVenueCalendar).toHaveBeenCalledTimes(1);
    const counts = weekCells().map((cell) => within(cell).queryAllByRole("listitem").length);
    expect(counts).toEqual([1, 0, 0, 0, 0, 0, 0]);
    expect(within(weekCells()[0]).getByRole("listitem")).toHaveClass("venue-calendar__entry--blocked");
  });

  it("SCRUM178_AC4_today_in_the_month_view_comes_back_from_several_months_away", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(local(2026, 9, 21, 15));

    const { user } = await renderCalendar();
    await showView(user, "month");
    for (let i = 0; i < 4; i += 1) {
      await user.click(screen.getByRole("button", { name: "Next month" }));
    }
    expect(await screen.findByRole("table", { name: "February 2027" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Go to today" }));

    expect(await screen.findByRole("table", { name: "October 2026" })).toBeInTheDocument();
    expect(requestedWindow()).toMatchObject({ from: local(2026, 8, 28), to: local(2026, 10, 2) });
    expect(screen.getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "true");
    expect(cellOfDay(local(2026, 9, 21))).toHaveClass("venue-calendar__cell--today");
  });

  it("SCRUM178_AC4_switching_week_to_month_while_the_week_is_pending_never_shows_the_week_answer", async () => {
    const week = deferred();
    const month = deferred();
    vi.mocked(getVenueCalendar).mockReturnValueOnce(week.promise).mockReturnValueOnce(month.promise);

    const user = userEvent.setup();
    render(<VenueCalendar venueId={VENUE_ID} initialDate={WED_7_OCT} />);
    await user.click(screen.getByRole("button", { name: "Month" }));
    expect(getVenueCalendar).toHaveBeenCalledTimes(2);
    expect(requestedWindow()).toMatchObject({ from: local(2026, 8, 28), to: local(2026, 10, 2) });

    // The week answers first, while the month is still on its way.
    const staleEntry = { ...APPROVED, id: "b-stale", startsAt: oct(8, 9), endsAt: oct(8, 10), eventName: "Stale Event" };
    await act(async () => week.resolve([staleEntry]));
    expect(screen.getByRole("status")).toHaveTextContent("Loading...");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("Stale Event")).not.toBeInTheDocument();

    const monthEntry = { ...APPROVED, id: "b-month", startsAt: oct(20, 9), endsAt: oct(20, 11), eventName: "Month Event" };
    await act(async () => month.resolve([monthEntry]));
    expect(screen.getByRole("table", { name: "October 2026" })).toBeInTheDocument();
    expect(screen.getByText("Month Event")).toBeInTheDocument();
    expect(screen.queryByText("Stale Event")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("SCRUM178_AC4_today_pressed_while_requests_are_pending_shows_only_todays_answer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(local(2026, 9, 21, 15));

    const opening = deferred();
    const nextWeek = deferred();
    const today = deferred();
    vi.mocked(getVenueCalendar)
      .mockReturnValueOnce(opening.promise)
      .mockReturnValueOnce(nextWeek.promise)
      .mockReturnValueOnce(today.promise);

    const user = userEvent.setup();
    render(<VenueCalendar venueId={VENUE_ID} initialDate={WED_7_OCT} />);
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await user.click(screen.getByRole("button", { name: "Go to today" }));
    expect(getVenueCalendar).toHaveBeenCalledTimes(3);
    expect(requestedWindow()).toMatchObject({ from: local(2026, 9, 19), to: local(2026, 9, 26) });

    // Both earlier windows answer late, with entries that would land on
    // today's week if the guard let them through.
    const staleA = { ...APPROVED, id: "b-a", startsAt: oct(20, 9), endsAt: oct(20, 10), eventName: "Stale A" };
    const staleB = { ...APPROVED, id: "b-b", startsAt: oct(22, 9), endsAt: oct(22, 10), eventName: "Stale B" };
    await act(async () => {
      nextWeek.resolve([staleB]);
      opening.resolve([staleA]);
    });
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByText("Stale A")).not.toBeInTheDocument();
    expect(screen.queryByText("Stale B")).not.toBeInTheDocument();

    const current = { ...APPROVED, id: "b-now", startsAt: oct(21, 9), endsAt: oct(21, 10), eventName: "Today Event" };
    await act(async () => today.resolve([current]));
    expect(screen.getByRole("table", { name: "19 – 25 Oct 2026" })).toBeInTheDocument();
    expect(screen.getByText("Today Event")).toBeInTheDocument();
    expect(screen.queryByText("Stale A")).not.toBeInTheDocument();
    expect(screen.queryByText("Stale B")).not.toBeInTheDocument();
  });

  it("SCRUM178_AC4_previous_and_next_are_named_after_the_current_view", async () => {
    const { user } = await renderCalendar();
    const nav = screen.getByRole("group", { name: "Move through the calendar" });

    const expectNames = (unit) => {
      expect(within(nav).getByRole("button", { name: `Previous ${unit}` })).toHaveTextContent(/^Previous$/);
      expect(within(nav).getByRole("button", { name: `Next ${unit}` })).toHaveTextContent(/^Next$/);
      for (const other of ["day", "week", "month"].filter((u) => u !== unit)) {
        expect(within(nav).queryByRole("button", { name: `Previous ${other}` })).not.toBeInTheDocument();
        expect(within(nav).queryByRole("button", { name: `Next ${other}` })).not.toBeInTheDocument();
      }
    };

    expectNames("week");
    await user.click(screen.getByRole("button", { name: "Day" }));
    expectNames("day");
    await user.click(screen.getByRole("button", { name: "Month" }));
    expectNames("month");
    await user.click(screen.getByRole("button", { name: "Week" }));
    expectNames("week");
  });
});

describe("SCRUM178_AC2 VenueCalendar entry labels", () => {
  it("SCRUM178_AC2_week_view_labels_each_tone_on_its_own_day", async () => {
    vi.mocked(getVenueCalendar).mockResolvedValue([APPROVED, FLAGGED, BLOCK]);
    await renderCalendar();

    const cells = weekCells();

    // Tuesday 6 October.
    const booked = within(cells[1]).getByRole("listitem");
    expect(booked).toHaveClass("venue-calendar__entry", "venue-calendar__entry--booked");
    expect(booked.querySelector(".venue-calendar__entry-label")).toHaveTextContent(/^Booked$/);
    expect(booked.querySelector(".venue-calendar__entry-detail")).toHaveTextContent("Gala Dinner");
    expect(booked.querySelector(".venue-calendar__entry-time")).toHaveTextContent(expectedRange(APPROVED));
    expect(booked).toHaveAttribute("title", expectedRange(APPROVED));

    // Thursday 8 October.
    const review = within(cells[3]).getByRole("listitem");
    expect(review).toHaveClass("venue-calendar__entry--review");
    expect(review.querySelector(".venue-calendar__entry-label")).toHaveTextContent("Booked – under review");
    expect(review.querySelector(".venue-calendar__entry-detail")).toHaveTextContent("Product Launch");

    // Friday 9 October.
    const blocked = within(cells[4]).getByRole("listitem");
    expect(blocked).toHaveClass("venue-calendar__entry--blocked");
    expect(blocked.querySelector(".venue-calendar__entry-label")).toHaveTextContent("Blocked — Maintenance");
    expect(blocked.querySelector(".venue-calendar__entry-detail")).toBeNull();
    expect(blocked.querySelector(".venue-calendar__entry-time")).toHaveTextContent(expectedRange(BLOCK));

    // The block's staff notes never reach the page.
    expect(screen.queryByText(/Secret staff note/)).not.toBeInTheDocument();

    // Days with nothing on them hold no list at all.
    for (const index of [0, 2, 5, 6]) {
      expect(within(cells[index]).queryByRole("list")).not.toBeInTheDocument();
    }
    expect(screen.queryByText("Nothing booked or blocked in this period.")).not.toBeInTheDocument();
  });

  it("SCRUM178_AC2_a_block_without_a_reason_reads_plain_Blocked", async () => {
    vi.mocked(getVenueCalendar).mockResolvedValue([{ ...BLOCK, reason: null }]);
    await renderCalendar();

    const entry = within(weekCells()[4]).getByRole("listitem");
    expect(entry.querySelector(".venue-calendar__entry-label")).toHaveTextContent(/^Blocked$/);
  });

  it("SCRUM178_AC2_SCRUM17_AC2_block_label_is_scrum130_blockCalendarLabel", async () => {
    // SCRUM-183: the calendar's block wording is SCRUM-130's, not its own.
    // Every reason is checked, so a copy of the wording that only happens to
    // match "Maintenance" still fails here.
    const blocks = VENUE_BLOCK_REASONS.map(({ code }, index) => ({
      ...BLOCK,
      id: `k-${code}`,
      reason: code,
      startsAt: oct(5 + index, 8),
      endsAt: oct(5 + index, 9),
    }));
    vi.mocked(getVenueCalendar).mockResolvedValue(blocks);
    await renderCalendar();

    const cells = weekCells();
    blocks.forEach((entry, index) => {
      const item = within(cells[index]).getByRole("listitem");
      expect(item).toHaveClass("venue-calendar__entry--blocked");
      expect(item.querySelector(".venue-calendar__entry-label").textContent).toBe(blockCalendarLabel(entry));
    });
  });

  it("SCRUM178_AC2_a_booking_without_an_event_name_has_no_detail", async () => {
    vi.mocked(getVenueCalendar).mockResolvedValue([{ ...APPROVED, eventName: null }]);
    await renderCalendar();

    const entry = within(weekCells()[1]).getByRole("listitem");
    expect(entry.querySelector(".venue-calendar__entry-label")).toHaveTextContent(/^Booked$/);
    expect(entry.querySelector(".venue-calendar__entry-detail")).toBeNull();
  });

  it("SCRUM178_AC2_day_view_lists_entries_with_their_times", async () => {
    const second = { ...APPROVED, id: "b3", startsAt: oct(7, 18), endsAt: oct(7, 22), eventName: "Evening Talk" };
    const first = { ...FLAGGED, startsAt: oct(7, 9), endsAt: oct(7, 11) };
    vi.mocked(getVenueCalendar).mockResolvedValue([first, second]);

    const { user } = await renderCalendar();
    await user.click(screen.getByRole("button", { name: "Day" }));

    const items = await screen.findAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveClass("venue-calendar__entry--review");
    expect(items[0].querySelector(".venue-calendar__entry-time")).toHaveTextContent(expectedRange(first));
    expect(items[1]).toHaveClass("venue-calendar__entry--booked");
    expect(items[1].querySelector(".venue-calendar__entry-detail")).toHaveTextContent("Evening Talk");
    expect(screen.queryByText("Nothing booked or blocked in this period.")).not.toBeInTheDocument();
  });

  it("SCRUM178_AC2_month_view_entries_are_compact_with_the_range_in_the_title", async () => {
    vi.mocked(getVenueCalendar).mockResolvedValue([APPROVED, FLAGGED, BLOCK]);
    const { user } = await renderCalendar();
    await user.click(screen.getByRole("button", { name: "Month" }));
    await screen.findByRole("table", { name: "October 2026" });

    const cell = screen.getByRole("button", { name: dayButtonName(local(2026, 9, 6)) }).closest("td");
    const entry = within(cell).getByRole("listitem");
    expect(entry).toHaveClass("venue-calendar__entry--booked");
    expect(entry.querySelector(".venue-calendar__entry-time")).toBeNull();
    expect(entry.querySelector(".venue-calendar__entry-label")).toHaveTextContent(/^Booked$/);
    expect(entry.querySelector(".venue-calendar__entry-detail")).toHaveTextContent("Gala Dinner");
    expect(entry).toHaveAttribute("title", expectedRange(APPROVED));

    const blockCell = screen.getByRole("button", { name: dayButtonName(local(2026, 9, 9)) }).closest("td");
    expect(within(blockCell).getByRole("listitem")).toHaveClass("venue-calendar__entry--blocked");

    const emptyCell = screen.getByRole("button", { name: dayButtonName(local(2026, 9, 20)) }).closest("td");
    expect(within(emptyCell).queryByRole("list")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".venue-calendar__entry-time")).toHaveLength(0);
  });

  it("SCRUM178_AC2_a_multi_day_block_shows_on_each_day_it_covers", async () => {
    // Tuesday 18:00 to Friday 06:00: one entry per day, Tue to Fri.
    const longBlock = { ...BLOCK, id: "k2", startsAt: oct(6, 18), endsAt: oct(9, 6) };
    vi.mocked(getVenueCalendar).mockResolvedValue([longBlock]);
    await renderCalendar();

    const counts = weekCells().map((cell) => within(cell).queryAllByRole("listitem").length);
    expect(counts).toEqual([0, 1, 1, 1, 1, 0, 0]);
    expect(document.querySelectorAll("li.venue-calendar__entry--blocked")).toHaveLength(4);
  });

  it("SCRUM178_AC2_an_entry_ending_at_midnight_stays_on_its_own_day", async () => {
    const lateBooking = { ...APPROVED, startsAt: oct(6, 20), endsAt: oct(7) };
    vi.mocked(getVenueCalendar).mockResolvedValue([lateBooking]);
    await renderCalendar();

    const counts = weekCells().map((cell) => within(cell).queryAllByRole("listitem").length);
    expect(counts).toEqual([0, 1, 0, 0, 0, 0, 0]);
  });

  it("SCRUM178_AC2_a_booking_and_a_block_sharing_an_id_both_render", async () => {
    const block = { ...BLOCK, id: APPROVED.id, startsAt: oct(6, 18), endsAt: oct(6, 20) };
    vi.mocked(getVenueCalendar).mockResolvedValue([APPROVED, block]);
    await renderCalendar();

    expect(within(weekCells()[1]).getAllByRole("listitem")).toHaveLength(2);
  });
});

describe("SCRUM178_AC3 VenueCalendar pending requests are not shown as booked", () => {
  // A booked control on the same day, so each view is shown with something
  // in it and an empty view cannot pass the test by accident.
  const CONTROL = { ...APPROVED, id: "b-ok", startsAt: oct(7, 8), endsAt: oct(7, 9) };
  const PENDING = { ...APPROVED, id: "b-pending", status: "pending", startsAt: oct(7, 10), endsAt: oct(7, 12), eventName: "Pending Party" };
  const REJECTED = { ...APPROVED, id: "b-rejected", status: "rejected", startsAt: oct(7, 13), endsAt: oct(7, 15), eventName: "Rejected Rally" };

  it.each(["day", "week", "month"])(
    "SCRUM178_AC3_pending_and_rejected_bookings_are_not_shown_in_the_%s_view",
    async (view) => {
      serveByWindow([CONTROL, PENDING, REJECTED]);
      const { user } = await renderCalendar();
      await showView(user, view);

      // The endpoint's answer did carry all three.
      expect(await vi.mocked(getVenueCalendar).mock.results.at(-1).value).toHaveLength(3);

      const items = screen.getAllByRole("listitem");
      expect(items).toHaveLength(1);
      expect(items[0]).toHaveClass("venue-calendar__entry--booked");
      expect(items[0]).toHaveTextContent("Gala Dinner");
      expect(document.querySelectorAll(".venue-calendar__entry-label")).toHaveLength(1);
      expect(screen.queryByText("Pending Party")).not.toBeInTheDocument();
      expect(screen.queryByText("Rejected Rally")).not.toBeInTheDocument();
      expect(screen.queryByText("Booked – under review")).not.toBeInTheDocument();
    },
  );

  it("SCRUM178_AC3_a_day_of_only_pending_and_rejected_requests_shows_the_empty_state", async () => {
    serveByWindow([PENDING, REJECTED]);
    const { user } = await renderCalendar();
    await showView(user, "day");

    expect(screen.getByText("Nothing booked or blocked in this period.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByText(/Booked/)).not.toBeInTheDocument();
  });
});

describe("SCRUM178_AC5 VenueCalendar hidden entries", () => {
  it("SCRUM178_AC5_unknown_statuses_and_kinds_are_not_rendered", async () => {
    vi.mocked(getVenueCalendar).mockResolvedValue([
      APPROVED,
      { ...APPROVED, id: "p1", status: "pending", eventName: "Pending Party" },
      { ...APPROVED, id: "c1", status: "cancelled", eventName: "Cancelled Concert" },
      { ...BLOCK, id: "h1", kind: "reservation", reason: "other" },
    ]);
    await renderCalendar();

    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Gala Dinner")).toBeInTheDocument();
    expect(screen.queryByText("Pending Party")).not.toBeInTheDocument();
    expect(screen.queryByText("Cancelled Concert")).not.toBeInTheDocument();
    expect(screen.queryByText(/Other/)).not.toBeInTheDocument();
  });

  it("SCRUM178_AC5_a_period_of_only_hidden_entries_shows_the_empty_state", async () => {
    vi.mocked(getVenueCalendar).mockResolvedValue([
      { ...APPROVED, status: "pending" },
      { ...APPROVED, id: "x", kind: "reservation" },
    ]);
    const { user } = await renderCalendar();

    expect(screen.getByText("Nothing booked or blocked in this period.")).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);

    // The day view drops its list entirely rather than rendering an empty one.
    await user.click(screen.getByRole("button", { name: "Day" }));
    await waitFor(() => expect(getVenueCalendar).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Nothing booked or blocked in this period.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it.each(["day", "month"])(
    "SCRUM178_AC5_cancelled_and_unknown_kind_entries_are_hidden_in_the_%s_view",
    async (view) => {
      const control = { ...APPROVED, id: "b-ok", startsAt: oct(7, 8), endsAt: oct(7, 9) };
      serveByWindow([
        control,
        { ...APPROVED, id: "c1", status: "cancelled", startsAt: oct(7, 10), endsAt: oct(7, 11), eventName: "Cancelled Concert" },
        { ...APPROVED, id: "u1", kind: "reservation", startsAt: oct(7, 12), endsAt: oct(7, 13), eventName: "Mystery Kind" },
        { ...BLOCK, id: "h1", kind: "tentative", reason: "other", startsAt: oct(7, 14), endsAt: oct(7, 15) },
      ]);
      const { user } = await renderCalendar();
      await showView(user, view);

      expect(await vi.mocked(getVenueCalendar).mock.results.at(-1).value).toHaveLength(4);
      const items = screen.getAllByRole("listitem");
      expect(items).toHaveLength(1);
      expect(items[0]).toHaveTextContent("Gala Dinner");
      expect(screen.queryByText("Cancelled Concert")).not.toBeInTheDocument();
      expect(screen.queryByText("Mystery Kind")).not.toBeInTheDocument();
      expect(screen.queryByText(/Other/)).not.toBeInTheDocument();
      expect(document.querySelectorAll(".venue-calendar__entry--blocked")).toHaveLength(0);
    },
  );
});

describe("SCRUM178_AC1 VenueCalendar empty state", () => {
  it("SCRUM178_AC1_an_empty_week_says_so_and_still_shows_the_grid", async () => {
    await renderCalendar();

    expect(screen.getByText("Nothing booked or blocked in this period.")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "5 – 11 Oct 2026" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("SCRUM178_AC1 VenueCalendar errors", () => {
  it.each([
    [400, "That venue id was not recognised. Please go back and refresh."],
    [401, "Your session has expired. Please sign in again."],
    [404, "That venue does not exist. It may have been removed."],
    [500, "The calendar could not be loaded. Please try again."],
    [418, "Could not load this venue's calendar. Please try again."],
    [503, "Could not load this venue's calendar. Please try again."],
  ])("SCRUM178_AC1_a_%s_shows_its_message", async (status, message) => {
    vi.mocked(getVenueCalendar).mockRejectedValue(httpError(status));
    render(<VenueCalendar venueId={VENUE_ID} initialDate={WED_7_OCT} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing booked or blocked in this period.")).not.toBeInTheDocument();
    // The server's prose is never surfaced.
    expect(screen.queryByText(/database prose/)).not.toBeInTheDocument();
  });

  it("SCRUM178_AC1_a_network_error_without_a_response_shows_the_fallback", async () => {
    vi.mocked(getVenueCalendar).mockRejectedValue(new Error("Network Error"));
    render(<VenueCalendar venueId={VENUE_ID} initialDate={WED_7_OCT} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load this venue's calendar. Please try again.",
    );
  });

  it("SCRUM178_AC1_the_toolbar_still_works_after_an_error_and_a_success_clears_it", async () => {
    vi.mocked(getVenueCalendar).mockRejectedValueOnce(httpError(500)).mockResolvedValue([APPROVED]);
    const user = userEvent.setup();
    render(<VenueCalendar venueId={VENUE_ID} initialDate={WED_7_OCT} />);
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: "Next week" }));
    await screen.findByRole("table", { name: "12 – 18 Oct 2026" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Going back refetches the failed window, which now succeeds.
    await user.click(screen.getByRole("button", { name: "Previous week" }));
    await screen.findByRole("table", { name: "5 – 11 Oct 2026" });
    expect(screen.getByText("Gala Dinner")).toBeInTheDocument();
    expect(getVenueCalendar).toHaveBeenCalledTimes(3);
  });
});

describe("SCRUM178_AC6 VenueCalendar refused by the backend", () => {
  // Split out of the AC1 errors table above: a 403 is the backend refusing an
  // Organiser or Attendee, so it belongs to AC6. The assertions are the same.
  it("SCRUM178_AC6_a_403_shows_its_message", async () => {
    vi.mocked(getVenueCalendar).mockRejectedValue(httpError(403));
    render(<VenueCalendar venueId={VENUE_ID} initialDate={WED_7_OCT} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only Venue Staff and Event Coordinators can see a venue's calendar.",
    );
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing booked or blocked in this period.")).not.toBeInTheDocument();
    // The server's prose is never surfaced.
    expect(screen.queryByText(/database prose/)).not.toBeInTheDocument();
  });
});

describe("SCRUM178_AC1 VenueCalendar venue header", () => {
  it("SCRUM178_AC1_shows_the_venue_name_without_a_retired_badge", async () => {
    await renderCalendar();

    expect(await screen.findByRole("heading", { level: 1, name: "Hall A" })).toBeInTheDocument();
    expect(screen.queryByText("Retired")).not.toBeInTheDocument();
    expect(getVenueDetails).toHaveBeenCalledTimes(1);
    expect(getVenueDetails).toHaveBeenCalledWith(VENUE_ID);
  });

  it("SCRUM178_AC1_shows_a_retired_badge_for_a_retired_venue", async () => {
    vi.mocked(getVenueDetails).mockResolvedValue({ ...VENUE, retiredAt: "2026-09-01T00:00:00+08:00" });
    await renderCalendar();

    expect(await screen.findByRole("heading", { level: 1, name: "Hall A" })).toBeInTheDocument();
    expect(screen.getByText("Retired")).toHaveClass("ui-status-badge", "ui-status-badge--neutral");
  });

  it("SCRUM178_AC1_a_retired_venue_on_a_past_date_shows_its_past_bookings_and_blocks", async () => {
    // Retired in June 2025, opened on Wednesday 12 March 2025.
    vi.mocked(getVenueDetails).mockResolvedValue({ ...VENUE, retiredAt: local(2025, 5, 1).toISOString() });
    const pastBooking = {
      ...APPROVED,
      id: "b-past",
      startsAt: local(2025, 2, 11, 9).toISOString(),
      endsAt: local(2025, 2, 11, 17).toISOString(),
      eventName: "Spring Fair",
    };
    const pastBlock = {
      ...BLOCK,
      id: "k-past",
      startsAt: local(2025, 2, 13, 8).toISOString(),
      endsAt: local(2025, 2, 13, 18).toISOString(),
    };
    serveByWindow([pastBooking, pastBlock]);
    await renderCalendar({ initialDate: local(2025, 2, 12, 10) });

    expect(await screen.findByRole("heading", { level: 1, name: "Hall A" })).toBeInTheDocument();
    expect(screen.getByText("Retired")).toHaveClass("ui-status-badge", "ui-status-badge--neutral");
    expect(requestedWindow()).toMatchObject({ from: local(2025, 2, 10), to: local(2025, 2, 17) });

    const cells = weekCells("10 – 16 Mar 2025");
    const booked = within(cells[1]).getByRole("listitem");
    expect(booked.querySelector(".venue-calendar__entry-label")).toHaveTextContent(/^Booked$/);
    expect(booked.querySelector(".venue-calendar__entry-detail")).toHaveTextContent("Spring Fair");
    const blocked = within(cells[3]).getByRole("listitem");
    expect(blocked.querySelector(".venue-calendar__entry-label")).toHaveTextContent("Blocked — Maintenance");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM178_AC1_a_header_failure_falls_back_and_the_calendar_still_loads", async () => {
    vi.mocked(getVenueDetails).mockRejectedValue(httpError(500));
    vi.mocked(getVenueCalendar).mockResolvedValue([APPROVED]);
    await renderCalendar();

    expect(screen.getByRole("heading", { level: 1, name: "Venue calendar" })).toBeInTheDocument();
    expect(screen.getByText("Gala Dinner")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Retired")).not.toBeInTheDocument();
  });

  it("SCRUM178_AC1_the_header_is_fetched_once_while_the_view_moves", async () => {
    const { user } = await renderCalendar();
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await user.click(screen.getByRole("button", { name: "Month" }));
    await screen.findByRole("table", { name: "October 2026" });

    expect(getVenueDetails).toHaveBeenCalledTimes(1);
  });
});

describe("SCRUM178_AC1 VenueCalendar stale responses and unmounting", () => {
  it("SCRUM178_AC1_a_late_answer_for_a_window_already_left_is_ignored", async () => {
    const weekA = deferred();
    const weekB = deferred();
    vi.mocked(getVenueCalendar).mockReturnValueOnce(weekA.promise).mockReturnValueOnce(weekB.promise);

    const user = userEvent.setup();
    render(<VenueCalendar venueId={VENUE_ID} initialDate={WED_7_OCT} />);
    expect(screen.getByRole("status")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next week" }));
    expect(getVenueCalendar).toHaveBeenCalledTimes(2);

    const weekBEntry = { ...APPROVED, id: "b-next", startsAt: oct(13, 9), endsAt: oct(13, 11), eventName: "Week B Event" };
    await act(async () => weekB.resolve([weekBEntry]));
    expect(screen.getByRole("table", { name: "12 – 18 Oct 2026" })).toBeInTheDocument();
    expect(screen.getByText("Week B Event")).toBeInTheDocument();

    // Week A answers late, with an entry that would land on week B's Tuesday
    // if the guard let it through.
    const staleEntry = { ...APPROVED, id: "b-stale", startsAt: oct(13, 14), endsAt: oct(13, 16), eventName: "Stale Event" };
    await act(async () => weekA.resolve([staleEntry]));

    expect(screen.queryByText("Stale Event")).not.toBeInTheDocument();
    expect(screen.getByText("Week B Event")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "12 – 18 Oct 2026" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("SCRUM178_AC1_a_late_error_for_a_window_already_left_is_ignored", async () => {
    const weekA = deferred();
    vi.mocked(getVenueCalendar).mockReturnValueOnce(weekA.promise).mockResolvedValue([]);

    const user = userEvent.setup();
    render(<VenueCalendar venueId={VENUE_ID} initialDate={WED_7_OCT} />);
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await screen.findByRole("table", { name: "12 – 18 Oct 2026" });

    await act(async () => weekA.reject(httpError(403)));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: "12 – 18 Oct 2026" })).toBeInTheDocument();
  });

  it("SCRUM178_AC1_answers_arriving_after_unmount_are_dropped", async () => {
    const header = deferred();
    const calendar = deferred();
    vi.mocked(getVenueDetails).mockReturnValue(header.promise);
    vi.mocked(getVenueCalendar).mockReturnValue(calendar.promise);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = render(<VenueCalendar venueId={VENUE_ID} initialDate={WED_7_OCT} />);
    unmount();

    await act(async () => {
      header.resolve(VENUE);
      calendar.resolve([APPROVED]);
    });

    expect(consoleError).not.toHaveBeenCalled();
    expect(screen.queryByText("Hall A")).not.toBeInTheDocument();
    consoleError.mockRestore();
  });

  it("SCRUM178_AC1_a_header_failure_after_unmount_is_dropped", async () => {
    const header = deferred();
    vi.mocked(getVenueDetails).mockReturnValue(header.promise);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = render(<VenueCalendar venueId={VENUE_ID} initialDate={WED_7_OCT} />);
    unmount();
    await act(async () => header.reject(httpError(404)));

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("SCRUM484_AC7 VenueCalendar shows setup and turnaround on bookings", () => {
  // Tuesday 6 October, 10:00-12:00, at a venue with 30 minutes of setup and
  // 45 of turnaround: the venue is held 09:30-12:45.
  const PADDED = {
    ...APPROVED,
    id: "b-padded",
    eventName: "Orientation",
    startsAt: oct(6, 10),
    endsAt: oct(6, 12),
    occupiedStartsAt: oct(6, 9, 30),
    occupiedEndsAt: oct(6, 12, 45),
    setupMinutes: 30,
    turnaroundMinutes: 45,
  };

  const ZERO_PADDING = {
    ...APPROVED,
    id: "b-zero",
    eventName: "Board Meeting",
    startsAt: oct(8, 14),
    endsAt: oct(8, 16),
    occupiedStartsAt: oct(8, 14),
    occupiedEndsAt: oct(8, 16),
    setupMinutes: 0,
    turnaroundMinutes: 0,
  };

  function threeParts(entry) {
    return (
      `Setup ${formatDateTimeRange(entry.occupiedStartsAt, entry.startsAt)} · ` +
      `Event ${formatDateTimeRange(entry.startsAt, entry.endsAt)} · ` +
      `Turnaround ${formatDateTimeRange(entry.endsAt, entry.occupiedEndsAt)}`
    );
  }

  it("SCRUM484_AC7_calendar_week_entry_shows_three_parts", async () => {
    vi.mocked(getVenueCalendar).mockResolvedValue([PADDED]);
    await renderCalendar();

    const item = within(weekCells()[1]).getByRole("listitem");
    const time = item.querySelector(".venue-calendar__entry-time");
    expect(time.textContent).toBe(threeParts(PADDED));
    expect(time).toHaveTextContent(`Setup ${formatDateTimeRange(PADDED.occupiedStartsAt, PADDED.startsAt)}`);
    expect(time).toHaveTextContent(`Event ${formatDateTimeRange(PADDED.startsAt, PADDED.endsAt)}`);
    expect(time).toHaveTextContent(`Turnaround ${formatDateTimeRange(PADDED.endsAt, PADDED.occupiedEndsAt)}`);
    expect(item).toHaveAttribute("title", threeParts(PADDED));
    expect(item.querySelector(".venue-calendar__entry-detail")).toHaveTextContent("Orientation");
  });

  it("SCRUM484_AC7_calendar_month_title_shows_the_parts", async () => {
    vi.mocked(getVenueCalendar).mockResolvedValue([PADDED]);
    const { user } = await renderCalendar();
    await showView(user, "month");

    const item = within(cellOfDay(local(2026, 9, 6))).getByRole("listitem");
    expect(item.querySelector(".venue-calendar__entry-time")).toBeNull();
    expect(item).toHaveAttribute("title", threeParts(PADDED));
    expect(item).not.toHaveTextContent(/Setup|Turnaround/);
  });

  it("SCRUM484_AC7_calendar_zero_minutes_and_blocks_show_no_parts", async () => {
    vi.mocked(getVenueCalendar).mockResolvedValue([ZERO_PADDING, BLOCK]);
    await renderCalendar();
    const cells = weekCells();

    const booked = within(cells[3]).getByRole("listitem");
    const bookedTime = booked.querySelector(".venue-calendar__entry-time");
    expect(bookedTime.textContent).toBe(formatDateTimeRange(ZERO_PADDING.startsAt, ZERO_PADDING.endsAt));
    expect(booked).toHaveAttribute("title", formatDateTimeRange(ZERO_PADDING.startsAt, ZERO_PADDING.endsAt));

    const blocked = within(cells[4]).getByRole("listitem");
    const blockedTime = blocked.querySelector(".venue-calendar__entry-time");
    expect(blockedTime.textContent).toBe(expectedRange(BLOCK));
    expect(blocked).toHaveAttribute("title", expectedRange(BLOCK));

    for (const item of [booked, blocked]) {
      expect(item.getAttribute("title")).not.toMatch(/Setup|Event |Turnaround/);
      expect(item).not.toHaveTextContent(/Setup|Turnaround/);
    }
  });

  it("SCRUM484_AC7_a_turnaround_past_midnight_shows_the_booking_on_the_next_day", async () => {
    // Tuesday 22:00-23:30 with 45 minutes of turnaround to Wednesday 00:15.
    const late = {
      ...PADDED,
      id: "b-late",
      eventName: "Late Show",
      startsAt: oct(6, 22),
      endsAt: oct(6, 23, 30),
      occupiedStartsAt: oct(6, 21, 30),
      occupiedEndsAt: oct(7, 0, 15),
    };
    vi.mocked(getVenueCalendar).mockResolvedValue([late]);
    await renderCalendar();

    const counts = weekCells().map((cell) => within(cell).queryAllByRole("listitem").length);
    expect(counts).toEqual([0, 1, 1, 0, 0, 0, 0]);

    const wednesday = within(weekCells()[2]).getByRole("listitem");
    expect(wednesday.querySelector(".venue-calendar__entry-detail")).toHaveTextContent("Late Show");
    expect(wednesday.querySelector(".venue-calendar__entry-time").textContent).toBe(threeParts(late));
  });

  it("SCRUM484_AC7_an_older_payload_without_occupied_fields_shows_the_event_range", async () => {
    vi.mocked(getVenueCalendar).mockResolvedValue([APPROVED]);
    await renderCalendar();

    const item = within(weekCells()[1]).getByRole("listitem");
    expect(item.querySelector(".venue-calendar__entry-time").textContent).toBe(expectedRange(APPROVED));
    expect(document.body).not.toHaveTextContent(/Invalid Date/);
  });
});

describe("SCRUM491_AC6 VenueCalendar shows active tentative holds", () => {
  // Thursday 8 October, 10:00-12:00, held with 30 minutes of setup and 45 of
  // turnaround around it.
  const HOLD = {
    kind: "hold",
    id: "h-launch",
    eventRequestId: "e-launch",
    eventName: "Product Launch",
    startsAt: oct(8, 10),
    endsAt: oct(8, 12),
    occupiedStartsAt: oct(8, 9, 30),
    occupiedEndsAt: oct(8, 12, 45),
    setupMinutes: 30,
    turnaroundMinutes: 45,
  };

  it("SCRUM491_AC6_a_hold_reads_Tentatively_held_naming_the_holding_event", async () => {
    serveByWindow([HOLD]);
    await renderCalendar();

    const entry = document.querySelector(".venue-calendar__entry--held");
    expect(entry).not.toBeNull();
    expect(within(entry).getByText("Tentatively held")).toBeInTheDocument();
    expect(within(entry).getByText("Product Launch")).toBeInTheDocument();
    expect(screen.queryByText("Booked")).not.toBeInTheDocument();
  });

  it("SCRUM491_AC6_a_hold_shows_its_whole_occupied_period", async () => {
    serveByWindow([HOLD]);
    await renderCalendar();

    const entry = document.querySelector(".venue-calendar__entry--held");
    const time = entry.querySelector(".venue-calendar__entry-time");
    expect(time).toHaveTextContent(`Setup ${formatDateTimeRange(HOLD.occupiedStartsAt, HOLD.startsAt)}`);
    expect(time).toHaveTextContent(`Turnaround ${formatDateTimeRange(HOLD.endsAt, HOLD.occupiedEndsAt)}`);
  });

  it("SCRUM491_AC6_a_hold_sits_beside_a_booking_and_a_block", async () => {
    serveByWindow([APPROVED, HOLD, BLOCK]);
    await renderCalendar();

    expect(document.querySelectorAll(".venue-calendar__entry--booked")).toHaveLength(1);
    expect(document.querySelectorAll(".venue-calendar__entry--held")).toHaveLength(1);
    expect(document.querySelectorAll(".venue-calendar__entry--blocked")).toHaveLength(1);
  });
});
