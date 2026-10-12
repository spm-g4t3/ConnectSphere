// EventVenueSuitability.test.jsx
//
// SCRUM-192 (SCRUM-188 AC6, Week 7). The event view's "Venue suitability"
// section: loading, then every requested or booked venue with its live
// verdict; the alert that names what newly fails; the request-time override
// note; a retired venue; the empty state; a failed call with "Try again"; and
// "Recheck". venueSuitabilityService is mocked, so nothing touches the
// network. VenueSuitabilityResult is the real one (its own suite covers it).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import EventVenueSuitability from "../../src/components/EventVenueSuitability.jsx";
import { getEventVenueSuitability } from "../../src/services/venueSuitabilityService";

vi.mock("../../src/services/venueSuitabilityService", () => ({
  checkVenueSuitability: vi.fn(),
  getEventVenueSuitability: vi.fn(),
}));

const CHECKED = {
  startsAt: "2026-11-11T10:00:00+08:00",
  endsAt: "2026-11-11T12:00:00+08:00",
  expectedAttendance: 150,
  layout: "theatre",
  accessibility: [],
  facilities: [],
};

const ALL_MET = [
  { criterion: "Capacity", met: true, detail: "Capacity 200 >= expected attendance 150" },
  { criterion: "Operating hours", met: true, detail: "Open" },
  { criterion: "Layout", met: true, detail: "Offered" },
  { criterion: "Accessibility", met: true, detail: "None requested" },
  { criterion: "Facilities", met: true, detail: "None requested" },
  { criterion: "Availability", met: true, detail: "Free" },
];

function withUnmet(names) {
  return ALL_MET.map((c) =>
    names.includes(c.criterion) ? { ...c, met: false, detail: `${c.criterion} not met` } : c,
  );
}

function item(overrides = {}) {
  return {
    bookingId: "b1",
    venueId: "v1",
    venueName: "Hall A",
    venueLocation: "Level 2",
    status: "pending",
    statusDisplay: { status: "pending", label: "Pending", group: "OPEN", description: "" },
    // SCRUM-525 (AC5): top-level, so they survive a failed recheck.
    roomLayoutCode: "theatre",
    expectedAttendance: 150,
    attendanceSource: "booking",
    suitabilityOverridden: false,
    current: { suitable: true, criteria: ALL_MET, checked: CHECKED },
    atRequest: { suitable: true, unmet: [] },
    newlyUnmet: [],
    ...overrides,
  };
}

const httpError = (status, data = {}) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderSection(eventRequestId = "e1") {
  const user = userEvent.setup();
  const utils = render(<EventVenueSuitability eventRequestId={eventRequestId} />);
  return { user, ...utils };
}

const venueItem = (name) => screen.getByRole("heading", { name }).closest("li");

beforeEach(() => {
  vi.mocked(getEventVenueSuitability).mockReset();
});

describe("SCRUM-192 loading and listing (SCRUM188_AC6)", () => {
  it("SCRUM188_AC6_shows_loading_then_the_list_for_this_event", async () => {
    const pending = deferred();
    vi.mocked(getEventVenueSuitability).mockReturnValue(pending.promise);
    renderSection("e1");

    expect(screen.getByRole("status")).toHaveTextContent("Rechecking this event's venues...");
    expect(getEventVenueSuitability).toHaveBeenCalledWith("e1");

    pending.resolve([item(), item({ bookingId: "b2", venueId: "v2", venueName: "Room B" })]);

    const list = await screen.findByRole("list", { name: "Requested venues" });
    expect(within(list).getByRole("heading", { name: "Hall A" })).toBeInTheDocument();
    expect(within(list).getByRole("heading", { name: "Room B" })).toBeInTheDocument();
    expect(screen.queryByText("Rechecking this event's venues...")).not.toBeInTheDocument();
  });

  it("SCRUM188_AC6_a_suitable_venue_shows_suitable_its_status_and_no_alert", async () => {
    vi.mocked(getEventVenueSuitability).mockResolvedValue([item()]);
    renderSection();

    await screen.findByRole("heading", { name: "Hall A" });
    const li = venueItem("Hall A");
    expect(within(li).getByText("Booking: Pending")).toBeInTheDocument();
    expect(within(li).getByText("Level 2")).toBeInTheDocument();
    expect(within(li).getAllByText("Suitable").length).toBeGreaterThan(0);
    expect(within(li).queryByRole("alert")).not.toBeInTheDocument();
    // The full result is there but folded away, as nothing needs attention.
    expect(li.querySelector("details")).not.toHaveAttribute("open");
  });

  it("SCRUM188_AC6_an_unsuitable_venue_alerts_with_the_newly_unmet_criteria_and_opens", async () => {
    vi.mocked(getEventVenueSuitability).mockResolvedValue([
      item({
        current: { suitable: false, criteria: withUnmet(["Capacity", "Availability"]), checked: CHECKED },
        newlyUnmet: ["Capacity", "Availability"],
      }),
    ]);
    renderSection();

    await screen.findByRole("heading", { name: "Hall A" });
    const li = venueItem("Hall A");
    expect(within(li).getAllByText("Not suitable").length).toBeGreaterThan(0);
    expect(within(li).getByRole("alert")).toHaveTextContent(
      "This venue no longer meets the event's requirements: Capacity, Availability",
    );
    expect(li.querySelector("details")).toHaveAttribute("open");
    expect(within(li).getByText("Capacity not met")).toBeInTheDocument();
  });

  it("SCRUM188_AC6_an_override_shows_what_was_accepted_at_request_time", async () => {
    vi.mocked(getEventVenueSuitability).mockResolvedValue([
      item({
        suitabilityOverridden: true,
        current: { suitable: false, criteria: withUnmet(["Layout", "Capacity"]), checked: CHECKED },
        atRequest: { suitable: false, unmet: ["Layout"] },
        newlyUnmet: ["Capacity"],
      }),
    ]);
    renderSection();

    await screen.findByRole("heading", { name: "Hall A" });
    const li = venueItem("Hall A");
    expect(within(li).getByText("Requested although it did not meet: Layout")).toBeInTheDocument();
    // Only what newly fails raises the alarm.
    expect(within(li).getByRole("alert")).toHaveTextContent(
      "This venue no longer meets the event's requirements: Capacity",
    );
    expect(within(li).getByRole("alert")).not.toHaveTextContent("Layout");
  });

  it("SCRUM188_AC6_a_failure_already_accepted_at_request_time_raises_no_alert", async () => {
    vi.mocked(getEventVenueSuitability).mockResolvedValue([
      item({
        suitabilityOverridden: true,
        current: { suitable: false, criteria: withUnmet(["Layout"]), checked: CHECKED },
        atRequest: { suitable: false, unmet: ["Layout"] },
        newlyUnmet: [],
      }),
    ]);
    renderSection();

    await screen.findByRole("heading", { name: "Hall A" });
    const li = venueItem("Hall A");
    expect(within(li).getAllByText("Not suitable").length).toBeGreaterThan(0);
    expect(within(li).getByText("Requested although it did not meet: Layout")).toBeInTheDocument();
    expect(within(li).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM188_AC6_a_retired_venue_says_so_while_the_others_still_show", async () => {
    vi.mocked(getEventVenueSuitability).mockResolvedValue([
      item({
        current: null,
        error: { code: "VENUE_RETIRED", message: "Venue 1234 is retired, so it cannot host an event" },
        newlyUnmet: [],
      }),
      item({ bookingId: "b2", venueId: "v2", venueName: "Room B" }),
    ]);
    renderSection();

    await screen.findByRole("heading", { name: "Hall A" });
    const retired = venueItem("Hall A");
    expect(within(retired).getByRole("alert")).toHaveTextContent("This venue has been retired.");
    // The server's prose carries a raw id, so it is never shown.
    expect(screen.queryByText(/Venue 1234/)).not.toBeInTheDocument();
    expect(retired.querySelector("details")).toBeNull();

    const other = venueItem("Room B");
    expect(within(other).getAllByText("Suitable").length).toBeGreaterThan(0);
  });

  it("SCRUM188_AC6_an_event_with_no_venue_says_so_quietly", async () => {
    vi.mocked(getEventVenueSuitability).mockResolvedValue([]);
    renderSection();

    expect(await screen.findByText("No venue has been requested for this event yet.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Requested venues" })).not.toBeInTheDocument();
  });
});

describe("SCRUM-192 failures and rechecking (SCRUM188_AC6)", () => {
  it("SCRUM188_AC6_a_failed_call_shows_the_message_then_try_again_loads_it", async () => {
    vi.mocked(getEventVenueSuitability)
      .mockRejectedValueOnce(httpError(409, { code: "EVENT_DATES_MISSING", error: "raw prose" }))
      .mockResolvedValueOnce([item()]);
    const { user } = renderSection();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This event has no proposed start and end, so no venue can be checked against it yet.",
    );
    expect(screen.queryByText("raw prose")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "Hall A" })).toBeInTheDocument();
    expect(getEventVenueSuitability).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("SCRUM188_AC6_a_403_says_only_the_assigned_coordinator_can_check", async () => {
    vi.mocked(getEventVenueSuitability).mockRejectedValue(httpError(403));
    renderSection();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only the coordinator assigned to this event can check a venue for it.",
    );
  });

  it("SCRUM188_AC6_week7_recheck_calls_the_service_again_and_shows_the_new_answer", async () => {
    // A venue edited elsewhere (setup time raised) shows on "Recheck".
    vi.mocked(getEventVenueSuitability)
      .mockResolvedValueOnce([item()])
      .mockResolvedValueOnce([
        item({
          current: { suitable: false, criteria: withUnmet(["Availability"]), checked: CHECKED },
          newlyUnmet: ["Availability"],
        }),
      ]);
    const { user } = renderSection("e1");

    await screen.findByRole("heading", { name: "Hall A" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Recheck" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This venue no longer meets the event's requirements: Availability",
    );
    expect(getEventVenueSuitability).toHaveBeenCalledTimes(2);
    expect(getEventVenueSuitability).toHaveBeenLastCalledWith("e1");
  });

  it("SCRUM188_AC6_recheck_is_offered_on_the_empty_state_too", async () => {
    vi.mocked(getEventVenueSuitability).mockResolvedValueOnce([]).mockResolvedValueOnce([item()]);
    const { user } = renderSection();

    await screen.findByText("No venue has been requested for this event yet.");
    await user.click(screen.getByRole("button", { name: "Recheck" }));

    expect(await screen.findByRole("heading", { name: "Hall A" })).toBeInTheDocument();
  });
});

// SCRUM-188 review fix F10 (AC6): the opened result marks what was overridden.
describe("SCRUM-188 overridden criteria in the recheck", () => {
  it("SCRUM188_AC6_an_overridden_criterion_reads_overridden_in_the_opened_result", async () => {
    vi.mocked(getEventVenueSuitability).mockResolvedValue([
      item({
        suitabilityOverridden: true,
        current: { suitable: false, criteria: withUnmet(["Layout", "Capacity"]), checked: CHECKED },
        atRequest: { suitable: false, unmet: ["Layout"] },
        newlyUnmet: ["Capacity"],
      }),
    ]);
    renderSection();

    await screen.findByRole("heading", { name: "Hall A" });
    const criteria = within(venueItem("Hall A")).getAllByRole("listitem");
    const byName = (name) => criteria.find((li) => li.textContent.includes(name));
    expect(within(byName("Layout")).getByText("Not met — overridden by coordinator")).toBeInTheDocument();
    expect(within(byName("Capacity")).getByText("Not met")).toBeInTheDocument();
  });

  it("SCRUM188_AC6_without_an_override_nothing_reads_overridden", async () => {
    vi.mocked(getEventVenueSuitability).mockResolvedValue([
      item({
        suitabilityOverridden: false,
        current: { suitable: false, criteria: withUnmet(["Layout"]), checked: CHECKED },
        atRequest: { suitable: false, unmet: ["Layout"] },
        newlyUnmet: ["Layout"],
      }),
    ]);
    renderSection();

    await screen.findByRole("heading", { name: "Hall A" });
    expect(screen.queryByText(/overridden by coordinator/)).not.toBeInTheDocument();
  });
});

// SCRUM-188 review fix F11: an item that could not be rechecked is worded
// from its code; a 400 for the whole call is not about the layout.
describe("SCRUM-188 items that could not be rechecked", () => {
  it.each([
    [
      "STORED_REQUIREMENTS_INVALID",
      "The requirements saved with this request can no longer be read, so it could not be rechecked.",
    ],
    ["RECHECK_FAILED", "This venue could not be rechecked right now. Try Recheck."],
    ["SOMETHING_NEW", "This venue could not be rechecked. Press Recheck to try again."],
  ])("SCRUM188_AC6_an_item_with_%s_says_so_in_fixed_copy", async (code, text) => {
    vi.mocked(getEventVenueSuitability).mockResolvedValue([
      item({ current: null, newlyUnmet: [], error: { code, message: "Unknown code xyz for booking 1234" } }),
      item({ bookingId: "b2", venueId: "v2", venueName: "Room B" }),
    ]);
    renderSection();

    await screen.findByRole("heading", { name: "Hall A" });
    expect(within(venueItem("Hall A")).getByRole("alert")).toHaveTextContent(text);
    expect(screen.queryByText(/1234|xyz/)).not.toBeInTheDocument();
    expect(venueItem("Hall A").querySelector("details")).toBeNull();
    expect(within(venueItem("Room B")).getAllByText("Suitable").length).toBeGreaterThan(0);
  });

  it("SCRUM188_AC6_a_400_for_the_whole_recheck_has_its_own_message", async () => {
    vi.mocked(getEventVenueSuitability).mockRejectedValue(httpError(400, { error: "Invalid id" }));
    renderSection();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This event's venues could not be rechecked. Please try again.");
    expect(alert).not.toHaveTextContent(/layout/i);
  });

  it("SCRUM188_AC6_an_event_with_no_attendance_says_so", async () => {
    vi.mocked(getEventVenueSuitability).mockRejectedValue(
      httpError(409, { code: "EVENT_ATTENDANCE_MISSING", error: "raw prose" }),
    );
    renderSection();

    expect(await screen.findByRole("alert")).toHaveTextContent(/no expected attendance/);
  });
});

// SCRUM-525 (AC5, R14): each booking shows its own attendance and layout,
// outside the recheck result, and says when the number is the event's.
describe("SCRUM-525 each booking's attendance and layout", () => {
  it("SCRUM525_AC5_each_booking_shows_its_attendance_and_layout", async () => {
    vi.mocked(getEventVenueSuitability).mockResolvedValue([
      item({ expectedAttendance: 120, roomLayoutCode: "theatre" }),
      // Errored: no `current`, yet its own values still show.
      item({
        bookingId: "b2",
        venueId: "v2",
        venueName: "Room B",
        expectedAttendance: 40,
        roomLayoutCode: "u_shape",
        current: null,
        newlyUnmet: [],
        error: { code: "RECHECK_FAILED", message: "prose" },
      }),
    ]);
    renderSection();

    await screen.findByRole("heading", { name: "Hall A" });
    const hall = venueItem("Hall A");
    expect(within(hall).getByText("Attendance: 120")).toBeInTheDocument();
    expect(within(hall).getByText("Layout: Theatre")).toBeInTheDocument();

    const room = venueItem("Room B");
    expect(within(room).getByText("Attendance: 40")).toBeInTheDocument();
    expect(within(room).getByText("Layout: U-Shape")).toBeInTheDocument();
    expect(within(room).getByRole("alert")).toHaveTextContent("could not be rechecked");
  });

  it("SCRUM525_AC5_a_booking_with_no_layout_says_none_was_requested", async () => {
    vi.mocked(getEventVenueSuitability).mockResolvedValue([item({ roomLayoutCode: null })]);
    renderSection();

    await screen.findByRole("heading", { name: "Hall A" });
    expect(within(venueItem("Hall A")).getByText("Layout: None requested")).toBeInTheDocument();
  });

  it.each([
    ["event", 150, "Attendance: 150 (event's)"],
    ["booking", 40, "Attendance: 40"],
    [null, null, "Attendance: Not recorded"],
  ])("SCRUM525_AC5_a_fallback_attendance_is_marked_as_the_events (source %s)", async (source, n, text) => {
    vi.mocked(getEventVenueSuitability).mockResolvedValue([
      item({ attendanceSource: source, expectedAttendance: n }),
    ]);
    renderSection();

    await screen.findByRole("heading", { name: "Hall A" });
    // Exact text: "Attendance: 40" must not carry the event's mark.
    expect(within(venueItem("Hall A")).getByText(text)).toBeInTheDocument();
  });

  it("SCRUM525_AC3_a_booking_with_no_attendance_anywhere_errors_alone", async () => {
    vi.mocked(getEventVenueSuitability).mockResolvedValue([
      item({
        expectedAttendance: null,
        attendanceSource: null,
        current: null,
        newlyUnmet: [],
        error: { code: "EVENT_ATTENDANCE_MISSING", message: "raw prose" },
      }),
      item({ bookingId: "b2", venueId: "v2", venueName: "Room B", expectedAttendance: 40 }),
    ]);
    renderSection();

    await screen.findByRole("heading", { name: "Hall A" });
    expect(within(venueItem("Hall A")).getByRole("alert")).toHaveTextContent(
      "Neither this request nor the event has an expected attendance, so its capacity could not be checked.",
    );
    expect(screen.queryByText(/raw prose/)).not.toBeInTheDocument();
    expect(within(venueItem("Room B")).queryByRole("alert")).not.toBeInTheDocument();
  });
});

// F-WK7-1-01: the recheck shows the occupied period and its parts as sent.
describe("SCRUM-188 Week 7 occupied period in the recheck", () => {
  it("SCRUM188_WK7_1_a_recheck_shows_the_occupied_period_and_its_parts", async () => {
    const detail =
      "Booked for Gala Night 09:15–12:45 on Wed 11 Nov (setup 09:15–10:00, turnaround 12:00–12:45)";
    vi.mocked(getEventVenueSuitability).mockResolvedValue([
      item({
        current: {
          suitable: false,
          criteria: ALL_MET.map((c) => (c.criterion === "Availability" ? { ...c, met: false, detail } : c)),
          checked: CHECKED,
        },
        newlyUnmet: ["Availability"],
      }),
    ]);
    renderSection();

    await screen.findByRole("heading", { name: "Hall A" });
    const li = venueItem("Hall A");
    expect(within(li).getByRole("alert")).toHaveTextContent(
      "This venue no longer meets the event's requirements: Availability",
    );
    expect(li.querySelector("details")).toHaveAttribute("open");
    expect(within(li).getByText(detail)).toBeInTheDocument();
  });
});

// SCRUM-188 review fix F9: the parent learns what loaded.
describe("SCRUM-188 onLoaded", () => {
  it("SCRUM188_AC7_reports_the_loaded_items_to_the_parent_on_each_load", async () => {
    const onLoaded = vi.fn();
    const items = [item()];
    vi.mocked(getEventVenueSuitability).mockResolvedValueOnce(items).mockResolvedValueOnce([]);
    const user = userEvent.setup();
    render(<EventVenueSuitability eventRequestId="e1" onLoaded={onLoaded} />);

    await screen.findByRole("heading", { name: "Hall A" });
    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(onLoaded).toHaveBeenLastCalledWith(items);

    await user.click(screen.getByRole("button", { name: "Recheck" }));
    await screen.findByText("No venue has been requested for this event yet.");
    expect(onLoaded).toHaveBeenCalledTimes(2);
    expect(onLoaded).toHaveBeenLastCalledWith([]);
  });

  it("SCRUM188_AC7_a_failed_load_reports_nothing", async () => {
    const onLoaded = vi.fn();
    vi.mocked(getEventVenueSuitability).mockRejectedValue(httpError(500));
    render(<EventVenueSuitability eventRequestId="e1" onLoaded={onLoaded} />);

    await screen.findByRole("alert");
    expect(onLoaded).not.toHaveBeenCalled();
  });
});
