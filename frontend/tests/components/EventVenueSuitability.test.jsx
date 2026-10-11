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
