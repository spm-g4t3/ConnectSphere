// The attendee's waiting-list screens with the services mocked. Positions and
// statuses are whatever the server last said; nothing here computes them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import RegisteredEvents from "../../src/components/RegisteredEvents.jsx";
import BrowseOpenEvents from "../../src/components/BrowseOpenEvents.jsx";
import BrowseEventDetails from "../../src/components/BrowseEventDetails.jsx";
import { getRegisteredEvents, getWaitlist, leaveWaitlist } from "../../src/services/attendeeEventService";
import { getOpenEvent, getOpenEvents } from "../../src/services/openEventService";
import { deferred } from "../helpers/async.js";

vi.mock("../../src/services/attendeeEventService", () => ({
  getRegisteredEvents: vi.fn(), getWaitlist: vi.fn(), leaveWaitlist: vi.fn(),
}));
vi.mock("../../src/services/openEventService", () => ({ getOpenEvent: vi.fn(), getOpenEvents: vi.fn() }));

const place = (overrides = {}) => ({
  registrationId: "r1", eventRequestId: "e1", eventName: "Open Day", waitlistPosition: 3,
  waitlistedAt: "2026-10-16T10:00:00Z", ...overrides,
});
const openEvent = (overrides = {}) => ({
  id: "e1", eventName: "Open Day", description: "Come along.",
  startsAt: "2026-10-25T01:00:00.000Z", endsAt: "2026-10-25T03:30:00.000Z",
  capacity: 1, placesLeft: 0, isFull: true, isRegistered: false, canRegister: false,
  canJoinWaitlist: false, waitlistPosition: null, ...overrides,
});

function renderMyRegistrations() {
  return render(<MemoryRouter><RegisteredEvents /></MemoryRouter>);
}
// The app's refresh mechanism: re-read when the attendee comes back to the tab.
async function returnToTab() {
  await act(async () => { window.dispatchEvent(new Event("focus")); });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("SCRUM475 My Registrations", () => {
  it("SCRUM475_AC1_shows_each_waitlisted_event_with_the_servers_position", async () => {
    vi.mocked(getRegisteredEvents).mockResolvedValue([]);
    vi.mocked(getWaitlist).mockResolvedValue([place(), place({ registrationId: "r2", eventName: null, waitlistPosition: 1 })]);
    renderMyRegistrations();

    const lists = await screen.findByRole("region", { name: "Waiting lists" });
    const items = await within(lists).findAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Open Day");
    expect(items[0]).toHaveTextContent("Waitlisted: position 3");
    expect(items[1]).toHaveTextContent("Unnamed event");
    expect(items[1]).toHaveTextContent("Waitlisted: position 1");
  });

  it("SCRUM475_AC6_returning_to_the_tab_shows_queue_movement_and_a_promotion_as_registered", async () => {
    vi.mocked(getRegisteredEvents).mockResolvedValueOnce([]).mockResolvedValue([{ eventRequestId: "e1", eventName: "Open Day" }]);
    vi.mocked(getWaitlist).mockResolvedValueOnce([place({ waitlistPosition: 2 }), place({ registrationId: "r9", eventRequestId: "e9", eventName: "Gala", waitlistPosition: 4 })])
      .mockResolvedValue([place({ registrationId: "r9", eventRequestId: "e9", eventName: "Gala", waitlistPosition: 3 })]);
    renderMyRegistrations();
    expect(await screen.findByText("Waitlisted: position 4")).toBeInTheDocument();

    await returnToTab();

    expect(await screen.findByRole("link", { name: "Open Day" })).toBeInTheDocument();
    expect(await screen.findByText("Waitlisted: position 3")).toBeInTheDocument();
    expect(screen.queryByText("Waitlisted: position 2")).not.toBeInTheDocument();
  });

  it("SCRUM475_AC2_AC5_leaving_shows_progress_sends_once_and_reloads_from_the_server", async () => {
    vi.mocked(getRegisteredEvents).mockResolvedValue([]);
    vi.mocked(getWaitlist).mockResolvedValueOnce([place()]).mockResolvedValue([]);
    const request = deferred();
    vi.mocked(leaveWaitlist).mockReturnValue(request.promise);
    renderMyRegistrations();

    fireEvent.click(await screen.findByRole("button", { name: "Leave waiting list" }));
    const confirm = screen.getByRole("button", { name: "Confirm leaving" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(screen.getByRole("button", { name: "Leaving..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Keep my place" })).toBeDisabled();
    await act(async () => request.resolve({ id: "r1", status: "withdrawn" }));

    expect(leaveWaitlist).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("You have left the waiting list for Open Day.")).toHaveAttribute("role", "status");
    expect(await screen.findByText("You are not on any waiting lists.")).toBeInTheDocument();
    // Read again from the server, not removed and renumbered here.
    expect(getWaitlist).toHaveBeenCalledTimes(2);
  });

  it("SCRUM475_AC2_a_failure_keeps_the_entry_and_offers_the_action_again", async () => {
    vi.mocked(getRegisteredEvents).mockResolvedValue([]);
    vi.mocked(getWaitlist).mockResolvedValue([place()]);
    vi.mocked(leaveWaitlist).mockRejectedValue({ code: "ERR_NETWORK" });
    renderMyRegistrations();

    fireEvent.click(await screen.findByRole("button", { name: "Leave waiting list" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm leaving" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the server. You are still on the waiting list.");
    expect(screen.getByText("Waitlisted: position 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave waiting list" })).toBeEnabled();
  });

  it("SCRUM475_AC2_keeping_the_place_sends_nothing", async () => {
    vi.mocked(getRegisteredEvents).mockResolvedValue([]);
    vi.mocked(getWaitlist).mockResolvedValue([place()]);
    renderMyRegistrations();

    fireEvent.click(await screen.findByRole("button", { name: "Leave waiting list" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep my place" }));

    expect(screen.getByRole("button", { name: "Leave waiting list" })).toBeInTheDocument();
    expect(leaveWaitlist).not.toHaveBeenCalled();
  });

  it.each([
    [401, "Your session has expired"],
    [403, "Only Attendees can view waiting lists."],
  ])("SCRUM475_AC2_a_%s_on_load_is_explained", async (status, text) => {
    vi.mocked(getRegisteredEvents).mockResolvedValue([]);
    vi.mocked(getWaitlist).mockRejectedValue({ response: { status } });
    renderMyRegistrations();
    const lists = await screen.findByRole("region", { name: "Waiting lists" });
    expect(await within(lists).findByRole("alert")).toHaveTextContent(text);
  });
});

describe("SCRUM475 the browse pages", () => {
  it("SCRUM475_AC1_the_list_marks_events_the_attendee_is_queued_for", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([
      openEvent({ waitlistPosition: 2 }),
      openEvent({ id: "e2", eventName: "Gala" }),
    ]);
    render(<MemoryRouter><BrowseOpenEvents /></MemoryRouter>);

    const rows = await screen.findAllByRole("listitem");
    expect(within(rows[0]).getByText("Waitlisted: position 2")).toBeInTheDocument();
    expect(within(rows[1]).queryByText(/Waitlisted/)).not.toBeInTheDocument();
  });

  function renderDetails(onRegister = vi.fn(), onJoinWaitlist = vi.fn()) {
    render(
      <MemoryRouter initialEntries={["/open-events/e1"]}>
        <Routes>
          <Route path="/open-events/:eventId"
            element={<BrowseEventDetails onRegister={onRegister} onJoinWaitlist={onJoinWaitlist} />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("SCRUM475_AC1_the_event_page_shows_the_queue_position_beside_availability", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(openEvent({ waitlistPosition: 2 }));
    renderDetails();
    const availability = (await screen.findByText("Availability")).closest("div");
    expect(within(availability).getByText("Waitlisted: position 2")).toBeInTheDocument();
  });

  it("SCRUM475_AC4_with_a_place_free_the_page_offers_registration_not_the_waiting_list", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(openEvent({ isFull: false, placesLeft: 1, canRegister: true, canJoinWaitlist: false }));
    const onRegister = vi.fn().mockResolvedValue({ status: "registered" });
    renderDetails(onRegister);

    fireEvent.click(await screen.findByRole("button", { name: "Register" }));

    await waitFor(() => expect(onRegister).toHaveBeenCalledWith("e1"));
    expect(screen.queryByRole("button", { name: "Join waiting list" })).not.toBeInTheDocument();
  });

  it("SCRUM475_AC3_AC5_joining_rereads_the_event_and_shows_the_servers_position", async () => {
    vi.mocked(getOpenEvent).mockResolvedValueOnce(openEvent({ canJoinWaitlist: true }))
      .mockResolvedValue(openEvent({ waitlistPosition: 4 }));
    const onJoinWaitlist = vi.fn().mockResolvedValue({ status: "waitlisted", waitlistPosition: 4 });
    renderDetails(vi.fn(), onJoinWaitlist);

    fireEvent.click(await screen.findByRole("button", { name: "Join waiting list" }));

    expect(await screen.findByText("You are number 4 on the waiting list.", { exact: false })).toBeInTheDocument();
    expect(getOpenEvent).toHaveBeenCalledTimes(2);
    expect(onJoinWaitlist).toHaveBeenCalledTimes(1);
  });
});
