// BrowseOpenEvents.test.jsx
//
// SCRUM-495: the Attendee's list of open events. The service is mocked at its
// own module, so what is under test is what the page does with each answer:
// the order it was given, the date, times and availability it shows, the
// Full and Registered marks, and the loading, error and empty states. Dates
// and times are Singapore time (09:00 for 01:00Z), whatever the machine's zone.

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
  it("says it is loading while the list is on its way", () => {
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
  it("shows the name, date, start and end times and the places left", async () => {
    const e = event();
    vi.mocked(getOpenEvents).mockResolvedValue([e]);

    renderPage();

    const row = within(await screen.findByRole("list")).getByRole("listitem");
    expect(within(row).getByRole("link", { name: "Open Day" })).toBeInTheDocument();
    expect(row).toHaveTextContent(/Oct 25, 2026|25 Oct 2026/);
    expect(row).toHaveTextContent("Starts 09:00");
    expect(row).toHaveTextContent("Ends 11:30");
    expect(row).toHaveTextContent("12 places left");
  });

  it("reads one place as '1 place left'", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([event({ placesLeft: 1 })]);

    renderPage();

    expect(await screen.findByText("1 place left")).toBeInTheDocument();
  });

  it("shows 'No limit' for an event with no capacity", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([event({ capacity: null, placesLeft: null })]);

    renderPage();

    expect(await screen.findByText("No limit")).toBeInTheDocument();
    expect(screen.queryByText(/places? left/)).not.toBeInTheDocument();
  });

  it("keeps a full event in the list, marked 'Full', never as a number", async () => {
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

  it("marks an event the caller has joined as 'Registered', and no other", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([
      event({ id: "e1", eventName: "Joined", isRegistered: true, canRegister: false }),
      event({ id: "e2", eventName: "Not joined" }),
    ]);

    renderPage();

    await screen.findByRole("list");
    expect(within(rowFor("Joined")).getByText("Registered")).toBeInTheDocument();
    expect(within(rowFor("Not joined")).queryByText("Registered")).not.toBeInTheDocument();
  });

  it("shows a full event the caller has joined as both Full and Registered", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([
      event({ eventName: "Both", placesLeft: 0, isFull: true, isRegistered: true, canRegister: false }),
    ]);

    renderPage();

    await screen.findByRole("list");
    const row = rowFor("Both");
    expect(within(row).getByText("Full")).toBeInTheDocument();
    expect(within(row).getByText("Registered")).toBeInTheDocument();
  });

  it("shows the end date as well when the event ends on a later day", async () => {
    const e = event({ startsAt: "2026-10-25T10:00:00.000Z", endsAt: "2026-10-27T10:00:00.000Z" });
    vi.mocked(getOpenEvents).mockResolvedValue([e]);

    renderPage();

    const row = within(await screen.findByRole("list")).getByRole("listitem");
    expect(row).toHaveTextContent(/Oct 27, 2026|27 Oct 2026/);
  });

  it("shows a nameless event as an unnamed event", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([event({ eventName: "" })]);

    renderPage();

    expect(await screen.findByRole("link", { name: "Unnamed event" })).toBeInTheDocument();
  });

  it("falls back to plain words for a missing or unreadable date or time", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([event({ startsAt: null, endsAt: "later" })]);

    renderPage();

    const row = within(await screen.findByRole("list")).getByRole("listitem");
    expect(row).toHaveTextContent("Date to be confirmed");
    expect(row).toHaveTextContent("Starts Not set");
    expect(row).toHaveTextContent("Ends Not set");
  });
});

describe("SCRUM495_AC4 order", () => {
  it("shows the events in the order the server sent them", async () => {
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
  it("goes to that event's browse details route", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([event({ id: "abc-123", eventName: "Open Day" })]);

    renderPage();

    const link = await screen.findByRole("link", { name: "Open Day" });
    expect(link).toHaveAttribute("href", "/open-events/abc-123");

    await userEvent.click(link);

    expect(screen.getByTestId("where")).toHaveTextContent("/open-events/abc-123");
  });

  it("encodes the id, so an odd id cannot change the path", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([event({ id: "a/b?c", eventName: "Odd" })]);

    renderPage();

    expect(await screen.findByRole("link", { name: "Odd" })).toHaveAttribute("href", "/open-events/a%2Fb%3Fc");
  });
});

describe("SCRUM495_AC8 no internal planning information", () => {
  it("shows no description, venue or capacity figure on the list", async () => {
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
  ])("explains a %i", async (status, message) => {
    vi.mocked(getOpenEvents).mockRejectedValue({ response: { status } });

    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText("No events are currently open for registration.")).not.toBeInTheDocument();
  });

  it("gives a general message when there is no response at all", async () => {
    vi.mocked(getOpenEvents).mockRejectedValue(new Error("Network Error"));

    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("Open events could not be loaded. Please try again.");
  });

  it("loads again on 'Try again' and shows the list when it works", async () => {
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
  it("drops an event that is no longer open, and keeps the rest, when the reader returns", async () => {
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

  it("shows the empty message when the refresh finds nothing open", async () => {
    vi.mocked(getOpenEvents).mockResolvedValueOnce([event()]).mockResolvedValueOnce([]);

    renderPage();
    await screen.findByRole("link", { name: "Open Day" });

    returnToTab();

    expect(await screen.findByText("No events are currently open for registration.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("brings an event back after reconfirmation, with the registration it already had", async () => {
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

  it("shows new availability, and a new Registered mark, after the reader returns from registering", async () => {
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

  it("does not blank the list while it refreshes", async () => {
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

  it("keeps the last list with a notice when a refresh cannot reach the server, and recovers on 'Try again'", async () => {
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
  ])("replaces the list with the error when a refresh is refused with %i", async (status, message) => {
    vi.mocked(getOpenEvents)
      .mockResolvedValueOnce([event()])
      .mockRejectedValueOnce({ response: { status } });

    renderPage();
    await screen.findByRole("link", { name: "Open Day" });

    returnToTab();

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByRole("link", { name: "Open Day" })).not.toBeInTheDocument();
  });

  it("keeps the newest answer when an older read finishes after it", async () => {
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

  it("keeps the newest answer when an older read fails after it", async () => {
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

  it("opening the page again reads the server again, so a registration made on the details page shows", async () => {
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