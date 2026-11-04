// EventVenueFinder.test.jsx
//
// SCRUM-141 (SCRUM-20 AC1/AC2): the coordinator's venue search inside the
// event view -- pre-filled from the event, editable, and run only when the
// coordinator presses Search.
//
// venueService is mocked, so nothing touches the network. SCRUM-142's venue
// details and SCRUM-143's no-match message and retry (AC8) are asserted at
// the end, then SCRUM-254's request button and SCRUM-191's suitability check.
//
// Timezone-proof: the finder shows Singapore (venue) time on every device, so
// expected input values are Singapore literals and payloads are compared with
// +08:00 strings. Date and time inputs are set with fireEvent.change. Run
// under UTC, Asia/Singapore and America/New_York.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import EventVenueFinder from "../../src/components/EventVenueFinder.jsx";
import { findVenuesForEvent, searchActiveVenues } from "../../src/services/venueService";
import { createBookingRequest } from "../../src/services/bookingRequestService";
import { checkVenueSuitability } from "../../src/services/venueSuitabilityService";
import {
  ACCESSIBILITY_FEATURES,
  FACILITIES,
  ROOM_LAYOUTS,
} from "../../src/services/venueLookups.js";
import { deferred, httpError } from "../helpers/async.js";

vi.mock("../../src/services/venueService", () => ({
  findVenuesForEvent: vi.fn(),
  searchActiveVenues: vi.fn(),
}));

vi.mock("../../src/services/venueSuitabilityService", () => ({
  checkVenueSuitability: vi.fn(),
}));

vi.mock("../../src/services/bookingRequestService", () => ({
  createBookingRequest: vi.fn(),
}));

const GENERIC_ERROR = "Could not search venues. Please try again.";
const FORBIDDEN = "Only Event Coordinators can search by event requirements.";

// Wednesday 11 November 2026, 10:00-12:00 Singapore, shown as exactly that on
// every device.
const START_ISO = "2026-11-11T10:00:00+08:00";
const END_ISO = "2026-11-11T12:00:00+08:00";
const START = { date: "2026-11-11", time: "10:00" };
const END = { date: "2026-11-11", time: "12:00" };

const EVENT = Object.freeze({
  id: "e1",
  eventName: "Tech Talk",
  proposedStart: START_ISO,
  proposedEnd: END_ISO,
  expectedAttendance: 80,
  venueRequirements: "Theatre layout with a projector",
});

const HALL = {
  id: "v1",
  name: "Hall A",
  location: "Level 2",
  maxCapacity: 200,
  layouts: ["theatre", "u_shape"],
  accessibility: ["step_free_entrance", "hearing_loop"],
  facilities: ["projector", "wifi"],
  hours: [{ dayOfWeek: 3, opensAt: "08:00", closesAt: "22:00" }],
  setupMinutes: 45,
  turnaroundMinutes: 30,
};
const ANNEX = {
  id: "v2",
  name: "Annex",
  location: "Block C",
  maxCapacity: 90,
  layouts: ["classroom"],
  accessibility: [],
  facilities: [],
  hours: [],
  setupMinutes: 0,
  turnaroundMinutes: 0,
};

function renderFinder(request = EVENT, props = {}) {
  const user = userEvent.setup();
  const utils = render(<EventVenueFinder request={request} {...props} />);
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

/** The elements a control's aria-describedby names, in order. */
function describedBy(control) {
  const ids = (control.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  return ids.map((id) => document.getElementById(id));
}

/**
 * The error list a control's aria-describedby points at. It may name hints
 * too (Location always does), so the list is the one <ul> among them.
 */
function describedErrors(control) {
  const elements = describedBy(control);
  expect(elements).not.toContain(null);
  const list = elements.find((el) => el.tagName === "UL");
  expect(list).toBeTruthy();
  return [...list.querySelectorAll("li")].map((li) => li.textContent);
}

const LOCATION_HINT = "Matches part of the venue's location (building or area), not its name.";
const multiDayHint = (date) =>
  `This event runs longer than a day. Venue search checks one day's hours, which can run into the next day — set an end time on ${date} or the next day.`;

beforeEach(() => {
  vi.mocked(findVenuesForEvent).mockReset();
  vi.mocked(findVenuesForEvent).mockResolvedValue([]);
  vi.mocked(createBookingRequest).mockReset();
  vi.mocked(searchActiveVenues).mockReset();
  vi.mocked(checkVenueSuitability).mockReset();
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

  it("SCRUM20_AC2_prefill_uses_singapore_time_on_any_device", () => {
    // 09:00-13:00 Singapore is 20:00-00:00 the day before in New York. The
    // form still shows the Singapore period, End included.
    renderFinder({
      ...EVENT,
      proposedStart: "2026-11-11T09:00:00+08:00",
      proposedEnd: "2026-11-11T13:00:00+08:00",
    });

    expect(field.date()).toHaveValue("2026-11-11");
    expect(field.start()).toHaveValue("09:00");
    expect(field.end()).toHaveValue("13:00");
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

  it("SCRUM20_AC1_the_time_zone_is_disclosed_as_singapore_time", () => {
    renderFinder();
    expect(screen.getByText(
      "Times are Singapore time (Asia/Singapore), the venues' local time. An end time earlier than the start means the next day.",
    ))
      .toBeInTheDocument();
    expect(screen.queryByText(/device/)).not.toBeInTheDocument();
  });
});

describe("SCRUM20 hints that explain the form", () => {
  it("SCRUM20_AC1_location_hint_says_it_matches_location_not_name", () => {
    renderFinder();

    const hint = screen.getByText(LOCATION_HINT);
    expect(field.location()).not.toHaveAttribute("aria-invalid");
    expect(describedBy(field.location())).toEqual([hint]);
  });

  it("SCRUM20_AC1_location_hint_stays_described_beside_a_server_error", async () => {
    vi.mocked(findVenuesForEvent).mockRejectedValue(httpError(400, {
      details: [{ field: "location", message: "must be text" }],
    }));
    const { user } = renderFinder();
    await user.click(searchButton());

    await waitFor(() => expect(field.location()).toHaveAttribute("aria-invalid", "true"));
    const [errors, hint] = describedBy(field.location());
    expect(errors.tagName).toBe("UL");
    expect(errors).toHaveTextContent("must be text");
    expect(hint).toBe(screen.getByText(LOCATION_HINT));
  });

  it("SCRUM20_AC3_multi_day_event_explains_the_blank_end", async () => {
    const { user } = renderFinder({ ...EVENT, proposedEnd: "2026-11-13T12:00:00+08:00" });

    const hint = screen.getByText(multiDayHint(START.date));
    expect(hint).not.toHaveAttribute("role");
    expect(describedBy(field.end())).toEqual([hint]);

    // Search names End as required; the hint is still there and still read.
    await user.click(searchButton());
    expect(findVenuesForEvent).not.toHaveBeenCalled();
    expect(describedErrors(field.end())).toEqual(["is required"]);
    expect(describedBy(field.end())).toContain(hint);
  });

  it("SCRUM20_AC3_multi_day_hint_describes_the_event_not_the_edited_date", () => {
    renderFinder({ ...EVENT, proposedEnd: "2026-11-13T12:00:00+08:00" });

    fireEvent.change(field.date(), { target: { value: "2026-11-20" } });

    expect(screen.getByText(multiDayHint(START.date))).toBeInTheDocument();
  });

  it("SCRUM20_AC3_single_day_event_has_no_multi_day_hint", () => {
    renderFinder();

    expect(screen.queryByText(/longer than a day/)).not.toBeInTheDocument();
    expect(field.end()).not.toHaveAttribute("aria-describedby");
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

describe("SCRUM575_AC5 an event that ends the next day", () => {
  const OVERNIGHT = {
    ...EVENT,
    proposedStart: "2026-11-13T22:00:00+08:00",
    proposedEnd: "2026-11-14T02:00:00+08:00",
  };

  it("SCRUM575_AC5_note_under_end_names_the_next_day_and_the_search_sends_it", async () => {
    const { user } = renderFinder(OVERNIGHT);

    expect(field.end()).toHaveValue("02:00");
    const note = screen.getByText("Ends Saturday 2026-11-14 02:00 (next day)");
    expect(note).toHaveAttribute("aria-live", "polite");
    expect(describedBy(field.end())).toEqual([note]);

    await user.click(searchButton());

    const criteria = await sentCriteria();
    expect(criteria.startsAt).toBe(OVERNIGHT.proposedStart);
    expect(criteria.endsAt).toBe(OVERNIGHT.proposedEnd);
  });

  it("SCRUM575_AC5_note_appears_when_end_is_edited_before_the_start", () => {
    renderFinder();
    expect(screen.queryByText(/\(next day\)/)).not.toBeInTheDocument();

    fireEvent.change(field.end(), { target: { value: "09:00" } });

    expect(screen.getByText("Ends Thursday 2026-11-12 09:00 (next day)")).toBeInTheDocument();
  });
});

describe("SCRUM20_AC1 searching", () => {
  it("SCRUM20_AC2_the_seeded_values_are_sent_unchanged", async () => {
    const { user } = renderFinder();
    await user.click(searchButton());

    const criteria = await sentCriteria();
    // eventRequestId is the event's own id (SCRUM-491), not a search value.
    expect(Object.keys(criteria).sort()).toEqual([
      "endsAt",
      "eventRequestId",
      "expectedAttendance",
      "startsAt",
    ]);
    expect(criteria.startsAt).toBe(START_ISO);
    expect(criteria.endsAt).toBe(END_ISO);
    expect(criteria.expectedAttendance).toBe(80);
  });

  it("SCRUM20_AC1_sent_period_is_singapore_time", async () => {
    const { user } = renderFinder({
      ...EVENT,
      proposedStart: "2026-11-11T09:00:00+08:00",
      proposedEnd: "2026-11-11T13:00:00+08:00",
    });
    await user.click(searchButton());

    const criteria = await sentCriteria();
    expect(criteria.startsAt).toBe("2026-11-11T09:00:00+08:00");
    expect(criteria.endsAt).toBe("2026-11-11T13:00:00+08:00");
  });

  it("SCRUM20_AC2_edited_values_are_sent", async () => {
    const { user } = renderFinder();

    await user.clear(field.attendance());
    await user.type(field.attendance(), "120");
    fireEvent.change(field.end(), { target: { value: "11:30" } });
    await user.click(searchButton());

    const criteria = await sentCriteria();
    expect(criteria.expectedAttendance).toBe(120);
    expect(criteria.endsAt).toBe("2026-11-11T11:30:00+08:00");
  });

  it("SCRUM20_AC2_an_edited_start_is_sent", async () => {
    const { user } = renderFinder();

    fireEvent.change(field.start(), { target: { value: "10:30" } });
    expect(field.start()).toHaveValue("10:30");
    await user.click(searchButton());

    const criteria = await sentCriteria();
    expect(criteria.startsAt).toBe("2026-11-11T10:30:00+08:00");
    expect(criteria.endsAt).toBe(END_ISO);
  });

  it("SCRUM20_AC2_changing_the_date_moves_start_and_end", async () => {
    const { user } = renderFinder();

    fireEvent.change(field.date(), { target: { value: "2026-11-12" } });
    await user.click(searchButton());

    const criteria = await sentCriteria();
    expect(criteria.startsAt).toBe("2026-11-12T10:00:00+08:00");
    expect(criteria.endsAt).toBe("2026-11-12T12:00:00+08:00");
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
    expect(
      within(list)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["Hall A", "Annex"]);
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
    expect(describedErrors(field.end())).toEqual(["must differ from the start"]);
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

describe("SCRUM20 venue details on each result (SCRUM-142)", () => {
  /** Term -> definition text for one result, found by its venue name. */
  async function detailsOf(name) {
    const article = await screen.findByRole("article", { name });
    const terms = within(article).getAllByRole("term").map((dt) => dt.textContent);
    const values = within(article).getAllByRole("definition").map((dd) => dd.textContent);
    return Object.fromEntries(terms.map((term, i) => [term, values[i]]));
  }

  async function searchReturning(venues) {
    vi.mocked(findVenuesForEvent).mockResolvedValue(venues);
    const { user } = renderFinder();
    await user.click(searchButton());
    await screen.findByRole("list", { name: "Matching venues" });
  }

  it("SCRUM20_each_result_shows_name_location_capacity_layouts_accessibility_and_facilities", async () => {
    await searchReturning([HALL, ANNEX]);

    expect(screen.getByRole("heading", { name: "Hall A" })).toBeInTheDocument();
    expect(await detailsOf("Hall A")).toEqual({
      Location: "Level 2",
      "Maximum capacity": "200",
      "Room layouts": "Theatre, U-Shape",
      "Accessibility features": "Step-free entrance, Hearing loop",
      Facilities: "Projector, Wi-Fi",
    });
    expect((await detailsOf("Annex"))["Room layouts"]).toBe("Classroom");
  });

  it("SCRUM20_labels_come_from_venueLookups_not_the_raw_codes", async () => {
    await searchReturning([
      {
        ...HALL,
        layouts: ROOM_LAYOUTS.map((o) => o.code),
        accessibility: ACCESSIBILITY_FEATURES.map((o) => o.code),
        facilities: FACILITIES.map((o) => o.code),
      },
    ]);

    const details = await detailsOf("Hall A");
    expect(details["Room layouts"]).toBe(ROOM_LAYOUTS.map((o) => o.label).join(", "));
    expect(details["Accessibility features"]).toBe(
      ACCESSIBILITY_FEATURES.map((o) => o.label).join(", "),
    );
    expect(details.Facilities).toBe(FACILITIES.map((o) => o.label).join(", "));
  });

  it("SCRUM20_a_code_the_lookup_copy_does_not_know_shows_as_the_raw_code", async () => {
    // venueLookups is a known-stale copy: a newer code must still show.
    await searchReturning([
      {
        ...HALL,
        layouts: ["theatre", "cabaret"],
        accessibility: ["braille_signage"],
        facilities: ["projector", "stage_lighting"],
      },
    ]);

    const details = await detailsOf("Hall A");
    expect(details["Room layouts"]).toBe("Theatre, cabaret");
    expect(details["Accessibility features"]).toBe("braille_signage");
    expect(details.Facilities).toBe("Projector, stage_lighting");
  });

  it("SCRUM20_an_empty_code_list_says_none_listed", async () => {
    await searchReturning([{ ...ANNEX, layouts: [] }]);

    const details = await detailsOf("Annex");
    expect(details["Room layouts"]).toBe("None listed");
    expect(details["Accessibility features"]).toBe("None listed");
    expect(details.Facilities).toBe("None listed");
  });

  it("SCRUM20_only_the_six_required_fields_are_shown", async () => {
    await searchReturning([HALL]);

    const article = await screen.findByRole("article", { name: "Hall A" });
    expect(Object.keys(await detailsOf("Hall A"))).toEqual([
      "Location",
      "Maximum capacity",
      "Room layouts",
      "Accessibility features",
      "Facilities",
    ]);
    expect(article).not.toHaveTextContent(/hours|setup|turnaround|08:00|22:00|45|30/i);
  });

  it("SCRUM20_AC7_results_are_shown_as_returned_without_refiltering", async () => {
    // The server decides what matches and in what order. Zeta is below the
    // form's 80 and listed before Alpha: the client neither drops nor sorts.
    const ZETA = { ...ANNEX, id: "v9", name: "Zeta", maxCapacity: 50 };
    const ALPHA = { ...HALL, id: "v8", name: "Alpha" };
    await searchReturning([ZETA, ALPHA]);

    expect(field.attendance()).toHaveValue(80);
    const list = screen.getByRole("list", { name: "Matching venues" });
    expect(
      within(list)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["Zeta", "Alpha"]);
    expect((await detailsOf("Zeta"))["Maximum capacity"]).toBe("50");
  });
});

describe("SCRUM20_AC8 no venue matched (SCRUM-143)", () => {
  const NO_MATCH = "No venue matched your criteria.";
  // By its text: with results on screen, SCRUM-254's eligibility reason is a
  // status too.
  const noMatch = () =>
    screen.queryAllByRole("status").find((el) => el.textContent.includes(NO_MATCH)) ?? null;

  it("SCRUM20_AC8_empty_response_shows_the_no_match_message", async () => {
    const { user } = renderFinder();
    await user.click(searchButton());

    expect(await screen.findByRole("status")).toHaveTextContent(NO_MATCH);
    expect(screen.queryByRole("list", { name: "Matching venues" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM20_AC8_no_match_message_names_no_criterion", async () => {
    // Fixed text: it never says which criterion left the list empty.
    const { user } = renderFinder();
    await user.type(field.location(), "Level 9");
    await user.selectOptions(field.layout(), "banquet");
    await user.click(screen.getByLabelText("Projector"));
    await user.click(searchButton());

    const status = await screen.findByRole("status");
    expect(status).not.toHaveTextContent(
      /capacity|attendance|hours|time|layout|accessib|facilit|location|date/i,
    );
  });

  it("SCRUM20_AC8_inputs_keep_their_values_after_no_match", async () => {
    const { user } = renderFinder();

    await user.clear(field.attendance());
    await user.type(field.attendance(), "500");
    await user.type(field.location(), "Level 9");
    await user.selectOptions(field.layout(), "banquet");
    await user.click(screen.getByLabelText("Projector"));
    await user.click(screen.getByLabelText("Step-free entrance"));
    await user.click(searchButton());
    await screen.findByRole("status");

    expect(field.date()).toHaveValue(START.date);
    expect(field.start()).toHaveValue(START.time);
    expect(field.end()).toHaveValue(END.time);
    expect(field.attendance()).toHaveValue(500);
    expect(field.location()).toHaveValue("Level 9");
    expect(field.layout()).toHaveValue("banquet");
    const ticked = screen.getAllByRole("checkbox").filter((box) => box.checked);
    expect(ticked).toEqual([
      screen.getByLabelText("Step-free entrance"),
      screen.getByLabelText("Projector"),
    ]);
  });

  it("SCRUM20_AC8_adjusting_and_searching_again_replaces_the_message", async () => {
    vi.mocked(findVenuesForEvent)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([HALL]);
    const { user } = renderFinder();

    await user.click(searchButton());
    await screen.findByRole("status");
    await user.clear(field.attendance());
    await user.type(field.attendance(), "40");
    await user.click(searchButton());

    const list = await screen.findByRole("list", { name: "Matching venues" });
    expect(within(list).getByRole("heading", { name: "Hall A" })).toBeInTheDocument();
    expect(noMatch()).not.toBeInTheDocument();
    expect(findVenuesForEvent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(findVenuesForEvent).mock.calls[1][0].expectedAttendance).toBe(40);
  });

  it("SCRUM20_AC8_no_message_before_the_first_search", () => {
    renderFinder();

    expect(noMatch()).not.toBeInTheDocument();
    expect(screen.queryByText(NO_MATCH, { exact: false })).not.toBeInTheDocument();
  });

  it("SCRUM20_AC8_the_message_is_hidden_while_a_new_search_runs", async () => {
    const pending = deferred();
    vi.mocked(findVenuesForEvent)
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(pending.promise);
    const { user } = renderFinder();

    await user.click(searchButton());
    await screen.findByRole("status");
    await user.click(searchButton());

    expect(searchButton()).toHaveTextContent("Searching...");
    expect(noMatch()).not.toBeInTheDocument();

    pending.resolve([]);
    expect(await screen.findByRole("status")).toHaveTextContent(NO_MATCH);
  });

  it("SCRUM20_AC8_a_failed_search_after_no_match_shows_the_error_not_the_message", async () => {
    vi.mocked(findVenuesForEvent)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(httpError(500, {}));
    const { user } = renderFinder();

    await user.click(searchButton());
    await screen.findByRole("status");
    await user.click(searchButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(GENERIC_ERROR);
    expect(noMatch()).not.toBeInTheDocument();
  });
});

describe("SCRUM484_AC7 search still hides venues without a reason", () => {
  it("SCRUM484_AC7_search_no_match_does_not_explain_setup", async () => {
    // Search counts each venue's setup and turnaround but gives no reason per
    // venue (SCRUM-143/145), so an empty result never blames either.
    vi.mocked(findVenuesForEvent).mockResolvedValue([]);
    const { user } = renderFinder();
    await user.click(searchButton());

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("No venue matched your criteria.");
    expect(status).not.toHaveTextContent(/setup|turnaround/i);
    expect(screen.queryByRole("list", { name: "Matching venues" })).not.toBeInTheDocument();
  });
});

describe("SCRUM254 request this venue from the event's search", () => {
  const COORDINATOR = "u-coord";
  const APPROVED = Object.freeze({
    ...EVENT,
    status: "approved",
    assignedCoordinatorId: COORDINATOR,
  });
  const PENDING_BOOKING = { id: "b1", status: "pending" };
  const NOT_APPROVED =
    /A venue can only be requested for an approved or confirmed event, including one under or past safety review\. This event is/;

  const requestButton = (name) =>
    screen.getByRole("button", { name: `Request this venue: ${name}` });
  const allRequestButtons = () => screen.getAllByRole("button", { name: /^Request this venue: / });
  const panel = (name) => screen.queryByRole("region", { name: `Request ${name}` });

  /** Renders the finder, searches, and waits for HALL and ANNEX. */
  async function searched(request = APPROVED, props = { userId: COORDINATOR }) {
    vi.mocked(findVenuesForEvent).mockResolvedValue([HALL, ANNEX]);
    const utils = renderFinder(request, props);
    await utils.user.click(searchButton());
    await screen.findByRole("heading", { name: "Hall A" });
    return utils;
  }

  it("SCRUM254_each_result_offers_a_request_button", async () => {
    await searched();
    expect(allRequestButtons()).toHaveLength(2);
    expect(requestButton("Hall A")).toHaveTextContent("Request this venue");
    expect(requestButton("Annex")).toHaveAttribute("type", "button");
  });

  it.each(["approved", "confirmed"])(
    "SCRUM254_enabled_for_the_assigned_coordinator_on_a_%s_event_with_no_reason",
    async (status) => {
      await searched({ ...APPROVED, status });
      for (const button of allRequestButtons()) expect(button).toBeEnabled();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    },
  );

  it.each([
    ["a submitted event", { ...APPROVED, status: "submitted" }, COORDINATOR, NOT_APPROVED],
    ["an event under review", { ...APPROVED, status: "under_review" }, COORDINATOR, /This event is under review\./],
    ["a different coordinator", APPROVED, "someone-else", /Only the coordinator assigned to this event/],
    ["no signed-in user", APPROVED, undefined, /Only the coordinator assigned to this event/],
    ["no proposed start", { ...APPROVED, proposedStart: null }, COORDINATOR, /no proposed start and end yet/],
    ["no proposed end", { ...APPROVED, proposedEnd: null }, COORDINATOR, /no proposed start and end yet/],
  ])("SCRUM254_disabled_with_the_reason_shown_once_for_%s", async (_label, request, userId, reason) => {
    vi.mocked(findVenuesForEvent).mockResolvedValue([HALL, ANNEX]);
    const { user } = renderFinder(request, { userId });
    // A missing start or end leaves the date blank, so fill it in to search.
    if (!request.proposedStart || !request.proposedEnd) {
      fireEvent.change(field.date(), { target: { value: START.date } });
      fireEvent.change(field.start(), { target: { value: START.time } });
      fireEvent.change(field.end(), { target: { value: END.time } });
    }
    await user.click(searchButton());
    await screen.findByRole("heading", { name: "Hall A" });

    for (const button of allRequestButtons()) expect(button).toBeDisabled();
    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toHaveTextContent(reason);
  });

  it("SCRUM254_no_reason_before_any_results", () => {
    renderFinder(EVENT);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("SCRUM254_clicking_opens_the_panel_for_that_venue_without_searching_again", async () => {
    const { user } = await searched();
    expect(findVenuesForEvent).toHaveBeenCalledTimes(1);

    await user.click(requestButton("Annex"));

    expect(screen.getByRole("heading", { name: "Request Annex" })).toBeInTheDocument();
    expect(panel("Annex")).toBeInTheDocument();
    expect(panel("Hall A")).not.toBeInTheDocument();
    expect(findVenuesForEvent).toHaveBeenCalledTimes(1);
    // The panel's own form is not nested in the search form.
    const searchForm = searchButton().closest("form");
    expect(searchForm.contains(panel("Annex"))).toBe(false);
  });

  // SCRUM-525 (AC1, R11): one live request per venue, so a send locks only
  // the venue it was for, whether or not the parent listens.
  it.each([
    ["with", true],
    ["without", false],
  ])("SCRUM525_AC1_a_sent_request_disables_only_that_venue (%s onRequestSubmitted)", async (_label, withCallback) => {
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING_BOOKING);
    const onRequestSubmitted = withCallback ? vi.fn() : undefined;
    const { user } = await searched(APPROVED, { userId: COORDINATOR, onRequestSubmitted });

    await user.click(requestButton("Hall A"));
    await user.click(within(panel("Hall A")).getByRole("button", { name: "Request this venue" }));

    await waitFor(() => expect(requestButton("Hall A")).toBeDisabled());
    expect(createBookingRequest).toHaveBeenCalledWith({ eventRequestId: "e1", venueId: "v1", expectedAttendance: 80 });
    if (withCallback) expect(onRequestSubmitted).toHaveBeenCalledWith(PENDING_BOOKING);
    expect(requestButton("Annex")).toBeEnabled();
    expect(requestButton("Hall A")).toHaveAccessibleDescription(/\(Pending\)/);
  });

  // SCRUM-525 (AC1, R3): a refusal names no venue, so the lock comes from the
  // panel that sent it, and only that venue is locked.
  it.each([
    ["BOOKING_REQUEST_EXISTS", null],
    ["BOOKING_FLAGGED_FOR_REVIEW", "Flagged for review"],
  ])("SCRUM525_AC1_%s_disables_only_the_venue_it_names", async (code, status) => {
    vi.mocked(createBookingRequest).mockRejectedValue(
      httpError(409, { error: "prose", code, conflicts: [{ kind: "booking_request", bookingId: "b9" }] }),
    );
    const onRequestSubmitted = vi.fn();
    const onVenueAlreadyRequested = vi.fn();
    const { user } = await searched(APPROVED, { userId: COORDINATOR, onRequestSubmitted, onVenueAlreadyRequested });

    await user.click(requestButton("Annex"));
    await user.click(within(panel("Annex")).getByRole("button", { name: "Request this venue" }));

    await waitFor(() => expect(requestButton("Annex")).toBeDisabled());
    expect(requestButton("Hall A")).toBeEnabled();
    expect(requestButton("Annex")).toHaveAccessibleDescription(
      status
        ? `This event already has a request for this venue (${status}). See it under Venue suitability above.`
        : "This event already has a request for this venue. See it under Venue suitability above.",
    );
    expect(onVenueAlreadyRequested).toHaveBeenCalledWith(code);
    expect(onRequestSubmitted).not.toHaveBeenCalled();
  });

  it("SCRUM254_cancel_closes_the_panel", async () => {
    const { user } = await searched();

    await user.click(requestButton("Hall A"));
    await user.click(within(panel("Hall A")).getByRole("button", { name: "Cancel" }));

    expect(panel("Hall A")).not.toBeInTheDocument();
    expect(requestButton("Hall A")).toBeEnabled();
  });

  it("SCRUM254_a_new_search_closes_an_open_panel", async () => {
    const { user } = await searched();

    await user.click(requestButton("Hall A"));
    expect(panel("Hall A")).toBeInTheDocument();
    await user.click(searchButton());

    await waitFor(() => expect(findVenuesForEvent).toHaveBeenCalledTimes(2));
    await screen.findByRole("heading", { name: "Hall A" });
    expect(panel("Hall A")).not.toBeInTheDocument();
  });

  // SCRUM-525 (AC1): the lock describes the event, not the results, so it
  // survives a new search, and stays on the one venue.
  it("SCRUM525_AC1_a_new_search_keeps_the_sent_venue_disabled", async () => {
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING_BOOKING);
    const { user } = await searched();

    await user.click(requestButton("Annex"));
    await user.click(within(panel("Annex")).getByRole("button", { name: "Request this venue" }));
    await waitFor(() => expect(requestButton("Annex")).toBeDisabled());
    await user.click(searchButton());

    await waitFor(() => expect(findVenuesForEvent).toHaveBeenCalledTimes(2));
    await screen.findByRole("heading", { name: "Annex" });
    expect(requestButton("Annex")).toBeDisabled();
    expect(requestButton("Hall A")).toBeEnabled();
  });

  // SCRUM-525 (AC1 "the existing one shown", R13): a venue the parent says
  // is already requested names the request's status and where it is listed.
  it("SCRUM525_AC1_a_requested_venue_points_to_its_existing_request", async () => {
    vi.mocked(checkVenueSuitability).mockResolvedValue({ suitable: true, criteria: [], checked: {} });
    const sentence = "This event already has a request for this venue (Pending). See it under Venue suitability above.";
    const { user } = await searched(APPROVED, { userId: COORDINATOR, liveRequests: new Map([["v2", "Pending"]]) });

    expect(requestButton("Annex")).toBeDisabled();
    expect(requestButton("Annex")).toHaveAccessibleDescription(sentence);
    expect(requestButton("Hall A")).toBeEnabled();
    expect(requestButton("Hall A")).toHaveAccessibleDescription("");
    // A hint, not an announcement.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    // Checked from its card, the venue is not offered in the panel either.
    await user.click(screen.getByRole("button", { name: "Check suitability: Annex" }));
    const check = screen.getByRole("region", { name: "Suitability of Annex" });
    await within(check).findByText(sentence);
    expect(within(check).queryByRole("button", { name: "Request this venue" })).not.toBeInTheDocument();
  });
});

describe("SCRUM491_AC5 the event's own hold does not hide a venue from its search", () => {
  it("SCRUM491_AC5_the_search_names_the_event_it_is_for", async () => {
    const { user } = renderFinder();
    await user.click(searchButton());

    const criteria = await sentCriteria();
    expect(criteria.eventRequestId).toBe(EVENT.id);
  });

  it("SCRUM491_AC5_without_an_event_id_none_is_sent", async () => {
    const { user } = renderFinder({ ...EVENT, id: undefined });
    await user.click(searchButton());

    const criteria = await sentCriteria();
    expect(criteria).not.toHaveProperty("eventRequestId");
  });
});

describe("SCRUM-191 check a venue's suitability from the event (SCRUM188_AC1/AC2)", () => {
  const COORDINATOR = "u-coord";
  const APPROVED = Object.freeze({
    ...EVENT,
    status: "approved",
    assignedCoordinatorId: COORDINATOR,
  });
  const STUDIO = { id: "v3", name: "Studio", location: "Block D", maxCapacity: 40 };

  const UNSUITABLE = {
    suitable: false,
    criteria: [
      { criterion: "Capacity", met: false, detail: "Capacity 40 < expected attendance 80" },
      { criterion: "Operating hours", met: true, detail: "Open" },
      { criterion: "Layout", met: true, detail: "Offered" },
      { criterion: "Accessibility", met: true, detail: "Provided" },
      { criterion: "Facilities", met: true, detail: "Provided" },
      { criterion: "Availability", met: true, detail: "Free" },
    ],
    checked: {
      startsAt: START_ISO,
      endsAt: END_ISO,
      expectedAttendance: 80,
      layout: "theatre",
      accessibility: ["hearing_loop"],
      facilities: ["projector"],
    },
  };

  const checkButton = (name) => screen.getByRole("button", { name: `Check suitability: ${name}` });
  const suitabilityPanel = (name) => screen.queryByRole("region", { name: `Suitability of ${name}` });
  const requestPanel = (name) => screen.queryByRole("region", { name: `Request ${name}` });
  const requestButton = (name) => screen.getByRole("button", { name: `Request this venue: ${name}` });
  const otherToggle = () => screen.getByRole("button", { name: "Check another venue" });

  /** Renders the finder, searches, and waits for HALL and ANNEX. */
  async function searched(request = APPROVED, props = { userId: COORDINATOR }) {
    vi.mocked(findVenuesForEvent).mockResolvedValue([HALL, ANNEX]);
    const utils = renderFinder(request, props);
    await utils.user.click(searchButton());
    await screen.findByRole("heading", { name: "Hall A" });
    return utils;
  }

  /** Ticks theatre, Hearing loop and Projector in the form. */
  async function pickCodes(user) {
    await user.selectOptions(field.layout(), "theatre");
    await user.click(within(group("Accessibility features")).getByLabelText("Hearing loop"));
    await user.click(within(group("Facilities")).getByLabelText("Projector"));
  }

  beforeEach(() => {
    vi.mocked(checkVenueSuitability).mockResolvedValue(UNSUITABLE);
  });

  it("SCRUM188_AC1_each_result_offers_check_suitability_as_a_non_submitting_button", async () => {
    await searched();
    expect(checkButton("Hall A")).toHaveAttribute("type", "button");
    expect(checkButton("Annex")).toBeEnabled();
  });

  it("SCRUM188_AC1_check_suitability_opens_the_panel_with_the_forms_codes", async () => {
    const { user } = await searched();
    await pickCodes(user);

    await user.click(checkButton("Hall A"));

    expect(suitabilityPanel("Hall A")).toBeInTheDocument();
    expect(await within(suitabilityPanel("Hall A")).findByText("Not suitable")).toBeInTheDocument();
    expect(checkVenueSuitability).toHaveBeenCalledWith("e1", "v1", {
      layout: "theatre",
      accessibility: ["hearing_loop"],
      facilities: ["projector"],
    });
    // No search is run, and the panel is not nested in the search form.
    expect(findVenuesForEvent).toHaveBeenCalledTimes(1);
    expect(searchButton().closest("form").contains(suitabilityPanel("Hall A"))).toBe(false);
  });

  it("SCRUM188_AC1_later_form_edits_do_not_change_the_checked_snapshot", async () => {
    const { user } = await searched();
    await pickCodes(user);
    await user.click(checkButton("Hall A"));
    await within(suitabilityPanel("Hall A")).findByText("Not suitable");

    // Edit the form after the check.
    await user.selectOptions(field.layout(), "banquet");
    await user.click(within(group("Facilities")).getByLabelText("Wi-Fi"));

    expect(checkVenueSuitability).toHaveBeenCalledTimes(1);
    expect(suitabilityPanel("Hall A")).toBeInTheDocument();

    // Requesting from the panel carries the codes that were checked.
    vi.mocked(createBookingRequest).mockResolvedValue({ id: "b1", status: "pending" });
    await user.click(within(suitabilityPanel("Hall A")).getByRole("button", { name: "Request this venue" }));
    await user.click(within(requestPanel("Hall A")).getByRole("checkbox"));
    await user.click(within(requestPanel("Hall A")).getByRole("button", { name: "Request this venue" }));

    await waitFor(() => expect(createBookingRequest).toHaveBeenCalledTimes(1));
    expect(createBookingRequest).toHaveBeenCalledWith({
      eventRequestId: "e1",
      venueId: "v1",
      roomLayoutCode: "theatre",
      accessibility: ["hearing_loop"],
      facilities: ["projector"],
      expectedAttendance: 80,
      confirmUnsuitable: true,
      acknowledgedCriteria: ["Capacity"],
    });
  });

  it("SCRUM188_AC1_checking_the_same_venue_again_takes_a_new_snapshot", async () => {
    const { user } = await searched();
    await user.click(checkButton("Hall A"));
    await within(suitabilityPanel("Hall A")).findByText("Not suitable");

    await user.selectOptions(field.layout(), "banquet");
    await user.click(checkButton("Hall A"));

    await waitFor(() => expect(checkVenueSuitability).toHaveBeenCalledTimes(2));
    expect(vi.mocked(checkVenueSuitability).mock.calls[1][2]).toMatchObject({ layout: "banquet" });
  });

  it.each([
    ["a different coordinator", "someone-else"],
    ["no signed-in user", undefined],
  ])("SCRUM188_AC1_check_buttons_are_disabled_for_%s", async (_label, userId) => {
    await searched(APPROVED, { userId });
    expect(checkButton("Hall A")).toBeDisabled();
    expect(checkButton("Annex")).toBeDisabled();
    expect(otherToggle()).toBeDisabled();
  });

  it("SCRUM188_AC1_check_another_venue_lists_only_active_venues_and_checks_the_chosen_one", async () => {
    vi.mocked(searchActiveVenues).mockResolvedValue([
      HALL,
      STUDIO,
      { id: "v9", name: "Old Wing", location: "Block Z", retiredAt: "2026-01-01T00:00:00Z" },
    ]);
    const { user } = renderFinder(APPROVED, { userId: COORDINATOR });
    expect(searchActiveVenues).not.toHaveBeenCalled();

    await user.click(otherToggle());
    const select = await screen.findByLabelText("Active venue");
    // Retired venues are never offered; the default search excludes them.
    expect(searchActiveVenues).toHaveBeenCalledWith();
    const options = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Choose a venue", "Hall A (Level 2)", "Studio (Block D)"]);

    const check = screen.getByRole("button", { name: "Check" });
    expect(check).toBeDisabled();
    await user.selectOptions(select, "v3");
    await user.click(check);

    expect(await within(suitabilityPanel("Studio")).findByText("Not suitable")).toBeInTheDocument();
    expect(checkVenueSuitability).toHaveBeenCalledWith("e1", "v3", {
      layout: "",
      accessibility: [],
      facilities: [],
    });
  });

  it("SCRUM188_AC1_the_active_venue_list_is_loaded_once", async () => {
    vi.mocked(searchActiveVenues).mockResolvedValue([STUDIO]);
    const { user } = renderFinder(APPROVED, { userId: COORDINATOR });

    await user.click(otherToggle());
    await screen.findByLabelText("Active venue");
    await user.click(otherToggle());
    await user.click(otherToggle());
    await screen.findByLabelText("Active venue");

    expect(searchActiveVenues).toHaveBeenCalledTimes(1);
  });

  it("SCRUM188_AC1_a_failed_venue_list_says_so_and_can_be_retried", async () => {
    vi.mocked(searchActiveVenues)
      .mockRejectedValueOnce(httpError(500, { error: "prose" }))
      .mockResolvedValueOnce([STUDIO]);
    const { user } = renderFinder(APPROVED, { userId: COORDINATOR });

    await user.click(otherToggle());
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the list of venues.");
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByLabelText("Active venue")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    ["an empty list", []],
    // A malformed response is treated as no venues rather than crashing.
    ["a malformed response", null],
  ])("SCRUM188_AC1_%s_says_there_are_no_active_venues_to_check", async (_label, rows) => {
    vi.mocked(searchActiveVenues).mockResolvedValue(rows);
    const { user } = renderFinder(APPROVED, { userId: COORDINATOR });

    await user.click(otherToggle());

    expect(await screen.findByText("There are no active venues to check.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Active venue")).not.toBeInTheDocument();
  });

  it("SCRUM188_AC1_a_venue_without_a_location_is_listed_by_name_alone", async () => {
    vi.mocked(searchActiveVenues).mockResolvedValue([{ id: "v4", name: "Rooftop", maxCapacity: 30 }]);
    const { user } = renderFinder(APPROVED, { userId: COORDINATOR });

    await user.click(otherToggle());
    const select = await screen.findByLabelText("Active venue");

    const options = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Choose a venue", "Rooftop"]);
  });

  it("SCRUM188_AC1_closing_the_other_venue_check_removes_its_panel", async () => {
    vi.mocked(searchActiveVenues).mockResolvedValue([STUDIO]);
    const { user } = renderFinder(APPROVED, { userId: COORDINATOR });
    await user.click(otherToggle());
    await user.selectOptions(await screen.findByLabelText("Active venue"), "v3");
    await user.click(screen.getByRole("button", { name: "Check" }));
    await within(suitabilityPanel("Studio")).findByText("Not suitable");

    await user.click(within(suitabilityPanel("Studio")).getByRole("button", { name: "Close" }));

    expect(suitabilityPanel("Studio")).not.toBeInTheDocument();
  });

  it("SCRUM191_only_one_panel_is_open_at_a_time", async () => {
    const { user } = await searched();

    await user.click(checkButton("Hall A"));
    expect(suitabilityPanel("Hall A")).toBeInTheDocument();

    await user.click(requestButton("Annex"));
    expect(requestPanel("Annex")).toBeInTheDocument();
    expect(suitabilityPanel("Hall A")).not.toBeInTheDocument();

    await user.click(checkButton("Annex"));
    expect(suitabilityPanel("Annex")).toBeInTheDocument();
    expect(requestPanel("Annex")).not.toBeInTheDocument();
  });

  it("SCRUM191_requesting_from_the_panel_opens_the_request_with_the_suitability_and_codes", async () => {
    const { user } = await searched();
    await pickCodes(user);
    await user.click(checkButton("Hall A"));
    await within(suitabilityPanel("Hall A")).findByText("Not suitable");

    await user.click(within(suitabilityPanel("Hall A")).getByRole("button", { name: "Request this venue" }));

    const panel = requestPanel("Hall A");
    expect(panel).toBeInTheDocument();
    expect(suitabilityPanel("Hall A")).not.toBeInTheDocument();
    // The unsuitable result is there up front, before any send.
    expect(within(panel).getByRole("alert")).toHaveTextContent("Capacity: Capacity 40 < expected attendance 80");
    expect(within(panel).getByRole("button", { name: "Request this venue" })).toBeDisabled();
  });

  it("SCRUM191_request_this_venue_is_hidden_in_the_panel_when_the_event_cannot_be_requested", async () => {
    const { user } = await searched({ ...APPROVED, status: "submitted" });
    await user.click(checkButton("Hall A"));
    await within(suitabilityPanel("Hall A")).findByText("Not suitable");

    expect(
      within(suitabilityPanel("Hall A")).queryByRole("button", { name: "Request this venue" }),
    ).not.toBeInTheDocument();
  });

  it("SCRUM191_a_request_straight_from_a_result_carries_the_forms_current_codes", async () => {
    vi.mocked(createBookingRequest).mockResolvedValue({ id: "b1", status: "pending" });
    const { user } = await searched();
    await pickCodes(user);

    await user.click(requestButton("Annex"));
    await user.click(within(requestPanel("Annex")).getByRole("button", { name: "Request this venue" }));

    await waitFor(() =>
      expect(createBookingRequest).toHaveBeenCalledWith({
        eventRequestId: "e1",
        venueId: "v2",
        roomLayoutCode: "theatre",
        accessibility: ["hearing_loop"],
        facilities: ["projector"],
        expectedAttendance: 80,
      }),
    );
    expect(checkVenueSuitability).not.toHaveBeenCalled();
  });

  it("SCRUM191_a_new_search_closes_an_open_check", async () => {
    const { user } = await searched();
    await user.click(checkButton("Hall A"));
    expect(suitabilityPanel("Hall A")).toBeInTheDocument();

    await user.click(searchButton());
    await waitFor(() => expect(findVenuesForEvent).toHaveBeenCalledTimes(2));
    expect(suitabilityPanel("Hall A")).not.toBeInTheDocument();
  });
});
