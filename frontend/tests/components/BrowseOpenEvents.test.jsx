// The Attendee's list of open events, with the service mocked. Times are
// Singapore time (09:00 for 01:00Z) whatever the machine's zone.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import BrowseOpenEvents from "../../src/components/BrowseOpenEvents.jsx";
import { getOpenEvents } from "../../src/services/openEventService";

vi.mock("../../src/services/openEventService", () => ({
  getOpenEvents: vi.fn(),
}));

function event(overrides = {}) {
  return {
    id: "e1",
    eventName: "Open Day",
    description: "Come along.",
    startsAt: "2026-10-25T01:00:00.000Z",
    endsAt: "2026-10-25T03:30:00.000Z",
    capacity: 50,
    placesLeft: 12,
    isFull: false,
    isRegistered: false,
    canRegister: true,
    ...overrides,
  };
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/open-events"]}>
      <Routes>
        <Route path="/open-events" element={<BrowseOpenEvents />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

const rowFor = (name) => screen.getByRole("link", { name }).closest("li");

beforeEach(() => {
  vi.mocked(getOpenEvents).mockReset();
});

describe("SCRUM495 loading and empty states", () => {
  it("SCRUM495_AC7_says_it_is_loading_while_the_list_is_on_its_way", () => {
    vi.mocked(getOpenEvents).mockReturnValue(new Promise(() => {}));

    renderPage();

    expect(screen.getByRole("status")).toHaveTextContent("Loading...");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("SCRUM495_AC7_says_so_when_no_event_is_open", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([]);

    renderPage();

    expect(await screen.findByText("No events are currently open for registration.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("SCRUM495_AC3 what each row shows", () => {
  it("SCRUM495_AC3_shows_the_name_date_start_and_end_times_and_the_places_left", async () => {
    const e = event();
    vi.mocked(getOpenEvents).mockResolvedValue([e]);

    renderPage();

    const row = within(await screen.findByRole("list")).getByRole("listitem");
    expect(within(row).getByRole("link", { name: "Open Day" })).toBeInTheDocument();
    expect(row).toHaveTextContent("2026-10-25");
    expect(row).toHaveTextContent("Starts 09:00");
    expect(row).toHaveTextContent("Ends 11:30");
    expect(row).toHaveTextContent("12 places left");
  });

  it("SCRUM495_AC3_reads_one_place_as_1_place_left", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([event({ placesLeft: 1 })]);

    renderPage();

    expect(await screen.findByText("1 place left")).toBeInTheDocument();
  });

  it("SCRUM495_AC3_shows_no_limit_for_an_event_with_no_capacity", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([event({ capacity: null, placesLeft: null })]);

    renderPage();

    expect(await screen.findByText("No limit")).toBeInTheDocument();
    expect(screen.queryByText(/places? left/)).not.toBeInTheDocument();
  });

  it("SCRUM495_AC3_keeps_a_full_event_in_the_list_marked_full_never_as_a_number", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([
      event({ id: "e2", eventName: "Packed Hall", capacity: 5, placesLeft: 0, isFull: true, canRegister: false }),
    ]);

    renderPage();

    await screen.findByRole("list");
    const row = rowFor("Packed Hall");
    expect(within(row).getByText("Full")).toBeInTheDocument();
    expect(row).not.toHaveTextContent(/places? left/);
    expect(row).not.toHaveTextContent("No limit");
  });

  it("SCRUM495_AC3_marks_an_event_the_caller_has_joined_as_registered_and_no_other", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([
      event({ id: "e1", eventName: "Joined", isRegistered: true, canRegister: false }),
      event({ id: "e2", eventName: "Not joined" }),
    ]);

    renderPage();

    await screen.findByRole("list");
    expect(within(rowFor("Joined")).getByText("Registered")).toBeInTheDocument();
    expect(within(rowFor("Not joined")).queryByText("Registered")).not.toBeInTheDocument();
  });

  it("SCRUM495_AC3_shows_a_full_event_the_caller_has_joined_as_both_full_and_registered", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([
      event({ eventName: "Both", placesLeft: 0, isFull: true, isRegistered: true, canRegister: false }),
    ]);

    renderPage();

    await screen.findByRole("list");
    const row = rowFor("Both");
    expect(within(row).getByText("Full")).toBeInTheDocument();
    expect(within(row).getByText("Registered")).toBeInTheDocument();
  });

  it("SCRUM495_AC3_shows_the_end_date_as_well_when_the_event_ends_on_a_later_day", async () => {
    const e = event({ startsAt: "2026-10-25T10:00:00.000Z", endsAt: "2026-10-27T10:00:00.000Z" });
    vi.mocked(getOpenEvents).mockResolvedValue([e]);

    renderPage();

    const row = within(await screen.findByRole("list")).getByRole("listitem");
    expect(row).toHaveTextContent("2026-10-27");
  });

  it("SCRUM495_AC3_shows_a_nameless_event_as_an_unnamed_event", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([event({ eventName: "" })]);

    renderPage();

    expect(await screen.findByRole("link", { name: "Unnamed event" })).toBeInTheDocument();
  });

  it("SCRUM495_AC3_falls_back_to_plain_words_for_a_missing_or_unreadable_date_or_time", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([event({ startsAt: null, endsAt: "later" })]);

    renderPage();

    const row = within(await screen.findByRole("list")).getByRole("listitem");
    expect(row).toHaveTextContent("Date to be confirmed");
    expect(row).toHaveTextContent("Starts Not set");
    expect(row).toHaveTextContent("Ends Not set");
  });
});

describe("SCRUM495_AC4 order", () => {
  it("SCRUM495_AC4_shows_the_events_in_the_order_the_server_sent_them", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([
      event({ id: "a", eventName: "Earliest" }),
      event({ id: "b", eventName: "Middle" }),
      event({ id: "c", eventName: "Latest" }),
    ]);

    renderPage();

    const rows = within(await screen.findByRole("list")).getAllByRole("listitem");
    expect(rows.map((row) => within(row).getByRole("link").textContent)).toEqual(["Earliest", "Middle", "Latest"]);
  });
});

describe("SCRUM495_AC5 selecting an event", () => {
  it("SCRUM495_AC5_goes_to_that_event_s_browse_details_route", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([event({ id: "abc-123", eventName: "Open Day" })]);

    renderPage();

    const link = await screen.findByRole("link", { name: "Open Day" });
    expect(link).toHaveAttribute("href", "/open-events/abc-123");

    await userEvent.click(link);

    expect(screen.getByTestId("where")).toHaveTextContent("/open-events/abc-123");
  });

  it("SCRUM495_AC5_encodes_the_id_so_an_odd_id_cannot_change_the_path", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([event({ id: "a/b?c", eventName: "Odd" })]);

    renderPage();

    expect(await screen.findByRole("link", { name: "Odd" })).toHaveAttribute("href", "/open-events/a%2Fb%3Fc");
  });
});

describe("SCRUM495_AC8 no internal planning information", () => {
  it("SCRUM495_AC8_shows_no_description_venue_or_capacity_figure_on_the_list", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([
      event({ venueName: "Grand Hall", venue_requirements: "Main hall", coordinatorName: "Casey" }),
    ]);

    renderPage();

    const row = within(await screen.findByRole("list")).getByRole("listitem");
    expect(row).not.toHaveTextContent("Grand Hall");
    expect(row).not.toHaveTextContent("Main hall");
    expect(row).not.toHaveTextContent("Casey");
    expect(row).not.toHaveTextContent("Come along.");
  });
});

describe("SCRUM495 errors and retry", () => {
  it.each([
    [401, "Your session has expired. Please sign in again."],
    [403, "Only Attendees can browse open events."],
    [500, "Open events could not be loaded. Please try again."],
    [503, "Event registration is temporarily unavailable. Please try again later."],
  ])("SCRUM495_AC2_explains_a_%i", async (status, message) => {
    vi.mocked(getOpenEvents).mockRejectedValue({ response: { status } });

    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText("No events are currently open for registration.")).not.toBeInTheDocument();
  });

  it("SCRUM495_AC2_gives_a_general_message_when_there_is_no_response_at_all", async () => {
    vi.mocked(getOpenEvents).mockRejectedValue(new Error("Network Error"));

    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("Open events could not be loaded. Please try again.");
  });

  it("SCRUM495_AC2_loads_again_on_try_again_and_shows_the_list_when_it_works", async () => {
    vi.mocked(getOpenEvents)
      .mockRejectedValueOnce({ response: { status: 500 } })
      .mockResolvedValueOnce([event({ eventName: "Back again" })]);

    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("link", { name: "Back again" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(getOpenEvents).toHaveBeenCalledTimes(2);
  });
});


// ---------------------------------------------------------------------------
// Refresh and stale state
// ---------------------------------------------------------------------------

const returnToTab = () => fireEvent(window, new Event("focus"));

function pending() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SCRUM495_AC6_AC7_AC8 the list is refreshed from the server", () => {
  it("SCRUM495_AC6_AC7_AC8_drops_an_event_that_is_no_longer_open_and_keeps_the_rest_when_the_reader_returns", async () => {
    vi.mocked(getOpenEvents).mockResolvedValueOnce([
      event({ id: "a", eventName: "Stays" }),
      event({ id: "b", eventName: "Goes back to Approved" }),
    ]).mockResolvedValueOnce([event({ id: "a", eventName: "Stays" })]);

    renderPage();
    await screen.findByRole("link", { name: "Goes back to Approved" });

    returnToTab();

    await waitFor(() => expect(screen.queryByRole("link", { name: "Goes back to Approved" })).not.toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Stays" })).toBeInTheDocument();
  });

  it("SCRUM495_AC6_AC7_AC8_shows_the_empty_message_when_the_refresh_finds_nothing_open", async () => {
    vi.mocked(getOpenEvents).mockResolvedValueOnce([event()]).mockResolvedValueOnce([]);

    renderPage();
    await screen.findByRole("link", { name: "Open Day" });

    returnToTab();

    expect(await screen.findByText("No events are currently open for registration.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("SCRUM495_AC6_AC7_AC8_brings_an_event_back_after_reconfirmation_with_the_registration_it_already_had", async () => {
    vi.mocked(getOpenEvents)
      .mockResolvedValueOnce([event({ id: "a", eventName: "Gala", isRegistered: true, canRegister: false })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([event({ id: "a", eventName: "Gala", isRegistered: true, canRegister: false })]);

    renderPage();
    await screen.findByRole("link", { name: "Gala" });
    returnToTab();
    await screen.findByText("No events are currently open for registration.");
    returnToTab();

    const row = (await screen.findByRole("link", { name: "Gala" })).closest("li");
    expect(within(row).getByText("Registered")).toBeInTheDocument();
  });

  it("SCRUM495_AC6_AC7_AC8_shows_new_availability_and_a_new_registered_mark_after_the_reader_returns_from_registering", async () => {
    vi.mocked(getOpenEvents)
      .mockResolvedValueOnce([event({ placesLeft: 1 })])
      .mockResolvedValueOnce([event({ placesLeft: 0, isFull: true, isRegistered: true, canRegister: false })]);

    renderPage();
    await screen.findByText("1 place left");

    returnToTab();

    const row = (await screen.findByText("Full")).closest("li");
    expect(within(row).getByText("Registered")).toBeInTheDocument();
    expect(screen.queryByText("1 place left")).not.toBeInTheDocument();
  });

  it("SCRUM495_AC6_AC7_AC8_does_not_blank_the_list_while_it_refreshes", async () => {
    const refresh = pending();
    vi.mocked(getOpenEvents).mockResolvedValueOnce([event()]).mockReturnValueOnce(refresh.promise);

    renderPage();
    await screen.findByRole("link", { name: "Open Day" });

    returnToTab();

    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Day" })).toBeInTheDocument();
    refresh.resolve([event({ eventName: "Renamed" })]);
    expect(await screen.findByRole("link", { name: "Renamed" })).toBeInTheDocument();
  });

  it("SCRUM495_AC6_AC7_AC8_keeps_the_last_list_with_a_notice_when_a_refresh_cannot_reach_the_server_and_recovers_on_try_again", async () => {
    vi.mocked(getOpenEvents)
      .mockResolvedValueOnce([event()])
      .mockRejectedValueOnce({ response: { status: 500 } })
      .mockResolvedValueOnce([event({ eventName: "Fresh" })]);

    renderPage();
    await screen.findByRole("link", { name: "Open Day" });
    returnToTab();

    expect(await screen.findByText(/Could not refresh the list/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Day" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("link", { name: "Fresh" })).toBeInTheDocument();
    expect(screen.queryByText(/Could not refresh the list/)).not.toBeInTheDocument();
  });

  it.each([
    [401, "Your session has expired. Please sign in again."],
    [403, "Only Attendees can browse open events."],
  ])("SCRUM495_AC6_AC7_AC8_replaces_the_list_with_the_error_when_a_refresh_is_refused_with_%i", async (status, message) => {
    vi.mocked(getOpenEvents)
      .mockResolvedValueOnce([event()])
      .mockRejectedValueOnce({ response: { status } });

    renderPage();
    await screen.findByRole("link", { name: "Open Day" });

    returnToTab();

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByRole("link", { name: "Open Day" })).not.toBeInTheDocument();
  });

  it("SCRUM495_AC6_AC7_AC8_keeps_the_newest_answer_when_an_older_read_finishes_after_it", async () => {
    const slow = pending();
    const fast = pending();
    vi.mocked(getOpenEvents)
      .mockResolvedValueOnce([event({ eventName: "First read" })])
      .mockReturnValueOnce(slow.promise)
      .mockReturnValueOnce(fast.promise);

    renderPage();
    await screen.findByRole("link", { name: "First read" });
    returnToTab();
    returnToTab();

    fast.resolve([event({ eventName: "Newest" })]);
    await screen.findByRole("link", { name: "Newest" });
    slow.resolve([event({ eventName: "Stale" })]);

    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByRole("link", { name: "Newest" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Stale" })).not.toBeInTheDocument();
  });

  it("SCRUM495_AC6_AC7_AC8_keeps_the_newest_answer_when_an_older_read_fails_after_it", async () => {
    const slow = pending();
    const fast = pending();
    vi.mocked(getOpenEvents)
      .mockResolvedValueOnce([event({ eventName: "First read" })])
      .mockReturnValueOnce(slow.promise)
      .mockReturnValueOnce(fast.promise);

    renderPage();
    await screen.findByRole("link", { name: "First read" });
    returnToTab();
    returnToTab();
    fast.resolve([event({ eventName: "Newest" })]);
    await screen.findByRole("link", { name: "Newest" });
    slow.reject({ response: { status: 500 } });

    await waitFor(() => expect(getOpenEvents).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("link", { name: "Newest" })).toBeInTheDocument();
    expect(screen.queryByText(/Could not refresh the list/)).not.toBeInTheDocument();
  });

  it("SCRUM495_AC6_AC7_AC8_opening_the_page_again_reads_the_server_again_so_a_registration_made_on_the_details_page_shows", async () => {
    vi.mocked(getOpenEvents)
      .mockResolvedValueOnce([event({ placesLeft: 2 })])
      .mockResolvedValueOnce([event({ placesLeft: 1, isRegistered: true, canRegister: false })]);

    const first = renderPage();
    await screen.findByText("2 places left");
    first.unmount();
    renderPage();

    const row = (await screen.findByText("1 place left")).closest("li");
    expect(within(row).getByText("Registered")).toBeInTheDocument();
    expect(getOpenEvents).toHaveBeenCalledTimes(2);
  });
});
