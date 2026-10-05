// VenueSearch.test.jsx
//
// The venue search page. First the behaviour it already had (SCRUM-45's
// seeded arrival, the banner, the empty and error states), pinned so the
// SCRUM-130 window cannot have changed it; then SCRUM-130 itself (part of
// SCRUM-17, AC2: "the blocked period is excluded from venue search results").
//
// venueService is mocked, so nothing touches the network. The page renders in
// a MemoryRouter beside a /review-queue probe, so "Back to event review" is
// checked by where it really lands.
//
// Timezone-safe: dates are built from fixed instants via toDatetimeLocalValue
// and set with fireEvent.change; payloads are checked by offset shape and
// getTime(); expected text comes from formatRange, never a hard-coded
// wall-clock string.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom";

import VenueSearch from "../../src/components/VenueSearch.jsx";
import { searchActiveVenues } from "../../src/services/venueService";
import { deviceTimeZoneLabel, toDatetimeLocalValue } from "../../src/services/datetimeFormat.js";
import { formatRange } from "../../src/services/displayFormat.js";
import { toCalendarDateParam } from "../../src/services/calendarRange.js";

vi.mock("../../src/services/venueService", () => ({
  searchActiveVenues: vi.fn(),
}));

const OFFSET_SUFFIX = /[+-]\d{2}:\d{2}$|Z$/;
const GENERIC_ERROR = "Could not load venues. Please try again.";
const EMPTY_STATE = "No active venues match your search.";

const HALL = { id: "v1", name: "Hall A", location: "Level 2", maxCapacity: 200 };
const ANNEX = { id: "v2", name: "Annex", location: "Block C", maxCapacity: 40 };

// Mid-November, clear of every DST change the test zones have.
const START_ISO = "2026-11-10T02:00:00Z";
const END_ISO = "2026-11-10T06:00:00Z";
const LATER_ISO = "2026-11-10T08:00:00Z";

function local(iso) {
  return toDatetimeLocalValue(iso);
}

function noteFor(startIso, endIso) {
  return `Venues blocked between ${formatRange(startIso, endIso)} are not shown.`;
}

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

function ReviewQueueProbe() {
  const location = useLocation();
  return <div data-testid="review-queue">{JSON.stringify(location.state)}</div>;
}

function CalendarProbe() {
  const { venueId } = useParams();
  const location = useLocation();
  return (
    <div data-testid="calendar-probe" data-search={location.search}>
      Calendar route for {venueId}
    </div>
  );
}

function renderSearch({ path = "/venue-search", state } = {}) {
  const user = userEvent.setup();
  const utils = render(
    <MemoryRouter initialEntries={[{ pathname: path.split("?")[0], search: path.includes("?") ? `?${path.split("?")[1]}` : "", state }]}>
      <Routes>
        <Route path="/venue-search" element={<VenueSearch />} />
        <Route path="/review-queue" element={<ReviewQueueProbe />} />
        <Route path="/venues/:venueId/calendar" element={<CalendarProbe />} />
      </Routes>
    </MemoryRouter>,
  );
  return { user, ...utils };
}

const fromInput = () => screen.getByLabelText("From");
const toInput = () => screen.getByLabelText("To");
const searchButton = () => screen.getByRole("button", { name: /Search venues|Searching/ });
const clearButton = () => screen.queryByRole("button", { name: "Clear dates" });
const note = () => document.querySelector(".venue-search__window-note");
const genericError = () => screen.queryByText(GENERIC_ERROR);

function setFrom(iso) {
  fireEvent.change(fromInput(), { target: { value: iso === "" ? "" : local(iso) } });
}
function setTo(iso) {
  fireEvent.change(toInput(), { target: { value: iso === "" ? "" : local(iso) } });
}

/** The <ul> of messages wired to an input by aria-describedby, or null. */
function errorListFor(input) {
  const id = input.getAttribute("aria-describedby");
  return id ? document.getElementById(id) : null;
}

beforeEach(() => {
  vi.mocked(searchActiveVenues).mockReset();
  vi.mocked(searchActiveVenues).mockResolvedValue([HALL]);
});

// ---------------------------------------------------------------------------
// Existing behaviour, pinned
// ---------------------------------------------------------------------------

describe("VenueSearch existing behaviour", () => {
  it("does not search on mount without a URL filter", async () => {
    renderSearch();
    await Promise.resolve();
    expect(searchActiveVenues).not.toHaveBeenCalled();
    expect(screen.queryByText(EMPTY_STATE)).not.toBeInTheDocument();
  });

  it("a dateless search sends exactly location and minCapacity, with no date keys", async () => {
    const { user } = renderSearch();
    await user.type(screen.getByPlaceholderText("Location"), "Level");
    await user.type(screen.getByPlaceholderText("Min capacity"), "50");
    await user.click(searchButton());

    expect(searchActiveVenues).toHaveBeenCalledTimes(1);
    const payload = searchActiveVenues.mock.calls[0][0];
    expect(payload).toStrictEqual({ location: "Level", minCapacity: 50 });
    expect(Object.keys(payload).sort()).toEqual(["location", "minCapacity"]);
    expect(await screen.findByText("Hall A")).toBeInTheDocument();
  });

  it("a search with nothing filled in sends undefined location and minCapacity only", async () => {
    const { user } = renderSearch();
    await user.click(searchButton());

    const payload = searchActiveVenues.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual(["location", "minCapacity"]);
    expect(payload).toStrictEqual({ location: undefined, minCapacity: undefined });
  });

  it("?minCapacity seeds the field and searches once on mount", async () => {
    const { user } = renderSearch({ path: "/venue-search?minCapacity=120" });

    expect(await screen.findByText("Hall A")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Min capacity")).toHaveValue(120);
    expect(searchActiveVenues).toHaveBeenCalledTimes(1);
    expect(searchActiveVenues.mock.calls[0][0]).toStrictEqual({ location: undefined, minCapacity: 120 });

    // Typing changes handleSearch's identity; the auto-search must not re-fire.
    await user.type(screen.getByPlaceholderText("Location"), "Lev");
    setFrom(START_ISO);
    expect(searchActiveVenues).toHaveBeenCalledTimes(1);
  });

  it("?location seeds the field and searches once on mount", async () => {
    renderSearch({ path: "/venue-search?location=Level" });

    expect(await screen.findByText("Hall A")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Location")).toHaveValue("Level");
    expect(searchActiveVenues).toHaveBeenCalledTimes(1);
    expect(searchActiveVenues.mock.calls[0][0]).toStrictEqual({ location: "Level", minCapacity: undefined });
  });

  it("dates are not read from the URL", async () => {
    renderSearch({ path: `/venue-search?startsAt=${encodeURIComponent(START_ISO)}&endsAt=${encodeURIComponent(END_ISO)}` });
    await Promise.resolve();
    expect(searchActiveVenues).not.toHaveBeenCalled();
    expect(fromInput()).toHaveValue("");
    expect(toInput()).toHaveValue("");
  });

  it("shows the event banner from router state, and no banner without it", async () => {
    const { unmount } = renderSearch({
      path: "/venue-search?minCapacity=80",
      state: { eventRequestContext: { eventName: "Tech Summit", venueRequirements: "tiered seating" } },
    });
    await screen.findByText("Hall A");
    expect(screen.getByText("Tech Summit")).toBeInTheDocument();
    expect(screen.getByText("tiered seating")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to event review" })).not.toBeInTheDocument();
    unmount();

    renderSearch();
    expect(screen.queryByText(/Finding a venue for/)).not.toBeInTheDocument();
  });

  it("Back to event review navigates to the review queue with its state", async () => {
    const returnToReview = { requestId: "r1", tab: "pending" };
    const { user } = renderSearch({
      path: "/venue-search?minCapacity=80",
      state: { eventRequestContext: { eventName: "Tech Summit" }, returnToReview },
    });
    await screen.findByText("Hall A");

    await user.click(screen.getByRole("button", { name: "Back to event review" }));

    const probe = await screen.findByTestId("review-queue");
    expect(JSON.parse(probe.textContent)).toEqual(returnToReview);
  });

  it("shows the empty state after a search with no results", async () => {
    vi.mocked(searchActiveVenues).mockResolvedValue([]);
    const { user } = renderSearch();
    expect(screen.queryByText(EMPTY_STATE)).not.toBeInTheDocument();

    await user.click(searchButton());

    expect(await screen.findByText(EMPTY_STATE)).toBeInTheDocument();
  });

  it("shows the generic error when the search fails", async () => {
    vi.mocked(searchActiveVenues).mockRejectedValue(httpError(500, {}));
    const { user } = renderSearch();

    await user.click(searchButton());

    expect(await screen.findByText(GENERIC_ERROR)).toBeInTheDocument();
  });

  it("a 400 naming only minCapacity still shows the generic message", async () => {
    vi.mocked(searchActiveVenues).mockRejectedValue(
      httpError(400, { details: [{ field: "minCapacity", message: "must be a positive whole number" }] }),
    );
    const { user } = renderSearch();

    await user.click(searchButton());

    expect(await screen.findByText(GENERIC_ERROR)).toBeInTheDocument();
    expect(screen.queryByText("must be a positive whole number")).not.toBeInTheDocument();
    expect(fromInput()).not.toHaveAttribute("aria-invalid");
    expect(toInput()).not.toHaveAttribute("aria-invalid");
  });

  it("a 400 with no details shows the generic message", async () => {
    vi.mocked(searchActiveVenues).mockRejectedValue(httpError(400, { error: "bad" }));
    const { user } = renderSearch();
    await user.click(searchButton());
    expect(await screen.findByText(GENERIC_ERROR)).toBeInTheDocument();
  });

  it("disables Search and shows Searching... while loading", async () => {
    const pending = deferred();
    vi.mocked(searchActiveVenues).mockReturnValue(pending.promise);
    const { user } = renderSearch();

    await user.click(searchButton());
    expect(screen.getByRole("button", { name: "Searching..." })).toBeDisabled();

    pending.resolve([HALL]);
    expect(await screen.findByRole("button", { name: "Search venues" })).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// SCRUM-130: the date window
// ---------------------------------------------------------------------------

describe("VenueSearch date window (SCRUM-130)", () => {
  it("SCRUM17_AC2_shows_the_device_time_zone_hint", () => {
    renderSearch();
    expect(
      screen.getByText(`Times are in your device's time zone (${deviceTimeZoneLabel()}).`),
    ).toBeInTheDocument();
  });

  it("SCRUM17_AC2_date_inputs_start_blank_with_no_error_wiring", () => {
    renderSearch();
    for (const input of [fromInput(), toInput()]) {
      expect(input).toHaveAttribute("type", "datetime-local");
      expect(input).toHaveValue("");
      expect(input).not.toHaveAttribute("aria-invalid");
      expect(input).not.toHaveAttribute("aria-describedby");
    }
  });

  it("SCRUM17_AC2_sends_the_window_as_offset_ISO_naming_the_entered_instants", async () => {
    const { user } = renderSearch();
    await user.type(screen.getByPlaceholderText("Location"), "Level");
    await user.type(screen.getByPlaceholderText("Min capacity"), "50");
    setFrom(START_ISO);
    setTo(END_ISO);
    await user.click(searchButton());

    expect(searchActiveVenues).toHaveBeenCalledTimes(1);
    const payload = searchActiveVenues.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual(["endsAt", "location", "minCapacity", "startsAt"]);
    expect(payload.location).toBe("Level");
    expect(payload.minCapacity).toBe(50);
    expect(payload.startsAt).toMatch(OFFSET_SUFFIX);
    expect(payload.endsAt).toMatch(OFFSET_SUFFIX);
    expect(new Date(payload.startsAt).getTime()).toBe(new Date(START_ISO).getTime());
    expect(new Date(payload.endsAt).getTime()).toBe(new Date(END_ISO).getTime());
  });

  it("SCRUM17_AC2_a_start_without_an_end_blocks_the_call_with_an_error_under_To", async () => {
    const { user } = renderSearch();
    setFrom(START_ISO);
    await user.click(searchButton());

    expect(searchActiveVenues).not.toHaveBeenCalled();
    const list = errorListFor(toInput());
    expect(list).not.toBeNull();
    expect(within(list).getByText("is required when a start is given")).toBeInTheDocument();
    expect(toInput()).toHaveAttribute("aria-invalid", "true");
    expect(fromInput()).not.toHaveAttribute("aria-invalid");
    expect(fromInput()).not.toHaveAttribute("aria-describedby");
  });

  it("SCRUM17_AC2_an_end_without_a_start_blocks_the_call_with_an_error_under_From", async () => {
    const { user } = renderSearch();
    setTo(END_ISO);
    await user.click(searchButton());

    expect(searchActiveVenues).not.toHaveBeenCalled();
    const list = errorListFor(fromInput());
    expect(within(list).getByText("is required when an end is given")).toBeInTheDocument();
    expect(fromInput()).toHaveAttribute("aria-invalid", "true");
    expect(toInput()).not.toHaveAttribute("aria-invalid");
  });

  it("SCRUM17_AC2_a_reversed_window_blocks_the_call", async () => {
    const { user } = renderSearch();
    setFrom(END_ISO);
    setTo(START_ISO);
    await user.click(searchButton());

    expect(searchActiveVenues).not.toHaveBeenCalled();
    expect(within(errorListFor(toInput())).getByText("must be later than the start")).toBeInTheDocument();
  });

  it("SCRUM17_AC2_an_equal_window_blocks_the_call", async () => {
    const { user } = renderSearch();
    setFrom(START_ISO);
    setTo(START_ISO);
    await user.click(searchButton());

    expect(searchActiveVenues).not.toHaveBeenCalled();
    expect(within(errorListFor(toInput())).getByText("must be later than the start")).toBeInTheDocument();
  });

  it("SCRUM17_AC2_a_blocked_call_keeps_the_previous_results", async () => {
    vi.mocked(searchActiveVenues).mockResolvedValue([HALL, ANNEX]);
    const { user } = renderSearch();
    await user.click(searchButton());
    await screen.findByText("Annex");

    setFrom(START_ISO);
    await user.click(searchButton());

    expect(searchActiveVenues).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Hall A")).toBeInTheDocument();
    expect(screen.getByText("Annex")).toBeInTheDocument();
  });

  it("SCRUM17_AC2_a_blocked_call_clears_a_stale_generic_error", async () => {
    vi.mocked(searchActiveVenues).mockRejectedValue(httpError(500, {}));
    const { user } = renderSearch();
    await user.click(searchButton());
    await screen.findByText(GENERIC_ERROR);

    setFrom(START_ISO);
    await user.click(searchButton());

    expect(searchActiveVenues).toHaveBeenCalledTimes(1);
    expect(genericError()).not.toBeInTheDocument();
    expect(screen.getByText("is required when a start is given")).toBeInTheDocument();
  });

  it("SCRUM17_AC2_editing_To_clears_its_client_error", async () => {
    const { user } = renderSearch();
    setFrom(START_ISO);
    await user.click(searchButton());
    expect(screen.getByText("is required when a start is given")).toBeInTheDocument();

    setTo(END_ISO);

    expect(screen.queryByText("is required when a start is given")).not.toBeInTheDocument();
    expect(toInput()).not.toHaveAttribute("aria-invalid");
    expect(toInput()).not.toHaveAttribute("aria-describedby");
  });

  it("SCRUM17_AC2_editing_From_does_not_clear_an_error_on_To", async () => {
    const { user } = renderSearch();
    setFrom(END_ISO);
    setTo(START_ISO);
    await user.click(searchButton());
    expect(screen.getByText("must be later than the start")).toBeInTheDocument();

    // A From edit retires From's errors only, even if it would fix the window.
    setFrom("2026-11-09T00:00:00Z");

    expect(screen.getByText("must be later than the start")).toBeInTheDocument();
    expect(toInput()).toHaveAttribute("aria-invalid", "true");
  });

  it("SCRUM17_AC2_editing_From_clears_only_From_errors_from_the_server_and_To_only_To", async () => {
    vi.mocked(searchActiveVenues).mockRejectedValue(
      httpError(400, {
        details: [
          { field: "startsAt", message: "server start fault" },
          { field: "endsAt", message: "server end fault" },
        ],
      }),
    );
    const { user } = renderSearch();
    setFrom(START_ISO);
    setTo(END_ISO);
    await user.click(searchButton());
    expect(await screen.findByText("server start fault")).toBeInTheDocument();
    expect(screen.getByText("server end fault")).toBeInTheDocument();
    expect(genericError()).not.toBeInTheDocument();

    setFrom("2026-11-10T01:00:00Z");
    expect(screen.queryByText("server start fault")).not.toBeInTheDocument();
    expect(screen.getByText("server end fault")).toBeInTheDocument();
    expect(fromInput()).not.toHaveAttribute("aria-invalid");
    expect(toInput()).toHaveAttribute("aria-invalid", "true");

    setTo(LATER_ISO);
    expect(screen.queryByText("server end fault")).not.toBeInTheDocument();
    expect(toInput()).not.toHaveAttribute("aria-invalid");
  });

  it("SCRUM17_AC2_server_endsAt_details_show_under_To_with_no_generic_banner_and_results_kept", async () => {
    const { user } = renderSearch();
    await user.click(searchButton());
    await screen.findByText("Hall A");

    vi.mocked(searchActiveVenues).mockRejectedValue(
      httpError(400, {
        details: [
          { field: "endsAt", message: "must be later than the start" },
          { field: "minCapacity", message: "must be a positive whole number" },
        ],
      }),
    );
    setFrom(START_ISO);
    setTo(END_ISO);
    await user.click(searchButton());

    const list = await waitFor(() => {
      const found = errorListFor(toInput());
      expect(found).not.toBeNull();
      return found;
    });
    expect(within(list).getByText("must be later than the start")).toBeInTheDocument();
    expect(toInput()).toHaveAttribute("aria-invalid", "true");
    expect(fromInput()).not.toHaveAttribute("aria-invalid");
    expect(genericError()).not.toBeInTheDocument();
    expect(screen.queryByText("must be a positive whole number")).not.toBeInTheDocument();
    expect(screen.getByText("Hall A")).toBeInTheDocument();
  });

  it("SCRUM17_AC2_the_error_list_is_what_aria_describedby_points_at", async () => {
    const { user } = renderSearch();
    setFrom(START_ISO);
    await user.click(searchButton());

    const id = toInput().getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    const list = document.getElementById(id);
    expect(list.tagName).toBe("UL");
    expect(list).toHaveTextContent("is required when a start is given");
  });

  it("SCRUM17_AC2_a_new_valid_search_clears_old_field_errors", async () => {
    const { user } = renderSearch();
    setFrom(START_ISO);
    await user.click(searchButton());
    expect(screen.getByText("is required when a start is given")).toBeInTheDocument();

    fireEvent.change(fromInput(), { target: { value: "" } });
    await user.click(searchButton());

    expect(searchActiveVenues).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("is required when a start is given")).not.toBeInTheDocument();
  });

  describe("the blocked-venues note", () => {
    it("SCRUM17_AC2_appears_after_a_successful_dated_search_as_one_text_node", async () => {
      const { user } = renderSearch();
      setFrom(START_ISO);
      setTo(END_ISO);
      expect(note()).toBeNull();

      await user.click(searchButton());

      const expected = noteFor(START_ISO, END_ISO);
      const p = await screen.findByText(expected);
      expect(p).toHaveAttribute("role", "status");
      expect(p.childNodes).toHaveLength(1);
      expect(p.firstChild.nodeType).toBe(Node.TEXT_NODE);
      expect(p.textContent).toBe(expected);
    });

    it("SCRUM17_AC2_does_not_appear_from_typing_alone", () => {
      renderSearch();
      setFrom(START_ISO);
      setTo(END_ISO);
      expect(note()).toBeNull();
    });

    it("SCRUM17_AC2_does_not_appear_after_a_dateless_search", async () => {
      const { user } = renderSearch();
      await user.click(searchButton());
      await screen.findByText("Hall A");
      expect(note()).toBeNull();
    });

    it("SCRUM17_AC2_describes_the_search_that_ran_not_the_inputs", async () => {
      const { user } = renderSearch();
      setFrom(START_ISO);
      setTo(END_ISO);
      await user.click(searchButton());
      await screen.findByText(noteFor(START_ISO, END_ISO));

      setTo(LATER_ISO);
      expect(screen.getByText(noteFor(START_ISO, END_ISO))).toBeInTheDocument();
      expect(screen.queryByText(noteFor(START_ISO, LATER_ISO))).not.toBeInTheDocument();

      await user.click(searchButton());
      expect(await screen.findByText(noteFor(START_ISO, LATER_ISO))).toBeInTheDocument();
      expect(screen.queryByText(noteFor(START_ISO, END_ISO))).not.toBeInTheDocument();
    });

    it("SCRUM17_AC2_disappears_after_a_successful_dateless_search", async () => {
      const { user } = renderSearch();
      setFrom(START_ISO);
      setTo(END_ISO);
      await user.click(searchButton());
      await screen.findByText(noteFor(START_ISO, END_ISO));

      fireEvent.change(fromInput(), { target: { value: "" } });
      fireEvent.change(toInput(), { target: { value: "" } });
      await user.click(searchButton());

      await waitFor(() => expect(searchActiveVenues).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(note()).toBeNull());
    });

    it("SCRUM17_AC2_survives_a_failed_search", async () => {
      const { user } = renderSearch();
      setFrom(START_ISO);
      setTo(END_ISO);
      await user.click(searchButton());
      await screen.findByText(noteFor(START_ISO, END_ISO));

      vi.mocked(searchActiveVenues).mockRejectedValue(httpError(500, {}));
      fireEvent.change(fromInput(), { target: { value: "" } });
      fireEvent.change(toInput(), { target: { value: "" } });
      await user.click(searchButton());

      expect(await screen.findByText(GENERIC_ERROR)).toBeInTheDocument();
      expect(screen.getByText(noteFor(START_ISO, END_ISO))).toBeInTheDocument();
    });

    it("SCRUM17_AC2_survives_a_client_blocked_search", async () => {
      const { user } = renderSearch();
      setFrom(START_ISO);
      setTo(END_ISO);
      await user.click(searchButton());
      await screen.findByText(noteFor(START_ISO, END_ISO));

      fireEvent.change(toInput(), { target: { value: "" } });
      await user.click(searchButton());

      expect(searchActiveVenues).toHaveBeenCalledTimes(1);
      expect(screen.getByText(noteFor(START_ISO, END_ISO))).toBeInTheDocument();
    });
  });

  describe("Clear dates", () => {
    it("SCRUM17_AC2_is_hidden_when_both_dates_are_blank", () => {
      renderSearch();
      expect(clearButton()).not.toBeInTheDocument();
    });

    it("SCRUM17_AC2_appears_when_either_date_is_set", () => {
      renderSearch();
      setFrom(START_ISO);
      expect(clearButton()).toBeInTheDocument();
      fireEvent.change(fromInput(), { target: { value: "" } });
      expect(clearButton()).not.toBeInTheDocument();
      setTo(END_ISO);
      expect(clearButton()).toBeInTheDocument();
    });

    it("SCRUM17_AC2_resets_both_dates_and_their_errors_without_searching", async () => {
      const { user } = renderSearch();
      await user.type(screen.getByPlaceholderText("Location"), "Level");
      setFrom(START_ISO);
      await user.click(searchButton());
      expect(screen.getByText("is required when a start is given")).toBeInTheDocument();

      await user.click(clearButton());

      expect(searchActiveVenues).not.toHaveBeenCalled();
      expect(fromInput()).toHaveValue("");
      expect(toInput()).toHaveValue("");
      expect(screen.getByPlaceholderText("Location")).toHaveValue("Level");
      expect(screen.queryByText("is required when a start is given")).not.toBeInTheDocument();
      expect(toInput()).not.toHaveAttribute("aria-invalid");
      expect(toInput()).not.toHaveAttribute("aria-describedby");
      expect(clearButton()).not.toBeInTheDocument();
    });

    it("SCRUM17_AC2_clears_server_date_errors_too", async () => {
      vi.mocked(searchActiveVenues).mockRejectedValue(
        httpError(400, { details: [{ field: "startsAt", message: "server start fault" }] }),
      );
      const { user } = renderSearch();
      setFrom(START_ISO);
      setTo(END_ISO);
      await user.click(searchButton());
      await screen.findByText("server start fault");

      await user.click(clearButton());

      expect(screen.queryByText("server start fault")).not.toBeInTheDocument();
      expect(fromInput()).not.toHaveAttribute("aria-invalid");
      expect(searchActiveVenues).toHaveBeenCalledTimes(1);
    });

    it("SCRUM17_AC2_leaves_the_note_until_the_next_successful_search", async () => {
      const { user } = renderSearch();
      setFrom(START_ISO);
      setTo(END_ISO);
      await user.click(searchButton());
      await screen.findByText(noteFor(START_ISO, END_ISO));

      await user.click(clearButton());
      expect(screen.getByText(noteFor(START_ISO, END_ISO))).toBeInTheDocument();
      expect(searchActiveVenues).toHaveBeenCalledTimes(1);

      await user.click(searchButton());
      await waitFor(() => expect(searchActiveVenues).toHaveBeenCalledTimes(2));
      const payload = searchActiveVenues.mock.calls[1][0];
      expect(Object.keys(payload).sort()).toEqual(["location", "minCapacity"]);
      await waitFor(() => expect(note()).toBeNull());
    });
  });

  it("SCRUM17_AC2_date_inputs_and_Clear_dates_are_disabled_while_loading", async () => {
    const pending = deferred();
    vi.mocked(searchActiveVenues).mockReturnValue(pending.promise);
    const { user } = renderSearch();
    setFrom(START_ISO);
    setTo(END_ISO);
    expect(fromInput()).toBeEnabled();
    expect(clearButton()).toBeEnabled();

    await user.click(searchButton());

    expect(fromInput()).toBeDisabled();
    expect(toInput()).toBeDisabled();
    expect(clearButton()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Searching..." })).toBeDisabled();

    pending.resolve([HALL]);
    await screen.findByText("Hall A");
    expect(fromInput()).toBeEnabled();
    expect(toInput()).toBeEnabled();
    expect(clearButton()).toBeEnabled();
  });

  it("SCRUM17_AC2_inputs_re_enable_after_a_failed_search", async () => {
    const pending = deferred();
    vi.mocked(searchActiveVenues).mockReturnValue(pending.promise);
    const { user } = renderSearch();
    setFrom(START_ISO);
    setTo(END_ISO);
    await user.click(searchButton());
    expect(fromInput()).toBeDisabled();

    pending.reject(httpError(500, {}));
    await screen.findByText(GENERIC_ERROR);
    expect(fromInput()).toBeEnabled();
    expect(toInput()).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// SCRUM-181: each result links to its venue's calendar
// ---------------------------------------------------------------------------

describe("VenueSearch View calendar (SCRUM-181)", () => {
  const resultFor = (name) => screen.getByText(name).closest("li");
  const calendarLink = (name) => within(resultFor(name)).getByRole("link", { name: "View calendar" });

  it("SCRUM178_AC1_each_result_links_to_its_own_calendar", async () => {
    vi.mocked(searchActiveVenues).mockResolvedValue([HALL, ANNEX]);
    const { user } = renderSearch();
    await user.click(searchButton());
    await screen.findByText("Hall A");

    expect(screen.getAllByRole("link", { name: "View calendar" })).toHaveLength(2);
    expect(calendarLink("Hall A")).toHaveAttribute("href", `/venues/${HALL.id}/calendar`);
    expect(calendarLink("Annex")).toHaveAttribute("href", `/venues/${ANNEX.id}/calendar`);
  });

  it("SCRUM178_AC1_without_an_applied_window_the_link_has_no_query", async () => {
    const { user } = renderSearch();
    await user.click(searchButton());
    await screen.findByText("Hall A");

    const href = calendarLink("Hall A").getAttribute("href");
    expect(href).toBe(`/venues/${HALL.id}/calendar`);
    expect(href).not.toContain("?");
  });

  it("SCRUM178_AC1_typing_a_window_without_searching_adds_no_query", async () => {
    const { user } = renderSearch();
    await user.click(searchButton());
    await screen.findByText("Hall A");

    // The link follows the window behind the results, not the inputs.
    setFrom(START_ISO);
    setTo(END_ISO);
    expect(calendarLink("Hall A")).toHaveAttribute("href", `/venues/${HALL.id}/calendar`);
  });

  it("SCRUM178_AC1_with_an_applied_window_the_link_carries_its_start_date", async () => {
    vi.mocked(searchActiveVenues).mockResolvedValue([HALL, ANNEX]);
    const { user } = renderSearch();
    setFrom(START_ISO);
    setTo(END_ISO);
    await user.click(searchButton());
    await screen.findByText("Hall A");

    // The local day of the window's start, whatever zone the test runs in.
    const expectedDate = toCalendarDateParam(new Date(START_ISO));
    expect(expectedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(calendarLink("Hall A")).toHaveAttribute("href", `/venues/${HALL.id}/calendar?date=${expectedDate}`);
    expect(calendarLink("Annex")).toHaveAttribute("href", `/venues/${ANNEX.id}/calendar?date=${expectedDate}`);
  });

  it("SCRUM178_AC1_a_window_starting_late_in_the_local_day_keeps_that_local_date", async () => {
    // 23:30 local on 9 Nov is still 9 Nov here, even where UTC says 10 Nov.
    const lateStart = new Date(2026, 10, 9, 23, 30).toISOString();
    const lateEnd = new Date(2026, 10, 10, 1, 30).toISOString();
    const { user } = renderSearch();
    setFrom(lateStart);
    setTo(lateEnd);
    await user.click(searchButton());
    await screen.findByText("Hall A");

    expect(calendarLink("Hall A")).toHaveAttribute("href", `/venues/${HALL.id}/calendar?date=2026-11-09`);
  });

  it("SCRUM178_AC1_a_later_dateless_search_drops_the_query", async () => {
    const { user } = renderSearch();
    setFrom(START_ISO);
    setTo(END_ISO);
    await user.click(searchButton());
    await screen.findByText("Hall A");
    expect(calendarLink("Hall A").getAttribute("href")).toContain("?date=");

    await user.click(screen.getByRole("button", { name: "Clear dates" }));
    await user.click(searchButton());
    await waitFor(() => expect(searchActiveVenues).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(calendarLink("Hall A")).toHaveAttribute("href", `/venues/${HALL.id}/calendar`),
    );
  });

  it("SCRUM178_AC1_clicking_it_lands_on_the_calendar_route_with_the_date", async () => {
    const { user } = renderSearch();
    setFrom(START_ISO);
    setTo(END_ISO);
    await user.click(searchButton());
    await screen.findByText("Hall A");

    await user.click(calendarLink("Hall A"));

    const probe = await screen.findByTestId("calendar-probe");
    expect(probe).toHaveTextContent(`Calendar route for ${HALL.id}`);
    expect(probe).toHaveAttribute("data-search", `?date=${toCalendarDateParam(new Date(START_ISO))}`);
  });
});
