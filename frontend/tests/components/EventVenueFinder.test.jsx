// EventVenueFinder.test.jsx
//
// SCRUM-141 (SCRUM-20 AC1/AC2): the coordinator's venue search inside the
// event view -- pre-filled from the event, editable, and run only when the
// coordinator presses Search.
//
// venueService is mocked, so nothing touches the network. Results are only a
// list of names here; SCRUM-142 adds venue details and SCRUM-143 the no-match
// message, so neither is asserted.
//
// Timezone-safe: the event's instants are fixed ISO strings and every expected
// input value comes from toDatetimeLocalValue; date and time inputs are set
// with fireEvent.change; payloads are checked by offset shape and getTime().
// Run under UTC, Asia/Singapore and America/New_York.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import EventVenueFinder from "../../src/components/EventVenueFinder.jsx";
import { findVenuesForEvent } from "../../src/services/venueService";
import { deviceTimeZoneLabel, toDatetimeLocalValue } from "../../src/services/datetimeFormat.js";
import {
  ACCESSIBILITY_FEATURES,
  FACILITIES,
  ROOM_LAYOUTS,
} from "../../src/services/venueLookups.js";

vi.mock("../../src/services/venueService", () => ({
  findVenuesForEvent: vi.fn(),
}));

const OFFSET_SUFFIX = /[+-]\d{2}:\d{2}$/;
const GENERIC_ERROR = "Could not search venues. Please try again.";
const FORBIDDEN = "Only Event Coordinators can search by event requirements.";

// Wednesday 11 November 2026, 10:00-12:00 Singapore: one date in every zone
// the suite runs in, and clear of DST changes.
const START_ISO = "2026-11-11T10:00:00+08:00";
const END_ISO = "2026-11-11T12:00:00+08:00";

function localParts(iso) {
  const [date, time] = toDatetimeLocalValue(iso).split("T");
  return { date, time };
}

const START = localParts(START_ISO);
const END = localParts(END_ISO);

const EVENT = Object.freeze({
  id: "e1",
  eventName: "Tech Talk",
  proposedStart: START_ISO,
  proposedEnd: END_ISO,
  expectedAttendance: 80,
  venueRequirements: "Theatre layout with a projector",
});

const HALL = { id: "v1", name: "Hall A", location: "Level 2", maxCapacity: 200 };
const ANNEX = { id: "v2", name: "Annex", location: "Block C", maxCapacity: 90 };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function httpError(status, data) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });
}

function renderFinder(request = EVENT) {
  const user = userEvent.setup();
  const utils = render(<EventVenueFinder request={request} />);
  return { user, ...utils };
}

const field = {
  date: () => screen.getByLabelText("Date"),
  start: () => screen.getByLabelText("Start"),
  end: () => screen.getByLabelText("End"),
  attendance: () => screen.getByLabelText("Expected attendance"),
  location: () => screen.getByLabelText("Location"),
  layout: () => screen.getByLabelText("Layout"),
};
const searchButton = () => screen.getByRole("button", { name: /Search venues|Searching/ });
const group = (legend) => screen.getByRole("group", { name: legend });

/** The criteria of the only call, once it has been made. */
async function sentCriteria() {
  await waitFor(() => expect(findVenuesForEvent).toHaveBeenCalledTimes(1));
  return vi.mocked(findVenuesForEvent).mock.calls[0][0];
}

/** The error list a control's aria-describedby points at. */
function describedErrors(control) {
  const id = control.getAttribute("aria-describedby");
  expect(id).toBeTruthy();
  const list = document.getElementById(id);
  expect(list).not.toBeNull();
  return [...list.querySelectorAll("li")].map((li) => li.textContent);
}

beforeEach(() => {
  vi.mocked(findVenuesForEvent).mockReset();
  vi.mocked(findVenuesForEvent).mockResolvedValue([]);
});

describe("SCRUM20_AC2 pre-filled from the event", () => {
  it("SCRUM20_AC2_date_times_and_attendance_show_the_event_values", () => {
    renderFinder();

    expect(field.date()).toHaveValue(START.date);
    expect(field.start()).toHaveValue(START.time);
    expect(field.end()).toHaveValue(END.time);
    expect(field.attendance()).toHaveValue(80);
  });

  it("SCRUM20_AC2_optional_criteria_start_empty", () => {
    renderFinder();

    expect(field.location()).toHaveValue("");
    expect(field.layout()).toHaveValue("");
    for (const checkbox of screen.getAllByRole("checkbox")) {
      expect(checkbox).not.toBeChecked();
    }
  });

  it("SCRUM20_AC2_no_request_is_sent_on_render", async () => {
    // F-AC2 key case: the search waits for the coordinator.
    renderFinder();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(findVenuesForEvent).not.toHaveBeenCalled();
    expect(screen.queryByRole("list", { name: "Matching venues" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM20_AC2_missing_value_leaves_its_field_empty_and_required", async () => {
    const { user } = renderFinder({ ...EVENT, expectedAttendance: null });

    expect(field.attendance()).toHaveValue(null);
    await user.click(searchButton());

    expect(findVenuesForEvent).not.toHaveBeenCalled();
    expect(field.attendance()).toHaveAttribute("aria-invalid", "true");
    expect(describedErrors(field.attendance())).toEqual(["is required"]);
  });

  it("SCRUM20_AC2_event_on_two_dates_leaves_the_end_for_the_coordinator", () => {
    renderFinder({ ...EVENT, proposedEnd: "2026-11-13T12:00:00+08:00" });

    expect(field.date()).toHaveValue(START.date);
    expect(field.start()).toHaveValue(START.time);
    expect(field.end()).toHaveValue("");
  });

  it("SCRUM20_AC2_a_rerender_with_the_same_key_keeps_the_seeded_state", () => {
    // Seeded once (lazy useState): a new prop alone does not overwrite edits.
    // The parent re-seeds by changing the key; CoordinatorRequestDetail's
    // tests cover that.
    const { rerender } = render(<EventVenueFinder request={EVENT} />);
    fireEvent.change(field.attendance(), { target: { value: "150" } });

    rerender(<EventVenueFinder request={{ ...EVENT, expectedAttendance: 999 }} />);

    expect(field.attendance()).toHaveValue(150);
  });

  it("SCRUM20_AC2_a_new_key_reseeds_the_form", () => {
    const { rerender } = render(<EventVenueFinder key="e1" request={EVENT} />);
    fireEvent.change(field.attendance(), { target: { value: "150" } });

    rerender(<EventVenueFinder key="e2" request={{ ...EVENT, id: "e2", expectedAttendance: 30 }} />);

    expect(field.attendance()).toHaveValue(30);
  });

  it("SCRUM20_AC1_the_time_zone_is_disclosed", () => {
    renderFinder();
    expect(screen.getByText(`Times are in your device's time zone (${deviceTimeZoneLabel()}).`))
      .toBeInTheDocument();
  });
});

describe("SCRUM20_AC1 the optional pickers", () => {
  it("SCRUM20_AC1_optional_pickers_render_from_venue_lookups", () => {
    renderFinder();

    const layoutOptions = within(field.layout()).getAllByRole("option");
    expect(layoutOptions.map((o) => o.textContent)).toEqual([
      "Any layout",
      ...ROOM_LAYOUTS.map((l) => l.label),
    ]);
    expect(layoutOptions[0]).toHaveValue("");

    expect(within(group("Accessibility features")).getAllByRole("checkbox"))
      .toHaveLength(ACCESSIBILITY_FEATURES.length);
    expect(within(group("Facilities")).getAllByRole("checkbox")).toHaveLength(FACILITIES.length);
    for (const { label } of [...ACCESSIBILITY_FEATURES, ...FACILITIES]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });
});

describe("SCRUM20_AC1 searching", () => {
  it("SCRUM20_AC2_the_seeded_values_are_sent_unchanged", async () => {
    const { user } = renderFinder();
    await user.click(searchButton());

    const criteria = await sentCriteria();
    expect(Object.keys(criteria).sort()).toEqual(["endsAt", "expectedAttendance", "startsAt"]);
    expect(criteria.startsAt).toMatch(OFFSET_SUFFIX);
    expect(criteria.endsAt).toMatch(OFFSET_SUFFIX);
    expect(new Date(criteria.startsAt).getTime()).toBe(new Date(START_ISO).getTime());
    expect(new Date(criteria.endsAt).getTime()).toBe(new Date(END_ISO).getTime());
    expect(criteria.expectedAttendance).toBe(80);
  });

  it("SCRUM20_AC2_edited_values_are_sent", async () => {
    const { user } = renderFinder();

    await user.clear(field.attendance());
    await user.type(field.attendance(), "120");
    // Earlier, not later: in New York the event already ends at 23:00, so a
    // later end would cross local midnight.
    const earlierEnd = localParts("2026-11-11T11:30:00+08:00");
    fireEvent.change(field.end(), { target: { value: earlierEnd.time } });
    await user.click(searchButton());

    const criteria = await sentCriteria();
    expect(criteria.expectedAttendance).toBe(120);
    expect(new Date(criteria.endsAt).getTime()).toBe(new Date("2026-11-11T11:30:00+08:00").getTime());
  });

  it("SCRUM20_AC2_an_edited_start_is_sent", async () => {
    const { user } = renderFinder();

    // Later, not earlier: in New York the event starts at 21:00, and 10:30
    // Singapore is still on that date in every test zone.
    const laterStart = localParts("2026-11-11T10:30:00+08:00");
    fireEvent.change(field.start(), { target: { value: laterStart.time } });
    expect(field.start()).toHaveValue(laterStart.time);
    await user.click(searchButton());

    const criteria = await sentCriteria();
    expect(new Date(criteria.startsAt).getTime()).toBe(new Date("2026-11-11T10:30:00+08:00").getTime());
    expect(new Date(criteria.endsAt).getTime()).toBe(new Date(END_ISO).getTime());
  });

  it("SCRUM20_AC2_changing_the_date_moves_start_and_end", async () => {
    const { user } = renderFinder();

    const nextDay = localParts("2026-11-12T10:00:00+08:00");
    fireEvent.change(field.date(), { target: { value: nextDay.date } });
    await user.click(searchButton());

    const criteria = await sentCriteria();
    const DAY = 24 * 60 * 60 * 1000;
    expect(new Date(criteria.startsAt).getTime()).toBe(new Date(START_ISO).getTime() + DAY);
    expect(new Date(criteria.endsAt).getTime()).toBe(new Date(END_ISO).getTime() + DAY);
  });

  it("SCRUM20_AC1_selected_codes_and_location_are_sent", async () => {
    const { user } = renderFinder();

    await user.type(field.location(), "  Level 2 ");
    await user.selectOptions(field.layout(), "theatre");
    await user.click(screen.getByLabelText("Projector"));
    await user.click(screen.getByLabelText("Wi-Fi"));
    await user.click(screen.getByLabelText("Step-free entrance"));
    await user.click(searchButton());

    const criteria = await sentCriteria();
    expect(criteria).toMatchObject({
      location: "Level 2",
      layout: "theatre",
      accessibility: ["step_free_entrance"],
      facilities: ["projector", "wifi"],
    });
  });

  it("SCRUM20_AC1_unticking_a_box_sends_only_what_is_still_ticked", async () => {
    const { user } = renderFinder();

    await user.click(screen.getByLabelText("Projector"));
    await user.click(screen.getByLabelText("Wi-Fi"));
    await user.click(screen.getByLabelText("Projector"));
    expect(screen.getByLabelText("Projector")).not.toBeChecked();
    expect(screen.getByLabelText("Wi-Fi")).toBeChecked();
    await user.click(searchButton());

    const criteria = await sentCriteria();
    expect(criteria.facilities).toEqual(["wifi"]);
    expect(criteria).not.toHaveProperty("accessibility");
  });

  it("SCRUM20_AC1_unselected_criteria_are_left_out", async () => {
    const { user } = renderFinder();

    // Set, then cleared again: nothing is sent for either.
    await user.selectOptions(field.layout(), "banquet");
    await user.selectOptions(field.layout(), "");
    await user.type(field.location(), "   ");
    await user.click(searchButton());

    const criteria = await sentCriteria();
    for (const key of ["location", "layout", "accessibility", "facilities"]) {
      expect(criteria).not.toHaveProperty(key);
    }
  });

  it("SCRUM20_AC1_results_list_shows_the_venue_names", async () => {
    vi.mocked(findVenuesForEvent).mockResolvedValue([HALL, ANNEX]);
    const { user } = renderFinder();
    await user.click(searchButton());

    const list = await screen.findByRole("list", { name: "Matching venues" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Hall A",
      "Annex",
    ]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM20_AC1_an_empty_result_shows_no_list_and_no_error", async () => {
    // The no-match message is SCRUM-143's; this only pins that nothing breaks.
    const { user } = renderFinder();
    await user.click(searchButton());

    await waitFor(() => expect(findVenuesForEvent).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(searchButton()).toHaveTextContent("Search venues"));
    expect(screen.queryByRole("list", { name: "Matching venues" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM20_AC2_values_are_kept_after_a_search", async () => {
    vi.mocked(findVenuesForEvent).mockResolvedValue([HALL]);
    const { user } = renderFinder();

    await user.clear(field.attendance());
    await user.type(field.attendance(), "60");
    await user.type(field.location(), "Level");
    await user.selectOptions(field.layout(), "classroom");
    await user.click(screen.getByLabelText("Screen"));
    await user.click(searchButton());
    await screen.findByRole("list", { name: "Matching venues" });

    expect(field.date()).toHaveValue(START.date);
    expect(field.start()).toHaveValue(START.time);
    expect(field.end()).toHaveValue(END.time);
    expect(field.attendance()).toHaveValue(60);
    expect(field.location()).toHaveValue("Level");
    expect(field.layout()).toHaveValue("classroom");
    expect(screen.getByLabelText("Screen")).toBeChecked();
  });

  it("SCRUM20_AC1_searching_again_sends_a_second_request_with_the_new_values", async () => {
    vi.mocked(findVenuesForEvent).mockResolvedValue([HALL]);
    const { user } = renderFinder();

    await user.click(searchButton());
    await screen.findByRole("list", { name: "Matching venues" });
    await user.clear(field.attendance());
    await user.type(field.attendance(), "150");
    await user.click(searchButton());

    await waitFor(() => expect(findVenuesForEvent).toHaveBeenCalledTimes(2));
    expect(vi.mocked(findVenuesForEvent).mock.calls[1][0].expectedAttendance).toBe(150);
  });

  it("SCRUM20_AC1_searching_disables_the_form_and_says_so", async () => {
    const pending = deferred();
    vi.mocked(findVenuesForEvent).mockReturnValue(pending.promise);
    const { user } = renderFinder();

    await user.click(searchButton());

    expect(searchButton()).toHaveTextContent("Searching...");
    expect(searchButton()).toBeDisabled();
    for (const control of [
      field.date(), field.start(), field.end(), field.attendance(), field.location(), field.layout(),
      ...screen.getAllByRole("checkbox"),
    ]) {
      expect(control).toBeDisabled();
    }

    pending.resolve([HALL]);
    await screen.findByRole("list", { name: "Matching venues" });
    expect(searchButton()).toHaveTextContent("Search venues");
    expect(searchButton()).toBeEnabled();
    expect(field.attendance()).toBeEnabled();
  });
});

describe("SCRUM20_AC1 client errors", () => {
  it("SCRUM20_AC1_errors_show_before_any_request", async () => {
    const { user } = renderFinder();

    await user.clear(field.attendance());
    await user.click(searchButton());

    expect(findVenuesForEvent).not.toHaveBeenCalled();
    expect(field.attendance()).toHaveAttribute("aria-invalid", "true");
    expect(describedErrors(field.attendance())).toEqual(["is required"]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM20_AC1_required_fields_blank_show_an_error_beside_each", async () => {
    const { user } = renderFinder({ id: "e9" });

    await user.click(searchButton());

    expect(findVenuesForEvent).not.toHaveBeenCalled();
    for (const control of [field.date(), field.start(), field.end(), field.attendance()]) {
      expect(control).toHaveAttribute("aria-invalid", "true");
      expect(describedErrors(control)).toEqual(["is required"]);
    }
    expect(field.location()).not.toHaveAttribute("aria-invalid");
    expect(field.layout()).not.toHaveAttribute("aria-invalid");
  });

  it("SCRUM20_AC1_end_equal_to_start_is_refused_beside_end", async () => {
    const { user } = renderFinder();

    fireEvent.change(field.end(), { target: { value: START.time } });
    await user.click(searchButton());

    expect(findVenuesForEvent).not.toHaveBeenCalled();
    expect(describedErrors(field.end())).toEqual(["must be later than the start"]);
    expect(field.start()).not.toHaveAttribute("aria-invalid");
  });

  it("SCRUM20_AC1_attendance_must_be_a_whole_number_of_at_least_one", async () => {
    const { user } = renderFinder();

    fireEvent.change(field.attendance(), { target: { value: "0" } });
    await user.click(searchButton());
    expect(describedErrors(field.attendance())).toEqual(["must be at least 1"]);

    fireEvent.change(field.attendance(), { target: { value: "2.5" } });
    await user.click(searchButton());
    expect(describedErrors(field.attendance())).toEqual(["must be a whole number"]);

    expect(findVenuesForEvent).not.toHaveBeenCalled();
  });

  it("SCRUM20_AC1_editing_a_field_clears_its_error_only", async () => {
    const { user } = renderFinder({ ...EVENT, proposedStart: null, proposedEnd: null });

    await user.click(searchButton());
    expect(field.date()).toHaveAttribute("aria-invalid", "true");
    expect(field.start()).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(field.date(), { target: { value: START.date } });

    expect(field.date()).not.toHaveAttribute("aria-invalid");
    expect(field.date()).not.toHaveAttribute("aria-describedby");
    expect(field.start()).toHaveAttribute("aria-invalid", "true");
  });

  it("SCRUM20_AC1_a_client_error_keeps_the_last_good_results", async () => {
    vi.mocked(findVenuesForEvent).mockResolvedValue([HALL]);
    const { user } = renderFinder();

    await user.click(searchButton());
    await screen.findByRole("list", { name: "Matching venues" });

    await user.clear(field.attendance());
    await user.click(searchButton());

    expect(findVenuesForEvent).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("list", { name: "Matching venues" })).toBeInTheDocument();
  });

  it("SCRUM20_AC1_a_client_error_clears_an_earlier_message", async () => {
    vi.mocked(findVenuesForEvent).mockRejectedValueOnce(httpError(500, {}));
    const { user } = renderFinder();

    await user.click(searchButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(GENERIC_ERROR);

    await user.clear(field.attendance());
    await user.click(searchButton());

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(findVenuesForEvent).toHaveBeenCalledTimes(1);
  });
});

describe("SCRUM20_AC1 server errors", () => {
  it("SCRUM20_AC1_server_details_show_beside_the_fields_they_name", async () => {
    vi.mocked(findVenuesForEvent).mockRejectedValue(httpError(400, {
      error: "Invalid venue search -- ...",
      details: [
        { field: "startsAt", message: "must include a UTC offset" },
        { field: "expectedAttendance", message: "must be at most 10000" },
        { field: "location", message: "must be text" },
        { field: "layout", message: "unknown code: ballroom" },
      ],
    }));
    const { user } = renderFinder();
    await user.click(searchButton());

    await waitFor(() => expect(field.start()).toHaveAttribute("aria-invalid", "true"));
    expect(describedErrors(field.start())).toEqual(["must include a UTC offset"]);
    expect(describedErrors(field.attendance())).toEqual(["must be at most 10000"]);
    expect(describedErrors(field.location())).toEqual(["must be text"]);
    expect(describedErrors(field.layout())).toEqual(["unknown code: ballroom"]);
    // Every detail found a field, so there is no generic message.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM20_AC1_server_details_for_code_lists_show_on_their_group", async () => {
    vi.mocked(findVenuesForEvent).mockRejectedValue(httpError(400, {
      details: [
        { field: "endsAt", message: "must be later than the start" },
        { field: "facilities", message: "unknown code: hoverboard" },
        { field: "accessibility", message: "unknown code: ramp" },
      ],
    }));
    const { user } = renderFinder();
    await user.click(searchButton());

    await waitFor(() => expect(group("Facilities")).toHaveAttribute("aria-invalid", "true"));
    expect(describedErrors(field.end())).toEqual(["must be later than the start"]);
    expect(describedErrors(group("Facilities"))).toEqual(["unknown code: hoverboard"]);
    expect(describedErrors(group("Accessibility features"))).toEqual(["unknown code: ramp"]);
  });

  it("SCRUM20_AC1_editing_a_field_clears_its_server_error", async () => {
    vi.mocked(findVenuesForEvent).mockRejectedValue(httpError(400, {
      details: [
        { field: "facilities", message: "unknown code: hoverboard" },
        { field: "location", message: "must be text" },
      ],
    }));
    const { user } = renderFinder();
    await user.click(searchButton());
    await waitFor(() => expect(group("Facilities")).toHaveAttribute("aria-invalid", "true"));

    await user.click(screen.getByLabelText("Projector"));

    expect(group("Facilities")).not.toHaveAttribute("aria-invalid");
    expect(field.location()).toHaveAttribute("aria-invalid", "true");
  });

  it("SCRUM20_AC1_unmapped_details_give_the_generic_message", async () => {
    vi.mocked(findVenuesForEvent).mockRejectedValue(httpError(400, {
      details: [
        { field: "expectedAttendance", message: "must be at least 1" },
        { field: "somethingNew", message: "is wrong" },
      ],
    }));
    const { user } = renderFinder();
    await user.click(searchButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(GENERIC_ERROR);
    // The mapped one still sits beside its field.
    expect(describedErrors(field.attendance())).toEqual(["must be at least 1"]);
  });

  it.each([
    ["no details", { error: "Invalid venue search" }],
    ["an empty details list", { details: [] }],
    ["no body", undefined],
  ])("SCRUM20_AC1_a_400_with_%s_gives_the_generic_message", async (_label, data) => {
    vi.mocked(findVenuesForEvent).mockRejectedValue(httpError(400, data));
    const { user } = renderFinder();
    await user.click(searchButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(GENERIC_ERROR);
    expect(screen.queryAllByRole("textbox").filter((el) => el.hasAttribute("aria-invalid"))).toEqual([]);
  });

  it("SCRUM20_AC1_403_names_the_role", async () => {
    vi.mocked(findVenuesForEvent).mockRejectedValue(httpError(403, { error: "Forbidden" }));
    const { user } = renderFinder();
    await user.click(searchButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(FORBIDDEN);
  });

  it.each([
    ["a 500", httpError(500, { error: "boom" })],
    ["a 401", httpError(401, { error: "Authentication required" })],
    ["a network error", new Error("Network Error")],
  ])("SCRUM20_AC1_%s_gives_the_generic_message", async (_label, err) => {
    vi.mocked(findVenuesForEvent).mockRejectedValue(err);
    const { user } = renderFinder();
    await user.click(searchButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(GENERIC_ERROR);
    expect(searchButton()).toBeEnabled();
  });

  it("SCRUM20_AC1_a_failed_search_clears_the_earlier_results", async () => {
    vi.mocked(findVenuesForEvent)
      .mockResolvedValueOnce([HALL])
      .mockRejectedValueOnce(httpError(500, {}));
    const { user } = renderFinder();

    await user.click(searchButton());
    await screen.findByRole("list", { name: "Matching venues" });
    await user.click(searchButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(GENERIC_ERROR);
    expect(screen.queryByRole("list", { name: "Matching venues" })).not.toBeInTheDocument();
  });

  it("SCRUM20_AC1_a_successful_search_clears_an_earlier_error", async () => {
    vi.mocked(findVenuesForEvent)
      .mockRejectedValueOnce(httpError(400, { details: [{ field: "location", message: "must be text" }] }))
      .mockResolvedValueOnce([HALL]);
    const { user } = renderFinder();

    await user.click(searchButton());
    await waitFor(() => expect(field.location()).toHaveAttribute("aria-invalid", "true"));
    await user.click(searchButton());

    await screen.findByRole("list", { name: "Matching venues" });
    expect(field.location()).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
